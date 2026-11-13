/**
 * Wider redaction: key names (private keys, passphrases, signatures, connection strings, DSNs, whole-key `credentials`,
 * session tokens, but not agent session ids), secret-shaped values in messages and stacks, and credential values
 * that a node was handed (scrubbed like `$secrets` values).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

Object.assign(process.env, {  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-redact-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { telemetryConfig } = await import('@/lib/server/telemetry/config');
// The setup file loaded the config with the suite's level (error): lines under it would not be written.
telemetryConfig.logLevel = 'info';
const { logger, redact, writeRecord } = await import('@/lib/server/telemetry/logger');
const { SECRET_KEY } = await import('@/lib/server/telemetry/config');
const { redactPatterns, redactValue, forgetSecretValues } = await import('@/lib/server/secrets/redact');
registry.registerBuiltin(corePlugin);

const lines: string[] = [];
const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
  lines.push(String(chunk));
  return true;
});
afterAll(() => {
  spy.mockRestore();
  forgetSecretValues();
});

describe('secret key names', () => {
  it.each(['privateKey', 'private_key', 'passphrase', 'signature', 'credentials', 'connectionString', 'connection_string', 'dsn', 'sentryDsn', 'sessionToken', 'session_secret', 'sessionCookie', 'password', 'apiKey'])(
    'redacts %s',
    (key) => expect(SECRET_KEY.test(key)).toBe(true),
  );
  it.each(['sessionId', 'session', 'signatureAlgorithm', 'tokenUrl', 'tokenType', 'credentialsId', 'credentialCount', 'hostname', 'publicKey', 'dsnHost'])('keeps %s', (key) =>
    expect(SECRET_KEY.test(key)).toBe(false),
  );
  it('redacts values by key in nested records and keeps plain session ids', () => {
    expect(redact({ privateKey: 'abc', nested: { dsn: 'https://k@o.ingest.sentry.io/1' }, sessionId: 'sess_1' })).toEqual({ privateKey: '[redacted]', nested: { dsn: '[redacted]' }, sessionId: 'sess_1' });
  });
});

describe('secret-shaped values', () => {
  it('scrubs Bearer tokens, lf_ keys, URL userinfo and PEM blocks', () => {
    expect(redactPatterns('401 from upstream: Authorization: Bearer abc.def-ghi_123456')).toBe('401 from upstream: Authorization: Bearer [redacted]');
    expect(redactPatterns('key lf_0123456789abcdefABCD used')).toBe('key [redacted] used');
    expect(redactPatterns('connect postgres://app:hunter2pw@db.internal:5432/x failed')).toBe('connect postgres://[redacted]@db.internal:5432/x failed');
    expect(redactPatterns('k\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----\nafter')).toBe('k\n[redacted]\nafter');
  });
  it('leaves ordinary text alone (no false positives)', () => {
    for (const text of ['mail me at a@b.com', 'https://example.com/a/b?x=1', 'the bearer of bad news', 'lf_short', 'host:8080//path', 'public -----BEGIN PUBLIC KEY-----']) {
      expect(redactPatterns(text)).toBe(text);
    }
  });
  it('applies to messages, fields and error stacks in a log line', () => {
    lines.length = 0;
    const error = new Error('upstream said Bearer abcdefghijkl and https://u:p4ssw0rd@h.example/x');
    logger.error('call failed: Bearer zzzzzzzzzzzz', { error, detail: { url: 'redis://:secretpw@cache:6379' } });
    const out = lines.join('');
    for (const leaked of ['zzzzzzzzzzzz', 'abcdefghijkl', 'p4ssw0rd', 'secretpw']) expect(out).not.toContain(leaked);
    expect(out).toContain('[redacted]');
    expect(out).toContain('"exception.type":"Error"');
  });
  it('writes 10k ordinary lines quickly (the marker guards keep the scan cheap)', () => {
    const t = performance.now();
    for (let i = 0; i < 10_000; i++) writeRecord('info', 'workflow step done', { executionId: `ex_${i}`, node: 'HTTP Request', ms: i });
    expect(performance.now() - t).toBeLessThan(2_000);
  });
});

describe('credential values handed to a node', () => {
  it('are scrubbed from log lines and run data, like $secrets values', () => {
    const PASSWORD = 'Sup3r-Secret-Pw-4242';
    const credential = credentials.create({ name: 'Basic', type: 'core.httpBasicAuth', data: { user: 'app', password: PASSWORD } });
    const data = credentials.dataFor({ id: credential.id, name: credential.name }, 'core.httpBasicAuth');
    expect(data.password).toBe(PASSWORD);
    lines.length = 0;
    logger.warn(`request to upstream failed with ${PASSWORD}`, { body: { echoed: PASSWORD } });
    expect(lines.join('')).not.toContain(PASSWORD);
    expect(JSON.stringify(redactValue({ result: { echoed: `x${PASSWORD}y` } }))).not.toContain(PASSWORD);
    // The user name is not a secret field and stays readable.
    logger.info('user app logged in');
    expect(lines.join('')).toContain('user app logged in');
  });
});
