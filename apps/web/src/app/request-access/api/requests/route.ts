/**
 * The requester's own access requests (docs/access-requests.md#outside-requesters-what-they-can-ask-and-see). Needs the requester session.
 *
 * GET  /request-access/api/requests → `{ items }`, newest first: state, entry, duration asked and approved, reason, the denial comment or failure note,
 *   the grant, dates. Never an approver, a decision's `by` or a run id (OutsideRequestView).
 * POST /request-access/api/requests `{ entryId, durationMinutes, reason, account? }` → 201 the request. The requester is the signed-in outsider, never a
 *   field. 404 for an entry that is not open to outsiders; 400 for a duration the entry does not offer or a reason outside 3 to 500 characters;
 *   409 when a request or grant already exists (`existingId`) or access requests are not set up; 401 when they no longer stand (blocked, domain removed).
 */
import { z } from 'zod';
import { accessBackend } from '@/lib/server/access/port';
import { outsideRoute } from '@/lib/server/access/outside/http';
import { requesterOfOutside } from '@/lib/server/access/principal';
import { json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ entryId: z.string().min(1).max(100), durationMinutes: z.number().int().nullable(), reason: z.string().max(2000), account: z.string().max(100).optional() });

export const GET = outsideRoute(async ({ requester }) => json({ items: accessBackend().ledger.outside.mine(requesterOfOutside(requester)) }));

export const POST = outsideRoute(
  async ({ req, requester }) => {
    const body = await parseBody(req, bodySchema);
    if (!body.ok) return body.response;
    return json(await accessBackend().ledger.outside.create(requesterOfOutside(requester), { ...body.data, channel: 'form' }), 201);
  },
  { write: true },
);
