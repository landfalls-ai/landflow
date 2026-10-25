/**
 * Postgres mode (LANDFLOW_DB=postgres, DATABASE_URL). The store API is synchronous, so the host
 * keeps a full copy of the database in an in-memory SQLite connection, loaded at boot: every read
 * is served from it with the same SQL as SQLite mode, and every committed write is applied to it
 * at once and replayed on Postgres, in order, by a background queue.
 *
 * Durability: a batch is appended to `<data dir>/postgres-queue.jsonl` before it is queued, and
 * Postgres records the last batch it applied (`meta.postgres.replica_seq`, in the same transaction).
 * At boot the file is replayed from there, so writes not yet in Postgres when the host stopped or
 * crashed are not lost; the file is emptied whenever the queue drains.
 *
 * Limits: one host per database (an advisory lock refuses a second one) until queue mode, and the
 * whole database lives in memory.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { logger } from '../telemetry/logger';
import { Database, openSqliteConnection, upsertSql, type SqlValue, type WriteOp, type WriteSink } from './database';
import { LATEST_VERSION, MIGRATIONS, SCHEMA_VERSION_TABLE, TABLES, type TableName } from './schema';

/** Held for the life of the host: a second host on the same database fails to start. */
const INSTANCE_LOCK = 0x4c414e44; // "LAND"
/** Serializes migrations of concurrent boots. */
const MIGRATION_LOCK = 0x4c414e45;
const SEQ_KEY = 'postgres.replica_seq';
/** Ops per Postgres transaction when the queue has a backlog. */
const MAX_OPS_PER_FLUSH = 500;

interface Batch {
  seq: number;
  ops: WriteOp[];
}

const dollar = (index: number) => `$${index}`;

/** The SQL and parameters of one write on Postgres. */
export function postgresStatement(op: WriteOp): { text: string; values: SqlValue[] } {
  if (op.op === 'delete') {
    const columns = Object.keys(op.where);
    return { text: `DELETE FROM ${op.table} WHERE ${columns.map((c, i) => `${c} = $${i + 1}`).join(' AND ')}`, values: columns.map((c) => op.where[c]) };
  }
  if (op.op === 'deleteBefore') return { text: `DELETE FROM ${op.table} WHERE ${op.column} < $1`, values: [op.value] };
  const columns = Object.keys(op.row);
  return { text: upsertSql(op.table, columns, op.op, dollar), values: columns.map((c) => op.row[c]) };
}

/** Connection failures are retried until Postgres is back; anything else is a bad batch. */
function isConnectionError(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? '');
  return !code || code.startsWith('08') || code.startsWith('57') || code.startsWith('E') || code === '53300';
}

