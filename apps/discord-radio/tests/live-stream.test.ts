import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { RadioDirector } from '../src/director.js';
import { startHealthServer } from '../src/health-server.js';
import { LiveMp3Stream } from '../src/live-stream.js';

class FakeEncoder extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly signals: Array<string | undefined> = [];
    kill(signal?: string): boolean { this.signals.push(signal); return true; }
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe('private live MP3 output', () => {
    it('does not expose the route when disabled', async () => {
        const server = await startHealthServer({} as RadioDirector, 0);
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound port');
            const response = await fetch(`http://127.0.0.1:${address.port}/live.mp3`);
            expect(response.status).toBe(404);
        } finally { await close(server); }
    });

    it('fans out one current programme to late clients and switches tracks without restarting clients', async () => {
        const encoders: FakeEncoder[] = [];
        const gains: number[] = [];
        const live = new LiveMp3Stream((_path, gain) => {
            const encoder = new FakeEncoder();
            encoders.push(encoder);
            gains.push(gain);
            return encoder;
        });
        const server = await startHealthServer({} as RadioDirector, 0, live);
        const controllers = [new AbortController(), new AbortController()];
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound port');
            const url = `http://127.0.0.1:${address.port}/live.mp3`;
            live.start('music.wav', 'music');
            const first = await fetch(url, { signal: controllers[0]!.signal });
            expect(first.status).toBe(200);
            expect(first.headers.get('content-type')).toBe('audio/mpeg');
            const firstReader = first.body!.getReader();
            const firstChunk = firstReader.read();
            encoders[0]!.stdout.write(Buffer.from('first'));
            expect(Buffer.from((await firstChunk).value!).toString()).toBe('first');

            const second = await fetch(url, { signal: controllers[1]!.signal });
            const secondReader = second.body!.getReader();
            const nextFirst = firstReader.read();
            const nextSecond = secondReader.read();
            encoders[0]!.stdout.write(Buffer.from('shared'));
            expect(Buffer.from((await nextFirst).value!).toString()).toBe('shared');
            expect(Buffer.from((await nextSecond).value!).toString()).toBe('shared');
            expect(encoders).toHaveLength(1);

            live.start('speech.wav', 'speech');
            expect(encoders[0]!.signals).toContain(undefined);
            expect(encoders).toHaveLength(2);
            expect(gains).toEqual([0.38, 1.1]);
            const speechFirst = firstReader.read();
            const speechSecond = secondReader.read();
            encoders[1]!.stdout.write(Buffer.from('speech'));
            expect(Buffer.from((await speechFirst).value!).toString()).toBe('speech');
            expect(Buffer.from((await speechSecond).value!).toString()).toBe('speech');
        } finally {
            controllers.forEach(controller => controller.abort());
            live.close();
            await close(server);
        }
    });

    it('limits clients and leaves the station encoder unaffected by disconnects', async () => {
        const encoders: FakeEncoder[] = [];
        const live = new LiveMp3Stream(() => {
            const encoder = new FakeEncoder();
            encoders.push(encoder);
            return encoder;
        }, 1);
        const server = await startHealthServer({} as RadioDirector, 0, live);
        const controller = new AbortController();
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound port');
            const url = `http://127.0.0.1:${address.port}/live.mp3`;
            live.start('music.wav', 'music');
            const first = await fetch(url, { signal: controller.signal });
            const second = await fetch(url);
            expect(first.status).toBe(200);
            expect(second.status).toBe(503);
            controller.abort();
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(encoders[0]!.signals).toHaveLength(0);
        } finally {
            controller.abort();
            live.close();
            await close(server);
        }
    });

    it('fails fast before a programme starts and disconnects listeners if encoding fails', async () => {
        const encoder = new FakeEncoder();
        const live = new LiveMp3Stream(() => encoder);
        const server = await startHealthServer({} as RadioDirector, 0, live);
        const controller = new AbortController();
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound port');
            const url = `http://127.0.0.1:${address.port}/live.mp3`;
            expect((await fetch(url)).status).toBe(503);
            live.start('music.wav', 'music');
            const response = await fetch(url, { signal: controller.signal });
            expect(response.status).toBe(200);
            const pendingAudio = response.body!.getReader().read();
            encoder.emit('error', new Error('encoder failed'));
            await expect(pendingAudio).rejects.toThrow();
            expect((await fetch(url)).status).toBe(503);
        } finally {
            controller.abort();
            live.close();
            await close(server);
        }
    });

    it('resumes a paused encoder before terminating it at a track boundary', () => {
        const encoder = new FakeEncoder();
        const live = new LiveMp3Stream(() => encoder);
        live.start('music.wav', 'music');
        live.pause();
        live.stop();
        expect(encoder.signals).toEqual(['SIGSTOP', 'SIGCONT', undefined]);
        live.close();
    });
});
