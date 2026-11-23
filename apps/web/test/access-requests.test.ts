/**
 * C35 (docs/access-requests.md#asking): asking for access, the installed flow, who the approvers are, and cancelling. The flow runs in
 * process against the fake GitHub and Google plugins; people are real users.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-requests-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { makeWorld } = await import('./fixtures/access-world');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const { AccessError } = await import('@/lib/server/access/errors');
const { createRequest, cancelRequest, listRequests, getRequest } = await import('@/lib/server/access/requests');
const { accessSetup, installAccessRequests } = await import('@/lib/server/access/setup');
const { accessSettings } = await import('@/lib/server/access/store');
const { resetAccessTrigger } = await import('@/lib/server/access/trigger');
const { BUILTIN_TEMPLATES } = await import('@/lib/server/templates');
const { createEntry, updateEntry } = await import('@/lib/server/access/catalog');
const { setUserDisabled } = await import('@/lib/server/auth/users');

const w = await makeWorld({ install: false });
const { mia, ola, ann, admin, owner, lead, team, group, manual } = w;
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 100 }).events;
const refused = async (fn: () => unknown, status: number, text?: RegExp) => {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AccessError);
    expect((error as InstanceType<typeof AccessError>).status).toBe(status);
    if (text) expect((error as Error).message).toMatch(text);
    return error as InstanceType<typeof AccessError>;
  }
  throw new Error(`expected ${status}`);
};
const ask = (user: typeof mia, entryId: string, extra: Record<string, unknown> = {}) =>
  createRequest(user, { entryId, durationMinutes: 60, reason: 'Fixing the build', account: 'mia-gh', ...extra } as never);

describe('before setup', () => {
  it('answers 409 and stores nothing', async () => {
    await refused(() => ask(mia, team.id), 409, /An admin must set up access requests first/);
    expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM access_requests')!.n).toBe(0);
    expect(accessSetup()).toMatchObject({ installed: false, active: false });
  });

  it('a workflow that only looks like the flow does not stand in for it', async () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === 'access-requests')!;
    store.saveWorkflow({ ...template.workflow, id: 'wf_lookalike', name: 'Look-alike', active: true } as unknown as Workflow);
    resetAccessTrigger();
    await refused(() => ask(mia, team.id), 409, /set up access requests first/);
    store.deleteWorkflow('wf_lookalike');
    resetAccessTrigger();
  });

  it('a member cannot set it up; an admin can, once', async () => {
    await refused(() => installAccessRequests(mia), 403);
    const first = await w.install();
    expect(first.setup).toMatchObject({ installed: true, active: true, projectId: first.projectId });
    expect(first.setup.workflowId).toEqual(expect.any(String));
    expect((await installAccessRequests(owner)).workflowId).toBe(first.setup.workflowId);
    expect(store.listWorkflows().filter((x) => x.nodes.some((n) => n.type === 'core.accessRequestTrigger'))).toHaveLength(1);
    expect(audited('access.setup').length).toBeGreaterThanOrEqual(1);
  });
});

describe('asking', () => {
  it('files a pending request with the entry’s snapshot and starts the installed flow with the approvers', async () => {
    const request = await ask(mia, team.id);
    expect(request).toMatchObject({ entryName: 'Platform team', status: 'pending', durationMinutes: 60, reason: 'Fixing the build', account: 'mia-gh', channel: 'form', requester: { id: mia.id }, approverNames: ['Ann Approver'], canCancel: true, canDecide: false });
    const row = w.requestRow(request.id)!;
    expect(row.workflow_id).toBe(accessSettings().workflowId);
    expect(row.entry_snapshot).not.toContain(w.github.id);
    expect(JSON.parse(row.entry_snapshot)).toMatchObject({ name: 'Platform team', durations: [60, 15, 1, null] });
    const execution = store.getExecution(request.executionId!)!;
    expect(execution.status).toBe('waiting');
    expect(execution.workflowId).toBe(accessSettings().workflowId);
    const item = execution.runData.request[0].outputs[0][0].json as Record<string, unknown>;
    expect(item).toMatchObject({ requestId: request.id, entry: { id: team.id, name: 'Platform team', system: 'github-team' }, requester: { id: mia.id, name: 'Mia Member' }, durationMinutes: 60, durationText: '1 h', reason: 'Fixing the build', channel: 'form', approvers: 'ann@landflow.test', account: 'mia-gh' });
    // The asked duration first, then the shorter ones (never a longer one).
    expect(item.durationChoices).toBe('60: 1 h\n15: 15 min\n1: 1 min');
    expect(JSON.stringify(item)).not.toContain(w.github.id);
    expect(audited('access.request.create').some((e) => e.target?.id === request.id)).toBe(true);
    // Cancel it so later tests start clean.
    await cancelRequest(mia, request.id);
  });

  it('refuses a duration the entry does not offer, a short reason, an entry that is not visible, and a missing GitHub username', async () => {
    await refused(() => ask(mia, team.id, { durationMinutes: 30 }), 400, /durations this entry offers/);
    await refused(() => ask(mia, team.id, { reason: 'hi' }), 400, /3 to 500/);
    await refused(() => ask(mia, team.id, { reason: 'x'.repeat(501) }), 400, /3 to 500/);
    await refused(() => ask(mia, 'ae_missing'), 404);
    const hidden = createEntry(admin, { name: 'Hidden', system: 'manual', target: { instructions: 'By hand' }, durations: [60], approverIds: [ann.id], owners: [lead.id], eligibleUserIds: [ola.id] });
    await refused(() => ask(mia, hidden.id, { account: undefined }), 404);
    await refused(() => ask(ola, team.id, { account: undefined }), 400, /GitHub username/);
    updateEntry(lead, team.id, { enabled: false }, team.version);
    await refused(() => ask(mia, team.id), 404, undefined).catch(() => undefined);
    updateEntry(lead, team.id, { enabled: true }, team.version + 1);
    expect(database().get<{ n: number }>(`SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'`)!.n).toBe(0);
  });

  it('a second open request for the entry is a 409 naming the first', async () => {
    const first = await ask(mia, group.id, { durationMinutes: null });
    const error = await refused(() => ask(mia, group.id, { durationMinutes: null }), 409, /already asked/);
    expect(error.details).toMatchObject({ existingId: first.id });
    await cancelRequest(mia, first.id);
  });

  it('keeps a GitHub username for next time (audited) and Google always uses the session email', async () => {
    expect(audited('access.account.set').some((e) => e.target?.id === mia.id)).toBe(true);
    const viaGoogle = await ask(mia, group.id, { durationMinutes: null, account: 'evil@example.com' });
    expect(viaGoogle.account).toBe('mia@landflow.test');
    await cancelRequest(mia, viaGoogle.id);
    const kept = await createRequest(mia, { entryId: team.id, durationMinutes: 15, reason: 'Pairing on a fix' });
    expect(kept.account).toBe('mia-gh');
    await cancelRequest(mia, kept.id);
    await refused(() => ask(mia, team.id, { account: 'not a login!' }), 400);
  });

  it('a manual entry needs no account', async () => {
    const request = await createRequest(mia, { entryId: manual.id, durationMinutes: 60, reason: 'Edit the launch deck' });
    expect(request.account).toBeUndefined();
    await cancelRequest(mia, request.id);
  });
});

describe('who approves', () => {
  it('never the requester: an approver who asks hands it to the admins', async () => {
    const own = await createRequest(ann, { entryId: team.id, durationMinutes: 60, reason: 'My own build', account: 'ann-gh' });
    const item = store.getExecution(own.executionId!)!.runData.request[0].outputs[0][0].json as { approvers: string };
    expect(item.approvers.split(',').sort()).toEqual(['admin@landflow.test', 'owner@landflow.test', 'second@landflow.test']);
    expect(own.canDecide).toBe(false);
    await cancelRequest(ann, own.id);
  });

  it('is refused when nobody but the requester could approve', async () => {
    const solo = createEntry(admin, { name: 'Solo', system: 'manual', target: { instructions: 'By hand' }, durations: [60], approverIds: [owner.id], owners: [lead.id] });
    for (const user of [admin, w.second]) setUserDisabled(user.id, true);
    try {
      const error = await refused(() => createRequest(owner, { entryId: solo.id, durationMinutes: 60, reason: 'Edit the deck' }), 409, /Nobody but you can approve this/);
      expect(error.message).toContain('Ask an admin to add an approver');
    } finally {
      for (const user of [admin, w.second]) setUserDisabled(user.id, false);
    }
    expect(database().get<{ n: number }>(`SELECT COUNT(*) AS n FROM access_requests WHERE entry_id = ?`, solo.id)!.n).toBe(0);
  });
});

describe('listing and cancelling', () => {
  it('shows each person their own, the approver the ones to decide, admins everything, and hides it from others', async () => {
    const a = await ask(mia, team.id);
    const b = await createRequest(ola, { entryId: manual.id, durationMinutes: 60, reason: 'Edit the launch deck' });
    const ids = (user: typeof mia, scope: 'mine' | 'decide' | 'all') => listRequests(user, { scope, status: 'pending', limit: 50 }).items.map((r) => r.id).sort();
    expect(ids(mia, 'mine')).toEqual([a.id]);
    expect(ids(ola, 'mine')).toEqual([b.id]);
    expect(ids(ann, 'decide')).toEqual([a.id, b.id].sort());
    expect(listRequests(ann, { scope: 'decide', limit: 50 }).items.every((r) => r.canDecide)).toBe(true);
    expect(ids(mia, 'decide')).toEqual([]);
    expect(ids(admin, 'all')).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids(lead, 'all')).toEqual([a.id, b.id].sort());
    expect(ids(mia, 'all')).toEqual([a.id]);
    expect(getRequest(ann, a.id).id).toBe(a.id);
    await refused(() => getRequest(ola, a.id), 404);
    await refused(() => cancelRequest(ola, a.id), 404);
    // The requester cancels: the waiting run stops, the question leaves Needs you, the cancel is audited.
    const cancelled = await cancelRequest(mia, a.id);
    expect(cancelled.status).toBe('cancelled');
    expect(store.getExecution(a.executionId!)!.status).not.toBe('waiting');
    expect(audited('access.request.cancel').some((e) => e.target?.id === a.id)).toBe(true);
    await refused(() => cancelRequest(mia, a.id), 409, /already cancelled/);
    // An admin may cancel someone else's.
    expect((await cancelRequest(admin, b.id)).status).toBe('cancelled');
  });
});
