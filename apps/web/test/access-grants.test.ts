/**
 * C35 (docs/access-requests.md#what-apply-access-decision-trusts): Apply Access Decision believes only the server's record of the run. The
 * record is stood in for here (`recordedDecisions`), so every way an answer can be wrong or forged is tried; whatever is wrong, the request
 * becomes `failed` with the reason and the fake GitHub is untouched. The real flow end to end is in access-flow.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.hoisted(() => ({ next: undefined as undefined | ((executionId: string, names: string[]) => unknown) }));
vi.mock('@/lib/server/access/decision', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/access/decision')>('@/lib/server/access/decision');
  return { ...actual, recordedDecisions: (executionId: string, names: string[]) => (record.next ? record.next(executionId, names) : actual.recordedDecisions(executionId, names)) };
});

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-grants-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { makeWorld } = await import('./fixtures/access-world');
const { accessSettings, grantOfRequest } = await import('@/lib/server/access/store');
const { applyDecision, markDone, retryGrant, revokeNow } = await import('@/lib/server/access/grants');
const { createRequest, cancelRequest } = await import('@/lib/server/access/requests');
const { AccessError } = await import('@/lib/server/access/errors');
const { queryEvents } = await import('@/lib/server/audit/store');
const { setUserDisabled } = await import('@/lib/server/auth/users');
const { runWorkflow } = await import('@/lib/server/runner');
const { database } = await import('@/lib/server/db');

const w = await makeWorld();
const { mia, ola, ann, lead, admin, team, manual, fake, mails } = w;
w.captureMail();
const STEP = 'Ask the approver';
const installed = () => accessSettings().workflowId!;
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 100 }).events;

let n = 0;
/** A fresh pending request by `user` (each in its own entry state: cancelled before the next). */
async function pending(entryId = team.id, user = mia, minutes: number | null = 60) {
  const login = `gh-user-${++n}`;
  for (const open of database().all<{ id: string }>(`SELECT id FROM access_requests WHERE entry_id = ? AND requester_id = ? AND status = 'pending'`, entryId, user.id)) await cancelRequest(admin, open.id);
  const request = await createRequest(user, { entryId, durationMinutes: minutes, reason: 'Fixing the build', account: login });
  return { id: request.id, executionId: request.executionId!, login };
}
/** The question the server built for the run's request (what an honest Ask a Person records), so a forged answer is the only thing wrong. */
const questionOf = (executionId: string) => JSON.parse(database().get<{ question: string }>('SELECT question FROM access_requests WHERE execution_id = ?', executionId)!.question) as { title: string; text: string; nodes: string[] };
const says = (partial: Record<string, unknown> | undefined, workflowId = installed()) => (executionId: string): unknown => {
  const q = questionOf(executionId);
  return { workflowId, steps: partial === undefined ? [undefined] : [{ name: STEP, nodeId: q.nodes[0], title: q.title, originalText: q.text, ...partial }] };
};
/** Make the request's entry a two-step one (the second step is Lee Lead), as the data allows. */
function twoSteps(requestId: string) {
  const row = w.requestRow(requestId)!;
  const snapshot = JSON.parse(row.entry_snapshot);
  snapshot.steps.push({ name: 'Second', approvers: { userIds: [lead.id] }, approvalsRequired: 1 });
  const question = JSON.parse(row.question!);
  question.nodes.push('node_second');
  database().upsert('access_requests', { ...row, entry_snapshot: JSON.stringify(snapshot), question: JSON.stringify(question) } as never);
  return question as { title: string; text: string; nodes: string[] };
}
const teamHas = (login: string) => Object.hasOwn(fake.members('teams', 'acme/platform'), login);
const status = (id: string) => w.requestRow(id)!.status;
const note = (id: string) => w.requestRow(id)!.note;

beforeEach(() => {
  record.next = undefined;
  mails.length = 0;
});

