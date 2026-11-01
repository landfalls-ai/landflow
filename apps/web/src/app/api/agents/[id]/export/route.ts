/**
 * GET /api/agents/:id/export?format=claude-plugin[&marketplace=1][&preview=1] — the agent as a Claude Code plugin, a zip:
 * `.claude-plugin/plugin.json`, `agents/<slug>.md`, `skills/<slug>/SKILL.md`, and `.landflow/` with what only Landflow
 * uses. `marketplace=1` adds `.claude-plugin/marketplace.json`; `preview=1` answers with the file list instead.
 */
import { agentStore } from '@/lib/server/agents/store';
import { error, handler } from '@/lib/server/http';
import { exportAgentPlugin } from '@/lib/server/marketplace/export';
import { exportQuery, exportResponse } from '@/lib/server/marketplace/export-http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const query = exportQuery(request);
  if (query instanceof Response) return query;
  const agent = agentStore.get((await params).id);
  if (!agent) return error('Agent not found', 404);
  return exportResponse(exportAgentPlugin(agent, query.options), query.preview);
});
