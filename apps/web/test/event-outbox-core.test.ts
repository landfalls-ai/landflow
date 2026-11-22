/**
 * The shared outbox core (lib/server/outbox/core.ts), on both tables that use it (`event_outbox` for subscriptions,
 * `audit_outbox` for SIEM destinations): backoff numbers, leases, ordered and unordered claims, settling, dead rows and
 * pruning. The schema of migration 2924 and the audit labels of its subscriptions are checked here too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-outbox-core-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { MIGRATIONS, TABLES } = await import('@/lib/server/db/schema');
const { AUDIT_ACTIONS } = await import('@/lib/shared/audit');
const core = await import('@/lib/server/outbox/core');
const { backoffMs: auditBackoff, MAX_BACKOFF_MS: auditMax } = await import('@/lib/server/audit/outbox');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-22T10:00:00Z');

describe('migration 2924', () => {
  it('creates the subscription and outbox tables', () => {
    const db = database();
    expect(db.all('SELECT * FROM event_subscriptions')).toEqual([]);
    expect(db.all('SELECT * FROM event_outbox')).toEqual([]);
    expect(TABLES.event_subscriptions).toEqual(['id']);
    expect(TABLES.event_outbox).toEqual(['topic', 'target_id', 'event_id']);
    expect(MIGRATIONS.some((m) => m.version === 2924)).toBe(true);
  });

  it('labels the subscription audit actions', () => {
    for (const action of ['event_subscription.created', 'event_subscription.updated', 'event_subscription.deleted']) expect(AUDIT_ACTIONS).toHaveProperty([action]);
  });
});

describe('backoff', () => {
  it('gives the numbers the audit outbox always had', () => {
    expect(core.MAX_BACKOFF_MS).toBe(300_000);
    expect(core.backoffMs(1, 0.5)).toBe(2_000);
    expect(core.backoffMs(2, 0.5)).toBe(4_000);
    expect(core.backoffMs(3, 0)).toBe(Math.round(8_000 * 0.8));
    expect(core.backoffMs(3, 1)).toBe(Math.round(8_000 * 1.2));
    expect(core.backoffMs(40, 0.5)).toBe(300_000);
    expect(core.backoffMs(40, 1)).toBe(300_000);
  });
  it('is re-exported by the audit outbox', () => {
    expect(auditBackoff).toBe(core.backoffMs);
    expect(auditMax).toBe(core.MAX_BACKOFF_MS);
  });
});

for (const [name, t] of [
  ['event_outbox', core.SUBSCRIPTION_OUTBOX],
  ['audit_outbox', core.AUDIT_OUTBOX],
] as const) {
  describe(`the core on ${name}`, () => {
    const db = () => database();
    const put = (eventId: string, createdMs: number, over: Record<string, string | number | null> = {}) =>
      db().insertNew(t.table, {
        ...(t.topic && { topic: t.topic, payload: '{}', dead_at: null }),
        [t.target]: 'T1',
        event_id: eventId,
        created_at: iso(createdMs),
        attempts: 0,
        next_at: iso(createdMs),
        lease_until: null,
        last_error: null,
        ...over,
      });
    const rowsOf = () => db().all<Record<string, string | number | null>>(`SELECT * FROM ${t.table} ORDER BY created_at, event_id`);

    beforeEach(() => {
      db().deleteBefore(t.table, 'created_at', '9999');
    });

    it('claims due rows with a lease, skips leased ones and takes them back when the lease ends', () => {
      put('a', NOW - 3000);
      put('b', NOW - 2000);
      put('later', NOW - 1000, { next_at: iso(NOW + 600_000) });
      const first = core.claimDue(t, 'T1', 10, NOW, false);
      expect(first.map((r) => r.event_id)).toEqual(['a', 'b']);
      expect(rowsOf().find((r) => r.event_id === 'a')?.lease_until).toBe(iso(NOW + core.LEASE_MS));
      expect(core.claimDue(t, 'T1', 10, NOW + 1000, false)).toEqual([]);
      expect(core.claimDue(t, 'T1', 10, NOW + core.LEASE_MS + 1, false).map((r) => r.event_id)).toEqual(['a', 'b']);
    });

    it('does not claim another target’s rows and honours the limit', () => {
      put('a', NOW - 3000);
      put('b', NOW - 2000);
      db().insertNew(t.table, { ...(t.topic && { topic: t.topic, payload: '{}', dead_at: null }), [t.target]: 'T2', event_id: 'x', created_at: iso(NOW - 5000), attempts: 0, next_at: iso(NOW - 5000), lease_until: null, last_error: null });
      expect(core.claimDue(t, 'T1', 1, NOW, false).map((r) => r.event_id)).toEqual(['a']);
    });

    it('ordered: nothing is claimed while the oldest row waits or is leased; unordered claims the later one', () => {
      put('a', NOW - 3000, { attempts: 1, next_at: iso(NOW + 4000), last_error: 'boom' });
      put('b', NOW - 2000);
      expect(core.claimDue(t, 'T1', 10, NOW, true)).toEqual([]);
      expect(core.claimDue(t, 'T1', 10, NOW, false).map((r) => r.event_id)).toEqual(['b']);
      db().delete(t.table, { ...(t.topic && { topic: t.topic }), [t.target]: 'T1', event_id: 'b' });
      expect(core.claimDue(t, 'T1', 10, NOW + 5000, true).map((r) => r.event_id)).toEqual(['a']);
      // A leased oldest row blocks the next one as well.
      put('c', NOW - 1000, { next_at: iso(NOW + 5000) });
      expect(core.claimDue(t, 'T1', 10, NOW + 5001, true)).toEqual([]);
    });

    it('settles: ok deletes, an error backs off and keeps at most 500 characters of the message', () => {
      put('a', NOW - 3000);
      const claimed = core.claimDue(t, 'T1', 10, NOW, true);
      const next = core.settleRows(t, claimed, { error: new Error('x'.repeat(900)) }, NOW);
      const row = rowsOf()[0]!;
      expect(row.attempts).toBe(1);
      expect(String(row.last_error)).toHaveLength(500);
      expect(row.lease_until).toBeNull();
      expect(Date.parse(String(row.next_at))).toBe(next);
      expect(next - NOW).toBeGreaterThanOrEqual(1_600);
      expect(next - NOW).toBeLessThanOrEqual(2_400);
      expect(core.settleRows(t, core.claimDue(t, 'T1', 10, next, true), { ok: true }, next)).toBe(0);
      expect(rowsOf()).toEqual([]);
    });

    it('prunes dead rows older than the cut (event_outbox only)', () => {
      put('a', NOW - 3000);
      if (!t.dead) {
        expect(() => core.settleRows(t, core.claimDue(t, 'T1', 1, NOW, false), { error: new Error('no'), dead: true }, NOW)).toThrow();
        return;
      }
      put('b', NOW - 2000);
      const claimed = core.claimDue(t, 'T1', 10, NOW, false);
      core.settleRows(t, claimed.slice(0, 1), { error: new Error('gave up'), dead: true }, NOW - 40 * 86_400_000);
      core.settleRows(t, claimed.slice(1), { error: new Error('gave up'), dead: true }, NOW - 1_000);
      expect(rowsOf().map((r) => r.dead_at !== null)).toEqual([true, true]);
      // Dead rows are never claimed.
      expect(core.claimDue(t, 'T1', 10, NOW + 10 * 86_400_000, false)).toEqual([]);
      expect(core.pruneDead(t, NOW - 30 * 86_400_000)).toBe(1);
      expect(rowsOf().map((r) => r.event_id)).toEqual(['b']);
    });

    it('makeDue brings waiting rows (and revives dead ones) to now', () => {
      put('a', NOW - 3000, { attempts: 3, next_at: iso(NOW + 100_000), last_error: 'e' });
      put('b', NOW - 2000, t.dead ? { dead_at: iso(NOW - 1000), next_at: iso(NOW - 1000) } : {});
      const n = core.makeDue(t, 'T1', NOW, true);
      expect(n).toBe(t.dead ? 2 : 1);
      const rows = rowsOf();
      expect(rows.every((r) => Date.parse(String(r.next_at)) <= NOW)).toBe(true);
      if (t.dead) expect(rows.every((r) => r.dead_at === null)).toBe(true);
    });
  });
}
