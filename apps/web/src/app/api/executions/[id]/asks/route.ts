import { openAsks } from '@/lib/server/a2a/agent-asks';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/executions/:id/asks → `{ asks }`: the commands a Claude Code member of the run asks a person about right now (a push
 * to main, a force push, deleting a remote branch; docs/a2a.md). The run is not paused; the live team node reads this.
 */
export const GET = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return json({ asks: openAsks(id) });
});
