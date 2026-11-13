/**
 * The audit log: who did what, when and from where. `recordAudit()` is the API for domain events (sign-ins, user and
 * role changes, API keys, workflows and their publishing, credentials and their use in runs, settings, executions,
 * Git sync, plugins, marketplace installs, four-eyes approvals); `handler` (lib/server/http.ts) adds a generic
 * `api.request` event for every other change made through the API (./http). Each event is
 *
 * - stored in `audit_events` (./store), kept for Settings → Audit log's retention (./settings);
 * - queued in the same transaction for every enabled SIEM destination, delivered with retries (./outbox, ./sinks);
 * - emitted as an OTel log record with `event.name` and semantic attributes (./otel), and a process log line.
 *
 * Inside an API request the event gets the request's principal (user, API key id), client address, user agent,
 * request id, method and route pattern (./context); elsewhere (schedules, triggers, workers) the actor is the system.
 * Details are flat ids, names and counts: keys that look secret are dropped, and nothing reads request bodies.
 * Recording never throws by default: a failure is logged, counted (`landflow.audit.write_failures`, ./metrics) and the
 * action goes on. With `LANDFLOW_AUDIT_FAIL_CLOSED=true`, a call that passes `{ required: true }` (role changes, API keys,
 * credentials, audit settings, SCIM provisioning) throws `AuditUnavailableError` (503) instead, and its call site orders
 * the change so it does not happen without its event.
 *
 * Publishes, rollbacks and unpublishes are recorded from the publish timeline (lib/server/publications.ts), so every
 * path that publishes is covered; plugin registrations and removals from the registry's events (lib/server/bus.ts).
 */
import { randomBytes } from 'node:crypto';
import type { WorkflowNode } from '@landflow/engine';
import { AUDIT_ACTIONS, type AuditActor, type AuditEvent, type AuditOutcome, type AuditTarget, type AuditValue } from '../../shared/audit';
import { requestAuth } from '../auth/context';
import { getUser } from '../auth/users';
import { bus } from '../bus';
import { database } from '../db';
import { registryAudit } from '../plugins/registry-audit';
import { onPublicationChanged, publishLog } from '../publications';
import { singleton } from '../singleton';
import { SECRET_KEY } from '../telemetry/config';
import { logger } from '../telemetry/logger';
import { auditFailClosed } from '../config/audit';
import { HttpError } from '../errors';
import { auditRequestContext } from './context';
import { recordAuditWriteFailure } from './metrics';
import { emitAuditLog } from './otel';
import { targetProject } from './project';
import { getAuditSettings } from './settings';
import { insertEvent } from './store';
import { recordAuditUsage } from '../usage/ledger';

export type { AuditEvent, AuditOutcome, AuditTarget } from '../../shared/audit';
export { auditRequestContext } from './context';

/** Who did it, when it isn't the request's principal: a user (sign-in, sign-out), the system or nobody. */
export type AuditActorInput = { id: string; name?: string; email?: string } | 'system' | 'anonymous';

export interface AuditInput {
  /** `<category>.<verb>` (see AUDIT_ACTIONS in lib/shared/audit.ts). */
  action: string;
  outcome?: AuditOutcome;
  target?: AuditTarget;
  /** One line for people; default: the action's label and the target's name. */
  summary?: string;
  /** Flat ids, names, counts and flags. Keys that look secret are dropped; values are clipped. */
  details?: Record<string, unknown>;
  /** The event's project; default: the target's (./project), null for none. */
  project?: string | null;
  actor?: AuditActorInput;
  /** The generic layer's request line (domain events take the method and route from the request context). */
  status?: number;
  at?: Date;
}

/** The audit log could not store a required event (fail-closed mode): the change was refused. */
export class AuditUnavailableError extends HttpError {
  constructor(options: { cause?: unknown } = {}) {
    super('The audit log is unavailable, so this change was not made', 503, { cause: options.cause });
  }
}

