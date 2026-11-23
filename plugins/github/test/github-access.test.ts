/** The GitHub Access node (team, organization, repository and project access) against the stateful fake GitHub. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { mcpToolsForNode } from '@landflow/protocol';
import { GitHubAccess } from '../src/nodes/github-access';
import { FakeGitHub, OWNER, REPO, TOKEN } from './fake-github';
import { ORG, PROJECT_NUMBER, TEAM } from './fake-github-access';
import { jsonOf, run, startFakeApi, type FakeApi } from './helpers';

const fake = new FakeGitHub();
const access = fake.access;
let api: FakeApi;
const creds = () => ({ githubApi: { accessToken: TOKEN, baseUrl: `${api.url}/api/v3` } });
const call = (parameters: JsonObject, options: { items?: JsonObject[]; continueOnFail?: boolean } = {}) => run(GitHubAccess, parameters, { credentials: creds(), ...options });
const team = (operation: string, extra: JsonObject = {}) => call({ resource: 'teamMembership', operation, org: ORG, teamSlug: TEAM, ...extra });
const org = (operation: string, extra: JsonObject = {}) => call({ resource: 'orgMembership', operation, org: ORG, ...extra });
const repo = (operation: string, extra: JsonObject = {}) => call({ resource: 'repoCollaborator', operation, owner: OWNER, repository: REPO, ...extra });
const project = (operation: string, extra: JsonObject = {}) => call({ resource: 'projectCollaborator', operation, org: ORG, projectNumber: PROJECT_NUMBER, ...extra });
const methods = () => api.requests.map((r) => `${r.method} ${r.path.replace('/api/v3', '')}`);
const only = async (response: ReturnType<typeof call>) => {
  const done = await response;
  expect(done.error).toBeUndefined();
  return jsonOf(done)[0];
};

beforeAll(async () => {
  api = await startFakeApi(fake.handle);
});
afterAll(() => api.close());
beforeEach(() => {
  fake.reset();
  api.requests.length = 0;
});

describe('Team membership', () => {
  it('adds an organization member as a member, then says it changed nothing the second time', async () => {
    expect(await only(team('add', { username: 'bob' }))).toEqual({ user: 'bob', target: `${ORG}/${TEAM}`, role: 'member', state: 'active', changed: true });
    expect(access.teams.get(TEAM)!.get('bob')).toEqual({ role: 'member', state: 'active' });
    api.requests.length = 0;
    expect(await only(team('add', { username: 'bob' }))).toEqual({ user: 'bob', target: `${ORG}/${TEAM}`, role: 'member', state: 'active', changed: false, alreadyHad: true });
    expect(methods()).toEqual([`GET /orgs/${ORG}/teams/${TEAM}/memberships/bob`]);
  });

  it('adds as a maintainer and changes the role of an existing member', async () => {
    await team('add', { username: 'bob' });
    expect(await only(team('add', { username: 'bob', teamRole: 'maintainer' }))).toMatchObject({ role: 'maintainer', changed: true });
    expect(access.teams.get(TEAM)!.get('bob')!.role).toBe('maintainer');
    expect(api.requests.at(-1)!.body).toEqual({ role: 'maintainer' });
  });

  it('reports pending for a user outside the organization', async () => {
    expect(await only(team('add', { username: 'dave' }))).toMatchObject({ user: 'dave', state: 'pending', role: 'member', changed: true });
    // A pending membership is already what was asked for.
    expect(await only(team('add', { username: 'dave' }))).toMatchObject({ state: 'pending', changed: false });
  });

  it('gets one membership: active with its role, pending, or none', async () => {
    expect(await only(team('get', { username: 'alice' }))).toEqual({ user: 'alice', target: `${ORG}/${TEAM}`, role: 'maintainer', state: 'active', changed: false });
    await team('add', { username: 'dave' });
    expect(await only(team('get', { username: 'dave' }))).toMatchObject({ state: 'pending', role: 'member' });
    expect(await only(team('get', { username: 'carol' }))).toEqual({ user: 'carol', target: `${ORG}/${TEAM}`, role: null, state: 'none', changed: false });
  });

  it('removes a member, and removing someone who is not on the team succeeds with changed false', async () => {
    await team('add', { username: 'bob' });
    expect(await only(team('remove', { username: 'bob' }))).toEqual({ user: 'bob', target: `${ORG}/${TEAM}`, role: null, state: 'none', changed: true });
    expect(access.teams.get(TEAM)!.has('bob')).toBe(false);
    api.requests.length = 0;
    expect(await only(team('remove', { username: 'bob' }))).toMatchObject({ state: 'none', changed: false });
    // Not a member: the team and the user are checked, so a typo is an error and not a quiet "nothing to do".
    expect(methods()).toEqual([`GET /orgs/${ORG}/teams/${TEAM}/memberships/bob`, `GET /orgs/${ORG}/teams/${TEAM}`, 'GET /users/bob']);
  });

  it('lists members with their roles, paged to the end', async () => {
    access.seedTeam('big', 230);
    const response = await team('getMany', { teamSlug: 'big', returnAll: true });
    const items = jsonOf(response);
    expect(items).toHaveLength(230);
    expect(items[0]).toEqual({ user: 'member-000', target: `${ORG}/big`, role: 'maintainer', state: 'active', changed: false });
    expect(items[5]).toMatchObject({ role: 'member' });
    expect(api.requests.filter((r) => r.query.get('role') === null && r.path.endsWith('/members')).map((r) => r.query.get('page'))).toEqual(['1', '2', '3']);
  });

  it('lists up to a limit', async () => {
    access.seedTeam('big', 230);
    const items = jsonOf(await team('getMany', { teamSlug: 'big', returnAll: false, limit: 5 }));
    expect(items.map((i) => i.user)).toEqual(['member-000', 'member-001', 'member-002', 'member-003', 'member-004']);
  });

  it('filters the list by role', async () => {
    await team('add', { username: 'bob' });
    const items = jsonOf(await team('getMany', { returnAll: true, roleFilter: 'member' }));
    expect(items.map((i) => i.user)).toEqual(['bob']);
  });

  it('says there is no such team, for every operation', async () => {
    for (const operation of ['add', 'remove', 'get', 'getMany']) {
      const response = await team(operation, { teamSlug: 'nope', username: 'bob' });
      expect(response.error?.message, operation).toMatch(/team "nope" was not found in the organization "acme"/i);
    }
  });

  it('says there is no such GitHub user, or no such organization', async () => {
    expect((await team('add', { username: 'ghost' })).error?.message).toMatch(/no GitHub user "ghost"/i);
    expect((await call({ resource: 'teamMembership', operation: 'get', org: 'other', teamSlug: TEAM, username: 'bob' })).error?.message).toMatch(/team "platform" was not found in the organization "other"/i);
  });

  it('explains a 403 and a 422', async () => {
    fake.failNext = { status: 403, body: { message: 'Must be an owner or maintainer' } };
    const denied = await team('add', { username: 'bob' });
    expect(denied.error?.message).toMatch(/403.*Must be an owner or maintainer/);
    expect(denied.error?.description).toMatch(/admin:org|Members/);
    expect(denied.error?.description).not.toMatch(/Contents/);
    fake.failNext = { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Membership', field: 'role', code: 'invalid' }] } };
    const refused = await team('add', { username: 'bob' });
    expect(refused.error?.message).toMatch(/422.*Validation Failed.*role invalid/);
    expect(refused.error?.description).toMatch(/refused/i);
    expect((await team('add', { username: 'bob', teamRole: 'owner' })).error?.message).toMatch(/Team Role must be member or maintainer/);
  });

  it('requires a username and the token never appears in an error', async () => {
    const response = await team('add', { username: '' });
    expect(response.error?.message).toMatch(/Username is required/);
    fake.failNext = { status: 401, body: { message: 'Bad credentials' } };
    expect(JSON.stringify((await team('get', { username: 'bob' })).error)).not.toContain(TOKEN);
  });
});

describe('Organization membership', () => {
  it('invites a user by name with their id, as a direct member', async () => {
    expect(await only(org('invite', { username: 'dave' }))).toMatchObject({ user: 'dave', target: ORG, role: 'member', state: 'pending', changed: true, invitationId: expect.any(Number) });
    expect(api.requests.at(-1)).toMatchObject({ method: 'POST', body: { invitee_id: 4, role: 'direct_member' } });
    expect(access.orgInvitations).toHaveLength(1);
  });

  it('invites as an admin', async () => {
    expect(await only(org('invite', { username: 'dave', orgRole: 'admin' }))).toMatchObject({ role: 'admin', state: 'pending' });
    expect(api.requests.at(-1)!.body).toMatchObject({ role: 'admin' });
  });

  it('invites by email', async () => {
    expect(await only(org('invite', { email: 'new.person@example.com' }))).toMatchObject({ user: 'new.person@example.com', state: 'pending', changed: true });
    expect(api.requests.at(-1)!.body).toEqual({ email: 'new.person@example.com', role: 'direct_member' });
    // Inviting the same address again finds the open invitation.
    api.requests.length = 0;
    expect(await only(org('invite', { email: 'New.Person@example.com' }))).toMatchObject({ state: 'pending', changed: false });
    expect(methods()).toEqual([`GET /orgs/${ORG}/invitations`]);
  });

  it('does not invite a member or someone already invited', async () => {
    expect(await only(org('invite', { username: 'bob' }))).toMatchObject({ user: 'bob', state: 'active', role: 'member', changed: false });
    await org('invite', { username: 'dave' });
    expect(await only(org('invite', { username: 'dave' }))).toMatchObject({ state: 'pending', changed: false });
    expect(access.orgInvitations).toHaveLength(1);
  });

  it('needs a username or an email, not neither', async () => {
    expect((await org('invite')).error?.message).toMatch(/Username or Email is required/);
    expect((await org('invite', { username: 'dave', email: 'd@example.com' })).error?.message).toMatch(/either a Username or an Email/i);
  });

  it('gets a membership: active, pending, none', async () => {
    expect(await only(org('get', { username: 'alice' }))).toEqual({ user: 'alice', target: ORG, role: 'admin', state: 'active', changed: false });
    await org('invite', { username: 'dave' });
    expect(await only(org('get', { username: 'dave' }))).toMatchObject({ state: 'pending', role: 'member' });
    expect(await only(org('get', { username: 'outsider' }))).toEqual({ user: 'outsider', target: ORG, role: null, state: 'none', changed: false });
  });

  it('removes a member (and from every team) and is a no-op for a stranger', async () => {
    expect(await only(org('remove', { username: 'alice' }))).toEqual({ user: 'alice', target: ORG, role: null, state: 'none', changed: true });
    expect(access.orgMembers.has('alice')).toBe(false);
    expect(await only(org('remove', { username: 'alice' }))).toMatchObject({ state: 'none', changed: false });
  });

  it('cancels an invitation by user, by email or by id, and again is a no-op', async () => {
    await org('invite', { username: 'dave' });
    await org('invite', { email: 'x@example.com' });
    const [first, second] = access.orgInvitations;
    expect(await only(org('cancelInvitation', { username: 'dave' }))).toEqual({ user: 'dave', target: ORG, role: null, state: 'none', changed: true });
    expect(await only(org('cancelInvitation', { email: 'X@example.com' }))).toMatchObject({ user: 'X@example.com', changed: true });
    expect(access.orgInvitations).toEqual([]);
    expect(await only(org('cancelInvitation', { username: 'dave' }))).toMatchObject({ changed: false });
    access.orgInvitations.push({ ...first, id: 777 });
    expect(await only(org('cancelInvitation', { invitationId: 777 }))).toMatchObject({ changed: true });
    expect(await only(org('cancelInvitation', { invitationId: 778 }))).toMatchObject({ changed: false });
    expect(second.id).not.toBe(first.id);
  });

  it('says there is no such user or organization', async () => {
    expect((await org('get', { username: 'ghost' })).error?.message).toMatch(/no GitHub user "ghost"/i);
    const missingOrg = await call({ resource: 'orgMembership', operation: 'get', org: 'other', username: 'bob' });
    expect(missingOrg.error?.message).toMatch(/organization "other" was not found/i);
    expect((await org('invite', { username: 'ghost' })).error?.message).toMatch(/no GitHub user "ghost"/i);
  });

  it('explains a refused role', async () => {
    expect((await org('invite', { username: 'dave', orgRole: 'reinstate-me' })).error?.message).toMatch(/Organization Role must be direct_member or admin/);
    fake.failNext = { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'The organization has no seats left' }] } };
    const response = await org('invite', { email: 'new@example.com' });
    expect(response.error?.message).toMatch(/422.*no seats left/);
    expect(response.error?.description).toMatch(/seats/);
  });
});

describe('Repository collaborator', () => {
  it('adds an organization member directly, and reports no change the second time', async () => {
    expect(await only(repo('add', { username: 'carol', permission: 'triage' }))).toEqual({ user: 'carol', target: `${OWNER}/${REPO}`, permission: 'triage', state: 'active', changed: true });
    expect(access.collaborators.get('carol')).toBe('triage');
    expect(api.requests.at(-1)!.body).toEqual({ permission: 'triage' });
    api.requests.length = 0;
    expect(await only(repo('add', { username: 'carol', permission: 'triage' }))).toMatchObject({ permission: 'triage', state: 'active', changed: false, alreadyHad: true });
    expect(api.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('maps push and pull to GitHub’s write and read, and changes an existing permission', async () => {
    expect(await only(repo('add', { username: 'bob', permission: 'push' }))).toMatchObject({ permission: 'push', changed: false });
    expect(await only(repo('add', { username: 'bob', permission: 'admin' }))).toMatchObject({ permission: 'admin', changed: true });
    // Never a downgrade: someone with admin who is asked to get pull keeps admin, and the answer says so.
    expect(await only(repo('add', { username: 'bob', permission: 'pull' }))).toMatchObject({ permission: 'admin', changed: false, alreadyHad: true });
    expect(access.collaborators.get('bob')).toBe('admin');
  });

  it('invites an outside collaborator: pending, with the invitation, and idempotent while it is open', async () => {
    const added = await only(repo('add', { username: 'outsider', permission: 'push' }));
    expect(added).toMatchObject({ user: 'outsider', permission: 'push', state: 'pending', changed: true, invitationId: expect.any(Number) });
    expect(added.note).toMatch(/invitation/i);
    expect(access.collaborators.has('outsider')).toBe(false);
    api.requests.length = 0;
    expect(await only(repo('add', { username: 'outsider', permission: 'push' }))).toMatchObject({ state: 'pending', changed: false });
    expect(api.requests.some((r) => r.method === 'PUT')).toBe(false);
    expect(await only(repo('getPermission', { username: 'outsider' }))).toMatchObject({ permission: 'push', state: 'pending' });
  });

  it('gets a permission: a role, pending, or none', async () => {
    expect(await only(repo('getPermission', { username: 'alice' }))).toEqual({ user: 'alice', target: `${OWNER}/${REPO}`, permission: 'admin', state: 'active', changed: false });
    expect(await only(repo('getPermission', { username: 'bob' }))).toMatchObject({ permission: 'push' });
    expect(await only(repo('getPermission', { username: 'outsider' }))).toEqual({ user: 'outsider', target: `${OWNER}/${REPO}`, permission: null, state: 'none', changed: false });
    // An organization member has the base permission without being a collaborator.
    expect(await only(repo('getPermission', { username: 'carol' }))).toMatchObject({ permission: 'pull', state: 'active' });
  });

  it('removes a collaborator, cancels an open invitation, and is a no-op for a stranger', async () => {
    // bob is an organization member: the direct access goes, the base permission stays, and the answer reports what is left.
    expect(await only(repo('remove', { username: 'bob' }))).toMatchObject({ user: 'bob', target: `${OWNER}/${REPO}`, permission: 'pull', state: 'active', changed: true, note: expect.stringMatching(/base permission/) });
    expect(access.collaborators.has('bob')).toBe(false);
    await repo('add', { username: 'outsider', permission: 'pull' });
    expect(await only(repo('remove', { username: 'outsider' }))).toMatchObject({ state: 'none', changed: true });
    expect(access.repoInvitations).toEqual([]);
    api.requests.length = 0;
    expect(await only(repo('remove', { username: 'outsider' }))).toMatchObject({ changed: false, state: 'none' });
    expect(api.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('lists collaborators, with the pending invitations unless asked not to', async () => {
    await repo('add', { username: 'outsider', permission: 'push' });
    const all = jsonOf(await repo('getMany', { returnAll: true }));
    expect(all.map((i) => `${i.user}:${i.permission}:${i.state}`)).toEqual(['alice:admin:active', 'bob:push:active', 'outsider:push:pending']);
    const active = jsonOf(await repo('getMany', { returnAll: true, includeInvited: false }));
    expect(active.map((i) => i.user)).toEqual(['alice', 'bob']);
  });

  it('pages the list', async () => {
    for (let n = 0; n < 120; n++) {
      access.users.set(`c${n}`, 500 + n);
      access.collaborators.set(`c${n}`, 'read');
    }
    expect(jsonOf(await repo('getMany', { returnAll: true, includeInvited: false }))).toHaveLength(122);
    expect(jsonOf(await repo('getMany', { returnAll: false, limit: 3, includeInvited: false }))).toHaveLength(3);
  });

  it('says there is no such repository or user, and refuses a bad permission', async () => {
    const missingRepo = await call({ resource: 'repoCollaborator', operation: 'add', owner: OWNER, repository: 'nope', username: 'bob', permission: 'push' });
    expect(missingRepo.error?.message).toMatch(/repository "acme\/nope" was not found/i);
    expect((await repo('add', { username: 'ghost', permission: 'push' })).error?.message).toMatch(/no GitHub user "ghost"/i);
    const bad = await repo('add', { username: 'carol', permission: 'owner' });
    expect(bad.error?.message).toMatch(/Permission must be one of pull, triage, push, maintain, admin/);
  });

  it('explains a 403', async () => {
    fake.failNext = { status: 403, body: { message: 'Must have admin rights to Repository.' } };
    const response = await repo('add', { username: 'carol', permission: 'push' });
    expect(response.error?.message).toMatch(/403.*admin rights/);
    expect(response.error?.description).toMatch(/admin/i);
  });
});

describe('Project (v2) collaborator', () => {
  it('adds a collaborator with a role through GraphQL and removes them with NONE', async () => {
    expect(await only(project('add', { username: 'bob', projectRole: 'WRITER' }))).toEqual({ user: 'bob', target: `${ORG}/projects/${PROJECT_NUMBER}`, role: 'WRITER', state: 'active', changed: null });
    expect(access.projectRoles.get('bob')).toBe('WRITER');
    expect(api.requests.every((r) => r.path === '/api/graphql')).toBe(true);
    expect(await only(project('remove', { username: 'bob' }))).toEqual({ user: 'bob', target: `${ORG}/projects/${PROJECT_NUMBER}`, role: null, state: 'none', changed: null });
    expect(access.projectRoles.has('bob')).toBe(false);
  });

  it('says there is no such project, organization or user', async () => {
    expect((await project('add', { username: 'bob', projectRole: 'READER', projectNumber: 99 })).error?.message).toMatch(/project 99 was not found in the organization "acme"/i);
    const otherOrg = await call({ resource: 'projectCollaborator', operation: 'add', org: 'other', projectNumber: 1, username: 'bob', projectRole: 'READER' });
    expect(otherOrg.error?.message).toMatch(/organization "other" was not found/i);
    expect((await project('add', { username: 'ghost', projectRole: 'READER' })).error?.message).toMatch(/no GitHub user "ghost"/i);
  });

  it('reports a GraphQL permission error with the scope hint', async () => {
    fake.failNext = { status: 200, body: { data: null, errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted the required scopes: project' }] } };
    const response = await project('add', { username: 'bob', projectRole: 'READER' });
    expect(response.error?.message).toMatch(/required scopes/);
    expect(response.error?.description).toMatch(/project/);
  });

  it('uses the Enterprise GraphQL endpoint next to /api/v3', async () => {
    await project('add', { username: 'bob', projectRole: 'READER' });
    expect(api.requests[0].path).toBe('/api/graphql');
  });
});

describe('Items, errors and tools', () => {
  it('handles each input item with its own parameters, and continues on fail when asked', async () => {
    const response = await run(GitHubAccess, { resource: 'teamMembership', operation: 'add', org: ORG, teamSlug: TEAM }, {
      credentials: creds(),
      items: [{}, {}],
      perItem: [{ username: 'bob' }, { username: 'ghost' }],
      continueOnFail: true,
    });
    const items = response.outputs[0];
    expect(items[0].json).toMatchObject({ user: 'bob', changed: true });
    expect(items[1].json).toMatchObject({ error: expect.stringMatching(/no GitHub user "ghost"/i) });
    expect(items.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('is a node error for an operation the resource does not have', async () => {
    const response = await call({ resource: 'teamMembership', operation: 'invite', org: ORG, teamSlug: TEAM, username: 'bob' });
    expect(response.error?.message).toMatch(/not available for resource "teamMembership"/);
  });

  it('offers only the read operations as tools; every write is kept out', () => {
    const tools = mcpToolsForNode('github', GitHubAccess.description);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['githubAccess_orgMembership_get', 'githubAccess_repoCollaborator_getMany', 'githubAccess_repoCollaborator_getPermission', 'githubAccess_teamMembership_get', 'githubAccess_teamMembership_getMany']);
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe('Names are checked before any call', () => {
  const bad: Array<[string, () => ReturnType<typeof call>, RegExp]> = [
    ['team slug ..', () => team('remove', { teamSlug: '..', username: 'bob' }), /Team Slug/],
    ['team slug with a slash', () => team('get', { teamSlug: 'a/b', username: 'bob' }), /Team Slug/],
    ['team slug with a space', () => team('getMany', { teamSlug: 'a b' }), /Team Slug/],
    ['org .', () => org('get', { org: '.', username: 'bob' }), /Organization/],
    ['org ..', () => team('add', { org: '..', username: 'bob' }), /Organization/],
    ['project org with a slash', () => project('add', { org: 'a/b', username: 'bob', projectRole: 'READER' }), /Organization/],
    ['owner ..', () => repo('add', { owner: '..', username: 'bob', permission: 'pull' }), /Owner/],
    ['repository ..', () => repo('getMany', { repository: '..', returnAll: true }), /Repository/],
    ['repository with a slash', () => repo('getPermission', { repository: 'x/y', username: 'bob' }), /Repository/],
    ['username ..', () => team('remove', { username: '..' }), /Username/],
    ['username .', () => org('remove', { username: '.' }), /Username/],
    ['username with a slash', () => repo('remove', { username: 'a/b' }), /Username/],
    ['username with a space', () => team('get', { username: 'bo b' }), /Username/],
    ['username starting with a hyphen', () => team('get', { username: '-bob' }), /Username/],
    ['username with two hyphens in a row', () => org('invite', { username: 'a--b' }), /Username/],
    ['username over 39 characters', () => project('remove', { username: 'a'.repeat(40) }), /Username/],
    ['invitation id negative', () => org('cancelInvitation', { invitationId: -3 }), /Invitation ID/],
  ];
  for (const [name, attempt, message] of bad) {
    it(`refuses ${name} and calls nothing`, async () => {
      const response = await attempt();
      expect(response.error?.message).toMatch(message);
      expect(response.error?.message).toMatch(/not a valid|must be/i);
      expect(api.requests).toEqual([]);
    });
  }

  it('accepts ordinary logins, slugs and names', async () => {
    expect((await team('get', { teamSlug: 'platform', username: 'a-b-c1' })).error?.message ?? '').not.toMatch(/not a valid/);
    expect((await repo('getMany', { owner: OWNER, repository: 'my.repo_1-x', returnAll: true })).error?.message ?? '').not.toMatch(/not a valid/);
  });
});

describe('Agent tools can read but never grant', () => {
  const asTool = (parameters: JsonObject) => run(GitHubAccess, { org: ORG, teamSlug: TEAM, username: 'bob', ...parameters }, { credentials: creds(), mode: 'tool' });

  it('refuses every write in tool mode, whatever the model overrode, with no call to GitHub', async () => {
    const writes: JsonObject[] = [
      { resource: 'teamMembership', operation: 'add' },
      { resource: 'teamMembership', operation: 'remove' },
      { resource: 'orgMembership', operation: 'invite' },
      { resource: 'orgMembership', operation: 'remove' },
      { resource: 'orgMembership', operation: 'cancelInvitation' },
      { resource: 'repoCollaborator', operation: 'add', owner: OWNER, repository: REPO, permission: 'admin' },
      { resource: 'repoCollaborator', operation: 'remove', owner: OWNER, repository: REPO },
      { resource: 'projectCollaborator', operation: 'add', projectNumber: PROJECT_NUMBER, projectRole: 'ADMIN' },
      { resource: 'projectCollaborator', operation: 'remove', projectNumber: PROJECT_NUMBER },
    ];
    for (const parameters of writes) {
      const response = await asTool(parameters);
      expect(response.error?.message, JSON.stringify(parameters)).toMatch(/not allowed as an agent tool|never grants access/i);
    }
    expect(api.requests).toEqual([]);
    expect(access.teams.get(TEAM)!.has('bob')).toBe(false);
  });

  it('still reads in tool mode', async () => {
    const response = await asTool({ resource: 'teamMembership', operation: 'get' });
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({ user: 'bob', state: 'none' });
  });

  it('refuses a write over MCP too', async () => {
    const response = await run(GitHubAccess, { resource: 'teamMembership', operation: 'add', org: ORG, teamSlug: TEAM, username: 'bob' }, { credentials: creds(), mode: 'mcp' });
    expect(response.error?.message).toMatch(/agent tool/i);
    expect(api.requests).toEqual([]);
  });
});

describe('Access is never downgraded', () => {
  it('a maintainer asked to be a member stays a maintainer, and the answer says they already had it', async () => {
    expect(await only(team('add', { username: 'alice' }))).toEqual({ user: 'alice', target: `${ORG}/${TEAM}`, role: 'maintainer', state: 'active', changed: false, alreadyHad: true });
    expect(access.teams.get(TEAM)!.get('alice')!.role).toBe('maintainer');
    expect(api.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('an organization owner counts as a maintainer of every team', async () => {
    expect(await only(team('add', { username: 'octo-bot' }))).toMatchObject({ role: 'maintainer', changed: false, alreadyHad: true });
    expect(access.teams.get(TEAM)!.has('octo-bot')).toBe(false);
  });

  it('a new grant says alreadyHad is not so', async () => {
    expect(await only(team('add', { username: 'bob' }))).not.toHaveProperty('alreadyHad');
  });

  it('an organization owner asked to be a member keeps the admin role', async () => {
    expect(await only(org('invite', { username: 'alice' }))).toEqual({ user: 'alice', target: ORG, role: 'admin', state: 'active', changed: false, alreadyHad: true });
  });

  it('refuses to report a higher org role as granted to a member or an invitee', async () => {
    const member = await org('invite', { username: 'bob', orgRole: 'admin' });
    expect(member.error?.message).toMatch(/bob.*already.*member.*role member/i);
    expect(member.error?.description).toMatch(/does not change roles/i);
    await org('invite', { username: 'dave' });
    expect((await org('invite', { username: 'dave', orgRole: 'admin' })).error?.message).toMatch(/dave.*already.*invited.*role member/i);
    await org('invite', { email: 'e@example.com' });
    expect((await org('invite', { email: 'e@example.com', orgRole: 'admin' })).error?.message).toMatch(/already invited.*role member/i);
    expect(access.orgMembers.get('bob')).toBe('member');
    expect(access.orgInvitations.map((i) => i.role)).toEqual(['direct_member', 'direct_member']);
  });

  it('a higher invited repository permission is raised, a lower one is kept', async () => {
    await repo('add', { username: 'outsider', permission: 'triage' });
    expect(await only(repo('add', { username: 'outsider', permission: 'pull' }))).toMatchObject({ permission: 'triage', state: 'pending', changed: false, alreadyHad: false });
    expect(await only(repo('add', { username: 'outsider', permission: 'admin' }))).toMatchObject({ permission: 'admin', state: 'pending', changed: true });
  });

  it('the base permission already covers a pull request for an organization member', async () => {
    expect(await only(repo('add', { username: 'carol', permission: 'pull' }))).toMatchObject({ permission: 'pull', changed: false, alreadyHad: true });
    expect(access.collaborators.has('carol')).toBe(false);
  });
});

describe('Removing a repository collaborator reports what is left', () => {
  it('an organization member keeps the base permission, and nothing direct means no change', async () => {
    expect(await only(repo('remove', { username: 'bob' }))).toMatchObject({ permission: 'pull', state: 'active', changed: true });
    api.requests.length = 0;
    expect(await only(repo('remove', { username: 'bob' }))).toMatchObject({ permission: 'pull', state: 'active', changed: false });
    expect(api.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('with no base permission, removing leaves none', async () => {
    access.orgBasePermission = 'none';
    expect(await only(repo('remove', { username: 'bob' }))).toMatchObject({ permission: null, state: 'none', changed: true });
  });

  it('decides from the direct collaborators, not the effective permission', async () => {
    // carol has pull only through the base permission: there is nothing of hers to remove.
    expect(await only(repo('remove', { username: 'carol' }))).toMatchObject({ changed: false, permission: 'pull' });
    expect(api.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });
});

describe('Logins are case-insensitive', () => {
  it('Bob and bob are the same person on a team, in the organization and on a repository', async () => {
    expect(await only(team('add', { username: 'Bob' }))).toMatchObject({ user: 'Bob', changed: true });
    expect(await only(team('add', { username: 'bob' }))).toMatchObject({ changed: false, alreadyHad: true });
    expect(await only(team('get', { username: 'BOB' }))).toMatchObject({ state: 'active' });
    expect(access.teams.get(TEAM)!.has('bob')).toBe(true);
    expect(await only(org('get', { username: 'ALICE' }))).toMatchObject({ role: 'admin', state: 'active' });
    expect(await only(org('invite', { username: 'Carol' }))).toMatchObject({ changed: false });
    expect(await only(repo('add', { username: 'BOB', permission: 'push' }))).toMatchObject({ changed: false });
    await repo('add', { username: 'Outsider', permission: 'push' });
    expect(await only(repo('add', { username: 'outsider', permission: 'push' }))).toMatchObject({ state: 'pending', changed: false });
    expect(await only(repo('remove', { username: 'OUTSIDER' }))).toMatchObject({ changed: true });
    await org('invite', { username: 'Dave' });
    expect(await only(org('cancelInvitation', { username: 'dave' }))).toMatchObject({ changed: true });
    expect(await only(project('add', { username: 'Bob', projectRole: 'READER' }))).toMatchObject({ role: 'READER' });
    expect(access.projectRoles.get('bob')).toBe('READER');
  });
});
