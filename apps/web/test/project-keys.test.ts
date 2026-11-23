/**
 * C31, the key level: a project's data key (lib/server/credentials/project-key-store.ts) and the vault sealing with it
 * (version 3 values naming `<projectId>.<version>`). The wrapped key binds project and version; unwrapped keys are
 * cached ten minutes and never appear in logs, audit events or errors (AS-8); two projects' credentials sit under
 * different keys and one project's key can't open the other's value (AS-1); a credential sealed on the ring before the
 * change still opens and runs (AS-2); rotating the ring's primary leaves project-key credentials alone.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-keys-'));
const previousEnv = { ...process.env };
const K1 = `k1:${'a1'.repeat(32)}`;
const K2 = `k2:${'b2'.repeat(32)}`;
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_ENCRYPTION_KEYS: K1, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_ENCRYPTION_KEY;

const ring = await import('@/lib/server/credentials/key-ring');
const { CredentialVault } = await import('@/lib/server/credentials/vault');
const { ProjectKeyStore, ProjectKeyError, KEY_CACHE_MS, wrapAad } = await import('@/lib/server/credentials/project-key-store');
const { database } = await import('@/lib/server/db');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { logger } = await import('@/lib/server/telemetry/logger');
registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

const SECRET = 'header-secret-value-1234';
const header = (value = SECRET) => ({ name: 'X-Key', value });
type StoredCredential = import('@/lib/server/credentials/vault').StoredCredential;

function memoryBackend() {
  const rows = new Map<string, StoredCredential>();
  return {
    rows,
    backend: {
      kind: 'files' as const,
      load: () => [...rows.values()].map((c) => structuredClone(c)),
      save: (change: { saved: StoredCredential } | { removed: string }) => {
        if ('saved' in change) rows.set(change.saved.id, structuredClone(change.saved));
        else rows.delete(change.removed);
      },
      stale: () => false,
      close: () => undefined,
    },
  };
}

/** A vault whose credentials are in memory and whose projects are the map `home` (credential id → project). */
function vaultWith(home: Map<string, string>, options: { keyClock?: () => number } = {}) {
  const memory = memoryBackend();
  const vault = new CredentialVault({ dir: dataDir, backend: memory.backend, ...options });
  vault.setProjectResolver((id) => home.get(id));
  return { vault, memory };
}