export interface AuditOptions {
  /** A high-value change: in fail-closed mode a storage failure throws `AuditUnavailableError` instead of being swallowed. */
  required?: boolean;
}

const requiredScope = () => singleton('audit-required-scope', () => ({ depth: 0 }));

/**
 * Run a database change and its audit events as one transaction in which every event is required: with
 * `LANDFLOW_AUDIT_FAIL_CLOSED` a storage failure throws `AuditUnavailableError` and the change rolls back with it.
 * Without the setting it is a plain transaction. `fn` is synchronous, as for `database().transaction()`.
 */
export function auditedTransaction<T>(fn: () => T): T {
  const scope = requiredScope();
  scope.depth++;
  try {
    return database().transaction(fn);
  } finally {
    scope.depth--;
  }
}

/**
 * A change that is not a database write (credentials in the files config store). Fail-closed: the event is recorded
 * first and a failure refuses the change. Otherwise the change runs and its event follows (`input` gets its result).
 */
export function auditedChange<T>(input: (result: T | undefined) => AuditInput, change: () => T): T {
  if (auditFailClosed()) {
    recordAudit(input(undefined), { required: true });
    return change();
  }
  const result = change();
  recordAudit(input(result));
  return result;
}

const MAX_TEXT = 500;
const MAX_LIST = 50;
/** A Landflow API key or MCP token, should one ever reach a detail value. */
const TOKEN = /\blf_[A-Za-z0-9_-]{16,}/g;

const counter = () => singleton('audit-id-counter', () => ({ n: 0 }));

/** A new event id that sorts by time: `aud_` + ms (base36) + a per-process counter + random. */
export function newAuditId(at = Date.now()): string {
  const state = counter();
  state.n = (state.n + 1) % 1_679_616;
  return `aud_${at.toString(36).padStart(9, '0')}${state.n.toString(36).padStart(4, '0')}${randomBytes(3).toString('hex')}`;
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text).replace(TOKEN, '[redacted]');

/**
 * Details as flat AuditValues: secret-looking keys go (a number or boolean under one stays, as in the logger and spans:
 * `{ credentials: 3 }` is a count, not a secret), nested objects become JSON text, strings and lists are clipped.
 */
