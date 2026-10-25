/**
 * The durable runtime through the runner and the HTTP routes: executions saved as they run (version id,
 * node runs, a checkpoint per node), crash recovery at boot (continue from the last checkpoint, or fail
 * with the reason), idempotency keys on webhooks, forms and the run API, per-workflow concurrency (FIFO
 * queue, skip, singleton, manual runs bypass), automatic and manual retries (linked executions, from the
 * failed node), per-node timeouts and stop-all.
 *
 * The boot test comes first: route handlers bootstrap too, and bootstrap recovers executions only once.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Many steps per test, each waiting on real runs: give a busy machine (the whole suite in parallel) time.
vi.setConfig({ testTimeout: 30_000 });
import { defineNode, definePlugin } from '@landflow/sdk';
import type { NodeRun, Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-durable-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://durable.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { retries, retryDueFor } = await import('@/lib/server/retries');
const { recordVersion } = await import('@/lib/server/versions');
const { rememberIdempotent } = await import('@/lib/server/idempotency');
const { workflowSchema } = await import('@/lib/server/schemas');
const { singleton } = await import('@/lib/server/singleton');
const runner = await import('@/lib/server/runner');
const { runWorkflow, recoverExecutions, startRecovery, DuplicateRunError, RunSkippedError, liveExecutions } = runner;
const webhookRoute = await import('@/app/api/webhook/[...path]/route');
const formRoute = await import('@/app/form/[...path]/route');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const executionRoute = await import('@/app/api/executions/[id]/route');
const retryRoute = await import('@/app/api/executions/[id]/retry/route');
const stopAllRoute = await import('@/app/api/executions/stop-all/route');

// ---------------------------------------------------------------------------
// Test nodes
// ---------------------------------------------------------------------------

const main = [{ type: 'main' as const }];

/** Holds every run that reaches it while closed, until released (oldest first). */
const gate = { closed: false, entered: [] as string[], held: [] as Array<{ executionId: string; release: () => void }> };
function release(count = 1) {
  for (const held of gate.held.splice(0, count)) held.release();
}

/** Fails while `failures` is above 0 (counting down), else passes its items on with the call number. */
const flaky = { failures: 0, calls: 0 };
const counter = { calls: 0 };

const durablePlugin = definePlugin({
  info: { id: 'durable', name: 'Durable test nodes', version: '0.0.1', description: 'Test nodes' },
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
      description: { name: 'flaky', displayName: 'Flaky', description: 'Fails a few times', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
      execute(ctx) {
        flaky.calls++;
        if (flaky.failures > 0) {
          flaky.failures--;
          throw new Error('flaky failure');
        }
        return [ctx.getInputData().map((item) => ({ json: { ...item.json, flakyCall: flaky.calls } }))];
      },
    }),
    defineNode({
      description: { name: 'count', displayName: 'Count', description: 'Counts its calls', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
      execute(ctx) {
        counter.calls++;
        return [ctx.getInputData().map((item) => ({ json: { ...item.json, counted: counter.calls } }))];
      },
    }),
    defineNode({
      description: {
        name: 'slow', displayName: 'Slow', description: 'Takes its time', version: 1, kind: 'action', inputs: main, outputs: main,
        properties: [{ name: 'ms', displayName: 'Milliseconds', type: 'number', default: 1000 }],
      },
      async execute(ctx) {
        await new Promise((resolve) => setTimeout(resolve, ctx.getNodeParameter<number>('ms', 0)));
        return [ctx.getInputData()];
      },
    }),
  ],
});

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(durablePlugin);

afterAll(() => {
  waits.stop();
  retries.stop();
  release(gate.held.length);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  // Whatever a failed test left at the gate goes on, so it doesn't hold up the next one.
  release(gate.held.length);
  gate.closed = false;
  gate.entered = [];
  flaky.failures = 0;
  flaky.calls = 0;
  counter.calls = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface N {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  typeVersion?: number;
  extra?: Record<string, unknown>;
}

/** Save a workflow (node ids are their names) and its version; edges are [source, target]. */
function save(id: string, nodes: N[], edges: Array<[string, string]>, extra: Partial<Workflow> = {}): Workflow {
  const workflow = store.saveWorkflow({
    id,
    name: id,
    nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: n.typeVersion ?? 1, position: [i * 200, 0], parameters: n.parameters ?? {}, ...n.extra })),
    connections: edges.map(([source, target], i) => ({ id: `e${i}`, type: 'main', source, target, sourceIndex: 0, targetIndex: 0 })),
    ...extra,
  } as Workflow);
  recordVersion(workflow);
  return workflow;
}

