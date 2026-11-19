/**
 * The leader service `notion brain` (docs/features/notion-brain.md#how-it-is-built): a tick every 5 seconds that copies a link
 * that is being set up, and for a link in sync drains its outbox (oldest first, at most 200 rows a tick), keeps Home and Log
 * fresh, and runs the pull and the knowledge walk the other packages register (`setPullStep`, `setKnowledgeStep`). With
 * `LANDFLOW_NOTION_BRAIN=off`, or for a link that is paused, refused, unshared or disconnected, a tick sends nothing at all.
 * `tickOnce()` is one tick, for tests and the joins; a tick never overlaps itself and `stop()` waits for the one in flight.
 */
import { database } from '../../db';
import { isNotionError } from '../../notion/port';
import { singleton } from '../../singleton';
import { logger } from '../../telemetry/logger';
import type { CopyProgress } from '../../../shared/notion-brain';
import { runCopy } from './copy';
import { enqueue, itemOf, itemsOf, knowledgeStep, pullStep, type ItemKind, type OutboxRow } from './sync';
import { isStopped, linkById, listActiveLinks, notionBrainEnabled, updateLink, type LinkRow } from './links';
import { pushEnv, pushOutboxRow } from './push';
import { sessionFor } from './render';
import { LinkStopped, checkStillShared, stopOnLinkFailure } from './status';
import { outboxListener } from './store';

export const TICK_MS = 5000;
export const BATCH = 200;
const HOURLY = 3_600_000;
/** How often every page is looked at again: new work changes a page's Work section without a brain change. */
export const SWEEP_MS = 30 * 60_000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 300_000;

interface State {
  inFlight?: Promise<void>;
  timer?: NodeJS.Timeout;
  /** Per link: when a failed copy may try again, and how many times it failed in a row. */
  copyRetry: Map<string, { at: number; failures: number }>;
  /** Per link: when every page was last queued for a fresh look (work arrives without a brain change). */
  sweptAt: Map<string, number>;
}
const state = () => singleton('notion-brain-service', (): State => ({ copyRetry: new Map(), sweptAt: new Map() }));

const copyPhase = (link: LinkRow): CopyProgress['phase'] | undefined => {
  try {
    return link.copy ? (JSON.parse(link.copy) as CopyProgress).phase : undefined;
  } catch {
    return undefined;
  }
};

/** Whether the initial copy still has work: a link being set up, or one resumed (an admin, a new key) before the copy was done. */
const needsCopy = (link: LinkRow): boolean => link.status === 'setting_up' || link.status === 'copying' || (link.status === 'active' && link.copy !== null && copyPhase(link) !== 'done');

