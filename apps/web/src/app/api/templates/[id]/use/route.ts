/**
 * POST /api/templates/:id/use — create a workflow from a template: `{ name?, folderId?, credentials: { <slot id>:
 * <credential id> } }`. Credentials are checked against their slot's type, missing data tables are created, URL paths
 * made unique; the workflow is saved as an inactive draft in `?projectId=` (else the folder's project, else the
 * caller's personal project), with its data tables: the project's table of a template's table name is reused,
 * another project's never. A team template (`teamName?` names the team) first creates its agents and team in the same
 * project with fresh ids, then the workflow (if it has one) pointing at them; the answer then has `team` and `agents`.
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { createIn, targetProject } from '@/lib/server/projects/http';
import { getTemplate, templateAccess, useTemplate } from '@/lib/server/templates';
import { recordUsage } from '@/lib/server/usage/ledger';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  name: z.string().max(200).optional(),
  teamName: z.string().max(200).optional(),
  folderId: z.string().optional(),
  credentials: z.record(z.string(), z.string().nullable()).optional(),
});

export const POST = handler(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const viewer = currentPrincipal()?.user;
  const template = await getTemplate(id, viewer);
  if (!template || (viewer && !templateAccess(viewer, template).read)) return error('Template not found', 404);
  const projectId = targetProject(request, body.data.folderId);
  const result = await useTemplate(id, body.data, {
    projectId,
    createWorkflow: (save, workflowId) => createIn(projectId, 'workflow', save, (w: Workflow) => w.id, workflowId),
    createTable: (create) => createIn(projectId, 'dataTable', create, (t) => t.id),
    createAgent: (create) => createIn(projectId, 'agent', create, (a) => a.id),
    createTeam: (create) => createIn(projectId, 'agentTeam', create, (t) => t.id),
  });
  const created = (result as { workflow?: { id?: string } }).workflow?.id;
  recordUsage({ kind: 'template.used', ...(created && { workflowId: created }), ...(viewer?.id && { actorId: viewer.id }), attrs: { templateId: id, template: template.name } });
  return json(result, 201);
});
