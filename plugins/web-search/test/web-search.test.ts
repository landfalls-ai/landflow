/** The Web Search node against fake SearXNG, Brave and Tavily servers on loopback. No real search API is called. */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runNode, type JsonObject } from '@landflow/sdk';
import type { ExecuteRequest } from '@landflow/protocol';
import { clean, checkSite, resetCallCounts } from '../src/search';
import { WebSearch } from '../src/nodes/web-search';
import { DEFAULT_MAX_CONCURRENCY, plugin } from '../src/main';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: any;
}
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };

let seen: Seen[] = [];
let reply: (s: Seen) => Reply = () => ({ body: {} });
let base = '';
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const text = Buffer.concat(chunks).toString('utf8');
    const s: Seen = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: text ? JSON.parse(text) : undefined };
    seen.push(s);
    const r = reply(s);
    setTimeout(() => {
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
    }, r.delayMs ?? 0);
  });
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
  reply = () => ({ body: {} });
  resetCallCounts();
});
afterEach(() => {
  delete process.env.LANDFLOW_SEARCH_DENY_DOMAINS;
  delete process.env.LANDFLOW_SEARCH_SEARXNG_URL;
});

const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'web-search' };
function run(parameters: JsonObject, credentials?: Record<string, JsonObject>, executionId = 'ex_test', continueOnFail = false) {
  const request: ExecuteRequest = {
    protocol: 'landflow.plugin/v1',
    executionId,
    workflowId: 'wf_test',
    mode: 'manual',
    node: { id: 'n1', name: 'Web Search', type: 'web-search.webSearch', typeVersion: 1 },
    parameters,
    itemParameters: [parameters],
    inputs: [[{ json: {} }]],
    ...(credentials && { credentials }),
    ...(continueOnFail && { continueOnFail: true }),
  };
  return runNode(new WebSearch(), request, extras);
}
const items = (r: Awaited<ReturnType<typeof run>>) => (r as any).outputs?.[0]?.map((x: any) => x.json) ?? [];
const failed = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify((r as any).error ?? '');

const searxngCred = () => ({ searxngApi: { baseUrl: base } });
const braveCred = () => ({ braveSearchApi: { apiKey: 'brave-key', baseUrl: base } });
const tavilyCred = () => ({ tavilyApi: { apiKey: 'tvly-key', baseUrl: base } });

describe('descriptor', () => {
  it('is a tool with an input and output schema and three credential types', () => {
    const d = new WebSearch().description;
    expect(d.usableAsTool).toBe(true);
    expect(Object.keys((d.toolInputSchema as any).properties).sort()).toEqual(['maxResults', 'query', 'recency', 'site']);
    expect((d.toolInputSchema as any).required).toEqual(['query']);
    expect(Object.keys((d.outputSchema as any).properties).sort()).toEqual(['snippet', 'source', 'title', 'url']);
    expect((plugin.credentialTypes ?? []).map((c) => c.name).sort()).toEqual(['braveSearchApi', 'searxngApi', 'tavilyApi']);
    expect(DEFAULT_MAX_CONCURRENCY).toBeGreaterThan(0);
  });
});

