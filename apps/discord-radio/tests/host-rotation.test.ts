import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MediaCache } from '../src/media-cache.js';
import type { BreakContext, MusicProvider, OutputFanout, ShowPlanProposal, Track } from '../src/contracts.js';
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

afterEach(() => vi.restoreAllMocks());

const upcomingProposal: ShowPlanProposal = { theme: 'Грядущий эфир', requestRun: 'alternate', queries: [
    'First Artist — First Song', 'Second Artist — Second Song', 'Third Artist — Third Song',
    'Fourth Artist — Fourth Song', 'Fifth Artist — Fifth Song', 'Sixth Artist — Sixth Song',
    'Seventh Artist — Seventh Song', 'Eighth Artist — Eighth Song',
] };

function upcomingFixture(options?: { upcoming?: () => Promise<ShowPlanProposal>; current?: () => Promise<ShowPlanProposal> }) {
    const store = new RadioStore(':memory:', policy);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const shift = store.startHostShift('sol', now + 9 * 60_000, now, null)!;
    const fallback = store.ensureFallbackShowPlan({ theme: 'Резерв', queries: ['one', 'two', 'three'], requestRun: 'alternate' }, now);
    store.replaceShowPlan(fallback.revision, { theme: 'Текущий AI эфир', queries: ['old one', 'old two', 'old three'], requestRun: 'alternate' }, now);
    for (let index = 0; index < 3; index++) {
        const id = store.enqueueEditorial({ ...track, id: `old-${index}`, title: `Old ${index}`, artist: `Old Artist ${index}` });
        store.claimPreparation();
        store.markReady(id, `C:/cache/old-${index}.media`);
    }
    const fresh = [
        { ...track, id: 'fresh-first', title: 'First Song', artist: 'First Artist' },
        { ...track, id: 'fresh-second', title: 'Second Song', artist: 'Second Artist' },
    ];
    const search = vi.fn(async (query: string) => query === upcomingProposal.queries[0] ? [fresh[0]!]
        : query === upcomingProposal.queries[1] ? [fresh[1]!] : []);
    const reserveReleases: Array<() => void> = [];
    const released = vi.fn();
    const cache = { materialize: vi.fn(async (item: Track) => `C:/cache/${item.id}.media`),
        reserve: vi.fn(() => {
            const release = vi.fn(() => released());
            reserveReleases.push(release);
            return release;
        }) } as unknown as MediaCache;
    const proposeShowPlan = vi.fn(options?.current ?? (async () => await new Promise<ShowPlanProposal>(() => undefined)));
    const proposeUpcomingShowPlan = vi.fn(options?.upcoming ?? (async () => upcomingProposal));
    const radio = new RadioDirector(store, [{ name: 'ytmusic', search } as unknown as MusicProvider], cache, output,
        undefined, [], undefined, 0, { planner: { proposeShowPlan, proposeUpcomingShowPlan },
            shiftPlanner: { proposeHostShift: async () => ({ hostId: 'glm', minutes: 180 }) } });
    // Keep the test focused on plan transfer rather than unrelated playback preparation.
    (radio as unknown as { ensurePrepared: () => Promise<void> }).ensurePrepared = async () => undefined;
    return { radio, store, shift, cache, search, fresh, released, reserveReleases,
        proposeShowPlan, proposeUpcomingShowPlan, advance: (ms: number) => { now += ms; },
        begin: () => {
            (radio as unknown as { running: boolean; kickHostShiftPlanning(): void }).running = true;
            (radio as unknown as { kickHostShiftPlanning(): void }).kickHostShiftPlanning();
        } };
}

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
            expect(contexts[0]?.previousHost).toEqual({ id: 'sol', name: 'Сол' });
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

    it('holds two verified incoming tracks until the pinned shift and commits them together', async () => {
        const fixture = upcomingFixture();
        const { radio, store, shift, fresh, reserveReleases, proposeUpcomingShowPlan, proposeShowPlan } = fixture;
        try {
            fixture.begin();
            await vi.waitFor(() => expect((radio as unknown as { upcomingPlan?: unknown }).upcomingPlan).toBeDefined());
            expect(proposeUpcomingShowPlan).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'glm',
                hostMusicBrief: expect.stringContaining('IDM') }), expect.any(AbortSignal));
            expect(store.currentHostShift()?.id).toBe(shift.id);
            expect(store.currentShowPlan()?.theme).toBe('Текущий AI эфир');
            expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-0', 'old-1', 'old-2']);
            expect(reserveReleases).toHaveLength(2);
            fixture.advance(9 * 60_000 + 1);
            await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
            expect(store.currentHostShift()?.hostId).toBe('glm');
            expect(store.currentShowPlan()?.theme).toBe(upcomingProposal.theme);
            expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(fresh.map(item => item.id));
            expect(reserveReleases.every(release => vi.isMockFunction(release) &&
                (release as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
            // The incoming host is prompted to revise the backstage plan automatically.
            await vi.waitFor(() => expect(proposeShowPlan).toHaveBeenCalledOnce());
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('keeps the old authored queue after an upcoming model failure until the new host plan succeeds', async () => {
        let finishCurrent!: (proposal: ShowPlanProposal) => void;
        const current = new Promise<ShowPlanProposal>(resolve => { finishCurrent = resolve; });
        const fixture = upcomingFixture({ upcoming: async () => { throw new Error('model unavailable'); }, current: async () => await current });
        const { radio, store, proposeUpcomingShowPlan, proposeShowPlan } = fixture;
        try {
            fixture.begin();
            await vi.waitFor(() => expect(proposeUpcomingShowPlan).toHaveBeenCalledOnce());
            fixture.advance(9 * 60_000 + 1);
            await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
            await vi.waitFor(() => expect(proposeShowPlan).toHaveBeenCalledOnce());
            expect(store.currentShowPlan()?.theme).toBe('Текущий AI эфир');
            expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-0', 'old-1', 'old-2']);
            finishCurrent(upcomingProposal);
            await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe(upcomingProposal.theme));
            expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['fresh-first', 'fresh-second']);
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('abandons a short media preplan and releases its only reservation', async () => {
        const fixture = upcomingFixture();
        const { radio, store, search, fresh, reserveReleases } = fixture;
        search.mockImplementation(async query => query === upcomingProposal.queries[0] ? [fresh[0]!] : []);
        try {
            fixture.begin();
            await vi.waitFor(() => expect(reserveReleases).toHaveLength(1));
            await vi.waitFor(() => expect((radio as unknown as { upcomingPlanning?: Promise<void> }).upcomingPlanning).toBeUndefined());
            expect((reserveReleases[0] as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
            expect((radio as unknown as { upcomingPlan?: unknown }).upcomingPlan).toBeUndefined();
            fixture.advance(9 * 60_000 + 1);
            await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
            expect(store.currentShowPlan()?.theme).toBe('Текущий AI эфир');
            expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-0', 'old-1', 'old-2']);
        } finally {
            await radio.stop();
            store.close();
        }
    });

    it('drops staged media when the show revision or pinned shift becomes stale', async () => {
        for (const stale of ['revision', 'shift'] as const) {
            const fixture = upcomingFixture();
            const { radio, store, shift, reserveReleases } = fixture;
            try {
                fixture.begin();
                await vi.waitFor(() => expect((radio as unknown as { upcomingPlan?: unknown }).upcomingPlan).toBeDefined());
                if (stale === 'revision') {
                    store.replaceShowPlan(store.currentShowPlan()!.revision,
                        { theme: 'Новый текущий блок', queries: ['new one', 'new two', 'new three'], requestRun: 'alternate' });
                    // A host-authored revision can arrive after staging and just
                    // before handoff; the commit guard must reject it on its own.
                    fixture.advance(9 * 60_000 + 1);
                    await (radio as unknown as { rotateHostIfDue(): Promise<void> }).rotateHostIfDue();
                    expect(store.currentShowPlan()?.theme).toBe('Новый текущий блок');
                } else {
                    store.startHostShift('claude', Date.now() + 180 * 60_000, Date.now(), shift.id);
                    (radio as unknown as { kickUpcomingPlanning(): void }).kickUpcomingPlanning();
                }
                expect((radio as unknown as { upcomingPlan?: unknown }).upcomingPlan).toBeUndefined();
                expect(reserveReleases.every(release => vi.isMockFunction(release) &&
                    (release as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
                expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-0', 'old-1', 'old-2']);
            } finally {
                await radio.stop();
                store.close();
            }
        }
    });

    it('releases held upcoming media on stop without inserting it', async () => {
        const fixture = upcomingFixture();
        const { radio, store, reserveReleases } = fixture;
        fixture.begin();
        await vi.waitFor(() => expect((radio as unknown as { upcomingPlan?: unknown }).upcomingPlan).toBeDefined());
        await radio.stop();
        expect(reserveReleases.every(release => vi.isMockFunction(release) &&
            (release as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-0', 'old-1', 'old-2']);
        store.close();
    });
});
