import { setTimeout as delay } from 'node:timers/promises';

import type { HostInputDecisionPlanner, HostShiftPlanner, HostShiftProposal, MusicProvider, MusicQueryInterpreter, OutputFanout, QueueItem, RadioStatus, RequestInput, ShowPlan, ShowPlanner, StudioInput, Track } from './contracts.js';
import { HOST_PROFILES } from './host-profiles.js';
import { balanceHostShift, fallbackHostShift, validateHostShiftProposal } from './host-scheduler.js';
import { retryableDownloadError, type MediaCache } from './media-cache.js';
import type { HostPresenter } from './host.js';
import { moderateStudioMessage, safeOnAirName } from './moderation.js';
import { providerFor } from './providers.js';
import { fallbackShowPlan } from './showrunner.js';
import type { RadioStore, RequestDecision, StudioDecision } from './storage.js';
import { matchesMusicQuery, metadataKey, songKey } from './track-identity.js';

function logPlayout(event: string, itemId: number, details: Record<string, string | number | boolean> = {}): void {
    console.log(JSON.stringify({ level: 'info', event, itemId, ...details }));
}

export type RequestSubmission =
    | { kind: 'accepted'; decision: Extract<RequestDecision, { accepted: true }>; track: Track }
    | { kind: 'choices'; tracks: Track[] }
    | { kind: 'rejected'; reason: string };

interface PreparedBreak {
    path: string;
    kind: 'station' | 'request' | 'studio' | 'jingle' | 'intro';
    hostId?: keyof typeof HOST_PROFILES;
    studioId?: number;
    requestSignature?: string;
    segmentId?: number;
    hostShiftId?: number;
    planRevision?: number;
}

class Mailbox {
    private tail: Promise<void> = Promise.resolve();

    async run<T>(task: () => T | Promise<T>): Promise<T> {
        const previous = this.tail;
        let release: () => void = () => undefined;
        this.tail = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await task();
        } finally {
            release();
        }
    }
}

export class RadioDirector {
    private readonly mailbox = new Mailbox();
    private readonly workAbort = new AbortController();
    private running = false;
    private playing = false;
    private currentItemId?: number;
    private currentPlaybackStartedAt?: number;
    private currentPlaybackDurationMs?: number;
    private skipRequestedItemId?: number;
    private ticking = false;
    private mode: RadioStatus['mode'] = 'starting';
    private lastError?: string;
    private rotationCursor = 0;
    private tracksSinceStudio = 0;
    private autofillFailures = 0;
    private autofillRetryAt = 0;
    // The provider can spend up to 30 seconds resolving a music URL and up to
    // 90 seconds downloading it. The outer deadline must cover both stages.
    private readonly preparationTimeoutMs = 120_000;
    private readonly searchTimeoutMs = 15_000;
    private readonly readyBreaks = new Map<number, PreparedBreak>();
    private readonly breaksInFlight = new Set<number>();
    private airingStudioId?: number;
    private readonly backgroundJobs = new Set<Promise<void>>();
    private readonly urgentPreparations = new Set<Promise<void>>();
    private readonly activeTicks = new Set<Promise<void>>();
    private preparation?: Promise<void>;
    private loopTask?: Promise<void>;
    private playbackTask?: Promise<void>;
    private showPlanning?: Promise<void>;
    private hostDecisions?: Promise<void>;
    private hostNotifications?: Promise<void>;
    private hostShiftPlanning?: Promise<void>;
    private pendingHostShift?: { expectedId: number; proposal: HostShiftProposal; source: 'organizer' | 'fallback' };
    private nextHostShiftAttemptAt = 0;
    private showPlanRetryAt = 0;
    private lastShowPlanAttemptAt = 0;
    private nextShowPlanPollAt = 0;
    private editorialDepthHighWater?: number;
    private replanVersion = 0;
    private appliedReplanVersion = 0;
    private requestFailureNotifier?: (recipient: { userId: string; guildId: string }, message: string) => Promise<void>;
    private hostNotificationSender?: (recipient: { userId: string; guildId: string }, message: string) => Promise<void>;

    constructor(
        private readonly store: RadioStore,
        private readonly providers: readonly MusicProvider[],
        private readonly cache: MediaCache,
        private readonly output: OutputFanout,
        private readonly presenter?: HostPresenter,
        private readonly rotationQueries: readonly string[] = [],
        private readonly queryInterpreter?: MusicQueryInterpreter,
        private readonly jingleEveryMs = 0,
        private readonly runtimeOptions?: { planner?: ShowPlanner; inputDecisionPlanner?: HostInputDecisionPlanner;
            shiftPlanner?: HostShiftPlanner; isPrivileged?: (userId: string) => boolean },
    ) {}

    setRequestFailureNotifier(notifier: (recipient: { userId: string; guildId: string }, message: string) => Promise<void>): void {
        this.requestFailureNotifier = notifier;
    }

    setHostNotificationSender(sender: (recipient: { userId: string; guildId: string }, message: string) => Promise<void>): void {
        this.hostNotificationSender = sender;
    }

    async submitRequest(input: Omit<RequestInput, 'track' | 'now'> & { query: string; now?: number }): Promise<RequestSubmission> {
        this.workAbort.signal.throwIfAborted();
        if (/\b(?:https?|ftp):\/\/|www\./iu.test(input.query)) {
            return { kind: 'rejected', reason: 'Прямые ссылки не принимаются. Укажите исполнителя, название или опишите музыку.' };
        }
        if (input.dedication) {
            const moderated = moderateStudioMessage(input.dedication);
            if (!moderated.ok) return { kind: 'rejected', reason: moderated.reason };
            input = { ...input, dedication: moderated.text };
        }
        let searchQuery = input.query;
        const descriptive = /что-нибудь|хочу послушать|похож(?:ее|ую)|настроени|мрачн|вес[её]л|спокойн/iu.test(searchQuery) || searchQuery.trim().split(/\s+/u).length >= 7;
        if (descriptive && this.queryInterpreter) {
            searchQuery = await this.queryInterpreter.rewriteMusicQuery(searchQuery, this.workAbort.signal).catch(() => searchQuery);
        }
        const searches = await this.abortable(Promise.allSettled(this.providers.map(provider =>
            this.withDeadline(signal => provider.search(searchQuery, 5, signal), this.searchTimeoutMs, `${provider.name} search timed out`))));
        this.workAbort.signal.throwIfAborted();
        const tracks = searches
            .flatMap(result => (result.status === 'fulfilled' ? result.value : []))
            .filter((track, index, all) => all.findIndex(candidate => candidate.provider === track.provider && candidate.id === track.id) === index)
            .slice(0, 5);
        if (tracks.length === 0) return { kind: 'rejected', reason: 'Музыкальных треков по этому запросу не найдено.' };
        const query = input.query.trim().toLocaleLowerCase('ru');
        const exact = tracks.find(track => track.title.toLocaleLowerCase('ru') === query || `${track.artist} ${track.title}`.toLocaleLowerCase('ru') === query);
        if (!exact && tracks.length > 1) return { kind: 'choices', tracks };
        return await this.submitTrackRequest({ ...input, track: exact ?? tracks[0]!, now: input.now ?? Date.now() });
    }