describe('SearXNG', () => {
  const body = {
    results: [
      { title: 'Landflow <b>docs</b>', url: 'https://www.example.com/docs', content: 'A low-code\n platform &amp; more', engine: 'x', score: 3 },
      { title: 'Second', url: 'https://other.org/a', content: 'two' },
      { title: 'Not http', url: 'javascript:alert(1)', content: 'bad' },
    ],
  };

  it('asks for JSON, maps the fields and returns only the four', async () => {
    reply = () => ({ body });
    const r = await run({ provider: 'searxng', query: '  landflow   workflow ', recency: 'week', site: 'https://example.com/x' }, searxngCred());
    expect(seen[0].path).toBe('/search');
    expect(seen[0].query.get('format')).toBe('json');
    expect(seen[0].query.get('q')).toBe('landflow workflow site:example.com');
    expect(seen[0].query.get('time_range')).toBe('week');
    expect(items(r)).toEqual([
      { title: 'Landflow docs', url: 'https://www.example.com/docs', snippet: 'A low-code platform & more', source: 'example.com' },
      { title: 'Second', url: 'https://other.org/a', snippet: 'two', source: 'other.org' },
    ]);
  });

  it('falls back to LANDFLOW_SEARCH_SEARXNG_URL and says what is missing without it', async () => {
    reply = () => ({ body });
    process.env.LANDFLOW_SEARCH_SEARXNG_URL = `${base}/`;
    expect(items(await run({ provider: 'searxng', query: 'x', maxResults: 1 }))).toHaveLength(1);
    expect(seen[0].path).toBe('/search');
    delete process.env.LANDFLOW_SEARCH_SEARXNG_URL;
    expect(failed(await run({ provider: 'searxng', query: 'x' }))).toContain('No SearXNG URL');
  });

  it('explains a 403 and a non-JSON answer', async () => {
    reply = () => ({ status: 403, body: 'forbidden' });
    expect(failed(await run({ provider: 'searxng', query: 'x' }, searxngCred()))).toContain('SearXNG refused the request (HTTP 403)');
    reply = () => ({ body: '<html>no json</html>' });
    expect(failed(await run({ provider: 'searxng', query: 'x' }, searxngCred()))).toContain('did not answer with JSON');
  });
});

describe('Brave Search', () => {
  it('sends the token header and maps web results', async () => {
    reply = () => ({ body: { web: { results: [{ title: 'B1', url: 'https://b.example/1', description: '<strong>hello</strong> world' }] } } });
    const r = await run({ provider: 'brave', query: 'x', maxResults: 3, recency: 'day', site: 'b.example' }, braveCred());
    expect(seen[0].path).toBe('/res/v1/web/search');
    expect(seen[0].headers['x-subscription-token']).toBe('brave-key');
    expect(seen[0].query.get('count')).toBe('3');
    expect(seen[0].query.get('freshness')).toBe('pd');
    expect(seen[0].query.get('q')).toBe('x site:b.example');
    expect(items(r)).toEqual([{ title: 'B1', url: 'https://b.example/1', snippet: 'hello world', source: 'b.example' }]);
  });

  it('reports rate limiting with the retry hint, and a bad key', async () => {
    reply = () => ({ status: 429, headers: { 'retry-after': '7' }, body: { error: 'slow down' } });
    const limited = failed(await run({ provider: 'brave', query: 'x' }, braveCred()));
    expect(limited).toContain('Brave Search rate limit reached (HTTP 429)');
    expect(limited).toContain('7 s');
    reply = () => ({ status: 401, body: {} });
    expect(failed(await run({ provider: 'brave', query: 'x' }, braveCred()))).toContain('refused the request (HTTP 401)');
  });

  it('needs its credential', async () => {
    expect(failed(await run({ provider: 'brave', query: 'x' }))).toBeTruthy();
    expect(seen).toHaveLength(0);
  });
});

describe('Tavily', () => {
  it('posts JSON with a bearer key and never asks for answers or page text', async () => {
    reply = () => ({ body: { results: [{ title: 'T1', url: 'https://t.example/1', content: 'text', raw_content: 'WHOLE PAGE', score: 0.9 }] } });
    const r = await run({ provider: 'tavily', query: 'x', maxResults: 4, recency: 'month', site: 't.example' }, tavilyCred());
    expect(seen[0].method).toBe('POST');
    expect(seen[0].path).toBe('/search');
    expect(seen[0].headers.authorization).toBe('Bearer tvly-key');
    expect(seen[0].body).toMatchObject({ query: 'x', max_results: 4, include_domains: ['t.example'], time_range: 'month', include_raw_content: false, include_answer: false });
    expect(items(r)).toEqual([{ title: 'T1', url: 'https://t.example/1', snippet: 'text', source: 't.example' }]);
  });

  it('reports rate limiting, server errors and an empty result', async () => {
    reply = () => ({ status: 429, body: {} });
    expect(failed(await run({ provider: 'tavily', query: 'x' }, tavilyCred()))).toContain('Tavily rate limit reached');
    reply = () => ({ status: 500, body: 'boom' });
    expect(failed(await run({ provider: 'tavily', query: 'x' }, tavilyCred()))).toContain('Tavily error (HTTP 500): boom');
    reply = () => ({ body: { results: [] } });
    expect(items(await run({ provider: 'tavily', query: 'x' }, tavilyCred()))).toEqual([]);
  });
});

