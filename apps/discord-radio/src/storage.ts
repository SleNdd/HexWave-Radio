import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import type { QueueItem, RecentSpin, RequestInput, ShowMemory, ShowPlan, ShowPlanProposal, StudioInput, Track } from './contracts.js';
import { HOST_IDS, type HostId } from './host-profiles.js';
import { SHOW_PLAN_TTL_MS, validateShowProposal } from './showrunner.js';
import { metadataKey, songKey } from './track-identity.js';

export interface RequestPolicy {
    requestCooldownMs: number;
    requestTtlMs: number;
    studioCooldownMs: number;
    studioTtlMs: number;
    trackCooldownMs: number;
    artistCooldownMs: number;
}

export type RequestDecision = { accepted: true; requestId: number; itemId: number; merged: boolean; duplicateSubmission?: boolean } | { accepted: false; reason: string };
export type StudioDecision = { accepted: true; messageId: number; duplicateSubmission?: boolean } | { accepted: false; reason: string };
export type HostInputDecision = { choice: 'select' | 'decline' } | { choice: 'defer'; deferMinutes: number };
export type HostInput =
    | { kind: 'request'; id: number; guildId: string; userId: string; userName: string; dedication?: string; createdAt: number; expiresAt: number; track: Track }
    | { kind: 'studio'; id: number; guildId: string; userId: string; userName: string; message: string; createdAt: number; expiresAt: number };
export type HostNotification = {
    id: number; kind: 'request' | 'studio'; inputId: number; guildId: string; userId: string;
    message: string; attempts: number; nextAttemptAt: number; createdAt: number;
};
export type ListenerInput = {
    kind: 'request' | 'studio'; id: number; status: string; hostDecision: 'pending' | 'select' | 'defer' | 'decline';
    createdAt: number; decidedAt?: number; eligibleAfter?: number; label: string;
};

export interface HostShift {
    id: number;
    hostId: HostId;
    startedAt: number;
    plannedEndAt: number;
    endedAt?: number;
    introducedAt?: number;
}

export interface HostSegmentTurn {
    hostId: HostId;
    modelId: string;
    voiceId: string;
    text: string;
}

// Persistence ceiling only; editorial shift lengths are chosen by the organizer.
export const MAX_HOST_SHIFT_MS = 12 * 60 * 60_000;

type Row = Record<string, unknown>;

const asNumber = (value: unknown): number => Number(value);
const asString = (value: unknown): string => String(value);
const asSqlValue = (value: unknown): SQLInputValue => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
    throw new TypeError('Unexpected SQLite value');
};

export class RadioStore {
    private static readonly failedTrackQuarantineMs = 15 * 60_000;
    private static readonly unavailableTrackQuarantineMs = 6 * 60 * 60_000;
    private static readonly listenerRetryWindowMs = 2 * 60_000;
    private static readonly notificationLeaseMs = 60_000;
    private static readonly maxNotificationAttempts = 5;
    readonly db: DatabaseSync;

