/**
 * Event subscriptions: a project's webhooks for its runs' events (docs/features/event-subscriptions.md). This file is
 * the store (create, change, delete, secrets, Retry now), the views the API and the card read (with the backlog and the
 * dead rows of each), and the in-memory index of enabled subscriptions per project that the save hook matches against,
 * so a save in a project without any subscription costs one map lookup. The index is dropped on every local change and
 * when another process changes the table (`onTablesChanged`).
 *
 * The signing secret is made here (`whsec_…`), sealed with the vault, shown once and never returned again.
 */
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { MAX_SUBSCRIPTIONS_PER_PROJECT, RUN_EVENT_TYPES, type EventSubscriptionInput, type EventSubscriptionView, type RunEventType, type SubscriptionDelivery } from '../../shared/event-subscriptions';
import { recordAudit } from '../audit';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { onTablesChanged } from '../db/replication';
import { HttpError } from '../errors';
import { assertUrlAllowed } from '../net/safe-fetch';
import { singleton } from '../singleton';
import { makeDue, SUBSCRIPTION_OUTBOX, SUBSCRIPTION_TOPIC } from './core';

/** A subscription the caller can't make or change as asked (the status says which: 400, 404, 409). */
export class EventSubscriptionError extends HttpError {
  static readonly errorName: string = 'EventSubscriptionError';
  constructor(message: string, status = 400) {
    super(message, status, { expose: true });
  }
}

interface Row {
  id: string;
  project_id: string;
  name: string;
  url: string;
  events: string;
  workflow_ids: string | null;
  node_names: string | null;
  include_output: number | bigint;
  ordered: number | bigint;
  secret: string;
  enabled: number | bigint;
  disabled_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_delivery: string | null;
}

/** A subscription as the save hook and the dispatcher use it (the sealed secret stays sealed until a delivery). */
export interface EventSubscription {
  id: string;
  projectId: string;
  name: string;
  url: string;
  events: RunEventType[];
  workflowIds: string[] | null;
  nodeNames: string[];
  includeOutput: boolean;
  ordered: boolean;
  enabled: boolean;
  disabledReason: string | null;
  sealedSecret: string;
  createdAt: string;
  updatedAt: string;
  lastDelivery: SubscriptionDelivery | null;
}

const db = () => database();
const list = <T>(text: string | null): T[] => {
  try {
    const value = text ? (JSON.parse(text) as unknown) : [];
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
};

function fromRow(row: Row): EventSubscription {
  let lastDelivery: SubscriptionDelivery | null = null;
  try {
    lastDelivery = row.last_delivery ? (JSON.parse(row.last_delivery) as SubscriptionDelivery) : null;
  } catch {
    lastDelivery = null;
  }
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    url: row.url,
    events: list<RunEventType>(row.events),
    workflowIds: row.workflow_ids === null ? null : list<string>(row.workflow_ids),
    nodeNames: list<string>(row.node_names),
    includeOutput: Number(row.include_output) === 1,
    ordered: Number(row.ordered) === 1,
    enabled: Number(row.enabled) === 1,
    disabledReason: row.disabled_reason,
    sealedSecret: row.secret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastDelivery,
  };
}

// ---- the index the save hook matches against -----------------------------------------------------------------------

interface Index {
  byProject: Map<string, EventSubscription[]> | undefined;
  watching: boolean;
}
const index = () => singleton<Index>('event-subscriptions-index', () => ({ byProject: undefined, watching: false }));

/** Drop the index (a local change, or another process changed the table). */
export function forgetSubscriptionIndex() {
  index().byProject = undefined;
}

function byProject(): Map<string, EventSubscription[]> {
  const state = index();
  if (!state.watching) {
    state.watching = true;
    onTablesChanged((change) => {
      if (change.tables.has('event_subscriptions')) forgetSubscriptionIndex();
    });
  }
  if (!state.byProject) {
    const map = new Map<string, EventSubscription[]>();
    for (const row of db().all<Row>('SELECT * FROM event_subscriptions WHERE enabled = 1 ORDER BY created_at, id')) {
      const subscription = fromRow(row);
      map.set(subscription.projectId, [...(map.get(subscription.projectId) ?? []), subscription]);
    }
    state.byProject = map;
  }
  return state.byProject;
}

