/**
 * The access half of the fake GitHub: organization and team membership, organization invitations, repository
 * collaborators and invitations, and Projects (v2) over GraphQL. Stateful, so a test adds a member and then reads it
 * back; the answers (statuses, bodies, the pending state of a user outside the organization) follow GitHub's REST docs.
 * Fake logins and ids only.
 */
import type { FakeReply, FakeRequest } from './helpers';

export const ORG = 'acme';
export const TEAM = 'platform';
export const PROJECT_NUMBER = 7;

const notFound = (): FakeReply => ({ status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } });
const noContent = (): FakeReply => ({ status: 204 });

/** GitHub's legacy `permission` for a role name. */
const LEGACY: Record<string, string> = { read: 'read', triage: 'read', write: 'write', maintain: 'write', admin: 'admin' };
/** What the collaborator PUT takes, as the role GitHub reports. */
const PUT_ROLE: Record<string, string> = { pull: 'read', triage: 'triage', push: 'write', maintain: 'maintain', admin: 'admin' };

interface OrgInvitation {
  id: number;
  login: string | null;
  email: string | null;
  role: string;
  invitee_id: number | null;
}
interface RepoInvitation {
  id: number;
  login: string;
  permissions: string;
}

export class FakeAccess {
  /** Every GitHub account that exists, with an id. */
  users = new Map<string, number>();
  /** Members of the organization: login → `member` | `admin`. */
  orgMembers = new Map<string, string>();
  orgInvitations: OrgInvitation[] = [];
  /** Teams of the organization: slug → members (login → role, state). */
  teams = new Map<string, Map<string, { role: string; state: string }>>();
  /** Collaborators of acme/widgets: login → role name (read, triage, write, maintain, admin). */
  collaborators = new Map<string, string>();
  repoInvitations: RepoInvitation[] = [];
  /** The organization's project: collaborators login → READER | WRITER | ADMIN. */
  projectRoles = new Map<string, string>();
  /** What every organization member can do on the repository without being a collaborator (the org's base permission). */
  orgBasePermission: 'read' | 'none' = 'read';
  private nextId = 5000;

  constructor(private readonly repo: string) {
    this.reset();
  }

  reset() {
    this.users = new Map([['alice', 1], ['bob', 2], ['carol', 3], ['dave', 4], ['octo-bot', 9], ['outsider', 5]]);
    this.orgMembers = new Map([['alice', 'admin'], ['bob', 'member'], ['carol', 'member'], ['octo-bot', 'admin']]);
    this.orgInvitations = [];
    this.teams = new Map([[TEAM, new Map([['alice', { role: 'maintainer', state: 'active' }]])], ['empty', new Map()]]);
    this.collaborators = new Map([['alice', 'admin'], ['bob', 'write']]);
    this.repoInvitations = [];
    this.projectRoles = new Map();
    this.nextId = 5000;
    this.orgBasePermission = 'read';
  }

  /** A team of `count` members (member-000…), for the paging tests; the first two are maintainers. */
  seedTeam(slug: string, count: number) {
    const members = new Map<string, { role: string; state: string }>();
    for (let n = 0; n < count; n++) {
      const login = `member-${String(n).padStart(3, '0')}`;
      this.users.set(login, 100 + n);
      this.orgMembers.set(login, 'member');
      members.set(login, { role: n < 2 ? 'maintainer' : 'member', state: 'active' });
    }
    this.teams.set(slug, members);
  }

