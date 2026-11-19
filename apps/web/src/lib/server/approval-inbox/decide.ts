/**
 * Approve or deny one approval-inbox request for a signed-in person (docs/approval-inbox.md). The route's access rules in one
 * place: 404 for a request on a workflow the caller cannot read, 403 for one they can read but not run (or an API key), then
 * `decideApproval`, whose first act is the conditional claim every door shares.
 */
import { ApprovalError, decideApproval } from '../approvals';
import { requestAuth } from '../auth/context';
import type { UserRecord } from '../auth/users';
import { resourceAccess } from '../projects/access';
import { canDecide, viewFor } from './access';
import { closedOf, reconcile, requestRow, type InboxRow } from './store';

/** The request if `actor` may read its workflow; a 404 otherwise (a request on a workflow they cannot see does not exist for them). */
export function readableRequest(actor: UserRecord, id: string): InboxRow {
  const row = requestRow(id);
  if (!row || !resourceAccess(actor, 'workflow', row.workflow_id)) throw new ApprovalError('Approval request not found', 404);
  return row;
}

export async function decideRequest(actor: UserRecord, id: string, approved: boolean, note?: string) {
  const via = requestAuth()?.principal?.via;
  if (via === 'api-key' || via === 'mcp') throw new ApprovalError('A person decides an approval in Needs you', 403);
  let row = readableRequest(actor, id);
  if (!canDecide(actor, row)) throw new ApprovalError('You can see this approval but not decide it: only people who can run the workflow do', 403);
  // A request whose run is gone or was cancelled elsewhere settles now, and answers as the closed request it is.
  row = await reconcile(row);
  if (row.status !== 'waiting') {
    const closed = closedOf(row);
    throw new ApprovalError(closed.message, closed.status);
  }
  await decideApproval(row.execution_id, row.call_id, approved, {
    by: actor.email || actor.name,
    byName: actor.name || actor.email,
    via: 'inbox',
    ...(via && { principal: via }),
    ...(note?.trim() && { note }),
    background: true,
  });
  return viewFor(requestRow(id) ?? row, actor);
}
