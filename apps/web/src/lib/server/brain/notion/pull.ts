/**
 * The Notion pull (docs/features/notion-brain.md#what-comes-back-from-notion): what people edit in the linked Notion pages comes
 * back to Landflow, each field by its owner's rule (plan.md §3). Registered with `setPullStep` when this module loads (runtime.ts).
 *
 * - Names, descriptions, owners and attributes of a page, "Your notes" (a knowledge doc), new pages, facts people add and notes for
 *   a team come back through `brainStoreFor(project)` with origin `notion` (tainted where Landflow has taint).
 * - A change to a practice's title, summary or body is a tainted draft that a person approves in Landflow. Status, Version and
 *   Handle are never pulled.
 * - What Landflow owns (the region of a page, Landflow's properties, a study fact's statement, a note) is put back: an explicit
 *   `enqueue`, because NB04's listener drops `notion`-origin changes.
 * - A trashed or moved row detaches its item (nothing local is deleted). A removed property is a problem, and a removed required
 *   one makes the link need a repair.
 *
 * The pull reads only under the link's data sources and rows (never Notion's search endpoint), through the link's read client; the only writes
 * it makes (the Landflow ID of a row a person added) go through `linkClient`. Logs carry ids, never page text.
 */
import { createHash } from 'node:crypto';
import { ATTR_NAME, FACT_KINDS, NOTION_EVIDENCE_LABEL, type BrainEntity, type FactKind } from '../../../shared/brain';
import type { BrainStore } from '../../../shared/brain-store';
import { DATABASES, DATABASE_KINDS, LANDFLOW_ID, NOTES_HEADING, type DatabaseKind, type PropertySpec } from '../../../shared/notion-brain';
import { NOTE_KINDS, type NoteKind } from '../../../shared/notebook';
import { PRACTICE_HANDLE, PRACTICE_STRENGTHS, type Practice, type PracticeStrength, type PracticeVersion } from '../../../shared/practices';
import { agentTeamStore } from '../../agent-teams/store';
import { findUserByEmail, getUser } from '../../auth/users';
import { credentials } from '../../credentials/vault';
import { database } from '../../db';
import { safeFetch } from '../../net/safe-fetch';
import { NOTION_VERSION, isNotionError, notionId, type NotionClient, type NotionPage, type NotionPropertyValue, type NotionRichText } from '../../notion/port';
import { PracticeError } from '../../practices/errors';
import { fileDraftSuggestion } from '../../practices/inbox';
import { cleanFields, draftPractice, getPractice, hashFields, versionsOf } from '../../practices/store';
import { noteStore } from '../../notebook/store';
import { homeProjectId } from '../../projects/store';
import { logger } from '../../telemetry/logger';
import { EntityError, entityKey, getEntity } from '../entities';
import { getFact, upsertFact } from '../facts';
import { getProposal, saveProposal } from '../proposals';
import { brainStoreFor } from '../store/port';
import { notionIsLater, recordOverwrite, regionConflict, statementConflict } from './conflicts';
import { addProblem, isStopped, linkById, notionBrainEnabled, problems, resolveProblem, setCursors, setStatus, updateLink, type LinkRow } from './links';
import './problems'; // registers the problem actions (setProblemActions)
import {
  enqueue,
  itemByNotionId,
  itemOf,
  itemsOf,
  linkClient,
  linkDatabases,
  markOwn,
  readClient,
  saveItem,
  setPullStep,
  setRegionConflict,
  splitBody,
  type ItemKind,
  type ItemRow,
  type LinkDatabase,
  type LinkDatabases,
} from './sync';

/** How often a link is pulled, how far back a window reaches past the cursor (edit times are coarse), and how often every row is listed (to find trashed ones). */
export const POLL_MS = 2 * 60_000;
export const OVERLAP_MS = 5 * 60_000;
export const SWEEP_MS = 15 * 60_000;
export const NOTES_LIMIT = 4_000;
const MINUTE = 60_000;
const DEFAULT_FACT_KIND: FactKind = 'purpose';
const KIND_OF_DATABASE: Readonly<Record<DatabaseKind, ItemKind>> = {
  pages: 'entity',
  facts: 'fact',
  practices: 'practice',
  notebook: 'note',
};

// ---------------------------------------------------------------------------------------------------- values

