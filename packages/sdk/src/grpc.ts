/**
 * gRPC binding: implements landflow.plugin.v1.PluginService for a plugin.
 * Execute, LoadOptions and TestCredentials continue the caller's W3C trace
 * from the call metadata (`traceparent`, `tracestate`, `baggage`).
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
import { findCredentialType, serveExecute, serveLoadOptions, serveTestCredentials, serveWebhook, serveWebhookMethod } from './handlers';
import { buildManifest, type IPlugin } from './node';
import { contextFromMetadata, getTelemetry, type Telemetry } from './otel';
import { findNode, toErrorPayload } from './runtime';

type Callback = grpc.sendUnaryData<unknown>;
type Call<T> = grpc.ServerUnaryCall<T, unknown>;

export interface PluginServiceOptions {
  /** Default: getTelemetry() at call time (what serve() installed, else passive). */
  telemetry?: Telemetry;
}

export function createPluginService(plugin: IPlugin, options: PluginServiceOptions = {}): grpc.UntypedServiceImplementation {
  const startedAt = Date.now();
  const manifest = manifestToMsg(buildManifest(plugin));
  const telemetryFor = () => options.telemetry ?? getTelemetry();

  return {
    GetManifest(_call: Call<unknown>, callback: Callback) {
      callback(null, manifest);
    },
    async Execute(call: Call<ExecuteRequestMsg>, callback: Callback) {
      try {
        const request = executeRequestFromMsg(call.request);
        const node = findNode(plugin.nodes, plugin.info.id, request.node.type);
        if (!node) {
          callback({ code: grpc.status.NOT_FOUND, message: `Unknown node type "${request.node.type}"` });
          return;
        }
        const telemetry = telemetryFor();
        const response = await serveExecute(plugin, node, request, telemetry, contextFromMetadata(telemetry, call.metadata), 'grpc');
        callback(null, executeResponseToMsg(response));
      } catch (error) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: toErrorPayload(error).message });
      }
    },
    async LoadOptions(call: Call<Parameters<typeof loadOptionsRequestFromMsg>[0]>, callback: Callback) {
      try {
        const request = loadOptionsRequestFromMsg(call.request);
        const node = findNode(plugin.nodes, plugin.info.id, request.nodeType);
        if (!node) {
          callback({ code: grpc.status.NOT_FOUND, message: `Unknown node type "${request.nodeType}"` });
          return;
        }
        const telemetry = telemetryFor();
        const options = await serveLoadOptions(plugin, node, request, telemetry, contextFromMetadata(telemetry, call.metadata), 'grpc');
        callback(null, optionsToMsg(options));
      } catch (error) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: toErrorPayload(error).message });
      }
    },
    async TestCredentials(call: Call<{ credentialType: string; data: DynamicValueMsg | null }>, callback: Callback) {
      try {
        const request = testCredentialsRequestFromMsg(call.request);
        if (!findCredentialType(plugin, request.credentialType)) {
          callback({ code: grpc.status.NOT_FOUND, message: `Unknown credential type "${request.credentialType}"` });
          return;
        }
        const telemetry = telemetryFor();
        const response = await serveTestCredentials(plugin, request, telemetry, contextFromMetadata(telemetry, call.metadata), 'grpc');
        callback(null, { ok: response.ok, message: response.message ?? '' });
      } catch (error) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: toErrorPayload(error).message });
      }
    },
    async WebhookMethod(call: Call<WebhookMethodRequestMsg>, callback: Callback) {
      try {
        const request = webhookMethodRequestFromMsg(call.request);
        const node = findNode(plugin.nodes, plugin.info.id, request.node.type);
        if (!node) {
          callback({ code: grpc.status.NOT_FOUND, message: `Unknown node type "${request.node.type}"` });
          return;
        }
        const telemetry = telemetryFor();
        const response = await serveWebhookMethod(plugin, node, request, telemetry, contextFromMetadata(telemetry, call.metadata), 'grpc');
        callback(null, webhookMethodResponseToMsg(response));
      } catch (error) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: toErrorPayload(error).message });
      }
    },
    async ReceiveWebhook(call: Call<ReceiveWebhookRequestMsg>, callback: Callback) {
      try {
        const request = webhookRequestFromMsg(call.request);
        const node = findNode(plugin.nodes, plugin.info.id, request.node.type);
        if (!node) {
          callback({ code: grpc.status.NOT_FOUND, message: `Unknown node type "${request.node.type}"` });
          return;
        }
        const telemetry = telemetryFor();
        const response = await serveWebhook(plugin, node, request, telemetry, contextFromMetadata(telemetry, call.metadata), 'grpc');
        callback(null, webhookResponseToMsg(response));
      } catch (error) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: toErrorPayload(error).message });
      }
    },
    Health(_call: Call<unknown>, callback: Callback) {
      callback(null, {
        status: 'ok',
        uptimeMs: Date.now() - startedAt,
        pluginId: plugin.info.id,
        version: plugin.info.version,
      });
    },
  };
}

export function serveGrpc(plugin: IPlugin, options: { port: number; host?: string; telemetry?: Telemetry }): Promise<grpc.Server> {
  const proto = loadLandflowProto();
  const server = new grpc.Server();
  server.addService(proto.PluginService.service, createPluginService(plugin, { telemetry: options.telemetry }));
  return new Promise((resolve, reject) => {
    server.bindAsync(
      `${options.host ?? '0.0.0.0'}:${options.port}`,
      grpc.ServerCredentials.createInsecure(),
      (error) => (error ? reject(error) : resolve(server)),
    );
  });
}
