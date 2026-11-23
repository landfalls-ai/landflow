/**
 * The encryption key file (credentials/vault.ts loadKey): created once, atomically, so vaults opened on the same data
 * directory share one key, the file is never seen half-written, and no temporary file is left behind.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const previousKey = process.env.LANDFLOW_ENCRYPTION_KEY;
delete process.env.LANDFLOW_ENCRYPTION_KEY;
const { CredentialVault } = await import('@/lib/server/credentials/vault');

afterAll(() => {
  if (previousKey !== undefined) process.env.LANDFLOW_ENCRYPTION_KEY = previousKey;
});

describe('encryption key file', () => {
  it('is created once with mode 0600 and shared by every vault on the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-vault-key-'));
    const first = new CredentialVault({ dir });
    const key = readFileSync(join(dir, 'encryption.key'), 'utf8');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, 'encryption.key')).mode & 0o777).toBe(0o600);
    const second = new CredentialVault({ dir });
    expect(readFileSync(join(dir, 'encryption.key'), 'utf8')).toBe(key);
    // Both seal with the same key: what one seals, the other opens.
    expect(second.openSecret(first.sealSecret('hello'))).toBe('hello');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
