/**
 * Stateful stand-ins for the GitHub Access node (`github.githubAccess`) and the Google Directory node (`google.googleDirectory`)
 * with the operations, parameters and answers `lib/server/access/systems.ts` names (C35, docs/access-requests.md). They keep teams,
 * organizations, repositories, projects and groups in memory, are idempotent (`changed`, `alreadyHad`, `state`), refuse a write
 * in `tool` and `mcp` mode as the real GitHub node does, and fail with "No team …" the way the real ones do.
 * `fake.calls` logs every call (mode, parameters, whether a credential came) so a test can assert what the host sent.
 */
import { defineCredentialType, defineNode, definePlugin, NodeOperationError, type IExecuteContext, type JsonObject } from '@landflow/sdk';

type Role = string;
type Kind = 'teams' | 'orgs' | 'repos' | 'projects' | 'groups';

export const fake = {
  teams: new Map<string, Map<string, Role>>(),
  orgs: new Map<string, Map<string, Role>>(),
  repos: new Map<string, Map<string, Role>>(),
  projects: new Map<string, Map<string, Role>>(),
  groups: new Map<string, Map<string, Role>>(),
  calls: [] as Array<{ type: string; mode: string; operation: string; parameters: Record<string, unknown>; credential: boolean }>,
  /** Fail the next call with this message (`{{token}}` becomes the credential's token, to prove it is scrubbed). */
  failNext: undefined as string | undefined,
  /** Fail every call (the system is down). */
  down: false,
  reset() {
    for (const map of [this.teams, this.orgs, this.repos, this.projects, this.groups]) map.clear();
    this.calls.length = 0;
    this.failNext = undefined;
    this.down = false;
  },
  seedTeam(org: string, slug: string, members: Record<string, Role> = {}) {
    this.teams.set(`${org}/${slug}`, new Map(Object.entries(members)));
  },
  seedRepo(owner: string, repo: string, members: Record<string, Role> = {}) {
    this.repos.set(`${owner}/${repo}`, new Map(Object.entries(members)));
  },
  seedOrg(org: string, members: Record<string, Role> = {}) {
    this.orgs.set(org, new Map(Object.entries(members)));
  },
  seedProject(org: string, number: number, members: Record<string, Role> = {}) {
    this.projects.set(`${org}/${number}`, new Map(Object.entries(members)));
  },
  seedGroup(email: string, members: Record<string, Role> = {}) {
    this.groups.set(email.toLowerCase(), new Map(Object.entries(members)));
  },
  members(kind: Kind, key: string): Record<string, Role> {
    return Object.fromEntries(this[kind].get(key) ?? []);
  },
};

const TEAM_RANK: Record<string, number> = { member: 1, maintainer: 2 };
const REPO_RANK: Record<string, number> = { pull: 1, triage: 2, push: 3, maintain: 4, admin: 5 };
const ORG_RANK: Record<string, number> = { direct_member: 1, admin: 2 };

const LOGGED = ['resource', 'operation', 'org', 'teamSlug', 'owner', 'repository', 'projectNumber', 'username', 'groupKey', 'memberKey', 'role', 'teamRole', 'orgRole', 'permission', 'projectRole', 'authentication', 'adminEmail'];

function gate(ctx: IExecuteContext, credential: string, token: string | undefined, write: boolean, operation: string) {
  const parameters: Record<string, unknown> = {};
  for (const name of LOGGED) {
    const value = ctx.getNodeParameter<unknown>(name, 0, undefined);
    if (value !== undefined && value !== '') parameters[name] = value;
  }
  fake.calls.push({ type: ctx.getNode().type, mode: ctx.getMode(), operation, parameters, credential: Boolean(token) });
  if (write && (ctx.getMode() === 'tool' || ctx.getMode() === 'mcp')) throw new NodeOperationError('Granting or removing access is not allowed as an agent tool');
  if (!token) throw new NodeOperationError(`No ${credential} credential`);
  if (fake.down) throw new NodeOperationError('The system is not reachable right now');
  if (fake.failNext) {
    const message = fake.failNext.replaceAll('{{token}}', token);
    fake.failNext = undefined;
    throw new NodeOperationError(message);
  }
}

