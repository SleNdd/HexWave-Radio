import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { RadioDirector } from '../src/director.js';
import { startHealthServer } from '../src/health-server.js';

describe('health server startup', () => {
    it('reports an exhausted connected station as unhealthy', async () => {
        const director = { status: async () => ({ mode: 'degraded', queued: 0, readyTracks: 0,
            outputs: [{ guildId: 'guild', connected: true }] }) } as unknown as RadioDirector;
        const server = await startHealthServer(director, 0);
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound TCP port');
            const response = await fetch(`http://127.0.0.1:${address.port}/health`);
            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toMatchObject({ ok: false, mode: 'degraded', readyTracks: 0 });
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });

    it('reports a connected station still waiting for its first AI-planned track as unhealthy', async () => {
        const director = { status: async () => ({ mode: 'starting', queued: 0, readyTracks: 0,
            outputs: [{ guildId: 'guild', connected: true }] }) } as unknown as RadioDirector;
        const server = await startHealthServer(director, 0);
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound TCP port');
            const response = await fetch(`http://127.0.0.1:${address.port}/health`);
            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toMatchObject({ ok: false, mode: 'starting', readyTracks: 0 });
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });

    it('reports an empty station as unhealthy even without Discord subscribers', async () => {
        const director = {
            status: async () => ({ mode: 'starting', queued: 0, readyTracks: 0, outputs: [] }),
        } as unknown as RadioDirector;
        const server = await startHealthServer(director, 0);
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound TCP port');
            const response = await fetch(`http://127.0.0.1:${address.port}/health`);
            expect(response.status).toBe(503);
            await expect(startHealthServer(director, address.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });

    it('reports a playing station as healthy without Discord subscribers', async () => {
        const director = { status: async () => ({ mode: 'playing', queued: 1, readyTracks: 0, outputs: [] }) } as unknown as RadioDirector;
        const server = await startHealthServer(director, 0);
        try {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound TCP port');
            const response = await fetch(`http://127.0.0.1:${address.port}/health`);
            expect(response.status).toBe(200);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });
});
