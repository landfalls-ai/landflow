/**
 * Vector stores for the RAG nodes and agent knowledge bases. Each keeps
 * documents (text, metadata, embedding) in named collections and offers two
 * searches: by vector (cosine similarity) and by keywords. Hybrid search runs
 * both and merges them with reciprocal rank fusion.
 *
 * - memory: per server process, kept until it restarts (n8n's Simple Vector Store).
 * - sqlite: `vectors.sqlite` in the host's data directory; brute-force cosine and BM25.
 * - pgvector: a Postgres table with a `vector` column; `<=>` cosine distance and full-text search.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'pg';
import type { AiDocument } from '@landflow/engine';
import type { JsonObject, JsonValue } from '@landflow/sdk';
import { traceVectorStore } from '../telemetry';
import { bm25Scores, cosineSimilarity, reciprocalRankFusion, RRF_K, searchTerms, topK } from './search';

export type StoreKind = 'memory' | 'sqlite' | 'pgvector';

/** A document to store, with its embedding. Without an id, one is generated. */
export interface StoreInput {
  id?: string;
  pageContent: string;
  metadata: JsonObject;
  embedding: number[];
}

/** Exact-match conditions on metadata fields (all must hold). */
export type MetadataFilter = Record<string, JsonValue>;

export interface VectorStore {
  readonly kind: StoreKind;
  /** `db.system.name` of its spans. */
  readonly system: string;
  add(collection: string, documents: StoreInput[]): Promise<string[]>;
  /** Highest cosine similarity first; `score` is the similarity. */
  similaritySearch(collection: string, vector: number[], k: number, filter?: MetadataFilter): Promise<AiDocument[]>;
  /** Best keyword match first; documents without any query term are left out. */
  keywordSearch(collection: string, query: string, k: number, filter?: MetadataFilter): Promise<AiDocument[]>;
  clear(collection: string): Promise<void>;
  /** The id and metadata of every document of a collection (no text, no embeddings), oldest first. */
  metadataOf(collection: string): Promise<Array<{ id: string; metadata: JsonObject }>>;
  /** Delete the documents whose metadata matches `filter`; returns how many went. */
  deleteWhere(collection: string, filter: MetadataFilter): Promise<number>;
  count(collection: string): Promise<number>;
  collections(): Promise<Array<{ name: string; count: number }>>;
}

const dimensionError = (collection: string, stored: number, given: number) =>
  new Error(`Collection “${collection}” holds ${stored}-dimensional vectors, but these have ${given}. Use the same embeddings model, or clear the collection first.`);

function matches(metadata: JsonObject, filter?: MetadataFilter): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => JSON.stringify(metadata[key]) === JSON.stringify(value));
}

