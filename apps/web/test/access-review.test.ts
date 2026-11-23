/**
 * C35-C1 review fixes (docs/access-requests.md): access must not outlive its end, and must not be granted on the wrong approval.
 * Apply Access Decision's record of the run is stood in for (as access-grants.test.ts does) so every way of getting it wrong is tried;
 * the real flow is used where the point is the flow itself.
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
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-review-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
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
const { applyDecision, retryGrant, revokeNow } = await import('@/lib/server/access/grants');
const { createRequest, cancelRequest, decideAccessRequest, setGithubAccount, getRequest } = await import('@/lib/server/access/requests');
const { sweepGrants, reconcileGrants } = await import('@/lib/server/access/sweeper');
const { createEntry, updateEntry } = await import('@/lib/server/access/catalog');
const { installAccessRequests, accessSetup } = await import('@/lib/server/access/setup');
const { resetAccessTrigger } = await import('@/lib/server/access/trigger');
const { store } = await import('@/lib/server/store');
const { publishDraft } = await import('@/lib/server/publish');
const { governedSave } = await import('@/lib/server/governance/saves');
const { publishOrRequest } = await import('@/lib/server/governance/approvals');
const { createUser, setUserDisabled } = await import('@/lib/server/auth/users');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');

const w = await makeWorld();
const { mia, ola, ann, lead, admin, owner, team, fake } = w;
w.captureMail();
const STEP = 'Ask the approver';
const installed = () => accessSettings().workflowId!;
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 200 }).events;
const MIN = 60_000;

let n = 0;
async function pending(entryId = team.id, user = mia, minutes: number | null = 60, account?: string) {
  const login = account ?? `rv-user-${++n}`;
  for (const open of database().all<{ id: string }>(`SELECT id FROM access_requests WHERE entry_id = ? AND requester_id = ? AND status = 'pending'`, entryId, user.id)) await cancelRequest(admin, open.id);
  const request = await createRequest(user, { entryId, durationMinutes: minutes, reason: 'Fixing the build', account: login });
  return { id: request.id, executionId: request.executionId!, login };
}
const questionOf = (executionId: string) => parseJson<{ title: string; text: string; nodes: string[] }>(database().get<{ question: string }>('SELECT question FROM access_requests WHERE execution_id = ?', executionId)?.question, undefined as never);
/** What the run's record says: a step answered as the server asked it (override any part to forge it). */
const says = (partial: Record<string, unknown> | undefined, workflowId = installed()) => (executionId: string) => {
  const q = questionOf(executionId);
  return { workflowId, steps: [partial === undefined ? undefined : { name: STEP, nodeId: q?.nodes[0], title: q?.title, originalText: q?.text, ...partial }] };
};
const approvedBy = (email = 'ann@landflow.test', extra: Record<string, unknown> = {}) => says({ approved: true, by: email, ...extra });
const teamHas = (login: string) => Object.hasOwn(fake.members('teams', 'acme/platform'), login);
const status = (id: string) => w.requestRow(id)!.status;

beforeEach(() => {
  // Each test starts with no live grant from an earlier one (a test may leave one in whatever state it was proving).
  for (const row of database().all<Record<string, unknown>>(`SELECT * FROM access_grants WHERE status NOT IN ('expired', 'revoked')`)) database().upsert('access_grants', { ...row, status: 'expired' } as never);
  for (const row of database().all<Record<string, unknown>>(`SELECT * FROM access_requests WHERE status = 'pending'`)) database().upsert('access_requests', { ...row, status: 'cancelled' } as never);
  record.next = undefined;
  fake.reset();
  fake.seedTeam('acme', 'platform');
  fake.seedGroup('eng@example.com');
});

