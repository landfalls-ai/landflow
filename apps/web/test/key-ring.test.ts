/**
 * The encryption key ring (backend review S13): v1 values (no key id, no AAD) still open, new values are v2 with the
 * primary kid and bound to their row, passphrase keys are stretched with scrypt and the old SHA-256 form still opens,
 * derived keys differ per label, rotation re-seals everything and is idempotent, and the route is the owner's.
 */
import { createCipheriv, createHash, scryptSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-key-ring-'));
const LEGACY = 'an old passphrase for the vault';
const previousEnv = { ...process.env };
Object.assign(process.env, {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_ENCRYPTION_KEY: LEGACY,
  LANDFLOW_ENCRYPTION_KEYS: `n1:a new passphrase for the vault,n0:${'ab'.repeat(32)}`,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
});

const ring = await import('@/lib/server/credentials/key-ring');
const { CredentialVault, credentials, parseSealedString } = await import('@/lib/server/credentials/vault');
type StoredCredential = import('@/lib/server/credentials/vault').StoredCredential;
const { rotateEncryption } = await import('@/lib/server/credentials/rotate');
const { database } = await import('@/lib/server/db');
const { disableTestAuth, enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { routePolicy } = await import('@/lib/server/auth/policy');
const rotateRoute = await import('@/app/api/settings/encryption/rotate/route');

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

/** What the code before key ids did: AES-256-GCM, SHA-256 of the passphrase, no AAD. */
function sealV1(text: string): { iv: string; tag: string; value: string } {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(LEGACY).digest(), iv);
  const value = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: value.toString('base64') };
}

/** A well-formed sealed string under a key that is not in the ring. */
function foreign(): string {
  const sealed = ring.sealWith(ring.buildKeyRing(`zz:${'cd'.repeat(32)}`, undefined), 'x', 'landflow:secret');
  return `v2.${sealed.kid}.${sealed.iv}.${sealed.tag}.${sealed.value}`;
}

const memoryBackend = (seed: StoredCredential[]) => {
  const rows = new Map(seed.map((c) => [c.id, c]));
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
    },
  };
};

const stored = (id: string, data: object): StoredCredential => ({ id, name: id, type: 'x', secretFields: [], data: sealV1(JSON.stringify(data)), createdAt: '2026-01-01', updatedAt: '2026-01-01' });

describe('key ring', () => {
  it('lists the primary first and keeps the legacy keys for old data', () => {
    expect(credentials.primaryKid).toBe('n1');
    expect(credentials.ringConfigured).toBe(true);
  });

  it('stretches a passphrase with scrypt and uses hex keys as they are', () => {
    expect(ring.keyFromText('n1', 'pass').equals(scryptSync('pass', 'landflow:kdf:v2:n1', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }))).toBe(true);
    expect(ring.keyFromText('n1', 'pass').equals(createHash('sha256').update('pass').digest())).toBe(false);
    expect(ring.keyFromText('a', 'ab'.repeat(32)).toString('hex')).toBe('ab'.repeat(32));
    expect(ring.keyFromText('a', 'same').equals(ring.keyFromText('b', 'same'))).toBe(false);
  });

  it('refuses a malformed or repeated key list', () => {
    expect(() => ring.parseKeyList('nokid')).toThrow(/kid:key/);
    expect(() => ring.parseKeyList('a:x,a:y')).toThrow(/twice/);
    expect(() => ring.parseKeyList('k0:x')).toThrow(/reserved/);
  });

  it('opens a v1 string and seals new ones as v2 with the primary kid', () => {
    const v1 = sealV1('legacy secret');
    expect(credentials.openSecret(`v1.${v1.iv}.${v1.tag}.${v1.value}`)).toBe('legacy secret');
    const sealed = credentials.sealSecret('fresh secret');
    expect(sealed.startsWith('v2.n1.')).toBe(true);
    expect(credentials.openSecret(sealed)).toBe('fresh secret');
    expect(credentials.sealSecret('fresh secret')).not.toBe(sealed);
  });

  it('binds a sealed string to its purpose', () => {
    const sealed = credentials.sealSecret('x-value', 'alerts');
    expect(credentials.openSecret(sealed, 'alerts')).toBe('x-value');
    expect(() => credentials.openSecret(sealed)).toThrow();
  });

  it('derives a different key per label with HKDF, and lists the older ones for verifying', () => {
    expect(credentials.deriveKey('a').equals(credentials.deriveKey('b'))).toBe(false);
    expect(credentials.deriveKey('a')).toHaveLength(32);
    const keys = credentials.deriveKeys('a');
    expect(keys[0]!.equals(credentials.deriveKey('a'))).toBe(true);
    // n1, n0, k0 and k0-legacy via HKDF, then the old HMAC form.
    expect(keys.length).toBe(5);
  });

  it('opens a v1 credential, seals it as v2 on rotation, and a blob moved to another id no longer opens', () => {
    const { rows, backend } = memoryBackend([stored('cred_a', { token: 'aaa' }), stored('cred_b', { token: 'bbb' })]);
    const vault = new CredentialVault({ dir: dataDir, backend });
    expect(vault.rotateCredentials()).toEqual({ resealed: 2, current: 0, failed: [] });
    expect(rows.get('cred_a')!.data).toMatchObject({ v: 2, kid: 'n1' });
    // Idempotent.
    expect(vault.rotateCredentials()).toEqual({ resealed: 0, current: 2, failed: [] });
    // A blob sealed for a under an older key, copied onto b: rotation opens it with b's AAD and fails; a's own id opens it.
    const old = ring.buildKeyRing(`n0:${'ab'.repeat(32)}`, undefined);
    const blob = ring.sealWith(old, JSON.stringify({ token: 'aaa' }), 'landflow:credential:cred_a');
    const swapped = memoryBackend([{ ...stored('cred_b', {}), data: blob }, { ...stored('cred_a', {}), data: blob }]);
    const moved = new CredentialVault({ dir: dataDir, backend: swapped.backend }).rotateCredentials();
    expect(moved).toEqual({ resealed: 1, current: 0, failed: ['cred_b'] });
  });

  it('rotation re-seals every other store, skips what is current and reports what it can not open', () => {
    const db = database();
    const v1 = sealV1('smtp-password');
    const now = new Date().toISOString();
    db.upsert('alert_channels', { id: 'ch1', name: 'mail', kind: 'email', created_at: now, updated_at: now, data: JSON.stringify({ config: { password: `v1.${v1.iv}.${v1.tag}.${v1.value}`, host: 'smtp.test' } }) });
    db.upsert('alert_channels', { id: 'ch2', name: 'broken', kind: 'email', created_at: now, updated_at: now, data: JSON.stringify({ config: { password: foreign() } }) });
    // Strings that only look like a sealed one (a four-part version) are left alone and not counted.
    db.upsert('alert_channels', { id: 'ch3', name: 'version', kind: 'email', created_at: now, updated_at: now, data: JSON.stringify({ config: { note: 'v1.2.3.4' } }) });
    const result = rotateEncryption();
    expect(result.primary).toBe('n1');
    expect(result.stores.alert_channels).toBe(1);
    expect(result.failed).toEqual(['alert_channels:ch2']);
    const row = db.get<{ data: string }>('SELECT data FROM alert_channels WHERE id = ?', 'ch1')!;
    const config = JSON.parse(row.data).config as { password: string; host: string };
    expect(config.host).toBe('smtp.test');
    expect(parseSealedString(config.password)).toMatchObject({ v: 2, kid: 'n1' });
    expect(credentials.openSecret(config.password)).toBe('smtp-password');
    const again = rotateEncryption();
    expect(again.resealed).toBe(0);
    expect(again.failed).toEqual(['alert_channels:ch2']);
  });
});

