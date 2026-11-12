/**
 * The second brain (docs/second-brain.md): the usage ledger (redaction, signatures, what executions and audit events
 * record, reports, rollups and scope), the detectors on seeded events, the suggestion lifecycle (dedupe, held back, the
 * weekly cap, dismiss as intended, apply ops / a draft / persona rules, the effect checks), what study() learns without a
 * model, Find Similar (and the walls around other projects), the brain over the instance MCP server, the Landflow Usage, Suggest Improvement and On Usage Event nodes, flow detectors (Detector Trigger), the new edit
 * operations, and the routes.
 * No model and no embeddings: LANDFLOW_BRAIN_MODEL and LANDFLOW_BRAIN_EMBEDDINGS are off.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';
import type { Proposal, UsageEvent } from '@/lib/shared/brain';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-'));
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
const { checkEffect, outcomeOf } = await import('@/lib/server/brain/effect');
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

const runs = (workflowId: string, n: number, extra: Partial<Parameters<typeof ledger.recordUsage>[0]> & { status?: string; mode?: string } = {}) => {
  const { status = 'success', mode = 'trigger', ...rest } = extra;
  for (let i = 0; i < n; i++) ledger.recordUsage({ kind: 'run.finished', workflowId, durationMs: 500, at: ago(i * 3_600_000 + 60_000), attrs: { status, mode }, ...rest });
};

const fail = (workflowId: string, nodeId: string, message: string, n: number, nodeType = 'core.httpRequest') => {
  for (let i = 0; i < n; i++) ledger.recordUsage({ kind: 'node.failed', workflowId, nodeId, nodeType, message, signature: ledger.signatureOf(nodeType, message), at: ago(i * 3_600_000 + 120_000), attrs: { mode: 'trigger' } });
};

function clear() {
  const db = database();
  const columns = { usage_events: 'at', usage_daily: 'day', proposals: 'created_at', brain_facts: 'last_seen', brain_profiles: 'updated_at' } as const;
  for (const [table, column] of Object.entries(columns)) db.deleteBefore(table as keyof typeof columns, column, '9999');
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
}

async function call(handler: unknown, url: string, init: RequestInit & { json?: unknown } = {}, params?: Record<string, string>) {
  const { json: body, ...rest } = init;
  const request = new Request(`http://localhost${url}`, { ...rest, ...(body !== undefined && { method: rest.method ?? 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(request, params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  clear();
  delete process.env.LANDFLOW_BRAIN;
  delete process.env.LANDFLOW_BRAIN_WEEKLY_CAP;
});

describe('the usage ledger', () => {
  it('redacts personal details and secrets, and signs failures without their numbers', () => {
    const text = ledger.redact('Bad email ada@example.com, card 4111111111111111, token sk_live_51HabcDEF0123456789xyz at https://api.example.com/v1?key=abc');
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('4111111111111111');
    expect(text).not.toContain('sk_live_51HabcDEF0123456789xyz');
    const a = ledger.signatureOf('core.httpRequest', 'Order 1234 not found (status 404)');
    const b = ledger.signatureOf('core.httpRequest', 'Order 98765 not found (status 404)');
    expect(a).toBe(b);
    expect(ledger.signatureOf('core.set', 'Order 1234 not found (status 404)')).not.toBe(a);
    expect(ledger.signatureOf('core.httpRequest', 'Something else broke')).not.toBe(a);
  });

  it('records nothing with LANDFLOW_BRAIN=false', () => {
    process.env.LANDFLOW_BRAIN = 'false';
    expect(ledger.recordUsage({ kind: 'run.finished', workflowId: 'wf_x' })).toBeUndefined();
    expect(query.listUsageEvents({})).toHaveLength(0);
  });

  it('records a finished run, its failed and slow steps from a saved execution', () => {
    const wf = workflow('wf_exec', 'Exec', [node('t', 'Start', 'core.manualTrigger'), node('h', 'Call', 'core.httpRequest'), node('s', 'Slow', 'core.set')]);
    const run = (durationMs: number, error?: string) => ({ startedAt: ago(5_000), durationMs, status: error ? 'error' : 'success', source: 'node', inputs: [], outputs: [[{ json: {} }]], ...(error && { error: { message: error } }) });
    const record = {
      executionId: 'ex_brain_1',
      workflowId: wf.id,
      workflowName: wf.name,
      workflow: wf,
      mode: 'trigger',
      status: 'error',
      startedAt: ago(6_000),
      finishedAt: ago(1_000),
      durationMs: 5_000,
      runData: { t: [run(1)], s: [run(3_000)], h: [run(20, 'The service answered 503 for order 12345')] },
      executionOrder: ['t', 's', 'h'],
      lastNodeId: 'h',
      error: { message: 'The service answered 503 for order 12345', nodeId: 'h' },
      startedBy: owner.id,
    } as unknown as ExecutionRecord;
    store.saveExecution(record);
    const events = query.listUsageEvents({ workflowId: wf.id }, { limit: 10 });
    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toEqual(['node.failed', 'node.slow', 'run.finished']);
    const failed = events.find((e) => e.kind === 'node.failed')!;
    expect(failed).toMatchObject({ nodeId: 'h', nodeType: 'core.httpRequest', executionId: 'ex_brain_1', actorId: owner.id });
    expect(failed.message).not.toContain('12345');
    expect(events.find((e) => e.kind === 'run.finished')?.attrs).toMatchObject({ status: 'error', mode: 'trigger' });
    // Saved again (a retry writes the record twice): no duplicates.
    store.saveExecution(record);
    expect(query.listUsageEvents({ workflowId: wf.id }, { limit: 10 })).toHaveLength(3);
  });

  it('keeps the audit events it cares about', () => {
    ledger.recordAuditUsage({ id: 'au_1', at: new Date().toISOString(), action: 'workflow.update', outcome: 'success', actor: { id: owner.id, type: 'user' }, target: { type: 'workflow', id: 'wf_a' }, details: { source: 'editor' } } as never);
    ledger.recordAuditUsage({ id: 'au_2', at: new Date().toISOString(), action: 'credential.use', outcome: 'success', actor: { id: owner.id, type: 'user' }, target: { type: 'credential', id: 'cr_1', name: 'Slack' }, details: { workflowId: 'wf_a', nodeType: 'messaging.slack' } } as never);
    ledger.recordAuditUsage({ id: 'au_3', at: new Date().toISOString(), action: 'user.login', outcome: 'success', actor: { id: owner.id, type: 'user' } } as never);
    ledger.recordAuditUsage({ id: 'au_4', at: new Date().toISOString(), action: 'workflow.update', outcome: 'failure', actor: { id: owner.id, type: 'user' }, target: { type: 'workflow', id: 'wf_a' } } as never);
    const events = query.listUsageEvents({}, { limit: 10 });
    expect(events.map((e) => e.kind).sort()).toEqual(['credential.used', 'workflow.saved']);
    expect(events.find((e) => e.kind === 'credential.used')).toMatchObject({ workflowId: 'wf_a', nodeType: 'messaging.slack', attrs: { credentialId: 'cr_1' } });
  });

  it('groups a report, labels failure signatures with a message, and rolls up beyond retention', () => {
    workflow('wf_r', 'Report flow', [node('h', 'Call', 'core.httpRequest')]);
    runs('wf_r', 4);
    runs('wf_r', 2, { status: 'error' });
    fail('wf_r', 'h', 'Timeout after 3000 ms', 3);
    const byKind = query.usageReport({}, 'kind');
    expect(byKind.rows.find((r) => r.key === 'run.finished')).toMatchObject({ count: 6, failures: 2 });
    const bySignature = query.usageReport({ kinds: ['node.failed'] }, 'signature');
    expect(bySignature.rows[0]).toMatchObject({ count: 3 });
    expect(bySignature.rows[0].label).toContain('Timeout after');
    // Old events: the rollup answers once the window reaches past raw retention.
    ledger.recordUsage({ kind: 'run.finished', workflowId: 'wf_r', at: ago(120 * DAY), attrs: { status: 'success', mode: 'trigger' } });
    query.rollupMissing(database());
    const old = query.usageReport({ kinds: ['run.finished'], from: ago(130 * DAY) }, 'workflow');
    expect(old.rows[0]).toMatchObject({ key: 'wf_r', count: 7 });
    expect(query.ledgerSize(database()).events).toBeGreaterThan(0);
  });

  it('limits a report to the scope', () => {
    runs('wf_mine', 2);
    runs('wf_theirs', 3);
    const report = query.usageReport({}, 'workflow', { scope: { workflows: new Set(['wf_mine']), agents: new Set() } });
    expect(report.rows.map((r) => r.key)).toEqual(['wf_mine']);
  });
});

describe('the detectors', () => {
  it('find hot spots, flaky calls, hand-run rhythms, missing error workflows and unmet demand', async () => {
    workflow('wf_hot', 'Invoices', [node('t', 'Webhook', 'core.webhook'), node('h', 'Fetch customer', 'core.httpRequest')], [['t', 'h']], { active: true });
    runs('wf_hot', 10);
    fail('wf_hot', 'h', 'Customer 1234 has no billing address', 6);

    workflow('wf_flaky', 'CRM sync', [node('t', 'Webhook', 'core.webhook'), node('h', 'CRM', 'core.httpRequest')], [['t', 'h']], { active: true });
    runs('wf_flaky', 20);
    fail('wf_flaky', 'h', 'ETIMEDOUT connecting to crm.example.com', 4);

    workflow('wf_hand', 'Morning report', [node('m', 'Manual', 'core.manualTrigger'), node('s', 'Build', 'core.set')], [['m', 's']]);
    for (let d = 1; d <= 5; d++) ledger.recordUsage({ kind: 'run.finished', workflowId: 'wf_hand', at: ago(d * DAY), attrs: { status: 'success', mode: 'manual' } });

    workflow('wf_alerts', 'Failure alerts', [node('e', 'Error Trigger', 'core.errorTrigger')], [], { active: true });
    workflow('wf_unsafe', 'Payouts', [node('t', 'Webhook', 'core.webhook')], [], { active: true });
    runs('wf_unsafe', 3, { status: 'error' });

    ledger.recordUsage({ kind: 'search.empty', message: 'jira', actorId: 'u1' });
    ledger.recordUsage({ kind: 'search.empty', message: 'jira issue', actorId: 'u2' });
    ledger.recordUsage({ kind: 'spotlight.asked', message: 'create a jira ticket when a deal closes', actorId: 'u1', attrs: { proposals: 0 } });

    const result = await runDetectors({ enrich: false });
    expect(result.byDetector['failure-hot-spot']).toBeGreaterThanOrEqual(1);
    const open = proposals.listProposals({ status: 'open' });
    const by = (detector: string, workflowId?: string) => open.find((p) => p.detector === detector && (!workflowId || p.target.id === workflowId));

    expect(by('failure-hot-spot', 'wf_hot')).toMatchObject({ target: { nodeName: 'Fetch customer' }, risk: 'medium' });
    expect(by('failure-hot-spot', 'wf_flaky')).toBeUndefined(); // flaky failures are the flaky detector's

    expect(by('flaky-call', 'wf_flaky')?.ops).toEqual([{ op: 'setNodeSettings', node: 'CRM', settings: { retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 5_000 } }]);

    const hand = by('hand-run-rhythm', 'wf_hand')!;
    expect(hand.ops.map((o) => o.op)).toEqual(['addNode', 'connect']);

    expect(by('no-safety-net', 'wf_unsafe')?.ops).toEqual([{ op: 'setWorkflowSettings', settings: { errorWorkflowId: 'wf_alerts' } }]);

    expect(by('unmet-demand')).toMatchObject({ target: { type: 'instance', name: 'jira' } });
    expect(brainStatus().open).toBe(open.length);
  });

  it('suggest building a tool the Agent architect needed and no plugin has, with a sketch of the plugin', async () => {
    // A conversation that proposes twice notes the same need twice: it counts once.
    ledger.recordUsage({ kind: 'tool.missing', message: 'Read firing Grafana alerts', actorId: 'u1', attrs: { source: 'architect', system: 'Grafana', agent: 'Grafana Guardian' } });
    ledger.recordUsage({ kind: 'tool.missing', message: 'Read firing Grafana alerts', actorId: 'u1', attrs: { source: 'architect', system: 'Grafana', agent: 'Grafana Guardian' } });
    // A model that copied the format's placeholder ("App: …") still names the app in what it needed.
    ledger.recordUsage({ kind: 'tool.missing', message: 'Read Grafana alerts from a webhook', actorId: 'u2', attrs: { source: 'architect', system: 'App' } });
    // Spelled two ways, it's one app: a single suggestion, under neither Grafana.
    ledger.recordUsage({ kind: 'tool.missing', message: 'Open an incident', actorId: 'u1', attrs: { source: 'architect', system: 'Pager Duty' } });
    ledger.recordUsage({ kind: 'tool.missing', message: 'Page the on-call', actorId: 'u2', attrs: { source: 'architect', system: 'PagerDuty' } });
    // An architect ask that came to a draft isn't a dead end.
    ledger.recordUsage({ kind: 'spotlight.asked', message: 'Triage Grafana alerts and post to Slack', actorId: 'u1', attrs: { architect: true, proposals: 1 } });
    ledger.recordUsage({ kind: 'spotlight.asked', message: 'Grafana alerts to Slack', actorId: 'u2', attrs: { architect: true, proposals: 2 } });

    const { DETECTOR_RUNS, detectContext } = await import('@/lib/server/brain/detectors');
    const findings = DETECTOR_RUNS['missing-tool'](detectContext());
    expect(findings.map((f) => f.proposal.title)).toEqual(['Build a tool for Grafana', 'Build a tool for Pager Duty']);
    findings.splice(1);
    expect(findings[0].proposal).toMatchObject({ detector: 'missing-tool', title: 'Build a tool for Grafana', target: { type: 'instance', name: 'Grafana' }, effect: 'Agents can read firing Grafana alerts' });
    expect(findings[0].proposal.why).toContain('“Grafana Guardian”');
    expect(findings[0].proposal.evidence).toEqual(expect.arrayContaining([{ label: 'Needed (30 days)', value: 2 }, { label: 'People', value: 2 }, { label: 'How to build one', value: 'Build a plugin', href: '/developers' }]));

    const sketch = JSON.stringify({ nodes: [{ name: 'Get alerts', does: 'Lists firing alerts', parameters: ['state', 'folder'], credential: 'Grafana API token' }] });
    const model = { provider: 'test', model: 'brain', generate: async () => ({ text: sketch, toolCalls: [], stopReason: 'stop' as const }) };
    const [enriched] = await (await import('@/lib/server/brain/writer')).enrichFindings(findings, { model });
    expect(enriched.proposal.why).toContain('A plugin for Grafana could have: Get alerts: Lists firing alerts (parameters: state, folder), with a Grafana API token credential.');

    await runDetectors({ enrich: false, only: ['missing-tool', 'unmet-demand'] });
    const open = proposals.listProposals({ status: 'open' });
    expect(open.map((p) => p.title).sort()).toEqual(['Build a tool for Grafana', 'Build a tool for Pager Duty']);
  });

  it('treat a Stop and Error as a deliberate rejection, with no fix to write', async () => {
    workflow('wf_stop', 'Invoice intake', [node('t', 'Webhook', 'core.webhook'), node('x', 'Reject invoice', 'core.stopAndError', { message: 'No billing address' })], [['t', 'x']]);
    runs('wf_stop', 10);
    fail('wf_stop', 'x', 'Customer 206 has no billing address', 6, 'core.stopAndError');
    await runDetectors({ enrich: false, only: ['failure-hot-spot'] });
    const [p] = proposals.listProposals({ status: 'open' });
    expect(p).toMatchObject({ detector: 'failure-hot-spot', risk: 'low', ops: [] });
    expect(p.title).toContain('stops 6 runs a week');
    expect(p.why).toMatch(/on purpose/);
  });

  it('suggest one error workflow to create when there is none', async () => {
    workflow('wf_a', 'A', [node('t', 'Webhook', 'core.webhook')], [], { active: true });
    workflow('wf_b', 'B', [node('t', 'Webhook', 'core.webhook')], [], { active: true });
    runs('wf_a', 3, { status: 'error' });
    runs('wf_b', 4, { status: 'error' });
    await runDetectors({ enrich: false, only: ['no-safety-net'] });
    const [p] = proposals.listProposals({ status: 'open' });
    expect(p).toMatchObject({ target: { type: 'instance' }, draft: { name: 'Failure alerts' } });
  });
});

describe('suggestions', () => {
  const seedFlaky = () => {
    workflow('wf_flaky', 'CRM sync', [node('t', 'Webhook', 'core.webhook'), node('h', 'CRM', 'core.httpRequest')], [['t', 'h']], { active: true });
    runs('wf_flaky', 20);
    fail('wf_flaky', 'h', '503 Service Unavailable', 4);
  };

  it('refresh the open one instead of adding another, and stay away once dismissed as intended', async () => {
    seedFlaky();
    await runDetectors({ enrich: false, only: ['flaky-call'] });
    await runDetectors({ enrich: false, only: ['flaky-call'] });
    const open = proposals.listProposals({ status: 'open' });
    expect(open).toHaveLength(1);
    proposals.dismissProposal(open[0].id, 'intended', { note: 'the CRM rate-limits us on purpose' });
    expect(facts.listFacts({ subjectType: 'workflow', subjectId: 'wf_flaky', kind: 'intended' })[0].statement).toContain('rate-limits us on purpose');
    const again = await runDetectors({ enrich: false, only: ['flaky-call'] });
    expect(again).toMatchObject({ found: 1, saved: 0, held: 1 });
  });

  it('keep at most the weekly cap per workflow, the strongest ones', () => {
    process.env.LANDFLOW_BRAIN_WEEKLY_CAP = '2';
    workflow('wf_cap', 'Capped', [node('t', 'Webhook', 'core.webhook')]);
    const add = (title: string, confidence: number) => proposals.proposeFrom({ title, why: 'because', workflowId: 'wf_cap', confidence, risk: 'low' }, 'analyst');
    expect(add('One', 0.5)).toBeDefined();
    expect(add('Two', 0.6)).toBeDefined();
    expect(add('Weaker', 0.3)).toBeUndefined();
    expect(add('Stronger', 0.9)).toBeDefined();
    const open = proposals.listProposals({ status: 'open', workflowId: 'wf_cap' });
    expect(open.map((p) => p.title).sort()).toEqual(['Stronger', 'Two']);
  });

  it('check the ops of a suggestion from outside against the workflow', () => {
    workflow('wf_ops', 'Ops', [node('h', 'Call', 'core.httpRequest')]);
    const p = proposals.proposeFrom(
      { title: 'Retry the call', why: 'it times out', workflowId: 'wf_ops', nodeName: 'Call', ops: [{ op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true, bogus: 1 } }, { op: 'setParameters', node: 'Missing', parameters: {} }] },
      'workflow',
    )!;
    expect(p.ops).toEqual([{ op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true } }]);
    expect(p.target).toMatchObject({ nodeName: 'Call' });
    expect(p.warnings?.join(' ')).toMatch(/Missing/);
    expect(() => proposals.proposeFrom({ title: 'x', why: 'y', workflowId: 'wf_nope' }, 'analyst')).toThrow(/No workflow/);
    // Advice about a node that already has open advice is held back; a change to it is not.
    const advice = proposals.proposeFrom({ title: 'Look at the call', why: 'it fails', workflowId: 'wf_ops', nodeName: 'Call' }, 'analyst');
    expect(advice).toBeDefined();
    expect(proposals.proposeFrom({ title: 'Check the call again', why: 'still failing', workflowId: 'wf_ops', nodeName: 'Call' }, 'workflow')).toBeUndefined();
  });

  it('apply ops through governance, with the baseline their effect is measured against', async () => {
    seedFlaky();
    await runDetectors({ enrich: false, only: ['flaky-call'] });
    const [p] = proposals.listProposals({ status: 'open' });
    const result = proposals.applyProposal(p.id, { actorId: owner.id });
    expect(store.getWorkflow('wf_flaky')?.nodes.find((n) => n.name === 'CRM')).toMatchObject({ retryOnFail: true, maxTries: 3 });
    expect(result.proposal).toMatchObject({ status: 'applied', appliedBy: owner.id, outcome: 'pending', baseline: { metric: 'failureRate' } });
    expect(query.listUsageEvents({ kinds: ['proposal.applied'] })).toHaveLength(1);
    expect(() => proposals.applyProposal(p.id)).toThrow(/applied/);
  });

  it('apply a draft as a new workflow, persona rules to the agent’s draft, and refuse advice', () => {
    const draft = proposals.proposeFrom({ title: 'Create an alerts workflow', why: 'none exists', draft: { id: 'draft', name: 'Alerts', nodes: [node('e', 'Error Trigger', 'core.errorTrigger')], connections: [] } as Workflow }, 'analyst')!;
    const created = proposals.applyProposal(draft.id, { actorId: owner.id });
    expect(created.workflow).toMatchObject({ name: 'Alerts', active: false });
    expect(store.getWorkflow(created.workflow!.id)).toBeDefined();
    expect(created.proposal.createdWorkflowId).toBe(created.workflow!.id);

    const agent = agentStore.create({ name: 'Helper', persona: { always: ['Be brief'] } });
    const rules = proposals.proposeFrom({ title: 'Cite sources', why: 'people asked', agentId: agent.id, agentChange: { always: ['Cite the page you used'], never: ['Guess prices'] } }, 'analyst')!;
    proposals.applyProposal(rules.id);
    expect(agentStore.get(agent.id)?.persona).toMatchObject({ always: ['Be brief', 'Cite the page you used'], never: ['Guess prices'] });

    const advice = proposals.proposeFrom({ title: 'Talk to finance', why: 'costs rose' }, 'analyst')!;
    expect(() => proposals.applyProposal(advice.id)).toThrow(/advice only/);
  });

  it('measure the effect after 7 and 14 days, and remember it', () => {
    workflow('wf_fx', 'Effects', [node('t', 'Webhook', 'core.webhook')]);
    const appliedAt = Date.now() - 15 * DAY;
    // The week before: half the runs failed; the two weeks after: none.
    for (let i = 0; i < 10; i++) ledger.recordUsage({ kind: 'run.finished', workflowId: 'wf_fx', at: new Date(appliedAt - (i + 1) * 3_600_000).toISOString(), attrs: { status: i % 2 ? 'error' : 'success', mode: 'trigger' } });
    for (let i = 0; i < 10; i++) ledger.recordUsage({ kind: 'run.finished', workflowId: 'wf_fx', at: new Date(appliedAt + (i + 1) * DAY).toISOString(), attrs: { status: 'success', mode: 'trigger' } });
    const open = proposals.proposeFrom({ title: 'Fix it', why: 'it fails', workflowId: 'wf_fx' }, 'analyst')!;
    const applied = proposals.markApplied(open, {}, database(), appliedAt);
    expect(applied.baseline?.value).toBeCloseTo(0.5);
    const week = checkEffect(applied, appliedAt + 8 * DAY)!;
    expect(week.checks).toHaveLength(1);
    expect(week.outcome).toBe('pending');
    const done = checkEffect(week, appliedAt + 15 * DAY)!;
    expect(done.outcome).toBe('worked');
    expect(facts.getFact(`workflow:wf_fx:change:${open.id}`)?.statement).toMatch(/helped/);
    expect(checkEffect(done, appliedAt + 30 * DAY)).toBeUndefined();
    expect([outcomeOf(1, 0.95), outcomeOf(1, 1.2), outcomeOf(0, 0)]).toEqual(['no-effect', 'worse', 'no-effect']);
  });

  it('expire detector suggestions nobody confirmed, and quiet a detector people keep rejecting', async () => {
    seedFlaky();
    await runDetectors({ enrich: false, only: ['flaky-call'] });
    expect(proposals.expireStale(database(), Date.now() + 15 * DAY)).toBe(1);
    const db = database();
    for (let i = 0; i < 5; i++) {
      const p = proposals.upsertProposal({ source: 'detector', detector: 'slow-step', fingerprint: `slow-${i}`, target: { type: 'instance' }, title: `Slow ${i}`, why: 'slow', evidence: [], ops: [], risk: 'low', confidence: 0.5, score: 1 }, db)!;
      proposals.dismissProposal(p.id, 'wrong');
    }
    expect(proposals.detectorStats().find((s) => s.id === 'slow-step')).toMatchObject({ dismissed: 5, quiet: 3 });
  });
});

describe('flow detectors', () => {
  /** A detector flow: Detector Trigger → Suggest Improvement, whose why echoes the trigger's quiet. */
  const detectorFlow = (active = true, confidence = 0.6) =>
    workflow(
      'wf_overlap',
      'Overlap finder',
      [
        node('t', 'Detector', 'core.detectorTrigger'),
        node('s', 'Suggest', 'core.suggestImprovement', { title: 'Two teams build the same thing', why: "=Quiet {{ $json.quiet }}, bar {{ $json.minConfidence }}", risk: 'low', confidence }),
      ],
      [['t', 's']],
      { active },
    );

  it('run on the brain’s look, post as the detector, refresh instead of duplicating, and expire once unconfirmed', async () => {
    detectorFlow();
    expect(listFlowDetectors()).toEqual([{ id: 'flow:wf_overlap', workflowId: 'wf_overlap', name: 'Overlap finder', active: true }]);
    const result = await runDetectors({ enrich: false });
    expect(result.byDetector['flow:wf_overlap']).toBe(1);
    expect(result.flows).toEqual([expect.objectContaining({ id: 'flow:wf_overlap', status: 'success', found: 1, saved: 1 })]);
    const [suggestion] = proposals.listProposals({ status: 'open', detector: 'flow:wf_overlap' });
    expect(suggestion).toMatchObject({ source: 'detector', detector: 'flow:wf_overlap', label: 'Overlap finder', why: 'Quiet 1, bar 0', target: { type: 'instance' } });

    // Found again: the same suggestion, refreshed.
    const again = await runDetectors({ enrich: false, only: ['flow:wf_overlap'] });
    expect(again.flows?.[0]).toMatchObject({ found: 1, saved: 1 });
    expect(proposals.listProposals({ status: 'open' })).toHaveLength(1);

    // Nobody confirmed it for 14 days: it expires, as built-in detectors' suggestions do.
    expect(proposals.expireStale(database(), Date.now() + 15 * DAY)).toBe(1);
  });

  it('get quieter when people reject them, and the flow sees how quiet', async () => {
    detectorFlow(true, 0.7);
    const db = database();
    for (let i = 0; i < 5; i++) {
      const p = proposals.upsertProposal({ source: 'detector', detector: 'flow:wf_overlap', label: 'Overlap finder', fingerprint: `o-${i}`, target: { type: 'instance' }, title: `Overlap ${i}`, why: 'same goal', evidence: [], ops: [], risk: 'low', confidence: 0.7, score: 1 }, db)!;
      proposals.dismissProposal(p.id, 'wrong');
    }
    expect(proposals.quietOf('flow:wf_overlap')).toBe(3);
    expect(proposals.detectorStats().find((s) => s.id === 'flow:wf_overlap')).toMatchObject({ label: 'Overlap finder', workflowId: 'wf_overlap', active: true, dismissed: 5, quiet: 3 });

    // Confidence 0.7 is under the bar at quiet 3 (0.8): held back, and the node says why.
    const result = await runDetectors({ enrich: false, only: ['flow:wf_overlap'] });
    expect(result.flows?.[0]).toMatchObject({ found: 1, saved: 0 });
    const record = store.getExecution(result.flows![0].executionId!)!;
    const out = record.runData.s?.[0].outputs[0][0].json as { saved: boolean; reason: string };
    expect(out).toMatchObject({ saved: false });
    expect(out.reason).toContain('quieted');
    expect(proposals.listProposals({ status: 'open' })).toHaveLength(0);
  });

  it('only run when published, are listed with their record, and run alone from Run now', async () => {
    detectorFlow(false);
    expect((await runDetectors({ enrich: false })).flows).toBeUndefined();
    expect(brainStatus().detectors.find((d) => d.id === 'flow:wf_overlap')).toMatchObject({ label: 'Overlap finder', active: false, made: 0 });
    expect((await call(runRoute.POST, '/api/brain/run', { json: { what: 'detect', detector: 'flow:wf_overlap' } })).status).toBe(409);
    expect((await call(runRoute.POST, '/api/brain/run', { json: { what: 'detect', detector: 'flow:wf_nope' } })).status).toBe(404);
    expect((await call(runRoute.POST, '/api/brain/run', { json: { what: 'detect', detector: 'not-a-detector' } })).status).toBe(400);

    detectorFlow(true);
    const ran = await call(runRoute.POST, '/api/brain/run', { json: { what: 'detect', detector: 'flow:wf_overlap' } });
    expect(ran.status).toBe(200);
    expect(ran.body.detect).toMatchObject({ found: 1, saved: 1, byDetector: { 'flow:wf_overlap': 1 } });
    const listed = await call(proposalsRoute.GET, '/api/proposals?detector=flow:wf_overlap');
    expect((listed.body.proposals as Proposal[]).map((p) => p.detector)).toEqual(['flow:wf_overlap']);

    // A built-in detector alone runs no flows.
    const builtin = await call(runRoute.POST, '/api/brain/run', { json: { what: 'detect', detector: 'flaky-call' } });
    expect((builtin.body.detect as { flows?: unknown }).flows).toBeUndefined();
  });

  it('measure an applied finding about a workflow like any other', async () => {
    workflow('wf_target', 'Target', [node('h', 'Call', 'core.httpRequest')]);
    workflow('wf_overlap', 'Overlap finder', [node('t', 'Detector', 'core.detectorTrigger'), node('s', 'Suggest', 'core.suggestImprovement')], [['t', 's']], { active: true });
    const p = proposals.proposeFrom({ title: 'Retry the call', why: 'timeouts', workflowId: 'wf_target', ops: [{ op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true } }] }, 'workflow', database(), { detector: 'flow:wf_overlap' })!;
    expect(p).toMatchObject({ source: 'detector', detector: 'flow:wf_overlap' });
    const applied = proposals.applyProposal(p.id);
    expect(applied.proposal.baseline).toMatchObject({ metric: 'failureRate' });
  });
});

