/**
 * safeFetch: the one guarded client for requests to a URL a user, a webhook or a model can influence (the HTTP
 * Request node, alert channels, SIEM destinations, remote MCP servers, RAG embeddings, OIDC/SAML metadata).
 *
 * The host runs next to Postgres, Valkey, the secrets manager, the code runner and (in a cloud) a metadata address, so
 * a request must not reach loopback, private, link-local, CGNAT or metadata addresses unless an operator allowed them.
 * Checking the host name before the call is not enough (a name can resolve to anything, and a redirect can move to
 * another one), so:
 * - the check sits in the socket's DNS lookup: the address that is checked is the address that is connected to, and a
 *   name with one blocked address among its answers is refused as a whole;
 * - literal IP hosts, which never reach DNS, are checked before connecting;
 * - redirects are followed here, one hop at a time, and every hop gets the same checks (the governance host list by
 *   name first, then the address).
 *
 * Policy (read at call time):
 * - LANDFLOW_OUTBOUND_BLOCK_PRIVATE: default on in the production profile, off in development (local fakes and tests
 *   on 127.0.0.1 keep working);
 * - LANDFLOW_OUTBOUND_ALLOW: comma-separated host names (`*.corp.example` works) and IPs or CIDR ranges that stay
 *   reachable; the hosts of OLLAMA_URL, LANDFLOW_CODE_RUNNER_URL, OPENAI_BASE_URL and the MCP gateway URLs always are.
 * Remote plugins, databases, brokers, S3 and the marketplace's git are configured infrastructure and not covered.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { envFlag, envString, envUrl, isProduction } from '../config';
import { singleton } from '../singleton';
import { SpanKind, withSpan } from '../telemetry/spans';
import { addressInRange, isBlockedAddress, stripBrackets } from './addresses';

/** A request refused by the outbound policy (a node shows its message; HTTP semantics: 403). */
export class OutboundBlockedError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'OutboundBlockedError';
  }
}

export interface OutboundPolicy {
  blockPrivate: boolean;
  /** Host names (lower case, `*.suffix` allowed) and IP / CIDR entries. */
  allow: string[];
}

/** Variables whose host the host itself is configured to call, so they stay reachable without being listed. */
const IMPLICIT_URLS = ['OLLAMA_URL', 'LANDFLOW_CODE_RUNNER_URL', 'OPENAI_BASE_URL', 'LANDFLOW_MCP_GATEWAY_PUBLIC_URL', 'LANDFLOW_MCP_GATEWAY_ADMIN_URL', 'LANDFLOW_MCP_GATEWAY_HOST_URL'];

export function outboundPolicy(): OutboundPolicy {
  const listed = (envString('LANDFLOW_OUTBOUND_ALLOW') ?? '')
    .split(/[\s,]+/)
    .map((entry) => stripBrackets(entry.trim().toLowerCase()))
    .filter(Boolean);
  const implicit = IMPLICIT_URLS.map((name) => envUrl(name))
    .filter((value): value is string => Boolean(value))
    .map((value) => stripBrackets(new URL(value).hostname.toLowerCase()));
  return { blockPrivate: envFlag('LANDFLOW_OUTBOUND_BLOCK_PRIVATE', isProduction()), allow: [...listed, ...implicit] };
}

const isRange = (entry: string): boolean => isIP(entry.split('/')[0]) !== 0;

function nameAllowed(host: string, policy: OutboundPolicy): boolean {
  const name = host.toLowerCase();
  return policy.allow.some((entry) => !isRange(entry) && (entry.startsWith('*.') ? name.endsWith(entry.slice(1)) : entry === name));
}

function addressAllowed(address: string, policy: OutboundPolicy): boolean {
  return policy.allow.some((entry) => isRange(entry) && addressInRange(address, entry));
}

const blocked = (host: string): OutboundBlockedError => new OutboundBlockedError(`Blocked: ${host} resolves to a private address (LANDFLOW_OUTBOUND_ALLOW lists exceptions)`);

/** Throws when a request to `host` that resolves to `address` is refused by `policy`. */
export function assertAddressAllowed(host: string, address: string, policy: OutboundPolicy = outboundPolicy()): void {
  if (!policy.blockPrivate || !isBlockedAddress(address)) return;
  if (nameAllowed(host, policy) || addressAllowed(address, policy)) return;
  throw blocked(host);
}

