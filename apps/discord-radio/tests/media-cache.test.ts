import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { MusicProvider, Track } from '../src/contracts.js';
import { MediaCache } from '../src/media-cache.js';

const track: Track = { provider: 'ytmusic', id: 'LfgNorryffc', title: 'Nightcall', artist: 'Kavinsky', durationMs: 258_000 };

async function withCache(run: (cache: MediaCache, directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'discord-radio-cache-test-'));
    try {
        await run(new MediaCache(directory, 1_000_000), directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

describe('media cache transient download recovery', () => {
    it('does not evict media reserved for an uncommitted queue item', async () => withCache(async (cache, directory) => {
        const second = { ...track, id: 'gXDqIAaWOUU' };
        const fetch = vi.fn(async () => ({ body: Readable.from([Buffer.alloc(600_000)]), mimeType: 'audio/mp4' }));
        const firstPath = await cache.materialize(track, { fetch } as unknown as MusicProvider);
        const release = cache.reserve(track);
        const secondPath = await cache.materialize(second, { fetch } as unknown as MusicProvider);
        expect(await readFile(firstPath)).toHaveLength(600_000);
        expect(await readFile(secondPath)).toHaveLength(600_000);
        release();
        await cache.prune(new Set([secondPath]));
        expect(await readdir(directory)).toEqual([expect.stringMatching(/\.media$/u)]);
        expect(await readFile(secondPath)).toHaveLength(600_000);
    }));
    it('removes a partial stream before one fresh attempt', async () => withCache(async (cache, directory) => {
        const fetch = vi.fn()
            .mockResolvedValueOnce({ body: Readable.from((async function* () {
                yield Buffer.from('partial');
                throw new TypeError('terminated');
            })()), mimeType: 'audio/mp4' })
            .mockResolvedValueOnce({ body: Readable.from([Buffer.from('complete')]), mimeType: 'audio/mp4' });
        const path = await cache.materialize(track, { fetch } as unknown as MusicProvider);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(await readFile(path, 'utf8')).toBe('complete');
        expect(await readdir(directory)).toEqual([expect.stringMatching(/\.media$/u)]);
    }));

    it('re-resolves once after an audio CDN 403, but not after a resolver 403', async () => withCache(async cache => {
        const fetch = vi.fn()
            .mockRejectedValueOnce(new Error('YouTube Music audio fetch failed (403)'))
            .mockResolvedValueOnce({ body: Readable.from([Buffer.from('complete')]), mimeType: 'audio/mp4' });
        expect(await readFile(await cache.materialize(track, { fetch } as unknown as MusicProvider), 'utf8')).toBe('complete');
        expect(fetch).toHaveBeenCalledTimes(2);
        const permanent = vi.fn().mockRejectedValue(new Error('YouTube Music resolve failed (403)'));
        await expect(cache.materialize({ ...track, id: 'gXDqIAaWOUU' }, { fetch: permanent } as unknown as MusicProvider))
            .rejects.toThrow('YouTube Music resolve failed (403)');
        expect(permanent).toHaveBeenCalledTimes(1);
    }));

    it('does not retry after cancellation', async () => withCache(async cache => {
        const controller = new AbortController();
        const fetch = vi.fn(async () => {
            controller.abort();
            throw new TypeError('fetch failed');
        });
        await expect(cache.materialize(track, { fetch } as unknown as MusicProvider, controller.signal)).rejects.toThrow('fetch failed');
        expect(fetch).toHaveBeenCalledTimes(1);
    }));

    it('leaves no partial file when the retry also fails', async () => withCache(async (cache, directory) => {
        const fetch = vi.fn(async () => ({
            body: Readable.from((async function* () {
                yield Buffer.from('partial');
                throw new TypeError('terminated');
            })()),
            mimeType: 'audio/mp4',
        }));
        await expect(cache.materialize(track, { fetch } as unknown as MusicProvider)).rejects.toThrow('terminated');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(await readdir(directory)).toEqual([]);
    }));
});
