/**
 * Who sees and who decides an approval-inbox request (docs/approval-inbox.md). Kept apart from store.ts so the claim every door
 * shares (approvals.ts, the email links) does not pull in the project rules.
 */
import type { InboxRequestView } from '../../shared/approval-inbox';
import { canResource, resourceAccess, type Actor } from '../projects/access';
import { reconcile, requestRow, viewOf, type InboxRow } from './store';
import { database } from '../db';

/** Whether `actor` is a signed-in person who may decide (run access on the request's workflow). */
export function canDecide(actor: Actor | undefined, row: Pick<InboxRow, 'workflow_id'>): boolean {
  return Boolean(actor) && canResource(actor, 'workflow', row.workflow_id, 'run');
}

/** The request as `viewer` sees it. */
export const viewFor = (row: InboxRow, viewer?: Actor): InboxRequestView => viewOf(row, canDecide(viewer, row));

/** One request as the routes show it, for `viewer`. */
export function view(id: string, viewer?: Actor): InboxRequestView | undefined {
  const row = requestRow(id);
  return row && viewFor(row, viewer);
}

/** The requests `actor` may read (a workflow they can see), newest first. */
export async function list(actor: Actor | undefined, filter: { status?: 'waiting' | 'all'; executionId?: string } = {}): Promise<InboxRequestView[]> {
  const where: string[] = [];
  const params: string[] = [];
  if ((filter.status ?? 'waiting') === 'waiting') where.push("status = 'waiting'");
  if (filter.executionId) {
    where.push('execution_id = ?');
    params.push(filter.executionId);
  }
  const rows = database().all<InboxRow>(`SELECT * FROM approval_inbox${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC, id DESC LIMIT 500`, ...params);
  const out: InboxRequestView[] = [];
  const seen = new Map<string, boolean>();
  for (const candidate of rows) {
    let readable = seen.get(candidate.workflow_id);
    if (readable === undefined) seen.set(candidate.workflow_id, (readable = Boolean(resourceAccess(actor, 'workflow', candidate.workflow_id))));
    if (!readable) continue;
    const row = await reconcile(candidate);
    if ((filter.status ?? 'waiting') === 'waiting' && row.status !== 'waiting') continue;
    out.push(viewFor(row, actor));
  }
  return out;
}
