import { createServer, type Server } from 'node:http';

import type { RadioDirector } from './director.js';
import type { LiveMp3Stream } from './live-stream.js';

export async function startHealthServer(director: RadioDirector, port: number, liveStream?: LiveMp3Stream, bindHost = '127.0.0.1'): Promise<Server> {
    const server = createServer((request, response) => {
        if (request.url === '/live.mp3' && liveStream) {
            liveStream.attach(request, response);
            return;
        }
        if (request.method !== 'GET' || request.url !== '/health') {
            response.writeHead(404).end();
            return;
        }
        void director
            .status()
            .then(status => {
                // The programme runs even with zero Discord subscribers. Empty
                // running order is an incident regardless of connection state.
                const empty = status.mode !== 'paused' && status.mode !== 'playing' &&
                    (status.readyTracks ?? 0) === 0;
                const ok = status.mode !== 'stopped' && status.mode !== 'degraded' && !empty;
                response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                response.end(JSON.stringify({ ok, mode: status.mode, queued: status.queued, readyTracks: status.readyTracks, outputs: status.outputs }));
            })
            .catch(error => {
                response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'health check failed' }));
            });
    });
    await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => reject(error);
        server.once('error', failed);
        server.listen(port, bindHost, () => {
            server.off('error', failed);
            resolve();
        });
    });
    return server;
}
