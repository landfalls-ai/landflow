/**
 * Recording someone's work (docs/work-and-briefings.md): POST/DELETE /api/brain/work. The events are the caller's own and
 * private to them until they mark one `team` (people who share a project with them) or `org` (everyone); nobody else
 * reads a private one, not an admin. PATCH changes the visibility and share posts a `work.self_update`. The
 * contract is `WorkEventInput` in packages/protocol; this file validates with it, declares the kind on first use and
 * writes through the ledger (usage/ledger.ts `upsertWorkEvent`).
 */
import { validateWorkEvent, type WorkEventInput } from '@landflow/protocol';
import { getUser } from '../auth/users';
import { database, type Database } from '../db';
import { HttpError } from '../errors';
import type { Actor } from '../projects/access';
import { getKind, saveKind } from '../usage/kinds';
import { brainEnabled, dayOf, deleteWorkEvent, fromRow, upsertWorkEvent, type UsageRow } from '../usage/ledger';
import { rawRetentionDays, rollupDays } from '../usage/query';
import type { UsageKindField } from '../../shared/brain';
import type { WorkVisibility } from '../../shared/brain-work';
import { getEntity, upsertEntity } from './entities';
import { itemOf } from './related';

/** The brain is switched off (LANDFLOW_BRAIN=false): nothing is recorded or briefed. */
export class BrainOffError extends HttpError {
  static readonly errorName: string = 'BrainOffError';
  constructor() {
    super('The second brain is off on this instance', 503, { expose: true });
  }
}

export const MAX_WORK_EVENTS = 50;
/** How far ahead of the host's clock an event's `occurredAt` may be. */
const FUTURE_SLACK_MS = 86_400_000;

export interface SavedWork {
  sourceId: string;
  id: string;
  created: boolean;
}

export interface RejectedWork {
  sourceId: string;
  reason: string;
}

/** The fields the tools' work kinds declare (deploy/brain/work-kinds.json holds the same list for the declare script; the GitHub-only kinds list their own there). */
export const WORK_FIELDS: UsageKindField[] = [
  { name: 'source', type: 'string', required: true, description: 'The tool the work was done in: claude-code, landflow-cli, mcp…' },
  { name: 'sourceId', type: 'string', required: true, description: 'Stable id of this item in its tool (sending it again updates it)' },
  { name: 'url', type: 'string', description: 'Link to the item' },
  { name: 'actor', type: 'string', description: 'Email of the person who did it' },
  { name: 'title', type: 'string', description: 'One line: what the work was' },
  { name: 'summary', type: 'string', description: 'What happened, clipped to 200 characters' },
  { name: 'team', type: 'string', description: 'Team hint' },
  { name: 'initiative', type: 'string', description: 'Initiative or project hint' },
  { name: 'customer', type: 'string', description: 'Customer hint' },
  { name: 'repo', type: 'string', description: 'The repository, owner/name' },
  { name: 'branch', type: 'string', description: 'The branch' },
  { name: 'areas', type: 'string', description: 'Directory names touched, comma-joined' },
  { name: 'commits', type: 'number', description: 'Commits made' },
  { name: 'turns', type: 'number', description: 'Turns of the conversation with the assistant' },
  { name: 'prs', type: 'number', description: 'Pull requests opened or merged' },
  { name: 'prUrl', type: 'string', description: 'The first pull request' },
  { name: 'endedAt', type: 'string', description: 'When it ended (ISO 8601)' },
  { name: 'occurredAt', type: 'string', description: 'When it happened (ISO 8601)' },
];

const KIND_NOTES: Record<string, string> = {
  'work.session': 'A working session in a coding tool or another harness',
};

