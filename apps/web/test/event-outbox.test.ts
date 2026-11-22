/**
 * Run events through the outbox (C19): which events a save announces, that the rows are written in the save's own
 * transaction (a failing listener leaves neither), who gets what (project, workflow and node filters, output opt-in),
 * the signing secret sealed and re-sealed on rotation, and then the dispatcher against a local receiver and a fake clock:
 * signed deliveries with a stable event id, backoff and retry, ordering, a 410, dead rows after 72 hours, the backlog
 * bound, a private address refused when sending, metrics, and that only the leader runs it.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NodeRun, Workflow } from '@landflow/engine';
import type { ExecutionRecord, ExecutionState } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-event-outbox-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
  LANDFLOW_PUBLIC_URL: 'http://events.test',
  LANDFLOW_ENCRYPTION_KEYS: `n1:a new passphrase for the vault,n0:${'ab'.repeat(32)}`,
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store, onExecutionSaving } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const projects = await import('@/lib/server/projects');
const { createTeamProject } = await import('@/lib/server/projects/store');
const { ensureExecutionReactions } = await import('@/lib/server/execution-reactions');
const { credentials } = await import('@/lib/server/credentials/vault');
const key = await import('@/lib/server/credentials/key-ring');
const { rotateEncryption } = await import('@/lib/server/credentials/rotate');
const { signature } = await import('@/lib/server/alerts/http');
const { runEvents, eventPayload } = await import('@/lib/server/outbox/events');
const subs = await import('@/lib/server/outbox/subscriptions');
const { drainSubscriptions, enforceBacklog, maintainOutbox } = await import('@/lib/server/outbox/dispatcher');
const { outboxHealth, deliveryTally } = await import('@/lib/server/outbox/metrics');
const { SUBSCRIPTION_OUTBOX } = await import('@/lib/server/outbox/core');
const { singleton } = await import('@/lib/server/singleton');
const { SERVICES } = await import('@/lib/server/runtime');

ensureExecutionReactions();

afterAll(async () => {
  await new Promise<void>((done) => (receiver ? receiver.close(() => done()) : done()));
  for (const name of Object.keys(ENV)) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
});

// ---- a project, its workflows and a receiver ------------------------------------------------------------------------

let projectId = '';
let otherProjectId = '';
const WF = 'wf_events_a';
const WF2 = 'wf_events_b';
const OTHER_WF = 'wf_events_other';

function workflow(id: string, project: string) {
  store.saveWorkflow({ id, name: id, nodes: [], connections: [] } as unknown as Workflow);
  projects.setHomeProject('workflow', id, project);
}

beforeAll(() => {
  projectId = createTeamProject({ name: 'Events' }).id;
  otherProjectId = createTeamProject({ name: 'Elsewhere' }).id;
  workflow(WF, projectId);
  workflow(WF2, projectId);
  workflow(OTHER_WF, otherProjectId);
});

interface Hit {
  headers: IncomingHttpHeaders;
  body: string;
}
let receiver: Server | undefined;
let receiverUrl = '';
const hits: Hit[] = [];
/** Statuses the receiver answers with, in order; the last repeats. */
let script: number[] = [200];
async function startReceiver() {
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      hits.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      const status = script.length > 1 ? script.shift()! : script[0]!;
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end(status === 200 ? 'ok' : 'nope');
    });
  });
  await new Promise<void>((done) => receiver!.listen(0, '127.0.0.1', done));
  const address = receiver.address();
  receiverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hook`;
}
await startReceiver();

let counter = 0;
function record(workflowId: string, status: ExecutionState, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  counter += 1;
  const at = new Date(Date.now() + counter).toISOString();
  return { executionId: `ex_evt_${counter}`, workflowId, workflowName: workflowId, mode: 'manual', status, startedAt: at, finishedAt: status === 'running' ? '' : at, durationMs: 5, runData: {}, executionOrder: [], ...over } as ExecutionRecord;
}
const run = (nodeStatus: 'success' | 'error' = 'success', items: unknown[] = [{ n: 1 }]): NodeRun => ({ startedAt: new Date().toISOString(), durationMs: 1, status: nodeStatus, source: 'main', inputs: [], outputs: [items.map((json) => ({ json })) as never] });

const rows = (id?: string) => database().all<{ target_id: string; event_id: string; payload: string; dead_at: string | null; attempts: number; next_at: string; last_error: string | null }>(`SELECT * FROM event_outbox ${id ? 'WHERE target_id = ?' : ''} ORDER BY created_at, event_id`, ...(id ? [id] : []));
const subscribe = (input: Partial<Parameters<typeof subs.createSubscription>[2]> = {}, project = projectId) =>
  subs.createSubscription({ id: 'usr_test' }, project, { name: 'Receiver', url: receiverUrl, events: ['run.finished', 'run.failed'], ...input });
function clean() {
  for (const s of subs.allSubscriptions()) subs.deleteSubscription(s.id);
  hits.length = 0;
  script = [200];
}

// ---- which events a save announces ----------------------------------------------------------------------------------

describe('runEvents', () => {
  it('announces a run once: its start, its end, its failure, its cancel; nothing while waiting', () => {
    expect(runEvents(record(WF, 'running'), undefined).map((e) => e.type)).toEqual(['run.started']);
    expect(runEvents(record(WF, 'running'), 'queued').map((e) => e.type)).toEqual(['run.started']);
    // Another save of a run that was already running, or one that came back from waiting, is not a second start.
    expect(runEvents(record(WF, 'running'), 'running')).toEqual([]);
    expect(runEvents(record(WF, 'running'), 'waiting')).toEqual([]);
    expect(runEvents(record(WF, 'success'), 'running').map((e) => e.type)).toEqual(['run.finished']);
    expect(runEvents(record(WF, 'success'), undefined).map((e) => e.type)).toEqual(['run.finished']);
    const failed = runEvents(record(WF, 'error', { error: { message: 'boom', nodeName: 'HTTP Request' } }), 'running');
    expect(failed.map((e) => e.type)).toEqual(['run.failed']);
    expect(failed[0]!.error).toEqual({ message: 'boom', node: 'HTTP Request' });
    const canceled = runEvents(record(WF, 'canceled'), 'running');
    expect(canceled.map((e) => e.type)).toEqual(['run.finished']);
    expect(canceled[0]!.status).toBe('canceled');
    expect(runEvents(record(WF, 'waiting'), 'running')).toEqual([]);
  });

  it('gives the same ids when a save repeats, and announces an end only once', () => {
    const r = record(WF, 'success');
    expect(runEvents(r, 'running')[0]!.id).toBe(`${r.executionId}:run.finished`);
    expect(runEvents(r, 'running')[0]!.id).toBe(runEvents(r, 'running')[0]!.id);
    expect(runEvents(r, 'success')).toEqual([]);
  });

  it('derives node.finished from the run data, for named nodes only, before the run event', () => {
    const r = record(WF, 'success', { runData: { n1: [run()], n2: [run('error')] }, nodeNames: { n1: 'Send invoice', n2: 'Other' } });
    const events = runEvents(r, 'running', new Set(['Send invoice']));
    expect(events.map((e) => e.id)).toEqual([`${r.executionId}:node.finished:Send invoice`, `${r.executionId}:run.finished`]);
    expect(events[0]!.node).toMatchObject({ name: 'Send invoice', status: 'success' });
    expect(runEvents(r, 'running').map((e) => e.type)).toEqual(['run.finished']);
  });
});

describe('payload', () => {
  const sub = { projectId: 'p', includeOutput: false };
  it('holds ids and status and no item data unless asked (AS-9)', () => {
    const r = record(WF, 'success', { lastNodeId: 'n1', runData: { n1: [run('success', [{ secret: 'item data' }])] } });
    const body = JSON.parse(eventPayload(runEvents(r, 'running')[0]!, r, sub));
    expect(body).toMatchObject({ id: `${r.executionId}:run.finished`, type: 'run.finished', projectId: 'p', workflow: { id: WF }, execution: { id: r.executionId, status: 'success', url: `http://events.test/executions/${r.executionId}` } });
    expect(JSON.stringify(body)).not.toContain('item data');
    expect(body.output).toBeUndefined();
  });
  it('carries the first 5 items with includeOutput, and cuts a 200 KB output to 64 KB', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ i }));
    const r = record(WF, 'success', { lastNodeId: 'n1', runData: { n1: [run('success', many)] } });
    const body = JSON.parse(eventPayload(runEvents(r, 'running')[0]!, r, { projectId: 'p', includeOutput: true }));
    expect(body.output).toHaveLength(5);
    expect(body.outputTruncated).toBe(true);
    const huge = record(WF, 'success', { lastNodeId: 'n1', runData: { n1: [run('success', [{ blob: 'x'.repeat(200_000) }])] } });
    const text = eventPayload(runEvents(huge, 'running')[0]!, huge, { projectId: 'p', includeOutput: true });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(text).outputTruncated).toBe(true);
  });
});

