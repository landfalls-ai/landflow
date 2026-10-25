/**
 * GET  /api/templates?search=&category=&source= — the templates library: saved on this instance, built in and (when
 *      LANDFLOW_TEMPLATES_URL is set and a search or `source=remote` asks for them) remote ones.
 * POST /api/templates — "Save as template" from a workflow (`{ workflow, name, description, categories, setup }`), or
 *      import a template file (`{ data }`, the JSON "Export" gives). Credentials and pinned data never come along.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { importTemplate, listTemplates, saveTemplate, saveTemplateSchema, TemplateError } from '@/lib/server/templates';

export const dynamic = 'force-dynamic';

const SOURCES = ['builtin', 'local', 'remote'] as const;

export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const source = params.get('source');
  if (source && !SOURCES.includes(source as (typeof SOURCES)[number])) return error(`source is one of ${SOURCES.join(', ')}`);
  return json(await listTemplates({ search: params.get('search') ?? '', category: params.get('category') ?? undefined, source: (source ?? undefined) as (typeof SOURCES)[number] | undefined }));
});

const bodySchema = z.union([z.object({ data: z.unknown() }).strict(), saveTemplateSchema]);

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const user = currentPrincipal()?.user;
  const author = user?.name || user?.email;
  try {
    const template = 'data' in body.data ? importTemplate(body.data.data, author) : saveTemplate(body.data, author);
    return json({ template }, 201);
  } catch (caught) {
    if (caught instanceof TemplateError) return error(caught.message, caught.status, caught.details);
    throw caught;
  }
});
