/**
 * C01: a brain fact is a chain of versions. The chain id keeps naming the latest one; every read sees the latest live
 * version only (docs/second-brain.md#fact-versions). Written test first, one `describe` per task.
 */
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-fact-versions-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { migrateSqlite } = await import('@/lib/server/db/database');
const { MIGRATIONS } = await import('@/lib/server/db/schema');
const facts = await import('@/lib/server/brain/facts');
const { onBrainChange } = await import('@/lib/server/brain/store/port');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const columns = (table: string) =>
  database()
    .all<{ name: string }>(`PRAGMA table_info(${table})`)
    .map((c) => c.name);
const base = { subjectType: 'workflow', subjectId: 'w1', kind: 'health', confidence: 0.6 } as const;
const input = (statement: string) => ({ ...base, statement }) as never;
const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();

describe('T-1 migrations', () => {
  it('adds the version and forget columns', () => {
    for (const c of ['version', 'is_latest', 'parent_id', 'root_id', 'is_static', 'relation', 'forgotten_at', 'forget_reason', 'forgotten_by', 'forget_after'])
      expect(columns('brain_facts'), c).toContain(c);
    for (const c of ['forgotten_at', 'forget_reason', 'forgotten_by']) expect(columns('team_notes'), c).toContain(c);
  });

  it('migrates a fact written before 2912 as version 1, latest, its own root', () => {
    const sqlite = new DatabaseSync(':memory:');
    migrateSqlite(
      sqlite,
      MIGRATIONS.filter((m) => m.version < 2912),
    );
    sqlite
      .prepare(
        "INSERT INTO brain_facts (id, subject_type, subject_id, kind, project_id, status, last_seen, data) VALUES ('workflow:old:health', 'workflow', 'old', 'health', NULL, 'active', 'x', '{}')",
      )
      .run();
    expect(migrateSqlite(sqlite, MIGRATIONS)).toEqual(expect.arrayContaining([2912, 2913])) // later migrations (C07's 2915 ...) run after;
    const row = sqlite.prepare("SELECT version, is_latest, root_id, is_static, parent_id, relation FROM brain_facts WHERE id = 'workflow:old:health'").get();
    expect({ ...row }).toEqual({ version: 1, is_latest: 1, root_id: 'workflow:old:health', is_static: 0, parent_id: null, relation: null });
  });
});

describe('T-3 reads filter in SQL', () => {
  it('lists, searches, counts and gets only the latest live version', () => {
    const db = database();
    facts.upsertFact(input('fails 2 percent of runs'), db, at(1));
    facts.upsertFact(input('fails 9 percent of runs'), db, at(2));
    facts.upsertFact({ ...base, subjectId: 'w2', statement: 'forgotten one' } as never, db, at(1));
    db.upsert('brain_facts', {
      id: 'workflow:w2:health',
      subject_type: 'workflow',
      subject_id: 'w2',
      kind: 'health',
      status: 'active',
      last_seen: at(1),
      data: JSON.stringify(facts.getFact('workflow:w2:health')),
      forgotten_at: at(3),
    });
    facts.upsertFact({ ...base, subjectId: 'w3', statement: 'lapsed one' } as never, db, at(1));
    db.upsert('brain_facts', {
      id: 'workflow:w3:health',
      subject_type: 'workflow',
      subject_id: 'w3',
      kind: 'health',
      status: 'active',
      last_seen: at(1),
      data: JSON.stringify(facts.getFact('workflow:w3:health')),
      forget_after: '2000-01-01T00:00:00.000Z',
    });

    expect(facts.listFacts({}, db).map((f) => f.id)).toEqual(['workflow:w1:health']);
    expect(facts.searchFacts('fails', {}, db).map((f) => f.statement)).toEqual(['fails 9 percent of runs']);
    expect(facts.countFacts(db).facts).toBe(1);
    expect(facts.getFact('workflow:w2:health', db)).toBeUndefined();
    expect(facts.getFact('workflow:w2:health', db, { includeForgotten: true })?.id).toBe('workflow:w2:health');
    expect(
      facts
        .listFacts({ history: true, subjectId: 'w1' }, db)
        .map((f) => f.id)
        .sort(),
    ).toEqual(['workflow:w1:health', 'workflow:w1:health#v1']);
    expect(
      facts
        .listFacts({ forgotten: 'only' }, db)
        .map((f) => f.id)
        .sort(),
    ).toEqual(['workflow:w2:health', 'workflow:w3:health']);
  });

  it('puts the filter and the limit in the query', () => {
    const db = database();
    for (let i = 0; i < 30; i++) facts.upsertFact({ ...base, subjectId: `bulk${i}`, statement: `s ${i}` } as never, db, at(10));
    const spy = vi.spyOn(db, 'all');
    expect(facts.listFacts({ limit: 10 }, db)).toHaveLength(10);
    const sql = String(spy.mock.calls[0][0]);
    expect(sql).toContain('is_latest = 1');
    expect(sql).toMatch(/LIMIT/);
    spy.mockRestore();
  });
});

