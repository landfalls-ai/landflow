/**
 * Self-registration endpoint for plugins (the HTTP face of RegistryService).
 * Heartbeats are counted, not traced; a (re-)registration gets its own trace.
 */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { announceRequestSchema, withdrawRequestSchema } from '@landflow/protocol';
import { registry } from '@/lib/server/plugins/registry';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { recordHeartbeat } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, announceRequestSchema);
  if (!body.ok) return body.response;
  recordHeartbeat(body.data.pluginId);
  try {
    // The request span is not sampled (heartbeats would drown the traces): detach from it.
    return json(await context.with(ROOT_CONTEXT, () => registry.announce(body.data)));
  } catch (caught) {
    // The host could not pull a valid manifest from the announced endpoint.
    return error((caught as Error).message, 422, { accepted: false, heartbeatIntervalSeconds: 10 });
  }
});

export const DELETE = handler(async (request: Request) => {
  const body = await parseBody(request, withdrawRequestSchema);
  if (!body.ok) return body.response;
  return json({ ok: registry.withdraw(body.data.endpoint) });
});
