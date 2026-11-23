/**
 * Custom instance roles (C32, docs/features/authentication.md#custom-roles): a name, a description and rules
 * `{ action, effect: 'allow' }` over the existing actions, held by members (one each, `users.custom_role_id`). `can()`
 * (lib/shared/auth.ts) allows an action the built-in role or the role grants; the grants are read with the user on every
 * request (./users), so an edit or a delete shows at the holder's next one, in every process, with no cache.
 *
 * The escalation check is here, not in the routes: a person creates, edits or assigns a role only if they hold every
 * action it grants, only the owner grants `users:manage` or `apiKeys:admin`, and nobody grants `projects:manage`.
 * Every change is a high-value audit event with from/to (`auditedTransaction`: with LANDFLOW_AUDIT_FAIL_CLOSED an event
 * that can't be stored refuses the change with 503).
 */
import { nanoid } from 'nanoid';
import { ACTIONS, GRANTABLE_ACTIONS, OWNER_ONLY_GRANTS, can, canManageUser, ungrantable, type Action } from '../../shared/auth';
import { RESERVED_ROLE_NAMES, parseStoredRules, type CustomRoleView, type RoleRule } from '../../shared/roles';
import { auditedTransaction, recordAudit } from '../audit';
import { HttpError } from '../errors';
import { authDb } from './db';
import { getUser, updateUser, type UserRecord } from './users';

export class RoleError extends HttpError {
  static readonly errorName: string = 'RoleError';
  constructor(
    message: string,
    status = 400,
    details?: Record<string, unknown>,
  ) {
    super(message, status, { expose: true, ...(details && { details }) });
  }
}

interface RoleRow {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  rules: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  holders?: number | string;
}

