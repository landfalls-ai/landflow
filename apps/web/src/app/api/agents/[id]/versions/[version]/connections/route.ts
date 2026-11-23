/**
 * GET /api/agents/:id/versions/:version/connections — `{ agent, version, connections }`: what one published version of the agent
 * is connected to, as the connections route answers it for the published one (AG21: the bubbles of a version view, read-only).
 * Credentials come as names, never data.
 */
import { agentConnections, withDocumentCounts } from '@/lib/server/agents/connections';
import { agentStore } from '@/lib/server/agents/store';
import { agentVersionConfig } from '@/lib/server/agents/versions';
import { error, handler, json } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; version: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, version: raw } = await params;
  const agent = agentStore.get(id);
  if (!agent || !canResource(routeActor(), 'agent', id, 'read')) return error('Agent not found', 404);
  const version = Number(raw);
  const config = Number.isInteger(version) ? agentVersionConfig(id, version) : undefined;
  if (!config) return error('Version not found', 404);
  // `agentConnections` reads the published version's config: this version stands in for it.
  const asVersion = { ...agent, published: { version, publishedAt: '', config } };
  const own = agentConnections(asVersion, {}, {});
  return json({
    agent: { id, name: config.name, published: true, icon: config.icon, color: config.color, ...(config.avatar && { avatar: config.avatar }) },
    version,
    connections: await withDocumentCounts(asVersion, own),
  });
});
