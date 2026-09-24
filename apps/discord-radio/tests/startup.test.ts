import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { startRadioRuntime, stopRadioRuntime, stopRadioRuntimeDuringStartup } from '../src/startup.js';

describe('radio startup rollback', () => {
    it('closes a partially started bot, director, and SQLite after a health bind failure', async () => {
        const events: string[] = [];
        const failure = new Error('EADDRINUSE');
        await expect(
            startRadioRuntime({
                bot: {
                    start: async () => { events.push('bot.start'); },
                    stop: async () => { events.push('bot.stop'); },
                },
                director: {
                    start: () => { events.push('director.start'); },
                    stop: async () => { events.push('director.stop'); },
                },
                store: { close: () => { events.push('store.close'); } },
                listen: async () => { events.push('health.listen'); throw failure; },
            }),
        ).rejects.toBe(failure);
        expect(events.slice(0, 2)).toEqual(['director.start', 'health.listen']);
        expect(events).not.toContain('bot.start');
        expect(events.slice(2, 4).sort()).toEqual(['bot.stop', 'director.stop']);
        expect(events[4]).toBe('store.close');
    });

    it('keeps the station running when Discord startup fails and retries it in the background', async () => {
        const events: string[] = [];
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const bot = {
            start: vi.fn(async () => {
                events.push('bot.start');
                if (events.filter(event => event === 'bot.start').length === 1) throw new Error('Discord unavailable');
            }),
            stop: async () => { events.push('bot.stop'); },
        };
        const director = { start: () => { events.push('director.start'); },
            stop: async () => { events.push('director.stop'); } };
        const store = { close: () => { events.push('store.close'); } };
        const server = { close: (callback: (error?: Error) => void) => callback() } as unknown as Server;
        const started = await startRadioRuntime({ bot, director, store, listen: async () => {
            events.push('health.listen'); return server;
        } });
        try {
            expect(started).toBe(server);
            expect(events.slice(0, 3)).toEqual(['director.start', 'health.listen', 'bot.start']);
            expect(events).not.toContain('director.stop');
            await expect.poll(() => bot.start.mock.calls.length, { timeout: 2_000 }).toBe(2);
            expect(warning).toHaveBeenCalledWith(JSON.stringify({ level: 'warn', event: 'discord.start.retry', waitMs: 1_000 }));
        } finally {
            await stopRadioRuntime({ bot, director, store, server });
            warning.mockRestore();
        }
    });

    it('closes every resource even when audio shutdown fails', async () => {
        const events: string[] = [];
        const server = {
            close: (callback: (error?: Error) => void) => {
                events.push('health.close');
                callback();
            },
        } as unknown as Server;
        await expect(
            stopRadioRuntime({
                bot: { start: async () => undefined, stop: async () => { events.push('bot.stop'); } },
                director: { start: () => undefined, stop: async () => { events.push('director.stop'); throw new Error('audio stop failed'); } },
                store: { close: () => { events.push('store.close'); } },
                server,
            }),
        ).rejects.toThrow('Radio shutdown failed: director');
        expect(events).toEqual(['director.stop', 'bot.stop', 'health.close', 'store.close']);
    });

    it('stops Discord immediately when shutdown interrupts startup', async () => {
        const events: string[] = [];
        let rejectStartup = (_error: Error): void => undefined;
        const startup = new Promise<Server>((_resolve, reject) => { rejectStartup = reject; });
        const stopping = stopRadioRuntimeDuringStartup({
            bot: { start: async () => undefined, stop: async () => { events.push('bot.stop'); } },
            director: { start: () => undefined, stop: async () => { events.push('director.stop'); } },
            store: { close: () => { events.push('store.close'); } },
        }, startup);
        expect(events).toEqual(['bot.stop']);
        rejectStartup(new Error('startup aborted'));
        await stopping;
        expect(events).toEqual(['bot.stop']);
    });

    it('does not start Discord after shutdown overtakes the health listener', async () => {
        const events: string[] = [];
        let finishListen!: (server: Server) => void;
        const pendingListen = new Promise<Server>(resolve => { finishListen = resolve; });
        const server = { close: (callback: (error?: Error) => void) => callback() } as unknown as Server;
        const bot = { start: async () => { events.push('bot.start'); }, stop: async () => { events.push('bot.stop'); } };
        const director = { start: () => { events.push('director.start'); },
            stop: async () => { events.push('director.stop'); } };
        const store = { close: () => { events.push('store.close'); } };
        const startup = startRadioRuntime({ bot, director, store, listen: async () => await pendingListen });
        const stopping = stopRadioRuntimeDuringStartup({ bot, director, store }, startup);
        finishListen(server);
        await stopping;
        expect(events).not.toContain('bot.start');
        expect(events).toContain('director.stop');
        expect(events).toContain('store.close');
    });

    it('starts Discord teardown while director shutdown is still pending', async () => {
        const events: string[] = [];
        let finishDirector = (): void => undefined;
        const directorStopped = new Promise<void>(resolve => { finishDirector = resolve; });
        const server = { close: (callback: (error?: Error) => void) => { events.push('health.close'); callback(); } } as unknown as Server;
        const stopping = stopRadioRuntime({
            bot: { start: async () => undefined, stop: async () => { events.push('bot.stop'); } },
            director: { start: () => undefined, stop: async () => { events.push('director.stop'); await directorStopped; } },
            store: { close: () => { events.push('store.close'); } },
            server,
        });
        await delay(0);
        expect(events).toEqual(['director.stop', 'bot.stop']);
        finishDirector();
        await stopping;
        expect(events).toEqual(['director.stop', 'bot.stop', 'health.close', 'store.close']);
    });
});
