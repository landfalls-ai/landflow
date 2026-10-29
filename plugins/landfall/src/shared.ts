/**
 * What the Landfall nodes share: the Landfall HTTP client (bearer auth, one retry after a 429, errors with hints),
 * per-item processing with pairedItem and JSON parameters.
 */
import {
  NodeOperationError,
  type IExecuteContext,
  type JsonObject,
  type JsonValue,
  type NodeItem,
  type TracedFetch,
} from '@landflow/sdk';

/** What the client needs: the traced fetch, plus the execution's abort signal so a rate-limit wait never outlives the call. */
export interface ApiContext {
  http: TracedFetch;
  signal?: AbortSignal;
}

/** Landfall's limit is 300 requests per 60 s per client; a 429 waits `Retry-After` (up to this long) and retries once. */
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

/** The credential's base URL without trailing slashes. */
export function baseUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) throw new NodeOperationError('The Landfall credential has no Base URL');
  return url.replace(/\/+$/, '');
}

/** "fetch failed (ECONNREFUSED)" rather than undici's bare "fetch failed". */
export function networkReason(error: unknown): string {
  const e = error as Error & { cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause ? `${e.message} (${cause})` : (e?.message ?? String(error));
}

/** One call; network failures and timeouts become node errors, HTTP errors are left to the caller. */
async function fetchOnce(api: ApiContext, url: string, init: RequestInit): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await api.http(url, { ...init, signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (error) {
    const timeout = (error as Error)?.name === 'TimeoutError';
    throw new NodeOperationError(`Landfall API request failed: ${timeout ? `no answer within ${API_TIMEOUT_MS / 1000} s` : networkReason(error)}`);
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

/** A call with Landfall's rate-limit rule: on 429 honour `Retry-After` (seconds) once. */
export async function fetchLandfall(api: ApiContext, url: string, init: RequestInit): Promise<ApiResponse> {
  const first = await fetchOnce(api, url, init);
  if (first.status !== 429) return first;
  const retryAfter = Number(first.headers.get('retry-after') ?? 1);
  if (!(retryAfter >= 0 && retryAfter <= MAX_RETRY_WAIT_S)) return first;
  await sleepUnless(Math.ceil(retryAfter * 1000), api.signal);
  return fetchOnce(api, url, init);
}

/** NestJS-style bodies: `{ statusCode, message: string | string[], error }`. */
export function errorDetail(response: ApiResponse): string {
  const message = response.body?.message ?? response.body?.error;
  if (Array.isArray(message)) return message.join('; ');
  if (typeof message === 'string' && message) return message;
  return response.text.slice(0, 200) || `HTTP ${response.status}`;
}

/** "Landfall API error 404: …" with a hint for the errors people actually hit. */
export function landfallError(response: ApiResponse, hints: { operation?: string } = {}): NodeOperationError {
  const detail = errorDetail(response);
  const retry = response.headers.get('retry-after');
  let description: string | undefined;
  switch (response.status) {
    case 401:
      description =
        'Landfall rejected the token. Org routes need a Landfall API key (lf_key_…, not a Landflow lf_ key); Open from Alert and Recover need the ingest token; Heartbeat Ping needs the heartbeat token.';
      break;
    case 403:
      description = 'The member who owns this API key may not do this in the organization, or Landfall refuses this event type from API keys.';
      break;
    case 404:
      description = 'Check the Org Slug in the credential and the incident ID.';
      break;
    case 409:
      description = 'The timeline moved while the event was being written. Try again.';
      break;
    case 422:
      if (hints.operation === 'trigger') {
        description =
          'Landfall accepts remote triggers only from a remote-source connection that exists and whose last health check passed. Create the connection in Landfall (its URL is this plugin\'s source face, LANDFALL_SOURCE_PORT), run its health check, and put its id in the credential\'s Connection ID.';
      }
      break;
    case 429:
      description = `Landfall allows 300 requests per 60 s per client${retry ? `; retry after ${retry} s` : ''}.`;
      break;
  }
  return new NodeOperationError(`Landfall API error ${response.status}: ${detail}`, description ? { description } : {});
}

/** The JSON body of a successful response; any other status becomes a node error. */
export function expectOk(response: ApiResponse, hints: { operation?: string } = {}): any {
  if (!response.ok) throw landfallError(response, hints);
  return response.body;
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

/** Resource / operation dispatch with a clear error for combinations the node doesn't have. */
export function unsupported(resource: string, operation: string): NodeOperationError {
  return new NodeOperationError(`Operation "${operation}" is not available for resource "${resource}"`, {
    description: 'Pick an operation from the list after changing the resource.',
  });
}