async function setSeq(client: PoolClient | Pool, seq: number) {
  await client.query(`INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [SEQ_KEY, String(seq)]);
}

/** Apply the migrations Postgres lacks, in one transaction (an advisory lock keeps concurrent boots apart). */
export async function migratePostgres(pool: Pool): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await client.query(SCHEMA_VERSION_TABLE);
    const current = Number((await client.query('SELECT MAX(version) AS version FROM schema_version')).rows[0]?.version ?? 0);
    if (current > LATEST_VERSION) throw new Error(`The database has schema version ${current}, newer than this Landflow build knows (${LATEST_VERSION})`);
    const applied: number[] = [];
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      for (const statement of migration.postgres ?? migration.statements) await client.query(statement);
      await client.query('INSERT INTO schema_version (version, name, applied_at) VALUES ($1, $2, $3)', [migration.version, migration.name, new Date().toISOString()]);
      applied.push(migration.version);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** The ordered, spooled write queue to Postgres. */
class PostgresSink implements WriteSink {
  private queue: Batch[] = [];
  private draining?: Promise<void>;
  private failures = 0;
  private closed = false;

  constructor(
    private readonly pool: Pool,
    private readonly lock: PoolClient,
    private readonly spool: string,
    private seq: number,
  ) {}

  enqueue(ops: WriteOp[]) {
    if (this.closed) throw new Error('The Postgres store is closed');
    const batch = { seq: ++this.seq, ops };
    // On disk before anything else: a crash before Postgres has it replays it at the next boot.
    appendFileSync(this.spool, `${JSON.stringify(batch)}\n`);
    this.queue.push(batch);
    this.drain();
  }

  private drain() {
    this.draining ??= this.run().finally(() => {
      this.draining = undefined;
      if (this.queue.length && !this.closed) this.drain();
    });
  }

  private async run() {
    while (this.queue.length) {
      // Several small batches go in one transaction; a big one goes alone.
      const take: Batch[] = [];
      let ops = 0;
      for (const batch of this.queue) {
        if (take.length && ops + batch.ops.length > MAX_OPS_PER_FLUSH) break;
        take.push(batch);
        ops += batch.ops.length;
      }
      try {
        await applyBatches(this.pool, take);
        this.queue.splice(0, take.length);
        this.failures = 0;
        if (!this.queue.length) writeFileSync(this.spool, '');
      } catch (error) {
        this.failures++;
        if (!isConnectionError(error) && this.failures >= 5) {
          // A batch Postgres keeps rejecting would block every later write: drop it, loudly.
          const dropped = take[0];
          logger.error('postgres store: dropped a write batch Postgres rejects', { error, 'landflow.db.seq': dropped.seq, 'landflow.db.ops': JSON.stringify(dropped.ops).slice(0, 2000) });
          this.queue.shift();
          await setSeq(this.pool, dropped.seq).catch(() => {});
          this.failures = 0;
          continue;
        }
        if (this.failures === 1 || this.failures % 20 === 0) logger.warn('postgres store: write failed, retrying', { error, 'landflow.db.queued': this.queue.length });
        if (this.closed) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 250 * 2 ** Math.min(this.failures, 7))).unref?.());
      }
    }
  }

  async flush(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length && Date.now() < deadline) {
      this.drain();
      await Promise.race([this.draining, new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())).unref?.())]);
    }
    if (this.queue.length) throw new Error(`${this.queue.length} write batch(es) not yet in Postgres (kept in ${this.spool})`);
  }

  async close() {
    try {
      await this.flush();
    } finally {
      this.closed = true;
      this.lock.release();
      await this.pool.end();
    }
  }
}

/** Apply batches in one Postgres transaction and record the last one's sequence number. */
async function applyBatches(pool: Pool, batches: Batch[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const batch of batches) {
      for (const op of batch.ops) {
        const { text, values } = postgresStatement(op);
        await client.query(text, values);
      }
    }
    await setSeq(client, batches.at(-1)!.seq);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Replay what the spool holds past Postgres' last applied batch. Returns the sequence number to continue from. */
async function replaySpool(pool: Pool, spool: string): Promise<number> {
  const applied = Number((await pool.query('SELECT value FROM meta WHERE key = $1', [SEQ_KEY])).rows[0]?.value ?? 0);
  if (!existsSync(spool)) return applied;
  const batches: Batch[] = [];
  for (const line of readFileSync(spool, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const batch = JSON.parse(line) as Batch;
      if (batch.seq > applied) batches.push(batch);
    } catch {
      // A line cut short by a crash mid-write: that batch never committed locally either.
    }
  }
  if (batches.length) {
    await applyBatches(pool, batches);
    logger.info('postgres store: replayed queued writes', { 'landflow.db.batches': batches.length });
  }
  writeFileSync(spool, '');
  return Math.max(applied, batches.at(-1)?.seq ?? 0);
}

/** Copy every table from Postgres into the in-memory SQLite connection. */
async function loadMirror(pool: Pool, mirror: Database): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of Object.keys(TABLES) as TableName[]) {
    const { rows } = await pool.query(`SELECT * FROM ${table}`);
    counts[table] = rows.length;
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    const statement = mirror.sqlite.prepare(upsertSql(table, columns, 'upsert', () => '?'));
    mirror.sqlite.exec('BEGIN');
    try {
      for (const row of rows) statement.run(...columns.map((c) => (row[c] === undefined ? null : row[c])));
      mirror.sqlite.exec('COMMIT');
    } catch (error) {
      mirror.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  return counts;
}

/**
 * Connect, take the instance lock, migrate, replay the spool and load the in-memory copy. The returned Database
 * reads from the copy and replays its writes on Postgres.
 */
export async function openPostgres(url: string, dataDir: string): Promise<Database> {
  const { Pool } = (await import('pg')).default ?? (await import('pg'));
  const pool: Pool = new Pool({ connectionString: url, max: 4, application_name: 'landflow' });
  pool.on('error', (error) => logger.warn('postgres store: idle connection error', { error }));
  let lock: PoolClient | undefined;
  try {
    lock = await pool.connect();
    const { rows } = await lock.query('SELECT pg_try_advisory_lock($1) AS locked', [INSTANCE_LOCK]);
    if (!rows[0]?.locked) throw new Error('Another Landflow host is using this Postgres database (one host per database until queue mode)');
    await migratePostgres(pool);
    const spool = join(dataDir, 'postgres-queue.jsonl');
    const seq = await replaySpool(pool, spool);
    const sink = new PostgresSink(pool, lock, spool, seq);
    const db = new Database(openSqliteConnection(':memory:'), 'postgres', ':memory:', sink);
    const counts = await loadMirror(pool, db);
    logger.info('postgres store loaded', { 'landflow.db.workflows': counts.workflows ?? 0, 'landflow.db.executions': counts.executions ?? 0 });
    // Best effort; anything left is in the spool for the next boot.
    process.once('beforeExit', () => void sink.flush(5_000).catch(() => {}));
    return db;
  } catch (error) {
    lock?.release();
    await pool.end().catch(() => {});
    throw error;
  }
}
