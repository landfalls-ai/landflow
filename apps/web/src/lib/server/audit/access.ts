/**
 * Who reads which audit events: owners and admins every event; a member whose custom role grants `audit:read` (C32) the
 * events of every project they are a member of (any project role, their personal project included); everyone else the
 * events of the projects they are an admin of (their personal project, and team projects where their role is admin),
 * through GET /api/audit and /api/audit/export. Verifying the hash chain, the settings and SIEM destinations stay with
 * the `audit:read` action and `settings:manage` (lib/server/auth/policy.ts).
 */
import { can, type RoleHolder } from '../../shared/auth';
import type { AuditFilters } from '../../shared/audit';
import { personalProjectId } from '../../shared/projects';
import { membershipsOf } from '../projects/store';
import type { StoreFilters } from './store';

/** The projects `user` is an admin of (personal included). */
export function adminProjectIds(user: { id: string }): string[] {
  return [personalProjectId(user.id), ...membershipsOf(user.id).filter((m) => m.role === 'admin').map((m) => m.projectId)];
}

/** The projects `user` is a member of in any role (personal included). */
export function memberProjectIds(user: { id: string }): string[] {
  return [personalProjectId(user.id), ...membershipsOf(user.id).map((m) => m.projectId)];
}

/**
 * `filters` as `user` may apply them: everything for the built-in owners and admins (not for a custom role that grants
 * `audit:read`: that is the member's projects, D9), else limited to their projects (403 for another project).
 */
export function auditFiltersFor(user: { id: string } & RoleHolder, filters: AuditFilters): { ok: true; filters: StoreFilters } | { ok: false; message: string } {
  if (user.role === 'owner' || user.role === 'admin') return { ok: true, filters };
  const granted = can(user, 'audit:read');
  const mine = granted ? memberProjectIds(user) : adminProjectIds(user);
  if (filters.projectId) return mine.includes(filters.projectId) ? { ok: true, filters } : { ok: false, message: granted ? 'You can read the audit log of the projects you are a member of' : 'Only admins of this project (and instance owners and admins) can read its audit log' };
  return { ok: true, filters: { ...filters, projectIds: mine } };
}
