/**
 * C31: the data key of each project (DEK), the layer between the key ring and a project's credentials. A DEK is 256
 * random bits, kept in `project_keys` wrapped by the ring's primary key (a v2 sealed string whose AAD binds the project
 * and the version, so a wrapped key copied to another row or project no longer opens). A project has at most one
 * `active` version; older versions stay `retired` while a credential may still name them and are deleted only by a later
 * sweep (./project-keys), after a grace period and once nothing names them.
 *
 * Several processes (queue mode, Postgres): a key exists only once Postgres has it. Creating one and adding a version
 * run in Postgres itself, in a transaction under an advisory lock per project, so two processes never end up with
 * different keys for the same version; the synchronous seal path never creates a key in that mode (it reads the one
 * this process's copy has, else the caller seals on the ring and an `ensure` runs in the background). Every change
 * to a row is a conditional UPDATE in Postgres that names only the columns it changes, so a row another process retired
 * or destroyed is never brought back, and tells the other processes (a key notice), which then drop what they cached.
 * SQLite (one process, or processes sharing the file): the same steps as synchronous local writes in a transaction.
 *
 * Unwrapped keys live only in this process's memory for ten minutes (and are zeroed when dropped), never written,
 * logged, audited, serialized or put in an error. This file holds the key level only; what to re-seal and when lives in
 * ./project-keys, which sits above the vault, so the vault can import this without a cycle.
 */
import { randomBytes } from 'node:crypto';
import { database } from '../db';
import type { Database, DirectClient } from '../db/database';
import { onTablesChanged } from '../db/replication';
import { recordAudit } from '../audit';
import { logger } from '../telemetry/logger';
import { openWith, sealWith, type KeyRing, type SealedValue } from './key-ring';

/** How long an unwrapped key is kept in memory (FR-9). */
export const KEY_CACHE_MS = 10 * 60_000;
/** How long a retired key stays before a sweep may destroy it: longer than the cache plus any replication delay, so no process is still sealing with it. */
export const KEY_DESTROY_GRACE_MS = 15 * 60_000;
const CACHE_SWEEP_MS = 60_000;

export type ProjectKeyState = 'active' | 'retired';

export type ProjectKeyRow = {
  project_id: string;
  version: number;
  wrapped: string;
  state: ProjectKeyState;
  created_at: string;
  retired_at: string | null;
};

/** A project's key is missing or can't be opened. `gone`: no such row (destroyed, or not yet here); `unwrap`: the ring lacks the key that wrapped it. */
export class ProjectKeyError extends Error {
  constructor(
    message: string,
    readonly reason: 'gone' | 'unwrap',
  ) {
    super(message);
  }
}

/** AAD of a wrapped key: the project and the version. Its prefix is not `landflow:`, which every `sealSecret` purpose starts with, so no purpose can collide with it. */
export const wrapAad = (projectId: string, version: number) => `landflow-key-wrap:project:${projectId}:${version}`;

/** `v2.<kid>.<iv>.<tag>.<ciphertext>`, the form `sealSecret` uses. */
const toString = (sealed: SealedValue) => `v2.${sealed.kid}.${sealed.iv}.${sealed.tag}.${sealed.value}`;

function parseWrapped(text: string): SealedValue | undefined {
  const parts = text.split('.');
  if (parts[0] !== 'v2' || parts.length !== 5 || !parts[1] || !parts[2] || !parts[3]) return undefined;
  return { v: 2, kid: parts[1], iv: parts[2], tag: parts[3], value: parts[4]! };
}

/** The kid that wrapped a key (undefined when the text is not a wrapped key). */
export const wrappedKid = (text: string): string | undefined => parseWrapped(text)?.kid;

export type RewrapResult = { rewrapped: number; current: number; failed: string[] };

const normalize = (row: ProjectKeyRow): ProjectKeyRow => ({ ...row, version: Number(row.version) });

export interface ProjectKeyStoreOptions {
  ring: KeyRing;
  /** The database holding `project_keys` (default: the host's). */
  db?: () => Database;
  /** The clock the cache uses (tests). */
  now?: () => number;
}

/** Stands for "Postgres's now" in `change`. */
const NOW = '\u0000now';

