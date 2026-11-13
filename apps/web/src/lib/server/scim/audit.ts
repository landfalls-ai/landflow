/**
 * SCIM's audit events. The generic `api.request` event only covers /api paths, so provisioning relies on domain
 * events: `user.provision`, `user.update`, `user.deactivate`, `user.reactivate`, `user.remove`, `group.create`,
 * `group.update`, `group.members_change`, `group.remove`, each with the values before and after (flat, as recordAudit
 * wants them), recorded as the SCIM token's user and key (`scimRoute` sets the request context). A rejected token is
 * `scim.auth_failed` (denied), at most once per client address per minute so a misconfigured identity provider
 * retrying in a loop can't flood the log, and at most 60 a minute in all, so a caller rotating its address can't
 * either. A 403 (a valid key without the scope, or not an owner or admin) names the key and its user.
 */
import { recordAudit } from '../audit';
import { singleton } from '../singleton';
import type { UserRecord } from '../auth/users';
import type { ScimGroup } from './groups';

const FAILED_WINDOW_MS = 60_000;
const MAX_TRACKED = 10_000;
/** Events per minute across every address. */
const MAX_PER_WINDOW = 60;

const lastFailure = () => singleton('scim-auth-failures', () => new Map<string, number>());
const failureWindow = () => singleton('scim-auth-failure-window', () => ({ start: 0, count: 0 }));

/** Who presented a token that was valid but not enough (403): the key and its user. */
export interface ScimAuthFailureCaller {
  keyId: string;
  userId: string;
}

/**
 * Record a rejected SCIM token, unless this client address already has one in the last minute or the minute's
 * ceiling is reached.
 */
export function recordScimAuthFailure(ip: string | undefined, status: number, reason: string, caller?: ScimAuthFailureCaller, now = Date.now()) {
  const seen = lastFailure();
  const key = ip ?? 'unknown';
  const last = seen.get(key);
  if (last !== undefined && now - last < FAILED_WINDOW_MS) return;
  if (seen.size >= MAX_TRACKED) {
    // Drop what has aged out; if that frees nothing, the oldest goes (Map keeps insertion order).
    for (const [address, at] of seen) if (now - at >= FAILED_WINDOW_MS) seen.delete(address);
    if (seen.size >= MAX_TRACKED) seen.delete(seen.keys().next().value as string);
  }
  seen.delete(key);
  seen.set(key, now);
  const window = failureWindow();
  if (now - window.start >= FAILED_WINDOW_MS) Object.assign(window, { start: now, count: 0 });
  if (++window.count > MAX_PER_WINDOW) return;
  recordAudit({
    action: 'scim.auth_failed',
    outcome: 'denied',
    actor: 'anonymous',
    summary: `Rejected SCIM token (${reason})`,
    details: { status, reason, ...(caller && { keyId: caller.keyId, userId: caller.userId }) },
  });
}

const userTarget = (user: Pick<UserRecord, 'id' | 'email'>) => ({ type: 'user', id: user.id, name: user.email });
const groupTarget = (group: Pick<ScimGroup, 'id' | 'displayName'>) => ({ type: 'group', id: group.id, name: group.displayName });

export function auditUserProvisioned(user: UserRecord) {
  recordAudit({
    action: 'user.provision',
    target: userTarget(user),
    summary: `Provisioned ${user.email} through SCIM`,
    details: { email: user.email, name: user.name, role: user.role, active: !user.disabledAt, externalId: user.externalId ?? null },
  });
}

/** What changed between two versions of a user: one `user.update` for name, email, role or external id, one event for a deactivation or reactivation. */
export function auditUserChange(before: UserRecord, after: UserRecord) {
  const details: Record<string, unknown> = {};
  const changed = (key: string, from: unknown, to: unknown) => {
    if (from === to) return;
    details[`${key}From`] = from ?? null;
    details[`${key}To`] = to ?? null;
  };
  changed('name', before.name, after.name);
  changed('email', before.email, after.email);
  changed('role', before.role, after.role);
  changed('externalId', before.externalId, after.externalId);
  if (Object.keys(details).length) {
    recordAudit({ action: 'user.update', target: userTarget(after), summary: `Updated ${after.email} through SCIM (${[...new Set(Object.keys(details).map((k) => k.replace(/(From|To)$/, '')))].join(', ')})`, details });
  }
  const was = !before.disabledAt;
  const now = !after.disabledAt;
  if (was !== now) {
    recordAudit({
      action: now ? 'user.reactivate' : 'user.deactivate',
      target: userTarget(after),
      summary: `${now ? 'Reactivated' : 'Deactivated'} ${after.email} through SCIM`,
      details: { activeFrom: was, activeTo: now },
    });
  }
}

export function auditUserRemoved(user: UserRecord, details: { transferredTo?: string }) {
  recordAudit({ action: 'user.remove', target: userTarget(user), summary: `Removed ${user.email} through SCIM`, details: { role: user.role, active: !user.disabledAt, ...(details.transferredTo && { transferredTo: details.transferredTo }) } });
}

export function auditGroupCreated(group: ScimGroup, members: string[]) {
  recordAudit({ action: 'group.create', target: groupTarget(group), summary: `Created the group “${group.displayName}” through SCIM`, details: { displayName: group.displayName, externalId: group.externalId ?? null, members: members.length } });
  if (members.length) recordAudit({ action: 'group.members_change', target: groupTarget(group), summary: `Added ${members.length} member(s) to “${group.displayName}”`, details: { added: members, removed: [] } });
}

export function auditGroupChange(before: ScimGroup, after: ScimGroup, added: string[], removed: string[]) {
  if (before.displayName !== after.displayName || before.externalId !== after.externalId) {
    recordAudit({
      action: 'group.update',
      target: groupTarget(after),
      summary: `Updated the group “${after.displayName}” through SCIM`,
      details: { displayNameFrom: before.displayName, displayNameTo: after.displayName, externalIdFrom: before.externalId ?? null, externalIdTo: after.externalId ?? null },
    });
  }
  if (added.length || removed.length) {
    recordAudit({ action: 'group.members_change', target: groupTarget(after), summary: `Changed the members of “${after.displayName}” (+${added.length}, -${removed.length})`, details: { added, removed } });
  }
}

export function auditGroupRemoved(group: ScimGroup, members: string[]) {
  recordAudit({ action: 'group.remove', target: groupTarget(group), summary: `Removed the group “${group.displayName}” through SCIM`, details: { displayName: group.displayName, members } });
}
