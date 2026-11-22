/**
 * C21 (W4a P20): the Vector Store nodes know their project. A workflow's home project claims a collection on its first insert;
 * a workflow in another project can't load, insert, clear or use it as a tool, and gets one message whether the collection
 * exists or not; a read grant lets it search but not write; the brain's names stay closed (and landflow-agent-memory for every
 * project), except a project's own Notion knowledge read once its admin allows it (FR-7); a project that writes through a grant
 * keeps its Upsert-by-Key keys apart from the owner's.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-vsa-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { defineNode } = await import('@landflow/sdk');
const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { setHomeProject, defaultProjectId } = await import('@/lib/server/projects/store');
const access = await import('@/lib/server/rag/collection-access');
const { SqliteVectorStore } = await import('@/lib/server/rag/stores');
const { storeKeyOf } = await import('@/lib/shared/collections');
const { AGENT_MEMORY_COLLECTION } = await import('@/lib/shared/brain');
const { runFlow, outputsOf } = await import('./helpers');

const fakeEmbeddings = defineNode({
  description: { name: 'fakeEmbeddings', displayName: 'Fake Embeddings', description: 'x', version: 1, kind: 'subnode', supplies: 'ai_embedding', categories: ['AI'], inputs: [], outputs: [{ type: 'ai_embedding' }], properties: [] },
  supplyData: () => ({ provider: 'test', model: 'm1', embedDocuments: async (texts: string[]) => texts.map((t) => [t.length, 1, 2]), embedQuery: async (text: string) => [text.length, 1, 2] }),
});
// A stand-in for an agent: it takes the store's tool and calls it once.
const toolUser = defineNode({
  description: { name: 'toolUser', displayName: 'Tool User', description: 'x', version: 1, kind: 'action', categories: ['AI'], inputs: [{ type: 'main' }, { type: 'ai_tool' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) {
    const [tool] = await (ctx as unknown as { getInputConnectionData<T>(type: string): Promise<T[]> }).getInputConnectionData<{ invoke(input: { query: string }): Promise<unknown> }>('ai_tool');
    return [[{ json: (await tool!.invoke({ query: 'returns' })) as Record<string, never> }]];
  },
});

const PAGES = [{ id: 'a', text: 'Returns: items can be returned within 30 days.' }, { id: 'b', text: 'Shipping is free for orders over 50 euros.' }];
type Flow = Awaited<ReturnType<typeof runFlow>>;
const produced = (result: Flow) => (result.runData.Store ?? []).filter((run) => run.source === 'main').at(-1)?.outputs?.[0] ?? [];
const failure = (result: Flow, node = 'Store') => (result.runData[node] ?? []).filter((run) => run.source === 'main').at(-1)?.error;

/** Run the flow `wf_test` as a workflow of `project`. */
const asProject = (project: string) => setHomeProject('workflow', 'wf_test', project);
const store = (collection: string, mode: 'insert' | 'load', extra: Record<string, unknown> = {}, type = 'core.vectorStoreSqlite') => ({ name: 'Store', type, parameters: { mode, collection, ...(mode === 'load' && { prompt: 'returns' }), ...extra } });
const insert = (collection: string, extra: Record<string, unknown> = {}, input = PAGES, type = 'core.vectorStoreSqlite', workflowId?: string) =>
  runFlow([store(collection, 'insert', extra, type), { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: { jsonMode: 'expressionData', jsonData: '{{ $json.text }}' } }, { name: 'Embeddings', type: 'test.fakeEmbeddings' }], [['Start', 'Store'], ['Loader', 'Store', 'ai_document'], ['Embeddings', 'Store', 'ai_embedding']], { input, extra: { fakeEmbeddings }, ...(workflowId && { workflowId }) });
const load = (collection: string, type = 'core.vectorStoreSqlite') =>
  runFlow([store(collection, 'load', {}, type), { name: 'Embeddings', type: 'test.fakeEmbeddings' }], [['Start', 'Store'], ['Embeddings', 'Store', 'ai_embedding']], { input: [{}], extra: { fakeEmbeddings } });
