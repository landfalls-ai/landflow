/**
 * GET  /api/templates?search=&category=&source=&projectId=&page= — the templates library: saved on this instance (the
 *      caller's projects' and the instance-wide ones; `projectId`: that project's and the instance-wide ones), built in
 *      and (when LANDFLOW_TEMPLATES_URL is set and a search or `source=remote` asks for them) remote ones, 30 per `page`.
 * POST /api/templates — "Save as template" from a workflow (`{ workflow, name, description, categories, setup,
 *      projectId? }`), or import a template file (`{ data, projectId? }`, the JSON "Export" gives). `projectId`: the
 *      project it belongs to (the caller edits there), `null` instance-wide (owners and admins; their default).
 *      Credentials and pinned data never come along.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { projectRole } from '@/lib/server/projects';
import { importTemplate, listTemplates, saveTemplate, saveTemplateSchema } from '@/lib/server/templates';

export const dynamic = 'force-dynamic';

const SOURCES = ['builtin', 'local', 'remote'] as const;

export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const source = params.get('source');
  if (source && !SOURCES.includes(source as (typeof SOURCES)[number])) return error(`source is one of ${SOURCES.join(', ')}`);
  const viewer = currentPrincipal()?.user;
  const projectId = params.get('projectId') || undefined;
  if (projectId && viewer && !projectRole(viewer, projectId)) return error('Project not found', 404);
  const page = Number(params.get('page') ?? 1);
  return json(
    await listTemplates({
      search: params.get('search') ?? '',
      category: params.get('category') ?? undefined,
      source: (source ?? undefined) as (typeof SOURCES)[number] | undefined,
      ...(projectId && { projectId }),
      ...(viewer && { viewer }),
      ...(Number.isFinite(page) && page > 1 && { page }),
    }),
  );
});

const bodySchema = z.union([z.object({ data: z.unknown(), projectId: z.string().nullable().optional() }).strict(), saveTemplateSchema]);

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const user = currentPrincipal()?.user;
  const author = user?.name || user?.email;
  const template = 'data' in body.data ? importTemplate(body.data.data, author, user, body.data.projectId) : saveTemplate(body.data, author, user);
  return json({ template }, 201);
});
