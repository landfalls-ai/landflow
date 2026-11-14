/**
 * Four-eyes publishing (lib/server/governance/approvals.ts): with it on, publish, rollback and unpublish become
 * requests (202) with a note and a diff summary; someone else allowed to approve approves (which publishes through
 * publishVersion) or rejects with a comment; nobody approves their own request; requests go stale when the draft or
 * what is live changes; a newer request replaces a pending one; legacy `active` saves and Git sync go through the
 * same gate; approvers are emailed; the approver role and the project-role hook narrow who may approve; every step
 * is audited. With it off, publishing is immediate as before.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { PublishRequestedResponse, PublishRequestList, PublishRequestView } from '@/lib/shared/governance';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-four-eyes-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://four-eyes.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { publishedVersionId, publishLog } = await import('@/lib/server/publications');
const { listVersions } = await import('@/lib/server/versions');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { registerApproverCheck, publishOrRequest } = await import('@/lib/server/governance/approvals');
const { updateGovernancePolicy } = await import('@/lib/server/governance/policy');
const { applySync } = await import('@/lib/server/sync');
const { queryEvents } = await import('@/lib/server/audit/store');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const publishRoute = await import('@/app/api/workflows/[id]/publish/route');
const unpublishRoute = await import('@/app/api/workflows/[id]/unpublish/route');
const requestsRoute = await import('@/app/api/publish-requests/route');
const approveRoute = await import('@/app/api/publish-requests/[id]/approve/route');
const rejectRoute = await import('@/app/api/publish-requests/[id]/reject/route');
const cancelRoute = await import('@/app/api/publish-requests/[id]/cancel/route');
const governanceRoute = await import('@/app/api/settings/governance/route');

registry.registerBuiltin(corePlugin);

type User = Awaited<ReturnType<typeof createUser>>;
let alice: User;
let bob: User;
let admin: User;
const mail: Array<{ to: string; subject: string; text: string }> = [];

beforeAll(async () => {
  alice = await createUser({ email: 'alice@four-eyes.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
  bob = await createUser({ email: 'bob@four-eyes.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
  admin = await createUser({ email: 'admin@four-eyes.test', name: 'Ada', role: 'admin', password: 'admin-password-1' });
  setMailTransport({ send: async (message) => void mail.push(message) });
});

afterAll(() => {
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
  updateGovernancePolicy({ fourEyes: { enabled: true, approverRole: 'member', unpublish: true, notifyEmail: true, channelIds: [] } });
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://four-eyes.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
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

async function newWorkflow(name: string, value = '1'): Promise<Workflow> {
  const response = await as(alice, () => workflowsRoute.POST(req('POST', '/api/workflows', { name, nodes: [start, setV(value)], connections: [{ id: 'e', type: 'main', source: 'Start', target: 'Set', sourceIndex: 0, targetIndex: 0 }] })));
  return ((await response.json()) as { workflow: Workflow }).workflow;
}

async function save(user: User, workflow: Workflow, value: string) {
  const current = store.getWorkflow(workflow.id)!;
  return as(user, () => workflowRoute.PUT(req('PUT', `/api/workflows/${workflow.id}`, { ...current, nodes: [start, setV(value)] }), params({ id: workflow.id })));
}

async function askPublish(user: User, workflowId: string, body: Record<string, unknown> = {}) {
  const response = await as(user, () => publishRoute.POST(req('POST', `/api/workflows/${workflowId}/publish`, body), params({ id: workflowId })));
  return { status: response.status, body: (await response.json()) as PublishRequestedResponse & { error?: string } };
}

const decide = async (user: User, verb: 'approve' | 'reject' | 'cancel', id: string, comment?: string) => {
  const route = verb === 'approve' ? approveRoute : verb === 'reject' ? rejectRoute : cancelRoute;
  const response = await as(user, () => route.POST(req('POST', `/api/publish-requests/${id}/${verb}`, comment === undefined ? undefined : { comment }), params({ id })));
  return { status: response.status, body: (await response.json()) as { request?: PublishRequestView; error?: string } };
};

const list = async (user: User, query = '') => (await (await as(user, () => requestsRoute.GET(req('GET', `/api/publish-requests${query}`)))).json()) as PublishRequestList;

describe('four-eyes publishing', () => {
  it('turns a publish into a request that someone else approves', async () => {
    const workflow = await newWorkflow('Orders');
    mail.length = 0;
    const asked = await askPublish(alice, workflow.id, { note: 'Ready for prod' });
    expect(asked.status).toBe(202);
    expect(asked.body.approvalRequired).toBe(true);
    const request = asked.body.request;
    expect(request).toMatchObject({ kind: 'publish', status: 'pending', note: 'Ready for prod', requestedBy: alice.id, requestedByName: 'Alice', versionNumber: 1, canApprove: false, canCancel: true });
    expect(request.diff?.summary).toBe('Created with 2 nodes');
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    // Approvers (not the requester) are emailed.
    await vi.waitFor(() => expect(mail.map((m) => m.to).sort()).toEqual(expect.arrayContaining(['admin@four-eyes.test', 'bob@four-eyes.test'])));
    expect(mail.some((m) => m.to === 'alice@four-eyes.test')).toBe(false);
    expect(mail[0].subject).toBe('Approval needed: Alice wants to publish “Orders”');

    // The badge: Bob may approve, Alice may not.
    expect((await list(bob)).approvable).toBeGreaterThanOrEqual(1);
    expect((await list(bob)).requests.find((r) => r.id === request.id)?.canApprove).toBe(true);
    expect((await list(alice)).requests.find((r) => r.id === request.id)?.canApprove).toBe(false);

    const self = await decide(alice, 'approve', request.id);
    expect(self.status).toBe(403);
    expect(self.body.error).toMatch(/can’t approve your own request/);

    mail.length = 0;
    const approved = await decide(bob, 'approve', request.id, 'LGTM');
    expect(approved.status).toBe(200);
    expect(approved.body.request).toMatchObject({ status: 'approved', decidedBy: bob.id, decidedByName: 'Bob', comment: 'LGTM' });
    expect(publishedVersionId(workflow.id)).toBe(request.versionId);
    expect(publishLog(workflow.id, 1)[0]).toMatchObject({ action: 'publish', by: alice.id, note: 'Ready for prod — approved by Bob' });
    await vi.waitFor(() => expect(mail).toEqual([expect.objectContaining({ to: 'alice@four-eyes.test', subject: 'Approved: publish “Orders”' })]));

    const actions = queryEvents({ targetId: workflow.id }).events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['publish_request.create', 'publish_request.approve', 'workflow.publish']));
    expect(queryEvents({ action: ['publish_request.approve'], targetId: workflow.id }).events[0]).toMatchObject({ actor: { id: bob.id }, details: { requestId: request.id, comment: 'LGTM' } });

    // Deciding twice: refused.
    expect((await decide(admin, 'approve', request.id)).status).toBe(409);
  });

  it('marks a request stale when the draft changes, and refuses to approve it', async () => {
    const workflow = await newWorkflow('Invoices');
    const { body } = await askPublish(alice, workflow.id);
    await save(alice, workflow, '2');
    const listed = (await list(bob, `?workflowId=${workflow.id}&status=all`)).requests.find((r) => r.id === body.request.id);
    expect(listed).toMatchObject({ status: 'stale', reason: 'The draft changed after the request was made' });
    const approve = await decide(bob, 'approve', body.request.id);
    expect(approve.status).toBe(409);
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    expect(queryEvents({ action: ['publish_request.stale'], targetId: workflow.id }).events).toHaveLength(1);
  });

  it('goes stale when the author autosaves after asking, so an approver never publishes unseen content', async () => {
    const workflow = await newWorkflow('Autosaved');
    const autosave = async (value: string) => {
      const current = store.getWorkflow(workflow.id)!;
      const request = new Request(`http://four-eyes.test/api/workflows/${workflow.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...current, nodes: [start, setV(value)] }),
        headers: { 'content-type': 'application/json', 'x-landflow-autosave': '1' },
      });
      return as(alice, () => workflowRoute.PUT(request, params({ id: workflow.id })));
    };
    expect((await autosave('reviewed')).status).toBe(200);
    const { status, body } = await askPublish(alice, workflow.id);
    expect(status).toBe(202);
    expect((await autosave('NOT REVIEWED')).status).toBe(200);
    const approve = await decide(bob, 'approve', body.request.id);
    expect(approve.status).toBe(409);
    expect(publishedVersionId(workflow.id)).toBeUndefined();
  });

  it('rejects with a comment, withdraws, and replaces a pending request with a newer one', async () => {
    const workflow = await newWorkflow('Payroll');
    const first = (await askPublish(alice, workflow.id, { note: 'v1' })).body.request;
    const rejected = await decide(bob, 'reject', first.id, 'Missing error handling');
    expect(rejected.body.request).toMatchObject({ status: 'rejected', comment: 'Missing error handling', decidedBy: bob.id });
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    expect((await decide(alice, 'reject', (await askPublish(alice, workflow.id)).body.request.id)).status).toBe(403);

    const second = (await list(alice, `?workflowId=${workflow.id}`)).requests[0];
    const third = (await askPublish(alice, workflow.id, { note: 'again' })).body.request;
    const statuses = (await list(alice, `?workflowId=${workflow.id}&status=all`)).requests;
    expect(statuses.find((r) => r.id === second.id)).toMatchObject({ status: 'canceled', reason: 'Replaced by a newer request' });
    expect((await decide(bob, 'cancel', third.id)).status).toBe(403);
    expect((await decide(alice, 'cancel', third.id)).body.request).toMatchObject({ status: 'canceled' });
    expect((await list(bob, `?workflowId=${workflow.id}`)).requests).toHaveLength(0);
  });

  it('needs approval to unpublish and to roll back', async () => {
    const workflow = await newWorkflow('Shipping', 'a');
    await decide(bob, 'approve', (await askPublish(alice, workflow.id)).body.request.id);
    const v1 = publishedVersionId(workflow.id)!;
    await save(alice, workflow, 'b');
    await decide(bob, 'approve', (await askPublish(alice, workflow.id)).body.request.id);
    expect(publishedVersionId(workflow.id)).not.toBe(v1);

    const rollback = (await askPublish(alice, workflow.id, { versionId: v1 })).body.request;
    expect(rollback).toMatchObject({ kind: 'rollback', versionNumber: 1, baseVersionNumber: 2 });
    expect(rollback.diff?.nodesChanged).toEqual(['Set']);
    await decide(admin, 'approve', rollback.id);
    expect(publishedVersionId(workflow.id)).toBe(v1);

    const response = await as(alice, () => unpublishRoute.POST(req('POST', `/api/workflows/${workflow.id}/unpublish`, { note: 'retire' }), params({ id: workflow.id })));
    expect(response.status).toBe(202);
    const unpublish = ((await response.json()) as PublishRequestedResponse).request;
    expect(unpublish).toMatchObject({ kind: 'unpublish', note: 'retire' });
    expect(store.getWorkflow(workflow.id)?.active).toBe(true);
    await decide(bob, 'approve', unpublish.id);
    expect(publishedVersionId(workflow.id)).toBeUndefined();
    expect(store.getWorkflow(workflow.id)?.active).toBe(false);

    // "Unpublishing needs approval" off: immediate.
    updateGovernancePolicy({ fourEyes: { unpublish: false } });
    await decide(bob, 'approve', (await askPublish(alice, workflow.id)).body.request.id);
    expect((await as(alice, () => unpublishRoute.POST(req('POST', `/api/workflows/${workflow.id}/unpublish`), params({ id: workflow.id })))).status).toBe(200);
    expect(publishedVersionId(workflow.id)).toBeUndefined();
  });

  it('holds legacy `active` switches and Git sync publishes for approval', async () => {
    const workflow = await newWorkflow('Legacy');
    const put = await as(alice, () => workflowRoute.PUT(req('PUT', `/api/workflows/${workflow.id}`, { ...store.getWorkflow(workflow.id)!, active: true }), params({ id: workflow.id })));
    const body = (await put.json()) as { workflow: Workflow; publishRequest?: PublishRequestView };
    expect(body.workflow.active).toBeFalsy();
    expect(body.publishRequest).toMatchObject({ kind: 'publish', status: 'pending' });
    expect(publishedVersionId(workflow.id)).toBeUndefined();

    const synced = await applySync(
      [
        { path: 'landflow-sync.json', content: '{"format":"landflow-sync/v1"}' },
        { path: 'workflows/synced.workflow.json', content: JSON.stringify({ id: 'wf_synced', name: 'Synced', active: true, nodes: [start], connections: [] }) },
      ],
      { by: alice.id, note: 'Git sync' },
    );
    expect(synced.errors).toEqual([]);
    expect(store.getWorkflow('wf_synced')).toBeTruthy();
    expect(publishedVersionId('wf_synced')).toBeUndefined();
    expect((await list(bob, '?workflowId=wf_synced')).requests).toEqual([expect.objectContaining({ kind: 'publish', requestedBy: alice.id, note: 'Git sync' })]);
  });

  it('narrows approvers by role and through the project-role hook', async () => {
    const workflow = await newWorkflow('Narrow');
    const request = (await askPublish(alice, workflow.id)).body.request;
    updateGovernancePolicy({ fourEyes: { approverRole: 'admin' } });
    expect((await decide(bob, 'approve', request.id)).status).toBe(403);
    const unregister = registerApproverCheck((user) => (user.id === admin.id ? false : undefined));
    try {
      expect((await decide(admin, 'approve', request.id)).status).toBe(403);
    } finally {
      unregister();
    }
    expect((await decide(admin, 'approve', request.id)).status).toBe(200);
  });

  it('is off by default and changed through Settings → Governance', async () => {
    const response = await governanceRoute.PATCH(req('PATCH', '/api/settings/governance', { fourEyes: { enabled: false } }));
    expect(((await response.json()) as { policy: { fourEyes: { enabled: boolean } } }).policy.fourEyes.enabled).toBe(false);
    const workflow = await newWorkflow('Direct');
    const direct = await askPublish(alice, workflow.id);
    expect(direct.status).toBe(200);
    expect(direct.body.approvalRequired).toBeUndefined();
    expect(publishedVersionId(workflow.id)).toBe(listVersions(workflow.id)[0].id);
    // Members can't change the policy.
    expect((await as(bob, () => governanceRoute.PATCH(req('PATCH', '/api/settings/governance', { fourEyes: { enabled: false } })))).status).toBe(403);
    // Nothing to ask for: the live version again is a no-op, not a request.
    updateGovernancePolicy({ fourEyes: { enabled: true } });
    const again = await publishOrRequest({ workflowId: workflow.id, action: 'publish', by: alice.id });
    expect(again.approvalRequired).toBeFalsy();
  });
});