const asTool = (collection: string, workflowId?: string) =>
  runFlow([{ name: 'Store', type: 'core.vectorStoreSqlite', parameters: { mode: 'retrieve-as-tool', collection } }, { name: 'Agent', type: 'test.toolUser' }, { name: 'Embeddings', type: 'test.fakeEmbeddings' }], [['Start', 'Agent'], ['Store', 'Agent', 'ai_tool'], ['Embeddings', 'Store', 'ai_embedding']], { input: [{}], extra: { fakeEmbeddings, toolUser }, ...(workflowId && { workflowId }) });

let A = '';
let B = '';
let alice: Awaited<ReturnType<typeof auth.createUser>>;
const unique = (name: string) => `${name}-${Date.now().toString(36)}`;

beforeAll(async () => {
  auth.disableTestAuth();
  await auth.createOwner({ email: 'owner@example.com', name: 'Olive', password: 'password-123' });
  alice = await auth.createUser({ email: 'alice@example.com', name: 'Alice', role: 'member', password: 'password-123' });
  A = projects.createTeamProject({ name: 'Alpha' }).id;
  B = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(A, alice.id, 'admin');
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('a collection belongs to the project of the workflow that first wrote it', () => {
  it('B can’t load, insert or clear what A wrote; A still can', async () => {
    const name = unique('hr-policies');
    asProject(A);
    expect(failure(await insert(name))).toBeUndefined();
    expect(access.collectionAccess(storeKeyOf('sqlite', name), A)).toBe('owner');
    asProject(B);
    const loaded = await load(name);
    expect(failure(loaded)?.message).toMatch(new RegExp(`project can.t use the collection “${name}”`));
    expect(produced(loaded)).toHaveLength(0);
    expect(failure(await insert(name, { clearStore: true }))?.message).toMatch(/can.t use the collection/);
    // the collection is unchanged
    expect(await new SqliteVectorStore().count(name)).toBe(2);
    asProject(A);
    expect(outputsOf(await load(name), 'Store')[0]).toHaveLength(2);
  });

  it('a retrieve-as-tool sub-node reads as the workflow’s project', async () => {
    const name = unique('tool-collection');
    asProject(A);
    await insert(name);
    expect(failure(await asTool(name), 'Agent')).toBeUndefined();
    asProject(B);
    const refused = await asTool(name);
    expect(JSON.stringify(refused.runData)).toMatch(/can.t use the collection/);
  });

  it('a read grant lets B search it; B’s insert and Clear still fail and the collection is unchanged (AS-2); revoking stops it (AS-3)', async () => {
    const name = unique('shared-handbook');
    asProject(A);
    await insert(name);
    access.grantCollection(alice, storeKeyOf('sqlite', name), B, 'read');
    asProject(B);
    expect(outputsOf(await load(name), 'Store')[0]).toHaveLength(2);
    expect(failure(await asTool(name), 'Agent')).toBeUndefined();
    expect(failure(await insert(name, { clearStore: true }))?.message).toMatch(/can.t use the collection/);
    expect(await new SqliteVectorStore().count(name)).toBe(2);
    access.revokeCollection(alice, storeKeyOf('sqlite', name), B);
    expect(failure(await load(name))?.message).toMatch(/can.t use the collection/);
  });

  it('a run with no home project of its own (a one-node mcp_ workflow, an agent of no project) never claims and never reads a claimed collection (fail closed)', async () => {
    const name = unique('mcp-collection');
    const key = storeKeyOf('sqlite', name);
    // nothing stored for this id: it must not be treated as a member of the default project
    expect(failure(await insert(name, {}, PAGES, 'core.vectorStoreSqlite', 'mcp_oneshot'))).toBeUndefined();
    expect(access.collectionAccess(key, A)).toBe('unclaimed'); // inserted, but not claimed by anyone
    expect(access.collectionAccess(key, defaultProjectId())).toBe('unclaimed');
    const owned = unique('owned-by-a');
    asProject(A);
    await insert(owned);
    const mcp = await runFlow([store(owned, 'load'), { name: 'Embeddings', type: 'test.fakeEmbeddings' }], [['Start', 'Store'], ['Embeddings', 'Store', 'ai_embedding']], { input: [{}], extra: { fakeEmbeddings }, workflowId: 'mcp_oneshot' });
    expect(failure(mcp)?.message).toMatch(/can.t use the collection/);
  });

  it('an agent’s node tool (workflow id agent:<id>) asks as the agent’s home project', async () => {
    const name = unique('agent-tool-collection');
    asProject(A);
    await insert(name);
    setHomeProject('agent', 'agt_a', A);
    setHomeProject('agent', 'agt_b', B);
    expect(failure(await asTool(name, 'agent:agt_a'), 'Agent')).toBeUndefined();
    expect(JSON.stringify((await asTool(name, 'agent:agt_b')).runData)).toMatch(/can.t use the collection/);
  });

  it('a write that fails on the loader or the embeddings checks does not claim the collection', async () => {
    const name = unique('unclaimed-until-valid');
    asProject(A);
    const noLoader = await runFlow([store(name, 'insert'), { name: 'Embeddings', type: 'test.fakeEmbeddings' }], [['Start', 'Store'], ['Embeddings', 'Store', 'ai_embedding']], { input: PAGES, extra: { fakeEmbeddings } });
    expect(failure(noLoader)?.message).toMatch(/document loader/i);
    expect(access.collectionAccess(storeKeyOf('sqlite', name), A)).toBe('unclaimed');
    const noEmbeddings = await runFlow([store(name, 'insert'), { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: { jsonMode: 'expressionData', jsonData: '{{ $json.text }}' } }], [['Start', 'Store'], ['Loader', 'Store', 'ai_document']], { input: PAGES });
    expect(failure(noEmbeddings)).toBeDefined();
    expect(access.collectionAccess(storeKeyOf('sqlite', name), A)).toBe('unclaimed');
  });

  it('an in-memory collection is protected the same way', async () => {
    const name = unique('mem-notes');
    asProject(A);
    await insert(name, {}, PAGES, 'core.vectorStoreInMemory');
    asProject(B);
    expect(failure(await load(name, 'core.vectorStoreInMemory'))?.message).toMatch(/can.t use the collection/);
  });
});

describe('the brain’s names stay closed', () => {
  it.each(['landflow-brain-x', AGENT_MEMORY_COLLECTION, 'landflow-notion-someone'])('%s is refused to read and to write, for every project', async (name) => {
    for (const project of [A, B]) {
      asProject(project);
      expect(failure(await load(name))?.message).toMatch(/second brain.s own collection/);
      expect(failure(await insert(name))?.message).toMatch(/second brain.s own collection/);
    }
  });

  it('FR-7: a project’s own Notion knowledge can be read, never written, once its admin turns it on; no other project can', async () => {
    const own = `landflow-notion-${A}`;
    asProject(A);
    expect(failure(await load(own))?.message).toMatch(/second brain.s own collection/);
    access.setNotionRead(alice, A, true);
    expect(failure(await load(own))).toBeUndefined();
    expect(failure(await insert(own))?.message).toMatch(/second brain.s own collection/);
    asProject(B);
    expect(failure(await load(own))?.message).toMatch(/second brain.s own collection/);
    access.setNotionRead(alice, A, false);
    asProject(A);
    expect(failure(await load(own))?.message).toMatch(/second brain.s own collection/);
  });
});

describe('Upsert by Key through a grant', () => {
  it('a project that writes through a write grant keeps its keys apart from the owner’s', async () => {
    const name = unique('upsert-shared');
    asProject(A);
    await insert(name, { upsertKey: '{{ $json.id }}' });
    access.grantCollection(alice, storeKeyOf('sqlite', name), B, 'write');
    asProject(B);
    // the same keys, different text: B adds its own documents, A's stay
    expect(failure(await insert(name, { upsertKey: '{{ $json.id }}' }, [{ id: 'a', text: 'B says something else entirely.' }]))).toBeUndefined();
    const rows = await new SqliteVectorStore().metadataOf(name);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.metadata.upsertKey).filter((k) => k === 'a' || k === 'b').sort()).toEqual(['a', 'b']);
    // the owner re-running its own keys replaces only its own chunks
    asProject(A);
    await insert(name, { upsertKey: '{{ $json.id }}' }, [PAGES[0]!, PAGES[1]!]);
    expect(await new SqliteVectorStore().count(name)).toBe(3);
  });
});

