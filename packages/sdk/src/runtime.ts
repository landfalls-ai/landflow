/**
 * Turns a wire-level ExecuteRequest into an IExecuteContext, runs the node and
 * normalizes whatever it returns into an ExecuteResponse. Used by the dispatcher
 * (every binding: HTTP, gRPC, brokers, MCP) and by the host's in-process
 * transport, so a node behaves the same no matter how it is reached.
 */
import { context as otelContext } from '@opentelemetry/api';
import type {
  ExecuteRequest,
  ExecuteResponse,
  JsonObject,
  LogEntry,
  NodeItem,
  NodeRecord,
  PropertyOption,
  TestCredentialsRequest,
  TestCredentialsResponse,
} from '@landflow/protocol';
import { withPropertyDefaults } from '@landflow/protocol';
import { createBinaryHelpers, httpBinaryClient, type BinaryDataClient } from './binary';
import { credentialAccessor, localCredentialName, requestSecrets, type CredentialTypeDefinition, type ICredentialTestContext } from './credentials';
import { createNodeMetrics, createSpanFunction, createTracedFetch, type TracedFetch } from './instrumentation';
import type { LogAttributes, LogLevel, ProcessLogger } from './logger';
import {
  NodeOperationError,
  type ExecuteResult,
  type HttpRequestOptions,
  type HttpResponse,
  type IExecuteContext,
  type ILoadOptionsContext,
  type ILogger,
  type INodeType,
  type IPlugin,
} from './node';
import { getTelemetry, type Telemetry } from './otel';
import { registerSecrets, scrub, secretValues } from './redact';

export interface ContextExtras {
  getInputConnectionData?: IExecuteContext['getInputConnectionData'];
  /** In-process only: lets the node suspend the execution (the engine provides it for main-flow nodes). */
  putExecutionToWait?: IExecuteContext['putExecutionToWait'];
  /** In-process only: the node's per-execution state. */
  getNodeState?: IExecuteContext['getNodeState'];
  setNodeState?: IExecuteContext['setNodeState'];
  /** In-process only: the node outputs `$('Node')` sees. */
  getNodeOutputs?: IExecuteContext['getNodeOutputs'];
  /** In-process only: streamed answer chunks (set while a streaming response listens). */
  sendChunk?: IExecuteContext['sendChunk'];
  /** In-process only: progress of a running node (`ctx.sendProgress`). */
  sendProgress?: IExecuteContext['sendProgress'];
  /**
   * In-process only: receives each `ctx.artifact` / `ctx.check` as it is made (the engine turns it into a `node.record`
   * event). Without it the records are collected into `ExecuteResponse.records`, which is how remote plugins send them.
   */
  onRecord?: (record: NodeRecord) => void;
  /** Extra log sink (the host streams logs live). */
  onLog?: (entry: LogEntry) => void;
  signal?: AbortSignal;
  /** Epoch ms by which the call must finish (the dispatcher sets it from the binding's deadline); exposed as `ctx.deadline`. */
  deadline?: number;
  /** Telemetry for spans, metrics and the process log (default: getTelemetry()). */
  telemetry?: Telemetry;
  /** The plugin's credential types, so only their password fields are redacted (otherwise every string credential value is). */
  credentialTypes?: readonly CredentialTypeDefinition[];
  /** Qualifies local node types in telemetry attributes. */
  pluginId?: string;
  /** In-process only: the host's binary store (remote plugins use the request's `binaryAccess` over HTTP). */
  binary?: BinaryDataClient;
}

/** Bodies fetch sends as they are (files, forms, streams); anything else that isn't a string goes as JSON. */
const isRawBody = (body: unknown): body is BodyInit =>
  body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof URLSearchParams || body instanceof ReadableStream || (typeof Blob !== 'undefined' && body instanceof Blob) || (typeof FormData !== 'undefined' && body instanceof FormData);

export async function httpRequest(fetcher: TracedFetch, options: HttpRequestOptions): Promise<HttpResponse> {
  const url = new URL(options.url);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: BodyInit | undefined;
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === 'string' || isRawBody(options.body)) body = options.body;
    else {
      body = JSON.stringify(options.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
  }
  const response = await fetcher(url, {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    ...(body instanceof ReadableStream && { duplex: 'half' }),
  } as RequestInit);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => (responseHeaders[key] = value));
  if (options.encoding === 'buffer') return { status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) };
  const text = await response.text();
  const wantsJson = options.json ?? (response.headers.get('content-type') ?? '').includes('json');
  let parsed: unknown = text;
  if (wantsJson && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, headers: responseHeaders, body: parsed };
}

export function qualifiedType(type: string, pluginId?: string): string {
  return pluginId && !type.startsWith(`${pluginId}.`) ? `${pluginId}.${type}` : type;
}

