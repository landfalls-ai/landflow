/**
 * NB05: what people edit in the linked Notion pages comes back (docs/features/notion-brain.md#what-comes-back-from-notion), each
 * field by its owner's rule: names, descriptions, owners and attributes, "Your notes", new pages, facts, notes for a team and
 * practice changes as tainted drafts; trash, schema and the capped query; and nb1's carryover (a practice approval emits after its
 * transaction, the inbox says "a linked Notion page", a note's author). The only Notion is the local fake; the linked state is
 * seeded by hand (notion-pull-seed.ts): NB04's copy and push are not in this tree, so a re-push is asserted as an outbox row.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import type { BrainChange } from '@/lib/shared/brain-store';
import { FAKE_NOTION_TOKEN, startFakeNotion, type FakeNotion } from './fake-notion';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-notion-pull-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
  LANDFLOW_BRAIN_MODEL: 'off',
  LANDFLOW_BRAIN_EMBEDDINGS: 'off',
  LANDFLOW_PUBLIC_URL: 'http://pull.test',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/brain/store');
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createUser } = await import('@/lib/server/auth/users');
const projects = await import('@/lib/server/projects');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const { logger } = await import('@/lib/server/telemetry');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { onBrainChange, brainStoreFor } = await import('@/lib/server/brain/store/port');
const { getEntity, listEntities } = await import('@/lib/server/brain/entities');
const { searchFacts, getFact } = await import('@/lib/server/brain/facts');
const { listProposals } = await import('@/lib/server/brain/proposals');
const links = await import('@/lib/server/brain/notion/links');
const sync = await import('@/lib/server/brain/notion/sync');
const service = await import('@/lib/server/brain/notion/service');
const { pullLink, parseAttributes, parsePracticeRegion } = await import('@/lib/server/brain/notion/pull');
const practicesStore = await import('@/lib/server/practices/store');
const approve = await import('@/lib/server/practices/approve');
const { PracticeNeedsReview } = await import('@/lib/server/practices/errors');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { noteStore } = await import('@/lib/server/notebook/store');
const notebook = await import('@/lib/server/notebook/service');
const { LANDFLOW_ID } = await import('@/lib/shared/notion-brain');
const { NOTION_EVIDENCE_LABEL } = await import('@/lib/shared/brain');
const seed = await import('./notion-pull-seed');
const { rt, select, title } = seed;

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
const output: string[] = [];
const heard: BrainChange[] = [];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

beforeAll(async () => {
  fake = await startFakeNotion({ queryCap: 5, now: () => clock });
  credential = credentials.create({
    name: 'Notion',
    type: 'productivity.notionApi',
    data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url },
  }).id;
  onBrainChange((c) => heard.push(c));
  for (const level of ['warn', 'info', 'error', 'debug'] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      output.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
  }
});
afterAll(async () => {
  await fake.close();
  vi.restoreAllMocks();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** A new project with its own link, seeded. */
async function setup() {
  const project = projects.createTeamProject({ name: `Pull ${++counter}` });
  const s = await seed.seedLink(fake, credential, project.id);
  const pull = (force = true) => pullLink(links.linkById(s.link.id)!, { force });
  return { ...s, project: project.id, pull };
}
type Setup = Awaited<ReturnType<typeof setup>>;
// Wave nb2 integration: NB04's listener also marks Home and Log due after any change (its own behaviour, tested in NB04's tests); these assertions are about the objects queued.
const outbox = (s: Setup) => database().all<{ kind: string; local_key: string }>("SELECT kind, local_key FROM notion_brain_outbox WHERE link_id = ? AND kind NOT IN ('home', 'log') ORDER BY local_key", s.link.id);
const problemKinds = (s: Setup) => links.problems(s.link.id).map((p) => p.kind);
/** NB04's status notices for this link (status.ts: one brain suggestion per link and status). */
const statusNotices = (s: Setup) => listProposals({ status: 'open', limit: 200 }).filter((p) => p.fingerprint.startsWith(`notion-brain:${s.link.id}:`));
const reads = () => fake.state.requests.filter((r) => r.method === 'GET' && r.template === '/v1/pages/:id/markdown').length;
/** The next minute: edit times are rounded to the minute, so an edit after a pull needs a later stamp than the pull saw. */
const tick = () => {
  clock += 60_000;
};