describe('safeguards', () => {
  const many = () => ({ results: Array.from({ length: 40 }, (_, i) => ({ title: `T${i}`, url: `https://s${i}.example/`, content: 'c' })) });

  it('caps results at 20 and clamps nonsense', async () => {
    reply = () => ({ body: many() });
    expect(items(await run({ provider: 'searxng', query: 'x', maxResults: 500 }, searxngCred()))).toHaveLength(20);
    expect(items(await run({ provider: 'searxng', query: 'x', maxResults: -3 }, searxngCred())).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses an empty or too long query, and a bad site, before any call', async () => {
    expect(failed(await run({ provider: 'searxng', query: '   ' }, searxngCred()))).toContain('Query is empty');
    expect(failed(await run({ provider: 'searxng', query: 'a'.repeat(401) }, searxngCred()))).toContain('too long');
    expect(failed(await run({ provider: 'searxng', query: 'x', site: 'not a domain!' }, searxngCred()))).toContain('not a domain');
    expect(seen).toHaveLength(0);
  });

  it('stops a run at its call limit, per run', async () => {
    reply = () => ({ body: many() });
    const p = { provider: 'searxng', query: 'x', options: { maxCallsPerRun: 2 } };
    expect(failed(await run(p, searxngCred(), 'run-a'))).toBe('""');
    await run(p, searxngCred(), 'run-a');
    expect(failed(await run(p, searxngCred(), 'run-a'))).toContain('Search limit reached');
    expect(seen).toHaveLength(2);
    expect(failed(await run(p, searxngCred(), 'run-b'))).toBe('""');
  });

  it('times out a slow provider', async () => {
    reply = () => ({ body: many(), delayMs: 800 });
    const r = await run({ provider: 'searxng', query: 'x', options: { timeoutSeconds: 0.1 } }, searxngCred());
    expect(failed(r)).toContain('did not answer within');
  });

  it('reports a provider that is not there', async () => {
    const r = await run({ provider: 'searxng', query: 'x' }, { searxngApi: { baseUrl: 'http://127.0.0.1:1' } });
    expect(failed(r)).toContain('SearXNG request failed');
  });

  it('applies the operator deny-list to results and to the site filter', async () => {
    process.env.LANDFLOW_SEARCH_DENY_DOMAINS = 'bad.example, *.evil.org';
    reply = () => ({
      body: { results: [{ title: 'a', url: 'https://bad.example/x', content: '' }, { title: 'b', url: 'https://sub.bad.example/x', content: '' }, { title: 'c', url: 'https://www.evil.org/', content: '' }, { title: 'd', url: 'https://good.example/', content: '' }] },
    });
    expect(items(await run({ provider: 'searxng', query: 'x' }, searxngCred())).map((x: any) => x.source)).toEqual(['good.example']);
    expect(failed(await run({ provider: 'searxng', query: 'x', site: 'docs.bad.example' }, searxngCred()))).toContain('deny-list');
  });

  it('trims snippets and strips markup and control characters', async () => {
    reply = () => ({ body: { results: [{ title: 'x', url: 'https://a.example/', content: `<script>alert(1)</script>${'word '.repeat(200)}\u0000‮` }] } });
    const [one] = items(await run({ provider: 'searxng', query: 'x', options: { snippetLength: 50 } }, searxngCred()));
    expect(one.snippet.length).toBeLessThanOrEqual(50);
    expect(one.snippet).not.toMatch(/[<>\u0000‮]/);
  });

  it('turns a failure into an item with continue on fail', async () => {
    reply = () => ({ status: 429, body: {} });
    const r = await run({ provider: 'searxng', query: 'x' }, searxngCred(), 'ex_c', true);
    expect(items(r)[0].error).toContain('rate limit');
  });
});

describe('helpers', () => {
  it('cleans text and validates sites', () => {
    expect(clean('<p>a&nbsp;b</p>  c', 100)).toBe('a b c');
    expect(clean('abcdef', 4)).toBe('abc…');
    expect(checkSite('', [])).toBeUndefined();
    expect(checkSite('HTTPS://Docs.Example.com/path?q=1', [])).toBe('docs.example.com');
  });
});