/** A node logger: collects LogEntry (returned to the host), forwards to onLog and writes the process log. */
export function nodeLogger(sink: LogEntry[], processLog: ProcessLogger, onLog?: (entry: LogEntry) => void): ILogger {
  const write = (level: LogLevel) => (message: string, attributes?: LogAttributes) => {
    const entry: LogEntry = { level, message: scrub(String(message)) };
    sink.push(entry);
    onLog?.(entry);
    processLog.log(level, entry.message, attributes);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

interface PollStateBox {
  value?: JsonObject;
  set: boolean;
}

/** Masks the credential values of this call in a record's text and JSON fields. */
function scrubRecord<T extends object>(record: T): T {
  return JSON.parse(scrub(JSON.stringify(record))) as T;
}

function buildContext(node: INodeType, request: ExecuteRequest, logs: LogEntry[], records: NodeRecord[], extras: ContextExtras) {
  const telemetry = extras.telemetry ?? getTelemetry();
  const type = qualifiedType(request.node.type, extras.pluginId);
  const base = otelContext.active();
  // Defaults follow displayOptions per item (the visible property of a name wins); a hidden property falls back
  // to the first default declared under its name.
  const firstDefaults = new Map<string, unknown>();
  for (const p of node.description.properties) if (p.default !== undefined && !firstDefaults.has(p.name)) firstDefaults.set(p.name, p.default);
  const itemDefaults = new Map<number, Record<string, unknown>>();
  const defaultsFor = (itemIndex: number) => {
    let values = itemDefaults.get(itemIndex);
    if (!values) {
      values = withPropertyDefaults(node.description.properties, { ...request.parameters, ...request.itemParameters[itemIndex] });
      itemDefaults.set(itemIndex, values);
    }
    return values;
  };
  const processLog = telemetry.logger.child({
    'landflow.node.type': type,
    'landflow.node.name': request.node.name,
    'landflow.execution.id': request.executionId,
    ...(request.workflowId && { 'landflow.workflow.id': request.workflowId }),
  });
  const logger = nodeLogger(logs, processLog, extras.onLog);
  const http = createTracedFetch(telemetry, { base, signal: extras.signal });
  const poll: PollStateBox = { set: false };
  const report = (record: NodeRecord) => {
    const stamped = scrubRecord({ ...record, at: new Date().toISOString() });
    if (extras.onRecord) extras.onRecord(stamped);
    else records.push(stamped);
  };

  const context: IExecuteContext = {
    getNode: () => request.node,
    getMode: () => request.mode,
    mode: request.mode,
    getExecutionId: () => request.executionId,
    getWorkflowId: () => request.workflowId,
    getIdempotencyKey: () => request.idempotencyKey || undefined,
    continueOnFail: () => request.continueOnFail === true,
    getInputData: (inputIndex = 0) => request.inputs[inputIndex] ?? [],
    getInputCount: () => request.inputs.length,
    getNodeParameter<T>(name: string, itemIndex = 0, fallback?: T): T {
      const perItem = request.itemParameters[itemIndex];
      if (perItem && name in perItem) return perItem[name] as T;
      if (name in request.parameters) return request.parameters[name] as T;
      const visible = defaultsFor(itemIndex);
      if (name in visible) return visible[name] as T;
      if (firstDefaults.has(name)) return firstDefaults.get(name) as T;
      return fallback as T;
    },
    getCredentials: credentialAccessor(request.credentials),
    logger,
    span: createSpanFunction(telemetry, base),
    metrics: createNodeMetrics(telemetry, {
      ...(extras.pluginId && { 'landflow.plugin.id': extras.pluginId }),
      'landflow.node.type': type,
      ...(request.workflowId && { 'landflow.workflow.id': request.workflowId }),
    }),
    http,
    helpers: {
      httpRequest: (options) => httpRequest(http, options),
      returnJsonArray: (data) => (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
      ...createBinaryHelpers(request, extras.binary ?? (request.binaryAccess && httpBinaryClient(request.binaryAccess, http)), extras.signal),
    },
    artifact: (artifact) => report({ type: 'artifact', ...artifact }),
    check: (check) => report({ type: 'check', ...check }),
    getPollState: <T extends JsonObject>() => request.pollState as T | undefined,
    setPollState: (state: JsonObject) => {
      poll.value = state;
      poll.set = true;
    },
    isFirstPoll: () => request.mode === 'poll' && !request.pollState,
    ...(extras.signal && { signal: extras.signal }),
    ...(extras.deadline !== undefined && { deadline: extras.deadline }),
  };
  if (extras.getInputConnectionData) context.getInputConnectionData = extras.getInputConnectionData;
  if (extras.putExecutionToWait) context.putExecutionToWait = extras.putExecutionToWait;
  if (extras.getNodeState) context.getNodeState = extras.getNodeState;
  if (extras.setNodeState) context.setNodeState = extras.setNodeState;
  if (extras.getNodeOutputs) context.getNodeOutputs = extras.getNodeOutputs;
  if (extras.sendChunk) context.sendChunk = extras.sendChunk;
  if (extras.sendProgress) context.sendProgress = extras.sendProgress;
  return { context, poll, logger };
}

export function createExecuteContext(
  node: INodeType,
  request: ExecuteRequest,
  logs: LogEntry[],
  extras: ContextExtras = {},
): IExecuteContext {
  return buildContext(node, request, logs, [], extras).context;
}

function isItem(value: unknown): value is NodeItem {
  return typeof value === 'object' && value !== null && 'json' in value && typeof (value as NodeItem).json === 'object';
}

/** Accepts NodeItem[][] | NodeItem[] | JsonObject[] and returns NodeItem[][]. */
export function normalizeOutputs(result: ExecuteResult | undefined | null, inputLength: number): NodeItem[][] {
  if (!result) return [[]];
  let outputs: NodeItem[][];
  if (result.length > 0 && Array.isArray(result[0])) {
    outputs = (result as unknown[][]).map((branch) =>
      branch.map((entry) => (isItem(entry) ? entry : { json: entry as JsonObject })),
    );
  } else {
    outputs = [(result as unknown[]).map((entry) => (isItem(entry) ? entry : { json: entry as JsonObject }))];
  }
  // Same contract as every SDK: 1:1 outputs get pairedItem filled in automatically.
  for (const branch of outputs) {
    if (branch.length !== inputLength) continue;
    branch.forEach((item, index) => {
      if (!item.pairedItem) item.pairedItem = { item: index };
    });
  }
  return outputs;
}

/**
 * Poll semantics (docs/protocol.md §8), enforced so a trigger cannot replay history:
 * - first poll (no pollState): items are dropped; without a state of its own the
 *   node gets `{ baselineAt }` so the next poll is not "first" again;
 * - later polls: an unchanged state is echoed back;
 * - manual: no pollState is returned.
 */
function applyPollSemantics(node: INodeType, request: ExecuteRequest, response: ExecuteResponse, poll: PollStateBox, logger: ILogger) {
  // Only a poll trigger polls; other nodes in a poll-started run keep their items.
  if (request.mode !== 'poll' || node.description.triggerSource !== 'poll') {
    if (poll.set && request.mode !== 'manual') logger.debug(`setPollState() ignored in mode "${request.mode}"`);
    return;
  }
  if (!request.pollState) {
    const count = response.outputs.reduce((sum, branch) => sum + branch.length, 0);
    if (count > 0) {
      response.outputs = response.outputs.map(() => []);
      logger.warn(`First poll returned ${count} item(s); dropped, since the first poll only establishes the baseline (check ctx.isFirstPoll())`);
    }
    response.pollState = poll.set && poll.value ? poll.value : { baselineAt: new Date().toISOString() };
    return;
  }
  response.pollState = poll.set && poll.value ? poll.value : request.pollState;
}

export interface NodeRunResult {
  response: ExecuteResponse;
  /** The error the node threw, if any (already mapped into response.error). */
  error?: unknown;
}

/** runNode, plus the thrown error for the server span. */
export async function executeNode(node: INodeType, request: ExecuteRequest, extras: ContextExtras = {}): Promise<NodeRunResult> {
  const logs: LogEntry[] = [];
  const records: NodeRecord[] = [];
  if (!node.execute) {
    return { response: { outputs: [[]], error: { message: `Node "${node.description.name}" cannot be executed` } } };
  }
  const release = registerSecrets(requestSecrets(request.credentials, extras.credentialTypes));
  try {
    const { context, poll, logger } = buildContext(node, request, logs, records, extras);
    try {
      const result = await node.execute(context);
      const response: ExecuteResponse = { outputs: normalizeOutputs(result, request.inputs[0]?.length ?? 0) };
      applyPollSemantics(node, request, response, poll, logger);
      if (logs.length) response.logs = logs;
      if (records.length) response.records = records;
      return { response };
    } catch (error) {
      const response: ExecuteResponse = { outputs: [[]], error: toErrorPayload(error) };
      if (logs.length) response.logs = logs;
      if (records.length) response.records = records;
      return { response, error };
    }
  } finally {
    release();
  }
}

export async function runNode(
  node: INodeType,
  request: ExecuteRequest,
  extras: ContextExtras = {},
): Promise<ExecuteResponse> {
  return (await executeNode(node, request, extras)).response;
}

export function toErrorPayload(error: unknown): NonNullable<ExecuteResponse['error']> {
  if (error instanceof NodeOperationError) {
    return {
      message: scrub(error.message),
      ...(error.description && { description: scrub(error.description) }),
      ...(error.itemIndex !== undefined && { itemIndex: error.itemIndex }),
    };
  }
  if (error instanceof Error) return { message: scrub(error.message) };
  return { message: scrub(String(error)) };
}

export type LoadOptionsExtras = Pick<ContextExtras, 'telemetry' | 'signal' | 'deadline' | 'credentialTypes' | 'pluginId'>;

export async function runLoadOptions(
  node: INodeType,
  method: string,
  parameters: JsonObject,
  credentials?: Record<string, JsonObject>,
  extras: LoadOptionsExtras = {},
): Promise<PropertyOption[]> {
  const loader = node.methods?.loadOptions?.[method];
  if (!loader) throw new NodeOperationError(`Node "${node.description.name}" has no loadOptions method "${method}"`);
  const telemetry = extras.telemetry ?? getTelemetry();
  const base = otelContext.active();
  const http = createTracedFetch(telemetry, { base, signal: extras.signal });
  const processLog = telemetry.logger.child({
    'landflow.node.type': qualifiedType(node.description.name, extras.pluginId),
    'landflow.load_options.method': method,
  });
  const release = registerSecrets(requestSecrets(credentials, extras.credentialTypes));
  try {
    const context: ILoadOptionsContext = {
      getCurrentParameters: () => parameters,
      getNodeParameter: <T>(name: string, fallback?: T) => (name in parameters ? (parameters[name] as T) : (fallback as T)),
      getCredentials: credentialAccessor(credentials),
      logger: nodeLogger([], processLog),
      http,
      span: createSpanFunction(telemetry, base),
      helpers: { httpRequest: (options) => httpRequest(http, options) },
    };
    try {
      return await loader(context);
    } catch (error) {
      // Rethrown while the secrets are still registered, so callers that format the message later get it scrubbed.
      const payload = toErrorPayload(error);
      throw new NodeOperationError(payload.message, { ...(payload.description && { description: payload.description }) });
    }
  } finally {
    release();
  }
}

export interface TestCredentialsResult {
  response: TestCredentialsResponse;
  /** Set when the test threw (the response then says ok: false). */
  error?: unknown;
}

/** runTestCredentials, plus the thrown error for the server span. */
export async function executeTestCredentials(
  plugin: IPlugin,
  request: TestCredentialsRequest,
  extras: Pick<ContextExtras, 'telemetry' | 'signal'> = {},
): Promise<TestCredentialsResult> {
  const name = localCredentialName(request.credentialType);
  const type = plugin.credentialTypes?.find((t) => t.name === name);
  if (!type) return { response: { ok: false, message: `Unknown credential type "${request.credentialType}"` } };
  if (!type.test) return { response: { ok: false, message: `Credential type "${name}" has no connection test` } };
  const telemetry = extras.telemetry ?? getTelemetry();
  const base = otelContext.active();
  const http = createTracedFetch(telemetry, { base, signal: extras.signal });
  const release = registerSecrets(secretValues(request.data, type.properties));
  try {
    const context: ICredentialTestContext = {
      credentialType: name,
      logger: nodeLogger([], telemetry.logger.child({ 'landflow.credential.type': name })),
      http,
      span: createSpanFunction(telemetry, base),
      helpers: { httpRequest: (options) => httpRequest(http, options) },
    };
    const result = await type.test(request.data ?? {}, context);
    const ok = result?.ok === true;
    return { response: { ok, ...(result?.message && { message: scrub(String(result.message)) }) } };
  } catch (error) {
    return { response: { ok: false, message: toErrorPayload(error).message }, error };
  } finally {
    release();
  }
}

/**
 * TestCredentials for a plugin (HTTP, gRPC and the host's in-process plugins):
 * finds the type by local name and runs its `test`. Never throws: an unknown
 * type, a type without `test` or a test that throws all give `{ ok: false, message }`.
 */
export async function runTestCredentials(
  plugin: IPlugin,
  request: TestCredentialsRequest,
  extras: Pick<ContextExtras, 'telemetry' | 'signal'> = {},
): Promise<TestCredentialsResponse> {
  return (await executeTestCredentials(plugin, request, extras)).response;
}

/** Find a node by local or fully-qualified type. */
export function findNode(nodes: readonly INodeType[], pluginId: string, type: string): INodeType | undefined {
  const local = type.startsWith(`${pluginId}.`) ? type.slice(pluginId.length + 1) : type;
  return nodes.find((node) => node.description.name === local);
}
