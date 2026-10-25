/**
 * Sign-in and access control: roles, API key scopes and the one place role checks live (`can`), shared by the
 * server (route guard, routes) and the client (which hides what a role can't do). No runtime imports.
 *
 * Roles: the owner (exactly one, created at setup) and admins manage users, settings, credential sharing and the
 * instance MCP server; members build and run workflows and see everything (projects and sharing come in Wave 4).
 */

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
/** Roles an invite or a role change may assign (there is one owner, set at setup). */
export const ASSIGNABLE_ROLES = ['admin', 'member'] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** What an API key may do. `admin` includes every other scope (and admin-only routes, if its user is an admin). */
export const API_KEY_SCOPES = ['workflows:read', 'workflows:write', 'executions:read', 'executions:write', 'run', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'workflows:read': 'Read workflows, data tables and variables',
  'workflows:write': 'Create, change and delete workflows and data tables',
  'executions:read': 'Read executions and live events',
  'executions:write': 'Stop and delete executions',
  run: 'Run workflows, retry and re-run executions',
  admin: 'Everything, including settings, credentials and plugins',
};

/** Whether `scopes` grant `needed` (`admin` grants everything). */
export function hasScope(scopes: readonly ApiKeyScope[], needed: ApiKeyScope): boolean {
  return scopes.includes('admin') || scopes.includes(needed);
}

/** Things only some roles may do. Anything not listed here is open to every signed-in user. */
export type Action =
  | 'users:manage'
  | 'settings:manage'
  | 'credentials:share'
  | 'mcp:manage'
  | 'plugins:manage'
  | 'variables:manage'
  /** Take over a workflow someone else has open in the editor. */
  | 'workflows:takeover'
  /** Create API keys with the `admin` scope. */
  | 'apiKeys:admin';

const ADMINS: readonly Role[] = ['owner', 'admin'];

const ALLOWED: Record<Action, readonly Role[]> = {
  'users:manage': ADMINS,
  'settings:manage': ADMINS,
  'credentials:share': ADMINS,
  'mcp:manage': ADMINS,
  'plugins:manage': ADMINS,
  'variables:manage': ADMINS,
  'workflows:takeover': ADMINS,
  'apiKeys:admin': ADMINS,
};

/** The role check: whether `user` may do `action`. */
export function can(user: { role: Role } | null | undefined, action: Action): boolean {
  return Boolean(user && ALLOWED[action].includes(user.role));
}

/** A change one user makes to another in Settings → Users. */
export type UserChange = { kind: 'role'; role: Role } | { kind: 'remove' } | { kind: 'reset-password' };

/**
 * Whether `actor` may make `change` to `target`. Owners and admins manage users, but nobody changes or removes the
 * owner (or themselves, apart from their own password), nobody makes another owner, and only the owner manages admins.
 */
export function canManageUser(actor: { id: string; role: Role } | null | undefined, target: { id: string; role: Role }, change: UserChange): boolean {
  if (!actor || !can(actor, 'users:manage')) return false;
  if (target.role === 'owner') return false;
  if (actor.id === target.id) return change.kind === 'reset-password';
  if (change.kind === 'role' && change.role === 'owner') return false;
  if (actor.role !== 'owner' && (target.role === 'admin' || (change.kind === 'role' && change.role === 'admin'))) return false;
  return true;
}

/** The signed-in user as pages and the client see them. */
export interface Viewer {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Signed in through single sign-on (OIDC) at least once. */
  sso: boolean;
  /** Has a Landflow password (SSO-only users don't). */
  hasPassword: boolean;
}

/** A user in Settings → Users (GET /api/users). */
export interface UserView extends Viewer {
  createdAt: string;
  lastLoginAt?: string;
}

/** A pending invite (admins only). */
export interface InviteView {
  id: string;
  email: string;
  role: AssignableRole;
  createdAt: string;
  expiresAt: string;
  invitedBy?: string;
}

/** POST /api/users/invites and POST /api/users/<id>/password-reset: the link (shown to copy) and whether it was emailed. */
export interface LinkResponse {
  link: string;
  emailed: boolean;
  /** Why it wasn't emailed: SMTP isn't configured, or sending failed (the message). */
  emailError?: string;
}

/** An API key as listed (the key itself is shown once, when it is created). */
export interface ApiKeyView {
  id: string;
  label: string;
  /** The key's last characters, to tell keys apart. */
  hint: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

/** GET /api/auth/status: what the sign-in pages need (public). */
export interface AuthStatus {
  setupRequired: boolean;
  /** Single sign-on is configured: the button's label. */
  oidc?: { label: string };
  /** Invites and password resets go out by email. */
  smtp: boolean;
}

/** GET /api/settings/security (admins): sign-in configuration, for Settings → Security. */
export interface SecurityView {
  oidc: {
    configured: boolean;
    issuer?: string;
    clientId?: string;
    label: string;
    redirectUrl?: string;
    roleClaim: string;
    roleMap: Record<string, string>;
    defaultRole: string;
    /** Discovery worked (only checked when configured). */
    reachable?: boolean;
    error?: string;
  };
  smtp: { configured: boolean; host?: string; port?: number; from?: string };
  sessionHours: number;
  registrySecret: boolean;
  metricsPublic: boolean;
}

/** Someone has a workflow open in the editor (GET/POST /api/workflows/<id>/lock, and `lock` events on /api/events). */
export interface EditLockView {
  workflowId: string;
  userId: string;
  userName: string;
  /** The editor tab holding it (one user can have the workflow open in two tabs). */
  tabId: string;
  since: string;
  expiresAt: string;
}

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
