/**
 * Sign-in and access control: roles, API key scopes and the one place role checks live (`can`), shared by the
 * server (route guard, routes) and the client (which hides what a role can't do). No runtime imports.
 *
 * Roles: the owner (exactly one, created at setup) and admins manage users, settings, team projects and the
 * instance MCP server, and see everything; members build and run workflows in the projects they belong to (their
 * personal project and team projects) and what is shared with them (lib/shared/projects.ts).
 */

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
/** Roles an invite or a role change may assign (there is one owner, set at setup). */
export const ASSIGNABLE_ROLES = ['admin', 'member'] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** What an API key may do. `admin` includes every other scope (and admin-only routes, if its user is an admin). */
export const API_KEY_SCOPES = ['workflows:read', 'workflows:write', 'executions:read', 'executions:write', 'run', 'admin', 'scim', 'audit:read', 'brain:read', 'brain:write', 'harness:write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'workflows:read': 'Read workflows, data tables and variables',
  'workflows:write': 'Create, change and delete workflows and data tables',
  'executions:read': 'Read executions and live events',
  'executions:write': 'Stop and delete executions',
  run: 'Run workflows, retry and re-run executions',
  admin: 'Everything, including settings, credentials and plugins',
  scim: 'SCIM provisioning by an identity provider (Okta, Entra ID); nothing else',
  'brain:read': 'Brain: read your briefing and ask',
  'brain:write': 'Brain: record your work',
  'harness:write': 'Send harness status (Claude Code hooks)',
  'audit:read': 'Read and export the audit log (owners and admins: every event; project admins: their projects’ events)',
};

/** Whether `scopes` grant `needed` (`admin` grants everything). */
export function hasScope(scopes: readonly ApiKeyScope[], needed: ApiKeyScope): boolean {
  // Recording your work (`brain:write`) includes reading your briefing (`brain:read`).
  return scopes.includes('admin') || scopes.includes(needed) || (needed === 'brain:read' && scopes.includes('brain:write'));
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
  | 'apiKeys:admin'
  /** Create team projects (and see and manage every project). */
  | 'projects:manage'
  /** Create SCIM tokens (API keys with the `scim` scope). */
  | 'scim:manage'
  /** Read and export the audit log, see its settings. */
  | 'audit:read';

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
  'projects:manage': ADMINS,
  'scim:manage': ADMINS,
  'audit:read': ADMINS,
};

/** Every action, for the role editor and for validating a custom role's rules (C32). */
export const ACTIONS = Object.keys(ALLOWED) as readonly Action[];

/**
 * What a custom role may grant: every action but `projects:manage`, which also means "admin of every project" and so
 * would make its holder an instance admin for project access (C32-D2).
 */
export const GRANTABLE_ACTIONS: readonly Action[] = ACTIONS.filter((action) => action !== 'projects:manage');

/**
 * Granted through a custom role only by the owner (decided 2026-11-23). `users:manage` and `apiKeys:admin` let their
 * holder change who may do what; `scim:manage` lets a token rewrite users and groups; `plugins:manage` installs code that
 * runs on the host with the host's access to the data directory; `settings:manage` changes instance settings, security,
 * source control and environments, which reach every project.
 */
export const OWNER_ONLY_GRANTS: readonly Action[] = ['users:manage', 'apiKeys:admin', 'scim:manage', 'plugins:manage', 'settings:manage'];

/**
 * The actions of a stored role's `rules` text (JSON `[{ action, effect: 'allow' }]`): unknown actions (a role saved by an
 * older or newer build) and `projects:manage` are dropped and repeats merged, so a bad row can only ever grant less;
 * anything that isn't JSON grants nothing.
 */
export function parseStoredActions(text: string | null | undefined): Action[] {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<Action>();
  for (const entry of parsed as Array<{ action?: unknown; effect?: unknown }>) {
    const action = entry?.action as Action;
    if (entry?.effect === 'allow' && GRANTABLE_ACTIONS.includes(action)) seen.add(action);
  }
  return [...seen];
}

/**
 * The part of a user the role check reads: the built-in role, plus what a custom role grants, as the server's user
 * record carries it (`customRole.actions`) or the client's `Viewer` (`grants`).
 */
export interface RoleHolder {
  role: Role;
  grants?: readonly Action[];
  customRole?: { id?: string; name?: string; actions?: readonly Action[] };
}

/** The built-in owner or admin role itself (a custom role never counts): what instance-wide controls need. */
export const isBuiltInAdmin = (user: { role: Role } | null | undefined): boolean => user?.role === 'owner' || user?.role === 'admin';

/** The role check: whether `user` may do `action` (the built-in role allows it, or a custom role grants it). */
export function can(user: RoleHolder | null | undefined, action: Action): boolean {
  if (!user) return false;
  if (ALLOWED[action].includes(user.role)) return true;
  return Boolean(user.grants?.includes(action) || user.customRole?.actions?.includes(action));
}