describe('names, descriptions, owners and attributes', () => {
  it('a rename, a description and attributes come back, and nothing is written back to Notion', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'kestrel-bank',
      name: 'Kestrel Bank',
      description: 'A bank',
      owner: 'Ana',
      attrs: { tier: 'gold' },
    });
    await s.pull(); // the baseline
    heard.length = 0;
    const writes = fake.writes().length;
    tick();
    fake.editAsPerson(page.row, {
      properties: {
        Name: title('Kestrel Group'),
        Description: rt('A group of banks'),
        Owner: rt('Ben'),
        Attributes: rt('tier: platinum\nregion: emea'),
      },
    });
    await s.pull();
    await flush();
    const entity = getEntity('customer', 'kestrel-bank')!;
    expect(entity).toMatchObject({
      name: 'Kestrel Group',
      description: 'A group of banks',
      owner: 'Ben',
      attrs: { tier: 'platinum', region: 'emea' },
    });
    expect(heard.filter((c) => c.kind === 'entity')).toEqual([
      expect.objectContaining({
        key: 'customer/kestrel-bank',
        origin: 'notion',
        projectId: s.project,
      }),
    ]);
    expect(fake.writes().length).toBe(writes); // echo-free: nothing went back for those fields
    expect(outbox(s)).toEqual([]);
  });

  it('a bad Attributes line is a problem and the other lines are kept', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'system',
      id: 'ledger',
      name: 'Ledger',
      attrs: { tier: 'a' },
    });
    await s.pull();
    tick();
    fake.editAsPerson(page.row, {
      properties: {
        Attributes: rt('tier: b\nthis is not an attribute\nowner_team: core'),
      },
    });
    await s.pull();
    expect(getEntity('system', 'ledger')!.attrs).toEqual({
      tier: 'b',
      owner_team: 'core',
    });
    expect(problemKinds(s)).toContain('bad_attribute');
    expect(links.problems(s.link.id)[0].detail).not.toContain('this is not an attribute');
  });

  it('the bot’s own writes change nothing locally and queue nothing', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'bot-co',
      name: 'Bot Co',
      description: 'Written by Landflow',
    });
    const before = getEntity('customer', 'bot-co')!;
    heard.length = 0;
    await s.pull();
    await s.pull();
    await flush();
    expect(getEntity('customer', 'bot-co')).toEqual(before);
    expect(heard).toEqual([]);
    expect(outbox(s)).toEqual([]);
    expect(page.row).toBeTruthy();
  });

  it('a changed Type is put back with a problem; a changed Landflow-owned property is put back', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'typed',
      name: 'Typed',
    });
    await s.pull();
    tick();
    fake.editAsPerson(page.row, { properties: { Type: select('system') } });
    await s.pull();
    expect(getEntity('customer', 'typed')).toBeTruthy();
    expect(getEntity('system', 'typed')).toBeUndefined();
    expect(problemKinds(s)).toContain('type_changed');
    expect(outbox(s)).toEqual([{ kind: 'entity', local_key: 'customer/typed' }]);
  });

  it('an edit made by a Notion user whose email is a Landflow user is attributed to that user (with the email capability)', async () => {
    const userFake = await startFakeNotion({
      userEmails: true,
      now: () => clock,
    });
    const cred = credentials.create({
      name: 'Notion email',
      type: 'productivity.notionApi',
      data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: userFake.url },
    }).id;
    const ana = await createUser({
      email: 'ana@pull.test',
      name: 'Ana Ruiz',
      role: 'member',
      password: 'ana-password-1',
    });
    const project = projects.createTeamProject({ name: `Email ${++counter}` });
    const s = await seed.seedLink(userFake, cred, project.id);
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'emailed',
      name: 'Emailed',
    });
    await pullLink(links.linkById(s.link.id)!, { force: true });
    const person = userFake.addPerson('Ana R.', 'ana@pull.test');
    heard.length = 0;
    userFake.editAsPerson(page.row, {
      properties: { Name: title('Emailed Co') },
      by: person,
    });
    await pullLink(links.linkById(s.link.id)!, { force: true });
    await flush();
    expect(heard.find((c) => c.kind === 'entity')).toMatchObject({
      origin: 'notion',
      by: ana.id,
    });
    await userFake.close();
  });

  it('without the email capability nobody is named', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'anon',
      name: 'Anon',
    });
    await s.pull();
    heard.length = 0;
    tick();
    fake.editAsPerson(page.row, { properties: { Name: title('Anon Co') } });
    await s.pull();
    await flush();
    const change = heard.find((c) => c.kind === 'entity')!;
    expect(change.origin).toBe('notion');
    expect(change.by).toBeUndefined();
  });
});

