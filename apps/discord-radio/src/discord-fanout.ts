import {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    joinVoiceChannel,
    type DiscordGatewayAdapterCreator,
    type VoiceConnection,
} from '@discordjs/voice';
import { setTimeout as delay } from 'node:timers/promises';

import type { OutputFanout, OutputHealth } from './contracts.js';

export class DiscordOutputFanout implements OutputFanout {
    private readonly player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    private readonly connections = new Map<string, VoiceConnection>();
    private readonly desired = new Map<string, { channelId: string; adapterCreator: unknown }>();
    private readonly reconnecting = new Set<string>();
    private readonly connectionTails = new Map<string, Promise<void>>();
    private active?: { reject: (error: Error) => void };
    private skipped = false;

    constructor(private readonly maxGuilds = 3) {}

    async connectGuild(guildId: string, channelId: string, adapterCreator: unknown): Promise<void> {
        if (!this.desired.has(guildId) && this.desired.size >= this.maxGuilds) throw new Error(`This release supports at most ${this.maxGuilds} guilds`);
        const alreadyReady = this.connections.get(guildId)?.state.status === VoiceConnectionStatus.Ready &&
            this.connections.get(guildId)?.joinConfig.channelId === channelId;
        this.desired.set(guildId, { channelId, adapterCreator });
        if (alreadyReady) return;
        try {
            await this.withConnectionLock(guildId, async () => {
                if (this.desired.get(guildId)?.channelId !== channelId) return;
                if (this.connections.get(guildId)?.state.status === VoiceConnectionStatus.Ready &&
                    this.connections.get(guildId)?.joinConfig.channelId === channelId) return;
                await this.establish(guildId, channelId, adapterCreator);
            });
        } catch (error) {
            void this.reconnect(guildId);
            throw error;
        }
    }

    private async establish(guildId: string, channelId: string, adapterCreator: unknown): Promise<void> {
        const previous = this.connections.get(guildId);
        if (previous) {
            this.connections.delete(guildId);
            previous.destroy();
            // A deliberate move keeps the shared player running while the new voice
            // connection becomes Ready; a failed move can then return to the old channel.
        }
        const connection = joinVoiceChannel({
            guildId,
            channelId,
            adapterCreator: adapterCreator as DiscordGatewayAdapterCreator,
            selfDeaf: true,
            selfMute: false,
        });
        this.connections.set(guildId, connection);
        connection.subscribe(this.player);
        connection.on(VoiceConnectionStatus.Disconnected, () => {
            if (this.connections.get(guildId) !== connection) return;
            this.abortPlaybackWithoutOutputs();
            void Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]).catch(() => {
                if (this.connections.get(guildId) !== connection) return;
                connection.destroy();
                this.connections.delete(guildId);
                void this.reconnect(guildId);
            });
        });
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        } catch (error) {
            connection.destroy();
            if (this.connections.get(guildId) === connection) {
                this.connections.delete(guildId);
                if (!previous) this.abortPlaybackWithoutOutputs();
            }
            throw error;
        }
    }

    private async withConnectionLock<T>(guildId: string, work: () => Promise<T>): Promise<T> {
        const previous = this.connectionTails.get(guildId) ?? Promise.resolve();
        let release!: () => void;
        const tail = new Promise<void>(resolve => { release = resolve; });
        this.connectionTails.set(guildId, tail);
        await previous;
        try {
            return await work();
        } finally {
            release();
            if (this.connectionTails.get(guildId) === tail) this.connectionTails.delete(guildId);
        }
    }

    async play(localPath: string, options?: { kind: 'speech' }): Promise<void> {
        if (this.active) throw new Error('AudioPlayer already has an active item');
        if (!this.hasReadyOutput()) throw new Error('No Discord voice outputs are connected');
        this.skipped = false;
        const resource = createAudioResource(localPath, { inputType: StreamType.Arbitrary, inlineVolume: true });
        // Loud masters dominate even peak-limited speech; keep the shared
        // music programme below narration rather than clipping the TTS harder.
        // Speech was peak-limited to 0.89 before caching. Keep the final
        // inline gain below 1 / 0.89 to avoid clipping in the Discord player.
        resource.volume?.setVolume(options?.kind === 'speech' ? 1.1 : 0.38);
        await new Promise<void>((resolve, reject) => {
            this.active = { reject };
            const cleanup = (): void => {
                this.player.off(AudioPlayerStatus.Idle, idle);
                this.player.off('error', failed);
                this.active = undefined;
            };
            const idle = (): void => {
                const wasSkipped = this.skipped;
                cleanup();
                if (wasSkipped) reject(new Error('Playback skipped by owner'));
                else resolve();
            };
            const failed = (error: Error): void => {
                cleanup();
                reject(error);
            };
            this.player.once(AudioPlayerStatus.Idle, idle);
            this.player.once('error', failed);
            this.player.play(resource);
        });
    }

    pause(): boolean {
        return this.player.pause(true);
    }

    resume(): boolean {
        return this.player.unpause();
    }

    skip(): boolean {
        if (!this.active) return false;
        this.skipped = true;
        return this.player.stop(true);
    }

    stopGuild(guildId: string): void {
        this.desired.delete(guildId);
        const connection = this.connections.get(guildId);
        if (!connection) return;
        connection.destroy();
        this.connections.delete(guildId);
        this.abortPlaybackWithoutOutputs();
    }

    stopAll(): void {
        if (this.active) this.active.reject(new Error('Audio output stopped'));
        this.player.stop(true);
        for (const connection of this.connections.values()) connection.destroy();
        this.connections.clear();
        this.desired.clear();
    }

    health(): OutputHealth[] {
        return [...this.desired.keys()].map(guildId => {
            const connection = this.connections.get(guildId);
            return {
                guildId,
                connected: connection?.state.status === VoiceConnectionStatus.Ready,
                detail: connection?.state.status ?? (this.reconnecting.has(guildId) ? 'reconnecting' : 'disconnected'),
            };
        });
    }

    private async reconnect(guildId: string): Promise<void> {
        if (this.reconnecting.has(guildId)) return;
        this.reconnecting.add(guildId);
        try {
            const waits = [1_000, 2_000, 4_000, 8_000, 30_000];
            for (let attempt = 0; this.desired.has(guildId); attempt++) {
                const waitMs = waits[Math.min(attempt, waits.length - 1)]!;
                await delay(waitMs);
                const target = this.desired.get(guildId);
                if (!target) return;
                try {
                    await this.withConnectionLock(guildId, async () => {
                        const latest = this.desired.get(guildId);
                        if (!latest) return;
                        if (this.connections.get(guildId)?.state.status === VoiceConnectionStatus.Ready &&
                            this.connections.get(guildId)?.joinConfig.channelId === latest.channelId) return;
                        await this.establish(guildId, latest.channelId, latest.adapterCreator);
                    });
                    return;
                } catch {
                    // Keep the other guild outputs playing and retry this one with bounded backoff.
                }
            }
        } finally {
            this.reconnecting.delete(guildId);
        }
    }

    private abortPlaybackWithoutOutputs(): void {
        if (this.hasReadyOutput() || !this.active) return;
        this.active.reject(new Error('All Discord voice outputs disconnected during playback'));
        this.player.stop(true);
    }

    private hasReadyOutput(): boolean {
        return [...this.connections.values()].some(connection => connection.state.status === VoiceConnectionStatus.Ready);
    }
}
