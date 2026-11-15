/**
 * Requests for a higher AI cap (docs/llm-gateway.md#asking-for-a-higher-cap), rows in `ai_cap_requests`.
 *
 * A person asks (`createCapRequest`); the cap-raise flow (templates/builtin-ai.ts) starts from Cap Raise Request and asks
 * an admin other than the requester through Ask a Person; Apply Cap Raise (nodes/cap-raise.ts) calls `applyCapRequest`,
 * which changes the Landflow cap and tells the budgets sync only after the server's own record of that run shows an
 * owner or admin who is not the requester approved. Nothing changes without a person.
 */
import { nanoid } from 'nanoid';
import { parseCapId, type CapRaiseInput, type CapRaiseRequest, type CapRaiseSetup, type CapRaiseStatus, type ParsedCapId } from '../../shared/llm-gateway';
import type { Workflow } from '../../shared/types';
import { watchedCaps, type WatchedCap } from '../ai-usage/alerts';
import { aiUsageMeter } from '../ai-usage';
import { aiCaps, saveAiCaps } from '../ai-usage/caps';
import { agentStore } from '../agents/store';
import { outsideRequest } from '../auth/context';
import { findUserByEmail, getUser, listUsers, normalizeEmail, type UserRecord } from '../auth/users';
import { database } from '../db';
import { HttpError } from '../errors';
import { decodeCursor, encodeCursor } from '../pagination';
import { createIn } from '../projects/http';
import { canResource, creationProject, isInstanceAdmin, type Actor } from '../projects/access';
import { cancelWaitingExecution, liveExecution } from '../runner';
import { publishDraft } from '../publish';
import { publishedVersionId } from '../publications';
import { store } from '../store';
import { useTemplate } from '../templates';
import { getVersion, versionHash } from '../versions';
import { logger } from '../telemetry/logger';
import { capRaiseFlow, fireCapRaise, resetCapRaiseTrigger, type CapRaiseItem } from './cap-raise-trigger';
import { capsChanged } from './events';

export const CAP_RAISE_KEY = 'ai_cap_raise';
export const CAP_RAISE_TEMPLATE = 'ai-cap-raise';

export class CapRequestError extends HttpError {
  static readonly errorName: string = 'CapRequestError';
  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message, status, { expose: true, ...(details && { details }) });
  }
}

const OPEN: CapRaiseStatus[] = ['pending', 'asking'];

interface Row {
  id: string;
  cap_id: string;
  subject: string;
  metric: string;
  period: string;
  current_max: number;
  requested_max: number;
  reason: string;
  requested_by: string;
  status: string;
  workflow_id: string | null;
  execution_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  gateway: string | null;
  created_at: string;
  updated_at: string;
}

const nameOf = (id: string | null | undefined): string | undefined => (id ? (getUser(id)?.name || getUser(id)?.email || undefined) : undefined);