/** Enabled subscriptions of a project (empty for most projects: the hot path's whole cost). */
export function projectSubscriptions(projectId: string): readonly EventSubscription[] {
  return byProject().get(projectId) ?? [];
}

/** The enabled subscriptions of `projectId` that want `type` for `workflowId` (and, for `node.finished`, for `nodeName`). */
export function matching(projectId: string, workflowId: string, type: RunEventType, nodeName?: string): EventSubscription[] {
  return projectSubscriptions(projectId).filter((s) => s.events.includes(type) && (!s.workflowIds || s.workflowIds.includes(workflowId)) && (type !== 'node.finished' || (nodeName !== undefined && s.nodeNames.includes(nodeName))));
}

// ---- reading -------------------------------------------------------------------------------------------------------

export function getSubscription(id: string): EventSubscription | undefined {
  const row = db().get<Row>('SELECT * FROM event_subscriptions WHERE id = ?', id);
  return row && fromRow(row);
}

/** Every subscription of the instance (the dispatcher's list), enabled or not. */
export function allSubscriptions(): EventSubscription[] {
  return db().all<Row>('SELECT * FROM event_subscriptions ORDER BY created_at, id').map(fromRow);
}

interface Stats {
  live: number;
  dead: number;
  oldest: string | null;
  lastError: string | null;
}

/** Backlog, dead rows and the last error of every subscription (one query). */
function stats(now: number): Map<string, Stats & { oldestAgeSeconds: number }> {
  const out = new Map<string, Stats & { oldestAgeSeconds: number }>();
  for (const row of db().all<{ target_id: string; live: number | bigint; dead: number | bigint; oldest: string | null }>(
    `SELECT target_id, SUM(CASE WHEN dead_at IS NULL THEN 1 ELSE 0 END) AS live, SUM(CASE WHEN dead_at IS NULL THEN 0 ELSE 1 END) AS dead, MIN(CASE WHEN dead_at IS NULL THEN created_at END) AS oldest FROM event_outbox WHERE topic = ? GROUP BY target_id`,
    SUBSCRIPTION_TOPIC,
  )) {
    const failing = db().get<{ last_error: string | null }>(
      "SELECT last_error FROM event_outbox WHERE topic = ? AND target_id = ? AND last_error IS NOT NULL ORDER BY CASE WHEN dead_at IS NULL THEN 1 ELSE 0 END, attempts DESC, created_at LIMIT 1",
      SUBSCRIPTION_TOPIC,
      row.target_id,
    );
    const oldest = row.oldest ? Date.parse(row.oldest) : NaN;
    out.set(row.target_id, { live: Number(row.live), dead: Number(row.dead), oldest: row.oldest, lastError: failing?.last_error ?? null, oldestAgeSeconds: Number.isFinite(oldest) ? Math.max(0, Math.round((now - oldest) / 1000)) : 0 });
  }
  return out;
}

function view(subscription: EventSubscription, stat: (Stats & { oldestAgeSeconds: number }) | undefined): EventSubscriptionView {
  return {
    id: subscription.id,
    projectId: subscription.projectId,
    name: subscription.name,
    url: subscription.url,
    events: subscription.events,
    workflowIds: subscription.workflowIds,
    nodeNames: subscription.nodeNames,
    includeOutput: subscription.includeOutput,
    ordered: subscription.ordered,
    enabled: subscription.enabled,
    disabledReason: subscription.disabledReason,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    lastDelivery: subscription.lastDelivery,
    backlog: stat?.live ?? 0,
    dead: stat?.dead ?? 0,
    lastError: stat?.lastError ?? null,
    oldestAgeSeconds: stat?.oldestAgeSeconds ?? 0,
  };
}

/** A project's subscriptions with their backlog, dead rows and last error (never the secret). */
export function listSubscriptions(projectId: string, now = Date.now()): EventSubscriptionView[] {
  const stat = stats(now);
  return db()
    .all<Row>('SELECT * FROM event_subscriptions WHERE project_id = ? ORDER BY created_at, id', projectId)
    .map((row) => view(fromRow(row), stat.get(row.id)));
}

export function subscriptionView(id: string, now = Date.now()): EventSubscriptionView | undefined {
  const subscription = getSubscription(id);
  return subscription && view(subscription, stats(now).get(id));
}

