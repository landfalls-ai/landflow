/**
 * POST /api/access/requests/:id/decision `{ approved, choice?, comment? }`: an approver of the entry (never the requester) decides the waiting
 * request from the Access page. It checks that the caller is one of the request's approvers, then records the decision exactly as the Ask a
 * Person answer does (approvals.ts `decideApproval`), so the flow's own record is what Apply Access Decision reads. An approver who is
 * not in the flow's project can decide here without access to the run. Session only: an API key or an MCP caller is refused.
 * `choice` is one of the durations the approver may allow (the asked one first); the first when none is named. 403 when the caller is not an
 * approver, 409 when the request is settled.
 */
import { z } from 'zod';
import { decideAccessRequest } from '@/lib/server/access/requests';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ approved: z.boolean(), choice: z.string().min(1).max(200).optional(), comment: z.string().max(5000).optional() });

export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json(await decideAccessRequest(routeActor(), (await params).id, body.data));
});
