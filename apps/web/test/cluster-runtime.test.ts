/**
 * Queue mode through the runner, in one process: a main (startCluster on the in-process coordinator, bootstrapped like
 * a real one) and job workers on the same MemoryHub, as processes sharing a Valkey would be. Production runs go through
 * the job queue to a worker and back (events, Respond to Webhook replies, the record, the webhook route's answer);
 * editor runs stay in the main unless offloaded; load spreads over workers; cancel and stop-all from another process; a
 * job canceled before a worker takes it; a stalled job taken over from its checkpoint (and failed after too many
 * takeovers); runs nobody holds adopted by the leader; the concurrency FIFO and idempotency claims across processes;
 * timers handed to the leader; the bus relay; the Workers status; leader services moving with the leadership.
 *
 * The workers here share the main's instance id (one process, one store) and differ by their consumer name.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { ExecutionEvent, NodeRun, Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';
import type { QueueJob } from '@/lib/server/cluster/coordinator';
import type { BusEvent } from '@/lib/server/bus';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-cluster-'));
const ENV: Record<string, string | undefined> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_DB: 'sqlite',
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://cluster.test',
  LANDFLOW_EXECUTIONS_MODE: 'queue',
  LANDFLOW_QUEUE_ALLOW_SQLITE: 'true',
  LANDFLOW_INSTANCE_ID: 'main-test',
  LANDFLOW_QUEUE_PREFIX: 'landflow',
  LANDFLOW_WORKER_PORT: '0',
  LANDFLOW_ROLE: undefined,
  LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS: undefined,
};
const previousEnv = { ...process.env };
for (const [key, value] of Object.entries(ENV)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const { registry } = await import('@/lib/server/plugins/registry');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { recordVersion, versionFor } = await import('@/lib/server/versions');
const { bus, isRelayed } = await import('@/lib/server/bus');
const { waits } = await import('@/lib/server/waits');
const { runWorkflow, cancelQueuedExecution, stopAllExecutions, DuplicateRunError } = await import('@/lib/server/runner');
type RunOptions = Parameters<typeof runWorkflow>[0];
type RunReply = Parameters<NonNullable<RunOptions['onReply']>>[0];
const { startCluster, stopCluster, adoptOrphans, clusterOverview, leaderService } = await import('@/lib/server/cluster');
const { clusterState, delegated } = await import('@/lib/server/cluster/state');
const { MemoryCoordinator, MemoryHub } = await import('@/lib/server/cluster/memory');
const { Relay } = await import('@/lib/server/cluster/relay');
const { JobWorker, MAX_TAKEOVERS } = await import('@/lib/server/cluster/worker');
const { idempotencyClaim } = await import('@/lib/server/cluster/dispatch');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');

// ---------------------------------------------------------------------------
// Test nodes
// ---------------------------------------------------------------------------

const main = [{ type: 'main' as const }];

/** Holds every run that reaches it while closed, until released (oldest first). */
const gate = { closed: false, entered: [] as string[], held: [] as Array<{ executionId: string; release: () => void }> };
function release(count = 1) {
  for (const held of gate.held.splice(0, count)) held.release();
}
const counter = { calls: 0 };

