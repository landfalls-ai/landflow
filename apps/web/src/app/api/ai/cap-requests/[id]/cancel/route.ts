/** POST /api/ai/cap-requests/:id/cancel → the request: its requester (or an admin) withdraws it while it is open. */
import { cancelCapRequest } from '@/lib/server/llm-gateway/cap-requests';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  return json(cancelCapRequest(routeActor(), id));
});
