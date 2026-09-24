import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { MusicProvider, Track } from './contracts.js';

export function retryableDownloadError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated')) return true;
    return /^(?:YouTube Music|Spotify) audio fetch failed \((?:403|408|429|5\d\d)\)$/u.test(error.message);
}

export class MediaCache {
    private readonly inFlight = new Map<string, Promise<string>>();
    private readonly reservations = new Map<string, number>();
    private readonly deleting = new Map<string, Promise<void>>();

    constructor(
        private readonly directory: string,
        private readonly maxBytes: number,
        private readonly maxTrackBytes = 200 * 1024 * 1024,
    ) {}

    /** Keep a staged file safe from every concurrent LRU prune until its queue transaction commits. */
    reserve(track: Track): () => void {
        const target = this.pathFor(track);
        this.reservations.set(target, (this.reservations.get(target) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const count = this.reservations.get(target) ?? 0;
            if (count <= 1) this.reservations.delete(target);
            else this.reservations.set(target, count - 1);
        };
    }

    private pathFor(track: Track): string {
        const key = createHash('sha256').update(`${track.provider}:${track.id}`).digest('hex');
        return join(this.directory, `${key}.media`);
    }

    async materialize(track: Track, provider: MusicProvider, signal?: AbortSignal, protectedPaths: ReadonlySet<string> = new Set()): Promise<string> {
        const target = this.pathFor(track);
        const key = target;
        await this.deleting.get(target)?.catch(() => undefined);
        const existing = await stat(target).catch(() => undefined);
        if (existing?.isFile() && existing.size > 0) {
            const now = new Date();
            await utimes(target, now, now).catch(() => undefined);
            return target;
        }
        const active = this.inFlight.get(key);
        if (active) return await active;
        const operation = this.download(track, provider, target, signal, protectedPaths);
        this.inFlight.set(key, operation);
        try {
            return await operation;
        } finally {
            this.inFlight.delete(key);
        }
    }

    async prune(protectedPaths: ReadonlySet<string> = new Set()): Promise<void> {
        await mkdir(this.directory, { recursive: true });
        const entries = await Promise.all(
            (await readdir(this.directory, { withFileTypes: true }))
                .filter(entry => entry.isFile() && entry.name.endsWith('.media'))
                .map(async entry => {
                    const path = join(this.directory, entry.name);
                    return { path, info: await stat(path) };
                }),
        );
        let total = entries.reduce((sum, entry) => sum + entry.info.size, 0);
        for (const entry of entries.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
            if (total <= this.maxBytes) break;
            if (protectedPaths.has(entry.path) || this.reservations.has(entry.path)) continue;
            const deletion = rm(entry.path, { force: true });
            this.deleting.set(entry.path, deletion);
            try {
                await deletion;
            } finally {
                if (this.deleting.get(entry.path) === deletion) this.deleting.delete(entry.path);
            }
            total -= entry.info.size;
        }
    }

    async invalidate(track: Track): Promise<void> {
        await rm(this.pathFor(track), { force: true });
    }

    private async download(
        track: Track,
        provider: MusicProvider,
        target: string,
        signal?: AbortSignal,
        protectedPaths: ReadonlySet<string> = new Set(),
    ): Promise<string> {
        await mkdir(this.directory, { recursive: true });
        for (let attempt = 0; attempt < 2; attempt++) {
            const temporary = `${target}.${process.pid}.${Date.now()}.${attempt}.part`;
            let bytes = 0;
            const limiter = new Transform({
                transform: (chunk: Buffer, _encoding, callback) => {
                    bytes += chunk.length;
                    callback(bytes > this.maxTrackBytes ? new Error('Track exceeds cache item limit') : undefined, chunk);
                },
            });
            try {
                const media = await provider.fetch(track.id, signal);
                await pipeline(media.body, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
                if (bytes === 0) throw new Error('Provider returned an empty track');
                await rename(temporary, target);
                await this.prune(new Set([...protectedPaths, target]));
                return target;
            } catch (error) {
                await rm(temporary, { force: true }).catch(() => undefined);
                if (attempt === 0 && !signal?.aborted && retryableDownloadError(error)) continue;
                throw error;
            }
        }
        throw new Error('Media download retry exhausted');
    }
}
