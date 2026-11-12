/**
 * Effect metrics a detector flow declares (docs/second-brain.md#7-measuring-the-effect): a usage query or a sub-workflow
 * that returns the number, kept on the suggestion, measured at baseline and at 7 and 14 days, higher or lower is better.
 * No model and no embeddings.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';
import type { Proposal, UsageEvent } from '@/lib/shared/brain';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-metrics-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_BRAIN_MODEL: 'off',
  LANDFLOW_BRAIN_EMBEDDINGS: 'off',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { agentStore } = await import('@/lib/server/agents/store');
const ledger = await import('@/lib/server/usage/ledger');
const query = await import('@/lib/server/usage/query');
const { runDetectors, runBrain, brainStatus } = await import('@/lib/server/brain');
const proposals = await import('@/lib/server/brain/proposals');
const { checkEffects } = proposals;
const { baselineFor, checkEffect, formatMetric, measureWorkflow, outcomeOf } = await import('@/lib/server/brain/effect');
const { metricSpecFrom } = await import('@/lib/shared/brain');
const facts = await import('@/lib/server/brain/facts');
const { study } = await import('@/lib/server/brain/study');
const { analystConfig } = await import('@/lib/server/brain/analyst');
const { matches, dispatchUsage, resetUsageTrigger, usageItems } = await import('@/lib/server/brain/usage-trigger');
const { landflowUsageNode, suggestImprovementNode, findSimilarNode } = await import('@/lib/server/nodes/usage');
const { findSimilar } = await import('@/lib/server/brain/similar');
const { scopeForActor } = await import('@/lib/server/brain/scope');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { inMemoryVectorStoreNode } = await import('@/lib/server/nodes/vector-stores');
const { applyOps, describeOps, parseOps } = await import('@/lib/shared/assistant-ops');
const { runOk } = await import('./helpers');
const { registryLookup } = await import('@/lib/server/assistant/ops');
const proposalsRoute = await import('@/app/api/proposals/route');
const proposalRoute = await import('@/app/api/proposals/[id]/route');
const applyRoute = await import('@/app/api/proposals/[id]/apply/route');
const appliedRoute = await import('@/app/api/proposals/[id]/applied/route');
const usageRoute = await import('@/app/api/usage/route');
const signalRoute = await import('@/app/api/usage/signal/route');
const statusRoute = await import('@/app/api/brain/status/route');
const factsRoute = await import('@/app/api/brain/facts/route');
const knowledgeRoute = await import('@/app/api/brain/workflows/[id]/route');
const analystRoute = await import('@/app/api/brain/analyst/route');
const runRoute = await import('@/app/api/brain/run/route');
const { listFlowDetectors } = await import('@/lib/server/brain/flow-detectors');

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@brain.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function node(id: string, name: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, name, type, typeVersion: 1, position: [0, 0], parameters, ...extra };
}

function workflow(id: string, name: string, nodes: WorkflowNode[], links: Array<[string, string]> = [], extra: Partial<Workflow> = {}): Workflow {
  return store.saveWorkflow({
    id,
    name,
    active: false,
    nodes,
    connections: links.map(([source, target], i) => ({ id: `c${i}`, type: 'main', source, sourceIndex: 0, target, targetIndex: 0 })),
    createdBy: owner.id,
    ...extra,
  } as Workflow);
}

function clear() {
  const db = database();
  const columns = { usage_events: 'at', usage_daily: 'day', proposals: 'created_at', brain_facts: 'last_seen', brain_profiles: 'updated_at' } as const;
  for (const [table, column] of Object.entries(columns)) db.deleteBefore(table as keyof typeof columns, column, '9999');
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
}

beforeEach(() => {
  clear();
  delete process.env.LANDFLOW_BRAIN;
});

const merged = (n: number, at: number, extra: Record<string, string | number | boolean> = {}) => {
  for (let i = 0; i < n; i++) ledger.recordUsage({ kind: 'work.initiative_merged' as never, at: new Date(at + (i + 1) * 3_600_000).toISOString(), attrs: { team: 'billing', ...extra } });
};

/** The Detector Trigger's declaration for the example: initiatives merged or reused, higher is better. */
const mergedParams = { metricSource: 'usage', metricLabel: 'Initiatives merged or reused', metricBetter: 'higher', metricKinds: ['work.initiative_merged'], metricAggregate: 'count', metricAbout: 'instance' };

// A published copy of a workflow outlives clear(), so every test's flows get ids of their own.
let serial = 0;
const flowId = () => `wf_overlap${++serial}`;
let current = '';
const detectorId = () => `flow:${current}` as const;

