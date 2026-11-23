/**
 * GitHub Access: who may do what, as flow steps. Team membership, organization membership and invitations, repository
 * collaborators and Projects (v2) collaborators, so an approved access request can be granted (and taken back) by a
 * flow. Every write is idempotent where GitHub is: it reads the state first, does nothing when the user already has what
 * was asked and says so (`changed: false`). Every result is one object `{ user, target, role | permission, state,
 * changed }`. Only the read operations are offered as agent tools: an agent never grants access.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { apiError, baseUrl, rawCall, repoPath, type ApiContext, type GitHubCredentials, type GitHubResponse } from '../api';
import { mapItems, optionalString, requireString, unsupported } from '../shared';

const PAGE_SIZE = 100;
/** A list stops here even when "Return All" is on: a team or repository with more people is not a flow's to page through. */
const MAX_LIST = 5000;

interface Access {
  api: ApiContext;
  credentials: GitHubCredentials;
}

type Reply = GitHubResponse & { text: string };

/** What each status means for access calls: the scopes and roles that matter here, not the file scopes of the other node. */
function accessHint(status: number, headers: Headers, message: string): string | undefined {
  if (status === 401) return 'GitHub rejected the token. Check that it is correct, has not expired or been revoked, and (for Enterprise) that the API base URL is right.';
  if (status === 403) {
    if (headers.get('x-ratelimit-remaining') === '0') return 'The GitHub rate limit is used up: run the node again after it resets.';
    if (/rate limit|abuse/i.test(message)) return 'GitHub is limiting this token for making many requests: wait a little and run the node again.';
    return 'The token is valid but not allowed to change access here. Team and organization membership need an organization owner (or a team maintainer for team membership) and the admin:org scope (classic) or the Members read and write permission (fine-grained); collaborators need admin rights on the repository; projects need the project scope. An SSO-protected organization also needs the token authorized.';
  }
  if (status === 422) return 'GitHub refused the change: for example the person is already invited, the organization has no seats left, the role or permission is not one the organization allows, or the email is not valid.';
  if (status === 404) return 'GitHub answers 404 for a missing resource and also for one the token cannot see. Check the names and the token’s access.';
  return undefined;
}

/** One call whose failure is a node error with the access hints. */
async function send(a: Access, method: string, path: string, body?: JsonObject): Promise<Reply> {
  const response = await rawCall(a.api, a.credentials, method, path, body);
  if (!response.ok) throw apiError(a.api, response as GitHubResponse<any>, accessHint);
  return response;
}

/** Like send, but a 404 is `undefined`: "not a member" is an answer. The caller checks what else a 404 may mean. */
async function sendOrMissing(a: Access, method: string, path: string): Promise<Reply | undefined> {
  const response = await rawCall(a.api, a.credentials, method, path);
  if (response.status === 404) return undefined;
  if (!response.ok) throw apiError(a.api, response as GitHubResponse<any>, accessHint);
  return response;
}

const enc = encodeURIComponent;
const lower = (value: unknown) => String(value ?? '').toLowerCase();
const body = (reply: Reply) => (reply.body ?? {}) as JsonObject;

/** The checks behind a 404: which of the named things does not exist? Each throws a clear error, or returns when it exists. */
async function assertOrg(a: Access, org: string) {
  if (!(await sendOrMissing(a, 'GET', `/orgs/${enc(org)}`))) {
    throw new NodeOperationError(`The organization "${org}" was not found`, { description: 'Check the organization’s login, and that the token can see it (an SSO-protected organization needs the token authorized).' });
  }
}
async function assertTeam(a: Access, org: string, slug: string) {
  if (!(await sendOrMissing(a, 'GET', `/orgs/${enc(org)}/teams/${enc(slug)}`))) {
    throw new NodeOperationError(`The team "${slug}" was not found in the organization "${org}"`, { description: 'Use the team’s slug (the name in its URL, such as platform), and check the organization and that the token can see the team.' });
  }
}
async function assertRepo(a: Access, owner: string, repository: string) {
  if (!(await sendOrMissing(a, 'GET', repoPath(owner, repository)))) {
    throw new NodeOperationError(`The repository "${owner}/${repository}" was not found`, { description: 'GitHub also answers 404 for a private repository the token cannot see. Check the owner, the name and the token’s access.' });
  }
}
async function userId(a: Access, username: string): Promise<number> {
  const user = await sendOrMissing(a, 'GET', `/users/${enc(username)}`);
  if (!user) throw new NodeOperationError(`There is no GitHub user "${username}"`, { description: 'Use the GitHub login (the name in the profile URL), not the display name or the email.' });
  return Number(body(user).id);
}
const assertUser = async (a: Access, username: string) => void (await userId(a, username));

