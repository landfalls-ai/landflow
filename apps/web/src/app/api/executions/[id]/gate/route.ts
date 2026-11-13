/**
 * POST /api/executions/:id/gate `{ decision: 'accepted' | 'sent_back', note? }` → `{ status }`: answer a Run report that
 * waits for a person on its failed checks (its gate set to "Ask a person", lib/server/nodes/run-report.ts). The decision
 * is said in the run's journal, settles each failed check, and resumes the run: accepted goes out on "Passed", sent back
 * on "Send back". The same wait can also be answered on its form page (/form/waiting/:id). 409 when the run is not
 * waiting on a Run report.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { resolveCheck } from '@/lib/server/journal/checks';
import { recordDecision } from '@/lib/server/journal/decisions';
import { liveExecution, resumeExecution, ResumeError } from '@/lib/server/runner';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ decision: z.enum(['accepted', 'sent_back']), note: z.string().max(2000).optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  if (liveExecution(id)) return error('This execution is running, not waiting on a Run report', 409);
  const record = await store.loadExecution(id);
  if (!record) return error('Execution not found', 404);
  const gate = record.status === 'waiting' ? (record.wait?.data?.runReport as { gate?: boolean; failed?: Array<{ name: string; spanId?: string }> } | undefined) : undefined;
  if (!gate?.gate) return error(`This execution is ${record.status}, not waiting on a Run report`, 409);
  const user = currentPrincipal()?.user;
  const by = user?.name || user?.email || user?.id || 'a person';
  const { decision, note } = body.data;
  recordDecision(id, record.workflowId, { id: user?.id ?? 'unknown', name: by }, `${decision === 'accepted' ? 'Accepted as is' : 'Sent back for a fix'}${note ? `: ${note}` : ''}`);
  for (const check of gate.failed ?? []) {
    if (!check.spanId) continue;
    try {
      await resolveCheck(id, record.workflowId, { spanId: check.spanId, name: check.name, decision, ...(note && { note }) }, by);
    } catch {
      // Settled already (from the strip, one by one): the decision on the run still stands.
    }
  }
  try {
    const done = await resumeExecution(id, { kind: 'form', outputs: [[{ json: { decision, ...(note && { note }), by } }]] });
    return json({ status: done.status });
  } catch (caught) {
    if (caught instanceof ResumeError) return error(caught.message, caught.status);
    throw caught;
  }
});