const overlapFlow = (trigger: Record<string, unknown>, suggest: Record<string, unknown> = {}) =>
  workflow(
    (current = flowId()),
    'Overlap finder',
    [node('t', 'Detector', 'core.detectorTrigger', trigger), node('s', 'Suggest', 'core.suggestImprovement', { title: 'Two teams build the same thing', why: 'same goal', risk: 'low', confidence: 0.7, ...suggest })],
    [['t', 's']],
    { active: true },
  );

describe('effect metrics declared by a flow', () => {
  it('parse from node parameters, and say what is wrong', () => {
    expect(metricSpecFrom(() => undefined)).toEqual({});
    expect(metricSpecFrom((n) => ({ metricSource: 'default' })[n])).toEqual({});
    const read = (values: Record<string, unknown>) => (n: string) => values[n];
    expect(metricSpecFrom(read(mergedParams)).spec).toEqual({
      source: 'usage',
      label: 'Initiatives merged or reused',
      better: 'higher',
      usage: { kinds: ['work.initiative_merged'], aggregate: 'count', about: 'instance' },
    });
    expect(metricSpecFrom(read({ ...mergedParams, metricAttrEquals: 'team=billing', metricAggregate: 'sum', metricField: 'cost' })).spec?.usage).toMatchObject({ attrEquals: { team: 'billing' }, aggregate: 'sum', field: 'cost' });
    expect(metricSpecFrom(read({ ...mergedParams, metricLabel: '' })).problem).toMatch(/Name the metric/);
    expect(metricSpecFrom(read({ ...mergedParams, metricKinds: ['nonsense'] })).problem).toMatch(/not an event kind/);
    expect(metricSpecFrom(read({ ...mergedParams, metricKinds: [] })).problem).toMatch(/at least one/);
    expect(metricSpecFrom(read({ ...mergedParams, metricAggregate: 'sum', metricField: '' })).problem).toMatch(/what to sum/);
    expect(metricSpecFrom(read({ metricSource: 'workflow', metricLabel: 'Score', metricWorkflowId: '' })).problem).toMatch(/sub-workflow/);
  });

  it('count a custom event over the windows: the overlap detector reports duplicate work avoided', async () => {
    overlapFlow(mergedParams);
    await runDetectors({ enrich: false });
    const [open] = proposals.listProposals({ status: 'open', detector: detectorId() });
    expect(open.metricSpec).toMatchObject({ source: 'usage', label: 'Initiatives merged or reused', better: 'higher' });
    const appliedAt = Date.now() - 15 * DAY;
    merged(2, appliedAt - 7 * DAY); // the week before: 2 merged
    merged(9, appliedAt); // the first week after: 9
    merged(9, appliedAt + 7 * DAY); // the second week after: 9 (the check is per week)
    merged(3, appliedAt - 3 * DAY, { team: 'other' }); // another team's, filtered out below
    const applied = proposals.markApplied(open, {}, database(), appliedAt);
    expect(applied.baseline).toMatchObject({ metric: 'custom', label: 'Initiatives merged or reused', better: 'higher', days: 7 });
    expect(applied.baseline?.value).toBe(5);
    const week = checkEffect(applied, appliedAt + 8 * DAY)!;
    expect(week.checks?.[0]).toMatchObject({ metric: 'custom', days: 7, label: 'Initiatives merged or reused' });
    const done = checkEffect(week, appliedAt + 15 * DAY)!;
    expect(done.checks?.[1].value).toBeCloseTo(9);
    expect(done.outcome).toBe('worked');
    const fact = facts.getFact(`instance:instance:change:${open.id}`);
    expect(fact?.statement).toMatch(/helped: Initiatives merged or reused was 5 before and 9 in the two weeks after \(higher is better\)/);
    expect(formatMetric('custom', 9, 'Initiatives merged or reused')).toBe('Initiatives merged or reused: 9');
  });

  it('filter by attribute and sum a value, about the suggestion’s workflow', () => {
    workflow('wf_target', 'Target', [node('t', 'Hook', 'core.webhook')]);
    workflow('wf_other', 'Other', [node('t', 'Hook', 'core.webhook')]);
    const at = Date.now() - 2 * DAY;
    for (const [wf, cost] of [['wf_target', 0.5], ['wf_target', 1.5], ['wf_other', 10]] as const) ledger.recordUsage({ kind: 'ai.call', workflowId: wf, cost, at: new Date(at).toISOString(), attrs: { model: 'm', saved: 4 } });
    const spec = metricSpecFrom((n) => ({ metricSource: 'usage', metricLabel: 'AI spend', metricBetter: 'lower', metricKinds: ['ai.call'], metricAggregate: 'sum', metricField: 'cost', metricAbout: 'target' })[n]).spec!;
    const target = { type: 'workflow' as const, id: 'wf_target' };
    workflow('wf_det2', 'Detector', [node('t', 'Detector', 'core.detectorTrigger')]);
    const detector = 'flow:wf_det2' as const;
    const baseline = baselineFor({ detector, target, metricSpec: spec }, Date.now());
    expect(baseline).toMatchObject({ metric: 'custom', label: 'AI spend', better: 'lower', value: 2 });
    const instance = baselineFor({ detector, target, metricSpec: { ...spec, usage: { ...spec.usage!, about: 'instance' } } }, Date.now());
    expect(instance?.value).toBe(12);
    const attr = baselineFor({ detector, target, metricSpec: { ...spec, usage: { ...spec.usage!, field: 'saved', aggregate: 'avg', attrEquals: { model: 'm' } } } }, Date.now());
    expect(attr?.value).toBe(4);
  });

  it('respect which way is better', () => {
    expect([outcomeOf(5, 9, 'higher'), outcomeOf(5, 3, 'higher'), outcomeOf(5, 5.2, 'higher'), outcomeOf(0, 4, 'higher'), outcomeOf(0, 0, 'higher')]).toEqual(['worked', 'worse', 'no-effect', 'worked', 'no-effect']);
    expect([outcomeOf(5, 9), outcomeOf(5, 3), outcomeOf(0, 4)]).toEqual(['worse', 'worked', 'worse']);
    // Lower is better and it went up: worse.
    workflow('wf_det', 'Cost detector', [node('t', 'Detector', 'core.detectorTrigger')]);
    const spec = metricSpecFrom((n) => ({ metricSource: 'usage', metricLabel: 'Spend', metricBetter: 'lower', metricKinds: ['ai.call'], metricAggregate: 'sum', metricField: 'cost', metricAbout: 'instance' })[n]).spec!;
    const appliedAt = Date.now() - 15 * DAY;
    ledger.recordUsage({ kind: 'ai.call', cost: 1, at: new Date(appliedAt - DAY).toISOString() });
    ledger.recordUsage({ kind: 'ai.call', cost: 4, at: new Date(appliedAt + DAY).toISOString() });
    const open = proposals.upsertProposal({ source: 'detector', detector: 'flow:wf_det', fingerprint: 'c', target: { type: 'instance' }, title: 'Spend', why: 'x', evidence: [], ops: [], risk: 'low', confidence: 0.7, score: 1, metricSpec: spec })!;
    const applied = proposals.markApplied(open, {}, database(), appliedAt);
    const done = checkEffect(checkEffect(applied, appliedAt + 8 * DAY)!, appliedAt + 15 * DAY)!;
    expect(done.outcome).toBe('worse');
    expect(facts.getFact(`instance:instance:change:${open.id}`)?.statement).toMatch(/made it worse: Spend was 1 before and 2 in the two weeks after \(lower is better\)/);
  });

  it('lets a Suggest Improvement node override the detector’s, or fall back to Landflow’s own', async () => {
    overlapFlow(mergedParams, { metricSource: 'usage', metricLabel: 'Spend', metricBetter: 'lower', metricKinds: ['ai.call'], metricAggregate: 'sum', metricField: 'cost' });
    await runDetectors({ enrich: false });
    expect(proposals.listProposals({ status: 'open', detector: detectorId() })[0].metricSpec).toMatchObject({ label: 'Spend', better: 'lower' });
    clear();
    overlapFlow(mergedParams, { metricSource: 'default' });
    await runDetectors({ enrich: false });
    expect(proposals.listProposals({ status: 'open', detector: detectorId() })[0].metricSpec).toBeUndefined();
    clear();
    overlapFlow({ metricSource: 'usage', metricLabel: '' });
    const result = await runDetectors({ enrich: false });
    expect(result.flows?.[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/Name the metric/) });
  });

  it('keeps the built-in measures when nothing is declared', async () => {
    overlapFlow({});
    await runDetectors({ enrich: false });
    const [open] = proposals.listProposals({ status: 'open', detector: detectorId() });
    expect(open.metricSpec).toBeUndefined();
    expect(baselineFor(open)).toBeUndefined(); // about the instance: not measured
  });

  describe('with a sub-workflow', () => {
    /** Called with { proposal, from, to, phase }; returns { score: 2 } for the baseline and { score: 9 } for the check. */
    let scoreId = '';
    beforeEach(() => {
      scoreId = '';
    });
    const scorer = (expression = "={{ $json.phase === 'baseline' ? 2 : 9 }}") =>
      workflow(
        (scoreId = scoreId || `wf_score${++serial}`),
        'Score',
        [node('in', 'Called', 'core.workflowTrigger', { inputSource: 'passthrough' }), node('set', 'Set', 'core.set', { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'score', type: 'string', value: expression }] } })],
        [['in', 'set']],
        { active: true },
      );
    const declared = () => ({ metricSource: 'workflow', metricLabel: 'Duplicate work avoided', metricBetter: 'higher', metricWorkflowId: scoreId, metricOutputField: 'score' });
    const waitSettled = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const p = proposals.getProposal(id)!;
        if (!p.baseline?.pending) return p;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the baseline never settled');
    };

    it('records the baseline a moment after Apply, then checks at 7 and 14 days', async () => {
      scorer();
      overlapFlow(declared());
      await runDetectors({ enrich: false });
      const [open] = proposals.listProposals({ status: 'open', detector: detectorId() });
      expect(open.metricSpec).toMatchObject({ source: 'workflow', workflow: { workflowId: scoreId, field: 'score' } });
      const appliedAt = Date.now() - 15 * DAY;
      const applied = proposals.markApplied(open, {}, database(), appliedAt);
      expect(applied.baseline).toMatchObject({ metric: 'custom', pending: true, label: 'Duplicate work avoided' });
      expect(checkEffect(applied, appliedAt + 8 * DAY)).toBeUndefined(); // a sub-workflow metric is async
      const settled = await waitSettled(open.id);
      expect(settled.baseline).toMatchObject({ value: 2, better: 'higher' });
      expect(settled.baseline?.pending).toBeUndefined();
      expect(await checkEffects(database(), appliedAt + 8 * DAY)).toBe(1);
      expect(proposals.getProposal(open.id)!.checks?.[0]).toMatchObject({ value: 9, days: 7 });
      expect(await checkEffects(database(), appliedAt + 15 * DAY)).toBe(1);
      const done = proposals.getProposal(open.id)!;
      expect(done.outcome).toBe('worked');
      expect(facts.getFact(`instance:instance:change:${open.id}`)?.statement).toMatch(/Duplicate work avoided was 2 before and 9 in the two weeks after/);
    });

    it('records no value, not a 0, when the sub-workflow is missing or fails, and tries again later', async () => {
      // Its sub-workflow doesn't exist yet when the suggestion is applied.
      scoreId = `wf_score${++serial}`;
      overlapFlow(declared());
      await runDetectors({ enrich: false });
      const [open] = proposals.listProposals({ status: 'open', detector: detectorId() });
      const appliedAt = Date.now() - 15 * DAY;
      proposals.markApplied(open, {}, database(), appliedAt);
      const failed = await waitSettled(open.id);
      expect(failed.baseline).toMatchObject({ failed: true });
      // Nothing is checked on a baseline with no value.
      expect(await checkEffects(database(), appliedAt + 8 * DAY)).toBe(0);
      expect(proposals.getProposal(open.id)!.checks ?? []).toEqual([]);
      // Built since: the next look settles the baseline and checks.
      scorer();
      expect(await checkEffects(database(), appliedAt + 8 * DAY)).toBe(2);
      expect(proposals.getProposal(open.id)!.baseline).toMatchObject({ value: 2 });
      expect(proposals.getProposal(open.id)!.baseline?.failed).toBeUndefined();
      expect(proposals.getProposal(open.id)!.checks).toHaveLength(1);
    });

    it('treats an answer that is not a number as no value', async () => {
      scorer("n/a");
      overlapFlow(declared());
      await runDetectors({ enrich: false });
      const [open] = proposals.listProposals({ status: 'open', detector: detectorId() });
      const now = Date.now();
      expect(await measureWorkflow(open, open.metricSpec!, now - 7 * DAY, now, 'baseline')).toBeUndefined();
    });

    it('gives the sub-workflow the proposal, the window and the phase', async () => {
      scorer("={{ $json.phase === 'check' && $json.proposal.title === 'Two teams build the same thing' ? 7 : 1 }}");
      overlapFlow(declared());
      await runDetectors({ enrich: false });
      const [open] = proposals.listProposals({ status: 'open', detector: detectorId() });
      const spec = open.metricSpec!;
      const appliedAt = Date.now() - 9 * DAY;
      const value = await measureWorkflow(open, spec, appliedAt, appliedAt + 7 * DAY, 'check');
      expect(value).toBe(7);
      expect(await measureWorkflow(open, { ...spec, workflow: { workflowId: 'missing', field: 'score' } }, appliedAt, appliedAt + DAY, 'check')).toBeUndefined();
    });
  });
});
