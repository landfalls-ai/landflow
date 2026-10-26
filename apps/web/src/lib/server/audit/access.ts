/**
 * Who reads which audit events: owners and admins (the `audit:read` action) every event; everyone else the events of the
 * projects they are an admin of (their personal project, and team projects where their role is admin), through
 * GET /api/audit and /api/audit/export. Verifying the hash chain, the settings and SIEM destinations stay with owners
 * and admins (lib/server/auth/policy.ts).
 */
import { can, type Role } from '../../shared/auth';
import type { AuditFilters } from '../../shared/audit';
import { personalProjectId } from '../../shared/projects';
import { membershipsOf } from '../projects/store';
import type { StoreFilters } from './store';

/** The projects `user` is an admin of (personal included). */
export function adminProjectIds(user: { id: string }): string[] {
  return [personalProjectId(user.id), ...membershipsOf(user.id).filter((m) => m.role === 'admin').map((m) => m.projectId)];
}

/** `filters` as `user` may apply them: everything for owners and admins, else limited to their projects (403 for another project). */
export function auditFiltersFor(user: { id: string; role: Role }, filters: AuditFilters): { ok: true; filters: StoreFilters } | { ok: false; message: string } {
  if (can(user, 'audit:read')) return { ok: true, filters };
  const mine = adminProjectIds(user);
  if (filters.projectId) return mine.includes(filters.projectId) ? { ok: true, filters } : { ok: false, message: 'Only admins of this project (and instance owners and admins) can read its audit log' };
  return { ok: true, filters: { ...filters, projectIds: mine } };
}