/** The kinds the route may declare itself (the `kinds` of deploy/brain/work-kinds.json). Any other needs an admin to declare it. */
export const DECLARABLE_KINDS = new Set(['work.discussion', 'work.decision', 'work.bug_reported', 'work.release', 'work.deal_won', 'work.deal_moved', 'work.meeting_scheduled', 'work.meeting_held', 'work.meeting_cancelled', 'work.meeting_notes', 'work.action_item', 'work.doc_edited', 'work.ticket_moved', 'work.feature_request', 'work.pr_opened', 'work.pr_merged', 'work.pr_closed', 'work.pr_reviewed', 'work.review_requested', 'work.ci_failed', 'work.ci_passed', 'work.self_update', 'work.session']);

/** Declare a listed work kind the first time a tool sends it (the Record Event declare path, usage/kinds.ts). */
function ensureKind(kind: string, actor: Actor) {
  if (getKind(kind)) return;
  saveKind({ kind, description: KIND_NOTES[kind] ?? 'Work sent by a person’s tools', fields: WORK_FIELDS, createdBy: actor.id });
}

const sourceIdOf = (event: unknown): string => {
  const value = typeof event === 'object' && event !== null ? (event as { sourceId?: unknown }).sourceId : undefined;
  return typeof value === 'string' ? value.slice(0, 200) : '';
};

/** Save `events` as `actor`'s own work. One event's problem never stops the rest: it comes back in `rejected` with its reason. */
export function recordWork(actor: Actor, events: unknown[]): { saved: SavedWork[]; rejected: RejectedWork[] } {
  if (!brainEnabled()) throw new BrainOffError();
  const email = getUser(actor.id)?.email;
  const saved: SavedWork[] = [];
  const rejected: RejectedWork[] = [];
  for (const raw of events.slice(0, MAX_WORK_EVENTS)) {
    const checked = validateWorkEvent(raw);
    if (!checked.ok) {
      rejected.push({ sourceId: sourceIdOf(raw), reason: checked.errors.join('; ') });
      continue;
    }
    const event: WorkEventInput = checked.value;
    // A date far ahead would be a row no briefing shows and the prune never reaches: a day of clock skew is the most.
    if (Date.parse(event.occurredAt) > Date.now() + FUTURE_SLACK_MS) {
      rejected.push({ sourceId: event.sourceId, reason: 'occurredAt is more than a day in the future' });
      continue;
    }
    if (!DECLARABLE_KINDS.has(event.kind) && !getKind(event.kind)) {
      rejected.push({ sourceId: event.sourceId, reason: 'Unknown work kind; an admin can declare it' });
      continue;
    }
    try {
      ensureKind(event.kind, actor);
      // An event sent again without a visibility keeps the one its owner gave it (PATCH); a new one is private.
      const visibility = event.visibility ?? (ownRow(actor.id, event.source, event.sourceId)?.visibility as WorkVisibility | undefined) ?? 'private';
      const { id, created } = upsertWorkEvent(actor.id, { ...event, visibility }, email);
      // A private event names no repository: the page would be readable by the instance owner (Q3, MOD6).
      if (event.repo && visibility !== 'private') recordRepo(event.repo);
      saved.push({ sourceId: event.sourceId, id, created });
    } catch (error) {
      if (error instanceof HttpError) rejected.push({ sourceId: event.sourceId, reason: error.message });
      else throw error;
    }
  }
  return { saved, rejected };
}

/** Delete one of the caller's own work events. Returns whether there was one (someone else's is not found). */
export function deleteWork(actor: Actor, source: string, sourceId: string): boolean {
  // Allowed while the brain is off: a person can always remove their own private events.
  return deleteWorkEvent(actor.id, source, sourceId);
}

// ---------------------------------------------------------------------------
// Repositories as systems
// ---------------------------------------------------------------------------

