/** POST /request-access/api/requests/:id/cancel → the request: the requester withdraws their own waiting request. 404 for anyone else's; 409 once it is settled. */
import { accessBackend } from '@/lib/server/access/port';
import { outsideRoute } from '@/lib/server/access/outside/http';
import { requesterOfOutside } from '@/lib/server/access/principal';
import { json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = outsideRoute(async ({ requester, params }) => json(await accessBackend().ledger.outside.cancel(requesterOfOutside(requester), params.id ?? '')), { write: true });
