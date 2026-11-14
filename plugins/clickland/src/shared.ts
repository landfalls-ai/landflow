/**
 * What the Clickland nodes share: the HTTP client (bearer API key, one retry after a 429, errors with hints), the
 * time range parameters, per-item processing with pairedItem, and JSON parameters.
 */
import { NodeOperationError, type IExecuteContext, type JsonObject, type JsonValue, type NodeItem, type TracedFetch } from '@landflow/sdk';

/** What the client needs: the traced fetch, plus the execution's abort signal so a wait never outlives the call. */
export interface ApiContext {
  http: TracedFetch;
  signal?: AbortSignal;
}

export interface ClicklandCredentials extends JsonObject {
  baseUrl: string;
  apiKey: string;
}

/** Where Clickland's API answers on the OrbStack cluster (the credential's default). */
export const DEFAULT_BASE_URL = 'http://clickland-api.clickland-dev.svc.cluster.local:4710';

const MAX_RETRY_WAIT_S = 10;
const API_TIMEOUT_MS = 30_000;

export interface ApiResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON, or undefined for an empty or non-JSON body. */
  body: any;
  text: string;
}

/** The credential's base URL without trailing slashes (the cluster address when empty). */
export function baseUrl(value: unknown): string {
  const url = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BASE_URL;
  return url.replace(/\/+$/, '');
}

