/**
 * GET /api/settings/networks: the networks the caller may see (instance-wide ones, and those of their projects), with each
 * runner's status, version and last seen and the workflows that run in it (C29, docs/network-runners.md). POST creates
 * one { name, description?, projectId? }: a built-in admin's, like every instance-wide settings write (policy.ts).
 */
import { requireUser } from '@/lib/server/auth';
import { handler, json, parseBody } from '@/lib/server/http';
import { createNetwork, listNetworks } from '@/lib/server/networks/store';
import { networkCreateSchema } from '@/lib/server/networks/schema';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const me = await requireUser();
  return json({ networks: listNetworks(me) });
});

export const POST = handler(async (request: Request) => {
  const me = await requireUser('settings:manage');
  const body = await parseBody(request, networkCreateSchema);
  if (!body.ok) return body.response;
  return json({ network: createNetwork(body.data, me) }, 201);
});