  /** A reply when the path is one of the access endpoints, else undefined. `path` has no API prefix. */
  handle(req: FakeRequest, path: string): FakeReply | undefined {
    if (path === '/graphql') return this.graphql(req);
    let m = /^\/users\/([^/]+)$/.exec(path);
    if (m) {
      const login = decodeURIComponent(m[1]).toLowerCase();
      const id = this.users.get(login);
      return id ? { body: { login, id, type: 'User' } } : notFound();
    }
    m = /^\/orgs\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      if (decodeURIComponent(m[1]) !== ORG) return notFound();
      return this.org(req, decodeURIComponent(m[2] ?? ''));
    }
    m = /^\/repos\/([^/]+)\/([^/]+)(\/(?:collaborators|invitations)(?:\/.*)?)$/.exec(path);
    if (m) {
      if (`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` !== this.repo) return notFound();
      return this.collaboratorRoutes(req, decodeURIComponent(m[3]));
    }
    return undefined;
  }

  private page<T>(req: FakeRequest, all: T[]): T[] {
    const page = Number(req.query.get('page') ?? 1);
    const per = Number(req.query.get('per_page') ?? 30);
    return all.slice((page - 1) * per, page * per);
  }

  private org(req: FakeRequest, rest: string): FakeReply {
    const { method } = req;
    const body = req.body ?? {};
    if (rest === '') return { body: { login: ORG } };

    let m = /^\/teams\/([^/]+)(\/.*)?$/.exec(rest);
    if (m) {
      const team = this.teams.get(m[1]);
      if (!team) return notFound();
      const tail = m[2] ?? '';
      if (tail === '') return { body: { slug: m[1], name: m[1] } };
      if (tail === '/members' && method === 'GET') {
        const role = req.query.get('role') ?? 'all';
        const rows = [...team].filter(([, v]) => v.state === 'active' && (role === 'all' || v.role === role)).map(([login]) => ({ login, id: this.users.get(login) }));
        return { body: this.page(req, rows) };
      }
      const user = /^\/memberships\/([^/]+)$/.exec(tail);
      if (user) {
        // GitHub logins are case-insensitive.
        const login = user[1].toLowerCase();
        if (!this.users.has(login)) return notFound();
        if (method === 'GET') {
          // An organization owner is a maintainer of every team, listed or not.
          const membership = team.get(login) ?? (this.orgMembers.get(login) === 'admin' ? { role: 'maintainer', state: 'active' } : undefined);
          return membership ? { body: { url: 'x', role: membership.role, state: membership.state } } : notFound();
        }
        if (method === 'PUT') {
          const role = body.role ?? 'member';
          if (role !== 'member' && role !== 'maintainer') return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Membership', field: 'role', code: 'invalid' }] } };
          // A user outside the organization gets an invitation: the membership is pending until they accept.
          const state = this.orgMembers.has(login) ? 'active' : 'pending';
          team.set(login, { role, state });
          return { body: { url: 'x', role, state } };
        }
        if (method === 'DELETE') {
          team.delete(login);
          return noContent();
        }
      }
      return notFound();
    }

    m = /^\/memberships\/([^/]+)$/.exec(rest);
    if (m) {
      const login = m[1].toLowerCase();
      if (!this.users.has(login)) return notFound();
      if (method === 'GET') {
        const role = this.orgMembers.get(login);
        if (role) return { body: { state: 'active', role, user: { login } } };
        const invitation = this.orgInvitations.find((i) => i.login === login);
        return invitation ? { body: { state: 'pending', role: invitation.role === 'admin' ? 'admin' : 'member', user: { login } } } : notFound();
      }
      if (method === 'DELETE') {
        const had = this.orgMembers.delete(login);
        const before = this.orgInvitations.length;
        this.orgInvitations = this.orgInvitations.filter((i) => i.login !== login);
        for (const team of this.teams.values()) team.delete(login);
        return had || before !== this.orgInvitations.length ? noContent() : notFound();
      }
    }

    if (rest === '/invitations' && method === 'GET') {
      return { body: this.page(req, this.orgInvitations.map((i) => ({ id: i.id, login: i.login, email: i.email, role: i.role }))) };
    }
    if (rest === '/invitations' && method === 'POST') {
      const role = body.role ?? 'direct_member';
      if (!['direct_member', 'admin', 'billing_manager', 'reinstate'].includes(role)) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Invitation', field: 'role', code: 'invalid' }] } };
      let login: string | null = null;
      if (body.invitee_id !== undefined) {
        login = [...this.users].find(([, id]) => id === body.invitee_id)?.[0] ?? null;
        if (!login) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Invitation', field: 'invitee_id', code: 'invalid' }] } };
      } else if (!body.email || !String(body.email).includes('@')) {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Invitation', field: 'email', code: 'invalid' }] } };
      }
      if (login && this.orgMembers.has(login)) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Invitation', code: 'already_a_member', message: `${login} is already a part of this organization` }] } };
      const invitation = { id: this.nextId++, login, email: body.email ?? null, role: role === 'admin' ? 'admin' : 'direct_member', invitee_id: body.invitee_id ?? null };
      this.orgInvitations.push(invitation);
      return { status: 201, body: { id: invitation.id, login, email: invitation.email, role: invitation.role } };
    }
    m = /^\/invitations\/(\d+)$/.exec(rest);
    if (m && method === 'DELETE') {
      const before = this.orgInvitations.length;
      this.orgInvitations = this.orgInvitations.filter((i) => i.id !== Number(m![1]));
      return before === this.orgInvitations.length ? notFound() : noContent();
    }
    return notFound();
  }

  /** Org members are added to an organization's repository directly; anyone else is invited. */
  private collaboratorRoutes(req: FakeRequest, rest: string): FakeReply {
    const { method } = req;
    const body = req.body ?? {};
    if (rest === '/collaborators' && method === 'GET') {
      const affiliation = req.query.get('affiliation') ?? 'all';
      // Direct: added to the repository itself (every row here); outside: those who are not organization members.
      const rows = [...this.collaborators]
        .filter(([login]) => affiliation !== 'outside' || !this.orgMembers.has(login))
        .map(([login, role]) => ({ login, id: this.users.get(login), role_name: role, permissions: { admin: role === 'admin' } }));
      return { body: this.page(req, rows) };
    }
    let m = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
    if (m && method === 'GET') {
      const login = m[1].toLowerCase();
      if (!this.users.has(login)) return notFound();
      // The effective permission: the direct role, else the organization's base permission for a member.
      const role = this.collaborators.get(login) ?? (this.orgMembers.has(login) && this.orgBasePermission !== 'none' ? this.orgBasePermission : undefined);
      return { body: { permission: role ? LEGACY[role] : 'none', role_name: role ?? 'none', user: { login, id: this.users.get(login) } } };
    }
    m = /^\/collaborators\/([^/]+)$/.exec(rest);
    if (m) {
      const login = m[1].toLowerCase();
      if (method === 'PUT') {
        if (!this.users.has(login)) return notFound();
        const permission = body.permission ?? 'push';
        const role = PUT_ROLE[permission];
        if (!role) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'permission', code: 'invalid' }] } };
        if (this.orgMembers.has(login) || this.collaborators.has(login)) {
          this.collaborators.set(login, role);
          return noContent();
        }
        // An outside user is invited and becomes a collaborator when they accept.
        const existing = this.repoInvitations.find((i) => i.login === login);
        if (existing) existing.permissions = role === 'write' ? 'write' : role === 'read' ? 'read' : role;
        else this.repoInvitations.push({ id: this.nextId++, login, permissions: role });
        const invitation = this.repoInvitations.find((i) => i.login === login)!;
        return { status: 201, body: { id: invitation.id, invitee: { login }, permissions: invitation.permissions } };
      }
      if (method === 'DELETE') {
        this.collaborators.delete(login);
        return noContent();
      }
    }
    if (rest === '/invitations' && method === 'GET') {
      return { body: this.page(req, this.repoInvitations.map((i) => ({ id: i.id, invitee: { login: i.login }, permissions: i.permissions }))) };
    }
    m = /^\/invitations\/(\d+)$/.exec(rest);
    if (m && method === 'DELETE') {
      const before = this.repoInvitations.length;
      this.repoInvitations = this.repoInvitations.filter((i) => i.id !== Number(m![1]));
      return before === this.repoInvitations.length ? notFound() : noContent();
    }
    return notFound();
  }

  /** The three GraphQL documents the node sends: the project's id, a user's id and updateProjectV2Collaborators. */
  private graphql(req: FakeRequest): FakeReply {
    const query = String(req.body?.query ?? '');
    const variables = (req.body?.variables ?? {}) as Record<string, any>;
    if (query.includes('updateProjectV2Collaborators')) {
      const input = variables.input ?? {};
      if (input.projectId !== `PVT_${PROJECT_NUMBER}`) return { body: { data: null, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a ProjectV2 with the id '${input.projectId}'.` }] } };
      for (const c of input.collaborators ?? []) {
        const login = [...this.users].find(([, id]) => `U_${id}` === c.userId)?.[0];
        if (!login) return { body: { data: null, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${c.userId}'.` }] } };
        if (c.role === 'NONE') this.projectRoles.delete(login);
        else this.projectRoles.set(login, c.role);
      }
      return { body: { data: { updateProjectV2Collaborators: { clientMutationId: null } } } };
    }
    if (query.includes('projectV2(')) {
      if (variables.org !== ORG) return { body: { data: { organization: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an Organization with the login of '${variables.org}'.` }] } };
      return { body: { data: { organization: { projectV2: variables.number === PROJECT_NUMBER ? { id: `PVT_${PROJECT_NUMBER}`, title: 'Roadmap' } : null } } } };
    }
    if (query.includes('user(login')) {
      const id = this.users.get(String(variables.login).toLowerCase());
      return { body: id ? { data: { user: { id: `U_${id}` } } } : { data: { user: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a User with the login of '${variables.login}'.` }] } };
    }
    return { status: 400, body: { message: 'unknown query' } };
  }
}
