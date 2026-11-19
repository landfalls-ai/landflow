/**
 * A fake Notion API (Notion-Version 2026-03-11, Markdown v2) on a local port: the only Notion any test of the Notion brain
 * talks to (docs/features/notion-brain.md; never api.notion.com, never a real key). It keeps pages with parents and an
 * in-trash flag, databases with one data source and property ids, rows, `last_edited_time` (rounded to the minute like
 * Notion's, unless `editTimes: 'exact'`) and `last_edited_by` (the bot, or a person through `editAsPerson`), and page bodies
 * as Markdown (HTML comments kept; child pages and databases shown as `<page url="…">title</page>` and
 * `<database url="…">title</database>` lines after the body).
 *
 * Endpoints: GET /v1/users/me, GET /v1/users/:id, GET|PATCH /v1/pages/:id, POST /v1/pages, GET|PATCH /v1/pages/:id/markdown,
 * POST /v1/databases, GET /v1/databases/:id, GET|PATCH /v1/data_sources/:id, POST /v1/data_sources/:id/query,
 * GET /v1/blocks/:id/children, and POST /v1/search (answered empty and logged, so a test can assert the sync never searches).
 * Every request needs `Notion-Version` (400 `missing_version`) and the bearer token (401 `unauthorized`); a page the bot was
 * not shared (no shared ancestor) is 404 `object_not_found`. `update_content` matches each `old_str` exactly once (none
 * matching: 400 `validation_error`; some: `warnings` with `no_match`); `replace_content` that drops a child page or database
 * needs `allow_deleting_content` (else 400). Rich text over 2,000 characters a run or 100 runs, relations over 100, a body
 * over 5,000 blocks or a request over 500 KB: 400. Queries filter on `last_edited_time` and on rich text / title `equals`,
 * page through `start_cursor`, and past `queryCap` answer `request_status: incomplete`. `setRateLimit` and `failNext` script
 * 429 (with `Retry-After`), 529, 500, 503, 504, 401, 403, 404 and 409.
 *
 * Written by the plan for the Notion brain program, wave nb1: NB02 owns it (backbone/contracts/nb/fake-notion.ts) as
 * apps/web/test/fake-notion.ts; NB03–NB08 and the join tests copy it byte for byte. Self-contained: node built-ins only.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_NOTION_VERSION = '2026-03-11';
export const FAKE_NOTION_TOKEN = 'ntn_fake_test_key_0000000000000000000000000000';

type Json = Record<string, unknown>;

export interface FakeRichText {
  type: 'text';
  text: { content: string; link: { url: string } | null };
  plain_text: string;
  href: string | null;
  annotations: Json;
}

export interface FakeProperty {
  id: string;
  name: string;
  type: string;
  config: Json;
}

export interface FakePage {
  id: string;
  /** `page_id` (a page), `data_source_id` (a row) or `workspace` (a top-level page). */
  parent: { type: 'page_id'; page_id: string } | { type: 'data_source_id'; data_source_id: string; database_id: string } | { type: 'workspace'; workspace: true };
  title: string;
  /** A row's property values in API form, keyed by name (each with its id and type). */
  properties: Record<string, Json>;
  markdown: string;
  inTrash: boolean;
  createdTime: string;
  lastEditedTime: string;
  createdBy: string;
  lastEditedBy: string;
  /** Shared with the connection (Add connections); access covers every child. */
  shared: boolean;
  /** Pieces the markdown read could not load, by block id (read with GET /v1/pages/:blockId/markdown). */
  unknownBlocks: Record<string, string>;
}

export interface FakeDatabase {
  id: string;
  parentPageId: string;
  title: string;
  dataSourceId: string;
  /** By property name. */
  properties: Record<string, FakeProperty>;
  inTrash: boolean;
  createdTime: string;
  lastEditedTime: string;
}

export interface FakeRequest {
  method: string;
  /** The path with ids, e.g. `/v1/pages/0f…/markdown`. */
  path: string;
  /** The path with `:id` in place of ids, e.g. `/v1/pages/:id/markdown`. */
  template: string;
  query: Record<string, string>;
  body?: Json;
  status: number;
  at: number;
}

export interface FakeNotionState {
  pages: Map<string, FakePage>;
  databases: Map<string, FakeDatabase>;
  /** Data source id → database id. */
  dataSources: Map<string, string>;
  /** Every request, answered or refused. */
  requests: FakeRequest[];
  bot: { id: string; name: string; workspaceName: string };
  /** Person users by id (`editAsPerson` names one). Emails are returned only when `userEmails` is on. */
  people: Map<string, { name: string; email: string }>;
}

export interface FakeFailure {
  status: number;
  code?: string;
  message?: string;
  /** Seconds, sent as `Retry-After` (429 and 529). */
  retryAfter?: number;
  /** Also sent as `additional_data.retry_after`. */
  additionalRetryAfter?: number;
  /** Only requests this matches (default: any). */
  match?: (method: string, template: string) => boolean;
}

