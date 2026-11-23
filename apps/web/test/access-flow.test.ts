/**
 * C35 end to end (docs/access-requests.md#the-flow): the installed flow, real runs, the decision made as an approver does, the grant in the
 * fake GitHub and Google, the removal by the service at the end, a no, and the channel the template picks. Nothing here is stood in for but
 * the two external systems.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-flow-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
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
const { createRequest, decideAccessRequest, getRequest } = await import('@/lib/server/access/requests');
const { listGrants, revokeNow } = await import('@/lib/server/access/grants');
const { sweepGrants } = await import('@/lib/server/access/sweeper');
const { accessSettings, saveAccessSettings, grantOfRequest } = await import('@/lib/server/access/store');
const { installAccessRequests } = await import('@/lib/server/access/setup');
const { needsYou } = await import('@/lib/server/journal/needs-you');
const { getTemplate, templateProblems } = await import('@/lib/server/templates');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { queryEvents } = await import('@/lib/server/audit/store');

const w = await makeWorld();
const { mia, ola, ann, team, group, manual, fake, mails } = w;
w.captureMail();
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 100 }).events;

describe('the template', () => {
  it('is usable, and the installed workflow has no problems', async () => {
    for (const id of ['access-requests', 'access-requests-chat']) {
      const detail = await getTemplate(id);
      expect(detail?.usable, id).toBe(true);
    }
    const flow = store.getWorkflow(accessSettings().workflowId!)!;
    expect(templateProblems(flow)).toEqual([]);
    expect(flow.nodes.find((n) => n.type === 'core.confirmDraft')!.parameters).toMatchObject({ peopleOnly: true, allowEdit: false, timeoutMinutes: 4320, onTimeout: 'reject', channel: 'chat', choices: '{{ $json.durationChoices }}' });
    expect(accessSettings().chatWorkflowId).toEqual(expect.any(String));
  });
});

describe('a GitHub team for a shorter time, then taken back by the service', () => {
  it('runs end to end', async () => {
    const request = await createRequest(mia, { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'mia-gh' });
    // The question is waiting for the approver, and for nobody else.
    const items = (await needsYou(undefined)).filter((i) => i.executionId === request.executionId);
    expect(items[0]).toMatchObject({ kind: 'approval', title: 'Waiting for ann@landflow.test: Give Mia Member Platform team for 1 h?' });
    expect(fake.members('teams', 'acme/platform')).toEqual({});

    await expect(decideAccessRequest(mia, request.id, { approved: true })).rejects.toMatchObject({ status: 403 });
    await expect(decideAccessRequest(ola, request.id, { approved: true })).rejects.toMatchObject({ status: 404 });
    await expect(decideAccessRequest(ann, request.id, { approved: true, choice: '1440' })).rejects.toMatchObject({ status: 400 });
    expect(fake.members('teams', 'acme/platform')).toEqual({});

    const decided = await decideAccessRequest(ann, request.id, { approved: true, choice: '15', comment: 'Fine for a quarter of an hour' });
    expect(decided).toMatchObject({ status: 'approved', approvedMinutes: 15, grant: { status: 'active', alreadyHad: false }, decisions: [{ outcome: 'approve', byName: 'Ann Approver', durationMinutes: 15, channel: 'needs-you' }] });
    expect(fake.members('teams', 'acme/platform')).toEqual({ 'mia-gh': 'member' });
    expect(store.getExecution(request.executionId!)!.status).toBe('success');
    const grant = grantOfRequest(request.id)!;
    expect(Date.parse(grant.until!) - Date.parse(grant.since!)).toBe(15 * 60_000);
    // Mia sees it granted; nobody else but the entry's people do.
    expect(listGrants(mia, { scope: 'mine' }).map((g) => g.id)).toContain(grant.id);
    expect(listGrants(ola, { scope: 'all' }).map((g) => g.id)).not.toContain(grant.id);
    expect(listGrants(ann, { scope: 'all' }).map((g) => g.id)).toContain(grant.id);
    expect(audited('access.request.approve').some((e) => e.target?.id === request.id && e.actor?.id === ann.id)).toBe(true);

    // Not yet due: untouched. Due: the service removes it, marks it expired and tells Mia.
    expect(await sweepGrants(Date.parse(grant.until!) - 60_000)).toMatchObject({ removed: 0 });
    expect(fake.members('teams', 'acme/platform')).toEqual({ 'mia-gh': 'member' });
    expect(await sweepGrants(Date.parse(grant.until!) + 1_000)).toMatchObject({ removed: 1 });
    expect(fake.members('teams', 'acme/platform')).toEqual({});
    expect(grantOfRequest(request.id)).toMatchObject({ status: 'expired', end_reason: 'expired' });
    expect(getRequest(mia, request.id)).toMatchObject({ status: 'approved', grant: { status: 'expired' } });
    expect(audited('access.grant.revoke').some((e) => e.target?.id === grant.id && (e.details as { reason?: string }).reason === 'expired')).toBe(true);
    await vi.waitFor(() => expect(mails.some((m) => m.to === 'mia@landflow.test' && /ended/i.test(m.subject))).toBe(true));
    // She can ask again now.
    const again = await createRequest(mia, { entryId: team.id, durationMinutes: 15, reason: 'One more fix' });
    expect(again.status).toBe('pending');
    await decideAccessRequest(ann, again.id, { approved: false, comment: 'Enough for today' });
  });
});

describe('a Google group for good', () => {
  it('is granted with no end, to the session email, and given back by the holder', async () => {
    const request = await createRequest(ola, { entryId: group.id, durationMinutes: null, reason: 'On the engineering list', account: 'ignored@example.com' });
    const decided = await decideAccessRequest(ann, request.id, { approved: true });
    expect(decided.grant).toMatchObject({ status: 'active', until: null });
    expect(fake.members('groups', 'eng@example.com')).toHaveProperty('ola@landflow.test');
    expect(await sweepGrants(Date.now() + 365 * 86_400_000)).toMatchObject({ removed: 0 });
    expect(fake.members('groups', 'eng@example.com')).toHaveProperty('ola@landflow.test');
    const back = await revokeNow(ola, decided.grant!.id);
    expect(back.status).toBe('revoked');
    expect(grantOfRequest(request.id)).toMatchObject({ end_reason: 'given_back', ended_by: ola.id });
    expect(fake.members('groups', 'eng@example.com')).toEqual({});
  });
});

describe('a no', () => {
  it('is denied with the approver’s comment, grants nothing and can be asked again', async () => {
    const request = await createRequest(mia, { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build' });
    const before = JSON.stringify(fake.members('teams', 'acme/platform'));
    const decided = await decideAccessRequest(ann, request.id, { approved: false, comment: 'Not this sprint' });
    expect(decided).toMatchObject({ status: 'denied', note: 'Not this sprint', decisions: [{ outcome: 'deny', byName: 'Ann Approver' }] });
    expect(decided.grant).toBeUndefined();
    expect(JSON.stringify(fake.members('teams', 'acme/platform'))).toBe(before);
    expect(store.getExecution(request.executionId!)!.status).toBe('success');
    await expect(decideAccessRequest(ann, request.id, { approved: true })).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(mails.some((m) => m.to === 'mia@landflow.test' && /denied/i.test(m.subject) && m.text.includes('Not this sprint'))).toBe(true));
  });
});

describe('a manual entry', () => {
  it('is approved in the flow, then done by hand', async () => {
    const request = await createRequest(mia, { entryId: manual.id, durationMinutes: 60, reason: 'Edit the launch deck' });
    const callsBefore = fake.calls.length;
    const decided = await decideAccessRequest(ann, request.id, { approved: true, choice: '60' });
    expect(decided).toMatchObject({ status: 'approved', grant: { status: 'pending', canMarkDone: true } });
    // Nothing was sent to any system; a person does it and says so.
    expect(fake.calls.length).toBe(callsBefore);
  });
});

describe('the channel the template picks', () => {
  it('asks by email when the host can send it, and in chat when it cannot', async () => {
    const ask = (workflowId: string) => store.getWorkflow(workflowId)!.nodes.find((n) => n.type === 'core.confirmDraft')!.parameters.channel;
    expect(ask(accessSettings().workflowId!)).toBe('chat');
    // A second setup with SMTP configured (the settings key forgotten, as on a fresh instance).
    saveAccessSettings({ projectId: accessSettings().projectId });
    const withMail = await installAccessRequests(w.owner);
    expect(ask(withMail.workflowId!)).toBe('email');
    setMailTransport(undefined);
    expect(ask(accessSettings().workflowId!)).toBe('email');
  });
});
