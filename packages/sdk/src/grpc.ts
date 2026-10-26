/**
 * gRPC binding: implements landflow.plugin.v1.PluginService for a plugin, and
 * `grpcBinding()` wraps it as a `TransportBinding` for `serve()`.
 * Execute, LoadOptions and TestCredentials continue the caller's W3C trace
 * from the call metadata (`traceparent`, `tracestate`, `baggage`); the call's
 * gRPC deadline is the dispatcher's deadline and a cancelled call aborts it.
 */
import {
  executeRequestFromMsg,
  executeResponseToMsg,
  grpc,
  loadLandflowProto,
  loadOptionsRequestFromMsg,
  manifestToMsg,
  optionsToMsg,
  testCredentialsRequestFromMsg,
  webhookMethodRequestFromMsg,
  webhookMethodResponseToMsg,
  webhookRequestFromMsg,
  webhookResponseToMsg,
  type DynamicValueMsg,
  type ExecuteRequestMsg,
  type ReceiveWebhookRequestMsg,
  type WebhookMethodRequestMsg,
} from '@landflow/protocol/grpc';
import { executeRequestSchema, type ExecuteRequest } from '@landflow/protocol';
import type { BindingContext, BindingInfo, TransportBinding } from './binding';
import { createDispatcher, DispatchError, type DispatchCall, type Dispatcher } from './dispatcher';
import type { IPlugin } from './node';
import { answerRegistryChallenge, REGISTRY_CHALLENGE_HEADER } from './registry-proof';
import { contextFromMetadata, type Telemetry } from './otel';
import { toErrorPayload } from './runtime';

type Callback = grpc.sendUnaryData<unknown>;
type Call<T> = grpc.ServerUnaryCall<T, unknown>;

export interface PluginServiceOptions {
  /** Default: getTelemetry() at call time (what serve() installed, else passive). */
  telemetry?: Telemetry;
  /** Share one dispatcher (and its concurrency limit) with other bindings; default: a private one over `telemetry`. */
  dispatcher?: Dispatcher;
}

/** gRPC status for a refused or stopped call. */
export function dispatchErrorStatus(error: DispatchError): grpc.status {
  switch (error.code) {
    case 'unknown_node':
    case 'unknown_credential_type':
      return grpc.status.NOT_FOUND;
    case 'deadline_exceeded':
      return grpc.status.DEADLINE_EXCEEDED;
    case 'canceled':
      return grpc.status.CANCELLED;
    case 'capacity':
      return grpc.status.RESOURCE_EXHAUSTED;
  }
}

/** The per-call facts from the call: trace metadata, the gRPC deadline, cancellation. */
function callFrom(call: Call<unknown>, telemetry: Telemetry): DispatchCall {
  const raw = call.getDeadline();
  const deadline = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Infinity;
  const controller = new AbortController();
  if (call.cancelled) controller.abort(new DispatchError('canceled', 'The call was cancelled'));
  else call.once('cancelled', () => controller.abort(new DispatchError('canceled', 'The call was cancelled')));
  return {
    transport: 'grpc',
    parent: contextFromMetadata(telemetry, call.metadata),
    signal: controller.signal,
    ...(Number.isFinite(deadline) && { deadline }),
  };
}

const failWith = (callback: Callback, error: unknown) =>
  error instanceof DispatchError
    ? callback({ code: dispatchErrorStatus(error), message: error.message })
    : callback({ code: grpc.status.INVALID_ARGUMENT, message: toErrorPayload(error).message });