/** Pages of 100 up to `limit` items. A 404 on a page means the thing listed does not exist: `onMissing` says which. */
async function collect(a: Access, path: string, limit: number, onMissing: () => Promise<void>): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  const glue = path.includes('?') ? '&' : '?';
  for (let page = 1; out.length < limit; page++) {
    const response = await sendOrMissing(a, 'GET', `${path}${glue}per_page=${PAGE_SIZE}&page=${page}`);
    if (!response) {
      await onMissing();
      throw new NodeOperationError('GitHub answered 404 for the list');
    }
    const batch = (response.body ?? []) as JsonObject[];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out.slice(0, limit);
}

function listLimit(ctx: IExecuteContext, i: number): number {
  if (ctx.getNodeParameter<boolean>('returnAll', i, false)) return MAX_LIST;
  return Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50);
}

/** The one result shape: who, on what, with which role or permission, in which state, and whether this call changed it. */
const result = (user: string | null, target: string, kind: 'role' | 'permission', value: string | null, state: string, changed: boolean | null, extra: JsonObject = {}): JsonObject => ({
  user,
  target,
  [kind]: value,
  state,
  changed,
  ...extra,
});

// ---------------------------------------------------------------------------
// Team membership
// ---------------------------------------------------------------------------

async function teamOperation(ctx: IExecuteContext, a: Access, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  const org = requireString(ctx, 'org', 'Organization', i);
  const slug = requireString(ctx, 'teamSlug', 'Team Slug', i);
  const target = `${org}/${slug}`;
  const base = `/orgs/${enc(org)}/teams/${enc(slug)}`;
  if (operation === 'getMany') {
    const filter = ctx.getNodeParameter<string>('roleFilter', i, 'all');
    const limit = listLimit(ctx, i);
    const missing = () => assertTeam(a, org, slug);
    // GitHub's list says nothing of a member's role: maintainers are listed first, the rest are members.
    const maintainers = filter === 'all' ? new Set((await collect(a, `${base}/members?role=maintainer`, MAX_LIST, missing)).map((u) => lower(u.login))) : new Set<string>();
    const members = await collect(a, `${base}/members${filter === 'all' ? '' : `?role=${enc(filter)}`}`, limit, missing);
    return members.map((u) => result(String(u.login), target, 'role', filter === 'all' ? (maintainers.has(lower(u.login)) ? 'maintainer' : 'member') : filter, 'active', false));
  }
  const username = requireString(ctx, 'username', 'Username', i);
  const membershipPath = `${base}/memberships/${enc(username)}`;
  const current = async (): Promise<{ role: string; state: string } | undefined> => {
    const response = await sendOrMissing(a, 'GET', membershipPath);
    if (response) return { role: String(body(response).role), state: String(body(response).state) };
    // 404: not on the team, or the team or the user is not there: say which.
    await assertTeam(a, org, slug);
    await assertUser(a, username);
    return undefined;
  };
  switch (operation) {
    case 'get': {
      const now = await current();
      return now ? result(username, target, 'role', now.role, now.state, false) : result(username, target, 'role', null, 'none', false);
    }
    case 'add': {
      const role = ctx.getNodeParameter<string>('teamRole', i, 'member');
      if (role !== 'member' && role !== 'maintainer') throw new NodeOperationError(`Team Role must be member or maintainer, got "${role}"`, { itemIndex: i });
      const now = await current();
      if (now && now.role === role) return result(username, target, 'role', role, now.state, false);
      const put = await send(a, 'PUT', membershipPath, { role });
      return result(username, target, 'role', role, String(body(put).state ?? 'active'), true);
    }
    case 'remove': {
      if (!(await current())) return result(username, target, 'role', null, 'none', false);
      await send(a, 'DELETE', membershipPath);
      return result(username, target, 'role', null, 'none', true);
    }
  }
  throw unsupported('teamMembership', operation);
}