const start: N = { name: 'Start', type: 'core.manualTrigger' };
const node = (name: string, type: 'gate' | 'flaky' | 'count' | 'slow', parameters: Record<string, unknown> = {}, extra?: Record<string, unknown>): N => ({ name, type: `durable.${type}`, parameters, ...(extra && { extra }) });
const setFields = (name: string, values: Array<{ name: string; value: string }>): N => ({
  name,
  type: 'core.set',
  parameters: { mode: 'manual', includeOtherFields: true, fields: { values: values.map((v) => ({ type: 'string', ...v })) } },
});
const hook = (path: string, respond = 'lastNode'): N => ({ name: 'Hook', type: 'core.webhook', parameters: { path, method: 'POST', respond } });

const trigger = (workflow: Workflow, extra: Partial<Parameters<typeof runWorkflow>[0]> = {}) =>
  runWorkflow({ workflow, mode: 'trigger', startNodeId: workflow.nodes[0].id, triggerItems: [{ json: { n: 1 } }], ...extra });
/** Start a run and resolve with its id once it exists (it goes on in the background). onStart is called synchronously. */
async function startRun(workflow: Workflow, extra: Partial<Parameters<typeof runWorkflow>[0]> = {}) {
  let id = '';
  const done = trigger(workflow, { ...extra, onStart: (started) => (id = started) });
  if (!id) await done;
  return { id, done };
}

const stored = (id: string) => store.getExecution(id);
const outputOf = (record: ExecutionRecord | undefined, name: string) => record?.runData[name]?.at(-1)?.outputs[0]?.map((i) => i.json);
const request = (url: string, init: RequestInit = {}) => new Request(`http://durable.test${url}`, init);
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const until = (check: () => void, timeout = 15_000) => vi.waitFor(check, { timeout, interval: 20 });
const live = singleton('live-executions', () => new Map<string, unknown>());

// ---------------------------------------------------------------------------

describe('boot', () => {
  it('continues the executions a restart interrupted from their last checkpoint, and fails the ones it cannot', async () => {
    const workflow = save('wf_boot', [start, setFields('Before', [{ name: 'b', value: '{{ $json.n }}' }]), node('Count', 'count'), setFields('After', [{ name: 'copy', value: "{{ $('Before').item.json.b }}" }])], [
      ['Start', 'Before'],
      ['Before', 'Count'],
      ['Count', 'After'],
    ]);
    const versionId = store.getWorkflow('wf_boot') && (await import('@/lib/server/versions')).versionFor(workflow)!.id;
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const base = (id: string, extra: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
      executionId: id, workflowId: workflow.id, workflowName: workflow.name, mode: 'trigger', status: 'running', startedAt, finishedAt: '', durationMs: 0, runData: {}, executionOrder: [], ...extra,
    });
    // What the previous process left: the trigger and "Before" ran; the checkpoint after "Before" says "Count" runs next.
    const run = (outputs: Array<Record<string, unknown>>): NodeRun => ({ startedAt, durationMs: 1, status: 'success', source: 'main', inputs: [[{ json: { n: 1 } }]], outputs: [outputs.map((json) => ({ json: json as never }))] });
    store.saveExecution(base('ex_boot_resume', { versionId }));
    store.saveStep('ex_boot_resume', 0, 'Start', run([{ n: 1 }]));
    store.saveStep('ex_boot_resume', 1, 'Before', run([{ n: 1, b: '1' }]));
    // A node run after the checkpoint (Count was running when the host died): not reused, Count runs again.
    store.saveStep('ex_boot_resume', 2, 'Count', run([{ n: 1, b: '1', counted: 99 }]));
    const state = { version: 1 as const, startedAt, activeMs: 25, stack: [{ nodeId: 'Count', inputs: [[{ json: { n: 1, b: '1' } }]] }], parked: [], nodeOutputs: {}, runData: {}, executionOrder: [], nodeState: {}, lastNodeId: 'Before' };
    store.saveCheckpoint('ex_boot_resume', { stepId: 'Before#0', steps: 2, baseSteps: 0, baseOutputs: {}, state });
    // Its version is gone (and it saved no graph of its own).
    store.saveExecution(base('ex_boot_gone', { versionId: 'v_gone' }));
    store.saveCheckpoint('ex_boot_gone', { stepId: 'start', steps: 0, baseSteps: 0, state: { ...state, stack: [] } });
    // A debug session can't go on without its debugger.
    store.saveExecution(base('ex_boot_debug', { debug: true, workflow }));
    // It never got to its first checkpoint.
    store.saveExecution(base('ex_boot_nocp', { workflow }));

    startRecovery(0);
    await ensureBootstrapped();
    await until(() => expect(stored('ex_boot_resume')?.status).toBe('success'));

    const resumed = stored('ex_boot_resume')!;
    expect(resumed.resumedAfterRestart).toMatchObject({ stepId: 'Before#0' });
    expect(resumed.executionOrder).toEqual(['Start', 'Before', 'Count', 'After']);
    expect(resumed.startedAt).toBe(startedAt);
    expect(counter.calls).toBe(1);
    // `$('Before')` still resolves: its output came from the saved node runs.
    expect(outputOf(resumed, 'After')).toEqual([{ n: 1, b: '1', counted: 1, copy: '1' }]);
    expect(resumed.versionId).toBe(versionId);
    expect(store.getCheckpoint('ex_boot_resume')).toBeUndefined();
    expect(store.steps('ex_boot_resume')).toEqual([]);
    expect(store.listExecutions({ workflowId: workflow.id }).find((e) => e.id === 'ex_boot_resume')).toMatchObject({ resumedAfterRestart: true, versionId });

    await until(() => expect(stored('ex_boot_gone')?.status).toBe('error'));
    expect(stored('ex_boot_gone')?.error?.message).toBe('Could not continue after the restart: workflow version v_gone no longer exists');
    expect(stored('ex_boot_debug')).toMatchObject({ status: 'canceled', error: { message: 'The debug session ended when the host restarted' } });
    expect(stored('ex_boot_nocp')?.error?.message).toMatch(/stopped before the execution saved a checkpoint/);
  }, 10_000);
});

