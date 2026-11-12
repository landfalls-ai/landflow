/**
 * Backtesting detectors (docs/second-brain.md#backtesting-a-detector): a built-in detector rerun as of past points over
 * seeded ledger history and scored against seeded decisions (hits, false alarms, misses), the ledger view that hides the
 * future, a detector flow's backtest (nothing written, would-be findings scored), the quiet override, Landflow Usage as
 * of a moment, the gate, and the routes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { BacktestResult } from '@/lib/shared/brain';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-backtest-'));
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
const ledger = await import('@/lib/server/usage/ledger');
const proposals = await import('@/lib/server/brain/proposals');
const { backtestDetector, listBacktests, asOfView, BacktestError } = await import('@/lib/server/brain/backtest');
const { inBacktest } = await import('@/lib/server/brain/backtest-scope');
const { landflowUsageNode } = await import('@/lib/server/nodes/usage');
const { run } = await import('./helpers');
const route = await import('@/app/api/brain/backtest/route');

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@backtest.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function node(id: string, name: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode {
  return { id, name, type, typeVersion: 1, position: [0, 0], parameters };
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

/** `n` failures of one node, the first an hour before `daysAgo` days ago. */
function failures(workflowId: string, daysAgo: number, n = 6) {
  for (let i = 0; i < n; i++) {
    const message = 'Customer not found (status 404)';
    ledger.recordUsage({ kind: 'node.failed', workflowId, nodeId: 'n1', nodeType: 'core.httpRequest', message, signature: ledger.signatureOf('core.httpRequest', message), at: ago(daysAgo * DAY + (i + 1) * HOUR), attrs: { mode: 'trigger' } });
  }
}

function clear() {
  const db = database();
  const columns = { usage_events: 'at', usage_daily: 'day', proposals: 'created_at', brain_backtests: 'created_at' } as const;
  for (const [table, column] of Object.entries(columns)) db.deleteBefore(table as keyof typeof columns, column, '9999');
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
}