describe('T-4 versioned writes', () => {
  it('a reworded statement is version 2 and keeps the chain id; the old one moves to #v1', async () => {
    const db = database();
    const events: Array<{ key: string; op: string }> = [];
    const off = onBrainChange((e) => events.push({ key: e.key, op: e.op }));
    facts.upsertFact({ ...base, subjectId: 'v1', statement: 'fails 2 percent' } as never, db, at(1));
    await Promise.resolve();
    events.length = 0;
    const next = facts.upsertFact({ ...base, subjectId: 'v1', statement: 'fails 9 percent' } as never, db, at(2));
    await Promise.resolve();
    off();
    expect(next).toMatchObject({ id: 'workflow:v1:health', version: 2, latest: true, parentId: 'workflow:v1:health#v1', rootId: 'workflow:v1:health', relation: 'updates', firstSeen: at(2) });
    const old = facts.getFact('workflow:v1:health#v1', db);
    expect(old).toMatchObject({ statement: 'fails 2 percent', version: 1, latest: false });
    expect(facts.getFact('workflow:v1:health', db)?.statement).toBe('fails 9 percent');
    expect(events).toEqual([{ key: 'workflow:v1:health', op: 'upsert' }]);
    const row = db.get<{ is_latest: number; version: number }>("SELECT is_latest, version FROM brain_facts WHERE id = 'workflow:v1:health#v1'");
    expect(row).toMatchObject({ is_latest: 0, version: 1 });
  });

  it('the same statement (spaces and case differ) adds no version and moves last_seen', () => {
    const db = database();
    facts.upsertFact({ ...base, subjectId: 'v2', statement: 'fails 2 percent' } as never, db, at(1));
    const again = facts.upsertFact({ ...base, subjectId: 'v2', statement: '  Fails  2 percent ' } as never, db, at(5));
    expect(again).toMatchObject({ version: 1, lastSeen: at(5), statement: 'fails 2 percent' });
    expect(facts.listFacts({ history: true, subjectId: 'v2' }, db)).toHaveLength(1);
  });

  it('bounds a chain at 50 versions: the root and the newest 49 stay, older rows are deleted', () => {
    const db = database();
    for (let i = 1; i <= 60; i++) facts.upsertFact({ ...base, subjectId: 'cap', statement: `statement ${i}` } as never, db, at(i));
    const all = facts.factVersions('workflow:cap:health', { limit: 100 }, db).versions;
    expect(all).toHaveLength(50);
    expect(all[0]).toMatchObject({ version: 1, statement: 'statement 1' });
    expect(all[1].version).toBe(12);
    expect(all.at(-1)).toMatchObject({ version: 60, statement: 'statement 60' });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM brain_facts WHERE root_id = 'workflow:cap:health'")?.n).toBe(50);
  });

  it('a static fact that refuses a write sends no change event', async () => {
    const db = database();
    facts.upsertFact({ ...base, subjectId: 'ev', statement: 'fixed' } as never, db, at(1), undefined, undefined, { isStatic: true });
    await Promise.resolve();
    const events: string[] = [];
    const off = onBrainChange((e) => events.push(e.key));
    facts.upsertFact({ ...base, subjectId: 'ev', statement: 'other' } as never, db, at(2));
    await Promise.resolve();
    off();
    expect(events).toEqual([]);
  });

  it('a live fact with a pending forget-after never carries the reason to a reader', () => {
    const db = database();
    facts.upsertFact({ ...base, subjectId: 'pend', statement: 'soon gone' } as never, db, at(1));
    const row = db.get<{ data: string }>("SELECT data FROM brain_facts WHERE id = 'workflow:pend:health'")!;
    db.upsert('brain_facts', {
      id: 'workflow:pend:health',
      subject_type: 'workflow',
      subject_id: 'pend',
      kind: 'health',
      status: 'active',
      last_seen: at(1),
      data: row.data,
      forget_after: '2099-01-01T00:00:00.000Z',
      forget_reason: 'a secret reason',
      forgotten_by: 'usr_1',
    });
    for (const f of [
      facts.getFact('workflow:pend:health', db),
      facts.listFacts({ subjectId: 'pend' }, db)[0],
      facts.searchFacts('soon', {}, db)[0],
      facts.factVersions('workflow:pend:health', { limit: 5 }, db).versions[0],
    ]) {
      expect(f).toBeDefined();
      expect(JSON.stringify(f)).not.toContain('secret reason');
      expect(JSON.stringify(f)).not.toContain('usr_1');
    }
    expect(facts.getFact('workflow:pend:health', db, { includeForgotten: true })?.forgetReason).toBe('a secret reason');
    // A new version of it keeps the pending forget.
    expect(facts.upsertFact({ ...base, subjectId: 'pend', statement: 'still soon gone' } as never, db, at(2))).toMatchObject({ version: 2, forgetReason: 'a secret reason' });
  });

  it('keeps a static fact unchanged without replaceStatic, and writes it with it', () => {
    const db = database();
    facts.upsertFact({ ...base, subjectId: 'st', statement: 'belongs to Finance' } as never, db, at(1), undefined, undefined, { isStatic: true });
    const kept = facts.upsertFact({ ...base, subjectId: 'st', statement: 'belongs to Sales' } as never, db, at(2));
    expect(kept).toMatchObject({ statement: 'belongs to Finance', static: true, version: 1 });
    const replaced = facts.upsertFact({ ...base, subjectId: 'st', statement: 'belongs to Sales' } as never, db, at(3), undefined, undefined, { replaceStatic: true });
    expect(replaced).toMatchObject({ statement: 'belongs to Sales', version: 2, static: true });
  });

  it('a static fact never goes stale', () => {
    const db = database();
    facts.upsertFact({ ...base, subjectId: 'st2', statement: 'never changes' } as never, db, at(1), undefined, undefined, { isStatic: true });
    facts.staleFactsBefore(at(100), db);
    expect(facts.getFact('workflow:st2:health', db)?.status).toBe('active');
  });

  it('staleness keeps the chain: the old versions stay as they are', () => {
    const db = database();
    facts.upsertFact({ ...base, subjectId: 'st3', statement: 'a' } as never, db, at(1));
    facts.upsertFact({ ...base, subjectId: 'st3', statement: 'b' } as never, db, at(2));
    facts.staleFactsBefore(at(100), db);
    expect(facts.getFact('workflow:st3:health', db)?.status).toBe('stale');
    expect(facts.getFact('workflow:st3:health#v1', db)?.status).toBe('active');
  });

  it('deleteFact removes the whole chain with one event for the chain id', async () => {
    const db = database();
    facts.upsertFact({ ...base, subjectId: 'del', statement: 'a' } as never, db, at(1));
    facts.upsertFact({ ...base, subjectId: 'del', statement: 'b' } as never, db, at(2));
    const events: Array<{ key: string; op: string }> = [];
    const off = onBrainChange((e) => events.push({ key: e.key, op: e.op }));
    expect(facts.deleteFact('workflow:del:health', db)).toBe(true);
    await Promise.resolve();
    off();
    expect(events).toEqual([{ key: 'workflow:del:health', op: 'delete' }]);
    expect(facts.listFacts({ history: true, subjectId: 'del' }, db)).toHaveLength(0);
  });

  it('an extends link starts a new chain pointing at the linked fact', () => {
    const db = database();
    facts.upsertFact({ ...base, subjectId: 'ln', statement: 'parent' } as never, db, at(1));
    const child = facts.upsertFact({ ...base, subjectId: 'ln', kind: 'purpose', statement: 'child' } as never, db, at(2), undefined, undefined, {
      parentId: 'workflow:ln:health',
      relation: 'extends',
    });
    expect(child).toMatchObject({ version: 1, parentId: 'workflow:ln:health', relation: 'extends', rootId: 'workflow:ln:purpose' });
  });
});
