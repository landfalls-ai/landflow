/** GET /api/approval-inbox/:id → `{ request }`: one approval request (404 when it does not exist or its workflow is not readable by the caller). */
import { viewFor } from '@/lib/server/approval-inbox/access';
import { readableRequest } from '@/lib/server/approval-inbox/decide';
import { reconcile } from '@/lib/server/approval-inbox/store';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const actor = routeActor();
  return json({ request: viewFor(await reconcile(readableRequest(actor, id)), actor) });
});
