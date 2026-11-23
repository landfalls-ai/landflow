/**
 * GET /api/approval-inbox → `{ requests }`: the approval requests of runs nobody watches that wait in Needs you (newest first),
 * for the workflows the caller can read. `?status=waiting|all` (default waiting), `?executionId=`. Each is an `InboxRequestView`
 * (lib/shared/approval-inbox.ts) with `canDecide` for the caller; parameters are masked (docs/approval-inbox.md).
 */
import { list } from '@/lib/server/approval-inbox/access';
import { listQuery } from '@/lib/server/approval-inbox/inbox-schema';
import { handler, json, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, listQuery);
  if (!query.ok) return query.response;
  return json({ requests: await list(routeActor(), query.data) });
});