function view(row: Row): CapRaiseRequest {
  return {
    id: row.id,
    capId: row.cap_id,
    subject: row.subject,
    metric: row.metric as 'tokens' | 'cost',
    period: row.period as 'day' | 'month',
    current: row.current_max,
    requested: row.requested_max,
    reason: row.reason,
    requestedBy: row.requested_by,
    ...(nameOf(row.requested_by) && { requestedByName: nameOf(row.requested_by) }),
    status: row.status as CapRaiseStatus,
    ...(row.workflow_id && { workflowId: row.workflow_id }),
    ...(row.execution_id && { executionId: row.execution_id }),
    ...(row.decided_by && { decidedBy: row.decided_by }),
    ...(nameOf(row.decided_by) && { decidedByName: nameOf(row.decided_by) }),
    ...(row.decided_at && { decidedAt: row.decided_at }),
    ...(row.note && { note: row.note }),
    ...(row.gateway && { gateway: row.gateway as 'updated' | 'skipped' | 'failed' }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const rowOf = (id: string): Row | undefined => database().get<Row>('SELECT * FROM ai_cap_requests WHERE id = ?', id);

/** Change a request's columns (and `updated_at`). */
function update(id: string, patch: Record<string, string | number | null>) {
  const row = rowOf(id);
  if (row) database().upsert('ai_cap_requests', { ...row, ...patch, updated_at: new Date().toISOString() });
}

export function getCapRequest(id: string): CapRaiseRequest | undefined {
  const row = rowOf(id);
  return row && view(row);
}

// ---------------------------------------------------------------------------
// The setup: which workflow is the cap-raise flow
// ---------------------------------------------------------------------------

function setupWorkflowId(): string | undefined {
  try {
    const raw = database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', CAP_RAISE_KEY)?.value;
    const id = raw ? (JSON.parse(raw) as { workflowId?: unknown }).workflowId : undefined;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The flow's workflow, and whether it is installed, published and its trigger enabled. */
export function capRaiseSetup(): CapRaiseSetup {
  const workflowId = setupWorkflowId();
  const workflow = workflowId ? store.getWorkflow(workflowId) : undefined;
  if (!workflowId || !workflow) return { active: false };
  return { workflowId, active: capRaiseFlow(workflowId)?.workflow.id === workflowId };
}

/**
 * Install the cap-raise flow once: the template, into the admin's home project, published and active. A second call
 * answers the existing one. The admin's click is the person in the loop for turning it on.
 */
export async function installCapRaise(actor: Actor): Promise<CapRaiseSetup> {
  if (!isInstanceAdmin(actor)) throw new CapRequestError('Only an admin turns on the cap-raise flow', 403);
  const existing = setupWorkflowId();
  if (existing && store.getWorkflow(existing)) {
    if (!capRaiseSetup().active) await publishDraft(existing, actor.id);
    resetCapRaiseTrigger();
    return capRaiseSetup();
  }
  const projectId = creationProject(actor);
  const result = await useTemplate(CAP_RAISE_TEMPLATE, {}, {
    ...(projectId && { projectId }),
    createWorkflow: (save, workflowId) => createIn(projectId, 'workflow', save, (w: Workflow) => w.id, workflowId),
    createTable: (create) => create(),
  });
  const workflowId = result.workflow?.id;
  if (!workflowId) throw new CapRequestError('The cap-raise template made no workflow', 500);
  await publishDraft(workflowId, actor.id);
  database().upsert('settings', { key: CAP_RAISE_KEY, value: JSON.stringify({ workflowId }) });
  resetCapRaiseTrigger();
  return capRaiseSetup();
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/** The caps `actor` may ask about, found in `caps`: their own user cap; a workflow or agent cap they can change. */
function mayAsk(actor: Actor, cap: ParsedCapId): boolean {
  if (cap.kind === 'user') return cap.subjectId === actor.id;
  // An admin sets a credential's caps directly.
  if (cap.kind === 'credential') return false;
  return canResource(actor, cap.kind, cap.subjectId, 'update');
}

/** Owners and admins other than `requesterId`, who are active. */
export function approversFor(requesterId: string): UserRecord[] {
  return listUsers().filter((user) => user.id !== requesterId && !user.disabledAt && (user.role === 'owner' || user.role === 'admin'));
}

export async function createCapRequest(actor: Actor, input: CapRaiseInput): Promise<CapRaiseRequest> {
  const parsed = parseCapId(input.capId);
  const cap: WatchedCap | undefined = parsed && watchedCaps().find((c) => c.id === input.capId);
  if (!parsed || !cap || !mayAsk(actor, parsed)) throw new CapRequestError('You can’t ask for more on that cap', 400);
  if (!Number.isFinite(input.requested) || input.requested <= cap.max) throw new CapRequestError(`Ask for more than the cap is now (${cap.max})`, 400);
  if (input.requested > cap.max * 100) throw new CapRequestError('Ask for at most 100 times the cap', 400);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 500) throw new CapRequestError('Say why, in 3 to 500 characters', 400);
  const open = database().get<{ id: string }>(`SELECT id FROM ai_cap_requests WHERE cap_id = ? AND requested_by = ? AND status IN ('pending', 'asking')`, cap.id, actor.id);
  if (open) throw new CapRequestError('You already asked for more on this cap; wait for the answer or cancel it', 409, { existingId: open.id });
  const flow = capRaiseFlow(setupWorkflowId());
  // Only the flow an admin installed handles a request: no other workflow's Ask a Person stands in for the admin's.
  if (!flow) throw new CapRequestError('An admin must turn on the cap-raise flow first (Insights → AI)', 409);

  const now = new Date().toISOString();
  const id = `acr_${nanoid(10)}`;
  database().upsert('ai_cap_requests', {
    id,
    cap_id: cap.id,
    subject: cap.subject,
    metric: cap.metric,
    period: cap.period,
    current_max: cap.max,
    requested_max: input.requested,
    reason,
    requested_by: actor.id,
    status: 'pending',
    workflow_id: null,
    execution_id: null,
    decided_by: null,
    decided_at: null,
    note: null,
    gateway: null,
    created_at: now,
    updated_at: now,
  });

  const requester = getUser(actor.id);
  const approvers = approversFor(actor.id).map((user) => user.email).filter(Boolean);
  if (!approvers.length) {
    update(id, { status: 'failed', note: 'No admin other than you can approve this' });
    return getCapRequest(id)!;
  }
  const item: CapRaiseItem = {
    requestId: id,
    capId: cap.id,
    subject: cap.subject,
    metric: cap.metric,
    period: cap.period,
    current: cap.max,
    requested: input.requested,
    reason,
    requestedBy: { id: actor.id, name: requester?.name || requester?.email || actor.id },
    approvers: approvers.join(','),
  };
  try {
    const run = await fireCapRaise(flow, item);
    // The run may already have settled the request (an Apply Cap Raise before the wait); only a still-pending one asks.
    if (rowOf(id)?.status === 'pending' && !run.error) update(id, { status: 'asking', workflow_id: run.workflowId, execution_id: run.executionId });
    else if (run.error) update(id, { status: 'failed', workflow_id: run.workflowId, execution_id: run.executionId, note: run.error });
    else update(id, { workflow_id: run.workflowId, execution_id: run.executionId });
  } catch (error) {
    logger.warn('the cap-raise flow could not start', { error: (error as Error).message });
    update(id, { status: 'failed', note: 'The cap-raise flow could not start' });
  }
  return getCapRequest(id)!;
}

export interface CapRequestPage {
  items: CapRaiseRequest[];
  nextCursor?: string;
}

/** Admins see every request, others their own; newest first, keyset-paged. */
export function listCapRequests(actor: Actor, options: { status?: CapRaiseStatus; limit: number; cursor?: string }): CapRequestPage {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (!isInstanceAdmin(actor)) {
    where.push('requested_by = ?');
    params.push(actor.id);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  const at = options.cursor ? decodeCursor(options.cursor) : undefined;
  if (at) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(at.s, at.s, at.i);
  }
  const rows = database().all<Row>(`SELECT * FROM ai_cap_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return { items: page.map(view), ...(rows.length > options.limit && last && { nextCursor: encodeCursor({ s: last.created_at, i: last.id }) }) };
}

/** The requester (or an admin) withdraws a request while it is open. */
export function cancelCapRequest(actor: Actor, id: string): CapRaiseRequest {
  const row = rowOf(id);
  if (!row || (row.requested_by !== actor.id && !isInstanceAdmin(actor))) throw new CapRequestError('Request not found', 404);
  if (!OPEN.includes(row.status as CapRaiseStatus)) throw new CapRequestError(`This request is already ${row.status}`, 409);
  update(id, { status: 'cancelled' });
  // The run stops waiting, so the question leaves the admins' Needs you.
  if (row.execution_id) cancelWaitingExecution(row.execution_id);
  return getCapRequest(id)!;
}

// ---------------------------------------------------------------------------
// Applying (Apply Cap Raise)
// ---------------------------------------------------------------------------

export interface RecordedDecision {
  approved: boolean;
  /** Who decided: an email, "slack:<id>", "timeout" or "unknown". */
  by?: string;
  comment?: string;
}

/**
 * The Ask a Person decision of an execution, from the server's record of the run (the output of its `core.confirmDraft`
 * nodes), never from the item the Apply node received: an expression or a Code node could write that. Undefined when
 * the run has no such decision.
 */
export function recordedDecision(executionId: string): RecordedDecision | undefined {
  const record = liveExecution(executionId) ?? store.getExecution(executionId);
  if (!record) return undefined;
  const workflow = record.workflow ?? store.getWorkflow(record.workflowId);
  const asks = (workflow?.nodes ?? []).filter((n) => n.type === 'core.confirmDraft');
  for (const ask of asks) {
    const outputs = record.runData[ask.id]?.at(-1)?.outputs;
    const item = outputs?.[0]?.[0] ?? outputs?.[1]?.[0];
    if (!item) continue;
    const json = item.json as { approved?: unknown; by?: unknown; comment?: unknown };
    return { approved: Boolean(outputs?.[0]?.length) && json.approved === true, ...(typeof json.by === 'string' && { by: json.by }), ...(typeof json.comment === 'string' && { comment: json.comment }) };
  }
  return undefined;
}

/** The active owner or admin a decision's `by` names (an email, or `email:<address>`), or undefined. */
function deciderOf(by: string | undefined): UserRecord | undefined {
  if (!by || by === 'timeout' || by === 'unknown' || by.startsWith('slack:')) return undefined;
  const user = findUserByEmail(normalizeEmail(by.startsWith('email:') ? by.slice(6) : by));
  return user && !user.disabledAt && (user.role === 'owner' || user.role === 'admin') ? user : undefined;
}

const LIMIT_FIELD = { 'day:tokens': 'dayTokens', 'day:cost': 'dayCost', 'month:tokens': 'monthTokens', 'month:cost': 'monthCost' } as const;
const AGENT_FIELD = { 'day:tokens': 'dailyTokenLimit', 'day:cost': 'dailyCostLimit', 'month:cost': 'monthlyCostLimit' } as const;
const WORKFLOW_FIELD = { 'day:tokens': 'aiMaxTokensPerDay', 'day:cost': 'aiMaxCostPerDay' } as const;

/** What changing a cap needs; a thrown message is the request's note. */
async function raiseCap(row: Row, cap: ParsedCapId, approver: UserRecord) {
  const key = `${cap.period}:${cap.metric}` as keyof typeof LIMIT_FIELD;
  const value = row.requested_max;
  // The ask may be days old: never lower a cap, and never add one that was removed since.
  const current = watchedCaps().find((c) => c.id === row.cap_id);
  if (!current) throw new Error('The cap no longer exists');
  if (current.max >= value) throw new Error(`The cap is already ${current.max}`);
  if (cap.kind === 'user' || cap.kind === 'credential') {
    const caps = aiCaps();
    const group = cap.kind === 'user' ? caps.users : caps.credentials;
    // A user under the cap for every user gets a set of their own: a copy of it with the one field raised.
    const base = group[cap.subjectId] ?? (cap.kind === 'user' ? caps.allUsers : undefined) ?? {};
    const name = base.name || (cap.kind === 'user' ? nameOf(cap.subjectId) : undefined);
    const next = { ...base, ...(name && { name }), [LIMIT_FIELD[key]]: value };
    saveAiCaps({ ...caps, ...(cap.kind === 'user' ? { users: { ...caps.users, [cap.subjectId]: next } } : { credentials: { ...caps.credentials, [cap.subjectId]: next } }) });
    // The meter keeps the caps for a few seconds; the next call and the next request see the new one.
    aiUsageMeter().invalidateCaps();
    return;
  }
  if (cap.kind === 'workflow') {
    const field = WORKFLOW_FIELD[key as keyof typeof WORKFLOW_FIELD];
    if (!field) throw new Error('A workflow has only daily caps');
    const workflow = store.getWorkflow(cap.subjectId);
    if (!workflow) throw new Error('The workflow no longer exists');
    const raised: Workflow = { ...workflow, settings: { ...workflow.settings, [field]: value } };
    const publishedId = publishedVersionId(workflow.id);
    // Production runs use the published version's settings. Publishing the draft would publish its other changes too.
    if (publishedId) {
      const published = getVersion(workflow.id, publishedId);
      if (!published || versionHash(published.workflow as Workflow) !== versionHash(workflow)) throw new Error('The workflow has changes that are not published; publish it, then raise the cap in its settings');
    }
    store.saveWorkflow(raised, { actor: approver.id });
    if (publishedId) {
      try {
        await publishDraft(workflow.id, approver.id);
      } catch (error) {
        // Nothing half-applied: the draft goes back to what it was.
        store.saveWorkflow(workflow, { actor: approver.id });
        throw new Error(`the workflow could not be published with its raised cap (${(error as Error).message})`);
      }
    }
    return;
  }
  const field = AGENT_FIELD[key as keyof typeof AGENT_FIELD];
  if (!field) throw new Error('An agent has no weekly or monthly token cap');
  const agent = agentStore.get(cap.subjectId);
  if (!agent) throw new Error('The agent no longer exists');
  // The cap is a limit, not behavior: it is set in the draft and in the published version in place, so the draft stays
  // as it is and nothing else the draft changed goes live.
  const withLimit = <T extends { settings?: object }>(config: T): T => ({ ...config, settings: { ...config.settings, [field]: value } });
  const published = agent.published && { ...agent.published, config: withLimit(agent.published.config) };
  const history = agent.history.map((v) => (published && v.version === published.version ? { ...v, config: withLimit(v.config) } : v));
  agentStore.rewrite({ ...withLimit(agent), ...(published && { published }), history, updatedAt: new Date().toISOString() });
}

/** The link row the sync keeps for what a cap touches, if it has one. */
function linkOf(cap: ParsedCapId): { state: string; synced_at: string } | undefined {
  const db = database();
  if (cap.kind === 'user') return db.get('SELECT state, synced_at FROM llm_gateway_links WHERE kind = ? AND landflow_id = ?', 'customer', cap.subjectId);
  if (cap.kind === 'credential') return db.get('SELECT state, synced_at FROM llm_gateway_links WHERE kind = ? AND landflow_id = ?', 'key', `credential:${cap.subjectId}`);
  if (cap.kind === 'agent') {
    const rows = db.all<{ landflow_id: string; state: string; synced_at: string }>(`SELECT landflow_id, state, synced_at FROM llm_gateway_links WHERE kind = 'key' AND landflow_id LIKE 'runtime:%'`);
    return rows.find((r) => r.landflow_id.endsWith(`:${cap.subjectId}`));
  }
  return undefined;
}

export interface AppliedCapRequest {
  requestId: string;
  status: CapRaiseStatus;
  gateway?: 'updated' | 'skipped' | 'failed';
}

/**
 * Settle the request `requestId` for the run `executionId` that asked: `outcome` is which Apply Cap Raise branch ran.
 * `rejected` records the no (and the comment); `approved` needs the server's own record of an approval by an owner or
 * admin who is not the requester, and only then changes the cap and tells the budgets sync.
 */
export async function applyCapRequest(requestId: string, executionId: string, outcome: 'approved' | 'rejected'): Promise<AppliedCapRequest> {
  const row = rowOf(requestId);
  if (!row) throw new CapRequestError('Request not found', 404);
  if (row.status !== 'asking') throw new CapRequestError(`This request is ${row.status}, not waiting for an answer`, 409);
  if (row.execution_id !== executionId) throw new CapRequestError('A request is applied only by the run it started', 409);
  const decision = recordedDecision(executionId);
  const fail = (note: string): AppliedCapRequest => {
    update(requestId, { status: 'failed', note });
    return { requestId, status: 'failed' };
  };

  if (outcome === 'rejected') {
    const by = decision && !decision.approved ? deciderOf(decision.by) : undefined;
    update(requestId, { status: 'rejected', decided_at: new Date().toISOString(), note: decision?.comment || (decision?.by === 'timeout' ? 'Nobody answered in time' : null), ...(by && { decided_by: by.id }) });
    return { requestId, status: 'rejected' };
  }
  if (!decision?.approved) return fail('The run has no recorded approval, so nothing changed');
  const approver = deciderOf(decision.by);
  if (!approver) return fail('The approval was not by an admin, so nothing changed');
  if (approver.id === row.requested_by) return fail('You can’t approve your own request, so nothing changed');
  const cap = parseCapId(row.cap_id);
  if (!cap) return fail('The cap is not one Landflow knows');
  // Only the installed flow may raise a cap, and only for a request it started.
  const installed = setupWorkflowId();
  const ran = (liveExecution(executionId) ?? store.getExecution(executionId))?.workflowId;
  if (!installed || row.workflow_id !== installed || ran !== installed) return fail('The run is not the installed cap-raise flow, so nothing changed');

  try {
    await raiseCap(row, cap, approver);
  } catch (error) {
    const message = (error as Error).message;
    return fail(message.startsWith('The cap ') ? `${message}, so nothing changed` : `The approved cap could not be changed: ${message}`);
  }
  const decidedAt = new Date().toISOString();
  // The budgets sync (LL04) listens; awaited so the link row is current when it is read.
  await outsideRequest(() => capsChanged('approval', [row.cap_id]));
  const link = linkOf(cap);
  const gateway: 'updated' | 'skipped' | 'failed' = link?.state === 'failed' ? 'failed' : link?.state === 'synced' && link.synced_at >= decidedAt ? 'updated' : 'skipped';
  update(requestId, { status: 'approved', decided_by: approver.id, decided_at: decidedAt, gateway, ...(decision.comment && { note: decision.comment }) });
  return { requestId, status: 'approved', gateway };
}