/**
 * The escalation check (C32 FR-3): the actions in `wanted` that `actor` may not put in a custom role. Nobody grants
 * `projects:manage`; only the owner grants `users:manage` and `apiKeys:admin`; anyone else grants only what they hold.
 * An empty answer means the role is fine.
 */
export function ungrantable(actor: RoleHolder, wanted: readonly Action[]): Action[] {
  return wanted.filter((action) => {
    if (!GRANTABLE_ACTIONS.includes(action)) return true;
    if (actor.role === 'owner') return false;
    if (OWNER_ONLY_GRANTS.includes(action)) return true;
    return !can(actor, action);
  });
}

/** A change one user makes to another in Settings → Users. */
export type UserChange = { kind: 'role'; role: Role } | { kind: 'remove' } | { kind: 'reset-password' };

/**
 * Whether `actor` may make `change` to `target`. Owners and admins manage users, but nobody changes or removes the
 * owner (or themselves, apart from their own password), nobody makes another owner, and only the owner manages admins.
 */
export function canManageUser(actor: (RoleHolder & { id: string }) | null | undefined, target: { id: string; role: Role; customRole?: { actions?: readonly Action[] } }, change: UserChange): boolean {
  if (!actor || !can(actor, 'users:manage')) return false;
  if (target.role === 'owner') return false;
  // Not someone who holds actions the actor couldn't grant: resetting their password or removing them would be a way round the escalation check (C32).
  if (actor.role !== 'owner' && actor.id !== target.id && ungrantable(actor, target.customRole?.actions ?? []).length) return false;
  if (actor.id === target.id) return change.kind === 'reset-password';
  if (change.kind === 'role' && change.role === 'owner') return false;
  if (actor.role !== 'owner' && (target.role === 'admin' || (change.kind === 'role' && change.role === 'admin'))) return false;
  return true;
}

/**
 * Whether `actor` may reset `target`'s second factors (C16-D4, narrowed by C32): owners reset anyone's but their own; admins and
 * user managers reset members' only (an admin's are the owner's to reset); nobody uses this path on themselves (they use Sign-in & security).
 */
export function canResetMfa(actor: (RoleHolder & { id: string }) | null | undefined, target: { id: string; role: Role; customRole?: { actions?: readonly Action[] } }): boolean {
  if (!actor || !can(actor, 'users:manage') || actor.id === target.id) return false;
  if (actor.role === 'owner') return true;
  // Everyone else resets a member's second factors, and only a member who holds nothing the actor couldn't grant.
  return target.role === 'member' && ungrantable(actor, target.customRole?.actions ?? []).length === 0;
}

/** Second factors (C16). */
export type MfaMethod = 'webauthn' | 'totp' | 'recovery';

/** A factor as its owner sees it: never the secret. */
export interface MfaFactorView {
  id: string;
  kind: 'totp' | 'webauthn';
  name: string;
  /** Counts only once confirmed with a valid code. */
  confirmed: boolean;
  createdAt: string;
  lastUsedAt?: string;
  flagged?: boolean;
}

/** The 202 answer of POST /api/auth/login (and a reset) for a user with a second factor: no session yet. */
export interface MfaChallengeResponse {
  mfaRequired: true;
  methods: MfaMethod[];
  /** A single-use token, valid five minutes, good only for POST /api/auth/mfa/verify. */
  challenge: string;
}

/** GET /api/me/mfa: Sign-in & security. */
export interface MfaStateView {
  factors: MfaFactorView[];
  recoveryCodesLeft: number;
  /** LANDFLOW_MFA_REQUIRED. */
  mode: 'off' | 'admins' | 'all';
  /** The mode covers you. */
  covered: boolean;
  /** Covered, a local session and no factor yet: only this page works. */
  enrolmentRequired: boolean;
  /** The session passed a second-factor check in the last five minutes. */
  recentlyVerified: boolean;
  /** You have a password (single sign-on accounts use their provider's factor). */
  canEnrol: boolean;
}

/** The signed-in user as pages and the client see them. */
export interface Viewer {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Signed in through single sign-on (OIDC or SAML) at least once. */
  sso: boolean;
  /** Has a Landflow password (SSO-only users don't). */
  hasPassword: boolean;
  /** Deactivated (SCIM): can't sign in. */
  disabled?: boolean;
  /** Created by provisioning: `scim` or `saml`. */
  provisionedBy?: string;
  /** The custom role the user holds besides `member` (C32), and what it grants (`can` reads `grants`). */
  customRole?: { id: string; name: string };
  grants?: Action[];
}

