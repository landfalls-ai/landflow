/**
 * Who asks and who holds (docs/access-requests.md#outside-requesters-what-they-can-ask-and-see): one module resolves an id from the requests and
 * grants tables to a Landflow user or an outside requester (C36: `ext_…`, a person without an account, kept by outside/identity.ts), so
 * nothing else calls `getUser` for a requester or a holder. Also the one definition of "the same email" for self-approval: a decider
 * whose canonical email (lower case, the local part cut at the first `+`) equals the requester's is the requester, and grants nothing.
 *
 * Plain server module (no Next.js import).
 */
import type { RequesterKind, VerifiedBy } from '../../shared/access';
import type { AuditActorInput } from '../audit';
import { getUser, listUsers } from '../auth/users';
import { publicUrl } from '../config';
import { getOutsideRequester, type OutsideRequester } from './outside/identity';
import { domainAllowed, outsideSettings } from './outside/settings';

export interface Requester {
  kind: RequesterKind;
  id: string;
  /** What to call them: a user's name (else email), an outside requester's name (else verified email). */
  name: string;
  email?: string;
  /** Outside requesters only: how the email was proven. */
  verifiedBy?: VerifiedBy;
}

/** Outside requesters' ids; a Landflow user's are `usr_…`, so the two never meet. */
export const isOutsideId = (id: string | null | undefined): boolean => Boolean(id?.startsWith('ext_'));

/** The one comparison of "the same person's email": lower case, nothing after a `+` in the local part. */
export function emailKey(email: string | null | undefined): string {
  const text = String(email ?? '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at < 0) return text;
  const local = text.slice(0, at);
  const plus = local.indexOf('+');
  return `${plus < 0 ? local : local.slice(0, plus)}${text.slice(at)}`;
}

/** The user or outside requester an id names; undefined when it names neither (a deleted user). */
export function requesterOf(id: string | null | undefined): Requester | undefined {
  if (!id) return undefined;
  if (isOutsideId(id)) {
    const outside = getOutsideRequester(id);
    return outside && requesterOfOutside(outside);
  }
  const user = getUser(id);
  return user && { kind: 'user', id: user.id, name: user.name || user.email, email: user.email };
}

/** The outside requester a public route was signed in as. */
export const requesterOfOutside = (outside: Pick<OutsideRequester, 'id' | 'email' | 'name' | 'verifiedBy'>): Requester => ({ kind: 'outside', id: outside.id, name: outside.name || outside.email, email: outside.email, verifiedBy: outside.verifiedBy });

/** A Landflow caller as a requester (an id the table no longer knows keeps its id as its name, as C35 did). */
export const requesterOfActor = (actor: { id: string }): Requester => requesterOf(actor.id) ?? { kind: 'user', id: actor.id, name: actor.id };

/** The name the people deciding see and the mails use: an outside requester is their verified address, marked. */
export const displayName = (requester: Pick<Requester, 'kind' | 'name' | 'email'>): string => (requester.kind === 'outside' ? `${requester.email ?? requester.name} (outside)` : requester.name);

/** Who the audit log names for an action by this requester. */
export const auditActorOfRequester = (requester: Requester): Exclude<AuditActorInput, string> => ({ id: requester.id, name: requester.name, ...(requester.email && { email: requester.email }) });

/** "outside requester erin@partner.test (email verified by link)": the line the approver's question carries. */
export const whoLine = (requester: Requester): string =>
  requester.kind === 'outside' ? `outside requester ${requester.email ?? requester.name} (email verified by ${requester.verifiedBy === 'google' ? 'Google sign-in' : 'link'})` : requester.name;

/** Where a status mail sends the requester: Landflow's Access page, or the public page. */
export const pageLink = (requester: Pick<Requester, 'kind'>): string => `${publicUrl()}${requester.kind === 'outside' ? '/request-access' : '/access'}`;

/** The canonical email an approval would be compared with: the requester's own. */
export const requesterEmailKey = (requesterId: string): string => emailKey(requesterOf(requesterId)?.email);

/**
 * Whether an outside requester may still ask now: the feature is on, their domain still allowed, they are not blocked and no Landflow
 * user has their address (never two identities for one email). Every use of the requester re-checks it, as the session does.
 */
export function outsideStanding(requester: Requester): boolean {
  if (requester.kind !== 'outside' || !requester.email) return false;
  const record = getOutsideRequester(requester.id);
  if (!record || record.blocked) return false;
  const settings = outsideSettings();
  if (!settings.enabled || !domainAllowed(record.email)) return false;
  return !listUsers().some((user) => emailKey(user.email) === emailKey(record.email));
}