    async submitTrackRequest(input: RequestInput): Promise<RequestSubmission> {
        this.workAbort.signal.throwIfAborted();
        if (input.dedication) {
            const moderated = moderateStudioMessage(input.dedication);
            if (!moderated.ok) return { kind: 'rejected', reason: moderated.reason };
            input = { ...input, dedication: moderated.text };
        }
        const decision = await this.mailbox.run(() => {
            this.workAbort.signal.throwIfAborted();
            const isOwner = this.runtimeOptions?.isPrivileged?.(input.userId) ?? input.isOwner;
            return this.store.addRequest({ ...input, isOwner, userName: safeOnAirName(input.userName) }, Boolean(this.runtimeOptions?.inputDecisionPlanner && !isOwner));
        });
        if (decision.accepted && !decision.duplicateSubmission) {
            this.startHostDecisions();
            this.requestShowReplan();
            this.kickUrgentPreparation();
        }
        return decision.accepted ? { kind: 'accepted', decision, track: input.track } : { kind: 'rejected', reason: decision.reason };
    }

    async submitStudio(input: Omit<StudioInput, 'now'> & { now?: number }): Promise<StudioDecision> {
        this.workAbort.signal.throwIfAborted();
        const moderated = moderateStudioMessage(input.message);
        if (!moderated.ok) return { accepted: false, reason: moderated.reason };
        const decision = await this.mailbox.run(() => {
            this.workAbort.signal.throwIfAborted();
            const isOwner = this.runtimeOptions?.isPrivileged?.(input.userId) ?? input.isOwner;
            return this.store.addStudioMessage({ ...input, isOwner, userName: safeOnAirName(input.userName), message: moderated.text, now: input.now ?? Date.now() },
                Boolean(this.runtimeOptions?.inputDecisionPlanner && !isOwner));
        });
        if (decision.accepted && !decision.duplicateSubmission) this.startHostDecisions();
        if (decision.accepted && !decision.duplicateSubmission) this.requestShowReplan();
        return decision;
    }

    async enqueueEditorial(track: Track): Promise<number> {
        return await this.mailbox.run(() => this.store.enqueueEditorial(track));
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.mode = 'starting';
        if (!this.store.currentHostShift()) {
            const now = Date.now();
            const bootstrap = fallbackHostShift([], undefined);
            // A short local bootstrap lets music start immediately while Luna
            // chooses the first full shift off the playout path. Ten minutes
            // gives the starter time to speak before the first handoff.
            this.store.startHostShift(bootstrap.hostId, now + 10 * 60_000, now, null);
        }
        this.store.jingleDue(this.jingleEveryMs);
        this.loopTask = this.loop();
        // Plan before the editorial horizon is exhausted; slow model work stays
        // outside the mailbox and never delays music startup.
        this.kickShowPlanning();
        this.kickHostShiftPlanning();
        this.startHostDecisions();
        this.startHostNotifications();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.workAbort.abort();
        this.output.stopAll();
        this.mode = 'stopped';
        // An in-flight tick may create playback after stop begins. Drain ticks first,
        // then read the latest playback/preparation tasks before SQLite is closed.
        await Promise.allSettled([this.loopTask, ...this.activeTicks].filter((task): task is Promise<void> => task !== undefined));
        await Promise.allSettled([this.preparation, this.playbackTask].filter((task): task is Promise<void> => task !== undefined));
        await Promise.allSettled([...this.backgroundJobs]);
        await this.mailbox.run(() => {
            for (const prepared of this.readyBreaks.values()) {
                if (prepared.segmentId !== undefined) this.store.discardHostSegment(prepared.segmentId);
            }
            this.readyBreaks.clear();
        });
    }

    pause(): boolean {
        const changed = this.output.pause();
        if (changed) this.mode = 'paused';
        return changed;
    }

    resume(): boolean {
        const changed = this.output.resume();
        if (changed) this.mode = this.playing ? 'playing' : 'starting';
        return changed;
    }

    async skip(force = false): Promise<'skipped' | 'preparing' | 'idle'> {
        if (!this.playing || this.currentItemId === undefined) return 'idle';
        if (!force && !(await this.mailbox.run(() => this.store.peekNextForPlayback()))) {
            void this.ensurePrepared().catch(error => {
                this.lastError = error instanceof Error ? error.message : 'media preparation failed';
            });
            return 'preparing';
        }
        if (!this.output.skip()) return 'idle';
        this.skipRequestedItemId = this.currentItemId;
        return 'skipped';
    }

    async rejectRequest(requestId: number): Promise<boolean> {
        return await this.mailbox.run(() => this.store.rejectRequest(requestId, 'Отклонено владельцем станции.'));
    }

    async rejectStudioMessage(messageId: number): Promise<boolean> {
        return await this.mailbox.run(() => this.airingStudioId === messageId
            ? false
            : this.store.rejectStudioMessage(messageId, 'Отклонено владельцем станции.'));
    }

    tick(): Promise<void> {
        if (this.isStopped()) return Promise.resolve();
        const operation = this.tickInternal();
        this.activeTicks.add(operation);
        void operation.then(
            () => this.activeTicks.delete(operation),
            () => this.activeTicks.delete(operation),
        );
        return operation;
    }