describe('1. a revoke while the access is being put in place', () => {
  it('removes it the moment it is in place and ends it revoked', async () => {
    const a = await pending();
    record.next = approvedBy();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const applying = applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    await vi.waitFor(() => expect(grantOfRequest(a.id)?.lease_until).toBeTruthy());
    const view = await revokeNow(admin, grantOfRequest(a.id)!.id);
    expect(view.status).toBe('pending'); // not settled: the add is still in flight
    release();
    fake.hold = undefined;
    await applying;
    expect(grantOfRequest(a.id)).toMatchObject({ status: 'revoked', end_reason: 'revoked', ended_by: admin.id });
    expect(teamHas(a.login)).toBe(false);
  });

  it('a manual grant nobody has done yet is still cancelled at once', async () => {
    const request = await createRequest(mia, { entryId: w.manual.id, durationMinutes: 60, reason: 'Edit the deck' });
    await decideAccessRequest(ann, request.id, { approved: true });
    const grant = grantOfRequest(request.id)!;
    expect(grant.status).toBe('pending');
    expect((await revokeNow(admin, grant.id)).status).toBe('revoked');
  });
});

describe('2. one check before the first add, never recomputed', () => {
  it('an add that worked at the system but timed out is removed at the end after a retry', async () => {
    const a = await pending();
    record.next = approvedBy();
    fake.timeoutAfterWrite = true;
    const done = await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    expect(done.note).toMatch(/timed out/);
    const failed = grantOfRequest(a.id)!;
    expect(failed).toMatchObject({ status: 'failed', already_had: 0 });
    expect(teamHas(a.login)).toBe(true); // it did happen at GitHub
    const retried = await retryGrant(admin, failed.id);
    expect(retried.status).toBe('active');
    expect(grantRow(failed.id)!.already_had).toBe(0); // the retry's add said "already a member": that is not "had it before"
    const until = Date.parse(grantRow(failed.id)!.until!);
    expect(await sweepGrants(until + 1000)).toMatchObject({ removed: 1 });
    expect(teamHas(a.login)).toBe(false);
  });

  it('someone who had it before keeps `already had` through a failed add and a retry, and is not removed', async () => {
    const a = await pending();
    fake.teams.get('acme/platform')!.set(a.login.toLowerCase(), 'member');
    record.next = approvedBy();
    fake.failNext = 'GitHub hiccup';
    fake.failOperation = 'add';
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    expect(grantOfRequest(a.id)).toMatchObject({ status: 'failed', already_had: 1 });
    await retryGrant(admin, grantOfRequest(a.id)!.id);
    const grant = grantOfRequest(a.id)!;
    expect(grant).toMatchObject({ status: 'active', already_had: 1 });
    await sweepGrants(Date.parse(grant.until!) + 1000);
    expect(teamHas(a.login.toLowerCase())).toBe(true);
    expect(grantOfRequest(a.id)!.status).toBe('expired');
  });

  it('a retry claims only from failed, so two retries at once add once', async () => {
    const a = await pending();
    record.next = approvedBy();
    fake.failNext = 'GitHub hiccup';
    fake.failOperation = 'add';
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    const id = grantOfRequest(a.id)!.id;
    fake.calls.length = 0;
    await Promise.allSettled([retryGrant(admin, id), retryGrant(admin, id)]);
    expect(fake.calls.filter((c) => c.operation === 'add')).toHaveLength(1);
    expect(grantRow(id)!.status).toBe('active');
  });

  it('the hourly pass takes up a pending grant whose lease ran out, keeping what was recorded', async () => {
    const a = await pending();
    record.next = approvedBy();
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    const grant = grantOfRequest(a.id)!;
    // As if the process stopped after the add and before it was marked: pending, the lease over, the check already made.
    database().upsert('access_grants', { ...grant, status: 'pending', since: null, until: null, end_reason: '15', lease_until: new Date(Date.now() - 5 * MIN).toISOString(), checked_at: new Date(Date.now() - 6 * MIN).toISOString(), already_had: 0 } as never);
    expect(await reconcileGrants(Date.now())).toMatchObject({ activated: 1 });
    const after = grantRow(grant.id)!;
    expect(after).toMatchObject({ status: 'active', already_had: 0 });
    expect(Date.parse(after.until!) - Date.parse(after.since!)).toBe(15 * MIN);
    // A lease still running is left alone.
    database().upsert('access_grants', { ...after, status: 'pending', since: null, until: null, end_reason: '15', lease_until: new Date(Date.now() + 5 * MIN).toISOString() } as never);
    expect(await reconcileGrants(Date.now())).toMatchObject({ activated: 0 });
    database().upsert('access_grants', { ...after } as never);
  });
});

