/**
 * gRPC binding helpers (Node.js only). The .proto is embedded as a string so
 * that bundlers (Next.js) never need to locate it on disk; regenerate with
 * `pnpm --filter @landflow/protocol gen:proto` after editing plugin.proto.
 *
 * The converters translate between the proto envelope (DynamicValue = JSON
 * bytes) and the plain JSON types used everywhere else, so business code is
 * transport-agnostic.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import { PLUGIN_PROTO } from './generated/plugin-proto';
import {
  PROTOCOL_VERSION,
  type AnnounceRequest,
  type AnnounceResponse,
  type ExecuteRequest,
  type ExecuteResponse,
  type HealthResponse,
  type LoadOptionsRequest,
  type NodeItem,
  type PluginManifest,
  type PropertyOption,
  type TestCredentialsRequest,
  type TestCredentialsResponse,
  type WebhookMethodRequest,
  type WebhookMethodResponse,
  type WebhookRequest,
  type WebhookResponse,
  type WithdrawRequest,
} from './types';

export { grpc };

const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
};

export interface LandflowGrpcPackage {
  PluginService: grpc.ServiceClientConstructor;
  RegistryService: grpc.ServiceClientConstructor;
}

let cached: LandflowGrpcPackage | undefined;

export function loadLandflowProto(): LandflowGrpcPackage {
  if (cached) return cached;
  const root = protobuf.parse(PLUGIN_PROTO, { keepCase: false }).root;
  const definition = protoLoader.fromJSON(root.toJSON(), LOADER_OPTIONS);
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    landflow: { plugin: { v1: LandflowGrpcPackage } };
  };
  cached = loaded.landflow.plugin.v1;
  return cached;
}

// ---------------------------------------------------------------------------
// DynamicValue
// ---------------------------------------------------------------------------

export interface DynamicValueMsg {
  json: Uint8Array | Buffer;
}

export function toDynamic(value: unknown): DynamicValueMsg {
  return { json: Buffer.from(JSON.stringify(value ?? null), 'utf8') };
}

export function fromDynamic<T = unknown>(value: DynamicValueMsg | null | undefined, fallback: T): T {
  if (!value || !value.json || value.json.length === 0) return fallback;
  return JSON.parse(Buffer.from(value.json).toString('utf8')) as T;
}

// ---------------------------------------------------------------------------
// Wire message shapes as produced by proto-loader (camelCase, defaults on)
// ---------------------------------------------------------------------------

interface ItemMsg {
  json: DynamicValueMsg | null;
  pairedItem: { item: number; input: number } | null;
  binary?: DynamicValueMsg | null;
}
interface BranchMsg {
  items: ItemMsg[];
}
export interface ExecuteRequestMsg {
  protocol: string;
  executionId: string;
  workflowId: string;
  mode: string;
  node: { id: string; name: string; type: string; typeVersion: number } | null;
  parameters: DynamicValueMsg | null;
  itemParameters: DynamicValueMsg[];
  inputs: BranchMsg[];
  credentials: DynamicValueMsg | null;
  pollState: DynamicValueMsg | null;
  continueOnFail: boolean;
  /** Empty (or absent) when the host predates idempotency keys. */
  idempotencyKey?: string;
  binaryAccess?: { url: string; token: string } | null;
}
export interface ExecuteResponseMsg {
  outputs: BranchMsg[];
  logs: { level: string; message: string }[];
  error: { message: string; description: string; itemIndex: number } | null;
  pollState: DynamicValueMsg | null;
}
export interface PluginInfoMsg {
  id: string;
  name: string;
  version: string;
  description: string;
  language: string;
  sdkName: string;
  sdkVersion: string;
  icon: string;
  author: string;
  homepage: string;
  color: string;
}
export interface ManifestMsg {
  protocol: string;
  plugin: PluginInfoMsg | null;
  nodes: DynamicValueMsg[];
  credentialTypes: DynamicValueMsg[];
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function itemsToBranch(items: NodeItem[]): BranchMsg {
  return {
    items: items.map((item) => ({
      json: toDynamic(item.json),
      pairedItem: item.pairedItem ? { item: item.pairedItem.item, input: item.pairedItem.input ?? 0 } : null,
      binary: item.binary && Object.keys(item.binary).length ? toDynamic(item.binary) : null,
    })),
  };
}

function branchToItems(branch: BranchMsg | null | undefined): NodeItem[] {
  return (branch?.items ?? []).map((item) => {
    const out: NodeItem = { json: fromDynamic(item.json, {}) };
    const binary = fromDynamic<NodeItem['binary'] | null>(item.binary, null);
    if (binary && Object.keys(binary).length) out.binary = binary;
    if (item.pairedItem) out.pairedItem = { item: item.pairedItem.item, input: item.pairedItem.input };
    return out;
  });
}

export function executeRequestToMsg(request: ExecuteRequest): ExecuteRequestMsg {
  return {
    protocol: request.protocol,
    executionId: request.executionId,
    workflowId: request.workflowId ?? '',
    mode: request.mode,
    node: request.node,
    parameters: toDynamic(request.parameters),
    itemParameters: request.itemParameters.map((p) => toDynamic(p)),
    inputs: request.inputs.map(itemsToBranch),
    credentials: request.credentials ? toDynamic(request.credentials) : null,
    pollState: request.pollState ? toDynamic(request.pollState) : null,
    continueOnFail: request.continueOnFail === true,
    ...(request.idempotencyKey && { idempotencyKey: request.idempotencyKey }),
    binaryAccess: request.binaryAccess ? { url: request.binaryAccess.url, token: request.binaryAccess.token } : null,
  };
}

export function executeRequestFromMsg(msg: ExecuteRequestMsg): ExecuteRequest {
  const request: ExecuteRequest = {
    protocol: PROTOCOL_VERSION,
    executionId: msg.executionId,
    mode: (msg.mode || 'manual') as ExecuteRequest['mode'],
    node: msg.node ?? { id: '', name: '', type: '', typeVersion: 1 },
    parameters: fromDynamic(msg.parameters, {}),
    itemParameters: msg.itemParameters.map((p) => fromDynamic(p, {})),
    inputs: msg.inputs.map(branchToItems),
  };
  if (msg.workflowId) request.workflowId = msg.workflowId;
  const credentials = fromDynamic<ExecuteRequest['credentials'] | null>(msg.credentials, null);
  if (credentials) request.credentials = credentials;
  const pollState = fromDynamic<ExecuteRequest['pollState'] | null>(msg.pollState, null);
  if (pollState) request.pollState = pollState;
  if (msg.continueOnFail) request.continueOnFail = true;
  if (msg.idempotencyKey) request.idempotencyKey = msg.idempotencyKey;
  if (msg.binaryAccess?.url) request.binaryAccess = { url: msg.binaryAccess.url, token: msg.binaryAccess.token };
  return request;
}

export function executeResponseToMsg(response: ExecuteResponse): ExecuteResponseMsg {
  return {
    outputs: response.outputs.map(itemsToBranch),
    logs: (response.logs ?? []).map((log) => ({ level: log.level, message: log.message })),
    error: response.error
      ? {
          message: response.error.message,
          description: response.error.description ?? '',
          itemIndex: response.error.itemIndex ?? -1,
        }
      : null,
    pollState: response.pollState ? toDynamic(response.pollState) : null,
  };
}

export function executeResponseFromMsg(msg: ExecuteResponseMsg): ExecuteResponse {
  const response: ExecuteResponse = { outputs: msg.outputs.map(branchToItems) };
  if (msg.logs.length) {
    response.logs = msg.logs.map((log) => ({
      level: (log.level || 'info') as 'info',
      message: log.message,
    }));
  }
  if (msg.error && msg.error.message) {
    response.error = { message: msg.error.message };
    if (msg.error.description) response.error.description = msg.error.description;
    if (msg.error.itemIndex >= 0) response.error.itemIndex = msg.error.itemIndex;
  }
  const pollState = fromDynamic<ExecuteResponse['pollState'] | null>(msg.pollState, null);
  if (pollState) response.pollState = pollState;
  return response;
}

export function manifestToMsg(manifest: PluginManifest): ManifestMsg {
  const { plugin } = manifest;
  return {
    protocol: manifest.protocol,
    plugin: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description ?? '',
      language: plugin.language,
      sdkName: plugin.sdk?.name ?? '',
      sdkVersion: plugin.sdk?.version ?? '',
      icon: plugin.icon ?? '',
      author: plugin.author ?? '',
      homepage: plugin.homepage ?? '',
      color: plugin.color ?? '',
    },
    nodes: manifest.nodes.map((node) => toDynamic(node)),
    credentialTypes: (manifest.credentialTypes ?? []).map((type) => toDynamic(type)),
  };
}