    private async tickInternal(): Promise<void> {
        if (this.playing || this.ticking || this.mode === 'paused') return;
        this.ticking = true;
        try {
            if (!(await this.mailbox.run(() => this.store.peekNextForPlayback()))) {
                const preparation = this.ensurePrepared().catch(error => {
                    this.lastError = error instanceof Error ? error.message : 'media preparation failed';
                });
                await this.waitForAnyReady(preparation);
            }
            if (this.isStopped()) return;
            if (!this.output.health().some(output => output.connected)) {
                this.mode = 'starting';
                return;
            }
            await this.rotateHostIfDue();
            const hostShift = await this.mailbox.run(() => this.store.currentHostShift());
            const upcoming = await this.mailbox.run(() => this.store.peekNextForPlayback());
            if (upcoming?.kind === 'request' && upcoming.track && this.presenter) {
                const prepared = this.readyBreaks.get(upcoming.id);
                const currentRequest = await this.mailbox.run(() => this.store.requestContext(upcoming.id));
                const introReady = prepared?.kind === 'intro' && prepared.hostId === hostShift?.hostId && !hostShift?.introducedAt;
                if (currentRequest && !introReady && (prepared?.kind !== 'request' || prepared.hostId !== hostShift?.hostId ||
                    prepared.requestSignature !== JSON.stringify(currentRequest))) {
                    this.readyBreaks.delete(upcoming.id);
                    if (prepared?.segmentId !== undefined) await this.mailbox.run(() => this.store.discardHostSegment(prepared.segmentId!));
                    const broadcast = await this.mailbox.run(() => ({ memory: this.store.showMemory(),
                        currentTheme: this.store.currentShowPlan()?.theme,
                        planRevision: this.store.currentShowPlan()?.revision,
                        recentPlayed: this.store.recentPlayed(8) }));
                    const refresh = this.abortable(this.presenter.prepare({ kind: 'request', hostId: hostShift?.hostId,
                        requesterName: currentRequest.userName,
                        ...(currentRequest.dedication ? { dedication: currentRequest.dedication } : {}), nextTrack: upcoming.track,
                        ...broadcast }, this.workAbort.signal));
                    const tracked = refresh.then(async rendered => {
                        if (!rendered) return;
                        await this.mailbox.run(() => {
                            if (this.isStopped() || this.store.peekNextForPlayback()?.id !== upcoming.id ||
                                this.store.currentHostShift()?.id !== hostShift?.id ||
                                this.store.currentShowPlan()?.revision !== broadcast.planRevision ||
                                JSON.stringify(this.store.requestContext(upcoming.id)) !== JSON.stringify(currentRequest)) return;
                            const segmentId = this.store.recordHostSegment(upcoming.id, rendered.script, rendered.path,
                                Date.now(), hostShift ? { hostId: hostShift.hostId, shiftId: hostShift.id } : undefined);
                            if (segmentId !== undefined) this.readyBreaks.set(upcoming.id,
                                { path: rendered.path, kind: 'request', segmentId, hostId: hostShift?.hostId,
                                    hostShiftId: hostShift?.id,
                                    planRevision: broadcast.planRevision,
                                    requestSignature: JSON.stringify(currentRequest) });
                        });
                    }).catch(() => undefined);
                    this.backgroundJobs.add(tracked);
                    void tracked.then(() => this.backgroundJobs.delete(tracked));
                }
            }
            const next = await this.mailbox.run(() => this.isStopped() ? undefined : this.store.nextForPlayback());
            if (this.isStopped()) {
                if (next) await this.mailbox.run(() => this.store.requeuePlaying(next.id, 'Station stopped before playback'));
                return;
            }
            if (!next?.localPath) {
                this.mode = 'degraded';
                return;
            }
            const candidateBreak = this.readyBreaks.get(next.id);
            const planRevision = await this.mailbox.run(() => this.store.currentShowPlan()?.revision);
            const preparedBreak = candidateBreak && candidateBreak.hostId === hostShift?.hostId &&
                (candidateBreak.kind === 'jingle' || candidateBreak.planRevision === planRevision)
                ? candidateBreak : undefined;
            if (candidateBreak && !preparedBreak && candidateBreak.segmentId !== undefined) {
                await this.mailbox.run(() => this.store.discardHostSegment(candidateBreak.segmentId!));
            }
            const staleSegmentIds = [...this.readyBreaks.entries()]
                .filter(([itemId]) => itemId !== next.id)
                .map(([, segment]) => segment.segmentId)
                .filter((id): id is number => id !== undefined);
            this.readyBreaks.clear();
            if (staleSegmentIds.length > 0) await this.mailbox.run(() => {
                for (const segmentId of staleSegmentIds) this.store.discardHostSegment(segmentId);
            });
            // A studio message may arrive after a jingle was rendered for this gap.
            // Keep the music boundary prompt; the letter can be voiced in a later gap.
            const studioPreemptsJingle =
                preparedBreak?.kind === 'jingle' &&
                this.tracksSinceStudio >= 1 &&
                Boolean(await this.mailbox.run(() => this.store.peekStudioMessage()));
            if (this.isStopped()) {
                await this.mailbox.run(() => this.store.requeuePlaying(next.id, 'Station stopped before playback'));
                if (preparedBreak?.segmentId !== undefined) await this.mailbox.run(() => this.store.discardHostSegment(preparedBreak.segmentId!));
                return;
            }
            if (studioPreemptsJingle && preparedBreak?.segmentId !== undefined) {
                await this.mailbox.run(() => this.store.discardHostSegment(preparedBreak.segmentId!));
            }
            this.playing = true;
            this.currentItemId = next.id;
            this.mode = 'playing';
            const operation = this.play(next, next.localPath, studioPreemptsJingle ? undefined : preparedBreak);
            this.playbackTask = operation;
            void operation.then(
                () => {
                    if (this.playbackTask === operation) this.playbackTask = undefined;
                },
                () => {
                    if (this.playbackTask === operation) this.playbackTask = undefined;
                },
            );
        } finally {
            this.ticking = false;
        }
    }

    async status(): Promise<RadioStatus> {
        return await this.mailbox.run(() => {
            const counts = this.store.counts();
            const showPlan = this.store.currentShowPlan();
            const shift = this.store.currentHostShift();
            return {
                mode: this.mode,
                ...(this.store.current() ? { current: this.store.current() } : {}),
                ...counts,
                outputs: this.output.health(),
                ...(showPlan ? { showPlan: { theme: showPlan.theme, source: showPlan.source } } : {}),
                ...(shift ? { host: { id: shift.hostId, plannedEndAt: shift.plannedEndAt } } : {}),
                ...(this.lastError ? { lastError: this.lastError } : {}),
            };
        });
    }