describe('3. the question the approver answered is the one the server built', () => {
  it('stores the question and the step nodes with the request, and the item carries them', async () => {
    const a = await pending();
    const q = questionOf(a.executionId);
    expect(q.title).toBe('Give Mia Member Platform team for 1 h?');
    expect(q.text).toContain(`Account: ${a.login}`);
    expect(q.text).toMatch(/unverified/);
    expect(q.nodes).toHaveLength(1);
  });

  it('never grants when the recorded question is not the server’s', async () => {
    for (const [label, forged] of [
      ['a changed title', { title: 'Approve the weekly report?' }],
      ['a changed text', { originalText: 'Approve the weekly report: it is fine.' }],
      ['no recorded question', { title: undefined, originalText: undefined }],
    ] as const) {
      const a = await pending();
      record.next = approvedBy('ann@landflow.test', forged);
      const done = await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
      expect(done.status, label).toBe('failed');
      expect(w.requestRow(a.id)!.note, label).toMatch(/question/);
      expect(teamHas(a.login), label).toBe(false);
      expect(grantOfRequest(a.id), label).toBeUndefined();
    }
  });

  it('needs as many steps as the entry has, and each recorded by the node the run was filed with', async () => {
    const a = await pending();
    record.next = approvedBy();
    const two = await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP, 'Another step'] });
    expect(two.status).toBe('failed');
    expect(w.requestRow(a.id)!.note).toMatch(/step/);
    const b = await pending();
    record.next = approvedBy('ann@landflow.test', { nodeId: 'some_other_node' });
    const other = await applyDecision(b.id, b.executionId, 'approved', { steps: [STEP] });
    expect(other.status).toBe('failed');
    expect(w.requestRow(b.id)!.note).toMatch(/node|step/);
    expect(teamHas(b.login)).toBe(false);
  });

  it('the real flow: an editor who changes the question in the installed flow gets no grant', async () => {
    const original = store.getWorkflow(installed())!;
    const edited = { ...original, nodes: original.nodes.map((node) => (node.type === 'core.confirmDraft' ? { ...node, parameters: { ...node.parameters, title: 'Approve the weekly report?' } } : node)) };
    store.saveWorkflow(edited, { actor: lead.id });
    await publishDraft(installed(), owner.id);
    resetAccessTrigger();
    try {
      const request = await createRequest(mia, { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'weekly-gh' });
      const decided = await decideAccessRequest(ann, request.id, { approved: true });
      expect(decided.status).toBe('failed');
      expect(decided.note).toMatch(/question/);
      expect(teamHas('weekly-gh')).toBe(false);
    } finally {
      store.saveWorkflow(original, { actor: owner.id });
      await publishDraft(installed(), owner.id);
      resetAccessTrigger();
    }
  });
});

describe('3. only instance admins change the installed flows', () => {
  it('refuses a non-admin save, publish, unpublish and delete of either flow, and allows an admin', async () => {
    const ids = [installed(), accessSettings().chatWorkflowId].filter(Boolean) as string[];
    expect(ids.length).toBeGreaterThanOrEqual(1);
    for (const id of ids) {
      const existing = store.getWorkflow(id)!;
      expect(() => governedSave({ ...existing, name: 'Mine now' }, existing, (x) => store.saveWorkflow(x), { by: lead.id })).toThrowError(/only an instance admin/i);
      await expect(publishOrRequest({ workflowId: id, action: 'unpublish', by: lead.id })).rejects.toMatchObject({ status: 403 });
      await expect(publishOrRequest({ workflowId: id, action: 'publish', by: lead.id })).rejects.toMatchObject({ status: 403 });
      expect(store.getWorkflow(id)!.name).toBe(existing.name);
      const route = await import('@/app/api/workflows/[id]/route');
      w.as(lead);
      const response = await route.DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(403);
      expect(store.getWorkflow(id)).toBeDefined();
      // An admin may (the same content: nothing changes).
      expect(() => governedSave(existing, existing, (x) => store.saveWorkflow(x), { by: admin.id })).not.toThrow();
    }
  });

  it('says so in the setup data', () => {
    expect(accessSetup()).toMatchObject({ flowsAdminOnly: true, lockedWorkflowIds: expect.arrayContaining([installed()]) });
  });
});

