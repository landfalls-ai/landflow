/**
 * Debounce and batching of trigger events (lib/server/trigger-buffers.ts) and per-node rate limits (engine
 * `node.rateLimit`): held webhook events answer 202, debounced events collapse per key into one run after the
 * quiet window (or the max wait), batches start when full or on their timeout, manual runs are never held, held
 * events survive a restart, and rate-limited nodes queue across concurrent runs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { TriggerBatch, TriggerDebounce, Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-buffers-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://buffers.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { publishDraft } = await import('@/lib/server/publish');
const { runWorkflow, RunBufferedError } = await import('@/lib/server/runner');
const { TriggerBuffers, debounceKey, triggerBuffers } = await import('@/lib/server/trigger-buffers');
const { workflowSchema } = await import('@/lib/server/schemas');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');
const formRoute = await import('@/app/form/[...path]/route');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  triggerBuffers.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });

/** Webhook (with debounce or batch) → No-op, published. */
async function hookWorkflow(id: string, path: string, buffer: { debounce?: TriggerDebounce; batch?: TriggerBatch }): Promise<Workflow> {
  const workflow: Workflow = { id, name: id, nodes: [node('Hook', 'core.webhook', { path, method: 'POST', respond: 'immediately' }, buffer), node('Done', 'core.noOp')], connections: [edge('Hook', 'Done')] };
  store.saveWorkflow(workflow);
  await publishDraft(id, 'tester', 'buffers');
  return workflow;
}

