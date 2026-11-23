/**
 * Linear records as activity items (docs/protocol.md §16): issues, comments, project updates, projects and cycles,
 * from GraphQL nodes (List Changed Since, Get) or webhook payloads (the Linear Trigger). Both shapes meet in the
 * mappers below, which only read the fields they find, so a payload missing a field gives a null hint, not an error.
 */
import { activityItem, ACTIVITY_ITEM_SCHEMA, type ActivityItem, type JsonObject } from '@landflow/sdk';

export type Entity = 'issue' | 'comment' | 'project-update' | 'project' | 'cycle';

export interface ActivityHints {
  /** A label named `<prefix><customer>` names the customer when Linear's customer needs do not. Default `customer:`. */
  customerPrefix: string;
}

export const hintsOf = (options: JsonObject | undefined): ActivityHints => ({
  customerPrefix: options?.customerLabelPrefix === undefined ? 'customer:' : String(options.customerLabelPrefix).trim().toLowerCase(),
});

/** Get: an activity item plus the full text (description and comments). */
export const ACTIVITY_WITH_TEXT_SCHEMA: JsonObject = {
  ...ACTIVITY_ITEM_SCHEMA,
  properties: { ...(ACTIVITY_ITEM_SCHEMA.properties as JsonObject), text: { type: 'string', description: 'The issue description and its comments, as Markdown text' } },
  required: [...(ACTIVITY_ITEM_SCHEMA.required as string[]), 'text'],
};

// --- GraphQL selections ---------------------------------------------------------------------------------------------

export const issueFields = (customerNeeds: boolean) => `
  id identifier title description url createdAt updatedAt priority
  state { name type }
  team { key name }
  project { name }
  assignee { email }
  creator { email }
  labels(first: 20) { nodes { name } }
  ${customerNeeds ? 'needs(first: 5) { nodes { customer { name } } }' : ''}`;

export const COMMENT_FIELDS = `
  id body url createdAt updatedAt
  user { email }
  issue { id identifier title team { key name } project { name } labels(first: 20) { nodes { name } } }
  projectUpdate { id project { name } }`;

export const PROJECT_UPDATE_FIELDS = `
  id body url updatedAt health
  user { email }
  project { name teams(first: 1) { nodes { name } } }`;

// --- helpers ----------------------------------------------------------------------------------------------------------

const obj = (value: unknown): JsonObject | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined);
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const lower = (value: unknown): string | null => str(value)?.trim().toLowerCase() ?? null;

/** A GraphQL connection (`{nodes: […]}`) or a plain list, as a list of objects. */
export function listOf(value: unknown): JsonObject[] {
  const items = Array.isArray(value) ? value : Array.isArray(obj(value)?.nodes) ? (obj(value)!.nodes as unknown[]) : [];
  return items.map(obj).filter((x): x is JsonObject => x !== undefined);
}

export const labelNames = (issue: JsonObject): string[] => listOf(issue.labels).map((l) => String(l.name ?? '')).filter(Boolean);

function customerOf(issue: JsonObject, hints: ActivityHints): string | null {
  for (const need of listOf(issue.needs)) {
    const name = str(obj(need.customer)?.name);
    if (name) return name;
  }
  const prefix = hints.customerPrefix;
  if (!prefix) return null;
  for (const name of labelNames(issue)) {
    if (name.toLowerCase().startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length).trim() || null;
  }
  return null;
}

const firstLine = (text: string) => text.split('\n').find((l) => l.trim())?.trim() ?? '';

export const CLOSED_AT_EPSILON_MS = 2000;

/** Whether an issue was created in the same moment as its last update (a poll cannot see the event, only the times). */
const looksNew = (createdAt: unknown, updatedAt: unknown) => {
  const c = Date.parse(String(createdAt ?? ''));
  const u = Date.parse(String(updatedAt ?? ''));
  return Number.isFinite(c) && Number.isFinite(u) && Math.abs(u - c) < CLOSED_AT_EPSILON_MS;
};

