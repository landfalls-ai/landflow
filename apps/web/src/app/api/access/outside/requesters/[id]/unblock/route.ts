/** POST /api/access/outside/requesters/:id/unblock (instance admins): let them sign in and ask again → the requester. */
import { unblockRequester } from '@/lib/server/access/outside/admin';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => json(unblockRequester(routeActor(), (await params).id)));
