/**
 * The access catalog (docs/access-requests.md#the-catalog).
 *
 * GET  /api/access/entries → `{ items, people? }`: the entries the caller may see (enabled ones they may ask for; owners and admins all), never with a
 *   credential unless they edit it. `people` (names and ids of active users) is for the editor and sent to people who can edit something.
 * POST /api/access/entries (admins) → 201 the entry.
 */
import { z } from 'zod';
import { activePeople, createEntry, listEntries } from '@/lib/server/access/catalog';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { ACCESS_SYSTEMS } from '@/lib/shared/access';

export const dynamic = 'force-dynamic';

const fields = {
  name: z.string().max(200),
  description: z.string().max(2000).optional(),
  durations: z.array(z.number().int().nullable()).max(50),
  approverIds: z.array(z.string().max(100)).max(100),
  owners: z.array(z.string().max(100)).max(100),
  eligibleUserIds: z.array(z.string().max(100)).max(1000).optional(),
  enabled: z.boolean().optional(),
};

const createSchema = z.object({
  ...fields,
  system: z.enum(ACCESS_SYSTEMS),
  target: z.record(z.string(), z.unknown()).optional(),
  credentialId: z.string().max(100).nullable().optional(),
  // Instance admins only (createEntry refuses an owner who isn't one).
  outsideMayAsk: z.boolean().optional(),
});

export const GET = handler(async () => {
  const actor = routeActor();
  const items = listEntries(actor);
  return json({ items, ...(items.some((entry) => entry.canEdit) || actor.role !== 'member' ? { people: activePeople() } : {}) });
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, createSchema);
  if (!body.ok) return body.response;
  return json(createEntry(routeActor(), body.data), 201);
});
