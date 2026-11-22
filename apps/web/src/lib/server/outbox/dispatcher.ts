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
import { nanoid } from 'nanoid';
import { DEAD_AFTER_MS, MAX_BACKLOG_BYTES, MAX_BACKLOG_PER_SUBSCRIPTION } from '../../shared/event-subscriptions';
import { database } from '../db';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { claimDue, pruneDead, settleRows, SUBSCRIPTION_OUTBOX, SUBSCRIPTION_TOPIC, type OutboxRow } from './core';
import { deliverEvent } from './deliver';
import { setEventKick } from './events';
import { ensureOutboxMetrics, recordDelivery } from './metrics';
import { allSubscriptions, getSubscription, noteDelivery, openSecret, type EventSubscription } from './subscriptions';

const TICK_MS = 2_000;
const KICK_DELAY_MS = 100;
const MAINTENANCE_MS = 60_000;
const DEAD_KEPT_MS = 30 * 86_400_000;
/** The most rows one subscription is delivered per pass (a backlog is worked off over several passes). */
const PER_PASS = 50;
const PARALLEL = 10;
/** How long one subscription may keep working in one pass: a pass that runs long hands over, and the next tick continues. */
const PASS_BUDGET_MS = 30_000;
/** A row of an unknown subscription is dropped once it is this old (a leader that has not heard of a new subscription yet must not drop its rows). */
const ORPHAN_AFTER_MS = 10 * 60_000;

type EventRow = OutboxRow & { target_id: string; payload: string };

interface State {
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
  maintenance?: ReturnType<typeof setInterval>;
  kickTimer?: ReturnType<typeof setTimeout>;
  /** Subscriptions with a pass in progress on this process: a slow receiver holds only its own. */
  active?: Set<string>;
}
const state = () => singleton<State>('event-outbox-dispatcher', () => ({ running: false }));

/**
 * Dead-letter the oldest live rows of `subscriptionId` beyond the row bound, and beyond the byte bound (the payloads of the
 * waiting rows: a subscription that asks for output may hold up to 64 KB an event). Returns how many.
 */
export function enforceBacklog(subscriptionId: string, now = Date.now(), bound = MAX_BACKLOG_PER_SUBSCRIPTION, byteBound = MAX_BACKLOG_BYTES): number {
  const db = database();
  const totals = db.get<{ n: number | bigint; bytes: number | bigint | null }>('SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS bytes FROM event_outbox WHERE topic = ? AND target_id = ? AND dead_at IS NULL', SUBSCRIPTION_TOPIC, subscriptionId);
  const live = Number(totals?.n ?? 0);
  let bytes = Number(totals?.bytes ?? 0);
  if (live <= bound && bytes <= byteBound) return 0;
  let drop = Math.max(0, live - bound);
  const dead: EventRow[] = [];
  // Oldest first, until both bounds hold.
  const oldest = db.all<EventRow>('SELECT * FROM event_outbox WHERE topic = ? AND target_id = ? AND dead_at IS NULL ORDER BY created_at, event_id LIMIT ?', SUBSCRIPTION_TOPIC, subscriptionId, live);
  for (const row of oldest) {
    if (drop <= 0 && bytes <= byteBound) break;
    dead.push(row);
    bytes -= row.payload.length;
    drop -= 1;
  }
  settleRows(SUBSCRIPTION_OUTBOX, dead, { error: new Error('backlog full'), dead: true }, now);
  return dead.length;
}

/** Deliver one claimed row; settle it. Returns whether it was delivered. */
async function deliverRow(subscription: EventSubscription, secret: string, row: EventRow, now: () => number): Promise<boolean> {
  const type = (() => {
    try {
      return String((JSON.parse(row.payload) as { type?: string }).type ?? 'event');
    } catch {
      return 'event';
    }
  })();
  const result = await deliverEvent({ url: subscription.url, secret }, { id: row.event_id, type }, row.payload);
  const old = now() - Date.parse(row.created_at) >= DEAD_AFTER_MS;
  if (result.ok) {
    settleRows(SUBSCRIPTION_OUTBOX, [row], { ok: true }, now());
    noteDelivery(subscription.id, result.delivery);
    recordDelivery('delivered');
    return true;
  }
  const error = new Error(result.delivery.error ?? 'Delivery failed');
  settleRows(SUBSCRIPTION_OUTBOX, [row], { error, ...(old && { dead: true }) }, now());
  noteDelivery(subscription.id, result.delivery, result.gone ? { reason: 'The receiver answered 410 Gone', url: subscription.url } : undefined);
  recordDelivery(result.gone ? 'gone' : old ? 'dead' : 'failed');
  logger.warn('event delivery failed', { 'landflow.event_subscription.id': subscription.id, 'landflow.event.id': row.event_id, ...(result.delivery.status && { 'http.response.status_code': result.delivery.status }), ...(old && { 'landflow.outbox.dead': true }) });
  return false;
}

