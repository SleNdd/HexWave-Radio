import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiScriptWriter } from '../src/host.js';
import { fallbackShowPlan, validateShowProposal } from '../src/showrunner.js';
import { RadioStore } from '../src/storage.js';

const policy = {
    requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0, studioTtlMs: 60_000,
    trackCooldownMs: 0, artistCooldownMs: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe('showrunner', () => {
    it('has bounded mixed-language fallback seeds and rejects malformed plans', () => {
        const plan = fallbackShowPlan(1_000_000, []);
        expect(validateShowProposal(plan)).toEqual(plan);
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
