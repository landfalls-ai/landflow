/**
 * C31: the data key of each project (DEK), the layer between the key ring and a project's credentials. A DEK is 256
 * random bits, kept in `project_keys` wrapped by the ring's primary key (a v2 sealed string whose AAD binds the project
 * and the version, so a wrapped key copied to another row or project no longer opens). A project has at most one
 * `active` version; older versions stay `retired` while a credential still names them and are deleted (destroyed) when
 * nothing does. Unwrapped keys live only in this process's memory for ten minutes and are never logged, audited,
 * serialized or put in an error. This file holds the key level only; what to re-seal and when lives in ./project-keys,
 * which sits above the vault, so the vault can import this without a cycle.
 */
import { randomBytes } from 'node:crypto';
import { database, type Database } from '../db';
import { recordAudit } from '../audit';
import { logger } from '../telemetry/logger';
import { openWith, sealWith, type KeyRing, type SealedValue } from './key-ring';

/** How long an unwrapped key is kept in memory (FR-9). */
export const KEY_CACHE_MS = 10 * 60_000;

export type ProjectKeyState = 'active' | 'retired';

export type ProjectKeyRow = {
  project_id: string;
  version: number;
  wrapped: string;
  state: ProjectKeyState;
  created_at: string;
  retired_at: string | null;
};

/** A project's key is missing or can't be opened (the project's key is gone, or the ring lacks the key that wrapped it). */
export class ProjectKeyError extends Error {
  constructor(
    message: string,
    readonly reason: 'gone' | 'unwrap',
  ) {
    super(message);
  }
}

/** AAD of a wrapped key: the project and the version. */
export const wrapAad = (projectId: string, version: number) => `landflow:project-key:${projectId}:${version}`;

/** `v2.<kid>.<iv>.<tag>.<ciphertext>`, the form `sealSecret` uses. */
const toString = (sealed: SealedValue) => `v2.${sealed.kid}.${sealed.iv}.${sealed.tag}.${sealed.value}`;

function parseWrapped(text: string): SealedValue | undefined {
  const parts = text.split('.');
  if (parts[0] !== 'v2' || parts.length !== 5 || !parts[1] || !parts[2] || !parts[3]) return undefined;
  return { v: 2, kid: parts[1], iv: parts[2], tag: parts[3], value: parts[4]! };
}

/** The kid that wrapped a key (undefined when the text is not a wrapped key). */
export const wrappedKid = (text: string): string | undefined => parseWrapped(text)?.kid;

export interface ProjectKeyStoreOptions {
  ring: KeyRing;
  /** The database holding `project_keys` (default: the host's). */
  db?: () => Database;
  /** The clock the cache uses (tests). */
  now?: () => number;
}

export class ProjectKeyStore {
  private readonly cache = new Map<string, { key: Buffer; at: number }>();
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

  /** Every key row, or one project's, oldest version first. */
  rows(projectId?: string): ProjectKeyRow[] {
    const rows = projectId
      ? this.db.all<ProjectKeyRow>('SELECT * FROM project_keys WHERE project_id = ? ORDER BY version', projectId)
      : this.db.all<ProjectKeyRow>('SELECT * FROM project_keys ORDER BY project_id, version');
    return rows.map((row) => ({ ...row, version: Number(row.version) }));
  }

  /** The active version of a project's key, if it has one. */
  activeVersion(projectId: string): number | undefined {
    return this.rows(projectId).find((row) => row.state === 'active')?.version;
  }

  private wrap(projectId: string, version: number, key: Buffer): string {
    return toString(sealWith(this.ring, key.toString('hex'), wrapAad(projectId, version)));
  }

  /** The project's active key; the first call for a project creates version 1 (audited, fail-open: a save never waits on it). */
  activeFor(projectId: string): { version: number; key: Buffer } {
    const active = this.rows(projectId).find((row) => row.state === 'active');
    if (active) return { version: active.version, key: this.keyFor(projectId, active.version) };
    const key = randomBytes(32);
    const row: ProjectKeyRow = { project_id: projectId, version: 1, wrapped: this.wrap(projectId, 1, key), state: 'active', created_at: new Date().toISOString(), retired_at: null };
    // Two processes may race here: the row that landed first is the key, and the loser reads it.
    if (!this.db.insertNew('project_keys', row)) return this.activeFor(projectId);
    this.cache.set(`${projectId}:1`, { key, at: this.now() });
    recordAudit({ action: 'encryption.project_key.created', target: { type: 'project', id: projectId }, project: projectId, summary: `Created version 1 of the encryption key of project ${projectId}`, details: { projectId, version: 1 } });
    return { version: 1, key };
  }

