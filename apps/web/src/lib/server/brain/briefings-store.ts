/**
 * The nightly briefings (docs/work-and-briefings.md#the-nightly-sync): one row per person and day, written by the
 * tomorrow-sync workflow's brain nodes. `gathered` and `text` are the person's own work, so every read here takes the
 * person's id and the workflow's run data carries ids and counts only. A `draft` is what the flow is still writing, `ready`
 * the one the person is served (one per person and day), `superseded` one a newer run replaced.
 */
import { randomUUID } from 'node:crypto';
import { database, type Database } from '../db';
import type { GatheredWork } from '../../shared/brain-work';

export type BriefingStatus = 'draft' | 'ready' | 'superseded';

export interface StoredBriefing {
  id: string;
  userId: string;
  day: string;
  status: BriefingStatus;
  gathered: GatheredWork;
  text?: string;
  model?: string;
  workflowId?: string;
  executionId?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  user_id: string;
  day: string;
  status: string;
  gathered: string | null;
  text: string | null;
  model: string | null;
  workflow_id: string | null;
  execution_id: string | null;
  created_at: string;
  updated_at: string;
}

export const BRIEFING_KEEP_DAYS = 30;
const EMPTY: GatheredWork = { own: [], related: [], finished: [] };

function parse(value: string | null): GatheredWork {
  try {
    const data = value ? (JSON.parse(value) as Partial<GatheredWork>) : {};
    return { own: data.own ?? [], related: data.related ?? [], finished: data.finished ?? [] };
  } catch {
    return { ...EMPTY };
  }
}

const fromRow = (row: Row): StoredBriefing => ({
  id: row.id,
  userId: row.user_id,
  day: row.day,
  status: row.status as BriefingStatus,
  gathered: parse(row.gathered),
  ...(row.text && { text: row.text }),
  ...(row.model && { model: row.model }),
  ...(row.workflow_id && { workflowId: row.workflow_id }),
  ...(row.execution_id && { executionId: row.execution_id }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRow = (b: StoredBriefing): Record<string, string | null> => ({
  id: b.id,
  user_id: b.userId,
  day: b.day,
  status: b.status,
  gathered: JSON.stringify(b.gathered),
  text: b.text ?? null,
  model: b.model ?? null,
  workflow_id: b.workflowId ?? null,
  execution_id: b.executionId ?? null,
  created_at: b.createdAt,
  updated_at: b.updatedAt,
});

/** A new draft for the person and day (an older draft of theirs for that day is dropped first). */
export function createDraft(input: { userId: string; day: string; gathered: GatheredWork; workflowId?: string; executionId?: string }, db: Database = database(), now = Date.now()): StoredBriefing {
  return db.transaction(() => {
    for (const old of db.all<{ id: string }>(`SELECT id FROM brain_briefings WHERE user_id = ? AND day = ? AND status = 'draft'`, input.userId, input.day)) db.delete('brain_briefings', { id: old.id });
    const at = new Date(now).toISOString();
    const draft: StoredBriefing = { id: randomUUID(), userId: input.userId, day: input.day, status: 'draft', gathered: input.gathered, ...(input.workflowId && { workflowId: input.workflowId }), ...(input.executionId && { executionId: input.executionId }), createdAt: at, updatedAt: at };
    db.upsert('brain_briefings', toRow(draft));
    return draft;
  });
}

/** The person's briefing row by id (any status), or undefined when it is someone else's. */
export function getBriefing(id: string, userId: string, db: Database = database()): StoredBriefing | undefined {
  const row = db.get<Row>('SELECT * FROM brain_briefings WHERE id = ? AND user_id = ?', id, userId);
  return row ? fromRow(row) : undefined;
}

export const getDraft = (id: string, userId: string, db: Database = database()): StoredBriefing | undefined => {
  const found = getBriefing(id, userId, db);
  return found?.status === 'draft' ? found : undefined;
};

/** The words the draft says, and which model wrote them (`deterministic` when none did). */
export function writeText(id: string, userId: string, text: string, model: string, db: Database = database(), now = Date.now()): StoredBriefing | undefined {
  const draft = getDraft(id, userId, db);
  if (!draft) return undefined;
  const next = { ...draft, text, model, updatedAt: new Date(now).toISOString() };
  db.upsert('brain_briefings', toRow(next));
  return next;
}

/** Make the draft the person's `ready` briefing of its day; the day's older `ready` one becomes `superseded`. */
export function markReady(id: string, userId: string, db: Database = database(), now = Date.now()): StoredBriefing | undefined {
  return db.transaction(() => {
    const draft = getDraft(id, userId, db);
    if (!draft) return undefined;
    const at = new Date(now).toISOString();
    for (const old of db.all<Row>(`SELECT * FROM brain_briefings WHERE user_id = ? AND day = ? AND status = 'ready'`, userId, draft.day)) db.upsert('brain_briefings', { ...old, status: 'superseded', updated_at: at });
    const ready = { ...draft, status: 'ready' as const, updatedAt: at };
    db.upsert('brain_briefings', toRow(ready));
    return ready;
  });
}

/** The `ready` briefing of the person for the day, if the flow wrote one. */
export function latestReady(userId: string, day: string, db: Database = database()): StoredBriefing | undefined {
  const row = db.get<Row>(`SELECT * FROM brain_briefings WHERE user_id = ? AND day = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 1`, userId, day);
  return row ? fromRow(row) : undefined;
}

/** Delete briefings (any status) created more than BRIEFING_KEEP_DAYS ago. */
export function pruneBriefings(db: Database = database(), now = Date.now()): number {
  return db.deleteBefore('brain_briefings', 'created_at', new Date(now - BRIEFING_KEEP_DAYS * 86_400_000).toISOString());
}
