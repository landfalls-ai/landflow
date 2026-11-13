/**
 * POST /api/executions/:id/checks `{ spanId, name, subject?, decision: 'accepted' | 'sent_back', note? }` → `{ check }`: a
 * person's decision on a failed check of the run (lib/server/journal/checks.ts). It is written to the journal as a check event with a
 * `resolution`; 404 when the span has no such check, 409 when it already has a decision or did not fail.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { resolveCheck } from '@/lib/server/journal/checks';
import { liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  spanId: z.string().min(1).max(512),
  name: z.string().min(1).max(512),
  subject: z.string().min(1).max(512).optional(),
  decision: z.enum(['accepted', 'sent_back']),
  note: z.string().max(2000).optional(),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const record = liveExecution(id) ?? await store.loadExecution(id);
  if (!record) return error('Execution not found', 404);
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const user = currentPrincipal()?.user;
  const check = resolveCheck(id, record.workflowId, body.data, user?.name || user?.email || user?.id || 'a person');
  return json({ check });
});