describe('rotation writes through the stores that cache', () => {
  /** The ring the first test of this file rotated from: sealed under n0, as a host before the rotation would have. */
  const underN0 = (text: string) => {
    const sealed = ring.sealWith(ring.buildKeyRing(`n0:${'ab'.repeat(32)}`, undefined), text, 'landflow:secret');
    return `v2.${sealed.kid}.${sealed.iv}.${sealed.tag}.${sealed.value}`;
  };

  it('a deployed agent saved after rotation keeps the re-sealed kagent token', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const agent = agentStore.create({ name: 'Rotating' });
    const old = underN0('kagent-token');
    agentStore.rewrite({ ...agent, kagent: { ...(agent.kagent ?? {}), name: 'a', token: old } as never });
    expect(rotateEncryption().stores.agent_definitions).toBe(1);
    // The store's own next save (no new secret) writes from its copy: that copy has to be the re-sealed one.
    agentStore.saveDraft(agent.id, { name: 'Rotating again' });
    const token = (agentStore.get(agent.id)?.kagent as { token: string } | undefined)?.token ?? '';
    expect(parseSealedString(token)).toMatchObject({ v: 2, kid: 'n1' });
    expect(credentials.openSecret(token)).toBe('kagent-token');
  });

  it('a settings row and a config file change their stamp, so another process re-reads them', () => {
    const db = database();
    const old = underN0('signing');
    db.upsert('settings', { key: 'saml-test', value: JSON.stringify({ privateKey: old }) });
    db.upsert('config_files', { name: 'audit-anchoring.json', data: JSON.stringify({ s3: { secretAccessKey: old } }), updated_at: '2026-01-01T00:00:00.000Z', updated_by: 'x' });
    const result = rotateEncryption();
    expect(result.stores.settings).toBe(1);
    expect(result.stores.config_files).toBe(1);
    const row = db.get<{ data: string; updated_at: string }>('SELECT data, updated_at FROM config_files WHERE name = ?', 'audit-anchoring.json')!;
    expect(row.updated_at).not.toBe('2026-01-01T00:00:00.000Z');
    expect(parseSealedString(JSON.parse(row.data).s3.secretAccessKey)).toMatchObject({ kid: 'n1' });
  });

  it('a malformed key list names the entry by position, not by its first characters', () => {
    const key = 'ab'.repeat(32);
    expect(() => ring.parseKeyList(key)).toThrow(/entry 1 is not kid:key/);
    expect(() => ring.parseKeyList(key)).not.toThrow(new RegExp(key.slice(0, 12)));
  });
});

describe('POST /api/settings/encryption/rotate', () => {
  it('is session-only and admin by policy, and the owner may run it', async () => {
    expect(routePolicy('POST', '/api/settings/encryption/rotate')).toMatchObject({ action: 'settings:manage', sessionOnly: true });
    const response = await rotateRoute.POST(new Request('http://localhost/api/settings/encryption/rotate', { method: 'POST' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { primary: string; done: boolean };
    expect(body.primary).toBe('n1');
    // ch2's broken value is still there from the test above.
    expect(body.done).toBe(false);
  });

  it('refuses an admin who is not the owner', async () => {
    enableTestAuth({ ...TEST_OWNER, id: 'usr_admin', role: 'admin' });
    try {
      const response = await rotateRoute.POST(new Request('http://localhost/api/settings/encryption/rotate', { method: 'POST' }));
      expect(response.status).toBe(403);
    } finally {
      enableTestAuth();
    }
  });

  it('refuses without a session', async () => {
    disableTestAuth();
    try {
      const response = await rotateRoute.POST(new Request('http://localhost/api/settings/encryption/rotate', { method: 'POST' }));
      expect([401, 403]).toContain(response.status);
    } finally {
      enableTestAuth();
    }
  });
});
