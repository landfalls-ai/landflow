/**
 * Pushing one object (docs/features/notion-brain.md#what-landflow-writes): render it from the local state as it is now, skip
 * it when nothing changed since the last push, else create its row (after asking Notion whether a row with its `Landflow ID`
 * is there already), update its properties and the part of its body between the markers, or move its row to trash when the
 * object is gone. Every write goes through `linkClient` (the scoped writer); an object the scoped writer refuses ends in an
 * error on its outbox row and never stops the next object.
 *
 * The outbox row says which object changed, never what to do: the push reads the current local state, so a delete that
 * arrives for an object that still exists is a refresh, and a change that was already pushed is a no-op.
 */
import { ITEM_DATABASE, type ItemKind, type ItemRow, type OutboxKind, itemOf, linkClient, linkDatabases, markOwn, pageBody, saveItem, splitBody, verifyOwn, wholeBody, regionConflict } from './sync';
import { parseEntityRef } from '../../../shared/brain';
import { LANDFLOW_ID } from '../../../shared/notion-brain';
import { database } from '../../db';
import { isNotionError, type NotionClient, type NotionPage } from '../../notion/port';
import { logger } from '../../telemetry/logger';
import { getFact, listFacts } from '../facts';
import { entityKey, getEntity, listEntities } from '../entities';
import { getPractice, listPractices } from '../../practices/store';
import { noteStore } from '../../notebook/store';
import { addProblem, type LinkRow } from './links';
import { checkStillShared } from './status';
import { hashOf, hashesOf, homeRegion, logRegion, packHash, propertiesById, renderEntity, renderFact, renderNote, renderPractice, unpackHash, type RenderSession, type Rendered } from './render';

export type PushResult = 'written' | 'unchanged' | 'skipped';

export interface PushEnv {
  link: LinkRow;
  /** The scoped writer over the link's client: every write goes through it. */
  client: NotionClient;
  session: RenderSession;
}

export const pushEnv = (link: LinkRow, session: RenderSession): PushEnv => ({ link, client: linkClient(link), session });

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------- loading

/** What the link's project holds that a copy sends (the same rules as `projectCounts`), by key. */
export function localKeys(link: LinkRow): Record<ItemKind, string[]> {
  const db = database();
  return {
    entity: listEntities({ projectId: link.project_id, limit: 1_000_000 }).map((e) => entityKey(e)),
    fact: listFacts({ status: 'active', limit: 1_000_000 }).filter((f) => f.projectId === link.project_id).map((f) => f.id),
    practice: listPractices({ projectId: link.project_id, status: ['draft', 'approved'], limit: 1_000_000 }).map((p) => p.id),
    note: db.all<{ id: string }>("SELECT id FROM team_notes WHERE project_id = ? AND scope = 'project' ORDER BY created_at, id", link.project_id).map((r) => r.id),
  };
}

/** The object as the link's project holds it now; undefined: it is gone, or it is not this project's to send. */
export function loadRendered(kind: ItemKind, key: string, env: PushEnv, hasItem: boolean): Rendered | undefined {
  const { link, session } = env;
  if (kind === 'entity') {
    const ref = parseEntityRef(key);
    const entity = ref ? getEntity(ref.type, ref.id) : undefined;
    return entity && entity.projectId === link.project_id ? renderEntity(entity, session) : undefined;
  }
  if (kind === 'fact') {
    const fact = getFact(key);
    if (!fact || fact.projectId !== link.project_id) return undefined;
    return fact.status === 'active' || hasItem ? renderFact(fact, session) : undefined;
  }
  if (kind === 'practice') {
    const practice = getPractice(key);
    if (!practice || practice.level !== 'project' || practice.projectId !== link.project_id) return undefined;
    return practice.status !== 'retired' || hasItem ? renderPractice(practice) : undefined;
  }
  const note = noteStore.get(key);
  return note && note.scope === 'project' && note.projectId === link.project_id ? renderNote(note) : undefined;
}

// ---------------------------------------------------------------------------------------------------- rows

const plain = (page: NotionPage, propertyId: string): string =>
  (page.properties?.[propertyId] ?? Object.values(page.properties ?? {}).find((p) => p.id === propertyId))?.rich_text?.map((r) => r.plain_text ?? r.text?.content ?? '').join('') ?? '';

