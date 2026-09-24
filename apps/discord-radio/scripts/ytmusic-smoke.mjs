// Live, credential-free provider/cache smoke. Run only against an operator-owned resolver.
// The temporary cache is removed; signed media URLs and response bodies are never logged.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MediaCache } from '../dist/media-cache.js';
import { YtMusicProvider } from '../dist/providers.js';

const resolver = process.argv[2] ?? 'http://127.0.0.1:9322';
const provider = new YtMusicProvider(resolver);
const queries = ['Kavinsky Nightcall', 'Daft Punk Discovery'];
const tracks = new Map();

for (const query of queries) {
    for (const track of await provider.search(query, 5)) tracks.set(track.id, track);
}
if (tracks.size !== 10) throw new Error(`Expected ten distinct catalog songs; got ${tracks.size}`);

let passed = 0;
let index = 0;
const directory = await mkdtemp(join(tmpdir(), 'discord-radio-ytmusic-smoke-'));
try {
    const cache = new MediaCache(directory, 200 * 1024 * 1024);
    for (const track of tracks.values()) {
        index++;
        const started = Date.now();
        try {
            const path = await cache.materialize(track, provider);
            const bytes = (await stat(path)).size;
            const elapsedMs = Date.now() - started;
            const ok = bytes > 100_000 && elapsedMs < track.durationMs;
            if (ok) passed++;
            console.log(JSON.stringify({ index, id: track.id, elapsedMs, durationMs: track.durationMs, bytes, ok }));
        } catch (error) {
            console.log(JSON.stringify({ index, id: track.id, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : 'unknown', ok: false }));
        }
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, total: tracks.size }));
if (passed !== tracks.size) process.exitCode = 1;