/** The check for a URL before any connection: a literal IP host has no DNS step, so this is its only check. */
export function assertUrlAllowed(url: URL, policy: OutboundPolicy = outboundPolicy()): void {
  const host = stripBrackets(url.hostname);
  if (isIP(host)) assertAddressAllowed(host, host, policy);
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for sockets (`net.connect`, `http.request`, undici's `connect`): `dns.lookup` that refuses blocked
 * addresses. It handles both shapes of answer (one address, or all of them with `all: true`).
 */
export function guardedLookup(hostname: string, options: object | number | undefined, callback: LookupCallback): void {
  const opts = typeof options === 'object' && options ? options : typeof options === 'number' ? { family: options } : {};
  const wantsAll = Boolean((opts as { all?: boolean }).all);
  dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return callback(error, '', undefined);
    try {
      for (const { address } of addresses) assertAddressAllowed(hostname, address);
    } catch (refused) {
      return callback(refused as NodeJS.ErrnoException, '', undefined);
    }
    if (wantsAll) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const agent = (): Agent => singleton('outbound.agent', () => new Agent({ connect: { lookup: guardedLookup as never } }));

export interface SafeFetchOptions {
  /** Why a URL is not allowed by name (the governance host list), or undefined; asked for every hop. */
  hostCheck?: (url: URL) => string | undefined;
  /** Redirects followed before giving up (default 10). */
  maxRedirects?: number;
  /** Record a client span (`HTTP <method>`); off for callers that already trace (ctx.http). Default on. */
  span?: boolean;
}

/** The first OutboundBlockedError in an error's cause chain (undici wraps socket errors as "fetch failed"). */
function blockedCause(error: unknown): OutboundBlockedError | undefined {
  for (let current = error as { cause?: unknown } | undefined, depth = 0; current && depth < 5; current = current.cause as { cause?: unknown } | undefined, depth++) {
    if (current instanceof OutboundBlockedError) return current;
  }
  return undefined;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function parse(value: string | URL): URL {
  const url = new URL(String(value));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundBlockedError(`Blocked: ${url.protocol} URLs are not allowed, only http and https`);
  return url;
}

async function hop(url: URL, init: RequestInit, options: SafeFetchOptions): Promise<Response> {
  const message = options.hostCheck?.(url);
  if (message) throw new OutboundBlockedError(message);
  // Blocking off (development): the platform fetch, so local fakes and test stubs behave as they always did.
  if (!outboundPolicy().blockPrivate) return fetch(url, { ...init, redirect: 'manual' });
  assertUrlAllowed(url);
  try {
    return (await undiciFetch(url, { ...(init as object), redirect: 'manual', dispatcher: agent() } as never)) as unknown as Response;
  } catch (error) {
    throw blockedCause(error) ?? error;
  }
}

async function follow(first: URL, init: RequestInit, options: SafeFetchOptions): Promise<Response> {
  const mode = init.redirect ?? 'follow';
  const limit = options.maxRedirects ?? 10;
  let url = first;
  let current = init;
  for (let redirects = 0; ; redirects++) {
    const response = await hop(url, current, options);
    const location = response.headers.get('location');
    if (!REDIRECTS.has(response.status) || !location || mode === 'manual') return response;
    if (mode === 'error') throw new TypeError(`Redirected to ${new URL(location, url).origin} while redirects are not allowed`);
    if (redirects >= limit) throw new Error(`Too many redirects (more than ${limit})`);
    await response.body?.cancel().catch(() => undefined);
    const next = parse(new URL(location, url));
    const method = (current.method ?? 'GET').toUpperCase();
    const toGet = response.status === 303 ? method !== 'HEAD' : (response.status === 301 || response.status === 302) && method === 'POST';
    const headers = new Headers(current.headers);
    if (next.origin !== url.origin) for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
    if (toGet) {
      for (const name of ['content-type', 'content-length', 'content-encoding']) headers.delete(name);
      current = { ...current, method: 'GET', body: undefined, headers };
    } else {
      if (current.body && typeof current.body === 'object' && 'getReader' in current.body) throw new Error(`Cannot follow the ${response.status} redirect of a streamed request body`);
      current = { ...current, headers };
    }
    url = next;
  }
}

/** `fetch` with the outbound policy (see the file header). Throws OutboundBlockedError for a refused target. */
export async function safeFetch(input: string | URL | Request, init: RequestInit = {}, options: SafeFetchOptions = {}): Promise<Response> {
  let merged = init;
  if (input instanceof Request) {
    const hasBody = !['GET', 'HEAD'].includes(input.method) && init.body === undefined;
    merged = { method: input.method, headers: input.headers, signal: input.signal, ...(hasBody && { body: await input.arrayBuffer() }), ...init };
  }
  const url = parse(input instanceof Request ? input.url : input);
  const run = () => follow(url, merged, options);
  if (options.span === false) return run();
  const method = (merged.method ?? 'GET').toUpperCase();
  return withSpan(
    `HTTP ${method}`,
    { kind: SpanKind.CLIENT, attributes: { 'http.request.method': method, 'server.address': url.hostname, 'url.full': `${url.protocol}//${url.host}${url.pathname}` } },
    async (span) => {
      const response = await run();
      span.setAttribute('http.response.status_code', response.status);
      return response;
    },
  );
}
