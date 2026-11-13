/**
 * GET /api/workflows/:id/schedules — the workflow's scheduled publishes (waiting first, then recent ones): `{ schedules }`.
 * POST `{ action: 'publish' | 'unpublish', at, versionId?, note? }` schedules one (same as `at` on /publish and /unpublish);
 * 201 `{ scheduled }`. See lib/server/publish-schedule.ts.
 */
import { z } from 'zod';
import { currentActorId } from '@/lib/server/auth/context';
import { handler, json, parseBody } from '@/lib/server/http';
import { listSchedules, schedulePublish } from '@/lib/server/publish-schedule';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  action: z.enum(['publish', 'unpublish']),
  at: z.string().min(1).max(64),
  versionId: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
});

export const GET = handler(async (_request: Request, { params }: Ctx) => json({ schedules: listSchedules({ workflowId: (await params).id }) }));

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json({ scheduled: schedulePublish({ workflowId: id, ...body.data, by: currentActorId() }) }, 201);
});
