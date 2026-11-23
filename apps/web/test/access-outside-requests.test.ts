/**
 * C36-B (docs/access-requests.md#outside-requesters-what-they-can-ask-and-see): the C35 library works for a requester with no Landflow account, and
 * the public request routes they use. C36-A's identity, session, settings and limit modules are stood in for by mocks (an outside
 * requester is an `ext_…` id in a map; the requester session is a header), so what is tried here is this package's own: who sees what, the
 * question the approver reads, self-approval by email, the account rules, the mails, cancel and give back, and Block.
 * Everything else about a Landflow user's own flow is C35's tests, unchanged.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOutsider {
  id: string;
  email: string;
  name: string | null;
  verifiedBy: 'link' | 'google';
  blocked: boolean;
}
const h = vi.hoisted(() => ({
  outsiders: new Map<string, FakeOutsider>(),
  settings: { enabled: true, domains: ['partner.test'], google: { enabled: false } as { enabled: boolean; credentialId?: string } },
  record: { next: undefined as undefined | ((executionId: string, names: string[]) => unknown) },
}));
vi.mock('@/lib/server/access/outside/identity', () => ({
  getOutsideRequester: (id: string) => h.outsiders.get(id),
  outsideRequesterByEmail: (email: string) => [...h.outsiders.values()].find((r) => r.email === email.toLowerCase()),
}));
vi.mock('@/lib/server/access/outside/sessions', () => ({
  // The requester session is the `x-requester` header here; a blocked requester has none.
  requesterFromRequest: async (req: Request) => {
    const found = h.outsiders.get(req.headers.get('x-requester') ?? '');
    return found && !found.blocked ? found : null;
  },
  endSessionsFor: () => undefined,
}));
vi.mock('@/lib/server/access/outside/settings', () => ({
  outsideSettings: () => h.settings,
  domainAllowed: (email: string) => h.settings.domains.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase()),
}));
vi.mock('@/lib/server/access/decision', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/access/decision')>('@/lib/server/access/decision');
  return { ...actual, recordedDecisions: (executionId: string, names: string[]) => (h.record.next ? h.record.next(executionId, names) : actual.recordedDecisions(executionId, names)) };
});

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-outside-requests-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { makeWorld } = await import('./fixtures/access-world');
const { queryEvents } = await import('@/lib/server/audit/store');
const { database } = await import('@/lib/server/db');
const { AccessError } = await import('@/lib/server/access/errors');
const { updateEntry, listOpenToOutside } = await import('@/lib/server/access/catalog');
const { approversFor } = await import('@/lib/server/access/rules');
const { requesterOf, requesterOfOutside, emailKey, auditActorOfRequester } = await import('@/lib/server/access/principal');
const { applyDecision, giveBack, listGrants, listOwnGrants, revokeNow } = await import('@/lib/server/access/grants');
const { cancelOpenRequestsOf, cancelRequest, createRequest, decideAccessRequest, fileOutsideRequest, listOwnRequests, listRequests, setGithubAccount } = await import('@/lib/server/access/requests');
const { accessSettings, accountOf, grantOfRequest, saveAccount } = await import('@/lib/server/access/store');
const entriesRoute = await import('@/app/request-access/api/entries/route');
const requestsRoute = await import('@/app/request-access/api/requests/route');
const cancelRoute = await import('@/app/request-access/api/requests/[id]/cancel/route');
const grantsRoute = await import('@/app/request-access/api/grants/route');
const giveBackRoute = await import('@/app/request-access/api/grants/[id]/give-back/route');
const accountRoute = await import('@/app/request-access/api/account/route');
const entryRoute = await import('@/app/api/access/entries/[id]/route');

const w = await makeWorld();
const { mia, ola, ann, lead, admin, owner, second, team, group, manual, fake, mails } = w;
w.captureMail();
const STEP = 'Ask the approver';
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 100 }).events;

const outsider = (key: string, email: string, verifiedBy: 'link' | 'google' = 'link', name: string | null = null): FakeOutsider => {
  const record = { id: `ext_${key}`, email, name, verifiedBy, blocked: false };
  h.outsiders.set(record.id, record);
  return record;
};
const erin = outsider('erin', 'erin@partner.test');
const dana = outsider('dana', 'dana@partner.test', 'google', 'Dana Example');
const asRequester = (who: FakeOutsider) => requesterOfOutside(who);

const url = 'http://landflow.test/request-access/api';
const send = (who: FakeOutsider | undefined, method: string, data?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json', ...(who && { 'x-requester': who.id }) }, ...(data !== undefined && { body: JSON.stringify(data) }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const call = async (fn: () => Promise<Response>) => {
  const response = await fn();
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
};
// The group offers only "unlimited"; the team an hour and shorter.
const askBody = (entryId: string, extra: Record<string, unknown> = {}) => ({ entryId, durationMinutes: entryId === group.id ? null : 60, reason: 'Fixing the build', account: 'erin-gh', ...extra });
const ask = (who: FakeOutsider, entryId: string, extra: Record<string, unknown> = {}) => call(() => requestsRoute.POST(new Request(`${url}/requests`, send(who, 'POST', askBody(entryId, extra)))));

const says = (partial: Record<string, unknown> | undefined) => (executionId: string): unknown => {
  const question = JSON.parse(database().get<{ question: string }>('SELECT question FROM access_requests WHERE execution_id = ?', executionId)!.question) as { title: string; text: string; nodes: string[] };
  return { workflowId: accessSettings().workflowId, steps: partial === undefined ? [undefined] : [{ name: STEP, nodeId: question.nodes[0], title: question.title, originalText: question.text, ...partial }] };
};
const apply = (requestId: string, outcome: 'approved' | 'rejected' = 'approved') => applyDecision(requestId, w.requestRow(requestId)!.execution_id!, outcome, { steps: [STEP] });
const refused = async (fn: () => unknown, status: number, text?: RegExp) => {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AccessError);
    expect((error as InstanceType<typeof AccessError>).status).toBe(status);
    if (text) expect((error as Error).message).toMatch(text);
    return;
  }
  throw new Error(`expected ${status}`);
};
const count = (sql: string, ...params: unknown[]) => database().get<{ n: number }>(sql, ...(params as never[]))!.n;

// Open two of the three entries to outside requesters, as an admin does; "Figma editor" (manual) stays closed.
for (const entry of [team, group]) updateEntry(admin, entry.id, { outsideMayAsk: true }, entry.version);

const OUTSIDE_REQUEST_KEYS = ['id', 'entryId', 'entryName', 'system', 'targetLabel', 'state', 'status', 'durationMinutes', 'approvedMinutes', 'reason', 'channel', 'account', 'note', 'grant', 'canCancel', 'createdAt', 'updatedAt'];
const OUTSIDE_GRANT_KEYS = ['id', 'requestId', 'entryId', 'entryName', 'account', 'system', 'targetLabel', 'status', 'since', 'until', 'endedAt', 'endReason', 'canGiveBack'];
const NEVER = ['approverNames', 'approvedBy', 'decisions', 'executionId', 'question', 'choices', 'canDecide', 'requester', 'holder', 'owners', 'steps', 'credentialId', 'eligibleUserIds', 'lastError', 'alreadyHad', 'canRevoke', 'by', 'byName'];
/** Every key, at every depth, is on the allow-list or the response fails. */
function onlyAllowed(value: unknown, allowed: string[], grantKeys = OUTSIDE_GRANT_KEYS): void {
  const view = value as Record<string, unknown>;
  for (const key of Object.keys(view)) {
    expect(allowed, `unexpected key ${key}`).toContain(key);
    expect(NEVER, `forbidden key ${key}`).not.toContain(key);
  }
  if (view.grant) onlyAllowed(view.grant, grantKeys, grantKeys);
}
const noApproverNames = (text: string) => {
  for (const name of ['Ann Approver', 'ann@landflow.test', 'Ada Admin', 'admin@landflow.test', 'Olive Owner', 'owner@landflow.test', 'Lee Lead']) expect(text, name).not.toContain(name);
};

