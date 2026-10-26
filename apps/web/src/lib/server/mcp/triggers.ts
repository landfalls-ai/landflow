/**
 * Triggers as MCP resources (docs/transports.md "From node to tool", docs/protocol.md §15.9): the poll triggers and app
 * webhook triggers of a plugin are resource templates on its endpoint, `landflow://triggers/<plugin>/<trigger>{?parameters}`
 * (the mapping is `mcpTriggersFromDescriptors()` in `@landflow/protocol`). A client builds a URI from a template and
 *
 * - **subscribes** (2026-07-28: `subscriptions/listen` with the URI in `resourceSubscriptions`; the stream is the
 *   subscription, and the SDK has no other seam). The host starts the trigger for that subscription with the credential
 *   bound like a tool call's (the grant's, else the caller's newest visible one): a poll loop at the node's interval, or the
 *   webhook the plugin registers with its service (`webhookMethod` create/delete, like a published workflow's), keeps the
 *   newest events (LANDFLOW_MCP_TRIGGER_BUFFER, default 50) and sends `notifications/resources/updated` on the stream;
 * - **reads** it (`resources/read`): the buffered events as JSON, files as `files` entries shaped like `resource_link`s
 *   (a read result can't carry content blocks), signed by the same helper as tool results. Without a subscription a poll
 *   trigger answers one poll in `manual` mode (the node shows recent events without consuming them), which is what a 2025-era
 *   client gets: its stateless endpoint has no stream to notify on, so it does not offer `subscribe`. An app webhook trigger
 *   has nothing to read before a client subscribes, and says so.
 *
 * **Stops**: the last stream of a subscription ending (the client left or unsubscribed, the connection dropped), no read for
 * LANDFLOW_MCP_TRIGGER_IDLE_SECONDS (default 3600), the grant, the governance rule or the MCP token going away (checked every
 * poll, at least every 30 s), and a process that died (its rows stop being pulsed; the sweep deregisters their webhooks within
 * two minutes). Nothing runs for a stopped subscription; its events stay readable LANDFLOW_MCP_TRIGGER_RETAIN_SECONDS (default 600).
 *
 * **Governance**: subscribing is a read-only call: a grant must cover `trigger_<node>` (or `*`), the node type must not be blocked,
 * the audit log gets `mcp.resource.subscribe` and `mcp.resource.unsubscribe` (caller, trigger, reason; never parameter values).
 *
 * **Queue mode**: the subscription runs on the main that holds the stream (its poll loop and webhook registration are
 * in-memory timers, with a row in `mcp_trigger_subs` that main pulses). The events and the row are in the database, so a
 * `resources/read` on any main sees them, and a webhook the service sends to another main is received there (the route hands it to
 * `receiveTriggerWebhook`), stored, and noticed by the holding main within a second, which sends the notification. A main that dies
 * leaves a row nobody pulses; the leader's sweep removes it and the webhook. A stream that reconnects to another main starts a
 * subscription there (the first poll is a new baseline).
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { PROTOCOL_VERSION, withPropertyDefaults, parseTriggerResourceUri, triggerQueryToParameters, MCP_TOOL_META_KEY, type ExecuteRequest, type JsonObject, type McpTriggerDefinition, type NodeItem, type WebhookMethodName, type WebhookMethodResponse } from '@landflow/protocol';
import type { ResolvedNodeType } from '@landflow/engine';
import { recordAudit } from '../audit';
import { deleteExecutionBinary } from '../binary/access';
import { credentials } from '../credentials/vault';
import { freshCredentials } from '../credentials/oauth2-runtime';
import { registry } from '../plugins/registry';
import { publicUrl } from '../runner';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { bindCredentials, callerLabel, type BoundCredentials } from './bind';
import { mcpDb } from './db';
import { fileBlocks } from './files';
import { pluginTriggers } from './grants';
import { callableTrigger, type McpCaller } from './identity';
import { getMcpToken, isDeadMcpToken } from './tokens';
import { notifyResourceUpdated } from './server';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const numberEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name] !== '' && process.env[name] !== undefined ? value : fallback;
};
/** Events kept per subscription. */
export const triggerBufferSize = () => Math.max(1, Math.floor(numberEnv('LANDFLOW_MCP_TRIGGER_BUFFER', 50)));
/** A subscription nobody reads for this long stops (seconds). */
export const triggerIdleMs = () => numberEnv('LANDFLOW_MCP_TRIGGER_IDLE_SECONDS', 3600) * 1000;
/** How long a stopped subscription's events stay readable (seconds). */
export const triggerRetainMs = () => numberEnv('LANDFLOW_MCP_TRIGGER_RETAIN_SECONDS', 600) * 1000;
/** The shortest poll interval (the host's own poller uses 10 s). */
export const triggerMinIntervalMs = () => Math.max(100, numberEnv('LANDFLOW_MCP_TRIGGER_MIN_INTERVAL_SECONDS', 10) * 1000);
/** How often the owning main pulses its rows, and how long without a pulse makes a row an orphan. */
const heartbeatMs = () => numberEnv('LANDFLOW_MCP_TRIGGER_HEARTBEAT_SECONDS', 30) * 1000;
const orphanAfterMs = () => heartbeatMs() * 4;
const sweepEveryMs = () => numberEnv('LANDFLOW_MCP_TRIGGER_SWEEP_SECONDS', 60) * 1000;
const WATCH_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;
/** The id of the one node a subscription runs. */
const NODE_ID = 'trigger';
/** App webhook URLs of subscriptions use this pseudo workflow id: `mcpsub_<sub key>` (the route hands them to {@link receiveTriggerWebhook}). */
export const TRIGGER_WEBHOOK_PREFIX = 'mcpsub_';