/** A user in Settings → Users (GET /api/users). */
export interface UserView extends Viewer {
  /** Confirmed second factors (count). */
  mfaFactors?: number;
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
  /** Absent for someone who isn't an owner or admin: a reset link is emailed to the person, never shown. */
  link?: string;
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
  /** The address of the last use (written with `lastUsedAt`, so up to a minute behind): personal data, for the key's owner. */
  lastUsedIp?: string;
  /** Fixed at creation: the key only works from these addresses and ranges. */
  allowedIps?: string[];
  /** Fixed at creation: the key stops after this many uses. */
  maxUses?: number;
  /** Uses so far (only with `maxUses`). */
  uses?: number;
  /** `uses` reached `maxUses`: kept and listed until deleted. */
  usedUp?: boolean;
}

/** GET /api/auth/status: what the sign-in pages need (public). */
export interface AuthStatus {
  setupRequired: boolean;
  /** Single sign-on is configured: the button's label. */
  oidc?: { label: string };
  /** SAML sign-in is configured: the button's label. */
  saml?: { label: string };
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
  /** SAML 2.0 sign-in (lib/server/auth/saml.ts). */
  saml?: SamlSecurityView;
  /** SCIM 2.0 provisioning (lib/server/scim). */
  scim?: ScimSecurityView;
  /** LANDFLOW_MFA_REQUIRED (docs/features/authentication.md#second-factor). */
  mfa?: { mode: 'off' | 'admins' | 'all' };
  sessionHours: number;
  registrySecret: boolean;
  metricsPublic: boolean;
}

export interface SamlSecurityView {
  configured: boolean;
  label: string;
  /** Our entity id (the SP's issuer). */
  entityId?: string;
  /** Where the IdP posts responses. */
  acsUrl?: string;
  metadataUrl?: string;
  /** The IdP's single sign-on URL and entity id. */
  idpSsoUrl?: string;
  idpIssuer?: string;
  /** Single logout URL at the IdP, when configured. */
  idpSloUrl?: string;
  /** Signing certificates configured (count) and when the first expires. */
  idpCerts: number;
  idpCertExpires?: string;
  wantAssertionsSigned: boolean;
  /** Seconds of clock skew allowed. */
  clockSkewSeconds: number;
  emailAttribute: string;
  nameAttribute: string;
  roleAttribute: string;
  roleMap: Record<string, string>;
  defaultRole: string;
  projectAttribute: string;
  projectMap: Record<string, string>;
  /** Users are created on their first sign-in. */
  jit: boolean;
  /** Encrypted assertions: our decryption certificate (lib/server/auth/saml-keys.ts). */
  encryption?: SamlEncryptionView;
  /** Signing key rotation: the certificate we sign requests with and the next one (LANDFLOW_SAML_CERT / _NEXT_CERT), both in our metadata. */
  signing?: { current: SamlKeyInfo; next?: SamlKeyInfo };
  error?: string;
}

/** Settings → Security → SAML: the SP's decryption key (never shown) and certificate, for encrypted assertions. */
export interface SamlEncryptionView {
  configured: boolean;
  /** Generated here, uploaded, or LANDFLOW_SAML_DECRYPTION_KEY / _CERT (then Settings can't change it). */
  source?: 'generated' | 'uploaded' | 'env';
  fromEnv: boolean;
  /** Responses whose assertion isn't encrypted are refused. */
  required: boolean;
  subject?: string;
  validTo?: string;
  /** SHA-256, colon-separated hex. */
  fingerprint?: string;
  /** PEM, to give the IdP (it is also in our metadata). */
  certificate?: string;
  createdAt?: string;
  error?: string;
  /** Rotation: the next certificate, published in our metadata beside this one; the IdP can encrypt to either. */
  next?: SamlKeyInfo;
  /** The retired certificate after a switch-over: its key still decrypts, our metadata no longer offers it. */
  previous?: SamlKeyInfo;
}

/** A certificate kept for key rotation (the key never leaves the server). */
export interface SamlKeyInfo {
  source: 'generated' | 'uploaded' | 'env';
  subject?: string;
  validTo?: string;
  fingerprint?: string;
  certificate?: string;
  createdAt?: string;
  retiredAt?: string;
  error?: string;
}

export interface ScimSecurityView {
  /** The SCIM base URL to give the identity provider. */
  baseUrl: string;
  /** SCIM tokens (API keys with the `scim` scope) of every admin. */
  tokens: Array<ApiKeyView & { userName: string }>;
  /** No reverse proxy count is set (LANDFLOW_TRUSTED_PROXIES): a token's address list can be got around, so the form warns. */
  addressUnverified: boolean;
  /** Group → project membership or instance role (LANDFLOW_SCIM_GROUP_MAP). */
  groupMap: Record<string, string>;
  groups: number;
  provisionedUsers: number;
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

/**
 * A request the browser makes on its own (a timer's poll, the edit lock's heartbeat, a reload after a live event) sends
 * this header as `1`: the guard then resolves its session without marking it used, so a tab left open still reaches
 * LANDFLOW_SESSION_IDLE_HOURS. Trusting it is safe: it can only make a session end sooner.
 */
export const BACKGROUND_HEADER = 'x-landflow-background';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
