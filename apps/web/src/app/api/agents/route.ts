import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { handler, json, parseBody } from '@/lib/server/http';
import { withOwnership } from '@/lib/server/projects';
import { createInProject, projectParam, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

/** GET ?projectId= — the agents the caller sees, each with its `ownership`. */
export const GET = handler(async (request: Request) => json({ agents: withOwnership(routeActor(), 'agent', agentStore.summaries(), projectParam(request)) }));

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ name: z.string().max(200).optional() }));
  if (!body.ok) return body.response;
  return json({ agent: createInProject(request, 'agent', () => agentStore.create({ name: body.data.name }), (a) => a.id) }, 201);
});
