import { z } from 'zod';
import { agentStore, audienceSources } from '@/lib/server/agents/store';
import { canReadSession } from '@/lib/server/agents/session-scope';
import { canResource, executionWorkflowId, isInstanceAdmin, resourceAccess, visibleProjectIds } from '@/lib/server/projects/access';
import { homeProjectId } from '@/lib/server/projects/store';
import { routeActor } from '@/lib/server/projects/http';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { decodeCursor, encodeCursor, limitParam } from '@/lib/server/pagination';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const SOURCES = ['test', 'schedule', 'telegram', 'slack', 'teams', 'workflow', 'agent', 'api'] as const;

const Query = z.object({
  limit: limitParam(200, 100),
  cursor: z
    .string()
    .max(512)
    .refine((text) => decodeCursor(text) !== undefined, 'Not a cursor from this API')
    .optional(),
  /** `people`: test, telegram, slack, teams. `automations`: schedule, workflow, agent, api. Absent: all. */
  audience: z.enum(['people', 'automations']).optional(),
  /** One source. `test` lists the test chat's own sessions (the ones written as "you"), not evaluation runs. */
  source: z.enum(SOURCES).optional(),
  executionId: z.string().trim().max(200).optional(),
  nodeId: z.string().trim().max(200).optional(),
});

/** The sessions of one agent, newest first, paged by `cursor` (answers `nextCursor`). */
export const GET = handler(async (request: Request, { params }: Ctx) => {
  const id = (await params).id;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  // PC13: a session is read only from its own project (agents/session-scope.ts), so the list is cut by the caller's projects.
  const actor = routeActor();
  if (!resourceAccess(actor, 'agent', id)) return error('Agent not found', 404);
  const parsed = parseQuery(request, Query);
  if (!parsed.ok) return parsed.response;
  const { limit, cursor, audience, source, executionId, nodeId } = parsed.data;
  if (executionId) {
    // The sessions a workflow run started (Run an Agent nodes), in full and oldest first: the execution view shows them live.
    // Filtered here over the agent's recent summaries, so it is the same on the file and the database store.
    // PC13: whoever can read the run reads its sessions.
    const workflowId = executionWorkflowId(executionId);
    if (!isInstanceAdmin(actor) && (!workflowId || !canResource(actor, 'workflow', workflowId, 'read'))) return error('Agent not found', 404);
    const sessions = agentStore
      .listSessions(id, 200)
      .filter((s) => s.execution?.executionId === executionId && (!nodeId || s.execution.nodeId === nodeId))
      .flatMap((s) => agentStore.getSession(s.id) ?? [])
      .filter((session) => canReadSession(actor, session))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return json({ sessions });
  }
  const projectIds = visibleProjectIds(actor);
  const home = homeProjectId('agent', id);
  const sources = source ? [source] : audienceSources(audience);
  // One more than asked tells whether there is a next page.
  const rows = agentStore.listSessions(id, limit + 1, {
    ...(sources && { sources }),
    ...(source === 'test' && { userId: 'you' }),
    ...(projectIds && { projectIds }),
    ...(home && { homeProjectId: home }),
    ...(cursor && { cursor: decodeCursor(cursor) }),
  });
  const sessions = rows.slice(0, limit);
  const last = sessions.at(-1);
  return json({ sessions, nextCursor: rows.length > limit && last ? encodeCursor({ s: last.updatedAt, i: last.id }) : null });
});