export interface FakeNotionOptions {
  token?: string;
  botName?: string;
  workspaceName?: string;
  /** Rows a data source query returns at most before it says `incomplete` (Notion: 10,000). */
  queryCap?: number;
  /** Blocks a markdown read returns before `truncated` (Notion: about 20,000). */
  markdownBlockCap?: number;
  /** `minute` (default): edit times rounded down to the minute, as Notion's are. `exact`: milliseconds. */
  editTimes?: 'minute' | 'exact';
  /** Answer person users' email (the connection's "user information with email" capability). Default off. */
  userEmails?: boolean;
  /** The clock (default Date.now). */
  now?: () => number;
}

export interface PersonEdit {
  /** API-form property values by name (`{ Description: { rich_text: [{ text: { content: 'x' } }] } }`). */
  properties?: Record<string, unknown>;
  /** The whole new body. */
  markdown?: string;
  /** A page's (not a row's) title. */
  title?: string;
  /** The person (a user id from `addPerson`); default: the first person, made on demand. */
  by?: string;
}

export interface FakeNotion {
  url: string;
  token: string;
  state: FakeNotionState;
  /** Make a page as a person: under `parentId` (a page) or at the workspace's top level; `shared` makes it a root the bot can see. */
  addPage(input: { parentId?: string; title: string; markdown?: string; shared?: boolean; by?: string }): string;
  /** A row a person adds to a database (API-form properties by name). */
  addRow(databaseId: string, properties: Record<string, unknown>, markdown?: string, by?: string): string;
  addPerson(name: string, email: string): string;
  /** Share a page with the connection (••• → Add connections), or stop sharing it. */
  share(pageId: string, shared?: boolean): void;
  /** The next `count` requests answer 429 `rate_limited` with `Retry-After: retryAfter` seconds. */
  setRateLimit(count: number, retryAfter?: number): void;
  /** The next matching request (or `times` of them) fails as given. */
  failNext(failure: FakeFailure, times?: number): void;
  editAsPerson(id: string, edit: PersonEdit): void;
  /** Move a page or row to trash as a person. */
  trash(id: string): void;
  /** Remove a property from a database as a person (a schema change). */
  removeProperty(databaseId: string, name: string): void;
  /** Make the markdown read of `pageId` report `blocks` as unknown block ids (each read alone afterwards). */
  setUnknownBlocks(pageId: string, blocks: Record<string, string>): void;
  /** Requests that changed something (every POST and PATCH except queries and search). */
  writes(): FakeRequest[];
  /** A page's body as stored (without the child lines). */
  body(id: string): string | undefined;
  /** A row's plain value of a property (title, rich text, select, number, checkbox, date, url, relation ids joined). */
  value(id: string, property: string): string | undefined;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------- helpers

class Refusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message: string) => new Refusal(400, 'validation_error', message);
const notFound = (id: string) => new Refusal(404, 'object_not_found', `Could not find object with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`);

const compact = (id: string) => id.replace(/-/g, '').toLowerCase();
const sameId = (a: string, b: string) => compact(a) === compact(b);
const dashed = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const ID_IN_PATH = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const newId = () => randomUUID();
const propertyId = () => Math.random().toString(36).slice(2, 6);
const slug = (title: string) => title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'Untitled';
const pageUrl = (title: string, id: string) => `https://www.notion.so/${slug(title)}-${compact(id)}`;
const blocksOf = (markdown: string) => markdown.split('\n').filter((line) => line.trim()).length;

function richText(input: unknown, label: string): FakeRichText[] {
  if (!Array.isArray(input)) throw invalid(`${label} should be an array of rich text`);
  if (input.length > 100) throw invalid(`${label}.length should be ≤ 100, instead was ${input.length}`);
  return input.map((item, i) => {
    const run = item as { text?: { content?: unknown; link?: { url?: unknown } | null }; mention?: unknown };
    const content = typeof run.text?.content === 'string' ? run.text.content : run.mention ? '@mention' : undefined;
    if (content === undefined) throw invalid(`${label}[${i}].text.content should be defined`);
    if (content.length > 2000) throw invalid(`${label}[${i}].text.content.length should be ≤ 2000, instead was ${content.length}`);
    const link = typeof run.text?.link?.url === 'string' ? { url: run.text.link.url } : null;
    return { type: 'text', text: { content, link }, plain_text: content, href: link?.url ?? null, annotations: {} };
  });
}

const plain = (runs: unknown): string => (Array.isArray(runs) ? runs.map((r) => String((r as { plain_text?: unknown }).plain_text ?? '')).join('') : '');