// ---- the save hook ----------------------------------------------------------------------------------------------------

describe('saveExecution writes the rows in its own transaction', () => {
  it('writes one row for a failing run of a subscribed workflow and none for another project', () => {
    clean();
    const { subscription } = subscribe({ events: ['run.failed'], workflowIds: [WF] });
    store.saveExecution(record(WF, 'success'));
    store.saveExecution(record(WF2, 'error'));
    store.saveExecution(record(OTHER_WF, 'error'));
    expect(rows()).toHaveLength(0);
    const failing = record(WF, 'error', { error: { message: 'boom' } });
    store.saveExecution(failing);
    expect(rows(subscription.id).map((r) => r.event_id)).toEqual([`${failing.executionId}:run.failed`]);
    // Saving the same finished run again (a retry link, an update) does not queue it twice.
    store.saveExecution(failing);
    expect(rows(subscription.id)).toHaveLength(1);
  });

  it('a listener that throws after the hook leaves neither the execution nor its rows (AS-1 from the store)', () => {
    clean();
    const { subscription } = subscribe({ events: ['run.failed'] });
    const off = onExecutionSaving(() => {
      throw new Error('disk full');
    });
    const r = record(WF, 'error');
    try {
      expect(() => store.saveExecution(r)).toThrow('disk full');
    } finally {
      off();
    }
    expect(rows(subscription.id)).toHaveLength(0);
    expect(database().get('SELECT id FROM executions WHERE id = ?', r.executionId)).toBeUndefined();
    store.saveExecution(r);
    expect(rows(subscription.id)).toHaveLength(1);
    expect(database().get('SELECT id FROM executions WHERE id = ?', r.executionId)).toBeDefined();
  });

  it('queues run.started on the running save and node.finished only for the named step, after the run (AS-6)', () => {
    clean();
    const { subscription } = subscribe({ events: ['run.started', 'node.finished'], nodeNames: ['Send invoice'] });
    const r = record(WF, 'running');
    store.saveExecution(r);
    store.saveExecution({ ...r, status: 'success', finishedAt: new Date().toISOString(), runData: { a: [run()], b: [run()] }, nodeNames: { a: 'Send invoice', b: 'Noise' } });
    expect(rows(subscription.id).map((x) => x.event_id)).toEqual([`${r.executionId}:run.started`, `${r.executionId}:node.finished:Send invoice`]);
    // Creation order is the order of the rows, even inside one millisecond.
    const created = database().all<{ created_at: string }>('SELECT created_at FROM event_outbox WHERE target_id = ? ORDER BY created_at', subscription.id).map((x) => x.created_at);
    expect(new Set(created).size).toBe(created.length);
  });

  it('does not queue what a disabled subscription would have got, and a later subscription gets no earlier events', () => {
    clean();
    const { subscription } = subscribe({ events: ['run.failed'] });
    subs.updateSubscription(subscription.id, { enabled: false });
    store.saveExecution(record(WF, 'error'));
    expect(rows(subscription.id)).toHaveLength(0);
    const before = record(WF, 'error');
    store.saveExecution(before);
    const { subscription: later } = subscribe({ events: ['run.failed'] });
    expect(rows(later.id)).toHaveLength(0);
  });

  it('a save in a project without subscriptions writes nothing and stays close to the cost of a plain save', () => {
    clean();
    const db = database();
    const insert = vi.spyOn(db, 'insertNew');
    const timeSaves = () => {
      const start = performance.now();
      for (let i = 0; i < 400; i++) store.saveExecution(record(OTHER_WF, i % 2 ? 'success' : 'running'));
      return performance.now() - start;
    };
    const listeners = singleton('store-execution-saving', () => [] as unknown[]);
    const kept = listeners.splice(0, listeners.length);
    let without = Infinity;
    try {
      for (let i = 0; i < 3; i++) without = Math.min(without, timeSaves());
    } finally {
      listeners.push(...kept);
    }
    let withHook = Infinity;
    for (let i = 0; i < 3; i++) withHook = Math.min(withHook, timeSaves());
    expect(insert.mock.calls.filter(([table]) => table === 'event_outbox')).toHaveLength(0);
    // A loose bound on a noisy machine: the hook is a map lookup, not a query.
    if (!process.env.CI_SLOW) expect(withHook).toBeLessThan(without * 1.6 + 25);
    insert.mockRestore();
  });
});