describe('an approval that is believed', () => {
  it('grants for the asked duration when the approver picked nothing, and for a shorter one when they did', async () => {
    const a = await pending();
    record.next = says({ approved: true, by: 'ann@landflow.test' });
    const done = await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    expect(done).toMatchObject({ status: 'approved', grantId: expect.any(String) });
    const grant = grantOfRequest(a.id)!;
    expect(grant.status).toBe('active');
    expect(Date.parse(grant.until!) - Date.parse(grant.since!)).toBe(60 * 60_000);
    expect(teamHas(a.login)).toBe(true);

    const b = await pending(team.id, ola, 60);
    record.next = says({ approved: true, by: 'email:ann@landflow.test', choice: '15' });
    await applyDecision(b.id, b.executionId, 'approved', { steps: [STEP] });
    const shorter = grantOfRequest(b.id)!;
    expect(Date.parse(shorter.until!) - Date.parse(shorter.since!)).toBe(15 * 60_000);
    expect(w.requestRow(b.id)!.approved_minutes).toBe(15);
    expect(audited('access.request.approve').length).toBeGreaterThanOrEqual(2);
    expect(audited('access.grant.activate').length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() => expect(mails.filter((m) => /granted/i.test(m.subject)).map((m) => m.to).sort()).toEqual(['mia@landflow.test', 'ola@landflow.test']));
    for (const grantId of [grant.id, shorter.id]) await revokeNow(admin, grantId);
  });

  it('grants unlimited access with no end', async () => {
    const g = await pending(w.group.id, mia, null);
    record.next = says({ approved: true, by: 'ann@landflow.test' });
    await applyDecision(g.id, g.executionId, 'approved', { steps: [STEP] });
    const grant = grantOfRequest(g.id)!;
    expect(grant).toMatchObject({ status: 'active', until: null });
    expect(fake.members('groups', 'eng@example.com')).toHaveProperty('mia@landflow.test');
    await revokeNow(admin, grant.id);
    expect(fake.members('groups', 'eng@example.com')).not.toHaveProperty('mia@landflow.test');
  });
});

describe('an approval that is not believed grants nothing', () => {
  const refuseWith = async (answer: (() => unknown) | undefined, reason: RegExp, options: { as?: typeof mia; outcome?: 'approved' | 'rejected'; executionId?: string } = {}) => {
    const a = await pending(team.id, options.as ?? mia);
    record.next = answer;
    const before = JSON.stringify(fake.members('teams', 'acme/platform'));
    const done = await applyDecision(a.id, options.executionId ?? a.executionId, options.outcome ?? 'approved', { steps: [STEP] }).catch((error) => error);
    if (done instanceof AccessError) {
      expect(done.status).toBe(409);
      expect(done.message).toMatch(reason);
    } else {
      expect(done).toMatchObject({ status: 'failed' });
      expect(note(a.id)).toMatch(reason);
      expect(status(a.id)).toBe('failed');
    }
    expect(JSON.stringify(fake.members('teams', 'acme/platform'))).toBe(before);
    expect(grantOfRequest(a.id)).toBeUndefined();
    return a;
  };

  it('the requester decided their own request', async () => {
    await refuseWith(says({ approved: true, by: 'mia@landflow.test' }), /own request/);
  });
  it('the decider is not an approver of the entry', async () => {
    await refuseWith(says({ approved: true, by: 'ola@landflow.test' }), /not an approver of this request/);
  });
  it('the decider is unknown, Slack, a timeout or nobody', async () => {
    for (const by of ['nobody@landflow.test', 'slack:U123', 'timeout', 'unknown', undefined]) {
      await refuseWith(says({ approved: true, ...(by && { by }) }), /not by a person Landflow knows/);
    }
  });
  it('the approver was deactivated since', async () => {
    setUserDisabled(ann.id, true);
    try {
      await refuseWith(says({ approved: true, by: 'ann@landflow.test' }), /not by a person Landflow knows/);
    } finally {
      setUserDisabled(ann.id, false);
    }
  });
  it('the run has no recorded answer, or its record says rejected while the branch says approved', async () => {
    await refuseWith(says(undefined), /no recorded answer/);
    await refuseWith(says({ approved: false, by: 'ann@landflow.test' }), /record says the request was rejected/);
  });
  it('the approved duration is not one the entry offers, or longer than asked', async () => {
    await refuseWith(says({ approved: true, by: 'ann@landflow.test', choice: '30' }), /not one this entry offers/);
    const a = await pending(team.id, ola, 15);
    record.next = says({ approved: true, by: 'ann@landflow.test', choice: '60' });
    expect(await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] })).toMatchObject({ status: 'failed' });
    expect(note(a.id)).toMatch(/longer than asked/);
  });
  it('the request was started by another run, or the run is not the installed flow', async () => {
    await refuseWith(says({ approved: true, by: 'ann@landflow.test' }), /only by the run it started/, { executionId: 'ex_someone_else' });
    await refuseWith(says({ approved: true, by: 'ann@landflow.test' }, 'wf_some_copy'), /not the installed access flow/);
  });
  it('two steps are listed and only one answered: waiting for step 2', async () => {
    const a = await pending(team.id, mia);
    const q = twoSteps(a.id);
    record.next = () => ({ workflowId: installed(), steps: [{ name: STEP, nodeId: q.nodes[0], title: q.title, originalText: q.text, approved: true, by: 'ann@landflow.test' }, undefined] });
    const done = await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP, 'Second approver'] });
    expect(done).toMatchObject({ status: 'failed' });
    expect(note(a.id)).toMatch(/waiting for step 2/);
    expect(grantOfRequest(a.id)).toBeUndefined();
  });
  it('a later step is decided by someone else, not the first step’s approver', async () => {
    const a = await pending(team.id, mia);
    const q = twoSteps(a.id);
    record.next = () => ({ workflowId: installed(), steps: [{ name: STEP, nodeId: q.nodes[0], title: q.title, originalText: q.text, approved: true, by: 'ann@landflow.test' }, { name: 'Second', nodeId: q.nodes[1], originalText: q.text, approved: true, by: 'ann@landflow.test' }] });
    expect(await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP, 'Second'] })).toMatchObject({ status: 'failed' });
    expect(note(a.id)).toMatch(/not an approver of this request/);
  });
  it('a settled request cannot be applied again', async () => {
    const a = await pending();
    record.next = says({ approved: false, by: 'ann@landflow.test', comment: 'Not now' });
    await applyDecision(a.id, a.executionId, 'rejected', { steps: [STEP] });
    await expect(applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] })).rejects.toMatchObject({ status: 409 });
  });
  it('failed requests are recorded and the requester is told', async () => {
    expect(audited('access.request.fail').length).toBeGreaterThan(5);
    const a = await pending();
    record.next = says({ approved: true, by: 'mia@landflow.test' });
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    await vi.waitFor(() => expect(mails.some((m) => m.to === 'mia@landflow.test' && /could not be granted/.test(m.subject))).toBe(true));
  });
});

