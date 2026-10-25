import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const id = (await params).id;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get('limit')) || 100));
  return json({ sessions: agentStore.listSessions(id, limit) });
});