describe('study', () => {
  it('profiles workflows and writes facts without a model', async () => {
    workflow('wf_s', 'Lead intake', [node('t', 'Webhook', 'core.webhook'), node('h', 'Enrich', 'core.httpRequest')], [['t', 'h']], { active: true });
    runs('wf_s', 8);
    runs('wf_s', 2, { status: 'error' });
    const result = await study({ embed: false });
    expect(result.workflows).toBeGreaterThanOrEqual(1);
    const profile = facts.getProfile('workflow', 'wf_s');
    expect(profile?.purpose).toBeTruthy();
    expect(facts.listFacts({ subjectType: 'workflow', subjectId: 'wf_s' }).map((f) => f.kind)).toEqual(expect.arrayContaining(['purpose', 'health']));
    expect(facts.searchFacts('lead intake')[0]?.subjectId).toBe('wf_s');
    const all = await runBrain('effects');
    expect(all).toMatchObject({ expired: 0, effects: 0 });
  });

  it('knows the agents a Run a Team node runs', async () => {
    const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
    const leadAgent = agentStore.create({ name: 'Study lead', instructions: 'Lead.' });
    const team = agentTeamStore.create({ name: 'Study team', members: [{ id: 'm_lead', title: 'Lead', kind: 'agent', agentId: leadAgent.id }] });
    workflow('wf_team_study', 'Team review', [node('t', 'Start', 'core.manualTrigger'), { ...node('r', 'Review', 'core.runTeam'), parameters: { teamId: team.id, message: 'Review' } }], [['t', 'r']]);
    await study({ embed: false });
    expect(facts.getProfile('workflow', 'wf_team_study')?.uses).toContainEqual({ type: 'agent', id: leadAgent.id, name: 'Study lead' });
  });
});

