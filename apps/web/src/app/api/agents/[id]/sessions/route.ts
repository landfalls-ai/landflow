import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const id = (await params).id;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  const query = new URL(request.url).searchParams;
  const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 100));
  const executionId = query.get('executionId')?.trim();
  if (executionId) {
    // The sessions a workflow run started (Run an Agent nodes), in full and oldest first: the execution view shows them live.
    // Filtered here over the agent's recent summaries, so it is the same on the file and the database store.
    const nodeId = query.get('nodeId')?.trim();
    const sessions = agentStore
      .listSessions(id, 200)
      .filter((s) => s.execution?.executionId === executionId && (!nodeId || s.execution.nodeId === nodeId))
      .flatMap((s) => agentStore.getSession(s.id) ?? [])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return json({ sessions });
  }
  return json({ sessions: agentStore.listSessions(id, limit) });
});