describe('the signing secret', () => {
  it('is made by Landflow, shown once, sealed, and re-sealed when the key rotates', () => {
    clean();
    const { subscription, secret } = subscribe();
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify(subs.listSubscriptions(projectId))).not.toContain(secret);
    const stored = database().get<{ secret: string }>('SELECT secret FROM event_subscriptions WHERE id = ?', subscription.id)!.secret;
    expect(stored).not.toContain(secret);
    expect(credentials.openSecret(stored)).toBe(secret);
    // A subscription sealed under the old key joins the rotation.
    const old = key.sealWith(key.buildKeyRing(`n0:${'ab'.repeat(32)}`, undefined), secret, 'landflow:secret');
    database().upsert('event_subscriptions', { ...(database().get<Record<string, string>>('SELECT * FROM event_subscriptions WHERE id = ?', subscription.id)!), secret: `v2.${old.kid}.${old.iv}.${old.tag}.${old.value}` });
    const result = rotateEncryption();
    expect(result.stores.event_subscriptions).toBe(1);
    const after = database().get<{ secret: string }>('SELECT secret FROM event_subscriptions WHERE id = ?', subscription.id)!.secret;
    expect(after.startsWith('v2.n1.')).toBe(true);
    expect(credentials.openSecret(after)).toBe(secret);
    const next = subs.updateSubscription(subscription.id, { newSecret: true });
    expect(next.secret).toMatch(/^whsec_/);
    expect(next.secret).not.toBe(secret);
  });
});

