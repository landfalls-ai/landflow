/**
 * Run a workflow and stream its execution events as SSE. The body may carry
 * the editor's unsaved workflow so "Run" works before "Save", debugger
 * settings, and a `rerun` of an earlier execution (from or only one node).
 * The response's `traceparent` header names the run's trace.
 *
 * `idempotencyKey` (or an `Idempotency-Key` header): a key already used for this workflow within the
 * retention window starts no new run; the stream names the existing execution (`duplicate: true`).
 */
import { context } from '@opentelemetry/api';
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import type { NodeItem } from '@landflow/protocol';
import { error, handler, parseBody, sseHeaders } from '@/lib/server/http';
import { idempotencyKeyOf, MAX_KEY_LENGTH } from '@/lib/server/idempotency';
import { DuplicateRunError, findTrigger, liveExecution, planRerun, RerunError, runWorkflow, type RunOptions } from '@/lib/server/runner';
import { workflowSchema } from '@/lib/server/schemas';
import { store } from '@/lib/server/store';
import { startTrigger, traceparentHeader, type TriggerFire } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const runSchema = z.object({
  workflow: workflowSchema.optional(),
  startNodeId: z.string().optional(),
  chat: z
    .object({
      message: z.string().min(1),
      sessionId: z.string().default('default'),
    })
    .optional(),
  items: z.array(z.object({ json: z.record(z.string(), z.unknown()) })).optional(),
  /** Run the trigger and the nodes before this one, then stop. */
  destinationNodeId: z.string().optional(),
  rerun: z
    .object({
      executionId: z.string(),
      scope: z.enum(['all', 'from', 'only']),
      nodeId: z.string().optional(),
    })
    .optional(),
  debug: z
    .object({
      breakpoints: z.array(z.string()).default([]),
      step: z.boolean().default(false),
    })
    .optional(),
  /** Run at most once per key (within LANDFLOW_IDEMPOTENCY_TTL_HOURS): a repeat names the first execution. */
  idempotencyKey: z.string().trim().min(1).max(MAX_KEY_LENGTH).optional(),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, runSchema);
  if (!body.ok) return body.response;
  const saved = store.getWorkflow(id);
  const workflow = (body.data.workflow ? { ...saved, ...body.data.workflow, id } : saved) as Workflow | undefined;
  if (!workflow) return error('Workflow not found', 404);

  let plan: Omit<RunOptions, 'signal' | 'onEvent' | 'onStart'>;
  let trigger: TriggerFire | undefined;
  if (body.data.rerun) {
    try {
      plan = planRerun(body.data.rerun.executionId, body.data.rerun, workflow);
    } catch (caught) {
      if (caught instanceof RerunError) return error(caught.message, caught.status);
      throw caught;
    }
  } else {
    let startNodeId = body.data.startNodeId;
    let triggerItems = body.data.items as NodeItem[] | undefined;
    let mode: 'manual' | 'chat' = 'manual';
    if (body.data.chat) {
      const trigger = findTrigger(workflow, 'chat', startNodeId);
      if (!trigger) return error('This workflow has no Chat Message trigger');
      startNodeId = trigger.id;
      mode = 'chat';
      triggerItems = [
        {
          json: {
            chatInput: body.data.chat.message,
            sessionId: body.data.chat.sessionId,
          },
        },
      ];
    } else if (!startNodeId) {
      startNodeId = (findTrigger(workflow, 'manual') ?? findTrigger(workflow, 'webhook') ?? findTrigger(workflow, 'chat') ?? findTrigger(workflow, 'schedule'))
        ?.id;
    }
    plan = {
      workflow,
      mode,
      startNodeId,
      triggerItems,
      destinationNodeId: body.data.destinationNodeId,
    };
    trigger = startTrigger({ source: mode, workflowId: id, nodeName: workflow.nodes.find((n) => n.id === startNodeId)?.name });
  }
  // The run happens inside trigger.fire (or, for re-runs, directly under this request's span).
  const runContext = trigger?.context ?? context.active();
  const idempotencyKey = body.data.idempotencyKey ?? idempotencyKeyOf(request);

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client went away
        }
      };
      try {
        const record = await context.with(runContext, () =>
          runWorkflow({
            ...plan,
            ...(body.data.debug && { debug: body.data.debug }),
            ...(idempotencyKey && { idempotencyKey }),
            signal: abort.signal,
            onStart: (executionId) => send('started', { executionId }),
            onEvent: (event) => send('execution', event),
          }),
        );
        trigger?.end();
        send('result', {
          executionId: record.executionId,
          status: record.status,
          error: record.error,
          lastNodeId: record.lastNodeId,
        });
      } catch (caught) {
        trigger?.end(caught);
        if (caught instanceof DuplicateRunError) {
          // The key ran before: name that execution instead of starting another.
          const existing = liveExecution(caught.executionId) ?? store.getExecution(caught.executionId);
          send('started', { executionId: caught.executionId, duplicate: true });
          send('result', { executionId: caught.executionId, status: existing?.status ?? 'running', error: existing?.error, lastNodeId: existing?.lastNodeId, duplicate: true });
          return;
        }
        send('result', {
          status: 'error',
          error: { message: (caught as Error).message },
        });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: { ...sseHeaders, ...traceparentHeader(runContext) } });
});
