/**
 * The runner's live progress (`liveProgress`, read by GET /api/executions/:id while a run is running): the latest
 * `node.progress` of each running node, with `since` (when it first reported), dropped when the node finishes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent, Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-progress-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { liveProgress, runWorkflow } = await import('@/lib/server/runner');
const { defineNode, definePlugin } = await import('@landflow/sdk');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let release: () => void = () => {};
const gate = () => new Promise<void>((resolve) => (release = resolve));

// Reports twice (further apart than the engine's throttle), then waits for the test to let it finish.
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'progresstest', name: 'Progress (test)', version: '1.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: { name: 'reporter', displayName: 'Reporter', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], properties: [] },
        async execute(ctx) {
          const waiting = gate();
          ctx.sendProgress?.({ step: 1 });
          await sleep(650);
          ctx.sendProgress?.({ step: 2 });
          await waiting;
          return [[{ json: { done: true } }]];
        },
      }),
    ],
  }),
);

const node = (id: string, type: string): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters: {} });
const workflow: Workflow = {
  id: 'wf_progress',
  name: 'Progress',
  nodes: [node('Start', 'core.manualTrigger'), node('Reporter', 'progresstest.reporter')],
  connections: [{ id: 'e1', type: 'main', source: 'Start', target: 'Reporter', sourceIndex: 0, targetIndex: 0 }],
};

describe('live progress of a run', () => {
  it('keeps the latest report of a running node with when it first reported, and drops it when the node finishes', async () => {
    const events: ExecutionEvent[] = [];
    let executionId = '';
    const done = runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start', onEvent: (event) => events.push(event), onStart: (id) => (executionId = id) });

    await vi.waitFor(() => expect(liveProgress(executionId).Reporter?.data).toEqual({ step: 2 }), { timeout: 5_000 });
    const reports = events.filter((e): e is Extract<ExecutionEvent, { type: 'node.progress' }> => e.type === 'node.progress');
    expect(reports.map((r) => r.data)).toEqual([{ step: 1 }, { step: 2 }]);
    const live = liveProgress(executionId).Reporter;
    expect(live.since).toBe(reports[0].at);
    expect(live.at).toBe(reports[1].at);
    expect(live.since < live.at).toBe(true);

    release();
    const record = await done;
    expect(record.status).toBe('success');
    expect(liveProgress(executionId)).toEqual({});
  });
});
