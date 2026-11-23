/**
 * Per-key limits of the hook route (C04 FR-10): at most `LANDFLOW_HARNESS_EVENTS_PER_SECOND` events a second per key (`LANDFLOW_HARNESS_OWNER_EVENTS_PER_SECOND` per key owner) and
 * `LANDFLOW_HARNESS_MAX_OPEN_SESSIONS` open sessions per key owner. Past either, the route answers 429 with `retryAfter`; nothing is
 * dropped without an answer. The per-second counter is its own small one (the API limiter counts minutes), in this process or,
 * in queue mode, through the coordinator so every main shares it.
 */
import { clusterActive, coordinator } from '../cluster/state';
import { envInt } from '../config';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { openCount } from './store';

export const eventsPerSecond = (): number => envInt('LANDFLOW_HARNESS_EVENTS_PER_SECOND', { fallback: 20, min: 1, max: 10_000 });
/** All of one person's keys together: five keys' worth by default. */
export const ownerEventsPerSecond = (): number => envInt('LANDFLOW_HARNESS_OWNER_EVENTS_PER_SECOND', { fallback: 100, min: 1, max: 100_000 });
export const maxOpenSessions = (): number => envInt('LANDFLOW_HARNESS_MAX_OPEN_SESSIONS', { fallback: 2000, min: 1, max: 1_000_000 });

const windows = () => singleton('harness-hook-windows', () => ({ map: new Map<string, { second: number; count: number }>(), swept: 0, opens: new Map<string, { at: number; n: number }>() }));
const MAX_KEYS = 10_000;

/** Count one event of `id` in this second against `limit`; true while within it. In queue mode the count is shared through the coordinator. */
async function within(scope: 'key' | 'owner', id: string, limit: number, now: number): Promise<boolean> {
  const second = Math.floor(now / 1000);
  const state = windows();
  if (state.map.size > MAX_KEYS && state.swept !== second) {
    state.swept = second;
    for (const [key, window] of state.map) if (window.second < second) state.map.delete(key);
  }
  const name = `${scope}:${id}`;
  const current = state.map.get(name);
  const mine = current && current.second === second ? current : { second, count: 0 };
  mine.count += 1;
  state.map.set(name, mine);
  if (!clusterActive()) return mine.count <= limit;
  try {
    return (await coordinator().incr(`hh:${name}:${second}`, 3000)) <= limit;
  } catch (error) {
    logger.warn('shared harness hook limit unavailable, counting in this process', { error: (error as Error).message });
    return mine.count <= limit;
  }
}

/**
 * Count one event against the key's per-second limit and its owner's (all of a person's keys together: many keys do not
 * multiply the limit). True while within both.
 */
export async function takeEvent(keyId: string, ownerId: string, now = Date.now()): Promise<boolean> {
  const byKey = await within('key', keyId, eventsPerSecond(), now);
  const byOwner = await within('owner', ownerId, ownerEventsPerSecond(), now);
  return byKey && byOwner;
}

/** Whether `ownerId` may open one more session (a count of the open ones, cached for 5 seconds). */
export function mayOpenSession(ownerId: string, now = Date.now()): boolean {
  const opens = windows().opens;
  const held = opens.get(ownerId);
  if (held && now - held.at < 5000 && held.n < maxOpenSessions()) {
    held.n += 1;
    return true;
  }
  const n = openCount(ownerId);
  if (opens.size > MAX_KEYS) opens.clear();
  opens.set(ownerId, { at: now, n: n + 1 });
  return n < maxOpenSessions();
}
