/**
 * One access entry (docs/access-requests.md#the-catalog).
 *
 * GET    /api/access/entries/:id → the entry; 404 when it does not exist or the caller may not see it.
 * PATCH  /api/access/entries/:id `{ version, …fields }` (owners and admins; the system, target and credential only admins) → the entry;
 *   409 when `version` is stale; 400 for an invalid field. `outsideMayAsk` (open to people without a Landflow account) is an instance admin's only: an owner
 *   who changes it gets 403.
 * DELETE /api/access/entries/:id (admins) → 204; 409 while access is in place or a request waits: disable it instead.
 */
import { z } from 'zod';
import { deleteEntry, getEntry, updateEntry } from '@/lib/server/access/catalog';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { ACCESS_SYSTEMS } from '@/lib/shared/access';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  durations: z.array(z.number().int().nullable()).max(50).optional(),
  approverIds: z.array(z.string().max(100)).max(100).optional(),
  owners: z.array(z.string().max(100)).max(100).optional(),
  eligibleUserIds: z.array(z.string().max(100)).max(1000).optional(),
  enabled: z.boolean().optional(),
  outsideMayAsk: z.boolean().optional(),
  system: z.enum(ACCESS_SYSTEMS).optional(),
  target: z.record(z.string(), z.unknown()).optional(),
  credentialId: z.string().max(100).nullable().optional(),
});

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Context) => json(getEntry(routeActor(), (await params).id)));

export const PATCH = handler(async (request: Request, { params }: Context) => {
  const body = await parseBody(request, patchSchema);
  if (!body.ok) return body.response;
  const { version, ...patch } = body.data;
  return json(updateEntry(routeActor(), (await params).id, patch, version));
});

export const DELETE = handler(async (_request: Request, { params }: Context) => {
  deleteEntry(routeActor(), (await params).id);
  return new Response(null, { status: 204 });
});
