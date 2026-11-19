/**
 * The Notion sync's shared half (docs/features/notion-brain.md#how-the-sync-works): the link's databases as stored, the items
 * (which Notion page each local object is) and the outbox, a body's parts (the region Landflow writes and "Your notes"), the
 * client every sync write goes through, and the hooks the push (NB04), the pull (NB05) and the knowledge walk (NB06) give each
 * other. Nothing here renders, pushes or pulls.
 *
 * Writes are scoped twice: the scoped writer (lib/server/notion/scope.ts) refuses any write that is not under the root, and
 * what counts as Landflow's own here is never taken from the database alone. An id is own only once it is seen under its own
 * parent in this process: Landflow just created it there (`markOwn`), or `verifyOwn` read its parent and walked up to the
 * brain page and the root. A row whose `notion_id` was changed by hand to another page is therefore refused.
 *
 * Written by the plan for the Notion brain program, wave nb2: NB04 owns it (backbone/contracts/nb/sync.ts); NB05 and NB06 add
 * this file byte for byte. Change it in the contract first, then every copy.
 */
import type { BrainObjectKind } from '../../../shared/brain-store';
import { DATABASE_KINDS, NOTES_HEADING, REGION_END, REGION_FALLBACK, REGION_START, type DatabaseKind } from '../../../shared/notion-brain';
import { database } from '../../db';
import { notionClientFor, notionId, sameId, type NotionClient, type NotionParent } from '../../notion/port';
import { scopedWriter } from '../../notion/scope';
import { singleton } from '../../singleton';
import type { LinkRow } from './links';

// ---------------------------------------------------------------------------------------------------- kinds and rows

/** A local object that is one Notion row: a page (entity), a fact, a practice, a note. A summary is its entity row's body. */
export type ItemKind = Exclude<BrainObjectKind, 'summary'>;
export const ITEM_DATABASE: Readonly<Record<ItemKind, DatabaseKind>> = { entity: 'pages', fact: 'facts', practice: 'practices', note: 'notebook' };
export const itemKindOf = (kind: BrainObjectKind): ItemKind => (kind === 'summary' ? 'entity' : kind);

/** What the outbox holds: a row, or one of the two pages Landflow writes whole (`home`, `log`; their key is `''`). */
export type OutboxKind = ItemKind | 'home' | 'log';
export const OUTBOX_KINDS: readonly OutboxKind[] = ['entity', 'fact', 'practice', 'note', 'home', 'log'];

export type ItemState = 'ok' | 'detached' | 'conflict';

/** A `notion_brain_items` row (migration 2909). `notion_id` is kept dashed and lower case. */
export interface ItemRow {
  link_id: string;
  kind: ItemKind;
  local_key: string;
  notion_id: string;
  pushed_hash: string | null;
  /** The region as Notion answered it after the last write (never as sent: Notion may rewrite Markdown). */
  pushed_region: string | null;
  pushed_at: string | null;
  seen_edited_at: string | null;
  pulled_hash: string | null;
  state: ItemState;
}

/** A `notion_brain_outbox` row (migration 2910): one per object, a second change updates it. */
export interface OutboxRow {
  link_id: string;
  kind: OutboxKind;
  local_key: string;
  op: 'upsert' | 'delete';
  enqueued_at: string;
  attempts: number;
  next_at: string | null;
  last_error: string | null;
}

/** One of the link's four databases as the copy made it: its data source and each property's id by name. */
export interface LinkDatabase {
  databaseId: string;
  dataSourceId: string;
  properties: Record<string, string>;
}
export type LinkDatabases = Partial<Record<DatabaseKind, LinkDatabase>>;

/** The link's `databases` JSON; a bad or missing value reads as none. */
export function linkDatabases(link: Pick<LinkRow, 'databases'>): LinkDatabases {
  try {
    const parsed = link.databases ? (JSON.parse(link.databases) as LinkDatabases) : {};
    return Object.fromEntries(DATABASE_KINDS.filter((kind) => parsed[kind]?.dataSourceId).map((kind) => [kind, parsed[kind]!])) as LinkDatabases;
  } catch {
    return {};
  }
}

const dashed = (id: string) => notionId(id) ?? id.toLowerCase();
const now = () => new Date().toISOString();

export const itemOf = (linkId: string, kind: ItemKind, localKey: string): ItemRow | undefined =>
  database().get<ItemRow>('SELECT * FROM notion_brain_items WHERE link_id = ? AND kind = ? AND local_key = ?', linkId, kind, localKey);

export const itemByNotionId = (linkId: string, id: string): ItemRow | undefined =>
  database().get<ItemRow>('SELECT * FROM notion_brain_items WHERE link_id = ? AND notion_id = ?', linkId, dashed(id));