    private async play(item: QueueItem, localPath: string, preparedBreak?: PreparedBreak): Promise<void> {
        let completed = false;
        let segmentFinalized = false;
        try {
            if (preparedBreak) {
                const breakStartedAt = Date.now();
                const studioId = preparedBreak.kind === 'studio' ? preparedBreak.studioId : undefined;
                const eligible = await this.mailbox.run(() => {
                    if (preparedBreak.kind === 'request') return preparedBreak.requestSignature === JSON.stringify(this.store.requestContext(item.id));
                    if (studioId === undefined) return true;
                    if (!this.store.studioMessageCanAir(studioId)) return false;
                    this.airingStudioId = studioId;
                    return true;
                });
                let aired = false;
                if (eligible) {
                    logPlayout('radio.break.started', item.id, { kind: preparedBreak.kind });
                    aired = await this.output.play(preparedBreak.path, { kind: 'speech' }).then(() => true, () => false);
                    logPlayout('radio.break.completed', item.id, { kind: preparedBreak.kind, ok: aired });
                }
                if (this.skipRequestedItemId === item.id) {
                    logPlayout('radio.track.skipped', item.id);
                    await this.skipAndNotify(item.id);
                    return;
                }
                if (!this.output.health().some(output => output.connected)) {
                    const reason = 'All Discord voice outputs disconnected during playback';
                    await this.mailbox.run(() => this.store.requeuePlaying(item.id, reason));
                    this.lastError = reason;
                    if (this.running) this.mode = 'starting';
                    return;
                }
                if (aired) {
                    if (preparedBreak.segmentId !== undefined) {
                        segmentFinalized = await this.mailbox.run(() => this.store.markHostSegmentPlayed(preparedBreak.segmentId!,
                            Date.now(), this.store.currentHostShift()?.id));
                    }
                    if (segmentFinalized && preparedBreak.kind === 'intro') {
                        await this.mailbox.run(() => {
                            const current = this.store.currentHostShift();
                            if (current && current.hostId === preparedBreak.hostId) this.store.markHostIntroduced(current.id);
                        });
                    }
                    if (preparedBreak.kind === 'studio' && preparedBreak.studioId !== undefined) {
                        await this.mailbox.run(() => {
                            this.store.markStudioAired(preparedBreak.studioId!, breakStartedAt);
                            if (this.airingStudioId === studioId) this.airingStudioId = undefined;
                        });
                        this.tracksSinceStudio = 0;
                    }
                    if (preparedBreak.kind === 'jingle') await this.mailbox.run(() => this.store.markJingleAired());
                }
                if (studioId !== undefined && !aired) await this.mailbox.run(() => {
                    if (this.airingStudioId === studioId) this.airingStudioId = undefined;
                });
            }
            let currentPath = localPath;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const playbackStartedAt = Date.now();
                    this.currentPlaybackStartedAt = playbackStartedAt;
                    this.currentPlaybackDurationMs = item.track?.durationMs;
                    const playback = this.output.play(currentPath);
                    logPlayout('radio.track.started', item.id, { attempt: attempt + 1 });
                    const preparation = this.ensurePrepared().catch(error => {
                        this.lastError = error instanceof Error ? error.message : 'media preparation failed';
                    });
                    const studioTracksBeforeCurrent = this.tracksSinceStudio;
                    // A break can only target a prepared next item. Do not inspect the queue
                    // before the concurrent media job has made that item ready.
                    const hostJob = this.waitForSuccessor(item.id, preparation).then(() => {
                        if (this.currentItemId !== item.id) return;
                        const estimatedRemaining = Math.max(0, (item.track?.durationMs ?? 0) -
                            (Date.now() - playbackStartedAt) - 10_000);
                        return this.prepareUpcomingBreak(studioTracksBeforeCurrent, estimatedRemaining);
                    }).catch(error => {
                        this.lastError = error instanceof Error ? error.message : 'host preparation failed';
                    });
                    this.backgroundJobs.add(hostJob);
                    void hostJob.then(() => this.backgroundJobs.delete(hostJob));
                    await playback;
                    if (!this.output.health().some(output => output.connected)) {
                        const reason = 'All Discord voice outputs disconnected during playback';
                        await this.mailbox.run(() => this.store.requeuePlaying(item.id, reason));
                        this.lastError = reason;
                        if (this.running) this.mode = 'starting';
                        break;
                    }
                    await this.mailbox.run(() => this.store.finishItem(item.id));
                    logPlayout('radio.track.completed', item.id);
                    completed = true;
                    this.lastError = undefined;
                    break;
                } catch (error) {
                    const reason = error instanceof Error ? error.message : 'audio output failed';
                    if (reason === 'Playback skipped by owner') {
                        logPlayout('radio.track.skipped', item.id);
                        await this.skipAndNotify(item.id);
                        break;
                    }
                    logPlayout('radio.track.failed', item.id, { attempt: attempt + 1 });
                    if (this.isOutputUnavailable(reason)) {
                        await this.mailbox.run(() => this.store.requeuePlaying(item.id, reason));
                        this.lastError = reason;
                        if (this.running) this.mode = 'starting';
                        break;
                    }
                    if (attempt === 0 && item.track && this.isRetryableMediaFailure(reason)) {
                        const release = this.reserveTrack(item.track);
                        try {
                            await this.cache.invalidate(item.track);
                            const protectedPaths = await this.mailbox.run(() => this.store.protectedCachePaths());
                            currentPath = await this.withDeadline(
                                signal => this.cache.materialize(item.track!, providerFor(this.providers, item.track!.provider), signal, protectedPaths),
                                this.preparationTimeoutMs,
                                'Media refresh timed out',
                            );
                            await this.mailbox.run(() => this.store.updatePlayingPath(item.id, currentPath));
                            continue;
                        } catch (retryError) {
                            const retryReason = retryError instanceof Error ? retryError.message : 'media refresh failed';
                            await this.failAndNotify(item.id, retryReason);
                            this.lastError = retryReason;
                            break;
                        } finally {
                            release();
                        }
                    }
                    await this.failAndNotify(item.id, reason);
                    this.lastError = reason;
                    break;
                }
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'audio output failed';
            await this.failAndNotify(item.id, reason);
            this.lastError = reason;
        } finally {
            if (preparedBreak?.segmentId !== undefined && !segmentFinalized) {
                await this.mailbox.run(() => this.store.discardHostSegment(preparedBreak.segmentId!)).catch(error => {
                    this.lastError = error instanceof Error ? error.message : 'host segment persistence failed';
                });
            }
            if (preparedBreak?.studioId === this.airingStudioId) this.airingStudioId = undefined;
            if (completed) {
                this.tracksSinceStudio++;
            }
            if (this.skipRequestedItemId === item.id) this.skipRequestedItemId = undefined;
            if (this.currentItemId === item.id) this.currentItemId = undefined;
            this.currentPlaybackStartedAt = undefined;
            this.currentPlaybackDurationMs = undefined;
            this.playing = false;
            if (this.running) void this.tick();
        }
    }

    private async loop(): Promise<void> {
        while (this.running) {
            this.startHostDecisions();
            this.startHostNotifications();
            if (Date.now() >= this.nextShowPlanPollAt) {
                this.nextShowPlanPollAt = Date.now() + 30_000;
                this.kickShowPlanning();
                this.kickHostShiftPlanning();
            }
            await this.tick().catch(error => {
                this.lastError = error instanceof Error ? error.message : 'radio loop failed';
                this.mode = 'degraded';
            });
            try {
                await delay(2_000, undefined, { signal: this.workAbort.signal });
            } catch {
                return;
            }
        }
    }

    private startHostDecisions(): void {
        if (!this.running || !this.runtimeOptions?.inputDecisionPlanner || this.hostDecisions || this.workAbort.signal.aborted) return;
        const operation = this.processHostDecisions().catch(error => {
            if (!this.workAbort.signal.aborted) this.lastError = error instanceof Error ? error.message : 'host input decision failed';
        }).finally(() => {
            if (this.hostDecisions === operation) this.hostDecisions = undefined;
            this.backgroundJobs.delete(operation);
        });
        this.hostDecisions = operation;
        this.backgroundJobs.add(operation);
    }

    private requestShowReplan(): void {
        this.replanVersion++;
        this.kickShowPlanning();
    }

    private kickShowPlanning(): void {
        if (!this.running || !this.runtimeOptions?.planner || this.showPlanning || Date.now() < this.showPlanRetryAt) return;
        const task = this.activeShowPlan().then(() => undefined).catch(error => {
            if (!this.workAbort.signal.aborted) console.warn(JSON.stringify({ level: 'warn', event: 'show.plan.start_failed',
                reason: error instanceof Error ? error.message : 'unknown' }));
        }).finally(() => this.backgroundJobs.delete(task));
        this.backgroundJobs.add(task);
    }

    private recentHostAirtime(now: number): Array<{ hostId: keyof typeof HOST_PROFILES; minutes: number }> {
        const since = now - 48 * 60 * 60_000;
        return this.store.recentHostShifts(since).map(shift => ({
            hostId: shift.hostId,
            minutes: Math.max(0, Math.round((Math.min(shift.endedAt ?? now, now) - Math.max(shift.startedAt, since)) / 60_000)),
        }));
    }

    private kickHostShiftPlanning(): void {
        if (!this.running || !this.runtimeOptions?.shiftPlanner || this.hostShiftPlanning ||
            this.pendingHostShift || this.workAbort.signal.aborted || Date.now() < this.nextHostShiftAttemptAt) return;
        const current = this.store.currentHostShift();
        if (!current || current.plannedEndAt - Date.now() > 10 * 60_000) return;
        const now = Date.now();
        const context = { currentHostId: current.hostId, recentShifts: this.recentHostAirtime(now),
            currentTheme: this.store.currentShowPlan()?.theme, memory: this.store.showMemory(now) };
        const operation = this.withDeadline(
            signal => this.runtimeOptions!.shiftPlanner!.proposeHostShift(context, signal),
            25_000, 'Host shift planning timed out',
        ).then(proposal => {
            if (!this.running || this.workAbort.signal.aborted || this.store.currentHostShift()?.id !== current.id ||
                this.pendingHostShift) return;
            const valid = validateHostShiftProposal(proposal);
            const balanced = balanceHostShift(valid, this.recentHostAirtime(Date.now()), current.hostId);
            this.pendingHostShift = { expectedId: current.id, proposal: balanced,
                source: balanced === valid ? 'organizer' : 'fallback' };
        }).catch(() => {
            // The boundary uses a local fair fallback; no model call blocks music.
            this.nextHostShiftAttemptAt = Date.now() + 60_000;
        }).finally(() => {
            if (this.hostShiftPlanning === operation) this.hostShiftPlanning = undefined;
            this.backgroundJobs.delete(operation);
        });
        this.hostShiftPlanning = operation;
        this.backgroundJobs.add(operation);
    }

    private async rotateHostIfDue(): Promise<void> {
        const changed = await this.mailbox.run(() => {
            const now = Date.now();
            const current = this.store.currentHostShift();
            if (!current || current.plannedEndAt > now) return false;
            const planned = this.pendingHostShift?.expectedId === current.id ? this.pendingHostShift.proposal : undefined;
            const source = planned ? this.pendingHostShift?.source ?? 'organizer' : 'fallback';
            const next = planned ?? fallbackHostShift(this.recentHostAirtime(now), current.hostId);
            const shifted = this.store.startHostShift(next.hostId, now + next.minutes * 60_000, now, current.id);
            if (!shifted) return false;
            this.pendingHostShift = undefined;
            this.nextHostShiftAttemptAt = 0;
            console.log(JSON.stringify({ level: 'info', event: 'host.shift.started', hostId: shifted.hostId,
                plannedEndAt: shifted.plannedEndAt, source }));
            return shifted.id !== current.id;
        });
        if (changed) this.requestShowReplan();
    }

    private async processHostDecisions(): Promise<void> {
        for (let index = 0; index < 20 && this.running && !this.workAbort.signal.aborted; index++) {
            const snapshot = await this.mailbox.run(() => ({
                input: this.store.pendingHostInputs(1)[0],
                theme: this.store.currentShowPlan()?.theme ?? 'Свободный эфир',
                hostId: this.store.currentHostShift()?.hostId,
                memory: this.store.showMemory(),
                recentPlayed: this.store.recentPlayed(8),
                upcoming: this.store.upcomingEditorial(4).map(item => ({ title: item.track.title, artist: item.track.artist })),
            }));
            const input = snapshot.input;
            if (!input) return;
            const context = input.kind === 'request'
                ? { kind: 'request' as const, currentTheme: snapshot.theme,
                    hostId: snapshot.hostId, hostMusicBrief: snapshot.hostId ? HOST_PROFILES[snapshot.hostId].musicBrief : undefined,
                    memory: snapshot.memory, recentPlayed: snapshot.recentPlayed, upcoming: snapshot.upcoming,
                    track: { title: input.track.title, artist: input.track.artist },
                    ...(input.dedication ? { dedication: input.dedication } : {}) }
                : { kind: 'studio' as const, currentTheme: snapshot.theme,
                    hostId: snapshot.hostId, hostMusicBrief: snapshot.hostId ? HOST_PROFILES[snapshot.hostId].musicBrief : undefined,
                    memory: snapshot.memory, recentPlayed: snapshot.recentPlayed, upcoming: snapshot.upcoming,
                    message: input.message };
            let decision: { choice: 'select' | 'defer' | 'decline'; deferMinutes?: number } = { choice: 'select' };
            try {
                decision = await this.withDeadline(
                    signal => this.runtimeOptions!.inputDecisionPlanner!.proposeInputDecision(context, signal),
                    25_000, 'Host input decision timed out',
                );
            } catch {
                // A failed model call is an explicit select, never an abandoned listener input.
            }
            if (!this.running || this.workAbort.signal.aborted) return;
            const committed = await this.mailbox.run(() => {
                return this.running && this.store.decideHostInput(input.kind, input.id,
                    decision.choice === 'defer' ? { choice: 'defer', deferMinutes: decision.deferMinutes! } : { choice: decision.choice });
            });
            if (committed && decision.choice !== 'select') this.startHostNotifications();
            if (committed && input.kind === 'request' && decision.choice === 'select') this.kickUrgentPreparation();
        }
    }

    private startHostNotifications(): void {
        if (!this.running || !this.hostNotificationSender || this.hostNotifications || this.workAbort.signal.aborted) return;
        const operation = this.processHostNotification().catch(error => {
            if (!this.workAbort.signal.aborted) this.lastError = error instanceof Error ? error.message : 'host notification failed';
        }).finally(() => {
            if (this.hostNotifications === operation) this.hostNotifications = undefined;
            this.backgroundJobs.delete(operation);
        });
        this.hostNotifications = operation;
        this.backgroundJobs.add(operation);
    }

    private async processHostNotification(): Promise<void> {
        const notice = await this.mailbox.run(() => this.store.dueHostNotification());
        if (!notice || !this.hostNotificationSender) return;
        let delivered = false;
        try {
            await this.withDeadline(
                () => this.hostNotificationSender!({ userId: notice.userId, guildId: notice.guildId }, notice.message),
                10_000, 'Host notification timed out',
            );
            delivered = true;
        } catch {
            // The persisted outbox schedules a bounded retry; music is unaffected.
        }
        if (this.workAbort.signal.aborted || !this.running) return;
        await this.mailbox.run(() => this.store.completeHostNotification(notice.id, delivered, Date.now(), notice.attempts));
    }

    private isStopped(): boolean {
        return this.mode === 'stopped';
    }

    private async fillEditorialHorizon(): Promise<void> {
        if (this.providers.length === 0) return;
        if (Date.now() < this.autofillRetryAt) return;
        const plan = await this.activeShowPlan();
        // Catalog queries must originate from a model-authored show plan.
        // The deterministic fallback is context for the planner, not a music source.
        if (plan?.source !== 'model') return;
        const queries = plan.queries;
        if (queries.length === 0) return;
        const attempts = this.providers.length * queries.length * 3;
        const deadline = Date.now() + 3 * this.searchTimeoutMs;
        let addedAny = false;
        for (let attempt = 0; attempt < attempts && !this.workAbort.signal.aborted && Date.now() < deadline && this.store.editorialPipelineCount() < 10; attempt++) {
            const cursor = this.rotationCursor++;
            const provider = this.providers[cursor % this.providers.length]!;
            const query = queries[Math.floor(cursor / this.providers.length) % queries.length]!;
            try {
                const candidates = await this.withDeadline(
                    signal => provider.search(query, 5, signal), Math.max(1, Math.min(this.searchTimeoutMs, deadline - Date.now())), `${provider.name} search timed out`,
                );
                this.workAbort.signal.throwIfAborted();
                for (const track of candidates) {
                    if (!matchesMusicQuery(track, query)) continue;
                    const result = await this.mailbox.run(() => {
                        if (this.isStopped() || (plan && this.store.currentShowPlan()?.revision !== plan.revision)) return { stale: true } as const;
                        return { stale: false, added: this.store.enqueueEditorialIfEligible(track) } as const;
                    });
                    if (result.stale) return;
                    const added = result.added;
                    if (added !== undefined) {
                        addedAny = true;
                        // A slow search for the rest of the horizon must not
                        // keep the first discovered song out of the player.
                        this.kickUrgentPreparation();
                        break;
                    }
                }
            } catch (error) {
                if (this.workAbort.signal.aborted) return;
                this.lastError = error instanceof Error ? error.message : `${provider.name} autofill failed`;
            }
        }
        if (this.workAbort.signal.aborted) return;
        if (addedAny || this.store.editorialPipelineCount() > 0) {
            this.autofillFailures = 0;
            this.autofillRetryAt = 0;
        } else {
            this.autofillFailures++;
            this.autofillRetryAt = Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(this.autofillFailures - 1, 6));
        }
    }

    private async activeShowPlan(): Promise<ShowPlan> {
        const now = Date.now();
        const snapshot = await this.mailbox.run(() => {
            const recentPlayed = this.store.recentPlayed(20, now);
            const plan = this.store.ensureFallbackShowPlan(fallbackShowPlan(now, recentPlayed, this.rotationQueries), now);
            const upcoming = this.store.upcomingEditorial(8).map(item => ({ title: item.track.title, artist: item.track.artist }));
            const shift = this.store.currentHostShift();
            return { plan, recentPlayed, memory: this.store.showMemory(now), upcoming,
                hostId: shift?.hostId, shiftId: shift?.id, shiftStartedAt: shift?.startedAt,
                completedInPlan: this.store.completedEditorialSince(plan.createdAt),
                editorialDepth: this.store.editorialPipelineCount() };
        });
        const planner = this.runtimeOptions?.planner;
        const signalDue = this.replanVersion > this.appliedReplanVersion;
        const criticalReserve = snapshot.editorialDepth <= 2;
        const reserveDropped = this.editorialDepthHighWater === undefined ||
            snapshot.editorialDepth < this.editorialDepthHighWater;
        const criticalReserveDue = criticalReserve && reserveDropped;
        const lowReserveDue = snapshot.editorialDepth <= 4 && reserveDropped;
        if (this.editorialDepthHighWater !== undefined) {
            this.editorialDepthHighWater = Math.max(this.editorialDepthHighWater, snapshot.editorialDepth);
        } else if (snapshot.editorialDepth > 4) {
            this.editorialDepthHighWater = snapshot.editorialDepth;
        }
        const shiftDue = snapshot.shiftStartedAt !== undefined && snapshot.plan.createdAt < snapshot.shiftStartedAt;
        const reviewDue = snapshot.plan.source === 'fallback' || signalDue || shiftDue || this.showPlanRetryAt > 0 ||
            snapshot.completedInPlan >= 4 || lowReserveDue ||
            now - snapshot.plan.createdAt >= 20 * 60_000;
        const minInterval = signalDue || shiftDue ? 0 : criticalReserveDue ? 15_000 : lowReserveDue ? 60_000 : 5 * 60_000;
        const earliest = Math.max(this.showPlanRetryAt, this.lastShowPlanAttemptAt + minInterval,
            snapshot.plan.source === 'model' && !signalDue && !shiftDue && !lowReserveDue ? snapshot.plan.createdAt + 5 * 60_000 : 0);
        if (planner && reviewDue && !this.showPlanning && now >= earliest) {
            this.lastShowPlanAttemptAt = now;
            const signalVersion = this.replanVersion;
            const operation = this.abortable(Promise.resolve().then(() => planner.proposeShowPlan({
                recentPlayed: snapshot.recentPlayed,
                currentTheme: snapshot.plan.theme,
                hostId: snapshot.hostId,
                hostMusicBrief: snapshot.hostId ? HOST_PROFILES[snapshot.hostId].musicBrief : undefined,
                memory: snapshot.memory,
                upcoming: snapshot.upcoming,
            }, this.workAbort.signal))).then(async proposal => {
                const staged = this.providers.length > 0 ? await this.stageEditorialPlan(proposal, criticalReserve)
                    : { tracks: [] as Array<{ track: Track; localPath: string }>, release: () => undefined };
                try {
                    const minimum = criticalReserve ? 1 : 2;
                    if (this.providers.length > 0 && staged.tracks.length < minimum) throw new Error(`Could not prepare ${minimum} new show-plan tracks`);
                    const applied = await this.mailbox.run(() => {
                        if (this.isStopped() || this.replanVersion !== signalVersion ||
                            this.store.currentHostShift()?.id !== snapshot.shiftId) return undefined;
                        const next = this.providers.length > 0
                            ? this.store.applyEditorialPlan(snapshot.plan.revision, proposal, staged.tracks)
                            : this.store.replaceShowPlan(snapshot.plan.revision, proposal);
                        if (next) this.editorialDepthHighWater = this.store.editorialPipelineCount();
                        return next;
                    });
                    if (!applied) return;
                    if (this.replanVersion === signalVersion) this.appliedReplanVersion = signalVersion;
                    this.showPlanRetryAt = 0;
                    for (const [itemId, segment] of this.readyBreaks) {
                        if (segment.kind === 'jingle' || segment.planRevision === applied.revision) continue;
                        this.readyBreaks.delete(itemId);
                        if (segment.segmentId !== undefined) await this.mailbox.run(() => this.store.discardHostSegment(segment.segmentId!));
                    }
                    if (this.playing) void this.prepareUpcomingBreak(this.tracksSinceStudio, this.remainingCurrentTrackMs()).catch(error => {
                        this.lastError = error instanceof Error ? error.message : 'post-plan host preparation failed';
                    });
                    console.log(JSON.stringify({ level: 'info', event: 'show.plan.applied', revision: applied.revision,
                        theme: applied.theme, readyTracks: staged.tracks.length }));
                    const previousPreparation = this.preparation;
                    void (previousPreparation?.catch(() => undefined) ?? Promise.resolve()).then(() => this.ensurePrepared()).catch(error => {
                        this.lastError = error instanceof Error ? error.message : 'post-plan refill failed';
                    });
                } finally {
                    staged.release();
                }
            }).catch(error => {
                if (!this.workAbort.signal.aborted) {
                    this.showPlanRetryAt = Date.now() + (criticalReserve ? 15_000 : lowReserveDue ? 60_000 : 5 * 60_000);
                    console.warn(JSON.stringify({ level: 'warn', event: 'show.plan.failed',
                        reason: error instanceof Error ? error.message : 'unknown' }));
                }
            }).finally(() => {
                if (this.showPlanning === operation) this.showPlanning = undefined;
                this.backgroundJobs.delete(operation);
                if (!this.isStopped() && this.replanVersion !== signalVersion) {
                    this.lastShowPlanAttemptAt = 0;
                    this.showPlanRetryAt = 0;
                    this.kickShowPlanning();
                }
            });
            this.showPlanning = operation;
            this.backgroundJobs.add(operation);
        }
        return snapshot.plan;
    }

    private async stageEditorialPlan(proposal: { queries: string[] }, urgent = false): Promise<{
        tracks: Array<{ track: Track; localPath: string }>; release: () => void;
    }> {
        const staged: Array<{ track: Track; localPath: string }> = [];
        const releases: Array<() => void> = [];
        const release = (): void => { for (const cleanup of releases) cleanup(); };
        const seenSongs = new Set<string>();
        const currentArtist = await this.mailbox.run(() => this.store.current()?.track?.artist);
        const seenArtists = new Set(currentArtist ? [metadataKey(currentArtist)] : []);
        const deadline = Date.now() + 3 * 60_000;
        const rejected = { search: 0, metadata: 0, repeat: 0, cooldown: 0, media: 0 };
        try {
          for (const query of proposal.queries) {
            if (staged.length >= 8 || Date.now() >= deadline || this.workAbort.signal.aborted) break;
            const searches = await Promise.allSettled(this.providers.map(provider => this.withDeadline(
                signal => provider.search(query, 5, signal), this.searchTimeoutMs, `${provider.name} search timed out`,
            )));
            rejected.search += searches.filter(result => result.status === 'rejected').length;
            const candidates = searches.flatMap(result => result.status === 'fulfilled' ? result.value : []);
            for (const track of candidates) {
                if (Date.now() >= deadline || this.workAbort.signal.aborted) break;
                if (!matchesMusicQuery(track, query)) { rejected.metadata++; continue; }
                const identity = songKey(track);
                const artistKey = metadataKey(track.artist);
                if (seenSongs.has(identity) || seenArtists.has(artistKey)) { rejected.repeat++; continue; }
                const eligible = await this.mailbox.run(() => this.store.canQueueEditorial(track));
                if (!eligible) { rejected.cooldown++; continue; }
                const unreserve = this.reserveTrack(track);
                try {
                    const protectedPaths = await this.mailbox.run(() => this.store.protectedCachePaths());
                    const path = await this.withDeadline(signal => this.cache.materialize(track,
                        providerFor(this.providers, track.provider), signal,
                        new Set([...protectedPaths, ...staged.map(item => item.localPath)])),
                    Math.min(this.preparationTimeoutMs, Math.max(1, deadline - Date.now())), 'Show-plan media preparation timed out');
                    staged.push({ track, localPath: path });
                    releases.push(unreserve);
                    seenSongs.add(identity);
                    seenArtists.add(artistKey);
                    break;
                } catch {
                    unreserve();
                    rejected.media++;
                    // Try another verified catalog track. The old ready run remains audible.
                }
            }
            if (urgent && staged.length > 0) break;
          }
          if (staged.length < (urgent ? 1 : 2) && !this.workAbort.signal.aborted) {
              console.warn(JSON.stringify({ level: 'warn', event: 'show.plan.staging.short', staged: staged.length,
                  queries: proposal.queries.length, rejected }));
          }
          return { tracks: staged, release };
        } catch (error) {
            release();
            throw error;
        }
    }

    private async ensurePrepared(): Promise<void> {
        if (this.preparation) return await this.preparation;
        const operation = this.prepareHorizon();
        this.preparation = operation;
        try {
            await operation;
        } finally {
            if (this.preparation === operation) this.preparation = undefined;
        }
    }

    private kickUrgentPreparation(): void {
        if (!this.running || this.workAbort.signal.aborted || this.urgentPreparations.size >= 2) return;
        // The normal horizon may be waiting on catalog search or a slow CDN.
        // These bounded workers still claim through the director mailbox.
        const operation = this.prepareQueued(1).then(() => undefined).catch(error => {
            if (!this.workAbort.signal.aborted) this.lastError = error instanceof Error ? error.message : 'urgent media preparation failed';
        }).finally(() => {
            this.urgentPreparations.delete(operation);
            this.backgroundJobs.delete(operation);
        });
        this.urgentPreparations.add(operation);
        this.backgroundJobs.add(operation);
    }

    private async prepareHorizon(): Promise<void> {
        const prepared = await this.prepareQueued(6);
        if (this.workAbort.signal.aborted) return;
        await this.fillEditorialHorizon();
        if (this.workAbort.signal.aborted) return;
        await this.prepareQueued(6 - prepared);
    }

    private async waitForSuccessor(currentItemId: number, preparation: Promise<void>): Promise<void> {
        let finished = false;
        void preparation.finally(() => { finished = true; });
        while (!finished && !this.workAbort.signal.aborted && this.currentItemId === currentItemId) {
            if (await this.mailbox.run(() => Boolean(this.store.peekNextForPlayback()))) return;
            try {
                await delay(250, undefined, { signal: this.workAbort.signal });
            } catch {
                return;
            }
        }
    }

    private async waitForAnyReady(preparation: Promise<void>): Promise<void> {
        let finished = false;
        void preparation.finally(() => { finished = true; });
        while (!finished && !this.workAbort.signal.aborted) {
            if (await this.mailbox.run(() => Boolean(this.store.peekNextForPlayback()))) return;
            try {
                await delay(250, undefined, { signal: this.workAbort.signal });
            } catch {
                return;
            }
        }
    }

    private async prepareQueued(limit: number): Promise<number> {
        let claimed = 0;
        const worker = async (): Promise<void> => {
            while (!this.workAbort.signal.aborted) {
                const item = await this.mailbox.run(() => {
                    if (claimed >= limit) return undefined;
                    const next = this.store.claimPreparation();
                    if (next) claimed++;
                    return next;
                });
                if (!item) return;
                if (!item.track) {
                    await this.failAndNotify(item.id, 'queue item has no track');
                    continue;
                }
                const release = this.reserveTrack(item.track);
                try {
                    const protectedPaths = await this.mailbox.run(() => this.store.protectedCachePaths());
                    const localPath = await this.withDeadline(
                        signal => this.cache.materialize(item.track!, providerFor(this.providers, item.track!.provider), signal, protectedPaths),
                        this.preparationTimeoutMs,
                        'Media preparation timed out',
                    );
                    if (this.workAbort.signal.aborted) return;
                    await this.mailbox.run(() => this.store.markReady(item.id, localPath));
                } catch (error) {
                    if (this.workAbort.signal.aborted) return;
                    const reason = error instanceof Error ? error.message : 'media preparation failed';
                    if (retryableDownloadError(error) || reason === 'Media preparation timed out') {
                        const deferred = await this.mailbox.run(() => {
                            const attempts = this.store.preparationAttempts(item.id);
                            return attempts < 3 && this.store.deferPreparation(item.id, reason,
                                Date.now() + (attempts === 1 ? 15_000 : 45_000));
                        });
                        if (deferred) {
                            logPlayout('radio.media.preparation_deferred', item.id, { kind: item.kind });
                            continue;
                        }
                    }
                    await this.failAndNotify(item.id, reason);
                    this.lastError = reason;
                } finally {
                    release();
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(2, limit) }, () => worker()));
        return claimed;
    }

    private async prepareUpcomingBreak(studioTracksBeforeCurrent: number, currentDurationMs: number): Promise<void> {
        if (!this.presenter) return;
        const next = await this.mailbox.run(() => this.store.peekNextForPlayback());
        if (!next?.track || this.readyBreaks.has(next.id) || this.breaksInFlight.has(next.id)) return;
        const request = next.kind === 'request' ? await this.mailbox.run(() => this.store.requestContext(next.id)) : undefined;
        const studio = !request && studioTracksBeforeCurrent >= 1 ? await this.mailbox.run(() => this.store.peekStudioMessage()) : undefined;
        const jingle = !request && !studio && (await this.mailbox.run(() => this.store.jingleDue(this.jingleEveryMs)));
        const broadcast = await this.mailbox.run(() => ({ memory: this.store.showMemory(),
            currentTheme: this.store.currentShowPlan()?.theme, planRevision: this.store.currentShowPlan()?.revision,
            recentPlayed: this.store.recentPlayed(8),
            hostShift: this.store.currentHostShift() }));
        const shift = broadcast.hostShift;
        if (shift && !this.pendingHostShift && shift.plannedEndAt <= Date.now() + currentDurationMs) {
            // A slow organizer must not race the already-rendered handoff.
            // Pin one fair local choice before speech preparation begins.
            this.pendingHostShift = { expectedId: shift.id,
                proposal: fallbackHostShift(this.recentHostAirtime(Date.now()), shift.hostId), source: 'fallback' };
        }
        const pending = shift && this.pendingHostShift?.expectedId === shift.id ? this.pendingHostShift.proposal : undefined;
        const prospective = shift && pending && shift.plannedEndAt <= Date.now() + currentDurationMs ? pending : undefined;
        const hostId = prospective?.hostId ?? shift?.hostId;
        // The first break of a new shift is an introduction, regardless of
        // whether an older request, letter or jingle is also waiting.
        const kind = hostId && (prospective || !shift?.introducedAt) ? 'intro'
            : request ? 'request' : studio ? 'studio' : jingle ? 'jingle' : 'station';
        this.breaksInFlight.add(next.id);
        try {
            const rendered = await this.abortable(this.presenter.prepare(
                kind === 'request'
                    ? { kind, hostId, requesterName: request!.userName,
                        ...(request!.dedication ? { dedication: request!.dedication } : {}), nextTrack: next.track, ...broadcast }
                    : kind === 'studio'
                      ? { kind, hostId, studioMessage: studio!.message,
                          requesterName: studio!.userName, nextTrack: next.track, ...broadcast }
                    : kind === 'jingle'
                        ? { kind, hostId }
                      : kind === 'intro'
                        ? { kind, hostId, nextTrack: next.track, ...broadcast }
                      : { kind, hostId, nextTrack: next.track, ...broadcast },
                this.workAbort.signal,
            ));
            if (!rendered) return;
            await this.mailbox.run(() => {
                if (this.isStopped() || this.store.peekNextForPlayback()?.id !== next.id ||
                    this.store.currentHostShift()?.id !== broadcast.hostShift?.id ||
                    this.store.currentShowPlan()?.revision !== broadcast.planRevision ||
                    (request && JSON.stringify(this.store.requestContext(next.id)) !== JSON.stringify(request))) return;
                const segmentId = this.store.recordHostSegment(next.id, rendered.script, rendered.path,
                    Date.now(), hostId ? { hostId, ...(hostId === shift?.hostId ? { shiftId: shift.id } : {}) } : undefined);
                if (segmentId !== undefined) this.readyBreaks.set(next.id,
                    { path: rendered.path, kind, segmentId, hostId, hostShiftId: shift?.id,
                        planRevision: broadcast.planRevision,
                        ...(studio ? { studioId: studio.id } : {}),
                        ...(request ? { requestSignature: JSON.stringify(request) } : {}) });
            });
        } finally {
            this.breaksInFlight.delete(next.id);
            const changed = await this.mailbox.run(() => this.store.currentShowPlan()?.revision !== broadcast.planRevision);
            if (changed && this.playing && !this.isStopped()) {
                void this.prepareUpcomingBreak(studioTracksBeforeCurrent, this.remainingCurrentTrackMs()).catch(error => {
                    this.lastError = error instanceof Error ? error.message : 'host refresh after programme pivot failed';
                });
            }
        }
    }

    private remainingCurrentTrackMs(): number {
        return Math.max(0, (this.currentPlaybackDurationMs ?? 0) -
            (Date.now() - (this.currentPlaybackStartedAt ?? Date.now())) - 10_000);
    }

    private reserveTrack(track: Track): () => void {
        // Test doubles that only implement materialize need no LRU coordination.
        return this.cache.reserve?.(track) ?? (() => undefined);
    }

    private async failAndNotify(itemId: number, reason: string): Promise<void> {
        const recipients = await this.mailbox.run(() => this.store.requestRecipients(itemId));
        await this.mailbox.run(() => this.store.failItem(itemId, reason));
        if (!this.requestFailureNotifier || recipients.length === 0) return;
        const retryExhausted = reason === 'fetch failed' || reason === 'terminated' ||
            reason === 'Media preparation timed out' || /audio fetch failed \((?:403|408|429|5\d\d)\)/u.test(reason);
        const message = retryExhausted
            ? 'Аудио заказанного трека не загрузилось после нескольких попыток. Заявка снята; обычный 15-минутный интервал между заказами сохраняется. Эфир продолжается.'
            : 'Заказанный трек не удалось подготовить или воспроизвести. Заявка снята; эфир продолжится автоматически.';
        void Promise.allSettled(recipients.map(recipient => this.requestFailureNotifier!(recipient, message)));
    }

    private async skipAndNotify(itemId: number): Promise<void> {
        const recipients = await this.mailbox.run(() => this.store.requestRecipients(itemId));
        await this.mailbox.run(() => this.store.skipItem(itemId));
        if (!this.requestFailureNotifier || recipients.length === 0) return;
        const message = 'Ведущий снял заказанный трек с эфира. Заявка закрыта без блокировки самой композиции.';
        void Promise.allSettled(recipients.map(recipient => this.requestFailureNotifier!(recipient, message)));
    }

    private abortable<T>(operation: Promise<T>): Promise<T> {
        const signal = this.workAbort.signal;
        if (signal.aborted) return Promise.reject(signal.reason);
        return new Promise<T>((resolve, reject) => {
            const cleanup = (): void => signal.removeEventListener('abort', onAbort);
            const onAbort = (): void => {
                cleanup();
                reject(signal.reason);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            void operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        });
    }

    private async withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, reason: string): Promise<T> {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([timeout, this.workAbort.signal]);
        let onAbort: () => void = () => undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(timeout.aborted ? new Error(reason) : signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            signal.throwIfAborted();
            return await Promise.race([operation(signal), deadline]);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    private isRetryableMediaFailure(reason: string): boolean {
        return !/skipped by owner|no discord voice outputs|audio output stopped|already has an active item/iu.test(reason);
    }

    private isOutputUnavailable(reason: string): boolean {
        return /all discord voice outputs disconnected|no discord voice outputs|audio output stopped/iu.test(reason);
    }
}
