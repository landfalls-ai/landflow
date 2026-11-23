/**
 * GET /api/agents/:id/versions/:version — `{ version, publishedAt, publishedBy?, publishedByName?, config }`: the config of one published
 * version of an agent, for the history sheet's compare (C23). Anyone who can read the agent may call it; a draft is not a
 * version, so an unknown, unpublished or malformed version is 404, as is an agent the caller cannot read.
 */
import { agentVersionConfig, agentVersionUses } from '@/lib/server/agents/versions';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { getUser } from '@/lib/server/auth/users';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; version: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, version } = await params;
  if (!agentStore.get(id) || !canResource(routeActor(), 'agent', id, 'read')) return error('Agent not found', 404);
  const n = /^[1-9]\d{0,8}$/.test(version) ? Number(version) : undefined;
  const config = n === undefined ? undefined : agentVersionConfig(id, n);
  if (n === undefined || !config) return error('Version not found', 404);
  // When it was published and by whom: the live and the kept versions carry the time; the version table has the person.
  const use = agentVersionUses(id).find((v) => v.version === n);
  const by = use?.publishedBy ? getUser(use.publishedBy)?.name : undefined;
  return json({ version: n, publishedAt: use?.publishedAt ?? null, ...(use?.publishedBy && { publishedBy: use.publishedBy }), ...(by && { publishedByName: by }), config });
});