// ---------------------------------------------------------------------------
// Organization membership and invitations
// ---------------------------------------------------------------------------

/** GitHub's invitation roles in the words membership uses. */
const orgRoleName = (role: unknown) => (role === 'direct_member' ? 'member' : String(role));

async function createInvitation(a: Access, org: string, payload: JsonObject): Promise<JsonObject> {
  const response = await rawCall(a.api, a.credentials, 'POST', `/orgs/${enc(org)}/invitations`, payload);
  if (response.status === 404) {
    await assertOrg(a, org);
    throw new NodeOperationError(`GitHub could not find what to invite to the organization "${org}"`);
  }
  if (!response.ok) throw apiError(a.api, response as GitHubResponse<any>, accessHint);
  return body(response);
}

async function orgOperation(ctx: IExecuteContext, a: Access, operation: string, i: number): Promise<JsonObject> {
  const org = requireString(ctx, 'org', 'Organization', i);
  const base = `/orgs/${enc(org)}`;
  const username = optionalString(ctx, 'username', i);
  const email = optionalString(ctx, 'email', i);
  const membership = async (login: string): Promise<{ role: string; state: string } | undefined> => {
    const response = await sendOrMissing(a, 'GET', `${base}/memberships/${enc(login)}`);
    if (response) return { role: String(body(response).role), state: String(body(response).state) };
    await assertOrg(a, org);
    await assertUser(a, login);
    return undefined;
  };
  const openInvitations = () => collect(a, `${base}/invitations`, MAX_LIST, () => assertOrg(a, org));
  const needUser = () => requireString(ctx, 'username', 'Username', i);

  switch (operation) {
    case 'get': {
      const login = needUser();
      const now = await membership(login);
      return now ? result(login, org, 'role', now.role, now.state, false) : result(login, org, 'role', null, 'none', false);
    }
    case 'invite': {
      if (!username && !email) throw new NodeOperationError('Username or Email is required', { itemIndex: i });
      if (username && email) throw new NodeOperationError('Give either a Username or an Email, not both', { itemIndex: i });
      const orgRole = ctx.getNodeParameter<string>('orgRole', i, 'direct_member');
      if (orgRole !== 'direct_member' && orgRole !== 'admin') throw new NodeOperationError(`Organization Role must be direct_member or admin, got "${orgRole}"`, { itemIndex: i });
      if (username) {
        const id = await userId(a, username);
        const now = await membership(username);
        if (now) return result(username, org, 'role', now.role, now.state, false);
        const created = await createInvitation(a, org, { invitee_id: id, role: orgRole });
        return result(username, org, 'role', orgRoleName(created.role ?? orgRole), 'pending', true, { invitationId: created.id ?? null });
      }
      const open = (await openInvitations()).find((inv) => lower(inv.email) === lower(email));
      if (open) return result(email, org, 'role', orgRoleName(open.role), 'pending', false, { invitationId: open.id ?? null });
      const created = await createInvitation(a, org, { email, role: orgRole });
      return result(email, org, 'role', orgRoleName(created.role ?? orgRole), 'pending', true, { invitationId: created.id ?? null });
    }
    case 'remove': {
      const login = needUser();
      if (!(await membership(login))) return result(login, org, 'role', null, 'none', false);
      // For an active member this removes them from the organization and its teams; for an invitee it cancels the invitation.
      await send(a, 'DELETE', `${base}/memberships/${enc(login)}`);
      return result(login, org, 'role', null, 'none', true);
    }
    case 'cancelInvitation': {
      const id = Number(ctx.getNodeParameter<unknown>('invitationId', i, 0)) || 0;
      if (!id && !username && !email) throw new NodeOperationError('Username, Email or Invitation ID is required', { itemIndex: i });
      const who = username || email || null;
      let target = id;
      if (!target) {
        const found = (await openInvitations()).find((inv) => (username ? lower(inv.login) === lower(username) : lower(inv.email) === lower(email)));
        if (!found) return result(who, org, 'role', null, 'none', false);
        target = Number(found.id);
      }
      const response = await rawCall(a.api, a.credentials, 'DELETE', `${base}/invitations/${target}`);
      if (response.status === 404) return result(who, org, 'role', null, 'none', false);
      if (!response.ok) throw apiError(a.api, response as GitHubResponse<any>, accessHint);
      return result(who, org, 'role', null, 'none', true);
    }
  }
  throw unsupported('orgMembership', operation);
}