const item = (json: Record<string, unknown>) => [[{ json: json as JsonObject, pairedItem: { item: 0 } }]];

const githubApi = defineCredentialType({
  name: 'githubApi',
  displayName: 'GitHub API',
  properties: [{ name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } }],
});

const githubAccess = defineNode({
  description: {
    name: 'githubAccess',
    displayName: 'GitHub Access',
    version: 1,
    kind: 'action',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'githubApi', required: true }],
    properties: [
      { name: 'resource', displayName: 'Resource', type: 'string', default: 'teamMembership' },
      { name: 'operation', displayName: 'Operation', type: 'string', default: 'add' },
      { name: 'org', displayName: 'Organization', type: 'string', default: '' },
      { name: 'teamSlug', displayName: 'Team Slug', type: 'string', default: '' },
      { name: 'owner', displayName: 'Owner', type: 'string', default: '' },
      { name: 'repository', displayName: 'Repository', type: 'string', default: '' },
      { name: 'projectNumber', displayName: 'Project Number', type: 'number', default: 0 },
      { name: 'username', displayName: 'Username', type: 'string', default: '' },
      { name: 'teamRole', displayName: 'Team Role', type: 'string', default: 'member' },
      { name: 'orgRole', displayName: 'Organization Role', type: 'string', default: 'direct_member' },
      { name: 'permission', displayName: 'Permission', type: 'string', default: 'pull' },
      { name: 'projectRole', displayName: 'Project Role', type: 'string', default: 'READER' },
    ],
  },
  async execute(ctx) {
    const resource = ctx.getNodeParameter<string>('resource', 0);
    const operation = ctx.getNodeParameter<string>('operation', 0);
    const user = String(ctx.getNodeParameter('username', 0)).toLowerCase();
    const token = ctx.getCredentials<{ accessToken?: string }>('githubApi').accessToken;
    gate(ctx, 'githubApi', token, operation === 'add' || operation === 'remove' || operation === 'invite', operation);
    const answer = (members: Map<string, Role>, rank: Record<string, number>, asked: string, label: string) => {
      const had = members.get(user);
      if (operation === 'add' || operation === 'invite') {
        if (had && (rank[had] ?? 0) >= (rank[asked] ?? 0)) return item({ user, target: label, role: had, state: 'active', changed: false, alreadyHad: true });
        members.set(user, asked);
        return item({ user, target: label, role: asked, state: 'active', changed: true });
      }
      if (operation === 'remove') return item({ user, target: label, state: 'none', changed: members.delete(user) });
      return item({ user, target: label, role: had ?? null, permission: had ?? null, state: had ? 'active' : 'none', changed: false });
    };
    if (resource === 'teamMembership') {
      const key = `${ctx.getNodeParameter('org', 0)}/${ctx.getNodeParameter('teamSlug', 0)}`;
      const members = fake.teams.get(key);
      if (!members) throw new NodeOperationError(`No team ${key}`, { description: 'Check the organization and the team slug' });
      return answer(members, TEAM_RANK, ctx.getNodeParameter<string>('teamRole', 0, 'member'), key);
    }
    if (resource === 'orgMembership') {
      const key = String(ctx.getNodeParameter('org', 0));
      const members = fake.orgs.get(key);
      if (!members) throw new NodeOperationError(`No organization ${key}`);
      return answer(members, ORG_RANK, ctx.getNodeParameter<string>('orgRole', 0, 'direct_member'), key);
    }
    if (resource === 'repoCollaborator') {
      const key = `${ctx.getNodeParameter('owner', 0)}/${ctx.getNodeParameter('repository', 0)}`;
      const members = fake.repos.get(key);
      if (!members) throw new NodeOperationError(`No repository ${key}`);
      return answer(members, REPO_RANK, ctx.getNodeParameter<string>('permission', 0, 'pull'), key);
    }
    if (resource === 'projectCollaborator') {
      const key = `${ctx.getNodeParameter('org', 0)}/${ctx.getNodeParameter('projectNumber', 0)}`;
      const members = fake.projects.get(key);
      if (!members) throw new NodeOperationError(`No project ${key}`);
      // GitHub sets a project role without saying whether it was so already: `changed` is null, there is no `alreadyHad`.
      if (operation === 'add') members.set(user, ctx.getNodeParameter<string>('projectRole', 0, 'READER'));
      else members.delete(user);
      return item({ user, target: key, state: operation === 'add' ? 'active' : 'none', changed: null });
    }
    throw new NodeOperationError(`The fake has no ${resource}`);
  },
});