describe('saved as it runs', () => {
  it('saves a running execution with its version, its node runs and a checkpoint after each node, then clears them', async () => {
    const workflow = save('wf_progress', [start, setFields('Before', [{ name: 'b', value: 'x' }]), node('Gate', 'gate'), setFields('After', [{ name: 'a', value: 'y' }])], [
      ['Start', 'Before'],
      ['Before', 'Gate'],
      ['Gate', 'After'],
    ]);
    gate.closed = true;
    const { id, done } = await startRun(workflow);
    await until(() => expect(gate.held.map((h) => h.executionId)).toContain(id));

    const running = stored(id)!;
    expect(running.status).toBe('running');
    expect(running.versionId).toBeTruthy();
    expect(running.workflow).toBeUndefined();
    expect(store.steps(id).map((s) => s.nodeId)).toEqual(['Start', 'Before']);
    expect(store.getCheckpoint(id)).toMatchObject({ stepId: 'Before#0', steps: 2 });
    expect(store.getCheckpoint(id)?.state.stack.map((e) => e.nodeId)).toEqual(['Gate']);
    // Listed once: by the runner while it runs.
    expect(liveExecutions(workflow.id).map((e) => e.id)).toEqual([id]);
    expect(store.listExecutions({ workflowId: workflow.id })).toEqual([]);

    release();
    const finished = await done;
    expect(finished.status).toBe('success');
    expect(stored(id)?.versionId).toBe(running.versionId);
    expect(store.steps(id)).toEqual([]);
    expect(store.getCheckpoint(id)).toBeUndefined();
  });

  it('records the graph of an unsaved draft with the execution (it has no version)', async () => {
    const workflow = save('wf_draft', [start, node('Gate', 'gate')], [['Start', 'Gate']]);
    gate.closed = true;
    const draft = { ...workflow, nodes: [...workflow.nodes, { id: 'Extra', name: 'Extra', type: 'core.noOp', typeVersion: 1, position: [400, 0] as [number, number], parameters: {} }] };
    const { id, done } = await startRun(draft);
    await until(() => expect(gate.held.length).toBe(1));
    expect(stored(id)?.versionId).toBeUndefined();
    expect(stored(id)?.workflow?.nodes.map((n) => n.id)).toContain('Extra');
    release();
    await done;
  });

  it('continues a run whose host died mid-run from its last checkpoint', async () => {
    const workflow = save('wf_crash', [start, node('Count', 'count'), node('Gate', 'gate'), setFields('After', [{ name: 'counted again', value: "{{ $('Count').item.json.counted }}" }])], [
      ['Start', 'Count'],
      ['Count', 'Gate'],
      ['Gate', 'After'],
    ]);
    gate.closed = true;
    const { id } = await startRun(workflow);
    await until(() => expect(gate.held.map((h) => h.executionId)).toContain(id));
    // The process "dies": what it held in memory is gone, the database keeps what it saved. (The old run stays stuck at the gate.)
    live.delete(id);
    gate.held.splice(0);
    gate.closed = false;

    const report = recoverExecutions();
    expect(report.resumed).toContain(id);
    await until(() => expect(stored(id)?.status).toBe('success'));
    const record = stored(id)!;
    expect(record.executionOrder).toEqual(['Start', 'Count', 'Gate', 'After']);
    // What ran before the checkpoint isn't run again.
    expect(counter.calls).toBe(1);
    expect(outputOf(record, 'After')?.[0]).toMatchObject({ counted: 1, 'counted again': '1' });
    expect(record.resumedAfterRestart?.stepId).toBe('Count#0');
  });
});