export function createPluginService(plugin: IPlugin, options: PluginServiceOptions = {}): grpc.UntypedServiceImplementation {
  const dispatcher = options.dispatcher ?? createDispatcher(plugin, { telemetry: options.telemetry });
  const manifest = manifestToMsg(dispatcher.manifest);
  const telemetryFor = () => options.telemetry ?? dispatcher.telemetry;

  return {
    GetManifest(call: Call<unknown>, callback: Callback) {
      // Kubernetes discovery: prove LANDFLOW_REGISTRY_SECRET in the response metadata when challenged (registry-proof.ts).
      const challenge = call.metadata.get(REGISTRY_CHALLENGE_HEADER)[0];
      const proof = answerRegistryChallenge(plugin.info.id, typeof challenge === 'string' ? challenge : undefined);
      if (Object.keys(proof).length) {
        const metadata = new grpc.Metadata();
        for (const [name, value] of Object.entries(proof)) metadata.set(name, value);
        call.sendMetadata(metadata);
      }
      callback(null, manifest);
    },
    async Execute(call: Call<ExecuteRequestMsg>, callback: Callback) {
      try {
        // Validate like the HTTP binding does (conformance "malformed-request": INVALID_ARGUMENT, the node never runs).
        const parsed = executeRequestSchema.safeParse(executeRequestFromMsg(call.request));
        if (!parsed.success) return callback({ code: grpc.status.INVALID_ARGUMENT, message: `Invalid ExecuteRequest: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}` });
        callback(null, executeResponseToMsg(await dispatcher.execute(parsed.data as unknown as ExecuteRequest, callFrom(call, telemetryFor()))));
      } catch (error) {
        failWith(callback, error);
      }
    },
    async LoadOptions(call: Call<Parameters<typeof loadOptionsRequestFromMsg>[0]>, callback: Callback) {
      try {
        const request = loadOptionsRequestFromMsg(call.request);
        callback(null, optionsToMsg(await dispatcher.loadOptions(request, callFrom(call, telemetryFor()))));
      } catch (error) {
        failWith(callback, error);
      }
    },
    async TestCredentials(call: Call<{ credentialType: string; data: DynamicValueMsg | null }>, callback: Callback) {
      try {
        const request = testCredentialsRequestFromMsg(call.request);
        const response = await dispatcher.testCredentials(request, callFrom(call, telemetryFor()));
        callback(null, { ok: response.ok, message: response.message ?? '' });
      } catch (error) {
        failWith(callback, error);
      }
    },
    async WebhookMethod(call: Call<WebhookMethodRequestMsg>, callback: Callback) {
      try {
        const request = webhookMethodRequestFromMsg(call.request);
        callback(null, webhookMethodResponseToMsg(await dispatcher.webhookMethod(request, callFrom(call, telemetryFor()))));
      } catch (error) {
        failWith(callback, error);
      }
    },
    async ReceiveWebhook(call: Call<ReceiveWebhookRequestMsg>, callback: Callback) {
      try {
        const request = webhookRequestFromMsg(call.request);
        callback(null, webhookResponseToMsg(await dispatcher.webhook(request, callFrom(call, telemetryFor()))));
      } catch (error) {
        failWith(callback, error);
      }
    },
    Health(_call: Call<unknown>, callback: Callback) {
      callback(null, dispatcher.health());
    },
  };
}

export interface ServeGrpcOptions {
  port: number;
  /** Default 0.0.0.0. */
  host?: string;
  telemetry?: Telemetry;
  dispatcher?: Dispatcher;
}

export function serveGrpc(plugin: IPlugin, options: ServeGrpcOptions): Promise<grpc.Server> {
  const proto = loadLandflowProto();
  const server = new grpc.Server();
  server.addService(proto.PluginService.service, createPluginService(plugin, { telemetry: options.telemetry, dispatcher: options.dispatcher }));
  return new Promise((resolve, reject) => {
    server.bindAsync(
      `${options.host ?? '0.0.0.0'}:${options.port}`,
      grpc.ServerCredentials.createInsecure(),
      (error) => (error ? reject(error) : resolve(server)),
    );
  });
}

export interface GrpcBindingOptions {
  port: number;
  /** Default 0.0.0.0. */
  host?: string;
}

/** The gRPC face as a `TransportBinding`: `serve()` builds one from `{ grpc: port }`. Announces `grpc://<advertiseHost>:<port>`. */
export function grpcBinding(options: GrpcBindingOptions): TransportBinding {
  let server: grpc.Server | undefined;
  let dispatcher: Dispatcher | undefined;
  return {
    kind: 'grpc',
    async start(context: BindingContext): Promise<BindingInfo> {
      dispatcher = context.dispatcher;
      server = await serveGrpc(context.plugin, { port: options.port, host: options.host, dispatcher, telemetry: context.telemetry });
      return { endpoints: [`grpc://${context.advertiseHost}:${options.port}`], description: `gRPC listening on :${options.port}` };
    },
    async stop() {
      const running = server;
      server = undefined;
      if (!running) return;
      // tryShutdown refuses new calls and waits for the ones in flight.
      await new Promise<void>((resolve) => running.tryShutdown(() => resolve()));
      await dispatcher?.drain();
    },
  };
}
