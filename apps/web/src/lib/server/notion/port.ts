/**
 * The host's Notion client, as the brain's sync sees it (docs/features/notion-brain.md#how-landflow-talks-to-notion): the
 * API shapes Landflow uses (Notion-Version 2026-03-11, Markdown v2), the error every call throws, page id parsing, and the
 * slot the client registers itself in (lib/server/notion/client.ts, NB02), so the link routes (NB03) and the sync (NB04–NB06)
 * get a client without importing it. Nothing here calls Notion.
 *
 * Written by the plan for the Notion brain program, wave nb1: NB02 owns it (backbone/contracts/nb/notion-port.ts); NB03 adds
 * this file byte for byte. Change it in the contract first, then every copy.
 */
import { singleton } from '../singleton';

export const NOTION_VERSION = '2026-03-11';
export const MARKDOWN_VERSION = 'v2';
export const NOTION_API = 'https://api.notion.com';

// ---------------------------------------------------------------------------------------------------- ids

/**
 * A page or database id from what a person pastes: a 32-hex id, a dashed UUID, or a notion.so / notion.com / notion.site
 * link (the id is the last 32 hex characters of the path, dashes ignored, before any `?` or `#`). Returns the dashed
 * lower-case UUID, or undefined. Covers the cases of the productivity plugin's `page_id`
 * (plugins/productivity/tests/test_notion.py `test_page_id`); a link to another host is refused.
 */
