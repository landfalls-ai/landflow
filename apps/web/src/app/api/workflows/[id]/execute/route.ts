/**
 * POST /api/workflows/:id/execute — start a saved workflow in the background and answer at once with 202
 * `{ executionId, workflowId, status: 'running' }`; follow it with GET /api/executions/:id. The body is optional:
 * `{ input?: object | object[], startNode?: name or id, idempotencyKey? }` (or an `Idempotency-Key` header). The
 * input becomes the start node's items; the default start is the manual, webhook, chat or schedule trigger. A key
 * already used names the first execution (200, `duplicate: true`). Runs are `manual` runs, like /run's.
 */
import { context } from '@opentelemetry/api';
import { z } from 'zod';
import type { JsonObject, NodeItem } from '@landflow/protocol';
import { error, handler, json } from '@/lib/server/http';
import { idempotencyKeyOf, MAX_KEY_LENGTH } from '@/lib/server/idempotency';
import { DuplicateRunError, findTrigger, liveExecution, startInBackground } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { startTrigger, traceparentHeader } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  input: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown())).max(10_000)]).optional(),
  startNode: z.string().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(MAX_KEY_LENGTH).optional(),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const raw = await request.text();
  let input: unknown = {};
  try {
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    return error('Request body must be JSON');
  }
  const body = bodySchema.safeParse(input);
  if (!body.success) return error('Invalid request', 400, { issues: body.error.issues.slice(0, 10) });
  const workflow = store.getWorkflow(id);
  if (!workflow) return error('Workflow not found', 404);

  const ref = body.data.startNode;
  const start = ref
    ? workflow.nodes.find((n) => n.id === ref || n.name === ref)
    : (findTrigger(workflow, 'manual') ?? findTrigger(workflow, 'webhook') ?? findTrigger(workflow, 'chat') ?? findTrigger(workflow, 'schedule'));
  if (ref && !start) return error(`No node "${ref}" in “${workflow.name}”`, 404);
  const items = body.data.input === undefined ? [{}] : Array.isArray(body.data.input) ? body.data.input : [body.data.input];
  const triggerItems: NodeItem[] = items.map((item) => ({ json: item as JsonObject }));
  const idempotencyKey = body.data.idempotencyKey ?? idempotencyKeyOf(request);

  const trigger = startTrigger({ source: 'manual', workflowId: id, nodeName: start?.name });
  try {
    const executionId = await context.with(trigger.context, () =>
      startInBackground({ workflow, mode: 'manual', ...(start && { startNodeId: start.id }), triggerItems, ...(idempotencyKey && { idempotencyKey }) }),
    );
    trigger.end();
    return json({ executionId, workflowId: id, status: 'running' }, { status: 202, headers: traceparentHeader(trigger.context) });
  } catch (caught) {
    trigger.end(caught);
    if (caught instanceof DuplicateRunError) {
      const existing = liveExecution(caught.executionId) ?? await store.loadExecution(caught.executionId);
      return json({ executionId: caught.executionId, workflowId: id, status: existing?.status ?? 'running', duplicate: true });
    }
    throw caught;
  }
});
