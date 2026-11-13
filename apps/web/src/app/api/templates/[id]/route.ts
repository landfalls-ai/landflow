/**
 * GET    /api/templates/:id — a template with its workflow, credential slots, setup steps, data tables and whether it
 *        can be used here (`?format=file` downloads it as a template file to import elsewhere; `?projectId=` counts
 *        that project's allowed nodes). Saved templates of a project show to its members only.
 * PATCH  /api/templates/:id — edit a saved template in place: `{ name?, description?, categories?, setup?, workflowId?,
 *        projectId? }`; `workflowId` replaces its workflow with that saved workflow's (credentials become slots, pinned
 *        data is left out). Editors of its project; owners and admins for instance-wide ones.
 * DELETE /api/templates/:id — delete a saved template (the same people).
 */
import type { Workflow } from '@/lib/shared/types';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { canResource, projectRole } from '@/lib/server/projects';
import { store } from '@/lib/server/store';
import { deleteTemplate, getTemplate, templateAccess, templateFile, updateTemplate, updateTemplateSchema } from '@/lib/server/templates';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const viewer = currentPrincipal()?.user;
  // Another project's node rules stay its own: `projectId` only counts for its members.
  const scope = new URL(request.url).searchParams.get('projectId') || undefined;
  const template = await getTemplate(id, viewer, scope && (!viewer || projectRole(viewer, scope)) ? scope : undefined);
  if (!template || (viewer && !templateAccess(viewer, template).read)) return error('Template not found', 404);
  if (new URL(request.url).searchParams.get('format') !== 'file') return json({ template });
  const name = template.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'template';
  return json(templateFile(template), { headers: { 'content-disposition': `attachment; filename="${name}.template.json"` } });
});

export const PATCH = handler(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await parseBody(request, updateTemplateSchema);
  if (!body.ok) return body.response;
  const viewer = currentPrincipal()?.user;
  const current = await getTemplate(id, viewer);
  if (!current || (viewer && !templateAccess(viewer, current).read)) return error('Template not found', 404);
  let source: Workflow | undefined;
  if (body.data.workflowId) {
    source = store.getWorkflow(body.data.workflowId) as Workflow | undefined;
    if (!source || (viewer && !canResource(viewer, 'workflow', source.id, 'read'))) return error('Workflow not found', 404);
  }
  return json({ template: updateTemplate(id, body.data, viewer, source) });
});

export const DELETE = handler(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const viewer = currentPrincipal()?.user;
  const current = await getTemplate(id, viewer);
  if (!current || (viewer && !templateAccess(viewer, current).read)) return error('Template not found', 404);
  deleteTemplate(id, viewer);
  return json({ ok: true });
});
