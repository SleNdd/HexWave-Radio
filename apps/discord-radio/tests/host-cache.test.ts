import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BreakContext, ScriptWriter, SpeechEngine, Track } from '../src/contracts.js';
import { HostPresenter } from '../src/host.js';

const track: Track = { provider: 'ytmusic', id: 'abcdefghijk', artist: 'Artist', title: 'First', durationMs: 180_000 };

describe('host speech cache', () => {
    it('does not cache a tiny successful-looking TTS error body as audio', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'radio-host-small-body-'));
        try {
            const writer = { writeBreak: async () => 'Короткая реплика.' } as ScriptWriter;
            const speech = { synthesize: async () => ({ body: Readable.from([Buffer.from('{"error":"voice unavailable"}')]),
                mimeType: 'audio/wav' }) } as SpeechEngine;
            const host = new HostPresenter(writer, speech, directory, 'mikhail');
            expect(await host.prepare({ kind: 'station', nextTrack: track })).toBeUndefined();
            expect((await readdir(directory)).filter(name => name.endsWith('.audio'))).toHaveLength(0);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('evicts old unreferenced speech but keeps ready and recent segments', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'radio-host-cache-'));
        try {
            const protectedPaths = new Set<string>();
            const writer = { writeBreak: async (context: BreakContext) => context.nextTrack?.title ?? 'station' } as ScriptWriter;
            const speech = { synthesize: async () => ({ body: Readable.from([Buffer.alloc(512, 1)]), mimeType: 'audio/wav' }) } as SpeechEngine;
            const host = new HostPresenter(writer, speech, directory, 'mikhail', undefined, 700, () => protectedPaths);
            const first = await host.prepare({ kind: 'station', nextTrack: track });
            expect(first).toBeDefined();
            const old = new Date(Date.now() - 11 * 60_000);
            await utimes(first!.path, old, old);
            protectedPaths.add(first!.path);
            const second = await host.prepare({ kind: 'station', nextTrack: { ...track, title: 'Second' } });
            expect(second).toBeDefined();
            expect((await readdir(directory)).filter(name => name.endsWith('.audio'))).toHaveLength(2);
            protectedPaths.delete(first!.path);
            const third = await host.prepare({ kind: 'station', nextTrack: { ...track, title: 'Third' } });
            expect(third).toBeDefined();
            expect(await stat(first!.path).catch(() => undefined)).toBeUndefined();
            expect((await stat(second!.path)).size).toBe(512);
            expect((await stat(third!.path)).size).toBe(512);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('never returns an evicted cached path when a prune and reuse overlap', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'radio-host-cache-race-'));
        try {
            const firstContext = { kind: 'station' as const, nextTrack: track };
            let host!: HostPresenter;
            let triggerReuse = false;
            let reuse: ReturnType<HostPresenter['prepare']> | undefined;
            const writer = { writeBreak: async (context: BreakContext) => context.nextTrack?.title ?? 'station' } as ScriptWriter;
            const speech = { synthesize: async () => ({ body: Readable.from([Buffer.alloc(512, 1)]), mimeType: 'audio/wav' }) } as SpeechEngine;
            host = new HostPresenter(writer, speech, directory, 'mikhail', undefined, 700, () => {
                if (triggerReuse) {
                    triggerReuse = false;
                    reuse = host.prepare(firstContext);
                }
                return new Set();
            });
            const first = await host.prepare(firstContext);
            expect(first).toBeDefined();
            const old = new Date(Date.now() - 11 * 60_000);
            await utimes(first!.path, old, old);
            triggerReuse = true;
            await host.prepare({ kind: 'station', nextTrack: { ...track, title: 'Second' } });
            expect(reuse).toBeDefined();
            const returned = await reuse!;
            expect(returned).toBeDefined();
            expect((await stat(returned!.path)).size).toBe(512);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
