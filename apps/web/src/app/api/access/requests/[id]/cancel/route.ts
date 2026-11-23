/** POST /api/access/requests/:id/cancel: the requester (or an admin) withdraws a waiting request → the request; 409 once it is decided. */
import { cancelRequest } from '@/lib/server/access/requests';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => json(await cancelRequest(routeActor(), (await params).id)));
