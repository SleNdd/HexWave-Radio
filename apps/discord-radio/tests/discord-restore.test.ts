import { Client, Events, REST } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RadioConfig } from '../src/config.js';
import type { SpeechEngine } from '../src/contracts.js';
import type { RadioDirector } from '../src/director.js';
import { DiscordRadioBot } from '../src/discord-bot.js';
import type { DiscordOutputFanout } from '../src/discord-fanout.js';
import type { RadioStore } from '../src/storage.js';

afterEach(() => {
    vi.restoreAllMocks();
});

function setup() {
    const saved = { guildId: 'guild', channelId: 'voice' };
    const saveGuildOutput = vi.fn();
    const connectGuild = vi.fn(async () => undefined);
    const stopAll = vi.fn();
    const store = { guildOutputs: () => [saved], saveGuildOutput } as unknown as RadioStore;
    const output = { connectGuild, stopAll, stopGuild: vi.fn(), health: vi.fn(() => []) } as unknown as DiscordOutputFanout;
    const config = { discord: { token: 'test', clientId: 'app', ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>(), maxGuilds: 3 } } as RadioConfig;
    const bot = new DiscordRadioBot(config, {} as RadioDirector, output, store, [], {} as SpeechEngine, [1]);
    const client = (bot as unknown as { client: Client }).client;
    vi.spyOn(REST.prototype, 'put').mockResolvedValue([]);
    vi.spyOn(client, 'login').mockResolvedValue('test');
    vi.spyOn(client, 'isReady').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return { bot, client, saved, saveGuildOutput, connectGuild, stopAll };
}

describe('Discord output restoration', () => {
    it('does not log in after stop wins a pending command registration', async () => {
        const { bot, client, connectGuild } = setup();
        let finishRegistration!: (value: never) => void;
        vi.spyOn(REST.prototype, 'put').mockReturnValue(new Promise(resolve => { finishRegistration = resolve; }));
        const starting = bot.start();
        await vi.waitFor(() => expect(REST.prototype.put).toHaveBeenCalledTimes(1));
        await bot.stop();
        await expect(starting).rejects.toThrow();
        finishRegistration([] as never);
        await Promise.resolve();
        expect(client.login).not.toHaveBeenCalled();
        expect(connectGuild).not.toHaveBeenCalled();
    });

    it('closes a login that resolves after stop without restoring voice', async () => {
        const { bot, client, connectGuild } = setup();
        vi.spyOn(client, 'isReady').mockReturnValue(false);
        let finishLogin!: (value: string) => void;
        vi.spyOn(client, 'login').mockReturnValue(new Promise(resolve => { finishLogin = resolve; }));
        const destroy = vi.spyOn(client, 'destroy');
        const starting = bot.start();
        await vi.waitFor(() => expect(client.login).toHaveBeenCalledTimes(1));
        await bot.stop();
        await expect(starting).rejects.toThrow();
        finishLogin('test');
        await Promise.resolve();
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(connectGuild).not.toHaveBeenCalled();
    });

    it('waits for the Discord gateway to be ready before restoring voice outputs', async () => {
        const { bot, client, connectGuild } = setup();
        vi.spyOn(client, 'isReady').mockReturnValue(false);
        const fetchGuild = vi.spyOn(client.guilds, 'fetch').mockResolvedValue({ voiceAdapterCreator: 'adapter' } as never);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const starting = bot.start();
        await vi.waitFor(() => expect(client.login).toHaveBeenCalledTimes(1));
        expect(fetchGuild).not.toHaveBeenCalled();
        client.emit(Events.ClientReady, { user: { id: 'test' } } as never);
        await starting;
        expect(connectGuild).toHaveBeenCalledWith('guild', 'voice', 'adapter');
        await bot.stop();
    });

    it('recovers a saved output after a transient guild lookup failure', async () => {
        const { bot, client, saved, saveGuildOutput, connectGuild } = setup();
        const fetchGuild = vi.spyOn(client.guilds, 'fetch')
            .mockRejectedValueOnce(new Error('temporary Discord failure'))
            .mockResolvedValue({ voiceAdapterCreator: 'adapter' } as never);

        await bot.start();
        expect(fetchGuild).toHaveBeenCalledTimes(1);
        expect(connectGuild).not.toHaveBeenCalled();
        expect(saveGuildOutput).toHaveBeenCalledWith(saved.guildId, saved.channelId, false);

        await vi.waitFor(() => expect(fetchGuild).toHaveBeenCalledTimes(2));
        expect(fetchGuild).toHaveBeenCalledTimes(2);
        expect(connectGuild).toHaveBeenCalledWith(saved.guildId, saved.channelId, 'adapter');
        expect(saveGuildOutput).toHaveBeenLastCalledWith(saved.guildId, saved.channelId, true);
        await bot.stop();
    });

    it('retries a voice admission failure that fanout did not register', async () => {
        const { bot, client, connectGuild } = setup();
        vi.spyOn(client.guilds, 'fetch').mockResolvedValue({ voiceAdapterCreator: 'adapter' } as never);
        connectGuild.mockRejectedValueOnce(new Error('at most 3 guilds'));

        await bot.start();
        await vi.waitFor(() => expect(connectGuild).toHaveBeenCalledTimes(2));
        expect(connectGuild).toHaveBeenLastCalledWith('guild', 'voice', 'adapter');
        await bot.stop();
    });

    it('cancels a pending restore when the bot stops', async () => {
        const { bot, client, connectGuild, stopAll } = setup();
        const fetchGuild = vi.spyOn(client.guilds, 'fetch').mockRejectedValue(new Error('temporary Discord failure'));

        await bot.start();
        await bot.stop();
        expect(fetchGuild).toHaveBeenCalledTimes(1);
        expect(connectGuild).not.toHaveBeenCalled();
        expect(stopAll).toHaveBeenCalledTimes(1);
    });

    it('does not resurrect an initial restore after an owner changes the output', async () => {
        const { bot, client, connectGuild } = setup();
        let resolveGuild!: (guild: { voiceAdapterCreator: string }) => void;
        const lookup = new Promise<{ voiceAdapterCreator: string }>(resolve => { resolveGuild = resolve; });
        vi.spyOn(client.guilds, 'fetch').mockReturnValue(lookup as never);

        const starting = bot.start();
        await vi.waitFor(() => expect(client.guilds.fetch).toHaveBeenCalledTimes(1));
        await (bot as unknown as { cancelRestoreRetry: (guildId: string) => Promise<void> }).cancelRestoreRetry('guild');
        await starting;
        resolveGuild({ voiceAdapterCreator: 'adapter' });
        await Promise.resolve();
        expect(connectGuild).not.toHaveBeenCalled();
        await bot.stop();
    });
});
