/**
 * What a person can do about a sync problem (docs/features/notion-brain.md#problems): the performer behind the problem route's
 * `repair`, `putBack`, `deleteLocal` and `keepAsFact` (`dismiss` needs none). Registered with `setProblemActions` when this module
 * loads (pull.ts imports it). Every write goes through `linkClient`, so it can only land under the root.
 *
 * - `repair` (admins): adds the properties a person removed back to their data source (the same schema the copy made), refreshes
 *   the link's property ids and lets the link sync again.
 * - `putBack`: makes a new Notion row for a trashed one (the item is pointed at it) and asks the push to write the rest.
 * - `deleteLocal` (admins): deletes the object in Landflow (a page or a fact; never a practice or a note).
 * - `keepAsFact`: the text a person wrote in the part Landflow writes becomes a fact of the page, read from the suggestion's evidence.
 */
import { NOTION_EVIDENCE_LABEL, type FactKind } from '../../../shared/brain';
import { DATABASES, DATABASE_KINDS, LANDFLOW_ID, type DatabaseKind, type PropertySpec } from '../../../shared/notion-brain';
import { HttpError } from '../../errors';
import { database } from '../../db';
import { noteStore } from '../../notebook/store';
import type { NotionPropertySchema } from '../../notion/port';
import { getPractice } from '../../practices/store';
import { getEntity } from '../entities';
import { deleteFact, getFact } from '../facts';
import { brainStoreFor } from '../store/port';
import { suggestedText } from './conflicts';
import { setProblemActions, updateLink, type LinkRow, type ProblemActionContext, type ProblemRow } from './links';
import { changeStatus } from './status';
import { ITEM_DATABASE, enqueue, itemByNotionId, linkClient, linkDatabases, markOwn, readClient, saveItem, verifyOwn, type ItemRow, type LinkDatabases } from './sync';

const gone = (message: string) => new HttpError(message, 409, { expose: true });

/** A property as the copy made it (a type's key only, options for selects, the Pages data source for About). */
export function schemaOf(spec: PropertySpec, pagesSource?: string): NotionPropertySchema {
  switch (spec.type) {
    case 'select':
      return {
        select: { options: (spec.options ?? []).map((name) => ({ name })) },
      };
    case 'multi_select':
      return {
        multi_select: {
          options: (spec.options ?? []).map((name) => ({ name })),
        },
      };
    case 'number':
      return { number: { format: 'number' } };
    case 'relation':
      return {
        relation: {
          data_source_id: pagesSource ?? '',
          type: 'single_property',
          single_property: {},
        },
      };
    case 'title':
    case 'rich_text':
    case 'checkbox':
    case 'date':
    case 'url':
      return { [spec.type]: {} } as NotionPropertySchema;
  }
}

async function repair(link: LinkRow): Promise<void> {
  const client = readClient(link);
  const writer = linkClient(link, client);
  const dbs = linkDatabases(link);
  const next: LinkDatabases = { ...dbs };
  for (const kind of DATABASE_KINDS) {
    const db = dbs[kind];
    if (!db) continue;
    if (!(await verifyOwn(link, db.dataSourceId, client))) throw gone(`The ${DATABASES[kind].title} database is not under this link’s page any more`);
    const source = await client.dataSource(db.dataSourceId);
    const ids = new Set(Object.values(source.properties).map((p) => p.id));
    const names = new Set(Object.keys(source.properties));
    const missing = DATABASES[kind].properties.filter((spec) => !ids.has(db.properties[spec.name] ?? '') && !names.has(spec.name) && !spec.required);
    const required = DATABASES[kind].properties.filter((spec) => spec.required && !ids.has(db.properties[spec.name] ?? '') && !names.has(spec.name));
    // A removed title property cannot be added back (a data source always has one): the other required ones are.
    const adds = [...missing, ...required.filter((spec) => spec.type !== 'title')];
    if (adds.length)
      await writer.updateDataSource(db.dataSourceId, {
        properties: Object.fromEntries(adds.map((spec) => [spec.name, schemaOf(spec, dbs.pages?.dataSourceId)])),
      });
    const after = await client.dataSource(db.dataSourceId);
    const properties = { ...db.properties };
    for (const spec of DATABASES[kind].properties) {
      const found = after.properties[spec.name] ?? Object.values(after.properties).find((p) => p.id === db.properties[spec.name]);
      if (found) properties[spec.name] = found.id;
    }
    next[kind] = { ...db, properties };
  }
  updateLink(link.id, { databases: JSON.stringify(next) });
  changeStatus(link.id, 'active');
  // The other open schema problems of this link are settled by the repair.
  const open = database().all<ProblemRow>("SELECT * FROM notion_brain_problems WHERE link_id = ? AND kind = 'schema_changed' AND resolved_at IS NULL", link.id);
  for (const p of open)
    database().upsert('notion_brain_problems', {
      ...p,
      resolved_by: 'system',
      resolved_action: 'repair',
      resolved_at: new Date().toISOString(),
    } as never);
}

