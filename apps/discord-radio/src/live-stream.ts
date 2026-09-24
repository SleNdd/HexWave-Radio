import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

type Encoder = Pick<ChildProcessByStdio<null, Readable, null>, 'stdout' | 'kill' | 'once'>;
type EncoderFactory = (path: string, gain: number) => Encoder;

function ffmpegEncoder(path: string, gain: number): Encoder {
    return spawn('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-re', '-i', path,
        '-vn', '-ac', '2', '-ar', '44100', '-af', `volume=${gain}`,
        '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '0',
        '-id3v2_version', '0', '-f', 'mp3', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
}

/** One bounded MP3 encoding of the current programme, never one per listener. */
export class LiveMp3Stream {
    private readonly clients = new Set<ServerResponse>();
    private encoder?: Encoder;
    private paused = false;
    private closed = false;

    constructor(private readonly factory: EncoderFactory = ffmpegEncoder, private readonly maxClients = 16) {}

    attach(request: IncomingMessage, response: ServerResponse): void {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }).end(); return; }
        if (this.closed || !this.encoder || this.clients.size >= this.maxClients) { response.writeHead(503).end(); return; }
        response.writeHead(200, {
            'content-type': 'audio/mpeg',
            'cache-control': 'no-store, no-transform',
            'x-content-type-options': 'nosniff',
        });
        response.flushHeaders();
        this.clients.add(response);
        response.once('close', () => this.clients.delete(response));
    }

    start(path: string, kind: 'music' | 'speech'): void {
        if (this.closed) return;
        this.stop();
        try {
            const encoder = this.factory(path, kind === 'speech' ? 1.1 : 0.38);
            this.encoder = encoder;
            this.paused = false;
            encoder.stdout.on('data', (chunk: Buffer) => {
                if (this.encoder !== encoder) return;
                for (const client of this.clients) {
                    if (!client.write(chunk)) {
                        this.clients.delete(client);
                        client.destroy();
                    }
                }
            });
            encoder.once('error', () => {
                if (this.encoder === encoder) {
                    this.encoder = undefined;
                    this.dropClients();
                    console.warn(JSON.stringify({ level: 'warn', event: 'live_stream.encoder_failed' }));
                }
            });
            encoder.once('close', (code: number | null) => {
                if (this.encoder === encoder) {
                    this.encoder = undefined;
                    if (code !== 0) {
                        this.dropClients();
                        console.warn(JSON.stringify({ level: 'warn', event: 'live_stream.encoder_failed' }));
                    }
                }
            });
        } catch {
            // The optional network output must never delay Discord or the station clock.
            this.dropClients();
            console.warn(JSON.stringify({ level: 'warn', event: 'live_stream.encoder_failed' }));
        }
    }

    pause(): void {
        if (this.encoder && !this.paused) this.paused = this.encoder.kill('SIGSTOP');
    }
    resume(): void {
        if (this.encoder && this.paused) {
            this.encoder.kill('SIGCONT');
            this.paused = false;
        }
    }

    stop(): void {
        const encoder = this.encoder;
        this.encoder = undefined;
        if (this.paused) encoder?.kill('SIGCONT');
        this.paused = false;
        encoder?.kill();
    }

    private dropClients(): void {
        for (const client of this.clients) client.destroy();
        this.clients.clear();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.stop();
        for (const client of this.clients) client.end();
        this.clients.clear();
    }
}
