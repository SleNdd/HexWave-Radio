import { setTimeout as delay } from 'node:timers/promises';

import { Client, Events, MessageFlags, REST } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RadioConfig } from '../src/config.js';
import type { SpeechEngine, Track } from '../src/contracts.js';
import type { RadioDirector } from '../src/director.js';
import { DiscordRadioBot } from '../src/discord-bot.js';
import type { DiscordOutputFanout } from '../src/discord-fanout.js';
import { RadioStore } from '../src/storage.js';
import { commandData } from '../src/commands.js';

afterEach(() => vi.restoreAllMocks());

describe('DiscordRadioBot shutdown', () => {
    it('shows a listener only their own decision receipts in a private radio command', async () => {
        const listenerInputs = vi.fn(() => [{ kind: 'request', id: 3, status: 'pending', hostDecision: 'defer' },
            { kind: 'studio', id: 4, status: 'rejected', hostDecision: 'decline' }]);
        const bot = new DiscordRadioBot({ discord: { ownerIds: new Set(['owner']) } } as RadioConfig,
            {} as RadioDirector, { stopAll: () => undefined } as DiscordOutputFanout,
            { listenerInputs } as unknown as RadioStore, [], {} as SpeechEngine);
        const replies: string[] = [];
        const deferred: number[] = [];
        (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio',
            user: { id: 'listener' }, options: { getSubcommand: () => 'mine' },
            deferReply: async (payload: { flags: number }) => { deferred.push(payload.flags); },
            editReply: async (message: string) => { replies.push(message); },
        } as never);
        await bot.stop();
        expect(listenerInputs).toHaveBeenCalledWith('listener', 'guild', 5);
        expect(deferred).toEqual([MessageFlags.Ephemeral]);
        expect(replies).toEqual([expect.stringContaining('Заявка #3 — запланировано позже (может прозвучать раньше)')]);
        expect(replies[0]).toContain('Письмо #4 — отклонено');
    });
    it('allows only the configured root owner to appoint persistent admins', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 900_000, requestTtlMs: 7_200_000,
            studioCooldownMs: 900_000, studioTtlMs: 7_200_000,
            trackCooldownMs: 21_600_000, artistCooldownMs: 2_700_000,
        });
        const config = { discord: { ownerIds: new Set(['owner']) } } as RadioConfig;
        const track: Track = { provider: 'ytmusic', id: 'track', artist: 'Artist', title: 'Song', durationMs: 180_000 };
        const submitRequest = vi.fn(async () => ({ kind: 'accepted', decision: { requestId: 2, merged: false }, track }));
        const bot = new DiscordRadioBot(config, { submitRequest } as unknown as RadioDirector,
            { stopAll: () => undefined } as DiscordOutputFanout, store, [], {} as SpeechEngine);
        const client = (bot as unknown as { client: Client }).client;
        const denied: string[] = [];
        client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio',
            user: { id: 'helper' }, options: { getSubcommand: () => 'admin-add', getUser: () => ({ id: 'stranger', bot: false }) },
            reply: async (payload: { content: string }) => { denied.push(payload.content); },
        } as never);
        await vi.waitFor(() => expect(denied).toHaveLength(1));
        expect(denied[0]).toBe('Назначать администраторов может только владелец станции.');
        expect(store.isStationAdmin('stranger')).toBe(false);

        const responses: string[] = [];
        const rootCommand = (subcommand: string) => client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio',
            user: { id: 'owner' }, options: { getSubcommand: () => subcommand, getUser: () => ({ id: 'helper', bot: false }) },
            deferReply: async () => undefined,
            editReply: async (payload: string) => { responses.push(payload); },
        } as never);
        rootCommand('admin-add');
        await vi.waitFor(() => expect(store.isStationAdmin('helper')).toBe(true));
        const isPrivileged = (id: string) => (bot as unknown as { isOwner: (user: { user: { id: string } }) => boolean })
            .isOwner({ user: { id } });
        expect(isPrivileged('helper')).toBe(true);
        expect(isPrivileged('stranger')).toBe(false);
        const requestAsHelper = () => client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'request',
            user: { id: 'helper', username: 'Helper', globalName: null },
            options: { getString: (key: string) => key === 'query' ? 'Song' : null },
            deferReply: async () => undefined, editReply: async () => undefined,
        } as never);
        requestAsHelper();
        await vi.waitFor(() => expect(submitRequest).toHaveBeenCalledWith(expect.objectContaining({ userId: 'helper', isOwner: true })));
        rootCommand('admin-remove');
        await vi.waitFor(() => expect(store.isStationAdmin('helper')).toBe(false));
        expect(isPrivileged('helper')).toBe(false);
        requestAsHelper();
        await vi.waitFor(() => expect(submitRequest).toHaveBeenCalledTimes(2));
        expect(submitRequest.mock.calls[1]![0]).toMatchObject({ userId: 'helper', isOwner: false });
        expect(responses).toEqual([expect.stringContaining('назначен'), expect.stringContaining('снят')]);
        await bot.stop();
        store.close();
    });

    it('lets a listener join and leave their voice output but not move or stop another channel', async () => {
        const config = { discord: { ownerIds: new Set(['owner']) } } as RadioConfig;
        const connectGuild = vi.fn(async () => undefined);
        const stopGuild = vi.fn();
        const saveGuildOutput = vi.fn();
        const bot = new DiscordRadioBot(config, {} as RadioDirector,
            { stopAll: () => undefined, connectGuild, stopGuild } as unknown as DiscordOutputFanout,
            { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine);
        (bot as unknown as { updateEmptyVoiceTimer: () => void }).updateEmptyVoiceTimer = () => undefined;
        const client = (bot as unknown as { client: Client }).client;
        const channels = new Map([['first', 'voice-a'], ['second', 'voice-b']]);
        const guild = {
            voiceAdapterCreator: {},
            members: { fetch: async (id: string) => ({ voice: {
                channelId: channels.get(id),
                channel: channels.get(id) ? { id: channels.get(id), name: channels.get(id) } : null,
            } }) },
        };
        const responses: string[] = [];
        const issue = (id: string, command: 'join' | 'leave') => client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', guild,
            commandName: 'radio', user: { id }, options: { getSubcommand: () => command },
            deferReply: async () => undefined, editReply: async (value: string) => { responses.push(value); },
        } as never);
        issue('first', 'join');
        await vi.waitFor(() => expect(connectGuild).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(saveGuildOutput).toHaveBeenCalledWith('guild', 'voice-a', true));
        issue('second', 'join');
        await vi.waitFor(() => expect(responses.at(-1)).toContain('другом канале'));
        expect(connectGuild).toHaveBeenCalledOnce();
        issue('second', 'leave');
        await vi.waitFor(() => expect(responses.at(-1)).toContain('слушатель из его голосового канала'));
        expect(stopGuild).not.toHaveBeenCalled();
        issue('first', 'leave');
        await vi.waitFor(() => expect(stopGuild).toHaveBeenCalledWith('guild'));
        expect(saveGuildOutput).toHaveBeenCalledWith('guild', 'disabled', false);
        await bot.stop();
    });

    it('rejects a concurrent listener join so it cannot move or backlog the first output', async () => {
        const config = { discord: { ownerIds: new Set(['owner']) } } as RadioConfig;
        let finishConnect!: () => void;
        const pending = new Promise<void>(resolve => { finishConnect = resolve; });
        const connectGuild = vi.fn(async () => { await pending; });
        const saveGuildOutput = vi.fn();
        const bot = new DiscordRadioBot(config, {} as RadioDirector,
            { stopAll: () => undefined, connectGuild, stopGuild: () => undefined } as unknown as DiscordOutputFanout,
            { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine);
        (bot as unknown as { updateEmptyVoiceTimer: () => void }).updateEmptyVoiceTimer = () => undefined;
        const client = (bot as unknown as { client: Client }).client;
        const guild = { voiceAdapterCreator: {}, members: { fetch: async (id: string) => ({ voice: {
            channelId: id === 'first' ? 'voice-a' : 'voice-b',
            channel: { id: id === 'first' ? 'voice-a' : 'voice-b', name: 'Voice' },
        } }) } };
        const responses: string[] = [];
        const join = (id: string) => client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', guild,
            commandName: 'radio', user: { id }, options: { getSubcommand: () => 'join' },
            deferReply: async () => undefined, editReply: async (value: string) => { responses.push(value); },
            reply: async (value: { content: string }) => { responses.push(value.content); },
        } as never);
        join('first');
        await vi.waitFor(() => expect(connectGuild).toHaveBeenCalledOnce());
        join('second');
        finishConnect();
        await vi.waitFor(() => expect(responses).toHaveLength(2));
        expect(connectGuild).toHaveBeenCalledOnce();
        expect(saveGuildOutput).toHaveBeenCalledWith('guild', 'voice-a', true);
        expect(responses.join(' ')).toContain('уже выполняется');
        await bot.stop();
    });

    it('revokes an admin promptly while their ordinary same-channel join is still connecting', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 900_000, requestTtlMs: 7_200_000,
            studioCooldownMs: 900_000, studioTtlMs: 7_200_000,
            trackCooldownMs: 21_600_000, artistCooldownMs: 2_700_000,
        });
        store.grantStationAdmin('helper', 'owner');
        let finishConnect!: () => void;
        const pending = new Promise<void>(resolve => { finishConnect = resolve; });
        const connectGuild = vi.fn(async () => { await pending; });
        const bot = new DiscordRadioBot({ discord: { ownerIds: new Set(['owner']) } } as RadioConfig,
            {} as RadioDirector, { stopAll: () => undefined, connectGuild } as unknown as DiscordOutputFanout,
            store, [], {} as SpeechEngine);
        (bot as unknown as { updateEmptyVoiceTimer: () => void }).updateEmptyVoiceTimer = () => undefined;
        const client = (bot as unknown as { client: Client }).client;
        const responses: string[] = [];
        client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio', user: { id: 'helper' },
            options: { getSubcommand: () => 'join' }, deferReply: async () => undefined,
            editReply: async (value: string) => { responses.push(value); },
            guild: { voiceAdapterCreator: {}, members: { fetch: async () => ({ voice: {
                channelId: 'voice', channel: { id: 'voice', name: 'Voice' },
            } }) } },
        } as never);
        await vi.waitFor(() => expect(connectGuild).toHaveBeenCalledOnce());
        client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio', user: { id: 'owner' },
            options: { getSubcommand: () => 'admin-remove', getUser: () => ({ id: 'helper', bot: false }) },
            deferReply: async () => undefined, editReply: async (value: string) => { responses.push(value); },
        } as never);
        await vi.waitFor(() => expect(store.isStationAdmin('helper')).toBe(false));
        finishConnect();
        await vi.waitFor(() => expect(responses).toContain('Радио подключено к Voice.'));
        await bot.stop();
        store.close();
    });

    it('does not persist a fresh listener join after the caller leaves during connection', async () => {
        const config = { discord: { ownerIds: new Set(['owner']) } } as RadioConfig;
        let finishConnect!: () => void;
        const pending = new Promise<void>(resolve => { finishConnect = resolve; });
        const connectGuild = vi.fn(async () => { await pending; });
        const stopGuild = vi.fn();
        const saveGuildOutput = vi.fn();
        const bot = new DiscordRadioBot(config, {} as RadioDirector,
            { stopAll: () => undefined, connectGuild, stopGuild } as unknown as DiscordOutputFanout,
            { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine);
        let inVoice = true;
        const replies: string[] = [];
        (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio', user: { id: 'listener' },
            options: { getSubcommand: () => 'join' }, deferReply: async () => undefined,
            editReply: async (value: string) => { replies.push(value); },
            guild: { voiceAdapterCreator: {}, members: { fetch: async () => ({ voice: {
                channelId: inVoice ? 'voice' : null,
                channel: inVoice ? { id: 'voice', name: 'Voice' } : null,
            } }) } },
        } as never);
        await vi.waitFor(() => expect(connectGuild).toHaveBeenCalledOnce());
        inVoice = false;
        finishConnect();
        await vi.waitFor(() => expect(stopGuild).toHaveBeenCalledWith('guild'));
        expect(saveGuildOutput).not.toHaveBeenCalled();
        expect(replies.join(' ')).toContain('изменились во время подключения');
        await bot.stop();
    });

    it('restores the idle auto-return target when a manual join fails', async () => {
        const store = { guildOutputs: () => [{ guildId: 'guild', channelId: 'voice' }], saveGuildOutput: vi.fn() } as unknown as RadioStore;
        const stopGuild = vi.fn();
        const bot = new DiscordRadioBot({ discord: { ownerIds: new Set(['owner']) } } as RadioConfig,
            {} as RadioDirector, { stopAll: () => undefined, stopGuild,
                connectGuild: async () => { throw new Error('voice connection failed'); } } as unknown as DiscordOutputFanout,
            store, [], {} as SpeechEngine);
        const idle = (bot as unknown as { idleVoiceChannels: Map<string, string> }).idleVoiceChannels;
        idle.set('guild', 'voice');
        const replies: string[] = [];
        (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio',
            user: { id: 'listener' }, options: { getSubcommand: () => 'join' },
            deferred: true, replied: false, deferReply: async () => undefined, editReply: async (value: string | { content: string }) => {
                replies.push(typeof value === 'string' ? value : value.content);
            },
            guild: { voiceAdapterCreator: {}, members: { fetch: async () => ({ voice: {
                channelId: 'voice', channel: { id: 'voice', name: 'Voice' },
            } }) } },
        } as never);
        await vi.waitFor(() => expect(replies).toHaveLength(1));
        expect(idle.get('guild')).toBe('voice');
        expect(stopGuild).toHaveBeenCalledWith('guild');
        expect(store.saveGuildOutput).not.toHaveBeenCalled();
        await bot.stop();
    });

    it('does not let a revoked admin finish moving an existing output', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 900_000, requestTtlMs: 7_200_000,
            studioCooldownMs: 900_000, studioTtlMs: 7_200_000,
            trackCooldownMs: 21_600_000, artistCooldownMs: 2_700_000,
        });
        store.grantStationAdmin('helper', 'owner');
        store.saveGuildOutput('guild', 'old', true);
        let finishConnect!: () => void;
        const pending = new Promise<void>(resolve => { finishConnect = resolve; });
        const connectGuild = vi.fn(async () => { await pending; });
        const stopGuild = vi.fn();
        const bot = new DiscordRadioBot({ discord: { ownerIds: new Set(['owner']) } } as RadioConfig,
            {} as RadioDirector, { stopAll: () => undefined, connectGuild, stopGuild } as unknown as DiscordOutputFanout,
            store, [], {} as SpeechEngine);
        (bot as unknown as { voiceChannels: Map<string, string> }).voiceChannels.set('guild', 'old');
        const client = (bot as unknown as { client: Client }).client;
        const replies: string[] = [];
        client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio', user: { id: 'helper' },
            options: { getSubcommand: () => 'join' }, deferReply: async () => undefined,
            editReply: async (value: string | { content: string }) => {
                replies.push(typeof value === 'string' ? value : value.content);
            },
            guild: { voiceAdapterCreator: {}, members: { fetch: async () => ({ voice: {
                channelId: 'new', channel: { id: 'new', name: 'New Voice' },
            } }) } },
        } as never);
        await vi.waitFor(() => expect(connectGuild).toHaveBeenCalledOnce());
        client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'radio', user: { id: 'owner' },
            options: { getSubcommand: () => 'admin-remove', getUser: () => ({ id: 'helper', bot: false }) },
            deferReply: async () => undefined, editReply: async () => undefined,
        } as never);
        await vi.waitFor(() => expect(store.isStationAdmin('helper')).toBe(false));
        finishConnect();
        await vi.waitFor(() => expect(connectGuild).toHaveBeenCalledTimes(2));
        expect(connectGuild.mock.calls[1]![1]).toBe('old');
        expect(stopGuild).not.toHaveBeenCalled();
        expect(store.guildOutputs()).toEqual([{ guildId: 'guild', channelId: 'old' }]);
        expect(replies.join(' ')).toContain('права изменились');
        await bot.stop();
        store.close();
    });

    it('publishes only the user-facing request command', () => {
        expect(commandData.map(command => command.name)).toContain('request');
        expect(commandData.map(command => command.name)).not.toContain('request-track');
    });

    it('keeps ambiguous choices private and accepts exactly one selection from their author', async () => {
        const tracks: Track[] = [
            { provider: 'spotify', id: 'private-id-1', artist: 'Alpha', title: 'First', durationMs: 100_000 },
            { provider: 'ytmusic', id: 'private-id-2', artist: 'Beta', title: 'Second', durationMs: 110_000 },
        ];
        const submitTrackRequest = vi.fn(async () => ({ kind: 'accepted', decision: { requestId: 7, merged: false }, track: tracks[1] }));
        const director = { submitRequest: async () => ({ kind: 'choices', tracks }), submitTrackRequest } as unknown as RadioDirector;
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        const bot = new DiscordRadioBot(config, director, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const client = (bot as unknown as { client: Client }).client;
        let choiceMessage: { content: string; components: Array<{ components: Array<{ data: { custom_id: string } }> }> } | undefined;
        client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'request',
            user: { id: 'owner', username: 'Owner', globalName: null },
            options: { getString: (key: string) => key === 'query' ? 'ambiguous' : null },
            deferReply: async () => undefined,
            editReply: async (message: typeof choiceMessage) => { choiceMessage = message; },
        } as never);
        await vi.waitFor(() => expect(choiceMessage).toBeDefined());
        expect(JSON.stringify(choiceMessage)).not.toContain('private-id');
        const customId = choiceMessage!.components[0]!.components[0]!.data.custom_id;
        const denied: string[] = [];
        client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => false, isStringSelectMenu: () => true, customId, guildId: 'guild',
            user: { id: 'other' }, values: ['1'], reply: async (message: { content: string }) => { denied.push(message.content); },
        } as never);
        await vi.waitFor(() => expect(denied).toHaveLength(1));
        expect(submitTrackRequest).not.toHaveBeenCalled();
        const selected: string[] = [];
        const choose = () => client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => false, isStringSelectMenu: () => true, customId, guildId: 'guild',
            user: { id: 'owner' }, values: ['1'], deferUpdate: async () => undefined,
            editReply: async (message: { content: string }) => { selected.push(message.content); },
            reply: async (message: { content: string }) => { selected.push(message.content); },
        } as never);
        choose();
        choose();
        await vi.waitFor(() => expect(selected).toHaveLength(2));
        expect(submitTrackRequest).toHaveBeenCalledOnce();
        expect(submitTrackRequest.mock.calls[0]![0]).toMatchObject({ userId: 'owner', track: tracks[1], isOwner: true });
        expect(selected.join(' ')).toContain('Заявка #7 принята');
        expect(selected.join(' ')).toMatch(/обрабатывается|Время выбора истекло/);
        await bot.stop();
    });

    it('rejects an expired selection without submitting a track', async () => {
        const submitTrackRequest = vi.fn();
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        const bot = new DiscordRadioBot(config, { submitTrackRequest } as unknown as RadioDirector, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        (bot as unknown as { pendingChoices: Map<string, unknown> }).pendingChoices.set('expired', {
            guildId: 'guild', userId: 'owner', userName: 'Owner', tracks: [], expiresAt: Date.now() - 1,
        });
        const replies: string[] = [];
        (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => false, isStringSelectMenu: () => true,
            customId: 'radio-request:expired', guildId: 'guild', user: { id: 'owner' }, values: ['0'],
            update: async (message: { content: string }) => { replies.push(message.content); },
            reply: async (message: { content: string }) => { replies.push(message.content); },
        } as never);
        await bot.stop();
        expect(replies).toEqual(['Время выбора истекло. Повторите /request.']);
        expect(submitTrackRequest).not.toHaveBeenCalled();
    });

    it('disconnects an empty voice channel after three minutes and preserves one with a human', async () => {
        vi.useFakeTimers();
        try {
            const config = { discord: { ownerIds: new Set<string>(), trustedRoleIds: new Set<string>() } } as RadioConfig;
            const stopGuild = vi.fn();
            const connectGuild = vi.fn(async () => undefined);
            const saveGuildOutput = vi.fn();
            const bot = new DiscordRadioBot(config, {} as RadioDirector, { stopAll: () => undefined, stopGuild, connectGuild } as unknown as DiscordOutputFanout, { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine);
            Object.defineProperty((bot as unknown as { client: Client }).client, 'user', { value: { id: 'bot' }, configurable: true });
            const voiceChannels = (bot as unknown as { voiceChannels: Map<string, string> }).voiceChannels;
            const update = (bot as unknown as { updateEmptyVoiceTimer: (guildId: string, channelId: string, guild: unknown) => void }).updateEmptyVoiceTimer.bind(bot);
            const members: Array<{ user: { bot: boolean } }> = [];
            let botVisible = false;
            let unknownHumanVoice = false;
            let unknownBotVoice = false;
            const voiceStates = () => [
                ...(botVisible ? [{ id: 'bot', channelId: 'voice', member: { user: { bot: true } } }] : []),
                ...(unknownHumanVoice ? [{ id: 'listener', channelId: 'voice', member: null }] : []),
                ...(unknownBotVoice ? [{ id: 'other-bot', channelId: 'voice', member: null }] : []),
            ];
            const guild = {
                id: 'guild', voiceAdapterCreator: {},
                voiceStates: { cache: {
                    some: (test: (state: { id: string; channelId: string; member: { user: { bot: boolean } } | null }) => boolean) => voiceStates().some(test),
                    get: (id: string) => voiceStates().find(state => state.id === id),
                    values: () => voiceStates().values(),
                } },
                members: { fetch: async (id: string) => ({ user: { bot: id === 'other-bot' } }) },
                channels: { fetch: async () => ({ isVoiceBased: () => true, members: { some: (test: (member: typeof members[number]) => boolean) => members.some(test) } }) },
            };
            voiceChannels.set('guild', 'voice');
            update('guild', 'voice', guild);
            await vi.advanceTimersByTimeAsync(180_000);
            expect(stopGuild).not.toHaveBeenCalled();
            botVisible = true;
            unknownHumanVoice = true;
            await vi.advanceTimersByTimeAsync(180_000);
            expect(stopGuild).not.toHaveBeenCalled();
            unknownHumanVoice = false;
            unknownBotVoice = true;
            update('guild', 'voice', guild);
            await vi.advanceTimersByTimeAsync(180_000);
            expect(stopGuild).toHaveBeenCalledWith('guild');
            expect(saveGuildOutput).toHaveBeenCalledWith('guild', 'voice', false);
            (bot as unknown as { client: Client }).client.emit(Events.VoiceStateUpdate,
                { channelId: null }, { id: 'other-bot', guild, channelId: 'voice', member: null } as never);
            await vi.advanceTimersByTimeAsync(0);
            expect(connectGuild).not.toHaveBeenCalled();
            members.push({ user: { bot: false } });
            unknownHumanVoice = true;
            (bot as unknown as { client: Client }).client.emit(Events.VoiceStateUpdate,
                { channelId: null }, { id: 'listener', guild, channelId: 'voice', member: null } as never);
            await vi.advanceTimersByTimeAsync(0);
            expect(connectGuild).toHaveBeenCalledWith('guild', 'voice', guild.voiceAdapterCreator);
            expect(saveGuildOutput).toHaveBeenCalledWith('guild', 'voice', true);
            await vi.advanceTimersByTimeAsync(180_000);
            expect(stopGuild).toHaveBeenCalledTimes(1);
            await bot.stop();
        } finally {
            vi.useRealTimers();
        }
    });
    it('does not persist a stale auto-rejoin after the listener leaves during voice admission', async () => {
        const config = { discord: { ownerIds: new Set<string>(), trustedRoleIds: new Set<string>() } } as RadioConfig;
        let admit!: () => void;
        const pendingConnect = new Promise<void>(resolve => { admit = resolve; });
        const stopGuild = vi.fn();
        const saveGuildOutput = vi.fn();
        const bot = new DiscordRadioBot(config, {} as RadioDirector,
            { stopAll: () => undefined, stopGuild, connectGuild: () => pendingConnect } as unknown as DiscordOutputFanout,
            { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine);
        const state = { channelId: 'voice' as string | null };
        const guild = { voiceAdapterCreator: {}, voiceStates: { cache: {
            get: (id: string) => id === 'listener' ? state : undefined,
            values: () => (state.channelId ? [{ id: 'listener', channelId: state.channelId, member: { user: { bot: false } } }] : []).values(),
        } } };
        (bot as unknown as { idleVoiceChannels: Map<string, string> }).idleVoiceChannels.set('guild', 'voice');
        (bot as unknown as { rejoinForHuman: (guildId: string, channelId: string, guild: unknown, humanId: string) => void })
            .rejoinForHuman('guild', 'voice', guild, 'listener');
        state.channelId = null;
        admit();
        await vi.waitFor(() => expect(stopGuild).toHaveBeenCalledWith('guild'));
        expect(saveGuildOutput).not.toHaveBeenCalled();
        await bot.stop();
    });
    it('keeps auto-rejoin when another listener arrives before the first leaves', async () => {
        const config = { discord: { ownerIds: new Set<string>(), trustedRoleIds: new Set<string>() } } as RadioConfig;
        let admit!: () => void;
        const pendingConnect = new Promise<void>(resolve => { admit = resolve; });
        const stopGuild = vi.fn();
        const saveGuildOutput = vi.fn();
        const bot = new DiscordRadioBot(config, {} as RadioDirector,
            { stopAll: () => undefined, stopGuild, connectGuild: () => pendingConnect } as unknown as DiscordOutputFanout,
            { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine);
        const states = new Map<string, { id: string; channelId: string; member: { user: { bot: boolean } } }>();
        states.set('first', { id: 'first', channelId: 'voice', member: { user: { bot: false } } });
        const guild = { voiceAdapterCreator: {}, voiceStates: { cache: {
            get: (id: string) => states.get(id), values: () => states.values(), some: (test: (state: NonNullable<ReturnType<typeof states.get>>) => boolean) => [...states.values()].some(test),
        } } };
        (bot as unknown as { idleVoiceChannels: Map<string, string> }).idleVoiceChannels.set('guild', 'voice');
        (bot as unknown as { rejoinForHuman: (guildId: string, channelId: string, guild: unknown, humanId: string) => void })
            .rejoinForHuman('guild', 'voice', guild, 'first');
        states.set('second', { id: 'second', channelId: 'voice', member: { user: { bot: false } } });
        states.delete('first');
        admit();
        await vi.waitFor(() => expect(saveGuildOutput).toHaveBeenCalledWith('guild', 'voice', true));
        expect(stopGuild).not.toHaveBeenCalled();
        await bot.stop();
    });
    it('does not persist auto-rejoin when an uncached listener leaves during member lookup', async () => {
        const config = { discord: { ownerIds: new Set<string>(), trustedRoleIds: new Set<string>() } } as RadioConfig;
        let resolveMember!: (member: { user: { bot: boolean } }) => void;
        const memberLookup = new Promise<{ user: { bot: boolean } }>(resolve => { resolveMember = resolve; });
        const fetch = vi.fn(() => memberLookup);
        const stopGuild = vi.fn();
        const saveGuildOutput = vi.fn();
        const bot = new DiscordRadioBot(config, {} as RadioDirector,
            { stopAll: () => undefined, stopGuild, connectGuild: async () => undefined } as unknown as DiscordOutputFanout,
            { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine);
        const states = new Map([['listener', { id: 'listener', channelId: 'voice', member: null }]]);
        const guild = { voiceAdapterCreator: {}, members: { fetch }, voiceStates: { cache: {
            get: (id: string) => states.get(id), values: () => states.values(),
        } } };
        (bot as unknown as { idleVoiceChannels: Map<string, string> }).idleVoiceChannels.set('guild', 'voice');
        (bot as unknown as { rejoinForHuman: (guildId: string, channelId: string, guild: unknown, humanId: string) => void })
            .rejoinForHuman('guild', 'voice', guild, 'listener');
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('listener'));
        states.delete('listener');
        resolveMember({ user: { bot: false } });
        await vi.waitFor(() => expect(stopGuild).toHaveBeenCalledWith('guild'));
        expect(saveGuildOutput).not.toHaveBeenCalled();
        await bot.stop();
    });
    it('does not expose external error text to Discord replies or event logs', async () => {
        const marker = 'secret-marker-never-echo';
        const director = { submitRequest: async () => { throw new Error(marker); } } as unknown as RadioDirector;
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        const bot = new DiscordRadioBot(config, director, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const replies: string[] = [];
        const interaction = {
            isChatInputCommand: () => true,
            inGuild: () => true,
            guildId: 'guild',
            commandName: 'request',
            user: { id: 'owner', username: 'Owner', globalName: null },
            options: { getString: (key: string) => (key === 'query' ? 'Song' : null) },
            deferReply: async () => undefined,
            editReply: async (message: { content: string }) => { replies.push(message.content); },
            followUp: async (message: { content: string }) => { replies.push(message.content); },
            deferred: true,
        };
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const client = (bot as unknown as { client: Client }).client;
        client.emit(Events.Error, new Error(marker));
        client.emit(Events.InteractionCreate, interaction as never);
        await bot.stop();
        expect(replies).toHaveLength(1);
        expect(replies[0]).not.toContain(marker);
        expect(errorLog.mock.calls.flat().join(' ')).not.toContain(marker);
        expect(errorLog.mock.calls.flat().join(' ')).toContain('discord.command_failed');
        expect(errorLog.mock.calls.flat().join(' ')).toContain('"command":"request"');
        errorLog.mockRestore();
    });

    it('ignores guild roles for listener admission and administrator bypass', async () => {
        const track: Track = { provider: 'ytmusic', id: 'track', artist: 'Artist', title: 'Song', durationMs: 180_000 };
        const submitRequest = vi.fn(async () => ({ kind: 'accepted', decision: { requestId: 2, merged: false }, track }));
        const director = { submitRequest } as unknown as RadioDirector;
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set(['trusted']) } } as RadioConfig;
        const bot = new DiscordRadioBot(config, director, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const replies: string[] = [];
        const interaction = {
            isChatInputCommand: () => true,
            inGuild: () => true,
            guildId: 'guild',
            commandName: 'request',
            user: { id: 'listener', username: 'Listener', globalName: null },
            member: { roles: ['trusted'] },
            options: { getString: (key: string) => key === 'query' ? 'Song' : null },
            deferReply: async () => undefined,
            editReply: async (message: string) => { replies.push(message); },
        };
        (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, interaction as never);
        await bot.stop();
        expect(submitRequest).toHaveBeenCalledWith(expect.objectContaining({ userId: 'listener', isOwner: false }));
        expect(replies).toEqual([expect.stringContaining('Заявка #2 принята')]);
    });

    it('lets an ordinary guild member request music when trusted roles are not configured', async () => {
        const track: Track = { provider: 'ytmusic', id: 'track', artist: 'Artist', title: 'Song', durationMs: 180_000 };
        const submitRequest = vi.fn(async () => ({ kind: 'accepted', decision: { requestId: 2, merged: false }, track }));
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        const bot = new DiscordRadioBot(config, { submitRequest } as unknown as RadioDirector, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const replies: string[] = [];
        (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName: 'request',
            user: { id: 'listener', username: 'Listener', globalName: null }, member: { roles: [] },
            options: { getString: (key: string) => key === 'query' ? 'Song' : null },
            deferReply: async () => undefined,
            editReply: async (message: string) => { replies.push(message); },
        } as never);
        await bot.stop();
        expect(submitRequest).toHaveBeenCalledWith(expect.objectContaining({ userId: 'listener', isOwner: false }));
        expect(replies).toEqual([expect.stringContaining('Заявка #2 принята')]);
    });

    it('tells listeners when an identical request or studio letter was already received', async () => {
        const song: Track = { provider: 'ytmusic', id: 'abcdefghijk', artist: 'Artist', title: 'Song', durationMs: 180_000 };
        const director = {
            submitRequest: async () => ({ kind: 'accepted', decision: { requestId: 7, merged: false, duplicateSubmission: true }, track: song }),
            submitStudio: async () => ({ accepted: true, messageId: 9, duplicateSubmission: true }),
        } as unknown as RadioDirector;
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        const bot = new DiscordRadioBot(config, director, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const replies: string[] = [];
        for (const [commandName, field, value] of [['request', 'query', 'Song'], ['studio', 'message', 'Поздравьте Машу']]) {
            (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, {
                isChatInputCommand: () => true, inGuild: () => true, guildId: 'guild', commandName,
                user: { id: 'listener', username: 'Listener', globalName: null },
                options: { getString: (key: string) => key === field ? value : null },
                deferReply: async () => undefined,
                editReply: async (message: string) => { replies.push(message); },
            } as never);
        }
        await bot.stop();
        expect(replies).toEqual([expect.stringContaining('Заявка #7 уже принята'), expect.stringContaining('Письмо #9 уже получено')]);
    });

    it('closes output promptly and gives an accepted request a grace period to finish', async () => {
        const track: Track = { provider: 'ytmusic', id: 'abcdefghijk', title: 'Song', artist: 'Artist', durationMs: 180_000 };
        let releaseRequest = (): void => undefined;
        const request = new Promise<{ kind: 'accepted'; decision: { accepted: true; requestId: number; itemId: number; merged: false }; track: Track }>(resolve => {
            releaseRequest = () => resolve({ kind: 'accepted', decision: { accepted: true, requestId: 1, itemId: 1, merged: false }, track });
        });
        const director = { submitRequest: async () => await request } as unknown as RadioDirector;
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        const stopAll = vi.fn();
        const bot = new DiscordRadioBot(config, director, { stopAll } as unknown as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const replies: string[] = [];
        const deferFlags: number[] = [];
        const interaction = {
            isChatInputCommand: () => true,
            inGuild: () => true,
            guildId: 'guild',
            commandName: 'request',
            user: { id: 'owner', username: 'Owner', globalName: null },
            options: { getString: (key: string) => (key === 'query' ? 'Artist Song' : null) },
            deferReply: async (options: { flags: number }) => { deferFlags.push(options.flags); },
            editReply: async (message: string) => {
                replies.push(message);
            },
        };
        const client = (bot as unknown as { client: Client }).client;
        client.emit(Events.InteractionCreate, interaction as never);
        let stopped = false;
        const stopping = bot.stop().then(() => {
            stopped = true;
        });
        await delay(0);
        expect(stopped).toBe(false);
        expect(stopAll).toHaveBeenCalledOnce();
        releaseRequest();
        await stopping;
        expect(replies).toHaveLength(1);
        expect(replies[0]).toContain('Заявка #1 принята');
        expect(deferFlags).toEqual([MessageFlags.Ephemeral]);
    });

    it('finishes shutdown after the grace period when a command never settles', async () => {
        const director = { submitRequest: () => new Promise(() => undefined) } as unknown as RadioDirector;
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        const stopAll = vi.fn();
        const bot = new DiscordRadioBot(config, director, { stopAll } as unknown as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine, [], 10);
        const client = (bot as unknown as { client: Client }).client;
        const destroy = vi.spyOn(client, 'destroy');
        client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true,
            inGuild: () => true,
            guildId: 'guild',
            commandName: 'request',
            user: { id: 'owner', username: 'Owner', globalName: null },
            options: { getString: () => 'Song' },
            deferReply: async () => undefined,
        } as never);
        const stopping = bot.stop();
        expect(stopAll).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
        await expect(Promise.race([
            stopping,
            delay(500).then(() => { throw new Error('shutdown remained blocked'); }),
        ])).resolves.toBeUndefined();
        expect(bot.stop()).toBe(stopping);
    });

    it('destroys the gateway even when voice teardown fails', async () => {
        const config = { discord: { ownerIds: new Set<string>(), trustedRoleIds: new Set<string>() } } as RadioConfig;
        const bot = new DiscordRadioBot(config, {} as RadioDirector, {
            stopAll: () => { throw new Error('voice teardown failed'); },
        } as unknown as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const destroy = vi.spyOn((bot as unknown as { client: Client }).client, 'destroy');
        await expect(bot.stop()).rejects.toThrow('Discord bot shutdown failed');
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('does not connect or persist a join after member lookup outlives shutdown', async () => {
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        let finishLookup = (member: unknown): void => undefined;
        const member = new Promise(resolve => { finishLookup = resolve; });
        const connectGuild = vi.fn(async () => undefined);
        const saveGuildOutput = vi.fn();
        const bot = new DiscordRadioBot(config, {} as RadioDirector, {
            stopAll: () => undefined, connectGuild,
        } as unknown as DiscordOutputFanout, { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine, [], 10);
        (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true,
            inGuild: () => true,
            guildId: 'guild',
            commandName: 'radio',
            user: { id: 'owner' },
            options: { getSubcommand: () => 'join' },
            deferReply: async () => undefined,
            guild: { members: { fetch: () => member }, voiceAdapterCreator: {} },
        } as never);
        await bot.stop();
        finishLookup({ voice: { channel: { id: 'voice', name: 'Voice' } } });
        await delay(0);
        expect(connectGuild).not.toHaveBeenCalled();
        expect(saveGuildOutput).not.toHaveBeenCalled();
    });

    it('removes a late join without writing to closed SQLite', async () => {
        const config = { discord: { ownerIds: new Set(['owner']), trustedRoleIds: new Set<string>() } } as RadioConfig;
        let finishConnection = (): void => undefined;
        const connection = new Promise<void>(resolve => { finishConnection = resolve; });
        let connected = false;
        let storeClosed = false;
        const connectGuild = vi.fn(async () => { await connection; connected = true; });
        const stopGuild = vi.fn(() => { connected = false; });
        const saveGuildOutput = vi.fn(() => {
            if (storeClosed) throw new Error('write after SQLite close');
        });
        const bot = new DiscordRadioBot(config, {} as RadioDirector, {
            stopAll: () => { connected = false; }, connectGuild, stopGuild,
        } as unknown as DiscordOutputFanout, { saveGuildOutput } as unknown as RadioStore, [], {} as SpeechEngine, [], 10);
        (bot as unknown as { client: Client }).client.emit(Events.InteractionCreate, {
            isChatInputCommand: () => true,
            inGuild: () => true,
            guildId: 'guild',
            commandName: 'radio',
            user: { id: 'owner' },
            options: { getSubcommand: () => 'join' },
            deferReply: async () => undefined,
            guild: {
                members: { fetch: async () => ({ voice: { channelId: 'voice', channel: { id: 'voice', name: 'Voice' } } }) },
                voiceAdapterCreator: {},
            },
        } as never);
        await vi.waitFor(() => expect(connectGuild).toHaveBeenCalledOnce());
        await bot.stop();
        storeClosed = true;
        finishConnection();
        await vi.waitFor(() => expect(stopGuild).toHaveBeenCalledWith('guild'));
        expect(connected).toBe(false);
        expect(saveGuildOutput).not.toHaveBeenCalled();
    });

    it('aborts a pending command registration without entering login', async () => {
        const config = { discord: { token: 'test-token', clientId: 'test-client', ownerIds: new Set<string>(), trustedRoleIds: new Set<string>() } } as RadioConfig;
        let finishRegistration = (): void => undefined;
        const put = vi.spyOn(REST.prototype, 'put').mockImplementation(() => new Promise(resolve => { finishRegistration = () => resolve({}); }));
        const login = vi.spyOn(Client.prototype, 'login');
        const bot = new DiscordRadioBot(config, {} as RadioDirector, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const starting = bot.start();
        expect(put).toHaveBeenCalledOnce();
        await bot.stop();
        await expect(starting).rejects.toThrow();
        finishRegistration();
        await delay(0);
        expect(login).not.toHaveBeenCalled();
    });

    it('checks cancellation after registration settles and before login starts', async () => {
        const config = { discord: { token: 'test-token', clientId: 'test-client', ownerIds: new Set<string>(), trustedRoleIds: new Set<string>() } } as RadioConfig;
        let finishRegistration = (): void => undefined;
        vi.spyOn(REST.prototype, 'put').mockImplementation(() => new Promise(resolve => { finishRegistration = () => resolve({}); }));
        const login = vi.spyOn(Client.prototype, 'login');
        const bot = new DiscordRadioBot(config, {} as RadioDirector, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const starting = bot.start();
        finishRegistration();
        await bot.stop();
        await expect(starting).rejects.toThrow();
        expect(login).not.toHaveBeenCalled();
    });

    it('aborts pending login and destroys a gateway opened by a late login result', async () => {
        const config = { discord: { token: 'test-token', clientId: 'test-client', ownerIds: new Set<string>(), trustedRoleIds: new Set<string>() } } as RadioConfig;
        vi.spyOn(REST.prototype, 'put').mockResolvedValue({} as never);
        let finishLogin = (_token: string): void => undefined;
        const login = vi.spyOn(Client.prototype, 'login').mockImplementation(() => new Promise<string>(resolve => { finishLogin = resolve; }));
        const bot = new DiscordRadioBot(config, {} as RadioDirector, { stopAll: () => undefined } as DiscordOutputFanout, {} as RadioStore, [], {} as SpeechEngine);
        const client = (bot as unknown as { client: Client }).client;
        const destroy = vi.spyOn(client, 'destroy');
        const starting = bot.start();
        await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
        await bot.stop();
        await expect(starting).rejects.toThrow();
        finishLogin('test-token');
        await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(2));
    });
});
