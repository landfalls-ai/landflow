/**
 * GET /api/access/requests/:id → the request with its decisions and grant; 404 for a request the caller may not see (the requester, the
 * entry's approvers and owners, and admins see it).
 */
import { getRequest } from '@/lib/server/access/requests';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => json(getRequest(routeActor(), (await params).id)));
