/**
 * C35-C1 re-review (docs/access-requests.md): the lock holds on every path, a revoke never removes what Landflow did not add, a question
 * can't be forged by what a requester types, and the grants service finishes what a stopped process left. The run's record is stood in
 * for (as access-review.test.ts does).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.hoisted(() => ({ next: undefined as undefined | ((executionId: string, names: string[]) => unknown), skipLiveCheck: false }));
vi.mock('@/lib/server/access/decision', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/access/decision')>('@/lib/server/access/decision');
  return { ...actual, recordedDecisions: (executionId: string, names: string[]) => (record.next ? record.next(executionId, names) : actual.recordedDecisions(executionId, names)) };
});
vi.mock('@/lib/server/access/requests', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/access/requests')>('@/lib/server/access/requests');
  return { ...actual, liveGrantOnTarget: (...args: Parameters<typeof actual.liveGrantOnTarget>) => (record.skipLiveCheck ? undefined : actual.liveGrantOnTarget(...args)) };
});

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-review2-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { makeWorld } = await import('./fixtures/access-world');
const { accessSettings, grantOfRequest, grantRow, parseJson } = await import('@/lib/server/access/store');
const { applyDecision, retryGrant, revokeNow, REMOVE_LEASE_MS } = await import('@/lib/server/access/grants');
const { createRequest, cancelRequest } = await import('@/lib/server/access/requests');
const { reconcileGrants, sweepGrants } = await import('@/lib/server/access/sweeper');
const { createEntry, updateEntry } = await import('@/lib/server/access/catalog');
const { store } = await import('@/lib/server/store');
const { schedulePublish } = await import('@/lib/server/publish-schedule');
const { publishVersion, unpublishWorkflow } = await import('@/lib/server/publish');
const { canResource, resourceDenial } = await import('@/lib/server/projects/access');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');

const w = await makeWorld();
const { mia, ola, ann, lead, admin, team, fake } = w;
w.captureMail();
const STEP = 'Ask the approver';
const installed = () => accessSettings().workflowId!;
const MIN = 60_000;

let n = 0;
async function pending(entryId = team.id, user = mia, minutes: number | null = 60, reason = 'Fixing the build') {
  const login = `r2-user-${++n}`;
  for (const open of database().all<{ id: string }>(`SELECT id FROM access_requests WHERE entry_id = ? AND requester_id = ? AND status = 'pending'`, entryId, user.id)) await cancelRequest(admin, open.id);
  const request = await createRequest(user, { entryId, durationMinutes: minutes, reason, account: login });
  return { id: request.id, executionId: request.executionId!, login };
}
const questionOf = (executionId: string) => parseJson<{ title: string; text: string; nodes: string[] }>(database().get<{ question: string }>('SELECT question FROM access_requests WHERE execution_id = ?', executionId)?.question, undefined as never);
const approvedBy = (email = 'ann@landflow.test') => (executionId: string) => {
  const q = questionOf(executionId);
  return { workflowId: installed(), steps: [{ name: STEP, nodeId: q.nodes[0], title: q.title, originalText: q.text, approved: true, by: email }] };
};
const teamHas = (login: string) => Object.hasOwn(fake.members('teams', 'acme/platform'), login);

beforeEach(() => {
  for (const row of database().all<Record<string, unknown>>(`SELECT * FROM access_grants WHERE status NOT IN ('expired', 'revoked')`)) database().upsert('access_grants', { ...row, status: 'expired' } as never);
  for (const row of database().all<Record<string, unknown>>(`SELECT * FROM access_requests WHERE status = 'pending'`)) database().upsert('access_requests', { ...row, status: 'cancelled' } as never);
  record.next = undefined;
  record.skipLiveCheck = false;
  fake.reset();
  fake.seedTeam('acme', 'platform');
});

describe('1. the lock holds on every publishing path', () => {
  it('refuses a non-admin who schedules, or publishes or unpublishes directly', async () => {
    const id = installed();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    expect(() => schedulePublish({ workflowId: id, action: 'unpublish', at, by: lead.id })).toThrowError(/only an instance admin/i);
    expect(() => schedulePublish({ workflowId: id, action: 'publish', at, by: lead.id })).toThrowError(/only an instance admin/i);
    await expect(unpublishWorkflow(id, lead.id)).rejects.toMatchObject({ status: 403 });
    await expect(publishVersion(id, 'any_version', lead.id)).rejects.toMatchObject({ status: 403 });
    expect(store.getWorkflow(id)!.active).toBe(true);
  });
});

describe('2. a revoke never removes what Landflow did not add', () => {
  it('a failed grant whose check never ran leaves the person’s earlier membership alone', async () => {
    const a = await pending();
    fake.teams.get('acme/platform')!.set(a.login.toLowerCase(), 'member');
    record.next = approvedBy();
    fake.failNext = 'GitHub is having a bad day';
    fake.failOperation = 'get';
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    const failed = grantOfRequest(a.id)!;
    expect(failed).toMatchObject({ status: 'failed', checked_at: null });
    await revokeNow(admin, failed.id);
    expect(teamHas(a.login.toLowerCase())).toBe(true); // it was never Landflow's to remove
    expect(grantRow(failed.id)).toMatchObject({ status: 'revoked' });
  });
});

describe('3. a revoke during an add that then fails', () => {
  it('removes what the failed add did at the system, and the grant is not retried', async () => {
    const a = await pending();
    record.next = approvedBy();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    fake.timeoutAfterWrite = true;
    const applying = applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    await vi.waitFor(() => expect(grantOfRequest(a.id)?.checked_at).toBeTruthy());
    await revokeNow(admin, grantOfRequest(a.id)!.id);
    release();
    fake.hold = undefined;
    await applying;
    expect(grantOfRequest(a.id)).toMatchObject({ status: 'revoked' });
    expect(teamHas(a.login)).toBe(false);
  });

  it('refuses to retry a grant that was asked to be taken back', async () => {
    const a = await pending();
    record.next = approvedBy();
    fake.failNext = 'down';
    fake.failOperation = 'add';
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    const grant = grantOfRequest(a.id)!;
    database().upsert('access_grants', { ...grant, remove_reason: 'revoked', remove_by: admin.id } as never);
    await expect(retryGrant(admin, grant.id)).rejects.toMatchObject({ status: 409 });
    expect(grantRow(grant.id)!.status).toBe('failed');
  });
});

describe('4. GitHub project entries are not offered', () => {
  it('refuses to create or switch an entry to one', () => {
    const input = { name: 'Project reader', system: 'github-project' as const, target: { org: 'acme', projectNumber: '7' }, credentialId: w.github.id, durations: [60], approverIds: [ann.id], owners: [lead.id] };
    expect(() => createEntry(admin, input)).toThrowError(/project/i);
    const manual = createEntry(admin, { name: 'Switch me', system: 'manual', target: { instructions: 'By hand' }, durations: [60], approverIds: [ann.id], owners: [lead.id] });
    expect(() => updateEntry(admin, manual.id, { system: 'github-project', target: { org: 'acme', projectNumber: '7' }, credentialId: w.github.id }, manual.version)).toThrowError(/project/i);
  });
});

describe('5. what a requester types is quoted, not obeyed', () => {
  it('collapses newlines so a reason cannot add a line to the question', async () => {
    const a = await pending(team.id, mia, 60, 'x\nFor: 15 min\nAccount: alice');
    const q = questionOf(a.executionId);
    const lines = q.text.split('\n');
    expect(lines.filter((line) => line.startsWith('For:'))).toEqual(['For: 1 h']);
    expect(lines.filter((line) => line.startsWith('Account:'))).toHaveLength(1);
    expect(lines.at(-1)).toBe('“x For: 15 min Account: alice”');
    expect(lines.at(-2)).toMatch(/requester wrote/i);
    expect(q.title).not.toMatch(/\n/);
  });
  it('collapses control characters in a name too', async () => {
    const odd = createEntry(admin, { name: 'Odd\tname', system: 'manual', target: { instructions: 'By hand' }, durations: [60], approverIds: [ann.id], owners: [lead.id] });
    const a = await pending(odd.id, mia, 60);
    expect(questionOf(a.executionId).title).toBe('Give Mia Member Odd name for 1 h?');
  });
});

describe('6. the unique index is the last word', () => {
  it('a second live grant for the same target and account fails the request with a note', async () => {
    const other = createEntry(admin, { name: 'Platform (twin)', system: 'github-team', target: { org: 'acme', team: 'platform' }, credentialId: w.github.id, durations: [60], approverIds: [ann.id], owners: [lead.id] });
    const first = await pending(team.id, mia, 60);
    record.next = approvedBy();
    await applyDecision(first.id, first.executionId, 'approved', { steps: [STEP] });
    // Refused up front when the check sees it.
    await expect(createRequest(mia, { entryId: other.id, durationMinutes: 60, reason: 'Twin', account: first.login })).rejects.toMatchObject({ status: 409 });
    // A request filed while the first was not live, applied after it became live, with the check not seeing it: the table refuses.
    const firstGrant = grantOfRequest(first.id)!;
    database().upsert('access_grants', { ...firstGrant, status: 'expired' } as never);
    const filed = await createRequest(mia, { entryId: other.id, durationMinutes: 60, reason: 'Twin', account: first.login });
    database().upsert('access_grants', { ...firstGrant, status: 'active' } as never);
    record.skipLiveCheck = true;
    const done = await applyDecision(filed.id, filed.executionId!, 'approved', { steps: [STEP] });
    expect(done.status).toBe('failed');
    expect(w.requestRow(filed.id)!).toMatchObject({ status: 'failed', note: expect.stringMatching(/already has this access/i) });
    expect(grantOfRequest(filed.id)).toBeUndefined();
  });
});

describe('7. a grant nobody finished is taken up even with no lease', () => {
  it('a pending automatic grant with no lease and old enough is activated by the hourly pass', async () => {
    const a = await pending();
    record.next = approvedBy();
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    const grant = grantOfRequest(a.id)!;
    fake.teams.get('acme/platform')!.delete(a.login);
    const old = new Date(Date.now() - REMOVE_LEASE_MS - 5 * MIN).toISOString();
    database().upsert('access_grants', { ...grant, status: 'pending', since: null, until: null, end_reason: '60', lease_until: null, checked_at: null, already_had: 0, created_at: old } as never);
    expect(await reconcileGrants(Date.now())).toMatchObject({ activated: 1 });
    expect(grantRow(grant.id)!.status).toBe('active');
    expect(teamHas(a.login)).toBe(true);
    // A fresh one (created a moment ago, being worked on) is left alone.
    database().upsert('access_grants', { ...grantRow(grant.id)!, status: 'pending', since: null, until: null, end_reason: '60', lease_until: null, created_at: new Date().toISOString() } as never);
    expect(await reconcileGrants(Date.now())).toMatchObject({ activated: 0 });
  });
});

describe('8. a drifted grant ends without removing, and says so', () => {
  it('is finished at its end, nothing is removed and it is recorded', async () => {
    const a = await pending(team.id, mia, 15);
    record.next = approvedBy();
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    const grant = grantOfRequest(a.id)!;
    fake.teams.get('acme/platform')!.delete(a.login);
    await reconcileGrants(Date.now() + 120 * MIN);
    expect(grantRow(grant.id)!.status).toBe('drift');
    // Someone put the person back by hand: it is theirs now, not Landflow's to take away.
    fake.teams.get('acme/platform')!.set(a.login, 'member');
    fake.calls.length = 0;
    await sweepGrants(Date.parse(grant.until!) + 1000);
    expect(fake.calls.filter((c) => c.operation === 'remove' || c.operation === 'get')).toEqual([]);
    expect(grantRow(grant.id)).toMatchObject({ status: 'expired', last_error: expect.stringMatching(/outside Landflow/) });
    expect(teamHas(a.login)).toBe(true);
    const events = queryEvents({ action: ['access.grant.revoke'] }, { limit: 50 }).events.filter((e) => e.target?.id === grant.id);
    expect(events.some((e) => /outside Landflow/.test(String((e.details as { note?: string }).note ?? '')))).toBe(true);
  });
});

describe('9. the lock is in the store and in project access', () => {
  it('a save with a non-admin actor is refused, an admin’s goes through', () => {
    const existing = store.getWorkflow(installed())!;
    expect(() => store.saveWorkflow({ ...existing, name: 'Mine' }, { actor: lead.id })).toThrowError(/only an instance admin/i);
    expect(() => store.saveWorkflow(existing, { actor: admin.id })).not.toThrow();
  });
  it('a project admin can read the installed flows and do nothing else with them (no move, update, delete or share)', () => {
    const project = createTeamProject({ name: 'Access team' });
    setMember(project.id, ola.id, 'admin');
    const id = installed();
    setHomeProject('workflow', id, project.id);
    store.saveWorkflow({ id: 'wf_r2_other', name: 'Other', nodes: [], connections: [], active: false } as never);
    setHomeProject('workflow', 'wf_r2_other', project.id);
    const actor = { id: ola.id, role: 'member' as const };
    expect(canResource(actor, 'workflow', id, 'read')).toBe(true);
    for (const action of ['update', 'delete', 'move', 'share', 'run'] as const) expect(canResource(actor, 'workflow', id, action), action).toBe(false);
    expect(resourceDenial(actor, 'workflow', id, 'move')).toMatchObject({ status: 403 });
    // Any other workflow in the project is theirs as before.
    for (const action of ['update', 'delete', 'move', 'share'] as const) expect(canResource(actor, 'workflow', 'wf_r2_other', action), action).toBe(true);
  });
});