/** The row of this data source whose `Landflow ID` is `key`, if any (a create that landed but whose answer was lost). */
export async function findRow(client: NotionClient, dataSourceId: string, idProperty: string, key: string): Promise<NotionPage | undefined> {
  const found = await client.queryDataSource(dataSourceId, { filter: { property: idProperty, rich_text: { equals: key } }, page_size: 2 });
  return found.results.find((row) => !row.in_trash && plain(row, idProperty) === key);
}

/** Every live row of a data source by its `Landflow ID` (one query a page of 100). */
export async function rowsByKey(client: NotionClient, dataSourceId: string, idProperty: string): Promise<Map<string, NotionPage>> {
  const rows = new Map<string, NotionPage>();
  for await (const row of client.paginate((cursor) => client.queryDataSource(dataSourceId, { page_size: 100, ...(cursor && { start_cursor: cursor }) }))) {
    const key = plain(row, idProperty);
    if (key && !row.in_trash) rows.set(key, row);
  }
  return rows;
}

/** Creates a row; if the create may have landed, looks for it by `Landflow ID` before trying once more. */
async function createRow(env: PushEnv, kind: ItemKind, key: string, rendered: Rendered, withBody: boolean): Promise<NotionPage> {
  const db = linkDatabases(env.link)[ITEM_DATABASE[kind]]!;
  const idProperty = db.properties[LANDFLOW_ID];
  const make = () =>
    env.client.createPage({
      parent: { data_source_id: db.dataSourceId },
      properties: propertiesById(db, { ...rendered.person, ...rendered.landflow }),
      ...(withBody && rendered.region !== undefined && { markdown: pageBody(rendered.region) }),
    });
  try {
    return await make();
  } catch (error) {
    if (!isNotionError(error) || !error.mayHaveLanded) throw error;
    const landed = idProperty ? await findRow(env.client, db.dataSourceId, idProperty, key) : undefined;
    if (landed) return landed;
    return make();
  }
}

/** Writes a row's body: `update_content` from the region last written, or (none yet) from what the page holds. Returns the region as Notion answered. */
async function writeBody(env: PushEnv, item: ItemRow, region: string): Promise<string> {
  const { client } = env;
  const id = item.notion_id;
  let before = item.pushed_region;
  // The copy made this row with no body: `''` says so, and the first body is written whole without a read.
  if (before === '') {
    const answer = await client.updateMarkdown(id, { type: 'replace_content', replace_content: { new_str: pageBody(region) } });
    return splitBody(answer.markdown).region ?? region;
  }
  if (before === null) {
    const current = await client.pageMarkdown(id);
    const parts = splitBody(current.markdown);
    if (parts.region === undefined) {
      // Nothing of Landflow's there yet: the body is empty (a row made with properties only) or a person's own text, which becomes "Your notes".
      const answer = await client.updateMarkdown(id, { type: 'replace_content', replace_content: { new_str: pageBody(region, parts.notes) } });
      return splitBody(answer.markdown).region ?? region;
    }
    before = parts.region;
  }
  if (before === region) return region;
  let answer;
  try {
    answer = await client.updateMarkdown(id, { type: 'update_content', update_content: { content_updates: [{ old_str: before, new_str: region }] } });
    if (!answer.warnings?.some((w) => w.code === 'no_match')) {
      const written = splitBody(answer.markdown).region ?? region;
      // The old text was found but something a person added next to it stayed: the page does not say what we meant.
      if (written === region) return region;
    }
  } catch (error) {
    if (!isNotionError(error) || (error.kind !== 'invalid' && !error.mayHaveLanded)) throw error;
  }
  return putBack(env, item, before, region);
}

/**
 * The text Landflow last wrote is not on the page: a person edited it (or our write landed and its answer was lost). Read the
 * page: if it already says what we meant, that is all; else tell NB05's hook (or file a problem), and write the region back
 * with the notes just read.
 */
