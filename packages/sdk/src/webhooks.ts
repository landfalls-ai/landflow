/**
 * App webhook triggers (docs/protocol.md §12): a trigger node with `triggerSource: "appWebhook"` registers its own
 * webhook with an external service when the workflow is published and removes it when it is unpublished, like n8n's
 * `webhookMethods`:
 *
 *   webhookMethods: {
 *     async checkExists(ctx) { … return Boolean(hook) },
 *     async create(ctx) { const hook = await api.createHook(ctx.getWebhookUrl()); ctx.getStaticData().webhookId = hook.id },
 *     async delete(ctx) { await api.deleteHook(ctx.getStaticData().webhookId); delete ctx.getStaticData().webhookId },
 *   },
 *   async webhook(ctx) {
 *     if (!verifyGitHubSignature(secret, ctx.getRawBody(), ctx.getHeader('x-hub-signature-256'))) return { response: { status: 401 } };
 *     return { items: [{ json: ctx.getBody() }] };
 *   },
 *
 * The host keeps the static data per workflow and node; changes the node makes to `ctx.getStaticData()` (or a
 * `setStaticData()`) go back with the response. Used by the HTTP and gRPC servers and the host's in-process plugins.
 */
import { context as otelContext } from '@opentelemetry/api';
import { withPropertyDefaults, type JsonObject, type LogEntry, type NodeItem, type NodeRef, type WebhookMethodName, type WebhookMethodRequest, type WebhookMethodResponse, type WebhookRequest, type WebhookResponse } from '@landflow/protocol';
import { credentialAccessor, requestSecrets, type CredentialTypeDefinition, type GetCredentials } from './credentials';
import { createNodeMetrics, createSpanFunction, createTracedFetch, type NodeMetrics, type SpanFunction, type TracedFetch } from './instrumentation';
import type { HttpRequestOptions, HttpResponse, ILogger, INodeType } from './node';
import { getTelemetry, type Telemetry } from './otel';
import { registerSecrets } from './redact';
import { httpRequest, nodeLogger, qualifiedType, toErrorPayload } from './runtime';

export interface IWebhookFunctions {
  getNode(): NodeRef;
  getWorkflowId(): string;
  /** A parameter (expressions resolved by the host, without items), else its default, else `fallback`. */
  getNodeParameter<T = unknown>(name: string, fallback?: T): T;
  readonly getCredentials: GetCredentials;
  /** Where the service must send its calls: `{publicUrl}/api/webhook/app/<workflowId>/<nodeId>`. */
  getWebhookUrl(): string;
  /** The node's static data for this workflow (the webhook id, a signing secret). Change it in place; the host stores it. */
  getStaticData<T extends JsonObject = JsonObject>(): T;
  /** Replace the static data. */
  setStaticData(data: JsonObject): void;
  readonly logger: ILogger;
  readonly span: SpanFunction;
  readonly metrics: NodeMetrics;
  readonly http: TracedFetch;
  readonly helpers: { httpRequest(options: HttpRequestOptions): Promise<HttpResponse> };
}

export interface IWebhookMethodContext extends IWebhookFunctions {
  readonly method: WebhookMethodName;
}

export interface IWebhookContext extends IWebhookFunctions {
  /** The call as received: method, path, lower-case headers, query and the raw body. */
  getRequest(): { method: string; path: string; headers: Record<string, string>; query: Record<string, string>; rawBody: Buffer };
  /** A request header (case-insensitive). */
  getHeader(name: string): string | undefined;
  /** The body bytes exactly as sent (what signatures cover). */
  getRawBody(): Buffer;
  /** The body: parsed JSON, a form-urlencoded body as an object, else the text. */
  getBody<T = unknown>(): T;
}

/** What `webhook()` returns: items start a run (none: no run); `response` is what the service gets back. */
export interface WebhookResult {
  items?: Array<NodeItem | JsonObject>;
  response?: { status?: number; headers?: Record<string, string>; body?: string; json?: unknown };
  /** Identifies the event (GitHub's `X-GitHub-Delivery`): a redelivery starts no second run. */
  idempotencyKey?: string;
}

