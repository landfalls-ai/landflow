/**
 * App webhook triggers (docs/protocol.md §12): plugin triggers with `triggerSource: "appWebhook"` that register their
 * own webhook with an external service (GitHub, Stripe…), like n8n's `webhookMethods`.
 *
 * When a workflow is published (lib/server/publish.ts), `reconcile()` brings the service in line with the published
 * version: for each app webhook trigger it asks the plugin `checkExists` and, when the hook is missing, `create`; a
 * trigger whose settings changed is deleted and created again; triggers that left the published version (and all of
 * them on unpublish or delete) are deleted. What the plugin stores (the hook id, a signing secret) is the node's
 * *static data*, kept per workflow and node in `node_static_data` with the registration the host made.
 *
 * The service calls `{publicUrl}/api/webhook/app/<workflowId>/<nodeId>`; the route hands the call to the plugin's
 * `webhook()` (which checks the signature) and starts a run of the published version with the items it returns.
 * Failed creates and deletes are retried every minute (a plugin that was offline, a service that was down).
 * Reconciles of one workflow never overlap.
 */
import { createHash } from 'node:crypto';
import { PROTOCOL_VERSION, type JsonObject, type WebhookMethodName, type WebhookMethodResponse } from '@landflow/protocol';
import { ExpressionResolver, type ResolvedNodeType, type Workflow, type WorkflowNode } from '@landflow/engine';
import type { AppWebhookStatus } from '../shared/publish';
import { freshCredentials } from './credentials/oauth2-runtime';
import { resolveWorkflowCredentials } from './projects/credentials';
import { database } from './db';
import { parse } from './db/rows';
import { registry } from './plugins/registry';
import { onPublicationChangedAnywhere } from './publications';
import { productionWorkflowById } from './publish';
import { publicUrl } from './runner';
import { parameterSecrets, rememberResolvedParameters } from './secrets/resolve';
import { singleton } from './singleton';
import { store } from './store';
import { logger } from './telemetry/logger';
import { variables } from './variables';
import { envInt } from './config';

const RETRY_INTERVAL_MS = envInt('LANDFLOW_APP_WEBHOOK_RETRY_MS', { fallback: 60_000, min: 1_000 });
const MAX_BACKOFF_MS = 60 * 60_000;
const ID = /^[\w-]+$/;

/** The node as it was registered: what `delete` needs once the node has changed or is gone. */
export interface RegisteredNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  parameters: JsonObject;
  credentials?: Record<string, { id: string; name: string }>;
}

/** What the host knows about a trigger's hook at its service. */
export interface Registration {
  node: RegisteredNode;
  /** Of the node's type, parameters, credentials and URL: a change re-registers. */
  configHash: string;
  webhookUrl: string;
  registeredAt?: string;
  /** The last create or delete failed: why, when, and how many times in a row (retried with backoff). */
  error?: string;
  failedAt?: string;
  attempts?: number;
  /** `delete` failed for a hook the published version no longer has: retried until it goes. */
  pendingDelete?: boolean;
}

interface Entry {
  workflowId: string;
  nodeId: string;
  data: JsonObject;
  registration?: Registration;
}

interface EntryRow {
  workflow_id: string;
  node_id: string;
  data: string;
  registration: string | null;
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const toEntry = (row: EntryRow): Entry => ({
  workflowId: row.workflow_id,
  nodeId: row.node_id,
  data: parse<JsonObject>(row.data) ?? {},
  ...(row.registration && { registration: parse<Registration>(row.registration) }),
});

function readEntry(workflowId: string, nodeId: string): Entry | undefined {
  const row = database().get<EntryRow>('SELECT workflow_id, node_id, data, registration FROM node_static_data WHERE workflow_id = ? AND node_id = ?', workflowId, nodeId);
  return row ? toEntry(row) : undefined;
}

function entriesOf(workflowId?: string): Entry[] {
  const db = database();
  const rows = workflowId
    ? db.all<EntryRow>('SELECT workflow_id, node_id, data, registration FROM node_static_data WHERE workflow_id = ?', workflowId)
    : db.all<EntryRow>('SELECT workflow_id, node_id, data, registration FROM node_static_data');
  return rows.map(toEntry);
}

function writeEntry(workflowId: string, nodeId: string, data: JsonObject, registration: Registration | undefined) {
  database().upsert('node_static_data', {
    workflow_id: workflowId,
    node_id: nodeId,
    data: JSON.stringify(data ?? {}),
    registration: registration ? JSON.stringify(registration) : null,
    updated_at: new Date().toISOString(),
  });
}

function removeEntry(workflowId: string, nodeId: string) {
  database().delete('node_static_data', { workflow_id: workflowId, node_id: nodeId });
}

/** A node's static data for a workflow (`{}` when it has none). */
export function getStaticData(workflowId: string, nodeId: string): JsonObject {
  return (ID.test(workflowId) && readEntry(workflowId, nodeId)?.data) || {};
}

/** Replace a node's static data, keeping its registration. */
export function setStaticData(workflowId: string, nodeId: string, data: JsonObject) {
  writeEntry(workflowId, nodeId, data, readEntry(workflowId, nodeId)?.registration);
}

// ---------------------------------------------------------------------------
// Calls into the plugin
// ---------------------------------------------------------------------------

/** Where the service sends a trigger's calls. */
export function appWebhookUrl(workflowId: string, nodeId: string): string {
  return `${publicUrl()}/api/webhook/app/${encodeURIComponent(workflowId)}/${encodeURIComponent(nodeId)}`;
}

export function isAppWebhookTrigger(resolved: ResolvedNodeType | { error: string }): resolved is ResolvedNodeType {
  return !('error' in resolved) && resolved.descriptor.kind === 'trigger' && resolved.descriptor.triggerSource === 'appWebhook';
}

function registeredNode(node: WorkflowNode): RegisteredNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion,
    parameters: structuredClone(node.parameters ?? {}) as JsonObject,
    ...(node.credentials && { credentials: structuredClone(node.credentials) }),
  };
}

