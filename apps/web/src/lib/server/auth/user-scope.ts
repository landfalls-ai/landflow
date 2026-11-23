/**
 * Which people a user manager may act on (C32 review). An owner or admin acts on anyone `canManageUser` allows. A member
 * who holds Manage users through a custom role acts only on people whose project memberships are all in projects that
 * member administers, may only move a removed person's things to the owner or to such a project, and never sees a
 * password reset link: it goes to the person by email.
 */
import { projectRole, isInstanceAdmin } from '../projects/access';
import { instanceOwnerId, membershipsOf } from '../projects/store';
import type { UserRecord } from './users';

/** Whether `actor` administers every project `target` is a member of (always true for an owner or admin). */
export function mayActOnUser(actor: UserRecord, target: UserRecord): boolean {
  if (isInstanceAdmin(actor)) return true;
  return membershipsOf(target.id).every((membership) => projectRole(actor, membership.projectId) === 'admin');
}

/** Whether `actor` may send a removed person's things to `transferTo`: an admin anywhere; anyone else to the owner or a project they administer. */
export function mayTransferTo(actor: UserRecord, transferTo: { userId: string } | { projectId: string } | undefined): boolean {
  if (!transferTo || isInstanceAdmin(actor)) return true;
  if ('userId' in transferTo) return transferTo.userId === instanceOwnerId();
  return projectRole(actor, transferTo.projectId) === 'admin';
}
