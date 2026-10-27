/**
 * `landflow audit verify/head/key` against a real host: the chain verifies (exit 0), a head is signed and fetched, checked
 * offline against the pinned key (and refused for a wrong key, a tampered payload, or a bad file), and a tampered log
 * exits 9 with the report in `error.details`. The JSON shapes are the contract (README: JSON output).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;
const dir = mkdtempSync(join(tmpdir(), 'landflow-cli-audit-'));

beforeAll(async () => {
  host = await startHost();
  cli = cliFor(host);
  const { recordAudit } = await web('lib/server/audit');
  for (let i = 0; i < 3; i++) recordAudit({ action: 'audit.verify', outcome: 'success', target: { type: 'audit_log' }, summary: `event ${i}` });
});

afterAll(async () => {
  await host?.close();
});

describe('audit', () => {
  it('verify: an intact chain exits 0', async () => {
    const result = await cli(['audit', 'verify', '--json']);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, problems: [] });
    expect(result.json.checked).toBeGreaterThan(0);
    expect((await cli(['audit', 'verify'])).stdout).toMatch(/hash chain is intact/);
  });

  it('head and key: nothing signed yet is not_found; then sign, fetch and verify offline', async () => {
    expect((await cli(['audit', 'head', '--json'])).code).toBe(3);
    const { signHead } = await web('lib/server/audit/signing');
    await signHead({});

    const file = join(dir, 'head.json');
    const keyFile = join(dir, 'key.pem');
    const head = await cli(['audit', 'head', '--out', file, '--json']);
    expect(head.code).toBe(0);
    expect(head.json.head).toMatchObject({ format: 'landflow.audit.head/1', algorithm: 'Ed25519' });
    expect((await cli(['audit', 'key', '--out', keyFile, '--json'])).json.current.keyId).toBe(head.json.head.keyId);

    const pinned = await cli(['audit', 'verify', '--head', file, '--public-key', keyFile, '--json']);
    expect(pinned.code).toBe(0);
    expect(pinned.json).toMatchObject({ ok: true, verified: true, pinned: true, keyId: head.json.head.keyId });
    const unpinned = await cli(['audit', 'verify', '--head', file]);
    expect(unpinned.stdout).toMatch(/Signature valid/);
    expect(unpinned.stdout).toMatch(/does not show who signed it/);
    // The whole `audit head --json` document is accepted too.
    writeFileSync(join(dir, 'view.json'), JSON.stringify(head.json));
    expect((await cli(['audit', 'verify', '--head', join(dir, 'view.json'), '--public-key', keyFile])).code).toBe(0);
  });

  it('verify --head refuses a tampered payload, another key, and a bad file', async () => {
    const file = join(dir, 'head.json');
    const keyFile = join(dir, 'key.pem');
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    const payload = JSON.parse(envelope.payload);
    writeFileSync(join(dir, 'tampered.json'), JSON.stringify({ ...envelope, payload: JSON.stringify({ ...payload, seq: payload.seq + 1 }) }));
    const tampered = await cli(['audit', 'verify', '--head', join(dir, 'tampered.json'), '--public-key', keyFile, '--json']);
    expect(tampered.code).toBe(9);
    expect(tampered.json).toMatchObject({ ok: false, error: { code: 'integrity_failed', message: expect.stringMatching(/does not match/) } });

    const { generateKeyPairSync } = await import('node:crypto');
    writeFileSync(join(dir, 'other.pem'), generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
    const wrongKey = await cli(['audit', 'verify', '--head', file, '--public-key', join(dir, 'other.pem'), '--json']);
    expect(wrongKey.code).toBe(9);
    expect(wrongKey.json.error.message).toMatch(/not the key you trust/);

    expect((await cli(['audit', 'verify', '--head', join(dir, 'missing.json'), '--json'])).code).toBe(1);
    expect((await cli(['audit', 'verify', '--public-key', keyFile, '--json'])).code).toBe(2);
  });

  it('verify: a tampered log exits 9 with the report', async () => {
    const { auditDb } = await web('lib/server/audit/chain');
    const sqlite = auditDb().sqlite;
    const row = sqlite.prepare('SELECT chain_seq AS seq FROM audit_events WHERE chain_seq IS NOT NULL ORDER BY chain_seq LIMIT 1 OFFSET 1').get() as { seq: number };
    sqlite.prepare("UPDATE audit_events SET summary = 'rewritten' WHERE chain_seq = ?").run(row.seq);
    const result = await cli(['audit', 'verify', '--json']);
    expect(result.code).toBe(9);
    expect(result.json).toMatchObject({ ok: false, error: { code: 'integrity_failed', details: { ok: false, brokenAt: { seq: row.seq } } } });
  });
});