// ---------------------------------------------------------------------------
// Repository collaborators
// ---------------------------------------------------------------------------

/** What people ask for (`pull`…`admin`, as the collaborator PUT takes it) and what GitHub reports (`read`, `write`…). */
const PERMISSIONS = ['pull', 'triage', 'push', 'maintain', 'admin'];
const fromGitHub = (role: unknown): string | null => {
  const name = String(role ?? '');
  if (!name || name === 'none') return null;
  return name === 'read' ? 'pull' : name === 'write' ? 'push' : name;
};

async function collaboratorOperation(ctx: IExecuteContext, a: Access, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  const owner = requireString(ctx, 'owner', 'Owner', i);
  const repository = requireString(ctx, 'repository', 'Repository', i);
  const repo = repoPath(owner, repository);
  const target = `${owner}/${repository}`;
  const missingRepo = () => assertRepo(a, owner, repository);
  const invitations = () => collect(a, `${repo}/invitations`, MAX_LIST, missingRepo);
  const inviteeOf = (inv: JsonObject) => String(((inv.invitee ?? {}) as JsonObject).login ?? '');

  if (operation === 'getMany') {
    const affiliation = ctx.getNodeParameter<string>('affiliation', i, 'all');
    const limit = listLimit(ctx, i);
    const people = await collect(a, `${repo}/collaborators?affiliation=${enc(affiliation)}`, limit, missingRepo);
    const out = people.map((u) => result(String(u.login), target, 'permission', fromGitHub(u.role_name), 'active', false));
    if (ctx.getNodeParameter<boolean>('includeInvited', i, true) && out.length < limit) {
      for (const inv of await invitations()) {
        if (out.length >= limit) break;
        out.push(result(inviteeOf(inv), target, 'permission', fromGitHub(inv.permissions), 'pending', false, { invitationId: inv.id ?? null }));
      }
    }
    return out;
  }

  const username = requireString(ctx, 'username', 'Username', i);
  const path = `${repo}/collaborators/${enc(username)}`;
  /** The permission now (or none), and an open invitation when there is no permission yet. */
  const current = async (): Promise<{ permission: string | null; invitation?: JsonObject }> => {
    const response = await sendOrMissing(a, 'GET', `${path}/permission`);
    if (!response) {
      await missingRepo();
      await assertUser(a, username);
      throw new NodeOperationError(`GitHub could not read the permission of "${username}" on ${target}`);
    }
    const permission = fromGitHub(body(response).role_name ?? body(response).permission);
    if (permission) return { permission };
    const invitation = (await invitations()).find((inv) => lower(inviteeOf(inv)) === lower(username));
    return { permission: null, ...(invitation && { invitation }) };
  };

  switch (operation) {
    case 'getPermission': {
      const now = await current();
      if (now.permission) return result(username, target, 'permission', now.permission, 'active', false);
      if (now.invitation) return result(username, target, 'permission', fromGitHub(now.invitation.permissions), 'pending', false, { invitationId: now.invitation.id ?? null });
      return result(username, target, 'permission', null, 'none', false);
    }
    case 'add': {
      const permission = ctx.getNodeParameter<string>('permission', i, 'pull');
      if (!PERMISSIONS.includes(permission)) throw new NodeOperationError(`Permission must be one of ${PERMISSIONS.join(', ')}, got "${permission}"`, { itemIndex: i });
      const now = await current();
      if (now.permission === permission) return result(username, target, 'permission', permission, 'active', false);
      if (now.invitation && fromGitHub(now.invitation.permissions) === permission) {
        return result(username, target, 'permission', permission, 'pending', false, { invitationId: now.invitation.id ?? null });
      }
      const put = await send(a, 'PUT', path, { permission });
      // 201 with an invitation: the user is outside the organization (or the repository is personal) and must accept it; 204: added.
      if (put.status === 201) {
        return result(username, target, 'permission', permission, 'pending', true, {
          invitationId: body(put).id ?? null,
          note: 'GitHub sent an invitation: the person has access once they accept it.',
        });
      }
      return result(username, target, 'permission', permission, 'active', true);
    }
    case 'remove': {
      const now = await current();
      if (now.permission) {
        await send(a, 'DELETE', path);
        return result(username, target, 'permission', null, 'none', true);
      }
      if (now.invitation) {
        const response = await rawCall(a.api, a.credentials, 'DELETE', `${repo}/invitations/${Number(now.invitation.id)}`);
        if (!response.ok && response.status !== 404) throw apiError(a.api, response as GitHubResponse<any>, accessHint);
        return result(username, target, 'permission', null, 'none', response.ok);
      }
      return result(username, target, 'permission', null, 'none', false);
    }
  }
  throw unsupported('repoCollaborator', operation);
}

