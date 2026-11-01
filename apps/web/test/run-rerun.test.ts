/**
 * Running it again from the Run Trace (lib/shared/run-rerun.ts, the rerun route's `askMember`): which steps a re-run keeps and
 * runs again, the member a request belongs to, and the team node's changed message for "Ask this member again".
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';
import { askAgainOf, copyToEditorHref, nodeSpanOf, rerunPlan } from '@/lib/shared/run-rerun';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-rerun-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { askAgainMessage, askMemberAgain } = await import('@/lib/server/agent-teams/ask-again');
const rerunRoute = await import('@/app/api/executions/[id]/rerun/route');
registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const flow: RunActor = { id: 'workflow', type: 'system', name: 'Plugin run' };
const lead: RunActor = { id: 'node:team', type: 'agent', name: 'Tech Lead' };
const dev: RunActor = { id: 'remote:developer', type: 'agent', name: 'Developer' };

function journal(): JournalEvent[] {
  let seq = 0;
  const events: JournalEvent[] = [];
  const add = (s: number, e: Record<string, unknown>) => events.push({ seq: ++seq, executionId: 'x1', at: new Date(T0 + s * 1000).toISOString(), ...e } as JournalEvent);
  add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Plugin run', actor: flow });
  add(1, { type: 'span.started', spanId: 'node:trigger:0', parentSpanId: 'run', kind: 'step', name: 'Manual Trigger', actor: flow, nodeId: 'trigger', attrs: { nodeType: 'core.manualTrigger' } });
  add(2, { type: 'span.ended', spanId: 'node:trigger:0', status: 'success' });
  add(3, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Tech Lead team', actor: lead, nodeId: 'team', attrs: { nodeType: 'core.runTeam' } });
  add(4, { type: 'span.started', spanId: 'node:team:0/step:c1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Developer', actor: dev, caller: lead, input: { message: 'Build the plugin' }, attrs: { toolKind: 'a2a' } });
  add(5, { type: 'span.started', spanId: 'node:team:0/step:c1/step:t1', parentSpanId: 'node:team:0/step:c1', kind: 'tool', name: 'Bash: pnpm test', actor: dev });
  add(6, { type: 'span.ended', spanId: 'node:team:0/step:c1/step:t1', status: 'error', error: 'typecheck failing' });
  add(7, { type: 'span.ended', spanId: 'node:team:0/step:c1', status: 'success', output: 'done' });
  add(8, { type: 'span.ended', spanId: 'node:team:0', status: 'success' });
  add(9, { type: 'span.started', spanId: 'node:report:0', parentSpanId: 'run', kind: 'step', name: 'Run Report', actor: flow, nodeId: 'report', attrs: { nodeType: 'core.runReport' } });
  add(10, { type: 'span.ended', spanId: 'node:report:0', status: 'error', error: 'typecheck failing' });
  add(11, { type: 'span.ended', spanId: 'run', status: 'error' });
  return events;
}

describe('running it again from a span', () => {
  const model = foldJournal(journal());

  it('finds the node a step belongs to, and what a re-run keeps and runs again', () => {
    expect(nodeSpanOf(model, 'node:team:0/step:c1/step:t1')?.nodeId).toBe('team');
    expect(nodeSpanOf(model, 'run')).toBeUndefined();
    const plan = rerunPlan(model, 'node:team:0/step:c1/step:t1')!;
    expect(plan.node.nodeId).toBe('team');
    expect(plan.pinned.map((s) => s.nodeId)).toEqual(['trigger']);
    expect(plan.again.map((s) => s.nodeId)).toEqual(['team', 'report']);
    expect(rerunPlan(model, 'node:trigger:0')!.pinned).toEqual([]);
  });

  it('knows the member a request under a Run a Team node asked, and what it was asked', () => {
    expect(askAgainOf(model, 'node:team:0/step:c1')).toEqual({ nodeId: 'team', member: 'Developer', message: 'Build the plugin' });
    // A tool step, a flow node and a request under something else are not requests to a member.
    expect(askAgainOf(model, 'node:team:0/step:c1/step:t1')).toBeUndefined();
    expect(askAgainOf(model, 'node:report:0')).toBeUndefined();
  });

  it('links to the editor with the run’s outputs pinned up to the node', () => {
    expect(copyToEditorHref('wf_1', 'ex 1', 'team')).toBe('/workflows/wf_1?execution=ex%201&pin=team');
    expect(copyToEditorHref('wf_1', 'ex1')).toBe('/workflows/wf_1?execution=ex1&pin=all');
  });
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });
const wf: Workflow = {
  id: 'wf_rerun_ask',
  name: 'rerun',
  nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: 'team_x', message: 'Build it' }), node('After', 'core.noOp')],
  connections: [edge('Start', 'Team'), edge('Team', 'After')],
};

describe('ask this member again', () => {
  it('changes the team node’s message for that re-run only', () => {
    const changed = askMemberAgain(wf, 'Team', { member: 'Developer', message: 'Build the plugin' });
    const message = String(changed.nodes.find((n) => n.id === 'Team')!.parameters.message);
    expect(message).toBe(askAgainMessage('Developer', 'Build the plugin'));
    expect(message).toContain('Ask Developer, and only Developer');
    expect(message).toContain('Build the plugin');
    // The workflow it was made from is untouched, and so are the other nodes.
    expect(wf.nodes.find((n) => n.id === 'Team')!.parameters.message).toBe('Build it');
    expect(changed.nodes.find((n) => n.id === 'After')).toBe(wf.nodes[2]);
  });

  it('only works on a Run a Team node that is in the workflow', () => {
    expect(() => askMemberAgain(wf, 'After', { member: 'Developer', message: 'x' })).toThrow(/Run a Team/);
    expect(() => askMemberAgain(wf, 'Gone', { member: 'Developer', message: 'x' })).toThrow(/not in the workflow/);
    expect(() => askMemberAgain(undefined, 'Team', { member: 'Developer', message: 'x' })).toThrow(/no longer exists/);
  });

  it('is refused by the route unless it re-runs from a Run a Team node', async () => {
    const plain: Workflow = { id: 'wf_rerun_plain', name: 'plain', nodes: [node('Start', 'core.manualTrigger'), node('Next', 'core.noOp')], connections: [edge('Start', 'Next')] };
    store.saveWorkflow(plain);
    const record = await runWorkflow({ workflow: plain, mode: 'manual', startNodeId: 'Start' });
    const post = (body: unknown) =>
      rerunRoute.POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: record.executionId }) });
    expect((await post({ scope: 'all', askMember: { member: 'Dev', message: 'x' } })).status).toBe(400);
    expect((await post({ scope: 'from', nodeId: 'Next', askMember: { member: 'Dev', message: 'x' } })).status).toBe(400);
    // A plain "re-run from here" starts a new execution linked to this one.
    const started = await post({ scope: 'from', nodeId: 'Next' });
    expect(started.status).toBe(202);
    const { executionId } = await started.json();
    expect(executionId).not.toBe(record.executionId);
    for (let i = 0; i < 100 && store.getExecution(executionId)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 25));
    expect(store.getExecution(executionId)).toMatchObject({ rerunOf: { executionId: record.executionId, scope: 'from', nodeId: 'Next' } });
  });
});
