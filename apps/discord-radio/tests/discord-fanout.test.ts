import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { VoiceConnectionStatus, entersState, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscordOutputFanout } from '../src/discord-fanout.js';

vi.mock('@discordjs/voice', async importOriginal => {
    const actual = await importOriginal<typeof import('@discordjs/voice')>();
    return { ...actual, joinVoiceChannel: vi.fn(), entersState: vi.fn() };
});

afterEach(() => vi.clearAllMocks());

type FanoutInternals = {
    connections: Map<string, VoiceConnection>;
    active?: { reject: (error: Error) => void };
    abortPlaybackWithoutOutputs: () => void;
};

function connection(status: VoiceConnectionStatus, channelId: string | null = null): VoiceConnection {
    return Object.assign(new EventEmitter(), { state: { status }, joinConfig: { channelId }, destroy: vi.fn(), subscribe: vi.fn() }) as unknown as VoiceConnection;
}

describe('DiscordOutputFanout ready-output guards', () => {
    it('does not start a track when only non-ready connections remain', async () => {
        const fanout = new DiscordOutputFanout();
        const internals = fanout as unknown as FanoutInternals;
        internals.connections.set('guild', connection(VoiceConnectionStatus.Connecting));

        await expect(fanout.play('C:/cache/track.media')).rejects.toThrow('No Discord voice outputs are connected');
        fanout.stopAll();
    });

    it('aborts an active track when every connection loses ready state', () => {
        const fanout = new DiscordOutputFanout();
        const internals = fanout as unknown as FanoutInternals;
        const output = connection(VoiceConnectionStatus.Ready);
        internals.connections.set('guild', output);
        const reject = vi.fn();
        internals.active = { reject };

        internals.abortPlaybackWithoutOutputs();
        expect(reject).not.toHaveBeenCalled();

        (output.state as { status: VoiceConnectionStatus }).status = VoiceConnectionStatus.Disconnected;
        internals.abortPlaybackWithoutOutputs();
        expect(reject).toHaveBeenCalledOnce();
        expect(reject.mock.calls[0]?.[0]).toHaveProperty('message', 'All Discord voice outputs disconnected during playback');
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
