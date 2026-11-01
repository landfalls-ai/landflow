/**
 * GET  /api/agent-templates — the personas to start a new agent from (docs/agents.md#templates): the built-in ones, then the
 *      saved ones the caller sees (their projects' and the whole instance's).
 * POST /api/agent-templates — "Save as template" from an agent (`{ agentId, name?, description?, category?, projectId? }`):
 *      its persona, instructions, skills, model without its credential, avatar and settings, never its tools, channels or
 *      schedules. `projectId`: where it's shared (an editor there; default: the agent's project); `null`: the whole instance
 *      (owners and admins).
 */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { agentTemplates, AgentTemplateError } from '@/lib/server/agents/templates';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { projectRole, resourceDenial } from '@/lib/server/projects/access';
import { homeProjectId } from '@/lib/server/projects/store';
import { projectRoleCan } from '@/lib/shared/projects';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ templates: agentTemplates.list(routeActor()) }));

const bodySchema = z
  .object({
    agentId: z.string().min(1),
    name: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    category: z.string().max(60).optional(),
    projectId: z.string().nullable().optional(),
  })
  .strict();

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const denied = resourceDenial(actor, 'agent', body.data.agentId, 'read');
  if (denied) return error(denied.message, denied.status);
  const agent = agentStore.get(body.data.agentId);
  if (!agent) return error('Agent not found', 404);
  try {
    const { agentId: _id, ...input } = body.data;
    // Not given: shared where the agent lives, when the caller may add templates there.
    const home = homeProjectId('agent', agent.id);
    const projectId = input.projectId !== undefined ? input.projectId : home && projectRoleCan.create(projectRole(actor, home)) ? home : undefined;
    return json({ template: agentTemplates.saveFromAgent(agent, { ...input, projectId }, actor, actor.name || actor.email) }, 201);
  } catch (caught) {
    if (caught instanceof AgentTemplateError) return error(caught.message, caught.status);
    throw caught;
  }
});
