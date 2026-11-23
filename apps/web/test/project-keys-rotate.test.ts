/**
 * C31, rotation and migration at scale, on the credentials table (LANDFLOW_CONFIG_STORE=database) in a scratch data
 * directory:
 * - root rotation (AS-4): 10,000 credentials on project keys across 20 projects; the new primary re-wraps the 20 key
 *   rows and not one credential row changes, in well under 5 s; the old ring key is no longer needed by them;
 * - one project's key (AS-7): a new version, that project's credentials re-sealed, the other projects untouched;
 * - migrate (AS-3): 500 credentials on the ring, writes that stop working after 250, a rerun finishes with 0 failures;
 * - revert: everything back on the ring's primary as version 2, opening with the ring alone.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-keys-rotate-'));
const previousEnv = { ...process.env };
const K1 = `k1:${'a1'.repeat(32)}`;
const K2 = `k2:${'b2'.repeat(32)}`;
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_CONFIG_STORE: 'database', LANDFLOW_ENCRYPTION_KEYS: `${K2},${K1}`, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_ENCRYPTION_KEY;

const { database } = await import('@/lib/server/db');
const { CredentialTable, CredentialVault } = await import('@/lib/server/credentials/vault');
const ring = await import('@/lib/server/credentials/key-ring');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

const LATER = Date.now() + 60 * 60_000; // past the grace period before a retired key may be deleted
const PROJECTS = 20;
const COUNT = 10_000;
const projectOf = (i: number) => `prj_rot_${i % PROJECTS}`;
const home = new Map<string, string>();

// What the host left behind: 10,000 credentials on project keys, wrapped by k1 (the ring before the rotation).
beforeAll(() => {
  const table = new CredentialTable(join(dataDir, 'credentials.json'));
  // A vault whose ring is the old one only: what the host sealed before k2 was added.
  process.env.LANDFLOW_ENCRYPTION_KEYS = K1;
  const maker = new CredentialVault({ dir: dataDir, backend: { kind: 'files', load: () => [], save: () => undefined, stale: () => false, close: () => undefined } });
  process.env.LANDFLOW_ENCRYPTION_KEYS = `${K2},${K1}`;
  maker.setProjectResolver((id) => home.get(id));
  const db = database();
  db.transaction(() => {
    for (let i = 0; i < COUNT; i++) {
      const id = `cred_rot_${i}`;
      home.set(id, projectOf(i));
      maker.create({ name: `Cred ${i}`, type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: `secret-value-${i}-padding` } }, { id });
      const stored = (maker as unknown as { credentials: Map<string, never> }).credentials.get(id)!;
      table.save({ saved: stored });
    }
  });
  table.close();
});

const credentialRows = () => new Map(database().all<{ id: string; data: string }>('SELECT id, data FROM credentials').map((row) => [row.id, row.data]));
const keyRows = () => new Map(database().all<{ project_id: string; version: number; wrapped: string }>('SELECT project_id, version, wrapped FROM project_keys').map((row) => [`${row.project_id}:${row.version}`, row.wrapped]));

let credentials: typeof import('@/lib/server/credentials/vault').credentials;
let rotateEncryption: typeof import('@/lib/server/credentials/rotate').rotateEncryption;
let projectKeys: typeof import('@/lib/server/credentials/project-keys').projectKeys;
beforeAll(async () => {
  // The host as it runs after the restart: the new key first, the old one still listed.
  ({ credentials } = await import('@/lib/server/credentials/vault'));
  ({ rotateEncryption } = await import('@/lib/server/credentials/rotate'));
  ({ projectKeys } = await import('@/lib/server/credentials/project-keys'));
  credentials.setProjectResolver((id) => home.get(id));
});

describe('root rotation with project keys (AS-4)', () => {
  it('re-wraps the project keys, touches no credential and takes seconds, not minutes', () => {
    expect(credentialRows().size).toBe(COUNT);
    const credsBefore = credentialRows();
    const keysBefore = keyRows();
    expect(keysBefore.size).toBe(PROJECTS);
    for (const wrapped of keysBefore.values()) expect(wrapped).toMatch(/^v2\.k1\./);

    const started = performance.now();
    const result = rotateEncryption();
    const took = performance.now() - started;

    expect(result.primary).toBe('k2');
    expect(result.failed).toEqual([]);
    expect(result.projectKeys).toMatchObject({ rewrapped: PROJECTS, failed: [] });
    expect(result.resealed).toBe(0);
    expect(took).toBeLessThan(5_000);
    // Every credential row is byte-equal; every key row is wrapped by k2 now.
    const credsAfter = credentialRows();
    for (const [id, data] of credsBefore) expect(credsAfter.get(id)).toBe(data);
    for (const wrapped of keyRows().values()) expect(wrapped).toMatch(/^v2\.k2\./);
    // A second run has nothing to do.
    expect(rotateEncryption().projectKeys).toMatchObject({ rewrapped: 0, current: PROJECTS });
  });

  it('the credentials still open, from a process that has only the new key', () => {
    const fresh = new CredentialVault({ dir: dataDir, backend: new CredentialTable(join(dataDir, 'credentials.json')) });
    expect(fresh.dataFor({ id: 'cred_rot_7', name: 'Cred 7' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'secret-value-7-padding' });
    const audit = database().all<{ action: string }>("SELECT action FROM audit_events WHERE action = 'encryption.project_key.rewrapped'");
    expect(audit.length).toBe(1);
  });
});

describe('rotating one project’s key (AS-7)', () => {
  it('moves that project’s credentials to the new version and leaves every other project alone; the old version is retired, and a sweep after the grace period deletes it', async () => {
    const before = credentialRows();
    const result = await projectKeys.rotate('prj_rot_3');
    expect(result).toMatchObject({ version: 2, resealed: COUNT / PROJECTS, failed: [] });
    const after = credentialRows();
    let changed = 0;
    for (const [id, data] of after) {
      if (data !== before.get(id)) {
        changed += 1;
        expect(home.get(id)).toBe('prj_rot_3');
        expect(JSON.parse(data)).toMatchObject({ v: 3, dek: 'prj_rot_3.2' });
      }
    }
    expect(changed).toBe(COUNT / PROJECTS);
    expect(credentials.dataFor({ id: 'cred_rot_3', name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'secret-value-3-padding' });
    // Version 1 is only retired (another process may still be sealing with it): a sweep inside the grace period keeps it, one after deletes it. The other projects still have only version 1.
    expect(keyRows().has('prj_rot_3:1')).toBe(true);
    expect(await projectKeys.sweep(undefined, Date.now())).toEqual([]);
    expect(await projectKeys.sweep(undefined, Date.now() + 60 * 60_000)).toEqual(['prj_rot_3:1']);
    expect(keyRows().has('prj_rot_3:1')).toBe(false);
    expect(keyRows().has('prj_rot_4:1')).toBe(true);
    expect(database().all("SELECT 1 FROM audit_events WHERE action = 'encryption.project_key.rotated'")).toHaveLength(1);
  });

  it('keeps the old version while a credential that failed to move still names it, even to a sweep long after', async () => {
    const real = CredentialTable.prototype.save;
    const spy = vi.spyOn(CredentialTable.prototype, 'save').mockImplementation(function (this: unknown, change: { saved: { id: string } } | { removed: string }) {
      if ('saved' in change && change.saved.id === 'cred_rot_5') throw new Error('write failed');
      return (real as (c: unknown) => void).call(this, change);
    } as never);
    try {
      const result = await projectKeys.rotate('prj_rot_5');
      expect(result.failed).toEqual(['cred_rot_5']);
      expect(keyRows().has('prj_rot_5:1')).toBe(true);
      expect(await projectKeys.sweep(undefined, Date.now() + 60 * 60_000)).toEqual([]);
      expect(keyRows().has('prj_rot_5:1')).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // It is still readable, on version 1.
    expect(credentials.sealedWith('cred_rot_5')).toBe('dek:prj_rot_5.1');
    expect(credentials.dataFor({ id: 'cred_rot_5', name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'secret-value-5-padding' });
  });
});

describe('migrate and revert', () => {
  const OLD = 500;
  beforeAll(() => {
    // 500 credentials sealed on the ring (what the host held before project keys), in projects of their own.
    credentials.setProjectResolver(undefined);
    for (let i = 0; i < OLD; i++) {
      const id = `cred_old_${i}`;
      home.set(id, `prj_old_${i % 5}`);
      credentials.create({ name: `Old ${i}`, type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: `old-secret-${i}-padding` } }, { id });
    }
    credentials.setProjectResolver((id) => home.get(id));
  });

  it('is resumable: writes that stop after 250 leave the rest on the ring, and a rerun finishes with no failures (AS-3)', async () => {
    expect(credentials.sealedWithAll().filter((c) => c.sealedWith === 'ring:k2')).toHaveLength(OLD);
    const real = CredentialTable.prototype.save;
    let writes = 0;
    const spy = vi.spyOn(CredentialTable.prototype, 'save').mockImplementation(function (this: unknown, change: unknown) {
      if (++writes > 250) throw new Error('killed');
      return (real as (c: unknown) => void).call(this, change);
    } as never);
    let first: Awaited<ReturnType<typeof projectKeys.migrate>>;
    try {
      first = await projectKeys.migrate(undefined, LATER);
    } finally {
      spy.mockRestore();
    }
    // The 500, and cred_rot_5 left on a retired version by the test above, which migrate finishes as well.
    expect(first.resealed).toBe(250);
    expect(first.failed).toHaveLength(OLD + 1 - 250);
    expect(first.done).toBe(false);
    // Everything is still readable, whichever way it is sealed.
    for (const i of [0, 249, 250, 499]) expect(credentials.dataFor({ id: `cred_old_${i}`, name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: `old-secret-${i}-padding` });

    const second = await projectKeys.migrate(undefined, LATER);
    expect(second).toMatchObject({ resealed: OLD + 1 - 250, failed: [], done: true });
    // cred_rot_5 is on version 2 now, and version 1, which nothing names, is gone.
    expect(credentials.sealedWith('cred_rot_5')).toBe('dek:prj_rot_5.2');
    expect([...first.destroyed, ...second.destroyed]).toContain('prj_rot_5:1');
    expect(credentials.sealedWithAll().filter((c) => c.sealedWith.startsWith('ring:'))).toHaveLength(0);
    expect(await projectKeys.migrate(undefined, LATER)).toMatchObject({ resealed: 0, failed: [], done: true });
    expect(database().all("SELECT 1 FROM audit_events WHERE action = 'encryption.project_key.migrated'")).toHaveLength(3);
  });

  it('status counts credentials per project and what is left on the ring', () => {
    const status = projectKeys.status((id) => `name of ${id}`);
    expect(status.onRing).toBe(0);
    expect(status.unreadable).toEqual([]);
    const rot3 = status.projects.find((p) => p.projectId === 'prj_rot_3')!;
    expect(rot3).toMatchObject({ name: 'name of prj_rot_3', active: 2, retired: [], credentials: COUNT / PROJECTS });
    expect(status.projects.find((p) => p.projectId === 'prj_old_0')).toMatchObject({ active: 1, credentials: OLD / 5 });
    expect(status.projects.find((p) => p.projectId === 'prj_rot_5')).toMatchObject({ active: 2, retired: [] });
  });

  it('rotateEncryption called without a project keys result refuses on Postgres instead of reporting a rotation that skipped them', () => {
    const db = database();
    const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(db), 'kind') ?? Object.getOwnPropertyDescriptor(db, 'kind');
    Object.defineProperty(db, 'kind', { value: 'postgres', configurable: true });
    try {
      expect(() => rotateEncryption()).toThrow(/rotateEncryptionAll/);
      expect(() => rotateEncryption({ projectKeys: { rewrapped: 0, current: 0, failed: [] } })).not.toThrow();
    } finally {
      delete (db as unknown as Record<string, unknown>).kind;
      if (real && !Object.getOwnPropertyDescriptor(db, 'kind')) Object.defineProperty(db, 'kind', real);
    }
  });

  it('revert puts every credential back on the ring’s primary key as version 2, and the ring alone opens them', async () => {
    const result = await projectKeys.revert();
    expect(result).toMatchObject({ failed: [], onProjectKeys: 0, done: true });
    expect(result.resealed).toBe(COUNT + OLD);
    const rows = [...credentialRows().values()].map((data) => JSON.parse(data) as { v: number; kid: string; dek?: string });
    expect(rows.every((data) => data.v === 2 && data.kid === 'k2' && data.dek === undefined)).toBe(true);
    // A host from before project keys: the ring only, no project_keys table in sight.
    const ringOnly = ring.buildKeyRing(`${K2},${K1}`, undefined);
    const stored = JSON.parse(credentialRows().get('cred_rot_9')!);
    expect(JSON.parse(ring.openWith(ringOnly, stored, 'landflow:credential:cred_rot_9'))).toMatchObject({ value: 'secret-value-9-padding' });
    // Idempotent.
    expect(await projectKeys.revert()).toMatchObject({ resealed: 0, done: true });
  });
});
