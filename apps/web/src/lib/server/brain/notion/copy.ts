/**
 * The initial copy (docs/features/notion-brain.md#the-first-copy): under the page the person named, one "Landflow brain" page
 * (its body Home), a Log page, four databases (Pages, Facts, Practices, Notebook), then a row for every page of the project
 * and its body, every fact, practice and note, and last Home and Log written whole.
 *
 * It is resumable and never duplicates. Every id Notion answers is recorded at once (the link, the items); a copy that starts
 * again finds what is there before it creates anything: the brain page's children are matched by title (the brain page
 * itself under the root), each data source's rows by `Landflow ID` (one query a database). A create whose answer was lost is
 * found the same way. All writes go through `linkClient`, the scoped writer.
 */
import { type CopyProgress, DATABASE_KINDS, DATABASES, LANDFLOW_ID, LOG_PAGE_TITLE, brainPageTitle, type DatabaseKind } from '../../../shared/notion-brain';
import { ITEM_DATABASE, itemOf, linkClient, linkDatabases, markOwn, saveItem, splitBody, verifyOwn, wholeBody, type ItemKind, type LinkDatabases } from './sync';
import { getProject } from '../../projects/store';
import { isNotionError, notionClientFor, type NotionBlock, type NotionClient } from '../../notion/port';
import { richText } from '../../notion/text';
import { logger } from '../../telemetry/logger';
import { linkById, setCopyProgress, updateLink, type LinkRow } from './links';
import { changeStatus } from './status';
import { LOG_PLACEHOLDER, databaseSchema, hashesOf, introRegion, packHash, propertiesById, renderEntity, sessionFor } from './render';
import { parseEntityRef } from '../../../shared/brain';
import { getEntity } from '../entities';
import { findRow, localKeys, pushEnv, pushItem, pushWhole, rowsByKey, type PushEnv } from './push';

const now = () => new Date().toISOString();

/** Brain-page children by title, as the last listing saw them. */
type Children = Array<{ id: string; title: string; type: 'page' | 'database' }>;

async function listChildren(client: NotionClient, parentId: string): Promise<Children> {
  const out: Children = [];
  for await (const block of client.paginate((cursor) => client.children(parentId, cursor))) {
    if (block.in_trash) continue;
    const entry = (b: NotionBlock) => (b.type === 'child_page' ? { type: 'page' as const, title: b.child_page?.title ?? '' } : b.type === 'child_database' ? { type: 'database' as const, title: b.child_database?.title ?? '' } : undefined);
    const found = entry(block);
    if (found) out.push({ id: block.id, ...found });
  }
  return out;
}

