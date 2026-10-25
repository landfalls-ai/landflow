/**
 * POST /api/templates/:id/use — create a workflow from a template: `{ name?, folderId?, credentials: { <slot id>:
 * <credential id> } }`. Credentials are checked against their slot's type, missing data tables are created, URL paths
 * made unique; the workflow is saved as an inactive draft in the caller's project (or `?projectId=`).
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { createInProject } from '@/lib/server/projects/http';
import { TemplateError, useTemplate } from '@/lib/server/templates';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  name: z.string().max(200).optional(),
  folderId: z.string().optional(),
  credentials: z.record(z.string(), z.string().nullable()).optional(),
});

export const POST = handler(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  try {
    const result = await useTemplate(id, body.data, {
      createWorkflow: (save) => createInProject(request, 'workflow', save, (w: Workflow) => w.id),
      createTable: (create) => createInProject(request, 'dataTable', create, (t) => t.id),
    });
    return json(result, 201);
  } catch (caught) {
    if (caught instanceof TemplateError) return error(caught.message, caught.status, caught.details);
    throw caught;
  }
});
