/**
 * Tool approvals of a waiting AI Agent node (lib/server/approvals.ts).
 *
 * GET  /api/executions/:id/approvals → `{ approval }`: the calls waiting for a person, with the decisions so far.
 * POST /api/executions/:id/approvals `{ callId, approved, input? }` → SSE: `decision` (`{ status: 'waiting' | 'resumed', approval }`);
 * when that was the last open call, the resumed run follows as on the run route (`execution` events, node.chunk
 * included, then `result`). `input` (a JSON object, with `approved: true`) is what a person changed in the call's input: the tool
 * runs with it, and the run's journal says it was edited. An Ask a Person node's request (`approval.confirm`) takes `text` (with `approved: true`
 * and only if the node allows editing: the draft as the person changed it) and `comment` instead of `input`; its call id is `confirm`. Errors before anything is decided answer JSON (404, 409).
 */
import { z } from 'zod';
import type { JsonObject } from '@landflow/protocol';
import { ApprovalError, decideApproval, pendingApproval } from '@/lib/server/approvals';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { sseResponse } from '@/lib/server/sse';
import { liveExecution } from '@/lib/server/runner';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

// `input`: the tool's input as a person edited it; the tool runs with it instead of the call's own (approvals only).
const inputSchema = z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 200_000, 'The edited input is too large');
const decisionSchema = z
  .object({ callId: z.string().min(1), approved: z.boolean(), input: inputSchema.optional(), text: z.string().min(1).max(200_000).optional(), comment: z.string().max(5_000).optional() })
  .refine((body) => body.approved || (body.input === undefined && body.text === undefined), 'Only an approval can carry an edited input or text');

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const record = liveExecution(id) ? undefined : await store.loadExecution(id);
  if (!record && !liveExecution(id)) return error('Execution not found', 404);
  return json({ approval: pendingApproval(record) ?? null });
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, decisionSchema);
  if (!body.ok) return body.response;
  const record = await store.loadExecution(id);
  if (!record) return error('Execution not found', 404);
  const approval = pendingApproval(record);
  if (!approval) return error(`This execution is ${record.status}, not waiting for a tool approval`, 409);
  if (!approval.calls.some((c) => c.id === body.data.callId)) return error('That tool call is not waiting for approval', 404);
  if (approval.decisions?.[body.data.callId]) return error('Already decided', 409);
  const user = currentPrincipal()?.user;

  return sseResponse(request, async (write, close) => {
    // A client that went away (or fell too far behind) loses the stream; the run goes on.
    const send = (event: string, data: unknown) => void write(data, { event });
    try {
      let announced = false;
      const outcome = await decideApproval(id, body.data.callId, body.data.approved, {
        ...(user && { by: user.email || user.name }),
        streaming: true,
        ...(body.data.input && { input: body.data.input as JsonObject }),
        ...(body.data.text !== undefined && { text: body.data.text }),
        ...(body.data.comment !== undefined && { comment: body.data.comment }),
        onEvent: (event) => {
          if (!announced) {
            announced = true;
            send('decision', { status: 'resumed', approval });
          }
          send('execution', event);
        },
      });
      if (outcome.status === 'waiting') send('decision', { status: 'waiting', approval: outcome.approval });
      else {
        if (!announced) send('decision', { status: 'resumed', approval });
        const { record: done } = outcome;
        send('result', {
          executionId: done.executionId,
          status: done.status,
          error: done.error,
          lastNodeId: done.lastNodeId,
          // The agent asked for another approval on its next turn.
          ...(done.status === 'waiting' && done.wait?.data?.approval !== undefined && { approval: done.wait.data.approval }),
        });
      }
    } catch (caught) {
      const status = caught instanceof ApprovalError ? caught.status : 500;
      send('result', { executionId: id, status: 'error', error: { message: (caught as Error).message }, httpStatus: status });
    } finally {
      close();
    }
  }, { route: '/api/executions/:id/approvals' });
});