// ---- the dispatcher ---------------------------------------------------------------------------------------------------

const failing = (over: Partial<ExecutionRecord> = {}) => {
  const r = record(WF, 'error', { error: { message: 'boom', nodeName: 'HTTP Request' }, ...over });
  store.saveExecution(r);
  return r;
};

describe('delivery', () => {
  it('posts the event signed, with its stable id, and deletes the row on a 2xx (AS-1, FR-4)', async () => {
    clean();
    const { subscription, secret } = subscribe({ events: ['run.failed'] });
    const r = failing();
    expect(await drainSubscriptions()).toBe(1);
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.headers['x-landflow-event']).toBe('run.failed');
    expect(hit.headers['x-landflow-event-id']).toBe(`${r.executionId}:run.failed`);
    expect(hit.headers['x-landflow-signature']).toBe(signature(secret, String(hit.headers['x-landflow-timestamp']), hit.body));
    expect(JSON.parse(hit.body)).toMatchObject({ id: `${r.executionId}:run.failed`, type: 'run.failed', projectId, error: { message: 'boom', node: 'HTTP Request' } });
    expect(rows(subscription.id)).toHaveLength(0);
    expect(subs.subscriptionView(subscription.id)!.lastDelivery).toMatchObject({ status: 200 });
  });

  it('retries a 500 twice with the same event id and backoff, then delivers (AS-2)', async () => {
    clean();
    script = [500, 500, 200];
    const { subscription } = subscribe({ events: ['run.failed'] });
    const r = failing();
    const t0 = Date.now() + 100;
    expect(await drainSubscriptions(t0)).toBe(0);
    expect(rows(subscription.id)[0]).toMatchObject({ attempts: 1 });
    expect(subs.subscriptionView(subscription.id)).toMatchObject({ backlog: 1, lastError: expect.stringContaining('HTTP 500') });
    // Within the backoff nothing is sent.
    expect(await drainSubscriptions(t0 + 500)).toBe(0);
    expect(hits).toHaveLength(1);
    expect(await drainSubscriptions(t0 + 3_000)).toBe(0);
    expect(hits).toHaveLength(2);
    expect(await drainSubscriptions(t0 + 3_000 + 6_000)).toBe(1);
    expect(hits).toHaveLength(3);
    expect(new Set(hits.map((h) => h.headers['x-landflow-event-id']))).toEqual(new Set([`${r.executionId}:run.failed`]));
    expect(rows(subscription.id)).toHaveLength(0);
  });

  it('delivers what queued while the receiver was down, in order (AS-3)', async () => {
    clean();
    script = [503];
    const { subscription } = subscribe({ events: ['run.failed'] });
    const ids = [failing(), failing(), failing()].map((r) => `${r.executionId}:run.failed`);
    const t0 = Date.now() + 100;
    expect(await drainSubscriptions(t0)).toBe(0);
    // Ordered: only the first was tried; the others wait behind it.
    expect(hits).toHaveLength(1);
    expect(rows(subscription.id)).toHaveLength(3);
    script = [200];
    hits.length = 0;
    // "Restart": a later pass, long after the backoff, drains them one after another.
    expect(await drainSubscriptions(t0 + 10 * 60_000)).toBe(3);
    expect(hits.map((h) => h.headers['x-landflow-event-id'])).toEqual(ids);
  });

  it('an unordered subscription is not held up by one failing event', async () => {
    clean();
    script = [500, 200, 200];
    const { subscription } = subscribe({ events: ['run.failed'], ordered: false });
    failing();
    failing();
    failing();
    expect(await drainSubscriptions(Date.now() + 100)).toBe(2);
    expect(rows(subscription.id)).toHaveLength(1);
  });

  it('delivers the same id again when a lease ran out before the row was settled (at least once)', async () => {
    clean();
    const { subscription } = subscribe({ events: ['run.failed'] });
    const r = failing();
    const { claimDue } = await import('@/lib/server/outbox/core');
    const t0 = Date.now() + 100;
    // A leader took the row and died: its lease is held, so another pass leaves it alone ...
    expect(claimDue(SUBSCRIPTION_OUTBOX, subscription.id, 1, t0, true)).toHaveLength(1);
    expect(await drainSubscriptions(t0 + 1_000)).toBe(0);
    expect(hits).toHaveLength(0);
    // ... and once the lease is over the next one sends it.
    expect(await drainSubscriptions(t0 + 61_000)).toBe(1);
    expect(hits.map((h) => h.headers['x-landflow-event-id'])).toEqual([`${r.executionId}:run.failed`]);
  });

  it('a 410 turns the subscription off with the reason and stops the tries (D11)', async () => {
    clean();
    script = [410];
    const { subscription } = subscribe({ events: ['run.failed'] });
    failing();
    failing();
    await drainSubscriptions(Date.now() + 100);
    expect(hits).toHaveLength(1);
    expect(subs.subscriptionView(subscription.id)).toMatchObject({ enabled: false, disabledReason: 'The receiver answered 410 Gone' });
    expect(await drainSubscriptions(Date.now() + 60 * 60_000)).toBe(0);
    expect(hits).toHaveLength(1);
    // Turning it back on clears the reason.
    expect(subs.updateSubscription(subscription.id, { enabled: true }).subscription).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('dead-letters a row still failing 72 hours after it was made, and Retry now brings it back (AS-7)', async () => {
    clean();
    script = [500];
    const { subscription } = subscribe({ events: ['run.failed'] });
    failing();
    const later = Date.now() + 73 * 3_600_000;
    await drainSubscriptions(later);
    expect(rows(subscription.id)[0]!.dead_at).not.toBeNull();
    expect(subs.subscriptionView(subscription.id)).toMatchObject({ backlog: 0, dead: 1 });
    expect(await drainSubscriptions(later + 3_600_000)).toBe(0);
    script = [200];
    expect(subs.retryNow(subscription.id)).toBe(1);
    expect(rows(subscription.id)[0]!.dead_at).toBeNull();
    expect(await drainSubscriptions(Date.now() + 1_000)).toBe(1);
    expect(rows(subscription.id)).toHaveLength(0);
  });

  it('dead-letters the oldest rows beyond the backlog bound, not on the save path (D12), and prunes old dead rows', () => {
    clean();
    const { subscription } = subscribe({ events: ['run.failed'] });
    const db = database();
    const base = Date.now();
    db.transaction(() => {
      for (let i = 0; i < 25; i++) db.insertNew('event_outbox', { topic: 'subscription', target_id: subscription.id, event_id: `bulk_${String(i).padStart(3, '0')}`, created_at: new Date(base + i).toISOString(), payload: '{}', attempts: 0, next_at: new Date(base + i).toISOString() });
    });
    expect(enforceBacklog(subscription.id, base, 20)).toBe(5);
    const dead = rows(subscription.id).filter((r) => r.dead_at);
    expect(dead.map((r) => r.event_id)).toEqual(['bulk_000', 'bulk_001', 'bulk_002', 'bulk_003', 'bulk_004']);
    expect(dead.every((r) => r.last_error === 'backlog full')).toBe(true);
    // Dead rows go after 30 days.
    expect(maintainOutbox(base + 31 * 86_400_000).pruned).toBe(5);
  });

  it('refuses an address that turned private since it was saved, and counts it as a failure with the policy reason', async () => {
    clean();
    const { subscription } = subscribe({ events: ['run.failed'] });
    failing();
    process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE = 'true';
    try {
      await drainSubscriptions(Date.now() + 100);
    } finally {
      delete process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE;
    }
    expect(hits).toHaveLength(0);
    expect(rows(subscription.id)[0]!.last_error).toMatch(/private address|could not be reached/);
  });

  it('reports backlog, oldest age and outcomes as metrics', async () => {
    clean();
    script = [500];
    subscribe({ events: ['run.failed'] });
    failing();
    await drainSubscriptions(Date.now() + 100);
    const health = outboxHealth(Date.now() + 5_000);
    expect(health.backlog).toBe(1);
    expect(health.oldestAgeSeconds).toBeGreaterThanOrEqual(4);
    expect(deliveryTally().failed).toBeGreaterThan(0);
  });

  it('is a leader-only service on the main role (FR-7)', () => {
    const entry = SERVICES.find((service) => service.name === 'event outbox');
    expect(entry).toMatchObject({ leader: true });
    expect(entry?.roles).not.toContain('worker');
  });
});
