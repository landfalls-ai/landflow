/**
 * Recording someone's work (docs/work-and-briefings.md): POST/DELETE /api/brain/work. The events are the caller's own and
 * private to them (nobody else reads one, not an admin); sharing with a team or the organization comes later. The
 * contract is `WorkEventInput` in packages/protocol; this file validates with it, declares the kind on first use and
 * writes through the ledger (usage/ledger.ts `upsertWorkEvent`).
 */
import { validateWorkEvent, type WorkEventInput } from '@landflow/protocol';
import { getUser } from '../auth/users';
import { HttpError } from '../errors';
import type { Actor } from '../projects/access';
import { getKind, saveKind } from '../usage/kinds';
import { brainEnabled, deleteWorkEvent, upsertWorkEvent } from '../usage/ledger';
import type { UsageKindField } from '../../shared/brain';

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

/** The fields every work kind declares (deploy/brain/work-kinds.json holds the same list for the declare script). */
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
export const DECLARABLE_KINDS = new Set(['work.discussion', 'work.decision', 'work.bug_reported', 'work.release', 'work.deal_won', 'work.deal_moved', 'work.meeting_scheduled', 'work.meeting_held', 'work.meeting_cancelled', 'work.meeting_notes', 'work.action_item', 'work.doc_edited', 'work.ticket_moved', 'work.feature_request', 'work.pr_opened', 'work.pr_merged', 'work.self_update', 'work.session']);

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
    if (event.visibility && event.visibility !== 'private') {
      rejected.push({ sourceId: event.sourceId, reason: 'Sharing comes later: send it as private for now' });
      continue;
    }
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
      const { id, created } = upsertWorkEvent(actor.id, { ...event, visibility: 'private' }, email);
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
