/**
 * The installed access flows decide who gets access (docs/access-requests.md#setting-up), so only an instance admin edits, publishes,
 * unpublishes, restores or deletes them: an editor of the project they live in can do none of it. Plain server module: the workflow
 * routes and the governance layer call it, and it reads only the setup's settings.
 */
import { getUser } from '../auth/users';
import { HttpError } from '../errors';
import { registerWorkflowLock } from '../singleton';
import { lockedAccessFlows } from './locked';

export { lockedAccessFlows };

/** Throws 403 unless `workflowId` is not an installed access flow, or `byUserId` is an active owner or admin. */
export function guardAccessFlow(workflowId: string, byUserId: string | undefined): void {
  if (!lockedAccessFlows().includes(workflowId)) return;
  const user = byUserId ? getUser(byUserId) : undefined;
  if (user && !user.disabledAt && (user.role === 'owner' || user.role === 'admin')) return;
  throw new HttpError('This workflow decides who gets access: only an instance admin changes, publishes, unpublishes or deletes it', 403, { expose: true });
}

// The workflow store and project access consult the lock through ./locks (no import of this feature), so it registers itself here.
registerWorkflowLock({ locked: lockedAccessFlows, guard: guardAccessFlow });