/** "fetch failed (ECONNREFUSED)" rather than undici's bare "fetch failed". */
export function networkReason(error: unknown): string {
  const e = error as Error & { cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause ? `${e.message} (${cause})` : (e?.message ?? String(error));
}

async function fetchOnce(api: ApiContext, url: string, init: RequestInit): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await api.http(url, { ...init, signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (error) {
    const timeout = (error as Error)?.name === 'TimeoutError';
    throw new NodeOperationError(`Clickland API request failed: ${timeout ? `no answer within ${API_TIMEOUT_MS / 1000} s` : networkReason(error)}`, {
      description: 'Check the Base URL in the Clickland credential: http://127.0.0.1:4710 on this machine, the cluster address from inside the cluster.',
    });
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

function sleepUnless(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new NodeOperationError('The execution was canceled while waiting'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NodeOperationError('The execution was canceled while waiting'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A call; a 429 with a short `Retry-After` waits and retries once. */
export async function fetchClickland(api: ApiContext, url: string, init: RequestInit): Promise<ApiResponse> {
  const first = await fetchOnce(api, url, init);
  if (first.status !== 429) return first;
  const retryAfter = Number(first.headers.get('retry-after') ?? 1);
  if (!(retryAfter >= 0 && retryAfter <= MAX_RETRY_WAIT_S)) return first;
  await sleepUnless(Math.ceil(retryAfter * 1000), api.signal);
  return fetchOnce(api, url, init);
}

/** Clickland's error body: `{ error: { code, message, details? } }`. */
export function errorDetail(response: ApiResponse): string {
  const error = response.body?.error;
  const message = typeof error === 'object' && error ? error.message : typeof error === 'string' ? error : response.body?.message;
  const position = error?.details?.position;
  if (typeof message === 'string' && message) return position !== undefined ? `${message} (at position ${position})` : message;
  return response.text.slice(0, 200) || `HTTP ${response.status}`;
}

/** The scope each kind of call needs, for the 403 hint. */
export type Scope = 'read' | 'alerts:write' | 'webhooks:write' | 'notes:write';

/** "Clickland API error 403: …" with a hint for the errors people hit. */
export function clicklandError(response: ApiResponse, hints: { scope?: Scope } = {}): NodeOperationError {
  const detail = errorDetail(response);
  let description: string | undefined;
  switch (response.status) {
    case 400:
      description = 'Clickland refused the request. For a search, check the query syntax (field:value, quotes for phrases, duration:>500).';
      break;
    case 401:
      description = 'Clickland rejected the API key. It is a Clickland key (ck_…, created under Settings → API keys in Clickland), not a Landflow lf_ key.';
      break;
    case 403:
      description = `The API key lacks the scope this needs${hints.scope ? ` (${hints.scope})` : ''}. Create a key with that scope in Clickland.`;
      break;
    case 404:
      description = 'Check the id: the alert, trace, view or webhook does not exist (or is gone).';
      break;
    case 429:
      description = 'Clickland is rate-limiting this key; try again shortly.';
      break;
  }
  return new NodeOperationError(`Clickland API error ${response.status}: ${detail}`, description ? { description } : {});
}

/** The JSON body of a successful response; any other status becomes a node error. */
export function expectOk(response: ApiResponse, hints: { scope?: Scope } = {}): any {
  if (!response.ok) throw clicklandError(response, hints);
  return response.body;
}

/** A `json` parameter: the editor stores text, expressions and tools may pass objects. Empty means "not set". */
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

/** An optional string parameter, trimmed ('' when unset). */
export function optionalString(ctx: IExecuteContext, name: string, itemIndex: number): string {
  const value = ctx.getNodeParameter<unknown>(name, itemIndex, '');
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Re-throw any failure as a node error that names the item. */
export function atItem(error: unknown, itemIndex: number): NodeOperationError {
  if (error instanceof NodeOperationError) {
    return error.itemIndex === itemIndex ? error : new NodeOperationError(error.message, { itemIndex, ...(error.description && { description: error.description }) });
  }
  return new NodeOperationError((error as Error)?.message ?? String(error), { itemIndex });
}

/**
 * Per-item processing: parameters are read per item index and every result is paired with its input item. A failure
 * stops the node with `itemIndex` set, unless the node continues on fail: then the item becomes `{ error }`.
 */
export async function mapItems(ctx: IExecuteContext, fn: (itemIndex: number, item: NodeItem) => Promise<JsonObject | JsonObject[]>): Promise<NodeItem[]> {
  const out: NodeItem[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      const result = await fn(i, items[i]);
      for (const entry of Array.isArray(result) ? result : [result]) out.push({ json: entry, pairedItem: { item: i } });
    } catch (error) {
      const failure = atItem(error, i);
      if (!ctx.continueOnFail()) throw failure;
      out.push({ json: { error: failure.message, ...(failure.description && { description: failure.description }) }, pairedItem: { item: i } });
    }
  }
  return out;
}

export function unsupported(resource: string, operation: string): NodeOperationError {
  return new NodeOperationError(`Operation "${operation}" is not available for resource "${resource}"`, {
    description: 'Pick an operation from the list after changing the resource.',
  });
}

// ---- time ranges ---------------------------------------------------------------------------------------------------

export interface TimeRange {
  from: string;
  to: string;
}

/** A date parameter as ISO 8601 UTC, or undefined when empty. */
export function isoOrUndefined(value: unknown, label: string, itemIndex?: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(typeof value === 'number' ? value : String(value));
  if (Number.isNaN(date.getTime())) throw new NodeOperationError(`${label} "${value}" is not a date`, itemIndex === undefined ? {} : { itemIndex });
  return date.toISOString();
}

/**
 * The window a query covers: From → To when From is set; otherwise the Last N Minutes before To (default now).
 * `now` is a parameter so tests are exact.
 */
export function timeRange(input: { lastMinutes?: unknown; from?: unknown; to?: unknown }, itemIndex?: number, now = Date.now()): TimeRange {
  const to = isoOrUndefined(input.to, 'To', itemIndex) ?? new Date(now).toISOString();
  const from = isoOrUndefined(input.from, 'From', itemIndex);
  if (from) {
    if (from >= to) throw new NodeOperationError('From must be before To', itemIndex === undefined ? {} : { itemIndex });
    return { from, to };
  }
  const minutes = Number(input.lastMinutes ?? 60);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new NodeOperationError('Last Minutes must be a positive number', itemIndex === undefined ? {} : { itemIndex });
  return { from: new Date(Date.parse(to) - minutes * 60_000).toISOString(), to };
}

/** The node's time range parameters for item `i`. */
export function rangeOf(ctx: IExecuteContext, i: number): TimeRange {
  return timeRange({ lastMinutes: ctx.getNodeParameter('lastMinutes', i, 60), from: ctx.getNodeParameter('from', i, ''), to: ctx.getNodeParameter('to', i, '') }, i);
}
