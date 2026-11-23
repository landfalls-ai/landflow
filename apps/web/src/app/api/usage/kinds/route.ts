/**
 * GET /api/usage/kinds — the custom event kinds flows record (docs/second-brain.md#your-own-event-kinds), with the
 * attributes each declares.
 * POST /api/usage/kinds { kind, description?, fields? } — declare a kind, or update its description and fields.
 * `kind` is `<namespace>.<name>`, such as work.ticket_moved; the namespace can't be one of Landflow's own (run, node, ai…).
 */
import { z } from 'zod';
import { routeActor } from '@/lib/server/projects/http';
import { handler, json, parseBody } from '@/lib/server/http';
import { getKind, listKinds, saveKind } from '@/lib/server/usage/kinds';

export const dynamic = 'force-dynamic';

const KindBody = z.object({
  kind: z.string().trim().max(64),
  description: z.string().max(300).optional(),
  fields: z
    .array(
      z.object({
        name: z.string().trim().max(40),
        type: z.enum(['string', 'number', 'boolean']),
        required: z.boolean().optional(),
        description: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .optional(),
});

export const GET = handler(async () => json({ kinds: listKinds() }));

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, KindBody);
  if (!parsed.ok) return parsed.response;
  const existed = Boolean(getKind(parsed.data.kind));
  return json({ kind: saveKind({ ...parsed.data, createdBy: routeActor().id }) }, existed ? 200 : 201);
});
