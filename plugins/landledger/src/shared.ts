/**
 * What the Landledger nodes share: the HTTP client (bearer `ll_` key, one retry after a 429, errors with hints),
 * per-item processing with pairedItem, JSON and string parameters, and exact decimal arithmetic for amounts (Landledger
 * sends money as decimal strings, never JSON numbers).
 */
import { NodeOperationError, type IExecuteContext, type JsonObject, type JsonValue, type NodeItem, type TracedFetch } from '@landflow/sdk';

/** What the client needs: the traced fetch, plus the execution's abort signal so a wait never outlives the call. */
export interface ApiContext {
  http: TracedFetch;
  signal?: AbortSignal;
}

export interface LandledgerCredentials extends JsonObject {
  baseUrl: string;
  apiKey: string;
  /** The `whsec_…` secret of a subscription an admin made in Landledger (the trigger then registers nothing). */
  webhookSecret: string;
}

/** The relay key's credential (`landledgerRelayApi`): a key with `decisions:relay` and nothing that raises or administers. */
export interface LandledgerRelayCredentials extends JsonObject {
  baseUrl: string;
  apiKey: string;
}

/** The notes key's credential (`landledgerNotesKey`): a key with `notes:draft`, which submits variance note drafts and nothing else. */
export interface LandledgerNotesCredentials extends JsonObject {
  baseUrl: string;
  apiKey: string;
}

/**
 * Where Landledger's API answers from inside the OrbStack cluster (the credential's default): the ExternalName Service
 * `landledger-api` in `landflow-dev` (deploy/k8s/components/landledger) pointing at Landledger on this machine.
 */
