/**
 * POST /api/workflows/:id/unpublish `{ note? }` — production triggers stop (the workflow becomes inactive) and app
 * webhook triggers remove their hooks. Saved versions and the draft stay; publish again at any time.
 *
 * Four-eyes publishing on (with "unpublishing needs approval"): 202 with `approvalRequired: true` and the `request`.
 */
import { z } from 'zod';
import { currentActorId } from '@/lib/server/auth/context';
import { ApprovalError, publishOrRequest } from '@/lib/server/governance/approvals';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { PublishError } from '@/lib/server/publish';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ note: z.string().max(2000).optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const hasBody = Number(request.headers.get('content-length') ?? 0) > 0 || request.headers.get('content-type')?.includes('json');
  const body = hasBody ? await parseBody(request, bodySchema) : { ok: true as const, data: {} as z.infer<typeof bodySchema> };
  if (!body.ok) return body.response;
  try {
    const outcome = await publishOrRequest({ workflowId: id, action: 'unpublish', note: body.data.note, by: currentActorId() });
    return json(outcome, outcome.approvalRequired ? 202 : 200);
  } catch (caught) {
    if (caught instanceof PublishError || caught instanceof ApprovalError) return error(caught.message, caught.status);
    throw caught;
  }
});
