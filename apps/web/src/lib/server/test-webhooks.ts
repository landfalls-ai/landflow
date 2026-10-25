/**
 * Test URLs of the Webhook and Form triggers (n8n's "Listen for test event"): /api/webhook-test/<path> and
 * /form-test/<path> answer only while an editor listens for that trigger, and run the workflow the editor sent when it
 * started listening (its current state, saved or not) as a manual run: mode `manual`, kept out of production Insights,
 * attributed to the user who listened. The trigger's authentication and IP allow-list apply as on the production URLs.
 *
 * - The editor POSTs /api/workflows/:id/listen with its workflow and the trigger's node id. That request stays open as
 *   an SSE stream (`listenerStream`): `listening`, then the run's events as /run streams them, then `result`; or
 *   `timeout` once TEST_LISTEN_MS (120 s) pass without a call. Closing it (Stop) removes the listener and stops a run
 *   that is still going.
 * - A Webhook listener is single-shot: the first call that passes the trigger's authentication claims it, and the URL
 *   answers 404 again. A Form listener shows the form until it is submitted, then stays (sending a reload to the run's
 *   next page) until the run finishes.
 * - The run's execution id is picked when listening starts, so the stream follows the run on the bus (./bus.ts)
 *   wherever it runs, the later pages of a multi-page form too (they resume through /form/waiting/<id>).
 *
 * Queue mode (./cluster): listeners are registered in Valkey, so a test call that reaches another main than the one
 * holding the editor's stream finds it there, claims it atomically (one run per listen) and runs it in that main; the
 * bus relay brings the run's events to the editor's main. Regular mode keeps them in a process-wide map.
 */
import { context } from '@opentelemetry/api';
import { nanoid } from 'nanoid';
import type { NodeItem } from '@landflow/protocol';
import type { ExecutionEvent, Workflow, WorkflowNode } from '@landflow/engine';
import type { ExecutionRecord } from '../shared/types';
import { withAuth } from './auth/context';
import { getUser } from './auth/users';
import { bus } from './bus';
import { clusterActive, coordinator, instanceId } from './cluster/state';
import { FORM_TRIGGER, messagePage, normalizePath } from './forms';
import { error, sseHeaders } from './http';
import { cancelExecution, liveExecution, runWorkflow, turnedDown, type RunOptions } from './runner';
import { singleton } from './singleton';
import { startTrigger } from './telemetry';
import { deferred } from './webhooks';

export const WEBHOOK_TRIGGER = 'core.webhook';
/** How long a listener waits for its test call. */
export const TEST_LISTEN_MS = 120_000;
/** A call that claimed a listener just as it timed out: how long the stream waits for its run to start. */
const CLAIM_GRACE_MS = 30_000;
/** A submitted test form keeps its URL (and Valkey keys) this long at most while the run goes on. */
const CLAIMED_TTL_MS = 60 * 60_000;
/** SSE comment that keeps proxies from closing the listening stream. */
const PING_MS = 15_000;

export type TestTriggerKind = 'webhook' | 'form';

/** Where each kind of test URL is served. */
export const TEST_PREFIX: Record<TestTriggerKind, string> = { webhook: '/api/webhook-test/', form: '/form-test/' };

export const NOT_LISTENING_HINT = 'Click “Listen for test event” in the editor first: the test URL answers only while the editor listens (for 120 s).';

export interface TestListener {
  id: string;
  kind: TestTriggerKind;
  /** The Webhook trigger's HTTP method; '' for a form (GET shows it, POST submits it). */
  method: string;
  path: string;
  /** What the editor sent when it started listening. */
  workflow: Workflow;
  nodeId: string;
  /** The test run's id, picked up front: the editor's stream follows it on the bus. */
  executionId: string;
  /** When it stops waiting for a call (epoch ms). */
  expiresAt: number;
  /** Who listened: the run is theirs, like an editor run. */
  actorId?: string;
}

