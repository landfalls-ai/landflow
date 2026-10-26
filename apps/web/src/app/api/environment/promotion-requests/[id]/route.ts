/** GET /api/environment/promotion-requests/:id — one promotion request with its preview (owners and admins). */
import { requireUser } from '@/lib/server/auth/guard';
import { getPromotionRequest } from '@/lib/server/environments/approvals';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const user = await requireUser('settings:manage');
  const request = getPromotionRequest((await params).id, user);
  return request ? json({ request }) : error('Promotion request not found', 404);
});
