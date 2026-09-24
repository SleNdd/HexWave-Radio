import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_BASE, HOST_IDS, HOST_PROFILES } from '../src/host-profiles.js';
import { OpenAiScriptWriter, TemplateScriptWriter } from '../src/host.js';
import { RadioStore } from '../src/storage.js';

afterEach(() => vi.unstubAllGlobals());

describe('host profiles', () => {
    it('routes each host to its allowlisted Tooken model while organizer stays Luna', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0,
            studioTtlMs: 60_000, trackCooldownMs: 0, artistCooldownMs: 0,
        });
        const calls: Array<{ url: string; body: { model: string; messages: Array<{ content: string }> } }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, body: JSON.parse(String(init.body)) as typeof calls[number]['body'] });
            return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Продолжаем эфир."}' } }] }), { status: 200 });
        }));
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1',
            apiFormat: 'chat', model: 'gpt-6-luna', timeoutMs: 1_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        try {
            for (const hostId of HOST_IDS) {
                expect(await writer.writeBreak({ kind: 'station', hostId, recentLines: [] })).toBe('Продолжаем эфир.');
            }
            for (const [index, hostId] of HOST_IDS.entries()) {
                expect(calls[index]?.url).toBe('https://tooken.club/v1/chat/completions');
                expect(calls[index]?.body.model).toBe(HOST_PROFILES[hostId].model);
                expect(calls[index]?.body.messages[0]?.content).toContain(HOST_PROFILES[hostId].personality);
            }
            expect(HOST_BASE).not.toContain('кожаные мешки');
            expect(new Set(HOST_IDS.map(id => HOST_PROFILES[id].voice)).size).toBe(6);
            expect(new Set(HOST_IDS.map(id => HOST_PROFILES[id].onAirName)).size).toBe(6);
        } finally {
            store.close();
        }
    });

    it('introduces each host by a pronounceable on-air name only on an intro break', async () => {
        const writer = new TemplateScriptWriter();
        for (const hostId of HOST_IDS) {
            const intro = await writer.writeBreak({ kind: 'intro', hostId, recentLines: [] });
            const station = await writer.writeBreak({ kind: 'station', hostId, recentLines: [] });
            expect(intro).toContain(HOST_PROFILES[hostId].onAirName);
            expect(station).not.toContain(HOST_PROFILES[hostId].onAirName);
        }
    });

    it('rejects a normal link that calls back to a previous studio sender', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0,
            studioTtlMs: 60_000, trackCooldownMs: 0, artistCooldownMs: 0,
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            choices: [{ message: { content: '{"text":"Саня, я всё ещё помню твоё письмо."}' } }],
        }), { status: 200 })));
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1',
            apiFormat: 'chat', model: 'gpt-6-luna', timeoutMs: 1_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        try {
            await expect(writer.writeBreak({ kind: 'station', hostId: 'luna', recentLines: [],
                memory: { earlierSpins: [], recentThemes: [], hostLines: [], earlierHostLines: [],
                    listenerSignals: [{ kind: 'studio', text: 'Поменяй жанр', userName: 'Саня', createdAt: Date.now() }] } }))
                .rejects.toThrow(/earlier listener mention/);
        } finally {
            store.close();
        }
    });

    it('requires an introduction to actually say the host name', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0,
            studioTtlMs: 60_000, trackCooldownMs: 0, artistCooldownMs: 0,
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            choices: [{ message: { content: '{"text":"Я уже у микрофона. Начинаем смену."}' } }],
        }), { status: 200 })));
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1',
            apiFormat: 'chat', model: 'gpt-6-luna', timeoutMs: 1_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        try {
            await expect(writer.writeBreak({ kind: 'intro', hostId: 'deepseek', recentLines: [] }))
                .rejects.toThrow(/omitted the on-air name/);
        } finally {
            store.close();
        }
    });

    it('accepts compatible providers wrapping valid copy in text or a JSON fence', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0,
            studioTtlMs: 60_000, trackCooldownMs: 0, artistCooldownMs: 0,
        });
        const copies = ['Продолжаем эфир.', '```json\n{"text":"Следующий трек уже готов."}\n```'];
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            choices: [{ message: { content: copies.shift() } }],
        }), { status: 200 })));
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1',
            apiFormat: 'chat', model: 'gpt-6-luna', timeoutMs: 1_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        try {
            expect(await writer.writeBreak({ kind: 'station', hostId: 'sol', recentLines: [] })).toBe('Продолжаем эфир.');
            expect(await writer.writeBreak({ kind: 'station', hostId: 'claude', recentLines: [] })).toBe('Следующий трек уже готов.');
        } finally {
            store.close();
        }
    });
});