registry.registerBuiltin(
  definePlugin({
    info: { id: 'cluster', name: 'Cluster test nodes', version: '0.0.1', description: 'Test nodes' },
    nodes: [
      defineNode({
        description: { name: 'gate', displayName: 'Gate', description: 'Holds while closed', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
        async execute(ctx) {
          gate.entered.push(ctx.getExecutionId());
          if (gate.closed) await new Promise<void>((resolve) => gate.held.push({ executionId: ctx.getExecutionId(), release: resolve }));
          return [ctx.getInputData()];
        },
      }),
      defineNode({
        description: { name: 'count', displayName: 'Count', description: 'Counts its calls', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
        execute(ctx) {
          counter.calls++;
          return [ctx.getInputData().map((item) => ({ json: { ...item.json, counted: counter.calls } }))];
        },
      }),
    ],
  }),
);

// ---------------------------------------------------------------------------
// The cluster: a main, another process on the same Valkey, and workers
// ---------------------------------------------------------------------------

const hub = new MemoryHub();
/** The main's connection. */
const valkey = new MemoryCoordinator(hub);
/** Another main on the same Valkey: it broadcasts control messages and hears what this one sends. */
const otherRelay = new Relay(new MemoryCoordinator(hub), 'main-other');
const heard: Array<{ channel: string; message: unknown }> = [];

const workers: Array<{ job: InstanceType<typeof JobWorker>; connection: InstanceType<typeof MemoryCoordinator> }> = [];
function worker(name: string, concurrency = 4) {
  const { config } = clusterState();
  const connection = new MemoryCoordinator(hub);
  const job = new JobWorker(connection, new Relay(new MemoryCoordinator(hub), config.instanceId), { ...config, workerConcurrency: concurrency }, name);
  workers.push({ job, connection });
  return job;
}
async function stopWorkers() {
  for (const { job, connection } of workers.splice(0)) {
    const stopped = job.stop(0);
    // Ends the blocking read at once (it would wait out its 2 s).
    await connection.close();
    await stopped;
  }
  clusterState().draining = false;
}

beforeAll(async () => {
  expect(await startCluster({ coordinator: valkey })).toBe(true);
  await ensureBootstrapped();
  await otherRelay.listen('control', (message) => heard.push({ channel: 'control', message }));
  await otherRelay.listen('bus', (message) => heard.push({ channel: 'bus', message }));
  await vi.waitFor(() => expect(clusterState().elector?.isLeader()).toBe(true), { timeout: 5_000, interval: 20 });
});

afterAll(async () => {
  release(gate.held.length);
  await stopWorkers();
  waits.stop();
  await stopCluster();
  await otherRelay.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(async () => {
  release(gate.held.length);
  gate.closed = false;
  gate.entered = [];
  counter.calls = 0;
  heard.length = 0;
  await stopWorkers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface N {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
}

function save(id: string, nodes: N[], edges: Array<[string, string]>, extra: Partial<Workflow> = {}): Workflow {
  const workflow = store.saveWorkflow({
    id,
    name: id,
    nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: 1, position: [i * 200, 0], parameters: n.parameters ?? {} })),
    connections: edges.map(([source, target], i) => ({ id: `e${i}`, type: 'main', source, target, sourceIndex: 0, targetIndex: 0 })),
    ...extra,
  } as Workflow);
  recordVersion(workflow);
  return workflow;
}

const start: N = { name: 'Start', type: 'core.manualTrigger' };
const node = (name: string, type: 'gate' | 'count'): N => ({ name, type: `cluster.${type}` });
const setFields = (name: string, values: Array<{ name: string; value: string }>): N => ({
  name,
  type: 'core.set',
  parameters: { mode: 'manual', includeOtherFields: true, fields: { values: values.map((v) => ({ type: 'string', ...v })) } },
});

/** Start a run (a webhook call by default); `started` resolves with its id once it exists. */
function begin(workflow: Workflow, extra: Partial<RunOptions> = {}) {
  let resolveId!: (id: string) => void;
  const started = new Promise<string>((resolve) => (resolveId = resolve));
  const done = runWorkflow({
    workflow,
    mode: 'webhook',
    startNodeId: workflow.nodes[0].id,
    triggerItems: [{ json: { n: 1 } }],
    ...extra,
    onStart: (id) => {
      resolveId(id);
      extra.onStart?.(id);
    },
  });
  done.catch(() => {});
  return { started, done };
}

const stored = (id: string) => store.getExecution(id);
const outputOf = (record: ExecutionRecord | undefined, name: string) => record?.runData[name]?.at(-1)?.outputs[0]?.map((i) => i.json);
const until = (check: () => void | Promise<void>, timeout = 15_000) => vi.waitFor(check, { timeout, interval: 20 });
const pendingJobs = () => hub.entries.size;

/** A run left by a process that stopped: Start and Before ran, the checkpoint after Before says Count runs next. */
function interrupted(id: string, workflow: Workflow, extra: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const record: ExecutionRecord = {
    executionId: id, workflowId: workflow.id, workflowName: workflow.name, mode: 'webhook', status: 'running', startedAt, finishedAt: '', durationMs: 0, runData: {}, executionOrder: [],
    versionId: versionFor(workflow)!.id, ...extra,
  };
  const run = (outputs: Array<Record<string, unknown>>): NodeRun => ({ startedAt, durationMs: 1, status: 'success', source: 'main', inputs: [[{ json: { n: 1 } }]], outputs: [outputs.map((json) => ({ json: json as never }))] });
  store.saveExecution(record);
  store.saveStep(id, 0, 'Start', run([{ n: 1 }]));
  store.saveStep(id, 1, 'Before', run([{ n: 1, b: '1' }]));
  const state = { version: 1 as const, startedAt, activeMs: 25, stack: [{ nodeId: 'Count', inputs: [[{ json: { n: 1, b: '1' } }]] }], parked: [], nodeOutputs: {}, runData: {}, executionOrder: [], nodeState: {}, lastNodeId: 'Before' };
  store.saveCheckpoint(id, { stepId: 'Before#0', steps: 2, baseSteps: 0, baseOutputs: {}, state });
  return record;
}

const resumable = () =>
  save('wf_q_resume', [start, setFields('Before', [{ name: 'b', value: '{{ $json.n }}' }]), node('Count', 'count'), setFields('After', [{ name: 'copy', value: "{{ $('Before').item.json.b }}" }])], [
    ['Start', 'Before'],
    ['Before', 'Count'],
    ['Count', 'After'],
  ]);

const jobFor = (record: ExecutionRecord, workflow: Workflow, extra: Partial<QueueJob> = {}): QueueJob => ({
  executionId: record.executionId, workflowId: workflow.id, expect: 'queued', record, workflow, engine: { startNodeId: 'Start' }, origin: 'main-test', enqueuedAt: new Date().toISOString(), ...extra,
});

// ---------------------------------------------------------------------------

describe('production runs go to the workers', () => {
  it('runs a webhook call on a worker; its events, Respond to Webhook reply and record come back to the main', async () => {
    const workflow = save('wf_q_hook', [start, node('Count', 'count'), { name: 'Respond', type: 'core.respondToWebhook', parameters: { respondWith: 'text', responseBody: 'done' } }], [
      ['Start', 'Count'],
      ['Count', 'Respond'],
    ]);
    worker('worker-a').start();
    const events: ExecutionEvent[] = [];
    const replies: RunReply[] = [];
    const record = await runWorkflow({ workflow, mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: { n: 1 } }], onEvent: (e) => events.push(e), onReply: (r) => replies.push(r) });

    expect(record.status).toBe('success');
    expect(outputOf(record, 'Count')).toEqual([{ n: 1, counted: 1 }]);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['execution.started', 'node.finished', 'execution.finished']));
    expect(replies).toMatchObject([{ type: 'webhook', status: 200, body: 'done' }]);
    expect(stored(record.executionId)?.status).toBe('success');
    // The worker acknowledged the job and dropped its keys.
    await until(() => expect(pendingJobs()).toBe(0));
    expect(hub.key(`job:${record.executionId}`)).toBeUndefined();
    await until(() => expect(hub.key(`lease:${record.executionId}`)).toBeUndefined());
  });

  it('answers a webhook route call with what the worker ran', async () => {
    save('wf_q_route', [{ name: 'Hook', type: 'core.webhook', parameters: { path: 'cluster-hook', method: 'POST', respond: 'lastNode' } }, setFields('Reply', [{ name: 'ok', value: 'yes' }])], [['Hook', 'Reply']], { active: true });
    worker('worker-a').start();
    const response = await webhookRoute.POST(
      new Request('http://cluster.test/api/webhook/cluster-hook', { method: 'POST', body: JSON.stringify({ x: 1 }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ path: ['cluster-hook'] }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: 'yes' });
    const executionId = response.headers.get('x-landflow-execution')!;
    expect(stored(executionId)).toMatchObject({ status: 'success', mode: 'webhook' });
  });

  it('answers an immediate webhook once the run is queued, without waiting for the worker', async () => {
    save('wf_q_now', [{ name: 'Hook', type: 'core.webhook', parameters: { path: 'cluster-now', method: 'POST', respond: 'immediately' } }, node('Gate', 'gate')], [['Hook', 'Gate']], { active: true });
    gate.closed = true;
    worker('worker-a').start();
    const response = await webhookRoute.POST(new Request('http://cluster.test/api/webhook/cluster-now', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), {
      params: Promise.resolve({ path: ['cluster-now'] }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; executionId: string };
    // Waiting for a worker is not the concurrency queue.
    expect(body.status).toBe('started');
    await until(() => expect(gate.held.map((h) => h.executionId)).toContain(body.executionId));
    release();
    await until(() => expect(stored(body.executionId)?.status).toBe('success'));
  });

  it('keeps editor runs in the main, and sends them to the workers with LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS', async () => {
    const workflow = save('wf_q_manual', [start, node('Count', 'count')], [['Start', 'Count']]);
    const before = hub.nextId();
    const manual = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(manual.status).toBe('success');
    expect([...hub.entries.keys()].filter((id) => id > before)).toEqual([]);

    const { config } = clusterState();
    config.offloadManual = true;
    try {
      const { started, done } = begin(workflow, { mode: 'manual' });
      const id = await started;
      expect(stored(id)).toMatchObject({ status: 'queued', queued: { worker: true } });
      expect(pendingJobs()).toBe(1);
      worker('worker-a').start();
      expect((await done).status).toBe('success');
    } finally {
      config.offloadManual = false;
    }
  });

  it('spreads runs over the workers', async () => {
    const workflow = save('wf_q_spread', [start, node('Gate', 'gate')], [['Start', 'Gate']]);
    const a = worker('worker-a', 1);
    const b = worker('worker-b', 1);
    a.start();
    b.start();
    gate.closed = true;
    const runs = [begin(workflow), begin(workflow)];
    await until(() => expect(gate.held).toHaveLength(2));
    expect([a.active, b.active]).toEqual([1, 1]);
    release(2);
    expect((await Promise.all(runs.map((run) => run.done))).map((r) => r.status)).toEqual(['success', 'success']);
  });
});

describe('across processes', () => {
  it('aborts a run on its worker when another main cancels it, and stops everything on stop-all', async () => {
    const workflow = save('wf_q_cancel', [start, node('Gate', 'gate')], [['Start', 'Gate']]);
    worker('worker-a').start();
    gate.closed = true;
    const first = begin(workflow);
    const id = await first.started;
    await until(() => expect(gate.held.map((h) => h.executionId)).toContain(id));
    await otherRelay.broadcast('control', { t: 'cancel', id });
    expect((await first.done).status).toBe('canceled');
    expect(stored(id)?.status).toBe('canceled');
    // The aborted node's promise stays parked at the gate: drop it.
    gate.held.splice(0);

    const runs = [begin(workflow), begin(workflow)];
    await until(() => expect(gate.held).toHaveLength(2));
    await otherRelay.broadcast('control', { t: 'stop-all' });
    expect((await Promise.all(runs.map((run) => run.done))).map((r) => r.status)).toEqual(['canceled', 'canceled']);
    gate.held.splice(0);

    // This main's Stop all reaches the other processes too.
    stopAllExecutions();
    await until(() => expect(heard).toContainEqual({ channel: 'control', message: { t: 'stop-all' } }));
  });

  it('never runs a job canceled before a worker took it', async () => {
    const workflow = save('wf_q_cancel_queued', [start, node('Gate', 'gate')], [['Start', 'Gate']]);
    const { started, done } = begin(workflow);
    const id = await started;
    expect(stored(id)?.status).toBe('queued');
    expect(cancelQueuedExecution(id)).toBe(true);
    await until(() => expect(hub.key(`canceled:${id}`)).toBe('1'));
    expect((await done).status).toBe('canceled');

    worker('worker-a').start();
    await until(() => expect(pendingJobs()).toBe(0));
    expect(gate.entered).not.toContain(id);
    expect(stored(id)?.status).toBe('canceled');
  });

  it('claims idempotency keys in Valkey: a key another main took answers with its run', async () => {
    const workflow = save('wf_q_idem', [start, node('Count', 'count')], [['Start', 'Count']]);
    hub.keys.set(idempotencyClaim(workflow.id, 'order-1'), { value: 'ex_elsewhere' });
    const duplicate = await runWorkflow({ workflow, mode: 'webhook', startNodeId: 'Start', idempotencyKey: 'order-1' }).catch((error: Error) => error);
    expect(duplicate).toBeInstanceOf(DuplicateRunError);
    expect((duplicate as InstanceType<typeof DuplicateRunError>).executionId).toBe('ex_elsewhere');
    expect(counter.calls).toBe(0);

    worker('worker-a').start();
    const record = await runWorkflow({ workflow, mode: 'webhook', startNodeId: 'Start', idempotencyKey: 'order-2' });
    expect(record.status).toBe('success');
    expect(hub.key(idempotencyClaim(workflow.id, 'order-2'))).toBe(record.executionId);
  });

  it('keeps a concurrency limit across processes: one run at a time, the rest in order from the shared FIFO', async () => {
    const workflow = save('wf_q_limit', [start, node('Gate', 'gate')], [['Start', 'Gate']], { settings: { concurrencyLimit: 1 } });
    worker('worker-a').start();
    gate.closed = true;
    const runs = [begin(workflow), begin(workflow), begin(workflow)];
    const ids: string[] = [];
    for (const run of runs) ids.push(await run.started);
    await until(() => expect(gate.held).toHaveLength(1));
    expect(await valkey.slotUsage(workflow.id)).toEqual({ running: 1, queued: 2 });
    expect(ids.map((id) => stored(id)?.status)).toEqual(['running', 'queued', 'queued']);

    for (const expected of ids) {
      await until(() => expect(gate.held.map((h) => h.executionId)).toEqual([expected]));
      release();
    }
    expect((await Promise.all(runs.map((run) => run.done))).map((r) => r.status)).toEqual(['success', 'success', 'success']);
    expect(gate.entered).toEqual(ids);
    await until(async () => expect(await valkey.slotUsage(workflow.id)).toEqual({ running: 0, queued: 0 }));
  });
});

describe('failures', () => {
  it('hands a stalled job to another worker, which continues the run from its last checkpoint', async () => {
    const workflow = resumable();
    const record = interrupted('ex_q_stalled', workflow);
    await valkey.set('job:ex_q_stalled', 'main-test', 60_000);
    await valkey.enqueue(jobFor(record, workflow));
    // The worker that took it died: it stopped touching the job.
    const [delivery] = await valkey.take('worker-dead', 1, 0);
    hub.pending.get(delivery.id)!.deliveredAt -= clusterState().config.stalledMs + 1_000;

    expect(await worker('worker-b').claim()).toBe(1);
    await until(() => expect(stored('ex_q_stalled')?.status).toBe('success'));
    const resumed = stored('ex_q_stalled')!;
    expect(resumed.resumedAfterRestart).toMatchObject({ stepId: 'Before#0' });
    expect(resumed.executionOrder).toEqual(['Start', 'Before', 'Count', 'After']);
    expect(outputOf(resumed, 'After')).toEqual([{ n: 1, b: '1', counted: 1, copy: '1' }]);
    expect(counter.calls).toBe(1);
    expect(hub.key('attempts:ex_q_stalled')).toBe('1');
    await until(() => expect(pendingJobs()).toBe(0));
  });

  it('drops a second job for a run the worker is already running', async () => {
    const workflow = save('wf_q_dup', [start, node('Gate', 'gate')], [['Start', 'Gate']]);
    worker('worker-a').start();
    gate.closed = true;
    const { started, done } = begin(workflow);
    const id = await started;
    await until(() => expect(gate.held.map((h) => h.executionId)).toEqual([id]));
    await valkey.enqueue(jobFor(stored(id)!, workflow, { expect: 'running' }));
    // Acknowledged and dropped: the first job is the only one left.
    await until(() => expect(pendingJobs()).toBe(1));
    release();
    expect((await done).status).toBe('success');
    expect(gate.entered).toEqual([id]);
    await until(() => expect(pendingJobs()).toBe(0));
  });

  it('puts what is still running back in the queue once, however often stop is called (SIGTERM)', async () => {
    const workflow = save('wf_q_term', [start, node('Gate', 'gate')], [['Start', 'Gate']]);
    const stopping = worker('worker-a');
    stopping.start();
    gate.closed = true;
    const { started, done } = begin(workflow);
    const id = await started;
    await until(() => expect(gate.held.map((h) => h.executionId)).toEqual([id]));
    const first = stopping.stop(0);
    expect(stopping.stop(0)).toBe(first);
    expect(await first).toBe(1);
    expect(hub.undelivered).toHaveLength(1);
    clusterState().draining = false;
    // Here the stopped worker's run goes on (its process would have exited): it finishes, and another worker reports it.
    gate.closed = false;
    release();
    await until(() => expect(stored(id)?.status).toBe('success'));
    worker('worker-b').start();
    expect((await done).status).toBe('success');
    await until(() => expect(pendingJobs()).toBe(0));
  });

  it(`fails a run that lost its worker more than ${MAX_TAKEOVERS} times`, async () => {
    const workflow = resumable();
    const record = interrupted('ex_q_doomed', workflow);
    await valkey.set('job:ex_q_doomed', 'main-test', 60_000);
    await valkey.set('attempts:ex_q_doomed', String(MAX_TAKEOVERS), 60_000);
    await valkey.enqueue(jobFor(record, workflow));
    worker('worker-a').start();
    await until(() => expect(stored('ex_q_doomed')?.status).toBe('error'));
    expect(stored('ex_q_doomed')?.error?.message).toMatch(/interrupted 5 times/);
    expect(counter.calls).toBe(0);
  });

  it('lets the leader hand a run nobody holds to a worker, and put a lost queued run back in its queue', async () => {
    const workflow = resumable();
    interrupted('ex_q_orphan', workflow);
    const queuedAt = new Date().toISOString();
    store.saveExecution({
      executionId: 'ex_q_lost', workflowId: workflow.id, workflowName: workflow.name, mode: 'webhook', status: 'queued', startedAt: queuedAt, finishedAt: '', durationMs: 0, runData: {}, executionOrder: [],
      versionId: versionFor(workflow)!.id, queued: { queuedAt, startNodeId: 'Start', triggerItems: [{ json: { n: 7 } }] },
    });
    // Seen once: it may be between processes. Seen again: adopted.
    expect(await adoptOrphans(valkey)).toBe(0);
    await adoptOrphans(valkey);
    expect(hub.key('job:ex_q_orphan')).toBeTruthy();
    worker('worker-a').start();
    await until(() => expect(stored('ex_q_orphan')?.status).toBe('success'));
    expect(stored('ex_q_orphan')?.resumedAfterRestart).toMatchObject({ stepId: 'Before#0' });
    await until(() => expect(stored('ex_q_lost')?.status).toBe('success'));
    expect(outputOf(stored('ex_q_lost'), 'Count')).toMatchObject([{ n: 7, b: '7' }]);
  });
});

describe('the shared data directory', () => {
  it('keeps an insights rollup per process and adds up all of them in a report', async () => {
    const { insightsRollup, insightsReport } = await import('@/lib/server/insights');
    expect(insightsRollup().path).toBe(join(dataDir, 'insights.main-test.json'));
    const workflow = save('wf_q_insights', [start, node('Count', 'count')], [['Start', 'Count']]);
    worker('worker-a').start();
    await runWorkflow({ workflow, mode: 'webhook', startNodeId: 'Start' });
    // What a worker on another host counted, in its own file.
    const hour = new Date().toISOString().slice(0, 13);
    const day = new Date().toISOString().slice(0, 10);
    const bucket = { production: { succeeded: 2, failed: 1, canceled: 0, durationMs: 30 } };
    writeFileSync(join(dataDir, 'insights.worker-far.json'), JSON.stringify({ version: 1, names: {}, days: { [workflow.id]: { [day]: bucket } }, hours: { [workflow.id]: { [hour]: bucket } } }));
    const row = insightsReport('24h').workflows.find((w) => w.workflowId === workflow.id);
    expect(row).toMatchObject({ runs: 4, succeeded: 3, failed: 1 });
  });
});

describe('the leader and the relay', () => {
  it('hands timers to the leader from a main that does not lead, and arms those handed to it', async () => {
    const state = clusterState();
    const elector = state.elector;
    state.elector = { isLeader: () => false } as never;
    try {
      expect(delegated()).toBe(true);
      waits.track({ executionId: 'ex_q_wait', status: 'waiting', wait: { until: new Date(Date.now() + 3_600_000).toISOString() } } as ExecutionRecord);
      expect(waits.pending()).not.toContain('ex_q_wait');
      await until(() => expect(heard).toContainEqual({ channel: 'control', message: { t: 'wait', id: 'ex_q_wait' } }));
    } finally {
      state.elector = elector;
    }

    const workflow = save('wf_q_wait', [start], []);
    const until1h = new Date(Date.now() + 3_600_000).toISOString();
    store.saveExecution({
      executionId: 'ex_q_waiting', workflowId: workflow.id, workflowName: workflow.name, mode: 'webhook', status: 'waiting', startedAt: new Date().toISOString(), finishedAt: '', durationMs: 0, runData: {}, executionOrder: [],
      wait: { until: until1h, resume: 'time' } as ExecutionRecord['wait'],
    });
    await otherRelay.broadcast('control', { t: 'wait', id: 'ex_q_waiting' });
    await until(() => expect(waits.pending()).toContain('ex_q_waiting'));
    waits.clear('ex_q_waiting');
  });

  it('shows other processes’ live events on this main’s bus, and sends its own to them once', async () => {
    const seen: Array<BusEvent & { seq: number }> = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event));
    const at = new Date().toISOString();
    try {
      const far: BusEvent = { channel: 'execution', workflowId: 'wf_far', event: { type: 'execution.finished', executionId: 'ex_far', status: 'success', durationMs: 1, at } };
      await otherRelay.broadcast('bus', far);
      await until(() => expect(seen.find((e) => e.channel === 'execution' && e.event.executionId === 'ex_far')).toBeTruthy());
      expect(isRelayed(seen.find((e) => e.channel === 'execution' && e.event.executionId === 'ex_far')!)).toBe(true);

      bus.publish({ channel: 'execution', workflowId: 'wf_near', event: { type: 'execution.finished', executionId: 'ex_near', status: 'success', durationMs: 1, at } });
      await until(() => expect(heard.filter((h) => h.channel === 'bus')).toHaveLength(1));
      expect(heard[0].message).toMatchObject({ workflowId: 'wf_near' });
      // A relayed event isn't sent back out.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(heard.filter((h) => h.channel === 'bus')).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('reports the cluster for Settings → Workers', async () => {
    const overview = await clusterOverview();
    expect(overview).toMatchObject({ mode: 'queue', database: 'sqlite', coordinator: 'memory', self: { id: 'main-test', role: 'main', leader: true }, leader: { holder: 'main-test' } });
    expect(overview.leader!.token).toBeGreaterThan(0);
    expect(overview.instances?.find((i) => i.id === 'main-test')).toMatchObject({ role: 'main', leader: true });
    expect(overview.settings).toMatchObject({ prefix: 'landflow', offloadManual: false, leaderTtlSeconds: 10, stalledSeconds: 30 });
  });

  it('runs leader services while this main leads, stops them when it steps down and keeps the scheduler state for the next leader', async () => {
    const calls: string[] = [];
    leaderService('test service', () => calls.push('start'), () => calls.push('stop'));
    expect(calls).toEqual(['start']);
    hub.keys.delete('scheduler:state');
    await clusterState().elector!.stop();
    expect(calls).toEqual(['start', 'stop']);
    expect(hub.key('scheduler:state')).toBeTruthy();
    expect((await valkey.leadership()).holder).toBeUndefined();
  });
});
