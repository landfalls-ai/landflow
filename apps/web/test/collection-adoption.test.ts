/**
 * C21 (W4a P20): the one-time adoption of the collections that existed before owners did, STRICT (the person's decision
 * C21-D2): each collection a saved configuration names goes to the home project of the oldest resource naming it, the other naming
 * projects get NO grant and lose access until an admin of the owner grants it, and every such (collection, project) pair is
 * recorded (an audit row each, a notice on the owner's card, the project's own "lost" list) so nothing is lost silently. A
 * collection no configuration names stays open until it is written. The database is built before the first check runs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-adopt-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const { SqliteVectorStore } = await import('@/lib/server/rag/stores');
const access = await import('@/lib/server/rag/collection-access');
const { storeKeyOf } = await import('@/lib/shared/collections');

const pause = () => new Promise((resolve) => setTimeout(resolve, 8));
const kb = (collection: string, store: 'sqlite' | 'memory' = 'sqlite') => ({ id: 'kb1', type: 'knowledge' as const, source: 'vector' as const, name: 'search', description: 'x', store, collection, embeddings: { provider: 'none' as const, model: 'bm25' }, topK: 4 });
const flowNode = (collection: string) => ({ id: 'n1', name: 'Store', type: 'core.vectorStoreSqlite', typeVersion: 1, position: [0, 0] as [number, number], parameters: { mode: 'load', collection } });

let owner: Awaited<ReturnType<typeof auth.createOwner>>;
let alice: Awaited<ReturnType<typeof auth.createUser>>;
let A = '';
let B = '';
let C = '';
const asker = (projectId: string) => ({ projectId, subject: 'workflow' as const });

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await auth.createOwner({ email: 'owner@example.com', name: 'Olive', password: 'password-123' });
  alice = await auth.createUser({ email: 'alice@example.com', name: 'Alice', role: 'member', password: 'password-123' });
  A = projects.createTeamProject({ name: 'Alpha' }).id;
  B = projects.createTeamProject({ name: 'Beta' }).id;
  C = projects.createTeamProject({ name: 'Gamma' }).id;
  projects.setMember(A, alice.id, 'admin');
  // The old database: nothing has checked a collection yet. Oldest first: Alpha's agent, then Beta's flow, then Gamma's agent.
  const agentA = agentStore.create({ name: 'Support', tools: [kb('faq')] });
  setHomeProject('agent', agentA.id, A);
  await pause();
  const flowB = store.saveWorkflow({ id: 'wf_adopt_b', name: 'Ingest', nodes: [flowNode('faq'), { ...flowNode('{{ $json.kb }}'), id: 'n2', name: 'By expression' }], connections: [] } as never);
  setHomeProject('workflow', flowB.id, B);
  await pause();
  const agentC = agentStore.create({ name: 'Notes bot', tools: [kb('notes'), kb('faq')] });
  setHomeProject('agent', agentC.id, C);
  // Gamma's flow was published naming `pubonly`; its draft has moved on to `drafted` since (production still runs the published one)
  const { publishDraft } = await import('@/lib/server/publish');
  const flowD = store.saveWorkflow({ id: 'wf_adopt_pub', name: 'Published', active: true, nodes: [flowNode('pubonly')], connections: [] } as never);
  setHomeProject('workflow', flowD.id, C);
  await publishDraft(flowD.id);
  store.saveWorkflow({ ...store.getWorkflow(flowD.id)!, nodes: [flowNode('drafted')] } as never);
  // a collection only the store knows (written by some earlier flow nobody names now)
  await new SqliteVectorStore().add('stray', [{ pageContent: 'old text', metadata: {}, embedding: [1, 2] }]);
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('the strict upgrade', () => {
  it('each named collection goes to the oldest naming project; the others lose access (C21-D2)', () => {
    const faq = storeKeyOf('sqlite', 'faq');
    expect(access.collectionAccess(faq, A)).toBe('owner'); // the first check runs the adoption
    expect(access.collectionAccess(faq, B)).toBe('none');
    expect(access.collectionAccess(faq, C)).toBe('none');
    expect(access.collectionAccess(storeKeyOf('sqlite', 'notes'), C)).toBe('owner');
    expect(access.collectionAccess(storeKeyOf('sqlite', 'notes'), A)).toBe('none');
  });

  it('a workflow’s published version counts too, not only its draft', () => {
    expect(access.collectionAccess(storeKeyOf('sqlite', 'pubonly'), C)).toBe('owner');
    expect(access.collectionAccess(storeKeyOf('sqlite', 'pubonly'), A)).toBe('none');
    expect(access.collectionAccess(storeKeyOf('sqlite', 'drafted'), C)).toBe('owner');
  });

  it('a name built by an expression is listed as not found, and a collection no configuration names stays open', () => {
    const report = access.lastAdoption();
    expect(report?.unresolved.join()).toMatch(/\{\{ \$json\.kb \}\}/);
    const stray = storeKeyOf('sqlite', 'stray');
    for (const project of [A, B, C]) expect(access.collectionAccess(stray, project)).toBe('unclaimed');
    expect(() => access.assertCanRead(stray, 'stray', asker(B))).not.toThrow();
  });

  it('every pair that lost access is recorded: an audit row each, the owner’s notice and the project’s own list', () => {
    const faq = storeKeyOf('sqlite', 'faq');
    const lostEvents = queryEvents({ action: ['collection.access_lost'] }).events.filter((e) => e.target?.id === faq);
    expect(lostEvents.map((e) => e.projectId).sort()).toEqual([B, C].sort());
    expect(lostEvents[0]?.details).toMatchObject({ from: 'open', to: 'none', ownerProject: A });
    const adopted = queryEvents({ action: ['collection.adopted'] }).events;
    expect(adopted).toHaveLength(1);
    expect(adopted[0]?.details?.lost).toEqual(expect.arrayContaining([`${faq} → ${B}`, `${faq} → ${C}`]));
    // the owner's card lists them, the lost project's own view names the owner
    const owned = access.projectCollections(A, true).collections.find((c) => c.key === faq);
    expect(owned?.lostAccess?.map((l) => l.projectId).sort()).toEqual([B, C].sort());
    expect(owned?.source).toBe('upgrade');
    expect(access.projectCollections(B, false).lost).toEqual([expect.objectContaining({ key: faq, ownerProjectId: A })]);
    expect(access.projectCollections(B, false).collections.find((c) => c.key === faq)).toBeUndefined();
    // nothing is granted by a notice
    expect(database().get('SELECT level FROM vector_collection_grants WHERE store_key = ? AND project_id = ? AND level != ?', faq, B, 'lost')).toBeUndefined();
  });

  it('an admin of the owner grants it back in one step; the notice goes and the access is the granted level', () => {
    const faq = storeKeyOf('sqlite', 'faq');
    access.grantCollection(alice, faq, B, 'write');
    expect(access.collectionAccess(faq, B)).toBe('write');
    expect(access.projectCollections(B, false).lost).toEqual([]);
    expect(access.projectCollections(A, true).collections.find((c) => c.key === faq)?.lostAccess?.map((l) => l.projectId)).toEqual([C]);
    // C's notice can be dismissed without a grant
    access.revokeCollection(alice, faq, C);
    expect(access.collectionAccess(faq, C)).toBe('none');
    expect(access.projectCollections(C, false).lost).toEqual([]);
  });

  it('runs once: asking again keeps every owner and a granted project, and only lists a dismissed notice again', () => {
    const faq = storeKeyOf('sqlite', 'faq');
    const adoptedBefore = queryEvents({ action: ['collection.adopted'] }).events.length;
    const again = access.adoptAgain(owner);
    expect(again.collections).toBe(0);
    expect(again.lost).toEqual([{ key: faq, projectId: C }]); // C still names it and still has no access
    expect(queryEvents({ action: ['collection.adopted'] }).events.length).toBe(adoptedBefore + 1);
    expect(access.collectionAccess(faq, A)).toBe('owner');
    expect(access.collectionAccess(faq, B)).toBe('write');
    expect(() => access.adoptAgain(alice)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('after the upgrade the owners still read and write what they did; a first write elsewhere claims as usual (AS-5)', async () => {
    await expect(access.assertCanWrite(storeKeyOf('sqlite', 'faq'), 'sqlite', 'faq', asker(A))).resolves.toBeUndefined();
    await expect(access.assertCanWrite(storeKeyOf('sqlite', 'notes'), 'sqlite', 'notes', asker(C))).resolves.toBeUndefined();
    await expect(access.assertCanWrite(storeKeyOf('sqlite', 'stray'), 'sqlite', 'stray', asker(B))).resolves.toBeUndefined();
    expect(access.collectionAccess(storeKeyOf('sqlite', 'stray'), B)).toBe('owner');
  });
});