beforeEach(async () => {
  // The per-person caps on filing and on the GitHub name count across a test file: each test starts them over.
  (await import('@/lib/server/access/outside/limits')).resetOutsideLimits();
  h.record.next = undefined;
  h.settings.enabled = true;
  h.settings.domains = ['partner.test'];
  mails.length = 0;
});

describe('what an outside requester may see', () => {
  it('lists only the entries an admin opened, with the allow-listed fields', async () => {
    const answer = await call(() => entriesRoute.GET(new Request(`${url}/entries`, send(erin, 'GET'))));
    expect(answer.status).toBe(200);
    expect(answer.body.items.map((e: { name: string }) => e.name).sort()).toEqual(['Engineering group', 'Platform team']);
    for (const item of answer.body.items) expect(Object.keys(item).sort()).toEqual(['description', 'durations', 'id', 'name', 'needsGithub', 'system', 'targetLabel'].filter((key) => key in item).sort());
    const platform = answer.body.items.find((e: { name: string }) => e.name === 'Platform team');
    expect(platform).toMatchObject({ system: 'github-team', needsGithub: true, durations: [60, 15, 1, null] });
    noApproverNames(answer.text);
    for (const secret of ['credentialId', 'approverNames', 'owners', 'eligibleUserIds', 'steps', w.github.id, lead.id, ann.id]) expect(answer.text).not.toContain(secret);
  });

  it('answers 401 without the requester session, and the closed entry is not even listed', async () => {
    expect((await call(() => entriesRoute.GET(new Request(`${url}/entries`, send(undefined, 'GET'))))).status).toBe(401);
    expect(listOpenToOutside().some((e) => e.id === manual.id)).toBe(false);
    updateEntry(admin, team.id, { enabled: false }, (database().get<{ version: number }>('SELECT version FROM access_entries WHERE id = ?', team.id)!).version);
    expect(listOpenToOutside().some((e) => e.id === team.id)).toBe(false);
    updateEntry(admin, team.id, { enabled: true }, (database().get<{ version: number }>('SELECT version FROM access_entries WHERE id = ?', team.id)!).version);
  });

  it('refuses a closed entry (404) and stores nothing', async () => {
    const before = count('SELECT COUNT(*) AS n FROM access_requests');
    expect((await ask(erin, manual.id, { account: undefined })).status).toBe(404);
    expect((await ask(erin, 'ae_missing')).status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM access_requests')).toBe(before);
  });

  it('keeps an outsider’s own request and grant to the allow-list: no approver names, execution ids or decisions’ `by`', async () => {
    const made = await ask(erin, team.id);
    expect(made.status).toBe(201);
    onlyAllowed(made.body, OUTSIDE_REQUEST_KEYS);
    h.record.next = says({ approved: true, by: 'ann@landflow.test', comment: 'ok' });
    await apply(made.body.id);
    const list = await call(() => requestsRoute.GET(new Request(`${url}/requests`, send(erin, 'GET'))));
    expect(list.body.items).toHaveLength(1);
    onlyAllowed(list.body.items[0], OUTSIDE_REQUEST_KEYS);
    expect(list.body.items[0]).toMatchObject({ state: 'granted', approvedMinutes: 60, grant: { status: 'active', account: 'erin-gh' } });
    noApproverNames(list.text);
    expect(list.text).not.toContain(w.requestRow(made.body.id)!.execution_id!);
    const grants = await call(() => grantsRoute.GET(new Request(`${url}/grants`, send(erin, 'GET'))));
    expect(grants.body.items).toHaveLength(1);
    onlyAllowed(grants.body.items[0], OUTSIDE_GRANT_KEYS);
    noApproverNames(grants.text);
    await giveBack(asRequester(erin), grants.body.items[0].id);
  });

  it('shows nothing of someone else’s requests or grants, and a 404 for acting on them', async () => {
    const mine = await ask(erin, team.id);
    h.record.next = says({ approved: true, by: 'ann@landflow.test' });
    await apply(mine.body.id);
    const grantId = grantOfRequest(mine.body.id)!.id;
    const theirs = await ask(dana, group.id, { account: undefined });
    expect((await call(() => requestsRoute.GET(new Request(`${url}/requests`, send(dana, 'GET'))))).body.items.map((r: { id: string }) => r.id)).toEqual([theirs.body.id]);
    expect((await call(() => grantsRoute.GET(new Request(`${url}/grants`, send(dana, 'GET'))))).body.items).toEqual([]);
    expect((await call(() => cancelRoute.POST(new Request(`${url}/requests/${mine.body.id}/cancel`, send(dana, 'POST')), ctx(mine.body.id)))).status).toBe(404);
    expect((await call(() => giveBackRoute.POST(new Request(`${url}/grants/${grantId}/give-back`, send(dana, 'POST')), ctx(grantId)))).status).toBe(404);
    expect(grantOfRequest(mine.body.id)!.status).toBe('active');
    expect((await call(() => cancelRoute.POST(new Request(`${url}/requests/${theirs.body.id}/cancel`, send(dana, 'POST')), ctx(theirs.body.id)))).status).toBe(200);
    await giveBack(asRequester(erin), grantId);
  });
});

describe('the question the approver reads', () => {
  it('says outside requester, the verified address and how it was verified', async () => {
    const byLink = await ask(erin, team.id);
    const byGoogle = await ask(dana, team.id, { account: 'dana-gh' });
    const question = (id: string) => JSON.parse(w.requestRow(id)!.question!) as { title: string; text: string };
    expect(question(byLink.body.id).title).toBe('Give erin@partner.test (outside) Platform team for 1 h?');
    expect(question(byLink.body.id).text).toContain('Who: outside requester erin@partner.test (email verified by link)');
    expect(question(byLink.body.id).text).toContain('Account: erin-gh (unverified: typed by the requester)');
    expect(question(byGoogle.body.id).text).toContain('Who: outside requester dana@partner.test (email verified by Google sign-in)');
    // A name the outsider chose (Google's profile) never stands in for the address.
    expect(question(byGoogle.body.id).title).not.toContain('Dana Example');
    expect(w.requestRow(byLink.body.id)).toMatchObject({ requester_kind: 'outside', requester_id: erin.id });
    await cancelRequest(admin, byLink.body.id);
    await cancelRequest(admin, byGoogle.body.id);
  });

  it('is what the approver sees on the Access page, with the requester’s email and how it was verified', async () => {
    const made = await ask(erin, team.id);
    const seen = listRequests(ann, { scope: 'decide', limit: 50 }).items.find((r) => r.id === made.body.id)!;
    expect(seen.requester).toEqual({ id: erin.id, name: 'erin@partner.test', kind: 'outside', email: 'erin@partner.test', verifiedBy: 'link' });
    expect(seen).toMatchObject({ canDecide: true, question: { title: expect.stringContaining('(outside)'), text: expect.stringContaining('Who: outside requester') } });
    const all = listRequests(admin, { scope: 'all', limit: 50 }).items.find((r) => r.id === made.body.id)!;
    expect(all.requester.kind).toBe('outside');
    await cancelRequest(admin, made.body.id);
  });

  it('leaves a Landflow user’s own question and view as they were', async () => {
    const request = await createRequest(mia, { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'mia-gh' });
    expect(request.requester).toEqual({ id: mia.id, name: 'Mia Member', kind: 'user' });
    const question = JSON.parse(w.requestRow(request.id)!.question!) as { title: string; text: string };
    expect(question.title).toBe('Give Mia Member Platform team for 1 h?');
    expect(question.text).not.toContain('Who:');
    expect(w.requestRow(request.id)!.requester_kind).toBe('user');
    await cancelRequest(mia, request.id);
  });
});

describe('who may approve: not the requester, not their email', () => {
  it('drops every approver whose email key is the requester’s, and falls back to the other admins', () => {
    expect(emailKey('Bob+ci@Acme.TEST')).toBe('bob@acme.test');
    const sameAddress = outsider('sameann', 'Ann@Landflow.test');
    const entry = { steps: [{ name: 'Approval', approvers: { userIds: [ann.id] }, approvalsRequired: 1 as const }] };
    expect(approversFor(entry, mia.id)).toEqual([ann.id]);
    // Ann's address is the requester's: she is dropped, so the fallback is the active instance admins.
    const fallback = approversFor(entry, sameAddress.id);
    expect(fallback).not.toContain(ann.id);
    expect(fallback.sort()).toEqual([owner.id, admin.id, second.id].sort());
    h.outsiders.delete(sameAddress.id);
  });

  it('refuses to file when the address is a Landflow user’s (no second identity for one email)', async () => {
    const clash = outsider('clash', 'mia@landflow.test');
    h.settings.domains = ['partner.test', 'landflow.test'];
    await refused(() => fileOutsideRequest(requesterOfOutside(clash), { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'clash-gh' }), 401, /Sign in again/);
    h.outsiders.delete(clash.id);
  });

  it('grants nothing when the decider’s email is the requester’s (decision time), and the page refuses them too', async () => {
    const made = await ask(erin, team.id);
    // The address becomes Ann's (an alias, a reassigned mailbox): her answer on this request must grant nothing.
    erin.email = 'Ann@landflow.test';
    await refused(() => decideAccessRequest(ann, made.body.id, { approved: true }), 403, /your own request/);
    h.record.next = says({ approved: true, by: 'ann@landflow.test' });
    const before = JSON.stringify(fake.members('teams', 'acme/platform'));
    const done = await apply(made.body.id);
    expect(done).toMatchObject({ status: 'failed' });
    expect(w.requestRow(made.body.id)).toMatchObject({ status: 'failed', note: expect.stringMatching(/own request, so nothing was granted/) });
    expect(JSON.stringify(fake.members('teams', 'acme/platform'))).toBe(before);
    expect(grantOfRequest(made.body.id)).toBeUndefined();
    erin.email = 'erin@partner.test';
    // The outsider is told a fixed sentence (page and mail), never the internal reason; the row and the approver's view keep it.
    const mine = await call(() => requestsRoute.GET(new Request(`${url}/requests`, send(erin, 'GET'))));
    expect(mine.body.items.find((r: { id: string }) => r.id === made.body.id)).toMatchObject({ state: 'failed', note: 'Nothing was granted; an admin has the details.' });
    await vi.waitFor(() => expect(mails.find((m) => /could not be granted/i.test(m.subject))).toBeDefined());
    const failedMail = mails.find((m) => /could not be granted/i.test(m.subject))!.text;
    expect(failedMail).toContain('Nothing was granted; an admin has the details.');
    expect(failedMail).not.toMatch(/own request|approve/i);
  });

  it('a different approver still grants (the check is the email, not the kind)', async () => {
    const made = await ask(erin, team.id);
    h.record.next = says({ approved: true, by: 'ann@landflow.test' });
    expect(await apply(made.body.id)).toMatchObject({ status: 'approved', grantId: expect.any(String) });
    expect(fake.members('teams', 'acme/platform')).toHaveProperty('erin-gh');
    await giveBack(asRequester(erin), grantOfRequest(made.body.id)!.id);
    expect(fake.members('teams', 'acme/platform')).not.toHaveProperty('erin-gh');
  });
});

const erin2 = () => requesterOfOutside(erin);

describe('the account a grant goes to', () => {
  it('Google access goes to the verified email whatever the body says', async () => {
    const made = await ask(erin, group.id, { durationMinutes: null, account: 'someone-else@elsewhere.test' });
    expect(made.status).toBe(201);
    expect(w.requestRow(made.body.id)!.account).toBe('erin@partner.test');
    h.record.next = says({ approved: true, by: 'ann@landflow.test' });
    await apply(made.body.id);
    expect(fake.members('groups', 'eng@example.com')).toHaveProperty('erin@partner.test');
    expect(fake.members('groups', 'eng@example.com')).not.toHaveProperty('someone-else@elsewhere.test');
    const view = await call(() => requestsRoute.GET(new Request(`${url}/requests`, send(erin, 'GET'))));
    expect(view.body.items.find((r: { id: string }) => r.id === made.body.id)).toMatchObject({ account: 'erin@partner.test', grant: { account: 'erin@partner.test' } });
    await giveBack(asRequester(erin), grantOfRequest(made.body.id)!.id);
    expect(fake.members('groups', 'eng@example.com')).not.toHaveProperty('erin@partner.test');
  });

  it('a GitHub username is one person’s, across users and outside requesters, whatever its case', async () => {
    setGithubAccount(mia, 'Mia-Taken');
    const before = count('SELECT COUNT(*) AS n FROM access_requests WHERE requester_id = ?', erin.id);
    const clash = await ask(erin, team.id, { account: 'mia-taken' });
    expect(clash.status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM access_requests WHERE requester_id = ?', erin.id)).toBe(before);
    const put = await call(() => accountRoute.PUT(new Request(`${url}/account`, send(erin, 'PUT', { github: 'MIA-TAKEN' }))));
    expect(put.status).toBe(409);
    const own = await call(() => accountRoute.PUT(new Request(`${url}/account`, send(erin, 'PUT', { github: 'erin-own' }))));
    expect(own).toMatchObject({ status: 200, body: { github: 'erin-own', google: 'erin@partner.test' } });
    expect((await call(() => accountRoute.GET(new Request(`${url}/account`, send(erin, 'GET'))))).body).toEqual({ github: 'erin-own', google: 'erin@partner.test' });
    // …and the other way: a Landflow user may take a name only an outsider typed (never verified): the outsider's copy is cleared and the audit row says so.
    expect(() => setGithubAccount(erin2(), 'mia-taken')).toThrow(/already linked to someone else/);
    setGithubAccount(ola, 'erin-own');
    expect(accountOf(ola.id, 'github')).toBe('erin-own');
    expect(accountOf(erin.id, 'github')).toBeUndefined();
    expect(audited('access.account.set').some((e) => (e.details as { displacedOutsideRequester?: string }).displacedOutsideRequester === erin.id)).toBe(true);
    database().delete('access_accounts', { user_id: ola.id, system: 'github' });
    expect(audited('access.account.set').some((e) => e.actor.id === erin.id && (e.details as { requesterKind?: string }).requesterKind === 'outside')).toBe(true);
    database().delete('access_accounts', { user_id: erin.id, system: 'github' });
    database().delete('access_accounts', { user_id: mia.id, system: 'github' });
    void saveAccount;
  });
});

describe('limits on filing and on the saved GitHub name', () => {
  it('answers 429 in plain words after 10 requests an hour and after 5 changes of the GitHub username a day, per person', async () => {
    const gil = outsider('gil', 'gil@partner.test');
    const other = outsider('hal', 'hal@partner.test');
    const statuses: number[] = [];
    // A request already open for the entry answers 409 (and counts), so the cap is read from the 11th answer.
    for (let i = 0; i < 11; i++) statuses.push((await ask(gil, team.id, { account: 'gil-gh' })).status);
    expect(statuses.slice(0, 10)).not.toContain(429);
    const limited = await ask(gil, team.id, { account: 'gil-gh' });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/asked a lot/);
    expect((await ask(other, team.id, { account: 'hal-gh' })).status).not.toBe(429);
    const puts: number[] = [];
    for (let i = 0; i < 6; i++) puts.push((await call(() => accountRoute.PUT(new Request(`${url}/account`, send(gil, 'PUT', { github: `gil-name-${i}` }))))).status);
    expect(puts.slice(0, 5)).not.toContain(429);
    expect(puts[5]).toBe(429);
  });
});

describe('the emails to an outside requester', () => {
  it('go to the verified address with the public link, never a token or an approver’s name', async () => {
    const made = await ask(erin, team.id);
    h.record.next = says({ approved: true, by: 'ann@landflow.test', comment: 'fine' });
    await apply(made.body.id);
    await vi.waitFor(() => expect(mails.filter((m) => m.to === 'erin@partner.test' && /granted/i.test(m.subject))).toHaveLength(1));
    const granted = mails.find((m) => m.to === 'erin@partner.test')!;
    expect(granted.text).toContain('http://landflow.test/request-access');
    expect(granted.text).not.toContain('/access\n');
    noApproverNames(granted.text);
    expect(granted.text).not.toMatch(/#t=|token/i);
    mails.length = 0;
    await giveBack(asRequester(erin), grantOfRequest(made.body.id)!.id);
    await vi.waitFor(() => expect(mails.find((m) => /ended/i.test(m.subject))).toMatchObject({ to: 'erin@partner.test' }));
  });

  it('say why a request was denied (the approver’s comment), and a Landflow user’s still link to /access', async () => {
    const made = await ask(erin, team.id);
    h.record.next = says({ approved: false, by: 'ann@landflow.test', comment: 'Not this quarter' });
    await apply(made.body.id, 'rejected');
    const view = await call(() => requestsRoute.GET(new Request(`${url}/requests`, send(erin, 'GET'))));
    expect(view.body.items.find((r: { id: string }) => r.id === made.body.id)).toMatchObject({ state: 'denied', status: 'denied', note: 'Not this quarter' });
    await vi.waitFor(() => expect(mails.find((m) => m.to === 'erin@partner.test' && /denied/i.test(m.subject))).toMatchObject({ text: expect.stringContaining('Reason: Not this quarter') }));
    expect(mails.find((m) => /denied/i.test(m.subject))!.text).toContain('/request-access');

    mails.length = 0;
    const userRequest = await createRequest(mia, { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'mia-gh' });
    h.record.next = says({ approved: false, by: 'ann@landflow.test', comment: 'No' });
    await apply(userRequest.id, 'rejected');
    await vi.waitFor(() => expect(mails.find((m) => m.to === 'mia@landflow.test')).toBeDefined());
    expect(mails.find((m) => m.to === 'mia@landflow.test')!.text).toMatch(/landflow\.test\/access\n$/);
  });
});

describe('cancel, give back and what the log says', () => {
  it('lets the requester withdraw their own waiting request and give back their own grant, audited as them', async () => {
    const made = await ask(erin, team.id);
    const cancelled = await call(() => cancelRoute.POST(new Request(`${url}/requests/${made.body.id}/cancel`, send(erin, 'POST')), ctx(made.body.id)));
    expect(cancelled).toMatchObject({ status: 200, body: { status: 'cancelled', state: 'cancelled', canCancel: false } });
    expect((await call(() => cancelRoute.POST(new Request(`${url}/requests/${made.body.id}/cancel`, send(erin, 'POST')), ctx(made.body.id)))).status).toBe(409);
    const event = audited('access.request.cancel').find((e) => e.target?.id === made.body.id)!;
    expect(event.actor).toMatchObject({ id: erin.id, email: 'erin@partner.test' });
    expect(event.details).toMatchObject({ requesterKind: 'outside' });

    const again = await ask(erin, team.id);
    h.record.next = says({ approved: true, by: 'ann@landflow.test' });
    await apply(again.body.id);
    const grantId = grantOfRequest(again.body.id)!.id;
    const gave = await call(() => giveBackRoute.POST(new Request(`${url}/grants/${grantId}/give-back`, send(erin, 'POST')), ctx(grantId)));
    expect(gave.status).toBe(200);
    expect(gave.body).toMatchObject({ id: grantId, status: expect.stringMatching(/revoked|removing/), canGiveBack: false });
    onlyAllowed(gave.body, OUTSIDE_GRANT_KEYS);
    expect(fake.members('teams', 'acme/platform')).not.toHaveProperty('erin-gh');
    const revoked = audited('access.grant.revoke').find((e) => e.target?.id === grantId)!;
    expect(revoked.actor).toMatchObject({ id: erin.id, email: 'erin@partner.test' });
    expect(revoked.details).toMatchObject({ reason: 'given_back', holderKind: 'outside' });
    expect(w.requestRow(again.body.id)!.requester_kind).toBe('outside');
    expect(database().get<{ holder_kind: string }>('SELECT holder_kind FROM access_grants WHERE id = ?', grantId)!.holder_kind).toBe('outside');
    const create = audited('access.request.create').find((e) => e.target?.id === again.body.id)!;
    expect(create.actor).toMatchObject({ id: erin.id });
    expect(create.details).toMatchObject({ requesterKind: 'outside', verifiedBy: 'link' });
  });

  it('shows an admin an outsider’s grants too, with who they are', async () => {
    const made = await ask(dana, team.id, { account: 'dana-gh' });
    h.record.next = says({ approved: true, by: 'ann@landflow.test' });
    await apply(made.body.id);
    const seen = listGrants(admin, { scope: 'all' }).find((g) => g.requestId === made.body.id)!;
    expect(seen.holder).toEqual({ id: dana.id, name: 'Dana Example', kind: 'outside', email: 'dana@partner.test', verifiedBy: 'google' });
    expect(seen.canRevoke).toBe(true);
    await revokeNow(admin, seen.id);
    expect(grantOfRequest(made.body.id)!.status).toBe('revoked');
  });
});

describe('blocking an outside requester', () => {
  it('cancels what they are waiting on, audited, and leaves their grants alone', async () => {
    const waiting = await ask(erin, team.id);
    const grantedRequest = await ask(erin, group.id, { account: undefined });
    h.record.next = says({ approved: true, by: 'ann@landflow.test' });
    await apply(grantedRequest.body.id);
    const waitingExecution = w.requestRow(waiting.body.id)!.execution_id;
    expect(waitingExecution).toBeTruthy();

    const cancelled = await cancelOpenRequestsOf(erin.id, auditActorOfRequester(requesterOf(admin.id)!));
    expect(cancelled).toBe(1);
    expect(w.requestRow(waiting.body.id)!.status).toBe('cancelled');
    expect(grantOfRequest(grantedRequest.body.id)!.status).toBe('active');
    const event = audited('access.request.cancel').find((e) => e.target?.id === waiting.body.id)!;
    expect(event.actor).toMatchObject({ id: admin.id });
    expect(event.details).toMatchObject({ requesterKind: 'outside', reason: 'blocked' });
    // A second pass finds nothing left.
    expect(await cancelOpenRequestsOf(erin.id, 'system')).toBe(0);

    // Blocked, they stand no longer: they file nothing and the session helper has none for them.
    erin.blocked = true;
    await refused(() => fileOutsideRequest(asRequester(erin), { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'erin-gh' }), 401);
    expect((await ask(erin, team.id)).status).toBe(401);
    erin.blocked = false;
    await giveBack(asRequester(erin), grantOfRequest(grantedRequest.body.id)!.id);
  });

  it('also stops asking when the feature is switched off or the domain is removed', async () => {
    h.settings.enabled = false;
    await refused(() => fileOutsideRequest(asRequester(erin), { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'erin-gh' }), 401);
    h.settings.enabled = true;
    h.settings.domains = ['other.test'];
    await refused(() => fileOutsideRequest(asRequester(erin), { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'erin-gh' }), 401);
  });
});

describe('opening an entry to outside requesters', () => {
  const version = (id: string) => database().get<{ version: number }>('SELECT version FROM access_entries WHERE id = ?', id)!.version;
  const patch = async (user: typeof admin, id: string, data: Record<string, unknown>) => {
    w.as(user);
    const response = await entryRoute.PATCH(new Request(`http://landflow.test/api/access/entries/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: version(id), ...data }) }), ctx(id));
    return { status: response.status, body: await response.json() };
  };

  it('is off by default and shown on the entry; only an instance admin turns it on or off', async () => {
    expect(listOpenToOutside().map((e) => e.name).sort()).toEqual(['Engineering group', 'Platform team']);
    const closed = await patch(lead, manual.id, { outsideMayAsk: true });
    expect(closed.status).toBe(403);
    expect(closed.body.error).toMatch(/instance admin/);
    expect(listOpenToOutside().some((e) => e.id === manual.id)).toBe(false);
    // The entry's owner changes other things as before; saying the flag is what it already is changes nothing.
    expect((await patch(lead, manual.id, { name: 'Figma editor', outsideMayAsk: false })).status).toBe(200);
    const opened = await patch(admin, manual.id, { outsideMayAsk: true });
    expect(opened).toMatchObject({ status: 200, body: { outsideMayAsk: true } });
    expect(audited('access.entry.update').some((e) => /"outside":true/.test(String((e.details as { to?: string }).to)) && /"outside":false/.test(String((e.details as { from?: string }).from)))).toBe(true);
    expect((await patch(admin, manual.id, { outsideMayAsk: false })).body.outsideMayAsk).toBe(false);
    // Members still see the flag on the entries they see; the catalog list says which are open.
    w.as(mia);
    expect((await (await import('@/app/api/access/entries/route')).GET()).status).toBe(200);
  });

  it('migration 2937: a C35 entry, request and grant read closed / user', () => {
    expect(database().get<{ outside: number }>('SELECT outside FROM access_entries WHERE id = ?', w.manual.id)!.outside).toBe(0);
    expect(database().all<{ requester_kind: string }>('SELECT DISTINCT requester_kind FROM access_requests').map((r) => r.requester_kind).sort()).toEqual(['outside', 'user']);
  });
});

describe('the library lists an outsider’s own rows only', () => {
  it('listOwnRequests and listOwnGrants are scoped to the requester', async () => {
    const made = await ask(dana, group.id, { account: undefined });
    expect(listOwnRequests(asRequester(dana)).every((r) => w.requestRow(r.id)!.requester_id === dana.id)).toBe(true);
    expect(listOwnRequests(asRequester(dana)).some((r) => r.id === made.body.id)).toBe(true);
    expect(listOwnRequests(asRequester(erin)).some((r) => r.id === made.body.id)).toBe(false);
    expect(listOwnGrants(asRequester(erin)).every((g) => database().get<{ holder_id: string }>('SELECT holder_id FROM access_grants WHERE id = ?', g.id)!.holder_id === erin.id)).toBe(true);
    await cancelRequest(admin, made.body.id);
  });
});