/** Returns an unvalidated manifest — run it through parseManifest() before use. */
export function manifestFromMsg(msg: ManifestMsg): unknown {
  const p = msg.plugin;
  return {
    protocol: msg.protocol,
    plugin: p
      ? {
          id: p.id,
          name: p.name,
          version: p.version,
          language: p.language,
          ...(p.description && { description: p.description }),
          ...(p.sdkName && { sdk: { name: p.sdkName, version: p.sdkVersion } }),
          ...(p.icon && { icon: p.icon }),
          ...(p.color && { color: p.color }),
          ...(p.author && { author: p.author }),
          ...(p.homepage && { homepage: p.homepage }),
        }
      : null,
    nodes: msg.nodes.map((node) => fromDynamic(node, null)),
    ...(msg.credentialTypes?.length && { credentialTypes: msg.credentialTypes.map((type) => fromDynamic(type, null)) }),
  };
}

export function loadOptionsRequestToMsg(request: LoadOptionsRequest) {
  return {
    nodeType: request.nodeType,
    method: request.method,
    parameters: toDynamic(request.parameters),
    credentials: request.credentials ? toDynamic(request.credentials) : null,
  };
}

export function loadOptionsRequestFromMsg(msg: {
  nodeType: string;
  method: string;
  parameters: DynamicValueMsg | null;
  credentials?: DynamicValueMsg | null;
}): LoadOptionsRequest {
  const request: LoadOptionsRequest = { nodeType: msg.nodeType, method: msg.method, parameters: fromDynamic(msg.parameters, {}) };
  const credentials = fromDynamic<LoadOptionsRequest['credentials'] | null>(msg.credentials, null);
  if (credentials) request.credentials = credentials;
  return request;
}

