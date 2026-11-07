/** Providers, limits and cleaning for the Web Search node. No node types in here, so tests can drive it directly. */
import { NodeOperationError } from '@landflow/sdk';

export type Provider = 'searxng' | 'brave' | 'tavily';
export type Recency = 'any' | 'day' | 'week' | 'month' | 'year';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export const HARD_MAX_RESULTS = 20;
export const DEFAULT_MAX_RESULTS = 5;
export const MAX_QUERY_LENGTH = 400;
export const MAX_TITLE_LENGTH = 200;
export const DEFAULT_SNIPPET_LENGTH = 300;
export const MAX_SNIPPET_LENGTH = 1000;
export const DEFAULT_TIMEOUT_SECONDS = 15;
export const DEFAULT_MAX_CALLS_PER_RUN = 20;
export const BRAVE_URL = 'https://api.search.brave.com';
export const TAVILY_URL = 'https://api.tavily.com';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface SearchRequest {
  query: string;
  maxResults: number;
  /** A bare domain, already validated. */
  site?: string;
  recency: Recency;
  timeoutMs: number;
}

// ---------------------------------------------------------------- input checks

export function checkQuery(raw: unknown): string {
  const query = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!query) throw new NodeOperationError('Query is empty', { description: 'Pass the words to search for in `query`.' });
  if (query.length > MAX_QUERY_LENGTH) {
    throw new NodeOperationError(`Query is too long (${query.length} characters, at most ${MAX_QUERY_LENGTH})`, { description: 'Search with a short, focused query.' });
  }
  return query;
}

export function clampResults(raw: unknown, fallback = DEFAULT_MAX_RESULTS): number {
  const n = Math.round(Number(raw));
  return Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? n : fallback, HARD_MAX_RESULTS));
}

export function parseDomains(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^\*?\./, ''))
    .filter(Boolean);
}

/** The operator's deny-list, read on every call. */
export const denyList = (): string[] => parseDomains(process.env.LANDFLOW_SEARCH_DENY_DOMAINS);

export function isDenied(host: string, deny: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return deny.some((d) => h === d || h.endsWith(`.${d}`));
}

/** A bare domain such as `example.com`; a pasted URL is reduced to its host. */
export function checkSite(raw: unknown, deny: string[]): string | undefined {
  let site = String(raw ?? '').trim().toLowerCase();
  if (!site) return undefined;
  site = site.replace(/^[a-z]+:\/\//, '').replace(/^site:/, '').replace(/^\*?\./, '').replace(/[/?#].*$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(site)) {
    throw new NodeOperationError(`Site "${String(raw).slice(0, 80)}" is not a domain`, { description: 'Use a bare domain such as example.com.' });
  }
  if (isDenied(site, deny)) throw new NodeOperationError(`Site ${site} is on this server's deny-list and cannot be searched`);
  return site;
}

export function checkRecency(raw: unknown): Recency {
  const v = String(raw ?? 'any').toLowerCase();
  return (['day', 'week', 'month', 'year'] as const).find((r) => r === v) ?? 'any';
}

// ---------------------------------------------------------------- cleaning

// Control, bidi and zero-width characters, written as escapes.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

