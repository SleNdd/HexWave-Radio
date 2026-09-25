import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiScriptWriter } from '../src/host.js';
import { fallbackShowPlan, validateShowProposal } from '../src/showrunner.js';
import { RadioStore } from '../src/storage.js';

const policy = {
    requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0, studioTtlMs: 60_000,
    trackCooldownMs: 0, artistCooldownMs: 0,
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('showrunner', () => {
    it('has bounded mixed-language fallback seeds and rejects malformed plans', () => {
        const plan = fallbackShowPlan(1_000_000, []);
        expect(validateShowProposal(plan)).toEqual(plan);
        expect(() => validateShowProposal({ ...plan, theme: ' ' })).toThrow('invalid theme: short');
        expect(() => validateShowProposal({ ...plan, theme: 'x'.repeat(101) })).toThrow('invalid theme: long');
        expect(() => validateShowProposal({ ...plan, theme: 'https://example.test/music' })).toThrow('invalid theme: url');
        expect(plan.queries.some(query => /[А-ЯЁ]/iu.test(query))).toBe(true);
        expect(plan.queries.some(query => /[A-Z]/iu.test(query))).toBe(true);
        expect(() => validateShowProposal({ ...plan, queries: ['русский рок', 'русский рок', 'indie rock'] })).toThrow();
        expect(() => validateShowProposal({ ...plan, queries: ['русский рок', 'indie rock', 'https://example.test/song'] })).toThrow();
        const requested = ['drum n bass', 'phonk', 'metal', 'techno', 'electronic'];
        expect(fallbackShowPlan(1_000_000, [], requested).queries).toEqual(requested);
        expect(validateShowProposal(fallbackShowPlan(1_000_000, [], requested)).queries).toEqual(requested);
        const longAiHorizon = Array.from({ length: 10 }, (_, index) => `Artist ${index} — Song ${index}`);
        expect(validateShowProposal({ ...plan, queries: longAiHorizon }).queries).toEqual(longAiHorizon);
        expect(() => validateShowProposal({ ...plan, queries: [...longAiHorizon, 'Artist 10 — Song 10'] })).toThrow();
    });

    it('uses the Tooken Chat Completions endpoint without forwarding a direct OpenAI key', async () => {
        const store = new RadioStore(':memory:', policy);
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"query":"drum n bass"}' } }] }) }));
        vi.stubGlobal('fetch', fetchMock);
        const writer = new OpenAiScriptWriter({ apiKey: 'tooken-key', baseUrl: 'https://tooken.club/v1', apiFormat: 'chat',
            model: 'gpt-6-luna', timeoutMs: 1_000, hourlyLimit: 1, dailyLimit: 1 }, store);
        expect(await writer.rewriteMusicQuery('что-нибудь быстрое')).toBe('drum n bass');
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://tooken.club/v1/chat/completions');
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(init.redirect).toBe('error');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer tooken-key');
        const sent = JSON.parse(String(init.body)) as { model: string; reasoning_effort?: string; max_completion_tokens: number };
        expect(sent).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 80 });
        expect(sent.reasoning_effort).toBeUndefined();
        store.close();
    });

    it('shares the writer serialization and API call budget with request interpretation', async () => {
        const store = new RadioStore(':memory:', policy);
        let release!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const fetchMock = vi.fn(async () => {
            await hold;
            return { ok: true, json: async () => ({ output_text: JSON.stringify({
                theme: 'Новый ритм', queries: ['Кино — Группа крови', 'Pendulum — Witchcraft',
                    'Каста — Вокруг шум', 'Kavinsky — Nightcall', '1nonly — Step Back'], requestRun: 'continue',
            }) }) };
        });
        vi.stubGlobal('fetch', fetchMock);
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', model: 'gpt-5.4-mini-2026-03-17',
            timeoutMs: 1_000, hourlyLimit: 1, dailyLimit: 1 }, store);
        const plan = writer.proposeShowPlan({ recentPlayed: [], currentTheme: 'Текущая тема' });
        const query = writer.rewriteMusicQuery('что-нибудь спокойное');
        await delay(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        release();
        expect((await plan).requestRun).toBe('continue');
        await expect(query).rejects.toThrow('budget exhausted');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='ai.call'").get()).toEqual({ count: 1 });
        store.close();
    });

    it('asks the active host model for a ten-song candidate reserve led by its own taste', async () => {
        const store = new RadioStore(':memory:', policy);
        const queries = Array.from({ length: 10 }, (_, index) => `Artist ${index} — Song ${index}`);
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: {
            content: JSON.stringify({ theme: 'Индустриальная ночь', queries, requestRun: 'continue' }),
        } }] }) }));
        vi.stubGlobal('fetch', fetchMock);
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1', apiFormat: 'chat',
            model: 'gpt-6-luna', timeoutMs: 1_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        const proposal = await writer.proposeShowPlan({ hostId: 'grok', hostMusicBrief: 'Industrial, metal, breakcore',
            currentTheme: 'Лунин поп', recentPlayed: [], upcoming: [] });
        expect(proposal.queries).toHaveLength(10);
        const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
            model: string; messages: Array<{ content: string }>;
        };
        expect(sent.model).toBe('grok-4.7');
        expect(sent.messages[0]?.content).toContain('Большинство предложений должно соответствовать твоему ядру');
        expect(sent.messages[0]?.content).toContain('обычно прозвучат лишь 3–4 трека');
        expect(sent.messages[0]?.content).toContain('от 3 до 100 символов');
        expect(sent.messages[0]?.content).toContain('от 2 до 80 символов');
        store.close();
    });

    it('uses backstage Luna when a host model times out, preserving the host music brief', async () => {
        const store = new RadioStore(':memory:', policy);
        const queries = Array.from({ length: 8 }, (_, index) => `Artist ${index} — Song ${index}`);
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
            .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: {
                content: JSON.stringify({ theme: 'Индустриальная смена', queries, requestRun: 'alternate' }),
            } }] }) });
        vi.stubGlobal('fetch', fetchMock);
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1', apiFormat: 'chat',
            model: 'gpt-6-luna', timeoutMs: 45_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const proposal = await writer.proposeShowPlan({ hostId: 'grok', hostMusicBrief: 'Industrial, metal, breakcore',
            currentTheme: 'Старый блок', recentPlayed: [], upcoming: [] });
        expect(proposal.theme).toBe('Индустриальная смена');
        const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
        const bodies = calls.map(([, init]) => JSON.parse(String(init.body)) as {
            model: string; messages: Array<{ content: string }>;
        });
        expect(bodies.map(body => body.model)).toEqual(['grok-4.7', 'gpt-6-luna']);
        expect(bodies[1]?.messages[0]?.content).toContain('Industrial, experimental, metal, breakcore');
        expect(warning).toHaveBeenCalledWith(JSON.stringify({ level: 'warn', event: 'show.plan.host_model_fallback', hostId: 'grok', reason: 'timeout' }));
        store.close();
    });

    it.each([
        { reply: '', finishReason: 'length', detail: 'truncated' },
        { reply: '', finishReason: 'stop', detail: 'empty' },
        { reply: '{"theme":"private listener data', finishReason: 'stop', detail: 'json_parse' },
        { reply: '[]', finishReason: 'stop', detail: 'format' },
        { reply: '{"theme":"x","queries":[],"requestRun":"alternate"}', finishReason: 'stop', detail: 'theme_short' },
        { reply: JSON.stringify({ theme: 'Ночная музыка', queries: Array.from({ length: 8 }, (_, index) => `genre ${index}`),
            requestRun: 'alternate' }), finishReason: 'stop', detail: 'artist_title_format' },
        { reply: '', finishReason: 'private listener data', detail: 'empty' },
    ])('categorizes DeepSeek plan failure as $detail without logging output', async ({ reply, finishReason, detail }) => {
        const store = new RadioStore(':memory:', policy);
        const valid = JSON.stringify({ theme: 'Ночная музыка',
            queries: Array.from({ length: 8 }, (_, index) => `Artist ${index} — Song ${index}`),
            requestRun: 'alternate' });
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: reply },
                finish_reason: finishReason }] }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: valid },
                finish_reason: 'stop' }] }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1', apiFormat: 'chat',
            model: 'gpt-6-luna', timeoutMs: 45_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        try {
            await expect(writer.proposeShowPlan({ hostId: 'deepseek', recentPlayed: [] })).resolves.toMatchObject({ theme: 'Ночная музыка' });
            const sent = fetchMock.mock.calls.map((call: [string, RequestInit]) => JSON.parse(String(call[1].body)) as {
                model: string; max_completion_tokens: number;
            });
            expect(sent.map(body => [body.model, body.max_completion_tokens])).toEqual([
                ['deepseek-v4-pro', 1_800], ['gpt-6-luna', 750],
            ]);
            expect(warning).toHaveBeenCalledWith(JSON.stringify({ level: 'warn', event: 'show.plan.host_model_fallback',
                hostId: 'deepseek', reason: 'invalid_plan', detail,
                ...(/^(?:length|stop)$/u.test(finishReason) ? { finish_reason: finishReason } : {}) }));
            expect(JSON.stringify(warning.mock.calls)).not.toContain('private listener data');
        } finally {
            store.close();
        }
    });

    it('normalizes a Responses API output cap without exposing its response body', async () => {
        const store = new RadioStore(':memory:', policy);
        const valid = JSON.stringify({ theme: 'Ночная музыка',
            queries: Array.from({ length: 8 }, (_, index) => `Artist ${index} — Song ${index}`),
            requestRun: 'alternate' });
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: '',
                incomplete_details: { reason: 'max_output_tokens' }, private_text: 'private listener data' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: valid }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', model: 'gpt-6-luna',
            timeoutMs: 45_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        try {
            await expect(writer.proposeShowPlan({ hostId: 'deepseek', recentPlayed: [] })).resolves.toMatchObject({ theme: 'Ночная музыка' });
            expect(warning).toHaveBeenCalledWith(JSON.stringify({ level: 'warn', event: 'show.plan.host_model_fallback',
                hostId: 'deepseek', reason: 'invalid_plan', detail: 'truncated', finish_reason: 'length' }));
            expect(JSON.stringify(warning.mock.calls)).not.toContain('private listener data');
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            store.close();
        }
    });

    it('does not retry a shared authentication failure through Luna', async () => {
        const store = new RadioStore(':memory:', policy);
        const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
        vi.stubGlobal('fetch', fetchMock);
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', baseUrl: 'https://tooken.club/v1', apiFormat: 'chat',
            model: 'gpt-6-luna', timeoutMs: 45_000, hourlyLimit: 0, dailyLimit: 0 }, store);
        await expect(writer.proposeShowPlan({ hostId: 'grok', recentPlayed: [] })).rejects.toThrow('AI API failed (401)');
        expect(fetchMock).toHaveBeenCalledOnce();
        store.close();
    });

    it('accepts only bounded structured host input decisions', async () => {
        const store = new RadioStore(':memory:', policy);
        const responses = [
            { choice: 'defer', deferMinutes: 7 },
            { choice: 'decline', deferMinutes: 0 },
            { choice: 'defer', deferMinutes: 99 },
        ];
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ output_text: JSON.stringify(responses.shift()) }) }));
        vi.stubGlobal('fetch', fetchMock);
        const writer = new OpenAiScriptWriter({ apiKey: 'test-only', model: 'gpt-5.4-mini-2026-03-17',
            timeoutMs: 1_000, hourlyLimit: 4, dailyLimit: 4 }, store);
        const context = { kind: 'studio' as const, currentTheme: 'Джаз', message: 'Сыграйте что-то быстрое' };
        await expect(writer.proposeInputDecision(context)).resolves.toEqual({ choice: 'defer', deferMinutes: 7 });
        await expect(writer.proposeInputDecision(context)).resolves.toEqual({ choice: 'decline' });
        await expect(writer.proposeInputDecision(context)).rejects.toThrow('invalid defer duration');
        const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { text: { format: { name: string } } };
        expect(sent.text.format.name).toBe('radio_input_decision');
        store.close();
    });
});