// ---------------------------------------------------------------------------
// Projects (v2) collaborators, over GraphQL
// ---------------------------------------------------------------------------

/** `https://api.github.com` → `…/graphql`; Enterprise Server `https://<host>/api/v3` → `https://<host>/api/graphql`. */
export function graphqlUrl(value: unknown): string {
  const base = baseUrl(value);
  return /\/api\/v3$/.test(base) ? base.replace(/\/api\/v3$/, '/api/graphql') : `${base}/graphql`;
}

interface GraphQlError {
  type?: string;
  message?: string;
}

/** A GraphQL call: transport failures and HTTP errors are node errors; GraphQL errors come back for the caller to read. */
async function graphql(a: Access, query: string, variables: JsonObject): Promise<{ data: JsonObject | null; errors: GraphQlError[] }> {
  const response = await rawCall(a.api, { ...a.credentials, baseUrl: graphqlUrl(a.credentials.baseUrl) }, 'POST', '', { query, variables });
  if (!response.ok) throw apiError(a.api, response as GitHubResponse<any>, accessHint);
  const reply = (response.body ?? {}) as { data?: JsonObject | null; errors?: GraphQlError[] };
  return { data: reply.data ?? null, errors: reply.errors ?? [] };
}

/** A GraphQL error that is not "not found" is a refusal (scopes, a role the project does not allow) and stops the node. */
function graphqlRefusal(errors: GraphQlError[]): NodeOperationError {
  const message = errors.map((e) => e.message).filter(Boolean).join('; ') || 'unknown error';
  const scopes = errors.some((e) => e.type === 'INSUFFICIENT_SCOPES' || e.type === 'FORBIDDEN');
  return new NodeOperationError(`GitHub API error: ${message}`, {
    description: scopes
      ? 'The token is not allowed to change this project. It needs the project scope (classic) or the Projects read and write permission (fine-grained), and its user must be an owner or admin of the project.'
      : 'GitHub refused the change: see the details above.',
  });
}

