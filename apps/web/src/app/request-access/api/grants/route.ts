/** GET /request-access/api/grants → `{ items }`: the requester's own grants (state, until, account), newest first; never an approver or an error text. */
import { accessBackend } from '@/lib/server/access/port';
import { outsideRoute } from '@/lib/server/access/outside/http';
import { requesterOfOutside } from '@/lib/server/access/principal';
import { json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = outsideRoute(async ({ requester }) => json({ items: accessBackend().ledger.outside.grants(requesterOfOutside(requester)) }));
