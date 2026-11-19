/**
 * POST /api/approval-inbox/:id/deny `{ note? }` → `{ request }` (the settled view): deny one waiting tool call of a run nobody watches.
 * Needs a signed-in person with run access on the workflow (404 without read access, 403 for read without run or an API key).
 * A request already settled answers 409 (who decided, or cancelled) or 410 (expired). The run resumes in the background.
 */
import { ApprovalError } from '@/lib/server/approvals';
import { decideRequest } from '@/lib/server/approval-inbox/decide';
import { decisionBody } from '@/lib/server/approval-inbox/inbox-schema';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const actor = routeActor();
  const body = await parseBody(request, decisionBody, { optional: true });
  if (!body.ok) return body.response;
  try {
    return json({ request: await decideRequest(actor, id, false, body.data.note) });
  } catch (caught) {
    if (caught instanceof ApprovalError) return error(caught.message, caught.status);
    throw caught;
  }
});
