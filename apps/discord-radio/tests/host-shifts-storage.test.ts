import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { MAX_HOST_SHIFT_MS, RadioStore } from '../src/storage.js';

const policy = {
    requestCooldownMs: 0,
    requestTtlMs: 60_000,
    studioCooldownMs: 0,
    studioTtlMs: 60_000,
    trackCooldownMs: 0,
    artistCooldownMs: 0,
};

function withDatabase(test: (path: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'radio-host-shifts-'));
    try {
        test(join(root, 'radio.sqlite'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe('durable host shifts', () => {
    it('persists one confirmed on-air introduction across a restart', () => withDatabase(path => {
        const first = new RadioStore(path, policy);
        const shift = first.startHostShift('glm', 20_000, 1_000, null)!;
        expect(first.markHostIntroduced(shift.id, 2_000)).toBe(true);
        expect(first.markHostIntroduced(shift.id, 3_000)).toBe(false);
        first.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.currentHostShift()).toMatchObject({ id: shift.id, hostId: 'glm', introducedAt: 2_000 });
        reopened.close();
    }));

    it('migrates a legacy database without changing existing state and survives restart', () => withDatabase(path => {
        const legacy = new DatabaseSync(path);
        legacy.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('legacy','kept')");
        legacy.close();

        const first = new RadioStore(path, policy);
        expect(first.currentHostShift()).toBeUndefined();
        expect(first.db.prepare("SELECT value FROM settings WHERE key='legacy'").get()).toEqual({ value: 'kept' });
        const luna = first.startHostShift('luna', 11_000, 1_000, null);
        expect(luna).toEqual({ id: 1, hostId: 'luna', startedAt: 1_000, plannedEndAt: 11_000 });
        first.close();

        const reopened = new RadioStore(path, policy);
        expect(reopened.currentHostShift()).toEqual(luna);
        const sol = reopened.startHostShift('sol', 21_000, 10_000, luna!.id);
        expect(sol).toMatchObject({ id: 2, hostId: 'sol', startedAt: 10_000, plannedEndAt: 21_000 });
        expect(reopened.precedingHostShift(sol!.id)).toMatchObject({ id: luna!.id, hostId: 'luna', endedAt: 10_000 });
        expect(reopened.precedingHostShift(luna!.id)).toBeUndefined();
        expect(reopened.recentHostShifts(5_000)).toEqual([{ ...luna, endedAt: 10_000 }, sol]);
        expect(reopened.recentHostShifts(10_001)).toEqual([sol]);
        reopened.close();
    }));

    it('uses CAS across two store instances and does not duplicate a renewed host', () => withDatabase(path => {
        const a = new RadioStore(path, policy);
        const b = new RadioStore(path, policy);
        try {
            const original = a.startHostShift('deepseek', 12_000, 1_000, null)!;
            expect(b.startHostShift('glm', 13_000, 2_000, null)).toBeUndefined();
            expect(b.startHostShift('deepseek', 14_000, 3_000, original.id)).toEqual({ ...original, plannedEndAt: 14_000 });
            expect(a.currentHostShift()?.plannedEndAt).toBe(14_000);
            const next = a.startHostShift('grok', 25_000, 9_000, original.id)!;
            expect(b.startHostShift('claude', 26_000, 10_000, original.id)).toBeUndefined();
            expect(a.currentHostShift()).toEqual(next);
            expect(a.recentHostShifts(0)).toHaveLength(2);
            expect(() => a.db.prepare('INSERT INTO host_shifts(host_id,started_at,planned_end_at) VALUES(?,?,?)').run('luna', 10_000, 20_000)).toThrow();
            expect(a.currentHostShift()).toEqual(next);
        } finally {
            a.close();
            b.close();
        }
    }));

    it('rolls back retirement if the replacement insert fails', () => withDatabase(path => {
        const store = new RadioStore(path, policy);
        try {
            const current = store.startHostShift('luna', 10_000, 1_000, null)!;
            store.db.exec("CREATE TRIGGER reject_glm BEFORE INSERT ON host_shifts WHEN NEW.host_id='glm' BEGIN SELECT RAISE(ABORT,'test rejection'); END");
            expect(() => store.startHostShift('glm', 20_000, 5_000, current.id)).toThrow('test rejection');
            expect(store.currentHostShift()).toEqual(current);
            expect(store.recentHostShifts(0)).toEqual([current]);
        } finally {
            store.close();
        }
    }));

    it('commits an incoming shift and verified editorial music atomically', () => withDatabase(path => {
        const store = new RadioStore(path, policy);
        try {
            const now = Date.now();
            const current = store.startHostShift('sol', now + 10_000, now, null)!;
            const plan = store.ensureFallbackShowPlan({ theme: 'Старый эфир', queries: ['one', 'two', 'three'],
                requestRun: 'alternate' }, now);
            const track = { provider: 'ytmusic' as const, id: 'abcdefghijk', title: 'Новая песня',
                artist: 'Новый артист', durationMs: 180_000 };
            const staged = [{ track, localPath: 'C:/cache/new.media' }];
            const proposal = { theme: 'Новая смена', queries: ['Artist A — Song A', 'Artist B — Song B',
                'Artist C — Song C'], requestRun: 'alternate' as const };
            store.db.exec(`CREATE TRIGGER reject_prepared_music BEFORE INSERT ON play_items
                WHEN NEW.kind='editorial' AND NEW.state='ready' BEGIN SELECT RAISE(ABORT,'test media commit failure'); END`);
            expect(() => store.startHostShiftWithEditorialPlan('glm', now + 190_000, now + 10_001,
                current.id, plan.revision, proposal, staged)).toThrow('test media commit failure');
            expect(store.currentHostShift()).toEqual(current);
            expect(store.currentShowPlan()?.revision).toBe(plan.revision);
            expect(store.db.prepare('SELECT COUNT(*) AS count FROM play_items').get()).toEqual({ count: 0 });
            store.db.exec('DROP TRIGGER reject_prepared_music');
            const committed = store.startHostShiftWithEditorialPlan('glm', now + 190_000, now + 10_001,
                current.id, plan.revision, proposal, staged);
            expect(committed?.shift.hostId).toBe('glm');
            expect(committed?.plan.theme).toBe('Новая смена');
            expect(store.upcomingEditorial().map(item => item.track.id)).toEqual([track.id]);
        } finally {
            store.close();
        }
    }));

    it('rejects unknown hosts and invalid time or CAS identifiers before mutation', () => {
        const store = new RadioStore(':memory:', policy);
        try {
            expect(() => store.startHostShift('unknown' as 'luna', 2_000, 1_000, null)).toThrow('Unknown host');
            expect(() => store.startHostShift('luna', 1_000, 1_000, null)).toThrow('duration');
            expect(() => store.startHostShift('luna', MAX_HOST_SHIFT_MS + 1_001, 1_000, null)).toThrow('duration');
            expect(() => store.startHostShift('luna', 2_000, 1_000, 0)).toThrow('expected');
            expect(() => store.recentHostShifts(Number.NaN)).toThrow('timestamp');
            expect(store.currentHostShift()).toBeUndefined();
        } finally {
            store.close();
        }
    });
});
