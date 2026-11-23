/**
 * GET /api/brain/graph — the memory graph: a page of facts as nodes with their subjects, `about` edges and, with
 * `?history=1`, version edges (`updates`, `extends`, `derives`). `?about=<subject>` limits it to one subject
 * (`workflow/<id>`, `agent/<id>`, `entity/<type>/<id>`, `project/<id>` or an entity page's `<type>/<id>`; `depth=2` adds the subjects one
 * link away); without it, the whole brain the caller may see. At most `limit` facts a page (500), paged by an opaque
 * `cursor`. `?forgotten=1` adds the forgotten facts the caller may restore. Anyone who can read executions may call it;
 * what they see is what the facts list shows them (docs/second-brain.md#the-graph).
 */
import { z } from 'zod';
import { brainGraph, parseSubject } from '@/lib/server/brain/graph';
import { canFact } from '@/lib/server/brain/scope';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { decodeCursor, limitParam } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';
import { GRAPH_PAGE_LIMIT } from '@/lib/shared/brain-graph';

export const dynamic = 'force-dynamic';

const flag = z.enum(['0', '1', 'true', 'false']).optional();
const Query = z.object({
  about: z.string().trim().min(1).max(300).optional(),
  depth: z.enum(['1', '2']).default('1'),
  history: flag,
  forgotten: flag,
  cursor: z
    .string()
    .max(512)
    .refine((text) => decodeCursor(text) !== undefined, 'Not a cursor from this API')
    .optional(),
  limit: limitParam(GRAPH_PAGE_LIMIT, GRAPH_PAGE_LIMIT),
});
const on = (value: string | undefined) => value === '1' || value === 'true';

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, Query);
  if (!query.ok) return query.response;
  const actor = routeActor();
  const { about, depth, history, forgotten, cursor, limit } = query.data;
  // A subject the caller may not read is "not found", as for every other Brain page.
  if (about) {
    const subject = parseSubject(about);
    if (!subject || !canFact(actor, subject, 'read')) return error('Subject not found', 404);
  }
  return json(brainGraph(actor, { ...(about && { about }), depth: depth === '2' ? 2 : 1, history: on(history), forgotten: on(forgotten), ...(cursor && { cursor }), limit }));
});