const view = (row: RoleRow): CustomRoleView => ({
  id: row.id,
  name: row.name,
  ...(row.description && { description: row.description }),
  rules: parseStoredRules(row.rules),
  holders: Number(row.holders ?? 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const ROLE_SELECT = 'SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.custom_role_id = r.id AND u.role = ?) AS holders FROM custom_roles r';

/** The rules as a short sorted text for an audit event's from/to. */
const rulesText = (rules: readonly RoleRule[]) => rules.map((rule) => rule.action).sort().join(', ');

export function listRoles(): CustomRoleView[] {
  return authDb().all<RoleRow>(`${ROLE_SELECT} ORDER BY r.name_key`, 'member').map(view);
}

function find(id: string): CustomRoleView | undefined {
  const row = authDb().get<RoleRow>(`${ROLE_SELECT} WHERE r.id = ?`, 'member', id);
  return row && view(row);
}

/** The role named `name` (any case): what a SCIM group maps to. */
export function roleByName(name: string): CustomRoleView | undefined {
  const row = authDb().get<RoleRow>(`${ROLE_SELECT} WHERE r.name_key = ?`, 'member', name.trim().toLowerCase());
  return row && view(row);
}

export const getRole = find;

/** Rules from a request: every action must exist (400 naming it), repeats merge. The escalation check is separate. */
function checkRules(rules: ReadonlyArray<{ action: string; effect: 'allow' }>): RoleRule[] {
  const seen = new Set<string>();
  for (const { action } of rules) {
    if (!(ACTIONS as readonly string[]).includes(action)) throw new RoleError(`“${action}” is not an action a role can grant`);
    seen.add(action);
  }
  return [...seen].map((action) => ({ action: action as Action, effect: 'allow' as const }));
}

/** 403 unless `actor` may put every action of `rules` in a role (the escalation check, FR-3). */
function checkEscalation(actor: UserRecord, rules: readonly RoleRule[]) {
  const wanted = rules.map((rule) => rule.action);
  const refused = ungrantable(actor, wanted);
  if (!refused.length) return;
  const never = refused.filter((action) => !GRANTABLE_ACTIONS.includes(action));
  if (never.length) throw new RoleError(`${never.join(', ')} can’t be granted through a custom role: it would make its holder an admin of every project`, 403);
  const ownerOnly = refused.filter((action) => OWNER_ONLY_GRANTS.includes(action));
  if (ownerOnly.length && actor.role !== 'owner') throw new RoleError(`Only the owner can grant ${ownerOnly.join(', ')}`, 403);
  throw new RoleError(`You can only grant actions you hold: ${refused.join(', ')}`, 403);
}

function checkName(name: string, exceptId?: string): { name: string; key: string } {
  const clean = name.trim();
  if (!clean || clean.length > 40) throw new RoleError('A role name is 1 to 40 characters');
  const key = clean.toLowerCase();
  if (RESERVED_ROLE_NAMES.includes(key)) throw new RoleError(`“${clean}” is a built-in role and can’t be reused as a custom role’s name`);
  const taken = authDb().get<{ id: string }>('SELECT id FROM custom_roles WHERE name_key = ?', key);
  if (taken && taken.id !== exceptId) throw new RoleError(`A role named “${clean}” already exists`, 409);
  return { name: clean, key };
}

function requireManager(actor: UserRecord) {
  if (!can(actor, 'users:manage')) throw new RoleError('Your role can’t do this. Ask an owner or admin.', 403);
}

/** Create a role. 403 for what `actor` may not grant, 409 for a taken name. */
export function createRole(input: { name: string; description?: string; rules: ReadonlyArray<{ action: string; effect: 'allow' }> }, actor: UserRecord): CustomRoleView {
  requireManager(actor);
  const rules = checkRules(input.rules);
  if (!rules.length) throw new RoleError('A role needs at least one action');
  checkEscalation(actor, rules);
  return auditedTransaction(() => {
    const { name, key } = checkName(input.name);
    const now = new Date().toISOString();
    const id = `role_${nanoid(10)}`;
    authDb().insertNew('custom_roles', { id, name, name_key: key, description: input.description?.trim() || null, rules: JSON.stringify(rules), created_by: actor.id, created_at: now, updated_at: now });
    recordAudit({ action: 'role.created', target: { type: 'role', id, name }, summary: `Created the custom role ${name}`, details: { from: null, to: rulesText(rules) } });
    return find(id)!;
  });
}

/** Change a role's name, description or rules. The check is on the whole new rule set; holders see it on their next request. */
export function updateRole(id: string, patch: { name?: string; description?: string | null; rules?: ReadonlyArray<{ action: string; effect: 'allow' }> }, actor: UserRecord): CustomRoleView {
  requireManager(actor);
  const rules = patch.rules && checkRules(patch.rules);
  if (rules && !rules.length) throw new RoleError('A role needs at least one action');
  return auditedTransaction(() => {
    const existing = find(id);
    if (!existing) throw new RoleError('Role not found', 404);
    checkEscalation(actor, rules ?? existing.rules);
    const named = patch.name !== undefined ? checkName(patch.name, id) : { name: existing.name, key: existing.name.toLowerCase() };
    const next = rules ?? existing.rules;
    const description = patch.description === undefined ? existing.description : patch.description?.trim() || undefined;
    authDb().upsert('custom_roles', {
      id,
      name: named.name,
      name_key: named.key,
      description: description ?? null,
      rules: JSON.stringify(next),
      created_by: authDb().get<{ created_by: string | null }>('SELECT created_by FROM custom_roles WHERE id = ?', id)?.created_by ?? null,
      created_at: existing.createdAt,
      updated_at: new Date().toISOString(),
    });
    recordAudit({
      action: 'role.updated',
      target: { type: 'role', id, name: named.name },
      summary: `Changed the custom role ${named.name}`,
      details: { from: rulesText(existing.rules), to: rulesText(next), ...(named.name !== existing.name && { nameFrom: existing.name, nameTo: named.name }), holders: existing.holders },
    });
    return find(id)!;
  });
}

/** Delete a role. In use, it asks for `confirm` (409 with the holder count); the holders become plain members. */
export function deleteRole(id: string, actor: UserRecord, options: { confirm?: boolean } = {}): void {
  requireManager(actor);
  auditedTransaction(() => {
    const existing = find(id);
    if (!existing) throw new RoleError('Role not found', 404);
    if (existing.holders > 0 && !options.confirm) throw new RoleError(`${existing.holders} ${existing.holders === 1 ? 'person holds' : 'people hold'} this role. Confirm to delete it and leave them as plain members`, 409, { holders: existing.holders });
    for (const holder of authDb().all<{ id: string; email: string }>('SELECT id, email FROM users WHERE custom_role_id = ?', id)) {
      setCustomRole(holder.id, null);
      recordAudit({ action: 'user.custom_role', target: { type: 'user', id: holder.id, name: holder.email }, summary: `${holder.email} lost the custom role ${existing.name} (deleted)`, details: { from: existing.name, to: null, reason: 'role_deleted' } });
    }
    authDb().delete('custom_roles', { id });
    recordAudit({ action: 'role.deleted', target: { type: 'role', id, name: existing.name }, summary: `Deleted the custom role ${existing.name}`, details: { from: rulesText(existing.rules), to: null, holders: existing.holders } });
  });
}

/**
 * Give a member a custom role, or take it away (`roleId` null). Only members hold one; the actor must manage the person
 * (`canManageUser`: not themselves, not the owner) and hold every action the role grants.
 */
export function assignRole(userId: string, roleId: string | null, actor: UserRecord): UserRecord {
  requireManager(actor);
  return auditedTransaction(() => {
    const target = getUser(userId);
    if (!target) throw new RoleError('User not found', 404);
    if (!canManageUser(actor, target, { kind: 'role', role: 'member' })) throw new RoleError('You can’t change this user’s role', 403);
    if (target.role !== 'member') throw new RoleError('Only members hold a custom role: an admin already holds every action');
    const role = roleId ? find(roleId) : undefined;
    if (roleId && !role) throw new RoleError('Role not found', 404);
    if (role) checkEscalation(actor, role.rules);
    if ((target.customRole?.id ?? null) === (role?.id ?? null)) return target;
    // The write is the one place a custom role is set, so its audit event sits beside it.
    const updated = setCustomRole(userId, role?.id ?? null);
    recordAudit({ action: 'user.custom_role', target: { type: 'user', id: userId, name: target.email }, summary: role ? `Gave ${target.email} the custom role ${role.name}` : `Took the custom role ${target.customRole?.name ?? ''} from ${target.email}`.trim(), details: { from: target.customRole?.name ?? null, to: role?.name ?? null } });
    return updated;
  });
}

/** Set or clear a member's role with no checks: for `assignRole`, `deleteRole` and the SCIM recompute, which check and audit themselves. */
export function setCustomRole(userId: string, roleId: string | null): UserRecord {
  return updateUser(userId, { customRoleId: roleId ?? undefined });
}