describe('idempotency', () => {
  it('starts one run per key and workflow within the retention window', async () => {
    const workflow = save('wf_idem', [start, node('Count', 'count')], [['Start', 'Count']]);
    const other = save('wf_idem_other', [start, node('Count', 'count')], [['Start', 'Count']]);
    const first = await trigger(workflow, { mode: 'webhook', idempotencyKey: 'order-1' });
    await expect(trigger(workflow, { mode: 'webhook', idempotencyKey: 'order-1' })).rejects.toMatchObject({ name: 'DuplicateRunError', executionId: first.executionId });
    await expect(trigger(workflow, { mode: 'webhook', idempotencyKey: ' order-1 ' })).rejects.toBeInstanceOf(DuplicateRunError);
    // Another workflow, or another key: a new run.
    expect((await trigger(other, { mode: 'webhook', idempotencyKey: 'order-1' })).status).toBe('success');
    expect((await trigger(workflow, { mode: 'webhook', idempotencyKey: 'order-2' })).status).toBe('success');
    expect(first.idempotencyKey).toBe('order-1');
    // Past the window the key is free again.
    rememberIdempotent(workflow.id, 'order-old', first.executionId, Date.now() - 48 * 3_600_000);
    expect((await trigger(workflow, { mode: 'webhook', idempotencyKey: 'order-old' })).status).toBe('success');
    expect(counter.calls).toBe(4);
  });

  it('answers a repeated webhook call with the first run instead of starting another', async () => {
    const workflow = save('wf_idem_hook', [hook('durable-idem'), setFields('Reply', [{ name: 'ok', value: 'yes' }])], [['Hook', 'Reply']], { active: true });
    const call = (key?: string) =>
      webhookRoute.POST(
        request('/api/webhook/durable-idem', { method: 'POST', body: JSON.stringify({ x: 1 }), headers: { 'content-type': 'application/json', ...(key && { 'idempotency-key': key }) } }),
        params({ path: ['durable-idem'] }),
      );
    const first = await call('k-1');
    expect(first.status).toBe(200);
    const executionId = first.headers.get('x-landflow-execution');
    const firstBody = await first.json();
    const again = await call('k-1');
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.headers.get('x-landflow-execution')).toBe(executionId);
    expect(await again.json()).toEqual(firstBody);
    expect(store.listExecutions({ workflowId: workflow.id })).toHaveLength(1);
    expect((await call()).headers.get('idempotent-replayed')).toBeNull();
    expect(store.listExecutions({ workflowId: workflow.id })).toHaveLength(2);
  });

  it('shows the end screen again for a repeated form submission', async () => {
    const fields = { values: [{ fieldLabel: 'Name', fieldType: 'text', requiredField: true }] };
    const workflow = save('wf_idem_form', [{ name: 'Form', type: 'core.formTrigger', parameters: { path: 'durable-form', formTitle: 'Sign up', formFields: fields, options: { formSubmittedText: 'Got it' } } }, node('Count', 'count')], [['Form', 'Count']], {
      active: true,
    });
    const submit = () =>
      formRoute.POST(
        request('/form/durable-form', { method: 'POST', body: new URLSearchParams({ f0: 'Ada' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'form-1' } }),
        params({ path: ['durable-form'] }),
      );
    expect((await submit()).status).toBe(200);
    const repeated = await submit();
    expect(repeated.headers.get('idempotent-replayed')).toBe('true');
    expect(await repeated.text()).toContain('Got it');
    await until(() => expect(store.listExecutions({ workflowId: workflow.id })).toHaveLength(1));
  });

  it('names the existing execution on the run API', async () => {
    const workflow = save('wf_idem_api', [start, node('Count', 'count')], [['Start', 'Count']]);
    const call = async () => {
      const response = await runRoute.POST(request(`/api/workflows/${workflow.id}/run`, { method: 'POST', body: JSON.stringify({ idempotencyKey: 'api-1' }), headers: { 'content-type': 'application/json' } }), params({ id: workflow.id }));
      return response.text();
    };
    const first = await call();
    const id = /"executionId":"(ex_[\w-]+)"/.exec(first)?.[1];
    const second = await call();
    expect(second).toContain('"duplicate":true');
    expect(second).toContain(`"executionId":"${id}"`);
    expect(counter.calls).toBe(1);
  });
});

