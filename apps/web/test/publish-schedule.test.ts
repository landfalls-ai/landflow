/**
 * Scheduled publishes (lib/server/publish-schedule.ts): a publish or unpublish at a chosen time is stored, listed,
 * cancellable, and run by the ticker through publishVersion (so governance and the audit log apply). With four-eyes
 * publishing on, scheduling files a request whose approval releases the schedule; a schedule made earlier whose time
 * comes after four-eyes was switched on becomes a request. A restart (a fresh `start()`) picks up what is overdue.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { ScheduledPublish } from '@/lib/shared/publish';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-publish-schedule-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://schedule.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { publishedVersionId } = await import('@/lib/server/publications');
const { listVersions } = await import('@/lib/server/versions');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { updateGovernancePolicy } = await import('@/lib/server/governance/policy');
const { publishSchedules } = await import('@/lib/server/publish-schedule');
const { queryEvents } = await import('@/lib/server/audit/store');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const publishRoute = await import('@/app/api/workflows/[id]/publish/route');
const unpublishRoute = await import('@/app/api/workflows/[id]/unpublish/route');
const schedulesRoute = await import('@/app/api/workflows/[id]/schedules/route');
const scheduleRoute = await import('@/app/api/workflows/[id]/schedules/[scheduleId]/route');
const approveRoute = await import('@/app/api/publish-requests/[id]/approve/route');

registry.registerBuiltin(corePlugin);

type User = Awaited<ReturnType<typeof createUser>>;
let alice: User;
let bob: User;

beforeAll(async () => {
  alice = await createUser({ email: 'alice@schedule.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
  bob = await createUser({ email: 'bob@schedule.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
  setMailTransport({ send: async () => {} });
});

afterAll(() => {
  publishSchedules.stop();
  setMailTransport(undefined);
  enableTestAuth();
  updateGovernancePolicy({ fourEyes: { enabled: false } });
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  enableTestAuth();
  updateGovernancePolicy({ fourEyes: { enabled: false, approverRole: 'member', unpublish: true, notifyEmail: false, channelIds: [] } });
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://schedule.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const as = async <T>(user: User, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

const setV = (value: string) => ({ id: 'Set', name: 'Set', type: 'core.set', typeVersion: 1, position: [200, 0] as [number, number], parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'v', type: 'string', value }] } } });
const start = { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} };

async function newWorkflow(name: string): Promise<Workflow> {
  const response = await as(alice, () => workflowsRoute.POST(req('POST', '/api/workflows', { name, nodes: [start, setV('1')], connections: [{ id: 'e', type: 'main', source: 'Start', target: 'Set', sourceIndex: 0, targetIndex: 0 }] })));
  return ((await response.json()) as { workflow: Workflow }).workflow;
}

const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const schedule = async (user: User, workflowId: string, body: Record<string, unknown>) => {
  const response = await as(user, () => publishRoute.POST(req('POST', `/api/workflows/${workflowId}/publish`, body), params({ id: workflowId })));
  return { status: response.status, body: (await response.json()) as { scheduled?: ScheduledPublish; error?: string } };
};
const list = async (workflowId: string) => ((await (await schedulesRoute.GET(req('GET', `/api/workflows/${workflowId}/schedules`), params({ id: workflowId }))).json()) as { schedules: ScheduledPublish[] }).schedules;
/** The clock a tick sees: past the schedule's time. */
const later = (iso: string, ms = 1_000) => new Date(Date.parse(iso) + ms);

