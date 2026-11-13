/**
 * Seed a throwaway Postgres database with finished executions and their journals, and measure what the host's in-memory
 * copy costs to load them (docs/deployment.md, "Postgres memory sizing"):
 *
 *   DATABASE_URL=postgres://…/landflow_test npx tsx --tsconfig tsconfig.json scripts/seed-executions.ts [count] [--measure]
 *
 * `count` (default 50000) finished runs are inserted, each with a record of about 10 KB (six node runs, 50 items of
 * run data) and 20 journal events of about 1 KB, finished two days ago (so all of them are cold); 5 more are running.
 * `--measure` then opens the database like the host does (migrations, spool replay, the in-memory copy) and prints the boot
 * time, the process's resident memory and the rows the copy holds. The database name must end in `_test`: the script
 * deletes every execution in it first. The measurements are in docs/history.md.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';

export interface SeedOptions {
  /** Finished executions (each with `events` journal events). */
  count: number;
  /** Executions still running (each with `events` events). */
  running?: number;
  /** Journal events per execution. */
  events?: number;
  /** Items of run data per node run, in and out (about 200 bytes each). */
  items?: number;
  /** How long ago the finished ones finished, in minutes (default two days). */
  finishedMinutesAgo?: number;
}

/** A saved record, with `__ID__` and `__STATUS__` standing where the SQL puts each row's own. */
function template(items: number): string {
  const nodeRun = {
    status: 'success',
    source: 'main',
    startedAt: '2026-11-01T10:00:00.000Z',
    durationMs: 120,
    inputs: [Array.from({ length: items }, (_, i) => ({ json: { index: i, name: `Customer ${i}`, email: `customer${i}@example.com`, note: 'x'.repeat(80) } }))],
    outputs: [Array.from({ length: items }, (_, i) => ({ json: { index: i, name: `Customer ${i}`, email: `customer${i}@example.com`, note: 'y'.repeat(80) } }))],
  };
  return JSON.stringify({
    executionId: '__ID__',
    workflowId: 'wf_seed',
    workflowName: 'Seeded workflow',
    mode: 'trigger',
    status: '__STATUS__',
    startedAt: '2026-11-01T10:00:00.000Z',
    finishedAt: '2026-11-01T10:00:02.000Z',
    durationMs: 2000,
    runData: Object.fromEntries(Array.from({ length: 6 }, (_, n) => [`node_${n}`, [nodeRun]])),
    executionOrder: Array.from({ length: 6 }, (_, n) => `node_${n}`),
  });
}

/** Insert the executions and their events straight into Postgres (one statement each: fast enough for 100,000). */
export async function seedExecutions(pool: Pool, options: SeedOptions): Promise<void> {
  const { count, running = 5, events = 20, items = 50, finishedMinutesAgo = 2 * 24 * 60 } = options;
  const record = template(items);
  const event = JSON.stringify({ type: 'span.ended', spanId: 'span', executionId: '__ID__', seq: 0, at: '2026-11-01T10:00:01.000Z', output: 'z'.repeat(900) });
  const finishedAt = new Date(Date.now() - finishedMinutesAgo * 60_000).toISOString();
  const startedAt = new Date(Date.now() - (finishedMinutesAgo + 1) * 60_000).toISOString();
  const runningAt = new Date(Date.now() - 60_000).toISOString();
  const insert = async (prefix: string, total: number, status: string, finished: string | null) => {
    if (total <= 0) return;
    await pool.query(
      `INSERT INTO executions (id, workflow_id, status, mode, started_at, finished_at, duration_ms, summary, data)
       SELECT $1 || n, 'wf_seed', $2, 'trigger', $3, $4, 2000, '{}', replace(replace($5, '__ID__', $1 || n), '__STATUS__', $2) FROM generate_series(1, $6::int) AS n
       ON CONFLICT (id) DO NOTHING`,
      [prefix, status, finished ? startedAt : runningAt, finished, record, total],
    );
    await pool.query(
      `INSERT INTO execution_events (execution_id, seq, at, type, span_id, data)
       SELECT $1 || n, s, $2, 'span.ended', 'span', replace(replace($3, '__ID__', $1 || n), '"seq":0', '"seq":' || s) FROM generate_series(1, $4::int) AS n, generate_series(1, $5::int) AS s
       ON CONFLICT (execution_id, seq) DO NOTHING`,
      [prefix, finished ?? runningAt, event, total, events],
    );
  };
  await pool.query('DELETE FROM execution_events');
  await pool.query('DELETE FROM executions');
  await insert('seed_done_', count, 'success', finishedAt);
  await insert('seed_running_', running, 'running', null);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('Refusing to seed: the database name must end in _test');
  const count = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) ?? 50_000);
  const pg = (await import('pg')).default;
  const { openPostgres, migratePostgres } = await import('../src/lib/server/db/postgres');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await migratePostgres(pool);
  const started = Date.now();
  await seedExecutions(pool, { count });
  const size = (await pool.query("SELECT pg_size_pretty(pg_total_relation_size('executions') + pg_total_relation_size('execution_events')) AS size")).rows[0].size;
  console.log(`seeded ${count} finished and 5 running executions in ${((Date.now() - started) / 1000).toFixed(1)} s (${size} in Postgres)`);
  await pool.end();
  if (!process.argv.includes('--measure')) return;
  const before = process.memoryUsage().rss;
  const boot = Date.now();
  const db = await openPostgres(url, mkdtempSync(join(tmpdir(), 'landflow-seed-')));
  const seconds = (Date.now() - boot) / 1000;
  const held = db.get<{ runs: number; data: number; events: number }>("SELECT (SELECT COUNT(*) FROM executions) AS runs, (SELECT COUNT(*) FROM executions WHERE data <> '') AS data, (SELECT COUNT(*) FROM execution_events) AS events");
  console.log(`boot ${seconds.toFixed(1)} s, rss ${(before / 1048576).toFixed(0)} -> ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB; copy holds ${held?.runs} runs, ${held?.data} with data, ${held?.events} events`);
  await db.close();
}

if (process.argv[1]?.endsWith('seed-executions.ts')) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
