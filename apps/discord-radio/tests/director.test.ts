import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MediaCache } from '../src/media-cache.js';
import type { BreakContext, HostInputDecisionPlanner, MusicProvider, MusicQueryInterpreter, OutputFanout, ShowPlan, ShowPlanProposal, ShowPlanner, Track } from '../src/contracts.js';
import { RadioDirector } from '../src/director.js';
import type { HostPresenter } from '../src/host.js';
import { RadioStore } from '../src/storage.js';
import { fallbackShowPlan, SHOW_PLAN_TTL_MS } from '../src/showrunner.js';

const policy = {
    requestCooldownMs: 30 * 60_000,
    requestTtlMs: 2 * 60 * 60_000,
    studioCooldownMs: 15 * 60_000,
    studioTtlMs: 2 * 60 * 60_000,
    trackCooldownMs: 6 * 60 * 60_000,
    artistCooldownMs: 45 * 60_000,
};

const found: Track = { provider: 'ytmusic', id: 'abcdefghijk', title: 'Night Circuit', artist: 'Test Unit', durationMs: 180_000 };
const stalledPlanner: ShowPlanner = { proposeShowPlan: async () => await new Promise<ShowPlanProposal>(() => undefined) };

function seedModelPlan(store: RadioStore, queries = ['first music', 'second music', 'third music']): void {
    const now = Date.now();
    const fallback = store.ensureFallbackShowPlan(fallbackShowPlan(now, []), now);
    store.replaceShowPlan(fallback.revision, { theme: 'Модельная программа', queries, requestRun: 'alternate' }, now);
}

afterEach(() => vi.restoreAllMocks());

function director(searches: string[], interpreter?: MusicQueryInterpreter): { director: RadioDirector; store: RadioStore } {
    const store = new RadioStore(':memory:', policy);
    const provider: MusicProvider = {
        name: 'ytmusic',
        search: async query => {
            searches.push(query);
            return [found];
        },
        resolve: async () => found,
        fetch: async () => {
            throw new Error('not used');
        },
        health: async () => ({ ok: true, detail: 'test' }),
    };
    const output: OutputFanout = {
        connectGuild: async () => undefined,
        play: async () => undefined,
        pause: () => false,
        resume: () => false,
        skip: () => false,
        stopGuild: () => undefined,
        stopAll: () => undefined,
        health: () => [],
    };
    return { director: new RadioDirector(store, [provider], {} as MediaCache, output, undefined, [], interpreter), store };
}

