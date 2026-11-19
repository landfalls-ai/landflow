/**
 * Test helper for the Notion pull (NB05): the linked state a pull starts from, seeded the way the copy leaves it. No copy exists in
 * this tree (NB04 builds it), so the root page, the link row, the brain page, the four databases, the rows and their items are made
 * here through the real client against the fake Notion. Import it after the test set its environment.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATABASES, DATABASE_KINDS, LANDFLOW_ID, type DatabaseKind } from '@/lib/shared/notion-brain';
import { notionClientFor, type NotionClient } from '@/lib/server/notion/port';
import { createLink, updateLink, type LinkRow } from '@/lib/server/brain/notion/links';
import { schemaOf } from '@/lib/server/brain/notion/problems';
import { markOwn, pageBody, saveItem, splitBody, type ItemKind, type LinkDatabases } from '@/lib/server/brain/notion/sync';
import { upsertEntity } from '@/lib/server/brain/entities';
import type { FakeNotion } from './fake-notion';

export const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'notion-render', name), 'utf8');
export const KESTREL_REGION = splitBody(fixture('kestrel-bank.md')).region!;
export const ANA_REGION = splitBody(fixture('ana.md')).region!;

export const rt = (content: string) => ({
  rich_text: [{ type: 'text', text: { content } }],
});
export const title = (content: string) => ({
  title: [{ type: 'text', text: { content } }],
});
export const select = (name: string) => ({ select: { name } });

export interface Seeded {
  link: LinkRow;
  root: string;
  brain: string;
  dbs: LinkDatabases;
  client: NotionClient;
  /** Database id by kind (what `fake.addRow` takes). */
  database: Record<DatabaseKind, string>;
}

export async function seedLink(fake: FakeNotion, credentialId: string, projectId: string): Promise<Seeded> {
  const client = notionClientFor({ credentialId, rps: 8 });
  const root = fake.addPage({ title: 'Company wiki', shared: true });
  const link = createLink({
    projectId,
    credentialId,
    rootPageId: root,
    rootTitle: 'Company wiki',
    botId: fake.state.bot.id,
    botName: fake.state.bot.name,
  });
  const brain = await client.createPage({
    parent: { page_id: root },
    properties: { title: title('Landflow brain · test') },
  });
  markOwn(link.id, brain.id);
  const dbs: LinkDatabases = {};
  const database = {} as Record<DatabaseKind, string>;
  for (const kind of DATABASE_KINDS) {
    const made = await client.createDatabase({
      parent: { page_id: brain.id },
      title: DATABASES[kind].title,
      properties: Object.fromEntries(DATABASES[kind].properties.map((spec) => [spec.name, schemaOf(spec, dbs.pages?.dataSourceId)])),
    });
    markOwn(link.id, made.databaseId);
    markOwn(link.id, made.dataSourceId, 'dataSource');
    dbs[kind] = {
      databaseId: made.databaseId,
      dataSourceId: made.dataSourceId,
      properties: made.propertyIds,
    };
    database[kind] = made.databaseId;
  }
  const active = updateLink(link.id, {
    status: 'active',
    brain_page_id: brain.id,
    databases: JSON.stringify(dbs),
    bot_id: fake.state.bot.id,
  })!;
  return { link: active, root, brain: brain.id, dbs, client, database };
}

/** An item the way the copy leaves it: pushed (its region as written, a hash), not yet pulled. `pushedAt` is now, as after a real push. */
export function seedItem(s: Seeded, kind: ItemKind, localKey: string, notionId: string, region: string | null, pushedAt = new Date().toISOString()) {
  markOwn(s.link.id, notionId);
  return saveItem({
    link_id: s.link.id,
    kind,
    local_key: localKey,
    notion_id: notionId,
    pushed_hash: 'pushed',
    pushed_region: region,
    pushed_at: pushedAt,
    seen_edited_at: null,
    pulled_hash: null,
    state: 'ok',
  });
}

/** A page of the project: the entity, and its Notion row with the region as Landflow wrote it. */
export async function seedPage(
  s: Seeded,
  input: {
    type: string;
    id: string;
    name: string;
    description?: string;
    owner?: string;
    attrs?: Record<string, unknown>;
  },
  region = KESTREL_REGION,
  pushedAt?: string,
) {
  const { entity } = upsertEntity({
    ...input,
    projectId: s.link.project_id,
    source: 'study',
  });
  const attrs = Object.entries(entity.attrs)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const row = await s.client.createPage({
    parent: { data_source_id: s.dbs.pages!.dataSourceId },
    properties: {
      Name: title(entity.name),
      Type: select(entity.type),
      Description: rt(entity.description ?? ''),
      Owner: rt(entity.owner ?? ''),
      Attributes: rt(attrs),
      [LANDFLOW_ID]: rt(`${entity.type}/${entity.id}`),
    },
    markdown: pageBody(region),
  });
  const item = seedItem(s, 'entity', `${entity.type}/${entity.id}`, row.id, region, pushedAt);
  return { entity, row: row.id, ref: `${entity.type}/${entity.id}`, item };
}
