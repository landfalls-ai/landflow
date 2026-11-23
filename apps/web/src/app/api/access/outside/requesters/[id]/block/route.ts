/** POST /api/access/outside/requesters/:id/block (instance admins): end their sessions, cancel their open requests, send them no more links → the requester. Their grants stay until they end or are revoked. */
import { blockRequester } from '@/lib/server/access/outside/admin';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => json(await blockRequester(routeActor(), (await params).id)));
