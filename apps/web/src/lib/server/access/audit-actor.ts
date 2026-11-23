/** Who a Landflow person is in an audit event. A leaf module (it imports no access module), so the outside-requester modules can use it without a cycle through rules.ts and principal.ts. */
import type { AuditActorInput } from '../audit';
import { getUser } from '../auth/users';
import type { Actor } from '../projects/access';

export function auditActorOf(actor: Actor): AuditActorInput {
  const user = getUser(actor.id);
  return user ? { id: user.id, name: user.name, email: user.email } : { id: actor.id };
}
