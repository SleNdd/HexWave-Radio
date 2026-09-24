import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { expect, it, vi } from 'vitest';

import { HostPresenter, TemplateScriptWriter, moscowNow } from '../src/host.js';

it('formats broadcast time in Moscow independently of the VPS timezone', () => {
    expect(moscowNow(Date.parse('2026-01-02T21:30:00Z'))).toMatch(/03\.01\.2026.*00:30/u);
});

it('passes only persisted aired lines to the writer without treating prepared speech as aired', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-radio-host-memory-test-'));
    try {
        const contexts: Array<{ recentLines: string[] }> = [];
        const presenter = new HostPresenter({ writeBreak: async context => {
            contexts.push(context);
            return 'Снова знакомая шутка.';
        } }, { synthesize: async () => ({ body: Readable.from([Buffer.alloc(300)]), mimeType: 'audio/wav' }),
            health: async () => ({ ok: true, detail: 'ready' }) }, directory, 'mikhail');
        const memory = { earlierSpins: [], recentThemes: [], listenerSignals: [], hostLines: ['Вчерашняя реплика.'], earlierHostLines: [] };
        await presenter.prepare({ kind: 'station', memory });
        await presenter.prepare({ kind: 'station', memory });
        expect(contexts[0]?.recentLines).toContain('Вчерашняя реплика.');
        expect(contexts[1]?.recentLines).not.toContain('Снова знакомая шутка.');
        await presenter.prepare({ kind: 'station', memory: { ...memory, hostLines: ['Снова знакомая шутка.'] } });
        expect(contexts[2]?.recentLines).toContain('Снова знакомая шутка.');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('uses an understandable fallback line and avoids the most recently aired station line', async () => {
    const writer = new TemplateScriptWriter();
    const first = await writer.writeBreak({ kind: 'station', recentLines: [] });
    const next = await writer.writeBreak({ kind: 'station', recentLines: [first] });
    expect(next).not.toBe(first);
    expect(next).not.toMatch(/инструкц|модерац|системн|тракт/iu);
    const studio = await writer.writeBreak({ kind: 'studio', requesterName: 'Саня', studioMessage: 'Привет!', recentLines: [] });
    expect(studio).toContain('Саня');
    expect(studio).not.toMatch(/инструкц|модерац/iu);
    const jingle = await writer.writeBreak({ kind: 'jingle', recentLines: [] });
    const request = await writer.writeBreak({ kind: 'request', requesterName: 'Саня', recentLines: [],
        nextTrack: { provider: 'ytmusic', id: 'abcdefghijk', artist: 'Test', title: 'Song', durationMs: 180_000 } });
    expect(jingle).not.toMatch(/кожан/iu);
    expect(request).not.toMatch(/кожан/iu);
});

it('returns the actual spoken script with a cached audio artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-radio-host-test-'));
    try {
        const writeBreak = vi.fn(async () => 'Эфир продолжается, кожаные мешки.');
        const synthesize = vi.fn(async () => ({ body: Readable.from([Buffer.from('test-audio'.repeat(30))]), mimeType: 'audio/wav' }));
        const presenter = new HostPresenter({ writeBreak }, { synthesize, health: async () => ({ ok: true, detail: 'ready' }) }, directory, 'mikhail');
        const first = await presenter.prepare({ kind: 'station' });
        const second = await presenter.prepare({ kind: 'station' });
        expect(first?.script).toBe('Эфир продолжается, кожаные мешки.');
        expect(second).toEqual(first);
        expect(await readFile(first!.path, 'utf8')).toBe('test-audio'.repeat(30));
        expect(writeBreak).toHaveBeenCalledTimes(2);
        expect(synthesize).toHaveBeenCalledTimes(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('uses distinct host voices and cache artifacts for the same words', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-radio-host-voices-'));
    try {
        const synthesize = vi.fn(async () => ({ body: Readable.from([Buffer.alloc(300)]), mimeType: 'audio/wav' }));
        const presenter = new HostPresenter({ writeBreak: async () => 'Продолжаем эфир.' },
            { synthesize, health: async () => ({ ok: true, detail: 'ready' }) }, directory, 'mikhail');
        const luna = await presenter.prepare({ kind: 'station', hostId: 'luna' });
        const sol = await presenter.prepare({ kind: 'station', hostId: 'sol' });
        expect(luna?.path).not.toBe(sol?.path);
        expect(synthesize.mock.calls[0]?.[1]).toBe('arina');
        expect(synthesize.mock.calls[1]?.[1]).toBe('pavel');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('normalizes speech before caching and changes the cache key with processing version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-radio-speech-test-'));
    try {
        const writeBreak = vi.fn(async () => 'Сейчас зазвучит музыка.');
        const synthesize = vi.fn(async () => ({ body: Readable.from([Buffer.from('quiet-audio'.repeat(25))]), mimeType: 'audio/wav' }));
        const normalize = vi.fn(async (_input: string, output: string) => {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(output, 'louder-audio');
        });
        const writer = { writeBreak };
        const speech = { synthesize, health: async () => ({ ok: true, detail: 'ready' }) };
        const raw = new HostPresenter(writer, speech, directory, 'mikhail');
        const louder = new HostPresenter(writer, speech, directory, 'mikhail', { version: 'loud-v1', normalize });
        const rawSegment = await raw.prepare({ kind: 'station' });
        const loudSegment = await louder.prepare({ kind: 'station' });
        expect(rawSegment?.path).not.toBe(loudSegment?.path);
        expect(await readFile(loudSegment!.path, 'utf8')).toBe('louder-audio');
        expect(normalize).toHaveBeenCalledTimes(1);
        expect(await louder.prepare({ kind: 'station' })).toEqual(loudSegment);
        expect(normalize).toHaveBeenCalledTimes(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('coalesces concurrent renders of the same speech instead of racing over cache files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-radio-speech-race-test-'));
    try {
        let finish!: () => void;
        const held = new Promise<void>(resolve => { finish = resolve; });
        const synthesize = vi.fn(async () => {
            await held;
            return { body: Readable.from([Buffer.from('speech'.repeat(50))]), mimeType: 'audio/wav' };
        });
        const presenter = new HostPresenter({ writeBreak: async () => 'Один и тот же текст.' },
            { synthesize, health: async () => ({ ok: true, detail: 'ready' }) }, directory, 'mikhail');
        const first = presenter.prepare({ kind: 'station' });
        const second = presenter.prepare({ kind: 'station' });
        finish();
        const [one, two] = await Promise.all([first, second]);
        expect(one).toEqual(two);
        expect(await readFile(one!.path, 'utf8')).toBe('speech'.repeat(50));
        expect(synthesize).toHaveBeenCalledTimes(1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