export interface IWebhookMethods {
  /** Is the webhook in the static data still registered? Without it, the host always calls `create`. */
  checkExists?(ctx: IWebhookMethodContext): Promise<boolean> | boolean;
  /** Register `ctx.getWebhookUrl()` and store what `delete` needs. Throw (or return false) when it fails. */
  create(ctx: IWebhookMethodContext): Promise<boolean | void> | boolean | void;
  /** Remove the webhook (a webhook that is already gone is not an error). */
  delete(ctx: IWebhookMethodContext): Promise<boolean | void> | boolean | void;
}

export interface WebhookExtras {
  telemetry?: Telemetry;
  credentialTypes?: readonly CredentialTypeDefinition[];
  pluginId?: string;
  signal?: AbortSignal;
}

interface Base {
  workflowId: string;
  node: NodeRef;
  parameters: JsonObject;
  credentials?: Record<string, JsonObject>;
  webhookUrl: string;
  staticData: JsonObject;
}

function buildFunctions(node: INodeType, request: Base, logs: LogEntry[], extras: WebhookExtras) {
  const telemetry = extras.telemetry ?? getTelemetry();
  const base = otelContext.active();
  const type = qualifiedType(request.node.type, extras.pluginId);
  const parameters = withPropertyDefaults(node.description.properties, request.parameters ?? {});
  const box = { data: structuredClone(request.staticData ?? {}) as JsonObject, initial: JSON.stringify(request.staticData ?? {}) };
  const http = createTracedFetch(telemetry, { base, signal: extras.signal });
  const processLog = telemetry.logger.child({ 'landflow.node.type': type, 'landflow.node.name': request.node.name, 'landflow.workflow.id': request.workflowId });
  const functions: IWebhookFunctions = {
    getNode: () => request.node,
    getWorkflowId: () => request.workflowId,
    getNodeParameter: <T>(name: string, fallback?: T) => (name in parameters ? (parameters[name] as T) : (fallback as T)),
    getCredentials: credentialAccessor(request.credentials),
    getWebhookUrl: () => request.webhookUrl,
    getStaticData: <T extends JsonObject>() => box.data as T,
    setStaticData: (data: JsonObject) => {
      box.data = data ?? {};
    },
    logger: nodeLogger(logs, processLog),
    span: createSpanFunction(telemetry, base),
    metrics: createNodeMetrics(telemetry, { ...(extras.pluginId && { 'landflow.plugin.id': extras.pluginId }), 'landflow.node.type': type, 'landflow.workflow.id': request.workflowId }),
    http,
    helpers: { httpRequest: (options) => httpRequest(http, options) },
  };
  /** The static data to return: only when the node changed it. */
  const changedStaticData = () => (JSON.stringify(box.data) === box.initial ? undefined : box.data);
  return { functions, changedStaticData };
}

/** Run `checkExists`, `create` or `delete` of an app webhook trigger. Never throws: failures come back in `error`. */
export async function runWebhookMethod(node: INodeType, request: WebhookMethodRequest, extras: WebhookExtras = {}): Promise<WebhookMethodResponse> {
  const logs: LogEntry[] = [];
  const methods = node.webhookMethods;
  if (!methods) return { error: { message: `Node "${node.description.name}" has no webhook methods` } };
  const release = registerSecrets(requestSecrets(request.credentials, extras.credentialTypes));
  try {
    const { functions, changedStaticData } = buildFunctions(node, request, logs, extras);
    const ctx: IWebhookMethodContext = { ...functions, method: request.method };
    const respond = (response: WebhookMethodResponse): WebhookMethodResponse => {
      const staticData = changedStaticData();
      return { ...response, ...(staticData && { staticData }), ...(logs.length && { logs }) };
    };
    try {
      if (request.method === 'checkExists') return respond({ exists: methods.checkExists ? (await methods.checkExists(ctx)) === true : false });
      if (request.method !== 'create' && request.method !== 'delete') return { error: { message: `Unknown webhook method "${String(request.method)}"` } };
      const outcome = await methods[request.method](ctx);
      if (outcome === false) return respond({ error: { message: request.method === 'create' ? 'The webhook could not be registered' : 'The webhook could not be removed' } });
      return respond({});
    } catch (error) {
      return respond({ error: toErrorPayload(error) });
    }
  } finally {
    release();
  }
}