export const DEFAULT_BASE_URL = 'http://landledger-api.landflow-dev.svc.cluster.local:4810';

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
    throw new NodeOperationError(`Landledger API request failed: ${timeout ? `no answer within ${API_TIMEOUT_MS / 1000} s` : networkReason(error)}`, {
      description: 'Check the Base URL in the Landledger credential: http://127.0.0.1:4810 on this machine, the cluster address from inside the cluster.',
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
export async function fetchLandledger(api: ApiContext, url: string, init: RequestInit): Promise<ApiResponse> {
  const first = await fetchOnce(api, url, init);
  if (first.status !== 429) return first;
  const retryAfter = Number(first.headers.get('retry-after') ?? 1);
  if (!(retryAfter >= 0 && retryAfter <= MAX_RETRY_WAIT_S)) return first;
  await sleepUnless(Math.ceil(retryAfter * 1000), api.signal);
  return fetchOnce(api, url, init);
}

/** Landledger's error body: `{ error: { code, message, details? } }`. */
export function errorDetail(response: ApiResponse): string {
  const error = response.body?.error;
  const message = typeof error === 'object' && error ? error.message : typeof error === 'string' ? error : response.body?.message;
  if (typeof message === 'string' && message) {
    // A refused note draft names each cited figure that differs from the snapshot: keep them, a redraft needs them.
    const mismatches = typeof error === 'object' && error ? error.details?.mismatches : undefined;
    if (Array.isArray(mismatches) && mismatches.length) return `${message} (mismatches: ${JSON.stringify(mismatches).slice(0, 2000)})`;
    return message;
  }
  return response.text.slice(0, 200) || `HTTP ${response.status}`;
}

/** The scope each kind of call needs, for the 403 hint (Landledger's docs/reference/api.md). */
export type Scope = 'read' | 'requests:write' | 'reservations:write' | 'decisions:relay' | 'webhooks:write' | 'ingest' | 'notes:draft' | 'admin';

/** "Landledger API error 403: …" with a hint for the errors people hit. */
export function landledgerError(response: ApiResponse, hints: { scope?: Scope } = {}): NodeOperationError {
  const detail = errorDetail(response);
  let description: string | undefined;
  switch (response.status) {
    case 400:
      description = 'Landledger refused the request: check the fields (amounts are decimal strings, months YYYY-MM, days YYYY-MM-DD, a known cost center).';
      break;
    case 401:
      description =
        'Landledger rejected the API key (a Landledger key, ll_…, made by an admin person under /api/keys, not a Landflow lf_ key), or, for a relayed press, Slack\'s signature, its age (5 minutes), the team or the app.';
      break;
    case 403:
      description = `The key or the person may not do this${hints.scope ? ` (the key needs ${hints.scope})` : ''}. A relayed press is refused for a Slack user nobody linked, a step other than the budget owner's, the requester, the sponsor, or someone not among the step's approvers.`;
      break;
    case 404:
      description = 'Check the id: the request, reservation or webhook does not exist (or is gone).';
      break;
    case 409:
      description =
        'The request or the month has moved on (another step is pending, the month is closing or locked, the request is no longer pending), the evidence a decision cites is stale (served more than 30 minutes ago: show the request again), or an idempotency key came back with a different body.';
      break;
    case 422:
      description =
        hints.scope === 'notes:draft'
          ? 'Landledger checked the draft\'s cited figures against the month\'s frozen snapshot and some differ (the mismatches say which): cite only the figures Notes → Figures lists, to the cent.'
          : 'Landledger understood the request but can\'t take it yet (only USD until FX is set up).';
      break;
    case 429:
      description = 'Landledger is rate-limiting this key; try again shortly.';
      break;
    case 503:
      description = 'Landledger is up but a part of it is not (its database, or webhook secrets without LANDLEDGER_SECRET_KEY).';
      break;
  }
  return new NodeOperationError(`Landledger API error ${response.status}: ${detail}`, description ? { description } : {});
}

/** The JSON body of a successful response; any other status becomes a node error. */
export function expectOk(response: ApiResponse, hints: { scope?: Scope } = {}): any {
  if (!response.ok) throw landledgerError(response, hints);
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

/** A JSON object parameter (empty: `{}`). */
export function objectParameter(value: unknown, label: string, itemIndex: number): JsonObject {
  const parsed = jsonParameter(value, label);
  if (parsed === undefined) return {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new NodeOperationError(`${label} must be a JSON object`, { itemIndex });
  return parsed as JsonObject;
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

// ---- amounts ---------------------------------------------------------------------------------------------------------

const MICRO = 1_000_000n;
const AMOUNT = /^(-)?(\d+)(?:\.(\d{1,6}))?$/;

/** A decimal amount (string or number) as micro-units, or undefined when it isn't one (at most six decimals). */
export function toMicros(value: unknown): bigint | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(6).replace(/\.?0+$/, '') : '') : String(value).trim().replace(/,/g, '');
  const m = AMOUNT.exec(text);
  if (!m) return undefined;
  const micros = BigInt(m[2]) * MICRO + BigInt((m[3] ?? '').padEnd(6, '0') || '0');
  return m[1] ? -micros : micros;
}

/** Micro-units as Landledger writes amounts: six decimals (`"1840.000000"`). */
export function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  return `${negative ? '-' : ''}${abs / MICRO}.${String(abs % MICRO).padStart(6, '0')}`;
}

/**
 * A money amount for a request (`{ amount: "1840.00" }`): a non-negative decimal with at most six decimals. Numbers
 * are accepted (a form, a model) and written without float noise.
 */
export function amountParameter(value: unknown, label: string, itemIndex: number): string {
  const micros = toMicros(value);
  if (micros === undefined || micros < 0n) throw new NodeOperationError(`${label} must be a non-negative amount with at most six decimals (e.g. 1840.00)`, { itemIndex });
  return fromMicros(micros).replace(/\.?0+$/, '').replace(/^$/, '0');
}

/** A month (YYYY-MM): the parameter, or this month in UTC. */
export function monthParameter(value: unknown, itemIndex: number, now = new Date()): string {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) return now.toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) throw new NodeOperationError(`Month "${text}" is not YYYY-MM`, { itemIndex });
  return text;
}

/** A day (YYYY-MM-DD) or undefined; an ISO date-time is cut to its UTC day. */
export function dayParameter(value: unknown, label: string, itemIndex: number): string | undefined {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new NodeOperationError(`${label} "${text}" is not a date`, { itemIndex });
  return date.toISOString().slice(0, 10);
}
