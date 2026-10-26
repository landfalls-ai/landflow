/** `plugin.rpc {Method}` client spans and `landflow.plugin.rpc.duration`, with trace-context injection. */
import { context, createContextKey, propagation, type Context } from '@opentelemetry/api';
import { hostMetrics, outcomeOf } from './metrics';
import { failSpan, SpanKind, startSpan } from './spans';

export type RpcMethod = 'Execute' | 'LoadOptions' | 'TestCredentials' | 'GetManifest' | 'WebhookMethod' | 'ReceiveWebhook';

export const RPC_SERVICE = 'landflow.plugin.v1.PluginService';

export interface RpcTarget {
  /** The transport kind: `http`, `grpc` or a broker kind (docs/transports.md). */
  system: string;
  /** "http://127.0.0.1:7101", "grpc://127.0.0.1:7201" or "kafka://kafka-main/twilio". */
  endpoint: string;
  pluginId?: string;
}

/** The selector's choice for the call in flight (lib/server/transports/selector.ts), read by the `plugin.rpc` span. */
export interface TransportChoiceAttributes {
  kind: string;
  reason: string;
}

const TRANSPORT_CHOICE = createContextKey('landflow.transport.choice');

/** Run `fn` with the selector's choice in the active context, so the RPC span it makes carries `landflow.transport.reason`. */
export function withTransportChoice<T>(choice: TransportChoiceAttributes, fn: () => T): T {
  return context.with(context.active().setValue(TRANSPORT_CHOICE, choice), fn);
}

const transportChoice = (from: Context) => from.getValue(TRANSPORT_CHOICE) as TransportChoiceAttributes | undefined;

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
  const choice = transportChoice(context.active());
  const { span, context: spanContext } = startSpan(`plugin.rpc ${method}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'rpc.system': target.system,
      'rpc.service': RPC_SERVICE,
      'rpc.method': method,
      'server.address': host,
      ...(port && { 'server.port': port }),
      ...(target.pluginId && { 'landflow.plugin.id': target.pluginId }),
      // Explainability (docs/transports.md): the transport the call went over and why the selector chose it.
      'landflow.transport': choice?.kind ?? target.system,
      ...(choice && { 'landflow.transport.reason': choice.reason }),
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
