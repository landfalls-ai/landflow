/**
 * Calls from external services to app webhook triggers (docs/protocol.md §12, lib/server/app-webhooks.ts):
 * /api/webhook/app/<workflowId>/<nodeId> is the URL the trigger registered when its workflow was published.
 *
 * The call goes to the plugin's `webhook()` with its raw body (signatures cover those bytes) and the node's static
 * data (the hook's signing secret); the items it returns start a run of the *published* version, whose trigger node
 * outputs them. The plugin decides the answer (a ping, a challenge, a 401 for a bad signature); by default the service
 * gets 200 `{ status, executionId }`. An idempotency key from the plugin (GitHub's delivery id) makes redeliveries
 * start no second run.
 */
import { context } from '@opentelemetry/api';
import type { WebhookResponse } from '@landflow/protocol';
import { appWebhooks, getStaticData, setStaticData, webhookBase, appWebhookUrl, isAppWebhookTrigger } from '@/lib/server/app-webhooks';
import { error, handler, json } from '@/lib/server/http';
import { registry } from '@/lib/server/plugins/registry';
import { productionWorkflowById } from '@/lib/server/publish';
import { DuplicateRunError, RunBufferedError, runWorkflow, RunSkippedError } from '@/lib/server/runner';
import { logger, recordWebhookRequest, startTrigger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ workflowId: string; nodeId: string }> };

/** Larger bodies are refused (services send JSON events well below this). */
const MAX_BODY_BYTES = Number(process.env.LANDFLOW_APP_WEBHOOK_MAX_BYTES ?? 25 * 1024 * 1024);

function reply(response: WebhookResponse['response'], fallback: () => Response): Response {
  if (!response) return fallback();
  return new Response(response.body ?? null, { status: response.status ?? 200, headers: response.headers ?? {} });
}

async function handle(request: Request, { params }: Ctx) {
  const { workflowId, nodeId } = await params;
  const workflow = productionWorkflowById(workflowId);
  const node = workflow?.nodes.find((n) => n.id === nodeId && !n.disabled);
  if (!workflow || !node) {
    recordWebhookRequest(404);
    return error('No published workflow has an app webhook trigger here', 404);
  }
  const resolved = registry.resolve(node.type);
  if (!isAppWebhookTrigger(resolved) || !resolved.webhook) {
    recordWebhookRequest(503, workflow.id);
    return error('error' in resolved ? resolved.error : `${node.type} is not an app webhook trigger`, 503);
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    recordWebhookRequest(413, workflow.id);
    return error('Request body too large', 413);
  }
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) {
    recordWebhookRequest(413, workflow.id);
    return error('Request body too large', 413);
  }
  // A service can call right after the hook was created (GitHub's ping): wait for the create to store its secret.
  await appWebhooks.settled(workflow.id);

  const url = new URL(request.url);
  const trigger = startTrigger({ source: 'webhook', workflowId: workflow.id, nodeName: node.name });
  const respond = (response: Response) => {
    recordWebhookRequest(response.status, workflow.id);
    for (const [key, value] of Object.entries(trigger.headers)) response.headers.set(key, value);
    return response;
  };
  try {
    const base = await webhookBase(workflow, node, resolved, getStaticData(workflow.id, node.id), appWebhookUrl(workflow.id, node.id));
    const result = await context.with(trigger.context, () =>
      resolved.webhook!({
        ...base,
        request: {
          method: request.method.toUpperCase(),
          path: url.pathname,
          headers: Object.fromEntries([...request.headers].filter(([key]) => key !== 'cookie')),
          query: Object.fromEntries(url.searchParams),
          body: raw.toString('base64'),
        },
      }),
    );
    if (result.staticData) setStaticData(workflow.id, node.id, result.staticData);
    if (result.error) {
      logger.warn('app webhook call failed', { 'landflow.workflow.id': workflow.id, 'landflow.node.name': node.name, error: result.error.message });
      trigger.end(new Error(result.error.message));
      return respond(reply(result.response, () => error(result.error!.message, 500)));
    }
    const items = result.items ?? [];
    if (!items.length) {
      trigger.end();
      return respond(reply(result.response, () => json({ status: 'ignored' })));
    }
    let executionId: string | undefined;
    try {
      const run = context.with(trigger.context, () =>
        runWorkflow({
          workflow,
          mode: 'webhook',
          startNodeId: node.id,
          triggerOutput: { nodeId: node.id, items },
          ...(result.idempotencyKey && { idempotencyKey: result.idempotencyKey }),
          onStart: (id) => (executionId = id),
        }),
      );
      run.then(
        () => trigger.end(),
        (caught) => trigger.end(caught),
      );
      if (!executionId) await run;
    } catch (caught) {
      if (caught instanceof DuplicateRunError) return respond(reply(result.response, () => json({ status: 'duplicate', executionId: caught.executionId })));
      if (caught instanceof RunBufferedError) {
        // Held by debounce or batching: the provider sees a success, so it doesn't retry the event.
        const held = { status: caught.reason, workflowId: workflow.id, count: caught.count, runsAt: caught.dueAt, ...(caught.startedNow && { started: true }) };
        return respond(reply(result.response, () => json(held, 202)));
      }
      if (caught instanceof RunSkippedError) return respond(error(caught.message, 429, { workflowId: workflow.id, reason: caught.reason }));
      throw caught;
    }
    return respond(reply(result.response, () => json({ status: 'started', executionId }, { headers: { 'x-landflow-execution': executionId ?? '' } })));
  } catch (caught) {
    trigger.end(caught);
    throw caught;
  }
}

export const GET = handler(handle);
export const POST = handler(handle);
export const PUT = handler(handle);
export const PATCH = handler(handle);
export const DELETE = handler(handle);
