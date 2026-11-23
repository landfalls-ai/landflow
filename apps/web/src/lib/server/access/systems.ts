/**
 * What each access system is (docs/access-requests.md#systems): its target fields and how they are checked, the account a
 * person needs there, and the plugin node and operation names that add, remove and check a member. This is the one place that
 * names a plugin: `plugins/github` (`github.githubAccess`) and `plugins/google-workspace` (`google.googleDirectory`) answer these
 * parameters; a rename there is a change here and nowhere else (`test/access-contract.test.ts` in C35-C2 runs them together).
 *
 * Plain server module (no Next.js import).
 */
import type { AccessSystem, AccessTarget } from '../../shared/access';
import { AccessError } from './errors';

export interface TargetField {
  name: string;
  label: string;
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
}

export type Operation = 'add' | 'remove' | 'check';

/** What a call to the system's node answers, in the words the library uses. */
export interface ActionResult {
  changed: boolean;
  /** `active`: has it; `pending`: an invitation is open; `none`: does not. */
  state: 'active' | 'pending' | 'none';
  /** The person had it before this call: it is never taken back when the grant ends. */
  alreadyHad: boolean;
}

export interface SystemSpec {
  system: AccessSystem;
  label: string;
  fields: TargetField[];
  /** The account the person needs in the system: their GitHub username, their Landflow email (Google) or none. */
  account: 'github' | 'google' | 'none';
  /** Credential types an entry may use (the vault's full type names). */
  credentialTypes: string[];
  /** Whether Landflow can check a member (the hourly reconcile). */
  checks: boolean;
  /** The plugin node; none for a manual system. */
  nodeType?: string;
}

const GITHUB_CREDENTIAL = 'github.githubApi';
const GOOGLE_CREDENTIALS = ['google.googleApi', 'google.googleOAuth2Api'];

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

const options = (...values: Array<[string, string]>) => values.map(([value, label]) => ({ value, label }));

export const SYSTEMS: Record<AccessSystem, SystemSpec> = {
  'github-team': {
    system: 'github-team',
    label: 'GitHub team',
    account: 'github',
    credentialTypes: [GITHUB_CREDENTIAL],
    checks: true,
    nodeType: 'github.githubAccess',
    fields: [
      { name: 'org', label: 'Organization', required: true, placeholder: 'acme' },
      { name: 'team', label: 'Team slug', required: true, placeholder: 'platform' },
      { name: 'role', label: 'Role', required: false, options: options(['member', 'Member'], ['maintainer', 'Maintainer']) },
    ],
  },
  'github-org': {
    system: 'github-org',
    label: 'GitHub organization',
    account: 'github',
    credentialTypes: [GITHUB_CREDENTIAL],
    checks: true,
    nodeType: 'github.githubAccess',
    fields: [
      { name: 'org', label: 'Organization', required: true, placeholder: 'acme' },
      { name: 'role', label: 'Role', required: false, options: options(['direct_member', 'Member'], ['admin', 'Owner']) },
    ],
  },
  'github-repo': {
    system: 'github-repo',
    label: 'GitHub repository',
    account: 'github',
    credentialTypes: [GITHUB_CREDENTIAL],
    checks: true,
    nodeType: 'github.githubAccess',
    fields: [
      { name: 'owner', label: 'Owner', required: true, placeholder: 'acme' },
      { name: 'repository', label: 'Repository', required: true, placeholder: 'widgets' },
      { name: 'permission', label: 'Permission', required: false, options: options(['pull', 'Read'], ['triage', 'Triage'], ['push', 'Write'], ['maintain', 'Maintain'], ['admin', 'Admin']) },
    ],
  },
  'github-project': {
    system: 'github-project',
    label: 'GitHub project',
    account: 'github',
    credentialTypes: [GITHUB_CREDENTIAL],
    // GitHub offers no read of a project's collaborators: nothing to check, and no way to see an earlier role.
    checks: false,
    nodeType: 'github.githubAccess',
    fields: [
      { name: 'org', label: 'Organization', required: true, placeholder: 'acme' },
      { name: 'projectNumber', label: 'Project number', required: true, placeholder: '7' },
      { name: 'role', label: 'Role', required: false, options: options(['READER', 'Reader'], ['WRITER', 'Writer'], ['ADMIN', 'Admin']) },
    ],
  },
  'google-group': {
    system: 'google-group',
    label: 'Google group',
    account: 'google',
    credentialTypes: GOOGLE_CREDENTIALS,
    checks: true,
    nodeType: 'google.googleDirectory',
    fields: [
      { name: 'groupKey', label: 'Group email', required: true, placeholder: 'eng@example.com' },
      { name: 'role', label: 'Role', required: false, options: options(['MEMBER', 'Member'], ['MANAGER', 'Manager'], ['OWNER', 'Owner']) },
      { name: 'adminEmail', label: 'Admin to impersonate', required: false, placeholder: 'admin@example.com' },
    ],
  },
  manual: {
    system: 'manual',
    label: 'Manual (done by hand)',
    account: 'none',
    credentialTypes: [],
    checks: false,
    fields: [{ name: 'instructions', label: 'How to grant it', required: false, placeholder: 'Add them in the Figma admin console' }],
  },
};