export function testCredentialsRequestToMsg(request: TestCredentialsRequest) {
  return { credentialType: request.credentialType, data: toDynamic(request.data) };
}

export function testCredentialsRequestFromMsg(msg: { credentialType: string; data: DynamicValueMsg | null }): TestCredentialsRequest {
  return { credentialType: msg.credentialType, data: fromDynamic(msg.data, {}) };
}

export function testCredentialsResponseToMsg(response: TestCredentialsResponse) {
  return { ok: response.ok, message: response.message ?? '' };
}

export function testCredentialsResponseFromMsg(msg: { ok: boolean; message: string }): TestCredentialsResponse {
  return { ok: Boolean(msg.ok), ...(msg.message && { message: msg.message }) };
}

export function optionsToMsg(options: PropertyOption[]) {
  return { options: toDynamic(options) };
}

export function optionsFromMsg(msg: { options: DynamicValueMsg | null }): PropertyOption[] {
  return fromDynamic(msg.options, []);
}

// ---------------------------------------------------------------------------
// App webhook triggers (WebhookMethod, ReceiveWebhook)
// ---------------------------------------------------------------------------

type NodeRefMsg = { id: string; name: string; type: string; typeVersion: number } | null;
type LogMsg = { level: string; message: string };
type NodeErrorMsg = { message: string; description: string; itemIndex: number } | null;

export interface WebhookMethodRequestMsg {
  protocol: string;
  method: string;
  workflowId: string;
  node: NodeRefMsg;
  parameters: DynamicValueMsg | null;
  credentials: DynamicValueMsg | null;
  webhookUrl: string;
  staticData: DynamicValueMsg | null;
}
export interface WebhookMethodResponseMsg {
  exists: boolean;
  staticData: DynamicValueMsg | null;
  logs: LogMsg[];
  error: NodeErrorMsg;
}
export interface ReceiveWebhookRequestMsg {
  protocol: string;
  workflowId: string;
  node: NodeRefMsg;
  parameters: DynamicValueMsg | null;
  credentials: DynamicValueMsg | null;
  webhookUrl: string;
  staticData: DynamicValueMsg | null;
  request: { method: string; path: string; headers: Record<string, string>; query: Record<string, string>; body: Uint8Array | Buffer } | null;
}
export interface ReceiveWebhookResponseMsg {
  items: ItemMsg[];
  response: { status: number; headers: Record<string, string>; body: Uint8Array | Buffer } | null;
  staticData: DynamicValueMsg | null;
  idempotencyKey: string;
  logs: LogMsg[];
  error: NodeErrorMsg;
}