describe('RadioDirector requests', () => {
    it('decides a studio letter in the background and persists a bounded deferral', async () => {
        const store = new RadioStore(':memory:', policy);
        const decide = vi.fn(async () => ({ choice: 'defer' as const, deferMinutes: 2 }));
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { inputDecisionPlanner: { proposeInputDecision: decide } });
        radio.start();
        const receipt = await radio.submitStudio({ guildId: 'g', userId: 'u', userName: 'User', message: 'Поздравьте Машу' });
        expect(receipt.accepted).toBe(true);
        await vi.waitFor(() => expect(store.db.prepare('SELECT host_decision FROM studio_messages').get()).toEqual({ host_decision: 'defer' }));
        expect(store.peekStudioMessage()).toBeUndefined();
        expect(decide).toHaveBeenCalledWith(expect.objectContaining({ kind: 'studio', message: 'Поздравьте Машу' }), expect.any(AbortSignal));
        expect(decide).toHaveBeenCalledWith(expect.objectContaining({
            memory: expect.objectContaining({ listenerSignals: [expect.objectContaining({
                kind: 'studio', text: 'Поздравьте Машу', userName: 'User',
            })], hostLines: [] }),
            recentPlayed: [], upcoming: [],
        }), expect.any(AbortSignal));
        await radio.stop();
        store.close();
    });

    it('selects an input durably when the decision model fails and never lets it veto an admin', async () => {
        const store = new RadioStore(':memory:', policy);
        const decide = vi.fn(async () => { throw new Error('model unavailable'); });
        const planner = { proposeInputDecision: decide } as HostInputDecisionPlanner;
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { inputDecisionPlanner: planner, isPrivileged: id => id === 'owner' });
        radio.start();
        expect((await radio.submitStudio({ guildId: 'g', userId: 'u', userName: 'User', message: 'Поздравьте Машу' })).accepted).toBe(true);
        await vi.waitFor(() => expect(store.db.prepare("SELECT host_decision FROM studio_messages WHERE user_id='u'").get()).toEqual({ host_decision: 'select' }));
        expect((await radio.submitStudio({ guildId: 'g', userId: 'owner', userName: 'Owner', message: 'Привет всем' })).accepted).toBe(true);
        expect(store.db.prepare("SELECT host_decision FROM studio_messages WHERE user_id='owner'").get()).toEqual({ host_decision: 'select' });
        expect(decide).toHaveBeenCalledTimes(1);
        await radio.stop();
        store.close();
    });

    it('persists a listener decline with a retryable notice', async () => {
        const store = new RadioStore(':memory:', policy);
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { inputDecisionPlanner: { proposeInputDecision: async () => ({ choice: 'decline' }) } });
        radio.start();
        expect((await radio.submitStudio({ guildId: 'g', userId: 'u', userName: 'User', message: 'Сыграйте немного джаза' })).accepted).toBe(true);
        await vi.waitFor(() => expect(store.db.prepare('SELECT host_decision,status FROM studio_messages').get())
            .toEqual({ host_decision: 'decline', status: 'rejected' }));
        expect(store.dueHostNotification()).toMatchObject({ kind: 'studio', userId: 'u' });
        await radio.stop();
        store.close();
    });

    it('delivers a host decision notice outside the mailbox and marks it sent', async () => {
        const store = new RadioStore(':memory:', policy);
        const send = vi.fn(async () => undefined);
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { inputDecisionPlanner: { proposeInputDecision: async () => ({ choice: 'decline' }) } });
        radio.setHostNotificationSender(send);
        radio.start();
        expect((await radio.submitStudio({ guildId: 'g', userId: 'u', userName: 'User', message: 'Привет студии' })).accepted).toBe(true);
        await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ userId: 'u', guildId: 'g' }, expect.stringContaining('письмо')),
            { timeout: 3_000 });
        await vi.waitFor(() => expect(store.db.prepare('SELECT status FROM host_notifications').get()).toEqual({ status: 'sent' }));
        await radio.stop();
        store.close();
    });

    it('drains a hung host decision on shutdown without changing its pending receipt', async () => {
        const store = new RadioStore(':memory:', policy);
        const decide = vi.fn(async () => await new Promise<{ choice: 'select' }>(() => undefined));
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { inputDecisionPlanner: { proposeInputDecision: decide } });
        radio.start();
        expect((await radio.submitStudio({ guildId: 'g', userId: 'u', userName: 'User', message: 'Привет студии' })).accepted).toBe(true);
        await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
        await Promise.race([radio.stop(), delay(300).then(() => { throw new Error('host decision stalled shutdown'); })]);
        expect(store.db.prepare('SELECT host_decision FROM studio_messages').get()).toEqual({ host_decision: 'pending' });
        store.close();
    });
    it('rechecks an admin grant at the mailbox commit after a slow music search', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        store.addRequest({ guildId: 'g', userId: 'helper', userName: 'Helper', track: {
            ...found, id: 'existing-song', title: 'Existing Song', artist: 'Other Artist',
        }, now });
        let finishSearch!: (tracks: Track[]) => void;
        const pending = new Promise<Track[]>(resolve => { finishSearch = resolve; });
        const provider = { name: 'ytmusic', search: async () => await pending } as MusicProvider;
        let privileged = true;
        const radio = new RadioDirector(store, [provider], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { isPrivileged: () => privileged });
        const request = radio.submitRequest({ guildId: 'g', userId: 'helper', userName: 'Helper', query: 'Night Circuit', isOwner: true, now: now + 1 });
        privileged = false;
        finishSearch([found]);
        expect(await request).toMatchObject({ kind: 'rejected' });
        expect(store.counts().pendingRequests).toBe(1);
        await radio.stop();
        store.close();
    });

    it('keeps music playing while the show planner is stalled', async () => {
        const store = new RadioStore(':memory:', policy);
        const searches: string[] = [];
        const provider = { name: 'ytmusic', search: async (query: string) => { searches.push(query); return [found]; } } as MusicProvider;
        const cache = { materialize: async () => 'C:/cache/show.media' } as MediaCache;
        const ready = store.enqueueEditorial(found);
        expect(store.claimPreparation()?.id).toBe(ready);
        expect(store.markReady(ready, 'C:/cache/show.media')).toBe(true);
        const play = vi.fn(async () => undefined);
        const output = { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [provider], cache, output, undefined, [], undefined, 0, { planner: stalledPlanner });

        await radio.tick();
        for (let attempt = 0; attempt < 30 && !store.peekNextForPlayback(); attempt++) await delay(5);
        await Promise.race([radio.tick(), delay(300).then(() => { throw new Error('show planning stalled music'); })]);
        expect(play).toHaveBeenCalledWith('C:/cache/show.media');
        expect(searches).toEqual([]);
        await Promise.race([radio.stop(), delay(300).then(() => { throw new Error('show planning stalled shutdown'); })]);
        store.close();
    });

    it('only fills from an authored plan, including one persisted before planner loss', async () => {
        const store = new RadioStore(':memory:', policy);
        const search = vi.fn(async () => [found]);
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search } as MusicProvider], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout);
        const fill = (radio as unknown as { fillEditorialHorizon(): Promise<void> }).fillEditorialHorizon.bind(radio);
        await fill();
        expect(search).not.toHaveBeenCalled();
        expect(store.editorialPipelineCount()).toBe(0);
        seedModelPlan(store);
        await fill();
        expect(search).toHaveBeenCalled();
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual([found.id]);
        await radio.stop();
        store.close();
    });

    it('starts an AI show plan even when the editorial queue is already full', async () => {
        const store = new RadioStore(':memory:', policy);
        for (let index = 0; index < 3; index++) {
            const id = store.enqueueEditorial({ ...found, id: `queued-${index}`, title: `Queued ${index}`, artist: `Artist ${index}` });
            expect(store.claimPreparation()?.id).toBe(id);
            expect(store.markReady(id, `C:/cache/${index}.media`)).toBe(true);
        }
        const planner = { proposeShowPlan: vi.fn(async () => ({
            theme: 'Ночная энергия', queries: ['drum and bass', 'phonk music', 'alternative metal'], requestRun: 'continue' as const,
        })) };
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, ['drum n bass', 'phonk', 'metal'], undefined, 0, { planner });
        radio.start();
        await vi.waitFor(() => expect(store.currentShowPlan()?.source).toBe('model'));
        expect(planner.proposeShowPlan).toHaveBeenCalledOnce();
        await radio.stop();
        store.close();
    });

    it('replaces a successful old-host ready tail with one bridge and new-host music', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 10_000_000;
        const fallback = store.ensureFallbackShowPlan(fallbackShowPlan(now, []), now);
        for (let index = 0; index < 4; index++) {
            const id = store.enqueueEditorial({ ...found, id: `old-track-${index}`, artist: `Old ${index}` }, now + index);
            expect(store.claimPreparation()?.id).toBe(id);
            expect(store.markReady(id, `C:/cache/old-${index}.media`, now)).toBe(true);
        }
        const fresh = [0, 1].map(index => ({ track: { ...found, id: `new-track-${index}`,
            title: `New Song ${index}`, artist: `New ${index}` }, localPath: `C:/cache/new-${index}.media` }));
        const applied = store.applyEditorialPlan(fallback.revision, {
            theme: 'Новый ведущий', queries: ['New 0 — New Song 0', 'New 1 — New Song 1',
                'New 2 — New Song 2'], requestRun: 'alternate',
        }, fresh, now + 10);
        expect(applied?.theme).toBe('Новый ведущий');
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-track-0', 'new-track-0', 'new-track-1']);
        expect(store.db.prepare("SELECT COUNT(*) AS count FROM play_items WHERE state='expired'").get()).toEqual({ count: 3 });
        store.close();
    });

    it('requests a new show plan before a short authored run reaches silence', async () => {
        const store = new RadioStore(':memory:', policy);
        let now = 10_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const fallback = store.ensureFallbackShowPlan(fallbackShowPlan(now, []), now);
        store.replaceShowPlan(fallback.revision,
            { theme: 'Первый блок', queries: ['Artist A — Song A', 'Artist B — Song B', 'Artist C — Song C'], requestRun: 'alternate' }, now);
        for (let index = 0; index < 5; index++) store.enqueueEditorial({ ...found,
            id: `abcdabcda${index}x`, artist: `Artist ${index}`, title: `Song ${index}` }, now + index);
        const planner = { proposeShowPlan: vi.fn(async () => ({
            theme: 'Следующий блок', queries: ['Artist D — Song D', 'Artist E — Song E', 'Artist F — Song F'], requestRun: 'continue' as const,
        })) };
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        expect(planner.proposeShowPlan).not.toHaveBeenCalled();
        const item = store.claimPreparation()!;
        store.markReady(item.id, 'C:/cache/first.media', now);
        store.nextForPlayback();
        store.finishItem(item.id, now + 1000);
        now += 60_000;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(planner.proposeShowPlan).toHaveBeenCalledOnce());
        await radio.stop();
        store.close();
    });

    it('lets the host revise its programme after four played songs even with a deep ready tail', async () => {
        const store = new RadioStore(':memory:', policy);
        let now = 10_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const fallback = store.ensureFallbackShowPlan(fallbackShowPlan(now, []), now);
        store.replaceShowPlan(fallback.revision, {
            theme: 'Текущий блок', queries: ['A — A', 'B — B', 'C — C'], requestRun: 'alternate',
        }, now);
        for (let index = 0; index < 8; index++) {
            const id = store.enqueueEditorial({ ...found, id: `planned-${index}`,
                title: `Song ${index}`, artist: `Artist ${index}` }, now + index);
            expect(store.claimPreparation()?.id).toBe(id);
            store.markReady(id, `C:/cache/${index}.media`, now);
        }
        for (let index = 0; index < 4; index++) {
            const item = store.nextForPlayback()!;
            store.finishItem(item.id, now + 1_000 + index);
        }
        now += 6 * 60_000;
        const planner = { proposeShowPlan: vi.fn(async () => ({
            theme: 'Поворот ведущего', queries: ['D — D', 'E — E', 'F — F'], requestRun: 'continue' as const,
        })) };
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(planner.proposeShowPlan).toHaveBeenCalledOnce());
        await radio.stop();
        store.close();
    });

    it('does not repeatedly replan an unchanged sparse editorial run', async () => {
        const store = new RadioStore(':memory:', policy);
        let now = 10_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const fallback = store.ensureFallbackShowPlan(fallbackShowPlan(now, []), now);
        store.replaceShowPlan(fallback.revision,
            { theme: 'Первый блок', queries: ['Artist A — Song A', 'Artist B — Song B', 'Artist C — Song C'], requestRun: 'alternate' }, now);
        for (let index = 0; index < 3; index++) store.enqueueEditorial({ ...found,
            id: `abcdabcdb${index}x`, artist: `Artist ${index}`, title: `Song ${index}` }, now + index);
        const planner = { proposeShowPlan: vi.fn(async () => ({
            theme: 'Новый блок', queries: ['Artist D — Song D', 'Artist E — Song E', 'Artist F — Song F'], requestRun: 'continue' as const,
        })) };
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        (radio as unknown as { ensurePrepared: () => Promise<void> }).ensurePrepared = async () => undefined;
        now += 6 * 60_000;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(planner.proposeShowPlan).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Новый блок'));
        expect(store.editorialPipelineCount()).toBe(3);
        expect((radio as unknown as { editorialDepthHighWater?: number }).editorialDepthHighWater).toBe(3);
        now += 6 * 60_000;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        expect(planner.proposeShowPlan).toHaveBeenCalledOnce();
        const item = store.claimPreparation()!;
        store.markReady(item.id, 'C:/cache/first.media', now);
        store.nextForPlayback();
        store.finishItem(item.id, now + 1000);
        now += 6 * 60_000;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(planner.proposeShowPlan).toHaveBeenCalledTimes(2));
        await radio.stop();
        store.close();
    });

    it('does not apply a delayed skip to the next on-air item', async () => {
        const store = new RadioStore(':memory:', policy);
        const skip = vi.fn(() => true);
        const output = { skip, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [], {} as MediaCache, output);
        const internals = radio as unknown as {
            playing: boolean;
            currentItemId: number;
            mailbox: { run<T>(task: () => Promise<T>): Promise<T> };
        };
        internals.playing = true;
        internals.currentItemId = 1;
        let release!: () => void;
        const blocker = internals.mailbox.run(() => new Promise<void>(resolve => { release = resolve; }));
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const pendingSkip = radio.skip();
        internals.currentItemId = 2;
        release();
        await blocker;
        expect(await pendingSkip).toBe('idle');
        expect(skip).not.toHaveBeenCalled();
        await radio.stop();
        store.close();
    });

    it('keeps the current track audible when skip has no ready successor unless forced', async () => {
        const store = new RadioStore(':memory:', policy);
        const id = store.enqueueEditorial(found);
        expect(store.claimPreparation()?.id).toBe(id);
        expect(store.markReady(id, 'C:/cache/current.media')).toBe(true);
        let rejectPlayback!: (error: Error) => void;
        const play = vi.fn(async () => await new Promise<void>((_resolve, reject) => { rejectPlayback = reject; }));
        const skip = vi.fn(() => { rejectPlayback(new Error('Playback skipped by owner')); return true; });
        const output = { health: () => [{ guildId: 'g', connected: true }], play, skip, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [], {} as MediaCache, output);
        (radio as unknown as { lastCompletedTrack?: Track }).lastCompletedTrack = found;
        await radio.tick();
        expect(await radio.skip()).toBe('preparing');
        expect(skip).not.toHaveBeenCalled();
        expect(await radio.skip(true)).toBe('skipped');
        await vi.waitFor(() => expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(id)).toEqual({ state: 'interrupted' }));
        expect((radio as unknown as { lastCompletedTrack?: Track }).lastCompletedTrack).toBeUndefined();
        expect(store.db.prepare('SELECT COUNT(*) AS n FROM track_quarantine').get()).toEqual({ n: 0 });
        await radio.stop();
        store.close();
    });

    it('skips the queue item when the owner interrupts its host break', async () => {
        const store = new RadioStore(':memory:', policy);
        const first = store.enqueueEditorial(found);
        const second = store.enqueueEditorial({ ...found, id: 'next-track', artist: 'Next Artist' });
        for (const [id, path] of [[first, 'C:/cache/first.media'], [second, 'C:/cache/second.media']] as const) {
            expect(store.claimPreparation()?.id).toBe(id);
            expect(store.markReady(id, path)).toBe(true);
        }
        let rejectBreak!: (error: Error) => void;
        const play = vi.fn(async (_path: string) => await new Promise<void>((_resolve, reject) => { rejectBreak = reject; }));
        const output = { health: () => [{ guildId: 'g', connected: true }], play,
            skip: () => { rejectBreak(new Error('Playback skipped by owner')); return true; }, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [], {} as MediaCache, output);
        (radio as unknown as { readyBreaks: Map<number, object> }).readyBreaks.set(first,
            { path: 'C:/cache/host.audio', kind: 'station' });
        await radio.tick();
        await vi.waitFor(() => expect(play).toHaveBeenCalledWith('C:/cache/host.audio', { kind: 'speech' }));
        expect(await radio.skip()).toBe('skipped');
        await vi.waitFor(() => expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(first)).toEqual({ state: 'interrupted' }));
        expect(play).toHaveBeenCalledTimes(1);
        await radio.stop();
        store.close();
    });

    it('prepares a host break without waiting for a slower later download', async () => {
        const store = new RadioStore(':memory:', policy);
        const ids = [store.enqueueEditorial(found),
            store.enqueueEditorial({ ...found, id: 'next-ready', artist: 'Next Artist' }),
            store.enqueueEditorial({ ...found, id: 'later-queued', artist: 'Later Artist' })];
        for (const id of ids.slice(0, 2)) {
            expect(store.claimPreparation()?.id).toBe(id);
            expect(store.markReady(id, `C:/cache/${id}.media`)).toBe(true);
        }
        let releaseDownload!: (value: string) => void;
        const download = new Promise<string>(resolve => { releaseDownload = resolve; });
        let releasePlayback!: () => void;
        const play = vi.fn(async () => await new Promise<void>(resolve => { releasePlayback = resolve; }));
        const prepare = vi.fn(async () => ({ path: 'C:/cache/host.audio', script: 'Реплика.' }));
        const output = { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search: async () => [] } as unknown as MusicProvider],
            { materialize: async () => await download } as MediaCache, output, { prepare } as unknown as HostPresenter);
        await radio.tick();
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(ids[2]!)).toEqual({ state: 'preparing' });
        releaseDownload('C:/cache/3.media');
        releasePlayback();
        await vi.waitFor(() => expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(ids[0]!)).toEqual({ state: 'played' }));
        await radio.stop();
        store.close();
    });

    it('discards a late model plan after its fallback revision expires', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        let deliver!: (proposal: ShowPlanProposal) => void;
        const pending = new Promise<ShowPlanProposal>(resolve => { deliver = resolve; });
        const planner = { proposeShowPlan: async () => await pending } as ShowPlanner;
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        const first = await (radio as unknown as { activeShowPlan(): Promise<{ revision: number }> }).activeShowPlan();
        await delay(0);
        clock.mockReturnValue(now + SHOW_PLAN_TTL_MS + 1);
        const next = store.ensureFallbackShowPlan(fallbackShowPlan(Date.now(), []), Date.now());
        expect(next.revision).toBe(first.revision + 1);
        deliver({ theme: 'Опоздавшая тема', queries: ['русский рок', 'indie rock', 'jazz funk'], requestRun: 'continue' });
        await delay(5);
        expect(store.currentShowPlan()?.source).toBe('fallback');
        expect(store.currentShowPlan()?.revision).toBe(next.revision);
        await radio.stop();
        store.close();
    });

    it('does not enqueue a provider result from a replaced show-plan revision', async () => {
        const store = new RadioStore(':memory:', policy);
        seedModelPlan(store, ['old one', 'old two', 'old three']);
        let startSearch!: () => void;
        let finishSearch!: (tracks: Track[]) => void;
        const searching = new Promise<void>(resolve => { startSearch = resolve; });
        const candidates = new Promise<Track[]>(resolve => { finishSearch = resolve; });
        const provider = { name: 'ytmusic', search: async (query: string) => {
            if (query.startsWith('old')) { startSearch(); return await candidates; }
            return [{ ...found, id: `new-${query}`, artist: `Artist ${query}`, title: `Track ${query}` }];
        } } as MusicProvider;
        let deliver!: (proposal: ShowPlanProposal) => void;
        const pending = new Promise<ShowPlanProposal>(resolve => { deliver = resolve; });
        const planner = { proposeShowPlan: async () => await pending } as ShowPlanner;
        const radio = new RadioDirector(store, [provider], { materialize: async track => `C:/cache/${track.id}.media` } as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, ['old one', 'old two', 'old three'], undefined, 0, { planner });
        const refill = (radio as unknown as { fillEditorialHorizon(): Promise<void> }).fillEditorialHorizon();
        await searching;
        deliver({ theme: 'Новая тема', queries: ['русский джаз', 'indie rock', 'house music'], requestRun: 'alternate' });
        for (let attempt = 0; attempt < 30 && store.currentShowPlan()?.source !== 'model'; attempt++) await delay(5);
        expect(store.currentShowPlan()?.source).toBe('model');
        finishSearch([found]);
        await refill;
        expect(store.upcomingEditorial().map(item => item.track.id)).toContain('new-русский джаз');
        expect(store.upcomingEditorial().some(item => item.track.id === found.id)).toBe(false);
        await radio.stop();
        store.close();
    });

    it('revises a model-authored theme after a listener signal without waiting for its hourly expiry', async () => {
        const store = new RadioStore(':memory:', policy);
        let now = 10_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const proposals: ShowPlanProposal[] = [
            { theme: 'Ночной ритм', queries: ['drum and bass', 'phonk music', 'techno mix'], requestRun: 'alternate' },
            { theme: 'Гитарный поворот', queries: ['русский рок', 'alternative metal', 'post punk'], requestRun: 'continue' },
        ];
        const planner = { proposeShowPlan: vi.fn(async () => proposals.shift()!) };
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Ночной ритм'));
        now += 6 * 60_000;
        expect((await radio.submitStudio({ guildId: 'g', userId: 'u', userName: 'Listener', message: 'Хочу немного рока', now })).accepted).toBe(true);
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Гитарный поворот'));
        expect(planner.proposeShowPlan).toHaveBeenCalledTimes(2);
        await radio.stop();
        store.close();
    });

    it('can replace real future editorial songs in response to a studio genre request', async () => {
        const store = new RadioStore(':memory:', policy);
        let now = 10_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const fallback = store.ensureFallbackShowPlan(fallbackShowPlan(now, []), now);
        store.replaceShowPlan(fallback.revision,
            { theme: 'Тихий вечер', queries: ['Old Artist — Old Song', 'Other Artist — Other Song', 'Third Artist — Third Song'], requestRun: 'alternate' }, now);
        const oldId = store.enqueueEditorial({ ...found, id: 'old-editorial', artist: 'Old Artist', title: 'Old Song' }, now);
        const planner = { proposeShowPlan: vi.fn(async () => ({ theme: 'Гитарный час',
            queries: ['Rock One — First Song', 'Rock Two — Second Song', 'Rock Three — Third Song',
                'Rock Four — Fourth Song', 'Rock Five — Fifth Song'],
            requestRun: 'continue' as const })) };
        const provider = { name: 'ytmusic', search: async (query: string) => {
            const [artist, title] = query.split(' — ');
            return [{ ...found, id: `song-${artist}`, artist, title }];
        } } as MusicProvider;
        const radio = new RadioDirector(store, [provider],
            { materialize: async track => `C:/cache/${track.id}.media` } as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        now += 6 * 60_000;
        expect((await radio.submitStudio({ guildId: 'g', userId: 'u', userName: 'Listener',
            message: 'Пожалуйста, смените жанр на рок', now })).accepted).toBe(true);
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Гитарный час'));
        expect(planner.proposeShowPlan).toHaveBeenCalledWith(expect.objectContaining({
            memory: expect.objectContaining({ listenerSignals: [expect.objectContaining({
                kind: 'studio', text: 'Пожалуйста, смените жанр на рок',
            })] }),
        }), expect.any(AbortSignal));
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(oldId)).toEqual({ state: 'expired' });
        expect(store.upcomingEditorial().map(item => `${item.track.artist} — ${item.track.title}`)).toEqual([
            'Rock One — First Song', 'Rock Two — Second Song', 'Rock Three — Third Song',
            'Rock Four — Fourth Song', 'Rock Five — Fifth Song',
        ]);
        await radio.stop();
        store.close();
    });

    it('starts with one verified AI-selected song when no successor exists', async () => {
        const store = new RadioStore(':memory:', policy);
        const proposal = { theme: 'Срочный эфир', queries: [
            'Test Unit — Night Circuit', 'Other One — Lost Song',
            'Other Two — Missing Song', 'Other Three — Unavailable',
        ], requestRun: 'alternate' as const };
        const planner = { proposeShowPlan: vi.fn(async () => proposal) };
        const search = vi.fn(async (query: string) => query === proposal.queries[0] ? [found] : []);
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search } as unknown as MusicProvider],
            { materialize: async () => 'C:/cache/one.media' } as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(store.upcomingEditorial().map(item => item.track.id)).toEqual([found.id]));
        expect(store.currentShowPlan()?.source).toBe('model');
        expect(search).toHaveBeenCalledWith(proposal.queries[0], 5, expect.any(AbortSignal));
        await radio.stop();
        store.close();
    });

    it('quarantines an unavailable staged candidate and commits the next verified song', async () => {
        const store = new RadioStore(':memory:', policy);
        const proposal = { theme: 'Новый блок', queries: [
            'Test Unit — Night Circuit', 'Fresh Artist — Fresh Song', 'Missing Artist — Lost Song',
        ], requestRun: 'alternate' as const };
        const fresh = { ...found, id: 'fresh-song', artist: 'Fresh Artist', title: 'Fresh Song' };
        const planner = { proposeShowPlan: vi.fn(async () => proposal) };
        const search = vi.fn(async (query: string) => query === proposal.queries[0] ? [found]
            : query === proposal.queries[1] ? [fresh] : []);
        const materialize = vi.fn(async (track: Track) => {
            if (track.id === found.id) throw new Error('YouTube Music resolve failed (403)');
            return 'C:/cache/fresh.media';
        });
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search } as unknown as MusicProvider],
            { materialize } as unknown as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        (radio as unknown as { ensurePrepared: () => Promise<void> }).ensurePrepared = async () => undefined;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Новый блок'));
        expect(materialize).toHaveBeenCalledTimes(2);
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual([fresh.id]);
        expect(store.canQueueEditorial(found)).toBe(false);
        await radio.stop();
        store.close();
    });

    it.each([
        ['resolver 502', new Error('YouTube Music resolve failed (502)')],
        ['provider timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ])('skips a transient %s without quarantining the song or discarding the plan', async (_failure, transientError) => {
        const store = new RadioStore(':memory:', policy);
        const proposal = { theme: 'Резервный кандидат', queries: [
            'Test Unit — Night Circuit', 'Fresh Artist — Fresh Song', 'Missing Artist — Lost Song',
        ], requestRun: 'alternate' as const };
        const fresh = { ...found, id: 'fresh-after-502', artist: 'Fresh Artist', title: 'Fresh Song' };
        const search = vi.fn(async (query: string) => query === proposal.queries[0] ? [found]
            : query === proposal.queries[1] ? [fresh] : []);
        const materialize = vi.fn(async (track: Track) => {
            if (track.id === found.id) throw transientError;
            return 'C:/cache/fresh.media';
        });
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search } as unknown as MusicProvider],
            { materialize } as unknown as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner: { proposeShowPlan: async () => proposal } });
        (radio as unknown as { ensurePrepared: () => Promise<void> }).ensurePrepared = async () => undefined;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Резервный кандидат'));
        expect(materialize).toHaveBeenCalledTimes(2);
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual([fresh.id]);
        expect(store.canQueueEditorial(found)).toBe(true);
        await radio.stop();
        store.close();
    });

    it('does not quarantine a good candidate when the local cache cannot write', async () => {
        const store = new RadioStore(':memory:', policy);
        const proposal = { theme: 'Новый блок', queries: [
            'Test Unit — Night Circuit', 'Another Artist — Song', 'Third Artist — Song',
        ], requestRun: 'alternate' as const };
        const planner = { proposeShowPlan: vi.fn(async () => proposal) };
        const search = vi.fn(async () => [found]);
        const materialize = vi.fn(async () => { throw new Error('EACCES: cache write denied'); });
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search } as unknown as MusicProvider],
            { materialize } as unknown as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect((radio as unknown as { showPlanning?: Promise<void> }).showPlanning).toBeUndefined());
        expect(search).toHaveBeenCalledOnce();
        expect(store.db.prepare('SELECT COUNT(*) AS n FROM track_quarantine').get()).toEqual({ n: 0 });
        expect(store.canQueueEditorial(found)).toBe(true);
        await radio.stop();
        store.close();
    });

    it('commits one fresh verified song promptly when only two editorial tracks remain', async () => {
        const store = new RadioStore(':memory:', policy);
        let now = 10_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        for (let index = 0; index < 2; index++) {
            const id = store.enqueueEditorial({ ...found, id: `old-song-${index}`, artist: `Old Artist ${index}` });
            expect(store.claimPreparation()?.id).toBe(id);
            expect(store.markReady(id, `C:/cache/old-${index}.media`)).toBe(true);
        }
        const proposal = { theme: 'Срочный поворот', queries: [
            'Test Unit — Night Circuit', 'Other One — Unavailable', 'Other Two — Missing',
        ], requestRun: 'alternate' as const };
        const nextTrack = { ...found, id: 'fresh-followup', artist: 'Fresh Artist', title: 'Followup Song' };
        const followup = { ...proposal, theme: 'Следующий срочный блок',
            queries: ['Fresh Artist — Followup Song', 'Another One — Unavailable', 'Another Two — Missing'] };
        let planCalls = 0;
        const planner = { proposeShowPlan: vi.fn(async () => planCalls++ === 0 ? proposal : followup) };
        const search = vi.fn(async (query: string) => query === proposal.queries[0] ? [found]
            : query === followup.queries[0] ? [nextTrack] : []);
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search } as unknown as MusicProvider],
            { materialize: async () => 'C:/cache/fresh.media' } as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        (radio as unknown as { ensurePrepared: () => Promise<void> }).ensurePrepared = async () => undefined;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Срочный поворот'));
        expect(search).toHaveBeenCalledTimes(1);
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-song-0', found.id]);
        now += 60_000;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        expect(planner.proposeShowPlan).toHaveBeenCalledOnce();
        const first = store.nextForPlayback()!;
        store.finishItem(first.id, now + 1_000);
        now += 60_000;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(planner.proposeShowPlan).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Следующий срочный блок'));
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual([found.id, nextTrack.id]);
        await radio.stop();
        store.close();
    });

    it('uses the current reserve when playback consumes a song during slow plan staging', async () => {
        const store = new RadioStore(':memory:', policy);
        let now = 10_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        for (let index = 0; index < 3; index++) {
            const id = store.enqueueEditorial({ ...found, id: `old-${index}`, artist: `Old Artist ${index}` });
            expect(store.claimPreparation()?.id).toBe(id);
            expect(store.markReady(id, `C:/cache/old-${index}.media`)).toBe(true);
        }
        const proposal = { theme: 'Обновлённый эфир', queries: [
            'Test Unit — Night Circuit', 'Missing Artist — Lost Track', 'Another Artist — Missing',
        ], requestRun: 'alternate' as const };
        const planner = { proposeShowPlan: vi.fn(async () => proposal) };
        const search = vi.fn(async (query: string) => query === proposal.queries[0] ? [found] : []);
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search } as unknown as MusicProvider],
            { materialize: async () => {
                const playing = store.nextForPlayback()!;
                now += 90_000;
                store.finishItem(playing.id, now);
                return 'C:/cache/new.media';
            } } as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        (radio as unknown as { ensurePrepared: () => Promise<void> }).ensurePrepared = async () => undefined;
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Обновлённый эфир'));
        expect(search).toHaveBeenCalledTimes(1);
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-1', found.id]);
        await radio.stop();
        store.close();
    });

    it('does not apply a show proposal made before a newly accepted listener signal', async () => {
        const store = new RadioStore(':memory:', policy);
        const deliveries: Array<(proposal: ShowPlanProposal) => void> = [];
        const planner = { proposeShowPlan: vi.fn(async () => await new Promise<ShowPlanProposal>(resolve => {
            deliveries.push(resolve);
        })) };
        const radio = new RadioDirector(store, [], {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout,
            undefined, [], undefined, 0, { planner });
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(deliveries).toHaveLength(1));
        expect((await radio.submitStudio({ guildId: 'g', userId: 'u', userName: 'Listener',
            message: 'Поменяйте вечер на джаз' })).accepted).toBe(true);
        deliveries[0]!({ theme: 'Старая программа', queries: ['rock', 'metal', 'techno'], requestRun: 'alternate' });
        await vi.waitFor(() => expect((radio as unknown as { showPlanning?: Promise<void> }).showPlanning).toBeUndefined());
        expect(store.currentShowPlan()?.source).toBe('fallback');
        await (radio as unknown as { activeShowPlan(): Promise<ShowPlan> }).activeShowPlan();
        await vi.waitFor(() => expect(deliveries).toHaveLength(2));
        deliveries[1]!({ theme: 'Новая программа', queries: ['jazz', 'soul', 'funk'], requestRun: 'alternate' });
        await vi.waitFor(() => expect(store.currentShowPlan()?.theme).toBe('Новая программа'));
        await radio.stop();
        store.close();
    });

    it('answers a request despite a hung second catalog search', async () => {
        const store = new RadioStore(':memory:', policy);
        let hungSignal: AbortSignal | undefined;
        let releaseHung!: (tracks: Track[]) => void;
        const hung = new Promise<Track[]>(resolve => { releaseHung = resolve; });
        const providers = [
            { name: 'ytmusic', search: async () => [found] },
            { name: 'spotify', search: async (_query: string, _limit: number, signal: AbortSignal) => { hungSignal = signal; return await hung; } },
        ] as MusicProvider[];
        const radio = new RadioDirector(store, providers, {} as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout);
        (radio as unknown as { searchTimeoutMs: number }).searchTimeoutMs = 20;
        const result = await Promise.race([
            radio.submitRequest({ guildId: 'g', userId: 'u', userName: 'User', query: 'Night Circuit' }),
            delay(500).then(() => { throw new Error('request search stalled'); }),
        ]);
        expect(result.kind).toBe('accepted');
        expect(hungSignal?.aborted).toBe(true);
        releaseHung([found]);
        await delay(0);
        expect(store.counts().pendingRequests).toBe(1);
        await radio.stop();
        store.close();
    });

    it('starts a ready request without waiting for stalled narration and drains it on stop', async () => {
        const store = new RadioStore(':memory:', policy);
        const accepted = store.addRequest({ guildId: 'g', userId: 'u', userName: 'User', track: found, now: Date.now() });
        expect(accepted.accepted).toBe(true);
        const item = store.claimPreparation()!;
        store.markReady(item.id, 'C:/cache/request.media');
        const play = vi.fn(async () => undefined);
        const output = { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout;
        const presenter = { prepare: () => new Promise<never>(() => undefined) } as unknown as HostPresenter;
        const radio = new RadioDirector(store, [], {} as MediaCache, output, presenter);

        await Promise.race([radio.tick(), delay(200).then(() => { throw new Error('request boundary stalled'); })]);
        expect(play).toHaveBeenCalledWith('C:/cache/request.media');
        await Promise.race([radio.stop(), delay(200).then(() => { throw new Error('director shutdown stalled'); })]);
        expect(store.db.prepare('SELECT status FROM host_segments').all()).toEqual([]);
        store.close();
    });

    it('defers a stalled media preparation and advances to the next queued track', async () => {
        const store = new RadioStore(':memory:', policy);
        const stalledId = store.enqueueEditorial(found);
        const next = { ...found, id: 'bcdefghijkl', artist: 'Second Artist' };
        store.enqueueEditorial(next);
        let stalledSignal: AbortSignal | undefined;
        let finishStalled!: (path: string) => void;
        const stalled = new Promise<string>(resolve => { finishStalled = resolve; });
        const cache = { materialize: async (track: Track, _provider: MusicProvider, signal: AbortSignal) => {
            if (track.id === found.id) {
                stalledSignal = signal;
                return await stalled;
            }
            return 'C:/cache/next.media';
        } } as MediaCache;
        const provider = { name: 'ytmusic', search: async () => [] } as MusicProvider;
        const play = vi.fn(async () => undefined);
        const output = { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [provider], cache, output, undefined, ['station']);
        (radio as unknown as { preparationTimeoutMs: number }).preparationTimeoutMs = 20;

        await Promise.race([radio.tick(), delay(500).then(() => { throw new Error('media preparation stalled'); })]);
        expect(stalledSignal?.aborted).toBe(true);
        expect(store.db.prepare('SELECT state,error FROM play_items WHERE id=?').get(stalledId)).toEqual({ state: 'queued', error: 'Media preparation timed out' });
        await radio.tick();
        expect(play).toHaveBeenCalledWith('C:/cache/next.media');
        finishStalled('C:/cache/late.media');
        await delay(0);
        expect(store.db.prepare('SELECT state,local_path FROM play_items WHERE id=?').get(stalledId)).toEqual({ state: 'queued', local_path: null });
        await radio.stop();
        store.close();
    });

    it('keeps a request pending after a transient download error and prepares it on retry', async () => {
        const store = new RadioStore(':memory:', policy);
        const receipt = store.addRequest({ guildId: 'g', userId: 'listener', userName: 'Listener', track: found, now: Date.now() }, true);
        expect(receipt.accepted).toBe(true);
        if (!receipt.accepted) throw new Error('request was not accepted');
        const materialize = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce('C:/cache/recovered.media');
        const radio = new RadioDirector(store, [{ name: 'ytmusic' } as MusicProvider],
            { materialize } as unknown as MediaCache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout);
        const notify = vi.fn(async () => undefined);
        radio.setRequestFailureNotifier(notify);
        const prepare = (radio as unknown as { prepareQueued: (limit: number) => Promise<number> }).prepareQueued.bind(radio);
        expect(await prepare(1)).toBe(1);
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(receipt.itemId)).toEqual({ state: 'queued' });
        expect(store.counts().pendingRequests).toBe(1);
        expect(notify).not.toHaveBeenCalled();
        store.db.prepare('UPDATE play_items SET retry_at=0 WHERE id=?').run(receipt.itemId);
        expect(await prepare(1)).toBe(1);
        expect(store.db.prepare('SELECT state,local_path FROM play_items WHERE id=?').get(receipt.itemId))
            .toEqual({ state: 'ready', local_path: 'C:/cache/recovered.media' });
        expect(store.preparationAttempts(receipt.itemId)).toBe(2);
        expect(store.counts().pendingRequests).toBe(1);
        await radio.stop();
        store.close();
    });

    it('prepares a second song while the first provider download is stalled', async () => {
        const store = new RadioStore(':memory:', policy);
        const first = store.enqueueEditorial(found);
        const second = store.enqueueEditorial({ ...found, id: 'bcdefghijkl', artist: 'Second Artist' });
        let finishFirst!: (path: string) => void;
        const stalled = new Promise<string>(resolve => { finishFirst = resolve; });
        const cache = { materialize: async (item: Track) => item.id === found.id
            ? await stalled : 'C:/cache/second.media' } as MediaCache;
        const radio = new RadioDirector(store, [{ name: 'ytmusic' } as MusicProvider], cache,
            { health: () => [], stopAll: () => undefined } as unknown as OutputFanout);
        const preparing = (radio as unknown as { prepareQueued: (limit: number) => Promise<number> }).prepareQueued(2);
        await vi.waitFor(() => expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(second))
            .toEqual({ state: 'ready' }));
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(first)).toEqual({ state: 'preparing' });
        finishFirst('C:/cache/first.media');
        expect(await preparing).toBe(2);
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(first)).toEqual({ state: 'ready' });
        await radio.stop();
        store.close();
    });

    it('starts a ready second song without waiting for a stalled first song at bootstrap', async () => {
        const store = new RadioStore(':memory:', policy);
        store.enqueueEditorial(found);
        store.enqueueEditorial({ ...found, id: 'bcdefghijkl', artist: 'Second Artist' });
        let finishFirst!: (path: string) => void;
        const stalled = new Promise<string>(resolve => { finishFirst = resolve; });
        const cache = { materialize: async (item: Track) => item.id === found.id
            ? await stalled : 'C:/cache/second.media' } as MediaCache;
        const play = vi.fn(async () => undefined);
        const radio = new RadioDirector(store, [{ name: 'ytmusic', search: async () => [] } as unknown as MusicProvider], cache,
            { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout);
        try {
            await Promise.race([radio.tick(), delay(500).then(() => { throw new Error('bootstrap waited for stalled first song'); })]);
            await vi.waitFor(() => expect(play).toHaveBeenCalledWith('C:/cache/second.media'));
        } finally {
            finishFirst('C:/cache/first.media');
            await radio.stop();
            store.close();
        }
    });

    it('drains shutdown while media preparation ignores cancellation', async () => {
        const store = new RadioStore(':memory:', policy);
        const id = store.enqueueEditorial(found);
        let began!: () => void;
        const started = new Promise<void>(resolve => { began = resolve; });
        let finish!: (path: string) => void;
        const download = new Promise<string>(resolve => { finish = resolve; });
        const cache = { materialize: async () => { began(); return await download; } } as MediaCache;
        const provider = { name: 'ytmusic' } as MusicProvider;
        const output = { health: () => [], stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [provider], cache, output);
        radio.start();
        await started;
        await Promise.race([radio.stop(), delay(200).then(() => { throw new Error('director shutdown stalled'); })]);
        store.close();
        finish('C:/cache/late.media');
        await delay(0);
        expect(id).toBeGreaterThan(0);
    });

    it('continues editorial refill after a stalled provider search', async () => {
        const store = new RadioStore(':memory:', policy);
        seedModelPlan(store);
        let searches = 0;
        const provider = { name: 'ytmusic', search: async () => ++searches === 1
            ? await new Promise<Track[]>(() => undefined)
            : [found] } as MusicProvider;
        const cache = { materialize: async () => 'C:/cache/refill.media' } as MediaCache;
        const play = vi.fn(async () => undefined);
        const output = { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [provider], cache, output, undefined, [], undefined, 0, { planner: stalledPlanner });
        (radio as unknown as { searchTimeoutMs: number }).searchTimeoutMs = 20;

        await radio.tick();
        for (let attempt = 0; attempt < 100 && !store.peekNextForPlayback(); attempt++) await delay(5);
        await Promise.race([radio.tick(), delay(500).then(() => { throw new Error('editorial search stalled'); })]);
        expect(searches).toBeGreaterThanOrEqual(2);
        expect(play).toHaveBeenCalledWith('C:/cache/refill.media');
        await radio.stop();
        store.close();
    });

    it('aborts a stalled catalog search promptly during shutdown without touching a closed store', async () => {
        const store = new RadioStore(':memory:', policy);
        seedModelPlan(store);
        let searchStarted!: () => void;
        const began = new Promise<void>(resolve => { searchStarted = resolve; });
        const provider = { name: 'ytmusic', search: async () => {
            searchStarted();
            return await new Promise<Track[]>(() => undefined);
        } } as MusicProvider;
        const output = { health: () => [], stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [provider], {} as MediaCache, output, undefined, [], undefined, 0, { planner: stalledPlanner });
        radio.start();
        await began;
        await Promise.race([radio.stop(), delay(500).then(() => { throw new Error('director shutdown stalled'); })]);
        expect(store.counts().queued).toBe(0);
        store.close();
    });

    it('prepares an arriving request while the empty station is still searching its catalog', async () => {
        const store = new RadioStore(':memory:', policy);
        seedModelPlan(store);
        let searchStarted!: () => void;
        const began = new Promise<void>(resolve => { searchStarted = resolve; });
        const provider = { name: 'ytmusic', search: async () => {
            searchStarted();
            return await new Promise<Track[]>(() => undefined);
        } } as MusicProvider;
        const cache = { materialize: async () => 'C:/cache/request.media' } as MediaCache;
        const play = vi.fn(async () => undefined);
        const output = { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [provider], cache, output, undefined, [], undefined, 0, { planner: stalledPlanner });
        radio.start();
        await began;
        const receipt = await radio.submitTrackRequest({ guildId: 'g', userId: 'owner', userName: 'Owner',
            isOwner: true, track: found, now: Date.now() });
        expect(receipt.kind).toBe('accepted');
        await Promise.race([vi.waitFor(() => expect(play).toHaveBeenCalledWith('C:/cache/request.media')),
            delay(500).then(() => { throw new Error('request waited for catalog refill'); })]);
        await radio.stop();
        store.close();
    });

    it('bounds urgent downloads and stops promptly when downloads ignore cancellation', async () => {
        const store = new RadioStore(':memory:', policy);
        seedModelPlan(store);
        let searchStarted!: () => void;
        const began = new Promise<void>(resolve => { searchStarted = resolve; });
        const provider = { name: 'ytmusic', search: async () => {
            searchStarted();
            return await new Promise<Track[]>(() => undefined);
        } } as MusicProvider;
        const materialize = vi.fn(async () => await new Promise<string>(() => undefined));
        const output = { health: () => [], stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [provider], { materialize } as unknown as MediaCache, output,
            undefined, [], undefined, 0, { planner: stalledPlanner });
        radio.start();
        await began;
        for (let index = 0; index < 3; index++) {
            const receipt = await radio.submitTrackRequest({ guildId: 'g', userId: 'owner', userName: 'Owner',
                isOwner: true, track: { ...found, id: `abcdefghij${index}`, title: `Track ${index}` }, now: Date.now() + index });
            expect(receipt.kind).toBe('accepted');
        }
        await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(2));
        await Promise.race([radio.stop(), delay(500).then(() => { throw new Error('urgent downloads stalled shutdown'); })]);
        expect(store.db.prepare("SELECT COUNT(*) AS count FROM play_items WHERE state='ready'").get()).toEqual({ count: 0 });
        store.close();
    });

    it('does not start playback or leave a claimed row playing when shutdown wins the claim boundary', async () => {
        const store = new RadioStore(':memory:', policy);
        const id = store.enqueueEditorial(found);
        const item = store.claimPreparation()!;
        store.markReady(item.id, 'C:/cache/ready.media');
        const play = vi.fn(async () => undefined);
        const output = { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [], {} as MediaCache, output);
        const original = store.nextForPlayback.bind(store);
        let stopping!: Promise<void>;
        const claim = vi.spyOn(store, 'nextForPlayback').mockImplementation(() => {
            const selected = original();
            stopping = radio.stop();
            return selected;
        });
        await radio.tick();
        await stopping;
        expect(play).not.toHaveBeenCalled();
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(id)).toMatchObject({ state: 'ready' });
        claim.mockRestore();
        store.close();
    });

    it('does not start a prefetched jingle after shutdown during the final studio lookup', async () => {
        const store = new RadioStore(':memory:', policy);
        const id = store.enqueueEditorial(found);
        const item = store.claimPreparation()!;
        store.markReady(item.id, 'C:/cache/ready.media');
        const play = vi.fn(async () => undefined);
        const output = { health: () => [{ guildId: 'g', connected: true }], play, stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [], {} as MediaCache, output);
        (radio as unknown as { tracksSinceStudio: number }).tracksSinceStudio = 1;
        (radio as unknown as { readyBreaks: Map<number, unknown> }).readyBreaks.set(item.id, { path: 'C:/cache/jingle.audio', kind: 'jingle' });
        let stopping!: Promise<void>;
        const lookup = vi.spyOn(store, 'peekStudioMessage').mockImplementation(() => {
            stopping = radio.stop();
            return undefined;
        });
        await radio.tick();
        await stopping;
        expect(play).not.toHaveBeenCalled();
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(id)).toMatchObject({ state: 'ready' });
        lookup.mockRestore();
        store.close();
    });

    it('discards an unaired prepared host segment during graceful shutdown', async () => {
        const store = new RadioStore(':memory:', policy);
        const itemId = store.enqueueEditorial(found);
        const segmentId = store.recordHostSegment(itemId, 'Эфир продолжается.', 'C:/cache/host.audio')!;
        const output = { stopAll: () => undefined } as unknown as OutputFanout;
        const radio = new RadioDirector(store, [], {} as MediaCache, output);
        (radio as unknown as { readyBreaks: Map<number, unknown> }).readyBreaks.set(itemId,
            { path: 'C:/cache/host.audio', kind: 'station', segmentId });
        await radio.stop();
        expect(store.db.prepare('SELECT status FROM host_segments WHERE id=?').get(segmentId)).toEqual({ status: 'failed' });
        store.close();
    });

    it('rejects arbitrary URLs before calling providers', async () => {
        const searches: string[] = [];
        const fixture = director(searches);
        await expect(
            fixture.director.submitRequest({ guildId: 'g', userId: 'u', userName: 'User', query: 'https://example.com/audio' }),
        ).resolves.toMatchObject({ kind: 'rejected' });
        expect(searches).toEqual([]);
        fixture.store.close();
    });

    it('rewrites a descriptive request but selects only a provider result', async () => {
        const searches: string[] = [];
        const interpreter: MusicQueryInterpreter = { rewriteMusicQuery: async () => 'dark electronic instrumental' };
        const fixture = director(searches, interpreter);
        const result = await fixture.director.submitRequest({
            guildId: 'g',
            userId: 'u',
            userName: 'User',
            query: 'хочу послушать что-нибудь мрачное электронное без вокала',
            now: 1_000,
        });
        expect(searches).toEqual(['dark electronic instrumental']);
        expect(result).toMatchObject({ kind: 'accepted', track: found });
        fixture.store.close();
    });

    it('allows only one concurrent queue tick to start playback', async () => {
        const store = new RadioStore(':memory:', policy);
        store.enqueueEditorial(found, 1_000);
        store.enqueueEditorial({ ...found, id: 'bcdefghijkl' }, 1_001);
        let release = (): void => undefined;
        const playback = new Promise<void>(resolve => {
            release = resolve;
        });
        let plays = 0;
        const output: OutputFanout = {
            connectGuild: async () => undefined,
            play: async () => {
                plays++;
                await playback;
            },
            pause: () => false,
            resume: () => false,
            skip: () => false,
            stopGuild: () => undefined,
            stopAll: () => undefined,
            health: () => [{ guildId: 'g', connected: true }],
        };
        const cache = { materialize: async (item: Track) => `C:/cache/${item.id}.media` } as MediaCache;
        const provider: MusicProvider = {
            name: 'ytmusic',
            search: async () => [],
            resolve: async () => undefined,
            fetch: async () => {
                throw new Error('not used');
            },
            health: async () => ({ ok: true, detail: 'test' }),
        };
        const radio = new RadioDirector(store, [provider], cache, output);
        await Promise.all([radio.tick(), radio.tick()]);
        expect(store.current()?.track?.id).toBe('abcdefghijk');
        await delay(10);
        expect(plays).toBe(1);
        release();
        await delay(0);
        store.close();
    });

    it('starts a ready track before a slow catalogue refill completes', async () => {
        const store = new RadioStore(':memory:', policy);
        store.enqueueEditorial(found);
        const queued = store.claimPreparation()!;
        store.markReady(queued.id, 'C:/cache/ready.media');
        let releaseSearch = (): void => undefined;
        const search = new Promise<Track[]>(resolve => {
            releaseSearch = () => resolve([]);
        });
        let releasePlayback = (): void => undefined;
        const playback = new Promise<void>(resolve => {
            releasePlayback = resolve;
        });
        let plays = 0;
        const provider: MusicProvider = {
            name: 'ytmusic',
            search: async () => await search,
            resolve: async () => undefined,
            fetch: async () => {
                throw new Error('not used');
            },
            health: async () => ({ ok: true, detail: 'test' }),
        };
        const output: OutputFanout = {
            connectGuild: async () => undefined,
            play: async () => {
                plays++;
                await playback;
            },
            pause: () => false,
            resume: () => false,
            skip: () => false,
            stopGuild: () => undefined,
            stopAll: () => undefined,
            health: () => [{ guildId: 'g', connected: true }],
        };
        const radio = new RadioDirector(store, [provider], {} as MediaCache, output, undefined, ['station']);
        await radio.tick();
        expect(plays).toBe(1);
        releaseSearch();
        releasePlayback();
        await delay(10);
        store.close();
    });

    it.each([false, true])('prepares a model-free jingle unless a studio letter arrives late (late letter: %s)', async lateStudio => {
        const store = new RadioStore(':memory:', policy);
        const paths = ['abcdefghijk', 'bcdefghijkl', 'cdefghijklm', 'defghijklmn'];
        for (const id of paths) {
            store.enqueueEditorial({ ...found, id, artist: `Artist ${id}` });
            const item = store.claimPreparation()!;
            store.markReady(item.id, `C:/cache/${id}.media`);
        }
        store.jingleDue(1_000, Date.now() - 2_000);
        const played: string[] = [];
        const releases = new Map<string, () => void>();
        const output: OutputFanout = {
            connectGuild: async () => undefined,
            play: async path => {
                played.push(path);
                await new Promise<void>(resolve => releases.set(path, resolve));
            },
            pause: () => false,
            resume: () => false,
            skip: () => false,
            stopGuild: () => undefined,
            stopAll: () => undefined,
            health: () => [{ guildId: 'g', connected: true }],
        };
        const contexts: Array<Omit<BreakContext, 'recentLines'>> = [];
        const presenter = {
            prepare: async (context: Omit<BreakContext, 'recentLines'>) => {
                contexts.push(context);
                return { path: `C:/cache/${context.kind}.audio`, script: `Test ${context.kind}` };
            },
        } as HostPresenter;
        const radio = new RadioDirector(store, [], {} as MediaCache, output, presenter, [], undefined, 1_000);
        const waitFor = async (condition: () => boolean): Promise<void> => {
            for (let attempt = 0; attempt < 20; attempt++) {
                if (condition()) return;
                await delay(5);
            }
            throw new Error('Expected audio transition did not occur');
        };

        await radio.tick();
        await waitFor(() => releases.has(`C:/cache/${paths[0]}.media`));
        releases.get(`C:/cache/${paths[0]}.media`)!();
        await waitFor(() => !store.current());
        await radio.tick();
        await waitFor(() => contexts.length === 1);
        expect(contexts[0]?.kind).toBe('jingle');
        if (lateStudio) {
            expect(store.addStudioMessage({ guildId: 'g', userId: 'u', userName: 'User', message: 'Поздравьте Машу', now: Date.now() })).toMatchObject({ accepted: true });
        }
        await waitFor(() => releases.has('C:/cache/jingle.audio'));
        releases.get('C:/cache/jingle.audio')!();
        await waitFor(() => releases.has(`C:/cache/${paths[1]}.media`));
        releases.get(`C:/cache/${paths[1]}.media`)!();
        await waitFor(() => !store.current());
        await radio.tick();
        await waitFor(() => releases.has(lateStudio ? 'C:/cache/studio.audio' : 'C:/cache/station.audio'));
        releases.get(lateStudio ? 'C:/cache/studio.audio' : 'C:/cache/station.audio')!();
        await waitFor(() => releases.has(`C:/cache/${paths[2]}.media`));
        if (lateStudio) {
            await waitFor(() => contexts.length >= 2);
            expect(contexts[1]?.kind).toBe('studio');
        }
        releases.get(`C:/cache/${paths[2]}.media`)!();
        await waitFor(() => !store.current());

        expect(played).toEqual([
            `C:/cache/${paths[0]}.media`,
            'C:/cache/jingle.audio',
            `C:/cache/${paths[1]}.media`,
            lateStudio ? 'C:/cache/studio.audio' : 'C:/cache/station.audio',
            `C:/cache/${paths[2]}.media`,
        ]);
        expect(store.jingleDue(1_000)).toBe(false);
        const hostRows = store.db.prepare('SELECT script,status FROM host_segments').all() as Array<{ script: string; status: string }>;
        expect(hostRows.find(row => row.script === 'Test jingle')?.status).toBe('played');
        if (lateStudio) expect(hostRows.find(row => row.script === 'Test studio')?.status).toBe('played');
        if (lateStudio) expect(store.peekStudioMessage()).toBeUndefined();
        store.close();
    });

    it('places a short ordinary host link before each following record', async () => {
        const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const store = new RadioStore(':memory:', policy);
        const ids = ['abcdefghijk', 'bcdefghijkl', 'cdefghijklm', 'defghijklmn'];
        for (const id of ids) {
            store.enqueueEditorial({ ...found, id, artist: `Artist ${id}` });
            const item = store.claimPreparation()!;
            store.markReady(item.id, `C:/cache/${id}.media`);
        }
        const releases = new Map<string, () => void>();
        const played: string[] = [];
        const output: OutputFanout = {
            connectGuild: async () => undefined,
            play: async path => {
                played.push(path);
                await new Promise<void>(resolve => releases.set(path, resolve));
            },
            pause: () => false,
            resume: () => false,
            skip: () => false,
            stopGuild: () => undefined,
            stopAll: () => undefined,
            health: () => [{ guildId: 'g', connected: true }],
        };
        const contexts: Array<Omit<BreakContext, 'recentLines'>> = [];
        const presenter = {
            prepare: async (context: Omit<BreakContext, 'recentLines'>) => {
                contexts.push(context);
                return { path: 'C:/cache/station.audio', script: 'Test station break' };
            },
        } as HostPresenter;
        const radio = new RadioDirector(store, [], {} as MediaCache, output, presenter);
        const waitFor = async (condition: () => boolean, label = 'audio transition'): Promise<void> => {
            for (let attempt = 0; attempt < 30; attempt++) {
                if (condition()) return;
                await delay(5);
            }
            throw new Error(`Expected ${label}; played: ${played.join(', ')}`);
        };
        for (const id of ids.slice(0, 2)) {
            await radio.tick();
            if (id !== ids[0]) {
                await waitFor(() => releases.has('C:/cache/station.audio'), 'station break');
                releases.get('C:/cache/station.audio')!();
                releases.delete('C:/cache/station.audio');
            }
            await waitFor(() => releases.has(`C:/cache/${id}.media`), id);
            releases.get(`C:/cache/${id}.media`)!();
            await waitFor(() => !store.current() && !(radio as unknown as { playing: boolean }).playing);
        }
        await waitFor(() => contexts.length === 2);
        expect(contexts[0]?.kind).toBe('station');
        expect(contexts[0]?.precedingTrack?.id).toBe(ids[0]);
        expect(contexts[0]?.nextTrack?.id).toBe(ids[1]);
        expect(contexts[1]?.precedingTrack?.id).toBe(ids[1]);
        expect(contexts[1]?.nextTrack?.id).toBe(ids[2]);
        await radio.tick();
        await waitFor(() => releases.has('C:/cache/station.audio'));
        releases.get('C:/cache/station.audio')!();
        releases.delete('C:/cache/station.audio');
        await waitFor(() => releases.has(`C:/cache/${ids[2]}.media`));
        releases.get(`C:/cache/${ids[2]}.media`)!();
        await waitFor(() => !store.current() && !(radio as unknown as { playing: boolean }).playing);
        expect(played).toEqual([`C:/cache/${ids[0]}.media`, 'C:/cache/station.audio',
            `C:/cache/${ids[1]}.media`, 'C:/cache/station.audio', `C:/cache/${ids[2]}.media`]);
        expect(store.db.prepare('SELECT play_item_id,script,status FROM host_segments').all()).toEqual([
            { play_item_id: 2, script: 'Test station break', status: 'played' },
            { play_item_id: 3, script: 'Test station break', status: 'played' },
            { play_item_id: 4, script: 'Test station break', status: 'ready' },
        ]);
        const events = logs.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; itemId: number; kind?: string; ok?: boolean });
        expect(events).toContainEqual({ level: 'info', event: 'radio.break.completed', itemId: 3, kind: 'station', ok: true });
        expect(logs.mock.calls.flat().join('')).not.toContain('C:/cache/');
        store.close();
    });

    it('starts the next track after a delayed download without waiting for a host link', async () => {
        const store = new RadioStore(':memory:', policy);
        const ids = ['abcdefghijk', 'bcdefghijkl', 'cdefghijklm', 'defghijklmn'];
        for (const id of ids) {
            store.enqueueEditorial({ ...found, id, artist: `Artist ${id}` });
            if (id !== ids[3]) {
                const item = store.claimPreparation()!;
                store.markReady(item.id, `C:/cache/${id}.media`);
            }
        }
        let releaseDownload!: (path: string) => void;
        const download = new Promise<string>(resolve => { releaseDownload = resolve; });
        const cache = { materialize: async () => download } as MediaCache;
        const releases = new Map<string, () => void>();
        const played: string[] = [];
        const output: OutputFanout = {
            connectGuild: async () => undefined,
            play: async path => {
                played.push(path);
                await new Promise<void>(resolve => releases.set(path, resolve));
            },
            pause: () => false,
            resume: () => false,
            skip: () => false,
            stopGuild: () => undefined,
            stopAll: () => undefined,
            health: () => [{ guildId: 'g', connected: true }],
        };
        const prepared: string[] = [];
        const presenter = { prepare: async (context: Omit<BreakContext, 'recentLines'>) => {
            prepared.push(context.kind);
            return await new Promise<never>(() => undefined);
        } } as HostPresenter;
        const provider = { name: 'ytmusic' } as MusicProvider;
        const radio = new RadioDirector(store, [provider], cache, output, presenter);
        const waitFor = async (condition: () => boolean): Promise<void> => {
            for (let attempt = 0; attempt < 40; attempt++) {
                if (condition()) return;
                await delay(5);
            }
            throw new Error(`Expected audio transition; played: ${played.join(', ')}`);
        };
        for (const id of ids.slice(0, 3)) {
            await radio.tick();
            await waitFor(() => releases.has(`C:/cache/${id}.media`));
            if (id === ids[2]) expect(prepared).toEqual(['station', 'station']);
            releases.get(`C:/cache/${id}.media`)!();
            await waitFor(() => !store.current() && !(radio as unknown as { playing: boolean }).playing);
        }
        const boundary = radio.tick();
        await delay(10);
        expect(prepared).toEqual(['station', 'station']);
        releaseDownload(`C:/cache/${ids[3]}.media`);
        await boundary;
        await waitFor(() => store.peekNextForPlayback()?.track?.id === ids[3] || store.current()?.track?.id === ids[3]);
        await radio.tick();
        await waitFor(() => releases.has(`C:/cache/${ids[3]}.media`));
        releases.get(`C:/cache/${ids[3]}.media`)!();
        await waitFor(() => !store.current() && !(radio as unknown as { playing: boolean }).playing);
        expect(played).toEqual(ids.map(id => `C:/cache/${id}.media`));
        await radio.stop();
        store.close();
    });

    it('refreshes a request introduction if another listener joins the merged request before airtime', async () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        const first = store.addRequest({ guildId: 'a', userId: 'u1', userName: 'One', track: found, now });
        expect(first.accepted).toBe(true);
        const item = store.claimPreparation()!;
        store.markReady(item.id, 'C:/cache/request.media');
        store.addRequest({ guildId: 'b', userId: 'u2', userName: 'Two', track: found, now: now + 1 });
        const played: string[] = [];
        const output: OutputFanout = {
            connectGuild: async () => undefined,
            play: async path => { played.push(path); },
            pause: () => false,
            resume: () => false,
            skip: () => false,
            stopGuild: () => undefined,
            stopAll: () => undefined,
            health: () => [{ guildId: 'a', connected: true }],
        };
        const contexts: Array<Omit<BreakContext, 'recentLines'>> = [];
        let finishNarration!: (segment: { path: string; script: string }) => void;
        const narration = new Promise<{ path: string; script: string }>(resolve => { finishNarration = resolve; });
        const presenter = { prepare: async (context: Omit<BreakContext, 'recentLines'>) => {
            contexts.push(context);
            return await narration;
        } } as HostPresenter;
        const radio = new RadioDirector(store, [], {} as MediaCache, output, presenter);
        (radio as unknown as { readyBreaks: Map<number, unknown> }).readyBreaks.set(item.id,
            { path: 'C:/cache/stale-request.audio', kind: 'request', requestSignature: JSON.stringify({ userName: 'One' }) });
        await radio.tick();
        finishNarration({ path: 'C:/cache/fresh-request.audio', script: 'Test request break' });
        await delay(0);
        expect(contexts[0]).toMatchObject({ requesterName: 'One и Two' });
        expect(played).toEqual(['C:/cache/request.media']);
        expect(store.db.prepare('SELECT status FROM host_segments').all()).toEqual([]);
        await radio.stop();
        store.close();
    });

    it('quarantines and refetches a cached track once after a media failure', async () => {
        const store = new RadioStore(':memory:', policy);
        store.enqueueEditorial(found, 1_000);
        let downloads = 0;
        let invalidations = 0;
        const cache = {
            materialize: async () => `C:/cache/download-${++downloads}.media`,
            invalidate: async () => {
                invalidations++;
            },
        } as unknown as MediaCache;
        let plays = 0;
        const output: OutputFanout = {
            connectGuild: async () => undefined,
            play: async () => {
                if (++plays === 1) throw new Error('FFmpeg could not decode cached media');
            },
            pause: () => false,
            resume: () => false,
            skip: () => false,
            stopGuild: () => undefined,
            stopAll: () => undefined,
            health: () => [{ guildId: 'g', connected: true }],
        };
        const provider: MusicProvider = {
            name: 'ytmusic',
            search: async () => [],
            resolve: async () => undefined,
            fetch: async () => {
                throw new Error('not used');
            },
            health: async () => ({ ok: true, detail: 'test' }),
        };
        const radio = new RadioDirector(store, [provider], cache, output);
        await radio.tick();
        for (let attempt = 0; attempt < 20 && store.current(); attempt++) await delay(5);

        expect({ downloads, invalidations, plays }).toEqual({ downloads: 2, invalidations: 1, plays: 2 });
        expect(store.db.prepare("SELECT state FROM play_items WHERE id=1").get()).toMatchObject({ state: 'played' });
        store.close();
    });

    it('keeps one programme advancing without subscribers and lets a guild join mid-track', async () => {
        const store = new RadioStore(':memory:', policy);
        store.addRequest({ guildId: 'g', userId: 'u', userName: 'User', track: found, now: Date.now() });
        let connected = false;
        let finishPlayback!: () => void;
        const playback = new Promise<void>(resolve => { finishPlayback = resolve; });
        let plays = 0;
        const output: OutputFanout = {
            connectGuild: async () => { connected = true; },
            play: async () => { plays++; await playback; },
            pause: () => false,
            resume: () => false,
            skip: () => false,
            stopGuild: () => { connected = false; },
            stopAll: () => undefined,
            health: () => connected ? [{ guildId: 'g', connected: true }] : [],
        };
        const cache = { materialize: async () => 'C:/cache/request.media' } as MediaCache;
        const provider: MusicProvider = {
            name: 'ytmusic',
            search: async () => [],
            resolve: async () => undefined,
            fetch: async () => {
                throw new Error('not used');
            },
            health: async () => ({ ok: true, detail: 'test' }),
        };
        const radio = new RadioDirector(store, [provider], cache, output);
        await radio.tick();
        await vi.waitFor(() => expect(plays).toBe(1));
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=1').get()).toMatchObject({ state: 'playing' });
        await output.connectGuild('g', 'voice', {});
        expect(plays).toBe(1);
        output.stopGuild('g');
        finishPlayback();
        await vi.waitFor(() => expect(store.db.prepare('SELECT state FROM play_items WHERE id=1').get())
            .toMatchObject({ state: 'played' }));
        expect(store.counts().pendingRequests).toBe(0);
        store.close();
    });
});
