/**
 * NB05: conflicts and problems (docs/features/notion-brain.md#conflicts): a person edits the part of a page Landflow writes (one
 * suggestion a day, the region put back), both sides edit a person-owned field (the later one wins, the other goes to the audit
 * log), and the actions on a problem (repair, put back, delete in Landflow, keep as a fact) with the instance switch. The only
 * Notion is the local fake; a re-push is asserted as an outbox row (NB04's push is not in this tree).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { FAKE_NOTION_TOKEN, startFakeNotion, type FakeNotion } from './fake-notion';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-notion-conflicts-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
  LANDFLOW_BRAIN_MODEL: 'off',
  LANDFLOW_BRAIN_EMBEDDINGS: 'off',
  LANDFLOW_PUBLIC_URL: 'http://conflicts.test',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/brain/store');
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const { getEntity } = await import('@/lib/server/brain/entities');
const { brainStoreFor } = await import('@/lib/server/brain/store/port');
const { searchFacts } = await import('@/lib/server/brain/facts');
const { listProposals } = await import('@/lib/server/brain/proposals');
const { wikiPage } = await import('@/lib/server/brain/wiki');
const links = await import('@/lib/server/brain/notion/links');
const sync = await import('@/lib/server/brain/notion/sync');
const { pullLink } = await import('@/lib/server/brain/notion/pull');
const { addedLines } = await import('@/lib/server/brain/notion/conflicts');
const problemRoute = await import('@/app/api/projects/[id]/brain/notion/problems/[problemId]/route');
const { NOTION_EVIDENCE_LABEL } = await import('@/lib/shared/brain');
const { LANDFLOW_ID } = await import('@/lib/shared/notion-brain');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const seed = await import('./notion-pull-seed');
const { rt, title } = seed;

registry.registerBuiltin(
  definePlugin({
    info: {
      id: 'productivity',
      name: 'Productivity (stand-in)',
      version: '0.0.0',
      language: 'typescript',
    },
    nodes: [],
    credentialTypes: [
      defineCredentialType({
        name: 'notionApi',
        displayName: 'Notion API',
        properties: [
          {
            name: 'apiKey',
            displayName: 'Internal Integration Secret',
            type: 'string',
            required: true,
            typeOptions: { password: true },
          },
          {
            name: 'baseUrl',
            displayName: 'API Base URL',
            type: 'string',
            default: 'https://api.notion.com',
          },
        ],
      }),
    ],
  }),
);

let fake: FakeNotion;
let clock = Date.now() - 20 * 60_000;
let credential = '';
let counter = 0;

beforeAll(async () => {
  fake = await startFakeNotion({ now: () => clock });
  credential = credentials.create({
    name: 'Notion',
    type: 'productivity.notionApi',
    data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url },
  }).id;
});
afterAll(async () => {
  delete process.env.LANDFLOW_NOTION_BRAIN;
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function setup() {
  const project = projects.createTeamProject({
    name: `Conflicts ${++counter}`,
  });
  const s = await seed.seedLink(fake, credential, project.id);
  const pull = () => pullLink(links.linkById(s.link.id)!, { force: true });
  return { ...s, project: project.id, pull };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const tick = () => {
  clock += 60_000;
};
// Wave nb2 integration: NB04's listener also marks Home and Log due after any change (its own behaviour, tested in NB04's tests); these assertions are about the objects queued.
const outbox = (s: Setup) => database().all<{ kind: string; local_key: string }>("SELECT kind, local_key FROM notion_brain_outbox WHERE link_id = ? AND kind NOT IN ('home', 'log') ORDER BY local_key", s.link.id);
const regionSuggestions = (s: Setup) => listProposals({ status: 'open', limit: 100 }).filter((p) => p.fingerprint.startsWith(`notion-brain:region:${s.link.id}:`));
const req = (url: string, body: unknown) =>
  new Request(`http://conflicts.test${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
const act = (s: Setup, problemId: string, action: string) =>
  problemRoute.POST(
    req(`/api/projects/${s.project}/brain/notion/problems/${problemId}`, {
      action,
    }),
    { params: Promise.resolve({ id: s.project, problemId }) },
  );

describe('the region of a page', () => {
  it('a region edited in Notion is put back (queued), filed as one suggestion and one problem, and a second edit the same day only updates the diff', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'kestrel-bank',
      name: 'Kestrel Bank',
    });
    await s.pull();
    tick();
    fake.editAsPerson(page.row, {
      markdown: sync.pageBody(`${seed.KESTREL_REGION}\nKestrel also pays by wire only.`),
    });
    await s.pull();
    expect(outbox(s)).toEqual([{ kind: 'entity', local_key: 'customer/kestrel-bank' }]);
    // The region NB04 replaces is what Notion holds now, and nothing is skipped as unchanged.
    const item = sync.itemOf(s.link.id, 'entity', 'customer/kestrel-bank')!;
    expect(item.pushed_hash).toBeNull();
    expect(item.pushed_region).toContain('Kestrel also pays by wire only.');
    const suggestions = regionSuggestions(s);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      source: 'analyst',
      label: 'Notion brain',
      projectId: s.project,
      target: {
        type: 'entity',
        id: 'customer/kestrel-bank',
        name: 'Kestrel Bank',
      },
      title: 'Someone changed the summary of Kestrel Bank in Notion',
    });
    expect(suggestions[0].evidence[0]).toEqual({
      label: 'Changed in Notion',
      value: 'Kestrel also pays by wire only.',
    });
    expect(suggestions[0].fingerprint).toBe(`notion-brain:region:${s.link.id}:customer/kestrel-bank:${new Date().toISOString().slice(0, 10)}`);
    const problems = links.problems(s.link.id);
    expect(problems.map((p) => [p.kind, p.local_key])).toEqual([['landflow_part_edited', 'customer/kestrel-bank']]);
    expect(problems[0].detail).not.toContain('wire');
    expect(queryEvents({ action: ['notion-brain.region'] }).events.some((e) => e.target?.id === 'customer/kestrel-bank')).toBe(true);
    // The same day again: still one suggestion, the diff is the new one.
    tick();
    fake.editAsPerson(page.row, {
      markdown: sync.pageBody(`${seed.KESTREL_REGION}\nKestrel also pays by wire only.\nAnd settles on Fridays.`),
    });
    await s.pull();
    const again = regionSuggestions(s);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(suggestions[0].id);
    expect(again[0].evidence[0].value).toBe('And settles on Fridays.');
    expect(links.problems(s.link.id)).toHaveLength(1);
  });

  it('"Keep as a fact" on the problem adds a fact with the text from the suggestion, and an unchanged region files nothing', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'kestrel-bank',
      name: 'Kestrel Bank',
    });
    await s.pull();
    expect(regionSuggestions(s)).toEqual([]);
    tick();
    fake.editAsPerson(page.row, {
      markdown: sync.pageBody(`${seed.KESTREL_REGION}\nKestrel pays by wire only.`),
    });
    await s.pull();
    const [problem] = links.problems(s.link.id);
    const done = await act(s, problem.id, 'keepAsFact');
    expect(done.status).toBe(200);
    const facts = searchFacts('wire', {});
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      statement: 'Kestrel pays by wire only.',
      subjectId: 'customer/kestrel-bank',
      projectId: s.project,
    });
    expect(facts[0].evidence).toEqual([expect.objectContaining({ label: NOTION_EVIDENCE_LABEL })]);
    expect(links.problems(s.link.id)).toEqual([]);
  });

  it('two Notion edits in a row, pulled one at a time, are not a both-sides conflict', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, { type: 'customer', id: 'twice', name: 'Twice', description: 'Original' });
    await s.pull();
    clock = Date.now() + 60_000;
    fake.editAsPerson(page.row, { properties: { Description: rt('First Notion edit') } });
    await s.pull();
    clock = Date.now() + 60_000;
    fake.editAsPerson(page.row, { properties: { Description: rt('Second Notion edit') } });
    await s.pull();
    expect(getEntity('customer', 'twice')!.description).toBe('Second Notion edit');
    expect(queryEvents({ action: ['notion-brain.overwrite'], targetId: 'customer/twice' }).events).toHaveLength(0);
    expect(wikiPage(getEntity('customer', 'twice')!, undefined, { id: TEST_OWNER.id } as never, true).changedInNotion).toBeUndefined();
  });

  it('"Keep as a fact" after lines were only removed adds no fact', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, { type: 'customer', id: 'kestrel-bank', name: 'Kestrel Bank' });
    await s.pull();
    tick();
    fake.editAsPerson(page.row, { markdown: sync.pageBody('') });
    await s.pull();
    const [problem] = links.problems(s.link.id);
    expect(problem).toBeTruthy();
    const done = await act(s, problem.id, 'keepAsFact');
    expect(done.status).toBe(409);
    expect(searchFacts('removed', {})).toHaveLength(0);
  });

  it('is what the sync registers for the push to call on a no_match', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'pushed-conflict',
      name: 'Pushed Conflict',
    });
    const item = sync.itemOf(s.link.id, 'entity', 'customer/pushed-conflict')!;
    await sync.regionConflict()!({
      link: s.link,
      item,
      before: 'old line',
      after: 'old line\nnew line',
      editedBy: 'Ana Ruiz',
    });
    expect(regionSuggestions(s)[0].title).toBe('Ana Ruiz changed the summary of Pushed Conflict in Notion');
    expect(page.row).toBeTruthy();
    expect(addedLines('a\nb', 'a\nc\nd')).toBe('c\nd');
    expect(addedLines('a\nb', 'a').length).toBeGreaterThan(0);
    expect(addedLines('x', `${'y'.repeat(600)}`).length).toBe(500);
  });
});

describe('both sides edited', () => {
  it('Notion later: Notion wins, Landflow’s value is in the audit row, and the page shows "changed in Notion"', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'both-a',
      name: 'Both A',
      description: 'Original',
    });
    await s.pull();
    // Landflow edits (its updated_at is now); the push has not run (its item says pushed long ago).
    sync.saveItem({
      ...sync.itemOf(s.link.id, 'entity', 'customer/both-a')!,
      pushed_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    brainStoreFor(s.project).upsertEntity({
        type: 'customer',
        id: 'both-a',
        description: 'Edited in Landflow',
      });
    clock = Date.now() + 5 * 60_000;
    fake.editAsPerson(page.row, {
      properties: { Description: rt('Edited in Notion') },
    });
    await s.pull();
    expect(getEntity('customer', 'both-a')!.description).toBe('Edited in Notion');
    const row = queryEvents({
      action: ['notion-brain.overwrite'],
      targetId: 'customer/both-a',
    }).events[0];
    expect(row.details).toMatchObject({
      field: 'description',
      winner: 'notion',
      replaced: 'Edited in Landflow',
    });
    const page2 = wikiPage(getEntity('customer', 'both-a')!, undefined, { id: TEST_OWNER.id } as never, true);
    expect(page2.changedInNotion).toMatchObject({ by: 'A Notion user' });
    expect(Date.now() - Date.parse(page2.changedInNotion!.at)).toBeLessThan(60_000);
    // 8 days later it is gone.
    expect(wikiPage(getEntity('customer', 'both-a')!, undefined, { id: TEST_OWNER.id } as never, true, database(), Date.now() + 8 * 86_400_000).changedInNotion).toBeUndefined();
  });

  it('Landflow later: Landflow keeps its value (queued to be written), and Notion’s is in the audit row', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'both-b',
      name: 'Both B',
      description: 'Original',
    });
    await s.pull();
    sync.saveItem({
      ...sync.itemOf(s.link.id, 'entity', 'customer/both-b')!,
      pushed_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    clock = Date.now() - 10 * 60_000;
    fake.editAsPerson(page.row, {
      properties: { Description: rt('Edited in Notion earlier') },
    });
    brainStoreFor(s.project).upsertEntity({
      type: 'customer',
      id: 'both-b',
      description: 'Edited in Landflow later',
    });
    await s.pull();
    expect(getEntity('customer', 'both-b')!.description).toBe('Edited in Landflow later');
    expect(outbox(s)).toEqual([{ kind: 'entity', local_key: 'customer/both-b' }]);
    const row = queryEvents({
      action: ['notion-brain.overwrite'],
      targetId: 'customer/both-b',
    }).events[0];
    expect(row.details).toMatchObject({
      field: 'description',
      winner: 'landflow',
      replaced: 'Edited in Notion earlier',
    });
    expect(wikiPage(getEntity('customer', 'both-b')!, undefined, { id: TEST_OWNER.id } as never, true).changedInNotion).toBeUndefined();
  });
});

describe('problem actions', () => {
  async function trashed() {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'gone-co',
      name: 'Gone Co',
    });
    await s.pull();
    fake.trash(page.row);
    await s.pull();
    // Wave nb2 integration: what NB04's push would have sent by now (Landflow's own writes during the setup) is drained.
    database().delete('notion_brain_outbox', { link_id: s.link.id });
    const [problem] = links.problems(s.link.id);
    expect(problem.kind).toBe('trashed_in_notion');
    return { s, page, problem };
  }

  it('putBack makes a new row, points the item at it, owns it and queues the push', async () => {
    const { s, page, problem } = await trashed();
    const before = fake.writes().length;
    const response = await act(s, problem.id, 'putBack');
    expect(response.status).toBe(200);
    const item = sync.itemOf(s.link.id, 'entity', 'customer/gone-co')!;
    expect(item.notion_id).not.toBe(page.row);
    expect(item.state).toBe('ok');
    expect(item.pushed_region).toBeNull();
    expect(fake.value(item.notion_id, 'Name')).toBe('Gone Co');
    expect(fake.value(item.notion_id, LANDFLOW_ID)).toBe('customer/gone-co');
    expect(sync.isOwn(s.link.id, item.notion_id)).toBe(true);
    expect(fake.writes().length).toBe(before + 1);
    expect(outbox(s)).toEqual([{ kind: 'entity', local_key: 'customer/gone-co' }]);
    expect(links.problems(s.link.id)).toEqual([]);
    await s.pull(); // the new row is a normal row now
    expect(getEntity('customer', 'gone-co')).toBeTruthy();
    expect(links.problems(s.link.id)).toEqual([]);
  });

  it('deleteLocal deletes the entity and its item', async () => {
    const { s, problem } = await trashed();
    const response = await act(s, problem.id, 'deleteLocal');
    expect(response.status).toBe(200);
    expect(getEntity('customer', 'gone-co')).toBeUndefined();
    expect(sync.itemOf(s.link.id, 'entity', 'customer/gone-co')).toBeUndefined();
  });

  it('with LANDFLOW_NOTION_BRAIN=off an action answers 409 SWITCHED_OFF and the problem stays; with it on, 200', async () => {
    const { s, problem } = await trashed();
    process.env.LANDFLOW_NOTION_BRAIN = 'off';
    try {
      const off = await act(s, problem.id, 'deleteLocal');
      expect(off.status).toBe(409);
      expect(((await off.json()) as { error: string }).error).toBe(links.SWITCHED_OFF);
      expect(getEntity('customer', 'gone-co')).toBeTruthy();
      expect(links.problems(s.link.id)).toHaveLength(1);
    } finally {
      delete process.env.LANDFLOW_NOTION_BRAIN;
    }
    expect((await act(s, problem.id, 'deleteLocal')).status).toBe(200);
  });

  it('repair adds the removed properties back, refreshes the ids and lets the link sync again', async () => {
    const s = await setup();
    await seed.seedPage(s, {
      type: 'customer',
      id: 'repair-co',
      name: 'Repair Co',
    });
    fake.removeProperty(s.database.pages, 'Teams');
    fake.removeProperty(s.database.pages, LANDFLOW_ID);
    await s.pull();
    expect(links.linkById(s.link.id)!.status).toBe('needs_repair');
    const [problem] = links.problems(s.link.id).filter((p) => p.local_key === `pages:${LANDFLOW_ID}`);
    const response = await act(s, problem.id, 'repair');
    expect(response.status).toBe(200);
    const after = links.linkById(s.link.id)!;
    expect(after.status).toBe('active');
    const ds = fake.state.databases.get(s.database.pages)!;
    expect(Object.keys(ds.properties)).toEqual(expect.arrayContaining(['Teams', LANDFLOW_ID]));
    expect(sync.linkDatabases(after).pages!.properties[LANDFLOW_ID]).toBe(ds.properties[LANDFLOW_ID].id);
    expect(links.problems(s.link.id)).toEqual([]);
    await s.pull();
    expect(links.linkById(s.link.id)!.status).toBe('active');
  });
});
