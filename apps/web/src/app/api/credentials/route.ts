import { z } from 'zod';
import type { JsonObject } from '@landflow/protocol';
import { CredentialError, credentials } from '@/lib/server/credentials/vault';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { homeProjectId, usableCredentialIds, visibleIds, withOwnership } from '@/lib/server/projects';
import { createInProject, projectParam, routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

/**
 * GET ?projectId= &workflowId= — the credentials the caller sees, each with its `ownership` (never secrets);
 * `workflowId` keeps the ones that workflow's project may use (the node panel's credential picker).
 */
export const GET = handler(async (request: Request) => {
  const actor = routeActor();
  const workflowId = new URL(request.url).searchParams.get('workflowId');
  let list = withOwnership(actor, 'credential', credentials.list(), projectParam(request));
  const usableBy = workflowId ? homeProjectId('workflow', workflowId) : undefined;
  if (workflowId) {
    const usable = usableCredentialIds(usableBy, list.map((c) => c.id));
    list = list.filter((c) => usable.has(c.id));
  }
  // "Used by" names only the workflows the caller sees.
  const workflows = visibleIds(actor, 'workflow', store.listWorkflows().map((w) => w.id));
  return json({ credentials: workflows ? list.map((c) => ({ ...c, usedBy: c.usedBy.filter((u) => workflows.has(u.workflowId)) })) : list, ...(usableBy && { projectId: usableBy }) });
});

/** POST { name, type, data } */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ name: z.string().max(120).default(''), type: z.string().min(3), data: z.record(z.string(), z.unknown()).default({}) }));
  if (!body.ok) return body.response;
  try {
    // ?projectId= puts it in a project (the caller must be an editor there); else the caller's personal project.
    const credential = createInProject(request, 'credential', () => credentials.create({ ...body.data, data: body.data.data as JsonObject }), (c) => c.id);
    // Ids, names and the type only: never the data.
    recordAudit({ action: 'credential.create', target: { type: 'credential', id: credential.id, name: credential.name }, details: { credentialType: credential.type } });
    return json({ credential }, 201);
  } catch (caught) {
    if (caught instanceof CredentialError) return error(caught.message, caught.status);
    throw caught;
  }
});
