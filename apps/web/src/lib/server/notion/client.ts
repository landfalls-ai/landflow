/**
 * The host's Notion client (docs/features/notion-brain.md#how-landflow-talks-to-notion): Notion-Version 2026-03-11, Markdown v2,
 * the calls the sync needs, a limiter per credential, and Notion's retry rules. It registers itself with
 * `setNotionClientFactory` when this module loads (lib/server/runtime.ts imports it).
 *
 * The key is read from the vault right before each request and kept in no closure that outlives it. Messages, spans and the
 * write log never hold it, nor page text.
 *
 * Retries: 429 and 529 wait `Retry-After` (or `additional_data.retry_after`, at most 120 s) and go again; 429
 * `public_api_request_blocked` is `blocked` and never retried; 500 and reads that get 503 or 504 back off with jitter
 * (1 s up to 5 min, at most 6 tries in one call); a 503 or 504 on a write is not retried (it may have landed: `mayHaveLanded`);
 * 409 is `conflict` (the caller re-reads and retries once); 400, 401, 403 and 404 are not retried.
 */
import { credentials } from '../credentials/vault';
import { safeFetch } from '../net/safe-fetch';
import { withSpan, SpanKind } from '../telemetry';
import { MAX_RETRY_AFTER_MS, NotionError, kindOfStatus, retryAfterMs } from './errors';
import { acquire, noteAnswered, noteRateLimited } from './limiter';
import {
  MARKDOWN_VERSION,
  NOTION_API,
  NOTION_VERSION,
  setNotionClientFactory,
  type NotionBlock,
  type NotionClient,
  type NotionClientOptions,
  type NotionDataSource,
  type NotionDatabase,
  type NotionList,
  type NotionPage,
  type NotionPageMarkdown,
  type NotionUser,
} from './port';
import { richText } from './text';
import { logNotionWrite } from './write-log';

const KEY_FIELDS: Record<string, string> = { 'productivity.notionApi': 'apiKey', 'productivity.notionOAuth2Api': 'accessToken' };
export const MAX_TRIES = 6;
const MAX_RATE_LIMIT_WAITS = 8;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 300_000;
const UNKNOWN_BLOCK_READS = 20;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Call {
  method: 'GET' | 'POST' | 'PATCH';
  /** The path with `:id` in place of ids: for spans, messages and the write log. */
  template: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  /** Changes something (not a read, not a query). */
  write?: boolean;
  isQuery?: boolean;
}

const idOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function parentIdOf(body: Record<string, unknown> | undefined): string | undefined {
  const parent = body?.parent as Record<string, unknown> | undefined;
  return idOf(parent?.page_id) ?? idOf(parent?.data_source_id) ?? idOf(parent?.database_id);
}

