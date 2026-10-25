/**
 * Production webhooks: /api/webhook/<path> runs every *active* workflow whose
 * Webhook trigger matches the path and method. The trigger's Respond setting
 * picks the answer: immediately (202), when the last node finishes (its output),
 * or from a Respond to Webhook node (sent when that node runs, even if the run
 * continues). A run that starts waiting first answers `{ status: 'waiting' }`.
 * Responses carry the run's `traceparent`.
 */
import { context } from '@opentelemetry/api';
import { error, handler } from '@/lib/server/http';
import { runWorkflow, type RunReply } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { recordWebhookRequest, startTrigger } from '@/lib/server/telemetry';
import { answerWebhook, deferred, requestItem, type RespondMode } from '@/lib/server/webhooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Ctx) {
  const path = (await params).path.join('/');
  const method = request.method.toUpperCase();
  const matches = store.listWorkflows().flatMap((workflow) =>
    workflow.active
      ? workflow.nodes
          .filter((n) => !n.disabled && n.type === 'core.webhook' && String(n.parameters.path ?? '').replace(/^\/+/, '') === path && String(n.parameters.method ?? 'POST') === method)
          .map((node) => ({ workflow, node }))
      : [],
  );
  if (!matches.length) {
    recordWebhookRequest(404);
    return error(`No active workflow listens on ${method} /api/webhook/${path}`, 404);
  }

  const item = await requestItem(request, path);
  const [{ workflow, node }] = matches;
  const trigger = startTrigger({ source: 'webhook', workflowId: workflow.id, nodeName: node.name });
  const respond = (response: Response) => {
    recordWebhookRequest(response.status, workflow.id);
    for (const [key, value] of Object.entries(trigger.headers)) response.headers.set(key, value);
    return response;
  };
  const mode = (['immediately', 'lastNode', 'responseNode'].includes(String(node.parameters.respond)) ? node.parameters.respond : 'lastNode') as RespondMode;
  const reply = deferred<RunReply>();
  let executionId: string | undefined;
  const run = context.with(trigger.context, () =>
    runWorkflow({
      workflow,
      mode: 'webhook',
      startNodeId: node.id,
      triggerItems: [item],
      onStart: (id) => (executionId = id),
      ...(mode === 'responseNode' && { onReply: (value: RunReply) => reply.resolve(value) }),
    }),
  );
  run.then(
    () => trigger.end(),
    (caught) => trigger.end(caught),
  );
  return respond(await answerWebhook(mode, run, reply.promise, { executionId, workflowId: workflow.id }));
}

export const GET = handler(handle);
export const POST = handler(handle);
export const PUT = handler(handle);
export const PATCH = handler(handle);
export const DELETE = handler(handle);