describe('the project key store', () => {
  const keyRing = ring.buildKeyRing(K1, undefined);

  it('creates version 1 once, however often it is asked, and audits it', () => {
    const store = new ProjectKeyStore({ ring: keyRing });
    const first = store.activeFor('prj_a');
    const again = store.activeFor('prj_a');
    expect(first.version).toBe(1);
    expect(again.key.equals(first.key)).toBe(true);
    expect(store.rows('prj_a')).toHaveLength(1);
    expect(store.rows('prj_a')[0]).toMatchObject({ state: 'active', version: 1 });
    const events = database().all<{ action: string }>("SELECT action FROM audit_events WHERE action = 'encryption.project_key.created'");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('wraps the key with the ring as a v2 value bound to project and version: another row cannot be opened with it', () => {
    const store = new ProjectKeyStore({ ring: keyRing });
    store.activeFor('prj_wrap_a');
    store.activeFor('prj_wrap_b');
    const a = store.rows('prj_wrap_a')[0]!;
    expect(a.wrapped).toMatch(/^v2\.k1\./);
    // Copying A's wrapped key onto B's row (or to another version) fails to unwrap.
    database().upsert('project_keys', { ...a, project_id: 'prj_wrap_b', version: 1 });
    const fresh = new ProjectKeyStore({ ring: keyRing });
    expect(() => fresh.keyFor('prj_wrap_b', 1)).toThrow(ProjectKeyError);
    // Its own row opens, and the AAD is what the module says it is.
    const parts = a.wrapped.split('.');
    const opened = ring.openWith(keyRing, { v: 2, kid: parts[1], iv: parts[2]!, tag: parts[3]!, value: parts[4]! }, wrapAad('prj_wrap_a', 1));
    expect(opened).toBe(fresh.keyFor('prj_wrap_a', 1).toString('hex'));
  });

  it('keeps an unwrapped key for ten minutes, then unwraps again', () => {
    let now = 1_000_000;
    const store = new ProjectKeyStore({ ring: keyRing, now: () => now });
    store.activeFor('prj_cache');
    const cold = new ProjectKeyStore({ ring: keyRing, now: () => now });
    cold.keyFor('prj_cache', 1);
    cold.keyFor('prj_cache', 1);
    expect(cold.unwraps).toBe(1);
    now += KEY_CACHE_MS - 1;
    cold.keyFor('prj_cache', 1);
    expect(cold.unwraps).toBe(1);
    now += 2;
    cold.keyFor('prj_cache', 1);
    expect(cold.unwraps).toBe(2);
  });

  it('a missing version is "gone"; a wrap the ring cannot open is "unwrap"', () => {
    const store = new ProjectKeyStore({ ring: keyRing });
    expect(() => store.keyFor('prj_nothing', 1)).toThrow(expect.objectContaining({ reason: 'gone' }));
    store.activeFor('prj_foreign');
    const other = new ProjectKeyStore({ ring: ring.buildKeyRing(K2, undefined) });
    expect(() => other.keyFor('prj_foreign', 1)).toThrow(expect.objectContaining({ reason: 'unwrap' }));
  });

  it('never puts key bytes in a log line, an audit event or an error (AS-8)', () => {
    const lines: string[] = [];
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => void lines.push(JSON.stringify(args))) as never));
    try {
      const store = new ProjectKeyStore({ ring: keyRing });
      const { key } = store.activeFor('prj_logs');
      store.addVersion('prj_logs');
      const other = new ProjectKeyStore({ ring: ring.buildKeyRing(K2, undefined) });
      let message = '';
      try {
        other.keyFor('prj_logs', 1);
      } catch (error) {
        message = String((error as Error).message);
      }
      other.rewrapAll();
      const everything = [...lines, message, JSON.stringify(database().all('SELECT * FROM audit_events'))].join('\n');
      for (const form of [key.toString('hex'), key.toString('base64')]) expect(everything).not.toContain(form);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('adding a version retires the active one and keeps it readable', () => {
    const store = new ProjectKeyStore({ ring: keyRing });
    const v1 = store.activeFor('prj_versions');
    const { version, previous } = store.addVersion('prj_versions');
    expect([version, previous]).toEqual([2, 1]);
    expect(store.rows('prj_versions').map((r) => [r.version, r.state])).toEqual([[1, 'retired'], [2, 'active']]);
    expect(store.activeFor('prj_versions').version).toBe(2);
    expect(new ProjectKeyStore({ ring: keyRing }).keyFor('prj_versions', 1).equals(v1.key)).toBe(true);
  });
});

describe('the vault with a project resolver', () => {
  it('seals two projects with different keys; neither key opens the other project’s value (AS-1)', () => {
    const home = new Map<string, string>();
    const { vault, memory } = vaultWith(home);
    home.set('cred_a', 'prj_vault_a');
    home.set('cred_b', 'prj_vault_b');
    vault.create({ name: 'A', type: 'core.httpHeaderAuth', data: header() }, { id: 'cred_a' });
    vault.create({ name: 'B', type: 'core.httpHeaderAuth', data: header('another-secret-5678') }, { id: 'cred_b' });
    const a = memory.rows.get('cred_a')!.data;
    const b = memory.rows.get('cred_b')!.data;
    expect(a).toMatchObject({ v: 3, dek: 'prj_vault_a.1' });
    expect(b).toMatchObject({ v: 3, dek: 'prj_vault_b.1' });
    expect(a.kid).toBeUndefined();
    expect(vault.sealedWith('cred_a')).toBe('dek:prj_vault_a.1');
    expect(ring.kidOf(a)).toBe('dek:prj_vault_a.1');
    // B's key is not A's key, and does not open A's value.
    const keyA = vault.projectKeys.keyFor('prj_vault_a', 1);
    const keyB = vault.projectKeys.keyFor('prj_vault_b', 1);
    expect(keyA.equals(keyB)).toBe(false);
    expect(() => ring.openWithDek(keyB, a, 'landflow:credential:cred_a')).toThrow();
    expect(ring.openWithDek(keyA, a, 'landflow:credential:cred_a')).toContain(SECRET);
    // A value copied to another credential id no longer opens (the AAD binds the id).
    expect(() => ring.openWithDek(keyA, a, 'landflow:credential:cred_b')).toThrow();
    // The ring does not open it either.
    expect(() => ring.openWith(ring.buildKeyRing(K1, undefined), a, 'landflow:credential:cred_a')).toThrow();
    // And the vault still reads both.
    expect(vault.dataFor({ id: 'cred_a', name: 'A' }, 'core.httpHeaderAuth')).toMatchObject({ value: SECRET });
    expect(vault.dataFor({ id: 'cred_b', name: 'B' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'another-secret-5678' });
  });

  it('with no resolver the value is v2 on the ring, as before', () => {
    const memory = memoryBackend();
    const vault = new CredentialVault({ dir: dataDir, backend: memory.backend });
    vault.create({ name: 'Plain', type: 'core.httpHeaderAuth', data: header() }, { id: 'cred_plain' });
    expect(memory.rows.get('cred_plain')!.data).toMatchObject({ v: 2, kid: 'k1' });
    expect(vault.sealedWith('cred_plain')).toBe('ring:k1');
  });

  it('a credential sealed on the ring before the change still opens, and is re-sealed onto the project key only when it is saved (AS-2)', () => {
    const home = new Map<string, string>();
    const memory = memoryBackend();
    const before = new CredentialVault({ dir: dataDir, backend: memory.backend });
    before.create({ name: 'Old', type: 'core.httpHeaderAuth', data: header() }, { id: 'cred_old' });
    const after = new CredentialVault({ dir: dataDir, backend: memory.backend });
    after.setProjectResolver((id) => home.get(id));
    home.set('cred_old', 'prj_old');
    expect(after.sealedWith('cred_old')).toBe('ring:k1');
    expect(after.dataFor({ id: 'cred_old', name: 'Old' }, 'core.httpHeaderAuth')).toMatchObject({ value: SECRET });
    // A save that changes nothing leaves it; one that changes a value seals it with the project's key.
    after.update('cred_old', { name: 'Old renamed' });
    expect(after.sealedWith('cred_old')).toBe('ring:k1');
    after.update('cred_old', { data: { value: 'a-new-secret-value-99' } });
    expect(after.sealedWith('cred_old')).toBe('dek:prj_old.1');
    expect(after.dataFor({ id: 'cred_old', name: 'Old' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'a-new-secret-value-99' });
  });

  it('root rotation (rotateCredentials) leaves project-key values alone and seals old ones on the ring, not onto a project key', () => {
    const home = new Map<string, string>();
    const memory = memoryBackend();
    const old = new CredentialVault({ dir: dataDir, backend: memory.backend });
    old.create({ name: 'Ring', type: 'core.httpHeaderAuth', data: header() }, { id: 'cred_ring' });
    const vault = new CredentialVault({ dir: dataDir, backend: memory.backend });
    vault.setProjectResolver((id) => home.get(id));
    home.set('cred_dek', 'prj_rot');
    home.set('cred_ring', 'prj_rot');
    vault.create({ name: 'Dek', type: 'core.httpHeaderAuth', data: header('dek-secret-value-777') }, { id: 'cred_dek' });
    const before = JSON.stringify(memory.rows.get('cred_dek'));
    const result = vault.rotateCredentials();
    expect(result.failed).toEqual([]);
    expect(JSON.stringify(memory.rows.get('cred_dek'))).toBe(before);
    expect(vault.sealedWith('cred_ring')).toBe('ring:k1');
  });

  it('a credential whose project key is gone says so', () => {
    const home = new Map<string, string>([['cred_gone', 'prj_gone']]);
    const { vault } = vaultWith(home);
    vault.create({ name: 'Gone', type: 'core.httpHeaderAuth', data: header() }, { id: 'cred_gone' });
    vault.projectKeys.destroy('prj_gone');
    const reopened = new CredentialVault({ dir: dataDir, backend: (vault as unknown as { backend: never }).backend });
    expect(() => reopened.dataFor({ id: 'cred_gone', name: 'Gone' }, 'core.httpHeaderAuth')).toThrow(/its project's key is gone/);
  });

  it('keeps the credentials.json shape: the file holds v3 with the dek name and no key', () => {
    const home = new Map<string, string>([['cred_file', 'prj_file']]);
    const dir = mkdtempSync(join(tmpdir(), 'landflow-project-keys-file-'));
    const vault = new CredentialVault({ dir });
    vault.setProjectResolver((id) => home.get(id));
    vault.create({ name: 'File', type: 'core.httpHeaderAuth', data: header() }, { id: 'cred_file' });
    const text = readFileSync(join(dir, 'credentials.json'), 'utf8');
    const parsed = JSON.parse(text) as { credentials?: Array<{ data: unknown }> } | Array<{ data: unknown }>;
    expect((Array.isArray(parsed) ? parsed : parsed.credentials!)[0]!.data).toMatchObject({ v: 3, dek: 'prj_file.1' });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(vault.projectKeys.keyFor('prj_file', 1).toString('hex'));
  });
});
