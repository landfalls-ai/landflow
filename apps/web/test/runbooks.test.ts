/**
 * Runbooks from Landfall rooms: the folding of a room into steps, the workflow built from them (run through the
 * runner with its form waits), the routes, and the Find Runbook node. Rooms are fixtures shaped like the Landfall
 * node's Get Room output; nothing here reaches Landfall.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-runbooks-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { runWorkflow } = await import('@/lib/server/runner');
const { alertKindOf, alertKindSlug, approvalFor, draftFromRoom, findRunbooks, runbookWorkflow, roomSchema } = await import('@/lib/server/runbooks');
const { findRunbookNode } = await import('@/lib/server/nodes/runbooks');
const { run } = await import('./helpers');
const listRoute = await import('@/app/api/runbooks/route');
const draftRoute = await import('@/app/api/runbooks/draft/route');
const formWaitingRoute = await import('@/app/form/waiting/[id]/route');

registry.registerBuiltin(corePlugin);
afterAll(() => {
  waits.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const ev = (seq: number, type: string, payload: Record<string, unknown> = {}) => ({ seq, type, payload, occurredAt: '2026-10-01T10:00:00Z' });
const room = () =>
  roomSchema.parse({
    incident: { id: 'inc_1', displayId: 'ACME-12', title: 'Checkout 5xx [prod] #12', severity: 'sev2' },
    events: [
      ev(0, 'incident.opened', { title: 'Checkout 5xx' }),
      ev(1, 'chat.message', { text: 'Error rate is 12% since the deploy', displayName: 'Ana' }),
      ev(2, 'remediation.proposed', { remediationId: 'rem_1', description: 'Check the checkout dashboards' }),
      ev(3, 'remediation.proposed', { remediationId: 'rem_2', description: 'Roll back checkout to the previous release' }),
      ev(4, 'remediation.applied-externally', { sourceSeq: 2, remediationId: 'rem_1', note: 'dashboards show 5xx from pod checkout-2' }),
      ev(5, 'chat.message', { text: 'Rolling back now', displayName: 'Ben' }),
      ev(6, 'remediation.applied-externally', { sourceSeq: 3, remediationId: 'rem_2', action: 'Roll back checkout to the previous release' }),
      ev(7, 'remediation.applied-externally', { sourceSeq: 3, action: 'Roll back checkout to the previous release' }),
      ev(8, 'remediation.applied-externally', { sourceSeq: 99 }),
      ev(9, 'status.changed', { status: 'resolved' }),
    ],
    outcome: { cause: 'bad deploy', fix: 'rollback', lessons: 'canary first', runbook_steps: ['unused when the records give steps'] },
  });

describe('alert kinds', () => {
  it('slugs titles, camel case alert names and drops ids and brackets', () => {
    expect(alertKindSlug('Checkout 5xx [prod] #12')).toBe('checkout-5xx');
    expect(alertKindSlug('HighErrorRate')).toBe('high-error-rate');
    expect(alertKindSlug('  ')).toBe('');
    expect(alertKindOf({ title: 'Disk full on db-1', labels: { alertname: 'DiskFull' } })).toBe('disk-full');
    expect(alertKindOf({ title: 'Disk full' })).toBe('disk-full');
    expect(alertKindOf('Disk full')).toBe('disk-full');
  });
});

describe('folding a room', () => {
  it('makes one step per applied remediation in order, with the chat before it as notes', () => {
    const draft = draftFromRoom(room());
    expect(draft.alertKind).toBe('checkout-5xx');
    expect(draft.room).toBe('ACME-12');
    expect(draft.steps.map((s) => s.title)).toEqual(['dashboards show 5xx from pod checkout-2'.length ? 'Check the checkout dashboards' : '', 'Roll back checkout to the previous release']);
    expect(draft.steps[0]).toMatchObject({ approval: false, notes: ['dashboards show 5xx from pod checkout-2', 'Ana: Error rate is 12% since the deploy'], source: { seq: 4, remediationId: 'rem_1', from: 'remediation' } });
    expect(draft.steps[1]).toMatchObject({ approval: true, reason: expect.stringContaining('roll back'), notes: ['Ben: Rolling back now'] });
    expect(draft.skipped).toEqual(['#7: “Roll back checkout to the previous release” repeats an earlier step', '#8 remediation.applied-externally: no action text']);
    expect(draft.background).toEqual({ cause: 'bad deploy', fix: 'rollback', lessons: 'canary first' });
  });

  it('puts approval before what the responders marked, production changes and changing words; their own “safe” wins', () => {
    expect(approvalFor('Look at the logs')).toEqual({ approval: false });
    expect(approvalFor('Look at the logs', { risky: true })).toMatchObject({ approval: true, reason: 'The responders marked it risky' });
    expect(approvalFor('Look at the logs', { environment: 'production' })).toMatchObject({ approval: true, reason: 'It changes production' });
    expect(approvalFor('Restart the pod')).toMatchObject({ approval: true });
    expect(approvalFor('Restart the pod', { risk: 'low' })).toEqual({ approval: false });
  });

  it('falls back to the outcome row’s steps, and the given kind and name win', () => {
    const base = room();
    const draft = draftFromRoom({ ...base, events: base.events.filter((e) => !e.type.startsWith('remediation')) }, { alertKind: 'HighErrorRate', name: 'Checkout errors' });
    expect(draft).toMatchObject({ alertKind: 'high-error-rate', name: 'Checkout errors' });
    expect(draft.steps).toMatchObject([{ title: 'unused when the records give steps', source: { from: 'outcome' } }]);
    expect(draftFromRoom(roomSchema.parse({ incident: { title: 'x' }, events: [] })).steps).toEqual([]);
  });
});

describe('the runbook workflow', () => {
  const steps = () => draftFromRoom(room()).steps;

  it('is a draft with one form wait per step, an approval gate before the risky one, and tags to find it by', () => {
    const workflow = runbookWorkflow({ name: 'Checkout 5xx', alertKind: 'checkout-5xx', room: 'ACME-12', steps: steps(), background: { cause: 'bad deploy' } });
    expect(workflow.active).toBe(false);
    expect(workflow.tags).toEqual(['runbook', 'alert-kind:checkout-5xx', 'room:ACME-12']);
    expect(workflow.nodes.map((n) => n.id)).toEqual(['start', 'called', 'step_1', 'approve_2', 'gate_2', 'reject_2', 'step_2']);
    expect(workflow.nodes.find((n) => n.id === 'step_1')?.notes).toContain('Ana: Error rate');
    expect(workflow.stickyNotes?.[0].content).toContain('**Cause.** bad deploy');
    expect(findRunbooks('Checkout 5xx', [workflow])[0]).toMatchObject({ steps: 2, approvals: 1, published: false, match: 'exact', url: `/workflows/${workflow.id}` });
  });

  it('runs: each step waits for a person, a rejected approval ends the run, an approved one goes on', async () => {
    const workflow = store.saveWorkflow(runbookWorkflow({ name: 'Checkout 5xx', alertKind: 'checkout-5xx', steps: steps() }));
    const resume = async (id: string, fields: Record<string, string>) => {
      const res = await formWaitingRoute.POST(new Request(`http://flow.test/form/waiting/${id}`, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } }), { params: Promise.resolve({ id }) });
      if (res.status >= 400) throw new Error(`${res.status} ${(await res.text()).replace(/<style>[\s\S]*<\/style>/, '').slice(0, 600)}`);
    };
    const waitingAt = async (id: string, node: string) => {
      await vi.waitFor(() => expect(store.getExecution(id)).toMatchObject({ status: 'waiting', wait: { nodeId: node } }));
    };
    const first = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'start' });
    await waitingAt(first.executionId, 'step_1');
    await resume(first.executionId, { f0: 'Done', f1: 'looked' });
    await waitingAt(first.executionId, 'approve_2');
    await resume(first.executionId, { f0: 'Reject', f1: 'not now' });
    await vi.waitFor(() => expect(store.getExecution(first.executionId)?.status).toBe('success'));
    const rejected = store.getExecution(first.executionId)!;
    expect(Object.keys(rejected.runData)).toContain('reject_2');
    expect(Object.keys(rejected.runData)).not.toContain('step_2');

    const second = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'start' });
    await waitingAt(second.executionId, 'step_1');
    await resume(second.executionId, { f0: 'Done' });
    await waitingAt(second.executionId, 'approve_2');
    await resume(second.executionId, { f0: 'Approve' });
    await waitingAt(second.executionId, 'step_2');
    await resume(second.executionId, { f0: 'Done', f1: 'rolled back' });
    await vi.waitFor(() => expect(store.getExecution(second.executionId)?.status).toBe('success'));
  });
});

describe('routes', () => {
  const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('drafts from a room without saving, then saves reviewed steps as a draft runbook found by kind', async () => {
    const before = store.listWorkflows().length;
    const drafted = await draftRoute.POST(post('/api/runbooks/draft', { room: room(), alertKind: 'payments-timeout' }));
    expect(drafted.status).toBe(200);
    const { draft, existing } = await drafted.json();
    expect(draft.steps).toHaveLength(2);
    expect(existing).toEqual([]);
    expect(store.listWorkflows()).toHaveLength(before);

    const reviewed = draft.steps.slice(1).map((s: { approval: boolean }) => ({ ...s, approval: true }));
    const saved = await listRoute.POST(post('/api/runbooks', { name: draft.name, alertKind: draft.alertKind, room: draft.room, description: draft.description, steps: reviewed, background: draft.background }));
    expect(saved.status).toBe(201);
    const { workflow, runbook } = await saved.json();
    expect(workflow.active).toBe(false);
    expect(runbook).toMatchObject({ alertKind: 'payments-timeout', steps: 1, approvals: 1, published: false, url: `/workflows/${workflow.id}`, room: 'ACME-12' });

    const listed = await (await listRoute.GET(new Request('http://localhost/api/runbooks?kind=HighErrorRate'))).json();
    expect(listed.runbooks).toEqual([]);
    const found = await (await listRoute.GET(new Request('http://localhost/api/runbooks?kind=Payments%20Timeout'))).json();
    expect(found.runbooks.map((r: { id: string }) => r.id)).toEqual([workflow.id]);
    expect((await (await listRoute.GET(new Request('http://localhost/api/runbooks'))).json()).runbooks.length).toBeGreaterThanOrEqual(1);
    // A second draft for the same kind says what exists.
    expect((await (await draftRoute.POST(post('/api/runbooks/draft', { room: room(), alertKind: 'payments-timeout' }))).json()).existing[0].id).toBe(workflow.id);
  });

  it('refuses a room with nothing to fold, bad bodies and empty steps', async () => {
    expect((await draftRoute.POST(post('/api/runbooks/draft', { room: { incident: { title: 'x' }, events: [] } }))).status).toBe(422);
    expect((await draftRoute.POST(post('/api/runbooks/draft', { room: {} }))).status).toBe(400);
    expect((await listRoute.POST(post('/api/runbooks', { name: 'x', alertKind: 'y', steps: [] }))).status).toBe(400);
  });
});

describe('Find Runbook node', () => {
  it('names the runbook for an alert of the same kind, with links, and says null when there is none', async () => {
    const workflow = store.saveWorkflow(runbookWorkflow({ name: 'High error rate', alertKind: 'high-error-rate', steps: [{ title: 'Check dashboards', approval: false, notes: [] }] }));
    const alert = { title: 'Error rate above 5%', labels: { alertname: 'HighErrorRate' }, severity: 'sev2' };
    const result = await run(findRunbookNode, { alertKind: 'HighErrorRate', baseUrl: 'https://flow.example.com/' }, [{ alert }]);
    expect((await run(findRunbookNode, { alertKind: alert }, [{ alert }])).json()[0]).toMatchObject({ runbookFound: true });
    expect(result.json()[0]).toMatchObject({
      alertKind: 'high-error-rate',
      runbookFound: true,
      runbook: { id: workflow.id, name: 'High error rate', url: `https://flow.example.com/workflows/${workflow.id}`, startUrl: `https://flow.example.com/api/workflows/${workflow.id}/execute`, published: false },
      runbookLine: expect.stringContaining('draft, not published yet'),
    });
    const none = await run(findRunbookNode, { alertKind: 'Totally Different Thing' }, [{}]);
    expect(none.json()[0]).toMatchObject({ runbook: null, runbookFound: false });
  });
});