function parseBody(raw: Buffer, contentType: string): unknown {
  const text = raw.toString('utf8');
  if (!text) return {};
  if (/json/i.test(contentType) || (!contentType && /^\s*[[{]/.test(text))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const form = Object.fromEntries(new URLSearchParams(text));
    // GitHub and others can send JSON as a `payload` form field.
    if (typeof form.payload === 'string' && /^\s*[[{]/.test(form.payload)) {
      try {
        return JSON.parse(form.payload);
      } catch {}
    }
    return form;
  }
  return text;
}

const toItem = (entry: NodeItem | JsonObject): NodeItem =>
  typeof entry === 'object' && entry !== null && 'json' in entry && typeof entry.json === 'object' && entry.json !== null && !Array.isArray(entry.json)
    ? (entry as NodeItem)
    : { json: entry as JsonObject };

/** Run `webhook()` of an app webhook trigger for one incoming call. Never throws: failures come back in `error`. */
export async function runWebhook(node: INodeType, request: WebhookRequest, extras: WebhookExtras = {}): Promise<WebhookResponse> {
  const logs: LogEntry[] = [];
  if (!node.webhook) return { error: { message: `Node "${node.description.name}" has no webhook() method` } };
  const release = registerSecrets(requestSecrets(request.credentials, extras.credentialTypes));
  try {
    const { functions, changedStaticData } = buildFunctions(node, request, logs, extras);
    const incoming = request.request;
    const headers = Object.fromEntries(Object.entries(incoming.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const rawBody = Buffer.from(incoming.body ?? '', 'base64');
    let body: unknown;
    const ctx: IWebhookContext = {
      ...functions,
      getRequest: () => ({ method: incoming.method, path: incoming.path, headers, query: incoming.query ?? {}, rawBody }),
      getHeader: (name) => headers[name.toLowerCase()],
      getRawBody: () => rawBody,
      getBody: <T>() => (body ??= parseBody(rawBody, headers['content-type'] ?? '')) as T,
    };
    const finish = (response: WebhookResponse): WebhookResponse => {
      const staticData = changedStaticData();
      return { ...response, ...(staticData && { staticData }), ...(logs.length && { logs }) };
    };
    try {
      const result = await node.webhook(ctx);
      const out: WebhookResponse = {};
      const items = (Array.isArray(result) ? result : (result?.items ?? [])).map(toItem);
      if (items.length) out.items = items;
      const reply = Array.isArray(result) ? undefined : result?.response;
      if (reply) {
        const replyHeaders = { ...(reply.headers ?? {}) };
        let replyBody = reply.body;
        if (reply.json !== undefined) {
          replyBody = JSON.stringify(reply.json);
          if (!Object.keys(replyHeaders).some((h) => h.toLowerCase() === 'content-type')) replyHeaders['content-type'] = 'application/json; charset=utf-8';
        }
        out.response = { ...(reply.status && { status: reply.status }), ...(Object.keys(replyHeaders).length && { headers: replyHeaders }), ...(replyBody !== undefined && { body: replyBody }) };
      }
      if (!Array.isArray(result) && result?.idempotencyKey) out.idempotencyKey = String(result.idempotencyKey);
      return finish(out);
    } catch (error) {
      return finish({ error: toErrorPayload(error) });
    }
  } finally {
    release();
  }
}
