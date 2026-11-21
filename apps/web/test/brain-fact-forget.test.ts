/**
 * C01 + C02: supersede a fact for a person or an agent (all or nothing), forget it softly with a reason, restore it; the
 * routes and who may call them. Written test first (docs/second-brain.md#forgetting-a-fact).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-fact-forget-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_BRAIN_MODEL: 'off',
  LANDFLOW_BRAIN_EMBEDDINGS: 'off',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const facts = await import('@/lib/server/brain/facts');
const lifecycle = await import('@/lib/server/brain/fact-lifecycle');
const { canFact } = await import('@/lib/server/brain/scope');
const { SqliteVectorStore } = await import('@/lib/server/rag/stores');
const factsRoute = await import('@/app/api/brain/facts/route');
const versionsRoute = await import('@/app/api/brain/facts/[id]/versions/route');
const forgetRoute = await import('@/app/api/brain/facts/[id]/forget/route');
const restoreRoute = await import('@/app/api/brain/facts/[id]/restore/route');
const entityFactsRoute = await import('@/app/api/entities/[type]/[id]/facts/route');
const entities = await import('@/lib/server/brain/entities');

const owner = await createUser({
  email: 'owner@forget.test',
  name: 'Owner',
  role: 'owner',
  password: 'owner-password-1',
});
const editor = await createUser({
  email: 'editor@forget.test',
  name: 'Editor',
  role: 'member',
  password: 'editor-password-1',
});
const viewer = await createUser({
  email: 'viewer@forget.test',
  name: 'Viewer',
  role: 'member',
  password: 'viewer-password-1',
});
const outsider = await createUser({
  email: 'out@forget.test',
  name: 'Out',
  role: 'member',
  password: 'out-password-1',
});
const team = createTeamProject({ name: 'Finance', createdBy: owner.id });
setMember(team.id, editor.id, 'editor');
setMember(team.id, viewer.id, 'viewer');
store.saveWorkflow(
  {
    id: 'wf_f',
    name: 'Close',
    active: false,
    nodes: [],
    connections: [],
    createdBy: owner.id,
  } as unknown as Workflow,
  { actor: owner.id },
);
setHomeProject('workflow', 'wf_f', team.id);
const actorOf = (u: { id: string; role: 'owner' | 'admin' | 'member' }) => ({
  id: u.id,
  role: u.role,
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const db = () => database();
const base = {
  subjectType: 'workflow',
  subjectId: 'wf_f',
  kind: 'health',
  confidence: 0.6,
  projectId: team.id,
} as const;
const put = (statement: string, extra: Partial<Parameters<typeof facts.upsertFact>[0]> = {}) => facts.upsertFact({ ...base, statement, ...extra } as never, db(), new Date().toISOString());
const ID = 'workflow:wf_f:health';

beforeEach(() => {
  enableTestAuth();
  for (const t of ['brain_facts', 'brain_entities'] as const) db().deleteBefore(t, t === 'brain_facts' ? 'last_seen' : 'created_at', '9999');
});

const call = async (handler: unknown, url: string, init?: { method?: string; body?: unknown }, params?: Record<string, string>) => {
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(
    new Request(`http://forget.test${url}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(init?.body !== undefined && { body: JSON.stringify(init.body) }),
    }),
    params && { params: Promise.resolve(params) },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
};

describe('T-5 supersede', () => {
  it('writes a new version for a person', async () => {
    put('closes in 4 days');
    const next = await lifecycle.supersedeFact(ID, { statement: 'closes in 2 days' }, { origin: 'person', by: editor.id }, db());
    expect(next).toMatchObject({
      version: 2,
      statement: 'closes in 2 days',
      writtenBy: { origin: expect.any(String) },
    });
    expect(facts.getFact(`${ID}#v1`, db())?.statement).toBe('closes in 4 days');
  });

  it('writes nothing when the embedding cannot be made', async () => {
    put('closes in 4 days');
    const saved = {
      model: process.env.LANDFLOW_BRAIN_EMBEDDINGS,
      url: process.env.OLLAMA_URL,
    };
    process.env.LANDFLOW_BRAIN_EMBEDDINGS = 'nomic-embed-text';
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    try {
      await expect(lifecycle.supersedeFact(ID, { statement: 'closes in 2 days' }, {}, db())).rejects.toMatchObject({ name: 'MemoryIndexError', status: 503 });
    } finally {
      process.env.LANDFLOW_BRAIN_EMBEDDINGS = saved.model;
      if (saved.url === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = saved.url;
    }
    expect(facts.getFact(ID, db())).toMatchObject({
      version: 1,
      statement: 'closes in 4 days',
    });
    expect(facts.factVersions(ID, { limit: 10 }, db()).versions).toHaveLength(1);
  });

  it('lets one of two writers of the same version win', async () => {
    put('closes in 4 days');
    const results = await Promise.allSettled([lifecycle.supersedeFact(ID, { statement: 'one' }, {}, db()), lifecycle.supersedeFact(ID, { statement: 'two' }, {}, db())]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({
      name: 'StaleChainError',
      status: 409,
    });
    expect(facts.factVersions(ID, { limit: 10 }, db()).versions.filter((v) => v.latest)).toHaveLength(1);
  });

  it('refuses a static fact without replaceStatic', async () => {
    facts.upsertFact({ ...base, statement: 'belongs to Finance' } as never, db(), new Date().toISOString(), undefined, undefined, { isStatic: true });
    await expect(lifecycle.supersedeFact(ID, { statement: 'belongs to Sales' }, {}, db())).rejects.toMatchObject({ name: 'StaticFactError', status: 409 });
    expect((await lifecycle.supersedeFact(ID, { statement: 'belongs to Sales', replaceStatic: true }, {}, db())).version).toBe(2);
  });
});

describe('T-5 forget and restore', () => {
  it('hides a forgotten fact from every read, drops its vector, audits it, and restore brings it back', async () => {
    put('closes in 4 days');
    const vectors = new SqliteVectorStore();
    const collection = `landflow-brain-${team.id}`;
    await vectors.add(collection, [
      {
        id: ID,
        pageContent: 'x',
        metadata: { factId: ID },
        embedding: [1, 0, 0],
      },
    ]);
    const forgotten = await lifecycle.forgetFact(ID, { reason: 'It was a one-off' }, { userId: editor.id, name: 'Editor' }, db());
    expect(forgotten).toMatchObject({
      forgetReason: 'It was a one-off',
      forgottenBy: editor.id,
    });
    expect(facts.getFact(ID, db())).toBeUndefined();
    expect(facts.listFacts({}, db())).toEqual([]);
    expect(facts.searchFacts('closes', {}, db())).toEqual([]);
    expect(facts.listFacts({ forgotten: 'only' }, db())[0]).toMatchObject({
      id: ID,
      forgetReason: 'It was a one-off',
    });
    expect(await vectors.count(collection)).toBe(0);
    const restored = lifecycle.restoreFact(ID, { userId: editor.id }, db());
    expect(restored.forgottenAt).toBeUndefined();
    expect(facts.getFact(ID, db())?.statement).toBe('closes in 4 days');
    const actions = db().all<{ action: string; details: string }>("SELECT action, details FROM audit_events WHERE action LIKE 'brain.fact_%' ORDER BY at, id");
    expect(actions.map((a) => a.action)).toEqual(['brain.fact_forgotten', 'brain.fact_restored']);
    expect(JSON.parse(actions[0].details)).toMatchObject({
      reason: 'It was a one-off',
      from: 'live',
      to: 'forgotten',
    });
  });

  it('needs a reason of 1 to 500 characters', async () => {
    put('closes in 4 days');
    await expect(lifecycle.forgetFact(ID, { reason: '  ' }, { userId: editor.id }, db())).rejects.toMatchObject({ status: 400 });
    await expect(lifecycle.forgetFact(ID, { reason: 'x'.repeat(501) }, { userId: editor.id }, db())).rejects.toMatchObject({ status: 400 });
    await expect(
      lifecycle.forgetFact(
        ID,
        {
          reason: 'gone',
          forgetAfter: new Date(Date.now() + 1000).toISOString(),
        },
        { userId: editor.id },
        db(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('forget-after hides the fact once the time has passed, with no sweep', async () => {
    put('closes in 4 days');
    await lifecycle.forgetFact(
      ID,
      {
        reason: 'short lived',
        forgetAfter: new Date(Date.now() + 3_600_000).toISOString(),
      },
      { userId: editor.id },
      db(),
    );
    expect(facts.getFact(ID, db())).toBeDefined();
    expect(
      facts.getFact(ID, db(), {
        now: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      }),
    ).toBeUndefined();
    expect(facts.listFacts({ now: new Date(Date.now() + 2 * 3_600_000).toISOString() }, db())).toEqual([]);
  });

  it('a forgotten fact stays forgotten when the study writes it again', async () => {
    put('closes in 4 days');
    await lifecycle.forgetFact(ID, { reason: 'wrong' }, { userId: editor.id }, db());
    put('closes in 3 days');
    expect(facts.getFact(ID, db())).toBeUndefined();
    expect(facts.getFact(ID, db(), { includeForgotten: true })).toMatchObject({
      version: 2,
      forgetReason: 'wrong',
    });
  });

  it('restoring a fact that is not forgotten answers 409', () => {
    put('closes in 4 days');
    expect(() => lifecycle.restoreFact(ID, { userId: editor.id }, db())).toThrow(/not forgotten/);
  });

  it('a supersede of a chain that started with an extends link is an update', async () => {
    put('parent');
    const child = facts.upsertFact({ ...base, kind: 'purpose', statement: 'child' } as never, db(), new Date().toISOString(), undefined, undefined, { parentId: ID, relation: 'extends' });
    const next = await lifecycle.supersedeFact(child.id, { statement: 'child v2' }, {}, db());
    expect(next).toMatchObject({ version: 2, relation: 'updates', parentId: `${child.id}#v1` });
  });

  it('canFact follows the subject', () => {
    expect(canFact(actorOf(editor), { subjectType: 'workflow', subjectId: 'wf_f' }, 'update')).toBe(true);
    expect(canFact(actorOf(viewer), { subjectType: 'workflow', subjectId: 'wf_f' }, 'read')).toBe(true);
    expect(canFact(actorOf(viewer), { subjectType: 'workflow', subjectId: 'wf_f' }, 'update')).toBe(false);
    expect(canFact(actorOf(outsider), { subjectType: 'workflow', subjectId: 'wf_f' }, 'read')).toBe(false);
    expect(canFact(actorOf(editor), { subjectType: 'credential', subjectId: 'c1' }, 'read')).toBe(false);
    expect(canFact(actorOf(owner), { subjectType: 'credential', subjectId: 'c1' }, 'read')).toBe(true);
  });
});

describe('T-9 routes', () => {
  const enc = encodeURIComponent;

  it('GET /api/brain/facts answers 400 for a bad limit, lists history and forgotten facts', async () => {
    put('closes in 4 days');
    put('closes in 2 days');
    expect((await call(factsRoute.GET, '/api/brain/facts?limit=abc')).status).toBe(400);
    expect((await call(factsRoute.GET, '/api/brain/facts')).body.facts).toHaveLength(1);
    expect((await call(factsRoute.GET, '/api/brain/facts?history=1')).body.facts).toHaveLength(2);
    await lifecycle.forgetFact(ID, { reason: 'gone' }, { userId: owner.id }, db());
    expect((await call(factsRoute.GET, '/api/brain/facts')).body.facts).toHaveLength(0);
    expect((await call(factsRoute.GET, '/api/brain/facts?forgotten=1')).body.facts.map((f: any) => f.id)).toEqual([ID]);
    enableTestAuth(outsider);
    expect((await call(factsRoute.GET, '/api/brain/facts?forgotten=1')).body.facts).toEqual([]);
  });

  it('the versions of a forgotten fact are for editors only, and carry the reason only to them', async () => {
    put('closes in 4 days');
    put('closes in 2 days');
    await lifecycle.forgetFact(ID, { reason: 'private words' }, { userId: owner.id }, db());
    const url = `/api/brain/facts/${enc(ID)}/versions`;
    enableTestAuth(viewer);
    expect((await call(versionsRoute.GET, url, undefined, { id: enc(ID) })).status).toBe(404);
    enableTestAuth(editor);
    const seen = await call(versionsRoute.GET, url, undefined, { id: enc(ID) });
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).toContain('private words');
  });

  it('the list route says which facts the caller may forget', async () => {
    put('closes in 4 days');
    enableTestAuth(viewer);
    expect((await call(factsRoute.GET, '/api/brain/facts')).body.editable).toEqual([]);
    enableTestAuth(editor);
    expect((await call(factsRoute.GET, '/api/brain/facts')).body.editable).toEqual([ID]);
  });

  it('GET versions lists a chain oldest first and pages by cursor', async () => {
    for (let i = 1; i <= 5; i++) put(`statement ${i}`);
    const page = await call(versionsRoute.GET, `/api/brain/facts/${enc(ID)}/versions?limit=2`, undefined, { id: enc(ID) });
    expect(page.status).toBe(200);
    expect(page.body.versions.map((v: any) => v.version)).toEqual([1, 2]);
    expect(page.body.nextCursor).toBe('2');
    const rest = await call(versionsRoute.GET, `/api/brain/facts/${enc(ID)}/versions?limit=10&cursor=2`, undefined, { id: enc(ID) });
    expect(rest.body.versions.map((v: any) => v.version)).toEqual([3, 4, 5]);
    expect(rest.body.nextCursor).toBeUndefined();
  });

  it('versions of a fact the caller cannot see answer 404', async () => {
    put('closes in 4 days');
    enableTestAuth(outsider);
    expect((await call(versionsRoute.GET, `/api/brain/facts/${enc(ID)}/versions`, undefined, { id: enc(ID) })).status).toBe(404);
  });

  it('an entity fact id with a slash works through versions, forget and restore', async () => {
    const entity = entities.upsertEntity({
      type: 'customer',
      id: 'acme',
      name: 'Acme',
      projectId: team.id,
      attrs: {},
    }).entity;
    const added = await call(
      entityFactsRoute.POST,
      '/api/entities/customer/acme/facts',
      {
        method: 'POST',
        body: { kind: 'purpose', statement: 'Pays on time', isStatic: true },
      },
      { type: 'customer', id: 'acme' },
    );
    expect(added.status).toBe(201);
    const id = added.body.fact.id as string;
    expect(id).toContain('/');
    expect(added.body.fact.static).toBe(true);
    expect((await call(versionsRoute.GET, `/api/brain/facts/${enc(id)}/versions`, undefined, { id: enc(id) })).body.versions).toHaveLength(1);
    expect((await call(forgetRoute.POST, `/api/brain/facts/${enc(id)}/forget`, { method: 'POST', body: { reason: 'Wrong customer' } }, { id: enc(id) })).status).toBe(200);
    expect(facts.getFact(id, db())).toBeUndefined();
    expect((await call(restoreRoute.POST, `/api/brain/facts/${enc(id)}/restore`, { method: 'POST' }, { id: enc(id) })).status).toBe(200);
    expect(facts.getFact(id, db())).toBeDefined();
    void entity;
  });

  it('forget and restore: an editor may, a viewer gets 403, an outsider 404, an empty reason 400', async () => {
    put('closes in 4 days');
    const url = `/api/brain/facts/${enc(ID)}/forget`;
    const params = { id: enc(ID) };
    enableTestAuth(outsider);
    expect((await call(forgetRoute.POST, url, { method: 'POST', body: { reason: 'x' } }, params)).status).toBe(404);
    enableTestAuth(viewer);
    expect((await call(forgetRoute.POST, url, { method: 'POST', body: { reason: 'x' } }, params)).status).toBe(403);
    enableTestAuth(editor);
    expect((await call(forgetRoute.POST, url, { method: 'POST', body: { reason: '' } }, params)).status).toBe(400);
    expect((await call(forgetRoute.POST, url, { method: 'POST', body: { reason: 'It is wrong' } }, params)).status).toBe(200);
    enableTestAuth(outsider);
    expect((await call(restoreRoute.POST, `/api/brain/facts/${enc(ID)}/restore`, { method: 'POST' }, params)).status).toBe(404);
    expect(facts.getFact(ID, db(), { includeForgotten: true })?.forgottenAt).toBeDefined();
    enableTestAuth(editor);
    expect((await call(restoreRoute.POST, `/api/brain/facts/${enc(ID)}/restore`, { method: 'POST' }, params)).status).toBe(200);
  });

  it('a parentId the caller cannot read answers 404 and writes nothing', async () => {
    entities.upsertEntity({
      type: 'customer',
      id: 'beta',
      name: 'Beta',
      projectId: team.id,
      attrs: {},
    });
    put('closes in 4 days');
    const other = createTeamProject({ name: 'Other', createdBy: owner.id });
    setMember(other.id, outsider.id, 'editor');
    entities.upsertEntity({
      type: 'customer',
      id: 'mine',
      name: 'Mine',
      projectId: other.id,
      attrs: {},
    });
    enableTestAuth(outsider);
    const before = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM brain_facts')?.n;
    const answer = await call(
      entityFactsRoute.POST,
      '/api/entities/customer/mine/facts',
      {
        method: 'POST',
        body: {
          kind: 'purpose',
          statement: 'Linked',
          parentId: ID,
          relation: 'extends',
        },
      },
      { type: 'customer', id: 'mine' },
    );
    expect(answer.status).toBe(404);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM brain_facts')?.n).toBe(before);
  });
});

// A fake Postgres (a map behind `direct`, a queue behind the sink) takes `supersedeFact` through its Postgres path with no
// server (the pattern of approval-inbox-postgres-order-ap1.test.ts); the real server runs under LANDFLOW_INTEGRATION=postgres.
describe('T-5 conditional supersede in Postgres mode', () => {
  type Row = Record<string, unknown>;
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

  async function fake() {
    const { Database, migrateSqlite } = await import('@/lib/server/db/database');
    const remote = new Map<string, Row>();
    const queued: import('@/lib/server/db/database').WriteOp[] = [];
    // One connection per `direct` call, each with its own undo log: a rollback undoes only that transaction's writes.
    const connection = (): import('@/lib/server/db/database').DirectClient => {
      const undo: Array<() => void> = [];
      return {
        async query(text: string, values: unknown[] = []) {
          if (text === 'BEGIN') return { rows: [], rowCount: 0 };
          if (text === 'ROLLBACK') {
            for (const step of undo.splice(0).reverse()) step();
            return { rows: [], rowCount: 0 };
          }
          if (text === 'COMMIT') return { rows: [], rowCount: 0 };
          if (text.startsWith('INSERT INTO brain_facts')) {
            const columns = /\(([^)]*)\) VALUES/.exec(text)![1].split(', ');
            const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
            if (remote.has(String(row.id))) return { rows: [], rowCount: 0 };
            remote.set(String(row.id), row);
            undo.push(() => remote.delete(String(row.id)));
            return { rows: [{ id: row.id }] as never[], rowCount: 1 };
          }
          if (text.startsWith('UPDATE brain_facts SET')) {
            const [id, version] = values as [string, number];
            const row = remote.get(id);
            if (!row || Number(row.version) !== version) return { rows: [], rowCount: 0 };
            const before = { ...row };
            undo.push(() => remote.set(id, before));
            for (const m of text.split(' WHERE ')[0].matchAll(/(\w+) = \$(\d+)/g)) row[m[1]] = values[Number(m[2]) - 1];
            return { rows: [{ id }] as never[], rowCount: 1 };
          }
          if (text.startsWith('DELETE FROM brain_facts WHERE id')) {
            const before = remote.get(String(values[0]));
            remote.delete(String(values[0]));
            if (before) undo.push(() => remote.set(String(values[0]), before));
            return { rows: [], rowCount: before ? 1 : 0 };
          }
          if (text.startsWith('SELECT pg_notify')) return { rows: [], rowCount: 1 };
          throw new Error(`fake postgres: unexpected query ${text}`);
        },
      };
    };
    const sink: import('@/lib/server/db/database').WriteSink = {
      enqueue: (ops) => void queued.push(...ops),
      flush: async () => {
        for (const op of queued.splice(0)) {
          if (op.table !== 'brain_facts') continue;
          if (op.op === 'upsert') remote.set(String(op.row.id), { ...remote.get(String(op.row.id)), ...op.row });
          else if (op.op === 'insert') remote.has(String(op.row.id)) || remote.set(String(op.row.id), { ...op.row });
          else if (op.op === 'delete') remote.delete(String(op.where.id));
        }
      },
      close: async () => {},
      direct: (fn) => fn(connection()),
    };
    const sqlite = new DatabaseSync(':memory:');
    migrateSqlite(sqlite);
    return {
      handle: new Database(sqlite, 'postgres', ':memory:', sink),
      remote,
    };
  }

  it('one of two writers of the same version wins; Postgres holds one latest', async () => {
    const { handle, remote } = await fake();
    facts.upsertFact({ ...base, statement: 'closes in 4 days' } as never, handle, new Date().toISOString());
    await handle.flush();
    const results = await Promise.allSettled([lifecycle.supersedeFact(ID, { statement: 'one' }, {}, handle), lifecycle.supersedeFact(ID, { statement: 'two' }, {}, handle)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ name: 'StaleChainError' });
    const rows = [...remote.values()].filter((r) => r.root_id === ID);
    expect(rows.map((r) => [r.version, r.is_latest]).sort()).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(facts.getFact(ID, handle)?.version).toBe(2);
    expect(facts.getFact(`${ID}#v1`, handle)?.latest).toBe(false);
  });

  it('the 50-version trim and the key notice happen inside the transaction', async () => {
    const { handle, remote } = await fake();
    for (let i = 1; i <= 50; i++) facts.upsertFact({ ...base, statement: `s ${i}` } as never, handle, new Date().toISOString());
    await handle.flush();
    const notices: string[] = [];
    (handle as unknown as { sink: { keyNotice: (t: string, k: unknown[]) => string } }).sink.keyNotice = (_t, k) => `notice:${String(k[0])}`;
    const orig = (handle as unknown as { sink: { direct: (fn: (c: { query: (t: string, v?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown> } }).sink.direct;
    (handle as unknown as { sink: { direct: typeof orig } }).sink.direct = (fn) =>
      orig((c) => fn({ query: (t, v) => (t.startsWith('SELECT pg_notify') && notices.push(String(v?.[1])), c.query(t, v)) }));
    const next = await lifecycle.supersedeFact(ID, { statement: 'the 51st' }, {}, handle);
    expect(next.version).toBe(51);
    expect(remote.has(`${ID}#v2`)).toBe(false);
    expect(remote.has(`${ID}#v1`)).toBe(true);
    expect(notices.sort()).toEqual([`notice:${ID}`, `notice:${ID}#v50`]);
  });
});