const googleApi = defineCredentialType({
  name: 'googleApi',
  displayName: 'Google service account',
  properties: [{ name: 'privateKey', displayName: 'Private Key', type: 'string', required: true, typeOptions: { password: true } }],
});
const googleOAuth2Api = defineCredentialType({
  name: 'googleOAuth2Api',
  displayName: 'Google OAuth2',
  properties: [{ name: 'refreshToken', displayName: 'Refresh Token', type: 'string', required: true, typeOptions: { password: true } }],
});

const googleDirectory = defineNode({
  description: {
    name: 'googleDirectory',
    displayName: 'Google Directory',
    version: 1,
    kind: 'action',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [
      { name: 'googleApi', required: true, displayOptions: { show: { authentication: ['serviceAccount'] } } },
      { name: 'googleOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    properties: [
      { name: 'authentication', displayName: 'Authentication', type: 'string', default: 'serviceAccount' },
      { name: 'resource', displayName: 'Resource', type: 'string', default: 'user' },
      { name: 'operation', displayName: 'Operation', type: 'string', default: 'getAll' },
      { name: 'adminEmail', displayName: 'Admin to Impersonate', type: 'string', default: '' },
      { name: 'groupKey', displayName: 'Group', type: 'string', default: '' },
      { name: 'memberKey', displayName: 'Member', type: 'string', default: '' },
      { name: 'role', displayName: 'Role', type: 'string', default: 'MEMBER' },
    ],
  },
  async execute(ctx) {
    const operation = ctx.getNodeParameter<string>('operation', 0);
    const oauth = ctx.getNodeParameter<string>('authentication', 0) === 'oAuth2';
    const data = (oauth ? ctx.getCredentials<{ refreshToken?: string }>('googleOAuth2Api') : ctx.getCredentials<{ privateKey?: string }>('googleApi')) as { refreshToken?: string; privateKey?: string };
    gate(ctx, oauth ? 'googleOAuth2Api' : 'googleApi', data.refreshToken ?? data.privateKey, operation === 'add' || operation === 'remove', operation);
    const group = String(ctx.getNodeParameter('groupKey', 0)).toLowerCase();
    const member = String(ctx.getNodeParameter('memberKey', 0)).toLowerCase();
    const members = fake.groups.get(group);
    if (!members) throw new NodeOperationError(`No group ${group}`);
    const had = members.get(member);
    if (operation === 'add') {
      if (had) return item({ group, member, role: had, status: 'already_member', changed: false, alreadyHad: true });
      const role = ctx.getNodeParameter<string>('role', 0, 'MEMBER');
      members.set(member, role);
      return item({ group, member, role, status: 'added', changed: true, alreadyHad: false });
    }
    if (operation === 'remove') {
      members.delete(member);
      return item({ group, member, role: had ?? null, status: had ? 'removed' : 'not_member', changed: Boolean(had) });
    }
    return item({ group, member, isMember: Boolean(had), status: had ? 'member' : 'not_member', changed: false });
  },
});

export const fakeGithubPlugin = definePlugin({ info: { id: 'github', name: 'GitHub (fake)', version: '1.0.0', language: 'typescript' }, nodes: [githubAccess], credentialTypes: [githubApi] });
export const fakeGooglePlugin = definePlugin({ info: { id: 'google', name: 'Google Workspace (fake)', version: '1.0.0', language: 'typescript' }, nodes: [googleDirectory], credentialTypes: [googleApi, googleOAuth2Api] });
