/**
 * Credentials and the data directory's settings files in the database (lib/server/config-store.ts, migration 1300).
 *
 * - LANDFLOW_CONFIG_STORE picks `files` or `database`; unset, queue mode means `database` and anything else `files`.
 * - Files mode is unchanged: credentials.json (mode 0600, sealed values), read back by a new vault.
 * - Database mode imports credentials.json once (recorded in `meta`), leaves the file byte for byte as it was, keeps
 *   the encryption key where it is, and writes rows from then on: a credential deleted after the import doesn't come
 *   back from the file, and two vaults changing different credentials don't overwrite each other.
 * - Settings documents (mcp.json, marketplaces.json…) follow the same rules through ConfigFile: imported once, the
 *   file left alone, rows from then on; MCP access and the marketplace store work on top of them.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-config-store-'));
const previous = { dir: process.env.LANDFLOW_DATA_DIR, store: process.env.LANDFLOW_CONFIG_STORE };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_DB: 'sqlite', LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_CONFIG_STORE;
delete process.env.LANDFLOW_ENCRYPTION_KEY;

const { configStoreKind, ConfigFile } = await import('@/lib/server/config-store');
const { CredentialFile, CredentialTable, CredentialVault } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { mcpAccess, setMcpEnabled, verifyMcpToken } = await import('@/lib/server/mcp/instance');
const { marketplaceStore } = await import('@/lib/server/marketplace/store');
registry.registerBuiltin(corePlugin);

const tables: Array<InstanceType<typeof CredentialTable>> = [];
afterEach(() => {
  delete process.env.LANDFLOW_CONFIG_STORE;
  for (const table of tables.splice(0)) table.close();
});
afterAll(() => {
  if (previous.dir === undefined) delete process.env.LANDFLOW_DATA_DIR;
  else process.env.LANDFLOW_DATA_DIR = previous.dir;
  if (previous.store !== undefined) process.env.LANDFLOW_CONFIG_STORE = previous.store;
});

const fileVault = (dir: string) => new CredentialVault({ dir, backend: new CredentialFile(join(dir, 'credentials.json')) });
const tableVault = (dir: string) => {
  const table = new CredentialTable(join(dir, 'credentials.json'));
  tables.push(table);
  return new CredentialVault({ dir, backend: table });
};
const header = { name: 'X-Key', value: 'super-secret-header-value' };

describe('LANDFLOW_CONFIG_STORE', () => {
  it('defaults to files, and to the database in queue mode; either can be set', () => {
    expect(configStoreKind({})).toBe('files');
    expect(configStoreKind({ LANDFLOW_EXECUTIONS_MODE: 'queue' })).toBe('database');
    expect(configStoreKind({ LANDFLOW_EXECUTIONS_MODE: 'queue', LANDFLOW_CONFIG_STORE: 'files' })).toBe('files');
    expect(configStoreKind({ LANDFLOW_CONFIG_STORE: 'database' })).toBe('database');
    expect(configStoreKind({ LANDFLOW_CONFIG_STORE: ' DB ' })).toBe('database');
  });
});

describe('credentials', () => {
  it('files mode: credentials.json as before (0600, sealed), read back by another vault', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-cred-files-'));
    const vault = fileVault(dir);
    expect(vault.storeKind).toBe('files');
    const created = vault.create({ name: 'Header', type: 'core.httpHeaderAuth', data: header });
    const file = join(dir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('super-secret-header-value');
    expect(JSON.parse(text)).toMatchObject({ version: 1, credentials: [{ id: created.id, name: 'Header', type: 'core.httpHeaderAuth', data: { iv: expect.any(String), tag: expect.any(String), value: expect.any(String) } }] });
    expect(fileVault(dir).dataFor({ id: created.id, name: 'Header' }, 'core.httpHeaderAuth')).toMatchObject(header);
    // Nothing in the database.
    expect(database().get('SELECT id FROM credentials WHERE id = ?', created.id)).toBeUndefined();
  });

  it('database mode: imports credentials.json once and leaves it (and the key) as they were', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-cred-db-'));
    const files = fileVault(dir);
    const first = files.create({ name: 'First', type: 'core.httpHeaderAuth', data: header });
    const second = files.create({ name: 'Second', type: 'core.httpHeaderAuth', data: { name: 'X-Other', value: 'other-secret' } });
    const file = join(dir, 'credentials.json');
    const bytes = readFileSync(file);
    const key = readFileSync(join(dir, 'encryption.key'));
    // Another install's import marker would hide this one: each test dir gets its own database rows only by id.
    database().delete('meta', { key: 'config_store.imported.credentials.json' });

    const vault = tableVault(dir);
    expect(vault.storeKind).toBe('database');
    expect(vault.list().map((c) => c.name).sort()).toEqual(['First', 'Second']);
    expect(vault.dataFor({ id: first.id, name: 'First' }, 'core.httpHeaderAuth')).toMatchObject(header);
    expect(database().get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'config_store.imported.credentials.json')).toBeDefined();
    expect(database().all('SELECT id FROM credentials WHERE id IN (?, ?)', first.id, second.id)).toHaveLength(2);

    // Changes go to rows; the file stays byte for byte.
    const third = vault.create({ name: 'Third', type: 'core.httpHeaderAuth', data: { name: 'X-Third', value: 'third-secret' } });
    vault.update(first.id, { name: 'First renamed' });
    expect(vault.delete(second.id)).toBe(true);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(readFileSync(join(dir, 'encryption.key')).equals(key)).toBe(true);

    // Another process (a new vault): no second import, so the deleted credential stays deleted.
    const other = tableVault(dir);
    expect(other.list().map((c) => c.name).sort()).toEqual(expect.arrayContaining(['First renamed', 'Third']));
    expect(other.list().some((c) => c.id === second.id)).toBe(false);
    expect(other.dataFor({ id: third.id, name: 'Third' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'third-secret' });

    // Different credentials changed by two vaults: neither overwrites the other (the file would keep only the last).
    const a = vault.create({ name: 'From A', type: 'core.httpHeaderAuth', data: header });
    const b = other.create({ name: 'From B', type: 'core.httpHeaderAuth', data: header });
    const ids = database().all<{ id: string }>('SELECT id FROM credentials').map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id, first.id, third.id]));
  });
});

describe('settings documents', () => {
  it('database mode: a file is imported once, left in place, and rows win from then on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-config-doc-'));
    const path = join(dir, 'skill-library.json');
    writeFileSync(path, JSON.stringify({ skills: [{ id: 'from-file' }] }));
    chmodSync(path, 0o640);
    const bytes = readFileSync(path);
    database().delete('meta', { key: 'config_store.imported.skill-library.json' });
    database().delete('config_files', { name: 'skill-library.json' });

    const doc = new ConfigFile<{ skills: Array<{ id: string }> }>('skill-library.json', { dir: () => dir, kind: () => 'database' });
    expect(doc.read()).toEqual({ skills: [{ id: 'from-file' }] });
    doc.write({ skills: [{ id: 'from-row' }] });
    expect(doc.read()).toEqual({ skills: [{ id: 'from-row' }] });
    // Someone edits the file afterwards: it is not imported again.
    writeFileSync(path, JSON.stringify({ skills: [{ id: 'edited-file' }] }));
    const again = new ConfigFile<{ skills: Array<{ id: string }> }>('skill-library.json', { dir: () => dir, kind: () => 'database' });
    expect(again.read()).toEqual({ skills: [{ id: 'from-row' }] });
    expect(database().get<{ updated_by: string }>('SELECT updated_by FROM config_files WHERE name = ?', 'skill-library.json')?.updated_by).toBeTruthy();
    writeFileSync(path, bytes);

    // Files mode reads and writes the file itself.
    const files = new ConfigFile<{ skills: Array<{ id: string }> }>('skill-library.json', { dir: () => dir, kind: () => 'files' });
    expect(files.read()).toEqual({ skills: [{ id: 'from-file' }] });
    files.write({ skills: [{ id: 'written' }] });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ skills: [{ id: 'written' }] });
  });

  it('MCP access and the marketplace store work in database mode, leaving their files alone', () => {
    // mcp.json and marketplaces.json written in files mode first.
    const enabled = setMcpEnabled(true);
    expect(enabled.token).toMatch(/^lf_mcp_/);
    const mcpFile = join(dataDir, 'mcp.json');
    expect(existsSync(mcpFile)).toBe(true);
    const mcpBytes = readFileSync(mcpFile);
    marketplaceStore.addMarketplace('acme/tools', { kind: 'github', owner: 'acme', repo: 'tools' }, 'mk_tmp_files');
    const marketplacesFile = join(dataDir, 'marketplaces.json');
    const marketplaceBytes = readFileSync(marketplacesFile);

    process.env.LANDFLOW_CONFIG_STORE = 'database';
    // Imported: the same token still works, the same marketplaces are listed.
    expect(mcpAccess()).toMatchObject({ enabled: true, hasToken: true });
    expect(verifyMcpToken(enabled.token)).toBe(true);
    expect(marketplaceStore.marketplace('mk_tmp_files')).toMatchObject({ input: 'acme/tools' });

    // Changes land in rows only.
    setMcpEnabled(false);
    marketplaceStore.removeMarketplace('mk_tmp_files');
    expect(mcpAccess().enabled).toBe(false);
    expect(marketplaceStore.marketplace('mk_tmp_files')).toBeUndefined();
    expect(readFileSync(mcpFile).equals(mcpBytes)).toBe(true);
    expect(readFileSync(marketplacesFile).equals(marketplaceBytes)).toBe(true);
    expect(JSON.parse(database().get<{ data: string }>('SELECT data FROM config_files WHERE name = ?', 'mcp.json')!.data)).toMatchObject({ enabled: false });

    // Back in files mode, the files are what they were.
    delete process.env.LANDFLOW_CONFIG_STORE;
    expect(mcpAccess().enabled).toBe(true);
    expect(marketplaceStore.marketplace('mk_tmp_files')).toMatchObject({ input: 'acme/tools' });
  });
});
