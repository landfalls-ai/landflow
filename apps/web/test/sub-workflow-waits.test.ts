/**
 * Execute Workflow in "Run Once for Each Item" mode with waiting children, through the runner: the parent waits for
 * every child that waits and resumes once the last one finished, with the outputs in item order (pairedItem kept),
 * whatever order they finish in; children finishing at the same moment resume it once; a failed child fails the parent
 * (and cancels the open ones) or, with continue on error, becomes an error item; stopping the parent (waiting, mid-way
 * or by its timeout) cancels the children it waits for; and a restart while children wait, children that finished
 * while nobody listened, and a run continued after a crash in the middle of the step.
 *
 * Queue mode (children and the parent resumed on different workers) is in cluster-runtime.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { NodeRun, Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-subwaits-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://subwaits.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { closeDatabase } = await import('@/lib/server/db');
const { singleton } = await import('@/lib/server/singleton');
const { logger } = await import('@/lib/server/telemetry');
const { runWorkflow, resumeExecution, cancelExecution, cancelWaitingExecution, recoverExecutions } = await import('@/lib/server/runner');
const { settleChildren, reconcileWaitingParents } = await import('@/lib/server/sub-executions');
type EachWait = import('@/lib/server/sub-executions').EachWait;

// ---------------------------------------------------------------------------
// Test nodes
// ---------------------------------------------------------------------------

const main = [{ type: 'main' as const }];
/** Holds items with `hold: true` while closed. */
const gate = { closed: false, held: [] as Array<() => void> };

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'subwaits', name: 'Sub-workflow wait test nodes', version: '0.0.1', description: 'Test nodes' },
    nodes: [
      defineNode({
        description: { name: 'failIf', displayName: 'Fail If', description: 'Fails on items with fail: true', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
        execute(ctx) {
          if (ctx.getInputData().some((item) => item.json.fail)) throw new Error('child broke');
          return [ctx.getInputData()];
        },
      }),
      defineNode({
        description: { name: 'gate', displayName: 'Gate', description: 'Holds items with hold: true while closed', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
        async execute(ctx) {
          if (gate.closed && ctx.getInputData().some((item) => item.json.hold)) await new Promise<void>((resolve) => gate.held.push(resolve));
          return [ctx.getInputData()];
        },
      }),
    ],
  }),
);

afterAll(() => {
  waits.stop();
  for (const release of gate.held.splice(0)) release();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key as keyof typeof ENV] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key as keyof typeof ENV];
  }
});

beforeEach(() => {
  for (const release of gate.held.splice(0)) release();
  gate.closed = false;
  vi.restoreAllMocks();
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

function save(id: string, nodes: N[], edges: Array<[string, string]>, extra: Partial<Workflow> = {}): Workflow {
  return store.saveWorkflow({
    id,
    name: id,
    nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: n.typeVersion ?? 1, position: [i * 200, 0], parameters: n.parameters ?? {}, ...n.extra })),
    connections: edges.map(([source, target], i) => ({ id: `e${i}`, type: 'main', source, target, sourceIndex: 0, targetIndex: 0 })),
    ...extra,
  } as Workflow);
}

/** The child: waits `hours` (0: not at all), fails on `fail: true`, holds on `hold: true` while the gate is closed, answers "done <n>". */
const kid = (id: string, extra: Partial<Workflow> = {}) =>
  save(
    id,
    [
      { name: 'Called', type: 'core.workflowTrigger', parameters: { inputSource: 'passthrough' } },
      { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'timeInterval', amount: '{{ $json.hours }}', unit: 'hours' } },
      { name: 'Check', type: 'subwaits.failIf' },
      { name: 'Gate', type: 'subwaits.gate' },
      { name: 'Result', type: 'core.set', parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'answer', type: 'string', value: 'done {{ $json.n }}' }] } } },
    ],
    [
      ['Called', 'Wait'],
      ['Wait', 'Check'],
      ['Check', 'Gate'],
      ['Gate', 'Result'],
    ],
    extra,
  );
kid('wf_kid');
// Its successful runs aren't kept: what a finished child returns only exists in memory.
kid('wf_kid_unsaved', { settings: { saveSuccessfulExecutions: false } });