describe('Your notes', () => {
  it('the text under "Your notes" is a knowledge doc, unredacted, at most 4,000 characters, and a second pull reads no Markdown', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'noted',
      name: 'Noted Co',
    });
    const notes = 'Ana prefers calls.   Call before 10.\n\nSecond paragraph with a key sk-live-1234567890abcdef and an email ben@acme.test.';
    tick();
    fake.editAsPerson(page.row, {
      markdown: seed.fixture('kestrel-bank.md').replace(/## Your notes\s*$/, `## Your notes\n${notes}\n`),
    });
    await s.pull();
    const doc = database().get<Record<string, unknown>>('SELECT * FROM notion_knowledge_docs WHERE link_id = ? AND page_id = ?', s.link.id, page.row)!;
    expect(doc).toMatchObject({
      title: 'Noted Co · Your notes',
      path: 'Pages / Noted Co',
      markdown: notes,
      truncated: 0,
    });
    expect(String(doc.url)).toContain(page.row.replace(/-/g, ''));
    const before = reads();
    await s.pull();
    expect(reads()).toBe(before);
    // Long notes are cut at 4,000 characters and say so; emptying the notes removes the doc.
    tick();
    fake.editAsPerson(page.row, {
      markdown: seed.fixture('kestrel-bank.md').replace(/## Your notes\s*$/, `## Your notes\n${'x'.repeat(5_000)}\n`),
    });
    await s.pull();
    expect(database().get<{ markdown: string; truncated: number }>('SELECT markdown, truncated FROM notion_knowledge_docs WHERE link_id = ? AND page_id = ?', s.link.id, page.row)).toMatchObject({
      markdown: 'x'.repeat(4_000),
      truncated: 1,
    });
    tick();
    fake.editAsPerson(page.row, { markdown: seed.fixture('kestrel-bank.md') });
    await s.pull();
    expect(database().get('SELECT 1 AS x FROM notion_knowledge_docs WHERE link_id = ? AND page_id = ?', s.link.id, page.row)).toBeUndefined();
  });

  it('a body with the markers gone: the notes are what is left once the region is cut out, and the region is queued to be written again', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'unmarked',
      name: 'Unmarked',
    });
    tick();
    fake.editAsPerson(page.row, {
      markdown: `My own heading\n\n${seed.KESTREL_REGION}\n\nAnd a note.`,
    });
    await s.pull();
    const doc = database().get<{ markdown: string }>('SELECT markdown FROM notion_knowledge_docs WHERE link_id = ? AND page_id = ?', s.link.id, page.row)!;
    expect(doc.markdown).toBe('My own heading\n\nAnd a note.');
    expect(outbox(s)).toEqual([{ kind: 'entity', local_key: 'customer/unmarked' }]);
    expect(problemKinds(s)).toEqual([]);
  });
});

describe('new pages', () => {
  it('a row with no Landflow ID is a new entity of the project, its ID is written back, and a second pull does not duplicate it', async () => {
    const s = await setup();
    const row = fake.addRow(
      s.database.pages,
      {
        Name: title('Orion Pay'),
        Type: select('customer'),
        Description: rt('A payments startup'),
        Attributes: rt('tier: silver'),
      },
      'Met them at the summit.',
    );
    await s.pull();
    const made = listEntities({ projectId: s.project }).filter((e) => e.name === 'Orion Pay');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      type: 'customer',
      description: 'A payments startup',
      source: 'notion',
      projectId: s.project,
      attrs: { tier: 'silver' },
    });
    const ref = `customer/${made[0].id}`;
    expect(fake.value(row, LANDFLOW_ID)).toBe(ref);
    expect(sync.itemByNotionId(s.link.id, row)).toMatchObject({
      kind: 'entity',
      local_key: ref,
    });
    expect(outbox(s)).toEqual([{ kind: 'entity', local_key: ref }]);
    expect(database().get<{ markdown: string }>('SELECT markdown FROM notion_knowledge_docs WHERE link_id = ? AND page_id = ?', s.link.id, row)!.markdown).toBe('Met them at the summit.');
    await s.pull();
    expect(listEntities({ projectId: s.project }).filter((e) => e.name === 'Orion Pay')).toHaveLength(1);
  });

  it('a row with no valid Type is an initiative and says so; a row with no name waits', async () => {
    const s = await setup();
    fake.addRow(s.database.pages, { Name: title('Typeless') });
    fake.addRow(s.database.pages, {});
    await s.pull();
    expect(listEntities({ projectId: s.project }).map((e) => [e.name, e.type])).toEqual([['Typeless', 'initiative']]);
    expect(problemKinds(s)).toEqual(['type_changed']);
  });

  it('more rows than the fake’s incomplete cap: the window is halved until every row is read', async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) {
      clock = Date.now() - (60 - i * 3) * 60_000;
      fake.addRow(s.database.pages, {
        Name: title(`Bulk ${i}`),
        Type: select('system'),
      });
    }
    const queries = fake.state.requests.length;
    await s.pull();
    expect(listEntities({ projectId: s.project }).filter((e) => e.name.startsWith('Bulk '))).toHaveLength(12);
    expect(fake.state.requests.slice(queries).filter((r) => r.template === '/v1/data_sources/:id/query').length).toBeGreaterThan(4);
  });
});