/** The secret of a subscription, opened for signing a delivery (never logged, never returned by the API). */
export function openSecret(subscription: Pick<EventSubscription, 'sealedSecret'>): string {
  return credentials.openSecret(subscription.sealedSecret);
}

// ---- writing -------------------------------------------------------------------------------------------------------

const names = z.array(z.string().trim().min(1).max(200)).max(50);
export const subscriptionInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the subscription a name').max(120),
  url: z.string().trim().min(1, 'Enter the URL events are sent to').max(2000),
  events: z.array(z.enum(RUN_EVENT_TYPES)).min(1, 'Choose at least one event'),
  workflowIds: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
  nodeNames: names.optional(),
  includeOutput: z.boolean().optional(),
  ordered: z.boolean().optional(),
});
export const subscriptionPatchSchema = subscriptionInputSchema.partial().extend({ enabled: z.boolean().optional(), newSecret: z.boolean().optional() });

/** A URL events may be sent to: http(s), and an address the outbound policy allows (the same check runs again when sending). */
export function checkUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EventSubscriptionError('Enter a full URL, such as https://example.com/hooks/landflow');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EventSubscriptionError('Events are sent over http or https');
  if (url.username || url.password) throw new EventSubscriptionError('Leave a user name and password out of the URL');
  try {
    assertUrlAllowed(url);
  } catch (error) {
    throw new EventSubscriptionError(`Landflow can’t send to this address: ${(error as Error).message}`);
  }
  return url.toString();
}

function normalise(input: Partial<EventSubscriptionInput>, current?: EventSubscription) {
  const events = input.events ?? current?.events ?? [];
  const nodeNames = [...new Set((input.nodeNames ?? current?.nodeNames ?? []).map((n) => n.trim()).filter(Boolean))];
  if (events.includes('node.finished') && !nodeNames.length) throw new EventSubscriptionError('Name the steps “A chosen step finishes” is sent for');
  return { events: [...new Set(events)], nodeNames: events.includes('node.finished') ? nodeNames : [] };
}

const newSecretValue = () => `whsec_${randomBytes(24).toString('base64url')}`;

function audit(action: 'created' | 'updated' | 'deleted', subscription: EventSubscription, details: Record<string, unknown> = {}) {
  recordAudit({
    action: `event_subscription.${action}`,
    target: { type: 'event_subscription', id: subscription.id, name: subscription.name },
    project: subscription.projectId,
    summary: `${action === 'created' ? 'Added' : action === 'updated' ? 'Changed' : 'Removed'} the event subscription “${subscription.name}”`,
    details: { projectId: subscription.projectId, host: safeHost(subscription.url), events: subscription.events.join(','), ...details },
  });
}

/** The URL's host, for the audit log (a path or query may carry a token). */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Add a subscription to `projectId`. Returns it with its signing secret, which is not shown again. */
export function createSubscription(actor: { id?: string } | undefined, projectId: string, input: EventSubscriptionInput): { subscription: EventSubscriptionView; secret: string } {
  const url = checkUrl(input.url);
  const { events, nodeNames } = normalise(input);
  if (db().get<{ n: number | bigint }>('SELECT COUNT(*) AS n FROM event_subscriptions WHERE project_id = ?', projectId)!.n >= MAX_SUBSCRIPTIONS_PER_PROJECT) {
    throw new EventSubscriptionError(`A project can have ${MAX_SUBSCRIPTIONS_PER_PROJECT} event subscriptions; remove one first`, 409);
  }
  const secret = newSecretValue();
  const now = new Date().toISOString();
  const row: Row = {
    id: `evs_${nanoid(12)}`,
    project_id: projectId,
    name: input.name.trim(),
    url,
    events: JSON.stringify(events),
    workflow_ids: input.workflowIds ? JSON.stringify(input.workflowIds) : null,
    node_names: JSON.stringify(nodeNames),
    include_output: input.includeOutput ? 1 : 0,
    ordered: input.ordered === false ? 0 : 1,
    secret: credentials.sealSecret(secret),
    enabled: 1,
    disabled_reason: null,
    created_by: actor?.id ?? null,
    created_at: now,
    updated_at: now,
    last_delivery: null,
  };
  db().transaction(() => {
    db().insertNew('event_subscriptions', row as unknown as Record<string, string | number | null>);
    audit('created', fromRow(row));
  });
  forgetSubscriptionIndex();
  return { subscription: subscriptionView(row.id)!, secret };
}