export interface EventInfo {
  action?: string;
  actorEmail?: string | null;
  /** The webhook's `updatedFrom`: previous values of what changed. */
  updatedFrom?: JsonObject;
  /** The webhook's own `url`, for payloads whose data has none. */
  url?: string | null;
}

interface Common {
  hints: ActivityHints;
  event?: EventInfo;
  cursor?: string;
  withText?: boolean;
  text?: string;
}

const finish = (item: ActivityItem, input: Common): ActivityItem & { text?: string } => (input.withText ? { ...item, text: input.text ?? '' } : item);
const cursorPart = (input: Common) => (input.cursor !== undefined ? { cursor: input.cursor } : {});

/** Suggested kind of an issue event: `work.bug_reported` / `work.feature_request` for a new issue by label, else `work.ticket_moved`. */
export function issueKind(labels: string[], isNew: boolean): string {
  if (isNew) {
    const lowered = labels.map((l) => l.trim().toLowerCase());
    if (lowered.some((l) => l === 'bug' || l.startsWith('bug ') || l.startsWith('bug:'))) return 'work.bug_reported';
    if (lowered.some((l) => l === 'feature' || l.startsWith('feature ') || l.startsWith('feature:'))) return 'work.feature_request';
  }
  return 'work.ticket_moved';
}

export function issueActivity(issue: JsonObject, input: Common): ActivityItem & { text?: string } {
  const labels = labelNames(issue);
  const state = obj(issue.state);
  const team = obj(issue.team);
  const event = input.event;
  const isNew = event?.action ? event.action === 'create' : looksNew(issue.createdAt, issue.updatedAt);
  const stateChanged = Boolean(event?.updatedFrom && ('stateId' in event.updatedFrom || 'state' in event.updatedFrom));
  const description = String(issue.description ?? '');
  const identifier = str(issue.identifier) ?? String(issue.id);
  const stateName = str(state?.name);
  const summary = stateChanged && stateName ? `Moved to ${stateName}. ${description}` : description;
  const item = activityItem({
    source: 'linear',
    sourceId: `linear:issue:${issue.id}:${issue.updatedAt}`,
    url: str(issue.url) ?? event?.url ?? null,
    actorEmail: event?.actorEmail !== undefined ? event.actorEmail : lower(obj(issue.creator)?.email),
    occurredAt: String(issue.updatedAt),
    kind: isNew ? issueKind(labels, true) : 'work.ticket_moved',
    title: `${identifier}: ${String(issue.title ?? '')}`,
    summary,
    teamHint: str(team?.name),
    initiativeHint: str(obj(issue.project)?.name),
    customerHint: customerOf(issue, input.hints),
    raw: {
      entity: 'issue',
      id: issue.id,
      identifier,
      action: event?.action ?? null,
      state: stateName,
      stateType: state?.type ?? null,
      stateChanged,
      priority: issue.priority ?? null,
      labels,
      team: str(team?.key),
      assignee: lower(obj(issue.assignee)?.email),
    },
    ...cursorPart(input),
  });
  return finish(item, input);
}

export function commentActivity(comment: JsonObject, input: Common): ActivityItem & { text?: string } {
  const issue = obj(comment.issue);
  const project = obj(comment.projectUpdate) ? obj(obj(comment.projectUpdate)!.project) : undefined;
  const body = String(comment.body ?? '');
  const where = str(issue?.identifier) ?? (project ? str(project.name) : null) ?? 'comment';
  const item = activityItem({
    source: 'linear',
    sourceId: `linear:comment:${comment.id}:${comment.updatedAt}`,
    url: str(comment.url) ?? input.event?.url ?? null,
    actorEmail: input.event?.actorEmail !== undefined ? input.event.actorEmail : lower(obj(comment.user)?.email),
    occurredAt: String(comment.updatedAt),
    kind: 'work.discussion',
    title: `${where}: ${firstLine(body)}`,
    summary: body,
    teamHint: str(obj(issue?.team)?.name),
    initiativeHint: str(obj(issue?.project)?.name) ?? str(project?.name),
    customerHint: issue ? customerOf(issue, input.hints) : null,
    raw: { entity: 'comment', id: comment.id, action: input.event?.action ?? null, issue: str(issue?.identifier), issueTitle: str(issue?.title), body },
    ...cursorPart(input),
  });
  return finish(item, input);
}