export const isSystem = (value: unknown): value is AccessSystem => typeof value === 'string' && Object.hasOwn(SYSTEMS, value);

/** A target's own default for an option field that was left out. */
const DEFAULTS: Record<string, Record<string, string>> = {
  'github-team': { role: 'member' },
  'github-org': { role: 'direct_member' },
  'github-repo': { permission: 'pull' },
  'github-project': { role: 'READER' },
  'google-group': { role: 'MEMBER' },
};

const need = (spec: SystemSpec, field: TargetField, value: string): string => {
  if (!value) {
    if (field.required) throw new AccessError(`${field.label} is required`, 400, { field: field.name });
    return '';
  }
  return value;
};

/** The system's target from what an editor sent: only its own fields, trimmed, checked, with the defaults; a 400 names the field. */
export function validateTarget(system: AccessSystem, input: Record<string, unknown> | undefined): Record<string, string> {
  const spec = SYSTEMS[system];
  const config: Record<string, string> = {};
  for (const field of spec.fields) {
    const given = input?.[field.name];
    let value = need(spec, field, given === undefined || given === null ? '' : String(given).trim());
    if (!value && DEFAULTS[system]?.[field.name]) value = DEFAULTS[system][field.name]!;
    if (!value) continue;
    if (field.options && !field.options.some((o) => o.value === value)) throw new AccessError(`${field.label} must be one of ${field.options.map((o) => o.value).join(', ')}`, 400, { field: field.name });
    const bad = (message: string) => new AccessError(`${field.label} ${message}`, 400, { field: field.name });
    switch (field.name) {
      case 'org':
      case 'team':
      case 'owner':
      case 'repository':
        if (!NAME.test(value) || value === '.' || value === '..') throw bad('has a character GitHub names do not have');
        break;
      case 'projectNumber':
        if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw bad('must be a number from the project’s address');
        break;
      case 'groupKey':
      case 'adminEmail':
        if (!EMAIL.test(value)) throw bad('must be an email address');
        break;
      case 'instructions':
        if (value.length > 500) throw bad('is too long (500 characters at most)');
        break;
    }
    config[field.name] = value;
  }
  return config;
}

/** A GitHub login as GitHub writes them; a 400 otherwise. */
export function validateGithubLogin(value: unknown): string {
  const login = String(value ?? '').trim();
  if (!LOGIN.test(login)) throw new AccessError('That is not a GitHub username (letters, digits and single hyphens, up to 39)', 400, { field: 'account' });
  return login;
}

