/**
 * GET    /api/templates/:id — a template with its workflow, credential slots, setup steps, data tables and whether it
 *        can be used here (`?format=file` downloads it as a template file to import elsewhere).
 * DELETE /api/templates/:id — delete a template saved on this instance.
 */
import { error, handler, json } from '@/lib/server/http';
import { deleteTemplate, getTemplate, TemplateError, templateFile } from '@/lib/server/templates';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const fail = (caught: unknown) => {
  if (caught instanceof TemplateError) return error(caught.message, caught.status, caught.details);
  throw caught;
};

export const GET = handler(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  try {
    const template = await getTemplate(id);
    if (!template) return error('Template not found', 404);
    if (new URL(request.url).searchParams.get('format') !== 'file') return json({ template });
    const name = template.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'template';
    return json(templateFile(template), { headers: { 'content-disposition': `attachment; filename="${name}.template.json"` } });
  } catch (caught) {
    return fail(caught);
  }
});

export const DELETE = handler(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  try {
    deleteTemplate(id);
    return json({ ok: true });
  } catch (caught) {
    return fail(caught);
  }
});