  /** A version's unwrapped key: from memory for ten minutes, else unwrapped with the ring. Throws ProjectKeyError. */
  keyFor(projectId: string, version: number): Buffer {
    const id = `${projectId}:${version}`;
    const cached = this.cache.get(id);
    if (cached && this.now() - cached.at < KEY_CACHE_MS) return cached.key;
    this.cache.delete(id);
    const row = this.rows(projectId).find((r) => r.version === version);
    if (!row) throw new ProjectKeyError(`Key ${version} of project ${projectId} is gone`, 'gone');
    const key = this.unwrap(row);
    this.cache.set(id, { key, at: this.now() });
    return key;
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

  /** A new active version (the old active one becomes retired), in one transaction. Returns the new version. */
  addVersion(projectId: string): { version: number; previous?: number } {
    return this.db.transaction(() => {
      const rows = this.rows(projectId);
      const previous = rows.find((row) => row.state === 'active');
      const version = Math.max(0, ...rows.map((row) => row.version)) + 1;
      const key = randomBytes(32);
      const now = new Date().toISOString();
      if (previous) this.db.upsert('project_keys', { ...previous, state: 'retired', retired_at: now });
      this.db.upsert('project_keys', { project_id: projectId, version, wrapped: this.wrap(projectId, version, key), state: 'active', created_at: now, retired_at: null });
      this.cache.set(`${projectId}:${version}`, { key, at: this.now() });
      return { version, ...(previous && { previous: previous.version }) };
    });
  }

  /** Mark every version of a project retired (nothing new is sealed with it; what names it still opens). */
  retireAll(projectId: string) {
    const now = new Date().toISOString();
    for (const row of this.rows(projectId)) if (row.state !== 'retired') this.db.upsert('project_keys', { ...row, state: 'retired', retired_at: now });
  }

  /** Mark one version retired. */
  retire(projectId: string, version: number) {
    const row = this.rows(projectId).find((r) => r.version === version);
    if (row && row.state !== 'retired') this.db.upsert('project_keys', { ...row, state: 'retired', retired_at: new Date().toISOString() });
  }

  /** Delete versions of a project's key (all of them when `versions` is left out) and forget their unwrapped copies. Returns how many went. */
  destroy(projectId: string, versions?: number[]): number {
    let gone = 0;
    for (const row of this.rows(projectId)) {
      if (versions && !versions.includes(row.version)) continue;
      gone += this.db.delete('project_keys', { project_id: projectId, version: row.version });
      this.cache.delete(`${projectId}:${row.version}`);
    }
    return gone;
  }

  /** Re-wrap every key whose wrap names another ring key than the primary, keeping each row's version and AAD. Writes one row at a time. */
  rewrapAll(): { rewrapped: number; current: number; failed: string[] } {
    const result = { rewrapped: 0, current: 0, failed: [] as string[] };
    for (const row of this.rows()) {
      if (wrappedKid(row.wrapped) === this.ring.primary) {
        result.current += 1;
        continue;
      }
      try {
        const key = this.unwrap(row);
        this.db.upsert('project_keys', { ...row, wrapped: this.wrap(row.project_id, row.version, key) });
        result.rewrapped += 1;
      } catch (error) {
        logger.warn('a project key could not be re-wrapped', { 'landflow.project_key.project': row.project_id, 'landflow.project_key.version': row.version, error: error instanceof ProjectKeyError ? error.reason : 'error' });
        result.failed.push(`${row.project_id}:${row.version}`);
      }
    }
    return result;
  }

  /** Drop every unwrapped key from memory (rotation in this process). */
  forget(projectId?: string) {
    if (!projectId) return this.cache.clear();
    for (const id of [...this.cache.keys()]) if (id.startsWith(`${projectId}:`)) this.cache.delete(id);
  }
}