export const itemsOf = (linkId: string, kind?: ItemKind): ItemRow[] =>
  kind
    ? database().all<ItemRow>('SELECT * FROM notion_brain_items WHERE link_id = ? AND kind = ? ORDER BY local_key', linkId, kind)
    : database().all<ItemRow>('SELECT * FROM notion_brain_items WHERE link_id = ? ORDER BY kind, local_key', linkId);

export function saveItem(row: ItemRow): ItemRow {
  const next = { ...row, notion_id: dashed(row.notion_id) };
  database().upsert('notion_brain_items', next as unknown as Record<string, never>);
  return next;
}

/** Queue a push of one object (coalesced: the object's row is replaced, its attempts reset). Never calls Notion. */
export function enqueue(linkId: string, kind: OutboxKind, localKey: string, op: OutboxRow['op'] = 'upsert'): void {
  const at = now();
  const row: OutboxRow = { link_id: linkId, kind, local_key: localKey, op, enqueued_at: at, attempts: 0, next_at: at, last_error: null };
  database().upsert('notion_brain_outbox', row as unknown as Record<string, never>);
}

// ---------------------------------------------------------------------------------------------------- bodies

/** A page body's parts: the region between the markers (either form), and the text under "Your notes". */
export interface BodyParts {
  /** Undefined when no start and end marker were found in order. */
  region?: string;
  /** What follows the "Your notes" heading after the end marker (or the whole body when there are no markers), blank lines trimmed. */
  notes: string;
  markers: 'comment' | 'fallback' | 'none';
}

const trimBlankLines = (lines: string[]) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end).join('\n');
};

/** Splits a body read from Notion (or a fixture). Markers are whole lines; blank lines around the parts never matter. */
export function splitBody(markdown: string): BodyParts {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (const [markers, start, end] of [['comment', REGION_START, REGION_END], ['fallback', REGION_FALLBACK.start, REGION_FALLBACK.end]] as const) {
    const from = lines.findIndex((line) => line.trim() === start);
    const to = from < 0 ? -1 : lines.findIndex((line, i) => i > from && line.trim() === end);
    if (to < 0) continue;
    const after = lines.slice(to + 1);
    const heading = after.findIndex((line) => line.trim() === NOTES_HEADING);
    return { region: trimBlankLines(lines.slice(from + 1, to)), notes: trimBlankLines(heading < 0 ? after : after.slice(heading + 1)), markers };
  }
  return { notes: trimBlankLines(lines), markers: 'none' };
}

/** A row's body: the region, then "Your notes" (empty on create; a put-back passes the notes it just read). */
export const pageBody = (region: string, notes = ''): string => `${REGION_START}\n${region}\n${REGION_END}\n\n${NOTES_HEADING}\n${notes ? `${notes}\n` : ''}`;
/** Home's and Log's body: the region only (Notion lists the brain page's children after it). */
export const wholeBody = (region: string): string => `${REGION_START}\n${region}\n${REGION_END}\n`;

// ---------------------------------------------------------------------------------------------------- own ids and the client

interface SyncState {
  /** Per link: compact ids of pages, rows and databases seen under their own parent in this process. */
  own: Map<string, Set<string>>;
  /** Per link: the data sources seen under the brain page (the scoped writer reads this set on every check). */
  sources: Map<string, Set<string>>;
  pull?: SyncStep;
  knowledge?: SyncStep;
  conflict?: RegionConflict;
}
const state = () => singleton('notion-sync', (): SyncState => ({ own: new Map(), sources: new Map() }));
const compact = (id: string) => id.replace(/-/g, '').toLowerCase();
const ownSet = (linkId: string) => state().own.get(linkId) ?? state().own.set(linkId, new Set()).get(linkId)!;
const sourceSet = (linkId: string) => state().sources.get(linkId) ?? state().sources.set(linkId, new Set()).get(linkId)!;

/** Landflow just made `id` under its own parent (or read it from a query of the link's own data source). */
export function markOwn(linkId: string, id: string, kind: 'page' | 'dataSource' = 'page'): void {
  if (kind === 'dataSource') sourceSet(linkId).add(dashed(id));
  else ownSet(linkId).add(compact(id));
}
export const isOwn = (linkId: string, id: string): boolean => ownSet(linkId).has(compact(id));

/** Forget what this process saw of a link (unlinked, or a test that starts again). */
export function forgetLink(linkId?: string): void {
  if (linkId === undefined) {
    state().own.clear();
    state().sources.clear();
  } else {
    state().own.delete(linkId);
    state().sources.delete(linkId);
  }
}

/** The link's client for reads (the pull, the knowledge walk, the check). Not scoped: reads go only where the caller walks. */
export const readClient = (link: Pick<LinkRow, 'credential_id' | 'rps'>): NotionClient => notionClientFor({ credentialId: link.credential_id, rps: link.rps });