const nodeRefFromMsg = (node: NodeRefMsg) => node ?? { id: '', name: '', type: '', typeVersion: 1 };
const logsToMsg = (logs: WebhookResponse['logs']): LogMsg[] => (logs ?? []).map((log) => ({ level: log.level, message: log.message }));
const errorToMsg = (error: WebhookResponse['error']): NodeErrorMsg =>
  error ? { message: error.message, description: error.description ?? '', itemIndex: error.itemIndex ?? -1 } : null;

function logsAndErrorFromMsg(msg: { logs: LogMsg[]; error: NodeErrorMsg }): Pick<WebhookResponse, 'logs' | 'error'> {
  const out: Pick<WebhookResponse, 'logs' | 'error'> = {};
  if (msg.logs?.length) out.logs = msg.logs.map((log) => ({ level: (log.level || 'info') as 'info', message: log.message }));
  if (msg.error?.message) {
    out.error = { message: msg.error.message, ...(msg.error.description && { description: msg.error.description }), ...(msg.error.itemIndex >= 0 && { itemIndex: msg.error.itemIndex }) };
  }
  return out;
}

export function webhookMethodRequestToMsg(request: WebhookMethodRequest): WebhookMethodRequestMsg {
  return {
    protocol: request.protocol,
    method: request.method,
    workflowId: request.workflowId,
    node: request.node,
    parameters: toDynamic(request.parameters),
    credentials: request.credentials ? toDynamic(request.credentials) : null,
    webhookUrl: request.webhookUrl,
    staticData: toDynamic(request.staticData ?? {}),
  };
}

export function webhookMethodRequestFromMsg(msg: WebhookMethodRequestMsg): WebhookMethodRequest {
  const request: WebhookMethodRequest = {
    protocol: PROTOCOL_VERSION,
    method: msg.method as WebhookMethodRequest['method'],
    workflowId: msg.workflowId,
    node: nodeRefFromMsg(msg.node),
    parameters: fromDynamic(msg.parameters, {}),
    webhookUrl: msg.webhookUrl,
    staticData: fromDynamic(msg.staticData, {}) ?? {},
  };
  const credentials = fromDynamic<WebhookMethodRequest['credentials'] | null>(msg.credentials, null);
  if (credentials) request.credentials = credentials;
  return request;
}

export function webhookMethodResponseToMsg(response: WebhookMethodResponse): WebhookMethodResponseMsg {
  return {
    exists: response.exists === true,
    staticData: response.staticData ? toDynamic(response.staticData) : null,
    logs: logsToMsg(response.logs),
    error: errorToMsg(response.error),
  };
}

export function webhookMethodResponseFromMsg(msg: WebhookMethodResponseMsg): WebhookMethodResponse {
  const response: WebhookMethodResponse = { ...logsAndErrorFromMsg(msg) };
  if (msg.exists) response.exists = true;
  const staticData = fromDynamic<WebhookMethodResponse['staticData'] | null>(msg.staticData, null);
  if (staticData) response.staticData = staticData;
  return response;
}

export function webhookRequestToMsg(request: WebhookRequest): ReceiveWebhookRequestMsg {
  return {
    protocol: request.protocol,
    workflowId: request.workflowId,
    node: request.node,
    parameters: toDynamic(request.parameters),
    credentials: request.credentials ? toDynamic(request.credentials) : null,
    webhookUrl: request.webhookUrl,
    staticData: toDynamic(request.staticData ?? {}),
    request: {
      method: request.request.method,
      path: request.request.path,
      headers: request.request.headers,
      query: request.request.query,
      body: Buffer.from(request.request.body ?? '', 'base64'),
    },
  };
}