async function projectOperation(ctx: IExecuteContext, a: Access, operation: string, i: number): Promise<JsonObject> {
  if (operation !== 'add' && operation !== 'remove') throw unsupported('projectCollaborator', operation);
  const org = requireString(ctx, 'org', 'Organization', i);
  const number = Number(ctx.getNodeParameter<unknown>('projectNumber', i, 0));
  if (!Number.isInteger(number) || number < 1) throw new NodeOperationError('Project Number is required', { itemIndex: i });
  const username = requireString(ctx, 'username', 'Username', i);
  const target = `${org}/projects/${number}`;
  const role = operation === 'add' ? ctx.getNodeParameter<string>('projectRole', i, 'READER') : 'NONE';
  if (!['READER', 'WRITER', 'ADMIN', 'NONE'].includes(role)) throw new NodeOperationError(`Project Role must be READER, WRITER or ADMIN, got "${role}"`, { itemIndex: i });

  const project = await graphql(a, 'query($org: String!, $number: Int!) { organization(login: $org) { projectV2(number: $number) { id title } } }', { org, number });
  const organization = project.data?.organization as JsonObject | null | undefined;
  if (!organization) {
    if (project.errors.some((e) => e.type && e.type !== 'NOT_FOUND')) throw graphqlRefusal(project.errors);
    throw new NodeOperationError(`The organization "${org}" was not found`, { description: 'Check the organization’s login and that the token can see it.' });
  }
  const projectId = (organization.projectV2 as JsonObject | null)?.id;
  if (!projectId) throw new NodeOperationError(`The project ${number} was not found in the organization "${org}"`, { description: 'Use the number in the project’s URL (…/projects/7), and check the token can see the project.' });

  const user = await graphql(a, 'query($login: String!) { user(login: $login) { id } }', { login: username });
  const id = (user.data?.user as JsonObject | null)?.id;
  if (!id) {
    if (user.errors.some((e) => e.type && e.type !== 'NOT_FOUND')) throw graphqlRefusal(user.errors);
    throw new NodeOperationError(`There is no GitHub user "${username}"`, { description: 'Use the GitHub login (the name in the profile URL).' });
  }

  const mutation = await graphql(a, 'mutation($input: UpdateProjectV2CollaboratorsInput!) { updateProjectV2Collaborators(input: $input) { clientMutationId } }', {
    input: { projectId: String(projectId), collaborators: [{ userId: String(id), role }] },
  });
  if (mutation.errors.length) throw graphqlRefusal(mutation.errors);
  // GitHub sets the role and does not say whether it was already so, so `changed` is unknown (null), not a guess.
  return operation === 'add' ? result(username, target, 'role', role, 'active', null) : result(username, target, 'role', null, 'none', null);
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

const prop = (type: string | string[], description: string) => ({ type, description });
const ACCESS_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    user: prop(['string', 'null'], 'The GitHub login (or the email an invitation went to)'),
    target: prop('string', 'What access is to: org/team, org, owner/repo or org/projects/N'),
    role: prop(['string', 'null'], 'The role: member or maintainer (team), member or admin (organization), READER, WRITER or ADMIN (project); null when there is none'),
    permission: prop(['string', 'null'], 'The repository permission: pull, triage, push, maintain or admin; null when there is none'),
    state: prop('string', 'active, pending (an invitation is open) or none'),
    changed: prop(['boolean', 'null'], 'Whether this call changed anything; false when the user already had what was asked. Null for a project, where GitHub does not say'),
    invitationId: prop(['number', 'null'], 'The invitation’s id, when one is open'),
    note: prop('string', 'A hint, such as that GitHub sent an invitation'),
  },
  required: ['user', 'target', 'state', 'changed'],
};

const show = (resource: string[], operation?: string[]) => ({ show: { resource, ...(operation && { operation }) } });

/** A write: not an agent tool (an agent never grants access), safe to repeat. */
const write = (name: string, value: string, description: string, action: string) => ({ name, value, description, action, mcp: false as const, idempotent: true, outputSchema: ACCESS_SCHEMA });
const read = (name: string, value: string, description: string, action: string) => ({ name, value, description, action, idempotent: true, outputSchema: ACCESS_SCHEMA });

const operations = (resource: string, options: PropertyDescriptor['options'], def: string): PropertyDescriptor => ({
  name: 'operation',
  displayName: 'Operation',
  type: 'options',
  noDataExpression: true,
  default: def,
  displayOptions: show([resource]),
  options,
});

