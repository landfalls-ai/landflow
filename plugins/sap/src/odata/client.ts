/**
 * The HTTP side of the node: one `SapClient` per call, with a cookie jar and the CSRF token of the services it touched. It checks the
 * host against the operator's allow-list on every request and follows no redirect, honours `Retry-After` on 429 (capped), retries a
 * read once on a 5xx, and never retries a write. Credentials go in headers built by the caller, never in a URL.
 */
import { NodeOperationError, type TracedFetch } from '@landflow/sdk';
import { SapError, mapError, type ErrorContext } from './errors';
import type { ODataVersion } from './query';

export interface SapAuth {
  /** `Authorization` or `APIKey` header. */
  headers: Record<string, string>;
  /** Who the metadata cache is keyed by (a user name or client id, never a secret). */
  identity: string;
  /** The credential's environment label (`production` or `test`), for spans and messages. */
  environment?: string;
}

/** `LANDFLOW_SAP_ALLOWED_HOSTS`: comma separated; `.suffix` matches subdomains, anything else is an exact host. */
export function allowedHosts(env = process.env.LANDFLOW_SAP_ALLOWED_HOSTS): string[] {
  return String(env ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const hostMatches = (host: string, entry: string) => (entry.startsWith('.') ? host.endsWith(entry) || host === entry.slice(1) : host === entry);

/**
 * The base URL must be https. With the operator's list set, its host must be on it; a host named exactly on the list may use http
 * (that is how the fake server on loopback is allowed: it is never allowed by default).
 */
export function checkBaseUrl(raw: string, list = allowedHosts()): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new NodeOperationError('The credential has no valid Base URL', { description: 'Use the tenant API host, for example https://my123456-api.s4hana.cloud.sap' });
  }
  if (url.username || url.password) throw new NodeOperationError('The Base URL must not contain a user name or password');
  if (url.search || url.hash) throw new NodeOperationError('The Base URL must not contain a query or fragment');
  const host = url.hostname.toLowerCase();
  const listed = list.some((entry) => hostMatches(host, entry));
  if (list.length > 0 && !listed) throw new NodeOperationError(`${host} is not in LANDFLOW_SAP_ALLOWED_HOSTS`, { description: 'The operator limits which hosts the SAP plugin may call.' });
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && list.includes(host))) {
    throw new NodeOperationError('The Base URL must be https', { description: 'http is only accepted for a host named exactly in LANDFLOW_SAP_ALLOWED_HOSTS (a local test server).' });
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export interface ClientOptions {
  baseUrl: string;
  auth: SapAuth;
  fetch: TracedFetch;
  sapClient?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Longest `Retry-After` the client waits (default 60 s). */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides `LANDFLOW_SAP_ALLOWED_HOSTS` (tests). */
  hosts?: string[];
}

export interface SapResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export interface SendOptions {
  query?: string;
  body?: unknown;
  headers?: Record<string, string>;
  context: ErrorContext;
  accept?: string;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SapClient {
  readonly base: URL;
  private readonly jar = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  /** Calls made, for tests and spans. */
  requests = 0;

  constructor(private readonly options: ClientOptions) {
    this.base = checkBaseUrl(options.baseUrl, options.hosts);
  }

  get environment() {
    return this.options.auth.environment;
  }
  get identity() {
    return `${this.base.origin}|${this.options.auth.identity}|${this.options.sapClient ?? ''}`;
  }

  /** The absolute URL for a path below the base (or a `__next` link of the same host). */
  private resolve(pathOrUrl: string, query?: string): URL {
    const url = /^https?:\/\//i.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(this.base.pathname.replace(/\/$/, '') + pathOrUrl, this.base.origin);
    if (url.origin !== this.base.origin) throw new NodeOperationError('SAP sent a link to another host; it was not followed');
    if (query) url.search = url.search ? `${url.search}&${query}` : `?${query}`;
    if (this.options.sapClient && !url.searchParams.has('sap-client')) url.searchParams.set('sap-client', this.options.sapClient);
    return url;
  }

  /** A link from a `__next` or `@odata.nextLink` as a path (relative to the base) for the next page. */
  nextPath(link: string): string {
    const url = this.resolve(link);
    return url.pathname.slice(this.base.pathname.length) + url.search;
  }

  private storeCookies(headers: Headers) {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const cookie of list) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      if (at > 0) this.jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }

  private cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private async once(method: string, path: string, options: SendOptions, extra: Record<string, string> = {}): Promise<SapResponse> {
    const url = this.resolve(path, options.query);
    const headers: Record<string, string> = { accept: options.accept ?? 'application/json', ...this.options.auth.headers, ...(options.headers ?? {}), ...extra };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    const timeoutMs = Math.max(100, this.options.timeoutMs ?? 30_000);
    const signals = [AbortSignal.timeout(timeoutMs), ...(this.options.signal ? [this.options.signal] : [])];
    this.requests++;
    let response: Response;
    try {
      response = await this.options.fetch(url, { method, headers, ...(body !== undefined && { body }), redirect: 'manual', signal: AbortSignal.any(signals) });
    } catch (error) {
      const name = (error as Error)?.name;
      const where = `SAP ${options.context.service}${options.context.entitySet ? `/${options.context.entitySet}` : ''} ${options.context.operation}`;
      if (this.options.signal?.aborted) throw error;
      if (name === 'TimeoutError' || name === 'AbortError') {
        const write = method !== 'GET';
        throw new SapError(`${where} timed out after ${Math.round(timeoutMs / 1000)} s`, 0, {
          description: write ? 'The change may have been made. Check with a Get or List before trying again; SAP has no idempotency key.' : 'SAP did not answer in time.',
        });
      }
      throw new SapError(`${where} could not reach SAP: ${(error as Error)?.cause ? String(((error as Error).cause as Error)?.message ?? (error as Error).message) : (error as Error).message}`, 0, {
        description: 'Check the Base URL of the credential and the network.',
      });
    }
    this.storeCookies(response.headers);
    if (response.status >= 300 && response.status < 400) {
      throw new SapError(`SAP ${options.context.service} ${options.context.operation} answered ${response.status} with a redirect; redirects are not followed`, response.status, {
        description: 'A redirect usually means the Base URL is wrong or the host wants a browser login.',
      });
    }
    const type = response.headers.get('content-type') ?? '';
    const text = response.status === 204 ? '' : await response.text();
    let parsed: unknown = text;
    if (text && (/json/i.test(type) || /^\s*[{[]/.test(text)) && !/xml/i.test(type)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  /** A success answer that is a web page (a login page behind a wrong host) is not an OData answer. */
  private expectOData(response: SapResponse, options: SendOptions): SapResponse {
    if ((options.accept ?? 'application/json') === 'application/json' && typeof response.body === 'string' && response.body.trim() !== '') {
      throw mapError(options.context, response.status, response.body, response.headers);
    }
    return response;
  }

  /** A read: `Retry-After` on 429 (capped), one retry on a 5xx. */
  async get(path: string, options: SendOptions): Promise<SapResponse> {
    const sleep = this.options.sleep ?? realSleep;
    const cap = this.options.maxRetryAfterMs ?? 60_000;
    let serverRetried = false;
    for (let attempt = 0; ; attempt++) {
      const response = await this.once('GET', path, options);
      if (response.status < 300) return this.expectOData(response, options);
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
        if (wait <= cap) {
          await sleep(wait);
          continue;
        }
      }
      if (response.status >= 500 && !serverRetried) {
        serverRetried = true;
        await sleep(200);
        continue;
      }
      throw mapError(options.context, response.status, response.body, response.headers);
    }
  }

  /** A CSRF token for a service (fetched with `x-csrf-token: Fetch` on the service root, cookies kept). */
  private async csrf(servicePath: string, context: ErrorContext, force = false): Promise<string> {
    const cached = this.tokens.get(servicePath);
    if (cached && !force) return cached;
    const response = await this.once('GET', `${servicePath}/`, { context: { ...context, operation: 'fetch CSRF token' }, accept: 'application/json' }, { 'x-csrf-token': 'Fetch' });
    if (response.status >= 300) throw mapError({ ...context, operation: 'fetch CSRF token' }, response.status, response.body, response.headers);
    const token = response.headers.get('x-csrf-token');
    if (!token || /^required$/i.test(token)) {
      throw new SapError(`SAP ${context.service} gave no CSRF token`, response.status, { description: 'Writes need a CSRF token; the service root did not return one.' });
    }
    this.tokens.set(servicePath, token);
    return token;
  }

  /**
   * A write (POST, PATCH, DELETE) with CSRF and an optional ETag. A 403 whose `x-csrf-token` header says `Required` fetches a new
   * token and repeats the call once (the token is gone, so the first call changed nothing). Nothing else is retried.
   */
  async write(method: 'POST' | 'PATCH' | 'DELETE', servicePath: string, path: string, options: SendOptions & { etag?: string }): Promise<SapResponse> {
    const headersFor = (token: string) => ({ 'x-csrf-token': token, ...(options.etag && { 'if-match': options.etag }), ...(options.headers ?? {}) });
    let token = await this.csrf(servicePath, options.context);
    for (let attempt = 0; ; attempt++) {
      const response = await this.once(method, path, { ...options, headers: headersFor(token) });
      if (response.status < 300) return this.expectOData(response, options);
      if (response.status === 403 && /^required$/i.test(response.headers.get('x-csrf-token') ?? '') && attempt === 0) {
        token = await this.csrf(servicePath, options.context, true);
        continue;
      }
      if (response.status === 429 && attempt < 1) {
        const seconds = Number(response.headers.get('retry-after'));
        const wait = (Number.isFinite(seconds) && seconds >= 0 ? seconds : 1) * 1000;
        if (wait <= (this.options.maxRetryAfterMs ?? 60_000)) {
          await (this.options.sleep ?? realSleep)(wait);
          continue;
        }
      }
      throw mapError(options.context, response.status, response.body, response.headers);
    }
  }
}

// ---------------------------------------------------------------------------
// Reading collections
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export interface Page {
  records: unknown[];
  count?: number;
  next?: string;
}

/** The records, total count and next link of a collection answer, V2 (`d.results`, `d.__count`, `d.__next`) or V4 (`value`). */
export function unwrapCollection(body: unknown, context: ErrorContext): Page {
  if (!isObject(body)) throw new SapError(`SAP ${context.service} ${context.operation}: not an OData answer`, 200, { description: 'The answer was not JSON.' });
  const d = body.d;
  if (isObject(d)) {
    const records = Array.isArray(d.results) ? d.results : [];
    const count = d.__count !== undefined ? Number(d.__count) : undefined;
    return { records, ...(Number.isFinite(count) && { count }), ...(typeof d.__next === 'string' && { next: d.__next }) };
  }
  if (Array.isArray(d)) return { records: d };
  if (Array.isArray(body.value)) {
    const count = body['@odata.count'] !== undefined ? Number(body['@odata.count']) : undefined;
    return { records: body.value, ...(Number.isFinite(count) && { count }), ...(typeof body['@odata.nextLink'] === 'string' && { next: body['@odata.nextLink'] as string }) };
  }
  throw new SapError(`SAP ${context.service} ${context.operation}: the answer has no results`, 200, { description: 'Neither d.results nor value was in the answer.' });
}

/** One entity of a single-entity answer (`d` for V2, the object itself for V4). */
export function unwrapEntity(body: unknown): unknown {
  if (isObject(body) && isObject(body.d) && !('results' in body.d)) return body.d;
  return body;
}

export interface CollectResult {
  records: unknown[];
  /** The service's total (with a count asked for), else undefined. */
  total?: number;
  hasMore: boolean;
  pages: number;
}

/**
 * Reads a collection up to `limit` records, following the server's next links. `hasMore` is true when SAP has more than were
 * returned (a next link remains, or the count is larger).
 */
export async function collect(client: SapClient, firstPath: string, firstQuery: string, limit: number, context: ErrorContext, maxPages = 50): Promise<CollectResult> {
  const records: unknown[] = [];
  let total: number | undefined;
  let path = firstPath;
  let query: string | undefined = firstQuery;
  let pages = 0;
  let more = false;
  while (pages < maxPages) {
    const response = await client.get(path, { ...(query !== undefined && { query }), context });
    pages++;
    const page = unwrapCollection(response.body, context);
    if (page.count !== undefined) total = page.count;
    for (const record of page.records) {
      if (records.length >= limit) {
        more = true;
        break;
      }
      records.push(record);
    }
    if (more) break;
    if (!page.next) break;
    if (records.length >= limit) {
      more = true;
      break;
    }
    path = client.nextPath(page.next);
    query = undefined;
  }
  if (pages >= maxPages) more = true;
  if (!more && total !== undefined && total > records.length) more = true;
  return { records, ...(total !== undefined && { total }), hasMore: more, pages };
}

export type { ODataVersion };
