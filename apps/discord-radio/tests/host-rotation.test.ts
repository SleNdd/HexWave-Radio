import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import type { MediaCache } from '../src/media-cache.js';
import type { BreakContext, OutputFanout, Track } from '../src/contracts.js';
import { RadioDirector } from '../src/director.js';
import type { HostPresenter } from '../src/host.js';
import { RadioStore } from '../src/storage.js';

const policy = {
    requestCooldownMs: 0, requestTtlMs: 60_000, studioCooldownMs: 0,
    studioTtlMs: 60_000, trackCooldownMs: 0, artistCooldownMs: 0,
};
const pendingPlays = new Set<() => void>();
const output = {
    health: () => [],
    play: async () => await new Promise<void>(resolve => { pendingPlays.add(resolve); }),
    stopAll: () => { for (const release of pendingPlays) release(); pendingPlays.clear(); },
} as unknown as OutputFanout;
const track: Track = { provider: 'ytmusic', id: 'abcdefghijk', title: 'Test Song', artist: 'Test Artist', durationMs: 180_000 };

describe('organizer host rotation', () => {
    it('prepares one introduction for a new shift and ordinary links afterward', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        const shift = store.startHostShift('sol', now + 10 * 60_000, now, null)!;
        const firstId = store.enqueueEditorial(track);
        expect(store.claimPreparation()?.id).toBe(firstId);
        expect(store.markReady(firstId, 'C:/cache/first.media')).toBe(true);
        const secondId = store.enqueueEditorial({ ...track, id: 'nexttrack02', title: 'Next Song' });
        expect(store.claimPreparation()?.id).toBe(secondId);
        expect(store.markReady(secondId, 'C:/cache/second.media')).toBe(true);
        const kinds: string[] = [];
        const presenter = { prepare: async (context: BreakContext) => {
            kinds.push(context.kind);
            return { path: 'C:/cache/line.audio', script: 'Сол у микрофона.' };
        } } as HostPresenter;
        const radio = new RadioDirector(store, [], {} as MediaCache, output, presenter);
        try {
            radio.start();
            await (radio as unknown as { prepareUpcomingBreak(count: number, durationMs: number): Promise<void> })
                .prepareUpcomingBreak(0, track.durationMs);
            expect(kinds).toEqual(['intro']);
            expect(store.currentHostShift()?.introducedAt).toBeUndefined();
            expect(store.markHostIntroduced(shift.id)).toBe(true);
            expect(store.markHostIntroduced(shift.id)).toBe(false);
            expect(store.current()?.id).toBe(firstId);
            const thirdId = store.enqueueEditorial({ ...track, id: 'nexttrack03', title: 'Third Song' });
            expect(store.claimPreparation()?.id).toBe(thirdId);
            expect(store.markReady(thirdId, 'C:/cache/third.media')).toBe(true);
            store.finishItem(firstId);
            store.nextForPlayback();
            await (radio as unknown as { prepareUpcomingBreak(count: number, durationMs: number): Promise<void> })
                .prepareUpcomingBreak(0, track.durationMs);
            expect(kinds[0]).toBe('intro');
            expect(kinds.slice(1)).toContain('station');
            expect(kinds.slice(1)).not.toContain('intro');
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('keeps the starter host on air long enough for an opening break', async () => {
        const store = new RadioStore(':memory:', policy);
        const radio = new RadioDirector(store, [], {} as MediaCache, output);
        try {
            radio.start();
            const shift = store.currentHostShift();
            expect(shift).toBeDefined();
            expect(shift!.plannedEndAt - shift!.startedAt).toBe(10 * 60_000);
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('commits a Luna organizer choice at a boundary and persists the outgoing shift', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        const old = store.startHostShift('sol', now + 20, now, null)!;
        const proposeHostShift = vi.fn(async () => ({ hostId: 'glm' as const, minutes: 180 }));
        const radio = new RadioDirector(store, [], {} as MediaCache, output, undefined, [], undefined, 0,
            { shiftPlanner: { proposeHostShift } });
        try {
            radio.start();
            await vi.waitFor(() => expect(proposeHostShift).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect((radio as unknown as { pendingHostShift?: unknown }).pendingHostShift).toBeDefined());
            await delay(25);
            await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
            expect(store.currentHostShift()).toMatchObject({ hostId: 'glm' });
            expect(store.recentHostShifts(now)).toContainEqual(expect.objectContaining({ id: old.id, endedAt: expect.any(Number) }));
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('uses a different local host when the organizer is unavailable', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        store.startHostShift('luna', now + 5, now, null);
        const radio = new RadioDirector(store, [], {} as MediaCache, output, undefined, [], undefined, 0,
            { shiftPlanner: { proposeHostShift: async () => { throw new Error('model unavailable'); } } });
        try {
            radio.start();
            await delay(15);
            await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
            expect(store.currentHostShift()?.hostId).not.toBe('luna');
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('prepares the incoming host voice for an upcoming request before its boundary', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        store.startHostShift('sol', now + 80, now, null);
        const bridgeId = store.enqueueEditorial({ ...track, id: 'bridge-track', title: 'Bridge' });
        expect(store.claimPreparation()?.id).toBe(bridgeId);
        expect(store.markReady(bridgeId, 'C:/cache/bridge.media')).toBe(true);
        const itemId = store.enqueueEditorial(track);
        expect(store.claimPreparation()?.id).toBe(itemId);
        expect(store.markReady(itemId, 'C:/cache/test.media')).toBe(true);
        const contexts: BreakContext[] = [];
        const presenter = { prepare: async (context: BreakContext) => {
            contexts.push(context);
            return { path: 'C:/cache/glm.audio', script: 'Продолжаем эксперимент.' };
        } } as HostPresenter;
        const radio = new RadioDirector(store, [], {} as MediaCache, output, presenter, [], undefined, 0,
            { shiftPlanner: { proposeHostShift: async () => ({ hostId: 'glm', minutes: 180 }) } });
        try {
            radio.start();
            await vi.waitFor(() => expect((radio as unknown as { pendingHostShift?: unknown }).pendingHostShift).toBeDefined());
            await (radio as unknown as { prepareUpcomingBreak(count: number, durationMs: number): Promise<void> })
                .prepareUpcomingBreak(0, track.durationMs);
            expect(contexts[0]?.hostId).toBe('glm');
            const prepared = (radio as unknown as { readyBreaks: Map<number, { hostId?: string }> }).readyBreaks.get(itemId);
            expect(prepared?.hostId).toBe('glm');
            await delay(90);
            await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
            expect(store.currentHostShift()?.hostId).toBe('glm');
            const segment = store.db.prepare('SELECT id,host_id,host_shift_id FROM host_segments WHERE play_item_id=?').get(itemId) as
                { id: number; host_id: string; host_shift_id: number | null };
            expect(segment).toMatchObject({ host_id: 'glm', host_shift_id: null });
            expect(store.markHostSegmentPlayed(segment.id, Date.now(), store.currentHostShift()!.id)).toBe(true);
            expect(store.db.prepare('SELECT host_shift_id FROM host_segments WHERE id=?').get(segment.id))
                .toEqual({ host_shift_id: store.currentHostShift()!.id });
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('pins a fairness-adjusted incoming host so preparation and rotation agree', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        store.startHostShift('sol', now + 80, now - 180 * 60_000, null);
        const bridgeId = store.enqueueEditorial({ ...track, id: 'bridge-track', title: 'Bridge' });
        store.claimPreparation();
        store.markReady(bridgeId, 'C:/cache/bridge.media');
        const itemId = store.enqueueEditorial(track);
        store.claimPreparation();
        store.markReady(itemId, 'C:/cache/test.media');
        const contexts: BreakContext[] = [];
        const presenter = { prepare: async (context: BreakContext) => {
            contexts.push(context);
            return { path: 'C:/cache/next.audio', script: 'Следующий трек.' };
        } } as HostPresenter;
        const radio = new RadioDirector(store, [], {} as MediaCache, output, presenter, [], undefined, 0,
            { shiftPlanner: { proposeHostShift: async () => ({ hostId: 'sol', minutes: 180 }) } });
        try {
            radio.start();
            await vi.waitFor(() => expect((radio as unknown as { pendingHostShift?: unknown }).pendingHostShift).toBeDefined());
            await (radio as unknown as { prepareUpcomingBreak(count: number, durationMs: number): Promise<void> })
                .prepareUpcomingBreak(0, track.durationMs);
            const preparedHost = contexts[0]?.hostId;
            expect(preparedHost).toBeDefined();
            expect(preparedHost).not.toBe('sol');
            await delay(90);
            await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
            expect(store.currentHostShift()?.hostId).toBe(preparedHost);
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('pins a local incoming host before narration when the organizer answers too late', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        store.startHostShift('sol', now + 80, now, null);
        const itemId = store.enqueueEditorial(track);
        store.claimPreparation();
        store.markReady(itemId, 'C:/cache/test.media');
        let finishPlanner!: (proposal: { hostId: 'grok'; minutes: number }) => void;
        const held = new Promise<{ hostId: 'grok'; minutes: number }>(resolve => { finishPlanner = resolve; });
        const contexts: BreakContext[] = [];
        const presenter = { prepare: async (context: BreakContext) => {
            contexts.push(context);
            return { path: 'C:/cache/pinned.audio', script: 'Следующий трек.' };
        } } as HostPresenter;
        const radio = new RadioDirector(store, [], {} as MediaCache, output, presenter, [], undefined, 0,
            { shiftPlanner: { proposeHostShift: async () => await held } });
        try {
            radio.start();
            await (radio as unknown as { prepareUpcomingBreak(count: number, durationMs: number): Promise<void> })
                .prepareUpcomingBreak(0, track.durationMs);
            const pinned = contexts[0]?.hostId;
            expect(pinned).toBeDefined();
            expect(pinned).not.toBe('sol');
            finishPlanner({ hostId: 'grok', minutes: 180 });
            await delay(90);
            await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
            expect(store.currentHostShift()?.hostId).toBe(pinned);
        } finally {
            await radio.stop();
            store.close();
        }
    });
});
