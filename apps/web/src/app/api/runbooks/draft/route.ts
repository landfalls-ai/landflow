/**
 * POST /api/runbooks/draft — fold a closed Landfall room (its incident, timeline and optionally its "Room outcomes"
 * row) into reviewable steps. Nothing is saved: the person reviews the steps, then POST /api/runbooks saves them.
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { draftFromRoom, findRunbooks, roomSchema } from '@/lib/server/runbooks';

export const dynamic = 'force-dynamic';

const draftSchema = z.object({ room: roomSchema, alertKind: z.string().max(120).optional(), name: z.string().max(160).optional() });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, draftSchema);
  if (!body.ok) return body.response;
  const draft = draftFromRoom(body.data.room, body.data);
  if (!draft.steps.length) return error('The room has no applied remediation and its outcome has no runbook steps, so there is nothing to fold into a runbook', 422);
  return json({ draft, existing: findRunbooks(draft.alertKind) });
});
