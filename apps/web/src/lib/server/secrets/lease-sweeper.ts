/**
 * The lease sweeper (C30, a leader service: one process sweeps). Every minute it
 *
 *   1. revokes the leases of runs that are over or gone (the run's own end already did, so this is the host that was
 *      killed, a worker that died between save and revoke, and a revoke that failed): retried on a backoff of 30 s,
 *      doubling, at most 30 minutes, and given up (`revoke_failed`, an audit event) after 24 hours of failures;
 *   2. ends leases whose time passed while their run still goes or waits (`expired`: the store removed them itself), and
 *      renews a running run's lease that has under two minutes left, up to an hour after it was issued;
 *   3. deletes ended rows older than 30 days (a lease that could not be revoked stays until an admin looks at it).
 *
 * At most 200 rows a step. A run that has no saved row yet is left alone for two minutes (its first node may be
 * asking for its lease before the run's first save). The clock is `now`, so tests move it.
 */
import { database } from '../db';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { expireRow, renewRow, revokeRow, type LeaseRow } from './leases';

export const SWEEP_EVERY_MS = 60_000;
export const ROWS_PER_TICK = 200;
/** A running run's lease with less than this left is renewed. */
export const RENEW_WINDOW_MS = 2 * 60_000;
/** A run with no saved row is ended only when its lease is older than this. */
const UNSAVED_GRACE_MS = 2 * 60_000;
const KEEP_ENDED_MS = 30 * 24 * 3_600_000;

const iso = (ms: number) => new Date(ms).toISOString();

export interface SweepResult {
  revoked: number;
  failed: number;
  expired: number;
  renewed: number;
  pruned: number;
}

export const leaseSweeper = singleton('secret-lease-sweeper', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function sweep(now: number): Promise<SweepResult> {
    const db = database();
    const result: SweepResult = { revoked: 0, failed: 0, expired: 0, renewed: 0, pruned: 0 };
    const due = iso(now);

    // 1. Runs that are over (or gone): revoke.
    const over = db.all<LeaseRow>(
      `SELECT l.* FROM secret_leases l LEFT JOIN executions e ON e.id = l.execution_id
        WHERE l.state = 'active' AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= ?)
          AND ((e.id IS NULL AND l.issued_at < ?) OR e.status NOT IN ('running', 'queued', 'waiting'))
        ORDER BY l.issued_at LIMIT ?`,
      due,
      iso(now - UNSAVED_GRACE_MS),
      ROWS_PER_TICK,
    );
    for (const outcome of await Promise.all(over.map((row) => revokeRow(row, 'sweeper', now)))) {
      if (outcome === 'revoked' || outcome === 'expired') result.revoked += 1;
      else if (outcome === 'failed') result.failed += 1;
    }

    // 2. Runs that go on (or wait): end what ran out, renew what is about to.
    const live = db.all<LeaseRow & { run_status: string }>(
      `SELECT l.*, e.status AS run_status FROM secret_leases l JOIN executions e ON e.id = l.execution_id
        WHERE l.state = 'active' AND e.status IN ('running', 'queued', 'waiting') AND l.expires_at <= ? AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= ?)
        ORDER BY l.expires_at LIMIT ?`,
      iso(now + RENEW_WINDOW_MS),
      due,
      ROWS_PER_TICK,
    );
    for (const { run_status: status, ...row } of live) {
      if (Date.parse(row.expires_at) <= now) {
        expireRow(row, now);
        result.expired += 1;
      } else if (status === 'running' && (await renewRow(row, now))) result.renewed += 1;
    }

    // 3. Old ended rows.
    const old = db.all<{ id: string }>(`SELECT id FROM secret_leases WHERE state IN ('revoked', 'expired') AND ended_at < ? LIMIT ?`, iso(now - KEEP_ENDED_MS), ROWS_PER_TICK);
    for (const { id } of old) result.pruned += db.delete('secret_leases', { id });
    return result;
  }

  /** One pass. A pass still going makes the next one a no-op (a slow store must not stack passes). */
  async function tick(now = Date.now()): Promise<SweepResult> {
    if (running) return { revoked: 0, failed: 0, expired: 0, renewed: 0, pruned: 0 };
    running = true;
    try {
      return await sweep(now);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch((error: Error) => logger.warn('lease sweep failed', { error: error.message })), SWEEP_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
});