/** Start → Execute Workflow (wf_kid, once per item, waiting for it) → After. */
const caller = (id: string, parameters: Record<string, unknown> = {}, extra: Partial<Workflow> = {}, run: Record<string, unknown> = {}) =>
  save(
    id,
    [{ name: 'Start', type: 'core.manualTrigger' }, { name: 'Run', type: 'core.executeWorkflow', parameters: { workflowId: 'wf_kid', mode: 'each', ...parameters }, extra: run }, { name: 'After', type: 'core.noOp' }],
    [
      ['Start', 'Run'],
      ['Run', 'After'],
    ],
    extra,
  );

const trigger = (workflow: Workflow, items: Array<Record<string, unknown>>, extra: Partial<Parameters<typeof runWorkflow>[0]> = {}) =>
  runWorkflow({ workflow, mode: 'trigger', startNodeId: 'Start', triggerItems: items.map((json) => ({ json: json as never })), ...extra });

const stored = (id: string) => store.getExecution(id);
const kidsOf = (record: ExecutionRecord | undefined) => (record?.subExecutions ?? []).map((sub) => sub.executionId);
const waitData = (id: string) => stored(id)?.wait?.data as unknown as EachWait;
const outputOf = (record: ExecutionRecord | undefined, node: string) => record?.runData[node]?.at(-1)?.outputs[0]?.map((i) => i.json);
const pairedOf = (record: ExecutionRecord | undefined, node: string) => record?.runData[node]?.at(-1)?.outputs[0]?.map((i) => i.pairedItem);
const until = (check: () => void, timeout = 10_000) => vi.waitFor(check, { timeout, interval: 20 });
const resume = (id: string) => resumeExecution(id, { kind: 'time' });
const live = singleton('live-executions', () => new Map<string, unknown>());
const finishedChildren = singleton('finished-children', () => new Map<string, unknown>());

/** A waiting child that finished without telling its parent (its process stopped in between): only its record says so. */
function finishUnheard(id: string, answer: string) {
  const startedAt = new Date().toISOString();
  const run: NodeRun = { startedAt, durationMs: 1, status: 'success', source: 'main', inputs: [[{ json: {} }]], outputs: [[{ json: { answer } }]] };
  waits.clear(id);
  store.patchExecution(id, { status: 'success', finishedAt: startedAt, runData: { Result: [run] }, executionOrder: ['Result'], wait: undefined, resumeState: undefined });
}

/** The host restarts: what it held in memory is gone, the database is opened again, the wait timers are re-armed. */
async function restart() {
  waits.stop();
  live.clear();
  finishedChildren.clear();
  await closeDatabase();
  waits.start(0);
}

// ---------------------------------------------------------------------------