/** Validate an API-form value against the property and return the stored value (with id and type). */
function propertyValue(property: FakeProperty, input: unknown): Json {
  const value = (input ?? {}) as Record<string, unknown>;
  const label = `body.properties.${property.name}`;
  const base = { id: property.id, type: property.type };
  switch (property.type) {
    case 'title':
    case 'rich_text':
      return { ...base, [property.type]: richText(value[property.type] ?? [], `${label}.${property.type}`) };
    case 'select': {
      const name = (value.select as { name?: unknown } | null)?.name;
      return { ...base, select: typeof name === 'string' ? { name } : null };
    }
    case 'multi_select': {
      const items = Array.isArray(value.multi_select) ? value.multi_select : [];
      if (items.length > 100) throw invalid(`${label}.multi_select.length should be ≤ 100`);
      return { ...base, multi_select: items.map((o) => ({ name: String((o as { name?: unknown }).name ?? '') })) };
    }
    case 'number':
      return { ...base, number: typeof value.number === 'number' ? value.number : null };
    case 'checkbox':
      return { ...base, checkbox: Boolean(value.checkbox) };
    case 'date': {
      const start = (value.date as { start?: unknown } | null)?.start;
      return { ...base, date: typeof start === 'string' ? { start, end: null } : null };
    }
    case 'url':
      return { ...base, url: typeof value.url === 'string' ? value.url : null };
    case 'relation': {
      const items = Array.isArray(value.relation) ? value.relation : [];
      if (items.length > 100) throw invalid(`${label}.relation.length should be ≤ 100, instead was ${items.length}`);
      return { ...base, relation: items.map((r) => ({ id: String((r as { id?: unknown }).id ?? '') })), has_more: false };
    }
    default:
      throw invalid(`${label}: unsupported property type ${property.type}`);
  }
}

function emptyValue(property: FakeProperty): Json {
  return propertyValue(property, property.type === 'select' ? { select: null } : property.type === 'number' ? { number: null } : property.type === 'date' ? { date: null } : property.type === 'url' ? { url: null } : {});
}

function plainValue(value: Json | undefined): string | undefined {
  if (!value) return undefined;
  switch (value.type) {
    case 'title':
    case 'rich_text':
      return plain(value[value.type as string]);
    case 'select':
      return (value.select as { name: string } | null)?.name;
    case 'multi_select':
      return (value.multi_select as Array<{ name: string }>).map((o) => o.name).join(', ');
    case 'number':
      return value.number === null ? undefined : String(value.number);
    case 'checkbox':
      return String(value.checkbox);
    case 'date':
      return (value.date as { start: string } | null)?.start;
    case 'url':
      return (value.url as string | null) ?? undefined;
    case 'relation':
      return (value.relation as Array<{ id: string }>).map((r) => r.id).join(',');
    default:
      return undefined;
  }
}

