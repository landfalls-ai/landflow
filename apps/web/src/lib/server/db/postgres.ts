/**
 * Postgres mode (LANDFLOW_DB=postgres, DATABASE_URL). The store API is synchronous, so the host
 * keeps a full copy of the database in an in-memory SQLite connection, loaded at boot: every read
 * is served from it with the same SQL as SQLite mode, and every committed write is applied to it
 * at once and replayed on Postgres, in order, by a background queue.
 *
 * Durability: a batch is appended to `<data dir>/postgres-queue.jsonl` before it is queued, and
 * Postgres records the last batch it applied (`meta.postgres.replica_seq`, in the same transaction).
 * At boot the file is replayed from there, so writes not yet in Postgres when the host stopped or
 * crashed are not lost; the file is emptied whenever the queue drains. The file is fsynced by LANDFLOW_PG_SPOOL_FSYNC.
 *
 * A batch Postgres rejects (not a connection failure) five times is never dropped: the sink is `blocked`, the batch
 * stays at the head, nothing after it is applied, `Database.write` throws StoreUnavailableError (`handler()` answers 503)
 * so the in-memory copy can't run ahead, and the batch is retried every LANDFLOW_PG_BLOCKED_RETRY_SECONDS. LANDFLOW_PG_SKIP_BATCH=<seq> skips it at the
 * next boot, writing it to `postgres-rejected-<seq>.jsonl` (`-<instance>-<seq>` in queue mode).
 *
 * Memory: the copy holds every table except the data and journal of cold runs, which Postgres serves on demand
 * (./hot-mirror, ./reads); the audit log, the usage ledger, insights rows and AI usage still live in it whole.
 *
 * Limits: one host per database (an advisory lock refuses a second one) in regular mode.
 *
 * Queue mode (`openPostgres(…, { instanceId })`, lib/server/cluster): mains and workers share the database. Each holds
 * the instance lock in shared mode (so a regular-mode host can't join, nor start beside them), spools to
 * `postgres-queue-<instance>.jsonl` with its own replayed sequence number, and notifies the others of every batch it
 * applies; ./replication keeps its copy in step with theirs.
 */