/** A person-readable line for what a target grants. */
export function targetLabel(system: AccessSystem, config: Record<string, string>): string {
  switch (system) {
    case 'github-team':
      return `GitHub team ${config.org}/${config.team} (${config.role ?? 'member'})`;
    case 'github-org':
      return `GitHub organization ${config.org} (${config.role === 'admin' ? 'owner' : 'member'})`;
    case 'github-repo':
      return `GitHub repository ${config.owner}/${config.repository} (${config.permission ?? 'pull'})`;
    case 'github-project':
      return `GitHub project ${config.org} #${config.projectNumber} (${(config.role ?? 'READER').toLowerCase()})`;
    case 'google-group':
      return `Google group ${config.groupKey} (${(config.role ?? 'MEMBER').toLowerCase()})`;
    case 'manual':
      return config.instructions ? `By hand: ${config.instructions}` : 'By hand';
  }
}

/** The target as the entry stores and shows it. */
export function targetOf(system: AccessSystem, config: Record<string, string>): AccessTarget {
  const key = system === 'manual' ? 'manual' : Object.entries(config).filter(([name]) => name !== 'role' && name !== 'permission' && name !== 'adminEmail').map(([, value]) => value).join('/');
  return { key, type: system, label: targetLabel(system, config), config };
}

/** The node's parameters for one operation on a target, for one person's account (`github` login or `google` email). */
export function callOf(system: AccessSystem, op: Operation, config: Record<string, string>, account: string): { nodeType: string; parameters: Record<string, unknown> } {
  const spec = SYSTEMS[system];
  if (!spec.nodeType) throw new AccessError('A manual entry has no automatic action', 400);
  switch (system) {
    case 'github-team':
      return { nodeType: spec.nodeType, parameters: { resource: 'teamMembership', operation: op === 'check' ? 'get' : op, org: config.org, teamSlug: config.team, username: account, ...(op === 'add' && { teamRole: config.role ?? 'member' }) } };
    case 'github-org':
      return { nodeType: spec.nodeType, parameters: { resource: 'orgMembership', operation: op === 'add' ? 'invite' : op === 'check' ? 'get' : 'remove', org: config.org, username: account, ...(op === 'add' && { orgRole: config.role ?? 'direct_member' }) } };
    case 'github-repo':
      return { nodeType: spec.nodeType, parameters: { resource: 'repoCollaborator', operation: op === 'check' ? 'getPermission' : op, owner: config.owner, repository: config.repository, username: account, ...(op === 'add' && { permission: config.permission ?? 'pull' }) } };
    case 'github-project':
      if (op === 'check') throw new AccessError('GitHub cannot say who is on a project', 400);
      return { nodeType: spec.nodeType, parameters: { resource: 'projectCollaborator', operation: op, org: config.org, projectNumber: Number(config.projectNumber), username: account, ...(op === 'add' && { projectRole: config.role ?? 'READER' }) } };
    case 'google-group':
      return { nodeType: spec.nodeType, parameters: { resource: 'member', operation: op === 'check' ? 'hasMember' : op, groupKey: config.groupKey, memberKey: account, ...(op === 'add' && { role: config.role ?? 'MEMBER' }), ...(config.adminEmail && { adminEmail: config.adminEmail }) } };
    case 'manual':
      throw new AccessError('A manual entry has no automatic action', 400);
  }
}

/** What a node's answer says, in the library's words (GitHub: `state`, `changed`, `alreadyHad`; Google: `status`, `isMember`, `changed`, `alreadyHad`). */
export function resultOf(system: AccessSystem, op: Operation, output: Record<string, unknown>): ActionResult {
  const changed = output.changed === true;
  const alreadyHad = output.alreadyHad === true;
  if (system === 'google-group') {
    if (op === 'check') return { changed: false, state: output.isMember === true || output.status === 'member' ? 'active' : 'none', alreadyHad: false };
    if (op === 'remove') return { changed, state: 'none', alreadyHad: false };
    return { changed, state: 'active', alreadyHad };
  }
  const state = output.state === 'pending' || output.state === 'none' ? output.state : output.state === 'active' ? 'active' : op === 'remove' ? 'none' : 'active';
  return { changed, state, alreadyHad: op === 'add' && alreadyHad };
}

/** `system|target` without the role or permission (the same team asked at two roles is one target): one live grant per target and account. */
export const targetKeyOf = (system: AccessSystem, config: Record<string, string>): string => `${system}|${targetOf(system, config).key}`.toLowerCase();