/** Deliver what is due to one subscription. Returns how many events it took. `now` reads the clock at each claim and settle (a test passes a fixed one). */
async function drainSubscription(subscription: EventSubscription, now: () => number): Promise<number> {
  const secret = openSecret(subscription);
  const started = Date.now();
  let delivered = 0;
  if (subscription.ordered) {
    // One at a time, oldest first: stop at the first failure so a later event never overtakes it.
    for (let n = 0; n < PER_PASS && Date.now() - started < PASS_BUDGET_MS; n++) {
      const [row] = claimDue<EventRow>(SUBSCRIPTION_OUTBOX, subscription.id, 1, now(), true);
      if (!row) break;
      if (!(await deliverRow(subscription, secret, row, now))) break;
      delivered += 1;
      if (!(await stillEnabled(subscription.id))) break;
    }
    return delivered;
  }
  for (let round = 0; round < PER_PASS / PARALLEL && Date.now() - started < PASS_BUDGET_MS; round++) {
    const rows = claimDue<EventRow>(SUBSCRIPTION_OUTBOX, subscription.id, PARALLEL, now(), false);
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

/**
 * One pass over every enabled subscription with due rows. Each subscription works on its own: one that is still busy with
 * a slow receiver is left to finish while the others are served. Returns how many events this call delivered. `at` is for
 * tests (a fake clock); without it every claim and settle reads the clock when it happens.
 */
export async function drainSubscriptions(at?: number): Promise<number> {
  const s = state();
  const active = (s.active ??= new Set<string>());
  const now = at === undefined ? () => Date.now() : () => at;
  let total = 0;
  try {
    const due = new Set(database().all<{ target_id: string }>('SELECT DISTINCT target_id FROM event_outbox WHERE topic = ? AND dead_at IS NULL AND next_at <= ?', SUBSCRIPTION_TOPIC, new Date(now()).toISOString()).map((row) => row.target_id));
    const mine = allSubscriptions().filter((subscription) => subscription.enabled && due.has(subscription.id) && !active.has(subscription.id));
    for (const subscription of mine) active.add(subscription.id);
    const results = await Promise.allSettled(
      mine.map((subscription) =>
        drainSubscription(subscription, now).finally(() => {
          active.delete(subscription.id);
        }),
      ),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') total += result.value;
      else logger.warn('event subscription pass failed', { error: (result.reason as Error).message });
    }
  } catch (error) {
    logger.warn('event outbox pass failed', { error: (error as Error).message });
  }
  return total;
}

/** Once a minute: the backlog bound of each subscription, and dead rows older than 30 days. */
export function maintainOutbox(now = Date.now()): { dead: number; pruned: number } {
  let dead = 0;
  try {
    const known = new Set<string>();
    for (const subscription of allSubscriptions()) {
      known.add(subscription.id);
      dead += enforceBacklog(subscription.id, now);
    }
    // Rows whose subscription is gone (deleted while a pass held them, or by another process) are dropped once they are old.
    const cut = new Date(now - ORPHAN_AFTER_MS).toISOString();
    for (const row of database().all<{ target_id: string; event_id: string }>('SELECT target_id, event_id FROM event_outbox WHERE topic = ? AND created_at < ?', SUBSCRIPTION_TOPIC, cut)) {
      if (!known.has(row.target_id)) database().delete('event_outbox', { topic: SUBSCRIPTION_TOPIC, target_id: row.target_id, event_id: row.event_id });
    }
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
    // A pass in progress settles its own rows; wait a moment for the busy subscriptions.
    for (let i = 0; i < 50 && s.active?.size; i++) await new Promise((r) => setTimeout(r, 100));
  },
};

/**
 * "Send test" on the card: one `test` event straight to the subscription's URL (not through the outbox, so the answer is
 * immediate), signed like any event. The attempt shows as the subscription's last delivery.
 */
export async function sendTestEvent(subscriptionId: string): Promise<{ ok: boolean; status?: number; message: string }> {
  const subscription = getSubscription(subscriptionId);
  if (!subscription) return { ok: false, message: 'Event subscription not found' };
  const at = new Date().toISOString();
  const id = `evt_test_${nanoid(10)}`;
  const body = JSON.stringify({ id, type: 'test', createdAt: at, projectId: subscription.projectId, test: true, message: `A test event from Landflow to “${subscription.name}”` });
  const result = await deliverEvent({ url: subscription.url, secret: openSecret(subscription) }, { id, type: 'test' }, body);
  noteDelivery(subscription.id, result.delivery);
  return { ok: result.ok, ...(result.delivery.status && { status: result.delivery.status }), message: result.ok ? `The receiver answered HTTP ${result.delivery.status}` : (result.delivery.error ?? 'Delivery failed') };
}