/** A property's schema from a create or update body (`{ "rich_text": {} }`, `{ "select": { "options": [...] } }`, …). */
function schemaOf(name: string, input: unknown, existing?: FakeProperty): FakeProperty {
  const spec = (input ?? {}) as Record<string, unknown>;
  const types = ['title', 'rich_text', 'number', 'select', 'multi_select', 'checkbox', 'date', 'url', 'relation'];
  const type = (typeof spec.type === 'string' ? spec.type : types.find((t) => t in spec)) ?? existing?.type;
  if (!type || !types.includes(type)) throw invalid(`body.properties.${name} should define one of ${types.join(', ')}`);
  const config = (spec[type] ?? {}) as Json;
  if (type === 'relation' && typeof config.data_source_id !== 'string') throw invalid(`body.properties.${name}.relation.data_source_id should be defined`);
  return { id: existing?.id ?? (type === 'title' ? 'title' : propertyId()), name: typeof spec.name === 'string' ? spec.name : name, type, config };
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

// ---------------------------------------------------------------------------------------------------- the server

export async function startFakeNotion(options: FakeNotionOptions = {}): Promise<FakeNotion> {
  const token = options.token ?? FAKE_NOTION_TOKEN;
  const now = options.now ?? Date.now;
  const queryCap = options.queryCap ?? 10_000;
  const blockCap = options.markdownBlockCap ?? 20_000;
  const stamp = () => {
    const ms = now();
    return new Date(options.editTimes === 'exact' ? ms : ms - (ms % 60_000)).toISOString();
  };
  const state: FakeNotionState = {
    pages: new Map(),
    databases: new Map(),
    dataSources: new Map(),
    requests: [],
    bot: { id: newId(), name: options.botName ?? 'Landflow test', workspaceName: options.workspaceName ?? 'Acme test workspace' },
    people: new Map(),
  };
  let rateLimited: { count: number; retryAfter: number } = { count: 0, retryAfter: 1 };
  const failures: Array<FakeFailure & { times: number }> = [];

  const firstPerson = () => {
    const found = state.people.keys().next();
    return found.done ? addPerson('Ada Lovelace', 'ada@example.test') : found.value;
  };
  function addPerson(name: string, email: string): string {
    const id = newId();
    state.people.set(id, { name, email });
    return id;
  }

  const findPage = (id: string) => state.pages.get(dashed(compact(id)));
  const findDatabase = (id: string) => state.databases.get(dashed(compact(id)));
  const databaseOfSource = (id: string) => {
    const databaseId = state.dataSources.get(dashed(compact(id)));
    return databaseId ? state.databases.get(databaseId) : undefined;
  };

  /** The page or database id an object hangs from. */
  const parentOf = (id: string): string | undefined => {
    const page = state.pages.get(id);
    if (page) return page.parent.type === 'page_id' ? page.parent.page_id : page.parent.type === 'data_source_id' ? page.parent.database_id : undefined;
    return state.databases.get(id)?.parentPageId;
  };
  /** The bot sees an object when it or an ancestor page is shared. */
  const visible = (id: string): boolean => {
    for (let at: string | undefined = id, depth = 0; at && depth < 64; at = parentOf(at), depth++) if (state.pages.get(at)?.shared) return true;
    return false;
  };
  const pageOrRefuse = (id: string) => {
    const page = findPage(id);
    if (!page || !visible(page.id)) throw notFound(id);
    return page;
  };
  const databaseOrRefuse = (id: string) => {
    const database = findDatabase(id);
    if (!database || !visible(database.id)) throw notFound(id);
    return database;
  };
  const sourceOrRefuse = (id: string) => {
    const database = databaseOfSource(id);
    if (!database || !visible(database.id)) throw notFound(id);
    return database;
  };

  const touch = (page: FakePage, by: string) => {
    page.lastEditedTime = stamp();
    page.lastEditedBy = by;
  };

  const children = (id: string) => [
    ...[...state.pages.values()].filter((p) => p.parent.type === 'page_id' && p.parent.page_id === id),
    ...[...state.databases.values()].filter((d) => d.parentPageId === id),
  ];
  const childLines = (id: string) =>
    children(id)
      .filter((child) => !child.inTrash)
      .map((child) => ('dataSourceId' in child ? `<database url="${pageUrl(child.title, child.id)}">${child.title}</database>` : `<page url="${pageUrl(child.title, child.id)}">${child.title}</page>`));
  const fullMarkdown = (page: FakePage) => [page.markdown, ...childLines(page.id)].filter((part) => part !== '').join('\n');

  const pageJson = (page: FakePage): Json => ({
    object: 'page',
    id: page.id,
    created_time: page.createdTime,
    last_edited_time: page.lastEditedTime,
    created_by: { object: 'user', id: page.createdBy },
    last_edited_by: { object: 'user', id: page.lastEditedBy },
    cover: null,
    icon: null,
    parent: page.parent,
    in_trash: page.inTrash,
    is_archived: page.inTrash,
    properties:
      page.parent.type === 'data_source_id'
        ? page.properties
        : { title: { id: 'title', type: 'title', title: [{ type: 'text', text: { content: page.title, link: null }, plain_text: page.title, href: null, annotations: {} }] } },
    url: pageUrl(page.title, page.id),
    public_url: null,
  });
  const titleRuns = (title: string) => [{ type: 'text', text: { content: title, link: null }, plain_text: title, href: null, annotations: {} }];
  const propertiesJson = (database: FakeDatabase) =>
    Object.fromEntries(Object.values(database.properties).map((p) => [p.name, { id: p.id, name: p.name, type: p.type, [p.type]: p.config }]));
  const databaseJson = (database: FakeDatabase): Json => ({
    object: 'database',
    id: database.id,
    title: titleRuns(database.title),
    description: [],
    parent: { type: 'page_id', page_id: database.parentPageId },
    is_inline: false,
    in_trash: database.inTrash,
    is_locked: false,
    data_sources: [{ id: database.dataSourceId, name: database.title }],
    created_time: database.createdTime,
    last_edited_time: database.lastEditedTime,
    icon: null,
    cover: null,
    url: pageUrl(database.title, database.id),
    public_url: null,
  });
  const dataSourceJson = (database: FakeDatabase): Json => ({
    object: 'data_source',
    id: database.dataSourceId,
    title: titleRuns(database.title),
    parent: { type: 'database_id', database_id: database.id },
    database_parent: { type: 'page_id', page_id: database.parentPageId },
    properties: propertiesJson(database),
    in_trash: database.inTrash,
    created_time: database.createdTime,
    last_edited_time: database.lastEditedTime,
  });
  const markdownJson = (page: FakePage, markdown: string, warnings?: Json[]): Json => {
    const lines = markdown.split('\n');
    let kept = 0;
    const cut: string[] = [];
    for (const line of lines) {
      if (line.trim()) kept++;
      if (kept > blockCap) break;
      cut.push(line);
    }
    const unknown = Object.keys(page.unknownBlocks);
    return { object: 'page_markdown', id: page.id, markdown: cut.join('\n'), truncated: kept > blockCap, unknown_block_ids: unknown.slice(0, 100), ...(warnings?.length && { warnings }) };
  };

  const setRowProperties = (page: FakePage, database: FakeDatabase, input: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(input)) {
      const property = database.properties[name] ?? Object.values(database.properties).find((p) => p.id === name);
      if (!property) throw invalid(`${name} is not a property that exists.`);
      page.properties[property.name] = propertyValue(property, value);
      if (property.type === 'title') page.title = plain((page.properties[property.name] as Json).title);
    }
  };
  const markdownVersion = (value: unknown) => {
    if (value !== undefined && value !== 'v1' && value !== 'v2') throw invalid('markdown_version should be "v1" or "v2"');
  };

  function createPage(body: Json, by: string): FakePage {
    const parent = (body.parent ?? {}) as Record<string, unknown>;
    const markdown = typeof body.markdown === 'string' ? body.markdown : undefined;
    markdownVersion(body.markdown_version);
    if (body.markdown_version !== undefined && markdown === undefined) throw invalid('markdown_version needs markdown');
    if (markdown !== undefined && (body.children !== undefined || body.content !== undefined)) throw invalid('markdown cannot be combined with children or content');
    if (markdown !== undefined && blocksOf(markdown) > 5000) throw invalid('The markdown would create more than 5000 blocks.');
    const at = stamp();
    const page: FakePage = { id: newId(), parent: { type: 'workspace', workspace: true }, title: 'Untitled', properties: {}, markdown: markdown ?? '', inTrash: false, createdTime: at, lastEditedTime: at, createdBy: by, lastEditedBy: by, shared: false, unknownBlocks: {} };
    const properties = (body.properties ?? {}) as Record<string, unknown>;
    if (typeof parent.data_source_id === 'string') {
      const database = sourceOrRefuse(parent.data_source_id);
      page.parent = { type: 'data_source_id', data_source_id: database.dataSourceId, database_id: database.id };
      for (const property of Object.values(database.properties)) page.properties[property.name] = emptyValue(property);
      setRowProperties(page, database, properties);
    } else if (typeof parent.page_id === 'string') {
      const above = pageOrRefuse(parent.page_id);
      page.parent = { type: 'page_id', page_id: above.id };
      const title = properties.title as { title?: unknown } | unknown[] | undefined;
      const heading = markdown?.match(/^# (.+)$/m)?.[1];
      page.title = title ? plain(richText(Array.isArray(title) ? title : (title.title ?? []), 'body.properties.title.title')) : (heading ?? 'Untitled');
      if (!title && heading) page.markdown = page.markdown.replace(/^# .+\n?/m, '');
    } else {
      throw invalid('body.parent should be { page_id } or { data_source_id }');
    }
    state.pages.set(page.id, page);
    return page;
  }

  function updateMarkdown(page: FakePage, body: Json, by: string): Json {
    markdownVersion(body.markdown_version);
    const kids = childLines(page.id);
    if (body.type === 'replace_content') {
      const command = (body.replace_content ?? {}) as { new_str?: unknown; allow_deleting_content?: unknown };
      if (typeof command.new_str !== 'string') throw invalid('replace_content.new_str should be a string');
      const next = command.new_str;
      const dropped = kids.filter((line) => !next.includes(line.match(/url="([^"]+)"/)![1]));
      if (dropped.length && command.allow_deleting_content !== true) throw invalid('The update would delete child pages or databases; set allow_deleting_content to true.');
      for (const line of dropped) {
        const url = line.match(/url="([^"]+)"/)![1];
        for (const child of children(page.id)) if (pageUrl(child.title, child.id) === url) child.inTrash = true;
      }
      if (blocksOf(next) > 5000) throw invalid('The markdown would create more than 5000 blocks.');
      page.markdown = next.split('\n').filter((line) => !/^<(page|database) url="/.test(line)).join('\n');
      touch(page, by);
      return markdownJson(page, fullMarkdown(page));
    }
    if (body.type === 'update_content') {
      const command = (body.update_content ?? {}) as { content_updates?: unknown; allow_deleting_content?: unknown };
      const updates = Array.isArray(command.content_updates) ? (command.content_updates as Array<{ old_str?: unknown; new_str?: unknown; replace_all_matches?: unknown }>) : [];
      if (!updates.length || updates.length > 100) throw invalid('update_content.content_updates should have 1 to 100 items');
      let text = page.markdown;
      const warnings: Json[] = [];
      let matched = 0;
      for (const [i, update] of updates.entries()) {
        if (typeof update.old_str !== 'string' || !update.old_str) throw invalid(`content_updates[${i}].old_str should be a non-empty string`);
        if (typeof update.new_str !== 'string') throw invalid(`content_updates[${i}].new_str should be a string`);
        const count = text.split(update.old_str).length - 1;
        if (count === 0) {
          warnings.push({ code: 'no_match', message: `content_updates[${i}].old_str was not found` });
          continue;
        }
        if (count > 1 && update.replace_all_matches !== true) throw invalid(`content_updates[${i}].old_str matches ${count} places; set replace_all_matches`);
        text = update.replace_all_matches === true ? text.split(update.old_str).join(update.new_str) : text.replace(update.old_str, () => update.new_str as string);
        matched++;
      }
      if (!matched) throw invalid('No content_updates matched the page content.');
      if (blocksOf(text) > 5000) throw invalid('The markdown would create more than 5000 blocks.');
      page.markdown = text;
      touch(page, by);
      return markdownJson(page, fullMarkdown(page), warnings);
    }
    throw invalid('type should be update_content or replace_content');
  }

  type Handler = (ids: string[], body: Json, query: Record<string, string>) => Json;
  const bot = () => state.bot.id;
  const routes: Array<{ method: string; template: string; handle: Handler }> = [
    { method: 'GET', template: '/v1/users/me', handle: () => ({ object: 'user', id: state.bot.id, type: 'bot', name: state.bot.name, avatar_url: null, bot: { owner: { type: 'workspace', workspace: true }, workspace_name: state.bot.workspaceName } }) },
    {
      method: 'GET',
      template: '/v1/users/:id',
      handle: ([id]) => {
        if (sameId(id, state.bot.id)) return { object: 'user', id: state.bot.id, type: 'bot', name: state.bot.name };
        const person = [...state.people].find(([key]) => sameId(key, id));
        if (!person) throw notFound(id);
        return { object: 'user', id: person[0], type: 'person', name: person[1].name, avatar_url: null, person: options.userEmails ? { email: person[1].email } : {} };
      },
    },
    { method: 'POST', template: '/v1/pages', handle: (_ids, body) => pageJson(createPage(body, bot())) },
    { method: 'GET', template: '/v1/pages/:id', handle: ([id]) => pageJson(pageOrRefuse(id)) },
    {
      method: 'PATCH',
      template: '/v1/pages/:id',
      handle: ([id], body) => {
        const page = pageOrRefuse(id);
        if (body.properties) {
          if (page.parent.type !== 'data_source_id') {
            const title = (body.properties as Record<string, { title?: unknown }>).title;
            if (title) page.title = plain(richText(title.title ?? [], 'body.properties.title.title'));
          } else {
            setRowProperties(page, sourceOrRefuse(page.parent.data_source_id), body.properties as Record<string, unknown>);
          }
        }
        if (typeof body.in_trash === 'boolean') page.inTrash = body.in_trash;
        touch(page, bot());
        return pageJson(page);
      },
    },
    {
      method: 'GET',
      template: '/v1/pages/:id/markdown',
      handle: ([id], _body, query) => {
        markdownVersion(query.markdown_version);
        const owner = [...state.pages.values()].find((p) => Object.keys(p.unknownBlocks).some((block) => sameId(block, id)));
        if (owner && visible(owner.id)) {
          const block = Object.keys(owner.unknownBlocks).find((key) => sameId(key, id))!;
          return { object: 'page_markdown', id: block, markdown: owner.unknownBlocks[block], truncated: false, unknown_block_ids: [] };
        }
        const page = pageOrRefuse(id);
        return markdownJson(page, fullMarkdown(page));
      },
    },
    { method: 'PATCH', template: '/v1/pages/:id/markdown', handle: ([id], body) => updateMarkdown(pageOrRefuse(id), body, bot()) },
    {
      method: 'POST',
      template: '/v1/databases',
      handle: (_ids, body) => {
        const parent = (body.parent ?? {}) as { page_id?: unknown };
        if (typeof parent.page_id !== 'string') throw invalid('body.parent.page_id should be defined');
        const above = pageOrRefuse(parent.page_id);
        const initial = ((body.initial_data_source ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
        const properties: Record<string, FakeProperty> = {};
        for (const [name, spec] of Object.entries(initial)) properties[name] = schemaOf(name, spec);
        if (!Object.values(properties).some((p) => p.type === 'title')) throw invalid('A data source needs one title property');
        const at = stamp();
        const database: FakeDatabase = { id: newId(), parentPageId: above.id, title: plain(richText(body.title ?? [], 'body.title')) || 'Untitled', dataSourceId: newId(), properties, inTrash: false, createdTime: at, lastEditedTime: at };
        state.databases.set(database.id, database);
        state.dataSources.set(database.dataSourceId, database.id);
        return databaseJson(database);
      },
    },
    { method: 'GET', template: '/v1/databases/:id', handle: ([id]) => databaseJson(databaseOrRefuse(id)) },
    { method: 'GET', template: '/v1/data_sources/:id', handle: ([id]) => dataSourceJson(sourceOrRefuse(id)) },
    {
      method: 'PATCH',
      template: '/v1/data_sources/:id',
      handle: ([id], body) => {
        const database = sourceOrRefuse(id);
        for (const [name, spec] of Object.entries((body.properties ?? {}) as Record<string, unknown>)) {
          const existing = database.properties[name] ?? Object.values(database.properties).find((p) => p.id === name);
          if (spec === null) {
            if (existing) delete database.properties[existing.name];
            continue;
          }
          const next = schemaOf(name, spec, existing);
          if (existing) delete database.properties[existing.name];
          database.properties[next.name] = next;
        }
        database.lastEditedTime = stamp();
        return dataSourceJson(database);
      },
    },
    {
      method: 'POST',
      template: '/v1/data_sources/:id/query',
      handle: ([id], body) => {
        const database = sourceOrRefuse(id);
        const size = Math.min(100, Math.max(1, Number(body.page_size ?? 100) || 100));
        const start = Number(body.start_cursor ?? 0) || 0;
        let rows = [...state.pages.values()].filter((p) => p.parent.type === 'data_source_id' && p.parent.database_id === database.id && !p.inTrash);
        rows = rows.filter((row) => matches(row, body.filter as Json | undefined));
        const sort = (Array.isArray(body.sorts) ? body.sorts[0] : undefined) as { timestamp?: string; direction?: string } | undefined;
        if (sort?.timestamp) {
          const key = sort.timestamp === 'created_time' ? 'createdTime' : 'lastEditedTime';
          rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (sort.direction === 'descending' ? -1 : 1));
        }
        const capped = rows.length > queryCap;
        const all = rows.slice(0, queryCap);
        const results = all.slice(start, start + size);
        const hasMore = start + size < all.length;
        return { object: 'list', type: 'page_or_data_source', page_or_data_source: {}, results: results.map(pageJson), next_cursor: hasMore ? String(start + size) : null, has_more: hasMore, request_status: capped ? { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' } : { type: 'complete' } };
      },
    },
    {
      method: 'GET',
      template: '/v1/blocks/:id/children',
      handle: ([id], _body, query) => {
        const page = pageOrRefuse(id);
        const size = Math.min(100, Math.max(1, Number(query.page_size ?? 100) || 100));
        const start = Number(query.start_cursor ?? 0) || 0;
        const blocks = children(page.id)
          .filter((child) => !child.inTrash)
          .map((child) => ({
            object: 'block',
            id: child.id,
            type: 'dataSourceId' in child ? 'child_database' : 'child_page',
            ['dataSourceId' in child ? 'child_database' : 'child_page']: { title: child.title },
            has_children: 'dataSourceId' in child ? false : children(child.id).length > 0,
            in_trash: child.inTrash,
            created_time: child.createdTime,
            last_edited_time: child.lastEditedTime,
            parent: { type: 'page_id', page_id: page.id },
          }));
        const results = blocks.slice(start, start + size);
        const hasMore = start + size < blocks.length;
        return { object: 'list', type: 'block', block: {}, results, next_cursor: hasMore ? String(start + size) : null, has_more: hasMore };
      },
    },
    { method: 'POST', template: '/v1/search', handle: () => ({ object: 'list', type: 'page_or_data_source', results: [], next_cursor: null, has_more: false }) },
  ];

  function matches(row: FakePage, filter: Json | undefined): boolean {
    if (!filter) return true;
    if (Array.isArray(filter.and)) return (filter.and as Json[]).every((f) => matches(row, f));
    if (Array.isArray(filter.or)) return (filter.or as Json[]).some((f) => matches(row, f));
    if (filter.timestamp === 'last_edited_time' || filter.timestamp === 'created_time') {
      const at = filter.timestamp === 'created_time' ? row.createdTime : row.lastEditedTime;
      const cond = (filter[filter.timestamp] ?? {}) as Record<string, string>;
      if (cond.on_or_after && at < new Date(cond.on_or_after).toISOString()) return false;
      if (cond.after && at <= new Date(cond.after).toISOString()) return false;
      if (cond.on_or_before && at > new Date(cond.on_or_before).toISOString()) return false;
      if (cond.before && at >= new Date(cond.before).toISOString()) return false;
      return true;
    }
    if (typeof filter.property === 'string') {
      const value = row.properties[filter.property] ?? Object.values(row.properties).find((v) => v.id === filter.property);
      const cond = (filter.rich_text ?? filter.title ?? {}) as Record<string, unknown>;
      if (typeof cond.equals === 'string') return plainValue(value) === cond.equals;
      if (cond.is_empty === true) return !plainValue(value);
      if (cond.is_not_empty === true) return Boolean(plainValue(value));
      throw invalid(`Unsupported filter on ${filter.property}`);
    }
    throw invalid('Unsupported filter');
  }

  function route(method: string, path: string): { handle: Handler; template: string; ids: string[] } | undefined {
    const parts = path.split('/').filter(Boolean);
    for (const candidate of routes) {
      if (candidate.method !== method) continue;
      const want = candidate.template.split('/').filter(Boolean);
      if (want.length !== parts.length) continue;
      const ids: string[] = [];
      const ok = want.every((segment, i) => {
        if (segment === ':id') {
          if (!ID_IN_PATH.test(parts[i])) return false;
          ids.push(dashed(compact(parts[i])));
          return true;
        }
        return segment === parts[i];
      });
      if (ok) return { handle: candidate.handle, template: candidate.template, ids };
    }
    return undefined;
  }

  const send = (response: ServerResponse, status: number, body: Json, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };
  const error = (status: number, code: string, message: string, extra: Json = {}) => ({ object: 'error', status, code, message, request_id: newId(), ...extra });

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake-notion.local');
    const method = (request.method ?? 'GET').toUpperCase();
    const query = Object.fromEntries(url.searchParams);
    const raw = await readBody(request);
    const found = route(method, url.pathname);
    const template = found?.template ?? url.pathname;
    const log: FakeRequest = { method, path: url.pathname, template, query, status: 0, at: now() };
    state.requests.push(log);
    const answer = (status: number, body: Json, headers?: Record<string, string>) => {
      log.status = status;
      send(response, status, body, headers);
    };
    let body: Json = {};
    if (raw) {
      try {
        body = JSON.parse(raw) as Json;
        log.body = body;
      } catch {
        return answer(400, error(400, 'invalid_json', 'Error parsing JSON body.'));
      }
    }
    if (request.headers['notion-version'] !== FAKE_NOTION_VERSION) {
      return answer(400, error(400, 'missing_version', `Notion-Version header should be "${FAKE_NOTION_VERSION}".`));
    }
    if (request.headers.authorization !== `Bearer ${token}`) return answer(401, error(401, 'unauthorized', 'API token is invalid.'));
    if (Buffer.byteLength(raw) > 500_000) return answer(400, error(400, 'validation_error', 'The request body is larger than 500KB.'));
    if (rateLimited.count > 0) {
      rateLimited.count--;
      return answer(429, error(429, 'rate_limited', 'You have been rate limited. Please try again in a few minutes.'), { 'retry-after': String(rateLimited.retryAfter) });
    }
    const failure = failures.find((f) => f.times > 0 && (!f.match || f.match(method, template)));
    if (failure) {
      failure.times--;
      if (!failure.times) failures.splice(failures.indexOf(failure), 1);
      const codes: Record<number, string> = { 400: 'validation_error', 401: 'unauthorized', 403: 'restricted_resource', 404: 'object_not_found', 409: 'conflict_error', 429: 'rate_limited', 500: 'internal_server_error', 503: 'service_unavailable', 504: 'gateway_timeout' };
      const headers: Record<string, string> = failure.retryAfter !== undefined ? { 'retry-after': String(failure.retryAfter) } : {};
      const extra: Json = failure.additionalRetryAfter !== undefined ? { additional_data: { retry_after: failure.additionalRetryAfter } } : {};
      return answer(failure.status, error(failure.status, failure.code ?? codes[failure.status] ?? 'internal_server_error', failure.message ?? 'Scripted failure.', extra), headers);
    }
    if (!found) return answer(400, error(400, 'invalid_request_url', 'Invalid request URL.'));
    try {
      answer(200, found.handle(found.ids, body, query));
    } catch (thrown) {
      if (thrown instanceof Refusal) return answer(thrown.status, error(thrown.status, thrown.code, thrown.message));
      answer(500, error(500, 'internal_server_error', thrown instanceof Error ? thrown.message : String(thrown)));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeNotion = {
    url: `http://127.0.0.1:${port}`,
    token,
    state,
    addPage({ parentId, title, markdown = '', shared = false, by }) {
      const person = by ?? firstPerson();
      const at = stamp();
      const parentPage = parentId ? findPage(parentId) : undefined;
      if (parentId && !parentPage) throw new Error(`fake-notion: no page ${parentId}`);
      const page: FakePage = { id: newId(), parent: parentPage ? { type: 'page_id', page_id: parentPage.id } : { type: 'workspace', workspace: true }, title, properties: {}, markdown, inTrash: false, createdTime: at, lastEditedTime: at, createdBy: person, lastEditedBy: person, shared, unknownBlocks: {} };
      state.pages.set(page.id, page);
      return page.id;
    },
    addRow(databaseId, properties, markdown = '', by) {
      const database = findDatabase(databaseId) ?? databaseOfSource(databaseId);
      if (!database) throw new Error(`fake-notion: no database ${databaseId}`);
      const page = createPage({ parent: { data_source_id: database.dataSourceId }, properties, ...(markdown && { markdown }) }, by ?? firstPerson());
      return page.id;
    },
    addPerson,
    share(pageId, shared = true) {
      const page = findPage(pageId);
      if (!page) throw new Error(`fake-notion: no page ${pageId}`);
      page.shared = shared;
    },
    setRateLimit(count, retryAfter = 1) {
      rateLimited = { count, retryAfter };
    },
    failNext(failure, times = 1) {
      failures.push({ ...failure, times });
    },
    editAsPerson(id, edit) {
      const page = findPage(id);
      if (!page) throw new Error(`fake-notion: no page ${id}`);
      const by = edit.by ?? firstPerson();
      if (edit.properties) {
        if (page.parent.type !== 'data_source_id') throw new Error('fake-notion: properties are a row’s');
        setRowProperties(page, databaseOfSource(page.parent.data_source_id)!, edit.properties);
      }
      if (edit.title !== undefined) page.title = edit.title;
      if (edit.markdown !== undefined) page.markdown = edit.markdown;
      touch(page, by);
    },
    trash(id) {
      const page = findPage(id);
      if (page) {
        page.inTrash = true;
        touch(page, firstPerson());
        return;
      }
      const database = findDatabase(id);
      if (!database) throw new Error(`fake-notion: no page or database ${id}`);
      database.inTrash = true;
    },
    removeProperty(databaseId, name) {
      const database = findDatabase(databaseId) ?? databaseOfSource(databaseId);
      if (!database?.properties[name]) throw new Error(`fake-notion: no property ${name}`);
      delete database.properties[name];
      database.lastEditedTime = stamp();
    },
    setUnknownBlocks(pageId, blocks) {
      const page = findPage(pageId);
      if (!page) throw new Error(`fake-notion: no page ${pageId}`);
      page.unknownBlocks = Object.fromEntries(Object.entries(blocks).map(([id, md]) => [dashed(compact(id)), md]));
    },
    writes: () => state.requests.filter((r) => (r.method === 'POST' || r.method === 'PATCH') && !r.template.endsWith('/query') && r.template !== '/v1/search'),
    body: (id) => findPage(id)?.markdown,
    value: (id, property) => plainValue(findPage(id)?.properties[property]),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  return fake;
}