    constructor(
        path: string,
        private readonly policy: RequestPolicy,
    ) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        this.migrate();
        this.recoverInterrupted();
    }

    close(): void {
        this.db.close();
    }

    private migrate(): void {
        this.transaction(() => {
            this.db.exec(`
            CREATE TABLE IF NOT EXISTS tracks (
                provider TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                artist_key TEXT NOT NULL DEFAULT '',
                song_key TEXT NOT NULL DEFAULT '',
                duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
                PRIMARY KEY(provider, provider_id)
            );
            CREATE TABLE IF NOT EXISTS play_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('editorial','request','host')),
                state TEXT NOT NULL CHECK(state IN ('queued','preparing','ready','playing','played','failed','interrupted','expired')),
                provider TEXT,
                provider_id TEXT,
                local_path TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                error TEXT,
                preparation_attempts INTEGER NOT NULL DEFAULT 0,
                retry_at INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(provider, provider_id) REFERENCES tracks(provider, provider_id)
            );
            CREATE TABLE IF NOT EXISTS track_quarantine (
                provider TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                failed_at INTEGER NOT NULL,
                retry_after INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(provider, provider_id),
                FOREIGN KEY(provider, provider_id) REFERENCES tracks(provider, provider_id)
            );
            CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                play_item_id INTEGER NOT NULL REFERENCES play_items(id),
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                dedication TEXT,
                status TEXT NOT NULL CHECK(status IN ('pending','fulfilled','rejected','expired')),
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS studio_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','aired','rejected','expired')),
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS host_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                play_item_id INTEGER REFERENCES play_items(id),
                script TEXT NOT NULL,
                local_path TEXT,
                status TEXT NOT NULL CHECK(status IN ('draft','ready','played','failed')),
                created_at INTEGER NOT NULL,
                aired_at INTEGER,
                host_id TEXT,
                host_shift_id INTEGER REFERENCES host_shifts(id)
            );
            CREATE TABLE IF NOT EXISTS host_segment_turns (
                segment_id INTEGER NOT NULL REFERENCES host_segments(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
                host_id TEXT NOT NULL CHECK(host_id IN ('luna','sol','grok','deepseek','glm','claude')),
                model_id TEXT NOT NULL,
                voice_id TEXT NOT NULL,
                text TEXT NOT NULL,
                PRIMARY KEY(segment_id,ordinal)
            );
            CREATE TABLE IF NOT EXISTS host_shifts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id TEXT NOT NULL CHECK(host_id IN ('luna','sol','grok','deepseek','glm','claude')),
                started_at INTEGER NOT NULL CHECK(started_at >= 0),
                planned_end_at INTEGER NOT NULL CHECK(planned_end_at > started_at),
                ended_at INTEGER CHECK(ended_at IS NULL OR ended_at >= started_at),
                introduced_at INTEGER CHECK(introduced_at IS NULL OR introduced_at >= started_at)
            );
            CREATE TABLE IF NOT EXISTS guild_outputs (
                guild_id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                connected INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS host_notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('request','studio')),
                input_id INTEGER NOT NULL,
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
                attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
                next_attempt_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(kind,input_id)
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS station_admins (
                user_id TEXT PRIMARY KEY,
                granted_by TEXT NOT NULL,
                granted_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS show_plan (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                revision INTEGER NOT NULL,
                theme TEXT NOT NULL,
                queries_json TEXT NOT NULL,
                source TEXT NOT NULL CHECK(source IN ('fallback','model')),
                request_run TEXT NOT NULL CHECK(request_run IN ('continue','alternate')),
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS play_items_state_created ON play_items(state, created_at);
            CREATE INDEX IF NOT EXISTS requests_active_user ON requests(user_id, status, created_at);
            CREATE INDEX IF NOT EXISTS requests_active_guild ON requests(guild_id, status, created_at);
            CREATE INDEX IF NOT EXISTS studio_active_user ON studio_messages(user_id, status, created_at);
            CREATE INDEX IF NOT EXISTS events_kind_created ON events(kind, created_at);
            CREATE INDEX IF NOT EXISTS host_notifications_due ON host_notifications(status,next_attempt_at,id);
            CREATE UNIQUE INDEX IF NOT EXISTS host_shifts_one_active ON host_shifts((1)) WHERE ended_at IS NULL;
            CREATE INDEX IF NOT EXISTS host_shifts_recent ON host_shifts(started_at,ended_at);
        `);
            for (const table of ['requests', 'studio_messages'] as const) {
                const columns = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(row => asString(row.name)));
                if (!columns.has('host_decision')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN host_decision TEXT NOT NULL DEFAULT 'select' CHECK(host_decision IN ('pending','select','defer','decline'))`);
                if (!columns.has('eligible_after')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN eligible_after INTEGER`);
                if (!columns.has('decided_at')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN decided_at INTEGER`);
            }
            const playColumns = new Set((this.db.prepare('PRAGMA table_info(play_items)').all() as Row[]).map(row => asString(row.name)));
            if (!playColumns.has('preparation_attempts')) this.db.exec('ALTER TABLE play_items ADD COLUMN preparation_attempts INTEGER NOT NULL DEFAULT 0');
            if (!playColumns.has('retry_at')) this.db.exec('ALTER TABLE play_items ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0');
            const quarantineColumns = new Set((this.db.prepare('PRAGMA table_info(track_quarantine)').all() as Row[]).map(row => asString(row.name)));
            if (!quarantineColumns.has('retry_after')) this.db.exec('ALTER TABLE track_quarantine ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0');
            const legacyQuarantine = this.db.prepare('SELECT provider,provider_id,failed_at FROM track_quarantine WHERE retry_after=0').all() as Row[];
            const legacyFailure = this.db.prepare(`SELECT error FROM play_items WHERE provider=? AND provider_id=?
                AND state='failed' AND updated_at=? ORDER BY id DESC LIMIT 1`);
            const updateQuarantine = this.db.prepare('UPDATE track_quarantine SET retry_after=? WHERE provider=? AND provider_id=?');
            for (const row of legacyQuarantine) {
                const provider = asString(row.provider);
                const providerId = asString(row.provider_id);
                const failedAt = asNumber(row.failed_at);
                const failure = legacyFailure.get(provider, providerId, failedAt) as Row | undefined;
                const reason = failure?.error ? asString(failure.error) : '';
                updateQuarantine.run(failedAt + RadioStore.quarantineMs(reason), provider, providerId);
            }
            const hostColumns = new Set((this.db.prepare('PRAGMA table_info(host_segments)').all() as Row[]).map(row => asString(row.name)));
            if (!hostColumns.has('aired_at')) this.db.exec('ALTER TABLE host_segments ADD COLUMN aired_at INTEGER');
            if (!hostColumns.has('host_id')) this.db.exec('ALTER TABLE host_segments ADD COLUMN host_id TEXT');
            if (!hostColumns.has('host_shift_id')) this.db.exec('ALTER TABLE host_segments ADD COLUMN host_shift_id INTEGER REFERENCES host_shifts(id)');
            const shiftColumns = new Set((this.db.prepare('PRAGMA table_info(host_shifts)').all() as Row[]).map(row => asString(row.name)));
            if (!shiftColumns.has('introduced_at')) this.db.exec('ALTER TABLE host_shifts ADD COLUMN introduced_at INTEGER');
            const trackColumns = new Set((this.db.prepare('PRAGMA table_info(tracks)').all() as Row[]).map(row => asString(row.name)));
            if (!trackColumns.has('artist_key')) this.db.exec("ALTER TABLE tracks ADD COLUMN artist_key TEXT NOT NULL DEFAULT ''");
            if (!trackColumns.has('song_key')) this.db.exec("ALTER TABLE tracks ADD COLUMN song_key TEXT NOT NULL DEFAULT ''");
            const legacyTracks = this.db.prepare("SELECT provider,provider_id,title,artist FROM tracks WHERE artist_key='' OR song_key=''").all() as Row[];
            const updateTrackKeys = this.db.prepare('UPDATE tracks SET artist_key=?,song_key=? WHERE provider=? AND provider_id=?');
            for (const row of legacyTracks) {
                const track = { artist: asString(row.artist), title: asString(row.title) };
                updateTrackKeys.run(metadataKey(track.artist), songKey(track), asString(row.provider), asString(row.provider_id));
            }
            this.db.exec(`
                CREATE INDEX IF NOT EXISTS requests_host_pending ON requests(host_decision, status, created_at);
                CREATE INDEX IF NOT EXISTS studio_host_pending ON studio_messages(host_decision, status, created_at);
                CREATE INDEX IF NOT EXISTS host_segments_status_aired ON host_segments(status, COALESCE(aired_at,created_at));
            `);
        });
    }

    private transaction<T>(work: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    private hostShiftFromRow(row: Row): HostShift {
        return {
            id: asNumber(row.id),
            hostId: asString(row.host_id) as HostId,
            startedAt: asNumber(row.started_at),
            plannedEndAt: asNumber(row.planned_end_at),
            ...(row.ended_at === null ? {} : { endedAt: asNumber(row.ended_at) }),
            ...(row.introduced_at === null ? {} : { introducedAt: asNumber(row.introduced_at) }),
        };
    }

    currentHostShift(): HostShift | undefined {
        const row = this.db.prepare('SELECT * FROM host_shifts WHERE ended_at IS NULL').get() as Row | undefined;
        return row ? this.hostShiftFromRow(row) : undefined;
    }

    /** Only the immediate predecessor is valid context for an upcoming handoff intro. */
    precedingHostShift(shiftId: number): HostShift | undefined {
        if (!Number.isSafeInteger(shiftId) || shiftId <= 0) return undefined;
        const row = this.db.prepare(`SELECT prior.* FROM host_shifts current
            JOIN host_shifts prior ON prior.ended_at=current.started_at AND prior.id<current.id
            WHERE current.id=? ORDER BY prior.id DESC LIMIT 1`).get(shiftId) as Row | undefined;
        return row ? this.hostShiftFromRow(row) : undefined;
    }

    /** Mark an introduction only after its speech was actually heard. */
    markHostIntroduced(shiftId: number, now = Date.now()): boolean {
        if (!Number.isSafeInteger(shiftId) || shiftId <= 0 || !Number.isSafeInteger(now)) return false;
        return this.db.prepare(`UPDATE host_shifts SET introduced_at=?
            WHERE id=? AND ended_at IS NULL AND introduced_at IS NULL AND started_at<=?`)
            .run(now, shiftId, now).changes === 1;
    }

    /** Include shifts that overlap the requested instant, not only those starting afterward. */
    recentHostShifts(since: number): HostShift[] {
        if (!Number.isSafeInteger(since) || since < 0) throw new RangeError('Invalid host shift history timestamp');
        const rows = this.db.prepare('SELECT * FROM host_shifts WHERE ended_at IS NULL OR ended_at >= ? ORDER BY started_at,id').all(since) as Row[];
        return rows.map(row => this.hostShiftFromRow(row));
    }

    /**
     * Atomically rotate the on-air host. `expectedCurrentId` is a compare-and-swap guard:
     * pass null only when no shift is expected; a stale decision returns undefined unchanged.
     * Re-selecting the same host adjusts its end time without duplicating its airtime.
     */
    startHostShift(hostId: HostId, plannedEndAt: number, now: number, expectedCurrentId: number | null): HostShift | undefined {
        if (!(HOST_IDS as readonly string[]).includes(hostId)) throw new RangeError('Unknown host identity');
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(plannedEndAt) ||
            plannedEndAt <= now || plannedEndAt - now > MAX_HOST_SHIFT_MS) throw new RangeError('Invalid host shift duration');
        if (expectedCurrentId !== null && (!Number.isSafeInteger(expectedCurrentId) || expectedCurrentId <= 0)) {
            throw new RangeError('Invalid expected host shift id');
        }
        return this.transaction(() => {
            const current = this.currentHostShift();
            if ((current?.id ?? null) !== expectedCurrentId) return undefined;
            if (current) {
                if (now < current.startedAt) throw new RangeError('Host shift clock moved backward');
                if (current.hostId === hostId) {
                    if (current.plannedEndAt !== plannedEndAt) {
                        this.db.prepare('UPDATE host_shifts SET planned_end_at=? WHERE id=? AND ended_at IS NULL').run(plannedEndAt, current.id);
                    }
                    return { ...current, plannedEndAt };
                }
                this.db.prepare('UPDATE host_shifts SET ended_at=? WHERE id=? AND ended_at IS NULL').run(now, current.id);
            }
            const inserted = this.db.prepare('INSERT INTO host_shifts(host_id,started_at,planned_end_at) VALUES(?,?,?)').run(hostId, now, plannedEndAt);
            return { id: Number(inserted.lastInsertRowid), hostId, startedAt: now, plannedEndAt };
        });
    }

    private recoverInterrupted(): void {
        this.transaction(() => {
            this.db.prepare("UPDATE host_segments SET status='failed' WHERE status IN ('draft','ready')").run();
            this.db.prepare("UPDATE play_items SET state='queued',local_path=NULL,error=NULL,updated_at=? WHERE state='preparing'").run(Date.now());
            const rows = this.db.prepare("SELECT * FROM play_items WHERE state = 'playing'").all() as Row[];
            if (rows.length > 0) this.restoreProgrammeBeforeClaim(asNumber(rows[0]!.id));
            const now = Date.now();
            const interrupt = this.db.prepare("UPDATE play_items SET state = 'interrupted', updated_at = ? WHERE id = ?");
            const replay = this.db.prepare(
                "INSERT INTO play_items(kind,state,provider,provider_id,local_path,created_at,updated_at,error) VALUES(?, 'queued', ?, ?, ?, ?, ?, NULL)",
            );
            const moveRequests = this.db.prepare('UPDATE requests SET play_item_id = ? WHERE play_item_id = ? AND status = \'pending\'');
            for (const row of rows) {
                interrupt.run(now, asSqlValue(row.id));
                const inserted = replay.run(
                    asSqlValue(row.kind),
                    asSqlValue(row.provider),
                    asSqlValue(row.provider_id),
                    asSqlValue(row.local_path),
                    now,
                    now,
                );
                moveRequests.run(inserted.lastInsertRowid, asSqlValue(row.id));
            }
        });
    }

    private putTrack(track: Track): void {
        this.db
            .prepare(
                `INSERT INTO tracks(provider,provider_id,title,artist,artist_key,song_key,duration_ms) VALUES(?,?,?,?,?,?,?)
                 ON CONFLICT(provider,provider_id) DO UPDATE SET title=excluded.title, artist=excluded.artist,
                 artist_key=excluded.artist_key,song_key=excluded.song_key,duration_ms=excluded.duration_ms`,
            )
            .run(track.provider, track.id, track.title, track.artist, metadataKey(track.artist), songKey(track), track.durationMs);
    }

    enqueueEditorial(track: Track, now = Date.now()): number {
        return this.transaction(() => {
            this.putTrack(track);
            return Number(
                this.db
                    .prepare("INSERT INTO play_items(kind,state,provider,provider_id,created_at,updated_at) VALUES('editorial','queued',?,?,?,?)")
                    .run(track.provider, track.id, now, now).lastInsertRowid,
            );
        });
    }

    enqueueEditorialIfEligible(track: Track, now = Date.now()): number | undefined {
        return this.transaction(() => {
            if (!this.canQueueEditorial(track, now)) return undefined;
            this.putTrack(track);
            return Number(
                this.db
                    .prepare("INSERT INTO play_items(kind,state,provider,provider_id,created_at,updated_at) VALUES('editorial','queued',?,?,?,?)")
                    .run(track.provider, track.id, now, now).lastInsertRowid,
            );
        });
    }

    /** Read-only preflight for expensive media staging. Eligibility is checked again at commit. */
    canQueueEditorial(track: Track, now = Date.now()): boolean {
        return this.editorialEligible(track, now, false);
    }

    editorialPipelineCount(): number {
        return asNumber(this.one("SELECT COUNT(*) AS count FROM play_items WHERE kind='editorial' AND state IN ('queued','preparing','ready','playing')").count);
    }

    completedEditorialSince(since: number): number {
        const row = this.db.prepare("SELECT COUNT(*) AS count FROM play_items WHERE kind='editorial' AND state='played' AND updated_at>=?")
            .get(since) as Row;
        return asNumber(row.count);
    }

    /** Current future editorial order for bounded planner context. */
    upcomingEditorial(limit = 6): Array<{ id: number; track: Track; state: 'queued' | 'preparing' | 'ready' }> {
        const bounded = Math.max(0, Math.min(20, Math.trunc(limit)));
        const rows = this.db.prepare(`SELECT p.id,p.state,p.provider,p.provider_id,t.title,t.artist,t.duration_ms
            FROM play_items p JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
            WHERE p.kind='editorial' AND p.state IN ('queued','preparing','ready')
            ORDER BY p.created_at,p.id LIMIT ?`).all(bounded) as Row[];
        return rows.map(row => ({
            id: asNumber(row.id), state: asString(row.state) as 'queued' | 'preparing' | 'ready',
            track: { provider: asString(row.provider) as Track['provider'], id: asString(row.provider_id),
                title: asString(row.title), artist: asString(row.artist), durationMs: asNumber(row.duration_ms) },
        }));
    }

    recentPlayed(limit = 12, now = Date.now()): RecentSpin[] {
        const bounded = Math.max(0, Math.min(20, Math.trunc(limit)));
        return (this.db.prepare(`SELECT t.title,t.artist,p.updated_at AS played_at FROM play_items p
            JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
            WHERE p.state='played' AND p.updated_at>=? AND p.updated_at<=?
            ORDER BY p.updated_at DESC,p.id DESC LIMIT ?`).all(now - 3 * 86_400_000, now, bounded) as Row[])
            .map(row => ({ title: asString(row.title), artist: asString(row.artist), playedAt: asNumber(row.played_at) }));
    }

    showMemory(now = Date.now()): ShowMemory {
        const day = 86_400_000;
        const earlierSpins: RecentSpin[] = [];
        for (let offset = 1; offset <= 2; offset++) {
            const rows = this.db.prepare(`SELECT t.title,t.artist,p.updated_at AS played_at FROM play_items p
                JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
                WHERE p.state='played' AND p.updated_at>=? AND p.updated_at<?
                ORDER BY p.updated_at DESC,p.id DESC LIMIT 5`).all(now - (offset + 1) * day, now - offset * day) as Row[];
            earlierSpins.push(...rows.map(row => ({ title: asString(row.title), artist: asString(row.artist), playedAt: asNumber(row.played_at) })));
        }
        const themes = this.db.prepare(`SELECT json_extract(payload,'$.theme') AS theme,created_at
            FROM events WHERE kind='show.plan' AND created_at>=? AND created_at<=?
            ORDER BY created_at DESC,id DESC LIMIT 8`).all(now - 3 * day, now) as Row[];
        const signals = this.db.prepare(`
            SELECT kind,text,user_name,created_at FROM (
                SELECT 'request' AS kind,substr(t.artist || ' — ' || t.title,1,180) AS text,r.user_name,r.created_at
                FROM requests r JOIN play_items p ON p.id=r.play_item_id
                JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
                WHERE (r.status='fulfilled' OR (r.status='pending' AND r.expires_at>?))
                  AND r.created_at>=? AND r.created_at<=?
                UNION ALL
                SELECT 'studio' AS kind,substr(s.message,1,180) AS text,s.user_name,s.created_at
                FROM studio_messages s WHERE (s.status='aired' OR (s.status='pending' AND s.expires_at>?))
                  AND s.created_at>=? AND s.created_at<=?
            ) ORDER BY created_at DESC LIMIT 6`).all(now, now - 3 * day, now, now, now - 3 * day, now) as Row[];
        // Child turns preserve the actual speaker order in joint shows. Legacy
        // single-host segments retain their old row as the spoken turn.
        const spoken = `SELECT t.text AS script,t.host_id,s.id AS segment_id,t.ordinal,
                COALESCE(s.aired_at,s.created_at) AS aired_at
            FROM host_segment_turns t JOIN host_segments s ON s.id=t.segment_id WHERE s.status='played'
            UNION ALL
            SELECT s.script,s.host_id,s.id AS segment_id,0 AS ordinal,
                COALESCE(s.aired_at,s.created_at) AS aired_at
            FROM host_segments s WHERE s.status='played' AND NOT EXISTS
                (SELECT 1 FROM host_segment_turns t WHERE t.segment_id=s.id)`;
        const hostLines = this.db.prepare(`SELECT script FROM (${spoken}) WHERE aired_at>=? AND aired_at<=?
            ORDER BY aired_at DESC,segment_id DESC,ordinal DESC LIMIT 24`).all(now - day, now) as Row[];
        const hostTurns = this.db.prepare(`SELECT host_id,script,aired_at FROM (${spoken})
            WHERE host_id IS NOT NULL AND aired_at>=? AND aired_at<=?
            ORDER BY aired_at DESC,segment_id DESC,ordinal DESC LIMIT 24`).all(now - day, now) as Row[];
        const earlierHostLines: Array<{ text: string; createdAt: number }> = [];
        for (let offset = 1; offset <= 2; offset++) {
            const rows = this.db.prepare(`SELECT script,aired_at FROM (${spoken}) WHERE aired_at>=? AND aired_at<?
                ORDER BY aired_at DESC,segment_id DESC,ordinal DESC LIMIT 3`).all(now - (offset + 1) * day, now - offset * day) as Row[];
            earlierHostLines.push(...rows.map(row => ({ text: asString(row.script), createdAt: asNumber(row.aired_at) })));
        }
        return {
            earlierSpins,
            recentThemes: themes.filter(row => typeof row.theme === 'string').map(row => ({ theme: asString(row.theme), createdAt: asNumber(row.created_at) })),
            listenerSignals: signals.map(row => ({ kind: asString(row.kind) as 'request' | 'studio', text: asString(row.text), userName: asString(row.user_name), createdAt: asNumber(row.created_at) })),
            hostLines: hostLines.map(row => asString(row.script)),
            hostTurns: hostTurns.map(row => ({ hostId: asString(row.host_id) as HostId,
                text: asString(row.script), airedAt: asNumber(row.aired_at) })),
            earlierHostLines,
        };
    }

    currentShowPlan(now = Date.now()): ShowPlan | undefined {
        const row = this.db.prepare('SELECT * FROM show_plan WHERE id=1 AND expires_at>?').get(now) as Row | undefined;
        return row ? this.rowToShowPlan(row) : undefined;
    }

    ensureFallbackShowPlan(proposal: ShowPlanProposal, now = Date.now()): ShowPlan {
        const valid = validateShowProposal(proposal);
        return this.transaction(() => {
            const row = this.db.prepare('SELECT * FROM show_plan WHERE id=1').get() as Row | undefined;
            if (row && asNumber(row.expires_at) > now &&
                (asString(row.source) === 'model' || asString(row.queries_json) === JSON.stringify(valid.queries))) return this.rowToShowPlan(row);
            const revision = row ? asNumber(row.revision) + 1 : 1;
            this.db.prepare(`INSERT INTO show_plan(id,revision,theme,queries_json,source,request_run,created_at,expires_at)
                VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                revision=excluded.revision,theme=excluded.theme,queries_json=excluded.queries_json,
                source=excluded.source,request_run=excluded.request_run,created_at=excluded.created_at,expires_at=excluded.expires_at`)
                .run(revision, valid.theme, JSON.stringify(valid.queries), 'fallback', valid.requestRun, now, now + SHOW_PLAN_TTL_MS);
            this.event('show.plan', { revision, theme: valid.theme, source: 'fallback' }, now);
            this.db.prepare("DELETE FROM events WHERE kind='show.plan' AND created_at<?").run(now - 7 * 86_400_000);
            return { revision, theme: valid.theme, queries: [...valid.queries], source: 'fallback', requestRun: valid.requestRun, createdAt: now, expiresAt: now + SHOW_PLAN_TTL_MS };
        });
    }

    replaceShowPlan(expectedRevision: number, proposal: ShowPlanProposal, now = Date.now()): ShowPlan | undefined {
        const valid = validateShowProposal(proposal);
        const revision = expectedRevision + 1;
        return this.transaction(() => {
            const result = this.db.prepare(`UPDATE show_plan SET revision=?,theme=?,queries_json=?,source='model',request_run=?,created_at=?,expires_at=?
                WHERE id=1 AND revision=? AND expires_at>?`)
                .run(revision, valid.theme, JSON.stringify(valid.queries), valid.requestRun, now, now + SHOW_PLAN_TTL_MS, expectedRevision, now);
            if (result.changes !== 1) return undefined;
            this.event('show.plan', { revision, theme: valid.theme, source: 'model' }, now);
            this.db.prepare("DELETE FROM events WHERE kind='show.plan' AND created_at<?").run(now - 7 * 86_400_000);
            return { revision, theme: valid.theme, queries: [...valid.queries], source: 'model', requestRun: valid.requestRun, createdAt: now, expiresAt: now + SHOW_PLAN_TTL_MS };
        });
    }

    /** Commit fresh prepared music. A new host can drop the old host's bridge once fresh media is ready. */
    applyEditorialPlan(
        expectedRevision: number,
        proposal: ShowPlanProposal,
        staged: Array<{ track: Track; localPath: string }>,
        now = Date.now(),
        keepContinuityBridge = true,
    ): ShowPlan | undefined {
        const valid = validateShowProposal(proposal);
        if (staged.length < 1) return undefined;
        return this.transaction(() => {
            const plan = this.db.prepare('SELECT revision,expires_at FROM show_plan WHERE id=1').get() as Row | undefined;
            if (!plan || asNumber(plan.revision) !== expectedRevision || asNumber(plan.expires_at) <= now) return undefined;

            const seen = new Set<string>();
            const seenSongs = new Set<string>();
            const seenArtists = new Set<string>();
            for (const { track, localPath } of staged) {
                if (!localPath.trim()) return undefined;
                const key = `${track.provider}\0${track.id}`;
                const identity = songKey(track);
                const artist = metadataKey(track.artist);
                if (seen.has(key) || seenSongs.has(identity) || seenArtists.has(artist)) return undefined;
                seen.add(key);
                seenSongs.add(identity);
                seenArtists.add(artist);
                if (!this.editorialEligible(track, now, true)) return undefined;
            }

            const revision = expectedRevision + 1;
            const updated = this.db.prepare(`UPDATE show_plan SET revision=?,theme=?,queries_json=?,source='model',request_run=?,created_at=?,expires_at=?
                WHERE id=1 AND revision=? AND expires_at>?`)
                .run(revision, valid.theme, JSON.stringify(valid.queries), valid.requestRun, now, now + SHOW_PLAN_TTL_MS, expectedRevision, now);
            if (updated.changes !== 1) return undefined;
            this.db.prepare("UPDATE play_items SET state='expired',updated_at=? WHERE kind='editorial' AND state IN ('queued','preparing')").run(now);
            const bridge = keepContinuityBridge ? this.db.prepare(
                "SELECT id FROM play_items WHERE kind='editorial' AND state='ready' ORDER BY created_at,id LIMIT 1",
            ).get() as Row | undefined : undefined;
            this.db.prepare("UPDATE play_items SET state='expired',updated_at=? WHERE kind='editorial' AND state='ready' AND id<>?")
                .run(now, bridge ? asNumber(bridge.id) : -1);
            const insert = this.db.prepare(`INSERT INTO play_items(kind,state,provider,provider_id,local_path,created_at,updated_at)
                VALUES('editorial','ready',?,?,?,?,?)`);
            for (const [index, { track, localPath }] of staged.entries()) {
                this.putTrack(track);
                insert.run(track.provider, track.id, localPath, now + index, now);
            }
            this.event('show.plan', { revision, theme: valid.theme, source: 'model' }, now);
            this.db.prepare("DELETE FROM events WHERE kind='show.plan' AND created_at<?").run(now - 7 * 86_400_000);
            return { revision, theme: valid.theme, queries: [...valid.queries], source: 'model', requestRun: valid.requestRun,
                createdAt: now, expiresAt: now + SHOW_PLAN_TTL_MS };
        });
    }

    private rowToShowPlan(row: Row): ShowPlan {
        return {
            revision: asNumber(row.revision),
            theme: asString(row.theme),
            queries: JSON.parse(asString(row.queries_json)) as string[],
            source: asString(row.source) as ShowPlan['source'],
            requestRun: asString(row.request_run) as ShowPlan['requestRun'],
            createdAt: asNumber(row.created_at),
            expiresAt: asNumber(row.expires_at),
        };
    }

    addRequest(input: RequestInput, requiresHostDecision = false): RequestDecision {
        return this.transaction(() => {
            this.expire(input.now);
            if (!input.isOwner) {
                const previous = this.db.prepare(
                    `SELECT r.id,r.play_item_id,
                            EXISTS(SELECT 1 FROM requests earlier WHERE earlier.play_item_id=r.play_item_id AND earlier.id<r.id) AS merged
                     FROM requests r JOIN play_items p ON p.id=r.play_item_id
                     WHERE r.guild_id=? AND r.user_id=? AND r.status='pending'
                       AND p.provider=? AND p.provider_id=? AND r.dedication IS ?
                       AND r.created_at BETWEEN ? AND ? ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
                ).get(input.guildId, input.userId, input.track.provider, input.track.id, input.dedication ?? null,
                    input.now - RadioStore.listenerRetryWindowMs, input.now) as Row | undefined;
                if (previous) return { accepted: true, requestId: asNumber(previous.id), itemId: asNumber(previous.play_item_id), merged: Boolean(previous.merged), duplicateSubmission: true };
            }
            const active = this.one('SELECT COUNT(*) AS count FROM requests WHERE user_id=? AND status=\'pending\'', input.userId);
            if (!input.isOwner && asNumber(active.count) >= 1) return { accepted: false, reason: 'У вас уже есть активная заявка.' };
            const recent = this.one('SELECT MAX(created_at) AS created_at FROM requests WHERE user_id=?', input.userId);
            if (!input.isOwner && recent.created_at !== null && input.now - asNumber(recent.created_at) < this.policy.requestCooldownMs) {
                return { accepted: false, reason: `Повторную заявку можно отправить через ${Math.ceil(this.policy.requestCooldownMs / 60_000)} минут.` };
            }
            const guild = this.one("SELECT COUNT(*) AS count FROM requests WHERE guild_id=? AND status='pending'", input.guildId);
            if (!input.isOwner && asNumber(guild.count) >= 8) return { accepted: false, reason: 'На этом сервере уже восемь заявок.' };
            const global = this.one("SELECT COUNT(*) AS count FROM requests WHERE status='pending'");
            if (!input.isOwner && asNumber(global.count) >= 20) return { accepted: false, reason: 'Общая очередь заявок заполнена.' };

            if (this.failedTrackRecently(input.track, input.now)) {
                return { accepted: false, reason: 'Этот трек временно недоступен. Попробуйте другую композицию.' };
            }

            const trackPlayed = this.one(
                `SELECT MAX(p.updated_at) AS at FROM play_items p
                 JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
                 WHERE p.state='played' AND (p.provider=? AND p.provider_id=? OR t.song_key=?)`,
                input.track.provider, input.track.id, songKey(input.track),
            );
            if (!input.isOwner && trackPlayed.at !== null && input.now - asNumber(trackPlayed.at) < this.policy.trackCooldownMs) {
                return { accepted: false, reason: 'Этот трек недавно звучал в эфире.' };
            }
            const artistPlayed = this.one(
                `SELECT MAX(p.updated_at) AS at FROM play_items p JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
                 WHERE p.state='played' AND t.artist_key=?`,
                metadataKey(input.track.artist),
            );
            if (!input.isOwner && artistPlayed.at !== null && input.now - asNumber(artistPlayed.at) < this.policy.artistCooldownMs) {
                return { accepted: false, reason: 'Этот исполнитель недавно звучал в эфире.' };
            }

            this.putTrack(input.track);
            const duplicate = this.db
                .prepare(
                    `SELECT p.id FROM play_items p JOIN requests r ON r.play_item_id=p.id
                     WHERE p.provider=? AND p.provider_id=? AND p.state IN ('queued','preparing','ready') AND r.status='pending' LIMIT 1`,
                )
                .get(input.track.provider, input.track.id) as Row | undefined;
            let itemId: number;
            if (duplicate) {
                itemId = asNumber(duplicate.id);
            } else {
                itemId = Number(
                    this.db
                        .prepare("INSERT INTO play_items(kind,state,provider,provider_id,created_at,updated_at) VALUES('request','queued',?,?,?,?)")
                        .run(input.track.provider, input.track.id, input.now, input.now).lastInsertRowid,
                );
            }
            const result = this.db
                .prepare(
                    "INSERT INTO requests(play_item_id,guild_id,user_id,user_name,dedication,status,created_at,expires_at,host_decision,decided_at) VALUES(?,?,?,?,?,'pending',?,?,?,?)",
                )
                .run(itemId, input.guildId, input.userId, input.userName, input.dedication ?? null, input.now, input.now + this.policy.requestTtlMs,
                    requiresHostDecision ? 'pending' : 'select', requiresHostDecision ? null : input.now);
            this.event('request.accepted', { requestId: Number(result.lastInsertRowid), itemId, merged: Boolean(duplicate) }, input.now);
            return { accepted: true, requestId: Number(result.lastInsertRowid), itemId, merged: Boolean(duplicate) };
        });
    }

    addStudioMessage(input: StudioInput, requiresHostDecision = false): StudioDecision {
        return this.transaction(() => {
            this.expire(input.now);
            if (!input.isOwner) {
                const previous = this.db.prepare(
                    `SELECT id FROM studio_messages WHERE guild_id=? AND user_id=? AND message=?
                       AND status IN ('pending','aired') AND created_at BETWEEN ? AND ?
                     ORDER BY created_at DESC,id DESC LIMIT 1`,
                ).get(input.guildId, input.userId, input.message, input.now - RadioStore.listenerRetryWindowMs, input.now) as Row | undefined;
                if (previous) return { accepted: true, messageId: asNumber(previous.id), duplicateSubmission: true };
            }
            const recent = this.one('SELECT MAX(created_at) AS created_at FROM studio_messages WHERE user_id=?', input.userId);
            if (!input.isOwner && recent.created_at !== null && input.now - asNumber(recent.created_at) < this.policy.studioCooldownMs) {
                return { accepted: false, reason: `Новое письмо в студию можно отправить через ${Math.ceil(this.policy.studioCooldownMs / 60_000)} минут.` };
            }
            const pending = this.one("SELECT COUNT(*) AS count FROM studio_messages WHERE status='pending'");
            if (!input.isOwner && asNumber(pending.count) >= 10) return { accepted: false, reason: 'Студийная почта временно заполнена.' };
            const result = this.db
                .prepare(
                    "INSERT INTO studio_messages(guild_id,user_id,user_name,message,status,created_at,expires_at,host_decision,decided_at) VALUES(?,?,?,?,'pending',?,?,?,?)",
                )
                .run(input.guildId, input.userId, input.userName, input.message, input.now, input.now + this.policy.studioTtlMs,
                    requiresHostDecision ? 'pending' : 'select', requiresHostDecision ? null : input.now);
            return { accepted: true, messageId: Number(result.lastInsertRowid) };
        });
    }

    pendingHostInputs(limit = 20, now = Date.now()): HostInput[] {
        const bounded = Math.max(0, Math.min(50, Math.trunc(limit)));
        if (bounded === 0) return [];
        this.expire(now);
        const rows = this.db.prepare(`
            SELECT 'request' AS kind,r.id,r.guild_id,r.user_id,r.user_name,r.dedication,NULL AS message,
                   r.created_at,r.expires_at,t.provider,t.provider_id,t.title,t.artist,t.duration_ms
            FROM requests r JOIN play_items p ON p.id=r.play_item_id
            JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
            WHERE r.status='pending' AND r.host_decision='pending' AND r.expires_at>?
              AND p.state IN ('queued','preparing','ready')
            UNION ALL
            SELECT 'studio' AS kind,s.id,s.guild_id,s.user_id,s.user_name,NULL AS dedication,s.message,
                   s.created_at,s.expires_at,NULL AS provider,NULL AS provider_id,NULL AS title,NULL AS artist,NULL AS duration_ms
            FROM studio_messages s WHERE s.status='pending' AND s.host_decision='pending' AND s.expires_at>?
            ORDER BY created_at,id LIMIT ?
        `).all(now, now, bounded) as Row[];
        return rows.map(row => {
            const common = {
                id: asNumber(row.id), guildId: asString(row.guild_id), userId: asString(row.user_id),
                userName: asString(row.user_name), createdAt: asNumber(row.created_at), expiresAt: asNumber(row.expires_at),
            };
            if (row.kind === 'studio') return { ...common, kind: 'studio' as const, message: asString(row.message) };
            return {
                ...common, kind: 'request' as const, ...(row.dedication ? { dedication: asString(row.dedication) } : {}),
                track: { provider: asString(row.provider) as Track['provider'], id: asString(row.provider_id),
                    title: asString(row.title), artist: asString(row.artist), durationMs: asNumber(row.duration_ms) },
            };
        });
    }

    decideHostInput(kind: 'request' | 'studio', id: number, decision: HostInputDecision, now = Date.now()): boolean {
        if (kind !== 'request' && kind !== 'studio') return false;
        if (decision.choice !== 'select' && decision.choice !== 'defer' && decision.choice !== 'decline') return false;
        if (decision.choice === 'defer' && (!Number.isInteger(decision.deferMinutes) || decision.deferMinutes < 1 || decision.deferMinutes > 15)) {
            return false;
        }
        return this.transaction(() => {
            this.expire(now);
            const table = kind === 'request' ? 'requests' : 'studio_messages';
            const eligibleAfter = decision.choice === 'defer' ? now + decision.deferMinutes * 60_000 : null;
            const result = this.db.prepare(`UPDATE ${table} SET host_decision=?,eligible_after=?,decided_at=?,
                status=CASE WHEN ?='decline' THEN 'rejected' ELSE status END
                WHERE id=? AND status='pending' AND host_decision='pending' AND expires_at>?`)
                .run(decision.choice, eligibleAfter, now, decision.choice, id, now);
            if (result.changes !== 1) return false;
            if (kind === 'request' && decision.choice === 'decline') {
                const row = this.db.prepare('SELECT play_item_id FROM requests WHERE id=?').get(id) as Row;
                const itemId = asNumber(row.play_item_id);
                const remaining = asNumber(this.one("SELECT COUNT(*) AS count FROM requests WHERE play_item_id=? AND status='pending'", itemId).count);
                if (remaining === 0) this.db.prepare("UPDATE play_items SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('queued','preparing','ready')")
                    .run('Отклонено ведущим.', now, itemId);
            }
            if (decision.choice !== 'select') {
                const recipient = this.db.prepare(`SELECT guild_id,user_id FROM ${table} WHERE id=?`).get(id) as Row;
                const message = kind === 'request'
                    ? decision.choice === 'decline' ? 'Ведущий решил не ставить вашу заявку в эфир.' : 'Ведущий планирует вашу заявку позже; если эфир останется без другой музыки, она может прозвучать раньше.'
                    : decision.choice === 'decline' ? 'Ведущий решил не брать ваше письмо в эфир.' : 'Ведущий отложил ваше письмо. Оно остаётся в ожидании.';
                this.db.prepare(`INSERT INTO host_notifications(kind,input_id,guild_id,user_id,message,status,attempts,next_attempt_at,created_at)
                    VALUES(?,?,?,?,?,'pending',0,?,?) ON CONFLICT(kind,input_id) DO NOTHING`)
                    .run(kind, id, asSqlValue(recipient.guild_id), asSqlValue(recipient.user_id), message, now, now);
            }
            this.event(`host.${kind}.${decision.choice}`, { id, ...(eligibleAfter === null ? {} : { eligibleAfter }) }, now);
            return true;
        });
    }

    dueHostNotification(now = Date.now()): HostNotification | undefined {
        return this.transaction(() => {
            this.db.prepare("UPDATE host_notifications SET status='failed' WHERE status='pending' AND attempts>=? AND next_attempt_at<=?")
                .run(RadioStore.maxNotificationAttempts, now);
            const row = this.db.prepare(`SELECT * FROM host_notifications WHERE status='pending' AND attempts<? AND next_attempt_at<=?
                ORDER BY next_attempt_at,id LIMIT 1`).get(RadioStore.maxNotificationAttempts, now) as Row | undefined;
            if (!row) return undefined;
            this.db.prepare('UPDATE host_notifications SET attempts=attempts+1,next_attempt_at=? WHERE id=?')
                .run(now + RadioStore.notificationLeaseMs, asSqlValue(row.id));
            return {
                id: asNumber(row.id), kind: asString(row.kind) as HostNotification['kind'], inputId: asNumber(row.input_id),
                guildId: asString(row.guild_id), userId: asString(row.user_id), message: asString(row.message),
                attempts: asNumber(row.attempts) + 1, nextAttemptAt: now + RadioStore.notificationLeaseMs,
                createdAt: asNumber(row.created_at),
            };
        });
    }

    completeHostNotification(id: number, ok: boolean, now = Date.now(), expectedAttempt?: number): boolean {
        return this.transaction(() => {
            const row = this.db.prepare('SELECT attempts,next_attempt_at FROM host_notifications WHERE id=? AND status=\'pending\'').get(id) as Row | undefined;
            if (!row || asNumber(row.attempts) < 1 || asNumber(row.next_attempt_at) <= now
                || (expectedAttempt !== undefined && asNumber(row.attempts) !== expectedAttempt)) return false;
            const attempts = asNumber(row.attempts);
            const status = ok ? 'sent' : attempts >= RadioStore.maxNotificationAttempts ? 'failed' : 'pending';
            const nextAttemptAt = ok || status === 'failed' ? asNumber(row.next_attempt_at) : now + 60_000 * 2 ** (attempts - 1);
            const result = this.db.prepare('UPDATE host_notifications SET status=?,next_attempt_at=? WHERE id=? AND status=\'pending\' AND attempts=?')
                .run(status, nextAttemptAt, id, attempts);
            if (result.changes === 1) this.event(`host.notification.${status}`, { id, attempts }, now);
            return result.changes === 1;
        });
    }

    listenerInputs(userId: string, guildId: string, limit = 10): ListenerInput[] {
        const bounded = Math.max(0, Math.min(20, Math.trunc(limit)));
        if (bounded === 0 || !userId || !guildId) return [];
        const rows = this.db.prepare(`
            SELECT 'request' AS kind,r.id,r.status,r.host_decision,r.created_at,r.decided_at,r.eligible_after,
                   t.artist || ' — ' || t.title AS label
            FROM requests r JOIN play_items p ON p.id=r.play_item_id
            JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
            WHERE r.user_id=? AND r.guild_id=?
            UNION ALL
            SELECT 'studio' AS kind,s.id,s.status,s.host_decision,s.created_at,s.decided_at,s.eligible_after,
                   'Письмо в студию' AS label
            FROM studio_messages s WHERE s.user_id=? AND s.guild_id=?
            ORDER BY created_at DESC,id DESC LIMIT ?
        `).all(userId, guildId, userId, guildId, bounded) as Row[];
        return rows.map(row => ({
            kind: asString(row.kind) as ListenerInput['kind'], id: asNumber(row.id), status: asString(row.status),
            hostDecision: asString(row.host_decision) as ListenerInput['hostDecision'], createdAt: asNumber(row.created_at),
            ...(row.decided_at === null ? {} : { decidedAt: asNumber(row.decided_at) }),
            ...(row.eligible_after === null ? {} : { eligibleAfter: asNumber(row.eligible_after) }),
            label: asString(row.label),
        }));
    }

    peekStudioMessage(now = Date.now()): { id: number; userName: string; message: string } | undefined {
        this.expire(now);
        const last = Number(this.setting('last_studio_aired_at') ?? '0');
        if (last > 0 && now - last < this.policy.studioCooldownMs) return undefined;
        const row = this.db.prepare(`SELECT id,user_name,message FROM studio_messages WHERE status='pending'
            AND (host_decision='select' OR (host_decision='defer' AND eligible_after<=?))
            ORDER BY created_at,id LIMIT 1`).get(now) as Row | undefined;
        return row ? { id: asNumber(row.id), userName: asString(row.user_name), message: asString(row.message) } : undefined;
    }

    markStudioAired(id: number, now = Date.now()): boolean {
        return this.transaction(() => {
            const result = this.db.prepare(`UPDATE studio_messages SET status='aired' WHERE id=? AND status='pending' AND expires_at>?
                AND (host_decision='select' OR (host_decision='defer' AND eligible_after<=?))`).run(id, now, now);
            if (result.changes === 1) this.setSetting('last_studio_aired_at', String(now));
            return result.changes === 1;
        });
    }

    studioMessageCanAir(id: number, now = Date.now()): boolean {
        this.expire(now);
        const row = this.db.prepare(`SELECT 1 AS eligible FROM studio_messages WHERE id=? AND status='pending' AND expires_at>?
            AND (host_decision='select' OR (host_decision='defer' AND eligible_after<=?))`).get(id, now, now);
        return row !== undefined;
    }

    rejectStudioMessage(id: number, reason: string, now = Date.now()): boolean {
        return this.transaction(() => {
            const result = this.db.prepare("UPDATE studio_messages SET status='rejected' WHERE id=? AND status='pending'").run(id);
            if (result.changes === 1) this.event('studio.rejected', { messageId: id, reason }, now);
            return result.changes === 1;
        });
    }

    recordHostSegment(playItemId: number, script: string, localPath: string, now = Date.now(),
        attribution?: { hostId: HostId; shiftId?: number }, turns?: readonly HostSegmentTurn[]): number | undefined {
        if (turns && (turns.length < 2 || turns.length > 3 || turns.some(turn =>
            !HOST_IDS.includes(turn.hostId) || !turn.modelId || !turn.voiceId || !turn.text))) {
            throw new RangeError('Invalid joint host turns');
        }
        return this.transaction(() => {
            const active = this.db.prepare("SELECT 1 FROM play_items WHERE id=? AND state IN ('queued','preparing','ready')").get(playItemId);
            if (!active) return undefined;
            const result = this.db.prepare(
                "INSERT INTO host_segments(play_item_id,script,local_path,status,created_at,host_id,host_shift_id) VALUES(?,?,?,'ready',?,?,?)",
            ).run(playItemId, script, localPath, now, attribution?.hostId ?? null, attribution?.shiftId ?? null);
            const segmentId = Number(result.lastInsertRowid);
            if (turns) {
                const insert = this.db.prepare(`INSERT INTO host_segment_turns(segment_id,ordinal,host_id,model_id,voice_id,text)
                    VALUES(?,?,?,?,?,?)`);
                for (const [ordinal, turn] of turns.entries()) {
                    insert.run(segmentId, ordinal, turn.hostId, turn.modelId, turn.voiceId, turn.text);
                }
            }
            return segmentId;
        });
    }

    markHostSegmentPlayed(id: number, now = Date.now(), shiftId?: number): boolean {
        return this.db.prepare("UPDATE host_segments SET status='played',aired_at=?,host_shift_id=COALESCE(?,host_shift_id) WHERE id=? AND status='ready'")
            .run(now, shiftId ?? null, id).changes === 1;
    }

    discardHostSegment(id: number): boolean {
        return this.db.prepare("UPDATE host_segments SET status='failed' WHERE id=? AND status='ready'").run(id).changes === 1;
    }

    recentShowSizes(limit = 100): { solo: number; pair: number; trio: number } {
        const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
        const rows = this.db.prepare(`SELECT (SELECT COUNT(*) FROM host_segment_turns t WHERE t.segment_id=s.id) AS turns
            FROM host_segments s WHERE s.status='played'
            ORDER BY COALESCE(s.aired_at,s.created_at) DESC,s.id DESC LIMIT ?`).all(safeLimit) as Row[];
        return rows.reduce<{ solo: number; pair: number; trio: number }>((counts, row) => {
            const turns = asNumber(row.turns);
            if (turns === 2) counts.pair++;
            else if (turns === 3) counts.trio++;
            else counts.solo++;
            return counts;
        }, { solo: 0, pair: 0, trio: 0 });
    }

    jingleDue(intervalMs: number, now = Date.now()): boolean {
        if (intervalMs <= 0) return false;
        const anchor = this.setting('last_jingle_at') ?? this.setting('jingle_anchor_at');
        if (!anchor) {
            this.setSetting('jingle_anchor_at', String(now));
            return false;
        }
        return now - Number(anchor) >= intervalMs;
    }

    markJingleAired(now = Date.now()): void {
        this.setSetting('last_jingle_at', String(now));
    }

    requestContext(playItemId: number): { userName: string; dedication?: string } | undefined {
        const rows = this.db
            .prepare("SELECT user_id,user_name,dedication FROM requests WHERE play_item_id=? AND status='pending' ORDER BY created_at,id")
            .all(playItemId) as Row[];
        if (rows.length === 0) return undefined;
        const names = [...new Map(rows.map(row => [asString(row.user_id), asString(row.user_name)])).values()];
        const userName = names.length <= 2 ? names.join(' и ') : `${names[0]}, ${names[1]} и другие слушатели`;
        const dedication = rows.find(row => row.dedication)?.dedication;
        return { userName, ...(dedication ? { dedication: asString(dedication) } : {}) };
    }

    expire(now = Date.now()): void {
        this.db.prepare("UPDATE requests SET status='expired' WHERE status='pending' AND expires_at<=?").run(now);
        this.db.prepare("UPDATE studio_messages SET status='expired' WHERE status='pending' AND expires_at<=?").run(now);
        this.db.prepare(
            `UPDATE play_items SET state='expired',updated_at=? WHERE kind='request' AND state IN ('queued','preparing','ready')
             AND NOT EXISTS(SELECT 1 FROM requests WHERE requests.play_item_id=play_items.id AND requests.status='pending')`,
        ).run(now);
    }

    claimPreparation(now = Date.now()): QueueItem | undefined {
        return this.transaction(() => {
            this.expire(now);
            const row = this.itemRow("WHERE p.state='queued' AND p.retry_at<=? ORDER BY p.created_at,p.id LIMIT 1", now);
            if (!row) return undefined;
            this.db.prepare("UPDATE play_items SET state='preparing',preparation_attempts=preparation_attempts+1,updated_at=? WHERE id=? AND state='queued'").run(now, asSqlValue(row.id));
            return this.rowToItem({ ...row, state: 'preparing', updated_at: now });
        });
    }

    preparationAttempts(id: number): number {
        return asNumber(this.one('SELECT preparation_attempts AS count FROM play_items WHERE id=?', id).count);
    }

    deferPreparation(id: number, reason: string, retryAt: number, now = Date.now()): boolean {
        return this.transaction(() => {
            const updated = this.db.prepare("UPDATE play_items SET state='queued',error=?,retry_at=?,updated_at=? WHERE id=? AND state='preparing'")
                .run(reason, retryAt, now, id);
            if (updated.changes === 1) this.event('play.preparation_deferred', { itemId: id, retryAt }, now);
            return updated.changes === 1;
        });
    }

    markReady(id: number, localPath: string, now = Date.now()): boolean {
        const result = this.db.prepare("UPDATE play_items SET state='ready',local_path=?,updated_at=?,error=NULL WHERE id=? AND state='preparing'").run(localPath, now, id);
        return result.changes === 1;
    }

    updatePlayingPath(id: number, localPath: string, now = Date.now()): boolean {
        const result = this.db.prepare("UPDATE play_items SET local_path=?,updated_at=?,error=NULL WHERE id=? AND state='playing'").run(localPath, now, id);
        return result.changes === 1;
    }

    failItem(id: number, reason: string, now = Date.now()): void {
        this.transaction(() => {
            const wasPlaying = this.db.prepare("SELECT 1 AS found FROM play_items WHERE id=? AND state='playing'").get(id) !== undefined;
            const updated = this.db.prepare("UPDATE play_items SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('queued','preparing','ready','playing')").run(reason, now, id);
            if (updated.changes === 0) return;
            const failedTrack = this.db.prepare('SELECT provider,provider_id FROM play_items WHERE id=?').get(id) as Row | undefined;
            if (failedTrack?.provider && failedTrack.provider_id) {
                this.recordTrackQuarantine(asString(failedTrack.provider), asString(failedTrack.provider_id), reason, now);
            }
            if (wasPlaying) this.restoreProgrammeBeforeClaim(id);
            this.db.prepare("UPDATE requests SET status='rejected' WHERE play_item_id=? AND status='pending'").run(id);
            this.event('play.failed', { itemId: id, reason }, now);
        });
    }

    /** A verified catalog candidate can fail before it becomes a play item. */
    quarantineFailedCandidate(track: Track, reason: string, now = Date.now()): void {
        this.transaction(() => {
            this.putTrack(track);
            this.recordTrackQuarantine(track.provider, track.id, reason, now);
        });
    }

    private recordTrackQuarantine(provider: string, providerId: string, reason: string, now: number): void {
        this.db.prepare(`INSERT INTO track_quarantine(provider,provider_id,failed_at,retry_after) VALUES(?,?,?,?)
            ON CONFLICT(provider,provider_id) DO UPDATE SET failed_at=excluded.failed_at,
                retry_after=MAX(track_quarantine.retry_after,excluded.retry_after)`)
            .run(provider, providerId, now, now + RadioStore.quarantineMs(reason));
    }

    nextForPlayback(now = Date.now()): QueueItem | undefined {
        return this.transaction(() => {
            this.expire(now);
            const editorial = this.itemRow("WHERE p.state='ready' AND p.kind='editorial' ORDER BY p.created_at,p.id LIMIT 1");
            const requests = this.requestCandidates(now);
            const lastKind = this.setting('last_kind');
            const editorials = Number(this.setting('editorials_since_request') ?? '0');
            const threshold = this.pendingRequestCount() > 6 ? 1 : 2;
            let selected: Row | undefined;
            const continueRequests = lastKind === 'request' && this.currentShowPlan(now)?.requestRun === 'continue';
            if (requests.length > 0 && ((lastKind !== 'request' && editorials >= threshold) || continueRequests)) selected = this.roundRobin(requests);
            // A ready request may override an undecided host input when it is the only playable music.
            if (!selected) selected = editorial ?? this.roundRobin(requests) ?? this.roundRobin(this.requestCandidates(now, true));
            if (!selected) return undefined;
            const updated = this.db.prepare("UPDATE play_items SET state='playing',updated_at=? WHERE id=? AND state='ready'").run(now, asSqlValue(selected.id));
            if (updated.changes !== 1) return undefined;
            if (selected.kind === 'request') {
                const coalesced = this.db.prepare(`SELECT id,host_decision FROM requests
                    WHERE play_item_id=? AND status='pending' AND host_decision IN ('pending','defer')`)
                    .all(asSqlValue(selected.id)) as Row[];
                this.db.prepare(`UPDATE requests SET host_decision='select',eligible_after=NULL,decided_at=?
                    WHERE play_item_id=? AND status='pending' AND host_decision IN ('pending','defer')`).run(now, asSqlValue(selected.id));
                for (const request of coalesced) this.event('host.request.coalesced', {
                    requestId: asNumber(request.id), itemId: asNumber(selected.id), previousDecision: asString(request.host_decision),
                }, now);
            }
            this.setSetting('play_claim_id', asString(selected.id));
            this.setSetting('play_claim_previous_kind', lastKind ?? '');
            this.setSetting('play_claim_previous_editorials', String(editorials));
            this.setSetting('play_claim_previous_request_guild', this.setting('last_request_guild') ?? '');
            const kind = asString(selected.kind);
            this.setSetting('last_kind', kind);
            if (kind === 'request') {
                this.setSetting('editorials_since_request', '0');
                if (selected.guild_id) this.setSetting('last_request_guild', asString(selected.guild_id));
            } else if (kind === 'editorial') {
                this.setSetting('editorials_since_request', String(editorials + 1));
            }
            return this.rowToItem({ ...selected, state: 'playing', updated_at: now });
        });
    }

    finishItem(id: number, now = Date.now()): void {
        this.transaction(() => {
            const updated = this.db.prepare("UPDATE play_items SET state='played',updated_at=? WHERE id=? AND state='playing'").run(now, id);
            if (updated.changes !== 1) return;
            this.clearProgrammeClaim(id);
            this.db.prepare("UPDATE requests SET status='fulfilled' WHERE play_item_id=? AND status='pending'").run(id);
            this.event('play.finished', { itemId: id }, now);
        });
    }

    skipItem(id: number, now = Date.now()): boolean {
        return this.transaction(() => {
            const updated = this.db.prepare("UPDATE play_items SET state='interrupted',error=?,updated_at=? WHERE id=? AND state='playing'")
                .run('Playback skipped by owner', now, id);
            if (updated.changes !== 1) return false;
            this.restoreProgrammeBeforeClaim(id);
            this.db.prepare("UPDATE requests SET status='rejected' WHERE play_item_id=? AND status='pending'").run(id);
            this.event('play.skipped', { itemId: id }, now);
            return true;
        });
    }

    requeuePlaying(id: number, reason: string, now = Date.now()): boolean {
        return this.transaction(() => {
            const result = this.db.prepare("UPDATE play_items SET state='ready',error=?,updated_at=? WHERE id=? AND state='playing'").run(reason, now, id);
            if (result.changes === 1) {
                this.restoreProgrammeBeforeClaim(id);
                this.event('play.requeued', { itemId: id, reason }, now);
            }
            return result.changes === 1;
        });
    }

    interruptItem(id: number, reason: string, now = Date.now()): void {
        this.db.prepare("UPDATE play_items SET state='interrupted',error=?,updated_at=? WHERE id=? AND state='playing'").run(reason, now, id);
    }

    rejectRequest(requestId: number, reason: string, now = Date.now()): boolean {
        return this.transaction(() => {
            const row = this.db.prepare("SELECT play_item_id FROM requests WHERE id=? AND status='pending'").get(requestId) as Row | undefined;
            if (!row) return false;
            this.db.prepare("UPDATE requests SET status='rejected' WHERE id=? AND status='pending'").run(requestId);
            const itemId = asNumber(row.play_item_id);
            const remaining = asNumber(this.one("SELECT COUNT(*) AS count FROM requests WHERE play_item_id=? AND status='pending'", itemId).count);
            if (remaining === 0) {
                this.db.prepare("UPDATE play_items SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('queued','preparing','ready')").run(reason, now, itemId);
            }
            this.event('request.rejected', { requestId, reason }, now);
            return true;
        });
    }

    current(): QueueItem | undefined {
        const row = this.itemRow("WHERE p.state='playing' ORDER BY p.updated_at DESC LIMIT 1");
        return row ? this.rowToItem(row) : undefined;
    }

    peekNextForPlayback(now = Date.now()): QueueItem | undefined {
        const editorial = this.itemRow("WHERE p.state='ready' AND p.kind='editorial' ORDER BY p.created_at,p.id LIMIT 1");
        const requests = this.requestCandidates(now);
        const lastKind = this.setting('last_kind');
        const editorials = Number(this.setting('editorials_since_request') ?? '0');
        const threshold = this.pendingRequestCount() > 6 ? 1 : 2;
        let selected: Row | undefined;
        const continueRequests = lastKind === 'request' && this.currentShowPlan(now)?.requestRun === 'continue';
        if (requests.length > 0 && ((lastKind !== 'request' && editorials >= threshold) || continueRequests)) selected = this.roundRobin(requests);
        if (!selected) selected = editorial ?? this.roundRobin(requests) ?? this.roundRobin(this.requestCandidates(now, true));
        return selected ? this.rowToItem(selected) : undefined;
    }

    requestRecipients(playItemId: number): Array<{ userId: string; guildId: string }> {
        return (
            this.db
                .prepare("SELECT DISTINCT user_id,guild_id FROM requests WHERE play_item_id=? AND status='pending'")
                .all(playItemId) as Row[]
        ).map(row => ({ userId: asString(row.user_id), guildId: asString(row.guild_id) }));
    }

    counts(): { queued: number; readyTracks: number; pendingRequests: number; pendingStudioMessages: number } {
        return {
            queued: asNumber(this.one("SELECT COUNT(*) AS count FROM play_items WHERE state IN ('queued','preparing','ready')").count),
            readyTracks: asNumber(this.one("SELECT COUNT(*) AS count FROM play_items WHERE state='ready'").count),
            pendingRequests: this.pendingRequestCount(),
            pendingStudioMessages: asNumber(this.one("SELECT COUNT(*) AS count FROM studio_messages WHERE status='pending'").count),
        };
    }

    protectedCachePaths(): Set<string> {
        const rows = this.db
            .prepare("SELECT local_path FROM play_items WHERE local_path IS NOT NULL AND state IN ('ready','playing')")
            .all() as Row[];
        return new Set(rows.map(row => asString(row.local_path)));
    }

    protectedHostPaths(): Set<string> {
        const rows = this.db.prepare("SELECT local_path FROM host_segments WHERE status='ready' AND local_path IS NOT NULL").all() as Row[];
        return new Set(rows.map(row => asString(row.local_path)));
    }

    reserveAiCall(now: number, hourlyLimit: number, dailyLimit: number): boolean {
        return this.transaction(() => {
            const hour = asNumber(this.one("SELECT COUNT(*) AS count FROM events WHERE kind='ai.call' AND created_at>=?", now - 3_600_000).count);
            const day = asNumber(this.one("SELECT COUNT(*) AS count FROM events WHERE kind='ai.call' AND created_at>=?", now - 86_400_000).count);
            // Zero disables the operator-configurable cap while preserving
            // durable call accounting for diagnostics.
            if ((hourlyLimit > 0 && hour >= hourlyLimit) || (dailyLimit > 0 && day >= dailyLimit)) return false;
            this.event('ai.call', {}, now);
            return true;
        });
    }

    saveGuildOutput(guildId: string, channelId: string, connected: boolean, now = Date.now()): void {
        this.db
            .prepare(
                `INSERT INTO guild_outputs(guild_id,channel_id,connected,updated_at) VALUES(?,?,?,?)
                 ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,connected=excluded.connected,updated_at=excluded.updated_at`,
            )
            .run(guildId, channelId, connected ? 1 : 0, now);
    }

    guildOutputs(): Array<{ guildId: string; channelId: string }> {
        return (this.db.prepare("SELECT guild_id,channel_id FROM guild_outputs WHERE channel_id<>'disabled' ORDER BY guild_id").all() as Row[]).map(row => ({
            guildId: asString(row.guild_id),
            channelId: asString(row.channel_id),
        }));
    }

    isStationAdmin(userId: string): boolean {
        return Boolean(this.db.prepare('SELECT 1 FROM station_admins WHERE user_id=?').get(userId));
    }

    listStationAdmins(): string[] {
        return (this.db.prepare('SELECT user_id FROM station_admins ORDER BY granted_at,user_id').all() as Row[])
            .map(row => asString(row.user_id));
    }

    grantStationAdmin(userId: string, grantedBy: string, now = Date.now()): boolean {
        return this.transaction(() => {
            const result = this.db.prepare('INSERT OR IGNORE INTO station_admins(user_id,granted_by,granted_at) VALUES(?,?,?)')
                .run(userId, grantedBy, now);
            if (result.changes) this.event('admin.granted', { userId, grantedBy }, now);
            return result.changes === 1;
        });
    }

    revokeStationAdmin(userId: string, now = Date.now()): boolean {
        return this.transaction(() => {
            const result = this.db.prepare('DELETE FROM station_admins WHERE user_id=?').run(userId);
            if (result.changes) this.event('admin.revoked', { userId }, now);
            return result.changes === 1;
        });
    }

    private pendingRequestCount(): number {
        return asNumber(this.one("SELECT COUNT(*) AS count FROM requests WHERE status='pending'").count);
    }

    private requestCandidates(now: number, includeUndecided = false): Row[] {
        return this.db
            .prepare(
                `SELECT p.*,t.title,t.artist,t.duration_ms,r.guild_id AS guild_id,MIN(r.created_at) AS request_at
                 FROM play_items p JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
                 JOIN requests r ON r.play_item_id=p.id AND r.status='pending'
                 WHERE p.state='ready' AND r.expires_at>?
                   AND (?=1 OR r.host_decision='select' OR (r.host_decision='defer' AND r.eligible_after<=?))
                 GROUP BY p.id,r.guild_id ORDER BY request_at,p.id`,
            )
            .all(now, includeUndecided ? 1 : 0, now) as Row[];
    }

    private roundRobin(rows: Row[]): Row | undefined {
        if (rows.length === 0) return undefined;
        const guilds = [...new Set(rows.map(row => asString(row.guild_id)))].sort();
        const last = this.setting('last_request_guild');
        const start = last ? (guilds.indexOf(last) + 1) % guilds.length : 0;
        for (let offset = 0; offset < guilds.length; offset++) {
            const guild = guilds[(start + offset) % guilds.length];
            const found = rows.find(row => row.guild_id === guild);
            if (found) return found;
        }
        return rows[0];
    }

    private itemRow(where: string, ...params: Array<string | number>): Row | undefined {
        return this.db
            .prepare(
                `SELECT p.*,t.title,t.artist,t.duration_ms FROM play_items p
                 LEFT JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id ${where}`,
            )
            .get(...params) as Row | undefined;
    }

    private rowToItem(row: Row): QueueItem {
        const provider = row.provider as Track['provider'] | null;
        return {
            id: asNumber(row.id),
            kind: asString(row.kind) as QueueItem['kind'],
            state: asString(row.state) as QueueItem['state'],
            ...(provider
                ? {
                      track: {
                          provider,
                          id: asString(row.provider_id),
                          title: asString(row.title),
                          artist: asString(row.artist),
                          durationMs: asNumber(row.duration_ms),
                      },
                  }
                : {}),
            ...(row.local_path ? { localPath: asString(row.local_path) } : {}),
            createdAt: asNumber(row.created_at),
            ...(row.error ? { error: asString(row.error) } : {}),
        };
    }

    private failedTrackRecently(track: Track, now: number): boolean {
        const failed = this.one(
            'SELECT MAX(retry_after) AS retry_after FROM track_quarantine WHERE provider=? AND provider_id=?',
            track.provider,
            track.id,
        );
        return failed.retry_after !== null && now < asNumber(failed.retry_after);
    }

    private static quarantineMs(reason: string): number {
        return /^(?:YouTube Music (?:resolve|audio fetch)|Spotify (?:track lookup|audio fetch)) failed \((?:403|404|410)\)$/u.test(reason)
            ? RadioStore.unavailableTrackQuarantineMs : RadioStore.failedTrackQuarantineMs;
    }

    private editorialEligible(track: Track, now: number, replacingFuture: boolean): boolean {
        if (!track.provider || !track.id || !track.title || !track.artist ||
            !Number.isFinite(track.durationMs) || track.durationMs <= 0) return false;
        const active = this.one(`SELECT COUNT(*) AS count FROM play_items WHERE provider=? AND provider_id=?
            AND state IN ('queued','preparing','ready','playing')
            AND (?=0 OR NOT (kind='editorial' AND state IN ('queued','preparing')))`,
            track.provider, track.id, replacingFuture ? 1 : 0);
        if (asNumber(active.count) > 0 || this.failedTrackRecently(track, now)) return false;
        const sameSongActive = this.one(`SELECT COUNT(*) AS count FROM play_items p
            JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
            WHERE p.state IN ('queued','preparing','ready','playing')
            AND t.song_key=?
            AND (?=0 OR NOT (p.kind='editorial' AND p.state IN ('queued','preparing')))`,
            songKey(track), replacingFuture ? 1 : 0);
        if (asNumber(sameSongActive.count) > 0) return false;
        const activeArtist = this.one(`SELECT COUNT(*) AS count FROM play_items p
            JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
            WHERE p.state IN ('queued','preparing','ready','playing') AND t.artist_key=?
            AND (?=0 OR NOT (p.kind='editorial' AND p.state IN ('queued','preparing')))`,
            metadataKey(track.artist), replacingFuture ? 1 : 0);
        if (asNumber(activeArtist.count) > 0) return false;
        const recentTrack = this.one("SELECT MAX(updated_at) AS at FROM play_items WHERE provider=? AND provider_id=? AND state='played'",
            track.provider, track.id);
        if (recentTrack.at !== null && now - asNumber(recentTrack.at) < this.policy.trackCooldownMs) return false;
        const sameSongPlayed = this.one(`SELECT MAX(p.updated_at) AS at FROM play_items p
            JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
            WHERE p.state='played' AND t.song_key=?`, songKey(track));
        if (sameSongPlayed.at !== null && now - asNumber(sameSongPlayed.at) < this.policy.trackCooldownMs) return false;
        const recentArtist = this.one(`SELECT MAX(p.updated_at) AS at FROM play_items p
            JOIN tracks t ON t.provider=p.provider AND t.provider_id=p.provider_id
            WHERE p.state='played' AND t.artist_key=?`, metadataKey(track.artist));
        return recentArtist.at === null || now - asNumber(recentArtist.at) >= this.policy.artistCooldownMs;
    }

    private one(sql: string, ...params: Array<string | number | null>): Row {
        return (this.db.prepare(sql) as StatementSync).get(...params) as Row;
    }

    private event(kind: string, payload: unknown, now: number): void {
        this.db.prepare('INSERT INTO events(kind,payload,created_at) VALUES(?,?,?)').run(kind, JSON.stringify(payload), now);
    }

    private setting(key: string): string | undefined {
        const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as Row | undefined;
        return row ? asString(row.value) : undefined;
    }

    private setSetting(key: string, value: string): void {
        this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    }

    private restoreProgrammeBeforeClaim(id: number): void {
        if (this.setting('play_claim_id') !== String(id)) return;
        this.setSetting('last_kind', this.setting('play_claim_previous_kind') ?? '');
        this.setSetting('editorials_since_request', this.setting('play_claim_previous_editorials') ?? '0');
        this.setSetting('last_request_guild', this.setting('play_claim_previous_request_guild') ?? '');
        this.clearProgrammeClaim(id);
    }

    private clearProgrammeClaim(id: number): void {
        if (this.setting('play_claim_id') !== String(id)) return;
        this.db.prepare("DELETE FROM settings WHERE key IN ('play_claim_id','play_claim_previous_kind','play_claim_previous_editorials','play_claim_previous_request_guild')").run();
    }
}
