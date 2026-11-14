/**
 * The person's own day (docs/work-and-briefings.md): GET /api/brain/briefing. Today's and yesterday's work events they
 * recorded, newest first, in the instance time zone. Colleagues' related work comes with shared visibility (`related`
 * stays empty until then).
 */
import { database, type Database } from '../db';
import type { Actor } from '../projects/access';
import { workAutoSend } from '../settings';
import { brainEnabled, dayOf, fromRow, type UsageRow } from '../usage/ledger';
import type { Briefing, WorkItem, WorkVisibility } from '../../shared/brain-work';

export const BRIEFING_LIMIT = 50;

/** The day before `day` (YYYY-MM-DD). Calendar arithmetic, so a daylight-saving change can't skip or repeat a day. */
export function dayBefore(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

function itemOf(row: UsageRow): WorkItem {
  const event = fromRow(row);
  const attrs = event.attrs ?? {};
  const text = (name: string) => (typeof attrs[name] === 'string' && attrs[name] ? String(attrs[name]) : undefined);
  const areas = text('areas')?.split(',').filter(Boolean);
  return {
    id: event.id,
    sourceId: row.source_id ?? '',
    source: row.source ?? text('source') ?? '',
    kind: event.kind,
    title: text('title') ?? event.message ?? '',
    ...(text('summary') && { summary: text('summary') }),
    ...(text('repo') && { repo: text('repo') }),
    ...(areas?.length && { areas }),
    at: event.at,
    ...(text('endedAt') && { endedAt: text('endedAt') }),
    ...(text('url') && { url: text('url') }),
    visibility: (row.visibility ?? 'private') as WorkVisibility,
  };
}

/** The caller's own work events of `day`, newest first. */
export function workOfDay(actor: Actor, day: string, db: Database = database()): WorkItem[] {
  return db
    .all<UsageRow>(`SELECT * FROM usage_events WHERE owner_id = ? AND source_id IS NOT NULL AND kind LIKE 'work.%' AND day = ? ORDER BY at DESC LIMIT ${BRIEFING_LIMIT}`, actor.id, day)
    .map(itemOf);
}

export function briefingFor(actor: Actor, options: { day?: string; now?: number } = {}, db: Database = database()): Briefing {
  const now = options.now ?? Date.now();
  const day = options.day ?? dayOf(now);
  const on = brainEnabled();
  return {
    day,
    generatedAt: new Date(now).toISOString(),
    source: 'live',
    today: on ? workOfDay(actor, day, db) : [],
    yesterday: on ? workOfDay(actor, dayBefore(day), db) : [],
    related: [],
    autoSend: workAutoSend(),
    brain: on ? 'on' : 'off',
  };
}
