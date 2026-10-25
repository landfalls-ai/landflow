/**
 * GET /api/publish-requests — four-eyes publish requests: pending ones by default; `?workflowId=` for one workflow,
 * `?status=all` or `?status=pending,approved,…` for others. Each carries `canApprove` / `canCancel` for the caller,
 * and `approvable` counts the pending ones the caller may approve (the badge).
 */
import type { PublishRequestStatus } from '@/lib/shared/governance';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { requestList } from '@/lib/server/governance/approvals';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const STATUSES: readonly PublishRequestStatus[] = ['pending', 'approved', 'rejected', 'canceled', 'stale', 'failed'];

export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const raw = params.get('status');
  const status = raw === 'all' ? 'all' : raw ? raw.split(',').filter((s): s is PublishRequestStatus => (STATUSES as readonly string[]).includes(s)) : undefined;
  const limit = Number(params.get('limit')) || undefined;
  return json(requestList({ workflowId: params.get('workflowId') ?? undefined, status, limit, viewer: currentPrincipal()?.user }));
});