describe('concurrency', () => {
  it('queues runs over the limit and starts them first in, first out', async () => {
    const workflow = save('wf_queue', [start, node('Gate', 'gate')], [['Start', 'Gate']], { settings: { concurrencyLimit: 1 } });
    gate.closed = true;
    const first = await startRun(workflow, { mode: 'webhook' });
    const second = await startRun(workflow, { mode: 'webhook' });
    const third = await startRun(workflow, { mode: 'webhook' });
    await until(() => expect(gate.held).toHaveLength(1));
    expect(stored(second.id)).toMatchObject({ status: 'queued', queued: { startNodeId: 'Start', triggerItems: [{ json: { n: 1 } }] } });
    expect(stored(third.id)?.status).toBe('queued');
    expect(store.listExecutions({ workflowId: workflow.id }).map((e) => e.status)).toEqual(['queued', 'queued']);

    // A manual run from the editor isn't held back.
    const manual = await startRun(workflow, { mode: 'manual' });
    await until(() => expect(gate.held).toHaveLength(2));
    release(2);
    expect((await first.done).status).toBe('success');
    await manual.done;
    await until(() => expect(gate.held.map((h) => h.executionId)).toEqual([second.id]));
    release();
    expect((await second.done).status).toBe('success');
    await until(() => expect(gate.held.map((h) => h.executionId)).toEqual([third.id]));
    release();
    expect((await third.done).status).toBe('success');
    expect(gate.entered.filter((id) => id !== manual.id)).toEqual([first.id, second.id, third.id]);
  });

  it('skips runs over the limit when set to, and bounds the queue', async () => {
    const skipping = save('wf_skip', [start, node('Gate', 'gate')], [['Start', 'Gate']], { settings: { singleton: true, concurrencyOverflow: 'skip' } });
    gate.closed = true;
    const first = await startRun(skipping, { mode: 'trigger' });
    await expect(trigger(skipping)).rejects.toMatchObject({ name: 'RunSkippedError', reason: 'singleton' });
    await until(() => expect(gate.held).toHaveLength(1));
    release();
    await first.done;

    const bounded = save('wf_bounded', [start, node('Gate', 'gate')], [['Start', 'Gate']], { settings: { concurrencyLimit: 1, concurrencyQueueSize: 1 } });
    const running = await startRun(bounded);
    await until(() => expect(gate.held).toHaveLength(1));
    const queued = await startRun(bounded);
    await expect(trigger(bounded)).rejects.toBeInstanceOf(RunSkippedError);
    await expect(trigger(bounded)).rejects.toMatchObject({ reason: 'queue-full' });
    // Canceling a queued run: it never starts.
    const response = await executionRoute.DELETE(request(`/api/executions/${queued.id}`, { method: 'DELETE' }), params({ id: queued.id }));
    expect(await response.json()).toEqual({ canceled: true });
    expect((await queued.done).status).toBe('canceled');
    release();
    await running.done;
    expect(gate.entered).not.toContain(queued.id);
  });

  it('counts waiting runs against a singleton', async () => {
    const workflow = save('wf_singleton_wait', [start, { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'timeInterval', amount: 2, unit: 'hours' } }], [['Start', 'Wait']], {
      settings: { singleton: true, concurrencyOverflow: 'skip' },
    });
    expect((await trigger(workflow)).status).toBe('waiting');
    await expect(trigger(workflow)).rejects.toMatchObject({ reason: 'singleton' });
  });

  it('answers 429 on a webhook when the run is skipped', async () => {
    save('wf_hook_skip', [hook('durable-skip', 'immediately'), node('Gate', 'gate')], [['Hook', 'Gate']], { active: true, settings: { concurrencyLimit: 1, concurrencyOverflow: 'skip' } });
    gate.closed = true;
    const call = () => webhookRoute.POST(request('/api/webhook/durable-skip', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), params({ path: ['durable-skip'] }));
    expect((await call()).status).toBe(202);
    await until(() => expect(gate.held).toHaveLength(1));
    const skipped = await call();
    expect(skipped.status).toBe(429);
    expect((await skipped.json()).reason).toBe('limit');
    release();
  });
});

