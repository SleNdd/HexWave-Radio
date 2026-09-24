import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

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
        expect(events.slice(0, 3)).toEqual(['bot.start', 'director.start', 'health.listen']);
        expect(events.slice(3, 5).sort()).toEqual(['bot.stop', 'director.stop']);
        expect(events[5]).toBe('store.close');
    });

    it('also closes a bot that fails partway through startup', async () => {
        const events: string[] = [];
        await expect(
            startRadioRuntime({
                bot: {
                    start: async () => { throw new Error('Discord login failed'); },
                    stop: async () => { events.push('bot.stop'); },
                },
                director: {
                    start: () => { events.push('director.start'); },
                    stop: async () => { events.push('director.stop'); },
                },
                store: { close: () => { events.push('store.close'); } },
                listen: async () => { throw new Error('health should not start'); },
            }),
        ).rejects.toThrow('Discord login failed');
        expect(events).not.toContain('director.start');
        expect(events).toContain('bot.stop');
        expect(events.at(-1)).toBe('store.close');
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