describe('waiting children in "each item" mode', () => {
  it('waits for every child that waits and resumes with all outputs in item order, whatever order they finish in', async () => {
    const parent = await trigger(caller('wf_each_mixed'), [
      { n: 1, hours: 0 },
      { n: 2, hours: 2 },
      { n: 3, hours: 0 },
      { n: 4, hours: 2 },
    ]);
    expect(parent.status).toBe('waiting');
    const kids = kidsOf(parent);
    expect(kids).toHaveLength(4);
    expect(kids.map((id) => stored(id)?.status)).toEqual(['success', 'waiting', 'success', 'waiting']);
    expect(kids.map((id) => stored(id)?.parentExecutionId)).toEqual(Array(4).fill(parent.executionId));
    expect(parent.wait).toMatchObject({ resume: 'subworkflow', nodeName: 'Run', data: { mode: 'each', workflowId: 'wf_kid' } });
    expect(waitData(parent.executionId).children.map((c) => [c.item, c.executionId, c.status])).toEqual([
      [0, kids[0], 'success'],
      [1, kids[1], undefined],
      [2, kids[2], 'success'],
      [3, kids[3], undefined],
    ]);
    // No timer of its own: its children resume it.
    expect(waits.pending()).not.toContain(parent.executionId);

    // The last item's child first: recorded, the parent goes on waiting.
    await resume(kids[3]);
    await until(() => expect(waitData(parent.executionId).children[3]).toMatchObject({ status: 'success', output: [{ json: { answer: 'done 4' } }] }));
    expect(stored(parent.executionId)?.status).toBe('waiting');

    await resume(kids[1]);
    await until(() => expect(stored(parent.executionId)?.status).toBe('success'));
    const done = stored(parent.executionId)!;
    expect(outputOf(done, 'After')).toEqual([{ answer: 'done 1' }, { answer: 'done 2' }, { answer: 'done 3' }, { answer: 'done 4' }]);
    expect(pairedOf(done, 'Run')).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }, { item: 3 }]);
    expect(done.runData.Run).toHaveLength(1);
    expect(done.wait).toBeUndefined();
  });

  it('runs straight through when no child waits, and keeps the output in item order', async () => {
    const parent = await trigger(caller('wf_each_none'), [
      { n: 1, hours: 0 },
      { n: 2, hours: 0 },
    ]);
    expect(parent.status).toBe('success');
    expect(outputOf(parent, 'After')).toEqual([{ answer: 'done 1' }, { answer: 'done 2' }]);
    expect(pairedOf(parent, 'Run')).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('takes the result of a child that finished while the parent was still starting the others', async () => {
    gate.closed = true;
    let parentId = '';
    const run = trigger(caller('wf_each_early', { workflowId: 'wf_kid_unsaved' }), [{ n: 1, hours: 2 }, { n: 2, hours: 0, hold: true }], { onStart: (id) => (parentId = id) });
    await until(() => expect(gate.held).toHaveLength(1));
    const firstKid = store.waitingExecutions().find((e) => e.parentExecutionId === parentId)!.executionId;
    // The first child finishes while the parent's node still waits for the second one to come back (and isn't kept).
    expect((await resume(firstKid)).status).toBe('success');
    expect(stored(firstKid)).toBeUndefined();
    expect(stored(parentId)?.status).toBe('running');
    for (const release of gate.held.splice(0)) release();
    // Every child is done by the time the parent would wait: it waits, and the result kept for it resumes it.
    expect((await run).status).toBe('waiting');
    await until(() => expect(stored(parentId)?.status).toBe('success'));
    expect(outputOf(stored(parentId), 'After')).toEqual([{ answer: 'done 1' }, { answer: 'done 2' }]);
  });

  it('resumes the parent once when children finish at the same moment', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const workflow = caller('wf_each_race');
    const items = [
      { n: 1, hours: 2 },
      { n: 2, hours: 2 },
      { n: 3, hours: 2 },
    ];
    const parent = await trigger(workflow, items);
    await Promise.all(kidsOf(parent).map(resume));
    await until(() => expect(stored(parent.executionId)?.status).toBe('success'));
    expect(outputOf(stored(parent.executionId), 'After')).toEqual([{ answer: 'done 1' }, { answer: 'done 2' }, { answer: 'done 3' }]);
    expect(stored(parent.executionId)?.executionOrder.filter((id) => id === 'Run')).toEqual(['Run']);

    // Straight through the step: the same results handed over several times at once, and the boot check on top.
    const other = await trigger(workflow, items);
    const kids = kidsOf(other);
    kids.forEach((id, i) => finishUnheard(id, `unheard ${i + 1}`));
    const records = kids.map((id) => stored(id)!);
    await Promise.all([settleChildren(other.executionId, [records[0]]), settleChildren(other.executionId, records), settleChildren(other.executionId, [records[2], records[1]]), reconcileWaitingParents({ boot: true })]);
    await until(() => expect(stored(other.executionId)?.status).toBe('success'));
    expect(outputOf(stored(other.executionId), 'After')).toEqual([{ answer: 'unheard 1' }, { answer: 'unheard 2' }, { answer: 'unheard 3' }]);
    expect(stored(other.executionId)?.runData.Run).toHaveLength(1);
    expect(warn.mock.calls.filter(([message]) => message === 'could not resume the parent execution')).toEqual([]);
  });

  it('fails the parent when a child fails, and cancels the children still waiting', async () => {
    const parent = await trigger(caller('wf_each_fails'), [
      { n: 1, hours: 2 },
      { n: 2, hours: 2, fail: true },
      { n: 3, hours: 2 },
    ]);
    const kids = kidsOf(parent);
    await resume(kids[1]);
    await until(() => expect(stored(parent.executionId)?.status).toBe('error'));
    expect(stored(parent.executionId)?.error?.message).toBe(`Sub-workflow failed: child broke (execution ${kids[1]})`);
    await until(() => expect([kids[0], kids[2]].map((id) => stored(id)?.status)).toEqual(['canceled', 'canceled']));

    // A child that fails before any other finishes: the node fails right away, and the one already waiting is canceled.
    const early = await trigger(caller('wf_each_fails_early'), [
      { n: 1, hours: 2 },
      { n: 2, hours: 0, fail: true },
    ]);
    expect(early.status).toBe('error');
    expect(early.error?.message).toContain('Sub-workflow failed: child broke');
    await until(() => expect(stored(kidsOf(early)[0])?.status).toBe('canceled'));
  });

  it('outputs an error item for a failed or canceled child with continue on error, and waits for the rest', async () => {
    const workflow = caller('wf_each_continue', {}, {}, { onError: 'continue' });
    const parent = await trigger(workflow, [
      { n: 1, hours: 2 },
      { n: 2, hours: 2, fail: true },
      { n: 3, hours: 2 },
      { n: 4, hours: 0, fail: true },
    ]);
    expect(parent.status).toBe('waiting');
    const kids = kidsOf(parent);
    expect(waitData(parent.executionId)).toMatchObject({ continueOnFail: true });
    expect(waitData(parent.executionId).children[3]).toMatchObject({ status: 'error', error: `Sub-workflow failed: child broke (execution ${kids[3]})` });

    await resume(kids[1]);
    await until(() => expect(waitData(parent.executionId).children[1].status).toBe('error'));
    expect(stored(parent.executionId)?.status).toBe('waiting');
    expect(cancelWaitingExecution(kids[2])).toBe(true);
    await until(() => expect(waitData(parent.executionId).children[2].status).toBe('canceled'));
    await resume(kids[0]);
    await until(() => expect(stored(parent.executionId)?.status).toBe('success'));
    const done = stored(parent.executionId)!;
    expect(outputOf(done, 'After')).toEqual([
      { answer: 'done 1' },
      { error: `Sub-workflow failed: child broke (execution ${kids[1]})` },
      { error: `The sub-workflow was canceled (execution ${kids[2]})` },
      { error: `Sub-workflow failed: child broke (execution ${kids[3]})` },
    ]);
    expect(pairedOf(done, 'Run')).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }, { item: 3 }]);

    // Nobody waits: the error items come right away.
    const quick = await trigger(workflow, [
      { n: 1, hours: 0, fail: true },
      { n: 2, hours: 0 },
    ]);
    expect(quick.status).toBe('success');
    expect(outputOf(quick, 'After')).toEqual([{ error: expect.stringContaining('Sub-workflow failed: child broke') }, { answer: 'done 2' }]);
  });

  it('cancels the children a stopped parent waits for: while it waits, mid-way through the items, or at its timeout', async () => {
    const waiting = await trigger(caller('wf_each_stop'), [
      { n: 1, hours: 0 },
      { n: 2, hours: 2 },
      { n: 3, hours: 2 },
    ]);
    const kids = kidsOf(waiting);
    expect(cancelWaitingExecution(waiting.executionId)).toBe(true);
    expect(stored(waiting.executionId)?.status).toBe('canceled');
    await until(() => expect(kids.map((id) => stored(id)?.status)).toEqual(['success', 'canceled', 'canceled']));

    // Stopped while the second child runs: the first one, already waiting, is canceled with it.
    gate.closed = true;
    let parentId = '';
    const run = trigger(caller('wf_each_stop_midway'), [{ n: 1, hours: 2 }, { n: 2, hours: 0, hold: true }, { n: 3, hours: 0 }], { onStart: (id) => (parentId = id) });
    await until(() => expect(gate.held).toHaveLength(1));
    expect(cancelExecution(parentId)).toBe(true);
    expect((await run).status).toBe('canceled');
    const started = kidsOf(stored(parentId));
    await until(() => expect(started.map((id) => stored(id)?.status)).toEqual(['canceled', 'canceled']));

    // The parent's timeout (the time it waits doesn't count, the time it runs its children does).
    const timed = trigger(caller('wf_each_stop_timeout', {}, { settings: { timeoutSeconds: 1 } }), [{ n: 1, hours: 2 }, { n: 2, hours: 0, hold: true }]);
    const timedOut = await timed;
    expect(timedOut.status).toBe('error');
    expect(timedOut.error?.message).toBe('Workflow timed out after 1 s');
    await until(() => expect(stored(kidsOf(stored(timedOut.executionId))[0])?.status).toBe('canceled'));

    // "Once" mode: the one child is canceled with its parent too.
    const once = await trigger(caller('wf_once_stop', { mode: 'once' }), [{ n: 1, hours: 2 }]);
    expect(once.status).toBe('waiting');
    expect(cancelWaitingExecution(once.executionId)).toBe(true);
    await until(() => expect(stored(kidsOf(once)[0])?.status).toBe('canceled'));
  });
});