describe('facts', () => {
  it('a fact row with About is a fact searchFacts returns, with the Notion evidence; without About it is a problem and nothing is written', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'kestrel-bank',
      name: 'Kestrel Bank',
    });
    await s.pull();
    const row = fake.addRow(s.database.facts, {
      Statement: title('Kestrel pays by wire only'),
      Kind: select('purpose'),
      About: { relation: [{ id: page.row }] },
    });
    const orphan = fake.addRow(s.database.facts, {
      Statement: title('Nobody knows what this is about'),
    });
    await s.pull();
    const found = searchFacts('wire', {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      statement: 'Kestrel pays by wire only',
      subjectId: 'customer/kestrel-bank',
      projectId: s.project,
    });
    expect(found[0].evidence).toEqual([
      expect.objectContaining({
        label: NOTION_EVIDENCE_LABEL,
        href: expect.stringContaining(row.replace(/-/g, '')),
      }),
    ]);
    expect(fake.value(row, LANDFLOW_ID)).toBe(found[0].id);
    expect(outbox(s)).toContainEqual({ kind: 'fact', local_key: found[0].id });
    expect(fake.value(orphan, LANDFLOW_ID)).toBe('');
    expect(searchFacts('knows', {})).toEqual([]);
    expect(problemKinds(s)).toEqual(['fact_without_page']);
    await s.pull();
    expect(searchFacts('wire', {})).toHaveLength(1);
  });

  it('a change to a study fact’s statement is put back and offers "Keep as a fact"; a person’s own fact takes the edit', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'facty',
      name: 'Facty',
    });
    const study = brainStoreFor(s.project).addFact(getEntity('customer', 'facty')!, { kind: 'purpose', statement: 'Studied purpose' });
    // A study fact has no `fact_` marker in its id: make one the way the study does.
    const { upsertFact } = await import('@/lib/server/brain/facts');
    upsertFact({
      id: 'customer:facty:purpose',
      subjectType: 'entity',
      subjectId: 'customer/facty',
      kind: 'purpose',
      statement: 'Issues cards',
      evidence: [],
      confidence: 0.8,
      projectId: s.project,
    });
    const studyRow = await s.client.createPage({
      parent: { data_source_id: s.dbs.facts!.dataSourceId },
      properties: {
        Statement: title('Issues cards'),
        Kind: select('purpose'),
        About: { relation: [{ id: page.row }] },
        [LANDFLOW_ID]: rt('customer:facty:purpose'),
      },
    });
    seed.seedItem(s, 'fact', 'customer:facty:purpose', studyRow.id, null);
    const ownRow = await s.client.createPage({
      parent: { data_source_id: s.dbs.facts!.dataSourceId },
      properties: {
        Statement: title(study.statement),
        Kind: select('purpose'),
        [LANDFLOW_ID]: rt(study.id),
      },
    });
    seed.seedItem(s, 'fact', study.id, ownRow.id, null);
    await s.pull();
    tick();
    fake.editAsPerson(studyRow.id, {
      properties: { Statement: title('Issues cards and loans') },
    });
    tick();
    fake.editAsPerson(ownRow.id, {
      properties: { Statement: title('Studied purpose, reworded') },
    });
    await s.pull();
    expect(getFact('customer:facty:purpose')!.statement).toBe('Issues cards');
    expect(getFact(study.id)!.statement).toBe('Studied purpose, reworded');
    expect(outbox(s)).toContainEqual({
      kind: 'fact',
      local_key: 'customer:facty:purpose',
    });
    expect(problemKinds(s)).toEqual(['landflow_part_edited']);
    expect(listProposals({ status: 'open', limit: 50 }).filter((p) => p.fingerprint.startsWith(`notion-brain:fact:${s.link.id}`))).toHaveLength(1);
  });
});