import { closeSync, existsSync, fdatasyncSync, ftruncateSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { envNumber, envString } from '../config';
import { logger } from '../telemetry/logger';
import { Database, openSqliteConnection, upsertSql, type DirectClient, type SqlValue, type WriteHealth, type WriteOp, type WriteSink } from './database';
import { hotCutoff, mirrorSelect, startEviction } from './hot-mirror';
import { CHANGES_CHANNEL, noticesFor, Replica, rowIdOf } from './replication';
import { recordWriteRejection, recordWriteRetry, registerWriteMetrics } from './write-metrics';
import { addColumnSql, MIGRATIONS, pendingMigrations, SCHEMA_VERSION_TABLE, TABLES, type TableName } from './schema';

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

/** Queue mode: this instance's name (notices carry it) and the meta key of its sequence number. */
interface Shared {
  origin: string;
  seqKey: string;
}

async function setSeq(client: PoolClient | Pool, seq: number, key = SEQ_KEY) {
  await client.query(`INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, String(seq)]);
}

/** Apply the migrations Postgres lacks, in one transaction (an advisory lock keeps concurrent boots apart). */
export async function migratePostgres(pool: Pool): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await client.query(SCHEMA_VERSION_TABLE);
    const done = (await client.query('SELECT version FROM schema_version')).rows.map((row: { version: string | number }) => Number(row.version));
    const applied: number[] = [];
    for (const migration of pendingMigrations(MIGRATIONS, done)) {
      for (const column of migration.addColumns ?? []) await client.query(addColumnSql(column, true));
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

export type SpoolFsync = 'interval' | 'always' | 'off';
export interface SinkOptions {
  /** Seconds between retries of a blocked batch (LANDFLOW_PG_BLOCKED_RETRY_SECONDS, default 60). */
  blockedRetrySeconds?: number;
  spoolFsync?: SpoolFsync;
  /** Base of the exponential wait between retries (default 250 ms); tests shrink it. */
  backoffMs?: number;
  /** How long close() waits for the queue to drain (default 10 s); tests shrink it. */
  closeFlushMs?: number;
}

const FSYNC_INTERVAL_MS = 100;
/** Non-connection rejections of the same batch before the sink blocks. */
const REJECTIONS_TO_BLOCK = 5;

/** The ordered, spooled write queue to Postgres. */
export class PostgresSink implements WriteSink {
  private queue: Batch[] = [];
  private draining?: Promise<void>;
  private failures = 0;
  private rejections = 0;
  private closed = false;
  private blockedSeq?: number;
  private lastError?: string;
  /** After a rejection: one batch per transaction, so the one Postgres rejects is the one that blocks. */
  private isolate = false;
  private queuedOps = 0;
  private readonly enqueuedAt = new WeakMap<Batch, number>();
  private fd: number;
  private readonly closeFlushMs: number;
  private readonly fsync: SpoolFsync;
  private readonly blockedRetryMs: number;
  private readonly backoffMs: number;
  private fsyncTimer?: NodeJS.Timeout;
  private unregister?: () => void;
  /** Queue mode: rows with writes not yet in Postgres (the follower leaves them alone), and how many. */
  private readonly pending = new Map<string, number>();
  /** Queue mode: the follower (closed with the store). */
  replica?: Replica;
  /** The tables the copy holds in part (a delete on them is always replayed). */
  readonly partial: ReadonlySet<TableName> = new Set<TableName>(['executions', 'execution_events']);
  /** Executions with writes not yet in Postgres, with how many. */
  private readonly pendingExecs = new Map<string, number>();
  /** Sequence number of the last batch applied (or already there at boot), and who waits for a later one. */
  private applied: number;
  private waiters: Array<{ seq: number; resolve: (ok: boolean) => void }> = [];
  /** Stops the evictor of cold runs (./hot-mirror). */
  stopEviction?: () => void;

  constructor(
    private readonly pool: Pool,
    private readonly lock: PoolClient,
    private readonly spool: string,
    private seq: number,
    private readonly shared?: Shared,
    options: SinkOptions = {},
  ) {
    this.applied = seq;
    const mode = options.spoolFsync ?? envString('LANDFLOW_PG_SPOOL_FSYNC')?.toLowerCase();
    this.fsync = mode === 'always' || mode === 'off' ? mode : 'interval';
    // At least a second from the environment, so a blocked sink can't retry in a tight loop; tests pass 0 as an option.
    this.blockedRetryMs = (options.blockedRetrySeconds ?? envNumber('LANDFLOW_PG_BLOCKED_RETRY_SECONDS', { fallback: 60, min: 1 })) * 1000;
    this.backoffMs = options.backoffMs ?? 250;
    this.closeFlushMs = options.closeFlushMs ?? 10_000;
    this.fd = openSync(spool, 'a');
    this.unregister = registerWriteMetrics(() => this.health());
  }

  private track(batches: Batch[], delta: 1 | -1) {
    for (const batch of batches) {
      this.queuedOps += delta * batch.ops.length;
      for (const op of batch.ops) {
        const exec = executionOf(op);
        if (exec) bump(this.pendingExecs, exec, delta);
        if (!this.shared) continue;
        const id = rowIdOf(op);
        if (id) bump(this.pending, id, delta);
      }
    }
  }

  pendingExecutions(): { has(id: string): boolean } {
    return this.pendingExecs;
  }

  /** Resolve true once every batch queued by now is in Postgres, false after `timeoutMs` (a blocked or slow queue). */
  barrier(timeoutMs: number): Promise<boolean> {
    if (this.applied >= this.seq) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        seq: this.seq,
        resolve: (ok: boolean) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  private markApplied(seq: number) {
    this.applied = Math.max(this.applied, seq);
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.seq > this.applied) return true;
      waiter.resolve(true);
      return false;
    });
  }

  /** Rows with writes of this process not yet in Postgres. */
  pendingRows(): { has(id: string): boolean } {
    return this.pending;
  }

  /** Writes not yet in Postgres, in order. */
  pendingOps(): WriteOp[] {
    return this.queue.flatMap((batch) => batch.ops);
  }

  health(): WriteHealth {
    const oldest = this.queue[0];
    const at = oldest && this.enqueuedAt.get(oldest);
    return {
      state: this.blockedSeq !== undefined ? 'blocked' : this.failures > 0 ? 'retrying' : 'ok',
      queuedBatches: this.queue.length,
      queuedOps: this.queuedOps,
      oldestAgeMs: at ? Date.now() - at : 0,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.blockedSeq !== undefined ? { blockedSeq: this.blockedSeq } : {}),
    };
  }

  /** A pool connection for `fn` (Database.direct): straight to Postgres, released afterwards. */
  async direct<T>(fn: (client: DirectClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('The Postgres store is closed');
    const client = await this.pool.connect();
    try {
      return await fn(client as unknown as DirectClient);
    } finally {
      client.release();
    }
  }

  enqueue(ops: WriteOp[]) {
    if (this.closed) throw new Error('The Postgres store is closed');
    const batch = { seq: ++this.seq, ops };
    // On disk before anything else: a crash before Postgres has it replays it at the next boot.
    writeSync(this.fd, `${JSON.stringify(batch)}\n`);
    this.track([batch], 1);
    this.syncSpool();
    this.enqueuedAt.set(batch, Date.now());
    this.queue.push(batch);
    this.drain();
  }

  /** fdatasync per LANDFLOW_PG_SPOOL_FSYNC: after each append, at most every 100 ms, or never. */
  private syncSpool() {
    if (this.fsync === 'off') return;
    if (this.fsync === 'always') return void fdatasyncSync(this.fd);
    if (this.fsyncTimer) return;
    this.fsyncTimer = setTimeout(() => {
      this.fsyncTimer = undefined;
      if (this.closed) return;
      try {
        fdatasyncSync(this.fd);
      } catch (error) {
        this.lastError = `spool fsync: ${errorText(error)}`;
        logger.error('postgres store: syncing the spool failed', { error });
      }
    }, FSYNC_INTERVAL_MS);
    this.fsyncTimer.unref?.();
  }

  private drain() {
    this.draining ??= this.run().finally(() => {
      this.draining = undefined;
      if (this.queue.length && !this.closed) this.drain();
    });
  }

  private async run() {
    while (this.queue.length) {
      // close() may have run while this loop slept (a blocked sink waits up to a minute): the pool is gone.
      if (this.closed) return;
      // Several small batches go in one transaction; a big one goes alone (and so does each, after a rejection).
      const take: Batch[] = [];
      let ops = 0;
      for (const batch of this.queue) {
        if (take.length && (this.isolate || ops + batch.ops.length > MAX_OPS_PER_FLUSH)) break;
        take.push(batch);
        ops += batch.ops.length;
      }
      const wasBlocked = this.blockedSeq !== undefined;
      const afterRejection = this.isolate;
      try {
        await applyBatches(this.pool, take, this.shared);
        this.queue.splice(0, take.length);
        this.track(take, -1);
        this.markApplied(take.at(-1)!.seq);
        this.failures = 0;
        this.rejections = 0;
        this.lastError = undefined;
        if (wasBlocked) {
          this.blockedSeq = undefined;
          logger.info('postgres store: the blocked write batch was applied; writes are accepted again', { 'landflow.db.seq': take[0].seq });
        }
        // The batch Postgres rejected earlier (the head one, taken alone) applied: back to grouping batches.
        if (afterRejection) this.isolate = false;
        // close() may have closed the spool while this transaction was in flight: its descriptor is no longer ours.
        if (this.closed) return;
        if (!this.queue.length) ftruncateSync(this.fd, 0);
      } catch (error) {
        this.failures++;
        const rejected = !isConnectionError(error);
        this.lastError = errorText(error);
        if (rejected) {
          this.rejections++;
          this.isolate = true;
          recordWriteRejection();
        }
        if (wasBlocked) {
          recordWriteRetry();
          logger.warn(rejected ? 'postgres store: the blocked write batch is still rejected' : 'postgres store: retrying the blocked write batch failed (connection)', { error, 'landflow.db.seq': take[0].seq });
        } else if (rejected && this.rejections >= REJECTIONS_TO_BLOCK) {
          // Never dropped: the batch stays at the head, later writes are refused (Database.write) and it is retried.
          this.blockedSeq = take[0].seq;
          logger.error('postgres store: blocked on a write batch Postgres rejects; writes are refused until it applies (retrying, or restart with LANDFLOW_PG_SKIP_BATCH)', {
            error,
            'landflow.db.seq': take[0].seq,
            'landflow.db.ops.count': take[0].ops.length,
            'landflow.db.ops': JSON.stringify(take[0].ops).slice(0, 2000),
            'db.response.status_code': (error as { code?: string }).code,
          });
        } else if (this.failures === 1 || this.failures % 20 === 0) {
          logger.warn('postgres store: write failed, retrying', { error, 'landflow.db.queued': this.queue.length });
        }
        if (this.closed) return;
        const wait = this.blockedSeq !== undefined ? this.blockedRetryMs : Math.min(30_000, this.backoffMs * 2 ** Math.min(this.failures, 7));
        await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
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

  /** Boot failed after the sink was made: release the spool and the metrics source without flushing (the caller ends the pool). */
  discard() {
    this.closed = true;
    this.stopEviction?.();
    this.unregister?.();
    clearTimeout(this.fsyncTimer);
    const fd = this.fd;
    this.fd = -1;
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }

  async close() {
    try {
      await this.flush(this.closeFlushMs);
    } finally {
      this.closed = true;
      this.stopEviction?.();
      for (const waiter of this.waiters) waiter.resolve(false);
      this.waiters = [];
      this.unregister?.();
      clearTimeout(this.fsyncTimer);
      try {
        if (this.fsync !== 'off') fdatasyncSync(this.fd);
      } catch {
        // Already closed, or the disk is gone: nothing more to do for the spool.
      }
      const fd = this.fd;
      this.fd = -1;
      closeSync(fd);
      await this.replica?.close();
      this.lock.release();
      await this.pool.end();
    }
  }
}

/** The execution a write belongs to (its row, or one of its journal events), for the evictor's list of rows in flight to Postgres. */
function executionOf(op: WriteOp): string | undefined {
  if (op.table !== 'executions' && op.table !== 'execution_events') return undefined;
  if (op.op === 'deleteBefore') return undefined;
  const values = op.op === 'delete' ? op.where : op.row;
  const id = op.table === 'executions' ? values.id : values.execution_id;
  return typeof id === 'string' ? id : undefined;
}

function bump(map: Map<string, number>, key: string, delta: 1 | -1) {
  const count = (map.get(key) ?? 0) + delta;
  if (count > 0) map.set(key, count);
  else map.delete(key);
}

/** Queue mode: each process has its own sequence space, so the file name carries the instance. */
const rejectedName = (seq: number, shared?: Shared) => (shared ? `${shared.origin}-${seq}` : String(seq));

const errorText = (error: unknown) => {
  const code = (error as { code?: string })?.code;
  return `${code ? `${code}: ` : ''}${error instanceof Error ? error.message : String(error)}`;
};

/** Apply batches in one Postgres transaction and record the last one's sequence number (queue mode: and notify the others). */
async function applyBatches(pool: Pool, batches: Batch[], shared?: Shared) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const batch of batches) {
      for (const op of batch.ops) {
        const { text, values } = postgresStatement(op);
        await client.query(text, values);
      }
    }
    if (shared) {
      // Delivered at COMMIT, in commit order, to every other process's LISTEN connection (./replication).
      for (const payload of noticesFor(shared.origin, batches.flatMap((batch) => batch.ops), Date.now())) await client.query('SELECT pg_notify($1, $2)', [CHANGES_CHANNEL, payload]);
    }
    await setSeq(client, batches.at(-1)!.seq, shared?.seqKey);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Replay what the spool holds past Postgres' last applied batch. Returns the sequence number to continue from. */
export async function replaySpool(pool: Pool, spool: string, shared?: Shared): Promise<number> {
  const applied = Number((await pool.query('SELECT value FROM meta WHERE key = $1', [shared?.seqKey ?? SEQ_KEY])).rows[0]?.value ?? 0);
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
  const skip = Number(envString('LANDFLOW_PG_SKIP_BATCH') ?? NaN);
  const skipped = Number.isFinite(skip) ? batches.filter((batch) => batch.seq === skip) : [];
  const todo = batches.filter((batch) => !skipped.includes(batch));
  for (const batch of skipped) {
    // Kept, never discarded: the operator can read it and replay it by hand.
    const file = join(dirname(spool), `postgres-rejected-${rejectedName(batch.seq, shared)}.jsonl`);
    writeFileSync(file, `${JSON.stringify(batch)}\n`);
    logger.error('postgres store: skipped a write batch (LANDFLOW_PG_SKIP_BATCH); it is in the rejected file', { 'landflow.db.seq': batch.seq, file });
  }
  if (todo.length) {
    try {
      await applyBatches(pool, todo, shared);
    } catch (error) {
      if (isConnectionError(error)) throw error;
      // Find the batch Postgres rejects: one by one (the failed transaction rolled back whole).
      for (const batch of todo) {
        try {
          await applyBatches(pool, [batch], shared);
        } catch (single) {
          if (isConnectionError(single)) throw single;
          throw new Error(`Postgres rejected write batch ${batch.seq} while replaying ${spool} (${errorText(single)}); fix the cause, or restart with LANDFLOW_PG_SKIP_BATCH=${batch.seq} to set it aside in postgres-rejected-${rejectedName(batch.seq, shared)}.jsonl`);
        }
      }
    }
    logger.info('postgres store: replayed queued writes', { 'landflow.db.batches': todo.length });
  }
  const last = Math.max(applied, batches.at(-1)?.seq ?? 0);
  // A skipped batch at the end is not in what was applied: record the sequence so it is not replayed again.
  if (skipped.length && last > applied && (todo.at(-1)?.seq ?? 0) < last) await setSeq(pool, last, shared?.seqKey);
  writeFileSync(spool, '');
  return last;
}

/** Copy every table from Postgres into the in-memory SQLite connection (run data and journal: only the hot runs'). */
async function loadMirror(pool: Pool, mirror: Database): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const cutoff = hotCutoff();
  for (const table of Object.keys(TABLES) as TableName[]) {
    const query = mirrorSelect(table, cutoff);
    const { rows } = await pool.query(query.text, query.values);
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
 * reads from the copy and replays its writes on Postgres. `instanceId` (queue mode): share the database with the
 * cluster's other processes and follow their writes (./replication).
 */
export async function openPostgres(url: string, dataDir: string, options: { instanceId?: string } = {}): Promise<Database> {
  const { Pool } = (await import('pg')).default ?? (await import('pg'));
  const shared: Shared | undefined = options.instanceId ? { origin: options.instanceId, seqKey: `${SEQ_KEY}:${options.instanceId}` } : undefined;
  const pool: Pool = new Pool({ connectionString: url, max: shared ? 8 : 4, application_name: shared ? `landflow:${shared.origin}` : 'landflow' });
  pool.on('error', (error) => logger.warn('postgres store: idle connection error', { error }));
  let lock: PoolClient | undefined;
  let replica: Replica | undefined;
  let sink: PostgresSink | undefined;
  try {
    lock = await pool.connect();
    const { rows } = await lock.query(`SELECT ${shared ? 'pg_try_advisory_lock_shared' : 'pg_try_advisory_lock'}($1) AS locked`, [INSTANCE_LOCK]);
    if (!rows[0]?.locked) {
      throw new Error(
        shared
          ? 'A Landflow host in regular mode is using this Postgres database: stop it, or start every process with LANDFLOW_EXECUTIONS_MODE=queue'
          : 'Another Landflow host is using this Postgres database (one host per database until queue mode: LANDFLOW_EXECUTIONS_MODE=queue)',
      );
    }
    await migratePostgres(pool);
    const spool = join(dataDir, shared ? `postgres-queue-${shared.origin}.jsonl` : 'postgres-queue.jsonl');
    const seq = await replaySpool(pool, spool, shared);
    const opened = new PostgresSink(pool, lock, spool, seq, shared);
    sink = opened;
    const db = new Database(openSqliteConnection(':memory:'), 'postgres', ':memory:', opened);
    if (shared) {
      // LISTEN before loading: what commits while the copy loads is applied after it, in order.
      replica = new Replica(db, pool, url, shared.origin, () => opened.pendingRows(), () => opened.pendingOps());
      await replica.listen();
      opened.replica = replica;
    }
    const counts = await loadMirror(pool, db);
    replica?.ready();
    logger.info('postgres store loaded', { 'landflow.db.workflows': counts.workflows ?? 0, 'landflow.db.executions': counts.executions ?? 0 });
    // Runs that cool down leave the copy (nothing is sent to Postgres); the lifecycle shutdown registry flushes the queue.
    opened.stopEviction = startEviction(db);
    return db;
  } catch (error) {
    // A test (or a retried boot) that opens again must not inherit this attempt's spool descriptor or metrics source.
    sink?.discard();
    await replica?.close();
    lock?.release();
    await pool.end().catch(() => {});
    throw error;
  }
}