/** Change a subscription; `newSecret` replaces the signing secret and answers the new one (once). */
export function updateSubscription(id: string, patch: Partial<EventSubscriptionInput> & { enabled?: boolean; newSecret?: boolean }): { subscription: EventSubscriptionView; secret?: string } {
  const current = getSubscription(id);
  if (!current) throw new EventSubscriptionError('Event subscription not found', 404);
  const url = patch.url !== undefined ? checkUrl(patch.url) : current.url;
  const { events, nodeNames } = normalise(patch, current);
  const secret = patch.newSecret ? newSecretValue() : undefined;
  const enabled = patch.enabled ?? current.enabled;
  const next = {
    id,
    project_id: current.projectId,
    name: patch.name?.trim() || current.name,
    url,
    events: JSON.stringify(events),
    workflow_ids: patch.workflowIds !== undefined ? (patch.workflowIds ? JSON.stringify(patch.workflowIds) : null) : current.workflowIds ? JSON.stringify(current.workflowIds) : null,
    node_names: JSON.stringify(nodeNames),
    include_output: (patch.includeOutput ?? current.includeOutput) ? 1 : 0,
    ordered: (patch.ordered ?? current.ordered) ? 1 : 0,
    secret: secret ? credentials.sealSecret(secret) : current.sealedSecret,
    enabled: enabled ? 1 : 0,
    // Turning it back on clears why it was turned off; a URL change does too (the new address gets a fresh start).
    disabled_reason: enabled ? null : patch.enabled === false ? 'Turned off' : current.disabledReason,
    created_by: db().get<{ created_by: string | null }>('SELECT created_by FROM event_subscriptions WHERE id = ?', id)?.created_by ?? null,
    created_at: current.createdAt,
    updated_at: new Date().toISOString(),
    last_delivery: current.lastDelivery ? JSON.stringify(current.lastDelivery) : null,
  };
  db().transaction(() => {
    db().upsert('event_subscriptions', next);
    const changed = [patch.name !== undefined && 'name', patch.url !== undefined && 'url', patch.events !== undefined && 'events', patch.workflowIds !== undefined && 'workflows', patch.nodeNames !== undefined && 'steps', patch.includeOutput !== undefined && 'output', patch.ordered !== undefined && 'order', patch.enabled !== undefined && 'enabled', secret && 'secret'].filter(Boolean);
    audit('updated', fromRow(next as unknown as Row), { changed: changed.join(',') });
  });
  forgetSubscriptionIndex();
  return { subscription: subscriptionView(id)!, ...(secret && { secret }) };
}

/** Delete a subscription and its waiting events. */
export function deleteSubscription(id: string): void {
  const current = getSubscription(id);
  if (!current) throw new EventSubscriptionError('Event subscription not found', 404);
  db().transaction(() => {
    for (const row of db().all<{ event_id: string }>('SELECT event_id FROM event_outbox WHERE topic = ? AND target_id = ?', SUBSCRIPTION_TOPIC, id)) {
      db().delete('event_outbox', { topic: SUBSCRIPTION_TOPIC, target_id: id, event_id: row.event_id });
    }
    db().delete('event_subscriptions', { id });
    audit('deleted', current);
  });
  forgetSubscriptionIndex();
}

/** Retry now: waiting rows are due at once and dead ones come back. Returns how many rows it touched. */
export function retryNow(id: string): number {
  if (!getSubscription(id)) throw new EventSubscriptionError('Event subscription not found', 404);
  return makeDue(SUBSCRIPTION_OUTBOX, id, Date.now(), true);
}

/** Note the outcome of a delivery attempt (shown on the card); `disable` turns the subscription off with a reason. */
export function noteDelivery(id: string, delivery: SubscriptionDelivery, disable?: string): void {
  const row = db().get<Row>('SELECT * FROM event_subscriptions WHERE id = ?', id);
  if (!row) return;
  db().upsert('event_subscriptions', { ...row, last_delivery: JSON.stringify(delivery), ...(disable && { enabled: 0, disabled_reason: disable, updated_at: new Date().toISOString() }) } as never);
  if (disable) forgetSubscriptionIndex();
}
