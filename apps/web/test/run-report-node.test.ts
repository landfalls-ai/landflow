/**
 * The Run report node (lib/server/nodes/run-report.ts) in real runs: it reads the run's journal, saves the report as an
 * artifact, sends the work back on "Send back" when a check failed (route), or waits for a person, who answers through
 * POST /api/executions/:id/gate (ask).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { JournalEvent } from '@/lib/shared/run-trace';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-report-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { journalStore } = await import('@/lib/server/journal');
const { runWorkflow } = await import('@/lib/server/runner');
const { store } = await import('@/lib/server/store');
const { defineNode, definePlugin } = await import('@landflow/sdk');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

registry.registerBuiltin(corePlugin);
// Makes a draft and reports a failing check, as a plugin in any language can (ctx.artifact, ctx.check).
registry.registerBuiltin(
  definePlugin({
    info: { id: 'reporttest', name: 'Report (test)', version: '1.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: { name: 'builder', displayName: 'Builder', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], properties: [] },
        async execute(ctx) {
          ctx.artifact({ name: 'Draft', kind: 'document', text: 'v1' });
          ctx.check({ name: 'Tests', status: 'fail', message: '2 of 10 failed' });
          return [ctx.getInputData()];
        },
      }),
    ],
  }),
);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const flow = (id: string, gate: string): Workflow =>
  store.saveWorkflow({
    id,
    name: `Report ${gate}`,
    nodes: [node('Start', 'core.manualTrigger'), node('Builder', 'reporttest.builder'), node('Report', 'core.runReport', { gate, profile: 'generic' }), node('Ship', 'core.noOp'), node('Fix', 'core.noOp')],
    connections: [
      { id: 'e1', type: 'main', source: 'Start', target: 'Builder', sourceIndex: 0, targetIndex: 0 },
      { id: 'e2', type: 'main', source: 'Builder', target: 'Report', sourceIndex: 0, targetIndex: 0 },
      { id: 'e3', type: 'main', source: 'Report', target: 'Ship', sourceIndex: 0, targetIndex: 0 },
      { id: 'e4', type: 'main', source: 'Report', target: 'Fix', sourceIndex: 1, targetIndex: 0 },
    ],
  });

const checksOf = (events: JournalEvent[]) => events.filter((e): e is Extract<JournalEvent, { type: 'check' }> => e.type === 'check');

describe('Run report node', () => {
  it('sends the work back when a check failed, with the report saved as an artifact of the run', async () => {
    const record = await runWorkflow({ workflow: flow('wf_report_route', 'route'), mode: 'manual', startNodeId: 'Start' });
    expect(record.status).toBe('success');
    expect(record.runData.Fix).toBeDefined();
    expect(record.runData.Ship).toBeUndefined();
    const out = record.runData.Report[0].outputs[1][0].json as Record<string, unknown>;
    expect(out).toMatchObject({ verdict: 'fail', failed: 1, profile: 'generic' });
    expect(String(out.sendBack)).toContain('Tests: 2 of 10 failed');
    expect(String(out.report)).toContain('✗ **Tests**');

    const events = journalStore.read(record.executionId, 0, 2000);
    expect(events.find((e) => e.type === 'artifact' && e.artifact.kind === 'report')).toMatchObject({ spanId: 'node:Report:0', artifact: { name: 'Run report', mimeType: 'text/markdown' } });
    expect(events.find((e) => e.type === 'artifact' && e.artifact.name === 'Draft')).toMatchObject({ spanId: 'node:Builder:0' });
    // The gate settled the failed check for this round: the next report judges the fix.
    expect(checksOf(events).filter((e) => e.check.name === 'Tests').map((e) => e.check.resolution?.decision)).toEqual([undefined, 'sent_back']);
  });

  it('waits for a person on “Ask a person”, who accepts the failed checks from the Needs you strip', async () => {
    const started = await runWorkflow({ workflow: flow('wf_report_ask', 'ask'), mode: 'manual', startNodeId: 'Start' });
    expect(started.status).toBe('waiting');
    expect(started.wait?.data?.runReport).toMatchObject({ gate: true, verdict: 'fail', failed: [{ name: 'Tests', spanId: 'node:Builder:0' }] });

    const needs = await import('@/app/api/runs/needs-you/route');
    const items = ((await (await needs.GET()).json()) as { items: Array<{ executionId: string; kind: string; title: string }> }).items.filter((i) => i.executionId === started.executionId);
    expect(items.map((i) => i.kind)).toEqual(['gate']);
    expect(items[0].title).toBe('Needs attention: 1 check failed');

    const gate = await import('@/app/api/executions/[id]/gate/route');
    const post = (body: unknown) => gate.POST(new Request(`http://localhost/api/executions/${started.executionId}/gate`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: started.executionId }) });
    const answered = await post({ decision: 'accepted', note: 'flaky on CI' });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ status: 'success' });
    expect((await post({ decision: 'accepted' })).status).toBe(409);

    const done = store.getExecution(started.executionId)!;
    expect(done.runData.Ship).toBeDefined();
    expect(done.runData.Fix).toBeUndefined();
    expect(done.runData.Report.at(-1)!.outputs[0][0].json).toMatchObject({ decision: 'accepted', note: 'flaky on CI' });
    const events = journalStore.read(started.executionId, 0, 2000);
    expect(events.find((e) => e.type === 'message' && e.text.startsWith('Accepted as is'))).toMatchObject({ text: 'Accepted as is: flaky on CI', from: { type: 'human' } });
    expect(checksOf(events).filter((e) => e.check.name === 'Tests').at(-1)?.check.resolution).toMatchObject({ decision: 'accepted', note: 'flaky on CI' });
    // The checks were recorded once, before the wait; the report was saved again after the decision.
    expect(events.filter((e) => e.type === 'artifact' && e.artifact.kind === 'report')).toHaveLength(2);
  });
});