/** The id of a repository's `system` entity: `repo-owner-name`, lowercase (the repository is `attrs.repo`). */
export const repoEntityId = (repo: string): string => `repo-${repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 64).replace(/-+$/, '');

/** One `system` entity per repository, made the first time work names it (a second event finds it and adds nothing). */
function recordRepo(repo: string, db: Database = database()) {
  const id = repoEntityId(repo);
  if (getEntity('system', id, db)) return;
  upsertEntity({ type: 'system', id, name: repo, description: 'A repository people work in', attrs: { repo }, source: 'work' }, db);
}

// ---------------------------------------------------------------------------
// Visibility and Post as my update
// ---------------------------------------------------------------------------

function ownRow(ownerId: string, source: string | undefined, sourceId: string, db: Database = database()): UsageRow | undefined {
  return source
    ? db.get<UsageRow>("SELECT * FROM usage_events WHERE owner_id = ? AND source = ? AND source_id = ? AND kind LIKE 'work.%'", ownerId, source, sourceId)
    : db.get<UsageRow>("SELECT * FROM usage_events WHERE owner_id = ? AND source_id = ? AND kind LIKE 'work.%' ORDER BY at DESC LIMIT 1", ownerId, sourceId);
}

/** Change who reads one of the caller's own work events. Undefined when they have none by that id (someone else's is never found). */
export function setWorkVisibility(actor: Actor, sourceId: string, visibility: WorkVisibility, source?: string, db: Database = database()) {
  const row = ownRow(actor.id, source, sourceId, db);
  if (!row) return undefined;
  const next = { ...row, visibility };
  db.upsert('usage_events', next);
  // The daily totals count only `org` work (counts per kind, no owner or text): a change to or from `org` recomputes that
  // day, unless the day is at the raw retention's edge (some of its events may be pruned already).
  if ((row.visibility === 'org') !== (visibility === 'org') && row.day > dayOf(Date.now() - rawRetentionDays() * 86_400_000)) rollupDays([row.day], db);
  // Sharing is the moment the repository may become a page; going back to private does not remove it.
  const repo = fromRow(next).attrs?.repo;
  if (visibility !== 'private' && typeof repo === 'string' && repo) recordRepo(repo, db);
  return itemOf(next);
}

/**
 * Post as my update: one explicit call that records a `work.self_update` event the caller owns, shared `org` (default) or
 * `team`, linking the item (`attrs.of`). Posting the same item again updates that event instead of adding another.
 */
export function shareWork(actor: Actor, sourceId: string, options: { source?: string; visibility?: 'team' | 'org' } = {}, db: Database = database()) {
  if (!brainEnabled()) throw new BrainOffError();
  const row = ownRow(actor.id, options.source, sourceId, db);
  if (!row) return undefined;
  const attrs = fromRow(row).attrs ?? {};
  const text = (name: string) => (typeof attrs[name] === 'string' && attrs[name] ? String(attrs[name]) : undefined);
  const of = `${row.source}:${row.source_id}`;
  const visibility = options.visibility ?? 'org';
  ensureKind('work.self_update', actor);
  const input: WorkEventInput = {
    kind: 'work.self_update',
    source: 'landflow',
    sourceId: `update:${of}`.slice(0, 200),
    occurredAt: new Date().toISOString(),
    title: text('title') ?? row.message ?? 'An update',
    ...(text('summary') && { summary: text('summary') }),
    ...(text('repo') && { repo: text('repo') }),
    ...(text('initiative') && { initiative: text('initiative') }),
    ...(text('customer') && { customer: text('customer') }),
    ...(text('areas') && { areas: text('areas')!.split(',').filter(Boolean) }),
    ...(text('url') && { url: text('url') }),
    visibility,
  };
  const email = getUser(actor.id)?.email;
  const saved = db.transaction(() => {
    const result = upsertWorkEvent(actor.id, input, email, db);
    // The ledger's attrs have no link field: add `of` to the row it wrote.
    const written = db.get<UsageRow>('SELECT * FROM usage_events WHERE id = ?', result.id);
    if (written) db.upsert('usage_events', { ...written, attrs: JSON.stringify({ ...(fromRow(written).attrs ?? {}), of }) });
    return result;
  });
  if (input.repo) recordRepo(input.repo, db);
  return { id: saved.id, created: saved.created, of, visibility };
}