describe('the nodes', () => {
  it('Landflow Usage reports, searches facts and lists suggestions', async () => {
    workflow('wf_test', 'Reader', [node('u', 'Usage', 'core.landflowUsage')]);
    workflow('wf_n', 'Busy', [node('h', 'Call', 'core.httpRequest')]);
    runs('wf_n', 3);
    fail('wf_n', 'h', 'Bad gateway 502', 2);
    const report = await runOk(landflowUsageNode, { operation: 'report', groupBy: 'workflow', kinds: [], days: 7, limit: 10, oneItem: false });
    expect(report.json().find((r) => r.key === 'wf_n')).toMatchObject({ label: 'Busy', count: 5 });
    const one = await runOk(landflowUsageNode, { operation: 'events', kinds: ['node.failed'], days: 7, limit: 10, oneItem: true });
    expect((one.json()[0] as { events: UsageEvent[] }).events).toHaveLength(2);
    proposals.proposeFrom({ title: 'Look at Busy', why: 'it fails', workflowId: 'wf_n' }, 'analyst');
    const open = await runOk(landflowUsageNode, { operation: 'proposals', status: 'open', limit: 10, oneItem: false });
    expect(open.json()[0]).toMatchObject({ title: 'Look at Busy' });
    const known = await runOk(landflowUsageNode, { operation: 'workflow', workflowId: 'wf_n' });
    expect(known.json()[0]).toMatchObject({ name: 'Busy', proposals: [expect.objectContaining({ title: 'Look at Busy' })] });
  });

  it('Suggest Improvement files a suggestion from a workflow', async () => {
    workflow('wf_test', 'Analyst flow', [node('s', 'Suggest', 'core.suggestImprovement')]);
    workflow('wf_target', 'Target', [node('h', 'Call', 'core.httpRequest')]);
    const out = await runOk(suggestImprovementNode, { title: 'Retry the call', why: 'timeouts', workflowId: 'wf_target', nodeName: 'Call', ops: JSON.stringify([{ op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true } }]), risk: 'low', confidence: 0.7 });
    expect(out.json()[0]).toMatchObject({ saved: true, proposal: { source: 'workflow', label: 'Analyst flow', target: { id: 'wf_target' } } });
    const again = await runOk(suggestImprovementNode, { title: 'Retry the call', why: 'timeouts', workflowId: 'wf_target', ops: '[]' });
    expect(proposals.listProposals({ status: 'open' })).toHaveLength(1);
    expect(again.json()[0]).toMatchObject({ saved: true });
  });

  it('On Usage Event matches by kind, workflow, new failures and cost', () => {
    const failed = { id: 'e1', at: new Date().toISOString(), day: '', kind: 'node.failed', workflowId: 'wf_a', signature: 'sig1' } as UsageEvent;
    expect(matches(failed, { kinds: ['node.failed'] })).toBe(true);
    expect(matches(failed, { kinds: ['ai.call'] })).toBe(false);
    expect(matches(failed, { kinds: [], workflowId: 'wf_b' })).toBe(false);
    const call = { id: 'e2', at: new Date().toISOString(), day: '', kind: 'ai.call', cost: 0.002 } as UsageEvent;
    expect(matches(call, { kinds: ['ai.call'], minCost: 0.01 })).toBe(false);
    expect(matches(call, { kinds: ['ai.call'], minCost: 0.001 })).toBe(true);
    // Only new: a signature seen before doesn't match.
    ledger.recordUsage({ kind: 'node.failed', workflowId: 'wf_a', signature: 'sig_old', at: ago(DAY) });
    const repeat = ledger.recordUsage({ kind: 'node.failed', workflowId: 'wf_a', signature: 'sig_old' })!;
    const fresh = ledger.recordUsage({ kind: 'node.failed', workflowId: 'wf_a', signature: 'sig_new' })!;
    expect(matches(repeat, { kinds: ['node.failed'], onlyNew: true })).toBe(false);
    expect(matches(fresh, { kinds: ['node.failed'], onlyNew: true })).toBe(true);
  });

  it('Build it: approving a missing tool hands the whole suggestion to the workflows that build one', async () => {
    resetUsageTrigger();
    ledger.recordUsage({ kind: 'tool.missing', message: 'Read firing Grafana alerts', actorId: 'u1', attrs: { source: 'architect', system: 'Grafana' } });
    await runDetectors({ enrich: false, only: ['missing-tool'] });
    const [suggestion] = proposals.listProposals({ status: 'open' });
    expect(suggestion).toMatchObject({ detector: 'missing-tool', title: 'Build a tool for Grafana' });

    // Nobody builds it yet: approved all the same, with a warning saying what to publish.
    const first = proposals.applyProposal(suggestion.id, { actorId: 'u1' });
    expect(first.proposal.status).toBe('applied');
    expect(first.warnings.join(' ')).toContain('Nothing builds it yet');
    expect(first.started).toBeUndefined();
    const [applied] = query.listUsageEvents({ kinds: ['proposal.applied'] }, { limit: 5 });
    expect(applied.attrs).toMatchObject({ proposal: suggestion.id, detector: 'missing-tool' });

    // The trigger filters by detector, and each item carries the suggestion, plugin sketch and all.
    expect(matches(applied, { kinds: ['proposal.applied'], detector: 'missing-tool' })).toBe(true);
    expect(matches(applied, { kinds: ['proposal.applied'], detector: 'failure-hot-spot' })).toBe(false);
    const [item] = usageItems([applied]);
    expect(item.json).toMatchObject({ kind: 'proposal.applied', proposal: { id: suggestion.id, title: 'Build a tool for Grafana', target: { type: 'instance', name: 'Grafana' } } });
    expect((item.json.proposal as { why: string }).why).toContain('Read firing Grafana alerts');

    // With a published builder, the next approval names it.
    workflow('wf_builder', 'Build a plugin', [node('u', 'On approval', 'core.usageTrigger', { kinds: ['proposal.applied'], detector: 'missing-tool' })], [], { active: true });
    workflow('wf_other', 'Failure watcher', [node('u', 'On usage', 'core.usageTrigger', { kinds: ['proposal.applied'], detector: 'failure-hot-spot' })], [], { active: true });
    expect(proposals.builders()).toEqual([{ id: 'wf_builder', name: 'Build a plugin' }]);
    resetUsageTrigger();
  });

  it('On Usage Event ignores what its own workflows do', () => {
    resetUsageTrigger();
    workflow('wf_watch', 'Watcher', [node('u', 'On usage', 'core.usageTrigger', { kinds: ['node.failed'], batchSeconds: 0 })], [], { active: true });
    // An event from the watching workflow itself never starts it (no loops); nothing throws either way.
    expect(() => dispatchUsage({ id: 'e', at: new Date().toISOString(), day: '', kind: 'node.failed', workflowId: 'wf_watch' } as UsageEvent)).not.toThrow();
    resetUsageTrigger();
  });

  it('the analyst’s tools are Landflow Usage and Suggest Improvement nodes with model-filled arguments', () => {
    const config = analystConfig();
    expect(config.tools?.map((t) => (t.type === 'node' ? t.nodeType : t.type))).toEqual(['core.landflowUsage', 'core.landflowUsage', 'core.landflowUsage', 'core.landflowUsage', 'core.landflowUsage', 'core.brainEntity', 'core.brainEntity', 'core.suggestImprovement']);
    const lookup = registryLookup();
    for (const tool of config.tools ?? []) if (tool.type === 'node') expect(lookup(tool.nodeType)).toBeDefined();
  });
});

