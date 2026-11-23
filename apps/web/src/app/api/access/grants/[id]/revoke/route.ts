/** POST /api/access/grants/:id/revoke: the holder gives it back, or an owner, approver or admin takes it back → the grant. An automatic grant is removed now; a manual one waits for someone's Done. 404 for a grant the caller may not see; 409 when it is not in place. */
import { revokeNow } from '@/lib/server/access/grants';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => json(await revokeNow(routeActor(), (await params).id)));
