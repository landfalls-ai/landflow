import { agentConfigSchema, asConfig } from '@/lib/server/agents/http';
import { removeAgent } from '@/lib/server/agents/remove'; // SB18:
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { ownershipOf } from '@/lib/server/projects';
import { REFUSED_CREDENTIAL_MESSAGE, refusedCredentials } from '@/lib/server/agents/credential-scope';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const agent = agentStore.get((await params).id);
  return agent ? json({ agent, ownership: ownershipOf(routeActor(), 'agent', agent.id) }) : error('Agent not found', 404);
});

/** Autosave of the builder: replaces the draft; published versions stay as they are. */
export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, agentConfigSchema);
  if (!body.ok) return body.response;
  const { id } = await params;
  // A NEW credential the agent's project may not use cannot be attached (a personal credential on a shared agent); ones the draft already holds stay.
  const refused = refusedCredentials(id, body.data);
  if (refused.length) return error(REFUSED_CREDENTIAL_MESSAGE, 403, { credentialIds: refused });
  const agent = agentStore.saveDraft(id, asConfig(body.data));
  return agent ? json({ agent }) : error('Agent not found', 404);
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  // SB18: the steps (kagent, evals, caches) are one function now, shared with Spotlight's take-back.
  if (!(await removeAgent(id))) return error('Agent not found', 404);
  return json({ ok: true });
});