describe('restarts', () => {
  it('survives a restart while children wait, and resumes once the last one finishes after it', async () => {
    const parent = await trigger(caller('wf_each_restart'), [
      { n: 1, hours: 2 },
      { n: 2, hours: 0 },
      { n: 3, hours: 2 },
    ]);
    const kids = kidsOf(parent);
    await restart();
    expect(stored(parent.executionId)?.status).toBe('waiting');
    // The children's timers are back; the parent has none.
    expect(waits.pending()).toEqual(expect.arrayContaining([kids[0], kids[2]]));
    expect(waits.pending()).not.toContain(parent.executionId);

    await resume(kids[2]);
    await until(() => expect(waitData(parent.executionId).children[2].status).toBe('success'));
    await restart();
    await resume(kids[0]);
    await until(() => expect(stored(parent.executionId)?.status).toBe('success'));
    expect(outputOf(stored(parent.executionId), 'After')).toEqual([{ answer: 'done 1' }, { answer: 'done 2' }, { answer: 'done 3' }]);
  });

  it('at boot, settles children that finished while nobody listened and resumes a parent a stopped process was resuming', async () => {
    const parent = await trigger(caller('wf_each_unheard'), [
      { n: 1, hours: 2 },
      { n: 2, hours: 2 },
    ]);
    const kids = kidsOf(parent);
    finishUnheard(kids[0], 'unheard 1');
    finishUnheard(kids[1], 'unheard 2');
    expect(stored(parent.executionId)?.status).toBe('waiting');
    await restart();
    await until(() => expect(stored(parent.executionId)?.status).toBe('success'));
    expect(outputOf(stored(parent.executionId), 'After')).toEqual([{ answer: 'unheard 1' }, { answer: 'unheard 2' }]);

    // Every result was in, the process marked it `resuming` and stopped before the resume took.
    const stuck = await trigger(caller('wf_each_stuck'), [{ n: 1, hours: 2 }]);
    const [kid] = kidsOf(stuck);
    finishUnheard(kid, 'unheard');
    const wait = stored(stuck.executionId)!.wait!;
    const data = { ...(wait.data as unknown as EachWait), resuming: true, children: [{ item: 0, executionId: kid, status: 'success', output: [{ json: { answer: 'recorded' } }] }] };
    store.patchExecution(stuck.executionId, { wait: { ...wait, data: data as never } });
    // Outside a boot nothing happens: a resume may be on its way.
    await reconcileWaitingParents();
    expect(stored(stuck.executionId)?.status).toBe('waiting');
    await restart();
    await until(() => expect(stored(stuck.executionId)?.status).toBe('success'));
    expect(outputOf(stored(stuck.executionId), 'After')).toEqual([{ answer: 'recorded' }]);
  });

  it('cancels the children left waiting by a step that runs again after a crash', async () => {
    gate.closed = true;
    let parentId = '';
    void trigger(caller('wf_each_crash'), [{ n: 1, hours: 2 }, { n: 2, hours: 0, hold: true }], { onStart: (id) => (parentId = id) });
    await until(() => expect(gate.held).toHaveLength(1));
    // The process "dies" mid-step: the parent and its second child are saved as running, the first child waits.
    const firstKid = store.waitingExecutions().find((e) => e.parentExecutionId === parentId)!.executionId;
    const secondKid = store.executionsWithStatus('running').find((e) => e.parentExecutionId === parentId)!.executionId;
    live.clear();
    gate.held.splice(0);
    gate.closed = false;

    const report = recoverExecutions();
    expect(report.resumed).toEqual([parentId]);
    // The step runs again with new children: the old running one is canceled, and the old waiting one too.
    await until(() => expect([firstKid, secondKid].map((id) => stored(id)?.status)).toEqual(['canceled', 'canceled']));
    await until(() => expect(stored(parentId)?.status).toBe('waiting'));
    const children = waitData(parentId).children;
    expect(children.map((c) => c.status)).toEqual([undefined, 'success']);
    expect(children.map((c) => c.executionId)).not.toContain(firstKid);
  });
});
