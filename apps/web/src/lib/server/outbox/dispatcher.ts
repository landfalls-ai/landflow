/**
 * The leader's delivery loop for event subscriptions (a `SERVICES` entry in ../runtime, `leader: true`). Every 2 seconds,
 * and when the save hook says rows were written, it goes through the enabled subscriptions: it claims what is due (one
 * row at a time, oldest first, when the subscription is ordered; a batch otherwise), POSTs it (./deliver), and settles
 * the row: a 2xx deletes it, a 410 turns the subscription off, anything else backs off (../outbox/core) and tries again.
 * A row still failing 72 hours after it was created is dead-lettered (kept, shown on the card, back with Retry now).
 * Delivery is at least once: a crash between the POST and the delete, or a lease that ran out, sends the same event again
 * with the same `x-landflow-event-id`.
 *
 * Also here, once a minute: the backlog bound (the oldest rows beyond 10,000 per subscription are dead-lettered, never on
 * the save path) and the pruning of dead rows after 30 days. A leader that dies mid-delivery leaves leases that run out
 * after a minute, then the next leader delivers.
 */
import { DEAD_AFTER_MS, MAX_BACKLOG_PER_SUBSCRIPTION } from '../../shared/event-subscriptions';
import { database } from '../db';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { claimDue, pruneDead, settleRows, SUBSCRIPTION_OUTBOX, SUBSCRIPTION_TOPIC, type OutboxRow } from './core';
import { deliverEvent } from './deliver';
import { setEventKick } from './events';
import { ensureOutboxMetrics, recordDelivery } from './metrics';
import { allSubscriptions, noteDelivery, openSecret, type EventSubscription } from './subscriptions';

const TICK_MS = 2_000;
const KICK_DELAY_MS = 100;
const MAINTENANCE_MS = 60_000;
const DEAD_KEPT_MS = 30 * 86_400_000;
/** The most rows one subscription is delivered per pass (a backlog is worked off over several passes). */
const PER_PASS = 50;
const PARALLEL = 10;

type EventRow = OutboxRow & { target_id: string; payload: string };

interface State {
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
  maintenance?: ReturnType<typeof setInterval>;
  kickTimer?: ReturnType<typeof setTimeout>;
  current?: Promise<number>;
}
const state = () => singleton<State>('event-outbox-dispatcher', () => ({ running: false }));

/** Dead-letter the oldest live rows of `subscriptionId` beyond the bound. Returns how many. */
export function enforceBacklog(subscriptionId: string, now = Date.now(), bound = MAX_BACKLOG_PER_SUBSCRIPTION): number {
  const db = database();
  const live = Number(db.get<{ n: number | bigint }>('SELECT COUNT(*) AS n FROM event_outbox WHERE topic = ? AND target_id = ? AND dead_at IS NULL', SUBSCRIPTION_TOPIC, subscriptionId)?.n ?? 0);
  if (live <= bound) return 0;
  const rows = db.all<EventRow>('SELECT * FROM event_outbox WHERE topic = ? AND target_id = ? AND dead_at IS NULL ORDER BY created_at, event_id LIMIT ?', SUBSCRIPTION_TOPIC, subscriptionId, live - bound);
  settleRows(SUBSCRIPTION_OUTBOX, rows, { error: new Error('backlog full'), dead: true }, now);
  return rows.length;
}

/** Deliver one claimed row; settle it. Returns whether it was delivered. */
async function deliverRow(subscription: EventSubscription, secret: string, row: EventRow, now: number): Promise<boolean> {
  const type = (() => {
    try {
      return String((JSON.parse(row.payload) as { type?: string }).type ?? 'event');
    } catch {
      return 'event';
    }
  })();
  const result = await deliverEvent({ url: subscription.url, secret }, { id: row.event_id, type }, row.payload);
  const old = now - Date.parse(row.created_at) >= DEAD_AFTER_MS;
  if (result.ok) {
    settleRows(SUBSCRIPTION_OUTBOX, [row], { ok: true }, Date.now());
    noteDelivery(subscription.id, result.delivery);
    recordDelivery('delivered');
    return true;
  }
  const error = new Error(result.delivery.error ?? 'Delivery failed');
  settleRows(SUBSCRIPTION_OUTBOX, [row], { error, ...(old && { dead: true }) }, Date.now());
  noteDelivery(subscription.id, result.delivery, result.gone ? 'The receiver answered 410 Gone' : undefined);
  recordDelivery(result.gone ? 'gone' : old ? 'dead' : 'failed');
  logger.warn('event delivery failed', { 'landflow.event_subscription.id': subscription.id, 'landflow.event.id': row.event_id, ...(result.delivery.status && { 'http.response.status_code': result.delivery.status }), ...(old && { 'landflow.outbox.dead': true }) });
  return false;
}

