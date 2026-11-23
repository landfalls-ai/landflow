/**
 * C22: the sources of an agent's knowledge base (the draft's knowledge tool `toolId`): a files-directory folder, an S3 prefix,
 * one site or a Google Drive folder, each with a schedule and a history of sync runs.
 *
 * GET: `{ sources: SourceView[] }`, for anyone who may read the agent.
 * POST `{ kind, name?, settings, credentialId?, schedule }`: add one (201 with the source); 400 for settings that are wrong, a
 * credential of the wrong type or a site address the outbound policy refuses; 403 for a credential the agent's project may not use;
 * 409 for the same place twice; 404 for an agent or base the caller cannot update.
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { createSource, listSources } from '@/lib/server/knowledge-sources';
import { agentStore } from '@/lib/server/agents/store';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { knowledgeConfigOf } from '@/lib/server/agents/knowledge';
import { SOURCE_KINDS, SOURCE_SCHEDULES } from '@/lib/shared/knowledge-sources';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; toolId: string }> };

const Body = z.object({
  kind: z.enum(SOURCE_KINDS as [string, ...string[]]),
  name: z.string().trim().max(120).optional(),
  settings: z.record(z.string(), z.unknown()),
  credentialId: z.string().trim().min(1).max(200).optional(),
  schedule: z.enum(SOURCE_SCHEDULES as [string, ...string[]]),
});

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, toolId } = await params;
  if (!agentStore.get(id) || !canResource(routeActor(), 'agent', id, 'read')) return error('Agent not found', 404);
  if (!knowledgeConfigOf(id, toolId)) return error('Knowledge base not found', 404);
  return json({ sources: listSources(id, toolId) });
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id, toolId } = await params;
  const actor = routeActor();
  if (!agentStore.get(id) || !canResource(actor, 'agent', id, 'update')) return error('Agent not found', 404);
  if (!knowledgeConfigOf(id, toolId)) return error('Knowledge base not found: save the agent first', 404);
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  return json(await createSource(actor, id, toolId, parsed.data as Parameters<typeof createSource>[3]), { status: 201 });
});