async function putBack(env: PushEnv, item: ItemRow, before: string, region: string): Promise<string> {
  const { client, link } = env;
  const current = await client.pageMarkdown(item.notion_id);
  const parts = splitBody(current.markdown);
  if (parts.region === region) return region;
  if (parts.region === before) throw new Error('Notion refused the body and the page still holds the last text');
  const hook = regionConflict();
  if (hook) await hook({ link, item, before, after: parts.region ?? current.markdown });
  else {
    logger.warn('[notion-brain] a person changed the part of a page Landflow writes', { linkId: link.id, notionId: item.notion_id });
    addProblem({ linkId: link.id, kind: 'landflow_part_edited', notionId: item.notion_id, localKey: item.local_key, detail: 'A part of this page that Landflow writes was changed in Notion and put back.' });
  }
  const answer = await client.updateMarkdown(item.notion_id, { type: 'replace_content', replace_content: { new_str: pageBody(region, parts.notes) } });
  return splitBody(answer.markdown).region ?? region;
}

// ---------------------------------------------------------------------------------------------------- one object

/** Push one row-shaped object (an entity, a fact, a practice, a note). */
export async function pushItem(env: PushEnv, kind: ItemKind, key: string, options: { known?: boolean } = {}): Promise<PushResult> {
  const { link } = env;
  const item = itemOf(link.id, kind, key);
  const rendered = loadRendered(kind, key, env, Boolean(item));
  if (!rendered) return item && item.state !== 'detached' ? trashItem(env, item) : 'skipped';
  if (item?.state === 'detached') return 'skipped';
  const db = linkDatabases(link)[ITEM_DATABASE[kind]];
  if (!db) throw new Error('The copy has not made this database yet');
  const hashes = hashesOf(rendered);

  if (!item) {
    // A row that landed before (its answer was lost, or a Landflow brain from before) is adopted by its Landflow ID.
    // Once per process: the data source is seen under the brain page before a row is made in it.
    await verifyOwn(link, db.dataSourceId, env.client);
    const idProperty = db.properties[LANDFLOW_ID];
    const existing = idProperty && !options.known ? await findRow(env.client, db.dataSourceId, idProperty, key) : undefined;
    const withBody = rendered.region !== undefined;
    const page = existing ?? (await createRow(env, kind, key, rendered, withBody));
    markOwn(link.id, page.id);
    const adopted = Boolean(existing);
    const saved = saveItem({ link_id: link.id, kind, local_key: key, notion_id: page.id, pushed_hash: null, pushed_region: null, pushed_at: null, seen_edited_at: page.last_edited_time ?? null, pulled_hash: null, state: 'ok' });
    if (adopted) return updateItem(env, saved, rendered);
    // One read after a create with a body: the region as Notion answered is what a later edit is compared with.
    const region = withBody ? (splitBody((await env.client.pageMarkdown(page.id)).markdown).region ?? rendered.region) : null;
    saveItem({ ...saved, pushed_hash: packHash(hashes), pushed_region: region ?? null, pushed_at: now() });
    return 'written';
  }
  return updateItem(env, item, rendered);
}

async function updateItem(env: PushEnv, item: ItemRow, rendered: Rendered): Promise<PushResult> {
  const { link, client } = env;
  const db = linkDatabases(link)[ITEM_DATABASE[item.kind]]!;
  const hashes = hashesOf(rendered);
  const before = unpackHash(item.pushed_hash);
  const properties: Record<string, unknown> = {};
  if (!before || before.person !== hashes.person) Object.assign(properties, rendered.person);
  if (!before || before.landflow !== hashes.landflow) Object.assign(properties, rendered.landflow);
  const bodyChanged = rendered.region !== undefined && (!before || before.body !== hashes.body);
  if (!Object.keys(properties).length && !bodyChanged) return 'unchanged';

  try {
    await verifyOwn(link, item.notion_id, client);
    let saved = item;
    if (Object.keys(properties).length) {
      await client.updatePage(item.notion_id, { properties: propertiesById(db, properties) });
      // Properties are in: remember them even if the body below fails.
      saved = saveItem({ ...saved, pushed_hash: packHash({ ...hashes, body: before?.body ?? '' }), pushed_at: now() });
    }
    if (bodyChanged) {
      const region = await writeBody(env, saved, rendered.region!);
      saveItem({ ...saved, pushed_hash: packHash(hashes), pushed_region: region, pushed_at: now() });
    }
  } catch (error) {
    if (isNotionError(error) && error.kind === 'notFound') {
      // The row is gone from Notion, or the whole page is no longer shared.
      await checkStillShared(link);
      saveItem({ ...item, state: 'detached' });
      return 'skipped';
    }
    throw error;
  }
  return 'written';
}

