/** POST /api/access/grants/:id/retry: try a failed grant or a failed removal again (an owner, an approver or an admin; never the holder, 403) → the grant. */
import { retryGrant } from '@/lib/server/access/grants';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => json(await retryGrant(routeActor(), (await params).id)));
