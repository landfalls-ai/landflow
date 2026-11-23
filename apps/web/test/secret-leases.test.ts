/**
 * Leased dynamic secrets (C30), the building blocks: the `secret_leases` table (migration 2933) and its place in key
 * rotation, the fake Vault that issues leases (packages/test-fakes/src/vault-leases.ts), the OpenBao / Vault provider's
 * dynamic mounts (issue, renew, revoke), and the lease store: one lease per run and path, sealed at rest, never in the
 * value cache, refused outside a node call. Whole runs are in secret-leases-run.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeVaultLeases, VAULT_LEASES_TOKEN } from '@landflow/test-fakes/vault-leases';

vi.setConfig({ testTimeout: 30_000 });

const OLD_KEY = 'ab'.repeat(32);
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-leases-'));
Object.assign(process.env, {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_SECRETS_CACHE_TTL: '60',
  LANDFLOW_ENCRYPTION_KEYS: `n1:a new passphrase for the lease tests,n0:${OLD_KEY}`,
});
delete process.env.LANDFLOW_ENVIRONMENT;

const { database } = await import('@/lib/server/db');
const { MIGRATIONS, TABLES } = await import('@/lib/server/db/schema');
const { credentials } = await import('@/lib/server/credentials/vault');
const key = await import('@/lib/server/credentials/key-ring');
const { rotateEncryption } = await import('@/lib/server/credentials/rotate');
const secrets = await import('@/lib/server/secrets');
const { vaultProvider } = await import('@/lib/server/secrets/providers/vault');
const leases = await import('@/lib/server/secrets/leases');
const { AUDIT_ACTIONS } = await import('@/lib/shared/audit');

const bao = fakeVaultLeases();
const PATH = 'database/creds/report-reader';
const ref = { provider: 'bao', name: PATH };
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const rowOf = (id: string, over: Record<string, unknown> = {}) => ({ id, execution_id: 'run_x', provider: 'bao', path: PATH, state: 'active', issued_at: iso(), expires_at: iso(Date.now() + 900_000), attempts: 0, ...over });
const leaseRows = (executionId: string) => database().all<Record<string, string | null>>('SELECT * FROM secret_leases WHERE execution_id = ?', executionId);

beforeAll(async () => {
  await bao.start();
  secrets.externalSecrets.create({ name: 'bao', kind: 'vault', settings: { url: bao.url, auth: 'token', token: VAULT_LEASES_TOKEN, dynamicMounts: 'database/', leaseTtl: 900 } });
});
afterAll(async () => {
  secrets.externalSecrets.closeAll();
  await bao.stop();
});

describe('the secret_leases table (migration 2933)', () => {
  it('is a migration with a table entry, and holds one row for a run, a provider and a path', () => {
    expect(MIGRATIONS.find((m) => m.version === 2933)?.name).toBe('secret_leases');
    expect(TABLES.secret_leases).toEqual(['id']);
    const db = database();
    expect(db.insertNew('secret_leases', rowOf('lease_a', { execution_id: 'run_table' }))).toBe(true);
    // The same id again is a no-op (the claim a second process loses)…
    expect(db.insertNew('secret_leases', rowOf('lease_a', { execution_id: 'run_table' }))).toBe(false);
    // …and another id for the same run, provider and path is refused by the unique index.
    expect(() => db.insertNew('secret_leases', rowOf('lease_b', { execution_id: 'run_table' }))).toThrow(/UNIQUE|unique/);
    db.delete('secret_leases', { id: 'lease_a' });
  });

  it('names its audit actions', () => {
    for (const action of ['secrets.lease.issued', 'secrets.lease.revoked', 'secrets.lease.expired', 'secrets.lease.revoke_failed']) expect(AUDIT_ACTIONS).toHaveProperty([action]);
  });

  it('is part of key rotation: an active row’s sealed lease values and lease id move to the new primary key', () => {
    const values = JSON.stringify({ username: 'v-token-x', password: 'Pw-rotation-0123456789' });
    const seal = (text: string, purpose: string) => {
      const sealed = key.sealWith(key.buildKeyRing(`n0:${OLD_KEY}`, undefined), text, `landflow:${purpose}`);
      return `v2.${sealed.kid}.${sealed.iv}.${sealed.tag}.${sealed.value}`;
    };
    const db = database();
    db.upsert('secret_leases', rowOf('lease_rot', { execution_id: 'run_rot', lease_id: seal('database/creds/report-reader/abc123', 'secrets.lease.id'), lease_values: seal(values, 'secrets.lease') }));
    const result = rotateEncryption();
    expect(result.failed).toEqual([]);
    expect(result.stores.secret_leases).toBe(2);
    const after = db.get<{ lease_id: string; lease_values: string }>('SELECT lease_id, lease_values FROM secret_leases WHERE id = ?', 'lease_rot')!;
    expect(after.lease_id.startsWith('v2.n1.')).toBe(true);
    expect(after.lease_values.startsWith('v2.n1.')).toBe(true);
    expect(credentials.openSecret(after.lease_id, 'secrets.lease.id')).toBe('database/creds/report-reader/abc123');
    expect(credentials.openSecret(after.lease_values, 'secrets.lease')).toBe(values);
    db.delete('secret_leases', { id: 'lease_rot' });
  });
});

describe('the fake Vault that issues leases', () => {
  const get = (path: string, token = VAULT_LEASES_TOKEN) => fetch(`${bao.url}/v1/${path}`, { headers: { 'x-vault-token': token } });
  const put = (path: string, body: unknown) => fetch(`${bao.url}/v1/${path}`, { method: 'PUT', headers: { 'x-vault-token': VAULT_LEASES_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('issues a new user and lease on every read, and revokes it', async () => {
    bao.reset();
    const first = (await (await get(PATH)).json()) as { lease_id: string; lease_duration: number; renewable: boolean; data: { username: string; password: string } };
    const second = (await (await get(PATH)).json()) as typeof first;
    expect(first.data.username).not.toBe(second.data.username);
    expect(first.lease_id).not.toBe(second.lease_id);
    expect(first).toMatchObject({ lease_duration: 900, renewable: true });
    expect(Object.keys(bao.state().active)).toHaveLength(2);
    expect((await put('sys/leases/revoke', { lease_id: first.lease_id })).status).toBe(204);
    expect(Object.keys(bao.state().active)).toEqual([second.lease_id]);
    expect(bao.state().revoked).toEqual([first.lease_id]);
    // A lease that is not there is "not found", and a wrong token is refused.
    expect((await put('sys/leases/revoke', { lease_id: first.lease_id })).status).toBe(400);
    expect((await get(PATH, 'nope')).status).toBe(403);
  });

  it('renews, fails the next revokes on request, and goes down and up', async () => {
    bao.reset();
    const issued = (await (await get(PATH)).json()) as { lease_id: string };
    const renewed = (await (await put('sys/leases/renew', { lease_id: issued.lease_id, increment: 1200 })).json()) as { lease_duration: number };
    expect(renewed.lease_duration).toBe(1200);
    bao.failNext('revoke', 2);
    expect((await put('sys/leases/revoke', { lease_id: issued.lease_id })).status).toBe(500);
    expect((await put('sys/leases/revoke', { lease_id: issued.lease_id })).status).toBe(500);
    bao.down();
    expect((await get(PATH)).status).toBe(503);
    bao.up();
    expect((await put('sys/leases/revoke', { lease_id: issued.lease_id })).status).toBe(204);
    expect(bao.state().failedRevokes).toBe(2);
  });
});

describe('the OpenBao / Vault provider: dynamic mounts', () => {
  const make = (settings: Record<string, string | number>) => vaultProvider.create({ url: bao.url, auth: 'token', token: VAULT_LEASES_TOKEN, ...settings }, {});

  it('lists Dynamic mounts and Lease TTL in the form', () => {
    const names = vaultProvider.fields.map((field) => field.name);
    expect(names).toContain('dynamicMounts');
    expect(names).toContain('leaseTtl');
  });

  it('marks a path dynamic by its mount, and nothing else', () => {
    const provider = make({ dynamicMounts: 'database/, rabbitmq' });
    expect(provider.isDynamic?.('database/creds/report-reader')).toBe(true);
    expect(provider.isDynamic?.('rabbitmq/creds/x')).toBe(true);
    expect(provider.isDynamic?.('landflow/db')).toBe(false);
    expect(provider.isDynamic?.('database-backup/x')).toBe(false);
    expect(make({}).isDynamic?.('database/creds/x')).toBe(false);
  });

  it('issues, renews and revokes with the token and the right endpoints', async () => {
    bao.reset();
    const provider = make({ dynamicMounts: 'database/', leaseTtl: 600 });
    const issued = await provider.issue!(PATH);
    expect(issued.values).toMatchObject({ username: expect.stringMatching(/^v-token-report-reader/), password: expect.any(String) });
    expect(issued.leaseSeconds).toBe(900);
    expect(issued.renewable).toBe(true);
    expect(await provider.renewLease!(issued.leaseId)).toBe(600);
    expect(bao.state().active[issued.leaseId].increments).toEqual([600]);
    await provider.revokeLease!(issued.leaseId);
    expect(bao.state().revoked).toEqual([issued.leaseId]);
    for (const request of bao.requests()) expect(request.headers['x-vault-token']).toBe(VAULT_LEASES_TOKEN);
    provider.close?.();
  });

  it('refuses a path outside its dynamic mounts and one that climbs out', async () => {
    const provider = make({ dynamicMounts: 'database/' });
    await expect(provider.issue!('landflow/db')).rejects.toThrow(/not a dynamic path/i);
    await expect(provider.issue!('database/../sys/seal')).rejects.toThrow(/Not a secret path/);
    provider.close?.();
  });
});

describe('leased secrets', () => {
  it('issues one lease for a run and a path, however many nodes ask at once, and keeps its id and values sealed', async () => {
    bao.reset();
    const [a, b] = await Promise.all([leases.leasedSecret(ref, { executionId: 'run_one', workflowId: 'wf_1' }), leases.leasedSecret(ref, { executionId: 'run_one', workflowId: 'wf_1' })]);
    expect(a).toEqual(b);
    expect(bao.state().issued).toHaveLength(1);
    const [row] = leaseRows('run_one');
    expect(row).toMatchObject({ provider: 'bao', path: PATH, state: 'active', workflow_id: 'wf_1' });
    expect(row.lease_id).toMatch(/^v2\./);
    expect(row.lease_values).toMatch(/^v2\./);
    expect(JSON.stringify(row)).not.toContain(bao.state().issued[0].password);
    expect(JSON.stringify(row)).not.toContain(bao.state().issued[0].leaseId);
    expect(credentials.openSecret(row.lease_id!, 'secrets.lease.id')).toBe(bao.state().issued[0].leaseId);
    const expiresIn = Date.parse(row.expires_at!) - Date.parse(row.issued_at!);
    expect(expiresIn).toBe(900_000);
    // A later call (the run resumed in another process) reads the row, not the store.
    expect(await leases.leasedSecret(ref, { executionId: 'run_one' })).toEqual(a);
    expect(bao.state().issued).toHaveLength(1);
  });

  it('gives another run its own user (AS-5)', async () => {
    const one = (await leases.leasedSecret(ref, { executionId: 'run_one' })) as { username: string };
    const two = (await leases.leasedSecret(ref, { executionId: 'run_two' })) as { username: string };
    expect(two.username).not.toBe(one.username);
    expect(bao.state().issued).toHaveLength(2);
  });

  it('never puts a leased value in the value cache (FR-2)', async () => {
    secrets.externalSecrets.clearCache();
    const before = secrets.externalSecrets.stats();
    await leases.leasedSecret(ref, { executionId: 'run_cache' });
    expect(secrets.externalSecrets.stats()).toEqual(before);
    expect(secrets.externalSecrets.stats().cached).toBe(0);
  });

  it('resolves a $secrets reference to a dynamic path inside a run, and remembers the values for redaction (FR-9)', async () => {
    const data = await secrets.resolveSecretsIn(
      { user: `{{ $secrets.bao['${PATH}'].username }}`, password: `{{ $secrets.bao['${PATH}'].password }}`, port: 5432 },
      'Credential',
      { executionId: 'run_one' },
    );
    const leased = (await leases.leasedSecret(ref, { executionId: 'run_one' })) as { username: string; password: string };
    expect(data).toEqual({ user: leased.username, password: leased.password, port: 5432 });
    expect(secrets.redactText(`password=${leased.password}`)).toBe(`password=${secrets.REDACTED}`);
  });

  it('refuses a dynamic path outside a node call, naming what to do (C30-D4), and issues nothing', async () => {
    const before = bao.state().issued.length;
    const reference = `{{ $secrets.bao['${PATH}'].username }}`;
    await expect(secrets.resolveSecretsIn({ user: reference })).rejects.toThrow(/issued per run: use it in a node credential/);
    await expect(secrets.resolveCredentialData({ user: reference })).rejects.toThrow(/issued per run: use it in a node credential/);
    await expect(secrets.externalSecrets.read('bao', PATH)).rejects.toThrow(/issued per run: use it in a node credential/);
    await expect(secrets.loadParameterSecrets([{ provider: 'bao', name: PATH, key: 'username' }])).rejects.toThrow();
    expect(bao.state().issued).toHaveLength(before);
  });

  it('fails naming the path when the store refuses to issue (US-4), and writes no row', async () => {
    await expect(leases.leasedSecret({ provider: 'bao', name: 'database/creds/missing' }, { executionId: 'run_refused' })).rejects.toThrow(/bao\['database\/creds\/missing'\].*not found/);
    expect(leaseRows('run_refused')).toEqual([]);
  });

  it('names a key the issued secret does not have', async () => {
    await expect(secrets.resolveSecretsIn({ x: `{{ $secrets.bao['${PATH}'].nope }}` }, 'Credential', { executionId: 'run_one' })).rejects.toThrow(/has no key “nope”/);
  });

  it('refuses a run whose lease has ended, instead of issuing a second user (a run that waited past its lease)', async () => {
    await leases.revokeRun('run_two', 'admin');
    await expect(leases.leasedSecret(ref, { executionId: 'run_two' })).rejects.toThrow(/lease for .* ended/);
    expect(bao.state().issued).toHaveLength(3);
  });

  it('refuses the 10,001st open lease', async () => {
    const db = database();
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) db.insertNew('secret_leases', rowOf(`bulk_${i}`, { execution_id: `bulk_run_${i}`, provider: 'other' }));
    });
    await expect(leases.leasedSecret(ref, { executionId: 'run_too_many' })).rejects.toThrow(/too many open leases/);
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) db.delete('secret_leases', { id: `bulk_${i}` });
    });
  });
});
