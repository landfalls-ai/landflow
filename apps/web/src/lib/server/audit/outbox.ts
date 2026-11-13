/**
 * The SIEM outbox: every stored audit event has a row in `audit_outbox` per destination that was enabled when it was
 * recorded (written in the event's transaction, ./store), and stays there until the destination took it. A dispatcher
 * in each process that runs `startAuditOutbox()` (bootstrap) delivers due rows oldest first, in batches per
 * destination: it claims them with a lease inside one `BEGIN IMMEDIATE` transaction (so two processes on the same
 * database don't both send a batch), deletes them once delivered, and on a failure pushes them back with exponential
 * backoff (2 s doubling, capped at 5 minutes, with jitter) and leaves that destination alone until then. Rows of a
 * disabled destination wait; deleting the destination drops them; retention (Settings → Audit log) prunes events
 * and their outbox rows hourly. Delivery runs on a 5 s tick and is kicked when an event is recorded.
 */
import type { AuditEvent } from '../../shared/audit';
import { database } from '../db';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { auditDestinations } from './destinations';
import { ensureAuditMetrics, recordAuditDeliveryFailure } from './metrics';
import { recordAudit, setOutboxKick } from './index';
import { getAuditSettings } from './settings';
import { BATCH_SIZE, deliver } from './sinks';
import { getEvents, pruneEventsAsync } from './store';

const TICK_MS = 5_000;
const KICK_DELAY_MS = 150;
const LEASE_MS = 60_000;
const HOUR_MS = 3_600_000;
export const MAX_BACKOFF_MS = 300_000;

interface OutboxRow {
  destination_id: string;
  event_id: string;
  created_at: string;
  attempts: number;
  next_at: string;
  lease_until: string | null;
  last_error: string | null;
}

/** The delay before attempt `attempts + 1` after `attempts` failures: 2 s doubling, at most 5 minutes, ±20 %. */
export function backoffMs(attempts: number, random = Math.random()): number {
  const base = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(Math.min(MAX_BACKOFF_MS, base * (0.8 + 0.4 * random)));
}

interface State {
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
  pruner?: ReturnType<typeof setInterval>;
  kickTimer?: ReturnType<typeof setTimeout>;
  /** Destinations backing off in this process, until when (ms). */
  backoff: Map<string, number>;
  /** The tick in progress, so callers (tests, shutdown) can wait for it. */
  current?: Promise<number>;
}

const state = () => singleton<State>('audit-outbox', () => ({ running: false, backoff: new Map() }));

/** Claim up to `limit` due rows of `destinationId` for this process (a lease of a minute). */
function claim(destinationId: string, limit: number, now: number): OutboxRow[] {
  const db = database();
  const at = new Date(now).toISOString();
  const lease = new Date(now + LEASE_MS).toISOString();
  return db.transaction(() => {
    const rows = db.all<OutboxRow>(
      'SELECT * FROM audit_outbox WHERE destination_id = ? AND next_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at, event_id LIMIT ?',
      destinationId,
      at,
      at,
      limit,
    );
    for (const row of rows) db.upsert('audit_outbox', { ...row, lease_until: lease });
    return rows;
  });
}

function settle(rows: OutboxRow[], error: Error | undefined, now: number): number {
  const db = database();
  return db.transaction(() => {
    if (!error) {
      for (const row of rows) db.delete('audit_outbox', { destination_id: row.destination_id, event_id: row.event_id });
      return 0;
    }
    let next = 0;
    for (const row of rows) {
      const attempts = Number(row.attempts) + 1;
      const at = now + backoffMs(attempts);
      next = Math.max(next, at);
      db.upsert('audit_outbox', { ...row, attempts, next_at: new Date(at).toISOString(), lease_until: null, last_error: error.message.slice(0, 500) });
    }
    return next;
  });
}