describe('retries', () => {
  const failing = (id: string, settings: Workflow['settings']) =>
    save(id, [start, node('Count', 'count'), node('Flaky', 'flaky'), setFields('After', [{ name: 'done', value: 'yes' }])], [
      ['Start', 'Count'],
      ['Count', 'Flaky'],
      ['Flaky', 'After'],
    ], { settings });

  it('retries a failed production run with backoff until it succeeds, linking the executions', async () => {
    const workflow = failing('wf_retry_auto', { retryMaxAttempts: 3, retryBaseDelaySeconds: 0 });
    flaky.failures = 2;
    const first = await trigger(workflow);
    expect(first.status).toBe('error');
    expect(first.retryAt).toBeTruthy();
    await until(() => expect(store.listExecutions({ workflowId: workflow.id }).filter((e) => e.status === 'success')).toHaveLength(1));
    const list = store.listExecutions({ workflowId: workflow.id }).reverse();
    expect(list.map((e) => e.status)).toEqual(['error', 'error', 'success']);
    const [a, b, c] = list.map((e) => stored(e.id)!);
    expect(a.retriedBy).toBe(b.executionId);
    expect(a.retryAt).toBeUndefined();
    expect([b.retryOf, b.retryAttempt, c.retryOf, c.retryAttempt]).toEqual([a.executionId, 1, b.executionId, 2]);
    // From the failed node: "Count" ran once, the retries reused it.
    expect(counter.calls).toBe(1);
    expect(c.runData.Count[0].reused).toBeTruthy();
    expect(outputOf(c, 'After')?.[0]).toMatchObject({ done: 'yes', counted: 1 });
    expect(list[1]).toMatchObject({ retryOf: a.executionId, retryAttempt: 1 });
  });

  it('stops after the last attempt, never retries manual runs, and doubles the delay', async () => {
    const workflow = failing('wf_retry_limit', { retryMaxAttempts: 2, retryBaseDelaySeconds: 0 });
    flaky.failures = 10;
    await trigger(workflow);
    await until(() => expect(store.listExecutions({ workflowId: workflow.id })).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.listExecutions({ workflowId: workflow.id })).toHaveLength(2);
    expect(store.listExecutions({ workflowId: workflow.id }).map((e) => stored(e.id)?.retryAt)).toEqual([undefined, undefined]);

    const manual = await trigger(workflow, { mode: 'manual' });
    expect(manual.retryAt).toBeUndefined();

    const now = Date.parse('2026-10-25T12:00:00Z');
    const slow = { ...workflow, settings: { retryMaxAttempts: 5, retryBaseDelaySeconds: 10 } };
    const due = (attempt: number) => retryDueFor({ ...manual, mode: 'trigger', retryAttempt: attempt || undefined }, slow, now)?.at;
    expect([due(0), due(1), due(2)]).toEqual(['2026-10-25T12:00:10.000Z', '2026-10-25T12:00:20.000Z', '2026-10-25T12:00:40.000Z']);
    expect(due(4)).toBeUndefined();
  });

  it('retries by hand from the failed node or from the start', async () => {
    const workflow = failing('wf_retry_manual', {});
    flaky.failures = 1;
    const failed = await trigger(workflow);
    expect(failed.status).toBe('error');
    expect(store.getCheckpoint(failed.executionId)?.stepId).toBe('Count#0');

    const response = await retryRoute.POST(request(`/api/executions/${failed.executionId}/retry`, { method: 'POST' }), params({ id: failed.executionId }));
    expect(response.status).toBe(202);
    const { executionId } = await response.json();
    await until(() => expect(stored(executionId)?.status).toBe('success'));
    const retried = stored(executionId)!;
    expect(retried).toMatchObject({ retryOf: failed.executionId, retryAttempt: 1 });
    expect(retried.runData.Count[0].reused).toEqual({ executionId: failed.executionId });
    expect(counter.calls).toBe(1);
    expect(stored(failed.executionId)?.retriedBy).toBe(executionId);

    const fromStart = await retryRoute.POST(request(`/api/executions/${failed.executionId}/retry`, { method: 'POST', body: JSON.stringify({ from: 'start' }) }), params({ id: failed.executionId }));
    const again = (await fromStart.json()).executionId as string;
    await until(() => expect(stored(again)?.status).toBe('success'));
    expect(stored(again)!.runData.Count[0].reused).toBeUndefined();
    expect(counter.calls).toBe(2);

    const notFailed = await retryRoute.POST(request(`/api/executions/${again}/retry`, { method: 'POST' }), params({ id: again }));
    expect(notFailed.status).toBe(409);
  });
});