export const GitHubAccess = defineNode({
  description: {
    name: 'githubAccess',
    displayName: 'GitHub Access',
    description: 'Give and take back access on GitHub: teams, the organization, repository collaborators and projects',
    version: 1,
    kind: 'action',
    categories: ['Development'],
    icon: 'file:github.svg',
    color: '#24292f',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://docs.github.com/en/rest/teams/members',
    keywords: ['github', 'access', 'team', 'member', 'organization', 'invite', 'collaborator', 'permission', 'project', 'grant'],
    usableAsTool: true,
    idempotent: true,
    toolDescription:
      'Read who has access on GitHub: a team’s members or one membership, one person’s organization membership, a repository’s collaborators or one person’s permission. It cannot grant or remove access.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'githubApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'teamMembership',
        options: [
          { name: 'Organization Membership', value: 'orgMembership' },
          { name: 'Project (v2) Collaborator', value: 'projectCollaborator' },
          { name: 'Repository Collaborator', value: 'repoCollaborator' },
          { name: 'Team Membership', value: 'teamMembership' },
        ],
      },
      operations(
        'orgMembership',
        [
          read('Get Membership', 'get', 'Whether a user is a member (active), invited (pending) or neither, and their role', 'Get an organization membership'),
          write('Invite', 'invite', 'Invite a user by GitHub login or by email; nothing happens when they are a member or already invited', 'Invite to the organization'),
          write('Cancel Invitation', 'cancelInvitation', 'Withdraw an open invitation, by login, email or id', 'Cancel an organization invitation'),
          write('Remove Member', 'remove', 'Remove a member from the organization (and its teams), or withdraw their invitation', 'Remove from the organization'),
        ],
        'get',
      ),
      operations(
        'projectCollaborator',
        [
          write('Add Collaborator', 'add', 'Give a user a role on an organization project (v2), through GraphQL', 'Add a project collaborator'),
          write('Remove Collaborator', 'remove', 'Take a user’s role on an organization project (v2) away', 'Remove a project collaborator'),
        ],
        'add',
      ),
      operations(
        'repoCollaborator',
        [
          write('Add Collaborator', 'add', 'Give a user a permission on the repository; an outside user gets an invitation', 'Add a repository collaborator'),
          read('Get Collaborators', 'getMany', 'List a repository’s collaborators and, by default, its open invitations', 'Get repository collaborators'),
          read('Get Permission', 'getPermission', 'A user’s permission on the repository: pull, triage, push, maintain, admin, or none', 'Get a repository permission'),
          write('Remove Collaborator', 'remove', 'Take a user’s access to the repository away, or withdraw their invitation', 'Remove a repository collaborator'),
        ],
        'add',
      ),
      // The default resource's operation comes last: parameter defaults are keyed by name, last one wins.
      operations(
        'teamMembership',
        [
          write('Add Member', 'add', 'Add a user to a team with a role; nothing happens when they already have it', 'Add a team member'),
          read('Get Members', 'getMany', 'List a team’s members with their roles', 'Get team members'),
          read('Get Membership', 'get', 'Whether a user is on the team (active), invited (pending) or not, and their role', 'Get a team membership'),
          write('Remove Member', 'remove', 'Take a user off a team', 'Remove a team member'),
        ],
        'add',
      ),
      { name: 'org', displayName: 'Organization', type: 'string', required: true, default: '', placeholder: 'acme', displayOptions: show(['teamMembership', 'orgMembership', 'projectCollaborator']), description: 'The organization’s login' },
      { name: 'teamSlug', displayName: 'Team Slug', type: 'string', required: true, default: '', placeholder: 'platform', displayOptions: show(['teamMembership']), description: 'The team’s slug: the name in its URL' },
      { name: 'owner', displayName: 'Owner', type: 'string', required: true, default: '', placeholder: 'acme', displayOptions: show(['repoCollaborator']), description: 'The user or organization that owns the repository' },
      { name: 'repository', displayName: 'Repository', type: 'string', required: true, default: '', placeholder: 'widgets', displayOptions: show(['repoCollaborator']), description: 'The repository name, without the owner' },
      { name: 'projectNumber', displayName: 'Project Number', type: 'number', required: true, default: 0, displayOptions: show(['projectCollaborator']), description: 'The number in the project’s URL (…/projects/7)' },
      {
        name: 'username',
        displayName: 'Username',
        type: 'string',
        default: '',
        placeholder: 'octocat',
        description: 'The GitHub login. For Invite and Cancel Invitation you may give an email instead',
        displayOptions: show(['teamMembership', 'orgMembership', 'repoCollaborator', 'projectCollaborator']),
      },
      { name: 'email', displayName: 'Email', type: 'string', default: '', placeholder: 'person@example.com', displayOptions: show(['orgMembership'], ['invite', 'cancelInvitation']), description: 'Invite (or withdraw the invitation of) a person by email instead of a login' },
      { name: 'invitationId', displayName: 'Invitation ID', type: 'number', default: 0, displayOptions: show(['orgMembership'], ['cancelInvitation']), description: 'Withdraw this invitation; empty: find it by Username or Email' },
      {
        name: 'teamRole',
        displayName: 'Team Role',
        type: 'options',
        default: 'member',
        displayOptions: show(['teamMembership'], ['add']),
        options: [
          { name: 'Member', value: 'member' },
          { name: 'Maintainer', value: 'maintainer' },
        ],
      },
      {
        name: 'orgRole',
        displayName: 'Organization Role',
        type: 'options',
        default: 'direct_member',
        displayOptions: show(['orgMembership'], ['invite']),
        options: [
          { name: 'Member', value: 'direct_member' },
          { name: 'Owner (admin)', value: 'admin' },
        ],
      },
      {
        name: 'permission',
        displayName: 'Permission',
        type: 'options',
        default: 'pull',
        displayOptions: show(['repoCollaborator'], ['add']),
        description: 'An outside collaborator gets an invitation and has the permission once they accept',
        options: [
          { name: 'Read (pull)', value: 'pull' },
          { name: 'Triage', value: 'triage' },
          { name: 'Write (push)', value: 'push' },
          { name: 'Maintain', value: 'maintain' },
          { name: 'Admin', value: 'admin' },
        ],
      },
      {
        name: 'projectRole',
        displayName: 'Project Role',
        type: 'options',
        default: 'READER',
        displayOptions: show(['projectCollaborator'], ['add']),
        options: [
          { name: 'Reader', value: 'READER' },
          { name: 'Writer', value: 'WRITER' },
          { name: 'Admin', value: 'ADMIN' },
        ],
      },
      {
        name: 'roleFilter',
        displayName: 'Role',
        type: 'options',
        default: 'all',
        displayOptions: show(['teamMembership'], ['getMany']),
        options: [
          { name: 'All', value: 'all' },
          { name: 'Members', value: 'member' },
          { name: 'Maintainers', value: 'maintainer' },
        ],
      },
      {
        name: 'affiliation',
        displayName: 'Affiliation',
        type: 'options',
        default: 'all',
        displayOptions: show(['repoCollaborator'], ['getMany']),
        options: [
          { name: 'All', value: 'all' },
          { name: 'Direct', value: 'direct', description: 'Added to the repository itself' },
          { name: 'Outside', value: 'outside', description: 'Not members of the organization' },
        ],
      },
      { name: 'includeInvited', displayName: 'Include Open Invitations', type: 'boolean', default: true, displayOptions: show(['repoCollaborator'], ['getMany']), description: 'Whether to add the people who were invited and have not accepted, with state pending' },
      { name: 'returnAll', displayName: 'Return All', type: 'boolean', default: false, displayOptions: show(['teamMembership', 'repoCollaborator'], ['getMany']) },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { resource: ['teamMembership', 'repoCollaborator'], operation: ['getMany'], returnAll: [false] } },
        description: 'Max number of people to return',
      },
    ],
  },

  async execute(ctx) {
    const credentials = ctx.getCredentials<GitHubCredentials>('githubApi');
    const access: Access = { api: { http: ctx.http, metrics: ctx.metrics }, credentials };
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      switch (resource) {
        case 'teamMembership':
          return teamOperation(ctx, access, operation, i);
        case 'orgMembership':
          return orgOperation(ctx, access, operation, i);
        case 'repoCollaborator':
          return collaboratorOperation(ctx, access, operation, i);
        case 'projectCollaborator':
          return projectOperation(ctx, access, operation, i);
      }
      throw unsupported(resource, operation);
    });
  },
});