describe('practices', () => {
  const draft = (project: string, over: Record<string, unknown> = {}) =>
    practicesStore.draftPractice(
      {
        handle: `team/rule-${++counter}`,
        title: 'Charts live under deploy/helm',
        level: 'project',
        projectId: project,
        strength: 'required',
        topics: ['helm'],
        repos: [],
        paths: ['deploy/**'],
        summary: 'Charts live in deploy/helm',
        body: 'One chart per service.',
        ...over,
      } as never,
      { source: 'person', actor: TEST_OWNER },
    );
  const region = '> Charts live in deploy/helm\n\nOne chart per service.';

  async function approved(s: Setup) {
    const { practice } = draft(s.project);
    approve.approvePractice(TEST_OWNER, practice.id, { version: 1 });
    const row = await s.client.createPage({
      parent: { data_source_id: s.dbs.practices!.dataSourceId },
      properties: {
        Title: title('Charts live under deploy/helm'),
        Handle: rt(practice.handle),
        Status: select('approved'),
        [LANDFLOW_ID]: rt(practice.id),
      },
      markdown: sync.pageBody(region),
    });
    seed.seedItem(s, 'practice', practice.id, row.id, region);
    return { practice, row: row.id };
  }

  it('a body edited in Notion is a tainted draft v2 for the approvers, the approved text stays, an approval needs the review, and the approved text is queued to be written back', async () => {
    const s = await setup();
    const { practice, row } = await approved(s);
    await s.pull();
    tick();
    fake.editAsPerson(row, {
      markdown: sync.pageBody(`${region}\nAlso pin the chart version.`),
    });
    await s.pull();
    const versions = practicesStore.versionsOf(practice.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({
      source: 'notion',
      tainted: true,
      summary: 'Charts live in deploy/helm',
      body: 'One chart per service.\nAlso pin the chart version.',
    });
    const approvedNow = practicesStore.approvedPractices({ projectIds: [s.project] }).find((p) => p.id === practice.id)!;
    expect(approvedNow.body).toBe('One chart per service.');
    expect(approvedNow.version).toBe(1);
    expect(() => approve.approvePractice(TEST_OWNER, practice.id, { version: 2 })).toThrow(PracticeNeedsReview);
    const suggestion = listProposals({ status: 'open', limit: 50 }).find((p) => p.practice?.practiceId === practice.id && p.practice.version === 2)!;
    expect(suggestion.why).toContain('a linked Notion page');
    expect(suggestion.why).not.toContain('a repository');
    expect(suggestion.evidence).toContainEqual(
      expect.objectContaining({
        label: 'Read from outside',
        value: 'a linked Notion page',
        href: expect.stringContaining(row.replace(/-/g, '')),
      }),
    );
    expect(outbox(s)).toContainEqual({
      kind: 'practice',
      local_key: practice.id,
    });
    // A later edit before approval updates that same draft.
    tick();
    fake.editAsPerson(row, {
      markdown: sync.pageBody(`${region}\nAlso pin the chart version and the app version.`),
    });
    await s.pull();
    expect(practicesStore.versionsOf(practice.id).map((v) => v.version)).toEqual([2, 1]);
    expect(practicesStore.versionsOf(practice.id)[0].body).toContain('and the app version');
    const approvedAfter = approve.approvePractice(TEST_OWNER, practice.id, {
      version: 2,
      reviewedSources: true,
    });
    expect(approvedAfter.approvedVersion).toBe(2);
    // Putting the approved text back is not a new edit.
    tick();
    fake.editAsPerson(row, {
      markdown: sync.pageBody(`> Charts live in deploy/helm\n\nOne chart per service.\nAlso pin the chart version and the app version.`),
    });
    await s.pull();
    expect(practicesStore.versionsOf(practice.id).map((v) => v.version)).toEqual([2, 1]);
  });

  it('Status set to Approved in Notion is put back and changes nothing locally', async () => {
    const s = await setup();
    const { practice, row } = await approved(s);
    const { practice: pending } = draft(s.project);
    await s.pull();
    // Wave nb2 integration: NB04's listener queued the new local draft; its push would have sent it by now.
    await flush();
    database().delete('notion_brain_outbox', { link_id: s.link.id });
    tick();
    fake.editAsPerson(row, { properties: { Status: select('retired') } });
    await s.pull();
    expect(practicesStore.getPractice(practice.id)!.status).toBe('approved');
    expect(practicesStore.getPractice(pending.id)!.status).toBe('draft');
    expect(outbox(s)).toEqual([{ kind: 'practice', local_key: practice.id }]);
  });

  it('a new practice row is a new tainted draft at the project level', async () => {
    const s = await setup();
    const row = fake.addRow(
      s.database.practices,
      {
        Title: title('Pin base images'),
        Strength: select('required'),
        Topics: { multi_select: [{ name: 'docker' }] },
      },
      '> Pin base images by digest\n\nUse digests, never tags.',
    );
    await s.pull();
    const created = practicesStore.listPractices({ projectId: s.project, level: 'project' } as never).find((p) => p.title === 'Pin base images')!;
    expect(created).toMatchObject({
      level: 'project',
      projectId: s.project,
      status: 'draft',
      strength: 'required',
      topics: ['docker'],
    });
    const v = practicesStore.versionsOf(created.id)[0];
    expect(v).toMatchObject({
      source: 'notion',
      tainted: true,
      summary: 'Pin base images by digest',
      body: 'Use digests, never tags.',
    });
    expect(fake.value(row, LANDFLOW_ID)).toBe(created.id);
    expect(practicesStore.approvedPractices({ projectIds: [s.project] })).toEqual([]);
  });

  it('parses a practice region: a leading quote is the summary, a callout is dropped', () => {
    expect(parsePracticeRegion('<callout>\n\tYour change is draft v2\n</callout>\n\n> One line\n> two\n\nBody here', 'fallback')).toEqual({ summary: 'One line two', body: 'Body here' });
    expect(parsePracticeRegion('Only a body', 'kept')).toEqual({
      summary: 'kept',
      body: 'Only a body',
    });
  });

  it('an approval whose transaction throws after markRetired emits nothing', async () => {
    const s = await setup();
    const { practice: old } = draft(s.project, { handle: 'team/old-rule' });
    approve.approvePractice(TEST_OWNER, old.id, { version: 1 });
    const { practice: next } = draft(s.project, { handle: 'team/new-rule' });
    await flush();
    heard.length = 0;
    const db = database();
    const real = db.upsert.bind(db);
    const spy = vi.spyOn(db, 'upsert').mockImplementation(((table: string, row: Record<string, unknown>) => {
      if (table === 'practice_versions' && row.approved_at) throw new Error('disk full');
      return (real as (t: string, r: Record<string, unknown>) => unknown)(table, row);
    }) as never);
    try {
      expect(() =>
        approve.approvePractice(TEST_OWNER, next.id, {
          version: 1,
          conflicts: { [old.id]: 'supersede' },
        }),
      ).toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    await flush();
    expect(heard.filter((c) => c.kind === 'practice')).toEqual([]);
    expect(practicesStore.getPractice(old.id)!.status).toBe('approved'); // rolled back
    // And a good approval is heard once the transaction has committed, for each practice it changed.
    approve.approvePractice(TEST_OWNER, next.id, {
      version: 1,
      conflicts: { [old.id]: 'supersede' },
    });
    await flush();
    expect(
      heard
        .filter((c) => c.kind === 'practice')
        .map((c) => c.key)
        .sort(),
    ).toEqual([next.id, old.id].sort());
  });
});

describe('notes for a team', () => {
  async function team(project: string, name: string) {
    const lead = agentStore.create({ name: `Lead ${name}` });
    const t = agentTeamStore.create({
      name,
      members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }],
    });
    setHomeProject('agentTeam', t.id, project);
    return t;
  }

  it('a note row with Team is an unverified, tainted team note by "A Notion user", and promoting it unverified is refused', async () => {
    const s = await setup();
    const t = await team(s.project, 'Support');
    const row = fake.addRow(s.database.notebook, {
      Text: title('Kestrel wants SSO by March'),
      Kind: select('decision'),
      Team: rt('support'),
    });
    await s.pull();
    const note = noteStore.list ? undefined : undefined;
    void note;
    const made = database().all<{ id: string }>('SELECT id FROM team_notes WHERE team_id = ?', t.id);
    expect(made).toHaveLength(1);
    const stored = noteStore.get(made[0].id)!;
    expect(stored).toMatchObject({
      text: 'Kestrel wants SSO by March',
      kind: 'decision',
      scope: 'team',
      status: 'unverified',
      tainted: true,
      author: 'A Notion user',
      source: {
        tool: 'notion',
        url: expect.stringContaining(row.replace(/-/g, '')),
      },
    });
    expect(stored.verifiedAt).toBeUndefined();
    expect(() => notebook.promote(stored, 'project', 'someone')).toThrow();
    expect(fake.value(row, LANDFLOW_ID)).toBe(stored.id);
    expect(outbox(s)).toEqual([{ kind: 'note', local_key: stored.id }]);
    await s.pull();
    expect(database().all('SELECT id FROM team_notes WHERE team_id = ?', t.id)).toHaveLength(1);
    // An edit of that note in Notion is put back: notes are edited in Landflow.
    database().exec?.('DELETE FROM notion_brain_outbox');
    tick();
    fake.editAsPerson(row, {
      properties: { Text: title('Rewritten in Notion') },
    });
    await s.pull();
    expect(noteStore.get(stored.id)!.text).toBe('Kestrel wants SSO by March');
    expect(outbox(s)).toEqual([{ kind: 'note', local_key: stored.id }]);
  });

  it('a note row with no Team, or a team of another project, is a problem and adds nothing', async () => {
    const s = await setup();
    await team(`${s.project}-other`, 'Elsewhere');
    fake.addRow(s.database.notebook, { Text: title('No team on this one') });
    fake.addRow(s.database.notebook, {
      Text: title('Wrong team'),
      Team: rt('Elsewhere'),
    });
    await s.pull();
    expect(problemKinds(s)).toEqual(['note_without_team', 'note_without_team']);
    expect(database().all('SELECT id FROM team_notes WHERE text LIKE ?', '%team on this one%')).toEqual([]);
  });

  it('the author is the user’s name for a user id, "A Notion user" for Notion without one, and "Landflow" otherwise (never a verified note by "Notion")', async () => {
    const s = await setup();
    const t = await team(s.project, 'Author');
    const user = await createUser({
      email: 'writer@pull.test',
      name: 'Wendy Writer',
      role: 'member',
      password: 'writer-password-1',
    });
    const store = brainStoreFor(s.project);
    expect((await store.addNote(t.id, { text: 'From a matched user' }, 'notion', user.id)).author).toBe('Wendy Writer');
    expect((await store.addNote(t.id, { text: 'From someone unknown' }, 'notion')).author).toBe('A Notion user');
    const plain = await store.addNote(t.id, { text: 'Added by a flow' });
    expect(plain.author).toBe('Landflow');
    expect(plain.status).toBe('verified');
  });
});

