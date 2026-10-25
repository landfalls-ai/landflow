/** GET /api/publish-requests/:id — one publish request, with `canApprove` / `canCancel` for the caller. */
import { currentPrincipal } from '@/lib/server/auth/guard';
import { getRequest } from '@/lib/server/governance/approvals';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const request = getRequest((await params).id, currentPrincipal()?.user);
  return request ? json({ request }) : error('Publish request not found', 404);
});
