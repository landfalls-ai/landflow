/**
 * POST { message } — run the draft agent once on that message with approvals denied (the smoke test, docs/assistant.md
 * "Agents and teams"); answers `{ smoke }` (lib/shared/agent-card.ts `AgentSmoke`). The session it ran in is deleted after.
 * 404 for an agent the caller cannot see, 400 for one with no model.
 */
import { z } from 'zod';
import { smokeTest, SmokeTestError } from '@/lib/server/agents/smoke-test';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { resourceAccess } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  if (!resourceAccess(routeActor(), 'agent', id)?.home) return error('Agent not found', 404);
  const body = await parseBody(request, z.object({ message: z.string().trim().min(1).max(4_000) }));
  if (!body.ok) return body.response;
  try {
    return json({ smoke: await smokeTest(id, body.data.message, { signal: request.signal }) });
  } catch (caught) {
    return caught instanceof SmokeTestError ? error(caught.message, caught.status) : error((caught as Error).message, 500);
  }
});