/** A trigger with a test URL, as listening needs it, or why it has none. */
export function testTriggerOf(workflow: Workflow, nodeId: string): { kind: TestTriggerKind; method: string; path: string; node: WorkflowNode } | { error: string } {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) return { error: 'That node is not in the workflow' };
  if (node.type !== WEBHOOK_TRIGGER && node.type !== FORM_TRIGGER) return { error: 'Only Webhook and On Form Submission triggers have a test URL' };
  if (node.disabled) return { error: `“${node.name}” is disabled` };
  if (node.type === FORM_TRIGGER) {
    const path = normalizePath(node.parameters.path);
    if (!path) return { error: 'Set the form path first' };
    if (path === 'waiting' || path.startsWith('waiting/')) return { error: 'The form path can’t start with “waiting”' };
    return { kind: 'form', method: '', path, node };
  }
  // Matched like /api/webhook/<path> matches it.
  const path = String(node.parameters.path ?? '').replace(/^\/+/, '');
  if (!path) return { error: 'Set the webhook path first' };
  return { kind: 'webhook', method: String(node.parameters.method ?? 'POST').toUpperCase(), path, node };
}

/** The listener's trigger node. */
export const listenerNode = (listener: TestListener): WorkflowNode | undefined => listener.workflow.nodes.find((n) => n.id === listener.nodeId);

// ---------------------------------------------------------------------------
// Where listeners are kept: a process-wide map, or Valkey in queue mode
// ---------------------------------------------------------------------------

interface ListenerTable {
  /** Add a listener; refused while another workflow listens on the same test URL. */
  register(listener: TestListener): Promise<{ ok: true } | { ok: false; holder: string }>;
  lookup(kind: TestTriggerKind, method: string, path: string): Promise<{ listener: TestListener; claimed: boolean } | undefined>;
  /** Take the listener for one call (webhook: it stops listening; form: it is submitted). False when someone else did, or it expired. */
  claim(listener: TestListener): Promise<boolean>;
  /** Its time is up: removed unless a call claimed it (true when it was removed). */
  expire(listener: TestListener): Promise<boolean>;
  /** Gone for good (the stream closed). */
  remove(listener: TestListener): Promise<void>;
}

const routeKey = (kind: TestTriggerKind, method: string, path: string) => `${kind}:${method}:${path}`;
const expired = (listener: TestListener) => listener.expiresAt <= Date.now();

/** Regular mode. */
const localListeners = () => singleton('test-listeners', () => new Map<string, { listener: TestListener; claimed: boolean }>());

const localTable: ListenerTable = {
  async register(listener) {
    const key = routeKey(listener.kind, listener.method, listener.path);
    const existing = localListeners().get(key);
    if (existing && existing.listener.workflow.id !== listener.workflow.id && (existing.claimed || !expired(existing.listener))) {
      return { ok: false, holder: existing.listener.workflow.name };
    }
    localListeners().set(key, { listener, claimed: false });
    // The same trigger listening again (another tab): the earlier stream ends.
    if (existing && existing.listener.id !== listener.id) streams().get(existing.listener.id)?.('Listening again elsewhere');
    return { ok: true };
  },
  async lookup(kind, method, path) {
    const entry = localListeners().get(routeKey(kind, method, path));
    if (!entry || (!entry.claimed && expired(entry.listener))) return undefined;
    return { listener: entry.listener, claimed: entry.claimed };
  },
  async claim(listener) {
    const key = routeKey(listener.kind, listener.method, listener.path);
    const entry = localListeners().get(key);
    if (entry?.listener.id !== listener.id || entry.claimed || expired(listener)) return false;
    if (listener.kind === 'webhook') localListeners().delete(key);
    else entry.claimed = true;
    return true;
  },
  async expire(listener) {
    const key = routeKey(listener.kind, listener.method, listener.path);
    const entry = localListeners().get(key);
    if (entry?.listener.id !== listener.id || entry.claimed) return false;
    localListeners().delete(key);
    return true;
  },
  async remove(listener) {
    const key = routeKey(listener.kind, listener.method, listener.path);
    if (localListeners().get(key)?.listener.id === listener.id) localListeners().delete(key);
  },
};

