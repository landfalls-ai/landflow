/** POST /api/publish-requests/:id/reject `{ comment? }` — reject it (approvers; the requester withdraws instead). */
import { z } from 'zod';
import { requireUser } from '@/lib/server/auth/guard';
import { rejectRequest } from '@/lib/server/governance/approvals';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ comment: z.string().max(2000).optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const hasBody = Number(request.headers.get('content-length') ?? 0) > 0 || request.headers.get('content-type')?.includes('json');
  const body = hasBody ? await parseBody(request, bodySchema) : { ok: true as const, data: {} as z.infer<typeof bodySchema> };
  if (!body.ok) return body.response;
  const user = await requireUser();
  return json({ request: rejectRequest(id, user, body.data.comment) });
});