describe('node timeout', () => {
  it('fails a node that runs past its timeoutSeconds', async () => {
    const workflow = save('wf_node_timeout', [start, node('Slow', 'slow', { ms: 5_000 }, { timeoutSeconds: 0.05 })], [['Start', 'Slow']]);
    const record = await trigger(workflow);
    expect(record.status).toBe('error');
    expect(record.error).toMatchObject({ message: 'Node timed out after 0.05 s', nodeName: 'Slow' });
  });

  it('keeps timeoutSeconds and the flow-control settings through the workflow schema', () => {
    const parsed = workflowSchema.parse({
      name: 'Schema',
      nodes: [{ id: 'a', name: 'A', type: 'core.noOp', position: [0, 0], timeoutSeconds: 30 }],
      settings: { concurrencyLimit: 2, singleton: false, concurrencyOverflow: 'skip', concurrencyQueueSize: 10, retryMaxAttempts: 3, retryBaseDelaySeconds: 60 },
    });
    expect(parsed.nodes[0].timeoutSeconds).toBe(30);
    expect(parsed.settings).toEqual({ concurrencyLimit: 2, singleton: false, concurrencyOverflow: 'skip', concurrencyQueueSize: 10, retryMaxAttempts: 3, retryBaseDelaySeconds: 60 });
    expect(workflowSchema.safeParse({ name: 'Bad', settings: { concurrencyOverflow: 'drop' } }).success).toBe(false);
  });
});

describe('stop all', () => {
  it('aborts running runs, cancels waiting and queued ones and drops pending retries', async () => {
    const gated = save('wf_stop', [start, node('Gate', 'gate')], [['Start', 'Gate']], { settings: { concurrencyLimit: 1 } });
    const waiting = save('wf_stop_wait', [start, { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'timeInterval', amount: 2, unit: 'hours' } }], [['Start', 'Wait']]);
    const failing = save('wf_stop_retry', [start, node('Flaky', 'flaky')], [['Start', 'Flaky']], { settings: { retryMaxAttempts: 3, retryBaseDelaySeconds: 3600 } });
    gate.closed = true;
    const running = await startRun(gated);
    const queued = await startRun(gated);
    const waited = await trigger(waiting);
    flaky.failures = 1;
    const failed = await trigger(failing);
    expect(retries.pending()).toContain(failed.executionId);
    await until(() => expect(gate.held).toHaveLength(1));

    // Earlier tests left waiting runs too: every one of them goes.
    const waitingNow = store.waitingExecutions().length;
    expect(waitingNow).toBeGreaterThanOrEqual(1);
    const response = await stopAllRoute.POST();
    expect(await response.json()).toEqual({ running: 1, waiting: waitingNow, queued: 1, retries: 1 });
    expect(store.waitingExecutions()).toEqual([]);
    expect((await running.done).status).toBe('canceled');
    expect((await queued.done).status).toBe('canceled');
    expect(stored(waited.executionId)?.status).toBe('canceled');
    expect(retries.pending()).not.toContain(failed.executionId);
    expect(stored(failed.executionId)?.retryAt).toBeUndefined();
    expect(gate.entered).not.toContain(queued.id);
    gate.held.splice(0);
  });
});