function checkDimensions(collection: string, documents: StoreInput[], stored?: number) {
  const first = stored ?? documents[0]?.embedding.length;
  for (const doc of documents) {
    if (!doc.embedding.length) throw new Error('A document has an empty embedding');
    if (first !== undefined && doc.embedding.length !== first) throw dimensionError(collection, first, doc.embedding.length);
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

interface MemoryRecord {
  id: string;
  pageContent: string;
  metadata: JsonObject;
  embedding: Float32Array;
}

const memoryCollections = ((globalThis as { __landflowVectors?: Map<string, Map<string, MemoryRecord>> }).__landflowVectors ??= new Map());

/** Rank records by keywords (BM25) and keep those that match at least one term. */
function keywordRank(records: Array<{ id: string; pageContent: string; metadata: JsonObject }>, query: string, k: number): AiDocument[] {
  const scores = bm25Scores(query, records.map((r) => r.pageContent));
  const scored = records.map((record, i) => ({ record, score: scores[i] })).filter((entry) => entry.score > 0);
  return topK(scored, k).map(({ record, score }) => ({ id: record.id, pageContent: record.pageContent, metadata: record.metadata, score }));
}

export class MemoryVectorStore implements VectorStore {
  readonly kind = 'memory' as const;
  readonly system = 'landflow.memory';

  private records(collection: string): MemoryRecord[] {
    return [...(memoryCollections.get(collection)?.values() ?? [])];
  }

  async add(collection: string, documents: StoreInput[]): Promise<string[]> {
    const existing = memoryCollections.get(collection) ?? new Map<string, MemoryRecord>();
    checkDimensions(collection, documents, existing.values().next().value?.embedding.length);
    const ids = documents.map((doc) => {
      const id = doc.id ?? randomUUID();
      existing.set(id, { id, pageContent: doc.pageContent, metadata: structuredClone(doc.metadata), embedding: Float32Array.from(doc.embedding) });
      return id;
    });
    memoryCollections.set(collection, existing);
    return ids;
  }

  async similaritySearch(collection: string, vector: number[], k: number, filter?: MetadataFilter): Promise<AiDocument[]> {
    const scored = this.records(collection)
      .filter((record) => matches(record.metadata, filter))
      .map((record) => ({ record, score: cosineSimilarity(vector, record.embedding) }));
    return topK(scored, k).map(({ record, score }) => ({ id: record.id, pageContent: record.pageContent, metadata: structuredClone(record.metadata), score }));
  }

  async keywordSearch(collection: string, query: string, k: number, filter?: MetadataFilter): Promise<AiDocument[]> {
    return keywordRank(
      this.records(collection).filter((record) => matches(record.metadata, filter)),
      query,
      k,
    ).map((doc) => ({ ...doc, metadata: structuredClone(doc.metadata) }));
  }

  async clear(collection: string) {
    memoryCollections.delete(collection);
  }

  async metadataOf(collection: string) {
    return this.records(collection).map((record) => ({ id: record.id, metadata: structuredClone(record.metadata) }));
  }

  async deleteWhere(collection: string, filter: MetadataFilter) {
    const records = memoryCollections.get(collection);
    let removed = 0;
    for (const record of this.records(collection)) {
      if (matches(record.metadata, filter) && records?.delete(record.id)) removed++;
    }
    return removed;
  }

  async count(collection: string) {
    return memoryCollections.get(collection)?.size ?? 0;
  }

  async collections() {
    return [...memoryCollections.entries()].map(([name, records]) => ({ name, count: records.size }));
  }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/** The host's data directory (LANDFLOW_DATA_DIR, default apps/web/.data). */
const dataDir = () => process.env.LANDFLOW_DATA_DIR ?? join(/*turbopackIgnore: true*/ process.cwd(), '.data');

export const defaultSqlitePath = () => join(dataDir(), 'vectors.sqlite');

const sqliteDatabases = ((globalThis as { __landflowVectorDbs?: Map<string, DatabaseSync> }).__landflowVectorDbs ??= new Map());

/** node:sqlite through process.getBuiltinModule (no bundler has to resolve it), without its one-time "experimental" warning. */
function loadSqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if ((typeof warning === 'string' ? warning : warning?.message)?.includes('SQLite is an experimental feature')) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

function openSqlite(file: string): DatabaseSync {
  const cached = sqliteDatabases.get(file);
  if (cached) return cached;
  const { DatabaseSync } = loadSqlite();
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS vectors (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
  `);
  sqliteDatabases.set(file, db);
  return db;
}

const toBlob = (vector: number[]) => new Uint8Array(Float32Array.from(vector).buffer);
/** Copy first: a row's bytes may sit at an offset Float32Array can't start from. */
const fromBlob = (blob: Uint8Array) => new Float32Array(blob.slice().buffer);

interface SqliteRow {
  id: string;
  content: string;
  metadata: string;
  embedding?: Uint8Array;
}

export class SqliteVectorStore implements VectorStore {
  readonly kind = 'sqlite' as const;
  readonly system = 'sqlite';

  constructor(readonly file = defaultSqlitePath()) {}

  private get db() {
    return openSqlite(this.file);
  }

  private rows(collection: string, withEmbedding: boolean): SqliteRow[] {
    const columns = withEmbedding ? 'id, content, metadata, embedding' : 'id, content, metadata';
    return this.db.prepare(`SELECT ${columns} FROM vectors WHERE collection = ? ORDER BY created_at, id`).all(collection) as unknown as SqliteRow[];
  }

  async add(collection: string, documents: StoreInput[]): Promise<string[]> {
    const { db } = this;
    const stored = db.prepare('SELECT dimensions FROM vectors WHERE collection = ? LIMIT 1').get(collection) as { dimensions: number } | undefined;
    checkDimensions(collection, documents, stored?.dimensions);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO vectors (collection, id, content, metadata, embedding, dimensions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const ids: string[] = [];
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const doc of documents) {
        const id = doc.id ?? randomUUID();
        insert.run(collection, id, doc.pageContent, JSON.stringify(doc.metadata), toBlob(doc.embedding), doc.embedding.length, now);
        ids.push(id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return ids;
  }

  async similaritySearch(collection: string, vector: number[], k: number, filter?: MetadataFilter): Promise<AiDocument[]> {
    const scored = this.rows(collection, true)
      .map((row) => ({ row, metadata: JSON.parse(row.metadata) as JsonObject }))
      .filter((entry) => matches(entry.metadata, filter))
      .map((entry) => ({ ...entry, score: cosineSimilarity(vector, fromBlob(entry.row.embedding!)) }));
    return topK(scored, k).map(({ row, metadata, score }) => ({ id: row.id, pageContent: row.content, metadata, score }));
  }

  async keywordSearch(collection: string, query: string, k: number, filter?: MetadataFilter): Promise<AiDocument[]> {
    const records = this.rows(collection, false)
      .map((row) => ({ id: row.id, pageContent: row.content, metadata: JSON.parse(row.metadata) as JsonObject }))
      .filter((record) => matches(record.metadata, filter));
    return keywordRank(records, query, k);
  }

  async clear(collection: string) {
    this.db.prepare('DELETE FROM vectors WHERE collection = ?').run(collection);
  }

  async metadataOf(collection: string) {
    const rows = this.db.prepare('SELECT id, metadata FROM vectors WHERE collection = ? ORDER BY created_at, id').all(collection) as unknown as Array<{ id: string; metadata: string }>;
    return rows.map((row) => ({ id: row.id, metadata: JSON.parse(row.metadata) as JsonObject }));
  }

  async deleteWhere(collection: string, filter: MetadataFilter) {
    const ids = (await this.metadataOf(collection)).filter((row) => matches(row.metadata, filter)).map((row) => row.id);
    const remove = this.db.prepare('DELETE FROM vectors WHERE collection = ? AND id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) remove.run(collection, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return ids.length;
  }

  async count(collection: string) {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE collection = ?').get(collection) as { n: number }).n);
  }

  async collections() {
    const rows = this.db.prepare('SELECT collection AS name, COUNT(*) AS count FROM vectors GROUP BY collection ORDER BY collection').all() as Array<{ name: string; count: number }>;
    return rows.map((row) => ({ name: row.name, count: Number(row.count) }));
  }
}

// ---------------------------------------------------------------------------
// Postgres + pgvector
// ---------------------------------------------------------------------------

export interface PgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  /** `disable`, `require` (encrypt, accept any certificate) or `verify` (encrypt and check the certificate). */
  ssl?: 'disable' | 'require' | 'verify';
}

const pgPools = ((globalThis as { __landflowPgPools?: Map<string, Pool> }).__landflowPgPools ??= new Map());
const ensuredTables = new Set<string>();

async function poolFor(config: PgConfig): Promise<Pool> {
  const key = JSON.stringify([config.host, config.port, config.database, config.user, config.password ?? '', config.ssl ?? 'disable']);
  const cached = pgPools.get(key);
  if (cached) return cached;
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ...(config.password && { password: config.password }),
    ...(config.ssl && config.ssl !== 'disable' && { ssl: { rejectUnauthorized: config.ssl === 'verify' } }),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  // An idle client that errors (server restart) must not crash the process.
  pool.on('error', () => undefined);
  pgPools.set(key, pool);
  return pool;
}

/** Close every Postgres pool (tests, shutdown). */
export async function closePgPools() {
  const pools = [...pgPools.values()];
  pgPools.clear();
  ensuredTables.clear();
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
}

/** `schema.table` or `table`, letters, digits and underscores only: it goes into SQL as an identifier. */
export function pgTableName(name: string): string {
  const trimmed = name.trim() || 'landflow_vectors';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(trimmed)) {
    throw new Error(`Invalid table name “${name}”: use letters, digits and underscores (optionally schema.table)`);
  }
  return trimmed.split('.').map((part) => `"${part}"`).join('.');
}

const vectorLiteral = (vector: number[]) => `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;

/** pgvector's "different vector dimensions 768 and 3" in our words. */
function pgError(error: unknown, collection: string): Error {
  const message = (error as Error).message ?? String(error);
  const dims = /different vector dimensions (\d+) and (\d+)/.exec(message);
  if (dims) return dimensionError(collection, Number(dims[1]), Number(dims[2]));
  if (/type "vector" does not exist|extension "vector"/.test(message)) return new Error(`The pgvector extension is not available in this database: ${message}`);
  return error instanceof Error ? error : new Error(message);
}

export class PgVectorStore implements VectorStore {
  readonly kind = 'pgvector' as const;
  readonly system = 'postgresql';
  private readonly table: string;
  private readonly indexName: string;

  constructor(
    private readonly config: PgConfig,
    tableName = 'landflow_vectors',
  ) {
    this.table = pgTableName(tableName);
    this.indexName = `"${(tableName.trim() || 'landflow_vectors').replace(/\./g, '_')}_collection_idx"`;
  }

  private async pool(): Promise<Pool> {
    const pool = await poolFor(this.config);
    const key = `${this.config.host}:${this.config.port}/${this.config.database}/${this.table}`;
    if (!ensuredTables.has(key)) {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          collection text NOT NULL,
          id text NOT NULL,
          content text NOT NULL,
          metadata jsonb NOT NULL DEFAULT '{}',
          embedding vector NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (collection, id)
        )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS ${this.indexName} ON ${this.table} (collection)`);
      ensuredTables.add(key);
    }
    return pool;
  }

  async add(collection: string, documents: StoreInput[]): Promise<string[]> {
    checkDimensions(collection, documents);
    if (!documents.length) return [];
    const pool = await this.pool();
    // The column takes any size; one collection must keep one.
    const stored = await pool.query<{ dims: number }>(`SELECT vector_dims(embedding) AS dims FROM ${this.table} WHERE collection = $1 LIMIT 1`, [collection]);
    if (stored.rows[0]) checkDimensions(collection, documents, Number(stored.rows[0].dims));
    const ids = documents.map((doc) => doc.id ?? randomUUID());
    try {
      for (let start = 0; start < documents.length; start += 200) {
        const batch = documents.slice(start, start + 200);
        const values: unknown[] = [];
        const rows = batch.map((doc, i) => {
          values.push(collection, ids[start + i], doc.pageContent, JSON.stringify(doc.metadata), vectorLiteral(doc.embedding));
          const p = i * 5;
          return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}::jsonb, $${p + 5}::vector)`;
        });
        await pool.query(
          `INSERT INTO ${this.table} (collection, id, content, metadata, embedding) VALUES ${rows.join(', ')}
           ON CONFLICT (collection, id) DO UPDATE SET content = EXCLUDED.content, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding`,
          values,
        );
      }
    } catch (error) {
      throw pgError(error, collection);
    }
    return ids;
  }

  async similaritySearch(collection: string, vector: number[], k: number, filter?: MetadataFilter): Promise<AiDocument[]> {
    const pool = await this.pool();
    const params: unknown[] = [collection, vectorLiteral(vector), Math.max(1, k)];
    const where = filter && Object.keys(filter).length ? ` AND metadata @> $${params.push(JSON.stringify(filter))}::jsonb` : '';
    try {
      const { rows } = await pool.query<{ id: string; content: string; metadata: JsonObject; distance: number }>(
        `SELECT id, content, metadata, embedding <=> $2::vector AS distance FROM ${this.table}
         WHERE collection = $1${where} ORDER BY embedding <=> $2::vector LIMIT $3`,
        params,
      );
      return rows.map((row) => ({ id: row.id, pageContent: row.content, metadata: row.metadata, score: 1 - Number(row.distance) }));
    } catch (error) {
      throw pgError(error, collection);
    }
  }

  async keywordSearch(collection: string, query: string, k: number, filter?: MetadataFilter): Promise<AiDocument[]> {
    // Terms are letters and digits only, so they are safe inside to_tsquery; any of them may match.
    const terms = [...new Set(searchTerms(query))];
    if (!terms.length) return [];
    const pool = await this.pool();
    const params: unknown[] = [collection, terms.join(' | '), Math.max(1, k)];
    const where = filter && Object.keys(filter).length ? ` AND metadata @> $${params.push(JSON.stringify(filter))}::jsonb` : '';
    const { rows } = await pool.query<{ id: string; content: string; metadata: JsonObject; rank: number }>(
      `SELECT id, content, metadata, ts_rank_cd(to_tsvector('simple', content), q) AS rank
       FROM ${this.table}, to_tsquery('simple', $2) q
       WHERE collection = $1 AND to_tsvector('simple', content) @@ q${where}
       ORDER BY rank DESC, id LIMIT $3`,
      params,
    );
    return rows.map((row) => ({ id: row.id, pageContent: row.content, metadata: row.metadata, score: Number(row.rank) }));
  }

  async clear(collection: string) {
    const pool = await this.pool();
    await pool.query(`DELETE FROM ${this.table} WHERE collection = $1`, [collection]);
  }

  async metadataOf(collection: string) {
    const pool = await this.pool();
    const { rows } = await pool.query<{ id: string; metadata: JsonObject }>(`SELECT id, metadata FROM ${this.table} WHERE collection = $1 ORDER BY created_at, id`, [collection]);
    return rows;
  }

  async deleteWhere(collection: string, filter: MetadataFilter) {
    if (!Object.keys(filter).length) return 0;
    const pool = await this.pool();
    const result = await pool.query(`DELETE FROM ${this.table} WHERE collection = $1 AND metadata @> $2::jsonb`, [collection, JSON.stringify(filter)]);
    return result.rowCount ?? 0;
  }

  async count(collection: string) {
    const pool = await this.pool();
    const { rows } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${this.table} WHERE collection = $1`, [collection]);
    return Number(rows[0]?.n ?? 0);
  }

  async collections() {
    const pool = await this.pool();
    const { rows } = await pool.query<{ name: string; count: string }>(`SELECT collection AS name, COUNT(*) AS count FROM ${this.table} GROUP BY collection ORDER BY collection`);
    return rows.map((row) => ({ name: row.name, count: Number(row.count) }));
  }
}

// ---------------------------------------------------------------------------
// Traced insert and search (vector or hybrid)
// ---------------------------------------------------------------------------

export type SearchMode = 'vector' | 'hybrid';

export interface SearchOptions {
  query: string;
  vector: number[];
  topK: number;
  mode: SearchMode;
  filter?: MetadataFilter;
  /** Hybrid: how many results each search contributes before fusion (default max(4 × topK, 20)). */
  candidates?: number;
  /** Hybrid: RRF damping constant (default 60). */
  rrfK?: number;
}

/** Store documents with their embeddings, in a `vector_store.insert` span. */
export function insertDocuments(store: VectorStore, collection: string, documents: StoreInput[]): Promise<string[]> {
  return traceVectorStore('insert', { store: store.kind, system: store.system, collection }, () => store.add(collection, documents), (ids) => ids.length);
}

/**
 * Search a collection, in a `vector_store.query` span. `vector` mode ranks by cosine similarity; `hybrid` also
 * ranks by keywords and fuses both lists with reciprocal rank fusion (`score` is then the RRF score).
 */
export function searchStore(store: VectorStore, collection: string, options: SearchOptions): Promise<AiDocument[]> {
  const k = Math.max(1, Math.floor(options.topK));
  return traceVectorStore(
    'query',
    {
      store: store.kind,
      system: store.system,
      collection,
      attributes: { 'landflow.retrieval.mode': options.mode, 'landflow.retrieval.top_k': k, ...(options.filter && { 'landflow.retrieval.filtered': true }) },
    },
    async () => {
      if (options.mode !== 'hybrid') return store.similaritySearch(collection, options.vector, k, options.filter);
      const pool = Math.max(k, options.candidates ?? Math.max(4 * k, 20));
      const [byVector, byKeyword] = await Promise.all([
        store.similaritySearch(collection, options.vector, pool, options.filter),
        store.keywordSearch(collection, options.query, pool, options.filter),
      ]);
      const documents = new Map<string, AiDocument>();
      for (const doc of [...byKeyword, ...byVector]) documents.set(doc.id!, doc);
      return reciprocalRankFusion([byVector.map((d) => d.id!), byKeyword.map((d) => d.id!)], options.rrfK ?? RRF_K)
        .slice(0, k)
        .map(({ id, score }) => ({ ...documents.get(id)!, score }));
    },
    (documents) => documents.length,
  );
}
