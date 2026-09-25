import type { Readable } from 'node:stream';
import type { HostId } from './host-profiles.js';

export type ProviderName = 'spotify' | 'ytmusic';

export interface Track {
    provider: ProviderName;
    id: string;
    title: string;
    artist: string;
    durationMs: number;
}

export interface MediaFetch {
    body: Readable;
    mimeType: string;
}

export interface MusicProvider {
    readonly name: ProviderName;
    search(query: string, limit?: number, signal?: AbortSignal): Promise<Track[]>;
    resolve(trackId: string, signal?: AbortSignal): Promise<Track | undefined>;
    fetch(trackId: string, signal?: AbortSignal): Promise<MediaFetch>;
    health(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
}

export interface BreakContext {
    kind: 'station' | 'request' | 'studio' | 'jingle' | 'intro';
    hostId?: HostId;
    previousHost?: { id: HostId; name: string };
    nextHost?: { id: HostId; name: string };
    /** Playing during preparation; it will have ended when this break airs. */
    precedingTrack?: Track;
    nextTrack?: Track;
    requesterName?: string;
    dedication?: string;
    studioMessage?: string;
    recentLines: string[];
    memory?: ShowMemory;
    currentTheme?: string;
    recentPlayed?: RecentSpin[];
    joint?: {
        occasion: string;
        participants: HostId[];
        turnIndex: number;
        priorTurns: Array<{ hostId: HostId; text: string }>;
    };
}

export interface JointShowProposal {
    hostIds: HostId[];
    occasion: string;
}

export interface JointShowPlanner {
    proposeJointShow(context: { currentHostId: HostId; recentShowSizes: { solo: number; pair: number; trio: number };
        currentTheme?: string; nextTrack?: Track; memory?: ShowMemory },
        signal?: AbortSignal): Promise<JointShowProposal>;
}

export interface ScriptWriter {
    writeBreak(context: BreakContext, signal?: AbortSignal): Promise<string>;
}

export interface MusicQueryInterpreter {
    rewriteMusicQuery(description: string, signal?: AbortSignal): Promise<string>;
}

export interface RecentSpin {
    title: string;
    artist: string;
    playedAt: number;
}

export interface ShowPlan {
    revision: number;
    theme: string;
    queries: string[];
    source: 'fallback' | 'model';
    requestRun: 'continue' | 'alternate';
    createdAt: number;
    expiresAt: number;
}

export interface ShowPlanProposal {
    theme: string;
    queries: string[];
    requestRun: 'continue' | 'alternate';
}

export interface ShowMemory {
    earlierSpins: RecentSpin[];
    recentThemes: Array<{ theme: string; createdAt: number }>;
    listenerSignals: Array<{ kind: 'request' | 'studio'; text: string; userName: string; createdAt: number }>;
    hostLines: string[];
    hostTurns?: Array<{ hostId: HostId; text: string; airedAt: number }>;
    earlierHostLines: Array<{ text: string; createdAt: number }>;
}

export interface ShowPlanner {
    proposeShowPlan(context: { recentPlayed: RecentSpin[]; currentTheme: string; memory?: ShowMemory;
        upcoming?: Array<{ title: string; artist: string }>; hostId?: HostId; hostMusicBrief?: string },
        signal?: AbortSignal): Promise<ShowPlanProposal>;
    /** Optional backstage Luna plan for a pinned incoming host; never writes the running order. */
    proposeUpcomingShowPlan?(context: { recentPlayed: RecentSpin[]; currentTheme: string; memory?: ShowMemory;
        upcoming: Array<{ title: string; artist: string }>; hostId: HostId; hostMusicBrief: string },
        signal?: AbortSignal): Promise<ShowPlanProposal>;
}

export interface HostInputDecisionContext {
    kind: 'request' | 'studio';
    currentTheme: string;
    hostId?: HostId;
    hostMusicBrief?: string;
    memory?: ShowMemory;
    recentPlayed?: RecentSpin[];
    upcoming?: Array<{ title: string; artist: string }>;
    track?: { title: string; artist: string };
    dedication?: string;
    message?: string;
}

export interface HostInputDecisionProposal {
    choice: 'select' | 'defer' | 'decline';
    deferMinutes?: number;
}

export interface HostInputDecisionPlanner {
    proposeInputDecision(context: HostInputDecisionContext, signal?: AbortSignal): Promise<HostInputDecisionProposal>;
}

export interface HostShiftProposal {
    hostId: HostId;
    minutes: number;
}

export interface HostShiftPlanner {
    proposeHostShift(context: {
        currentHostId?: HostId;
        recentShifts: Array<{ hostId: HostId; minutes: number }>;
        currentTheme?: string;
        memory?: ShowMemory;
    }, signal?: AbortSignal): Promise<HostShiftProposal>;
}

export interface SpeechResult {
    body: Readable;
    mimeType: string;
}

export interface SpeechEngine {
    synthesize(text: string, voice: string, signal?: AbortSignal): Promise<SpeechResult>;
    health(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
}

export interface OutputHealth {
    guildId: string;
    connected: boolean;
    detail?: string;
}

export interface OutputFanout {
    connectGuild(guildId: string, channelId: string, adapterCreator: unknown): Promise<void>;
    play(localPath: string, options?: { kind: 'speech' }): Promise<void>;
    pause(): boolean;
    resume(): boolean;
    skip(): boolean;
    stopGuild(guildId: string): void;
    stopAll(): void;
    health(): OutputHealth[];
}

export type PlayItemState = 'queued' | 'preparing' | 'ready' | 'playing' | 'played' | 'failed' | 'interrupted' | 'expired';
export type PlayItemKind = 'editorial' | 'request' | 'host';

export interface QueueItem {
    id: number;
    kind: PlayItemKind;
    state: PlayItemState;
    track?: Track;
    localPath?: string;
    createdAt: number;
    error?: string;
}

export interface RequestInput {
    guildId: string;
    userId: string;
    userName: string;
    track: Track;
    dedication?: string;
    isOwner?: boolean;
    now: number;
}

export interface StudioInput {
    guildId: string;
    userId: string;
    userName: string;
    message: string;
    isOwner?: boolean;
    now: number;
}

export interface RadioStatus {
    mode: 'starting' | 'playing' | 'paused' | 'degraded' | 'stopped';
    current?: QueueItem;
    queued: number;
    readyTracks: number;
    pendingRequests: number;
    pendingStudioMessages: number;
    outputs: OutputHealth[];
    showPlan?: Pick<ShowPlan, 'theme' | 'source'>;
    host?: { id: HostId; plannedEndAt: number };
    lastError?: string;
}