const send = (path: string, body: Record<string, unknown>) =>
  webhookRoute.POST(new Request(`http://buffers.test/api/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ path: [path] }),
  });

const runsOf = (workflowId: string) => store.listExecutions({ workflowId }).filter((e) => e.status !== 'running');
/** The bodies a finished run's trigger received. */
const bodiesOf = (executionId: string) => store.getExecution(executionId)!.runData.Hook[0].outputs[0].map((item) => (item.json as { body: Record<string, unknown> }).body);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('debounce', () => {
  it('collapses events per key into one run with the last event, after the quiet window', async () => {
    await hookWorkflow('wf_debounce', 'debounce', { debounce: { windowSeconds: 0.3, key: '{{ $json.body.user }}' } });
    const answers = [];
    for (const n of [1, 2, 3]) {
      answers.push(await send('debounce', { user: 'ann', n }));
      await sleep(50);
    }
    answers.push(await send('debounce', { user: 'bob', n: 1 }));
    expect(answers.map((a) => a.status)).toEqual([202, 202, 202, 202]);
    const third = await answers[2].json();
    expect(third).toMatchObject({ status: 'debounced', count: 3, workflowId: 'wf_debounce' });
    expect(Date.parse(third.runsAt)).toBeGreaterThan(Date.now());
    // Nothing ran yet.
    expect(runsOf('wf_debounce')).toHaveLength(0);
    expect(triggerBuffers.pending('wf_debounce').map((p) => p.count).sort()).toEqual([1, 3]);

    await vi.waitFor(() => expect(runsOf('wf_debounce')).toHaveLength(2), { timeout: 3_000, interval: 50 });
    const runs = runsOf('wf_debounce').map((run) => store.getExecution(run.id)!);
    const ann = runs.find((run) => bodiesOf(run.executionId)[0].user === 'ann')!;
    expect(bodiesOf(ann.executionId)).toEqual([{ user: 'ann', n: 3 }]);
    expect(ann).toMatchObject({ mode: 'webhook', status: 'success', buffered: { kind: 'debounce', count: 3 } });
    expect(triggerBuffers.pending('wf_debounce')).toEqual([]);
  });

  it('“all” mode hands the run every event; maxWait caps how long a busy key waits', async () => {
    await hookWorkflow('wf_debounce_all', 'debounce-all', { debounce: { windowSeconds: 0.25, mode: 'all', maxWaitSeconds: 0.5 } });
    const started = Date.now();
    // An event every 100 ms keeps the window open; maxWait starts the run anyway.
    for (let n = 1; n <= 8; n++) {
      await send('debounce-all', { n });
      if (runsOf('wf_debounce_all').length) break;
      await sleep(100);
    }
    await vi.waitFor(() => expect(runsOf('wf_debounce_all').length).toBeGreaterThanOrEqual(1), { timeout: 3_000, interval: 25 });
    const first = store.getExecution(runsOf('wf_debounce_all').at(-1)!.id)!;
    expect(Date.parse(first.startedAt) - started).toBeLessThan(1_000);
    const bodies = bodiesOf(first.executionId);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.map((b) => b.n)).toEqual(bodies.map((_, i) => i + 1));
  });

  it('reads the key from the event item', () => {
    const workflow = { id: 'w', name: 'w', nodes: [], connections: [] } as Workflow;
    expect(debounceKey(workflow, { windowSeconds: 1, key: '{{ $json.body.user }}' }, { json: { body: { user: 'ann' } } })).toBe('ann');
    expect(debounceKey(workflow, { windowSeconds: 1, key: '{{ $json.body.id }}' }, { json: { body: { id: 7 } } })).toBe('7');
    expect(debounceKey(workflow, { windowSeconds: 1 }, { json: {} })).toBe('');
  });
});

describe('batching', () => {
  it('starts one run when the batch is full, and another on the timeout', async () => {
    await hookWorkflow('wf_batch', 'batch', { batch: { size: 3, timeoutSeconds: 0.4 } });
    const first = await (await send('batch', { n: 1 })).json();
    expect(first).toMatchObject({ status: 'batched', count: 1 });
    await send('batch', { n: 2 });
    const full = await send('batch', { n: 3 });
    expect(full.status).toBe(202);
    expect(await full.json()).toMatchObject({ status: 'batched', count: 3, started: true });
    await vi.waitFor(() => expect(runsOf('wf_batch')).toHaveLength(1), { timeout: 3_000, interval: 25 });
    const run = store.getExecution(runsOf('wf_batch')[0].id)!;
    expect(bodiesOf(run.executionId)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(run.buffered).toEqual({ kind: 'batch', count: 3 });

    // One more event: its run starts on the timeout with just that one.
    await send('batch', { n: 4 });
    await sleep(150);
    expect(runsOf('wf_batch')).toHaveLength(1);
    await vi.waitFor(() => expect(runsOf('wf_batch')).toHaveLength(2), { timeout: 3_000, interval: 25 });
    const late = runsOf('wf_batch').map((r) => store.getExecution(r.id)!).find((r) => r.executionId !== run.executionId)!;
    expect(bodiesOf(late.executionId)).toEqual([{ n: 4 }]);
  });
});

describe('what is never held', () => {
  it('manual runs start at once', async () => {
    const workflow = await hookWorkflow('wf_buffer_manual', 'buffer-manual', { debounce: { windowSeconds: 60 } });
    const record = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Hook', triggerItems: [{ json: { body: { now: true } } }] });
    expect(record.status).toBe('success');
    expect(triggerBuffers.pending('wf_buffer_manual')).toEqual([]);
  });

  it('production runs of the trigger reject with RunBufferedError (a skipped run for callers)', async () => {
    const workflow = await hookWorkflow('wf_buffer_reject', 'buffer-reject', { debounce: { windowSeconds: 60 } });
    await expect(runWorkflow({ workflow, mode: 'webhook', startNodeId: 'Hook', triggerItems: [{ json: {} }] })).rejects.toBeInstanceOf(RunBufferedError);
    expect(triggerBuffers.pending('wf_buffer_reject')).toHaveLength(1);
  });

  it('a held form submission gets the end screen, not “busy”', async () => {
    const trigger = node('Form', 'core.formTrigger', { path: 'buffer-form', formTitle: 'Held', formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] } }, {
      debounce: { windowSeconds: 60 },
    });
    store.saveWorkflow({ id: 'wf_buffer_form', name: 'wf_buffer_form', nodes: [trigger, node('Done', 'core.noOp')], connections: [edge('Form', 'Done')] });
    await publishDraft('wf_buffer_form', 'tester', 'buffers');
    const response = await formRoute.POST(new Request('http://buffers.test/form/buffer-form', { method: 'POST', body: new URLSearchParams({ f0: 'Ada' }) }), {
      params: Promise.resolve({ path: ['buffer-form'] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/busy/);
    expect(triggerBuffers.pending('wf_buffer_form')).toHaveLength(1);
  });
});

describe('restarts', () => {
  it('re-arms held events from the database at boot', async () => {
    const workflow = await hookWorkflow('wf_buffer_restart', 'buffer-restart', { batch: { size: 10, timeoutSeconds: 0.3 } });
    const before = new TriggerBuffers();
    before.add(workflow, workflow.nodes[0], [{ json: { body: { n: 1 } } }], 'webhook');
    before.add(workflow, workflow.nodes[0], [{ json: { body: { n: 2 } } }], 'webhook');
    // The process stops: its timers are gone.
    before.stop();
    const started: Array<{ items: unknown[]; meta: { kind: string; count: number } }> = [];
    const after = new TriggerBuffers();
    after.start(async (_workflow, _node, items, _mode, meta) => {
      started.push({ items, meta });
    });
    await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3_000, interval: 25 });
    expect(started[0]).toMatchObject({ meta: { kind: 'batch', count: 2 }, items: [{ json: { body: { n: 1 } } }, { json: { body: { n: 2 } } }] });
    expect(after.pending('wf_buffer_restart')).toEqual([]);
    after.stop();
  });
});

describe('rate limits', () => {
  it('queues a node’s calls across concurrent runs and logs the wait', async () => {
    const workflow: Workflow = {
      id: 'wf_rate',
      name: 'Rate',
      nodes: [node('Start', 'core.manualTrigger'), node('Limited', 'core.noOp', {}, { rateLimit: { limit: 1, intervalSeconds: 0.25 } })],
      connections: [edge('Start', 'Limited')],
    };
    store.saveWorkflow(workflow);
    const started = Date.now();
    const runs = await Promise.all([1, 2, 3].map(() => runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' })));
    const elapsed = Date.now() - started;
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    // Three calls, one per 250 ms: the third waits about 500 ms.
    expect(elapsed).toBeGreaterThanOrEqual(450);
    const logs = runs.flatMap((r) => r.runData.Limited[0].logs ?? []).map((l) => l.message);
    expect(logs.some((m) => /Rate limit \(1 per 0.25 s\): waited/.test(m))).toBe(true);
  });

  it('accepts rate limit, debounce and batch settings in saved workflows', () => {
    const parsed = workflowSchema.safeParse({
      id: 'w',
      name: 'w',
      nodes: [
        { ...node('Hook', 'core.webhook', {}, { debounce: { windowSeconds: 30, key: '{{ $json.body.user }}', mode: 'all', maxWaitSeconds: 120 } }) },
        { ...node('Hook2', 'core.webhook', {}, { batch: { size: 50, timeoutSeconds: 10 } }) },
        { ...node('Api', 'core.httpRequest', {}, { rateLimit: { limit: 5, intervalSeconds: 1 } }) },
      ],
      connections: [],
    });
    expect(parsed.success).toBe(true);
  });
});
