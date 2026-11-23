/**
 * Who may do what with access requests (docs/access-requests.md#who-sees-and-does-what): one module for every rule, so a
 * route, a node and a page can't disagree. A caller who may not know an entry or a request exists gets a 404 from the library, not a 403.
 *
 * - Entries: enabled entries are listed to everyone signed in (or to the people an entry lists, when it lists any); owners and
 *   instance admins see and edit them all, instance admins create and delete; an entry's approvers see it too.
 * - Requests: the requester sees their own; an entry's approvers and owners see that entry's; instance admins see all.
 * - Grants: the holder sees their own; owners, approvers and admins see the entry's. Give it back (revoke): the holder, the owners and
 *   approvers, admins. Done on a manual grant: the approvers, the owners and admins, never the holder.
 * - Nobody approves their own request: `approversFor` never lists the requester.
 *
 * Plain server module (no Next.js import).
 */
import type { AccessTarget, AccessSystem, ApprovalStep } from '../../shared/access';
import type { AuditActorInput } from '../audit';
import { getUser, listUsers } from '../auth/users';
import { isInstanceAdmin, type Actor } from '../projects/access';

/** An entry as the library works with it (the row, parsed). */
export interface EntryData {
  id: string;
  name: string;
  description?: string;
  system: AccessSystem;
  target: AccessTarget;
  credentialId?: string;
  durations: Array<number | null>;
  steps: ApprovalStep[];
  owners: string[];
  /** Empty: everyone signed in may ask. */
  eligible: string[];
  enabled: boolean;
  version: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

const active = (userId: string) => {
  const user = getUser(userId);
  return Boolean(user && !user.disabledAt);
};

export const stepApproverIds = (entry: Pick<EntryData, 'steps'>, step = 0): string[] => entry.steps[step]?.approvers.userIds ?? [];

export const isOwner = (actor: Actor, entry: Pick<EntryData, 'owners'>): boolean => entry.owners.includes(actor.id);

export const isAnyApprover = (actor: Actor, entry: Pick<EntryData, 'steps'>): boolean => entry.steps.some((step) => step.approvers.userIds.includes(actor.id));

export const canCreateEntry = (actor: Actor): boolean => isInstanceAdmin(actor);
export const canDeleteEntry = (actor: Actor): boolean => isInstanceAdmin(actor);

/** Owners and instance admins edit an entry. */
export const canEditEntry = (actor: Actor, entry: EntryData): boolean => isInstanceAdmin(actor) || isOwner(actor, entry);

/** What only an instance admin changes: the system, the target and the credential (what the entry can reach). */
export const canEditReach = (actor: Actor): boolean => isInstanceAdmin(actor);

export function canSeeEntry(actor: Actor, entry: EntryData): boolean {
  if (canEditEntry(actor, entry) || isAnyApprover(actor, entry)) return true;
  return entry.enabled && (entry.eligible.length === 0 || entry.eligible.includes(actor.id));
}

/** Whether `actor` may ask for the entry: it is enabled and they are eligible (owners and admins ask for what they edit too). */
export function canAskFor(actor: Actor, entry: EntryData): boolean {
  return entry.enabled && (entry.eligible.length === 0 || entry.eligible.includes(actor.id) || canEditEntry(actor, entry));
}

/**
 * The people who may decide a request: the step's approvers other than the requester who are still active; when none is left,
 * the active instance admins other than the requester (Landbright's approver fallback). Empty: nobody can approve it.
 */
export function approversFor(entry: Pick<EntryData, 'steps'>, requesterId: string, step = 0): string[] {
  const named = stepApproverIds(entry, step).filter((id) => id !== requesterId && active(id));
  if (named.length) return [...new Set(named)];
  return listUsers().filter((user) => user.id !== requesterId && !user.disabledAt && (user.role === 'owner' || user.role === 'admin')).map((user) => user.id);
}

/** Whether `userId` decides step `step` of a request by `requesterId` now (active, not the requester, named or a fallback admin). */
export const isStepApprover = (entry: Pick<EntryData, 'steps'>, step: number, userId: string, requesterId: string): boolean => userId !== requesterId && approversFor(entry, requesterId, step).includes(userId);

interface RequestFacts {
  requesterId: string;
  approvers: string[];
}

export function canSeeRequest(actor: Actor, request: RequestFacts, entry: EntryData | undefined): boolean {
  if (request.requesterId === actor.id || isInstanceAdmin(actor) || request.approvers.includes(actor.id)) return true;
  return Boolean(entry && (isOwner(actor, entry) || isAnyApprover(actor, entry)));
}

/** The viewer is one of the request's approvers now (and not the requester). */
export const canDecideRequest = (actor: Actor, request: RequestFacts, entry: EntryData | undefined): boolean =>
  request.requesterId !== actor.id && (entry ? isStepApprover(entry, 0, actor.id, request.requesterId) && request.approvers.includes(actor.id) : false);

export const canCancelRequest = (actor: Actor, request: Pick<RequestFacts, 'requesterId'>): boolean => request.requesterId === actor.id || isInstanceAdmin(actor);

interface GrantFacts {
  holderId: string;
}

export function canSeeGrant(actor: Actor, grant: GrantFacts, entry: EntryData | undefined): boolean {
  if (grant.holderId === actor.id || isInstanceAdmin(actor)) return true;
  return Boolean(entry && (isOwner(actor, entry) || isAnyApprover(actor, entry)));
}

/** Give it back (the holder), take it back (owners, approvers, admins). */
export const canRevoke = (actor: Actor, grant: GrantFacts, entry: EntryData | undefined): boolean => canSeeGrant(actor, grant, entry);

/** Done on a manual grant: someone who does the work, never the person who holds it. */
export function canMarkDone(actor: Actor, grant: GrantFacts, entry: EntryData | undefined): boolean {
  if (grant.holderId === actor.id) return false;
  return isInstanceAdmin(actor) || Boolean(entry && (isOwner(actor, entry) || isAnyApprover(actor, entry)));
}

/** Retry a failed grant or removal: owners and admins (and approvers), never the holder. */
export const canRetry = canMarkDone;

/** Who the audit log names for an action: the person, by id, name and email (the library is called outside a request too). */
export function auditActorOf(actor: Actor): AuditActorInput {
  const user = getUser(actor.id);
  return user ? { id: user.id, name: user.name, email: user.email } : { id: actor.id };
}