describe('a no', () => {
  it('records a denial with the comment and tells the requester', async () => {
    const a = await pending();
    record.next = says({ approved: false, by: 'ann@landflow.test', comment: 'Ask again next sprint' });
    expect(await applyDecision(a.id, a.executionId, 'rejected', { steps: [STEP] })).toMatchObject({ status: 'denied' });
    expect(w.requestRow(a.id)).toMatchObject({ status: 'denied', note: 'Ask again next sprint' });
    expect(JSON.parse(w.requestRow(a.id)!.decisions!)[0]).toMatchObject({ outcome: 'deny', byName: 'Ann Approver', comment: 'Ask again next sprint' });
    await vi.waitFor(() => expect(mails.find((m) => /denied/i.test(m.subject))?.text).toContain('Ask again next sprint'));
    expect(audited('access.request.deny').some((e) => e.target?.id === a.id)).toBe(true);
  });
  it('a timeout expires the request', async () => {
    const a = await pending();
    record.next = says({ approved: false, by: 'timeout' });
    expect(await applyDecision(a.id, a.executionId, 'rejected', { steps: [STEP] })).toMatchObject({ status: 'expired' });
    expect(w.requestRow(a.id)).toMatchObject({ status: 'expired', note: 'Nobody answered in time' });
    await vi.waitFor(() => expect(mails.some((m) => /expired/i.test(m.subject))).toBe(true));
    expect(audited('access.request.expire').some((e) => e.target?.id === a.id)).toBe(true);
  });
  it('a denial needs a recorded answer too', async () => {
    const a = await pending();
    record.next = says(undefined);
    expect(await applyDecision(a.id, a.executionId, 'rejected', { steps: [STEP] })).toMatchObject({ status: 'failed' });
  });
});

