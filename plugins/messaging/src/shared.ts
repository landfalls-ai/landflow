/**
 * What every messaging node shares: the integration metrics, API error
 * mapping (HTTP status plus the service's own error text, never the token),
 * per-item processing with pairedItem, JSON parameters and client spans.
 */
import {
  NodeOperationError,
  type Attributes,
  type IExecuteContext,
  type JsonObject,
  type JsonValue,
  type NodeItem,
  type NodeMetrics,
  type Span,
  type SpanFunction,
  type TracedFetch,
} from '@landflow/sdk';

export type Service = 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'email';

/** What the API helpers need: the traced fetch, plus metrics when called from execute (loadOptions and credential tests have none). */
export interface ApiContext {
  http: TracedFetch;
  metrics?: NodeMetrics;
}

export const METRICS = {
  messagesSent: 'landflow.messaging.messages_sent',
  apiErrors: 'landflow.messaging.api_errors',
  pollUpdates: 'landflow.messaging.poll.updates',
} as const;

export function countSent(api: ApiContext, service: Service, operation: string) {
  api.metrics?.counter(METRICS.messagesSent, { description: 'Messages sent through a messaging service', unit: '{message}' }).add(1, { service, operation });
}

/** `status_class`: 4xx / 5xx from the HTTP status (or SMTP reply code), `network` / `timeout` when there was no answer. */
export function countApiError(api: ApiContext, service: Service, statusClass: string) {
  api.metrics?.counter(METRICS.apiErrors, { description: 'Failed calls to a messaging API' }).add(1, { service, status_class: statusClass });
}

export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/** Count the failure and build the node error: "Telegram API error 400: Bad Request: chat not found". */
export function apiError(api: ApiContext, service: Service, label: string, status: number | undefined, detail: string, description?: string, klass?: string) {
  countApiError(api, service, klass ?? (status ? statusClass(status) : '4xx'));
  return new NodeOperationError(`${label} API error${status ? ` ${status}` : ''}: ${detail}`, description ? { description } : {});
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON, or undefined for an empty or non-JSON body. */
  body: any;
  text: string;
}

const API_TIMEOUT_MS = 30_000;

/** One traced call (a client span via ctx.http). Network failures and timeouts become node errors; HTTP errors are left to the caller. */
export async function fetchJson(api: ApiContext, service: Service, label: string, url: string, init: RequestInit = {}): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await api.http(url, { ...init, signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (error) {
    const timeout = (error as Error)?.name === 'TimeoutError';
    countApiError(api, service, timeout ? 'timeout' : 'network');
    throw new NodeOperationError(`${label} API request failed: ${timeout ? `no answer within ${API_TIMEOUT_MS / 1000} s` : networkReason(error)}`);
  }
  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, ok: response.ok, headers: response.headers, body, text };
}

/** "fetch failed (ECONNREFUSED)" rather than undici's bare "fetch failed". */
export function networkReason(error: unknown): string {
  const e = error as Error & { cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause ? `${e.message} (${cause})` : (e?.message ?? String(error));
}

/** The credential's base URL without trailing slashes; an empty value falls back to the real service. */
export function baseUrl(value: unknown, fallback: string): string {
  const url = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return url.replace(/\/+$/, '');
}

/** A `json` parameter: the editor stores text, expressions may produce objects. Empty means "not set". */
export function jsonParameter(value: unknown, label: string): JsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value as JsonValue;
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new NodeOperationError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

/** A required string parameter, trimmed. */
export function requireString(ctx: IExecuteContext, name: string, label: string, itemIndex: number): string {
  const value = ctx.getNodeParameter<unknown>(name, itemIndex, '');
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) throw new NodeOperationError(`${label} is required`, { itemIndex });
  return text;
}

/** Re-throw any failure as a node error that names the item. */
export function atItem(error: unknown, itemIndex: number): NodeOperationError {
  if (error instanceof NodeOperationError) {
    return error.itemIndex === itemIndex
      ? error
      : new NodeOperationError(error.message, { itemIndex, ...(error.description && { description: error.description }) });
  }
  return new NodeOperationError((error as Error)?.message ?? String(error), { itemIndex });
}

/**
 * Per-item processing: parameters are read per item index and every result is
 * paired with its input item. A failure stops the node with `itemIndex` set,
 * unless the node continues on fail: then the item becomes `{ error }` and the
 * next item runs.
 */
export async function mapItems(ctx: IExecuteContext, fn: (itemIndex: number, item: NodeItem) => Promise<JsonObject | JsonObject[]>): Promise<NodeItem[]> {
  const out: NodeItem[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      const result = await fn(i, items[i]);
      for (const json of Array.isArray(result) ? result : [result]) out.push({ json, pairedItem: { item: i } });
    } catch (error) {
      const failure = atItem(error, i);
      if (!ctx.continueOnFail()) throw failure;
      out.push({ json: { error: failure.message, ...(failure.description && { description: failure.description }) }, pairedItem: { item: i } });
    }
  }
  return out;
}

/** Resource / operation dispatch with a clear error for combinations the node doesn't have. */
export function unsupported(resource: string, operation: string): NodeOperationError {
  return new NodeOperationError(`Operation "${operation}" is not available for resource "${resource}"`, {
    description: 'Pick an operation from the list after changing the resource.',
  });
}

/**
 * A client span for a non-HTTP protocol (SMTP). It is the active span inside
 * `fn`, so `ctx.span` children nest under it.
 */
export function clientSpan<T>(ctx: { span: SpanFunction }, name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return ctx.span(name, attributes, fn, { kind: 'client' });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
