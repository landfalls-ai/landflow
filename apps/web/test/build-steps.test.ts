/**
 * Building, step by step (lib/shared/build-steps.ts): tool calls and the ops of a proposal become steps that tick off, the
 * nodes and connections the ops add become ghosts that appear with their step, and progress is done steps over all.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AssistantOp } from '@/lib/shared/assistant-ops';
import { buildSteps, planOf, stepProgress, toolSteps, visibleGhosts } from '@/lib/shared/build-steps';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { registryLookup } from '@/lib/server/assistant/ops';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const workflow = (): Workflow => ({
  id: 'wf_test',
  name: 'Test',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Code', type: 'core.code', typeVersion: 1, position: [280, 0], parameters: { mode: 'each', codeEach: 'return $json;' } },
  ],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
});

const OPS: AssistantOp[] = [
  { op: 'addNode', ref: 'check', type: 'core.if', name: 'Ask for approval', after: 'Code' },
  { op: 'addNode', ref: 'ok', type: 'core.noOp', name: 'Approved', after: 'check' },
  { op: 'addNode', ref: 'no', type: 'core.noOp', name: 'Deny' },
  { op: 'connect', from: 'check', to: 'no', output: 1 },
  { op: 'setParameters', node: 'Code', parameters: { codeEach: 'return { ok: true };' } },
];

describe('planOf', () => {
  it('makes one step per added node, one for the connections together, one per edit', () => {
    const plan = planOf(workflow(), OPS, registryLookup(types));
    expect(plan.steps.map((s) => s.kind)).toEqual(['add', 'add', 'add', 'wire', 'set']);
    expect(plan.steps[0].title).toBe('Add Ask for approval');
    expect(plan.steps[0].parts).toContain('after Code');
    expect(plan.steps[3].title).toBe('Connect Ask for approval → Deny');
    expect(plan.steps[4].parts).toEqual(['Code', 'codeEach']);
  });

  it('puts consecutive connections in one step and names each', () => {
    const ops: AssistantOp[] = [
      { op: 'addNode', ref: 'x', type: 'core.noOp', name: 'X' },
      { op: 'addNode', ref: 'y', type: 'core.noOp', name: 'Y' },
      { op: 'connect', from: 'Code', to: 'x' },
      { op: 'connect', from: 'x', to: 'y' },
    ];
    const plan = planOf(workflow(), ops, registryLookup(types));
    const wire = plan.steps[2];
    expect(wire.title).toBe('Wire 2 connections');
    expect(wire.doing).toBe('Wiring the connections');
    expect(wire.parts).toEqual(['Code → X', 'X → Y']);
  });

  it('lists the added nodes as ghosts, at the positions the ops give, with their connections', () => {
    const wf = workflow();
    const plan = planOf(wf, OPS, registryLookup(types));
    expect(plan.nodes.map((n) => n.name)).toEqual(['Ask for approval', 'Approved', 'Deny']);
    expect(plan.nodes.every((n) => n.id.startsWith('n_ghost-'))).toBe(true);
    const check = plan.nodes[0];
    expect(check.position[0]).toBeGreaterThan(280);
    // Code → Ask, Ask → Approved, Ask → Deny: three new connections; the existing one is not a ghost.
    expect(plan.links).toHaveLength(3);
    expect(plan.links.some((l) => l.source === 'a')).toBe(false);
    expect(check.ins).toContain('main:0');
    expect(check.outs).toEqual(expect.arrayContaining(['main:0', 'main:1']));
    // The workflow itself is untouched.
    expect(wf.nodes).toHaveLength(2);
  });

  it('draws a connection when its own step is reached, not when both ends are there', () => {
    const plan = planOf(workflow(), OPS, registryLookup(types));
    const toDeny = plan.links.find((l) => plan.nodes.find((n) => n.id === l.target)?.name === 'Deny')!;
    expect(toDeny.step).toBe(3);
    const early = visibleGhosts(plan, 2);
    expect(early.nodes.map((n) => n.name)).toEqual(['Ask for approval', 'Approved', 'Deny']);
    expect(early.links).toHaveLength(2);
    expect(visibleGhosts(plan, 3).links).toHaveLength(3);
  });

  it('shows only the steps that reached, the newest one active', () => {
    const plan = planOf(workflow(), OPS, registryLookup(types));
    expect(visibleGhosts(plan, 0).nodes.map((n) => [n.name, n.active])).toEqual([['Ask for approval', true]]);
    expect(visibleGhosts(plan, 1).nodes.map((n) => [n.name, n.active])).toEqual([
      ['Ask for approval', false],
      ['Approved', true],
    ]);
  });

  it('leaves out ops that do not apply', () => {
    const plan = planOf(workflow(), [{ op: 'addNode', type: 'nope.nothing', name: 'Ghost' }, { op: 'removeNode', node: 'Code' }], registryLookup(types));
    expect(plan.steps.map((s) => s.kind)).toEqual(['remove']);
    expect(plan.nodes).toEqual([]);
    expect(plan.dropped).toHaveLength(1);
  });
});

describe('buildSteps', () => {
  let plan: { steps: ReturnType<typeof planOf>['steps'] };
  beforeAll(() => {
    plan = { steps: planOf(workflow(), OPS, registryLookup(types)).steps };
  });

  it('ticks tool calls as they stream and leaves out the proposal call', () => {
    const steps = toolSteps([{ label: 'Read the workflow', ok: true }, { label: 'Read Slack docs', ok: true }, { label: 'Proposed 3', ok: true }], 4);
    expect(steps.map((s) => s.title)).toEqual(['Read the workflow', 'Read Slack docs']);
    expect(steps[0].parts).toEqual(['4 nodes']);
  });

  it('marks done, active and to do by how many are revealed', () => {
    const steps = buildSteps({ tools: [{ label: 'Read the workflow', ok: true }], plan, revealed: 2, working: false });
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active', 'todo', 'todo']);
  });

  it('adds a step in progress while the assistant is still working, and only once the plan is revealed', () => {
    expect(buildSteps({ tools: [], plan: { steps: [] }, revealed: 0, working: true }).map((s) => [s.kind, s.state])).toEqual([['think', 'active']]);
    expect(buildSteps({ tools: [], plan, revealed: 1, working: true }).some((s) => s.kind === 'think')).toBe(false);
    expect(buildSteps({ tools: [], plan, revealed: 5, working: true }).at(-1)?.kind).toBe('think');
    expect(buildSteps({ tools: [], plan, revealed: 5, working: false }).some((s) => s.kind === 'think')).toBe(false);
  });

  it('measures progress as done over all, and never finishes while still working', () => {
    expect(stepProgress(buildSteps({ tools: [], plan: { steps: [] }, revealed: 0, working: true }))).toBe(0);
    expect(stepProgress(buildSteps({ tools: [], plan, revealed: 0, working: false }))).toBe(0);
    expect(stepProgress(buildSteps({ tools: [{ label: 'Read the workflow', ok: true }], plan, revealed: 2, working: false }))).toBeCloseTo(3 / 6);
    expect(stepProgress(buildSteps({ tools: [], plan, revealed: 5, working: false }))).toBe(1);
    expect(stepProgress(buildSteps({ tools: [], plan, revealed: 5, working: true }))).toBeLessThan(1);
  });
});

describe('mergeTrace', () => {
  it('keeps the stream rows with their times and adds only the plan changes', async () => {
    const { mergeTrace } = await import('../src/lib/shared/build-steps');
    const stream = [{ id: 'tool1', label: 'Searched nodes', kind: 'read' as const, status: 'ok' as const, durationMs: 120 }];
    const plan = [
      { id: 's1', kind: 'read', state: 'done', title: 'Read the workflow', doing: 'Reading', parts: [] },
      { id: 's2', kind: 'add', state: 'done', title: 'Add Slack', doing: 'Adding Slack', parts: [] },
    ] as never;
    const rows = mergeTrace(stream, plan);
    expect(rows.map((r) => r.id)).toEqual(['tool1', 's2']);
    expect(rows[0].durationMs).toBe(120);
    expect(mergeTrace(undefined, plan).map((r) => r.id)).toEqual(['s1', 's2']);
  });
});