/**
 * Queue mode: `test-listener:<kind>:<method>:<path>` holds the listener id, `test-listener:<id>` the listener (with its
 * workflow) and `test-listener:<id>:claim` who submitted a form (or that it expired). A webhook call claims by deleting
 * the route key while it still holds the id, a form submission by setting the claim key: one winner either way.
 */
const EXPIRED = '-expired-';
const valkeyKeys = (listener: Pick<TestListener, 'id' | 'kind' | 'method' | 'path'>) => ({
  route: `test-listener:${routeKey(listener.kind, listener.method, listener.path)}`,
  data: `test-listener:${listener.id}`,
  claim: `test-listener:${listener.id}:claim`,
});

const parseListener = (raw: string | undefined): TestListener | undefined => {
  try {
    return raw ? (JSON.parse(raw) as TestListener) : undefined;
  } catch {
    return undefined;
  }
};

const valkeyTable: ListenerTable = {
  async register(listener) {
    const valkey = coordinator();
    const keys = valkeyKeys(listener);
    const ttl = listener.expiresAt - Date.now() + CLAIM_GRACE_MS;
    const holderId = await valkey.get(keys.route);
    if (holderId && holderId !== listener.id) {
      const [raw, claim] = await valkey.getMany([`test-listener:${holderId}`, `test-listener:${holderId}:claim`]);
      const holder = parseListener(raw);
      const claimed = Boolean(claim) && claim !== EXPIRED;
      if (holder && holder.workflow.id !== listener.workflow.id && (claimed || (!expired(holder) && !claim))) return { ok: false, holder: holder.workflow.name };
    }
    await valkey.set(keys.data, JSON.stringify(listener), ttl);
    await valkey.set(keys.route, listener.id, ttl);
    if (holderId && holderId !== listener.id) streams().get(holderId)?.('Listening again elsewhere');
    return { ok: true };
  },
  async lookup(kind, method, path) {
    const valkey = coordinator();
    const id = await valkey.get(`test-listener:${routeKey(kind, method, path)}`);
    if (!id) return undefined;
    const [raw, claim] = await valkey.getMany([`test-listener:${id}`, `test-listener:${id}:claim`]);
    const listener = parseListener(raw);
    if (!listener || claim === EXPIRED) return undefined;
    const claimed = Boolean(claim);
    if (!claimed && expired(listener)) return undefined;
    return { listener, claimed };
  },
  async claim(listener) {
    if (expired(listener)) return false;
    const valkey = coordinator();
    const keys = valkeyKeys(listener);
    if (listener.kind === 'webhook') {
      const won = await valkey.deleteIfValue(keys.route, listener.id);
      if (won) await valkey.del(keys.data);
      return won;
    }
    if (!(await valkey.setIfAbsent(keys.claim, instanceId(), CLAIMED_TTL_MS))) return false;
    // Still this listener's URL (not replaced since it was looked up)? Then it lives while the run goes on.
    if ((await valkey.get(keys.route)) !== listener.id) {
      await valkey.del(keys.claim);
      return false;
    }
    await valkey.set(keys.route, listener.id, CLAIMED_TTL_MS);
    await valkey.set(keys.data, JSON.stringify(listener), CLAIMED_TTL_MS);
    return true;
  },
  async expire(listener) {
    const valkey = coordinator();
    const keys = valkeyKeys(listener);
    if (listener.kind === 'webhook') {
      const removed = await valkey.deleteIfValue(keys.route, listener.id);
      if (removed) await valkey.del(keys.data);
      return removed;
    }
    if (!(await valkey.setIfAbsent(keys.claim, EXPIRED, CLAIM_GRACE_MS))) return false;
    await valkey.deleteIfValue(keys.route, listener.id);
    await valkey.del(keys.data);
    return true;
  },
  async remove(listener) {
    const valkey = coordinator();
    const keys = valkeyKeys(listener);
    await valkey.deleteIfValue(keys.route, listener.id);
    await valkey.del(keys.data, keys.claim);
  },
};

