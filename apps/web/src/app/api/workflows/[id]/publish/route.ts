/**
 * POST /api/workflows/:id/publish `{ versionId?, note? }` — publish a version (default: the saved draft). Production
 * triggers (webhooks, forms, schedules, polls, MCP and app webhook triggers, error workflows, Execute Workflow from
 * production runs) run it from now on; the workflow becomes active. Publishing an older version is a rollback.
 * Answers the publication status, with `triggerErrors` for app webhooks that could not be registered (retried).
 */
import { z } from 'zod';
import { currentActorId } from '@/lib/server/auth/context';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { publishDraft, PublishError, publishVersion } from '@/lib/server/publish';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ versionId: z.string().min(1).max(200).optional(), note: z.string().max(2000).optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const hasBody = Number(request.headers.get('content-length') ?? 0) > 0 || request.headers.get('content-type')?.includes('json');
  const body = hasBody ? await parseBody(request, bodySchema) : { ok: true as const, data: {} as z.infer<typeof bodySchema> };
  if (!body.ok) return body.response;
  const by = currentActorId();
  try {
    const { versionId, note } = body.data;
    return json(versionId ? await publishVersion(id, versionId, by, note) : await publishDraft(id, by, note));
  } catch (caught) {
    if (caught instanceof PublishError) return error(caught.message, caught.status);
    throw caught;
  }
});
