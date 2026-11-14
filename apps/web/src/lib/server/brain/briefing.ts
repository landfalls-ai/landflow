/**
 * The person's own day (docs/work-and-briefings.md): GET /api/brain/briefing. Today's and yesterday's work events they
 * recorded, newest first, in the instance time zone, and `related`: colleagues' shared work that overlaps it (related.ts).
 */
import { database, type Database } from '../db';
import type { Actor } from '../projects/access';
import { workAutoSend } from '../settings';
import { brainEnabled, dayOf, type UsageRow } from '../usage/ledger';
import { itemOf, relatedFor } from './related';
import type { Briefing, WorkItem } from '../../shared/brain-work';

export const BRIEFING_LIMIT = 50;

/** The day before `day` (YYYY-MM-DD). Calendar arithmetic, so a daylight-saving change can't skip or repeat a day. */
export function dayBefore(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

/** The ledger rows of the caller's own work events of `day`, newest first. */
function rowsOfDay(actor: Actor, day: string, db: Database): UsageRow[] {
  return db.all<UsageRow>(`SELECT * FROM usage_events WHERE owner_id = ? AND source_id IS NOT NULL AND kind LIKE 'work.%' AND day = ? ORDER BY at DESC LIMIT ${BRIEFING_LIMIT}`, actor.id, day);
}

/** The caller's own work events of `day`, newest first. */
export function workOfDay(actor: Actor, day: string, db: Database = database()): WorkItem[] {
  return rowsOfDay(actor, day, db).map(itemOf);
}

export function briefingFor(actor: Actor, options: { day?: string; now?: number } = {}, db: Database = database()): Briefing {
  const now = options.now ?? Date.now();
  const day = options.day ?? dayOf(now);
  const on = brainEnabled();
  const today = on ? rowsOfDay(actor, day, db) : [];
  const yesterday = on ? rowsOfDay(actor, dayBefore(day), db) : [];
  return {
    day,
    generatedAt: new Date(now).toISOString(),
    source: 'live',
    today: today.map(itemOf),
    yesterday: yesterday.map(itemOf),
    related: on ? relatedFor(actor, [...today, ...yesterday], now, db) : [],
    autoSend: workAutoSend(),
    brain: on ? 'on' : 'off',
  };
}