const table = (): ListenerTable => (clusterActive() ? valkeyTable : localTable);

/** The streams this process holds, by listener id: called to end one that was replaced. */
const streams = () => singleton('test-listener-streams', () => new Map<string, (reason: string) => void>());

// ---------------------------------------------------------------------------
// Listening (the editor's side)
// ---------------------------------------------------------------------------

/** Start listening for a test call to `nodeId`'s test URL, running `workflow` (what the editor sent). */
export async function startListening(workflow: Workflow, nodeId: string, actorId?: string): Promise<{ ok: true; listener: TestListener } | { ok: false; error: string; status: number }> {
  const trigger = testTriggerOf(workflow, nodeId);
  if ('error' in trigger) return { ok: false, error: trigger.error, status: 400 };
  // The trigger outputs what arrives, whatever test data is pinned on it (pins on other nodes still apply).
  const { [nodeId]: _pinned, ...pinData } = workflow.pinData ?? {};
  const listener: TestListener = {
    id: `tl_${nanoid(12)}`,
    kind: trigger.kind,
    method: trigger.method,
    path: trigger.path,
    workflow: workflow.pinData?.[nodeId] ? { ...workflow, pinData } : workflow,
    nodeId,
    executionId: `ex_${nanoid(12)}`,
    expiresAt: Date.now() + TEST_LISTEN_MS,
    ...(actorId && { actorId }),
  };
  const registered = await table().register(listener);
  if (!registered.ok) return { ok: false, error: `Another workflow (“${registered.holder}”) is listening on ${TEST_PREFIX[trigger.kind]}${trigger.path}`, status: 409 };
  return { ok: true, listener };
}

/**
 * The listening stream (SSE): `listening`, then `execution` events of the test run and its `result`; `timeout` when no
 * call came, `stopped` when the same trigger started listening elsewhere. The listener goes when the stream ends;
 * `signal` (the editor's request) aborting ends it and stops a run that is still going.
 */
export function listenerStream(listener: TestListener, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let finish: (cancelRun?: boolean) => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let received = false;
      let timer: NodeJS.Timeout | undefined;
      let grace: NodeJS.Timeout | undefined;
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // the editor went away
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const ping = setInterval(() => write(': ping\n\n'), PING_MS);
      ping.unref?.();

      const unsubscribe = bus.subscribe((published) => {
        if (closed || published.channel !== 'execution' || published.event.executionId !== listener.executionId) return;
        const event: ExecutionEvent = published.event;
        if (!received) {
          received = true;
          clearTimeout(timer);
          clearTimeout(grace);
        }
        send('execution', event);
        if (event.type !== 'execution.finished') return;
        // Waiting for the next page of the form: follow the run there.
        if (listener.kind === 'form' && event.status === 'waiting' && event.wait?.resume === 'form') return;
        send('result', { executionId: listener.executionId, status: event.status, ...(event.error && { error: event.error }) });
        finish();
      });

      const timeout = () => {
        send('timeout', { message: `No test event arrived within ${Math.round(TEST_LISTEN_MS / 1000)} s` });
        finish();
      };
      finish = (cancelRun = false) => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearTimeout(timer);
        clearTimeout(grace);
        clearInterval(ping);
        signal.removeEventListener('abort', onAbort);
        streams().delete(listener.id);
        // Stop: a run still going is canceled, as an editor run is when its stream closes (a waiting form run stays).
        if (cancelRun && received && liveExecution(listener.executionId)) cancelExecution(listener.executionId);
        void table()
          .remove(listener)
          .catch(() => {});
        try {
          controller.close();
        } catch {}
      };
      const onAbort = () => finish(true);
      streams().set(listener.id, (reason) => {
        send('stopped', { message: reason });
        finish();
      });
      signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(
        async () => {
          if (received || closed) return;
          let removed = true;
          try {
            removed = await table().expire(listener);
          } catch {}
          if (received || closed) return;
          if (removed) return timeout();
          // A call claimed it just now: give its run a moment to start.
          grace = setTimeout(() => !received && timeout(), CLAIM_GRACE_MS);
        },
        Math.max(0, listener.expiresAt - Date.now()),
      );

      send('listening', {
        listenerId: listener.id,
        nodeId: listener.nodeId,
        kind: listener.kind,
        ...(listener.method && { method: listener.method }),
        path: listener.path,
        executionId: listener.executionId,
        expiresAt: listener.expiresAt,
        timeoutMs: Math.max(0, listener.expiresAt - Date.now()),
      });
      if (signal.aborted) onAbort();
    },
    cancel() {
      finish(true);
    },
  });
  return new Response(stream, { headers: sseHeaders });
}

