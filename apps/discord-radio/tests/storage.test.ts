import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { Track } from '../src/contracts.js';
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

const track = (id: string, artist = `Artist ${id}`): Track => ({ provider: 'ytmusic', id, title: `Title ${id}`, artist, durationMs: 180_000 });
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function diskStore(): { store: RadioStore; path: string } {
    const root = mkdtempSync(join(tmpdir(), 'discord-radio-'));
    roots.push(root);
    const path = join(root, 'radio.sqlite');
    return { store: new RadioStore(path, policy), path };
}

function prepareAll(store: RadioStore, now = Date.now()): void {
    while (true) {
        const item = store.claimPreparation(now);
        if (!item) break;
        store.markReady(item.id, `C:/cache/${item.id}.media`, now);
    }
}

describe('RadioStore', () => {
    it('records uncapped AI calls while retaining opt-in positive limits', () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        for (let index = 0; index < 5; index++) expect(store.reserveAiCall(now + index, 0, 0)).toBe(true);
        expect(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='ai.call'").get()).toEqual({ n: 5 });
        expect(store.reserveAiCall(now + 6, 5, 0)).toBe(false);
        store.close();
    });
    it('migrates an existing play-items table without losing queued music', () => {
        const root = mkdtempSync(join(tmpdir(), 'discord-radio-old-queue-'));
        roots.push(root);
        const path = join(root, 'radio.sqlite');
        const old = new DatabaseSync(path);
        old.exec(`CREATE TABLE play_items (id INTEGER PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,
            provider TEXT,provider_id TEXT,local_path TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT);
            INSERT INTO play_items(id,kind,state,created_at,updated_at) VALUES(1,'editorial','queued',1000,1000);`);
        old.close();
        const store = new RadioStore(path, policy);
        expect(store.claimPreparation(2000)?.id).toBe(1);
        expect(store.preparationAttempts(1)).toBe(1);
        store.close();
    });
    it('migrates legacy input rows as selected and preserves new pending decisions after restart', () => {
        const root = mkdtempSync(join(tmpdir(), 'discord-radio-legacy-'));
        roots.push(root);
        const path = join(root, 'radio.sqlite');
        const now = Date.now();
        const legacy = new DatabaseSync(path);
        legacy.exec(`
            CREATE TABLE requests (id INTEGER PRIMARY KEY,play_item_id INTEGER NOT NULL,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,
                user_name TEXT NOT NULL,dedication TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
            CREATE TABLE studio_messages (id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,user_name TEXT NOT NULL,
                message TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
            INSERT INTO studio_messages VALUES(1,'g','legacy','Legacy','Старое письмо','pending',${now},${now + policy.studioTtlMs});
        `);
        legacy.close();
        const store = new RadioStore(path, policy);
        expect(store.peekStudioMessage(now + 1)?.id).toBe(1);
        const fresh = store.addStudioMessage({ guildId: 'g', userId: 'fresh', userName: 'Fresh', message: 'Новое письмо', now }, true);
        expect(fresh.accepted).toBe(true);
        store.close();
        const reopened = new RadioStore(path, policy);
        expect(reopened.pendingHostInputs(10, now + 1)).toMatchObject([{ kind: 'studio', id: fresh.accepted ? fresh.messageId : -1 }]);
        expect(reopened.peekStudioMessage(now + 1)?.id).toBe(1);
        expect(reopened.decideHostInput('studio', fresh.accepted ? fresh.messageId : -1, { choice: 'select' }, now + 2)).toBe(true);
        expect(reopened.decideHostInput('studio', fresh.accepted ? fresh.messageId : -1, { choice: 'decline' }, now + 3)).toBe(false);
        reopened.close();
    });

    it('gates pending host inputs, defers once for at most fifteen minutes, and rejects stale decisions', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 40_000_000;
        const request = store.addRequest({ guildId: 'g', userId: 'u', userName: 'Listener', track: track('abcdefghijk'), now }, true);
        const studio = store.addStudioMessage({ guildId: 'g', userId: 'u', userName: 'Listener', message: 'Смените тему', now: now + 1 }, true);
        if (!request.accepted || !studio.accepted) throw new Error('inputs not accepted');
        const editorial = store.enqueueEditorial(track('bcdefghijkl'), now + 2);
        prepareAll(store, now + 3);
        expect(store.pendingHostInputs(1, now + 4)).toMatchObject([{ kind: 'request', id: request.requestId, track: { id: 'abcdefghijk' } }]);
        expect(store.peekStudioMessage(now + 4)).toBeUndefined();
        expect(store.peekNextForPlayback(now + 4)?.id).toBe(editorial);
        expect(store.decideHostInput('request', request.requestId, { choice: 'defer', deferMinutes: 16 }, now + 5)).toBe(false);
        expect(store.decideHostInput('request', request.requestId, { choice: 'defer', deferMinutes: 1 }, now + 5)).toBe(true);
        expect(store.decideHostInput('request', request.requestId, { choice: 'select' }, now + 6)).toBe(false);
        expect(store.decideHostInput('studio', studio.messageId, { choice: 'defer', deferMinutes: 1 }, now + 5)).toBe(true);
        store.db.prepare("INSERT INTO settings(key,value) VALUES('editorials_since_request','2')").run();
        expect(store.peekNextForPlayback(now + 60_004)?.id).toBe(editorial);
        expect(store.peekNextForPlayback(now + 60_005)?.id).toBe(request.itemId);
        expect(store.peekStudioMessage(now + 60_004)).toBeUndefined();
        expect(store.studioMessageCanAir(studio.messageId, now + 60_004)).toBe(false);
        expect(store.markStudioAired(studio.messageId, now + 60_004)).toBe(false);
        expect(store.peekStudioMessage(now + 60_005)?.id).toBe(studio.messageId);
        expect(store.studioMessageCanAir(studio.messageId, now + 60_005)).toBe(true);
        expect(store.markStudioAired(studio.messageId, now + 60_005)).toBe(true);
        expect(store.pendingHostInputs(10, now + 60_006)).toEqual([]);
        store.close();
    });

    it('declines one merged request without suppressing another selected listener and cannot decide expired input', () => {
        const store = new RadioStore(':memory:', { ...policy, requestTtlMs: 100, studioTtlMs: 100 });
        const now = 41_000_000;
        const first = store.addRequest({ guildId: 'a', userId: 'a', userName: 'A', track: track('abcdefghijk'), now }, true);
        const second = store.addRequest({ guildId: 'b', userId: 'b', userName: 'B', track: track('abcdefghijk'), now: now + 1 }, true);
        if (!first.accepted || !second.accepted) throw new Error('requests not accepted');
        expect(first.itemId).toBe(second.itemId);
        expect(store.decideHostInput('request', first.requestId, { choice: 'decline' }, now + 2)).toBe(true);
        expect(store.decideHostInput('request', second.requestId, { choice: 'select' }, now + 3)).toBe(true);
        prepareAll(store, now + 4);
        expect(store.nextForPlayback(now + 5)?.id).toBe(first.itemId);
        store.finishItem(first.itemId, now + 6);
        expect(store.db.prepare('SELECT id,status FROM requests ORDER BY id').all()).toEqual([
            { id: first.requestId, status: 'rejected' }, { id: second.requestId, status: 'fulfilled' },
        ]);
        const third = store.addStudioMessage({ guildId: 'g', userId: 'c', userName: 'C', message: 'Письмо', now: now + 7 }, true);
        if (!third.accepted) throw new Error('studio not accepted');
        expect(store.decideHostInput('studio', third.messageId, { choice: 'select' }, now + 108)).toBe(false);
        store.close();
    });

    it('retires a solely declined request and prevents a declined studio break', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 41_500_000;
        const request = store.addRequest({ guildId: 'g', userId: 'u', userName: 'U', track: track('abcdefghijk'), now }, true);
        const studio = store.addStudioMessage({ guildId: 'g', userId: 'u', userName: 'U', message: 'Письмо', now }, true);
        if (!request.accepted || !studio.accepted) throw new Error('inputs not accepted');
        prepareAll(store, now + 1);
        expect(store.decideHostInput('request', request.requestId, { choice: 'decline' }, now + 2)).toBe(true);
        expect(store.decideHostInput('studio', studio.messageId, { choice: 'decline' }, now + 2)).toBe(true);
        expect(store.peekNextForPlayback(now + 3)).toBeUndefined();
        expect(store.peekStudioMessage(now + 3)).toBeUndefined();
        expect(store.studioMessageCanAir(studio.messageId, now + 3)).toBe(false);
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(request.itemId)).toEqual({ state: 'failed' });
        expect(store.pendingHostInputs(10, now + 3)).toEqual([]);
        store.close();
    });

    it('commits decline/defer notifications with decisions and rolls back both on outbox failure', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 41_700_000;
        const request = store.addRequest({ guildId: 'g', userId: 'u', userName: 'U', track: track('abcdefghijk'), now }, true);
        const studio = store.addStudioMessage({ guildId: 'g', userId: 'u', userName: 'U', message: 'Письмо', now }, true);
        if (!request.accepted || !studio.accepted) throw new Error('inputs not accepted');
        store.db.exec(`CREATE TRIGGER reject_notification BEFORE INSERT ON host_notifications
            BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END`);
        expect(() => store.decideHostInput('request', request.requestId, { choice: 'decline' }, now + 1)).toThrow('outbox unavailable');
        expect(store.db.prepare('SELECT status,host_decision FROM requests WHERE id=?').get(request.requestId))
            .toEqual({ status: 'pending', host_decision: 'pending' });
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(request.itemId)).toEqual({ state: 'queued' });
        expect(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE kind=?').get('host.request.decline')).toEqual({ count: 0 });
        store.db.exec('DROP TRIGGER reject_notification');
        expect(store.decideHostInput('request', request.requestId, { choice: 'decline' }, now + 2)).toBe(true);
        expect(store.decideHostInput('request', request.requestId, { choice: 'decline' }, now + 3)).toBe(false);
        expect(store.decideHostInput('studio', studio.messageId, { choice: 'defer', deferMinutes: 2 }, now + 4)).toBe(true);
        expect(store.db.prepare('SELECT kind,input_id,status,attempts FROM host_notifications ORDER BY id').all()).toEqual([
            { kind: 'request', input_id: request.requestId, status: 'pending', attempts: 0 },
            { kind: 'studio', input_id: studio.messageId, status: 'pending', attempts: 0 },
        ]);
        expect(store.dueHostNotification(now + 4)?.message).toContain('заявку');
        store.close();
    });

    it('does not notify for selected inputs and records a successful delivery only once', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 41_750_000;
        const selected = store.addStudioMessage({ guildId: 'g', userId: 'u', userName: 'U', message: 'Первое', now }, true);
        const deferred = store.addStudioMessage({ guildId: 'g', userId: 'v', userName: 'V', message: 'Второе', now }, true);
        if (!selected.accepted || !deferred.accepted) throw new Error('inputs not accepted');
        expect(store.decideHostInput('studio', selected.messageId, { choice: 'select' }, now + 1)).toBe(true);
        expect(store.decideHostInput('studio', deferred.messageId, { choice: 'defer', deferMinutes: 1 }, now + 1)).toBe(true);
        const notice = store.dueHostNotification(now + 1)!;
        expect(notice.inputId).toBe(deferred.messageId);
        expect(store.completeHostNotification(notice.id, true, now + 2, notice.attempts)).toBe(true);
        expect(store.completeHostNotification(notice.id, true, now + 3, notice.attempts)).toBe(false);
        expect(store.dueHostNotification(now + 10_000_000)).toBeUndefined();
        expect(store.db.prepare('SELECT COUNT(*) AS count FROM host_notifications').get()).toEqual({ count: 1 });
        store.close();
    });

    it('leases durable notifications and applies bounded retries through terminal failure', () => {
        const { store, path } = diskStore();
        const now = 41_800_000;
        const studio = store.addStudioMessage({ guildId: 'g', userId: 'u', userName: 'U', message: 'Письмо', now }, true);
        if (!studio.accepted) throw new Error('studio not accepted');
        expect(store.decideHostInput('studio', studio.messageId, { choice: 'defer', deferMinutes: 2 }, now + 1)).toBe(true);
        const first = store.dueHostNotification(now + 1)!;
        expect(first).toMatchObject({ kind: 'studio', inputId: studio.messageId, guildId: 'g', userId: 'u', attempts: 1 });
        expect(store.dueHostNotification(now + 1)).toBeUndefined();
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.dueHostNotification(now + 59_999)).toBeUndefined();
        const afterCrash = reopened.dueHostNotification(now + 60_001)!;
        expect(afterCrash.attempts).toBe(2);
        expect(reopened.completeHostNotification(first.id, true, now + 60_002, first.attempts)).toBe(false);
        expect(reopened.completeHostNotification(afterCrash.id, false, now + 60_002, afterCrash.attempts)).toBe(true);
        expect(reopened.dueHostNotification(now + 120_001)).toBeUndefined();
        const third = reopened.dueHostNotification(now + 180_002)!;
        expect(third.attempts).toBe(3);
        expect(reopened.completeHostNotification(third.id, false, now + 180_003, third.attempts)).toBe(true);
        const fourth = reopened.dueHostNotification(now + 420_003)!;
        expect(fourth.attempts).toBe(4);
        expect(reopened.completeHostNotification(fourth.id, false, now + 420_004, fourth.attempts)).toBe(true);
        const fifth = reopened.dueHostNotification(now + 900_004)!;
        expect(fifth.attempts).toBe(5);
        expect(reopened.completeHostNotification(fifth.id, false, now + 900_005, fifth.attempts)).toBe(true);
        expect(reopened.dueHostNotification(now + 10_000_000)).toBeUndefined();
        expect(reopened.db.prepare('SELECT status,attempts FROM host_notifications WHERE id=?').get(first.id))
            .toEqual({ status: 'failed', attempts: 5 });
        reopened.close();
    });

    it('retires a notification if the worker crashes after its final delivery attempt', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 41_850_000;
        const request = store.addRequest({ guildId: 'g', userId: 'u', userName: 'U', track: track('abcdefghijk'), now }, true);
        if (!request.accepted) throw new Error('request not accepted');
        expect(store.decideHostInput('request', request.requestId, { choice: 'decline' }, now + 1)).toBe(true);
        for (let attempt = 1; attempt <= 5; attempt++) {
            const notice = store.dueHostNotification(now + attempt * 60_000)!;
            expect(notice.attempts).toBe(attempt);
        }
        expect(store.dueHostNotification(now + 6 * 60_000)).toBeUndefined();
        expect(store.db.prepare('SELECT status,attempts FROM host_notifications').get()).toEqual({ status: 'failed', attempts: 5 });
        store.close();
    });

    it('returns only a listener’s own submissions in the requested guild', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 41_900_000;
        const own = store.addRequest({ guildId: 'a', userId: 'u', userName: 'U', track: track('abcdefghijk'), now }, true);
        const otherGuild = store.addStudioMessage({ guildId: 'b', userId: 'u', userName: 'U', message: 'Private other guild', now: now + 1 }, true);
        const otherUser = store.addStudioMessage({ guildId: 'a', userId: 'v', userName: 'V', message: 'Private other user', now: now + 2 }, true);
        if (!own.accepted || !otherGuild.accepted || !otherUser.accepted) throw new Error('inputs not accepted');
        expect(store.decideHostInput('request', own.requestId, { choice: 'defer', deferMinutes: 1 }, now + 3)).toBe(true);
        expect(store.listenerInputs('u', 'a', 20)).toEqual([{
            kind: 'request', id: own.requestId, status: 'pending', hostDecision: 'defer',
            createdAt: now, decidedAt: now + 3, eligibleAfter: now + 60_003,
            label: 'Artist abcdefghijk — Title abcdefghijk',
        }]);
        expect(store.listenerInputs('u', 'b')).toMatchObject([{ kind: 'studio', id: otherGuild.messageId }]);
        expect(store.listenerInputs('u', 'a', 0)).toEqual([]);
        expect(store.listenerInputs('unknown', 'a')).toEqual([]);
        store.close();
    });

    it('selects all attached undecided listeners atomically when a merged request starts', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 42_000_000;
        const first = store.addRequest({ guildId: 'a', userId: 'a', userName: 'A', track: track('abcdefghijk'), now }, true);
        const second = store.addRequest({ guildId: 'b', userId: 'b', userName: 'B', track: track('abcdefghijk'), now: now + 1 }, true);
        if (!first.accepted || !second.accepted) throw new Error('requests not accepted');
        const editorial = store.enqueueEditorial(track('bcdefghijkl'), now + 2);
        prepareAll(store, now + 3);
        expect(store.decideHostInput('request', first.requestId, { choice: 'select' }, now + 4)).toBe(true);
        expect(store.peekNextForPlayback(now + 5)?.id).toBe(editorial);
        store.nextForPlayback(now + 5);
        store.finishItem(editorial, now + 6);
        expect(store.decideHostInput('request', second.requestId, { choice: 'defer', deferMinutes: 10 }, now + 6)).toBe(true);
        expect(store.nextForPlayback(now + 7)?.id).toBe(first.itemId);
        expect(store.db.prepare('SELECT host_decision FROM requests WHERE id=?').get(second.requestId)).toEqual({ host_decision: 'select' });
        expect(store.db.prepare("SELECT payload FROM events WHERE kind='host.request.coalesced'").all().map(row => JSON.parse(String(row.payload))))
            .toEqual([{ requestId: second.requestId, itemId: first.itemId, previousDecision: 'defer' }]);
        expect(store.decideHostInput('request', second.requestId, { choice: 'decline' }, now + 8)).toBe(false);
        store.close();
    });

    it('uses an undecided ready request to avoid silence, while old/admin intake defaults to selected', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 43_000_000;
        const emergency = store.addRequest({ guildId: 'g', userId: 'u', userName: 'U', track: track('abcdefghijk'), now }, true);
        if (!emergency.accepted) throw new Error('request not accepted');
        prepareAll(store, now + 1);
        expect(store.peekNextForPlayback(now + 2)?.id).toBe(emergency.itemId);
        expect(store.nextForPlayback(now + 2)?.id).toBe(emergency.itemId);
        expect(store.db.prepare('SELECT host_decision FROM requests WHERE id=?').get(emergency.requestId)).toEqual({ host_decision: 'select' });
        store.finishItem(emergency.itemId, now + 3);
        const admin = store.addRequest({ guildId: 'g', userId: 'owner', userName: 'Owner', track: track('bcdefghijkl'), now: now + 4, isOwner: true });
        const letter = store.addStudioMessage({ guildId: 'g', userId: 'owner', userName: 'Owner', message: 'Письмо', now: now + 4, isOwner: true });
        expect(admin.accepted && letter.accepted).toBe(true);
        expect(store.pendingHostInputs(10, now + 5)).toEqual([]);
        expect(store.peekStudioMessage(now + 5)?.id).toBe(letter.accepted ? letter.messageId : -1);
        store.close();
    });

    it('makes early emergency playout of a deferred request explicit in its notice and event', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 43_500_000;
        const request = store.addRequest({ guildId: 'g', userId: 'u', userName: 'U', track: track('abcdefghijk'), now }, true);
        if (!request.accepted) throw new Error('request not accepted');
        prepareAll(store, now + 1);
        expect(store.decideHostInput('request', request.requestId, { choice: 'defer', deferMinutes: 10 }, now + 2)).toBe(true);
        expect(store.dueHostNotification(now + 3)?.message).toContain('может прозвучать раньше');
        expect(store.nextForPlayback(now + 4)?.id).toBe(request.itemId);
        expect(store.db.prepare("SELECT payload FROM events WHERE kind='host.request.coalesced'").all().map(row => JSON.parse(String(row.payload))))
            .toEqual([{ requestId: request.requestId, itemId: request.itemId, previousDecision: 'defer' }]);
        store.close();
    });
    it('persists explicit admin grants and revocations without guild-role inference', () => {
        const { store, path } = diskStore();
        expect(store.isStationAdmin('helper')).toBe(false);
        expect(store.grantStationAdmin('helper', 'owner', 1_000)).toBe(true);
        expect(store.grantStationAdmin('helper', 'owner', 1_001)).toBe(false);
        expect(store.listStationAdmins()).toEqual(['helper']);
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.isStationAdmin('helper')).toBe(true);
        expect(reopened.revokeStationAdmin('helper', 2_000)).toBe(true);
        expect(reopened.revokeStationAdmin('helper', 2_001)).toBe(false);
        expect(reopened.isStationAdmin('helper')).toBe(false);
        reopened.close();
    });

    it('persists a versioned show plan, expires it, and rejects a stale model revision', () => {
        const { store, path } = diskStore();
        const now = 10_000_000;
        const fallback = fallbackShowPlan(now, []);
        const first = store.ensureFallbackShowPlan(fallback, now);
        expect(first.source).toBe('fallback');
        const updatedFallback = store.ensureFallbackShowPlan(fallbackShowPlan(now + 1, [],
            ['drum n bass', 'phonk', 'metal', 'techno', 'electronic']), now + 1);
        expect(updatedFallback).toMatchObject({ revision: first.revision + 1, source: 'fallback',
            queries: ['drum n bass', 'phonk', 'metal', 'techno', 'electronic'] });
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.currentShowPlan(now + 1)).toEqual(updatedFallback);
        const model = { theme: 'Разные ритмы', queries: ['русский рок', 'indie pop', 'jazz funk'], requestRun: 'continue' as const };
        const revised = reopened.replaceShowPlan(updatedFallback.revision, model, now + 2)!;
        expect(revised).toMatchObject({ revision: updatedFallback.revision + 1, source: 'model', requestRun: 'continue' });
        expect(reopened.ensureFallbackShowPlan(fallback, now + 3)).toEqual(revised);
        expect(reopened.replaceShowPlan(updatedFallback.revision, model, now + 3)).toBeUndefined();
        expect(reopened.currentShowPlan(now + 2 + SHOW_PLAN_TTL_MS)).toBeUndefined();
        const refreshed = reopened.ensureFallbackShowPlan(fallbackShowPlan(now + 2 + SHOW_PLAN_TTL_MS, []), now + 2 + SHOW_PLAN_TTL_MS);
        expect(refreshed.revision).toBe(revised.revision + 1);
        expect(reopened.replaceShowPlan(revised.revision, model, now + 3 + SHOW_PLAN_TTL_MS)).toBeUndefined();
        reopened.close();
    });

    it('reads bounded factual programme memory from the previous 72 hours after restart', () => {
        const { store, path } = diskStore();
        const day = 86_400_000;
        const now = 400_000_000;
        for (const [index, at] of [now - 2 * day + 100, now - day - 100, now - 100].entries()) {
            const id = ['abcdefghijk', 'bcdefghijkl', 'cdefghijklm'][index]!;
            const itemId = store.enqueueEditorial(track(id), at);
            const segmentId = store.recordHostSegment(itemId, `Реплика ${index}`, `C:/speech/${index}.wav`, at)!;
            prepareAll(store, at);
            expect(store.nextForPlayback(at + 1)?.id).toBe(itemId);
            store.markHostSegmentPlayed(segmentId, at + 2);
            store.finishItem(itemId, at + 2);
        }
        store.ensureFallbackShowPlan(fallbackShowPlan(now - 2 * day, []), now - 2 * day);
        const recent = store.ensureFallbackShowPlan(fallbackShowPlan(now - 100, []), now - 100);
        store.replaceShowPlan(recent.revision, { theme: 'Новая джазовая ночь', queries: ['русский джаз', 'jazz funk', 'nu jazz'], requestRun: 'continue' }, now - 50);
        store.addStudioMessage({ guildId: 'g', userId: 'old', userName: 'Old', message: 'Старое истёкшее письмо', now: now - 2 * day });
        store.addStudioMessage({ guildId: 'g', userId: 'new', userName: 'New', message: 'Сегодня хочу рок', now: now - 10 });
        store.close();

        const reopened = new RadioStore(path, policy);
        const memory = reopened.showMemory(now);
        expect(memory.earlierSpins.map(spin => spin.title)).toEqual(['Title bcdefghijkl', 'Title abcdefghijk']);
        expect(memory.hostLines).toEqual(['Реплика 2']);
        expect(memory.earlierHostLines.map(line => line.text)).toEqual(['Реплика 1', 'Реплика 0']);
        expect(memory.recentThemes.map(theme => theme.theme)).toContain('Новая джазовая ночь');
        expect(memory.listenerSignals).toEqual([{ kind: 'studio', text: 'Сегодня хочу рок', userName: 'New', createdAt: now - 10 }]);
        expect(memory.earlierSpins).toHaveLength(2);
        expect(reopened.recentPlayed(12, now).map(spin => spin.title)).toEqual([
            'Title cdefghijklm', 'Title bcdefghijkl', 'Title abcdefghijk',
        ]);
        expect(reopened.recentPlayed(12, now + 4 * day)).toEqual([]);
        reopened.close();
    });

    it('restores aired host lines for the next model call but excludes unplayed drafts', () => {
        const { store, path } = diskStore();
        const now = Date.now();
        const itemId = store.enqueueEditorial(track('abcdefghijk'), now);
        const played = store.recordHostSegment(itemId, 'Вчера я обещал рок, сегодня держу слово.', 'C:/speech/played.wav', now);
        const ready = store.recordHostSegment(itemId, 'Эта реплика не прозвучала.', 'C:/speech/ready.wav', now);
        expect(played).toBeDefined();
        expect(ready).toBeDefined();
        store.markHostSegmentPlayed(played!, now);
        store.close();
        const reopened = new RadioStore(path, policy);
        expect(reopened.showMemory(now + 1000).hostLines).toEqual(['Вчера я обещал рок, сегодня держу слово.']);
        reopened.close();
    });

    it('ages spoken history from airtime, not from a draft prepared days earlier', () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        const preparedAt = now - 4 * 86_400_000;
        const itemId = store.enqueueEditorial(track('abcdefghijk'), preparedAt);
        const segmentId = store.recordHostSegment(itemId, 'Только что прозвучало.', 'C:/speech/delayed.wav', preparedAt)!;
        expect(store.markHostSegmentPlayed(segmentId, now)).toBe(true);
        expect(store.showMemory(now + 1).hostLines).toEqual(['Только что прозвучало.']);
        expect(store.showMemory(now + 1).earlierHostLines).toEqual([]);
        store.close();
    });

    it('migrates old host segments and keeps historical spoken lines readable', () => {
        const root = mkdtempSync(join(tmpdir(), 'discord-radio-old-host-'));
        roots.push(root);
        const path = join(root, 'radio.sqlite');
        const now = Date.now();
        const old = new DatabaseSync(path);
        old.exec(`CREATE TABLE host_segments (id INTEGER PRIMARY KEY,play_item_id INTEGER,script TEXT NOT NULL,
            local_path TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL);
            INSERT INTO host_segments VALUES(1,NULL,'Старая эфирная реплика.',NULL,'played',${now - 1000});`);
        old.close();
        const store = new RadioStore(path, policy);
        expect(store.showMemory(now).hostLines).toEqual(['Старая эфирная реплика.']);
        expect(store.db.prepare('PRAGMA table_info(host_segments)').all()).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'aired_at' })]),
        );
        store.close();
    });

    it('provides bounded factual recent spins and treats the show decision as advisory', () => {
        const store = new RadioStore(':memory:', policy);
        const now = Date.now();
        const editorialId = store.enqueueEditorial(track('abcdefghijk'), now);
        prepareAll(store, now);
        expect(store.nextForPlayback(now + 1)?.id).toBe(editorialId);
        store.finishItem(editorialId, now + 2);
        const spins = store.recentPlayed(100, now + 2);
        expect(spins).toEqual([{ title: 'Title abcdefghijk', artist: 'Artist abcdefghijk', playedAt: now + 2 }]);
        expect(store.recentPlayed(0)).toEqual([]);

        const nextEditorial = store.enqueueEditorial(track('bcdefghijkl'), now + 3);
        const a = store.addRequest({ guildId: 'g', userId: 'a', userName: 'A', track: track('cdefghijklm'), now: now + 4 });
        const b = store.addRequest({ guildId: 'g', userId: 'b', userName: 'B', track: track('defghijklmn'), now: now + 5 });
        expect(a.accepted && b.accepted).toBe(true);
        prepareAll(store, now + 6);
        store.db.prepare("INSERT INTO settings(key,value) VALUES('last_kind','request') ON CONFLICT(key) DO UPDATE SET value='request'").run();
        const plan = store.ensureFallbackShowPlan(fallbackShowPlan(now, spins), now);
        expect(store.peekNextForPlayback(now + 7)?.id).toBe(nextEditorial);
        store.replaceShowPlan(plan.revision, { theme: 'Заказы в эфире', queries: ['русский инди', 'indie rock', 'dream pop'], requestRun: 'continue' }, now + 8);
        expect(store.peekNextForPlayback(now + 9)?.kind).toBe('request');
        const firstRequest = store.nextForPlayback(now + 9)!;
        expect(firstRequest.kind).toBe('request');
        store.finishItem(firstRequest.id, now + 10);
        expect(store.nextForPlayback(now + 11)?.kind).toBe('request');
        store.close();
    });

    it('persists prepared host scripts and retires unaired segments after restart', () => {
        const { store, path } = diskStore();
        const first = store.enqueueEditorial(track('abcdefghijk'));
        const second = store.enqueueEditorial(track('bcdefghijkl'));
        prepareAll(store);
        const aired = store.recordHostSegment(first, 'Короткая реплика.', 'C:/cache/a.audio')!;
        const abandoned = store.recordHostSegment(second, 'Другая реплика.', 'C:/cache/b.audio')!;
        expect(store.markHostSegmentPlayed(aired)).toBe(true);
        expect(store.markHostSegmentPlayed(aired)).toBe(false);
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.db.prepare('SELECT id,script,status FROM host_segments ORDER BY id').all()).toEqual([
            { id: aired, script: 'Короткая реплика.', status: 'played' },
            { id: abandoned, script: 'Другая реплика.', status: 'failed' },
        ]);
        expect(reopened.discardHostSegment(abandoned)).toBe(false);
        reopened.close();
    });

    it('quarantines failed editorial tracks across restart, then allows them after 15 minutes', () => {
        const { store, path } = diskStore();
        const now = 5_000_000;
        const song = track('abcdefghijk');
        const id = store.enqueueEditorialIfEligible(song, now)!;
        store.failItem(id, 'fetch failed', now + 1);
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.enqueueEditorialIfEligible(song, now + 2)).toBeUndefined();
        expect(reopened.enqueueEditorialIfEligible(song, now + 15 * 60_000 + 1)).toBeTypeOf('number');
        reopened.close();
    });

    it('keeps provider 403 tracks out of rotation for six hours across restart', () => {
        const { store, path } = diskStore();
        const now = 5_100_000;
        const song = track('unavailable');
        const id = store.enqueueEditorialIfEligible(song, now)!;
        store.failItem(id, 'YouTube Music resolve failed (403)', now + 1);
        store.close();
        const reopened = new RadioStore(path, policy);
        expect(reopened.enqueueEditorialIfEligible(song, now + 15 * 60_000 + 1)).toBeUndefined();
        expect(reopened.enqueueEditorialIfEligible(song, now + 6 * 60 * 60_000 + 1)).toBeTypeOf('number');
        reopened.close();
    });

    it('does not shorten a 403 hold after a later generic failure on the same track', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 5_150_000;
        const song = track('same-song');
        store.failItem(store.enqueueEditorial(song, now), 'YouTube Music resolve failed (403)', now + 1);
        store.failItem(store.enqueueEditorial(song, now + 2), 'fetch failed', now + 60_000);
        expect(store.enqueueEditorialIfEligible(song, now + 16 * 60_000)).toBeUndefined();
        expect(store.enqueueEditorialIfEligible(song, now + 6 * 60 * 60_000 + 1)).toBeTypeOf('number');
        store.close();
    });

    it('does not treat an unrelated error containing a 403 fragment as a provider denial', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 5_180_000;
        const song = track('unrelated');
        store.failItem(store.enqueueEditorial(song, now), 'local decoder error (403)', now + 1);
        expect(store.enqueueEditorialIfEligible(song, now + 15 * 60_000 + 1)).toBeTypeOf('number');
        store.close();
    });

    it('quarantines a verified media candidate that fails before queue insertion', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 5_190_000;
        const song = track('staged-failure');
        store.quarantineFailedCandidate(song, 'YouTube Music audio fetch failed (403)', now);
        expect(store.db.prepare('SELECT COUNT(*) AS n FROM play_items').get()).toEqual({ n: 0 });
        expect(store.enqueueEditorialIfEligible(song, now + 15 * 60_000)).toBeUndefined();
        expect(store.enqueueEditorialIfEligible(song, now + 6 * 60 * 60_000)).toBeTypeOf('number');
        store.close();
    });

    it('migrates old 403 quarantine rows without shortening their remaining hold', () => {
        const root = mkdtempSync(join(tmpdir(), 'discord-radio-old-quarantine-'));
        roots.push(root);
        const path = join(root, 'radio.sqlite');
        const now = 5_200_000;
        const old = new DatabaseSync(path);
        old.exec(`CREATE TABLE tracks(provider TEXT,provider_id TEXT,title TEXT,artist TEXT,duration_ms INTEGER,
                PRIMARY KEY(provider,provider_id));
            INSERT INTO tracks VALUES('ytmusic','old-song','Old Song','Old Artist',180000);
            CREATE TABLE play_items(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,
                provider TEXT,provider_id TEXT,local_path TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT);
            INSERT INTO play_items VALUES(1,'editorial','failed','ytmusic','old-song',NULL,${now},${now + 1},'YouTube Music resolve failed (403)');
            CREATE TABLE track_quarantine(provider TEXT NOT NULL,provider_id TEXT NOT NULL,failed_at INTEGER NOT NULL,
                PRIMARY KEY(provider,provider_id));
            INSERT INTO track_quarantine VALUES('ytmusic','old-song',${now + 1});`);
        old.close();
        const store = new RadioStore(path, policy);
        expect(store.db.prepare('SELECT retry_after FROM track_quarantine').get()).toEqual({ retry_after: now + 1 + 6 * 60 * 60_000 });
        expect(store.enqueueEditorialIfEligible({ ...track('old-song', 'Old Artist'), title: 'Old Song' }, now + 15 * 60_000 + 1)).toBeUndefined();
        store.close();
    });

    it('blocks the same artist and title under a different catalog ID for the full track cooldown', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 5_200_000;
        const original = { ...track('abcdefghijk', 'ГРУППА МЕТАЛ'), title: 'Тёмная ночь' };
        const alternate = { ...original, id: 'bcdefghijkl', artist: ' группа   метал ', title: ' ТЁМНАЯ НОЧЬ ' };
        const id = store.enqueueEditorialIfEligible(original, now)!;
        expect(store.enqueueEditorialIfEligible(alternate, now + 1)).toBeUndefined();
        expect(store.claimPreparation(now + 2)?.id).toBe(id);
        expect(store.markReady(id, 'C:/cache/song.media', now + 3)).toBe(true);
        expect(store.nextForPlayback(now + 4)?.id).toBe(id);
        store.finishItem(id, now + 5);
        expect(store.enqueueEditorialIfEligible(alternate, now + policy.artistCooldownMs + 1)).toBeUndefined();
        expect(store.enqueueEditorialIfEligible(alternate, now + policy.trackCooldownMs + 5)).toBeTypeOf('number');
        store.close();
    });

    it('keeps different upcoming songs by one artist out of the same short run', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 5_300_000;
        expect(store.enqueueEditorialIfEligible({ ...track('abcdefghijk', 'Кино'), title: 'Пачка сигарет' }, now)).toBeTypeOf('number');
        expect(store.enqueueEditorialIfEligible({ ...track('bcdefghijkl', ' КИНО '), title: 'Группа крови' }, now + 1)).toBeUndefined();
        store.close();
    });

    it('does not quarantine an editorial track skipped by the owner', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 5_500_000;
        const song = track('skip-song');
        const id = store.enqueueEditorial(song, now);
        expect(store.claimPreparation(now + 1)?.id).toBe(id);
        expect(store.markReady(id, 'C:/cache/skip.media', now + 2)).toBe(true);
        expect(store.nextForPlayback(now + 3)?.id).toBe(id);
        expect(store.skipItem(id, now + 4)).toBe(true);
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(id)).toEqual({ state: 'interrupted' });
        expect(store.db.prepare('SELECT COUNT(*) AS n FROM track_quarantine').get()).toEqual({ n: 0 });
        expect(store.enqueueEditorialIfEligible(song, now + 5)).toBeTypeOf('number');
        store.close();
    });

    it('rejects a request for a quarantined track without consuming its cooldown', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 6_000_000;
        const song = track('abcdefghijk');
        store.failItem(store.enqueueEditorial(song, now), 'YouTube Music audio fetch failed (403)', now + 1);
        const request = { guildId: 'a', userId: 'u1', userName: 'One', track: song };
        expect(store.addRequest({ ...request, now: now + 2 })).toMatchObject({ accepted: false, reason: expect.stringContaining('временно недоступен') });
        expect(store.addRequest({ ...request, now: now + 15 * 60_000 + 1 })).toMatchObject({ accepted: false });
        expect(store.addRequest({ ...request, now: now + 6 * 60 * 60_000 + 1 })).toMatchObject({ accepted: true });
        store.close();
    });

    it('retains the listener request cooldown after a terminal media failure', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 6_100_000;
        const first = store.addRequest({ guildId: 'g', userId: 'u', userName: 'Listener', track: track('abcdefghijk'), now });
        expect(first.accepted).toBe(true);
        if (!first.accepted) throw new Error('request was not accepted');
        store.failItem(first.itemId, 'fetch failed', now + 1);
        expect(store.addRequest({ guildId: 'g', userId: 'u', userName: 'Listener',
            track: track('bcdefghijkl'), now: now + 2 })).toMatchObject({ accepted: false,
            reason: expect.stringContaining('Повторную заявку') });
        store.close();
    });


    it('does not quarantine a playable track when the owner rejects its request', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 7_000_000;
        const song = track('abcdefghijk');
        const first = store.addRequest({ guildId: 'a', userId: 'u1', userName: 'One', track: song, now });
        expect(first.accepted).toBe(true);
        if (!first.accepted) throw new Error('request unexpectedly rejected');
        expect(store.rejectRequest(first.requestId, 'Отклонено владельцем станции.', now + 1)).toBe(true);
        const second = store.addRequest({ guildId: 'a', userId: 'u2', userName: 'Two', track: song, now: now + 2 });
        expect(second.accepted).toBe(true);
        if (!second.accepted) throw new Error('request unexpectedly rejected');
        store.rejectRequest(second.requestId, 'Отклонено владельцем станции.', now + 3);
        expect(store.enqueueEditorialIfEligible(song, now + 4)).toBeTypeOf('number');
        store.close();
    });

    it('merges duplicate tracks but keeps one active request per listener', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 10_000_000;
        const first = store.addRequest({ guildId: 'a', userId: 'u1', userName: 'One', track: track('abcdefghijk'), now });
        const duplicate = store.addRequest({ guildId: 'b', userId: 'u2', userName: 'Two', track: track('abcdefghijk'), now: now + 1 });
        const secondForUser = store.addRequest({ guildId: 'a', userId: 'u1', userName: 'One', track: track('bcdefghijkl'), now: now + 2 });
        expect(first).toMatchObject({ accepted: true, merged: false });
        expect(duplicate).toMatchObject({ accepted: true, merged: true });
        expect(secondForUser).toMatchObject({ accepted: false });
        expect(store.counts().pendingRequests).toBe(2);
        expect(store.requestContext(first.accepted ? first.itemId : -1)).toEqual({ userName: 'One и Two' });
        store.close();
    });

    it('returns the same pending request after an identical listener retry, including after restart', () => {
        const { store, path } = diskStore();
        const now = 11_000_000;
        const input = { guildId: 'a', userId: 'u1', userName: 'One', track: track('abcdefghijk'), dedication: 'Для Маши' };
        const first = store.addRequest({ ...input, now });
        expect(first).toMatchObject({ accepted: true, merged: false });
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.addRequest({ ...input, now: now + 1 })).toMatchObject({
            accepted: true, requestId: first.accepted ? first.requestId : -1, duplicateSubmission: true,
        });
        expect(reopened.counts().pendingRequests).toBe(1);
        expect(reopened.addRequest({ ...input, dedication: 'Для Саши', now: now + 2 })).toMatchObject({ accepted: false });
        expect(reopened.addRequest({ ...input, now: now + 2 * 60_000 + 1 })).toMatchObject({ accepted: false });
        reopened.close();
    });

    it('preserves the merged label when retrying a request that joined another listener', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 11_250_000;
        const song = track('abcdefghijk');
        store.addRequest({ guildId: 'a', userId: 'first', userName: 'First', track: song, now });
        const input = { guildId: 'b', userId: 'second', userName: 'Second', track: song };
        const joined = store.addRequest({ ...input, now: now + 1 });
        expect(joined).toMatchObject({ accepted: true, merged: true });
        expect(store.addRequest({ ...input, now: now + 2 })).toMatchObject({
            accepted: true, requestId: joined.accepted ? joined.requestId : -1, merged: true, duplicateSubmission: true,
        });
        expect(store.counts().pendingRequests).toBe(2);
        store.close();
    });

    it('returns the same studio receipt for an identical listener retry without another cooldown charge', () => {
        const { store, path } = diskStore();
        const now = 11_500_000;
        const input = { guildId: 'a', userId: 'u1', userName: 'One', message: 'Поздравьте Машу' };
        const first = store.addStudioMessage({ ...input, now });
        expect(first).toMatchObject({ accepted: true });
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.addStudioMessage({ ...input, now: now + 1 })).toMatchObject({
            accepted: true, messageId: first.accepted ? first.messageId : -1, duplicateSubmission: true,
        });
        expect(reopened.counts().pendingStudioMessages).toBe(1);
        expect(reopened.addStudioMessage({ ...input, message: 'Поздравьте Сашу', now: now + 2 })).toMatchObject({ accepted: false });
        expect(reopened.addStudioMessage({ ...input, now: now + 2 * 60_000 + 1 })).toMatchObject({ accepted: false });
        reopened.close();
    });

    it('lets the owner bypass listener request and studio limits without bypassing broken-media quarantine', () => {
        const store = new RadioStore(':memory:', { ...policy, requestCooldownMs: 15 * 60_000 });
        const now = 12_000_000;
        const first = store.addRequest({ guildId: 'a', userId: 'owner', userName: 'Owner', track: track('abcdefghijk'), now, isOwner: true });
        const second = store.addRequest({ guildId: 'a', userId: 'owner', userName: 'Owner', track: track('bcdefghijkl'), now: now + 1, isOwner: true });
        expect(first.accepted).toBe(true);
        expect(second.accepted).toBe(true);
        expect(store.addRequest({ guildId: 'a', userId: 'listener', userName: 'Listener', track: track('cdefghijklm'), now })).toMatchObject({ accepted: true });
        expect(store.addRequest({ guildId: 'a', userId: 'listener', userName: 'Listener', track: track('defghijklmn'), now: now + 1 })).toMatchObject({ accepted: false });

        expect(store.addStudioMessage({ guildId: 'a', userId: 'owner', userName: 'Owner', message: 'Первая идея', now, isOwner: true }).accepted).toBe(true);
        expect(store.addStudioMessage({ guildId: 'a', userId: 'owner', userName: 'Owner', message: 'Вторая идея', now: now + 1, isOwner: true }).accepted).toBe(true);
        expect(store.addStudioMessage({ guildId: 'a', userId: 'listener', userName: 'Listener', message: 'Первая идея', now }).accepted).toBe(true);
        expect(store.addStudioMessage({ guildId: 'a', userId: 'listener', userName: 'Listener', message: 'Вторая идея', now: now + 1 }).accepted).toBe(false);

        const broken = track('efghijklmno');
        store.failItem(store.enqueueEditorial(broken, now), 'fetch failed', now + 1);
        expect(store.addRequest({ guildId: 'a', userId: 'owner', userName: 'Owner', track: broken, now: now + 2, isOwner: true }))
            .toMatchObject({ accepted: false, reason: expect.stringContaining('временно недоступен') });
        store.close();
    });

    it('places requests after editorial tracks and rotates guilds', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 20_000_000;
        store.addRequest({ guildId: 'a', userId: 'u1', userName: 'One', track: track('abcdefghijk'), now });
        store.addRequest({ guildId: 'b', userId: 'u2', userName: 'Two', track: track('bcdefghijkl'), now: now + 1 });
        store.enqueueEditorial(track('cdefghijklm'), now + 2);
        store.enqueueEditorial(track('defghijklmn'), now + 3);
        prepareAll(store, now + 4);

        const first = store.nextForPlayback(now + 10)!;
        expect(first.kind).toBe('editorial');
        store.finishItem(first.id, now + 11);
        const second = store.nextForPlayback(now + 12)!;
        expect(second.kind).toBe('editorial');
        store.finishItem(second.id, now + 13);
        const requestA = store.nextForPlayback(now + 14)!;
        expect(requestA.kind).toBe('request');
        expect(requestA.track?.id).toBe('abcdefghijk');
        store.finishItem(requestA.id, now + 15);

        store.enqueueEditorial(track('efghijklmno'), now + 16);
        prepareAll(store, now + 16);
        const bridge = store.nextForPlayback(now + 17)!;
        expect(bridge.kind).toBe('editorial');
        store.finishItem(bridge.id, now + 18);
        const requestB = store.nextForPlayback(now + 19)!;
        expect(requestB.track?.id).toBe('bcdefghijkl');
        store.close();
    });

    it('plays a second ready request when no editorial bridge is ready', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 21_000_000;
        store.addRequest({ guildId: 'a', userId: 'u1', userName: 'One', track: track('abcdefghijk'), now });
        store.addRequest({ guildId: 'b', userId: 'u2', userName: 'Two', track: track('bcdefghijkl'), now: now + 1 });
        prepareAll(store, now + 2);
        const first = store.nextForPlayback(now + 3)!;
        expect(first.kind).toBe('request');
        store.finishItem(first.id, now + 4);
        expect(store.peekNextForPlayback(now + 5)?.kind).toBe('request');
        const second = store.nextForPlayback(now + 5);
        expect(second?.kind).toBe('request');
        expect(second?.id).not.toBe(first.id);
        store.close();
    });

    it('credits a merged track to the next guild in rotation without playing it twice', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 30_000_000;
        const lead = store.addRequest({ guildId: 'a', userId: 'a1', userName: 'A1', track: track('abcdefghijk'), now });
        const mergedB = store.addRequest({ guildId: 'b', userId: 'b1', userName: 'B1', track: track('bcdefghijkl'), now: now + 1 });
        const mergedA = store.addRequest({ guildId: 'a', userId: 'a2', userName: 'A2', track: track('bcdefghijkl'), now: now + 2 });
        store.addRequest({ guildId: 'b', userId: 'b2', userName: 'B2', track: track('cdefghijklm'), now: now + 3 });
        store.addRequest({ guildId: 'a', userId: 'a3', userName: 'A3', track: track('defghijklmn'), now: now + 4 });
        expect(lead).toMatchObject({ accepted: true });
        expect(mergedB).toMatchObject({ accepted: true, merged: false });
        expect(mergedA).toMatchObject({ accepted: true, merged: true, itemId: mergedB.accepted ? mergedB.itemId : -1 });

        store.enqueueEditorial(track('efghijklmno'), now + 5);
        store.enqueueEditorial(track('fghijklmnop'), now + 6);
        prepareAll(store, now + 7);
        for (let index = 0; index < 2; index++) {
            const editorial = store.nextForPlayback(now + 10 + index * 2)!;
            expect(editorial.kind).toBe('editorial');
            store.finishItem(editorial.id, now + 11 + index * 2);
        }

        const first = store.nextForPlayback(now + 14)!;
        expect(first.track?.id).toBe('abcdefghijk');
        store.finishItem(first.id, now + 15);
        store.enqueueEditorial(track('ghijklmnopq'), now + 16);
        prepareAll(store, now + 16);
        const bridge = store.nextForPlayback(now + 17)!;
        expect(bridge.kind).toBe('editorial');
        store.finishItem(bridge.id, now + 18);

        const shared = store.nextForPlayback(now + 19)!;
        expect(shared.track?.id).toBe('bcdefghijkl');
        expect(shared.id).toBe(mergedB.accepted ? mergedB.itemId : -1);
        expect((store.db.prepare("SELECT value FROM settings WHERE key='last_request_guild'").get() as { value: string }).value).toBe('b');
        store.finishItem(shared.id, now + 20);
        expect(store.counts().pendingRequests).toBe(2);
        expect(
            (store.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE play_item_id=? AND status=\'fulfilled\'').get(shared.id) as { count: number }).count,
        ).toBe(2);

        store.enqueueEditorial(track('hijklmnopqr'), now + 21);
        prepareAll(store, now + 21);
        const secondBridge = store.nextForPlayback(now + 22)!;
        expect(secondBridge.kind).toBe('editorial');
        store.finishItem(secondBridge.id, now + 23);
        const next = store.nextForPlayback(now + 24)!;
        expect(next.track?.id).toBe('defghijklmn');
        store.close();
    });

    it('records an interrupted row and requeues it after restart', () => {
        const { store, path } = diskStore();
        store.enqueueEditorial(track('abcdefghijk'));
        prepareAll(store);
        const playing = store.nextForPlayback()!;
        store.close();

        const reopened = new RadioStore(path, policy);
        const interrupted = reopened.db.prepare("SELECT COUNT(*) AS count FROM play_items WHERE id=? AND state='interrupted'").get(playing.id) as { count: number };
        expect(Number(interrupted.count)).toBe(1);
        expect(reopened.claimPreparation()?.track?.id).toBe('abcdefghijk');
        reopened.close();
    });

    it('restores request scheduling when a claimed spin loses all outputs', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 20_000_000;
        store.addRequest({ guildId: 'a', userId: 'u1', userName: 'One', track: track('abcdefghijk'), now });
        store.enqueueEditorial(track('bcdefghijkl'), now + 1);
        store.enqueueEditorial(track('cdefghijklm'), now + 2);
        prepareAll(store, now + 3);
        for (let index = 0; index < 2; index++) {
            const editorial = store.nextForPlayback(now + 10 + index * 2)!;
            expect(editorial.kind).toBe('editorial');
            store.finishItem(editorial.id, now + 11 + index * 2);
        }
        const request = store.nextForPlayback(now + 20)!;
        expect(request.kind).toBe('request');
        expect(store.requeuePlaying(request.id, 'all outputs disconnected', now + 21)).toBe(true);
        expect(store.peekNextForPlayback(now + 22)?.id).toBe(request.id);
        expect(store.counts().pendingRequests).toBe(1);
        store.close();
    });

    it('requeues a preparation that was interrupted by a crash', () => {
        const { store, path } = diskStore();
        store.enqueueEditorial(track('abcdefghijk'));
        expect(store.claimPreparation()?.state).toBe('preparing');
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.claimPreparation()?.track?.id).toBe('abcdefghijk');
        reopened.close();
    });

    it('keeps a transiently failing request pending until its durable retry time', () => {
        const { store, path } = diskStore();
        const now = Date.now();
        const request = store.addRequest({ guildId: 'g', userId: 'u', userName: 'Listener', track: track('abcdefghijk'), now }, true);
        expect(request.accepted).toBe(true);
        if (!request.accepted) throw new Error('request was not accepted');
        expect(store.claimPreparation(now)?.id).toBe(request.itemId);
        expect(store.preparationAttempts(request.itemId)).toBe(1);
        expect(store.deferPreparation(request.itemId, 'fetch failed', now + 15_000, now + 1)).toBe(true);
        expect(store.claimPreparation(now + 14_999)).toBeUndefined();
        expect(store.counts().pendingRequests).toBe(1);
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.claimPreparation(now + 15_000)?.id).toBe(request.itemId);
        expect(reopened.preparationAttempts(request.itemId)).toBe(2);
        reopened.close();
    });

    it('keeps a studio message pending until its rendered break actually airs', () => {
        const store = new RadioStore(':memory:', policy);
        const accepted = store.addStudioMessage({ guildId: 'a', userId: 'u1', userName: 'One', message: 'Поздравьте Машу', now: 1_000 });
        expect(accepted).toMatchObject({ accepted: true });
        const pending = store.peekStudioMessage(2_000);
        expect(pending?.message).toBe('Поздравьте Машу');
        expect(store.counts().pendingStudioMessages).toBe(1);
        expect(store.markStudioAired(pending!.id, 2_001)).toBe(true);
        expect(store.counts().pendingStudioMessages).toBe(0);
        store.close();
    });

    it('does not air a prefetched studio message after its TTL expires', () => {
        const store = new RadioStore(':memory:', { ...policy, studioTtlMs: 100 });
        const accepted = store.addStudioMessage({ guildId: 'a', userId: 'u1', userName: 'One', message: 'Поздравьте Машу', now: 1_000 });
        expect(accepted).toMatchObject({ accepted: true });
        const pending = store.peekStudioMessage(1_050)!;
        expect(store.studioMessageCanAir(pending.id, 1_101)).toBe(false);
        expect(store.markStudioAired(pending.id, 1_101)).toBe(false);
        expect(store.counts().pendingStudioMessages).toBe(0);
        store.close();
    });

    it('lets the owner reject a pending studio message before a prefetched break airs', () => {
        const store = new RadioStore(':memory:', policy);
        const accepted = store.addStudioMessage({ guildId: 'a', userId: 'u1', userName: 'One', message: 'Поздравьте Машу', now: 1_000 });
        expect(accepted).toMatchObject({ accepted: true });
        const id = (accepted as { accepted: true; messageId: number }).messageId;
        expect(store.studioMessageCanAir(id, 1_100)).toBe(true);
        expect(store.rejectStudioMessage(id, 'Отклонено владельцем станции.', 1_101)).toBe(true);
        expect(store.studioMessageCanAir(id, 1_102)).toBe(false);
        expect(store.markStudioAired(id, 1_102)).toBe(false);
        expect(store.rejectStudioMessage(id, 'Повторное отклонение.', 1_103)).toBe(false);
        expect(store.counts().pendingStudioMessages).toBe(0);
        store.close();
    });

    it('spaces jingles by airtime and persists the interval anchor', () => {
        const { store, path } = diskStore();
        expect(store.jingleDue(30 * 60_000, 1_000)).toBe(false);
        expect(store.jingleDue(30 * 60_000, 1_801_000)).toBe(true);
        store.markJingleAired(1_801_000);
        store.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.jingleDue(30 * 60_000, 1_802_000)).toBe(false);
        expect(reopened.jingleDue(30 * 60_000, 3_602_000)).toBe(true);
        reopened.close();
    });

    it('expires request and studio records transactionally', () => {
        const store = new RadioStore(':memory:', { ...policy, requestTtlMs: 100, studioTtlMs: 100 });
        store.addRequest({ guildId: 'a', userId: 'u1', userName: 'One', track: track('abcdefghijk'), now: 1_000 });
        store.addStudioMessage({ guildId: 'a', userId: 'u2', userName: 'Two', message: 'Поздравьте Машу', now: 1_000 });
        store.expire(1_101);
        expect(store.counts()).toMatchObject({ pendingRequests: 0, pendingStudioMessages: 0 });
        store.close();
    });

    it('atomically extends the ready editorial tail while preserving playing music and listener requests', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 1_000_000;
        const proposal = fallbackShowPlan(now, []);
        const plan = store.ensureFallbackShowPlan(proposal, now);
        const playingId = store.enqueueEditorial(track('playing'), now);
        const oldReadyId = store.enqueueEditorial(track('old-ready'), now + 1);
        const oldPreparingId = store.enqueueEditorial(track('old-preparing'), now + 2);
        expect(store.claimPreparation(now + 3)?.id).toBe(playingId);
        expect(store.markReady(playingId, 'C:/cache/playing.media', now + 4)).toBe(true);
        expect(store.claimPreparation(now + 5)?.id).toBe(oldReadyId);
        expect(store.markReady(oldReadyId, 'C:/cache/old-ready.media', now + 6)).toBe(true);
        expect(store.claimPreparation(now + 7)?.id).toBe(oldPreparingId);
        expect(store.nextForPlayback(now + 8)?.id).toBe(playingId);
        const accepted = store.addRequest({ guildId: 'g', userId: 'u', userName: 'Listener', track: track('request'), now: now + 9 });
        expect(accepted.accepted).toBe(true);

        const replacement = store.applyEditorialPlan(plan.revision, proposal, [
            { track: track('new-second'), localPath: 'C:/cache/new-second.media' },
            { track: track('new-first'), localPath: 'C:/cache/new-first.media' },
        ], now + 10);
        expect(replacement?.revision).toBe(plan.revision + 1);
        expect(store.current()?.id).toBe(playingId);
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(accepted.accepted ? accepted.itemId : -1)).toEqual({ state: 'queued' });
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(oldReadyId)).toEqual({ state: 'ready' });
        expect(store.db.prepare('SELECT state FROM play_items WHERE id=?').get(oldPreparingId)).toEqual({ state: 'expired' });
        expect(store.markReady(oldPreparingId, 'C:/cache/stale.media', now + 11)).toBe(false);
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['old-ready', 'new-second', 'new-first']);
        expect(store.canQueueEditorial(track('new-first'), now + 12)).toBe(false);
        store.close();
    });

    it('rejects stale, empty, duplicate and cooldown editorial plans without partial writes', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 2_000_000;
        const proposal = fallbackShowPlan(now, []);
        const plan = store.ensureFallbackShowPlan(proposal, now);
        const oldId = store.enqueueEditorial(track('old'), now);
        const staged = [
            { track: track('new-a'), localPath: 'C:/cache/a.media' },
            { track: track('new-b'), localPath: 'C:/cache/b.media' },
        ];
        expect(store.applyEditorialPlan(plan.revision + 1, proposal, staged, now + 1)).toBeUndefined();
        expect(store.applyEditorialPlan(plan.revision, proposal, [], now + 1)).toBeUndefined();
        expect(store.applyEditorialPlan(plan.revision, proposal, [staged[0]!, staged[0]!], now + 1)).toBeUndefined();
        expect(store.applyEditorialPlan(plan.revision, proposal, [staged[0]!,
            { track: { ...staged[0]!.track, id: 'new-c', artist: ` ${staged[0]!.track.artist.toUpperCase()} ` },
                localPath: 'C:/cache/c.media' }], now + 1)).toBeUndefined();
        expect(store.currentShowPlan(now + 2)?.revision).toBe(plan.revision);
        expect(store.upcomingEditorial().map(item => item.id)).toEqual([oldId]);

        const recentlyPlayed = store.enqueueEditorial(track('recent'), now + 3);
        expect(store.claimPreparation(now + 4)?.id).toBe(oldId);
        expect(store.markReady(oldId, 'C:/cache/old.media', now + 5)).toBe(true);
        expect(store.nextForPlayback(now + 6)?.id).toBe(oldId);
        store.finishItem(oldId, now + 7);
        expect(store.canQueueEditorial(track('old'), now + 8)).toBe(false);
        expect(store.applyEditorialPlan(plan.revision, proposal, [staged[0]!,
            { track: track('old'), localPath: 'C:/cache/recent.media' }], now + 8)).toBeUndefined();
        expect(store.currentShowPlan(now + 9)?.revision).toBe(plan.revision);
        expect(store.upcomingEditorial().map(item => item.id)).toEqual([recentlyPlayed]);
        store.close();
    });

    it('accepts one verified AI-selected track when the station has no ready successor', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 2_100_000;
        const proposal = fallbackShowPlan(now, []);
        const plan = store.ensureFallbackShowPlan(proposal, now);
        const applied = store.applyEditorialPlan(plan.revision, proposal,
            [{ track: track('one'), localPath: 'C:/cache/one.media' }], now + 1);
        expect(applied?.source).toBe('model');
        expect(store.upcomingEditorial().map(item => item.track.id)).toEqual(['one']);
        store.close();
    });

    it('rejects a new plan that repeats a ready artist while keeping the ready tail intact', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 2_500_000;
        const proposal = fallbackShowPlan(now, []);
        const plan = store.ensureFallbackShowPlan(proposal, now);
        const readyId = store.enqueueEditorial(track('ready'), now);
        expect(store.claimPreparation(now + 1)?.id).toBe(readyId);
        expect(store.markReady(readyId, 'C:/cache/ready.media', now + 2)).toBe(true);
        expect(store.applyEditorialPlan(plan.revision, proposal, [
            { track: track('ready-copy', 'Artist ready'), localPath: 'C:/cache/copy.media' },
            { track: track('other'), localPath: 'C:/cache/other.media' },
        ], now + 3)).toBeUndefined();
        expect(store.currentShowPlan(now + 4)?.revision).toBe(plan.revision);
        expect(store.upcomingEditorial().map(item => item.id)).toEqual([readyId]);
        store.close();
    });

    it('rolls back the plan update and all queue changes when inserting staged media fails', () => {
        const store = new RadioStore(':memory:', policy);
        const now = 3_000_000;
        const proposal = fallbackShowPlan(now, []);
        const plan = store.ensureFallbackShowPlan(proposal, now);
        const oldId = store.enqueueEditorial(track('old'), now);
        store.db.exec("CREATE TRIGGER fail_second_editorial BEFORE INSERT ON play_items WHEN NEW.provider_id='new-b' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
        expect(() => store.applyEditorialPlan(plan.revision, proposal, [
            { track: track('new-a'), localPath: 'C:/cache/a.media' },
            { track: track('new-b'), localPath: 'C:/cache/b.media' },
        ], now + 1)).toThrow('test failure');
        expect(store.currentShowPlan(now + 2)?.revision).toBe(plan.revision);
        expect(store.upcomingEditorial().map(item => item.id)).toEqual([oldId]);
        expect(store.db.prepare("SELECT COUNT(*) AS count FROM tracks WHERE provider_id IN ('new-a','new-b')").get()).toEqual({ count: 0 });
        store.close();
    });
});
