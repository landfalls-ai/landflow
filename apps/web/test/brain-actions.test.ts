/**
 * Actions decided by the flow (docs/second-brain.md#actions): buttons a flow puts on a suggestion, the act route, and
 * On Suggestion Decided (filters, the whole suggestion in each item, no loops, Build it through it).
 * No model and no embeddings.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { Proposal } from '@/lib/shared/brain';

vi.setConfig({ testTimeout: 20_000 });

const started = vi.hoisted(() => [] as Array<{ workflowId: string; items: Array<{ json: Record<string, unknown> }> }>);
vi.mock('@/lib/server/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/runner')>()),
  runWorkflow: async (opts: { workflow: { id: string }; triggerItems: Array<{ json: Record<string, unknown> }> }) => {
    started.push({ workflowId: opts.workflow.id, items: opts.triggerItems });
    return {};
  },
}));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-actions-'));
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
const proposals = await import('@/lib/server/brain/proposals');
const { resetDecidedTrigger, decidedMatches } = await import('@/lib/server/brain/decision-trigger');
const { suggestImprovementNode, suggestionDecidedTriggerNode } = await import('@/lib/server/nodes/usage');
const { runOk } = await import('./helpers');
const proposalsRoute = await import('@/app/api/proposals/route');
const proposalRoute = await import('@/app/api/proposals/[id]/route');
const actRoute = await import('@/app/api/proposals/[id]/act/route');
const applyRoute = await import('@/app/api/proposals/[id]/apply/route');

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@actions.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters });
const workflow = (id: string, name: string, nodes: WorkflowNode[], extra: Partial<Workflow> = {}) =>
  store.saveWorkflow({ id, name, active: false, nodes, connections: [], createdBy: owner.id, ...extra } as Workflow);
const listener = (id: string, parameters: Record<string, unknown> = {}) => workflow(id, `Flow ${id}`, [node('d', 'On decided', 'core.suggestionDecidedTrigger', parameters)], { active: true });

async function call(handler: unknown, url: string, init: RequestInit & { json?: unknown } = {}, params?: Record<string, string>) {
  const { json: body, ...rest } = init;
  const request = new Request(`http://localhost${url}`, { ...rest, ...(body !== undefined && { method: rest.method ?? 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(request, params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const ACTIONS = [
  { id: 'intro', label: 'Intro us', style: 'primary' },
  { id: 'book', label: 'Book 15 min', confirm: 'Send the invite?' },
];

function suggest(extra: Partial<Parameters<typeof proposals.proposeFrom>[0]> = {}): Proposal {
  return proposals.proposeFrom({ title: 'Ask Dana for an intro', why: 'She knows Acme', label: 'Warm intros', actions: ACTIONS, ...extra }, 'workflow')!;
}

beforeEach(() => {
  database().deleteBefore('usage_events', 'at', '9999');
  database().deleteBefore('proposals', 'created_at', '9999');
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
  started.length = 0;
  resetDecidedTrigger();
});

describe('actions on a suggestion', () => {
  it('keeps clean actions and rejects bad ones', () => {
    expect(suggest().actions).toEqual([
      { id: 'intro', label: 'Intro us', style: 'primary' },
      { id: 'book', label: 'Book 15 min', confirm: 'Send the invite?' },
    ]);
    expect(() => suggest({ title: 'b1', actions: [{ id: 'Bad Id', label: 'x' }] })).toThrow(/lowercase/);
    expect(() => suggest({ title: 'b2', actions: [{ id: 'applied', label: 'x' }] })).toThrow(/taken/);
    expect(() => suggest({ title: 'b3', actions: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] })).toThrow(/twice/);
    expect(() => suggest({ title: 'b4', actions: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: 'x' })) })).toThrow(/at most 4/);
  });

  it('come from the Suggest Improvement node and POST /api/proposals', async () => {
    const out = await runOk(suggestImprovementNode, { title: 'Intro to Acme', why: 'Dana knows them', actions: { buttons: [{ id: 'intro', label: 'Intro us', style: 'primary', confirm: '' }] } });
    expect((out.json()[0].proposal as Proposal).actions).toEqual([{ id: 'intro', label: 'Intro us', style: 'primary' }]);
    const created = await call(proposalsRoute.POST, '/api/proposals', { json: { title: 'Book a call', why: 'warm lead', actions: ACTIONS } });
    expect((created.body.proposal as Proposal).actions).toHaveLength(2);
    expect((await call(proposalsRoute.POST, '/api/proposals', { json: { title: 'x', why: 'y', actions: [{ id: 'applied', label: 'x' }] } })).status).toBe(400);
  });
});

describe('the act route', () => {
  it('records the decision, counts as applied, and says when nothing listens', async () => {
    const p = suggest();
    const bad = await call(actRoute.POST, `/api/proposals/${p.id}/act`, { json: { action: 'nope' } }, { id: p.id });
    expect(bad.status).toBe(400);
    const res = await call(actRoute.POST, `/api/proposals/${p.id}/act`, { json: { action: 'intro', note: 'she said yes' } }, { id: p.id });
    expect(res.status).toBe(200);
    const done = res.body.proposal as Proposal;
    expect(done.status).toBe('applied');
    expect(done.decision).toMatchObject({ action: 'intro', label: 'Intro us', by: 'usr_test_owner', note: 'she said yes' });
    expect(done.baseline ?? done.appliedAt).toBeTruthy();
    expect((res.body.warnings as string[]).join(' ')).toContain('On Suggestion Decided');
    expect((await call(actRoute.POST, `/api/proposals/${p.id}/act`, { json: { action: 'intro' } }, { id: p.id })).status).toBe(409);
  });
});

describe('On Suggestion Decided', () => {
  it('starts the listening flows with the whole suggestion and the decision', async () => {
    listener('wf_intro', { decisions: 'intro' });
    listener('wf_all');
    listener('wf_other', { detector: 'failure-hot-spot' });
    const p = suggest();
    const res = await call(actRoute.POST, `/api/proposals/${p.id}/act`, { json: { action: 'intro', note: 'go' } }, { id: p.id });
    expect((res.body.started as Array<{ id: string }>).map((w) => w.id).sort()).toEqual(['wf_all', 'wf_intro']);
    await vi.waitFor(() => expect(started.map((s) => s.workflowId).sort()).toEqual(['wf_all', 'wf_intro']));
    const item = started[0].items[0].json;
    expect(item).toMatchObject({ id: p.id, source: 'workflow', label: 'Warm intros', title: 'Ask Dana for an intro', why: 'She knows Acme', decision: 'action', action: 'intro', actionLabel: 'Intro us', note: 'go', by: 'usr_test_owner' });
    expect(item.actions).toHaveLength(2);
    expect(item.target).toEqual({ type: 'instance' });
  });

  it('fires for apply, dismiss and snooze, filtered by decision, label and target workflow', async () => {
    workflow('wf_target', 'Target', [node('h', 'Call', 'core.httpRequest')]);
    listener('wf_dismissed', { decisions: ['dismissed'] });
    listener('wf_snoozed', { decisions: 'snoozed' });
    listener('wf_applied', { decisions: 'applied', label: 'warm intros', workflowId: 'wf_target' });
    const advice = suggest({ title: 'Advice about the call', workflowId: 'wf_target', actions: undefined });

    // Advice only, but a flow listens: applying records the go-ahead instead of failing.
    const applied = await call(applyRoute.POST, `/api/proposals/${advice.id}/apply`, { json: undefined, method: 'POST' }, { id: advice.id });
    expect(applied.status).toBe(200);
    expect(applied.body.started).toEqual([{ id: 'wf_applied', name: 'Flow wf_applied' }]);
    expect((applied.body.proposal as Proposal).decision).toMatchObject({ action: 'applied' });
    await vi.waitFor(() => expect(started.map((s) => s.workflowId)).toEqual(['wf_applied']));
    expect(started[0].items[0].json).toMatchObject({ decision: 'applied' });

    started.length = 0;
    const b = suggest({ title: 'Second', actions: undefined });
    await call(proposalRoute.PATCH, `/api/proposals/${b.id}`, { method: 'PATCH', json: { action: 'snooze', days: 2 } }, { id: b.id });
    await call(proposalRoute.PATCH, `/api/proposals/${b.id}`, { method: 'PATCH', json: { action: 'dismiss', reason: 'wrong', note: 'nah' } }, { id: b.id });
    await vi.waitFor(() => expect(started.map((s) => s.workflowId).sort()).toEqual(['wf_dismissed', 'wf_snoozed']));
    expect(started.find((s) => s.workflowId === 'wf_dismissed')!.items[0].json).toMatchObject({ decision: 'dismissed', reason: 'wrong', note: 'nah' });
  });

  it('advice with no listening flow still errors', async () => {
    const advice = suggest({ actions: undefined });
    expect((await call(applyRoute.POST, `/api/proposals/${advice.id}/apply`, {}, { id: advice.id })).status).toBe(400);
  });

  it('never loops: a decision by (or about) a workflow that starts from it starts nothing', async () => {
    listener('wf_loop');
    const p = suggest();
    proposals.actOnProposal(p.id, 'intro', { viaWorkflowId: 'wf_loop' });
    const q = suggest({ title: 'About the listener', workflowId: 'wf_loop' });
    proposals.actOnProposal(q.id, 'intro');
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([]);
  });

  it('Build it also counts a listener on missing-tool applies', () => {
    listener('wf_builds', { detector: 'missing-tool', decisions: 'applied' });
    listener('wf_dismiss_only', { decisions: 'dismissed' });
    expect(proposals.builders()).toEqual([{ id: 'wf_builds', name: 'Flow wf_builds' }]);
  });

  it('matches by detector, label, decisions and workflow', () => {
    const p = { detector: 'missing-tool', label: 'Tools', target: { type: 'workflow', id: 'w1' } } as unknown as Proposal;
    const d = { action: 'intro', label: 'Intro', at: '' };
    expect(decidedMatches(p, d, {})).toBe(true);
    expect(decidedMatches(p, d, { detector: 'flow:x' })).toBe(false);
    // "any" (as Spotlight writes it), "all" and "*" mean any detector, like the empty choice.
    for (const any of ['any', 'All', '*']) expect(decidedMatches(p, d, { detector: any })).toBe(true);
    expect(decidedMatches(p, d, { label: 'tools' })).toBe(true);
    expect(decidedMatches(p, d, { decisions: 'applied, book' })).toBe(false);
    expect(decidedMatches(p, d, { decisions: 'applied, intro' })).toBe(true);
    expect(decidedMatches(p, d, { workflowId: 'w2' })).toBe(false);
  });

  it('a manual run hands over an example', async () => {
    const out = await runOk(suggestionDecidedTriggerNode, {}, [{}]);
    expect(out.json()[0]).toMatchObject({ decision: 'action', action: 'intro' });
  });
});