describe('trash, schema and what the pull reads', () => {
  it('a trashed row detaches its item with a problem, and nothing local is deleted', async () => {
    const s = await setup();
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'doomed',
      name: 'Doomed',
    });
    await s.pull();
    fake.trash(page.row);
    await s.pull();
    expect(sync.itemOf(s.link.id, 'entity', 'customer/doomed')!.state).toBe('detached');
    expect(problemKinds(s)).toEqual(['trashed_in_notion']);
    expect(getEntity('customer', 'doomed')).toBeTruthy();
    expect(links.problems(s.link.id)[0].detail).not.toContain('Doomed');
  });

  it('a removed property is a problem; a removed required one makes the link need a repair', async () => {
    const s = await setup();
    await seed.seedPage(s, { type: 'customer', id: 'schema', name: 'Schema' });
    fake.removeProperty(s.database.pages, 'Teams');
    await s.pull();
    expect(problemKinds(s)).toEqual(['schema_changed']);
    expect(links.linkById(s.link.id)!.status).toBe('active');
    fake.removeProperty(s.database.pages, LANDFLOW_ID);
    await s.pull();
    expect(links.linkById(s.link.id)).toMatchObject({ status: 'needs_repair' });
    expect(statusNotices(s).map((p) => p.title)).toEqual([expect.stringContaining('The Notion brain needs a repair')]);
  });

  // Wave nb2 integration: the pull changes a link's status through NB04's status.ts, so the admins hear of it.
  it('a 401 seen first by the pull stops the link as unauthorized and files one "Notion refused the key" notice', async () => {
    const s = await setup();
    await seed.seedPage(s, { type: 'customer', id: 'refused', name: 'Refused' });
    await s.pull();
    expect(statusNotices(s)).toEqual([]);
    fake.failNext({ status: 401 });
    await s.pull();
    expect(links.linkById(s.link.id)).toMatchObject({ status: 'unauthorized', reason: 'Notion refused the key' });
    const notices = statusNotices(s);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ fingerprint: `notion-brain:${s.link.id}:unauthorized`, projectId: s.project });
    expect(notices[0].title).toContain('Notion refused the key');
    await s.pull(); // a stopped link is not pulled, and no second notice is filed
    expect(statusNotices(s)).toHaveLength(1);
  });

  it('a trashed database seen by the pull makes the link unshared with one notice', async () => {
    const s = await setup();
    await s.pull();
    fake.trash(s.database.pages);
    await s.pull();
    expect(links.linkById(s.link.id)!.status).toBe('unshared');
    expect(statusNotices(s).map((p) => p.fingerprint)).toEqual([`notion-brain:${s.link.id}:unshared`]);
  });

  it('a 404 that the database check resolves to a gone database makes the link unshared with its reason and one notice', async () => {
    const s = await setup();
    await s.pull();
    fake.failNext({ status: 404, match: (m, t) => m === 'GET' && t === '/v1/data_sources/:id' }, 2); // the pull's read, then the check's
    await s.pull();
    const after = links.linkById(s.link.id)!;
    expect(after.status).toBe('unshared');
    expect(after.reason).toMatch(/database is gone or no longer shared/);
    expect(statusNotices(s).map((p) => p.fingerprint)).toEqual([`notion-brain:${s.link.id}:unshared`]);
  });

  it('a 5xx during the database check leaves the link active with the error kept', async () => {
    const s = await setup();
    await s.pull();
    fake.failNext({ status: 404, match: (m, t) => m === 'GET' && t === '/v1/data_sources/:id' }); // the pull's read
    let armed = true; // the scripted 500s end with the pull: none is left for the next test
    fake.failNext({ status: 500, match: (m, t) => armed && m === 'GET' && t === '/v1/data_sources/:id' }, 20); // the check's
    // The client backs off a read for seconds between its tries; here the waits are cut to a millisecond.
    const realTimeout = globalThis.setTimeout;
    const quick = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => realTimeout(fn, ms && ms >= 500 ? 1 : ms, ...rest)) as never);
    try {
      await s.pull();
    } finally {
      armed = false;
      quick.mockRestore();
    }
    const after = links.linkById(s.link.id)!;
    expect(after.status).toBe('active');
    expect(after.last_error).toBeTruthy();
    expect(statusNotices(s)).toEqual([]);
  });

  it('a deleted credential seen first by the pull stops the link as unauthorized with its reason and one notice', async () => {
    const doomed = credentials.create({ name: 'Doomed', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
    const project = projects.createTeamProject({ name: `Pull ${++counter}` });
    const s = await seed.seedLink(fake, doomed, project.id);
    credentials.delete(doomed);
    await pullLink(links.linkById(s.link.id)!, { force: true });
    expect(links.linkById(s.link.id)).toMatchObject({ status: 'unauthorized', reason: 'The Notion key was deleted' });
    expect(listProposals({ status: 'open', limit: 200 }).filter((p) => p.fingerprint === `notion-brain:${s.link.id}:unauthorized`)).toHaveLength(1);
  });

  it('a pass whose pull stopped the link on a 401 makes no knowledge-walk request', async () => {
    const s = await setup();
    for (const other of links.listActiveLinks()) if (other.id !== s.link.id) links.setStatus(other.id, 'paused', 'Paused for this test');
    await service.tickOnce(); // the first pass settles whatever is due
    links.updateLink(s.link.id, { last_pull_at: null }); // the pull is due again, and so is the walk
    links.setCursors(s.link.id, {});
    fake.state.requests.length = 0;
    fake.failNext({ status: 401, match: (m, t) => m === 'POST' && t.endsWith('/query') });
    await service.tickOnce();
    expect(links.linkById(s.link.id)!.status).toBe('unauthorized');
    const walked = fake.state.requests.filter((r) => r.template === '/v1/blocks/:id/children' || r.path.includes(s.root.replace(/-/g, '')) || r.path.includes(s.brain.replace(/-/g, '')));
    expect(walked.map((r) => `${r.method} ${r.template}`)).toEqual([]);
  });

  it('reads only under the link’s data sources and rows: never search, never another page', async () => {
    const s = await setup();
    const other = fake.addPage({ title: 'Somebody else’s page', shared: true });
    const page = await seed.seedPage(s, {
      type: 'customer',
      id: 'scoped',
      name: 'Scoped',
    });
    const from = fake.state.requests.length;
    tick();
    fake.editAsPerson(page.row, { properties: { Name: title('Scoped Co') } });
    fake.addRow(s.database.pages, { Name: title('Added') });
    await s.pull();
    await s.pull();
    const mine = fake.state.requests.slice(from);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((r) => r.template === '/v1/search')).toBe(false);
    const known = new Set(
      [s.dbs.pages, s.dbs.facts, s.dbs.practices, s.dbs.notebook]
        .map((d) => d!.dataSourceId.replace(/-/g, ''))
        .concat([...fake.state.pages.values()].filter((p) => p.parent.type === 'data_source_id').map((p) => p.id.replace(/-/g, ''))),
    );
    for (const r of mine) {
      if (r.template === '/v1/users/:id') continue; // the editor's email, with the connection's capability
      for (const id of r.path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) expect(known.has(id.replace(/-/g, '')), r.path).toBe(true);
      expect(r.path).not.toContain(other);
    }
  });

  it('logs hold no key and no page text', () => {
    const logged = output.join('\n');
    expect(logged).not.toContain(FAKE_NOTION_TOKEN);
    for (const word of ['wire only', 'Kestrel Group', 'Ana prefers', 'platinum']) expect(logged).not.toContain(word);
  });
});

describe('parsing', () => {
  it('Attributes: one key: value per line; a bad line is reported by number', () => {
    expect(parseAttributes('tier: gold\n\nregion: emea west\nnot a line\n9bad: x')).toEqual({ attrs: { tier: 'gold', region: 'emea west' }, bad: [4, 5] });
  });
});

describe('the contract copies', () => {
  it.skipIf(!process.env.LANDFLOW_BACKBONE_CONTRACTS)('sync.ts and the four fixture files equal backbone/contracts/nb byte for byte', () => {
    const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS!;
    const same = (copy: string, contract: string) => expect(readFileSync(copy, 'utf8'), contract).toBe(readFileSync(join(dir, 'nb', contract), 'utf8'));
    same(join(__dirname, '..', 'src', 'lib', 'server', 'brain', 'notion', 'sync.ts'), 'sync.ts');
    for (const file of ['input.ts', 'kestrel-bank.md', 'ana.md', 'home.md']) same(join(__dirname, 'fixtures', 'notion-render', file), join('render-fixtures', file));
  });
});
