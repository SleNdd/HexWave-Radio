import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { expect, it, vi } from 'vitest';

import type { BreakContext } from '../src/contracts.js';
import { FallbackScriptWriter, HostPresenter, OpenAiScriptWriter, TemplateScriptWriter } from '../src/host.js';
import type { RadioStore } from '../src/storage.js';

it('renders ordered character turns with prior dialogue and one cached, normalized file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'radio-joint-success-'));
    try {
        const contexts: BreakContext[] = [];
        const lines = ['Луна: что поставим дальше?', 'Сол: начнем с этой записи.', 'Грок: а я прибавлю громкость.'];
        const writeBreak = vi.fn(async (context: BreakContext) => {
            contexts.push(context);
            return lines[(contexts.length - 1) % lines.length]!;
        });
        const synthesize = vi.fn(async () => ({ body: Readable.from([Buffer.alloc(300, 1)]), mimeType: 'audio/wav' }));
        const concat = vi.fn(async (_inputs: string[], output: string) => { await writeFile(output, Buffer.alloc(500, 2)); });
        const normalize = vi.fn(async (_input: string, output: string) => { await writeFile(output, Buffer.alloc(600, 3)); });
        const presenter = new HostPresenter({ writeBreak }, { synthesize, health: async () => ({ ok: true, detail: 'ready' }) },
            directory, 'default', { version: 'test-v1', normalize }, undefined, undefined, concat);
        const context = { kind: 'station' as const, memory: { earlierSpins: [], recentThemes: [], listenerSignals: [],
            hostLines: ['Прозвучало раньше.'], earlierHostLines: [] } };
        const first = await presenter.prepareJoint(context, ['luna', 'sol', 'grok'], 'Спор о следующей записи');
        expect(first?.turns).toEqual([
            { hostId: 'luna', modelId: 'gpt-6-luna', voiceId: 'arina', text: lines[0] },
            { hostId: 'sol', modelId: 'gpt-6-sol', voiceId: 'pavel', text: lines[1] },
            { hostId: 'grok', modelId: 'grok-4.7', voiceId: 'yuriy', text: lines[2] },
        ]);
        expect(first?.script).toBe(lines.join('\n'));
        expect(contexts.map(item => item.hostId)).toEqual(['luna', 'sol', 'grok']);
        expect(contexts[1]?.joint?.priorTurns).toEqual([{ hostId: 'luna', text: lines[0] }]);
        expect(contexts[2]?.recentLines).toEqual(['Прозвучало раньше.', lines[0], lines[1]]);
        expect(synthesize.mock.calls.map(call => call[1])).toEqual(['arina', 'pavel', 'yuriy']);
        expect(await readFile(first!.path)).toEqual(Buffer.alloc(600, 3));
        expect((await readdir(directory)).filter(name => name.endsWith('.audio'))).toHaveLength(1);
        expect((await readdir(directory)).filter(name => name.endsWith('.part'))).toHaveLength(0);
        const second = await presenter.prepareJoint(context, ['luna', 'sol', 'grok'], 'Спор о следующей записи');
        expect(second).toEqual(first);
        expect(synthesize).toHaveBeenCalledTimes(3);
        expect(concat).toHaveBeenCalledTimes(1);
        expect(normalize).toHaveBeenCalledTimes(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('fails open without a final or partial file when a voice or concat fails, then retries cleanly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'radio-joint-failure-'));
    try {
        let failVoice = true;
        let failConcat = true;
        const synthesize = vi.fn(async (_text: string, voice: string) => {
            if (voice === 'pavel' && failVoice) throw new Error('voice unavailable');
            return { body: Readable.from([Buffer.alloc(300, 1)]), mimeType: 'audio/wav' };
        });
        const concat = vi.fn(async (_inputs: string[], output: string) => {
            await writeFile(output, Buffer.alloc(300, 1));
            if (failConcat) throw new Error('concat failed after writing');
        });
        const presenter = new HostPresenter({ writeBreak: async context => `${context.hostId} говорит короткую реплику.` },
            { synthesize, health: async () => ({ ok: true, detail: 'ready' }) }, directory, 'default',
            undefined, undefined, undefined, concat);
        const context = { kind: 'station' as const };
        expect(await presenter.prepareJoint(context, ['luna', 'sol'], 'Встреча у микрофона')).toBeUndefined();
        expect(await readdir(directory)).toEqual([]);
        failVoice = false;
        expect(await presenter.prepareJoint(context, ['luna', 'sol'], 'Встреча у микрофона')).toBeUndefined();
        expect(await readdir(directory)).toEqual([]);
        failConcat = false;
        expect(await presenter.prepareJoint(context, ['luna', 'sol'], 'Встреча у микрофона')).toBeDefined();
        expect((await readdir(directory)).filter(name => name.endsWith('.audio'))).toHaveLength(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('does not substitute template dialogue when a joint participant writer fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'radio-joint-writer-failure-'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        const primary = vi.fn(async (context: BreakContext) => {
            if (context.hostId === 'sol') throw new Error('AI API failed (503)');
            return 'Первый ведущий начинает разговор.';
        });
        const fallback = vi.fn(async () => 'Подставленная реплика другого ведущего.');
        const synthesize = vi.fn(async () => ({ body: Readable.from([Buffer.alloc(300)]), mimeType: 'audio/wav' }));
        const presenter = new HostPresenter(new FallbackScriptWriter({ writeBreak: primary }, { writeBreak: fallback }),
            { synthesize, health: async () => ({ ok: true, detail: 'ready' }) }, directory, 'default');
        expect(await presenter.prepareJoint({ kind: 'station' }, ['luna', 'sol'], 'Разговор о следующем треке'))
            .toBeUndefined();
        expect(primary).toHaveBeenCalledTimes(2);
        expect(fallback).not.toHaveBeenCalled();
        expect(synthesize).not.toHaveBeenCalled();
        expect(await readdir(directory)).toEqual([]);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('"reason":"upstream_failure"'));
    } finally {
        warning.mockRestore();
        await rm(directory, { recursive: true, force: true });
    }
});

it('rejects duplicate participants and overlong turns before starting speech', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'radio-joint-bounds-'));
    try {
        const synthesize = vi.fn(async () => ({ body: Readable.from([Buffer.alloc(300)]), mimeType: 'audio/wav' }));
        const presenter = new HostPresenter({ writeBreak: async () => 'слово '.repeat(40) },
            { synthesize, health: async () => ({ ok: true, detail: 'ready' }) }, directory, 'default');
        expect(await presenter.prepareJoint({ kind: 'station' }, ['luna', 'luna'], 'Одна студийная тема')).toBeUndefined();
        expect(await presenter.prepareJoint({ kind: 'station' }, ['luna', 'sol'], 'Одна студийная тема')).toBeUndefined();
        expect(synthesize).not.toHaveBeenCalled();
        expect(await readdir(directory)).toEqual([]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('coalesces concurrent joint renders and bounds oversized TTS bodies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'radio-joint-race-'));
    try {
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const synthesize = vi.fn(async () => ({ body: Readable.from([Buffer.alloc(300, 1)]), mimeType: 'audio/wav' }));
        const concat = vi.fn(async (_inputs: string[], output: string) => {
            await held;
            await writeFile(output, Buffer.alloc(500, 2));
        });
        const presenter = new HostPresenter({ writeBreak: async context => `${context.hostId} короткая реплика.` },
            { synthesize, health: async () => ({ ok: true, detail: 'ready' }) }, directory, 'default',
            undefined, undefined, undefined, concat);
        const first = presenter.prepareJoint({ kind: 'station' }, ['luna', 'sol'], 'Общий разговор в студии');
        const second = presenter.prepareJoint({ kind: 'station' }, ['luna', 'sol'], 'Общий разговор в студии');
        await vi.waitFor(() => expect(concat).toHaveBeenCalledTimes(1));
        release();
        const [one, two] = await Promise.all([first, second]);
        expect(one).toEqual(two);
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect(concat).toHaveBeenCalledTimes(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
    const oversizedDirectory = await mkdtemp(join(tmpdir(), 'radio-joint-oversized-'));
    try {
        const host = new HostPresenter({ writeBreak: async () => 'Короткая реплика для эфира.' },
            { synthesize: async () => ({ body: Readable.from([Buffer.alloc(2_000_001)]), mimeType: 'audio/wav' }),
                health: async () => ({ ok: true, detail: 'ready' }) }, oversizedDirectory, 'default');
        expect(await host.prepareJoint({ kind: 'station' }, ['luna', 'sol'], 'Общий разговор в студии')).toBeUndefined();
        expect(await readdir(oversizedDirectory)).toEqual([]);
    } finally {
        await rm(oversizedDirectory, { recursive: true, force: true });
    }
});

it('keeps fallback joint turns short and responsive to the previous speaker', async () => {
    const writer = new TemplateScriptWriter();
    const first = await writer.writeBreak({ kind: 'station', hostId: 'luna', recentLines: [],
        joint: { occasion: 'Спор о записи', participants: ['luna', 'sol'], turnIndex: 0, priorTurns: [] } });
    const second = await writer.writeBreak({ kind: 'station', hostId: 'sol', recentLines: [first],
        joint: { occasion: 'Спор о записи', participants: ['luna', 'sol'], turnIndex: 1,
            priorTurns: [{ hostId: 'luna', text: first }] } });
    expect(first.length).toBeLessThanOrEqual(180);
    expect(second).toMatch(/^Луна,/u);
    expect(second.length).toBeLessThanOrEqual(180);
});

it('validates organizer joint proposals and uses the fixed Luna model', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({
        hostIds: ['sol', 'luna'], occasion: 'Спор о новом треке',
    }) }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
        const store = { reserveAiCall: () => true } as unknown as RadioStore;
        const writer = new OpenAiScriptWriter({ apiKey: 'test', model: 'other', timeoutMs: 1000,
            hourlyLimit: 0, dailyLimit: 0 }, store);
        expect(await writer.proposeJointShow({ currentHostId: 'sol', recentShowSizes: { solo: 82, pair: 15, trio: 2 } })).toEqual({
            hostIds: ['sol', 'luna'], occasion: 'Спор о новом треке',
        });
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe('gpt-6-luna');
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ output_text: JSON.stringify({
            hostIds: ['luna', 'luna'], occasion: 'Спор о новом треке',
        }) }), { status: 200 }));
        await expect(writer.proposeJointShow({ currentHostId: 'sol', recentShowSizes: { solo: 82, pair: 15, trio: 2 } }))
            .rejects.toThrow('invalid joint show proposal');
    } finally {
        vi.unstubAllGlobals();
    }
});

it('keeps the planning-call reserve when an optional AI budget is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
        const reserved: Array<[number, number]> = [];
        const store = { reserveAiCall: (_now: number, hourly: number, daily: number) => {
            reserved.push([hourly, daily]);
            return false;
        } } as unknown as RadioStore;
        const writer = new OpenAiScriptWriter({ apiKey: 'test', model: 'gpt-6-luna', timeoutMs: 1000,
            hourlyLimit: 12, dailyLimit: 250 }, store);
        await expect(writer.proposeJointShow({ currentHostId: 'luna',
            recentShowSizes: { solo: 10, pair: 1, trio: 0 } })).rejects.toThrow('budget exhausted');
        expect(reserved).toEqual([[8, 226]]);
        expect(fetchMock).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
    }
});