// ---------------------------------------------------------------------------
// Test calls (the test URL's side)
// ---------------------------------------------------------------------------

/** The listener a test call is for: its trigger node, and whether a form was already submitted. */
export async function findTestListener(kind: TestTriggerKind, path: string, method = ''): Promise<{ listener: TestListener; node: WorkflowNode; claimed: boolean } | undefined> {
  const found = await table().lookup(kind, kind === 'webhook' ? method.toUpperCase() : '', path);
  const node = found && listenerNode(found.listener);
  return found && node ? { ...found, node } : undefined;
}

/** Take the listener for this call (one call per listen). */
export const claimTestListener = (listener: TestListener) => table().claim(listener);

const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** 404 for a test webhook nobody listens on, saying how to start listening (and naming the method it waits for). */
export async function testWebhookMiss(path: string, method: string): Promise<Response> {
  const others: string[] = [];
  for (const candidate of WEBHOOK_METHODS) if (candidate !== method && (await table().lookup('webhook', candidate, path))) others.push(candidate);
  const message = others.length
    ? `The test webhook ${TEST_PREFIX.webhook}${path} listens for ${others.join(' or ')} requests, not ${method}`
    : `No editor is listening on ${method} ${TEST_PREFIX.webhook}${path}`;
  return error(message, 404, { hint: NOT_LISTENING_HINT });
}

/** The HTML 404 of a test form nobody listens on. */
export const testFormMiss = () => messagePage({ title: 'Form not found', message: `No editor is listening for this test form. ${NOT_LISTENING_HINT}`, status: 404 });

/**
 * Tell the editor its test call failed before the run could start (a file too large, a run turned down): an
 * `execution.finished` for the test run's id ends its stream with the error.
 */
export function failTestEvent(listener: TestListener, message: string) {
  bus.publish({
    channel: 'execution',
    workflowId: listener.workflow.id,
    event: { type: 'execution.finished', executionId: listener.executionId, status: 'error', durationMs: 0, error: { message }, at: new Date().toISOString() },
  });
}

/**
 * Run a claimed listener's workflow from its trigger with `item`, as a manual run of the user who listened. `started`
 * resolves once the run exists (undefined), or with the error that kept it from starting (the editor is told).
 */
export function runTestEvent(
  listener: TestListener,
  item: NodeItem,
  options: Pick<RunOptions, 'onReply' | 'onEvent' | 'streaming'> = {},
): { run: Promise<ExecutionRecord>; started: Promise<unknown> } {
  const trigger = startTrigger({ source: 'manual', workflowId: listener.workflow.id, nodeName: listenerNode(listener)?.name });
  const begun = deferred<void>();
  const start = () =>
    context.with(trigger.context, () =>
      runWorkflow({
        workflow: listener.workflow,
        mode: 'manual',
        startNodeId: listener.nodeId,
        triggerItems: [item],
        executionId: listener.executionId,
        onStart: () => begun.resolve(),
        ...options,
      }),
    );
  const user = listener.actorId ? getUser(listener.actorId) : undefined;
  const run = user ? withAuth({ principal: { user, via: 'session' } }, start) : start();
  run.then(
    () => trigger.end(),
    (caught) => trigger.end(caught),
  );
  const started = turnedDown(run, begun.promise).then((caught) => {
    if (caught !== undefined) failTestEvent(listener, (caught as Error)?.message ?? 'The test run could not start');
    return caught;
  });
  return { run, started };
}