export function cleanDetails(details: Record<string, unknown> | undefined): Record<string, AuditValue> | undefined {
  if (!details) return undefined;
  const out: Record<string, AuditValue> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (SECRET_KEY.test(key) && typeof value !== 'number' && typeof value !== 'boolean') continue;
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : String(value);
    else if (typeof value === 'string') out[key] = clip(value);
    else if (Array.isArray(value)) out[key] = value.slice(0, MAX_LIST).map((entry) => clip(typeof entry === 'string' ? entry : JSON.stringify(entry) ?? ''));
    else {
      try {
        out[key] = clip(JSON.stringify(value) ?? '');
      } catch {
        // Unserializable: left out.
      }
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function lookupUser(id: string): { name?: string; email?: string } | undefined {
  try {
    return getUser(id);
  } catch {
    return undefined; // Recording never throws.
  }
}

function actorOf(input: AuditActorInput | undefined, ctx = auditRequestContext()): { actor: AuditActor; apiKeyId?: string } {
  if (input === 'system') return { actor: { type: 'system' } };
  if (input === 'anonymous') return { actor: { type: 'anonymous' } };
  const principal = requestAuth()?.principal ?? ctx?.principal;
  if (input) {
    // A bare id (an MCP token's or the gateway's caller) gets the user's name and email, so the log shows who it was.
    const known = principal?.user.id === input.id ? principal.user : input.name === undefined && input.email === undefined ? lookupUser(input.id) : undefined;
    return { actor: { type: 'user', id: input.id, ...((input.name ?? known?.name) && { name: input.name ?? known?.name }), ...((input.email ?? known?.email) && { email: input.email ?? known?.email }) } };
  }
  if (principal) {
    const { user } = principal;
    return {
      actor: { type: principal.via === 'api-key' ? 'api_key' : 'user', id: user.id, name: user.name, email: user.email },
      ...(principal.apiKey && { apiKeyId: principal.apiKey.id }),
    };
  }
  return { actor: { type: ctx ? 'anonymous' : 'system' } };
}

/** Delivery is kicked by the outbox when it runs in this process (./outbox). */
const kick = () => singleton('audit-outbox-kick', () => ({ fn: undefined as undefined | (() => void) }));

export function setOutboxKick(fn: (() => void) | undefined) {
  kick().fn = fn;
}

/**
 * Record an audit event (see the module comment). Returns it, or undefined when it could not be stored. A `required`
 * event in fail-closed mode throws instead; call it inside the change's `database().transaction()` (the insert joins
 * it, so the throw rolls the change back) or before a change that is not a database write.
 */
export function recordAudit(input: AuditInput, options: AuditOptions = {}): AuditEvent | undefined {
  ensureListeners();
  const ctx = auditRequestContext();
  try {
    const at = input.at ?? new Date();
    const { actor, apiKeyId } = actorOf(input.actor, ctx);
    const label = AUDIT_ACTIONS[input.action] ?? input.action;
    const target = input.target && { type: input.target.type, ...(input.target.id && { id: clip(input.target.id) }), ...(input.target.name && { name: clip(input.target.name) }) };
    const details = cleanDetails(input.details);
    // The request's own resource was looked up before the handler ran (it may be gone now); anything else is looked up here.
    const projectId =
      input.project !== undefined
        ? (input.project ?? undefined)
        : ctx?.target && target?.type === ctx.target.type && target.id === ctx.target.id
          ? ctx.target.projectId
          : targetProject(target, input.details);
    const event: AuditEvent = {
      id: newAuditId(at.getTime()),
      at: at.toISOString(),
      action: input.action,
      category: input.action.split('.')[0] || 'other',
      outcome: input.outcome ?? 'success',
      actor,
      ...(apiKeyId && { apiKeyId }),
      ...(ctx?.ip && { ip: ctx.ip }),
      ...(ctx?.userAgent && { userAgent: ctx.userAgent }),
      ...(ctx?.requestId && { requestId: ctx.requestId }),
      ...(ctx && { method: ctx.method }),
      ...((ctx?.route ?? ctx?.path) && { route: ctx?.route ?? ctx?.path }),
      ...(input.status !== undefined && { status: input.status }),
      ...(target && { target }),
      ...(projectId && { projectId }),
      summary: clip(input.summary ?? (target?.name ? `${label}: ${target.name}` : label)),
      ...(details && { details }),
    };
    const queued = insertEvent(event);
    recordAuditUsage(event);
    if (ctx && input.action !== 'api.request') ctx.recorded++;
    emitAuditLog(event);
    if (queued) kick().fn?.();
    return event;
  } catch (error) {
    logger.error('could not record an audit event', { error, 'landflow.audit.action': input.action });
    recordAuditWriteFailure(input.action);
    if ((options.required ?? requiredScope().depth > 0) && auditFailClosed()) throw new AuditUnavailableError({ cause: error });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Credential use in runs
// ---------------------------------------------------------------------------

/** Credentials already recorded per execution (one event per execution, node and credential). */
const seen = () => singleton('audit-credential-use', () => new Map<string, Set<string>>());
const MAX_TRACKED_EXECUTIONS = 1_000;

/**
 * A run used a node's credentials (the runner calls this when the engine resolves them): one `credential.use` event
 * per execution, node and credential, with ids and names only. Returns `resolved` unchanged.
 */
export function auditCredentialUse<T extends Record<string, unknown>>(executionId: string, workflowId: string, node: Pick<WorkflowNode, 'id' | 'name' | 'type' | 'credentials'>, resolved: T): T {
  try {
    const used = Object.keys(resolved ?? {});
    if (!used.length || !node.credentials || !getAuditSettings().credentialUse) return resolved;
    const tracked = seen();
    let ids = tracked.get(executionId);
    if (!ids) {
      if (tracked.size >= MAX_TRACKED_EXECUTIONS) tracked.delete(tracked.keys().next().value!);
      ids = new Set();
      tracked.set(executionId, ids);
    }
    for (const name of used) {
      const ref = node.credentials[name];
      if (!ref?.id || ids.has(`${node.id}|${ref.id}`)) continue;
      ids.add(`${node.id}|${ref.id}`);
      recordAudit({
        action: 'credential.use',
        target: { type: 'credential', id: ref.id, ...(ref.name && { name: ref.name }) },
        summary: `Run ${executionId} used credential “${ref.name ?? ref.id}” in “${node.name}”`,
        details: { executionId, workflowId, nodeId: node.id, nodeName: node.name, nodeType: node.type, credentialType: name },
      });
    }
  } catch (error) {
    logger.warn('could not audit credential use', { error });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Publishing and plugins, from their own event sources
// ---------------------------------------------------------------------------

function workflowName(workflowId: string): string | undefined {
  try {
    return database().get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', workflowId)?.name;
  } catch {
    return undefined;
  }
}

/** A publish, rollback (an older version than the newest) or unpublish, from the newest publish timeline entry. */
function auditPublication(workflowId: string) {
  const entry = publishLog(workflowId, 1)[0];
  // Within a second of the change: a deleted workflow's timeline is gone, and an old entry isn't news.
  if (!entry || Date.now() - Date.parse(entry.at) > 5_000) return;
  const newest = Number(database().get<{ n: number | null }>('SELECT MAX(number) AS n FROM workflow_versions WHERE workflow_id = ?', workflowId)?.n ?? 0);
  const action = entry.action === 'unpublish' ? 'workflow.unpublish' : entry.versionNumber !== undefined && entry.versionNumber < newest ? 'workflow.rollback' : 'workflow.publish';
  const name = workflowName(workflowId);
  const version = entry.versionNumber !== undefined ? ` (version ${entry.versionNumber})` : '';
  recordAudit({
    action,
    target: { type: 'workflow', id: workflowId, ...(name && { name }) },
    summary: `${AUDIT_ACTIONS[action]}: ${name ?? workflowId}${version}`,
    ...(entry.by && entry.by !== 'migration' && !requestAuth()?.principal && { actor: { id: entry.by } }),
    details: { versionId: entry.versionId, versionNumber: entry.versionNumber, note: entry.note, publishedBy: entry.by },
  });
}

const listeners = () => singleton('audit-listeners', () => ({ started: false }));

/** Listen to the publish timeline and the plugin registry (bootstrap starts it; recordAudit makes sure). Idempotent. */
export function ensureListeners() {
  const state = listeners();
  if (state.started) return;
  state.started = true;
  onPublicationChanged((workflowId) => auditPublication(workflowId));
  registryAudit.subscribe((event) => {
    if (event.type === 'plugin.endpoint_added') {
      recordAudit({ action: 'plugin.endpoint_added', target: { type: 'plugin', id: event.pluginId }, summary: `${AUDIT_ACTIONS['plugin.endpoint_added']}: ${event.pluginId} at ${event.endpoint}`, details: { endpoint: event.endpoint, source: event.source, transport: event.transport } });
    } else {
      recordAudit({ action: 'plugin.updated', target: { type: 'plugin', id: event.pluginId }, summary: `${AUDIT_ACTIONS['plugin.updated']}: ${event.pluginId} ${event.from} to ${event.to}`, details: { endpoint: event.endpoint, from: event.from, to: event.to } });
    }
  });
  bus.subscribe((event) => {
    if (event.channel !== 'registry') return;
    const registry = event.event;
    if (registry.type === 'plugin.registered') {
      recordAudit({ action: 'plugin.register', target: { type: 'plugin', id: registry.pluginId }, summary: registry.message, details: { endpoint: registry.endpoint, source: registry.source } });
    } else if (registry.type === 'plugin.removed') {
      recordAudit({ action: 'plugin.remove', target: { type: 'plugin', id: registry.pluginId }, summary: registry.message });
    }
  });
}