/** The object is gone (or not this project's): its row goes to trash in Notion, the one thing Landflow ever deletes there. */
async function trashItem(env: PushEnv, item: ItemRow): Promise<PushResult> {
  await verifyOwn(env.link, item.notion_id, env.client);
  try {
    await env.client.updatePage(item.notion_id, { in_trash: true });
  } catch (error) {
    if (!isNotionError(error) || error.kind !== 'notFound') throw error;
  }
  database().delete('notion_brain_items', { link_id: item.link_id, kind: item.kind, local_key: item.local_key });
  return 'written';
}

// ---------------------------------------------------------------------------------------------------- Home and Log

/** Home and Log are wholly Landflow's: written between the markers with `update_content`, never a bare `replace_content` (the brain page holds Log and the four databases). */
export async function pushWhole(env: PushEnv, kind: 'home' | 'log'): Promise<PushResult> {
  const { link, client, session } = env;
  const pageId = kind === 'home' ? link.brain_page_id : link.log_page_id;
  if (!pageId) throw new Error(`The copy has not made the ${kind === 'home' ? 'brain page' : 'Log page'} yet`);
  const region = kind === 'home' ? homeRegion(session.home(), session.ctx) : logRegion(session.home(), session.ctx);
  const hash = hashOf(region);
  const item = itemOf(link.id, kind as unknown as ItemKind, '');
  if (item && unpackHash(item.pushed_hash)?.body === hash) return 'unchanged';
  let written: string;
  try {
    await verifyOwn(link, pageId, client); // NB07: inside the try, so a gone brain page after a restart reaches checkStillShared
    written = await writeWhole(env, pageId, item?.pushed_region ?? null, region);
  } catch (error) {
    // The brain page is trashed or no longer shared: say so for the whole link instead of backing off forever.
    if (isNotionError(error) && error.kind === 'notFound') await checkStillShared(link);
    throw error;
  }
  saveItem({ link_id: link.id, kind: kind as unknown as ItemKind, local_key: '', notion_id: pageId, pushed_hash: packHash({ person: '', landflow: '', body: hash }), pushed_region: written, pushed_at: now(), seen_edited_at: item?.seen_edited_at ?? null, pulled_hash: item?.pulled_hash ?? null, state: 'ok' });
  return 'written';
}

const childLines = (markdown: string) => markdown.split('\n').filter((line) => /^<(page|database) url="/.test(line));

async function writeWhole(env: PushEnv, pageId: string, before: string | null, region: string): Promise<string> {
  const { client } = env;
  const answerRegion = (markdown: string) => splitBody(markdown).region ?? region;
  if (before !== null) {
    if (before === region) return region;
    try {
      const answer = await client.updateMarkdown(pageId, { type: 'update_content', update_content: { content_updates: [{ old_str: before, new_str: region }] } });
      if (!answer.warnings?.some((w) => w.code === 'no_match')) return answerRegion(answer.markdown);
    } catch (error) {
      if (!isNotionError(error) || (error.kind !== 'invalid' && !error.mayHaveLanded)) throw error;
    }
  }
  // Not what we last wrote (a person edited it, or nothing was written yet): read what is there and put the region back.
  const current = await client.pageMarkdown(pageId);
  const parts = splitBody(current.markdown);
  if (parts.region === region) return region;
  if (parts.region !== undefined) {
    const answer = await client.updateMarkdown(pageId, { type: 'update_content', update_content: { content_updates: [{ old_str: parts.region, new_str: region }] } });
    return answerRegion(answer.markdown);
  }
  // The markers are gone: write them again, keeping the child pages and databases the page lists.
  const kept = childLines(current.markdown).join('\n');
  const answer = await client.updateMarkdown(pageId, { type: 'replace_content', replace_content: { new_str: `${wholeBody(region)}${kept ? `\n${kept}\n` : ''}` } });
  return answerRegion(answer.markdown);
}

/** Pushes whatever an outbox row names. */
export function pushOutboxRow(env: PushEnv, kind: OutboxKind, key: string): Promise<PushResult> {
  return kind === 'home' || kind === 'log' ? pushWhole(env, kind) : pushItem(env, kind, key);
}