describe('the settings operations', () => {
  it('set whitelisted node and workflow settings, and describe them', () => {
    const wf = { id: 'w', name: 'W', nodes: [node('h', 'Call', 'core.httpRequest')], connections: [] } as unknown as Workflow;
    const { ops, dropped } = parseOps([
      { op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true, maxTries: 4, parameters: { url: 'x' } } },
      { op: 'setWorkflowSettings', settings: { errorWorkflowId: 'wf_err', timeoutSeconds: 60, owner: 'me' } },
    ]);
    expect(dropped).toEqual([]);
    expect(ops).toEqual([
      { op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true, maxTries: 4 } },
      { op: 'setWorkflowSettings', settings: { errorWorkflowId: 'wf_err', timeoutSeconds: 60 } },
    ]);
    const result = applyOps(wf, ops, registryLookup());
    expect(result.workflow.nodes[0]).toMatchObject({ retryOnFail: true, maxTries: 4 });
    expect(result.workflow.nodes[0].parameters).toEqual({});
    expect(result.workflow.settings).toMatchObject({ errorWorkflowId: 'wf_err', timeoutSeconds: 60 });
    expect(describeOps(ops).length).toBe(2);
  });
});

describe('the routes', () => {
  it('list, decide and apply suggestions', async () => {
    workflow('wf_route', 'Route flow', [node('h', 'Call', 'core.httpRequest')]);
    const created = await call(proposalsRoute.POST, '/api/proposals', { json: { title: 'Retry the call', why: 'timeouts', workflowId: 'wf_route', ops: [{ op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true } }] } });
    expect(created.status).toBe(201);
    const id = (created.body.proposal as Proposal).id;
    expect((created.body.proposal as Proposal).source).toBe('analyst');
    expect((await call(proposalsRoute.POST, '/api/proposals', { json: { title: 'x', why: 'y', workflowId: 'wf_missing' } })).status).toBe(404);

    const list = await call(proposalsRoute.GET, '/api/proposals?status=open&workflowId=wf_route');
    expect((list.body.proposals as Proposal[]).map((p) => p.id)).toEqual([id]);
    expect((await call(proposalRoute.GET, `/api/proposals/${id}`, {}, { id })).body.proposal).toMatchObject({ id });

    const snoozed = await call(proposalRoute.PATCH, `/api/proposals/${id}`, { method: 'PATCH', json: { action: 'snooze', days: 3 } }, { id });
    expect(snoozed.body.proposal).toMatchObject({ status: 'snoozed' });
    expect((await call(proposalRoute.PATCH, `/api/proposals/${id}`, { method: 'PATCH', json: { action: 'dismiss', reason: 'maybe' } }, { id })).status).toBe(400);

    const applied = await call(applyRoute.POST, `/api/proposals/${id}/apply`, { method: 'POST' }, { id });
    expect(applied.status).toBe(200);
    expect(store.getWorkflow('wf_route')?.nodes[0].retryOnFail).toBe(true);
    expect((await call(applyRoute.POST, `/api/proposals/${id}/apply`, { method: 'POST' }, { id })).status).toBe(409);

    const other = proposals.proposeFrom({ title: 'Set a timeout', why: 'slow', workflowId: 'wf_route' }, 'analyst')!;
    const marked = await call(appliedRoute.POST, `/api/proposals/${other.id}/applied`, { method: 'POST' }, { id: other.id });
    expect(marked.body.proposal).toMatchObject({ status: 'applied' });
    expect((await call(proposalRoute.GET, '/api/proposals/pr_nope', {}, { id: 'pr_nope' })).status).toBe(404);
  });

  it('report usage, take editor signals, and show what the brain knows', async () => {
    workflow('wf_k', 'Known', [node('h', 'Call', 'core.httpRequest')]);
    runs('wf_k', 3);
    const report = await call(usageRoute.GET, '/api/usage?groupBy=workflow');
    expect((report.body.rows as Array<{ key: string; label?: string }>)[0]).toMatchObject({ key: 'wf_k', label: 'Known' });
    expect((await call(signalRoute.POST, '/api/usage/signal', { json: { kind: 'search.empty', query: 'salesforce', workflowId: 'wf_k' } })).status).toBe(200);
    expect((await call(signalRoute.POST, '/api/usage/signal', { json: { kind: 'other', query: 'x' } })).status).toBe(400);
    expect(query.listUsageEvents({ kinds: ['search.empty'] })[0]).toMatchObject({ message: 'salesforce', workflowId: 'wf_k' });

    await study({ embed: false });
    const status = await call(statusRoute.GET, '/api/brain/status');
    expect(status.body).toMatchObject({ enabled: true, model: 'off' });
    expect(status.body.facts).toBeGreaterThan(0);
    const found = await call(factsRoute.GET, '/api/brain/facts?q=known');
    expect((found.body.facts as Array<{ subjectId: string }>)[0]?.subjectId).toBe('wf_k');
    const listed = await call(factsRoute.GET, '/api/brain/facts?subjectType=workflow&kind=health');
    expect((listed.body.facts as unknown[]).length).toBeGreaterThan(0);
    const knowledge = await call(knowledgeRoute.GET, '/api/brain/workflows/wf_k', {}, { id: 'wf_k' });
    expect(knowledge.body).toMatchObject({ profile: { subjectId: 'wf_k' }, proposals: [] });
    expect((await call(knowledgeRoute.GET, '/api/brain/workflows/wf_gone', {}, { id: 'wf_gone' })).status).toBe(404);
  });

  it('make the Platform analyst, published', async () => {
    const made = await call(analystRoute.POST, '/api/brain/analyst', { method: 'POST' });
    expect(made.status).toBe(201);
    const agent = made.body.agent as { id: string; name: string; published?: { version: number } };
    expect(agent).toMatchObject({ name: 'Platform analyst', published: { version: 1 } });
    expect(agentStore.get(agent.id)?.tools).toHaveLength(8);
    // It starts on the brain's model (off here, so the builder's), so it can answer right away.
    expect(agentStore.get(agent.id)?.model).toMatchObject({ provider: 'ollama' });
  });
});