async function call(handler: unknown, url: string, init: { json?: unknown } = {}) {
  const request = new Request(`http://localhost${url}`, { ...(init.json !== undefined ? { method: 'POST', body: JSON.stringify(init.json), headers: { 'content-type': 'application/json' } } : {}) });
  const response = await (handler as (r: Request) => Promise<Response>)(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A decided suggestion with this fingerprint of this detector. */
function decide(detector: string, fingerprint: string, how: 'applied' | 'wrong' | 'intended' | 'done' | 'open', title = fingerprint) {
  const p = proposals.upsertProposal({ source: 'detector', detector: detector as never, fingerprint, target: { type: 'instance' }, title, why: 'x', evidence: [], ops: [], risk: 'low', confidence: 0.7, score: 1 }, database())!;
  if (how === 'wrong' || how === 'intended' || how === 'done') proposals.dismissProposal(p.id, how);
  else if (how === 'applied') database().upsert('proposals', { id: p.id, fingerprint, source: 'detector', detector, project_id: null, workflow_id: null, status: 'applied', score: 1, created_at: p.createdAt, updated_at: p.updatedAt, data: JSON.stringify({ ...p, status: 'applied' }) });
  return p;
}

beforeEach(clear);

describe('backtesting a built-in detector', () => {
  const seed = () => {
    workflow('wf_hot', 'Hot', [node('n1', 'Fetch customer', 'core.httpRequest')]);
    workflow('wf_cold', 'Cold', [node('n1', 'Fetch invoice', 'core.httpRequest')]);
    failures('wf_hot', 20);
    failures('wf_cold', 10);
  };

  it('finds what it would have found at each point, and writes nothing', async () => {
    seed();
    const result = await backtestDetector('failure-hot-spot', { days: 30, quiet: 1 });
    expect(result.points).toHaveLength(31);
    const found = (daysAgo: number) => result.points.at(-1 - daysAgo)!.found;
    expect(found(25)).toBe(0); // before any of it: the ledger stops at each point
    expect(found(20)).toBe(1); // the hot spot has just happened
    expect(found(14)).toBe(1);
    expect(found(12)).toBe(0); // older than the 7-day window
    expect(found(10)).toBe(1);
    expect(found(0)).toBe(0);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.find((f) => f.title.includes('Fetch customer'))).toMatchObject({ points: 7, verdict: 'unknown', decision: 'none' });
    expect(proposals.listProposals({ status: 'all' })).toHaveLength(0);
    expect(listBacktests({ detector: 'failure-hot-spot' })[0]).toMatchObject({ id: result.id, quiet: 1, quietGiven: true });
  });

  it('scores findings against decisions: hits, false alarms, misses and what it rightly left out', async () => {
    seed();
    const first = await backtestDetector('failure-hot-spot', { quiet: 1 });
    const hot = first.findings.find((f) => f.title.includes('Fetch customer'))!;
    const cold = first.findings.find((f) => f.title.includes('Fetch invoice'))!;
    decide('failure-hot-spot', hot.fingerprint, 'wrong', 'Hot spot');
    decide('failure-hot-spot', cold.fingerprint, 'applied', 'Cold spot');
    decide('failure-hot-spot', 'never-found-applied', 'applied', 'Something it cannot find now');
    decide('failure-hot-spot', 'never-found-intended', 'intended', 'Intended, rightly quiet');
    decide('failure-hot-spot', 'never-found-open', 'open', 'Still open');

    const result = await backtestDetector('failure-hot-spot', { quiet: 1 });
    expect(result.findings.find((f) => f.fingerprint === hot.fingerprint)).toMatchObject({ verdict: 'false-alarm', decision: 'dismissed:wrong' });
    expect(result.findings.find((f) => f.fingerprint === cold.fingerprint)).toMatchObject({ verdict: 'hit', decision: 'applied' });
    expect(result.counts).toEqual({ findings: 2, hits: 1, falseAlarms: 1, unknown: 0, misses: 1, avoided: 1 });
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(0.5);
    expect(result.missed.map((m) => [m.title, m.wanted])).toEqual(expect.arrayContaining([['Something it cannot find now', true], ['Intended, rightly quiet', false]]));
    expect(result.missed).toHaveLength(2); // the open one is not a decision
    // Precision 50% passes the default gate; 0.6 fails it.
    expect(result.gate.ok).toBe(true);
    const strict = await backtestDetector('failure-hot-spot', { quiet: 1, threshold: 0.6 });
    expect(strict.gate.ok).toBe(false);
    expect(strict.gate.reason).toContain('under 60%');
    expect(proposals.listProposals({ status: 'open' })).toHaveLength(1); // only the seeded open one
  });

  it('changes with the quiet multiplier', async () => {
    seed();
    expect((await backtestDetector('failure-hot-spot', { quiet: 1 })).counts.findings).toBe(2);
    // Five failures become ten: neither group clears it.
    const quieter = await backtestDetector('failure-hot-spot', { quiet: 2 });
    expect(quieter).toMatchObject({ quiet: 2, quietGiven: true, counts: { findings: 0 }, precision: null });
    expect(quieter.gate.ok).toBe(true);
    // Without one it uses the detector's own, now.
    expect(await backtestDetector('failure-hot-spot', {})).toMatchObject({ quiet: 1, quietGiven: false });
  });

  it('refuses windows it cannot do', async () => {
    await expect(backtestDetector('failure-hot-spot', { days: 120 })).rejects.toBeInstanceOf(BacktestError);
    await expect(backtestDetector('failure-hot-spot', { days: 5, step: 9 })).rejects.toThrow('Step');
    await expect(backtestDetector('flow:wf_x', { days: 90, step: 1 })).rejects.toThrow('too many');
  });

  it('shows queries nothing after the point', () => {
    failures('wf_hot', 5);
    const db = database();
    const n = (asOf: number) => Number(asOfView(db, asOf).get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'node.failed'")?.n);
    expect(n(Date.now())).toBe(6);
    expect(n(Date.now() - 6 * DAY)).toBe(0);
  });
});

describe('backtesting a detector flow', () => {
  const detectorFlow = (confidence = 0.6) =>
    workflow(
      'wf_overlap',
      'Overlap finder',
      [node('t', 'Detector', 'core.detectorTrigger'), node('s', 'Suggest', 'core.suggestImprovement', { title: 'Two teams build the same thing', why: 'Same goal', risk: 'low', confidence })],
      [['t', 's']],
      { active: true },
    );
  const runCount = () => Number(database().get<{ n: number }>("SELECT COUNT(*) AS n FROM executions WHERE workflow_id = 'wf_overlap'")?.n);
  const ledgerRuns = () => Number(database().get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_events WHERE workflow_id = 'wf_overlap'")?.n);

  it('posts nothing, leaves no run behind, and scores its would-be findings', async () => {
    detectorFlow();
    const first = await backtestDetector('flow:wf_overlap', { days: 3, quiet: 1 });
    expect(first.points.map((p) => p.found)).toEqual([1, 1, 1, 1]);
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]).toMatchObject({ title: 'Two teams build the same thing', points: 4, verdict: 'unknown', decision: 'none' });
    expect(first.label).toBe('Overlap finder');
    expect(proposals.listProposals({ status: 'all' })).toHaveLength(0);
    expect(runCount()).toBe(0);
    expect(ledgerRuns()).toBe(0);

    decide('flow:wf_overlap', first.findings[0].fingerprint, 'wrong');
    const scored = await backtestDetector('flow:wf_overlap', { days: 3, quiet: 1 });
    expect(scored).toMatchObject({ precision: 0, counts: { findings: 1, hits: 0, falseAlarms: 1 } });
    expect(scored.gate.ok).toBe(false);
    expect(proposals.listProposals({ status: 'open' })).toHaveLength(0);
  });

  it('is held back by a higher quiet, and the item says it is a backtest as of the point', async () => {
    detectorFlow(0.6);
    // Quiet 2 asks for a confidence of 0.65.
    const quieter = await backtestDetector('flow:wf_overlap', { days: 1, quiet: 2 });
    expect(quieter.counts.findings).toBe(0);
    expect(quieter.points.map((p) => p.found)).toEqual([0, 0]);
    expect(quieter.points.every((p) => !p.error)).toBe(true);
  });

  it('reads the ledger as of the point in Landflow Usage', async () => {
    workflow('wf_test', 'Reader', []);
    workflow('wf_a', 'A', []);
    ledger.recordUsage({ kind: 'node.failed', workflowId: 'wf_a', nodeId: 'n1', at: ago(10 * DAY), message: 'old' });
    ledger.recordUsage({ kind: 'node.failed', workflowId: 'wf_a', nodeId: 'n1', at: ago(HOUR), message: 'recent' });
    const params = { operation: 'events', days: 3, kinds: ['node.failed'], limit: 10 };
    const messages = async (asOf?: number) => {
      const out = asOf ? await inBacktest({ asOf, quiet: 1 }, () => run(landflowUsageNode, params)) : await run(landflowUsageNode, params);
      return out.json().map((e) => (e as { message: string }).message);
    };
    expect(await messages()).toEqual(['recent']);
    expect(await messages(Date.now() - 9 * DAY)).toEqual(['old']);
  });
});

describe('the routes', () => {
  it('backtest a detector and list the results', async () => {
    workflow('wf_hot', 'Hot', [node('n1', 'Fetch customer', 'core.httpRequest')]);
    failures('wf_hot', 2);
    const done = await call(route.POST, '/api/brain/backtest', { json: { detector: 'failure-hot-spot', days: 5, quiet: 1 } });
    expect(done.status).toBe(200);
    const backtest = done.body.backtest as BacktestResult;
    expect(backtest).toMatchObject({ detector: 'failure-hot-spot', days: 5, step: 1, counts: { findings: 1 } });
    const listed = await call(route.GET, '/api/brain/backtest?detector=failure-hot-spot');
    expect((listed.body.backtests as BacktestResult[]).map((b) => b.id)).toEqual([backtest.id]);
    expect(((await call(route.GET, '/api/brain/backtest?detector=slow-step')).body.backtests as unknown[]).length).toBe(0);
  });

  it('refuse what makes no sense', async () => {
    expect((await call(route.POST, '/api/brain/backtest', { json: { detector: 'not-a-detector' } })).status).toBe(400);
    expect((await call(route.POST, '/api/brain/backtest', { json: { detector: 'slow-step', days: 400 } })).status).toBe(400);
    expect((await call(route.POST, '/api/brain/backtest', { json: { detector: 'flow:wf_nope' } })).status).toBe(404);
    workflow('wf_overlap', 'Overlap finder', [node('t', 'Detector', 'core.detectorTrigger')], [], { active: false });
    expect((await call(route.POST, '/api/brain/backtest', { json: { detector: 'flow:wf_overlap' } })).status).toBe(409);
    expect((await call(route.GET, '/api/brain/backtest?detector=nope')).status).toBe(400);
  });
});
