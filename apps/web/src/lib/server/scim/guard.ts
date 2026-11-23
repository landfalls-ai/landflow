/**
 * What a SCIM token may change (C32 review). The token's person is the actor: the owner's token changes anyone but the
 * owner; an admin's token not another admin; a token of someone holding Manage SCIM through a custom role (granted by
 * the owner) only members, never itself, never a member whose role holds actions that person couldn't grant. With no
 * actor (the operator's environment, a test, boot) nothing here restricts.
 */
import { ungrantable } from '../../shared/auth';
import { currentActorId } from '../auth/context';
import { getUser, type UserRecord } from '../auth/users';

/** The person behind the SCIM token making this request, if any. */
export function scimActor(): UserRecord | undefined {
  const id = currentActorId();
  return id ? getUser(id) : undefined;
}

/** Whether the token's person is an owner or admin (their token may change the instance's people and projects). */
export const isAdminActor = (actor: UserRecord | undefined): boolean => !actor || actor.role === 'owner' || actor.role === 'admin';

/** Why `actor`'s token may not change `user` (undefined when it may). The owner's token changes any account but the owner's. */
export function changeRefusal(actor: UserRecord | undefined, user: UserRecord): string | undefined {
  if (user.role === 'owner') return 'The owner’s account can’t be changed through SCIM';
  if (!actor) return undefined;
  if (actor.id === user.id) return 'A SCIM token can’t change its own person’s account';
  if (actor.role === 'owner') return undefined;
  if (user.role === 'admin') return 'Only the owner’s SCIM token changes an admin';
  if (ungrantable(actor, user.customRole?.actions ?? []).length) return 'This person’s custom role holds actions this token’s person couldn’t grant';
  return undefined;
}
