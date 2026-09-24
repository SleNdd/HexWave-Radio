import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscordOutputFanout } from '../src/discord-fanout.js';

vi.mock('@discordjs/voice', async importOriginal => {
    const actual = await importOriginal<typeof import('@discordjs/voice')>();
    return { ...actual, createAudioPlayer: vi.fn(actual.createAudioPlayer), createAudioResource: vi.fn(actual.createAudioResource),
        joinVoiceChannel: vi.fn(), entersState: vi.fn() };
});

afterEach(() => vi.clearAllMocks());

type FanoutInternals = {
    connections: Map<string, VoiceConnection>;
    active?: { reject: (error: Error) => void };
};

function connection(status: VoiceConnectionStatus, channelId: string | null = null): VoiceConnection {
    return Object.assign(new EventEmitter(), { state: { status }, joinConfig: { channelId }, destroy: vi.fn(), subscribe: vi.fn() }) as unknown as VoiceConnection;
}

describe('DiscordOutputFanout shared programme', () => {
    it('ends an audio resource stuck before its first frame without cutting one already playing', async () => {
        vi.useFakeTimers();
        const resource = { volume: { setVolume: vi.fn() } };
        const player = Object.assign(new EventEmitter(), {
            state: { status: AudioPlayerStatus.Idle } as { status: AudioPlayerStatus; resource?: typeof resource },
            play(next: typeof resource) { this.state = { status: AudioPlayerStatus.Buffering, resource: next }; },
            stop: vi.fn(function(this: { state: { status: AudioPlayerStatus }; emit: (event: string) => void }) {
                if (this.state.status === AudioPlayerStatus.Idle) return false;
                this.state = { status: AudioPlayerStatus.Idle };
                this.emit(AudioPlayerStatus.Idle);
                return true;
            }),
        });
        vi.mocked(createAudioPlayer).mockReturnValueOnce(player as never);
        vi.mocked(createAudioResource).mockReturnValue(resource as never);
        const startLive = vi.fn();
        const fanout = new DiscordOutputFanout(3, { start: startLive, stop: vi.fn(), close: vi.fn() } as never);
        try {
            const stuck = fanout.play('stuck.media');
            expect(startLive).not.toHaveBeenCalled();
            const rejected = expect(stuck).rejects.toThrow('Audio resource buffering timed out');
            await vi.advanceTimersByTimeAsync(15_000);
            await rejected;
            expect(player.stop).toHaveBeenCalledTimes(1);
            expect(startLive).not.toHaveBeenCalled();

            const playing = fanout.play('playing.media');
            player.state = { status: AudioPlayerStatus.Playing, resource };
            player.emit(AudioPlayerStatus.Playing);
            expect(startLive).toHaveBeenCalledOnce();
            expect(startLive).toHaveBeenCalledWith('playing.media', 'music');
            await vi.advanceTimersByTimeAsync(15_000);
            expect(player.stop).toHaveBeenCalledTimes(1);
            player.state = { status: AudioPlayerStatus.Idle };
            player.emit(AudioPlayerStatus.Idle);
            await expect(playing).resolves.toBeUndefined();
        } finally {
            fanout.stopAll();
            vi.useRealTimers();
        }
    });

    it('cleans the startup timer and listeners if the audio player rejects the resource synchronously', async () => {
        vi.useFakeTimers();
        const player = Object.assign(new EventEmitter(), {
            state: { status: AudioPlayerStatus.Idle },
            play: () => { throw new Error('resource already ended'); },
            stop: vi.fn(() => false),
        });
        vi.mocked(createAudioPlayer).mockReturnValueOnce(player as never);
        vi.mocked(createAudioResource).mockReturnValue({ volume: { setVolume: vi.fn() } } as never);
        const fanout = new DiscordOutputFanout();
        try {
            await expect(fanout.play('ended.media')).rejects.toThrow('resource already ended');
            expect(player.listenerCount(AudioPlayerStatus.Idle)).toBe(0);
            expect(player.listenerCount('error')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            expect((fanout as unknown as FanoutInternals).active).toBeUndefined();
        } finally {
            fanout.stopAll();
            vi.useRealTimers();
        }
    });

    it('starts HTTP audio when the player is already Playing on return from play', async () => {
        const resource = { volume: { setVolume: vi.fn() } };
        const player = Object.assign(new EventEmitter(), {
            state: { status: AudioPlayerStatus.Idle } as { status: AudioPlayerStatus; resource?: typeof resource },
            play(next: typeof resource) { this.state = { status: AudioPlayerStatus.Playing, resource: next }; },
            stop: vi.fn(() => false),
        });
        vi.mocked(createAudioPlayer).mockReturnValueOnce(player as never);
        vi.mocked(createAudioResource).mockReturnValue(resource as never);
        const startLive = vi.fn();
        const fanout = new DiscordOutputFanout(3, { start: startLive, stop: vi.fn(), close: vi.fn() } as never);
        try {
            const playing = fanout.play('instant.media');
            expect(startLive).toHaveBeenCalledOnce();
            player.state = { status: AudioPlayerStatus.Idle };
            player.emit(AudioPlayerStatus.Idle);
            await expect(playing).resolves.toBeUndefined();
        } finally {
            fanout.stopAll();
        }
    });

    it('does not mark or stop an already idle player as skipped', () => {
        const stopLive = vi.fn();
        const fanout = new DiscordOutputFanout(3, { stop: stopLive, close: vi.fn() } as never);
        const internals = fanout as unknown as FanoutInternals & { skipped: boolean };
        internals.active = { reject: vi.fn() };
        expect(fanout.skip()).toBe(false);
        expect(internals.skipped).toBe(false);
        expect(stopLive).not.toHaveBeenCalled();
        internals.active = undefined;
        fanout.stopAll();
    });

    it('keeps the audio player advancing without Discord subscribers', () => {
        const fanout = new DiscordOutputFanout();
        expect(vi.mocked(createAudioPlayer)).toHaveBeenCalledWith({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        fanout.stopAll();
    });

    it('does not abort an active programme when the last guild leaves', () => {
        const fanout = new DiscordOutputFanout();
        const internals = fanout as unknown as FanoutInternals;
        const output = connection(VoiceConnectionStatus.Ready);
        internals.connections.set('guild', output);
        const reject = vi.fn();
        internals.active = { reject };
        fanout.stopGuild('guild');
        expect(reject).not.toHaveBeenCalled();
        expect(fanout.health()).toEqual([]);
        internals.active = undefined;
        fanout.stopAll();
    });

    it('keeps playback alive while replacing the sole ready voice connection', async () => {
        const oldConnection = connection(VoiceConnectionStatus.Ready);
        const newConnection = connection(VoiceConnectionStatus.Connecting);
        vi.mocked(joinVoiceChannel).mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
        let releaseReady = (): void => undefined;
        const ready = new Promise<void>(resolve => {
            releaseReady = resolve;
        });
        vi.mocked(entersState).mockImplementation(async (target, status) => {
            if (target === newConnection && status === VoiceConnectionStatus.Ready) await ready;
            return target;
        });

        const fanout = new DiscordOutputFanout();
        await fanout.connectGuild('guild', 'channel-a', {});
        const reject = vi.fn();
        (fanout as unknown as FanoutInternals).active = { reject };

        const moving = fanout.connectGuild('guild', 'channel-b', {});
        expect(reject).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(vi.mocked(oldConnection.destroy)).toHaveBeenCalledOnce());

        (newConnection.state as { status: VoiceConnectionStatus }).status = VoiceConnectionStatus.Ready;
        releaseReady();
        await moving;
        (fanout as unknown as FanoutInternals).active = undefined;
        fanout.stopAll();
    });

    it('does not abort playback before a failed move can restore the previous channel', async () => {
        const oldConnection = connection(VoiceConnectionStatus.Ready);
        vi.mocked(joinVoiceChannel)
            .mockReturnValueOnce(oldConnection)
            .mockImplementationOnce(() => {
                throw new Error('join failed');
            });
        vi.mocked(entersState).mockResolvedValue(oldConnection);

        const fanout = new DiscordOutputFanout();
        await fanout.connectGuild('guild', 'channel-a', {});
        const reject = vi.fn();
        (fanout as unknown as FanoutInternals).active = { reject };

        await expect(fanout.connectGuild('guild', 'channel-b', {})).rejects.toThrow('join failed');
        expect(reject).not.toHaveBeenCalled();
        (fanout as unknown as FanoutInternals).active = undefined;
        fanout.stopAll();
    });

    it('does not reconnect or interrupt playback when joining the already ready channel', async () => {
        const ready = connection(VoiceConnectionStatus.Ready, 'channel-a');
        vi.mocked(joinVoiceChannel).mockReturnValueOnce(ready);
        vi.mocked(entersState).mockResolvedValue(ready);
        const fanout = new DiscordOutputFanout();
        await fanout.connectGuild('guild', 'channel-a', {});
        const reject = vi.fn();
        (fanout as unknown as FanoutInternals).active = { reject };
        await fanout.connectGuild('guild', 'channel-a', {});
        expect(vi.mocked(joinVoiceChannel)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(ready.destroy)).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();
        (fanout as unknown as FanoutInternals).active = undefined;
        fanout.stopAll();
    });

    it('does not replace an in-flight rollback when a background reconnect wakes', async () => {
        const old = connection(VoiceConnectionStatus.Ready, 'channel-a');
        const returning = connection(VoiceConnectionStatus.Connecting, 'channel-a');
        vi.mocked(joinVoiceChannel).mockReturnValueOnce(old).mockImplementationOnce(() => {
            throw new Error('move failed');
        }).mockReturnValueOnce(returning);
        let releaseReady!: () => void;
        const ready = new Promise<void>(resolve => { releaseReady = resolve; });
        vi.mocked(entersState).mockImplementation(async target => {
            if (target === returning) await ready;
            return target;
        });
        const fanout = new DiscordOutputFanout();
        await fanout.connectGuild('guild', 'channel-a', {});
        await expect(fanout.connectGuild('guild', 'channel-b', {})).rejects.toThrow('move failed');
        const rollback = fanout.connectGuild('guild', 'channel-a', {});
        await delay(1_100);
        expect(vi.mocked(joinVoiceChannel)).toHaveBeenCalledTimes(3);
        expect(vi.mocked(returning.destroy)).not.toHaveBeenCalled();
        (returning.state as { status: VoiceConnectionStatus }).status = VoiceConnectionStatus.Ready;
        releaseReady();
        await rollback;
        await delay(0);
        expect(vi.mocked(joinVoiceChannel)).toHaveBeenCalledTimes(3);
        fanout.stopAll();
    });
});
