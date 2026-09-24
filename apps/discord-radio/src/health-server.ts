import { createServer, type Server } from 'node:http';

import type { RadioDirector } from './director.js';

export async function startHealthServer(director: RadioDirector, port: number): Promise<Server> {
    const server = createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/health') {
            response.writeHead(404).end();
            return;
        }
        void director
            .status()
            .then(status => {
                // The process can answer HTTP while the voice channel is silent.
                // An exhausted queue with a connected output is an incident,
                // not a healthy station.
                const connectedButEmpty = status.mode !== 'paused' && status.mode !== 'playing' &&
                    status.readyTracks === 0 && status.outputs.some(output => output.connected);
                const ok = status.mode !== 'stopped' && !connectedButEmpty;
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
        server.listen(port, '0.0.0.0', () => {
            server.off('error', failed);
            resolve();
        });
    });
    return server;
}
