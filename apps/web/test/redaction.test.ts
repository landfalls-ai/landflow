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
  it.each(['privateKey', 'private_key', 'passphrase', 'signature', 'credentials', 'connectionString', 'connection_string', 'dsn', 'sentryDsn', 'sessionToken', 'session_secret', 'sessionCookie', 'password', 'apiKey', 'secretId', 'secret_id', 'client_secret_id', 'vault.secret_id', 'tokenValid', 'passwordInvalid'])(
    'redacts %s',
    (key) => expect(SECRET_KEY.test(key)).toBe(true),
  );
  it.each(['sessionId', 'session', 'signatureAlgorithm', 'tokenUrl', 'tokenType', 'credentialsId', 'credentialCount', 'hostname', 'publicKey', 'dsnHost', 'landflow.api_key.id', 'apiKeyId', 'enduser.id', 'landflow.request_id'])('keeps %s', (key) =>
    expect(SECRET_KEY.test(key)).toBe(false),
  );
  it('keeps a count under a secret-looking key in audit details, drops a string there', async () => {
    const { cleanDetails } = await import('@/lib/server/audit');
    expect(cleanDetails({ credentials: 3, users: 2, allUsers: false })).toEqual({ credentials: 3, users: 2, allUsers: false });
    expect(cleanDetails({ credentials: 'x', password: 'hunter2', note: 'ok' })).toEqual({ note: 'ok' });
  });
  it('redacts values by key in nested records and keeps plain session ids', () => {
    expect(redact({ privateKey: 'abc', nested: { dsn: 'https://k@o.ingest.sentry.io/1' }, sessionId: 'sess_1' })).toEqual({ privateKey: '[redacted]', nested: { dsn: '[redacted]' }, sessionId: 'sess_1' });
  });
});

describe('secret-shaped values', () => {
  it('scrubs provider keys an upstream error quotes (sk-, GitHub, Slack) and keeps look-alikes', () => {
    const fake = (prefix: string) => `${prefix}${'Ab1'.repeat(10)}`; // built at run time: no key-shaped literal in the repo
    for (const prefix of ['sk-', 'sk-proj-', 'sk-ant-api03-', 'ghp_', 'github_pat_11', 'xoxb-12-']) {
      expect(redactPatterns(`upstream said: invalid key ${fake(prefix)} (401)`)).toBe('upstream said: invalid key [redacted] (401)');
    }
    for (const text of ['task-123', 'the risk-assessment doc', 'sk-short', 'xoxo hugs']) expect(redactPatterns(text)).toBe(text);
  });
  it('scrubs Bearer tokens, lf_ keys, URL userinfo and PEM blocks', () => {
    expect(redactPatterns('401 from upstream: Authorization: Bearer abc.def-ghi_123456')).toBe('401 from upstream: Authorization: Bearer [redacted]');
    expect(redactPatterns('key lf_0123456789abcdefABCD used')).toBe('key [redacted] used');
    expect(redactPatterns('connect postgres://app:hunter2pw@db.internal:5432/x failed')).toBe('connect postgres://[redacted]@db.internal:5432/x failed');
    expect(redactPatterns('x //user:p@ss@host/y')).toBe('x //[redacted]@host/y');
    expect(redactPatterns('k\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----\nafter')).toBe('k\n[redacted]\nafter');
  });
  it('leaves ordinary text alone (no false positives)', () => {
    for (const text of ['mail me at a@b.com', 'https://example.com/a/b?x=1', 'the bearer of bad news', 'Bearer authentication failed', 'the bearer certificate', 'http://localhost:3000?email=a@b.com', 'lf_short', 'host:8080//path', 'public -----BEGIN PUBLIC KEY-----']) {
      expect(redactPatterns(text)).toBe(text);
    }
  });
  it('applies to messages, fields and error stacks in a log line', () => {
    lines.length = 0;
    const error = new Error('upstream said Bearer abcd1efghijkl and https://u:p4ssw0rd@h.example/x');
    logger.error('call failed: Bearer zzzz1zzzzzzz', { error, detail: { url: 'redis://:secretpw@cache:6379' } });
    const out = lines.join('');
    for (const leaked of ['zzzz1zzzzzzz', 'abcd1efghijkl', 'p4ssw0rd', 'secretpw']) expect(out).not.toContain(leaked);
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

  it('leaves a weak password out, so unrelated node output is not rewritten', () => {
    const credential = credentials.create({ name: 'Weak', type: 'core.httpBasicAuth', data: { user: 'app', password: 'postgres' } });
    credentials.dataFor({ id: credential.id, name: credential.name }, 'core.httpBasicAuth');
    expect(redactValue({ db: 'postgres', note: 'changeme postgres' })).toEqual({ db: 'postgres', note: 'changeme postgres' });
  });
});

describe('span attributes', () => {
  it('keeps request, user and API key ids and redacts secret-named attributes', async () => {
    const { TracerProvider } = await import('@opentelemetry/sdk-trace');
    const { LandflowSpanProcessor } = await import('@/lib/server/telemetry/processors');
    const ended: Array<{ attributes: Record<string, unknown> }> = [];
    const collect = { onStart() {}, onEnd: (s: { attributes: Record<string, unknown> }) => void ended.push(s), forceFlush: async () => {}, shutdown: async () => {} };
    const provider = new TracerProvider({ spanProcessors: [new LandflowSpanProcessor(), collect] });
    const span = provider.getTracer('test').startSpan('request');
    span.setAttributes({ 'landflow.api_key.id': 'key_1', 'enduser.id': 'usr_1', 'landflow.request_id': 'req_1', 'http.request.header.authorization': 'Bearer x' });
    span.end();
    const attributes = ended[0].attributes;
    expect(attributes).toMatchObject({ 'landflow.api_key.id': 'key_1', 'enduser.id': 'usr_1', 'landflow.request_id': 'req_1', 'http.request.header.authorization': '[redacted]' });
  });
});