/** Deliver what is due to one subscription. Returns how many events it took. */
async function drainSubscription(subscription: EventSubscription, now: number): Promise<number> {
  const secret = openSecret(subscription);
  let delivered = 0;
  if (subscription.ordered) {
    // One at a time, oldest first: stop at the first failure so a later event never overtakes it.
    for (let n = 0; n < PER_PASS; n++) {
      const [row] = claimDue<EventRow>(SUBSCRIPTION_OUTBOX, subscription.id, 1, now, true);
      if (!row) break;
      if (!(await deliverRow(subscription, secret, row, now))) break;
      delivered += 1;
      if (!(await stillEnabled(subscription.id))) break;
    }
    return delivered;
  }
  for (let round = 0; round < PER_PASS / PARALLEL; round++) {
    const rows = claimDue<EventRow>(SUBSCRIPTION_OUTBOX, subscription.id, PARALLEL, now, false);
    if (!rows.length) break;
    const results = await Promise.all(rows.map((row) => deliverRow(subscription, secret, row, now)));
    delivered += results.filter(Boolean).length;
    if (results.some((ok) => !ok) || !(await stillEnabled(subscription.id))) break;
  }
  return delivered;
}

/** A 410 in the middle of a pass turns the subscription off: read it again. */
async function stillEnabled(id: string): Promise<boolean> {
  return Number(database().get<{ enabled: number | bigint }>('SELECT enabled FROM event_subscriptions WHERE id = ?', id)?.enabled ?? 0) === 1;
}

/** One pass over every enabled subscription with due rows. Returns how many events were delivered. `now` is for tests (a fake clock). */
export function drainSubscriptions(now = Date.now()): Promise<number> {
  const s = state();
  if (s.current) return s.current;
  const run = (async () => {
    let total = 0;
    try {
      const due = new Set(database().all<{ target_id: string }>('SELECT DISTINCT target_id FROM event_outbox WHERE topic = ? AND dead_at IS NULL AND next_at <= ?', SUBSCRIPTION_TOPIC, new Date(now).toISOString()).map((row) => row.target_id));
      const subscriptions = allSubscriptions().filter((subscription) => subscription.enabled && due.has(subscription.id));
      const results = await Promise.allSettled(subscriptions.map((subscription) => drainSubscription(subscription, now)));
      for (const result of results) {
        if (result.status === 'fulfilled') total += result.value;
        else logger.warn('event subscription pass failed', { error: (result.reason as Error).message });
      }
    } catch (error) {
      logger.warn('event outbox pass failed', { error: (error as Error).message });
    }
    return total;
  })();
  s.current = run;
  void run.finally(() => {
    if (s.current === run) s.current = undefined;
  });
  return run;
}

/** Once a minute: the backlog bound of each subscription, and dead rows older than 30 days. */
export function maintainOutbox(now = Date.now()): { dead: number; pruned: number } {
  let dead = 0;
  try {
    for (const subscription of allSubscriptions()) dead += enforceBacklog(subscription.id, now);
    const pruned = pruneDead(SUBSCRIPTION_OUTBOX, now - DEAD_KEPT_MS);
    if (dead) logger.warn('event outbox backlog bound reached', { 'landflow.outbox.dead': dead });
    return { dead, pruned };
  } catch (error) {
    logger.warn('event outbox maintenance failed', { error: (error as Error).message });
    return { dead, pruned: 0 };
  }
}

function kick() {
  const s = state();
  if (!s.running || s.kickTimer) return;
  s.kickTimer = setTimeout(() => {
    s.kickTimer = undefined;
    void drainSubscriptions();
  }, KICK_DELAY_MS);
  s.kickTimer.unref?.();
}

export const eventOutbox = {
  /** Start delivering (a 2 s tick plus kicks). Idempotent. */
  start() {
    const s = state();
    if (s.running) return;
    s.running = true;
    ensureOutboxMetrics();
    setEventKick(kick);
    s.timer = setInterval(() => void drainSubscriptions(), TICK_MS);
    s.timer.unref?.();
    maintainOutbox();
    s.maintenance = setInterval(() => void maintainOutbox(), MAINTENANCE_MS);
    s.maintenance.unref?.();
    kick();
  },
  /** Stop, letting the pass in progress finish (its rows settle, so nothing is left half-delivered by us). */
  async stop() {
    const s = state();
    s.running = false;
    setEventKick(undefined);
    if (s.timer) clearInterval(s.timer);
    if (s.maintenance) clearInterval(s.maintenance);
    if (s.kickTimer) clearTimeout(s.kickTimer);
    s.timer = s.maintenance = s.kickTimer = undefined;
    await s.current?.catch(() => 0);
  },
};
