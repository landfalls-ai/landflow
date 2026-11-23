import { z } from 'zod';
import type { JsonObject } from '@landflow/protocol';
import { credentials } from '@/lib/server/credentials/vault';
import { handler, json, parseBody } from '@/lib/server/http';
import { defaultProjectId, homeProjectId, usableCredentialIds, visibleIds, withOwnership } from '@/lib/server/projects';
import { createIn, forgetDeleted, projectParam, routeActor, targetProject } from '@/lib/server/projects/http';
import { credentialRateLimitSchema } from '@/lib/server/schemas';
import { store } from '@/lib/server/store';
import { credentialIdsIn } from '@/lib/server/agents/credential-scope';
import { agentStore, configOf } from '@/lib/server/agents/store';
import { recordAudit } from '@/lib/server/audit';
import { auditFailClosed } from '@/lib/server/config/audit';

export const dynamic = 'force-dynamic';

/**
 * GET ?projectId= &workflowId= — the credentials the caller sees, each with its `ownership` (never secrets);
 * `workflowId` keeps the ones that workflow's project may use (the node panel's credential picker); `agentId` the ones an agent's
 * project may use (Spotlight's and the card's picker). Both answer the `projectId` they filtered by.
 */
export const GET = handler(async (request: Request) => {
  const actor = routeActor();
  const params = new URL(request.url).searchParams;
  const workflowId = params.get('workflowId');
  const agentId = params.get('agentId');
  let list = withOwnership(actor, 'credential', credentials.list(), projectParam(request));
  const usableBy = workflowId ? homeProjectId('workflow', workflowId) : agentId ? homeProjectId('agent', agentId) : undefined;
  if (workflowId || agentId) {
    const usable = usableCredentialIds(usableBy, list.map((c) => c.id));
    list = list.filter((c) => usable.has(c.id));
  }
  // "Used by" names only the workflows the caller sees.
  const workflows = visibleIds(actor, 'workflow', store.listWorkflows().map((w) => w.id));
  // Agents count too: an agent's tool or model credential is used, though no workflow node holds it.
  const agents = agentStore.list();
  const seen = visibleIds(actor, 'agent', agents.map((a) => a.id));
  const byAgent = new Map<string, Array<{ agentId: string; agentName: string }>>();
  for (const agent of agents) {
    if (seen && !seen.has(agent.id)) continue;
    for (const id of new Set([...credentialIdsIn(configOf(agent)), ...credentialIdsIn(agent.published?.config)])) byAgent.set(id, [...(byAgent.get(id) ?? []), { agentId: agent.id, agentName: agent.name }]);
  }
  const counted = (c: (typeof list)[number]) => ({ ...c, ...(workflows && { usedBy: c.usedBy.filter((u) => workflows.has(u.workflowId)) }), usedByAgents: byAgent.get(c.id) ?? [] });
  return json({ credentials: list.map(counted), ...(usableBy && { projectId: usableBy }) });
});

/** POST { name, type, data, rateLimit? } */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ name: z.string().max(120).default(''), type: z.string().min(3), data: z.record(z.string(), z.unknown()).default({}), rateLimit: credentialRateLimitSchema.nullable().optional() }));
  if (!body.ok) return body.response;
  // ?projectId= puts it in a project (the caller must be an editor there); else the caller's personal project.
  // The id is chosen first so the credential's project is recorded before it is sealed: the project's key seals it (C31).
  const id = credentials.newId();
  const project = targetProject(request);
  // The project's key is made (in Postgres, in queue mode) before the credential is sealed with it.
  await credentials.ensureProjectKey(project ?? defaultProjectId() ?? '').catch(() => undefined);
  const credential = createIn(project, 'credential', () => credentials.create({ ...body.data, data: body.data.data as JsonObject }, { id, actor: routeActor().id }), (c) => c.id, id);
  // Ids, names and the type only: never the data. The id exists only once it is created, so in fail-closed mode a
  // credential whose event can't be stored is deleted again (the credentials file is no transaction).
  try {
    recordAudit({ action: 'credential.create', target: { type: 'credential', id: credential.id, name: credential.name }, details: { credentialType: credential.type } }, { required: true });
  } catch (failure) {
    if (auditFailClosed()) {
      credentials.delete(credential.id);
      forgetDeleted('credential', credential.id);
    }
    throw failure;
  }
  return json({ credential }, 201);
});
