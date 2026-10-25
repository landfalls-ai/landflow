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
    })),
  };
}

function branchToItems(branch: BranchMsg | null | undefined): NodeItem[] {
  return (branch?.items ?? []).map((item) => {
    const out: NodeItem = { json: fromDynamic(item.json, {}) };
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
}): AnnounceRequest {
  return {
    protocol: PROTOCOL_VERSION,
    endpoint: msg.endpoint,
    pluginId: msg.pluginId,
    version: msg.version,
    ...(msg.ttlSeconds > 0 && { ttlSeconds: msg.ttlSeconds }),
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
