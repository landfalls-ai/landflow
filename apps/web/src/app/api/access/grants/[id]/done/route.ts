/** POST /api/access/grants/:id/done: a manual grant: the approver did it by hand (pending to active, from now) or removed it by hand (ended) → the grant. Never the holder (403). */
import { markDone } from '@/lib/server/access/grants';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => json(await markDone(routeActor(), (await params).id)));