const plain = (runs: NotionRichText[] | undefined): string => (runs ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('');

/** A property's value as one string (what is compared and hashed). */
export function valueText(value: NotionPropertyValue | undefined): string {
  if (!value) return '';
  switch (value.type) {
    case 'title':
      return plain(value.title);
    case 'rich_text':
      return plain(value.rich_text);
    case 'select':
      return value.select?.name ?? '';
    case 'multi_select':
      return (value.multi_select ?? []).map((o) => o.name).join(', ');
    case 'number':
      return value.number === null || value.number === undefined ? '' : String(value.number);
    case 'checkbox':
      return value.checkbox ? 'true' : 'false';
    case 'date':
      return value.date?.start ?? '';
    case 'url':
      return value.url ?? '';
    case 'relation':
      return (value.relation ?? []).map((r) => r.id).join(',');
    default:
      return '';
  }
}

/** A row's property by name, found by its id in the data source first (a person may rename a property). */
function property(row: NotionPage, db: LinkDatabase | undefined, name: string): NotionPropertyValue | undefined {
  const id = db?.properties[name];
  return (id ? Object.values(row.properties).find((p) => p.id === id) : undefined) ?? row.properties[name];
}
const text = (row: NotionPage, db: LinkDatabase | undefined, name: string) => valueText(property(row, db, name));

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const normalize = (value: string) =>
  value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
/** The region text of what `pushed_region` holds (the region itself, or a body with the markers in it). */
const regionOf = (pushed: string): string => normalize(splitBody(pushed).region ?? pushed);

/** The two hashes of a row: what people own (compared with the last pull) and what Landflow owns (a change there is put back). */
interface RowHashes {
  person: string;
  landflow: string;
}
const baselineOf = (item: ItemRow | undefined): (Partial<RowHashes> & { applied?: string }) | undefined => {
  if (!item?.pulled_hash) return undefined;
  const [hashes, applied] = item.pulled_hash.split('|');
  const [person, landflow] = hashes.split('.');
  return { person, landflow, ...(applied && { applied }) };
};
/** pulled_hash: the two hashes, and (after "|") the local updatedAt right after the pull last applied a Notion value, so that write does not read as a Landflow edit. */
const pulledHash = (h: RowHashes, applied?: string) => `${h.person}.${h.landflow}${applied ? `|${applied}` : ''}`;
/** The later of the two baselines a local change must pass to count as a Landflow edit. */
const dirtyAfter = (item: ItemRow): string => {
  const applied = baselineOf(item)?.applied ?? '';
  const pushed = item.pushed_at ?? '';
  return applied > pushed ? applied : pushed;
};
const hashOf = (names: string[], row: NotionPage, db: LinkDatabase | undefined) => sha(JSON.stringify(names.map((n) => text(row, db, n)))).slice(0, 16);
const specs = (kind: DatabaseKind, owner: PropertySpec['owner'][]) => DATABASES[kind].properties.filter((p) => owner.includes(p.owner)).map((p) => p.name);

// ---------------------------------------------------------------------------------------------------- context

interface Context {
  link: LinkRow;
  client: NotionClient;
  dbs: LinkDatabases;
  store: BrainStore;
  botId?: string;
  /** Notion user id → the matched Landflow user (cached for the pass). */
  editors: Map<string, Promise<Editor>>;
}

interface Editor {
  /** The Landflow user the editor's email matched (only with the connection's "user information with email"). */
  userId?: string;
  name?: string;
}

/** The key and base URL of the link's credential, for the one call the client has no method for (`GET /v1/users/:id`). */
const USER_TTL_MS = 10 * 60_000;
const userCache = new Map<string, { at: number; email?: string }>();

async function userOf(link: LinkRow, id: string): Promise<{ email?: string } | undefined> {
  const cached = userCache.get(`${link.id}:${id}`);
  if (cached && Date.now() - cached.at < USER_TTL_MS) return cached;
  const found = await fetchUser(link, id);
  userCache.set(`${link.id}:${id}`, { at: Date.now(), ...found });
  return found;
}

async function fetchUser(link: LinkRow, id: string): Promise<{ email?: string } | undefined> {
  try {
    const stored = credentials.get(link.credential_id);
    if (!stored) return undefined;
    const field = stored.type === 'productivity.notionOAuth2Api' ? 'accessToken' : 'apiKey';
    const data = await credentials.dataWithSecrets({ id: stored.id, name: stored.name }, stored.type);
    const key = typeof data[field] === 'string' ? (data[field] as string) : '';
    if (!key) return undefined;
    const base = (typeof data.baseUrl === 'string' && data.baseUrl.trim() ? data.baseUrl.trim() : 'https://api.notion.com').replace(/\/+$/, '');
    const response = await safeFetch(
      `${base}/v1/users/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'Notion-Version': NOTION_VERSION,
        },
      },
      { span: false },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { person?: { email?: string } };
    return { email: body.person?.email };
  } catch {
    return undefined;
  }
}

/** Who edited a row: the Landflow user whose email Notion gave (never trusted for a permission), else nobody ("A Notion user"). */
function editorOf(ctx: Context, row: NotionPage): Promise<Editor> {
  const id = row.last_edited_by?.id;
  if (!id || id === ctx.botId) return Promise.resolve({});
  const known = ctx.editors.get(id);
  if (known) return known;
  const found = userOf(ctx.link, id).then((user): Editor => {
    const match = user?.email ? findUserByEmail(user.email) : undefined;
    return match && !match.disabledAt ? { userId: match.id, name: match.name } : {};
  });
  ctx.editors.set(id, found);
  return found;
}

const botEdited = (ctx: Context, row: NotionPage) => Boolean(ctx.botId) && row.last_edited_by?.id === ctx.botId;
const outboxPending = (link: LinkRow, kind: string, key: string) =>
  Boolean(database().get('SELECT 1 AS x FROM notion_brain_outbox WHERE link_id = ? AND kind = ? AND local_key = ?', link.id, kind, key));

/** Ask NB04 to render Landflow's state again and write it: the hash it compares is cleared, and the region it replaces is what Notion holds now. */
function putBack(ctx: Context, item: ItemRow, nowHolds?: string): ItemRow {
  const next = saveItem({
    ...item,
    pushed_hash: null,
    ...(nowHolds !== undefined && { pushed_region: nowHolds }),
  });
  enqueue(ctx.link.id, item.kind, item.local_key);
  return next;
}

/** A problem a person resolves. One already resolved after the row's last edit is not filed again. */
function problem(ctx: Context, kind: Parameters<typeof addProblem>[0]['kind'], row: NotionPage | undefined, localKey: string | undefined, detail: string): void {
  const notionId = row?.id;
  if (row) {
    const settled = problems(ctx.link.id, { resolved: true }).some(
      (p) => p.kind === kind && p.notion_id === row.id && (p.local_key ?? undefined) === localKey && (p.resolved_at ?? '') >= row.last_edited_time,
    );
    if (settled) return;
  }
  addProblem({
    linkId: ctx.link.id,
    kind,
    ...(notionId && { notionId }),
    ...(localKey && { localKey }),
    detail,
  });
}

/** Writes the Landflow ID into a row a person added (through the scoped writer; the row is Landflow's now). */
async function writeBackId(ctx: Context, kind: DatabaseKind, row: NotionPage, key: string): Promise<void> {
  markOwn(ctx.link.id, row.id);
  const db = ctx.dbs[kind];
  await linkClient(ctx.link, ctx.client).updatePage(row.id, {
    properties: {
      [db?.properties[LANDFLOW_ID] ?? LANDFLOW_ID]: {
        rich_text: [{ type: 'text', text: { content: key } }],
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------------- the step

const running = new Set<string>();

/** Pulls one link: the step the service runs each tick (every 2 minutes, or at once on Sync now). */
export async function pullLink(link: LinkRow, options: { force?: boolean } = {}): Promise<void> {
  if (!notionBrainEnabled()) return;
  if (!options.force && link.last_pull_at && Date.now() - Date.parse(link.last_pull_at) < POLL_MS) return;
  if (running.has(link.id)) return;
  running.add(link.id);
  try {
    const fresh = linkById(link.id) ?? link;
    const dbs = linkDatabases(fresh);
    if (isStopped(fresh.status) || !Object.keys(dbs).length) return;
    const ctx: Context = {
      link: fresh,
      client: readClient(fresh),
      dbs,
      store: brainStoreFor(fresh.project_id),
      ...(fresh.bot_id && { botId: fresh.bot_id }),
      editors: new Map(),
    };
    if (!(await checkSchema(ctx))) return;
    const cursors = readCursors(fresh);
    const sweep = Boolean(options.force) || !cursors.sweptAt || Date.now() - Date.parse(cursors.sweptAt) >= SWEEP_MS;
    for (const kind of DATABASE_KINDS) {
      const db = dbs[kind];
      if (!db) continue;
      const read = await readRows(ctx, db, sweep ? undefined : cursors[kind]);
      const seen = new Set<string>();
      let newest = cursors[kind];
      for (const row of read.rows) {
        seen.add(row.id.replace(/-/g, '').toLowerCase());
        if (!newest || row.last_edited_time > newest) newest = row.last_edited_time;
        markOwn(ctx.link.id, row.id);
        try {
          await handleRow(ctx, kind, db, row);
        } catch (error) {
          if (isNotionError(error)) throw error;
          logger.warn('[notion-brain] a row could not be pulled', {
            link: ctx.link.id,
            notionId: row.id,
            kind,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (sweep && read.complete) await detachMissing(ctx, kind, seen);
      if (read.complete && newest) cursors[kind] = newest;
    }
    if (sweep) cursors.sweptAt = new Date().toISOString();
    writeCursors(fresh.id, cursors);
    updateLink(fresh.id, {
      last_pull_at: new Date().toISOString(),
      last_error: null,
    });
  } catch (error) {
    stopped(link.id, error);
  } finally {
    running.delete(link.id);
  }
}

/** What a failed pass does to the link: the key is refused, Notion blocked it, the data source is gone; anything else is the last error (no page text). */
function stopped(linkId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (isNotionError(error)) {
    if (error.kind === 'unauthorized') setStatus(linkId, 'unauthorized', 'Notion refused the key');
    else if (error.kind === 'blocked') setStatus(linkId, 'paused', 'Notion blocked the key (public_api_request_blocked)');
    else if (error.kind === 'notFound') setStatus(linkId, 'unshared', 'A page of the brain is gone or no longer shared');
    else updateLink(linkId, { last_error: message });
  } else updateLink(linkId, { last_error: message });
  logger.warn('[notion-brain] the pull stopped', {
    link: linkId,
    error: message,
  });
}

type Cursors = Partial<Record<DatabaseKind | 'sweptAt', string>>;
const rawCursors = (link: LinkRow): Record<string, unknown> => {
  try {
    const parsed = link.cursors ? (JSON.parse(link.cursors) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
/** The pull's own cursors, under `pull` (the knowledge walk keeps its own key in the same JSON). */
const readCursors = (link: LinkRow): Cursors => ({
  ...((rawCursors(link).pull as Cursors | undefined) ?? {}),
});
function writeCursors(linkId: string, cursors: Cursors): void {
  const link = linkById(linkId);
  if (link) setCursors(linkId, { ...rawCursors(link), pull: cursors });
}

// ---------------------------------------------------------------------------------------------------- reading rows

/** Every row of a data source edited since `from` (or all of them), ascending, through every page; a capped answer halves the window. */
async function readRows(ctx: Context, db: LinkDatabase, from: string | undefined): Promise<{ rows: NotionPage[]; complete: boolean }> {
  const out = new Map<string, NotionPage>();
  const lower = from ? new Date(Date.parse(from) - OVERLAP_MS).toISOString() : undefined;
  const complete = await readWindow(ctx, db, out, lower, undefined, 0, lower ?? new Date(Date.parse(ctx.link.created_at) - 86_400_000).toISOString());
  const rows = [...out.values()].filter((r) => !r.in_trash).sort((a, b) => (a.last_edited_time < b.last_edited_time ? -1 : a.last_edited_time > b.last_edited_time ? 1 : 0));
  return { rows, complete };
}

async function readWindow(ctx: Context, db: LinkDatabase, out: Map<string, NotionPage>, from: string | undefined, to: string | undefined, depth: number, floor: string): Promise<boolean> {
  const clauses = [
    ...(from
      ? [
          {
            timestamp: 'last_edited_time',
            last_edited_time: { on_or_after: from },
          },
        ]
      : []),
    ...(to
      ? [
          {
            timestamp: 'last_edited_time',
            last_edited_time: { on_or_before: to },
          },
        ]
      : []),
  ];
  const filter = clauses.length > 1 ? { and: clauses } : clauses[0];
  let incomplete = false;
  let cursor: string | undefined;
  do {
    const list = await ctx.client.queryDataSource(db.dataSourceId, {
      ...(filter && { filter }),
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const row of list.results) out.set(row.id, row);
    if (list.request_status?.type === 'incomplete') incomplete = true;
    cursor = list.has_more && list.next_cursor ? list.next_cursor : undefined;
  } while (cursor);
  if (!incomplete) return true;
  // Capped (10,000 results): halve the window and read each half. Edit times are minute-rounded, so a minute is the smallest window.
  const lo = Date.parse(from ?? floor);
  const hi = to ? Date.parse(to) : Math.max(Date.now(), ...[...out.values()].map((r) => Date.parse(r.last_edited_time))) + 7 * 86_400_000;
  if (hi - lo <= MINUTE || depth >= 32) {
    logger.warn('[notion-brain] a query stayed capped at its smallest window', {
      link: ctx.link.id,
      dataSource: db.dataSourceId,
    });
    return false;
  }
  const mid = new Date(lo + Math.floor((hi - lo) / 2)).toISOString();
  const first = await readWindow(ctx, db, out, from, mid, depth + 1, floor);
  const second = await readWindow(ctx, db, out, mid, to, depth + 1, floor);
  return first && second;
}

// ---------------------------------------------------------------------------------------------------- schema and trash

/** A property missing by id is a `schema_changed` problem; a missing required one (Name, Landflow ID) makes the link need a repair. False: the pass stops. */
async function checkSchema(ctx: Context): Promise<boolean> {
  let required: string | undefined;
  for (const kind of DATABASE_KINDS) {
    const db = ctx.dbs[kind];
    if (!db) continue;
    const source = await ctx.client.dataSource(db.dataSourceId);
    if (source.in_trash) {
      setStatus(ctx.link.id, 'unshared', `The ${DATABASES[kind].title} database is in Notion’s trash`);
      return false;
    }
    const ids = new Set(Object.values(source.properties).map((p) => p.id));
    for (const spec of DATABASES[kind].properties) {
      const id = db.properties[spec.name];
      if (!id || ids.has(id)) continue;
      addProblem({
        linkId: ctx.link.id,
        kind: 'schema_changed',
        localKey: `${kind}:${spec.name}`,
        detail: `The ${DATABASES[kind].title} database no longer has its “${spec.name}” property.`,
      });
      if (spec.required) required = `The ${DATABASES[kind].title} database no longer has its “${spec.name}” property`;
    }
  }
  if (required) {
    setStatus(ctx.link.id, 'needs_repair', required);
    return false;
  }
  return true;
}

const localExists = (item: ItemRow): boolean => {
  if (item.kind === 'entity') {
    const [type, id] = item.local_key.split('/');
    return Boolean(type && id && getEntity(type, id));
  }
  return item.kind === 'fact' ? Boolean(getFact(item.local_key)) : item.kind === 'practice' ? Boolean(getPractice(item.local_key)) : Boolean(noteStore.get(item.local_key));
};

/** Items of this kind whose row a complete listing did not return: trashed, deleted or moved out of the database. Nothing local is deleted. */
async function detachMissing(ctx: Context, kind: DatabaseKind, seen: Set<string>): Promise<void> {
  for (const item of itemsOf(ctx.link.id, KIND_OF_DATABASE[kind])) {
    if (item.state === 'detached' || seen.has(item.notion_id.replace(/-/g, '').toLowerCase()) || !localExists(item)) continue; // Landflow's own delete trashes the row: that is not a person's
    let gone = false;
    try {
      const page = await ctx.client.page(item.notion_id);
      gone = page.in_trash || page.parent.type !== 'data_source_id' || page.parent.data_source_id.replace(/-/g, '').toLowerCase() !== ctx.dbs[kind]!.dataSourceId.replace(/-/g, '').toLowerCase();
    } catch (error) {
      if (!isNotionError(error) || error.kind !== 'notFound') throw error;
      gone = true;
    }
    if (!gone) continue;
    saveItem({ ...item, state: 'detached' });
    addProblem({
      linkId: ctx.link.id,
      kind: 'trashed_in_notion',
      notionId: item.notion_id,
      localKey: item.local_key,
      detail: `The Notion row of ${item.kind} ${item.local_key} was deleted or moved out of its database. Nothing was deleted in Landflow.`,
    });
  }
}

// ---------------------------------------------------------------------------------------------------- one row

async function handleRow(ctx: Context, kind: DatabaseKind, db: LinkDatabase, row: NotionPage): Promise<void> {
  const landflowId = text(row, db, LANDFLOW_ID).trim();
  const itemKind = KIND_OF_DATABASE[kind];
  let item = itemByNotionId(ctx.link.id, row.id);
  if (!item && landflowId) {
    const named = itemOf(ctx.link.id, itemKind, landflowId);
    // A row that names a Landflow ID another row already holds is a copy a person made: it is new.
    if (!named) item = adopt(ctx, itemKind, landflowId, row);
  }
  if (item && item.kind !== itemKind) return;
  if (!item) {
    if (kind === 'pages') await newPage(ctx, db, row);
    else if (kind === 'facts') await newFact(ctx, db, row);
    else if (kind === 'practices') await newPractice(ctx, db, row);
    else await newNote(ctx, db, row);
    return;
  }
  if (item.state === 'detached') {
    item = saveItem({ ...item, state: 'ok' });
    for (const open of problems(ctx.link.id)) if (open.kind === 'trashed_in_notion' && open.notion_id === item.notion_id) resolveProblem(open.id, undefined, 'dismiss');
  }
  if (!landflowId) await writeBackId(ctx, kind, row, item.local_key);
  if (kind === 'pages') await pullPage(ctx, db, row, item);
  else if (kind === 'facts') await pullFact(ctx, db, row, item);
  else if (kind === 'practices') await pullPractice(ctx, db, row, item);
  else await pullNote(ctx, db, row, item);
}

/** A row that names a Landflow ID no item holds yet, whose local object exists: the row is that object's (the copy was interrupted). */
function adopt(ctx: Context, kind: ItemKind, key: string, row: NotionPage): ItemRow | undefined {
  const exists =
    kind === 'entity'
      ? (() => {
          const [t, i] = key.split('/');
          return Boolean(t && i && getEntity(t, i));
        })()
      : kind === 'fact'
        ? Boolean(getFact(key))
        : kind === 'practice'
          ? Boolean(getPractice(key))
          : false;
  if (!exists) return undefined;
  return saveItem({
    link_id: ctx.link.id,
    kind,
    local_key: key,
    notion_id: row.id,
    pushed_hash: null,
    pushed_region: null,
    pushed_at: null,
    seen_edited_at: null,
    pulled_hash: null,
    state: 'ok',
  });
}

// ---------------------------------------------------------------------------------------------------- pages

/** Parses the Attributes property: one `key: value` per line. */
export function parseAttributes(value: string): {
  attrs: Record<string, string>;
  bad: number[];
} {
  const attrs: Record<string, string> = {};
  const bad: number[] = [];
  value.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    const at = line.indexOf(':');
    const key = at > 0 ? line.slice(0, at).trim() : '';
    if (!key || !ATTR_NAME.test(key)) bad.push(index + 1);
    else attrs[key] = line.slice(at + 1).trim();
  });
  return { attrs, bad };
}

const attrString = (attrs: BrainEntity['attrs']): Record<string, string> => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)]));

async function newPage(ctx: Context, db: LinkDatabase, row: NotionPage): Promise<void> {
  const name = text(row, db, 'Name').trim();
  if (!name) return; // a row nobody has named yet
  const given = text(row, db, 'Type').trim().toLowerCase();
  const known = ['initiative', 'person', 'customer', 'system'].includes(given);
  const type = known ? given : 'initiative';
  const { attrs, bad } = parseAttributes(text(row, db, 'Attributes'));
  const editor = await editorOf(ctx, row);
  let created;
  try {
    created = ctx.store.upsertEntity(
      {
        type,
        name,
        description: text(row, db, 'Description').trim(),
        owner: text(row, db, 'Owner').trim(),
        projectId: ctx.link.project_id,
        attrs,
        source: 'notion',
      },
      'notion',
      editor.userId,
    ).entity;
  } catch (error) {
    if (!(error instanceof EntityError)) throw error;
    problem(ctx, 'bad_attribute', row, undefined, 'A new page could not be added: its attributes are over the limit (20 attributes, 200 characters each).');
    return;
  }
  const ref = entityKey(created);
  const item = saveItem({
    link_id: ctx.link.id,
    kind: 'entity',
    local_key: ref,
    notion_id: row.id,
    pushed_hash: null,
    pushed_region: null,
    pushed_at: null,
    seen_edited_at: null,
    pulled_hash: null,
    state: 'ok',
  });
  if (!known) problem(ctx, 'type_changed', row, ref, `A page added in Notion had no valid Type, so ${ref} was created as an initiative.`);
  if (bad.length) problem(ctx, 'bad_attribute', row, ref, `Line${bad.length > 1 ? 's' : ''} ${bad.join(', ')} of the Attributes of ${ref} ${bad.length > 1 ? 'are' : 'is'} not “key: value”.`);
  await writeBackId(ctx, 'pages', row, ref);
  const hashes = pageHashes(row, db);
  const saved = saveItem({
    ...item,
    pulled_hash: `${hashes.person}.${hashes.landflow}`,
  });
  await readBody(ctx, row, saved, created.name, true);
  enqueue(ctx.link.id, 'entity', ref); // Landflow writes the rest of the row: its region, Teams, Sources
}

function pageHashes(row: NotionPage, db: LinkDatabase): RowHashes {
  return {
    person: hashOf(specs('pages', ['person']), row, db),
    landflow: hashOf(
      specs('pages', ['landflow', 'create']).filter((n) => n !== 'Name'),
      row,
      db,
    ),
  };
}

async function pullPage(ctx: Context, db: LinkDatabase, row: NotionPage, item: ItemRow): Promise<void> {
  const [type, id] = item.local_key.split('/');
  const local = type && id ? getEntity(type, id) : undefined;
  if (!local) return;
  const hashes = pageHashes(row, db);
  const base = baselineOf(item);
  const bot = botEdited(ctx, row);
  const personChanged = !base || base.person !== hashes.person;
  const landflowChanged = Boolean(base) && base!.landflow !== hashes.landflow;
  let current = item;

  // Landflow's properties: a Type that is not the page's own, or any other property of Landflow's edited by a person, is put back.
  const typeGiven = text(row, db, 'Type').trim().toLowerCase();
  if (!bot && (!base || landflowChanged || personChanged) && typeGiven !== local.type) {
    problem(ctx, 'type_changed', row, item.local_key, `The Type of ${item.local_key} was changed in Notion. Landflow put its own back.`);
    current = putBack(ctx, current);
  } else if (!bot && landflowChanged) current = putBack(ctx, current);

  let applied = base?.applied;
  if (personChanged && !(bot && outboxPending(ctx.link, 'entity', item.local_key))) applied = (await applyPersonFields(ctx, db, row, local, current)) ?? applied;

  const after = pageHashes(row, db);
  current = saveItem({
    ...(itemOf(ctx.link.id, 'entity', item.local_key) ?? current),
    pulled_hash: pulledHash(after, applied),
  });
  await readBody(ctx, row, current, local.name, false);
}

/** Name, Description, Owner and Attributes: Notion's value wins when only Notion changed it; when both sides changed, the later edit wins and the other value is kept in the audit log. */
async function applyPersonFields(ctx: Context, db: LinkDatabase, row: NotionPage, local: BrainEntity, item: ItemRow): Promise<string | undefined> {
  const ref = item.local_key;
  const notion = {
    name: text(row, db, 'Name').trim(),
    description: text(row, db, 'Description').trim(),
    owner: text(row, db, 'Owner').trim(),
  };
  const parsed = parseAttributes(text(row, db, 'Attributes'));
  const localAttrs = attrString(local.attrs);
  const localDirty = outboxPending(ctx.link, 'entity', ref) || Boolean(item.pushed_at && local.updatedAt > dirtyAfter(item));
  const notionWins = !localDirty || notionIsLater(row.last_edited_time, local.updatedAt);
  const editor = await editorOf(ctx, row);
  const by = editor.name;

  const input: Parameters<BrainStore['upsertEntity']>[0] = {
    type: local.type,
    id: local.id,
  };
  const differing: Array<{ field: string; notion: string; local: string }> = [];
  if (notion.name && notion.name !== local.name) differing.push({ field: 'name', notion: notion.name, local: local.name });
  if (notion.description !== (local.description ?? ''))
    differing.push({
      field: 'description',
      notion: notion.description,
      local: local.description ?? '',
    });
  if (notion.owner !== (local.owner ?? ''))
    differing.push({
      field: 'owner',
      notion: notion.owner,
      local: local.owner ?? '',
    });
  const attrChanges: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.attrs)) {
    if (localAttrs[key] === value) continue;
    const had = local.attrs[key];
    attrChanges[key] = typeof had === 'number' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : typeof had === 'boolean' && (value === 'true' || value === 'false') ? value === 'true' : value;
  }
  if (!parsed.bad.length) for (const key of Object.keys(localAttrs)) if (!(key in parsed.attrs)) attrChanges[key] = null;
  if (Object.keys(attrChanges).length)
    differing.push({
      field: 'attributes',
      notion: JSON.stringify(parsed.attrs),
      local: JSON.stringify(localAttrs),
    });
  if (parsed.bad.length)
    problem(
      ctx,
      'bad_attribute',
      row,
      ref,
      `Line${parsed.bad.length > 1 ? 's' : ''} ${parsed.bad.join(', ')} of the Attributes of ${ref} ${parsed.bad.length > 1 ? 'are' : 'is'} not “key: value”. The other lines were kept.`,
    );
  if (!differing.length) return undefined;

  if (!notionWins) {
    for (const d of differing)
      recordOverwrite(ctx.link, {
        ref,
        name: local.name,
        field: d.field,
        winner: 'landflow',
        by,
        replaced: d.notion,
      });
    enqueue(ctx.link.id, 'entity', ref); // the push writes Landflow's later edit
    return undefined;
  }
  for (const d of differing) {
    if (d.field === 'name') input.name = d.notion;
    else if (d.field === 'description') input.description = d.notion;
    else if (d.field === 'owner') input.owner = d.notion;
    else input.attrs = attrChanges;
  }
  try {
    ctx.store.upsertEntity(input, 'notion', editor.userId);
  } catch (error) {
    if (!(error instanceof EntityError)) throw error;
    problem(ctx, 'bad_attribute', row, ref, `A change to ${ref} in Notion was refused (${error.message.split('\n')[0].slice(0, 120)}). Landflow put its own back.`);
    enqueue(ctx.link.id, 'entity', ref);
    return undefined;
  }
  if (localDirty)
    for (const d of differing)
      recordOverwrite(ctx.link, {
        ref,
        name: local.name,
        field: d.field,
        winner: 'notion',
        by,
        replaced: d.local,
      });
  return getEntity(local.type, local.id)?.updatedAt;
}

// ---------------------------------------------------------------------------------------------------- bodies

/** Whether the body is read: the row's edit time moved since the last read, or the last read was inside the minute the stamp names (a later edit in that minute has the same stamp). */
function needsBody(item: ItemRow, row: NotionPage, now = Date.now()): boolean {
  const [stamp, hot] = (item.seen_edited_at ?? '').split('|');
  if (stamp !== row.last_edited_time) return true;
  return hot === 'hot' && now >= Date.parse(row.last_edited_time) + MINUTE;
}

const notesTitle = (name: string) => `${name} · Your notes`;

/**
 * "Your notes" and the region of a row's body. A region that is not what Landflow wrote is a conflict (a suggestion, a problem, the
 * region put back); missing markers make the notes the whole body without the last region where it still appears.
 */
async function readBody(ctx: Context, row: NotionPage, item: ItemRow, name: string, created: boolean): Promise<void> {
  if (!created && !needsBody(item, row)) return;
  const now = Date.now();
  const markdown = (await ctx.client.pageMarkdown(row.id)).markdown;
  const parts = splitBody(markdown);
  let current: ItemRow = saveItem({
    ...item,
    seen_edited_at: now < Date.parse(row.last_edited_time) + MINUTE ? `${row.last_edited_time}|hot` : row.last_edited_time,
  });
  const pushed = current.pushed_region;
  let notes = parts.notes;
  if (parts.region !== undefined) {
    if (pushed !== null && normalize(parts.region) !== regionOf(pushed)) {
      const editor = await editorOf(ctx, row);
      await regionConflict({
        link: ctx.link,
        item: current,
        before: pushed,
        after: parts.region,
        ...(editor.name && { editedBy: editor.name }),
        editedAt: row.last_edited_time,
      });
      current = putBack(ctx, current, parts.region);
    }
  } else if (pushed !== null && pushed !== '') {
    // The markers are gone: the person's text is what is left of the body once the last copy of the region is cut out.
    const region = regionOf(pushed);
    const whole = markdown.replace(/\r\n/g, '\n');
    const at = region ? whole.lastIndexOf(region) : -1;
    const rest = at >= 0 ? `${whole.slice(0, at)}${whole.slice(at + region.length)}` : whole;
    const lines = rest.split('\n');
    const heading = lines.findIndex((l) => l.trim() === NOTES_HEADING);
    notes = (heading >= 0 ? lines.slice(heading + 1) : lines)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    current = putBack(ctx, current);
  }
  saveNotes(ctx.link, row, name, notes);
}

/** "Your notes" as a knowledge doc, kept as the person wrote them (never redacted, at most 4,000 characters). Empty notes remove the doc. */
function saveNotes(link: LinkRow, row: NotionPage, name: string, notes: string): void {
  const db = database();
  const page = row.id.toLowerCase();
  const existing = db.get<{ hash: string | null }>('SELECT hash FROM notion_knowledge_docs WHERE link_id = ? AND page_id = ?', link.id, page);
  if (!notes.trim()) {
    if (existing) db.delete('notion_knowledge_docs', { link_id: link.id, page_id: page });
    return;
  }
  const hash = sha(`${notes}|${name}|${row.url}`);
  if (existing?.hash === hash) return;
  db.upsert('notion_knowledge_docs', {
    link_id: link.id,
    page_id: page,
    title: notesTitle(name),
    url: row.url,
    path: `Pages / ${name}`,
    edited_at: row.last_edited_time,
    hash,
    markdown: notes.slice(0, NOTES_LIMIT),
    truncated: notes.length > NOTES_LIMIT ? 1 : 0,
  } as never);
}

// ---------------------------------------------------------------------------------------------------- facts

const MANUAL_FACT_ID = /^entity:.+:fact_/;

/** The page a Facts row is About: the first related row that is a page of this link. */
function aboutOf(ctx: Context, db: LinkDatabase, row: NotionPage): BrainEntity | undefined {
  for (const related of property(row, db, 'About')?.relation ?? []) {
    const item = itemByNotionId(ctx.link.id, related.id);
    if (item?.kind !== 'entity') continue;
    const [type, id] = item.local_key.split('/');
    const entity = type && id ? getEntity(type, id) : undefined;
    if (entity) return entity;
  }
  return undefined;
}

const factKindOf = (value: string, fallback: FactKind = DEFAULT_FACT_KIND): FactKind => ((FACT_KINDS as readonly string[]).includes(value) ? (value as FactKind) : fallback);

async function newFact(ctx: Context, db: LinkDatabase, row: NotionPage): Promise<void> {
  const statement = text(row, db, 'Statement').trim();
  if (!statement) return;
  const about = aboutOf(ctx, db, row);
  if (!about) {
    problem(ctx, 'fact_without_page', row, undefined, 'A fact row in Notion has no page in About, so nothing was added. Pick the page it is about.');
    return;
  }
  const editor = await editorOf(ctx, row);
  const fact = ctx.store.addFact(
    about,
    {
      kind: factKindOf(text(row, db, 'Kind').trim()),
      statement,
      evidence: [{ label: NOTION_EVIDENCE_LABEL, href: row.url }],
    },
    'notion',
    editor.userId,
  );
  const item = saveItem({
    link_id: ctx.link.id,
    kind: 'fact',
    local_key: fact.id,
    notion_id: row.id,
    pushed_hash: null,
    pushed_region: null,
    pushed_at: null,
    seen_edited_at: row.last_edited_time,
    pulled_hash: null,
    state: 'ok',
  });
  await writeBackId(ctx, 'facts', row, fact.id);
  const hashes = factHashes(row, db, true);
  saveItem({ ...item, pulled_hash: `${hashes.person}.${hashes.landflow}` });
  enqueue(ctx.link.id, 'fact', fact.id); // Landflow writes Source, Status and the rest
}

function factHashes(row: NotionPage, db: LinkDatabase, manual: boolean): RowHashes {
  const person = ['Statement', 'Kind'];
  const landflow = DATABASES.facts.properties.map((p) => p.name).filter((n) => (manual ? !person.includes(n) && n !== 'About' : true));
  return {
    person: manual ? hashOf(person, row, db) : '',
    landflow: hashOf(landflow, row, db),
  };
}

async function pullFact(ctx: Context, db: LinkDatabase, row: NotionPage, item: ItemRow): Promise<void> {
  const fact = getFact(item.local_key);
  if (!fact) return;
  const manual = MANUAL_FACT_ID.test(fact.id);
  const hashes = factHashes(row, db, manual);
  const base = baselineOf(item);
  const bot = botEdited(ctx, row);
  const changed = !base || base.person !== hashes.person || base.landflow !== hashes.landflow;
  let current = item;
  let applied = base?.applied;
  if (changed && !bot) {
    const statement = text(row, db, 'Statement').trim();
    if (manual) {
      const kind = factKindOf(text(row, db, 'Kind').trim(), fact.kind);
      if (statement && (statement !== fact.statement || kind !== fact.kind)) {
        const localDirty = outboxPending(ctx.link, 'fact', fact.id) || Boolean(item.pushed_at && fact.lastSeen > dirtyAfter(item));
        const editor = await editorOf(ctx, row);
        if (localDirty && !notionIsLater(row.last_edited_time, fact.lastSeen)) enqueue(ctx.link.id, 'fact', fact.id);
        else
          upsertFact(
            {
              id: fact.id,
              subjectType: fact.subjectType,
              subjectId: fact.subjectId,
              ...(fact.subjectName && { subjectName: fact.subjectName }),
              kind,
              statement: statement.slice(0, 1_000),
              evidence: fact.evidence,
              confidence: fact.confidence,
              ...(fact.projectId && { projectId: fact.projectId }),
            },
            database(),
            new Date().toISOString(),
            'notion',
            editor.userId,
          );
        applied = getFact(fact.id)?.lastSeen ?? applied;
      }
    } else if (statement !== fact.statement || (base && base.landflow !== hashes.landflow)) {
      if (statement && statement !== fact.statement) {
        const editor = await editorOf(ctx, row);
        statementConflict(ctx.link, item, {
          ref: fact.subjectId,
          text: statement,
          ...(editor.name && { editedBy: editor.name }),
          notionUrl: row.url,
        });
      }
      current = putBack(ctx, current);
    }
  }
  saveItem({
    ...current,
    pulled_hash: pulledHash(hashes, applied),
    seen_edited_at: row.last_edited_time,
  });
}

// ---------------------------------------------------------------------------------------------------- practices

const callout = /<callout>[\s\S]*?<\/callout>/g;

/** The summary (a leading quote) and the body of a practice row's region. A region with no quote keeps the summary it had. */
export function parsePracticeRegion(region: string, fallbackSummary: string): { summary: string; body: string } {
  const lines = region.replace(callout, '').replace(/\r\n/g, '\n').trim().split('\n');
  const quote: string[] = [];
  let at = 0;
  while (at < lines.length && (lines[at].startsWith('>') || (!quote.length && !lines[at].trim()))) {
    if (lines[at].startsWith('>')) quote.push(lines[at].replace(/^>\s?/, ''));
    at++;
  }
  const summary = quote.join(' ').replace(/\s+/g, ' ').trim();
  return summary ? { summary, body: lines.slice(at).join('\n').trim() } : { summary: fallbackSummary, body: lines.join('\n').trim() };
}

const list = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 38) || 'practice';

async function newPractice(ctx: Context, db: LinkDatabase, row: NotionPage): Promise<void> {
  const title = text(row, db, 'Title').trim();
  if (!title) return;
  const editor = await editorOf(ctx, row);
  const body = (await ctx.client.pageMarkdown(row.id)).markdown;
  const parts = splitBody(body);
  const written = (parts.region ?? parts.notes).replace(callout, '').trim();
  const parsed = parsePracticeRegion(written, title);
  const given = text(row, db, 'Handle').trim().toLowerCase();
  const strength = text(row, db, 'Strength').trim();
  try {
    const user = editor.userId ? getUser(editor.userId) : undefined;
    const base = {
      title,
      level: 'project' as const,
      projectId: ctx.link.project_id,
      strength: ((PRACTICE_STRENGTHS as readonly string[]).includes(strength) ? strength : 'recommended') as PracticeStrength,
      topics: list(text(row, db, 'Topics')),
      repos: list(text(row, db, 'Repos')),
      paths: list(text(row, db, 'Paths')),
      summary: parsed.summary,
      body: parsed.body || parsed.summary,
    };
    let saved: ReturnType<BrainStore['draftPractice']> | undefined;
    for (let attempt = 0; !saved && attempt < 5; attempt++) {
      const handle = PRACTICE_HANDLE.test(given) && attempt === 0 ? given : `notion/${slug(title)}${attempt ? `-${attempt + 1}` : ''}`;
      try {
        saved = ctx.store.draftPractice({ ...base, handle }, { source: 'notion', ...(user && { actor: user as never }) });
      } catch (error) {
        if ((error as { status?: number }).status !== 409) throw error;
      }
    }
    if (!saved) throw new PracticeError('No free handle for this practice', 400);
    const item = saveItem({
      link_id: ctx.link.id,
      kind: 'practice',
      local_key: saved.practice.id,
      notion_id: row.id,
      pushed_hash: null,
      pushed_region: null,
      pushed_at: null,
      seen_edited_at: row.last_edited_time,
      pulled_hash: null,
      state: 'ok',
    });
    await writeBackId(ctx, 'practices', row, saved.practice.id);
    const hashes = practiceHashes(row, db);
    saveItem({ ...item, pulled_hash: `${hashes.person}.${hashes.landflow}` });
    linkNotionPage(saved.practice.id, saved.version.version, row.url);
    enqueue(ctx.link.id, 'practice', saved.practice.id);
  } catch (error) {
    if (!(error instanceof PracticeError) && (error as { status?: number }).status === undefined) throw error;
    problem(ctx, 'too_large', row, undefined, `A new practice row in Notion could not be drafted: ${(error as Error).message}`);
  }
}

function practiceHashes(row: NotionPage, db: LinkDatabase): RowHashes {
  return {
    person: hashOf(['Title'], row, db),
    landflow: hashOf(
      DATABASES.practices.properties.map((p) => p.name).filter((n) => n !== 'Title'),
      row,
      db,
    ),
  };
}

/** The Notion page's address goes into the draft's inbox suggestion, next to "a linked Notion page". */
function linkNotionPage(practiceId: string, version: number, url: string): void {
  try {
    for (const stored of database().all<{ id: string }>("SELECT id FROM proposals WHERE source = 'practice' AND status IN ('open', 'snoozed')")) {
      const proposal = getProposal(stored.id);
      if (proposal?.practice?.practiceId !== practiceId || proposal.practice.version !== version) continue;
      saveProposal({
        ...proposal,
        evidence: proposal.evidence.map((e) => (e.label === 'Read from outside' ? { ...e, href: url } : e)),
      });
    }
  } catch {
    // The link is a courtesy: the suggestion stands without it.
  }
}

async function pullPractice(ctx: Context, db: LinkDatabase, row: NotionPage, item: ItemRow): Promise<void> {
  const practice = getPractice(item.local_key);
  if (!practice || practice.level !== 'project') return;
  const hashes = practiceHashes(row, db);
  const base = baselineOf(item);
  const bot = botEdited(ctx, row);
  let current = item;
  // Status, Version, Handle and the rest are Landflow's: a person's change is put back, never pulled. Nothing here approves anything.
  if (!bot && base && base.landflow !== hashes.landflow) current = putBack(ctx, current);
  const titleChanged = !base || base.person !== hashes.person;
  const read = needsBody(current, row);
  let region: string | undefined;
  let notes = '';
  if (read) {
    const markdown = (await ctx.client.pageMarkdown(row.id)).markdown;
    const parts = splitBody(markdown);
    region = parts.region;
    notes = parts.notes;
    const now = Date.now();
    current = saveItem({
      ...current,
      seen_edited_at: now < Date.parse(row.last_edited_time) + MINUTE ? `${row.last_edited_time}|hot` : row.last_edited_time,
    });
    saveNotes(ctx.link, row, practice.title, notes);
  }
  const pushed = current.pushed_region;
  const regionEdited = region !== undefined && pushed !== null && normalize(region) !== regionOf(pushed);
  if ((regionEdited || (titleChanged && !bot && text(row, db, 'Title').trim() !== practice.title)) && !bot) {
    const drafted = await draftFromNotion(ctx, db, row, practice, regionEdited ? region : undefined);
    if (drafted) current = putBack(ctx, current, regionEdited ? region : undefined);
  }
  saveItem({
    ...(itemOf(ctx.link.id, 'practice', item.local_key) ?? current),
    pulled_hash: `${hashes.person}.${hashes.landflow}`,
  });
}

/** A change to a practice's title, summary or body: a tainted draft (the version a person approves), or an update of the draft already waiting. */
async function draftFromNotion(ctx: Context, db: LinkDatabase, row: NotionPage, practice: Practice, region: string | undefined): Promise<boolean> {
  const versions = versionsOf(practice.id);
  const newest = versions[0];
  const approved = practice.approvedVersion ? versions.find((v) => v.version === practice.approvedVersion) : undefined;
  const reference = approved ?? newest;
  if (!reference) return false;
  const title = text(row, db, 'Title').trim() || reference.title;
  const parsed = region === undefined ? { summary: reference.summary, body: reference.body } : parsePracticeRegion(region, reference.summary);
  let fields;
  try {
    fields = cleanFields({
      title,
      strength: reference.strength,
      topics: reference.topics,
      repos: reference.repos,
      paths: reference.paths,
      summary: parsed.summary,
      body: parsed.body || reference.body,
      checks: reference.checks,
    });
  } catch (error) {
    problem(ctx, 'too_large', row, practice.id, `A change to practice ${practice.handle} in Notion could not be drafted: ${(error as Error).message}`);
    return false;
  }
  const same = (v: PracticeVersion | undefined) => Boolean(v) && v!.title === fields.title && v!.summary === fields.summary && v!.body === fields.body;
  const pending = newest && !newest.approvedAt && !newest.rejectedAt ? newest : undefined;
  if (same(approved) || same(pending) || (!approved && same(newest))) return true; // the approved text put back, or a draft already holds this
  const editor = await editorOf(ctx, row);
  const user = editor.userId ? getUser(editor.userId) : undefined;
  if (pending && pending.source === 'notion') {
    // A later edit before approval updates the same draft.
    updatePendingDraft(practice, pending, fields);
    linkNotionPage(practice.id, pending.version, row.url);
    return true;
  }
  const { practice: saved, version } = ctx.store.draftPractice(
    {
      practiceId: practice.id,
      handle: practice.handle,
      level: 'project',
      projectId: ctx.link.project_id,
      ...fields,
      checks: reference.checks,
    },
    { source: 'notion', ...(user && { actor: user as never }) },
  );
  linkNotionPage(saved.id, version.version, row.url);
  return true;
}

/** Rewrites the waiting draft version in place (its hash with it) and refreshes its suggestion. */
function updatePendingDraft(practice: Practice, pending: PracticeVersion, fields: ReturnType<typeof cleanFields>): void {
  const db = database();
  const stored = db.get<Record<string, unknown>>('SELECT * FROM practice_versions WHERE practice_id = ? AND version = ?', practice.id, pending.version);
  if (!stored) return;
  db.upsert('practice_versions', {
    ...stored,
    title: fields.title,
    summary: fields.summary,
    body: fields.body,
    sha256: hashFields(fields),
  } as never);
  const updated = versionsOf(practice.id).find((v) => v.version === pending.version);
  if (updated) fileDraftSuggestion(practice, updated);
}

// ---------------------------------------------------------------------------------------------------- notebook

const teamNamed = (link: LinkRow, name: string): string | undefined =>
  agentTeamStore.list().find((t) => homeProjectId('agentTeam', t.id) === link.project_id && t.draft.name.trim().toLowerCase() === name.trim().toLowerCase())?.id;

async function newNote(ctx: Context, db: LinkDatabase, row: NotionPage): Promise<void> {
  const body = text(row, db, 'Text').trim();
  if (!body) return;
  const team = text(row, db, 'Team').trim();
  const teamId = team ? teamNamed(ctx.link, team) : undefined;
  if (!teamId) {
    problem(
      ctx,
      'note_without_team',
      row,
      undefined,
      team ? 'A note row in Notion names a team that is not one of this project’s teams, so nothing was added.' : 'A note row in Notion has no Team, so nothing was added. Name the team it is for.',
    );
    return;
  }
  const editor = await editorOf(ctx, row);
  const kind = text(row, db, 'Kind').trim();
  const note = await ctx.store.addNote(
    teamId,
    {
      ...((NOTE_KINDS as readonly string[]).includes(kind) && {
        kind: kind as NoteKind,
      }),
      text: body,
      url: row.url,
    },
    'notion',
    editor.userId,
  );
  const item = saveItem({
    link_id: ctx.link.id,
    kind: 'note',
    local_key: note.id,
    notion_id: row.id,
    pushed_hash: null,
    pushed_region: null,
    pushed_at: null,
    seen_edited_at: row.last_edited_time,
    pulled_hash: null,
    state: 'ok',
  });
  await writeBackId(ctx, 'notebook', row, note.id);
  saveItem({
    ...item,
    pulled_hash: `.${hashOf(
      DATABASES.notebook.properties.map((p) => p.name),
      row,
      db,
    )}`,
  });
  enqueue(ctx.link.id, 'note', note.id); // Landflow writes Status, Tainted and From
}

/** A note is edited in Landflow: a change in Notion is put back (the first sight compares the text, the later ones the row's hash). */
async function pullNote(ctx: Context, db: LinkDatabase, row: NotionPage, item: ItemRow): Promise<void> {
  const hash = `.${hashOf(
    DATABASES.notebook.properties.map((p) => p.name),
    row,
    db,
  )}`;
  const base = baselineOf(item);
  let current = item;
  const note = noteStore.get(item.local_key);
  const said = text(row, db, 'Text').trim().replace(/\s+/g, ' ');
  const edited = base ? `.${base.landflow}` !== hash : Boolean(note && said && said !== note.text);
  if (edited && !botEdited(ctx, row)) current = putBack(ctx, current);
  saveItem({
    ...current,
    pulled_hash: hash,
    seen_edited_at: row.last_edited_time,
  });
}

// ---------------------------------------------------------------------------------------------------- registration

setPullStep(async (link, options) => pullLink(link, options));
setRegionConflict(regionConflict);