export class ProjectKeyStore {
  private readonly cache = new Map<string, { key: Buffer; at: number }>();
  private readonly ensuring = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  /** How many keys this process unwrapped (tests count them; never reports a key). */
  unwraps = 0;

  constructor(private readonly options: ProjectKeyStoreOptions) {}

  private get db(): Database {
    return (this.options.db ?? database)();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get ring(): KeyRing {
    return this.options.ring;
  }

  /** In Postgres mode keys are decided in Postgres (`direct`); undefined on SQLite, where the local copy is the database. */
  private direct<T>(fn: (client: DirectClient) => Promise<T>): Promise<T> | undefined {
    return this.db.kind === 'postgres' ? this.db.direct(fn) : undefined;
  }

  /** Whether this process shares its keys through Postgres (the synchronous seal path then never creates one). */
  get remote(): boolean {
    return this.db.kind === 'postgres';
  }

  // ---- reading ------------------------------------------------------------------------------------------------

  /** Every key row, or one project's, oldest version first (this process's copy). */
  rows(projectId?: string): ProjectKeyRow[] {
    const rows = projectId
      ? this.db.all<ProjectKeyRow>('SELECT * FROM project_keys WHERE project_id = ? ORDER BY version', projectId)
      : this.db.all<ProjectKeyRow>('SELECT * FROM project_keys ORDER BY project_id, version');
    return rows.map(normalize);
  }

  /** Every key row as Postgres has it (after this process's own writes reached it); this process's copy on SQLite. */
  async allRows(): Promise<ProjectKeyRow[] | undefined> {
    if (!this.remote) return this.rows();
    if (!(await this.db.barrier(5_000))) return undefined;
    const result = await this.direct((client) => client.query<ProjectKeyRow>('SELECT * FROM project_keys ORDER BY project_id, version'));
    return result ? result.rows.map(normalize) : this.rows();
  }

  /** The project key versions Postgres says some stored credential names (`<projectId>:<version>`); undefined on SQLite (the vault's own map is the whole truth then). */
  async namedInDatabase(): Promise<Set<string> | undefined> {
    if (!this.remote) return undefined;
    if (!(await this.db.barrier(5_000))) throw new Error('This process’s writes have not reached Postgres yet');
    const result = await this.direct((client) => client.query<{ data: string }>('SELECT data FROM credentials'));
    if (!result) return undefined;
    const named = new Set<string>();
    for (const { data } of result.rows) {
      try {
        const sealed = JSON.parse(data) as SealedValue;
        if (sealed.v === 3 && sealed.dek) named.add(sealed.dek.replace(/\.(\d+)$/, ':$1'));
      } catch {
        // Not a sealed value: names no key.
      }
    }
    return named;
  }

  /** The active version of a project's key in this process's copy, if it has one. */
  activeVersion(projectId: string): number | undefined {
    return this.rows(projectId).find((row) => row.state === 'active')?.version;
  }

  private wrap(projectId: string, version: number, key: Buffer): string {
    return toString(sealWith(this.ring, key.toString('hex'), wrapAad(projectId, version)));
  }

  private remember(projectId: string, version: number, key: Buffer) {
    this.subscribe();
    this.cache.set(`${projectId}:${version}`, { key, at: this.now() });
    this.timer ??= setInterval(() => this.expire(), CACHE_SWEEP_MS).unref();
  }

  /** Drop unwrapped keys whose ten minutes are over, zeroing them. */
  private expire() {
    const now = this.now();
    for (const [id, entry] of this.cache) {
      if (now - entry.at < KEY_CACHE_MS) continue;
      entry.key.fill(0);
      this.cache.delete(id);
    }
  }

  /** Hear of another process's changes to a project's keys and drop what this one cached for it. */
  private subscribe() {
    this.unsubscribe ??= onTablesChanged((change) => {
      if (!change.tables.has('project_keys')) return;
      const keys = change.keys.get('project_keys');
      if (!keys?.length) return this.forget();
      for (const key of keys) this.forget(String(key[0]));
    });
  }

  /** A version's unwrapped key: from memory for ten minutes, else unwrapped with the ring. Throws ProjectKeyError. */
  keyFor(projectId: string, version: number): Buffer {
    const id = `${projectId}:${version}`;
    const cached = this.cache.get(id);
    if (cached && this.now() - cached.at < KEY_CACHE_MS) return cached.key;
    if (cached) {
      cached.key.fill(0);
      this.cache.delete(id);
    }
    const row = this.rows(projectId).find((r) => r.version === version);
    if (!row) throw new ProjectKeyError(`Key ${version} of project ${projectId} is gone, or has not reached this process yet`, 'gone');
    const key = this.unwrap(row);
    this.remember(projectId, version, key);
    return key;
  }

  /** Whether a row's key opens with this ring, without keeping it in memory (status). */
  canUnwrap(row: ProjectKeyRow): boolean {
    try {
      this.unwrap(row).fill(0);
      return true;
    } catch {
      return false;
    }
  }

  private unwrap(row: ProjectKeyRow): Buffer {
    const sealed = parseWrapped(row.wrapped);
    if (!sealed) throw new ProjectKeyError(`Key ${row.version} of project ${row.project_id} is not a wrapped key`, 'unwrap');
    try {
      this.unwraps += 1;
      return Buffer.from(openWith(this.ring, sealed, wrapAad(row.project_id, Number(row.version))), 'hex');
    } catch {
      throw new ProjectKeyError(`Key ${row.version} of project ${row.project_id} can't be unwrapped: is the key that wrapped it in LANDFLOW_ENCRYPTION_KEYS?`, 'unwrap');
    }
  }

  // ---- creating -----------------------------------------------------------------------------------------------

  /**
   * The project's active key for sealing, from this process's copy. On SQLite the first call creates version 1; in Postgres
   * mode it never creates one and answers undefined when this copy has no active key: the caller seals on the ring
   * and calls `ensure` (the credential is moved onto the key by the next save or `migrate`).
   */
  activeFor(projectId: string): { version: number; key: Buffer } | undefined {
    const active = this.rows(projectId).find((row) => row.state === 'active');
    if (active) return { version: active.version, key: this.keyFor(projectId, active.version) };
    if (this.remote) return undefined;
    const key = randomBytes(32);
    const row: ProjectKeyRow = { project_id: projectId, version: 1, wrapped: this.wrap(projectId, 1, key), state: 'active', created_at: new Date().toISOString(), retired_at: null };
    // Another process on the same file may have been first: the row that landed is the key.
    if (!this.db.insertNew('project_keys', row)) return this.activeFor(projectId);
    this.remember(projectId, 1, key);
    this.auditCreated(projectId, 1);
    return { version: 1, key };
  }

  private auditCreated(projectId: string, version: number) {
    // Fail-open on purpose (as root rotation is): a credential save never waits on this event.
    recordAudit({ action: 'encryption.project_key.created', target: { type: 'project', id: projectId }, project: projectId, summary: `Created version ${version} of the encryption key of project ${projectId}`, details: { projectId, version } });
  }

  /** Make sure the project has an active key this process can use: created in Postgres if no process has made one. */
  ensure(projectId: string): Promise<void> {
    if (this.rows(projectId).some((row) => row.state === 'active')) return Promise.resolve();
    if (!this.remote) {
      this.activeFor(projectId);
      return Promise.resolve();
    }
    const running = this.ensuring.get(projectId);
    if (running) return running;
    const work = this.ensureRemote(projectId).finally(() => this.ensuring.delete(projectId));
    this.ensuring.set(projectId, work);
    return work;
  }

  /** `ensure` for the synchronous seal path: it runs on its own and a failure is only logged (the credential is on the ring, readable). */
  ensureInBackground(projectId: string) {
    this.ensure(projectId).catch((error) => logger.warn('a project key could not be created', { 'landflow.project_key.project': projectId, error: error instanceof Error ? error.name : 'error' }));
  }

  /** In one Postgres transaction under a lock per project: the active row if there is one, else a new version (the next number, counted there). */
  private async ensureRemote(projectId: string): Promise<void> {
    const call = this.direct(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`landflow:project-key:${projectId}`]);
        const active = (await client.query<ProjectKeyRow>("SELECT * FROM project_keys WHERE project_id = $1 AND state = 'active' ORDER BY version DESC LIMIT 1", [projectId])).rows[0];
        if (active) {
          await client.query('COMMIT');
          return { row: normalize(active), key: undefined };
        }
        const version = Number((await client.query<{ v: string }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM project_keys WHERE project_id = $1', [projectId])).rows[0]!.v);
        const key = randomBytes(32);
        const row: ProjectKeyRow = { project_id: projectId, version, wrapped: this.wrap(projectId, version, key), state: 'active', created_at: new Date().toISOString(), retired_at: null };
        await client.query('INSERT INTO project_keys (project_id, version, wrapped, state, created_at, retired_at) VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (project_id, version) DO NOTHING', [row.project_id, row.version, row.wrapped, row.state, row.created_at]);
        await this.notify(client, projectId, version);
        await client.query('COMMIT');
        return { row, key };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    const result = await call;
    if (!result) return void this.activeFor(projectId);
    this.db.upsertLocal('project_keys', result.row);
    if (result.key) {
      this.remember(projectId, result.row.version, result.key);
      this.auditCreated(projectId, result.row.version);
    }
  }

  /** Postgres's clock as the ISO text `retired_at` holds, so a skewed process clock cannot shorten the grace period. */
  private static readonly PG_NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

  /** Tell the other processes a row changed (they read it back from Postgres and drop what they cached). */
  private async notify(client: { query(text: string, values?: unknown[]): Promise<unknown> }, projectId: string, version: number) {
    const payload = this.db.keyNotice('project_keys', [projectId, version]);
    if (payload) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', payload]);
  }

  /** A new active version, the previous active one retired, in one step. Returns the new version. */
  async addVersion(projectId: string): Promise<{ version: number; previous?: number }> {
    const now = new Date().toISOString();
    const call = this.direct(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`landflow:project-key:${projectId}`]);
        const previous = (await client.query<{ version: string }>(`UPDATE project_keys SET state = 'retired', retired_at = ${ProjectKeyStore.PG_NOW} WHERE project_id = $1 AND state = 'active' RETURNING version`, [projectId])).rows[0];
        const version = Number((await client.query<{ v: string }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM project_keys WHERE project_id = $1', [projectId])).rows[0]!.v);
        const key = randomBytes(32);
        const row: ProjectKeyRow = { project_id: projectId, version, wrapped: this.wrap(projectId, version, key), state: 'active', created_at: now, retired_at: null };
        await client.query('INSERT INTO project_keys (project_id, version, wrapped, state, created_at, retired_at) VALUES ($1, $2, $3, $4, $5, NULL)', [row.project_id, row.version, row.wrapped, row.state, row.created_at]);
        await this.notify(client, projectId, version);
        if (previous) await this.notify(client, projectId, Number(previous.version));
        const stamp = previous ? (await client.query<{ retired_at: string }>('SELECT retired_at FROM project_keys WHERE project_id = $1 AND version = $2', [projectId, Number(previous.version)])).rows[0]?.retired_at : undefined;
        await client.query('COMMIT');
        return { row, key, previous: previous ? Number(previous.version) : undefined, stamp };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    if (call) {
      const done = await call;
      // Into this copy only: Postgres has them already.
      const old = done.previous === undefined ? undefined : this.rows(projectId).find((row) => row.version === done.previous);
      if (old) this.db.upsertLocal('project_keys', { ...old, state: 'retired', retired_at: done.stamp ?? now });
      this.db.upsertLocal('project_keys', done.row);
      this.remember(projectId, done.row.version, done.key);
      return { version: done.row.version, ...(done.previous !== undefined && { previous: done.previous }) };
    }
    return this.db.transaction(() => {
      const rows = this.rows(projectId);
      const previous = rows.find((row) => row.state === 'active');
      const version = Math.max(0, ...rows.map((row) => row.version)) + 1;
      const key = randomBytes(32);
      if (previous) this.db.upsert('project_keys', { ...previous, state: 'retired', retired_at: now });
      this.db.insertNew('project_keys', { project_id: projectId, version, wrapped: this.wrap(projectId, version, key), state: 'active', created_at: now, retired_at: null });
      this.remember(projectId, version, key);
      return { version, ...(previous && { previous: previous.version }) };
    });
  }

  // ---- changing rows ------------------------------------------------------------------------------------------

  /**
   * One conditional change to one row: Postgres runs the UPDATE (only the named columns, `where` decides) and the winner's row
   * comes back into this copy; SQLite does it in a transaction that first looks for the row. Never inserts, so a row that is
   * gone stays gone. Returns the row after the change, or undefined when none matched.
   */
  private async change(projectId: string, version: number, set: Partial<Pick<ProjectKeyRow, 'state' | 'retired_at' | 'wrapped'>>, where: { state?: ProjectKeyState; wrapped?: string } = {}): Promise<ProjectKeyRow | undefined> {
    const call = this.direct(async (client) => {
      const values: unknown[] = [projectId, version];
      const assign = Object.entries(set).map(([column, value]) => (column === 'retired_at' && value === NOW ? `retired_at = ${ProjectKeyStore.PG_NOW}` : (values.push(value), `${column} = $${values.length}`)));
      const guard = Object.entries(where).map(([column, value]) => (values.push(value), `${column} = $${values.length}`));
      const updated = await client.query<ProjectKeyRow>(`UPDATE project_keys SET ${assign.join(', ')} WHERE project_id = $1 AND version = $2${guard.map((g) => ` AND ${g}`).join('')} RETURNING *`, values);
      if (updated.rows[0]) await this.notify(client, projectId, version);
      return updated.rows[0];
    });
    if (call) {
      const row = await call;
      if (row) this.db.upsertLocal('project_keys', normalize(row));
      return row && normalize(row);
    }
    return this.changeLocal(projectId, version, set.retired_at === NOW ? { ...set, retired_at: new Date().toISOString() } : set, where);
  }

  /** The SQLite form of `change`: look for the row and change only the named columns, in one transaction. */
  private changeLocal(projectId: string, version: number, set: Partial<Pick<ProjectKeyRow, 'state' | 'retired_at' | 'wrapped'>>, where: { state?: ProjectKeyState; wrapped?: string }): ProjectKeyRow | undefined {
    return this.db.transaction(() => {
      const row = this.rows(projectId).find((r) => r.version === version);
      if (!row || (where.state && row.state !== where.state) || (where.wrapped && row.wrapped !== where.wrapped)) return undefined;
      // The whole row, which this transaction has just read: SQLite checks NOT NULL before it resolves a conflict, so a partial row would not do.
      this.db.upsert('project_keys', { ...row, ...set });
      return { ...row, ...set };
    });
  }

  /** Retire one version (nothing new is sealed with it; what names it still opens). A retired or missing row is left alone. */
  retire(projectId: string, version: number): Promise<unknown> {
    return this.change(projectId, version, { state: 'retired', retired_at: NOW }, { state: 'active' });
  }

  /** Retire every active version of a project. */
  async retireAll(projectId: string): Promise<void> {
    const rows = (this.remote ? ((await this.allRows()) ?? this.rows()).filter((r) => r.project_id === projectId) : this.rows(projectId)).filter((row) => row.state === 'active');
    for (const row of rows) await this.retire(projectId, row.version);
  }

  /**
   * Delete versions of a project's key and forget their unwrapped copies. Only a retired version is deleted (`force`: any, for
   * tests and a deliberate shred); an active one is left. Returns how many went.
   */
  async destroy(projectId: string, versions: number[], force = false): Promise<number> {
    let gone = 0;
    for (const version of versions) {
      const call = this.direct(async (client) => {
        const deleted = await client.query<{ version: string }>(`DELETE FROM project_keys WHERE project_id = $1 AND version = $2${force ? '' : " AND state = 'retired'"} RETURNING version`, [projectId, version]);
        if (deleted.rows[0]) await this.notify(client, projectId, version);
        return deleted.rows.length;
      });
      const n = call ? await call : this.db.transaction(() => (this.rows(projectId).some((r) => r.version === version && (force || r.state === 'retired')) ? this.db.delete('project_keys', { project_id: projectId, version }) : 0));
      if (n) this.db.delete('project_keys', { project_id: projectId, version });
      gone += n;
      this.forget(projectId);
    }
    return gone;
  }

  /**
   * Delete one retired version only if it has been retired for `graceMs` by Postgres's clock and no stored credential names it,
   * both decided inside the one DELETE (a credential written by another process a moment ago is seen). SQLite: this process's
   * clock and rows. Returns how many went (0 or 1).
   */
  async destroyDue(projectId: string, version: number, graceMs = KEY_DESTROY_GRACE_MS): Promise<number> {
    const call = this.direct(async (client) => {
      const deleted = await client.query(
        `DELETE FROM project_keys WHERE project_id = $1 AND version = $2 AND state = 'retired' AND retired_at IS NOT NULL
           AND retired_at::timestamptz <= now() - make_interval(secs => $3::float8 / 1000.0)
           AND NOT EXISTS (SELECT 1 FROM credentials WHERE strpos(data, '"dek":"' || $1 || '.' || $2::text || '"') > 0)`,
        [projectId, version, graceMs],
      );
      if (deleted.rowCount) await this.notify(client, projectId, version);
      return deleted.rowCount ?? 0;
    });
    const n = call
      ? await call
      : this.db.transaction(() => {
          const row = this.rows(projectId).find((r) => r.version === version);
          return row && row.state === 'retired' && row.retired_at && Date.parse(row.retired_at) <= Date.now() - graceMs ? this.db.delete('project_keys', { project_id: projectId, version }) : 0;
        });
    if (n) this.db.delete('project_keys', { project_id: projectId, version });
    this.forget(projectId);
    return n;
  }

  /** Re-wrap every key whose wrap names another ring key than the primary, keeping each row's version and AAD; one conditional change per row (Postgres: a conditional UPDATE naming only that column; SQLite: the row just read, in a transaction), only if the row still holds the wrap that was read. */
  async rewrapAll(): Promise<RewrapResult> {
    if (!this.remote) return this.rewrapAllSync();
    const result: RewrapResult = { rewrapped: 0, current: 0, failed: [] };
    const rows = (await this.allRows()) ?? this.rows();
    for (const row of rows) {
      if (wrappedKid(row.wrapped) === this.ring.primary) {
        result.current += 1;
        continue;
      }
      try {
        const key = this.unwrap(row);
        const changed = await this.change(row.project_id, row.version, { wrapped: this.wrap(row.project_id, row.version, key) }, { wrapped: row.wrapped });
        // Gone or changed by another process meanwhile: nothing to do, a later run sees what is there.
        if (changed) result.rewrapped += 1;
        key.fill(0);
      } catch (error) {
        logger.warn('a project key could not be re-wrapped', { 'landflow.project_key.project': row.project_id, 'landflow.project_key.version': row.version, error: error instanceof ProjectKeyError ? error.reason : 'error' });
        result.failed.push(`${row.project_id}:${row.version}`);
      }
    }
    return result;
  }

  /** `rewrapAll` for SQLite, where it needs no waiting (root rotation in a script, or in one process). */
  rewrapAllSync(): RewrapResult {
    const result: RewrapResult = { rewrapped: 0, current: 0, failed: [] };
    for (const row of this.rows()) {
      if (wrappedKid(row.wrapped) === this.ring.primary) {
        result.current += 1;
        continue;
      }
      try {
        const key = this.unwrap(row);
        if (this.changeLocal(row.project_id, row.version, { wrapped: this.wrap(row.project_id, row.version, key) }, { wrapped: row.wrapped })) result.rewrapped += 1;
        key.fill(0);
      } catch (error) {
        logger.warn('a project key could not be re-wrapped', { 'landflow.project_key.project': row.project_id, 'landflow.project_key.version': row.version, error: error instanceof ProjectKeyError ? error.reason : 'error' });
        result.failed.push(`${row.project_id}:${row.version}`);
      }
    }
    return result;
  }

  /** Drop unwrapped keys from memory, zeroed: one project's, or all of them. */
  forget(projectId?: string) {
    for (const [id, entry] of [...this.cache]) {
      if (projectId && !id.startsWith(`${projectId}:`)) continue;
      entry.key.fill(0);
      this.cache.delete(id);
    }
  }

  /** Stop listening and drop every key from memory. */
  close() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.forget();
  }
}