function configHash(node: RegisteredNode, webhookUrl: string): string {
  const refs = Object.fromEntries(Object.entries(node.credentials ?? {}).map(([name, ref]) => [name, ref.id]));
  return createHash('sha256').update(JSON.stringify([node.type, node.typeVersion, node.parameters, refs, webhookUrl])).digest('hex').slice(0, 16);
}

/** The fields WebhookMethod and ReceiveWebhook share: parameters (expressions resolved, no items), credentials, URL, static data. */
export async function webhookBase(workflow: Pick<Workflow, 'id' | 'name'>, node: RegisteredNode | WorkflowNode, resolved: ResolvedNodeType, staticData: JsonObject, webhookUrl: string) {
  const skip = new Set(resolved.descriptor.properties.filter((p) => p.noDataExpression || p.type === 'code').map((p) => p.name));
  // $secrets in the trigger's parameters, when Settings → External secrets allows it.
  const secrets = await parameterSecrets(node.parameters, skip);
  const resolver = new ExpressionResolver({
    items: [],
    nodeOutputs: {},
    workflow: { id: workflow.id, name: workflow.name },
    execution: { id: `appwebhook_${node.id}`, mode: 'webhook' },
    parameters: node.parameters as JsonObject,
    variables: variables.forWorkflow(workflow.id),
    ...(secrets && { secrets }),
  });
  const parameters = resolver.resolveParameters(node.parameters as JsonObject, 0, skip) as JsonObject;
  if (secrets) rememberResolvedParameters(node.parameters, parameters, skip);
  const data = await freshCredentials(resolveWorkflowCredentials(workflow.id, node, resolved.descriptor));
  return {
    protocol: PROTOCOL_VERSION,
    workflowId: workflow.id,
    node: { id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion },
    parameters,
    ...(data && Object.keys(data).length > 0 && { credentials: data }),
    webhookUrl,
    staticData,
  };
}