describe('scheduled publishes', () => {
  it('stores a schedule, lists it, and publishes the version at its time (not before)', async () => {
    const workflow = await newWorkflow('Scheduled one');
    const at = inFuture(3600_000);
    const { status, body } = await schedule(alice, workflow.id, { at, note: 'nightly release' });
    expect(status).toBe(202);
    expect(body.scheduled).toMatchObject({ workflowId: workflow.id, action: 'publish', status: 'pending', versionNumber: 1, note: 'nightly release', runAt: at });
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    expect(await list(workflow.id)).toHaveLength(1);

    // Before its time nothing happens.
    expect(await publishSchedules.tick(new Date())).toEqual([]);
    expect(publishedVersionId(workflow.id)).toBeUndefined();

    const ran = await publishSchedules.tick(later(at));
    expect(ran.map((r) => r.id)).toEqual([body.scheduled!.id]);
    expect(publishedVersionId(workflow.id)).toBe(listVersions(workflow.id)[0].id);
    expect(store.getWorkflow(workflow.id)!.active).toBe(true);
    expect((await list(workflow.id))[0]).toMatchObject({ status: 'done' });
    // Once: a second tick does not run it again.
    expect(await publishSchedules.tick(later(at, 5_000))).toEqual([]);
  });

  it('rejects past, malformed and too distant times, and unknown versions', async () => {
    const workflow = await newWorkflow('Bad times');
    expect((await schedule(alice, workflow.id, { at: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await schedule(alice, workflow.id, { at: 'tomorrow-ish' })).status).toBe(400);
    expect((await schedule(alice, workflow.id, { at: inFuture(400 * 24 * 3600_000) })).status).toBe(400);
    expect((await schedule(alice, workflow.id, { at: inFuture(60_000), versionId: 'nope' })).status).toBe(404);
    expect((await schedule(alice, 'missing', { at: inFuture(60_000) })).status).toBe(404);
  });

  it('can be canceled by who scheduled it, not by someone else, and never runs', async () => {
    const workflow = await newWorkflow('Canceled');
    const at = inFuture(600_000);
    const { body } = await schedule(alice, workflow.id, { at });
    const id = body.scheduled!.id;
    const denied = await as(bob, () => scheduleRoute.DELETE(req('DELETE', `/x`), params({ id: workflow.id, scheduleId: id })));
    expect(denied.status).toBe(403);
    const ok = await as(alice, () => scheduleRoute.DELETE(req('DELETE', `/x`), params({ id: workflow.id, scheduleId: id })));
    expect(ok.status).toBe(200);
    expect(await publishSchedules.tick(later(at))).toEqual([]);
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    const again = await as(alice, () => scheduleRoute.DELETE(req('DELETE', `/x`), params({ id: workflow.id, scheduleId: id })));
    expect(again.status).toBe(409);
  });

  it('schedules a specific older version and an unpublish', async () => {
    const workflow = await newWorkflow('Two versions');
    const first = listVersions(workflow.id)[0];
    const current = store.getWorkflow(workflow.id)!;
    await as(alice, () => workflowRoute.PUT(req('PUT', `/api/workflows/${workflow.id}`, { ...current, nodes: [start, setV('2')] }), params({ id: workflow.id })));
    expect(listVersions(workflow.id)).toHaveLength(2);
    const t1 = inFuture(60_000);
    const t2 = inFuture(120_000);
    const pub = await schedule(alice, workflow.id, { at: t1, versionId: first.id });
    expect(pub.body.scheduled?.versionNumber).toBe(1);
    const unpub = await as(alice, () => unpublishRoute.POST(req('POST', `/api/workflows/${workflow.id}/unpublish`, { at: t2 }), params({ id: workflow.id })));
    expect(unpub.status).toBe(202);
    await publishSchedules.tick(later(t1));
    expect(publishedVersionId(workflow.id)).toBe(first.id);
    await publishSchedules.tick(later(t2));
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    expect(store.getWorkflow(workflow.id)!.active).toBe(false);
    expect((await list(workflow.id)).map((s) => s.status)).toEqual(['done', 'done']);
  });

  it('a restart re-arms: overdue pending rows run on start, and a row a crash left running is retried', async () => {
    const workflow = await newWorkflow('Restart');
    // Bootstrap (any route call) started the ticker: stop it, as a shutdown would.
    publishSchedules.stop();
    const at = inFuture(1_500);
    const { body } = await schedule(alice, workflow.id, { at });
    // Simulate a crash mid-run: the row is `running`.
    const { database } = await import('@/lib/server/db');
    database().upsert('scheduled_publishes', { ...database().get<Record<string, unknown>>('SELECT * FROM scheduled_publishes WHERE id = ?', body.scheduled!.id)!, status: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    publishSchedules.start();
    await vi.waitFor(async () => expect((await list(workflow.id))[0].status).toBe('done'), { timeout: 5_000 });
    publishSchedules.stop();
    expect(publishedVersionId(workflow.id)).toBeDefined();
  });

  it('records the publish in the audit log and the publish timeline with the scheduler as note', async () => {
    const workflow = await newWorkflow('Audited');
    const at = inFuture(60_000);
    const { body } = await schedule(alice, workflow.id, { at, note: 'go' });
    await publishSchedules.tick(later(at));
    const actions = queryEvents({ limit: 200 }).events.filter((e) => e.target?.id === workflow.id).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['publish_schedule.create', 'publish_schedule.run', 'workflow.publish']));
    expect(body.scheduled).toBeDefined();
    const { publishLog } = await import('@/lib/server/publications');
    expect(publishLog(workflow.id)[0]).toMatchObject({ action: 'publish', note: expect.stringContaining('scheduled for') });
  });

  it('fails (and says why) when the version can no longer be published', async () => {
    const workflow = await newWorkflow('Blocked later');
    const at = inFuture(60_000);
    const { body } = await schedule(alice, workflow.id, { at });
    updateGovernancePolicy({ nodes: { mode: 'block', types: ['core.set'], plugins: [], blockCode: false } });
    try {
      await publishSchedules.tick(later(at));
    } finally {
      updateGovernancePolicy({ nodes: { mode: 'off', types: [], plugins: [], blockCode: false } });
    }
    const row = (await list(workflow.id)).find((s) => s.id === body.scheduled!.id)!;
    expect(row.status).toBe('failed');
    expect(row.result).toMatch(/core\.set|not allowed|blocked/i);
    expect(publishedVersionId(workflow.id)).toBeUndefined();
  });
});

describe('scheduled publishes with four-eyes publishing', () => {
  it('files a request; approval releases the schedule, which goes live at its time with the requester as publisher', async () => {
    const workflow = await newWorkflow('Four eyes scheduled');
    updateGovernancePolicy({ fourEyes: { enabled: true, approverRole: 'member', unpublish: true, notifyEmail: false, channelIds: [] } });
    const at = inFuture(3600_000);
    const { body } = await schedule(alice, workflow.id, { at });
    const scheduled = body.scheduled!;
    expect(scheduled.status).toBe('awaiting_approval');
    expect(scheduled.requestId).toBeTruthy();

    // Unapproved at its time: it doesn't go live.
    expect(await publishSchedules.tick(later(at))).toEqual([]);
    expect(publishedVersionId(workflow.id)).toBeUndefined();

    // Alice can't approve her own; Bob can, and approving doesn't publish yet.
    const own = await as(alice, () => approveRoute.POST(req('POST', '/x'), params({ id: scheduled.requestId! })));
    expect(own.status).toBe(403);
    const approved = await as(bob, () => approveRoute.POST(req('POST', '/x'), params({ id: scheduled.requestId! })));
    expect(approved.status).toBe(200);
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    expect((await list(workflow.id))[0].status).toBe('pending');

    // Its time came already: the next tick publishes.
    const ran = await publishSchedules.tick(later(at, 10_000));
    expect(ran).toHaveLength(1);
    expect(publishedVersionId(workflow.id)).toBeDefined();
  });

  it('a rejected request cancels the schedule', async () => {
    const workflow = await newWorkflow('Four eyes rejected');
    updateGovernancePolicy({ fourEyes: { enabled: true, approverRole: 'member', unpublish: true, notifyEmail: false, channelIds: [] } });
    const at = inFuture(60_000);
    const { body } = await schedule(alice, workflow.id, { at });
    const { rejectRequest } = await import('@/lib/server/governance/approvals');
    const { getUser } = await import('@/lib/server/auth/users');
    rejectRequest(body.scheduled!.requestId!, getUser(bob.id)!, 'no');
    const rows = await list(workflow.id);
    expect(rows[0].status).toBe('canceled');
    expect(await publishSchedules.tick(later(at))).toEqual([]);
    expect(publishedVersionId(workflow.id)).toBeUndefined();
  });

  it('a schedule made with four-eyes off becomes a request when its time comes with four-eyes on', async () => {
    const workflow = await newWorkflow('Becomes a request');
    const at = inFuture(60_000);
    const { body } = await schedule(alice, workflow.id, { at });
    expect(body.scheduled!.status).toBe('pending');
    updateGovernancePolicy({ fourEyes: { enabled: true, approverRole: 'member', unpublish: true, notifyEmail: false, channelIds: [] } });
    const ran = await publishSchedules.tick(later(at));
    expect(ran[0]).toMatchObject({ status: 'requested' });
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    const approved = await as(bob, () => approveRoute.POST(req('POST', '/x'), params({ id: ran[0].requestId! })));
    expect(approved.status).toBe(200);
    expect(publishedVersionId(workflow.id)).toBeDefined();
  });
});