export function projectUpdateActivity(update: JsonObject, input: Common): ActivityItem & { text?: string } {
  const project = obj(update.project);
  const body = String(update.body ?? '');
  const item = activityItem({
    source: 'linear',
    sourceId: `linear:project-update:${update.id}:${update.updatedAt}`,
    url: str(update.url) ?? input.event?.url ?? null,
    actorEmail: input.event?.actorEmail !== undefined ? input.event.actorEmail : lower(obj(update.user)?.email),
    occurredAt: String(update.updatedAt),
    kind: 'work.self_update',
    title: `${str(project?.name) ?? 'Project'} update${str(update.health) ? ` (${update.health})` : ''}: ${firstLine(body)}`,
    summary: body,
    teamHint: str(listOf(project?.teams)[0]?.name) ?? str(obj(project?.team)?.name),
    initiativeHint: str(project?.name),
    customerHint: null,
    raw: { entity: 'project-update', id: update.id, action: input.event?.action ?? null, project: str(project?.name), health: update.health ?? null, body },
    ...cursorPart(input),
  });
  return finish(item, input);
}

/** A project or cycle webhook that reports completion (`completedAt` set by this event): `work.release`; anything else is null (not an event worth a run). */
export function completionActivity(entity: 'project' | 'cycle', data: JsonObject, input: Common): ActivityItem | null {
  const event = input.event;
  const completedAt = str(data.completedAt);
  if (!completedAt) return null;
  if (event?.action === 'update' && event.updatedFrom && !('completedAt' in event.updatedFrom)) return null;
  const team = obj(data.team);
  const name = str(data.name) ?? (entity === 'cycle' ? `Cycle ${data.number ?? ''}`.trim() : 'Project');
  return activityItem({
    source: 'linear',
    sourceId: `linear:${entity}:${data.id}:${data.updatedAt ?? completedAt}`,
    url: str(data.url) ?? event?.url ?? null,
    actorEmail: event?.actorEmail ?? null,
    occurredAt: String(data.updatedAt ?? completedAt),
    kind: 'work.release',
    title: `${entity === 'cycle' ? 'Cycle completed' : 'Project completed'}: ${name}`,
    summary: str(data.description) ?? '',
    teamHint: str(team?.name),
    initiativeHint: entity === 'project' ? name : null,
    customerHint: null,
    raw: { entity, id: data.id, name, completedAt, action: event?.action ?? null },
  });
}

/** The full text of an issue for Get: the description, then each comment as `@author (date): body`. */
export function issueText(issue: JsonObject): string {
  const parts = [String(issue.description ?? '').trim()].filter(Boolean);
  for (const comment of listOf(issue.comments)) {
    const who = str(obj(comment.user)?.name) ?? str(obj(comment.user)?.email) ?? 'someone';
    parts.push(`${who} (${comment.createdAt}): ${String(comment.body ?? '').trim()}`);
  }
  return parts.join('\n\n---\n\n');
}

/** A Since value as ISO time: ISO as is (a cursor is one), a date alone is UTC; empty is 24 hours ago. */
export function sinceIso(value: unknown, now = Date.now()): string {
  const text = String(value ?? '').trim();
  if (!text) return new Date(now - 86_400_000).toISOString();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text) ? `${text}Z` : text);
  if (!Number.isFinite(ms)) throw new Error(`Since must be an ISO 8601 time or a cursor from an earlier item (got "${text}")`);
  return new Date(ms).toISOString();
}