async function callMethod(method: WebhookMethodName, workflow: Pick<Workflow, 'id' | 'name'>, node: RegisteredNode, staticData: JsonObject, webhookUrl: string): Promise<WebhookMethodResponse> {
  const resolved = registry.resolve(node.type);
  if ('error' in resolved) return { error: { message: resolved.error } };
  if (!resolved.webhookMethod) return { error: { message: `${node.type} has no webhook methods (is it an app webhook trigger?)` } };
  try {
    return await resolved.webhookMethod({ ...(await webhookBase(workflow, node, resolved, staticData, webhookUrl)), method });
  } catch (error) {
    return { error: { message: (error as Error).message } };
  }
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

type TriggerError = { nodeName: string; message: string };

/**
 * The app webhook triggers of a workflow's published version, and its enabled nodes whose plugin is unavailable
 * (their hooks are left alone until it is back: an offline plugin is no reason to delete them).
 */
function desiredTriggers(workflowId: string): { workflow?: Workflow; nodes: WorkflowNode[]; unresolved: Set<string> } {
  const workflow = productionWorkflowById(workflowId);
  const unresolved = new Set<string>();
  if (!workflow) return { nodes: [], unresolved };
  const nodes = workflow.nodes.filter((node) => {
    if (node.disabled) return false;
    const resolved = registry.resolve(node.type);
    if ('error' in resolved) unresolved.add(node.id);
    return isAppWebhookTrigger(resolved);
  });
  return { workflow, nodes, unresolved };
}

/** The registration after another failure. */
const failed = (registration: Registration, previous: Registration | undefined, error: string): Registration => ({
  ...registration,
  error,
  failedAt: new Date().toISOString(),
  attempts: (previous?.error ? (previous.attempts ?? 1) : 0) + 1,
});

/** Whether a failed registration is due for another try (one minute, doubling up to an hour). */
function due(registration: Registration, now = Date.now()): boolean {
  if (!registration.failedAt) return true;
  const wait = Math.min(MAX_BACKOFF_MS, RETRY_INTERVAL_MS * 2 ** Math.max(0, (registration.attempts ?? 1) - 1));
  return now - Date.parse(registration.failedAt) >= wait;
}

/** Remove a registered hook. Returns the error, if any (the entry then stays, marked for another try). */
async function unregister(workflow: Pick<Workflow, 'id' | 'name'>, entry: Entry, keepEntry: boolean): Promise<string | undefined> {
  const registration = entry.registration!;
  const response = await callMethod('delete', workflow, registration.node, entry.data, registration.webhookUrl);
  if (response.error) {
    const message = response.error.message;
    writeEntry(entry.workflowId, entry.nodeId, response.staticData ?? entry.data, { ...failed(registration, registration, message), pendingDelete: true });
    logger.warn('could not remove an app webhook', { 'landflow.workflow.id': entry.workflowId, 'landflow.node.name': registration.node.name, error: message });
    return message;
  }
  if (keepEntry) writeEntry(entry.workflowId, entry.nodeId, response.staticData ?? entry.data, undefined);
  else removeEntry(entry.workflowId, entry.nodeId);
  logger.info('app webhook removed', { 'landflow.workflow.id': entry.workflowId, 'landflow.node.name': registration.node.name });
  return undefined;
}

/** Make sure the service has the hook for this trigger: checkExists, else create. */
async function register(workflow: Workflow, node: WorkflowNode, entry: Entry | undefined): Promise<string | undefined> {
  const webhookUrl = appWebhookUrl(workflow.id, node.id);
  const snapshot = registeredNode(node);
  const hash = configHash(snapshot, webhookUrl);
  let data = entry?.data ?? {};
  const base: Registration = { node: snapshot, configHash: hash, webhookUrl };
  if (entry?.registration?.registeredAt && !entry.registration.pendingDelete) {
    const check = await callMethod('checkExists', workflow, snapshot, data, webhookUrl);
    if (check.staticData) data = check.staticData;
    if (check.exists === true && !check.error) {
      writeEntry(workflow.id, node.id, data, { ...base, registeredAt: entry.registration.registeredAt });
      return undefined;
    }
  }
  const created = await callMethod('create', workflow, snapshot, data, webhookUrl);
  if (created.staticData) data = created.staticData;
  if (created.error) {
    writeEntry(workflow.id, node.id, data, failed(base, entry?.registration, created.error.message));
    logger.warn('could not register an app webhook', { 'landflow.workflow.id': workflow.id, 'landflow.node.name': node.name, error: created.error.message });
    return created.error.message;
  }
  writeEntry(workflow.id, node.id, data, { ...base, registeredAt: new Date().toISOString() });
  logger.info('app webhook registered', { 'landflow.workflow.id': workflow.id, 'landflow.node.name': node.name, 'landflow.node.type': node.type });
  return undefined;
}

async function reconcileNow(workflowId: string): Promise<TriggerError[]> {
  const errors: TriggerError[] = [];
  const { workflow, nodes, unresolved } = desiredTriggers(workflowId);
  const saved = workflow ?? store.getWorkflow(workflowId);
  const named = { id: workflowId, name: saved?.name ?? workflowId };
  const wanted = new Map(nodes.map((node) => [node.id, node]));
  const entries = new Map(entriesOf(workflowId).map((entry) => [entry.nodeId, entry]));

  // Hooks the published version no longer has (or every hook, when nothing is published): delete them.
  for (const entry of entries.values()) {
    if (unresolved.has(entry.nodeId)) continue;
    const node = wanted.get(entry.nodeId);
    const registration = entry.registration;
    if (node && registration && !registration.pendingDelete && registration.configHash === configHash(registeredNode(node), appWebhookUrl(workflowId, node.id))) continue;
    if (!registration?.registeredAt && !registration?.pendingDelete) {
      // Never registered (a failed create): nothing to remove at the service.
      if (!node) removeEntry(workflowId, entry.nodeId);
      continue;
    }
    const message = await unregister(named, entry, Boolean(node));
    if (message) {
      errors.push({ nodeName: registration.node.name, message: `Could not remove the old webhook: ${message}` });
      // A changed trigger is registered again only once its old hook is gone (no duplicate deliveries).
      if (node) wanted.delete(node.id);
    }
  }

  // Hooks it should have.
  if (workflow) {
    for (const node of wanted.values()) {
      const message = await register(workflow, node, readEntry(workflowId, node.id));
      if (message) errors.push({ nodeName: node.name, message });
    }
  }
  return errors;
}

export const appWebhooks = singleton('app-webhooks', () => {
  /** The newest reconcile per workflow (its promise ends the chain). */
  const tails = new Map<string, Promise<unknown>>();
  /** A reconcile waiting for the one before it: callers until it starts share it. */
  const queued = new Map<string, Promise<TriggerError[]>>();
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  function reconcile(workflowId: string): Promise<TriggerError[]> {
    if (!ID.test(workflowId)) return Promise.resolve([]);
    const pending = queued.get(workflowId);
    if (pending) return pending;
    // Starts on a later turn of the event loop, so callers in the same turn (a publish and its listener) share one run.
    const run = (tails.get(workflowId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => new Promise((resolve) => setImmediate(resolve)))
      .then(() => {
        queued.delete(workflowId);
        return reconcileNow(workflowId);
      });
    queued.set(workflowId, run);
    const tail = run.catch(() => undefined);
    tails.set(workflowId, tail);
    void tail.then(() => {
      if (tails.get(workflowId) === tail) tails.delete(workflowId);
    });
    return run;
  }

  /** Workflows with a hook to retry: a failed create or delete (when due), or a published trigger not registered yet. */
  function retryable(): Set<string> {
    const ids = new Set<string>();
    for (const entry of entriesOf()) if ((entry.registration?.error || entry.registration?.pendingDelete) && due(entry.registration)) ids.add(entry.workflowId);
    for (const workflow of store.listWorkflows()) {
      if (!workflow.active || ids.has(workflow.id)) continue;
      const { nodes } = desiredTriggers(workflow.id);
      if (nodes.some((node) => !readEntry(workflow.id, node.id)?.registration)) ids.add(workflow.id);
    }
    return ids;
  }

  return {
    reconcile,

    /** Resolves once no reconcile of the workflow is running (an incoming call waits for the secret its create stores). */
    async settled(workflowId: string, timeoutMs = 10_000): Promise<void> {
      const tail = tails.get(workflowId);
      if (!tail) return;
      await Promise.race([tail, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.())]);
    },

    /** Where each app webhook trigger of the published version stands (plus hooks still waiting to be removed). */
    status(workflowId: string): AppWebhookStatus[] {
      if (!ID.test(workflowId)) return [];
      const { nodes, unresolved } = desiredTriggers(workflowId);
      const entries = new Map(entriesOf(workflowId).map((entry) => [entry.nodeId, entry]));
      const statuses: AppWebhookStatus[] = nodes.map((node) => {
        const registration = entries.get(node.id)?.registration;
        return {
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          webhookUrl: appWebhookUrl(workflowId, node.id),
          registered: Boolean(registration?.registeredAt && !registration.pendingDelete),
          ...(registration?.registeredAt && { registeredAt: registration.registeredAt }),
          ...(registration?.error && { error: registration.error }),
        };
      });
      for (const entry of entries.values()) {
        const registration = entry.registration;
        if (registration && unresolved.has(entry.nodeId)) {
          statuses.push({
            nodeId: entry.nodeId,
            nodeName: registration.node.name,
            nodeType: registration.node.type,
            webhookUrl: registration.webhookUrl,
            registered: Boolean(registration.registeredAt),
            ...(registration.registeredAt && { registeredAt: registration.registeredAt }),
            error: 'Its plugin is offline: calls fail until it is back',
          });
          continue;
        }
        if (!registration?.pendingDelete || nodes.some((node) => node.id === entry.nodeId)) continue;
        statuses.push({
          nodeId: entry.nodeId,
          nodeName: registration.node.name,
          nodeType: registration.node.type,
          webhookUrl: registration.webhookUrl,
          registered: true,
          ...(registration.registeredAt && { registeredAt: registration.registeredAt }),
          error: `Not removed yet: ${registration.error ?? 'pending'}`,
        });
      }
      return statuses;
    },

    /** At boot: check every published workflow's hooks, follow publication changes, retry failures every minute. */
    start() {
      if (timer) return;
      unsubscribe = onPublicationChangedAnywhere((workflowId) => void reconcile(workflowId));
      const ids = new Set([...store.listWorkflows().filter((w) => w.active).map((w) => w.id), ...entriesOf().map((e) => e.workflowId)]);
      for (const id of ids) {
        if (desiredTriggers(id).nodes.length || entriesOf(id).length) void reconcile(id);
      }
      timer = setInterval(() => {
        for (const id of retryable()) if (!queued.has(id)) void reconcile(id);
      }, RETRY_INTERVAL_MS);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
});
