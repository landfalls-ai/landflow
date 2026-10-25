/**
 * The database layer: versioned migrations (`schema_version`), the one-time import of the JSON files
 * older versions kept (inserted once, files renamed to `<name>.imported-<date>` and never deleted,
 * idempotent), the store reopened on the same file, and the SQL Data Tables storage against the JSON
 * one (the same results for the same operations). Everything runs in temp directories.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-db-'));
const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = dataDir;

const { importJsonData, LATEST_VERSION, MIGRATIONS, migrateSqlite, openSqlite, openSqliteConnection, TABLES, closeDatabase, database } = await import('@/lib/server/db');
const { JsonFileStorage, SqlDataTableStorage, DataTablesService } = await import('@/lib/server/datatables');
const { store } = await import('@/lib/server/store');

afterAll(async () => {
  await closeDatabase();
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const tmp = (prefix = 'landflow-db-case-') => mkdtempSync(join(tmpdir(), prefix));
const write = (path: string, data: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
};

const workflow = (id: string, name = id): Workflow => ({
  id,
  name,
  nodes: [{ id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
});

const execution = (id: string, workflowId: string, status: ExecutionRecord['status'] = 'success', startedAt = '2026-02-01T10:00:00.000Z'): ExecutionRecord => ({
  executionId: id,
  workflowId,
  workflowName: workflowId,
  mode: 'trigger',
  status,
  startedAt,
  finishedAt: startedAt,
  durationMs: 12,
  runData: {},
  executionOrder: [],
});

describe('migrations', () => {
  it('creates every table and records the schema version', () => {
    const db = openSqlite(join(tmp(), 'landflow.db'));
    expect(db.schemaVersion()).toBe(LATEST_VERSION);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
    for (const table of [...Object.keys(TABLES), 'schema_version']) expect(tables).toContain(table);
    const versions = db.all<{ version: number; name: string }>('SELECT version, name FROM schema_version ORDER BY version');
    expect(versions.map((v) => Number(v.version))).toEqual(MIGRATIONS.map((m) => m.version));
    expect(versions[0].name).toBe('initial');
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
  });

  it('applies only what a database lacks, once, and refuses a newer schema', () => {
    const path = join(tmp(), 'landflow.db');
    const sqlite = openSqliteConnection(path);
    expect(migrateSqlite(sqlite)).toEqual([]);
    const next = [...MIGRATIONS, { version: LATEST_VERSION + 1, name: 'add a test table', statements: ['CREATE TABLE test_extra (id TEXT PRIMARY KEY)'] }];
    expect(migrateSqlite(sqlite, next)).toEqual([LATEST_VERSION + 1]);
    expect(migrateSqlite(sqlite, next)).toEqual([]);
    expect(() => migrateSqlite(sqlite)).toThrow(/newer than this Landflow build knows/);
    sqlite.close();
  });

  it('rolls a failing migration back as a whole', () => {
    const sqlite = openSqliteConnection(join(tmp(), 'landflow.db'));
    const broken = [...MIGRATIONS, { version: LATEST_VERSION + 1, name: 'broken', statements: ['CREATE TABLE half_done (id TEXT)', 'THIS IS NOT SQL'] }];
    expect(() => migrateSqlite(sqlite, broken)).toThrow();
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).not.toContain('half_done');
    expect(Number((sqlite.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v)).toBe(LATEST_VERSION);
    sqlite.close();
  });
});

describe('JSON import', () => {
  /** A data directory as an older Landflow left it. */
  function legacyDir() {
    const dir = tmp('landflow-legacy-');
    write(join(dir, 'workflows', 'wf_a.json'), workflow('wf_a', 'Imported A'));
    write(join(dir, 'workflows', 'wf_b.json'), { ...workflow('wf_b', 'Imported B'), active: true, folderId: 'fo_1' });
    writeFileSync(join(dir, 'workflows', 'broken.json'), '{ not json');
    write(join(dir, 'executions', 'ex_1.json'), execution('ex_1', 'wf_a', 'success', '2026-02-01T10:00:00.000Z'));
    write(join(dir, 'executions', 'ex_2.json'), { ...execution('ex_2', 'wf_a', 'waiting', '2026-02-02T10:00:00.000Z'), wait: { resume: 'time', until: '2030-01-01T00:00:00.000Z', nodeId: 'W', nodeName: 'W', since: '2026-02-02T10:00:00.000Z' } });
    write(join(dir, 'poll-state.json'), { 'wf_a:Poll': { seen: ['a', 'b'] } });
    write(join(dir, 'folders.json'), { folders: [{ id: 'fo_1', name: 'Imported folder', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] });
    write(join(dir, 'settings.json'), { timezone: 'Europe/Paris', executions: { maxCount: 42, maxAgeDays: 0 } });
    write(join(dir, 'variables.json'), { variables: [{ key: 'API_BASE', value: 'https://example.test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] });
    const summary = { id: 'v_1', workflowId: 'wf_a', number: 1, createdAt: '2026-01-01T00:00:00.000Z', name: 'Imported A', nodeCount: 1, hash: 'h1', summary: 'Created' };
    write(join(dir, 'workflow-versions', 'wf_a', 'index.json'), [summary]);
    write(join(dir, 'workflow-versions', 'wf_a', 'v_1.json'), { ...summary, workflow: workflow('wf_a', 'Imported A') });
    write(join(dir, 'data-tables', 'dt_1.json'), {
      table: { id: 'dt_1', name: 'People', columns: [{ name: 'name', type: 'string' }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      nextId: 3,
      rows: [
        { id: 1, name: 'Ada', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 2, name: 'Grace', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    // Not part of the database: left where they are.
    write(join(dir, 'credentials.json'), { credentials: [] });
    write(join(dir, 'insights.json'), { days: {} });
    return dir;
  }

  it('imports everything once and renames the files, never deleting them', () => {
    const dir = legacyDir();
    const db = openSqlite(join(dir, 'landflow.db'));
    const result = importJsonData(db, dir, new Date('2026-10-25T08:00:00Z'));

    expect(result.counts).toMatchObject({
      'landflow.db.imported.workflows': 2,
      'landflow.db.imported.executions': 2,
      'landflow.db.imported.polls': 1,
      'landflow.db.imported.folders': 1,
      'landflow.db.imported.settings': 1,
      'landflow.db.imported.variables': 1,
      'landflow.db.imported.versions': 1,
      'landflow.db.imported.data_tables': 1,
    });
    expect(result.skipped).toEqual(['workflows/broken.json']);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM data_table_rows')?.n).toBe(2);
    expect(db.get<{ next_row_id: number }>('SELECT next_row_id FROM data_tables WHERE id = ?', 'dt_1')?.next_row_id).toBe(3);
    expect(db.get<{ status: string; wait_until: string | null }>('SELECT status, wait_until FROM executions WHERE id = ?', 'ex_2')).toMatchObject({ status: 'waiting' });

    const names = readdirSync(dir).sort();
    for (const name of ['workflows', 'executions', 'poll-state.json', 'folders.json', 'settings.json', 'variables.json', 'workflow-versions', 'data-tables']) {
      expect(names).not.toContain(name);
      expect(names).toContain(`${name}.imported-2026-10-25`);
    }
    // Every file is still there, the unreadable one included.
    expect(readdirSync(join(dir, 'workflows.imported-2026-10-25')).sort()).toEqual(['broken.json', 'wf_a.json', 'wf_b.json']);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json.imported-2026-10-25'), 'utf8')).timezone).toBe('Europe/Paris');
    expect(names).toContain('credentials.json');
    expect(names).toContain('insights.json');
  });

  it('is idempotent: a second run finds nothing, and rows that exist are never overwritten', () => {
    const dir = legacyDir();
    const db = openSqlite(join(dir, 'landflow.db'));
    // Already in the database (say, edited after an import that was interrupted before the renames).
    db.upsert('workflows', { id: 'wf_a', name: 'Edited since', active: 0, folder_id: null, created_at: null, updated_at: null, data: JSON.stringify(workflow('wf_a', 'Edited since')) });
    const first = importJsonData(db, dir, new Date('2026-10-25T08:00:00Z'));
    expect(first.counts['landflow.db.imported.workflows']).toBe(1);
    expect(db.get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', 'wf_a')?.name).toBe('Edited since');

    expect(importJsonData(db, dir, new Date('2026-10-25T09:00:00Z'))).toEqual({ counts: {}, renamed: [], skipped: [] });

    // The same files showing up again (restored from a backup): imported as far as they are new, renamed with a suffix.
    write(join(dir, 'workflows', 'wf_c.json'), workflow('wf_c'));
    write(join(dir, 'workflows', 'wf_b.json'), workflow('wf_b', 'Older copy'));
    const again = importJsonData(db, dir, new Date('2026-10-25T10:00:00Z'));
    expect(again.counts).toEqual({ 'landflow.db.imported.workflows': 1 });
    expect(again.renamed).toEqual(['workflows → workflows.imported-2026-10-25-2']);
    expect(db.get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', 'wf_b')?.name).toBe('Imported B');
  });

  it('runs on the first open of a data directory, and the store reads the imported data', async () => {
    const dir = legacyDir();
    await closeDatabase();
    process.env.LANDFLOW_DATA_DIR = dir;
    try {
      store.reload();
      expect(store.getWorkflow('wf_b')?.name).toBe('Imported B');
      expect(store.listExecutions().map((e) => e.id)).toEqual(['ex_2', 'ex_1']);
      expect(store.waitingExecutions().map((e) => e.executionId)).toEqual(['ex_2']);
      expect(store.getPoll('wf_a:Poll')).toEqual({ seen: ['a', 'b'] });
      expect(existsSync(join(dir, 'landflow.db'))).toBe(true);
      expect(existsSync(join(dir, 'workflows'))).toBe(false);
    } finally {
      await closeDatabase();
      process.env.LANDFLOW_DATA_DIR = dataDir;
      store.reload();
    }
  });
});

describe('store on SQLite', () => {
  it('keeps what it saved across a reopen of the file', async () => {
    store.saveWorkflow(workflow('wf_reopen', 'Survives'));
    store.saveExecution(execution('ex_reopen', 'wf_reopen'));
    store.setPoll('wf_reopen:Poll', { cursor: 7 } as never);
    await closeDatabase();
    store.reload();
    expect(store.getWorkflow('wf_reopen')?.name).toBe('Survives');
    expect(store.getExecution('ex_reopen')?.status).toBe('success');
    expect(store.getPoll('wf_reopen:Poll')).toEqual({ cursor: 7 });
    expect(database().schemaVersion()).toBe(LATEST_VERSION);
  });

  it('saves node runs and checkpoints of a running execution, and clears them', () => {
    store.saveExecution(execution('ex_steps', 'wf_reopen', 'running'));
    const run = { startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, status: 'success' as const, source: 'main' as const, inputs: [], outputs: [[{ json: { n: 1 } }]] };
    store.saveStep('ex_steps', 0, 'Start', run);
    store.saveStep('ex_steps', 1, 'Next', run);
    const state = { version: 1 as const, startedAt: '2026-01-01T00:00:00.000Z', activeMs: 5, stack: [], parked: [], nodeOutputs: {}, runData: {}, executionOrder: [], nodeState: {} };
    store.saveCheckpoint('ex_steps', { stepId: 'Start#0', steps: 1, state, baseSteps: 0, baseOutputs: { Start: [[{ json: { n: 1 } }]] } });
    store.saveCheckpoint('ex_steps', { stepId: 'Next#0', steps: 2, state });
    expect(store.steps('ex_steps').map((s) => [s.seq, s.nodeId])).toEqual([
      [0, 'Start'],
      [1, 'Next'],
    ]);
    // A later checkpoint keeps where the segment started.
    expect(store.getCheckpoint('ex_steps')).toMatchObject({ stepId: 'Next#0', steps: 2, baseSteps: 0, baseOutputs: { Start: [[{ json: { n: 1 } }]] } });
    // Running executions are listed by the runner, not the store.
    expect(store.listExecutions({ workflowId: 'wf_reopen' }).map((e) => e.id)).toEqual(['ex_reopen']);
    store.clearCheckpoint('ex_steps', true);
    expect(store.steps('ex_steps')).toEqual([]);
    expect(store.getCheckpoint('ex_steps')?.stepId).toBe('Next#0');
    store.deleteExecution('ex_steps');
    expect(store.getCheckpoint('ex_steps')).toBeUndefined();
  });
});

describe('Data Tables: SQL storage matches the JSON storage', () => {
  const both = () => {
    const sqlDb = openSqlite(join(tmp(), 'landflow.db'));
    return [new DataTablesService(new JsonFileStorage(tmp(), new Map())), new DataTablesService(new SqlDataTableStorage(() => sqlDb, new Map()))] as const;
  };
  /** Run the same steps on both; their results must be equal (timestamps aside). */
  const strip = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (key, v) =>
        key === 'createdAt' || key === 'updatedAt' || key === 'id' ? undefined : typeof v === 'string' ? v.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>') : v,
      ),
    );

  it('gives the same rows for inserts, queries, updates, upserts, column changes and deletes', () => {
    const results = both().map((svc) => {
      const table = svc.createTable({ name: 'People', columns: [{ name: 'name', type: 'string' }, { name: 'age', type: 'number' }, { name: 'active', type: 'boolean' }] });
      const out: unknown[] = [];
      out.push(svc.insertRows(table.id, [{ name: 'Ada', age: 36, active: true }, { name: 'Grace', age: '45', active: 'yes' }, { name: 'Linus', age: 28, active: false }]));
      out.push(svc.listRows(table.id, { filter: { type: 'and', conditions: [{ column: 'age', operator: 'gt', value: 30 }] }, sortBy: 'age', sortDirection: 'desc' }));
      out.push(svc.listRows(table.id, { search: 'li', limit: 1 }));
      out.push(svc.updateRows(table.id, { type: 'and', conditions: [{ column: 'name', operator: 'eq', value: 'Linus' }] }, { age: 29 }));
      out.push(svc.upsertRows(table.id, ['name'], [{ name: 'Ada', age: 37 }, { name: 'Margaret', age: 50 }]));
      out.push(svc.renameColumn(table.id, 'age', 'years'));
      out.push(svc.deleteColumn(table.id, 'active'));
      out.push(svc.deleteRows(table.id, { type: 'and', conditions: [{ column: 'years', operator: 'lt', value: 40 }] }));
      out.push(svc.listRows(table.id));
      out.push(svc.exportCsv(table.id));
      out.push(svc.listTables().map((t) => ({ name: t.name, rowCount: (t as { rowCount?: number }).rowCount })));
      return strip(out);
    });
    expect(results[1]).toEqual(results[0]);
  });

  it('keeps rows and the next row id across a reopen', () => {
    const dir = tmp();
    const path = join(dir, 'landflow.db');
    let db = openSqlite(path);
    const svc = new DataTablesService(new SqlDataTableStorage(() => db, new Map()));
    const table = svc.createTable({ name: 'Ids', columns: [{ name: 'v', type: 'string' }] });
    svc.insertRows(table.id, [{ v: 'a' }, { v: 'b' }]);
    svc.deleteRows(table.id, { type: 'and', conditions: [{ column: 'v', operator: 'eq', value: 'b' }] });
    db = openSqlite(path);
    const reopened = new DataTablesService(new SqlDataTableStorage(() => db, new Map()));
    expect(reopened.listRows(table.id).rows.map((r) => r.v)).toEqual(['a']);
    expect(reopened.insertRows(table.id, [{ v: 'c' }])[0].id).toBe(3);
  });
});