describe('find similar', () => {
  let alice: Awaited<ReturnType<typeof createUser>>;
  let alpha: ReturnType<typeof createTeamProject>;
  let beta: ReturnType<typeof createTeamProject>;
  const aliceActor = () => ({ id: alice.id, role: 'member' as const });

  /** Alice is in Alpha only. Alpha has "Invoice reminders", Beta (made by Owner) has "Overdue invoice nagger" and a secret fact. */
  async function seed() {
    alice ??= await createUser({ email: 'alice@brain.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
    alpha ??= createTeamProject({ name: 'Alpha', createdBy: owner.id });
    beta ??= createTeamProject({ name: 'Beta', createdBy: owner.id });
    setMember(alpha.id, alice.id, 'editor');
    const mine = workflow('wf_inv_a', 'Invoice reminders', [node('h', 'Call', 'core.httpRequest')], [], { description: 'Email customers who have not paid their invoices', createdBy: alice.id });
    const theirs = workflow('wf_inv_b', 'Overdue invoice nagger', [node('h', 'Call', 'core.httpRequest')], [], { description: 'Remind customers of unpaid invoices every Monday.\nUses the Stripe key sk-hidden', createdBy: owner.id });
    const other = workflow('wf_crm', 'Sync CRM contacts', [node('h', 'Call', 'core.httpRequest')], [], { description: 'Copy contacts to the warehouse', createdBy: alice.id });
    setHomeProject('workflow', mine.id, alpha.id);
    setHomeProject('workflow', other.id, alpha.id);
    setHomeProject('workflow', theirs.id, beta.id);
    facts.upsertFact({ subjectType: 'workflow', subjectId: 'wf_inv_b', subjectName: 'Overdue invoice nagger', kind: 'usage', statement: 'Nags unpaid invoice customers using the sk-hidden-fact key', evidence: [{ label: 'secret evidence' }], confidence: 0.9, projectId: beta.id });
    facts.upsertFact({ subjectType: 'workflow', subjectId: 'wf_inv_a', subjectName: 'Invoice reminders', kind: 'usage', statement: 'Reminds unpaid invoice customers by email', evidence: [], confidence: 0.9, projectId: alpha.id });
  }

  it('ranks workflows by shared words without a model, best first', async () => {
    await seed();
    const found = await findSimilar('Remind customers about unpaid invoices', { scope: undefined, kinds: ['workflow'] });
    expect(found.map((m) => m.title)).toEqual(expect.arrayContaining(['Invoice reminders', 'Overdue invoice nagger']));
    expect(found.some((m) => m.title === 'Sync CRM contacts')).toBe(false);
    expect(found[0].score).toBeGreaterThanOrEqual(found[1].score);
    expect(await findSimilar('   ')).toEqual([]);
    expect(await findSimilar('Remind customers about unpaid invoices', { kinds: ['workflow'], minScore: 0.99 })).toEqual([]);
    expect(await findSimilar('Remind customers about unpaid invoices', { kinds: ['workflow'], exclude: { workflowId: 'wf_inv_a' } })).not.toContainEqual(expect.objectContaining({ title: 'Invoice reminders' }));
  });

  it('gives full detail for your own projects and only a projection for the rest', async () => {
    await seed();
    const scope = scopeForActor(aliceActor());
    const mine = await findSimilar('Remind customers about unpaid invoices', { scope });
    expect(mine.map((m) => m.title)).toContain('Invoice reminders');
    expect(JSON.stringify(mine)).not.toMatch(/Overdue|sk-hidden|wf_inv_b/);
    expect(mine.find((m) => m.title === 'Invoice reminders' && m.type === 'workflow')).toMatchObject({ yours: true, id: 'wf_inv_a', type: 'workflow', owner: 'Alice', project: 'Alpha' });

    const withOthers = await findSimilar('Remind customers about unpaid invoices', { scope, includeOthers: true });
    const wall = withOthers.find((m) => m.title === 'Overdue invoice nagger')!;
    // Exactly the six projection fields: no id (nothing that grants access), no description, no facts, no evidence.
    expect(Object.keys(wall).sort()).toEqual(['goal', 'owner', 'project', 'score', 'title', 'type']);
    expect(wall).toMatchObject({ type: 'workflow', owner: 'Owner', project: 'Beta', goal: 'Remind customers of unpaid invoices every Monday.' });
    const text = JSON.stringify(withOthers);
    expect(text).not.toMatch(/wf_inv_b|sk-hidden|secret evidence|Stripe/);
    // Facts of the other project are never listed, even when only facts are asked for.
    const factsOnly = await findSimilar('unpaid invoice customers', { scope, kinds: ['fact'], includeOthers: true });
    expect(factsOnly.every((m) => 'yours' in m && m.type === 'fact')).toBe(true);
    expect(JSON.stringify(factsOnly)).not.toMatch(/sk-hidden/);
    expect(factsOnly[0]).toMatchObject({ subject: { id: 'wf_inv_a' } });
  });

  it('is the Find Similar node: one item per match, as the creator of the workflow sees', async () => {
    await seed();
    workflow('wf_test', 'Asker', [node('f', 'Find', 'core.findSimilar')], [], { createdBy: alice.id });
    const mine = await runOk(findSimilarNode, { text: 'Remind customers about unpaid invoices', what: ['workflow'], limit: 10, minScore: 0.15, includeOthers: false });
    expect(mine.json().map((r) => r.title)).toEqual(['Invoice reminders']);
    const all = await runOk(findSimilarNode, { text: 'Remind customers about unpaid invoices', what: 'workflow,agent', limit: 10, minScore: 0.15, includeOthers: true });
    const wall = all.json().find((r) => r.title === 'Overdue invoice nagger')!;
    expect(wall).not.toHaveProperty('id');
    expect(wall).not.toHaveProperty('yours');
    await expect(runOk(findSimilarNode, { text: '', what: [], limit: 10, minScore: 0.15, includeOthers: false })).rejects.toThrow(/title and a goal/);
  });

  it('keeps workflows out of the brain’s vector collections', async () => {
    for (const collection of ['landflow-brain', 'landflow-brain-prj_x', ' Landflow-Brain-prj_x ']) {
      await expect(runOk(inMemoryVectorStoreNode, { mode: 'insert', collection })).rejects.toThrow(/second brain’s own collection/);
      await expect(runOk(inMemoryVectorStoreNode, { mode: 'load', collection, prompt: 'x', topK: 1 })).rejects.toThrow(/Find Similar/);
    }
    // Another name is not caught by the guard (it fails later, for the missing embeddings model).
    await expect(runOk(inMemoryVectorStoreNode, { mode: 'load', collection: 'landflow-brainstorm', prompt: 'x', topK: 1 })).rejects.toThrow(/embeddings/);
  });

  describe('over the instance MCP server', () => {
    type Result = { isError?: boolean; content: Array<{ text: string }> };
    async function connect(actor?: { id: string; role: 'member' | 'owner' }, scope?: { projectId: string }) {
      const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await instanceServer(actor, scope).connect(serverSide);
      const client = new Client({ name: 'brain-test', version: '1.0.0' });
      await client.connect(clientSide);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = (await client.callTool({ name, arguments: args })) as Result;
        const text = result.content[0].text;
        return { error: Boolean(result.isError), text, data: result.isError ? undefined : (JSON.parse(text) as Record<string, any>) };
      };
      return { client, call };
    }

    it('lists the brain tools', async () => {
      const { client } = await connect();
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['brain_search_facts', 'brain_list_suggestions', 'brain_workflow_knowledge', 'brain_usage_report', 'check_overlap', 'brain_suggest']));
      await client.close();
    });

    it('scope every tool to what the caller can open', async () => {
      await seed();
      runs('wf_inv_a', 2);
      runs('wf_inv_b', 3);
      proposals.proposeFrom({ title: 'Retry the nagger', why: 'timeouts', workflowId: 'wf_inv_b' }, 'analyst');
      proposals.proposeFrom({ title: 'Retry the reminder', why: 'timeouts', workflowId: 'wf_inv_a' }, 'analyst');
      const { client, call } = await connect(aliceActor());

      const found = await call('brain_search_facts', { query: 'unpaid invoice customers' });
      expect(found.data!.facts.map((f: { subjectId: string }) => f.subjectId)).toEqual(['wf_inv_a']);
      const open = await call('brain_list_suggestions', {});
      expect(open.data!.proposals.map((p: { title: string }) => p.title)).toEqual(['Retry the reminder']);
      expect((await call('brain_list_suggestions', { workflowId: 'wf_inv_b' })).error).toBe(true);
      expect((await call('brain_list_suggestions', { detector: 'nope' })).error).toBe(true);
      expect((await call('brain_workflow_knowledge', { workflowId: 'wf_inv_a' })).data).toMatchObject({ name: 'Invoice reminders', facts: [expect.objectContaining({ kind: 'usage' })] });
      const hidden = await call('brain_workflow_knowledge', { workflowId: 'wf_inv_b' });
      expect(hidden.error).toBe(true);
      expect(hidden.text).toMatch(/not found/);
      const report = await call('brain_usage_report', { groupBy: 'workflow', days: 7 });
      expect(report.data!.rows.map((r: { key: string }) => r.key)).toEqual(['wf_inv_a']);
      expect((await call('brain_usage_report', { workflowId: 'wf_inv_b' })).error).toBe(true);

      // check_overlap looks past the wall, as a projection.
      const overlap = await call('check_overlap', { text: 'Remind customers about unpaid invoices' });
      const wall = overlap.data!.matches.find((m: { title: string }) => m.title === 'Overdue invoice nagger');
      expect(Object.keys(wall).sort()).toEqual(['goal', 'owner', 'project', 'score', 'title', 'type']);
      expect(overlap.text).not.toMatch(/wf_inv_b|sk-hidden|secret evidence/);
      expect((await call('check_overlap', { text: 'Remind customers about unpaid invoices', includeOthers: false })).text).not.toContain('Overdue');
      await client.close();
    });

    it('lets the instance token see everything and a project server only its project', async () => {
      await seed();
      const instance = await connect();
      const all = await instance.call('check_overlap', { text: 'Remind customers about unpaid invoices' });
      expect(all.data!.matches.filter((m: { yours?: boolean }) => m.yours).map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['wf_inv_a', 'wf_inv_b']));
      await instance.client.close();

      const scoped = await connect({ id: owner.id, role: 'owner' }, { projectId: beta.id });
      expect((await scoped.call('brain_workflow_knowledge', { workflowId: 'wf_inv_a' })).error).toBe(true);
      expect((await scoped.call('brain_workflow_knowledge', { workflowId: 'wf_inv_b' })).error).toBe(false);
      const nearby = await scoped.call('check_overlap', { text: 'Remind customers about unpaid invoices' });
      const reminders = nearby.data!.matches.find((m: { title: string }) => m.title === 'Invoice reminders');
      expect(reminders).not.toHaveProperty('id');
      expect((await scoped.call('brain_suggest', { title: 'Instance-wide', why: 'x' })).text).toMatch(/scoped to a project/);
      await scoped.client.close();
    });

    it('posts a suggestion only where the caller can edit', async () => {
      await seed();
      const { client, call } = await connect(aliceActor());
      const saved = await call('brain_suggest', { title: 'Add a retry', why: 'it timed out', workflowId: 'wf_inv_a', ops: [{ op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true } }] });
      expect(saved.data).toMatchObject({ saved: true, proposal: { source: 'analyst', target: { id: 'wf_inv_a' } } });
      expect((await call('brain_suggest', { title: 'Meddle', why: 'x', workflowId: 'wf_inv_b' })).error).toBe(true);
      expect((await call('brain_suggest', { title: 'Meddle', why: 'x' })).error).toBe(true);
      expect((await call('brain_suggest', { title: 'Meddle', why: 'x', workflowId: 'wf_missing' })).text).toMatch(/not found/);
      expect(proposals.listProposals({ status: 'open', workflowId: 'wf_inv_b' })).toHaveLength(0);
      await client.close();
    });
  });
});
