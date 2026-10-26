/** POST /api/environment/promotion-requests/:id/approve `{ comment? }` — approve and promote: an owner or admin other than the requester. Promotes only what the request previewed (409 when it went stale: ask again); answers the request and the PromotionResult (`result`). */
import { z } from 'zod';
import { requireUser } from '@/lib/server/auth/guard';
import { approvePromotion } from '@/lib/server/environments/approvals';
import { ApprovalError } from '@/lib/server/governance/approvals';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ comment: z.string().max(2000).optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const hasBody = Number(request.headers.get('content-length') ?? 0) > 0 || request.headers.get('content-type')?.includes('json');
  const body = hasBody ? await parseBody(request, bodySchema) : { ok: true as const, data: {} as z.infer<typeof bodySchema> };
  if (!body.ok) return body.response;
  const user = await requireUser('settings:manage');
  try {
    return json(await approvePromotion(id, user, body.data.comment));
  } catch (caught) {
    if (caught instanceof ApprovalError) return error(caught.message, caught.status);
    throw caught;
  }
});