/** Plain text of at most `max` characters: tags, entities and control characters out, whitespace collapsed. */
export function clean(value: unknown, max: number): string {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

interface Raw {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
}

/** Only http(s) links, no denied hosts, no repeats, cut to `limit`, with a trimmed title and snippet. */
export function normalize(raw: Raw[], limit: number, snippetLength: number, deny: string[]): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    let url: URL;
    try {
      url = new URL(String(r.url ?? ''));
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (isDenied(url.hostname, deny) || seen.has(url.href)) continue;
    seen.add(url.href);
    const source = url.hostname.replace(/^www\./, '');
    out.push({ title: clean(r.title, MAX_TITLE_LENGTH) || source, url: url.href, snippet: clean(r.snippet, snippetLength), source });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- providers

function failure(provider: string, status: number, headers: Headers, text: string): NodeOperationError {
  const retry = headers.get('retry-after');
  const body = clean(text, 160);
  if (status === 429) {
    return new NodeOperationError(`${provider} rate limit reached (HTTP 429)`, {
      description: `${provider} is limiting this key or server${retry ? `; try again in ${retry} s` : ''}. Search less often or raise the plan.`,
    });
  }
  if (status === 401 || status === 403) {
    return new NodeOperationError(`${provider} refused the request (HTTP ${status})`, {
      description:
        provider === 'SearXNG'
          ? 'Check the SearXNG URL, and that the instance allows the JSON format (search.formats in settings.yml).'
          : 'Check the API key in the saved credential: it may be wrong, expired or out of quota.',
    });
  }
  return new NodeOperationError(`${provider} error (HTTP ${status})${body ? `: ${body}` : ''}`);
}

async function call(provider: string, fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const e = error as Error & { cause?: { code?: string; message?: string } };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new NodeOperationError(`${provider} did not answer within ${timeoutMs / 1000} s`);
    const cause = e?.cause?.code ?? e?.cause?.message;
    throw new NodeOperationError(`${provider} request failed: ${cause ? `${e.message} (${cause})` : (e?.message ?? String(error))}`);
  }
  const text = await response.text();
  if (!response.ok) throw failure(provider, response.status, response.headers, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new NodeOperationError(
      `${provider} did not answer with JSON`,
      provider === 'SearXNG' ? { description: 'Enable the json format on the instance: search.formats in settings.yml must list html and json.' } : {},
    );
  }
}

const withSite = (query: string, site?: string) => (site ? `${query} site:${site}` : query);
const trimBase = (u: string) => u.trim().replace(/\/+$/, '');

export interface Endpoint {
  baseUrl: string;
  apiKey?: string;
}

export async function searchSearxng(fetcher: Fetcher, e: Endpoint, r: SearchRequest): Promise<Raw[]> {
  const params = new URLSearchParams({ q: withSite(r.query, r.site), format: 'json', safesearch: '1' });
  if (r.recency !== 'any') params.set('time_range', r.recency);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (e.apiKey) headers.authorization = `Bearer ${e.apiKey}`;
  const body = (await call('SearXNG', fetcher, `${trimBase(e.baseUrl)}/search?${params}`, { headers }, r.timeoutMs)) as { results?: any[] };
  return (body.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
}

export async function searchBrave(fetcher: Fetcher, e: Endpoint, r: SearchRequest): Promise<Raw[]> {
  const params = new URLSearchParams({ q: withSite(r.query, r.site), count: String(r.maxResults), safesearch: 'moderate' });
  const fresh = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;
  if (r.recency !== 'any') params.set('freshness', fresh[r.recency]);
  const body = (await call(
    'Brave Search',
    fetcher,
    `${trimBase(e.baseUrl)}/res/v1/web/search?${params}`,
    { headers: { accept: 'application/json', 'x-subscription-token': e.apiKey ?? '' } },
    r.timeoutMs,
  )) as { web?: { results?: any[] } };
  return (body.web?.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.description }));
}

export async function searchTavily(fetcher: Fetcher, e: Endpoint, r: SearchRequest): Promise<Raw[]> {
  const payload = {
    query: r.query,
    max_results: r.maxResults,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    ...(r.site && { include_domains: [r.site] }),
    ...(r.recency !== 'any' && { time_range: r.recency }),
  };
  const body = (await call(
    'Tavily',
    fetcher,
    `${trimBase(e.baseUrl)}/search`,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${e.apiKey ?? ''}` },
      body: JSON.stringify(payload),
    },
    r.timeoutMs,
  )) as { results?: any[] };
  return (body.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
}

export const PROVIDERS = { searxng: searchSearxng, brave: searchBrave, tavily: searchTavily } as const;

// ---------------------------------------------------------------- per-run call limit

const calls = new Map<string, number>();

/** Counts one search for this run; throws once the run has made `limit` of them (0 or less: no limit). */
export function countCall(runId: string, limit: number): void {
  if (limit <= 0) return;
  const n = (calls.get(runId) ?? 0) + 1;
  if (n > limit) {
    throw new NodeOperationError(`Search limit reached: this run already made ${limit} searches`, {
      description: 'The node caps the searches one run may make (Options, Max Searches per Run). Answer with what was found, or raise the limit.',
    });
  }
  calls.set(runId, n);
  if (calls.size > 2000) calls.delete(calls.keys().next().value as string); // oldest run first
}

export const resetCallCounts = () => calls.clear();