export function notionId(text: string | undefined | null): string | undefined {
  let path = String(text ?? '').trim();
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      return undefined;
    }
    const host = url.hostname.toLowerCase();
    if (!['notion.so', 'notion.com', 'notion.site'].some((h) => host === h || host.endsWith(`.${h}`))) return undefined;
    path = url.pathname;
  } else {
    path = path.split(/[?#]/)[0];
  }
  const hex = path.replace(/\/+$/, '').replace(/-/g, '').match(/([0-9a-f]{32})$/i)?.[1]?.toLowerCase();
  if (!hex) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether two ids name the same object (dashes and case ignored). */
export const sameId = (a: string | undefined, b: string | undefined): boolean =>
  Boolean(a && b) && a!.replace(/-/g, '').toLowerCase() === b!.replace(/-/g, '').toLowerCase();

// ---------------------------------------------------------------------------------------------------- API shapes

export interface NotionRichText {
  type: 'text' | 'mention' | 'equation';
  text?: { content: string; link?: { url: string } | null };
  mention?: { type: 'page'; page: { id: string } } | { type: 'user'; user: { id: string } } | { type: 'date'; date: { start: string } };
  annotations?: Record<string, unknown>;
  plain_text?: string;
  href?: string | null;
}

export interface NotionUserRef {
  object: 'user';
  id: string;
}

export interface NotionUser extends NotionUserRef {
  type?: 'person' | 'bot';
  name?: string | null;
  person?: { email?: string };
  bot?: { owner?: { type: 'workspace' | 'user'; workspace?: true }; workspace_name?: string | null };
}

export type NotionParent =
  | { type: 'page_id'; page_id: string }
  | { type: 'database_id'; database_id: string }
  | { type: 'data_source_id'; data_source_id: string; database_id?: string }
  | { type: 'block_id'; block_id: string }
  | { type: 'workspace'; workspace: true };

/** A property value on a page (a row), keyed by property name. `id` is the property's id in its data source. */
export interface NotionPropertyValue {
  id: string;
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  number?: number | null;
  checkbox?: boolean;
  date?: { start: string; end?: string | null } | null;
  url?: string | null;
  relation?: Array<{ id: string }>;
  has_more?: boolean;
}

export interface NotionPage {
  object: 'page';
  id: string;
  created_time: string;
  last_edited_time: string;
  created_by: NotionUserRef;
  last_edited_by: NotionUserRef;
  parent: NotionParent;
  in_trash: boolean;
  properties: Record<string, NotionPropertyValue>;
  url: string;
  public_url?: string | null;
}

/** A property's schema in a data source (create, update, retrieve). On create or update only the type's key is sent. */
export interface NotionPropertySchema {
  id?: string;
  name?: string;
  type?: string;
  title?: Record<string, never>;
  rich_text?: Record<string, never>;
  number?: { format?: string };
  select?: { options: Array<{ name: string; color?: string }> };
  multi_select?: { options: Array<{ name: string; color?: string }> };
  checkbox?: Record<string, never>;
  date?: Record<string, never>;
  url?: Record<string, never>;
  relation?: { data_source_id: string; type: 'single_property'; single_property: Record<string, never> };
}

export interface NotionDatabase {
  object: 'database';
  id: string;
  title: NotionRichText[];
  parent: NotionParent;
  in_trash: boolean;
  is_inline: boolean;
  data_sources: Array<{ id: string; name: string }>;
  url: string;
  created_time: string;
  last_edited_time: string;
}

export interface NotionDataSource {
  object: 'data_source';
  id: string;
  title: NotionRichText[];
  parent: { type: 'database_id'; database_id: string };
  properties: Record<string, NotionPropertySchema & { id: string; name: string; type: string }>;
  in_trash: boolean;
  last_edited_time: string;
}

/** `GET /v1/pages/:id/markdown` and `PATCH …/markdown` (object `page_markdown`). */
export interface NotionPageMarkdown {
  object: 'page_markdown';
  id: string;
  markdown: string;
  truncated: boolean;
  unknown_block_ids: string[];
  warnings?: Array<{ code: 'no_match' | 'unsupported_tag' | 'indentation_mismatch' | string; message: string }>;
}

/** The body of `PATCH /v1/pages/:id/markdown` (the client adds `markdown_version: "v2"`). */
export type NotionMarkdownUpdate =
  | { type: 'update_content'; update_content: { content_updates: Array<{ old_str: string; new_str: string; replace_all_matches?: boolean }>; allow_deleting_content?: boolean } }
  | { type: 'replace_content'; replace_content: { new_str: string; allow_deleting_content?: boolean } };

/** A child of a page (`GET /v1/blocks/:id/children`): the walk reads only `child_page` and `child_database`. */
export interface NotionBlock {
  object: 'block';
  id: string;
  type: string;
  has_children: boolean;
  in_trash: boolean;
  last_edited_time: string;
  parent: NotionParent;
  child_page?: { title: string };
  child_database?: { title: string };
}

export interface NotionList<T> {
  object: 'list';
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
  type?: string;
  /** Data source queries: `incomplete` when the query was capped (10,000 results); read it on every page. */
  request_status?: { type: 'complete' } | { type: 'incomplete'; incomplete_reason: 'query_result_limit_reached' | string };
}

/** `POST /v1/data_sources/:id/query`'s body (the subset the sync sends). */
export interface NotionQuery {
  filter?: Record<string, unknown>;
  sorts?: Array<{ timestamp: 'last_edited_time' | 'created_time'; direction: 'ascending' | 'descending' } | { property: string; direction: 'ascending' | 'descending' }>;
  start_cursor?: string;
  page_size?: number;
}

// ---------------------------------------------------------------------------------------------------- errors

/**
 * Why a call failed. `rateLimited` (429 and 529 after the client's own waits), `blocked` (429
 * `public_api_request_blocked`: never retried), `unavailable` (500, 503, 504 after backoff), `conflict` (409), `invalid`
 * (400, `validation_error` included), `unauthorized` (401), `forbidden` (403), `notFound` (404), `network` (no answer),
 * `outsideRoot` (the scoped writer refused it before sending).
 */
export type NotionErrorKind = 'rateLimited' | 'blocked' | 'unavailable' | 'conflict' | 'invalid' | 'unauthorized' | 'forbidden' | 'notFound' | 'network' | 'outsideRoot';

/** What every error the client throws carries (NB02's NotionError implements it). Its message never holds a key or page text. */
export interface NotionErrorInfo extends Error {
  readonly kind: NotionErrorKind;
  /** HTTP status; 0 when there was no answer or the call was refused before sending. */
  readonly status: number;
  /** Notion's `code` (`validation_error`, `object_not_found`, `rate_limited`, …), when it answered one. */
  readonly code?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** A 503 on a write: it may have been applied, so re-read before retrying. */
  readonly mayHaveLanded?: boolean;
}

export const isNotionError = (error: unknown): error is NotionErrorInfo =>
  error instanceof Error && typeof (error as Partial<NotionErrorInfo>).kind === 'string' && typeof (error as Partial<NotionErrorInfo>).status === 'number';

// ---------------------------------------------------------------------------------------------------- the client

export interface NotionClientOptions {
  /** A credential of type `productivity.notionApi` (field `apiKey`) or `productivity.notionOAuth2Api` (`accessToken`). */
  credentialId: string;
  /** Requests a second for this credential (2 by default, at most 8): the limiter takes the highest of a key's links. */
  rps?: number;
  /** Tests: a fetch to use instead of the guarded one, a clock and a sleep. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The calls the brain makes. The key is read from the vault right before each call and kept nowhere else; `baseUrl` on the
 * credential (default https://api.notion.com) is honoured, which is how tests reach the fake. Every request carries
 * `Notion-Version: 2026-03-11`; every Markdown call `markdown_version: "v2"`. Failures throw `NotionErrorInfo`.
 */
export interface NotionClient {
  me(): Promise<NotionUser>;
  page(id: string): Promise<NotionPage>;
  /** Follows `unknown_block_ids` (up to 20 more reads); `truncated` stays true when Notion cut it or the cap was reached. */
  pageMarkdown(id: string): Promise<NotionPageMarkdown>;
  createPage(input: { parent: { page_id: string } | { data_source_id: string }; properties?: Record<string, unknown>; markdown?: string }): Promise<NotionPage>;
  updatePage(id: string, input: { properties?: Record<string, unknown>; in_trash?: boolean }): Promise<NotionPage>;
  updateMarkdown(id: string, update: NotionMarkdownUpdate): Promise<NotionPageMarkdown>;
  /** Creates the database with its one data source, then reads the data source for the property ids. */
  createDatabase(input: { parent: { page_id: string }; title: string; properties: Record<string, NotionPropertySchema> }): Promise<{ databaseId: string; dataSourceId: string; propertyIds: Record<string, string>; url: string }>;
  database(id: string): Promise<NotionDatabase>;
  dataSource(id: string): Promise<NotionDataSource>;
  updateDataSource(id: string, input: { properties: Record<string, NotionPropertySchema | null> }): Promise<NotionDataSource>;
  queryDataSource(id: string, query: NotionQuery): Promise<NotionList<NotionPage>>;
  children(blockId: string, cursor?: string): Promise<NotionList<NotionBlock>>;
  /** Every item of a list call, following `next_cursor` while `has_more` (never by counting items). */
  paginate<T>(call: (cursor: string | undefined) => Promise<NotionList<T>>): AsyncGenerator<T>;
}

export type NotionClientFactory = (options: NotionClientOptions) => NotionClient;

const slot = () => singleton('notion-client', () => ({ factory: undefined as NotionClientFactory | undefined }));

/** client.ts registers the real factory when it loads; a test may set a stub (load the real module first). */
export function setNotionClientFactory(factory: NotionClientFactory | undefined): void {
  slot().factory = factory;
}

/** A client for one credential. Throws when the client module is not loaded (lib/server/runtime.ts imports it). */
export function notionClientFor(options: NotionClientOptions): NotionClient {
  const factory = slot().factory;
  if (!factory) throw new Error('The Notion client is not loaded: import lib/server/notion/client');
  return factory(options);
}