export function webhookRequestFromMsg(msg: ReceiveWebhookRequestMsg): WebhookRequest {
  const incoming = msg.request;
  const request: WebhookRequest = {
    protocol: PROTOCOL_VERSION,
    workflowId: msg.workflowId,
    node: nodeRefFromMsg(msg.node),
    parameters: fromDynamic(msg.parameters, {}),
    webhookUrl: msg.webhookUrl,
    staticData: fromDynamic(msg.staticData, {}) ?? {},
    request: {
      method: incoming?.method ?? 'POST',
      path: incoming?.path ?? '',
      headers: { ...(incoming?.headers ?? {}) },
      query: { ...(incoming?.query ?? {}) },
      body: incoming?.body ? Buffer.from(incoming.body).toString('base64') : '',
    },
  };
  const credentials = fromDynamic<WebhookRequest['credentials'] | null>(msg.credentials, null);
  if (credentials) request.credentials = credentials;
  return request;
}

export function webhookResponseToMsg(response: WebhookResponse): ReceiveWebhookResponseMsg {
  return {
    items: response.items?.length ? itemsToBranch(response.items).items : [],
    response: response.response
      ? { status: response.response.status ?? 0, headers: response.response.headers ?? {}, body: Buffer.from(response.response.body ?? '', 'utf8') }
      : null,
    staticData: response.staticData ? toDynamic(response.staticData) : null,
    idempotencyKey: response.idempotencyKey ?? '',
    logs: logsToMsg(response.logs),
    error: errorToMsg(response.error),
  };
}

export function webhookResponseFromMsg(msg: ReceiveWebhookResponseMsg): WebhookResponse {
  const response: WebhookResponse = { ...logsAndErrorFromMsg(msg) };
  const items = branchToItems({ items: msg.items ?? [] });
  if (items.length) response.items = items;
  if (msg.response) {
    const body = msg.response.body?.length ? Buffer.from(msg.response.body).toString('utf8') : undefined;
    response.response = {
      ...(msg.response.status && { status: msg.response.status }),
      ...(Object.keys(msg.response.headers ?? {}).length && { headers: { ...msg.response.headers } }),
      ...(body !== undefined && { body }),
    };
  }
  const staticData = fromDynamic<WebhookResponse['staticData'] | null>(msg.staticData, null);
  if (staticData) response.staticData = staticData;
  if (msg.idempotencyKey) response.idempotencyKey = msg.idempotencyKey;
  return response;
}

export function healthFromMsg(msg: { status: string; uptimeMs: number; pluginId: string; version: string }): HealthResponse {
  return {
    status: msg.status === 'degraded' ? 'degraded' : 'ok',
    uptimeMs: Number(msg.uptimeMs),
    pluginId: msg.pluginId,
    version: msg.version,
  };
}

export function announceFromMsg(msg: {
  protocol: string;
  endpoint: string;
  pluginId: string;
  version: string;
  ttlSeconds: number;
  instanceId?: string;
}): AnnounceRequest {
  return {
    protocol: PROTOCOL_VERSION,
    endpoint: msg.endpoint,
    pluginId: msg.pluginId,
    version: msg.version,
    ...(msg.ttlSeconds > 0 && { ttlSeconds: msg.ttlSeconds }),
    // Empty (proto3's default) from older plugins: left out.
    ...(msg.instanceId && { instanceId: msg.instanceId }),
  };
}

export function announceResponseToMsg(response: AnnounceResponse) {
  return {
    accepted: response.accepted,
    heartbeatIntervalSeconds: response.heartbeatIntervalSeconds,
    message: response.message ?? '',
  };
}

export function withdrawFromMsg(msg: { endpoint: string; pluginId: string }): WithdrawRequest {
  return { endpoint: msg.endpoint, ...(msg.pluginId && { pluginId: msg.pluginId }) };
}

/**
 * Promisified unary call with a deadline. `metadata` entries (e.g. the W3C
 * trace context: traceparent, tracestate, baggage) are sent as gRPC metadata.
 */
export function unary<Req, Res>(
  client: grpc.Client,
  method: string,
  request: Req,
  timeoutMs: number,
  metadata?: Record<string, string>,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + timeoutMs);
    const fn = (client as unknown as Record<string, Function>)[method];
    if (typeof fn !== 'function') {
      reject(new Error(`gRPC method ${method} not found on client`));
      return;
    }
    const md = new grpc.Metadata();
    for (const [key, value] of Object.entries(metadata ?? {})) md.set(key.toLowerCase(), value);
    fn.call(client, request, md, { deadline }, (error: grpc.ServiceError | null, response: Res) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}
