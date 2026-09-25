import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_BASE, HOST_IDS, HOST_PROFILES } from '../src/host-profiles.js';
import { FallbackScriptWriter, OpenAiScriptWriter, TemplateScriptWriter } from '../src/host.js';
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

    it('keeps malformed and overlong DeepSeek copy off air and out of logs', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0,
            studioTtlMs: 60_000, trackCooldownMs: 0, artistCooldownMs: 0,
        });
        const replies = [JSON.stringify({ text: `Начинаем эфир. ${'лишний '.repeat(70)}private listener data` }),
            '{"text":"private listener data"'];
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() } }] }),
            { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const writer = new FallbackScriptWriter(new OpenAiScriptWriter({ apiKey: 'test-only',
            baseUrl: 'https://tooken.club/v1', apiFormat: 'chat', model: 'gpt-6-luna',
            timeoutMs: 1_000, hourlyLimit: 0, dailyLimit: 0 }, store));
        try {
            const first = await writer.writeBreak({ kind: 'station', hostId: 'deepseek', recentLines: [] });
            const second = await writer.writeBreak({ kind: 'station', hostId: 'deepseek', recentLines: [first] });
            expect(first).toBeTruthy();
            expect(second).toBeTruthy();
            expect(`${first} ${second}`).not.toContain('private listener data');
            expect(warning.mock.calls).toEqual([
                [JSON.stringify({ level: 'warn', event: 'host.script.fallback', reason: 'invalid_copy', detail: 'length' })],
                [JSON.stringify({ level: 'warn', event: 'host.script.fallback', reason: 'invalid_copy', detail: 'structured_text' })],
            ]);
            expect(JSON.stringify(warning.mock.calls)).not.toContain('private listener data');
            const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
                messages: Array<{ content: string }>;
            };
            expect(firstPayload.messages[0]?.content).toContain('не более 55 слов и 350 символов');
            expect(firstPayload.messages[0]?.content).toContain('до 30 слов и 200 символов');
        } finally {
            warning.mockRestore();
            store.close();
        }
    });

    it('rejects a forward cue for the preceding record without banning a back-announce', async () => {
        const store = new RadioStore(':memory:', {
            requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0,
            studioTtlMs: 60_000, trackCooldownMs: 0, artistCooldownMs: 0,
        });
        const copies = [
            'Следующий трек — Лаид ту Рест. Держитесь.',
            'Дальше — Лаид ту Рест. Держитесь.',
            'Сейчас прозвучит Лаид ту Рест. Держитесь.',
            'Только что звучал Лаид ту Рест. Следующий трек — Бетон.',
            'Следующий трек — Бетон, а Лаид ту Рест только что звучал.',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ text: copies.shift() }) } }],
        }), { status: 200 })));
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1',
            apiFormat: 'chat', model: 'gpt-6-luna', timeoutMs: 1_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        const context = { kind: 'station' as const, hostId: 'luna' as const, recentLines: [],
            precedingTrack: { provider: 'ytmusic' as const, id: 'previous123', title: 'Лаид ту Рест',
                artist: 'Исполнитель', durationMs: 180_000 },
            nextTrack: { provider: 'ytmusic' as const, id: 'nexttrack123', title: 'Бетон',
                artist: 'Другой исполнитель', durationMs: 180_000 } };
        try {
            await expect(writer.writeBreak(context)).rejects.toThrow('cued the preceding track as next');
            await expect(writer.writeBreak(context)).rejects.toThrow('cued the preceding track as next');
            await expect(writer.writeBreak(context)).rejects.toThrow('cued the preceding track as next');
            await expect(writer.writeBreak(context)).resolves.toBe('Только что звучал Лаид ту Рест. Следующий трек — Бетон.');
            await expect(writer.writeBreak(context)).resolves.toBe('Следующий трек — Бетон, а Лаид ту Рест только что звучал.');
        } finally {
            store.close();
        }
    });
});
