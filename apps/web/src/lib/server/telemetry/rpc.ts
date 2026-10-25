/** `plugin.rpc {Method}` client spans and `landflow.plugin.rpc.duration`, with trace-context injection. */
import { context, propagation } from '@opentelemetry/api';
import { hostMetrics, outcomeOf } from './metrics';
import { failSpan, SpanKind, startSpan } from './spans';

export type RpcMethod = 'Execute' | 'LoadOptions' | 'TestCredentials' | 'GetManifest' | 'WebhookMethod' | 'ReceiveWebhook';

export const RPC_SERVICE = 'landflow.plugin.v1.PluginService';

export interface RpcTarget {
  system: 'http' | 'grpc';
  /** "http://127.0.0.1:7101" or "grpc://127.0.0.1:7201". */
  endpoint: string;
  pluginId?: string;
}

function address(endpoint: string): { host: string; port?: number } {
  try {
    const url = new URL(endpoint.replace(/^grpc:\/\//, 'http://'));
    return { host: url.hostname, ...(url.port && { port: Number(url.port) }) };
  } catch {
    return { host: endpoint };
  }
}

/**
 * Run one RPC inside a client span. `call` receives the W3C trace-context
 * entries (`traceparent`, `tracestate`, `baggage`) to send as HTTP headers or
 * gRPC metadata, so the plugin's server span becomes a child of this one.
 * `pluginId()` is read after the call (GetManifest learns it from the reply).
 */
export async function tracePluginRpc<T>(
  method: RpcMethod,
  target: RpcTarget,
  call: (carrier: Record<string, string>) => Promise<T>,
  pluginId?: () => string | undefined,
): Promise<T> {
  const { host, port } = address(target.endpoint);
  const { span, context: spanContext } = startSpan(`plugin.rpc ${method}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'rpc.system': target.system,
      'rpc.service': RPC_SERVICE,
      'rpc.method': method,
      'server.address': host,
      ...(port && { 'server.port': port }),
      ...(target.pluginId && { 'landflow.plugin.id': target.pluginId }),
    },
  });
  const carrier: Record<string, string> = {};
  propagation.inject(spanContext, carrier);
  const started = performance.now();
  let outcome: 'ok' | 'error' | 'timeout' = 'ok';
  try {
    return await context.with(spanContext, () => call(carrier));
  } catch (error) {
    outcome = outcomeOf(error);
    failSpan(span, error);
    if (outcome === 'timeout') span.setAttribute('error.type', 'timeout');
    throw error;
  } finally {
    const id = pluginId?.() ?? target.pluginId;
    if (id && !target.pluginId) span.setAttribute('landflow.plugin.id', id);
    span.end();
    hostMetrics().rpcDuration.record(performance.now() - started, {
      'landflow.plugin.id': id ?? 'unknown',
      'rpc.system': target.system,
      'rpc.method': method,
      'landflow.outcome': outcome,
    });
  }
}