describe('when the system fails', () => {
  it('records a failed grant with the plugin’s message (never the token), and an owner retries it', async () => {
    const a = await pending(team.id, ola);
    record.next = says({ approved: true, by: 'ann@landflow.test' });
    fake.failNext = 'No team acme/platform for token {{token}}';
    const done = await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    expect(done).toMatchObject({ status: 'approved', note: expect.stringMatching(/No team acme\/platform/) });
    const grant = grantOfRequest(a.id)!;
    expect(grant.status).toBe('failed');
    expect(grant.last_error).not.toContain('ghp_world-test-token-123');
    expect(JSON.stringify([...mails, ...audited('access.grant.fail')])).not.toContain('ghp_world-test-token-123');
    expect(audited('access.grant.fail').length).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(mails.some((m) => m.to === 'ola@landflow.test' && /could not be granted/.test(m.subject))).toBe(true));
    // Neither the holder nor a stranger retries; an owner of the entry does.
    await expect(retryGrant(ola, grant.id)).rejects.toMatchObject({ status: 403 });
    await expect(retryGrant(w.mia, grant.id)).rejects.toMatchObject({ status: 404 });
    const view = await retryGrant(lead, grant.id);
    expect(view).toMatchObject({ status: 'active' });
    expect(teamHas(a.login)).toBe(true);
    await revokeNow(admin, grant.id);
  });
});

describe('a manual entry', () => {
  it('waits for a person: the approver is asked to grant by hand, Done by the approver starts it, never by the holder', async () => {
    const a = await pending(manual.id, mia, 60);
    record.next = says({ approved: true, by: 'ann@landflow.test' });
    const callsBefore = fake.calls.length;
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    const grant = grantOfRequest(a.id)!;
    expect(grant.status).toBe('pending');
    expect(fake.calls.length).toBe(callsBefore);
    await vi.waitFor(() => expect(mails.length).toBeGreaterThanOrEqual(2));
    const toApprover = mails.find((m) => m.to === 'ann@landflow.test')!;
    expect(toApprover.subject).toMatch(/grant by hand/i);
    expect(toApprover.text).toContain('Add them in Figma, Settings, Members');
    expect(mails.find((m) => m.to === 'mia@landflow.test')!.subject).toMatch(/approved/i);
    await expect(markDone(mia, grant.id)).rejects.toMatchObject({ status: 403 });
    const view = await markDone(ann, grant.id);
    expect(view).toMatchObject({ status: 'active' });
    const started = grantOfRequest(a.id)!;
    expect(Date.parse(started.until!) - Date.parse(started.since!)).toBe(60 * 60_000);
    await vi.waitFor(() => expect(mails.some((m) => m.to === 'mia@landflow.test' && /granted/i.test(m.subject))).toBe(true));
    // Giving it back: a manual grant waits for someone to remove it by hand, then Done ends it.
    const removing = await revokeNow(mia, grant.id);
    expect(removing.status).toBe('removing');
    await vi.waitFor(() => expect(mails.some((m) => m.to === 'ann@landflow.test' && /remove by hand/i.test(m.subject))).toBe(true));
    await expect(markDone(mia, grant.id)).rejects.toMatchObject({ status: 403 });
    expect(await markDone(ann, grant.id)).toMatchObject({ status: 'revoked' });
  });
});

describe('an editor run with the example', () => {
  it('is a dry run: nothing is written', async () => {
    const before = database().get<{ n: number }>('SELECT COUNT(*) AS n FROM access_grants')!.n;
    const workflow = {
      id: 'wf_dry',
      name: 'Dry',
      nodes: [
        { id: 'trigger', name: 'Access Request', type: 'core.accessRequestTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'apply', name: 'Grant', type: 'core.accessDecision', typeVersion: 1, position: [200, 0], parameters: { requestId: '{{ $json.requestId }}', decision: 'approved', steps: STEP } },
      ],
      connections: [{ id: 'c1', type: 'main', source: 'trigger', target: 'apply', sourceIndex: 0, targetIndex: 0 }],
    };
    const run = await runWorkflow({ workflow: workflow as never, mode: 'manual', startNodeId: 'trigger' });
    expect(run.status).toBe('success');
    expect(run.runData.apply.at(-1)!.outputs[0]![0]!.json).toMatchObject({ requestId: 'areq_example', dryRun: true });
    expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM access_grants')!.n).toBe(before);
  });
});