export function notionClient(options: NotionClientOptions): NotionClient {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const doFetch = options.fetchImpl ?? ((input: string, init: RequestInit) => safeFetch(input, init, { span: false }));

  /** The key and base URL, read now and handed to one request only. */
  async function credential(): Promise<{ key: string; baseUrl: string }> {
    const stored = credentials.get(options.credentialId);
    const field = stored && KEY_FIELDS[stored.type];
    if (!stored || !field) {
      throw new NotionError(stored ? `Credential "${stored.name}" is a ${stored.type}, not a Notion credential` : 'The Notion credential was deleted', { kind: 'unauthorized', status: 0, retryable: false });
    }
    const data = await credentials.dataWithSecrets({ id: stored.id, name: stored.name }, stored.type);
    const key = typeof data[field] === 'string' ? (data[field] as string) : '';
    if (!key) throw new NotionError(`Credential "${stored.name}" has no ${field}`, { kind: 'unauthorized', status: 0, retryable: false });
    const base = typeof data.baseUrl === 'string' && data.baseUrl.trim() ? data.baseUrl.trim() : NOTION_API;
    return { key, baseUrl: base.replace(/\/+$/, '') };
  }

  async function attempt(call: Call): Promise<Response> {
    const { key, baseUrl } = await credential();
    const query = Object.entries(call.query ?? {}).filter(([, v]) => v !== undefined);
    const url = `${baseUrl}${call.path}${query.length ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : ''}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
    try {
      return await doFetch(url, { method: call.method, headers, ...(call.body && { body: JSON.stringify(call.body) }) });
    } catch (error) {
      // The cause of a fetch failure is a network error's text, which never holds the key.
      throw new NotionError(`${call.method} ${call.template}: no answer (${(error as Error).message})`, { kind: 'network', status: 0, mayHaveLanded: false });
    }
  }

  async function request<T>(call: Call): Promise<T> {
    return withSpan(`Notion ${call.method} ${call.template}`, { kind: SpanKind.CLIENT, attributes: { 'http.request.method': call.method, 'url.template': call.template } }, async (span) => {
      let tries = 0;
      let rateWaits = 0;
      for (;;) {
        await acquire(options.credentialId, { rps: options.rps, query: call.isQuery, now, sleep });
        if (call.write && tries === 0 && rateWaits === 0) {
          logNotionWrite({ method: call.method, pathTemplate: call.template, targetId: call.method === 'PATCH' ? idOf(call.path.split('/')[3]) : undefined, parentId: parentIdOf(call.body) });
        }
        const response = await attempt(call);
        span.setAttribute('http.response.status_code', response.status);
        const text = await response.text();
        let payload: unknown;
        try {
          payload = text ? JSON.parse(text) : undefined;
        } catch {
          payload = undefined;
        }
        if (response.ok) {
          noteAnswered(options.credentialId);
          return payload as T;
        }
        const code = idOf((payload as { code?: unknown } | undefined)?.code);
        const status = response.status;
        const message = `Notion ${call.method} ${call.template}: ${status}${code ? ` ${code}` : ''}`;
        const waitMs = retryAfterMs(response.headers.get('retry-after'), payload);
        if (status === 429 || status === 529) {
          if (status === 429) {
            if (code === 'public_api_request_blocked') {
              noteAnswered(options.credentialId);
              throw new NotionError(message, { kind: 'blocked', status, code, retryable: false });
            }
            noteRateLimited(options.credentialId, now());
          } else noteAnswered(options.credentialId);
          if (++rateWaits > MAX_RATE_LIMIT_WAITS) throw new NotionError(message, { kind: 'rateLimited', status, ...(code && { code }), retryAfterMs: waitMs });
          await sleep(waitMs ?? 1000);
          continue;
        }
        noteAnswered(options.credentialId);
        if (status >= 500) {
          const landed = call.write && (status === 503 || status === 504);
          if (landed) throw new NotionError(message, { kind: 'unavailable', status, ...(code && { code }), mayHaveLanded: true });
          if (++tries >= MAX_TRIES) throw new NotionError(message, { kind: 'unavailable', status, ...(code && { code }) });
          const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (tries - 1));
          await sleep(Math.round(backoff * (0.5 + Math.random() * 0.5)));
          continue;
        }
        throw new NotionError(message, { kind: kindOfStatus(status, code), status, ...(code && { code }) });
      }
    });
  }

  const get = <T>(template: string, path: string, query?: Call['query']) => request<T>({ method: 'GET', template, path, query });
  const md = { markdown_version: MARKDOWN_VERSION };

  async function pageMarkdown(id: string): Promise<NotionPageMarkdown> {
    const first = await get<NotionPageMarkdown>('/v1/pages/:id/markdown', `/v1/pages/${id}/markdown`, md);
    const parts = [first.markdown];
    const queue = [...(first.unknown_block_ids ?? [])];
    let truncated = first.truncated;
    let reads = 0;
    while (queue.length && reads < UNKNOWN_BLOCK_READS) {
      const block = queue.shift()!;
      reads++;
      const more = await get<NotionPageMarkdown>('/v1/pages/:id/markdown', `/v1/pages/${block}/markdown`, md);
      parts.push(more.markdown);
      truncated ||= more.truncated;
      queue.push(...(more.unknown_block_ids ?? []));
    }
    if (queue.length) truncated = true;
    return { ...first, markdown: parts.join('\n'), truncated, unknown_block_ids: queue };
  }

  const client: NotionClient = {
    me: () => get<NotionUser>('/v1/users/me', '/v1/users/me'),
    page: (id) => get<NotionPage>('/v1/pages/:id', `/v1/pages/${id}`),
    pageMarkdown,
    createPage: (input) =>
      request<NotionPage>({
        method: 'POST',
        template: '/v1/pages',
        path: '/v1/pages',
        write: true,
        body: { parent: input.parent, ...(input.properties && { properties: input.properties }), ...(input.markdown !== undefined && { markdown: input.markdown, ...md }) },
      }),
    updatePage: (id, input) => request<NotionPage>({ method: 'PATCH', template: '/v1/pages/:id', path: `/v1/pages/${id}`, write: true, body: { ...input } }),
    updateMarkdown: (id, update) => request<NotionPageMarkdown>({ method: 'PATCH', template: '/v1/pages/:id/markdown', path: `/v1/pages/${id}/markdown`, write: true, body: { ...update, ...md } }),
    async createDatabase(input) {
      const created = await request<NotionDatabase>({
        method: 'POST',
        template: '/v1/databases',
        path: '/v1/databases',
        write: true,
        body: { parent: { type: 'page_id', page_id: input.parent.page_id }, title: richText(input.title), initial_data_source: { properties: input.properties } },
      });
      const dataSourceId = created.data_sources?.[0]?.id;
      if (!dataSourceId) throw new NotionError('Notion POST /v1/databases: the answer named no data source', { kind: 'invalid', status: 200, retryable: false });
      const source = await client.dataSource(dataSourceId);
      return { databaseId: created.id, dataSourceId, propertyIds: Object.fromEntries(Object.entries(source.properties).map(([name, property]) => [name, property.id])), url: created.url };
    },
    database: (id) => get<NotionDatabase>('/v1/databases/:id', `/v1/databases/${id}`),
    dataSource: (id) => get<NotionDataSource>('/v1/data_sources/:id', `/v1/data_sources/${id}`),
    updateDataSource: (id, input) => request<NotionDataSource>({ method: 'PATCH', template: '/v1/data_sources/:id', path: `/v1/data_sources/${id}`, write: true, body: { ...input } }),
    queryDataSource: (id, query) => request<NotionList<NotionPage>>({ method: 'POST', template: '/v1/data_sources/:id/query', path: `/v1/data_sources/${id}/query`, body: { ...query }, isQuery: true }),
    children: (blockId, cursor) => get<NotionList<NotionBlock>>('/v1/blocks/:id/children', `/v1/blocks/${blockId}/children`, { page_size: 100, start_cursor: cursor }),
    async *paginate<T>(call: (cursor: string | undefined) => Promise<NotionList<T>>) {
      let cursor: string | undefined;
      for (;;) {
        const list = await call(cursor);
        yield* list.results;
        if (!list.has_more || !list.next_cursor) return;
        cursor = list.next_cursor;
      }
    },
  };
  return client;
}

setNotionClientFactory(notionClient);