describe('write implies read: the counts of a write say nothing a writer could not read', () => {
  it('a project with a read grant gets no embedded or reused counts, because it cannot write at all', async () => {
    const name = unique('probe');
    asProject(A);
    await insert(name, { upsertKey: '{{ $json.id }}' });
    access.grantCollection(alice, storeKeyOf('sqlite', name), B, 'read');
    asProject(B);
    const result = await insert(name, { upsertKey: '{{ $json.id }}' });
    expect(failure(result)?.message).toMatch(/can.t use the collection/);
    expect(produced(result)).toHaveLength(0);
  });
});

// pgvector: the collection is keyed by the connection and table, not by a credential (LANDFLOW_INTEGRATION=postgres).
const pgEnabled = process.env.LANDFLOW_INTEGRATION?.split(',').includes('postgres');
describe.skipIf(!pgEnabled)('pgvector collections', () => {
  const url = new URL(process.env.LANDFLOW_PG_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test');
  const credential = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: 'disable' };
  const tables: string[] = [];
  const table = (label: string) => {
    const name = `lf_access_${label}_${process.pid}`;
    tables.push(name);
    return name;
  };
  const pgNode = (mode: 'insert' | 'load', collection: string, tableName: string) => ({ name: 'Store', type: 'core.vectorStorePGVector', parameters: { mode, collection, tableName, ...(mode === 'load' && { prompt: 'returns' }) }, credentials: { postgres: credential } });
  const pgInsert = (collection: string, tableName: string) =>
    runFlow([pgNode('insert', collection, tableName), { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: { jsonMode: 'expressionData', jsonData: '{{ $json.text }}' } }, { name: 'Embeddings', type: 'test.fakeEmbeddings' }], [['Start', 'Store'], ['Loader', 'Store', 'ai_document'], ['Embeddings', 'Store', 'ai_embedding']], { input: PAGES, extra: { fakeEmbeddings } });
  const pgLoad = (collection: string, tableName: string) => runFlow([pgNode('load', collection, tableName), { name: 'Embeddings', type: 'test.fakeEmbeddings' }], [['Start', 'Store'], ['Embeddings', 'Store', 'ai_embedding']], { input: [{}], extra: { fakeEmbeddings } });

  afterAll(async () => {
    const { default: pg } = await import('pg');
    const { pgTableName, closePgPools } = await import('@/lib/server/rag/stores');
    const client = new pg.Client({ ...credential, ssl: false });
    await client.connect();
    for (const name of tables) await client.query(`DROP TABLE IF EXISTS ${pgTableName(name)}`);
    await client.end();
    await closePgPools();
  });

  it('B can’t read or write A’s collection in a table, but the same name in another table is another collection', async () => {
    const name = unique('pg-handbook');
    const mine = table('mine');
    asProject(A);
    expect(failure(await pgInsert(name, mine))).toBeUndefined();
    asProject(B);
    expect(failure(await pgLoad(name, mine))?.message).toMatch(/can.t use the collection/);
    expect(failure(await pgInsert(name, mine))?.message).toMatch(/can.t use the collection/);
    expect(failure(await pgInsert(name, table('other')))).toBeUndefined(); // its own table: its own collection, claimed by B
  });
});