describe('4. the hourly pass writes only what it changes', () => {
  it('a stale read of a grant never overwrites what changed since', async () => {
    const a = await pending();
    record.next = approvedBy();
    await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
    const stale = { ...grantOfRequest(a.id)! };
    // Revoked after the pass read it.
    await revokeNow(admin, stale.id);
    expect(grantRow(stale.id)!.status).toBe('revoked');
    const real = database().all.bind(database());
    const spy = vi.spyOn(database(), 'all').mockImplementation(((sql: string, ...params: unknown[]) => (/overdue_noted = 0/.test(sql) ? [{ ...stale, until: new Date(Date.now() - 3 * 86_400_000).toISOString(), status: 'active', overdue_noted: 0 }] : real(sql, ...params))) as never);
    try {
      await reconcileGrants(Date.now());
    } finally {
      spy.mockRestore();
    }
    expect(grantRow(stale.id)).toMatchObject({ status: 'revoked', overdue_noted: 0 });
  });
});

describe('5. GitHub refuses a raise, and the flow shows why', () => {
  it('a member asked to be a maintainer is a failed grant with the reason, and nothing changes at GitHub', async () => {
    fake.seedTeam('acme', 'infra', { 'raise-gh': 'member' });
    const maintainer = createEntry(admin, { name: 'Infra maintainer', system: 'github-team', target: { org: 'acme', team: 'infra', role: 'maintainer' }, credentialId: w.github.id, durations: [60], approverIds: [ann.id], owners: [lead.id] });
    const request = await createRequest(mia, { entryId: maintainer.id, durationMinutes: 60, reason: 'Run the infra team', account: 'raise-gh' });
    record.next = undefined;
    const decided = await decideAccessRequest(ann, request.id, { approved: true });
    expect(decided.grant).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/already .*role member, not maintainer/) });
    expect(fake.members('teams', 'acme/infra')).toEqual({ 'raise-gh': 'member' });
  });
});