const messageOf = (error: unknown): string => (isNotionError(error) ? error.message : `${(error as Error)?.name ?? 'Error'}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);

function failRow(row: OutboxRow, error: unknown, now: number): void {
  const attempts = row.attempts + 1;
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 16));
  const current = database().get<OutboxRow>('SELECT * FROM notion_brain_outbox WHERE link_id = ? AND kind = ? AND local_key = ?', row.link_id, row.kind, row.local_key);
  // A change that arrived while the push ran has a newer row (attempts reset): leave it alone.
  if (!current || current.enqueued_at !== row.enqueued_at) return;
  database().upsert('notion_brain_outbox', { ...current, attempts, next_at: new Date(now + wait).toISOString(), last_error: messageOf(error).slice(0, 500) } as unknown as Record<string, never>);
}

async function drain(link: LinkRow, now: number): Promise<void> {
  const rows = database().all<OutboxRow>('SELECT * FROM notion_brain_outbox WHERE link_id = ? AND (next_at IS NULL OR next_at <= ?) ORDER BY next_at, enqueued_at LIMIT ?', link.id, new Date(now).toISOString(), BATCH);
  if (!rows.length) return;
  const env = pushEnv(link, sessionFor(link));
  // Pages first: a fact's About needs its page's row.
  const ordered = [...rows.filter((r) => r.kind === 'entity'), ...rows.filter((r) => r.kind !== 'entity')];
  let pushed = 0;
  for (const row of ordered) {
    try {
      const result = await pushOutboxRow(env, row.kind, row.local_key);
      if (result === 'written') pushed++;
      database().delete('notion_brain_outbox', { link_id: row.link_id, kind: row.kind, local_key: row.local_key, enqueued_at: row.enqueued_at });
    } catch (error) {
      // The link stopped (unshared, unauthorized, paused): nothing more is sent this tick.
      if (error instanceof LinkStopped) throw error;
      stopOnLinkFailure(link.id, error);
      failRow(row, error, now);
      logger.warn('[notion-brain] a push failed', { linkId: link.id, kind: row.kind, key: row.local_key, error: isNotionError(error) ? `${error.kind} ${error.status}` : (error as Error).name });
      // Notion is struggling: leave the rest for the next tick.
      if (isNotionError(error) && (error.kind === 'rateLimited' || error.kind === 'unavailable' || error.kind === 'network')) break;
    }
  }
  if (pushed) updateLink(link.id, { last_push_at: new Date(now).toISOString(), last_error: null });
}

/** Every 30 minutes each page row is queued; the push renders it and skips what did not change. The first tick after a start only notes the time. */
function sweepPages(link: LinkRow, now: number): void {
  const last = state().sweptAt.get(link.id);
  if (last === undefined) return void state().sweptAt.set(link.id, now);
  if (now - last < SWEEP_MS) return;
  state().sweptAt.set(link.id, now);
  for (const item of itemsOf(link.id, 'entity')) {
    if (item.state === 'ok') enqueue(link.id, 'entity', item.local_key);
  }
}

/** Home and Log are re-rendered at least hourly: the work they list does not arrive as brain changes. */
function refreshWhole(link: LinkRow, now: number): void {
  for (const kind of ['home', 'log'] as const) {
    const waiting = database().get<OutboxRow>('SELECT * FROM notion_brain_outbox WHERE link_id = ? AND kind = ? AND local_key = ?', link.id, kind, '');
    const last = itemOf(link.id, kind as unknown as ItemKind, '')?.pushed_at;
    if (!waiting && (!last || now - Date.parse(last) >= HOURLY)) enqueue(link.id, kind, '');
  }
}

async function syncLink(first: LinkRow, now: number): Promise<void> {
  let link = first;
  if (needsCopy(link)) {
    const retry = state().copyRetry.get(link.id);
    if (retry && retry.at > now) return;
    try {
      await runCopy(link);
      state().copyRetry.delete(link.id);
    } catch (error) {
      if (error instanceof LinkStopped) return;
      stopOnLinkFailure(link.id, error);
      if (isNotionError(error) && error.kind === 'notFound') await checkStillShared(link);
      const failures = (retry?.failures ?? 0) + 1;
      state().copyRetry.set(link.id, { at: now + Math.min(60_000, BACKOFF_BASE_MS * 2 ** Math.min(failures, 6)), failures });
      updateLink(link.id, { last_error: messageOf(error).slice(0, 500) });
      logger.warn('[notion-brain] the copy stopped; it continues on the next try', { linkId: link.id, error: isNotionError(error) ? `${error.kind} ${error.status}` : (error as Error).name });
    }
    return;
  }
  sweepPages(link, now);
  await drain(link, now);
  link = linkById(link.id) ?? link;
  if (isStopped(link.status)) return;
  refreshWhole(link, now);
  const force = Boolean(link.next_sync_at && Date.parse(link.next_sync_at) <= now);
  for (const [name, step] of [['pull', pullStep()], ['knowledge', knowledgeStep()]] as const) {
    if (!step) continue;
    try {
      await step(link, { force });
    } catch (error) {
      if (error instanceof LinkStopped) return;
      logger.warn('[notion-brain] a sync step failed', { linkId: link.id, step: name, error: isNotionError(error) ? `${error.kind} ${error.status}` : (error as Error).name });
    }
    // A step that stopped the link (a refused key, a gone page) ends the pass: the next step would run against a stopped link.
    link = linkById(link.id) ?? link;
    if (isStopped(link.status)) return;
  }
  if (link.next_sync_at) updateLink(link.id, { next_sync_at: null });
}

async function tick(): Promise<void> {
  if (!notionBrainEnabled()) return;
  const now = Date.now();
  for (const link of listActiveLinks()) {
    if (isStopped(link.status)) continue;
    try {
      await syncLink(link, now);
    } catch (error) {
      if (error instanceof LinkStopped) continue;
      logger.warn('[notion-brain] a link could not be synced', { linkId: link.id, error: (error as Error).name });
    }
  }
}

/** Tests: forget the retry delay of a failed copy, as a restart does. */
export const resetBackoff = (): void => {
  state().copyRetry.clear();
  state().sweptAt.clear();
};

/** One tick. A tick already running is awaited, never overlapped. */
export function tickOnce(): Promise<void> {
  const s = state();
  if (s.inFlight) return s.inFlight;
  const run = tick().finally(() => {
    if (s.inFlight === run) s.inFlight = undefined;
  });
  s.inFlight = run;
  return run;
}

/** The leader service: `start` begins the ticks, `stop` ends them and waits for the one in flight. */
export const notionBrain = {
  start(): void {
    void outboxListener;
    const s = state();
    if (s.timer) return;
    s.timer = setInterval(() => void tickOnce().catch((error) => logger.warn('[notion-brain] a tick failed', { error: (error as Error).name })), TICK_MS);
    s.timer.unref?.();
  },
  async stop(): Promise<void> {
    const s = state();
    if (s.timer) clearInterval(s.timer);
    s.timer = undefined;
    await s.inFlight?.catch(() => undefined);
  },
  tickOnce,
};