export class McpTriggerError extends Error {
  constructor(
    message: string,
    /** JSON-RPC style: invalid params, or a denial. */
    readonly kind: 'invalid' | 'denied' | 'unavailable' = 'invalid',
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The node as registered: what `create` and `delete` of a webhook (and every poll) need. */
interface StoredNode {
  type: string;
  typeVersion: number;
  name: string;
  parameters: JsonObject;
  credentials: Record<string, { id: string; name: string }>;
}

interface SubRow {
  sub_key: string;
  plugin_id: string;
  trigger: string;
  uri: string;
  user_key: string;
  kind: string;
  node: string;
  static_data: string;
  poll_state: string | null;
  ready: number | bigint;
  registered: number | bigint;
  stopping: number | bigint;
  owner: string | null;
  polls: number | bigint;
  last_polled_at: string | null;
  last_error: string | null;
  attempts: number | bigint;
  read_at: string | null;
  heartbeat_at: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  sub_key: string;
  id: string;
  at: string;
  item: string;
}

const getRow = (key: string) => mcpDb().get<SubRow>('SELECT * FROM mcp_trigger_subs WHERE sub_key = ?', key);
const nodeOf = (row: SubRow) => JSON.parse(row.node) as StoredNode;
const staticOf = (row: SubRow) => JSON.parse(row.static_data) as JsonObject;

/** Read, change and write one row in a transaction (the DB layer has no UPDATE). */
function changeRow(key: string, change: (row: SubRow) => Partial<SubRow>): SubRow | undefined {
  return mcpDb().transaction(() => {
    const row = getRow(key);
    if (!row) return undefined;
    const next = { ...row, ...change(row), updated_at: new Date().toISOString() } as SubRow;
    mcpDb().upsert('mcp_trigger_subs', { ...next });
    return next;
  });
}

function removeSub(key: string) {
  const db = mcpDb();
  const scopes = new Set(db.all<EventRow>('SELECT * FROM mcp_trigger_events WHERE sub_key = ?', key).flatMap((e) => scopesOf(e.item)));
  db.transaction(() => {
    for (const e of db.all<EventRow>('SELECT * FROM mcp_trigger_events WHERE sub_key = ?', key)) db.delete('mcp_trigger_events', { sub_key: key, id: e.id });
    db.delete('mcp_trigger_subs', { sub_key: key });
  });
  for (const scope of scopes) void deleteExecutionBinary(scope);
}

/** The binary scopes (the polls' execution ids) an event's files are in. */
function scopesOf(itemJson: string): string[] {
  try {
    const item = JSON.parse(itemJson) as NodeItem;
    return Object.values(item.binary ?? {}).flatMap((ref) => (ref?.id ? [ref.id.split('.')[0]] : []));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Live state (this process)
// ---------------------------------------------------------------------------

interface Holder {
  endpointKey: string;
  uri: string;
}

interface Live {
  key: string;
  pluginId: string;
  trigger: McpTriggerDefinition;
  caller: McpCaller;
  holders: Map<string, Holder>;
  timer?: ReturnType<typeof setTimeout>;
  polling: boolean;
  stopped: boolean;
  /** The newest event id this process has notified about. */
  seen: string;
  lastCheckAt: number;
}

const state = () =>
  singleton('mcp-trigger-subs', () => ({
    subs: new Map<string, Live>(),
    heartbeat: undefined as undefined | ReturnType<typeof setInterval>,
    watch: undefined as undefined | ReturnType<typeof setInterval>,
    sweep: undefined as undefined | ReturnType<typeof setInterval>,
    instance: `mcp_${nanoid(8)}`,
  }));

const userKeyOf = (caller: McpCaller) => (caller.userId ? `u:${caller.userId}` : `${caller.kind}:${caller.subject}`);

/** One subscription per (caller, plugin, trigger, parameters). */
export function subscriptionKey(caller: McpCaller, pluginId: string, uri: string): string {
  const parsed = parseTriggerResourceUri(uri);
  const canonical = parsed ? JSON.stringify([parsed.name, Object.entries(parsed.query).sort(([a], [b]) => (a < b ? -1 : 1))]) : uri;
  return createHash('sha256').update(`${userKeyOf(caller)}\n${pluginId}\n${canonical}`).digest('hex').slice(0, 20);
}

const pseudoWorkflowId = (key: string) => `${TRIGGER_WEBHOOK_PREFIX}${key}`;
const webhookUrlOf = (key: string) => `${publicUrl()}/api/webhook/app/${pseudoWorkflowId(key)}/${NODE_ID}`;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function audit(action: 'mcp.resource.subscribe' | 'mcp.resource.unsubscribe' | 'mcp.resource.read', pluginId: string, caller: McpCaller | undefined, trigger: string, outcome: 'success' | 'failure' | 'denied', details: Record<string, unknown> = {}) {
  try {
    const plugin = registry.list().find((p) => p.id === pluginId);
    recordAudit({
      action,
      outcome,
      target: { type: 'plugin', id: pluginId, name: plugin?.info.name ?? pluginId },
      summary: `${action === 'mcp.resource.subscribe' ? 'Subscribed to' : action === 'mcp.resource.unsubscribe' ? 'Unsubscribed from' : 'Read'} MCP trigger ${trigger} of ${plugin?.info.name ?? pluginId}${outcome === 'denied' ? ' (refused)' : ''}`,
      details: { trigger, ...(caller && { caller: callerLabel(caller), callerKind: caller.kind, viaGateway: caller.viaGateway, ...(caller.tokenId && { tokenId: caller.tokenId }) }), ...details },
      actor: caller?.userId ? { id: caller.userId } : 'anonymous',
      project: null,
    });
  } catch (error) {
    logger.warn('mcp trigger audit failed', { error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Resolving a URI
// ---------------------------------------------------------------------------

interface Resolved {
  trigger: McpTriggerDefinition;
  node: ResolvedNodeType;
  parameters: JsonObject;
  uri: string;
  granted: Record<string, string>;
}

/** The trigger a URI names, for `caller`: it must exist, be allowed by a grant, and its plugin must be up. */
function resolveUri(caller: McpCaller, pluginId: string, uri: string): Resolved {
  const parsed = parseTriggerResourceUri(uri);
  if (!parsed || parsed.pluginId !== pluginId) throw new McpTriggerError(`Unknown resource ${uri}`);
  const trigger = pluginTriggers(pluginId).find((t) => t.name === parsed.name);
  if (!trigger) throw new McpTriggerError(`Unknown trigger "${parsed.name}" on ${pluginId}`);
  const callable = callableTrigger(caller, pluginId, trigger.name);
  if (!callable) throw new McpTriggerError(`${callerLabel(caller)} has no grant for ${trigger.name}`, 'denied');
  const { parameters, errors } = triggerQueryToParameters(trigger, parsed.query);
  if (errors.length) throw new McpTriggerError(`Invalid parameters in ${uri}: ${errors.join('; ')}`);
  const binding = trigger._meta[MCP_TOOL_META_KEY];
  const node = registry.resolve(binding.nodeType);
  if ('error' in node) throw new McpTriggerError(node.error, 'unavailable');
  return { trigger, node, parameters, uri, granted: callable.credentials };
}

interface Prepared extends Resolved {
  bound: BoundCredentials;
  stored: StoredNode;
}

/** Bind credentials and complete the parameters; throws when a required credential is missing. */
function prepare(caller: McpCaller, pluginId: string, resolved: Resolved): Prepared {
  const binding = resolved.trigger._meta[MCP_TOOL_META_KEY];
  const bound = bindCredentials(caller, pluginId, binding, resolved.granted, undefined);
  if (bound.error) throw new McpTriggerError(bound.error, 'denied');
  const parameters = withPropertyDefaults(resolved.node.descriptor.properties, { ...resolved.parameters, ...bound.parameters }) as JsonObject;
  try {
    credentials.resolveFor({ type: binding.nodeType, credentials: bound.credentials, parameters }, resolved.node.descriptor);
  } catch (error) {
    throw new McpTriggerError(`${(error as Error).message}. Ask for a grant that names a credential, or add one the caller may use`, 'denied');
  }
  return {
    ...resolved,
    bound,
    parameters,
    stored: { type: binding.nodeType, typeVersion: binding.typeVersion, name: resolved.trigger.title, parameters, credentials: bound.credentials },
  };
}

/** Parameters, fresh credentials and the base of a request for a stored node. */
async function nodeContext(stored: StoredNode, resolved: ResolvedNodeType) {
  const data = credentials.resolveFor({ type: stored.type, credentials: stored.credentials, parameters: stored.parameters }, resolved.descriptor, true);
  const fresh = await freshCredentials(data);
  return {
    node: { id: NODE_ID, name: stored.name, type: stored.type, typeVersion: stored.typeVersion },
    parameters: stored.parameters,
    ...(fresh && Object.keys(fresh).length > 0 && { credentials: fresh }),
  };
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

function intervalMs(row: SubRow, binding: { pollInterval?: number }): number {
  const configured = Number(nodeOf(row).parameters.pollInterval ?? binding.pollInterval ?? 60);
  return Math.max(triggerMinIntervalMs(), (Number.isFinite(configured) ? configured : 60) * 1000);
}

function appendEvents(key: string, items: NodeItem[]): string | undefined {
  if (!items.length) return undefined;
  const db = mcpDb();
  const base = Date.now();
  let last: string | undefined;
  const dropped: string[] = [];
  db.transaction(() => {
    items.forEach((item, i) => {
      const id = `${(base + i).toString(36).padStart(9, '0')}${nanoid(4)}`;
      db.upsert('mcp_trigger_events', { sub_key: key, id, at: new Date(base).toISOString(), item: JSON.stringify(item) });
      last = id;
    });
    const all = db.all<EventRow>('SELECT * FROM mcp_trigger_events WHERE sub_key = ? ORDER BY id DESC', key);
    for (const old of all.slice(triggerBufferSize())) {
      dropped.push(...scopesOf(old.item));
      db.delete('mcp_trigger_events', { sub_key: key, id: old.id });
    }
  });
  const keep = new Set(db.all<EventRow>('SELECT * FROM mcp_trigger_events WHERE sub_key = ?', key).flatMap((e) => scopesOf(e.item)));
  for (const scope of new Set(dropped)) if (!keep.has(scope)) void deleteExecutionBinary(scope);
  return last;
}

/** Tell this process's streams that listen for the subscription that it has news. */
function notifyHolders(live: Live, newest: string | undefined) {
  if (newest && newest > live.seen) live.seen = newest;
  for (const holder of live.holders.values()) notifyResourceUpdated(holder.endpointKey, holder.uri);
}

async function pollOnce(live: Live): Promise<void> {
  const row = getRow(live.key);
  if (!row) return;
  const stored = nodeOf(row);
  const resolved = registry.resolve(stored.type);
  const fail = (message: string) => {
    changeRow(live.key, () => ({ last_error: message, last_polled_at: new Date().toISOString() }));
    logger.warn('mcp trigger poll failed', { 'landflow.plugin.id': live.pluginId, 'mcp.trigger': live.trigger.name, error: message });
  };
  if ('error' in resolved) return fail(resolved.error);
  const baseline = !Number(row.ready);
  const executionId = `mcpsub_${nanoid(10)}`;
  try {
    const context = await nodeContext(stored, resolved);
    const request: ExecuteRequest = {
      protocol: PROTOCOL_VERSION,
      executionId,
      mode: 'poll',
      ...context,
      itemParameters: [],
      inputs: [],
      ...(row.poll_state && !baseline && { pollState: JSON.parse(row.poll_state) as JsonObject }),
    };
    const response = await resolved.execute(request, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (response.error) return fail(response.error.message);
    // The baseline poll never reports events, even if the node returned some (as the host's own poller).
    const items = baseline ? [] : (response.outputs[0] ?? []);
    if (live.stopped) return;
    const newest = appendEvents(live.key, items);
    changeRow(live.key, (r) => ({ ready: 1, polls: Number(r.polls) + 1, last_polled_at: new Date().toISOString(), last_error: null, ...(response.pollState && { poll_state: JSON.stringify(response.pollState) }) }));
    if (baseline || !items.length) void deleteExecutionBinary(executionId);
    if (newest) notifyHolders(live, newest);
  } catch (error) {
    fail((error as Error).message);
  }
}

/** Why `live` must stop now, if it must: the grant, the token, idleness. */
function stopReason(live: Live, row: SubRow | undefined): string | undefined {
  if (!row) return 'its row is gone';
  if (!callableTrigger(live.caller, live.pluginId, live.trigger.name)) return 'the grant no longer allows it';
  if (live.caller.tokenId) {
    const token = getMcpToken(live.caller.tokenId);
    if (!token || isDeadMcpToken(token)) return 'the MCP token was revoked or expired';
  }
  const idle = triggerIdleMs();
  const readAt = Math.max(row.read_at ? Date.parse(row.read_at) : 0, Date.parse(row.created_at));
  if (idle > 0 && Date.now() - readAt > idle) return 'idle: nobody read it';
  return undefined;
}

function schedulePoll(live: Live, delayMs: number) {
  if (live.stopped) return;
  clearTimeout(live.timer);
  live.timer = setTimeout(() => void tick(live), delayMs);
  live.timer.unref?.();
}

async function tick(live: Live): Promise<void> {
  if (live.stopped || live.polling) return;
  const row = getRow(live.key);
  const reason = stopReason(live, row);
  if (reason) {
    await deactivate(live, reason);
    return;
  }
  live.polling = true;
  try {
    await pollOnce(live);
  } finally {
    live.polling = false;
  }
  const after = getRow(live.key);
  if (after && !live.stopped) schedulePoll(live, intervalMs(after, live.trigger._meta[MCP_TOOL_META_KEY]));
}

// ---------------------------------------------------------------------------
// App webhooks
// ---------------------------------------------------------------------------

async function webhookMethod(row: SubRow, method: WebhookMethodName): Promise<WebhookMethodResponse> {
  const stored = nodeOf(row);
  const resolved = registry.resolve(stored.type);
  if ('error' in resolved) return { error: { message: resolved.error } };
  if (!resolved.webhookMethod) return { error: { message: `${stored.type} has no webhook methods (is it an app webhook trigger?)` } };
  try {
    const context = await nodeContext(stored, resolved);
    return await resolved.webhookMethod({ protocol: PROTOCOL_VERSION, method, workflowId: pseudoWorkflowId(row.sub_key), ...context, webhookUrl: webhookUrlOf(row.sub_key), staticData: staticOf(row) });
  } catch (error) {
    return { error: { message: (error as Error).message } };
  }
}

/** Register the subscription's hook at its service. Returns the error message, if any. */
async function registerHook(key: string): Promise<string | undefined> {
  const row = getRow(key);
  if (!row) return 'the subscription is gone';
  const created = await webhookMethod(row, 'create');
  if (created.error) {
    changeRow(key, () => ({ last_error: created.error!.message, ...(created.staticData && { static_data: JSON.stringify(created.staticData) }) }));
    return created.error.message;
  }
  changeRow(key, () => ({ registered: 1, last_error: null, ...(created.staticData && { static_data: JSON.stringify(created.staticData) }) }));
  return undefined;
}

/** Remove the subscription's hook. Returns the error message, if any (the row stays for the sweep to retry). */
async function removeHook(key: string): Promise<string | undefined> {
  const row = getRow(key);
  if (!row || !Number(row.registered)) return undefined;
  const response = await webhookMethod(row, 'delete');
  if (response.error) {
    changeRow(key, (r) => ({ last_error: `Could not remove the webhook: ${response.error!.message}`, attempts: Number(r.attempts) + 1, stopping: 1 }));
    logger.warn('could not remove an MCP trigger webhook', { 'mcp.trigger': row.trigger, error: response.error.message });
    return response.error.message;
  }
  changeRow(key, () => ({ registered: 0, ...(response.staticData && { static_data: JSON.stringify(response.staticData) }) }));
  return undefined;
}

/**
 * A call the service made to a subscription's webhook (the route at /api/webhook/app/mcpsub_<key>/trigger, any main): the
 * plugin's `webhook()` checks the signature and turns the call into items, which become events; the holding main notices them.
 */
export async function receiveTriggerWebhook(key: string, request: Request): Promise<Response> {
  const row = getRow(key);
  if (!row || row.kind !== 'appWebhook' || !Number(row.registered) || Number(row.stopping)) return Response.json({ error: 'No MCP subscription has a webhook here' }, { status: 404 });
  const stored = nodeOf(row);
  const resolved = registry.resolve(stored.type);
  if ('error' in resolved || !resolved.webhook) return Response.json({ error: 'error' in resolved ? resolved.error : `${stored.type} is not an app webhook trigger` }, { status: 503 });
  const raw = Buffer.from(await request.arrayBuffer());
  const url = new URL(request.url);
  const context = await nodeContext(stored, resolved);
  const result = await resolved.webhook({
    protocol: PROTOCOL_VERSION,
    workflowId: pseudoWorkflowId(key),
    ...context,
    webhookUrl: webhookUrlOf(key),
    staticData: staticOf(row),
    request: {
      method: request.method.toUpperCase(),
      path: url.pathname,
      headers: Object.fromEntries([...request.headers].filter(([name]) => name !== 'cookie')),
      query: Object.fromEntries(url.searchParams),
      body: raw.toString('base64'),
    },
  });
  if (result.staticData) changeRow(key, () => ({ static_data: JSON.stringify(result.staticData) }));
  const reply = (fallback: Response) => (result.response ? new Response(result.response.body ?? null, { status: result.response.status ?? 200, headers: result.response.headers ?? {} }) : fallback);
  if (result.error) {
    changeRow(key, () => ({ last_error: result.error!.message }));
    return reply(Response.json({ error: result.error.message }, { status: 500 }));
  }
  const items = result.items ?? [];
  if (!items.length) return reply(Response.json({ status: 'ignored' }));
  const newest = appendEvents(key, items);
  const live = state().subs.get(key);
  if (live) notifyHolders(live, newest);
  return reply(Response.json({ status: 'received', events: items.length }));
}

// ---------------------------------------------------------------------------
// Subscribe, release, stop
// ---------------------------------------------------------------------------

/** Take `holder` into the subscription for `uri`, starting the trigger when it is the first. */
async function acquire(caller: McpCaller, pluginId: string, uri: string, holderId: string, endpointKey: string): Promise<void> {
  const resolved = resolveUri(caller, pluginId, uri);
  const key = subscriptionKey(caller, pluginId, uri);
  const s = state();
  const existing = s.subs.get(key);
  if (existing && !existing.stopped) {
    existing.holders.set(holderId, { endpointKey, uri });
    return;
  }
  const prepared = prepare(caller, pluginId, resolved);
  const binding = resolved.trigger._meta[MCP_TOOL_META_KEY];
  const now = new Date().toISOString();
  const previous = getRow(key);
  const revived = previous && Number(previous.stopping);
  // A revived subscription keeps its events and poll state; its node is refreshed (the credential may have changed).
  mcpDb().upsert('mcp_trigger_subs', {
    sub_key: key,
    plugin_id: pluginId,
    trigger: resolved.trigger.name,
    uri: canonicalUri(uri),
    user_key: userKeyOf(caller),
    kind: binding.triggerSource,
    node: JSON.stringify(prepared.stored),
    static_data: previous?.static_data ?? '{}',
    poll_state: previous?.poll_state ?? null,
    ready: previous?.ready ?? 0,
    registered: binding.triggerSource === 'appWebhook' ? Number(previous?.registered ?? 0) : 0,
    stopping: 0,
    owner: s.instance,
    polls: previous?.polls ?? 0,
    last_polled_at: previous?.last_polled_at ?? null,
    last_error: null,
    attempts: 0,
    read_at: now,
    heartbeat_at: now,
    created_at: revived ? (previous?.created_at ?? now) : now,
    updated_at: now,
  });
  const live: Live = { key, pluginId, trigger: resolved.trigger, caller, holders: new Map([[holderId, { endpointKey, uri }]]), polling: false, stopped: false, seen: newestEventId(key) ?? '', lastCheckAt: Date.now() };
  s.subs.set(key, live);
  startMaintenance();
  if (binding.triggerSource === 'appWebhook') {
    const error = await registerHook(key);
    if (error) {
      s.subs.delete(key);
      live.stopped = true;
      removeSubIfEmpty(key);
      throw new McpTriggerError(`Could not register the webhook at the service: ${error}`, 'unavailable');
    }
  } else {
    schedulePoll(live, 0);
  }
}

const canonicalUri = (uri: string) => {
  const parsed = parseTriggerResourceUri(uri);
  if (!parsed) return uri;
  const query = new URLSearchParams(Object.entries(parsed.query).sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${uri.split('?')[0]}${query.size ? `?${query}` : ''}`;
};

function newestEventId(key: string): string | undefined {
  return mcpDb().get<{ id: string | null }>('SELECT MAX(id) AS id FROM mcp_trigger_events WHERE sub_key = ?', key)?.id ?? undefined;
}

/** A failed first registration leaves nothing behind. */
function removeSubIfEmpty(key: string) {
  const row = getRow(key);
  if (row && !Number(row.registered) && !newestEventId(key)) removeSub(key);
}

/** Stop what runs for a subscription and keep its row (and events) for a while; the hook is removed. */
async function deactivate(live: Live, reason: string): Promise<void> {
  if (live.stopped) return;
  live.stopped = true;
  clearTimeout(live.timer);
  state().subs.delete(live.key);
  changeRow(live.key, () => ({ stopping: 1, owner: null }));
  const error = await removeHook(live.key);
  audit('mcp.resource.unsubscribe', live.pluginId, live.caller, live.trigger.name, error ? 'failure' : 'success', { reason, ...(error && { error }) });
  // Streams still listening (the reason was not theirs leaving) hear that the resource changed: a read says why it stopped.
  for (const holder of live.holders.values()) notifyResourceUpdated(holder.endpointKey, holder.uri);
  live.holders.clear();
}

/**
 * Subscribe `caller` to the trigger resources `uris` of `pluginId` for one `subscriptions/listen` stream. Resolves to
 * `release` (stream ended), or throws `McpTriggerError` (nothing is left running from this call).
 */
export async function openTriggerSubscriptions(input: { caller: McpCaller; pluginId: string; uris: string[]; endpointKey: string }): Promise<{ release: () => void }> {
  const { caller, pluginId, endpointKey } = input;
  const holderId = `h_${nanoid(8)}`;
  const done: string[] = [];
  const release = () => {
    for (const uri of done.splice(0)) {
      const live = state().subs.get(subscriptionKey(caller, pluginId, uri));
      if (!live) continue;
      live.holders.delete(holderId);
      if (!live.holders.size) void deactivate(live, 'unsubscribed: the last stream ended');
    }
  };
  for (const uri of new Set(input.uris)) {
    try {
      await acquire(caller, pluginId, uri, holderId, endpointKey);
      done.push(uri);
      audit('mcp.resource.subscribe', pluginId, caller, parseTriggerResourceUri(uri)?.name ?? uri, 'success', { uri: uri.split('?')[0] });
    } catch (error) {
      release();
      const denied = error instanceof McpTriggerError && error.kind === 'denied';
      audit('mcp.resource.subscribe', pluginId, caller, parseTriggerResourceUri(uri)?.name ?? uri, denied ? 'denied' : 'failure', { reason: (error as Error).message, uri: uri.split('?')[0] });
      throw error;
    }
  }
  return { release };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface TriggerEvent {
  id: string;
  at: string;
  data: JsonObject;
  /** Files of the event, shaped like `resource_link`s (signed, expiring URLs). */
  files?: Array<Record<string, unknown>>;
}

export interface TriggerRead {
  uri: string;
  trigger: string;
  /** A stream is subscribed and the trigger runs. */
  subscribed: boolean;
  /** One poll made for this read: no subscription, nothing consumed. */
  oneShot?: boolean;
  /** The first poll of a subscription sets a baseline and reports nothing. */
  baseline?: boolean;
  polls?: number;
  lastPolledAt?: string;
  lastError?: string;
  /** Why a subscription stopped, when it did not stop because the client left. */
  stopped?: boolean;
  events: TriggerEvent[];
}

async function toEvent(item: NodeItem, id: string, at: string, caller: McpCaller, tool: string): Promise<TriggerEvent> {
  const blocks = item.binary && Object.keys(item.binary).length ? await fileBlocks([item], { tool, caller: callerLabel(caller) }).catch(() => undefined) : undefined;
  const files = blocks?.links.map((link) => ({ uri: link.uri, name: link.name, mimeType: link.mimeType, size: link.size }));
  return { id, at, data: item.json, ...(files?.length && { files }) };
}

/** `resources/read` of a trigger URI: the buffered events of the caller's subscription, else (poll triggers) one poll. */
export async function readTriggerResource(caller: McpCaller, pluginId: string, uri: string, signal?: AbortSignal): Promise<TriggerRead> {
  const resolved = (() => {
    try {
      return resolveUri(caller, pluginId, uri);
    } catch (error) {
      audit('mcp.resource.read', pluginId, caller, parseTriggerResourceUri(uri)?.name ?? uri, error instanceof McpTriggerError && error.kind === 'denied' ? 'denied' : 'failure', { reason: (error as Error).message });
      throw error;
    }
  })();
  const binding = resolved.trigger._meta[MCP_TOOL_META_KEY];
  const key = subscriptionKey(caller, pluginId, uri);
  const tool = `${pluginId}/${resolved.trigger.name}`;
  const row = getRow(key);
  if (row) {
    changeRow(key, () => ({ read_at: new Date().toISOString() }));
    const events = mcpDb().all<EventRow>('SELECT * FROM mcp_trigger_events WHERE sub_key = ? ORDER BY id DESC', key).reverse();
    return {
      uri,
      trigger: resolved.trigger.name,
      subscribed: !Number(row.stopping),
      ...(!Number(row.ready) && !Number(row.stopping) && { baseline: true }),
      polls: Number(row.polls),
      ...(row.last_polled_at && { lastPolledAt: row.last_polled_at }),
      ...(row.last_error && { lastError: row.last_error }),
      ...(Number(row.stopping) && { stopped: true }),
      events: await Promise.all(events.map((e) => toEvent(JSON.parse(e.item) as NodeItem, e.id, e.at, caller, tool))),
    };
  }
  if (binding.triggerSource !== 'poll') {
    throw new McpTriggerError(`${resolved.trigger.name} delivers events by webhook while a client is subscribed (subscriptions/listen on a 2026-07-28 connection); there is nothing to read before that`);
  }
  // One poll, in manual mode (the node shows recent events without consuming them), for clients that cannot subscribe.
  const prepared = prepare(caller, pluginId, resolved);
  const context = await nodeContext(prepared.stored, resolved.node);
  const request: ExecuteRequest = { protocol: PROTOCOL_VERSION, executionId: `mcpsub_${nanoid(10)}`, mode: 'manual', ...context, itemParameters: [], inputs: [] };
  const response = await resolved.node.execute(request, { signal: signal ?? AbortSignal.timeout(POLL_TIMEOUT_MS) });
  if (response.error) throw new McpTriggerError(response.error.message, 'unavailable');
  const items = (response.outputs[0] ?? []).slice(0, triggerBufferSize());
  const at = new Date().toISOString();
  audit('mcp.resource.read', pluginId, caller, resolved.trigger.name, 'success', { oneShot: true, events: items.length });
  return {
    uri,
    trigger: resolved.trigger.name,
    subscribed: false,
    oneShot: true,
    events: await Promise.all(items.map((item, i) => toEvent(item, `once-${i}`, at, caller, tool))),
  };
}

/** The caller's subscriptions on `pluginId` (live and stopped-but-retained), for `resources/list`. */
export function callerSubscriptions(caller: McpCaller, pluginId: string): Array<{ uri: string; trigger: string; subscribed: boolean }> {
  return mcpDb()
    .all<SubRow>('SELECT * FROM mcp_trigger_subs WHERE user_key = ? AND plugin_id = ? ORDER BY created_at', userKeyOf(caller), pluginId)
    .map((r) => ({ uri: r.uri, trigger: r.trigger, subscribed: !Number(r.stopping) }));
}

// ---------------------------------------------------------------------------
// Maintenance: heartbeat, watch, sweep
// ---------------------------------------------------------------------------

function startMaintenance() {
  const s = state();
  if (!s.heartbeat) {
    s.heartbeat = setInterval(() => {
      const now = new Date().toISOString();
      for (const live of s.subs.values()) {
        changeRow(live.key, () => ({ heartbeat_at: now, owner: s.instance }));
        // A grant taken away or a token revoked stops a webhook subscription too (polls check on every tick).
        if (live.trigger._meta[MCP_TOOL_META_KEY].triggerSource === 'appWebhook') {
          const reason = stopReason(live, getRow(live.key));
          if (reason) void deactivate(live, reason);
        }
      }
    }, heartbeatMs());
    s.heartbeat.unref?.();
  }
  if (!s.watch) {
    // Events another main stored (a webhook it received) are noticed here, where the stream is.
    s.watch = setInterval(() => {
      for (const live of s.subs.values()) {
        if (live.trigger._meta[MCP_TOOL_META_KEY].triggerSource !== 'appWebhook') continue;
        const newest = newestEventId(live.key);
        if (newest && newest > live.seen) notifyHolders(live, newest);
      }
    }, WATCH_MS);
    s.watch.unref?.();
  }
}

/** Remove what nobody owns any more: orphaned rows (their hook first), and stopped subscriptions past their retention. */
export async function sweepTriggerSubscriptions(now = Date.now()): Promise<number> {
  const s = state();
  let removed = 0;
  for (const row of mcpDb().all<SubRow>('SELECT * FROM mcp_trigger_subs')) {
    if (s.subs.has(row.sub_key)) continue;
    const stopping = Number(row.stopping) === 1;
    const orphan = !stopping && now - Date.parse(row.heartbeat_at) > orphanAfterMs();
    const expired = stopping && now - Date.parse(row.updated_at) > triggerRetainMs();
    // A stopped subscription whose hook is still registered (a failed delete) is retried at once, whatever the retention.
    const hookPending = Number(row.registered) === 1 && (stopping || orphan);
    if (!orphan && !expired && !hookPending) continue;
    if (hookPending) {
      const error = await removeHook(row.sub_key);
      if (error) continue;
    }
    if (orphan || expired) {
      if (orphan) audit('mcp.resource.unsubscribe', row.plugin_id, undefined, row.trigger, 'success', { reason: 'orphaned: the main that held it stopped pulsing' });
      removeSub(row.sub_key);
      removed++;
    }
  }
  return removed;
}

/** Started by bootstrap (the leader main in queue mode): the sweep of orphans and expired retentions. */
export const triggerSubscriptionSweeper = {
  start() {
    const s = state();
    if (s.sweep) return;
    s.sweep = setInterval(() => void sweepTriggerSubscriptions().catch((error) => logger.warn('mcp trigger sweep failed', { error: (error as Error).message })), sweepEveryMs());
    s.sweep.unref?.();
    void sweepTriggerSubscriptions().catch(() => {});
  },
  stop() {
    const s = state();
    if (s.sweep) clearInterval(s.sweep);
    s.sweep = undefined;
  },
};

/** Stop everything this process runs (tests, shutdown): polls end, hooks are removed. */
export async function stopAllTriggerSubscriptions(reason = 'the host is shutting down'): Promise<void> {
  const s = state();
  await Promise.allSettled([...s.subs.values()].map((live) => deactivate(live, reason)));
  for (const timer of [s.heartbeat, s.watch]) if (timer) clearInterval(timer);
  s.heartbeat = s.watch = undefined;
  triggerSubscriptionSweeper.stop();
}

/** How many subscriptions run in this process (tests, the status). */
export const runningTriggerSubscriptions = () => state().subs.size;