describe('6. accounts and the target', () => {
  it('a GitHub username belongs to one person, whatever its case', async () => {
    setGithubAccount(ola, 'Shared-Login');
    expect(() => setGithubAccount(mia, 'shared-login')).toThrowError(/already linked to someone else/i);
    const index = database().get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'access_accounts_handle'`);
    expect(index).toBeDefined();
  });

  it('labels the username unverified for the approver', async () => {
    const a = await pending();
    const view = getRequest(ann, a.id);
    expect(view).toMatchObject({ account: a.login, accountVerified: false });
  });

  it('allows one live grant for a target and account across entries', async () => {
    const other = createEntry(admin, { name: 'Platform team (again)', system: 'github-team', target: { org: 'acme', team: 'platform' }, credentialId: w.github.id, durations: [60], approverIds: [ann.id], owners: [lead.id] });
    const first = await pending(team.id, mia, 60, 'dup-gh');
    const second = await createRequest(mia, { entryId: other.id, durationMinutes: 60, reason: 'Fixing the build too', account: 'dup-gh' });
    record.next = approvedBy();
    await applyDecision(first.id, first.executionId, 'approved', { steps: [STEP] });
    expect(grantOfRequest(first.id)!.status).toBe('active');
    // The second was filed before the first was granted: it is refused when it would be granted.
    const done = await applyDecision(second.id, second.executionId!, 'approved', { steps: [STEP] });
    expect(done.status).toBe('failed');
    expect(w.requestRow(second.id)!.note).toMatch(/already has this access/i);
    // And a new request for it is refused up front.
    await expect(createRequest(mia, { entryId: other.id, durationMinutes: 60, reason: 'Once more', account: 'dup-gh' })).rejects.toMatchObject({ status: 409 });
    await revokeNow(admin, grantOfRequest(first.id)!.id);
  });
});

describe('7. a drifted grant still ends at its end', () => {
  it('is checked at its end: removed if the person is back, otherwise just ended', async () => {
    const make = async (login: string) => {
      const a = await pending(team.id, mia, 15, login);
      record.next = approvedBy();
      await applyDecision(a.id, a.executionId, 'approved', { steps: [STEP] });
      const grant = grantOfRequest(a.id)!;
      fake.teams.get('acme/platform')!.delete(login.toLowerCase());
      expect((await reconcileGrants(Date.now() + 2 * 60 * MIN)) as unknown).toMatchObject({ drift: 1 });
      expect(grantRow(grant.id)!.status).toBe('drift');
      return grant;
    };
    const gone = await make('drift-a');
    await sweepGrants(Date.parse(gone.until!) + 1000);
    expect(grantRow(gone.id)).toMatchObject({ status: 'expired', end_reason: 'expired' });

    const back = await make('drift-b');
    fake.teams.get('acme/platform')!.set('drift-b', 'member');
    await sweepGrants(Date.parse(back.until!) + 1000);
    expect(grantRow(back.id)!.status).toBe('expired');
    expect(teamHas('drift-b')).toBe(false);
  });
});

describe('8. indexes', () => {
  it('one pending request per person and entry, enforced by the table', async () => {
    const a = await pending();
    const row = w.requestRow(a.id)!;
    await expect(Promise.resolve().then(() => database().insertNew('access_requests', { ...row, id: 'areq_dup', execution_id: 'exec_dup' } as never))).rejects.toThrow();
    const names = database().all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['access_requests_open', 'access_requests_execution', 'access_grants_entry']));
    await cancelRequest(admin, a.id);
  });
});

describe('10. widening durations is for admins', () => {
  it('an owner may shorten and remove, not add unlimited or a longer one', () => {
    const e = createEntry(admin, { name: 'Widen test', system: 'manual', target: { instructions: 'By hand' }, durations: [60, 15], approverIds: [ann.id], owners: [lead.id] });
    expect(updateEntry(lead, e.id, { durations: [15] }, e.version).durations).toEqual([15]);
    const v = (id: string) => store && database().get<{ version: number }>('SELECT version FROM access_entries WHERE id = ?', id)!.version;
    expect(() => updateEntry(lead, e.id, { durations: [15, null] }, v(e.id))).toThrowError(/admin/i);
    expect(() => updateEntry(lead, e.id, { durations: [15, 1_440] }, v(e.id))).toThrowError(/admin/i);
    expect(updateEntry(lead, e.id, { durations: [15, 5] }, v(e.id)).durations).toEqual([15, 5]);
    expect(updateEntry(admin, e.id, { durations: [15, 5, null] }, v(e.id)).durations).toEqual([15, 5, null]);
  });
});

describe('11. the approvers stored at filing are the ones that count', () => {
  it('a fallback admin decides; an admin who appeared later does not', async () => {
    const lone = createUser as unknown as (input: Record<string, unknown>) => Promise<{ id: string; email: string }>;
    const solo = createEntry(admin, { name: 'Fallback test', system: 'github-team', target: { org: 'acme', team: 'platform' }, credentialId: w.github.id, durations: [60], approverIds: [ola.id], owners: [lead.id] });
    setUserDisabled(ola.id, true);
    try {
      const request = await createRequest(mia, { entryId: solo.id, durationMinutes: 60, reason: 'Fixing the build', account: 'fb-gh' });
      const stored = JSON.parse(w.requestRow(request.id)!.approvers) as string[];
      expect(stored).toEqual(expect.arrayContaining([admin.id, owner.id]));
      const late = await lone({ email: 'late-admin@landflow.test', name: 'Late Admin', role: 'admin' });
      record.next = approvedBy(late.email);
      const refused = await applyDecision(request.id, request.executionId!, 'approved', { steps: [STEP] });
      expect(refused.status).toBe('failed');
      expect(teamHas('fb-gh')).toBe(false);
      const again = await createRequest(mia, { entryId: solo.id, durationMinutes: 60, reason: 'Fixing the build', account: 'fb-gh' });
      record.next = approvedBy('admin@landflow.test');
      expect((await applyDecision(again.id, again.executionId!, 'approved', { steps: [STEP] })).status).toBe('approved');
      await revokeNow(admin, grantOfRequest(again.id)!.id);
    } finally {
      setUserDisabled(ola.id, false);
    }
  });
});

void installAccessRequests;
void audited;