/** Deliver what is due to one destination. Returns how many events it took. */
async function drainDestination(destinationId: string, now: number): Promise<number> {
  const s = state();
  const until = s.backoff.get(destinationId);
  if (until && until > now) return 0;
  s.backoff.delete(destinationId);
  const destination = auditDestinations.forSending(destinationId);
  if (!destination?.enabled) return 0;
  let delivered = 0;
  for (let round = 0; round < 20; round++) {
    const rows = claim(destinationId, BATCH_SIZE, Date.now());
    if (!rows.length) break;
    const byId = new Map(getEvents(rows.map((row) => row.event_id)).map((event) => [event.id, event]));
    // Rows whose event is gone (pruned meanwhile) are simply dropped.
    const events = rows.map((row) => byId.get(row.event_id)).filter((event): event is AuditEvent => Boolean(event));
    let failure: Error | undefined;
    try {
      await deliver(destination, events);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    const next = settle(rows, failure, Date.now());
    auditDestinations.noteDelivery(destinationId, { at: new Date().toISOString(), ok: !failure, ...(failure ? { message: failure.message } : { message: `Delivered ${events.length} event${events.length === 1 ? '' : 's'}` }) });
    if (failure) {
      s.backoff.set(destinationId, next);
      recordAuditDeliveryFailure(destination.name);
      logger.warn('audit destination delivery failed', { 'landflow.audit.destination': destination.name, error: failure.message });
      break;
    }
    delivered += events.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return delivered;
}

/** One pass over every destination with due rows. Returns how many events were delivered. */
export function drainOutbox(now = Date.now()): Promise<number> {
  const s = state();
  if (s.current) return s.current;
  const run = (async () => {
    let total = 0;
    try {
      const due = database()
        .all<{ destination_id: string }>('SELECT DISTINCT destination_id FROM audit_outbox WHERE next_at <= ?', new Date(now).toISOString())
        .map((row) => row.destination_id);
      const results = await Promise.allSettled(due.map((id) => drainDestination(id, now)));
      for (const result of results) if (result.status === 'fulfilled') total += result.value;
    } catch (error) {
      logger.warn('audit outbox pass failed', { error: (error as Error).message });
    }
    return total;
  })();
  s.current = run;
  void run.finally(() => {
    if (s.current === run) s.current = undefined;
  });
  return run;
}

function kick() {
  const s = state();
  if (!s.running || s.kickTimer) return;
  s.kickTimer = setTimeout(() => {
    s.kickTimer = undefined;
    void drainOutbox();
  }, KICK_DELAY_MS);
  s.kickTimer.unref?.();
}

/** Apply audit retention now. Returns how many events went. */
export async function pruneAuditLog(now = Date.now()): Promise<number> {
  try {
    const removed = await pruneEventsAsync(getAuditSettings().retentionDays, now);
    if (removed) logger.info('pruned audit events', { 'landflow.audit.pruned': removed });
    return removed;
  } catch (error) {
    logger.warn('audit retention failed', { error: (error as Error).message });
    return 0;
  }
}

/** Start delivering (5 s tick plus kicks) and hourly retention. Idempotent. */
export function startAuditOutbox() {
  const s = state();
  if (s.running) return;
  s.running = true;
  ensureAuditMetrics();
  setOutboxKick(kick);
  s.timer = setInterval(() => void drainOutbox(), TICK_MS);
  s.timer.unref?.();
  void pruneAuditLog();
  s.pruner = setInterval(() => void pruneAuditLog(), HOUR_MS);
  s.pruner.unref?.();
  kick();
}

export async function stopAuditOutbox() {
  const s = state();
  s.running = false;
  setOutboxKick(undefined);
  if (s.timer) clearInterval(s.timer);
  if (s.pruner) clearInterval(s.pruner);
  if (s.kickTimer) clearTimeout(s.kickTimer);
  s.timer = s.pruner = s.kickTimer = undefined;
  s.backoff.clear();
  await s.current?.catch(() => 0);
}

/** Forget in-process backoff (tests; Settings "Retry now" after fixing a destination). */
export function resetOutboxBackoff(destinationId?: string) {
  const s = state();
  if (destinationId) s.backoff.delete(destinationId);
  else s.backoff.clear();
}

/** Make every queued row of `destinationId` due now (after fixing its settings). */
export function retryDestinationNow(destinationId: string): number {
  resetOutboxBackoff(destinationId);
  const db = database();
  const now = new Date().toISOString();
  const rows = db.all<OutboxRow>('SELECT * FROM audit_outbox WHERE destination_id = ? AND next_at > ?', destinationId, now);
  db.transaction(() => {
    for (const row of rows) db.upsert('audit_outbox', { ...row, next_at: now });
  });
  kick();
  return rows.length;
}

/**
 * "Send test event" in Settings: deliver one `audit.test` event straight to the destination (not through the outbox,
 * so the answer is immediate), and record the attempt in the audit log.
 */
export async function sendTestEvent(destinationId: string): Promise<{ ok: boolean; message: string }> {
  const destination = auditDestinations.forSending(destinationId);
  if (!destination) return { ok: false, message: 'Audit destination not found' };
  const at = new Date();
  const probe: AuditEvent = {
    id: `aud_test_${at.getTime().toString(36)}`,
    at: at.toISOString(),
    action: 'audit.test',
    category: 'audit',
    outcome: 'success',
    actor: { type: 'system' },
    target: { type: 'audit_destination', id: destination.id, name: destination.name },
    summary: `Test event from Landflow to “${destination.name}”`,
    details: { test: true },
  };
  let result: { ok: boolean; message: string };
  try {
    await deliver(destination, [probe]);
    result = { ok: true, message: `Delivered a test event to ${destination.name}` };
  } catch (error) {
    result = { ok: false, message: (error as Error).message || 'Delivery failed' };
  }
  auditDestinations.noteDelivery(destination.id, { at: new Date().toISOString(), ok: result.ok, message: result.ok ? 'Test event delivered' : result.message });
  recordAudit({
    action: 'audit.test',
    outcome: result.ok ? 'success' : 'failure',
    target: { type: 'audit_destination', id: destination.id, name: destination.name },
    summary: `${result.ok ? 'Sent' : 'Could not send'} a test event to “${destination.name}”`,
    details: { kind: destination.kind, ...(!result.ok && { error: result.message }) },
  });
  return result;
}
