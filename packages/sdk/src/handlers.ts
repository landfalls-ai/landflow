/**
 * Server side of Execute / LoadOptions / TestCredentials, shared by the HTTP
 * and gRPC bindings: one server span per call (child of the host's
 * `plugin.rpc` span, from the extracted W3C context) and the automatic plugin
 * metrics (docs/observability.md §4–5). Health and manifest get no spans.
 */
import { context, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span } from '@opentelemetry/api';
import type { ExecuteRequest, ExecuteResponse, LoadOptionsRequest, PropertyOption, TestCredentialsRequest, TestCredentialsResponse } from '@landflow/protocol';
import { localCredentialName, requestSecrets, type CredentialTypeDefinition } from './credentials';
import type { INodeType, IPlugin } from './node';
import type { Telemetry } from './otel';
import { registerSecrets, scrub, secretValues } from './redact';
import { executeNode, executeTestCredentials, runLoadOptions, toErrorPayload } from './runtime';

export type RpcSystem = 'http' | 'grpc';

const RPC_SERVICE = 'landflow.plugin.v1.PluginService';

function rpcAttributes(system: RpcSystem, method: string): Attributes {
  return { 'rpc.system': system, 'rpc.service': RPC_SERVICE, 'rpc.method': method };
}

function fail(span: Span, error: unknown, message?: string) {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: scrub(message ?? (error as Error)?.message ?? String(error)) });
}

const countItems = (branches: { length: number }[]) => branches.reduce((sum, branch) => sum + branch.length, 0);

export function findCredentialType(plugin: IPlugin, name: string): CredentialTypeDefinition | undefined {
  const local = localCredentialName(name);
  return plugin.credentialTypes?.find((type) => type.name === local);
}

export async function serveExecute(
  plugin: IPlugin,
  node: INodeType,
  request: ExecuteRequest,
  telemetry: Telemetry,
  parent: Context,
  system: RpcSystem,
): Promise<ExecuteResponse> {
  const type = `${plugin.info.id}.${node.description.name}`;
  const itemsIn = countItems(request.inputs);
  // Held until the span has ended, so the redaction processor still knows the values.
  const release = registerSecrets(requestSecrets(request.credentials, plugin.credentialTypes));
  const span = telemetry.tracer.startSpan(
    `plugin.execute ${type}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'landflow.plugin.id': plugin.info.id,
        'landflow.node.type': type,
        'landflow.node.name': request.node.name,
        ...(request.workflowId && { 'landflow.workflow.id': request.workflowId }),
        'landflow.execution.id': request.executionId,
        'landflow.execution.mode': request.mode,
        'landflow.items.in': itemsIn,
        ...rpcAttributes(system, 'Execute'),
      },
    },
    parent,
  );
  const started = performance.now();
  let status: 'success' | 'error' = 'error';
  let itemsOut = 0;
  try {
    const { response, error } = await context.with(trace.setSpan(parent, span), () =>
      executeNode(node, request, { telemetry, credentialTypes: plugin.credentialTypes, pluginId: plugin.info.id }),
    );
    itemsOut = countItems(response.outputs);
    span.setAttribute('landflow.items.out', itemsOut);
    if (response.error) fail(span, error ?? new Error(response.error.message), response.error.message);
    else status = 'success';
    return response;
  } catch (error) {
    fail(span, error);
    throw error;
  } finally {
    span.end();
    release();
    const { instruments } = telemetry;
    const attributes = { 'landflow.node.type': type, 'landflow.node.status': status };
    instruments.executions.add(1, attributes);
    instruments.executeDuration.record(performance.now() - started, attributes);
    instruments.items.add(itemsIn, { 'landflow.node.type': type, 'landflow.direction': 'in' });
    instruments.items.add(itemsOut, { 'landflow.node.type': type, 'landflow.direction': 'out' });
  }
}

export async function serveLoadOptions(
  plugin: IPlugin,
  node: INodeType,
  request: LoadOptionsRequest,
  telemetry: Telemetry,
  parent: Context,
  system: RpcSystem,
): Promise<PropertyOption[]> {
  const release = registerSecrets(requestSecrets(request.credentials, plugin.credentialTypes));
  const span = telemetry.tracer.startSpan(
    `plugin.load_options ${request.method}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'landflow.plugin.id': plugin.info.id,
        'landflow.node.type': `${plugin.info.id}.${node.description.name}`,
        'landflow.load_options.method': request.method,
        ...rpcAttributes(system, 'LoadOptions'),
      },
    },
    parent,
  );
  let outcome: 'ok' | 'error' = 'error';
  try {
    const options = await context.with(trace.setSpan(parent, span), () =>
      runLoadOptions(node, request.method, request.parameters ?? {}, request.credentials, {
        telemetry,
        credentialTypes: plugin.credentialTypes,
        pluginId: plugin.info.id,
      }),
    );
    outcome = 'ok';
    return options;
  } catch (error) {
    fail(span, error, toErrorPayload(error).message);
    throw error;
  } finally {
    span.end();
    release();
    telemetry.instruments.loadOptions.add(1, { 'landflow.load_options.method': request.method, 'landflow.outcome': outcome });
  }
}

export async function serveTestCredentials(
  plugin: IPlugin,
  request: TestCredentialsRequest,
  telemetry: Telemetry,
  parent: Context,
  system: RpcSystem,
): Promise<TestCredentialsResponse> {
  const name = localCredentialName(request.credentialType);
  const release = registerSecrets(secretValues(request.data, findCredentialType(plugin, name)?.properties));
  const span = telemetry.tracer.startSpan(
    `plugin.test_credentials ${name}`,
    {
      kind: SpanKind.SERVER,
      attributes: { 'landflow.plugin.id': plugin.info.id, 'landflow.credential.type': name, ...rpcAttributes(system, 'TestCredentials') },
    },
    parent,
  );
  try {
    const { response, error } = await context.with(trace.setSpan(parent, span), () => executeTestCredentials(plugin, request, { telemetry }));
    span.setAttribute('landflow.credential.ok', response.ok);
    if (error) fail(span, error, response.message);
    return response;
  } finally {
    span.end();
    release();
  }
}
