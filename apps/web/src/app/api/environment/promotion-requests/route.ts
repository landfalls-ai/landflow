/**
 * GET /api/environment/promotion-requests — four-eyes promotion requests (owners and admins): pending ones by default,
 * `?status=all` or `?status=pending,approved,…` for others, each with its preview and `canApprove` / `canCancel` for
 * the caller.
 */
import type { PromotionRequestStatus } from '@/lib/shared/secrets';
import { requireUser } from '@/lib/server/auth/guard';
import { listPromotionRequests, promotionApprovalRequired } from '@/lib/server/environments/approvals';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const STATUSES: readonly PromotionRequestStatus[] = ['pending', 'approved', 'rejected', 'canceled', 'stale', 'failed'];

export const GET = handler(async (request: Request) => {
  // The previews hold credentials' non-secret fields and table rows: for those who promote.
  const user = await requireUser('settings:manage');
  const params = new URL(request.url).searchParams;
  const raw = params.get('status');
  const status = raw === 'all' ? 'all' : raw ? raw.split(',').filter((s): s is PromotionRequestStatus => (STATUSES as readonly string[]).includes(s)) : undefined;
  const limit = Number(params.get('limit')) || undefined;
  return json({ requests: listPromotionRequests({ status, limit, viewer: user }), fourEyes: promotionApprovalRequired() });
});
