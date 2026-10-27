/**
 * POST /api/workflows/:id/publish `{ versionId?, note? }` — publish a version (default: the saved draft). Production
 * triggers (webhooks, forms, schedules, polls, MCP and app webhook triggers, error workflows, Execute Workflow from
 * production runs) run it from now on; the workflow becomes active. Publishing an older version is a rollback.
 * Answers the publication status, with `triggerErrors` for app webhooks that could not be registered (retried).
 *
 * Four-eyes publishing on (Settings → Governance): nothing is published yet; the answer is 202 with
 * `approvalRequired: true` and the publish `request` another person approves. Nodes the governance policy doesn't
 * allow: 422.
 *
 * With `at` (ISO 8601, in the future) nothing happens now: the publish is scheduled (lib/server/publish-schedule.ts) and the
 * answer is 202 `{ scheduled }`. Four-eyes publishing on: the schedule waits for its request's approval and then goes live at `at`.
 */
import { z } from 'zod';
import { currentActorId } from '@/lib/server/auth/context';
import { ApprovalError, publishOrRequest } from '@/lib/server/governance/approvals';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { PublishError } from '@/lib/server/publish';
import { ScheduleError, schedulePublish } from '@/lib/server/publish-schedule';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ versionId: z.string().min(1).max(200).optional(), note: z.string().max(2000).optional(), at: z.string().min(1).max(64).optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const hasBody = Number(request.headers.get('content-length') ?? 0) > 0 || request.headers.get('content-type')?.includes('json');
  const body = hasBody ? await parseBody(request, bodySchema) : { ok: true as const, data: {} as z.infer<typeof bodySchema> };
  if (!body.ok) return body.response;
  try {
    const { versionId, note, at } = body.data;
    // `at`: not now, but at that time (ISO 8601): 202 `{ scheduled }`, or with four-eyes on, with the request that approves it.
    if (at) return json({ scheduled: schedulePublish({ workflowId: id, action: 'publish', versionId, at, note, by: currentActorId() }) }, 202);
    const outcome = await publishOrRequest({ workflowId: id, action: 'publish', versionId, note, by: currentActorId() });
    return json(outcome, outcome.approvalRequired ? 202 : 200);
  } catch (caught) {
    if (caught instanceof PublishError || caught instanceof ApprovalError || caught instanceof ScheduleError) return error(caught.message, caught.status);
    throw caught;
  }
});