/** Runs the copy of one link as far as it gets. Throws what stopped it; the next call continues where this one ended. */
export async function runCopy(initial: LinkRow): Promise<void> {
  const project = getProject(initial.project_id);
  if (!project) return;
  let link = initial;
  const fresh = () => (link = linkById(link.id) ?? link);
  if (link.status === 'setting_up') link = changeStatus(link.id, 'copying') ?? link;
  const client = linkClient(link);
  const session = sessionFor(link);
  const keys = localKeys(link);
  const progress = (phase: CopyProgress['phase'], done: number, of: number) => void setCopyProgress(link.id, { phase, done, total: of });
  const readOnly = notionClientFor({ credentialId: link.credential_id, rps: link.rps });

  // ---- the brain page under the root, then Log ---------------------------------------------------------------
  progress('pages', 0, 2);
  let rootChildren: Children | undefined;
  let brainChildren: Children | undefined;
  let createdBrain = false;

  if (link.brain_page_id) {
    if (!(await verifyOwn(link, link.brain_page_id, client))) throw new Error('The brain page is not under the root any more');
  } else {
    const title = brainPageTitle(project.name);
    rootChildren = await listChildren(readOnly, link.root_page_id);
    const named = rootChildren.find((c) => c.type === 'page' && c.title === title);
    if (named) {
      markOwn(link.id, named.id);
      link = updateLink(link.id, { brain_page_id: named.id }) ?? link;
    } else {
      const make = () => client.createPage({ parent: { page_id: link.root_page_id }, properties: { title: { title: richText(title) } }, markdown: wholeBody(introRegion()) });
      let page;
      try {
        page = await make();
      } catch (error) {
        if (!isNotionError(error) || !error.mayHaveLanded) throw error;
        const landed = (await listChildren(readOnly, link.root_page_id)).find((c) => c.type === 'page' && c.title === title);
        page = landed ? { id: landed.id } : await make();
      }
      markOwn(link.id, page.id);
      link = updateLink(link.id, { brain_page_id: page.id }) ?? link;
      createdBrain = true;
      const region = splitBody((await client.pageMarkdown(page.id)).markdown).region ?? introRegion();
      saveItem({ link_id: link.id, kind: 'home' as ItemKind, local_key: '', notion_id: page.id, pushed_hash: null, pushed_region: region, pushed_at: now(), seen_edited_at: null, pulled_hash: null, state: 'ok' });
    }
  }
  const brainId = link.brain_page_id!;
  const children = async () => (brainChildren ??= createdBrain ? [] : await listChildren(readOnly, brainId));

  if (link.log_page_id) {
    if (!(await verifyOwn(link, link.log_page_id, client))) throw new Error('The Log page is not under the brain page any more');
  } else {
    const named = (await children()).find((c) => c.type === 'page' && c.title === LOG_PAGE_TITLE);
    let id = named?.id;
    if (id) markOwn(link.id, id);
    else {
      const make = () => client.createPage({ parent: { page_id: brainId }, properties: { title: { title: richText(LOG_PAGE_TITLE) } }, markdown: wholeBody(LOG_PLACEHOLDER) });
      let page;
      try {
        page = await make();
      } catch (error) {
        if (!isNotionError(error) || !error.mayHaveLanded) throw error;
        brainChildren = undefined;
        const landed = (await children()).find((c) => c.type === 'page' && c.title === LOG_PAGE_TITLE);
        page = landed ? { id: landed.id } : await make();
      }
      id = page.id;
      markOwn(link.id, id);
      const region = splitBody((await client.pageMarkdown(id)).markdown).region ?? LOG_PLACEHOLDER;
      saveItem({ link_id: link.id, kind: 'log' as ItemKind, local_key: '', notion_id: id, pushed_hash: null, pushed_region: region, pushed_at: now(), seen_edited_at: null, pulled_hash: null, state: 'ok' });
    }
    link = updateLink(link.id, { log_page_id: id }) ?? link;
  }
  progress('pages', 2, 2);

  // ---- the four databases -----------------------------------------------------------------------------------
  const madeHere = new Set<DatabaseKind>();
  progress('databases', 0, DATABASE_KINDS.length);
  for (const [index, kind] of DATABASE_KINDS.entries()) {
    const known = linkDatabases(fresh())[kind];
    if (known) {
      if (!(await verifyOwn(link, known.dataSourceId, client))) throw new Error(`The ${DATABASES[kind].title} database is not under the brain page any more`);
    } else {
      const spec = DATABASES[kind];
      const pagesSource = linkDatabases(link).pages?.dataSourceId;
      let made: { databaseId: string; dataSourceId: string; propertyIds: Record<string, string> } | undefined;
      const adopt = async (): Promise<typeof made> => {
        brainChildren = undefined;
        const named = (await children()).find((c) => c.type === 'database' && c.title === spec.title);
        if (!named) return undefined;
        const database = await readOnly.database(named.id);
        const sourceId = database.data_sources?.[0]?.id;
        if (!sourceId) return undefined;
        const source = await readOnly.dataSource(sourceId);
        if (!(LANDFLOW_ID in source.properties)) return undefined;
        return { databaseId: named.id, dataSourceId: sourceId, propertyIds: Object.fromEntries(Object.entries(source.properties).map(([name, property]) => [name, property.id])) };
      };
      // A database a copy that stopped made, or a Landflow brain from before: found by title before anything is created.
      made = createdBrain ? undefined : await adopt();
      if (!made) {
        try {
          made = await client.createDatabase({ parent: { page_id: brainId }, title: spec.title, properties: databaseSchema(kind, pagesSource) });
        } catch (error) {
          if (!isNotionError(error) || !error.mayHaveLanded) throw error;
          made = await adopt();
          if (!made) throw error;
        }
        madeHere.add(kind);
      }
      markOwn(link.id, made.databaseId);
      markOwn(link.id, made.dataSourceId, 'dataSource');
      const next: LinkDatabases = { ...linkDatabases(fresh()), [kind]: { databaseId: made.databaseId, dataSourceId: made.dataSourceId, properties: made.propertyIds } };
      link = updateLink(link.id, { databases: JSON.stringify(next) }) ?? link;
    }
    progress('databases', index + 1, DATABASE_KINDS.length);
  }

  // The link as the pages and databases above left it: what every push below reads.
  const env: PushEnv = { ...pushEnv(fresh(), session), client };

  // ---- rows: what a database already holds is adopted by Landflow ID (one query a database) ---------------------
  const dbs = linkDatabases(fresh());
  for (const kind of DATABASE_KINDS) {
    const db = dbs[kind]!;
    if (madeHere.has(kind)) continue;
    const idProperty = db.properties[LANDFLOW_ID];
    if (!idProperty) continue;
    const itemKind = (Object.entries(ITEM_DATABASE).find(([, value]) => value === kind)![0] as ItemKind);
    const rows = await rowsByKey(readOnly, db.dataSourceId, idProperty);
    const wanted = new Set(keys[itemKind]);
    for (const [key, row] of rows) {
      markOwn(link.id, row.id);
      if (wanted.has(key) && !itemOf(link.id, itemKind, key)) {
        saveItem({ link_id: link.id, kind: itemKind, local_key: key, notion_id: row.id, pushed_hash: null, pushed_region: null, pushed_at: null, seen_edited_at: row.last_edited_time ?? null, pulled_hash: null, state: 'ok' });
      }
    }
  }

  // ---- rows (properties only), then bodies ------------------------------------------------------------------
  const pagesDb = dbs.pages!;
  let done = 0;
  progress('rows', 0, keys.entity.length);
  for (const key of keys.entity) {
    done++;
    if (itemOf(link.id, 'entity', key)) continue;
    const ref = parseEntityRef(key);
    const entity = ref ? getEntity(ref.type, ref.id) : undefined;
    if (!entity) continue;
    const rendered = renderEntity(entity, session, { body: false });
    const page = await createRowOnly(env, key, rendered, pagesDb.properties);
    markOwn(link.id, page.id);
    saveItem({ link_id: link.id, kind: 'entity', local_key: key, notion_id: page.id, pushed_hash: packHash({ ...hashesOf(rendered), body: '' }), pushed_region: '', pushed_at: now(), seen_edited_at: page.last_edited_time ?? null, pulled_hash: null, state: 'ok' });
    progress('rows', done, keys.entity.length);
  }
  done = 0;
  progress('bodies', 0, keys.entity.length);
  for (const key of keys.entity) {
    done++;
    const item = itemOf(link.id, 'entity', key);
    if (item && (item.pushed_region === null || item.pushed_region === '')) await pushItem(env, 'entity', key, { known: true });
    progress('bodies', done, keys.entity.length);
  }

  // ---- facts, practices, notes (the row carries all there is) -------------------------------------------------
  for (const [phase, kind] of [['facts', 'fact'], ['practices', 'practice'], ['notes', 'note']] as const) {
    done = 0;
    progress(phase, 0, keys[kind].length);
    for (const key of keys[kind]) {
      done++;
      if (!itemOf(link.id, kind, key)) await pushItem(env, kind, key, { known: true });
      progress(phase, done, keys[kind].length);
    }
  }

  // ---- Home and Log, whole ------------------------------------------------------------------------------------
  progress('home', 0, 2);
  await pushWhole(env, 'home');
  await pushWhole(env, 'log');
  progress('done', 1, 1);
  updateLink(link.id, { last_push_at: now(), last_error: null });
  changeStatus(link.id, 'active');
  logger.info('[notion-brain] the first copy is done', { linkId: link.id, pages: keys.entity.length, facts: keys.fact.length, practices: keys.practice.length, notes: keys.note.length });
}

/** A row with its properties only (its body waits until every page has a row to mention). A create whose answer was lost is looked up by Landflow ID. */
async function createRowOnly(env: PushEnv, key: string, rendered: ReturnType<typeof renderEntity>, ids: Record<string, string>) {
  const { link, client } = env;
  const db = linkDatabases(link).pages!;
  const make = () => client.createPage({ parent: { data_source_id: db.dataSourceId }, properties: propertiesById({ ...db, properties: ids }, { ...rendered.person, ...rendered.landflow }) });
  try {
    return await make();
  } catch (error) {
    if (!isNotionError(error) || !error.mayHaveLanded) throw error;
    const idProperty = ids[LANDFLOW_ID];
    const landed = idProperty ? await findRow(client, db.dataSourceId, idProperty, key) : undefined;
    return landed ?? make();
  }
}