/** The link's client for writes: the scoped writer over the read client, with what this process has seen as own. */
export function linkClient(link: Pick<LinkRow, 'id' | 'root_page_id' | 'credential_id' | 'rps'>, base: NotionClient = readClient(link)): NotionClient {
  return scopedWriter(base, { rootId: link.root_page_id, ownIds: (id) => isOwn(link.id, id), ownDataSources: sourceSet(link.id) });
}

async function parentIsOwn(link: LinkRow, parent: NotionParent, client: NotionClient): Promise<boolean> {
  if (parent.type === 'page_id') return sameId(parent.page_id, link.root_page_id) || (sameId(parent.page_id, link.brain_page_id ?? undefined) && (await verifyOwn(link, parent.page_id, client)));
  if (parent.type === 'data_source_id') return verifyDataSource(link, parent.data_source_id, client);
  if (parent.type === 'database_id') return verifyDatabase(link, parent.database_id, client);
  return false;
}

async function verifyDatabase(link: LinkRow, id: string, client: NotionClient): Promise<boolean> {
  if (isOwn(link.id, id)) return true;
  if (!Object.values(linkDatabases(link)).some((db) => sameId(db!.databaseId, id))) return false;
  const found = await client.database(id);
  const ok = !found.in_trash && found.parent.type === 'page_id' && sameId(found.parent.page_id, link.brain_page_id ?? undefined) && (await verifyOwn(link, found.parent.page_id, client));
  if (ok) markOwn(link.id, id);
  return ok;
}

async function verifyDataSource(link: LinkRow, id: string, client: NotionClient): Promise<boolean> {
  if ([...sourceSet(link.id)].some((own) => sameId(own, id))) return true;
  if (!Object.values(linkDatabases(link)).some((db) => sameId(db!.dataSourceId, id))) return false;
  const found = await client.dataSource(id);
  const ok = !found.in_trash && (await verifyDatabase(link, found.parent.database_id, client));
  if (ok) markOwn(link.id, id, 'dataSource');
  return ok;
}

/**
 * Whether `id` is Landflow's under this link: the brain page, Log, a page the items name, or one of the link's databases or
 * data sources, AND (once per process) its parent chain reaches the brain page and the root. Reads only (at most a few GETs
 * the first time); never throws on a mismatch: it answers false and the write that follows is refused by the scoped writer.
 */
export async function verifyOwn(link: LinkRow, id: string, client: NotionClient = readClient(link)): Promise<boolean> {
  if (isOwn(link.id, id)) return true;
  if (Object.values(linkDatabases(link)).some((db) => sameId(db!.dataSourceId, id))) return verifyDataSource(link, id, client);
  if (Object.values(linkDatabases(link)).some((db) => sameId(db!.databaseId, id))) return verifyDatabase(link, id, client);
  const named = sameId(id, link.brain_page_id ?? undefined) || sameId(id, link.log_page_id ?? undefined) || Boolean(itemByNotionId(link.id, id));
  if (!named) return false;
  const page = await client.page(id);
  const ok = !page.in_trash && (sameId(id, link.brain_page_id ?? undefined) ? page.parent.type === 'page_id' && sameId(page.parent.page_id, link.root_page_id) : await parentIsOwn(link, page.parent, client));
  if (ok) markOwn(link.id, id);
  return ok;
}

// ---------------------------------------------------------------------------------------------------- hooks

/**
 * A step the service (NB04) runs for each link it syncs, once per tick after the outbox: the pull (NB05) and the knowledge walk
 * (NB06). `force` is Sync now (`next_sync_at` due); otherwise the step returns at once until its own interval has passed (2
 * minutes for the pull, 15 for the walk). The service never runs two ticks at once, and skips a stopped link.
 */
export type SyncStep = (link: LinkRow, options: { force: boolean }) => Promise<void>;

/**
 * A person changed the part of a page Landflow writes (NB04's push saw `no_match` or `validation_error`, or NB05's pull saw the
 * region differ from `pushed_region`). `before` is the region Landflow last wrote, `after` what Notion has now. NB05 files
 * the suggestion (one per page per day); the caller puts the region back.
 */
export type RegionConflict = (input: { link: LinkRow; item: ItemRow; before: string; after: string; editedBy?: string; editedAt?: string }) => void | Promise<void>;

export const setPullStep = (step: SyncStep | undefined): void => void (state().pull = step);
export const pullStep = (): SyncStep | undefined => state().pull;
export const setKnowledgeStep = (step: SyncStep | undefined): void => void (state().knowledge = step);
export const knowledgeStep = (): SyncStep | undefined => state().knowledge;
export const setRegionConflict = (fn: RegionConflict | undefined): void => void (state().conflict = fn);
export const regionConflict = (): RegionConflict | undefined => state().conflict;
