/**
 * POST /api/workflows/:id/test-update `{ agents }` — a manual run of the production version's graph with the named agents at
 * their latest published versions (AG21). The trigger's data is replayed from the last production run, else the trigger's
 * pinned test data, else 409 `no_input`. Answers `{ executionId, status }`; the run is recorded like any run (both versions).
 */
import { z } from 'zod';
import { testUpdate } from '@/lib/server/agents/updates';
import { currentActorId } from '@/lib/server/auth/context';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id) || !canResource(routeActor(), 'workflow', id, 'run')) return error('Workflow not found', 404);
  const body = await parseBody(request, z.object({ agents: z.array(z.string().min(1).max(200)).min(1).max(50) }));
  if (!body.ok) return body.response;
  return json(await testUpdate(id, body.data.agents, currentActorId(), request.signal));
});
