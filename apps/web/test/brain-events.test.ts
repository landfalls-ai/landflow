/**
 * Custom usage event kinds (docs/second-brain.md#your-own-event-kinds): declaring a kind and its routes, the Record Event
 * node's checks, On Usage Event on a custom kind with an attribute filter (and no loops), and reports grouped by an attribute.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { UsageEvent, UsageKindDef } from '@/lib/shared/brain';

vi.setConfig({ testTimeout: 20_000 });

// Workflows the trigger starts are recorded here instead of run.
const started = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/server/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/runner')>()),
  runWorkflow: async (options: { workflow: { id: string } }) => {
    started.push(options.workflow.id);
    return {};
  },
}));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-events-'));
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
const query = await import('@/lib/server/usage/query');
const kinds = await import('@/lib/server/usage/kinds');
const { matches, dispatchUsage, resetUsageTrigger } = await import('@/lib/server/brain/usage-trigger');
const { landflowUsageNode, recordEventNode, usageTriggerNode } = await import('@/lib/server/nodes/usage');
const { customKindProblem, isUsageKind } = await import('@/lib/shared/brain');
const { run, runOk } = await import('./helpers');
const usageRoute = await import('@/app/api/usage/route');
const eventsRoute = await import('@/app/api/usage/events/route');
const kindsRoute = await import('@/app/api/usage/kinds/route');
const kindRoute = await import('@/app/api/usage/kinds/[kind]/route');

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@events.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters });

function workflow(id: string, name: string, nodes: WorkflowNode[], extra: Partial<Workflow> = {}): Workflow {
  return store.saveWorkflow({ id, name, active: false, nodes, connections: [], createdBy: owner.id, ...extra } as Workflow);
}

function clear() {
  const db = database();
  db.deleteBefore('usage_events', 'at', '9999');
  db.deleteBefore('usage_daily', 'day', '9999');
  db.deleteBefore('usage_kinds', 'created_at', '9999');
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
}

async function call(handler: unknown, url: string, init: RequestInit & { json?: unknown } = {}, params?: Record<string, string>) {
  const { json: body, ...rest } = init;
  const request = new Request(`http://localhost${url}`, { ...rest, ...(body !== undefined && { method: rest.method ?? 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(request, params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const MOVED = {
  kind: 'work.ticket_moved',
  description: 'A ticket changed column',
  fields: [
    { name: 'team', type: 'string' as const, required: true },
    { name: 'points', type: 'number' as const },
    { name: 'blocked', type: 'boolean' as const },
  ],
};

beforeEach(() => {
  clear();
  resetUsageTrigger();
  delete process.env.LANDFLOW_BRAIN;
});

describe('kind names', () => {
  it('accepts <namespace>.<name> and refuses built-in namespaces and bad shapes', () => {
    expect(customKindProblem('work.ticket_moved')).toBeUndefined();
    expect(customKindProblem('work.self_update.v2')).toBeUndefined();
    for (const bad of ['work', 'Work.moved', 'work.', '.moved', 'work moved.x', '1work.moved', 'a.b'.padEnd(70, 'x')]) expect(customKindProblem(bad), bad).toBeDefined();
    for (const builtin of ['run.custom', 'node.mine', 'ai.thing', 'feedback.extra', 'tool.used', 'proposal.x', 'workflow.y']) expect(customKindProblem(builtin), builtin).toContain('belongs to Landflow');
    expect(isUsageKind('node.failed')).toBe(true);
    expect(isUsageKind('work.ticket_moved')).toBe(true);
    expect(isUsageKind('nonsense')).toBe(false);
  });
});

describe('declaring kinds', () => {
  it('saves, updates (keeping the creator) and deletes, and checks fields', () => {
    const def = kinds.saveKind({ ...MOVED, createdBy: 'u1' });
    expect(kinds.getKind('work.ticket_moved')).toMatchObject({ description: 'A ticket changed column', createdBy: 'u1' });
    expect(def.fields).toHaveLength(3);
    const updated = kinds.saveKind({ kind: 'work.ticket_moved', description: 'Moved', createdBy: 'u2' });
    expect(updated).toMatchObject({ description: 'Moved', createdBy: 'u1', createdAt: def.createdAt });
    expect(updated.fields).toHaveLength(3);
    expect(() => kinds.saveKind({ kind: 'run.mine' })).toThrow(/belongs to Landflow/);
    expect(() => kinds.saveKind({ kind: 'work.x', fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }] })).toThrow(/twice/);
    expect(() => kinds.saveKind({ kind: 'work.x', fields: [{ name: 'recordedBy', type: 'string' }] })).toThrow(/kept for Landflow/);
    expect(kinds.deleteKind('work.ticket_moved')).toBe(true);
    expect(kinds.deleteKind('work.ticket_moved')).toBe(false);
  });

  it('checks attributes: required, types, coerced text, dropped extras', () => {
    const def = kinds.saveKind(MOVED);
    expect(kinds.checkAttrs(def, { team: 'billing', points: '5', blocked: 'true', extra: 'x' })).toEqual({ attrs: { team: 'billing', points: 5, blocked: true }, dropped: ['extra'] });
    expect(() => kinds.checkAttrs(def, { points: 3 })).toThrow(/needs “team”/);
    expect(() => kinds.checkAttrs(def, { team: 'a', points: 'many' })).toThrow(/“points” should be a number/);
    expect(() => kinds.checkAttrs(def, { team: 5 })).toThrow(/“team” should be a string/);
  });
});

describe('the kinds routes', () => {
  it('declare, list, read and delete a kind', async () => {
    const created = await call(kindsRoute.POST, '/api/usage/kinds', { json: MOVED });
    expect(created.status).toBe(201);
    expect((created.body.kind as UsageKindDef).createdBy).toBeDefined();
    expect((await call(kindsRoute.POST, '/api/usage/kinds', { json: { kind: 'work.ticket_moved', description: 'Moved' } })).status).toBe(200);
    const list = await call(kindsRoute.GET, '/api/usage/kinds');
    expect((list.body.kinds as UsageKindDef[]).map((k) => k.kind)).toEqual(['work.ticket_moved']);
    expect((await call(kindRoute.GET, '/api/usage/kinds/work.ticket_moved', {}, { kind: 'work.ticket_moved' })).body.kind).toMatchObject({ description: 'Moved' });

    expect((await call(kindsRoute.POST, '/api/usage/kinds', { json: { kind: 'run.custom' } })).status).toBe(400);
    expect((await call(kindsRoute.POST, '/api/usage/kinds', { json: { kind: 'Bad Name' } })).status).toBe(400);
    expect((await call(kindsRoute.POST, '/api/usage/kinds', { json: { kind: 'work.x', fields: [{ name: '1bad', type: 'string' }] } })).status).toBe(400);
    expect((await call(kindsRoute.POST, '/api/usage/kinds', { json: { kind: 'work.x', fields: [{ name: 'a', type: 'date' }] } })).status).toBe(400);

    expect((await call(kindRoute.DELETE, '/api/usage/kinds/work.ticket_moved', { method: 'DELETE' }, { kind: 'work.ticket_moved' })).status).toBe(200);
    expect((await call(kindRoute.DELETE, '/api/usage/kinds/work.ticket_moved', { method: 'DELETE' }, { kind: 'work.ticket_moved' })).status).toBe(404);
  });
});

describe('Record Event', () => {
  it('records a declared kind about this workflow, with the attributes checked', async () => {
    kinds.saveKind(MOVED);
    workflow('wf_test', 'Board sync', [node('r', 'Record', 'core.recordEvent')]);
    const out = await runOk(recordEventNode, { kind: 'work.ticket_moved', attributes: JSON.stringify({ team: 'billing', points: 3, secret: 'x' }), message: 'Moved to done for ada@example.com', items: 1 });
    expect(out.json()[0]).toMatchObject({ recorded: true, kind: 'work.ticket_moved', dropped: ['secret'], attrs: { team: 'billing', points: 3, recordedBy: 'wf_test' } });
    const [event] = query.listUsageEvents({ kinds: ['work.ticket_moved'] });
    expect(event).toMatchObject({ kind: 'work.ticket_moved', workflowId: 'wf_test', items: 1, attrs: { team: 'billing', points: 3 } });
    expect(event.message).not.toContain('ada@example.com');
    expect(event.attrs).not.toHaveProperty('secret');
  });

  it('fails clearly on a missing field, a wrong type, an undeclared or built-in kind', async () => {
    kinds.saveKind(MOVED);
    const fail = async (parameters: Record<string, unknown>) => (await run(recordEventNode, parameters)).error?.message ?? '';
    expect(await fail({ kind: 'work.ticket_moved', attributes: '{"points": 2}' })).toContain('needs “team”');
    expect(await fail({ kind: 'work.ticket_moved', attributes: '{"team": "a", "points": "lots"}' })).toContain('“points” should be a number');
    expect(await fail({ kind: 'work.unknown', attributes: '{}' })).toContain('isn’t declared');
    expect(await fail({ kind: 'node.failed', attributes: '{}' })).toContain('belongs to Landflow');
    expect(await fail({ kind: 'work.ticket_moved', attributes: '[1]' })).toContain('JSON object');
    expect(await fail({ kind: 'work.ticket_moved', attributes: 'nope' })).toContain('JSON object');
    expect(await fail({ kind: '' })).toContain('Choose the kind');
    expect(query.listUsageEvents({ kinds: ['work.ticket_moved'] })).toHaveLength(0);
  });

  it('declares a new kind on first use when asked, from the attributes it was given', async () => {
    const out = await runOk(recordEventNode, { kind: 'work.self_update', attributes: '{"agent": "a1", "ok": true, "n": 2}', declareIfNew: true });
    expect(out.json()[0]).toMatchObject({ recorded: true });
    expect(kinds.getKind('work.self_update')?.fields).toEqual([
      { name: 'agent', type: 'string' },
      { name: 'ok', type: 'boolean' },
      { name: 'n', type: 'number' },
    ]);
  });

  it('only records about workflows its creator can see', async () => {
    const member = await createUser({ email: 'member@events.test', name: 'Member', role: 'member', password: 'member-password-1' });
    kinds.saveKind({ kind: 'work.ping', fields: [] });
    workflow('wf_test', 'Member flow', [node('r', 'Record', 'core.recordEvent')], { createdBy: member.id });
    workflow('wf_private', 'Owner private', [node('m', 'Manual', 'core.manualTrigger')]);
    const result = await run(recordEventNode, { kind: 'work.ping', workflowId: 'wf_private' });
    expect(result.error?.message).toContain('can’t record events about that workflow');
    expect((await run(recordEventNode, { kind: 'work.ping', workflowId: 'wf_missing' })).error?.message).toContain('No workflow');
    expect((await run(recordEventNode, { kind: 'work.ping' })).error).toBeUndefined();
    expect(query.listUsageEvents({ kinds: ['work.ping'] })).toHaveLength(1);
  });

  it('says so when the ledger is off', async () => {
    kinds.saveKind({ kind: 'work.ping', fields: [] });
    process.env.LANDFLOW_BRAIN = 'false';
    const out = await runOk(recordEventNode, { kind: 'work.ping', attributes: '{}' });
    expect(out.json()[0]).toMatchObject({ recorded: false });
  });
});

describe('On Usage Event on custom kinds', () => {
  const event = (extra: Partial<UsageEvent> = {}): UsageEvent => ({ id: 'e1', at: new Date().toISOString(), day: '', kind: 'work.ticket_moved', workflowId: 'wf_board', attrs: { team: 'billing', points: 3, blocked: false }, ...extra });

  it('matches a custom kind, and an attribute filter for any kind', () => {
    expect(matches(event(), { kinds: ['work.ticket_moved'] })).toBe(true);
    expect(matches(event(), { kinds: ['node.failed'] })).toBe(false);
    expect(matches(event(), { kinds: ['work.ticket_moved'], attrEquals: { team: 'billing' } })).toBe(true);
    expect(matches(event(), { kinds: ['work.ticket_moved'], attrEquals: '{"team": "billing", "points": 3, "blocked": false}' })).toBe(true);
    expect(matches(event(), { kinds: ['work.ticket_moved'], attrEquals: 'team=support' })).toBe(false);
    expect(matches(event(), { attrEquals: 'team=billing, points=4' })).toBe(false);
    // any kind, including built-in ones
    expect(matches(event({ kind: 'run.finished', attrs: { status: 'error' } }), { kinds: ['run.finished'], attrEquals: { status: 'error' } })).toBe(true);
    expect(matches(event({ kind: 'run.finished', attrs: { status: 'success' } }), { attrEquals: { status: 'error' } })).toBe(false);
  });

  it('is armed by a published workflow and fires, but not for what its own workflow writes', async () => {
    kinds.saveKind(MOVED);
    workflow('wf_board', 'Board', [node('m', 'Manual', 'core.manualTrigger')]);
    workflow('wf_watch', 'Watcher', [node('u', 'On moved', 'core.usageTrigger', { kinds: ['work.ticket_moved'], attrEquals: { team: 'billing' }, batchSeconds: 0 })], { active: true });
    started.length = 0;
    // Bootstrap's own events may have cached an empty list of triggers a moment ago.
    resetUsageTrigger();
    dispatchUsage(event({ attrs: { team: 'support' } }));
    dispatchUsage(event());
    // Written by the watching workflow itself (about another one): never starts it.
    dispatchUsage(event({ attrs: { team: 'billing', recordedBy: 'wf_watch' } }));
    dispatchUsage(event({ workflowId: 'wf_watch' }));
    await vi.waitFor(() => expect(started).toEqual(['wf_watch']), { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toEqual(['wf_watch']);
  });

  it('lists declared kinds in the Kinds picker', async () => {
    kinds.saveKind(MOVED);
    const options = await usageTriggerNode.methods?.loadOptions?.kinds?.call(undefined as never);
    const names = (options ?? []).map((o: { value: unknown }) => o.value);
    expect(names).toContain('node.failed');
    expect(names).toContain('work.ticket_moved');
  });
});

describe('reports on custom kinds', () => {
  function seed() {
    kinds.saveKind(MOVED);
    workflow('wf_board', 'Board', [node('m', 'Manual', 'core.manualTrigger')]);
    for (const [team, n] of [['billing', 3], ['support', 1], ['billing', 2]] as const) {
      ledger.recordUsage({ kind: 'work.ticket_moved', workflowId: 'wf_board', items: n, attrs: { team, points: n, blocked: n === 1 } });
    }
    ledger.recordUsage({ kind: 'work.ticket_moved', workflowId: 'wf_board' });
  }

  it('groups by an attribute, and filters by one', () => {
    seed();
    const report = query.usageReport({ kinds: ['work.ticket_moved'], attr: 'team' }, 'attr');
    const byKey = Object.fromEntries(report.rows.map((r) => [r.key, [r.count, r.items]]));
    expect(byKey).toEqual({ billing: [2, 5], support: [1, 1], '': [1, 0] });
    expect(report.rows[0].key).toBe('billing');
    const billing = query.usageReport({ kinds: ['work.ticket_moved'], attrEquals: { team: 'billing' } }, 'kind');
    expect(billing.rows).toEqual([expect.objectContaining({ key: 'work.ticket_moved', count: 2, items: 5 })]);
    expect(query.usageReport({ attrEquals: { blocked: 'true' } }, 'kind').totals.count).toBe(1);
    expect(query.usageReport({ attrEquals: { points: '3' } }, 'kind').totals.count).toBe(1);
    expect(() => query.usageReport({}, 'attr')).toThrow(/attribute/);
    // injection-shaped names are ignored, not run
    expect(query.usageReport({ attrEquals: { "x') OR 1=1 --": 'y' } }, 'kind').totals.count).toBe(4);
  });

  it('rolls custom kinds into the daily rollups', () => {
    seed();
    query.rollupDays([ledger.dayOf(Date.now())]);
    const rows = database().all<{ kind: string; count: number }>("SELECT kind, count FROM usage_daily WHERE kind = 'work.ticket_moved'");
    expect(rows.reduce((n, r) => n + Number(r.count), 0)).toBe(4);
  });

  it('Landflow Usage reports by attribute and filters by kind and attribute', async () => {
    seed();
    workflow('wf_test', 'Reader', [node('u', 'Usage', 'core.landflowUsage')]);
    const report = await runOk(landflowUsageNode, { operation: 'report', groupBy: 'attr', groupAttr: 'team', kinds: ['work.ticket_moved'], attrEquals: '{}', days: 7, limit: 10, oneItem: false });
    expect(report.json().find((r) => r.key === 'billing')).toMatchObject({ count: 2 });
    const events = await runOk(landflowUsageNode, { operation: 'events', kinds: ['work.ticket_moved'], attrEquals: 'team=support', days: 7, limit: 10, oneItem: false });
    expect(events.json()).toHaveLength(1);
    const missing = await run(landflowUsageNode, { operation: 'report', groupBy: 'attr', groupAttr: '', kinds: [], days: 7, limit: 10 });
    expect(missing.error?.message).toContain('attribute');
  });

  it('the usage routes take custom kinds, attr.<name> filters and groupBy=attr', async () => {
    seed();
    const report = await call(usageRoute.GET, '/api/usage?groupBy=attr&groupAttr=team&kinds=work.ticket_moved,bogus');
    expect(report.status).toBe(200);
    expect((report.body.rows as Array<{ key: string; count: number }>).find((r) => r.key === 'billing')?.count).toBe(2);
    expect((await call(usageRoute.GET, '/api/usage?groupBy=attr')).status).toBe(400);
    const events = await call(eventsRoute.GET, '/api/usage/events?kinds=work.ticket_moved&attr.team=support');
    expect((events.body.events as UsageEvent[]).map((e) => e.attrs?.team)).toEqual(['support']);
    // an unknown or malformed kind is ignored, so it filters nothing
    expect((await call(eventsRoute.GET, '/api/usage/events?kinds=bogus')).body.events).toHaveLength(4);
  });
});
