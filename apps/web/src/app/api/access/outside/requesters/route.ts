/** GET /api/access/outside/requesters → `{ requesters }`: the people without a Landflow account who signed in (email, how verified, first and last seen, open requests, live grants, blocked). Instance admins only. */
import { listOutsideRequesters } from '@/lib/server/access/outside/admin';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ requesters: listOutsideRequesters(routeActor()) }));