/** The name of a local object, as its Notion row's title: what a re-created row is made with. */
function titleOf(item: ItemRow): string | undefined {
  if (item.kind === 'entity') {
    const [type, id] = item.local_key.split('/');
    return type && id ? getEntity(type, id)?.name : undefined;
  }
  if (item.kind === 'fact') return getFact(item.local_key)?.statement;
  if (item.kind === 'practice') return getPractice(item.local_key)?.title;
  return noteStore.get(item.local_key)?.text;
}

const TITLE_PROPERTY: Record<DatabaseKind, string> = {
  pages: 'Name',
  facts: 'Statement',
  practices: 'Title',
  notebook: 'Text',
};

async function putBack(link: LinkRow, problem: ProblemRow): Promise<void> {
  const item = problem.notion_id ? itemByNotionId(link.id, problem.notion_id) : undefined;
  if (!item) throw gone('Landflow no longer knows that row');
  const title = titleOf(item);
  if (!title) throw gone('The object this row was made from is gone from Landflow');
  const kind = ITEM_DATABASE[item.kind];
  const db = linkDatabases(link)[kind];
  if (!db) throw gone(`The ${DATABASES[kind].title} database is not set up`);
  const client = readClient(link);
  if (!(await verifyOwn(link, db.dataSourceId, client))) throw gone(`The ${DATABASES[kind].title} database is not under this link’s page any more`);
  const page = await linkClient(link, client).createPage({
    parent: { data_source_id: db.dataSourceId },
    properties: {
      [db.properties[TITLE_PROPERTY[kind]] ?? TITLE_PROPERTY[kind]]: {
        title: [{ type: 'text', text: { content: title.slice(0, 2_000) } }],
      },
      [db.properties[LANDFLOW_ID] ?? LANDFLOW_ID]: {
        rich_text: [{ type: 'text', text: { content: item.local_key } }],
      },
    },
  });
  markOwn(link.id, page.id);
  // The item points at the new row; nothing of it is known as written yet, so the push writes every property and the body again.
  saveItem({
    ...item,
    notion_id: page.id,
    state: 'ok',
    pushed_hash: null,
    pushed_region: null,
    pushed_at: null,
    seen_edited_at: null,
    pulled_hash: null,
  });
  enqueue(link.id, item.kind, item.local_key);
}

function deleteLocal(link: LinkRow, problem: ProblemRow): void {
  const item = problem.notion_id ? itemByNotionId(link.id, problem.notion_id) : undefined;
  if (!item) throw gone('Landflow no longer knows that row');
  if (item.kind === 'entity') {
    const [type, id] = item.local_key.split('/');
    brainStoreFor(link.project_id).deleteEntity(type, id);
  } else if (item.kind === 'fact') {
    deleteFact(item.local_key);
  } else {
    throw new HttpError(item.kind === 'practice' ? 'Retire a practice in Landflow; it is never deleted from here' : 'Delete a note in Landflow, on its team’s notebook', 400, { expose: true });
  }
  database().delete('notion_brain_items', {
    link_id: link.id,
    kind: item.kind,
    local_key: item.local_key,
  });
  database().delete('notion_knowledge_docs', {
    link_id: link.id,
    page_id: item.notion_id,
  });
}

function keepAsFact(link: LinkRow, problem: ProblemRow): void {
  const found = problem.local_key ? suggestedText(link, problem.local_key) : undefined;
  if (!found) throw gone('The suggestion with that text is gone');
  const [type, id] = found.ref.split('/');
  const entity = type && id ? getEntity(type, id) : undefined;
  if (!entity) throw gone('The page it is about is gone from Landflow');
  const kind: FactKind = 'purpose';
  brainStoreFor(link.project_id).addFact(entity, {
    kind,
    statement: found.text,
    evidence: [{ label: NOTION_EVIDENCE_LABEL, ...(found.url && { href: found.url }) }],
  });
}

setProblemActions(async ({ link, problem, action }: ProblemActionContext) => {
  if (action === 'repair') return repair(link);
  if (action === 'putBack') return putBack(link, problem);
  if (action === 'deleteLocal') return deleteLocal(link, problem);
  return keepAsFact(link, problem);
});
