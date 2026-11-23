/** POST /request-access/api/grants/:id/give-back → the grant: the requester gives back their own access now (an automatic grant is removed now; a manual one waits for someone's Done). 404 for anyone else's grant; 409 when it is not in place. */
import { accessBackend } from '@/lib/server/access/port';
import { outsideRoute } from '@/lib/server/access/outside/http';
import { requesterOfOutside } from '@/lib/server/access/principal';
import { json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = outsideRoute(async ({ requester, params }) => json(await accessBackend().ledger.outside.giveBack(requesterOfOutside(requester), params.id ?? '')), { write: true });
