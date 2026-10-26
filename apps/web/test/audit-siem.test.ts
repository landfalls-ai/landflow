/**
 * SIEM streaming of the audit log (lib/server/audit/sinks.ts, outbox.ts, destinations.ts) against fake receivers:
 * RFC 5424 syslog over UDP, TCP (octet counting and newline framing) and TLS; HTTP JSON lines signed with HMAC; the
 * Datadog and Elasticsearch presets; Splunk HEC. Then the durable outbox: events queued per destination in the
 * event's transaction, delivered in batches, retried with backoff after a failure, "Send test event", and secrets
 * that never come back from the API. Last, mTLS: syslog over TLS and HTTPS receivers that require a client certificate
 * (throwaway CA, server and client certificates made here, lib/server/auth/x509.ts), the destination API checking and
 * sealing the client key, and "Send test event" through it.
 */
import { createHmac, createPrivateKey } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AuditDestination, AuditEvent } from '@/lib/shared/audit';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-siem-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { database } = await import('@/lib/server/db');
const audit = await import('@/lib/server/audit');
const { deliver, syslogMessage, signedHeaders, elasticBulkUrl, splunkEventUrl, SYSLOG_SD_ID } = await import('@/lib/server/audit/sinks');
const { backoffMs, drainOutbox, resetOutboxBackoff, retryDestinationNow, MAX_BACKOFF_MS } = await import('@/lib/server/audit/outbox');
const { auditDestinations } = await import('@/lib/server/audit/destinations');
const destinationsRoute = await import('@/app/api/settings/audit/destinations/route');
const destinationRoute = await import('@/app/api/settings/audit/destinations/[id]/route');
const testRoute = await import('@/app/api/settings/audit/destinations/[id]/test/route');
const settingsRoute = await import('@/app/api/settings/audit/route');
const { createCertificate } = await import('@/lib/server/auth/x509');

registry.registerBuiltin(corePlugin);

const closers: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const close of closers) await close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: audit.newAuditId(),
  at: new Date().toISOString(),
  action: 'workflow.publish',
  category: 'workflow',
  outcome: 'success',
  actor: { type: 'user', id: 'usr_1', name: 'Ada "Q" Lovelace', email: 'ada@example.com' },
  ip: '198.51.100.4',
  requestId: 'req-1',
  method: 'POST',
  route: '/api/workflows/[id]/publish',
  status: 200,
  target: { type: 'workflow', id: 'wf_1', name: 'Orders ] sync' },
  summary: 'Published a workflow: Orders — ünïcode',
  details: { versionNumber: 3 },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Fake receivers
// ---------------------------------------------------------------------------

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function httpReceiver(answer: (request: Received) => { status: number; body?: string } = () => ({ status: 200, body: '{}' })) {
  const received: Received[] = [];
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      received.push(request);
      const reply = answer(request);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body ?? '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { received, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function streamReceiver(tls?: { key: string; cert: string }) {
  const chunks: string[] = [];
  const onSocket = (socket: NodeJS.ReadableStream) => socket.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  const server = tls ? createTlsServer({ key: tls.key, cert: tls.cert }, onSocket) : createNetServer(onSocket);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { text: () => chunks.join(''), port: (server.address() as { port: number }).port };
}

/** RFC 6587 octet-counted frames. */
function octetFrames(text: string): string[] {
  const frames: string[] = [];
  let buffer = Buffer.from(text);
  while (buffer.length) {
    const space = buffer.indexOf(0x20);
    const length = Number(buffer.subarray(0, space).toString());
    frames.push(buffer.subarray(space + 1, space + 1 + length).toString('utf8'));
    buffer = buffer.subarray(space + 1 + length);
  }
  return frames;
}

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

const RFC5424 = /^<(\d+)>1 (\S+) (\S+) (\S+) (\d+) (\S+) (\[landflow@32473(?: [a-zA-Z]+="(?:[^"\\\]]|\\.)*")*\]) (.*)$/;

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

describe('syslog (RFC 5424)', () => {
  it('formats PRI, header, structured data with escapes, and the event as ASCII JSON', () => {
    const e = event();
    const message = syslogMessage(e, { facility: 13, appName: 'landflow' });
    const match = RFC5424.exec(message);
    expect(match).toBeTruthy();
    const [, pri, timestamp, , app, , msgid, sd, msg] = match!;
    expect(Number(pri)).toBe(13 * 8 + 6);
    expect(timestamp).toBe(e.at);
    expect(app).toBe('landflow');
    expect(msgid).toBe('workflow.publish');
    expect(sd).toContain(`[${SYSLOG_SD_ID} id="${e.id}" action="workflow.publish" outcome="success"`);
    expect(sd).toContain('targetId="wf_1"');
    expect(/^[\x20-\x7e]*$/.test(msg)).toBe(true);
    expect(JSON.parse(msg)).toEqual(e);
    // Failures and denials are warnings; a `]` in a value is escaped.
    expect(syslogMessage(event({ outcome: 'denied' }), { facility: 4 }).startsWith(`<${4 * 8 + 4}>1 `)).toBe(true);
    expect(syslogMessage(event({ target: { type: 'workflow', id: 'a]b"c' } }), {})).toContain('targetId="a\\]b\\"c"');
  });

  it('sends one datagram per event over UDP', async () => {
    const socket = createSocket('udp4');
    const messages: string[] = [];
    socket.on('message', (m) => messages.push(m.toString('utf8')));
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
    await deliver({ kind: 'syslog', config: { host: '127.0.0.1', port: socket.address().port, protocol: 'udp', facility: 13 } }, [event(), event({ action: 'auth.sign_in' })]);
    await until(() => messages.length === 2);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => RFC5424.test(m))).toBe(true);
  });

  it('frames messages over TCP with octet counting or newlines', async () => {
    const counted = await streamReceiver();
    await deliver({ kind: 'syslog', config: { host: '127.0.0.1', port: counted.port, protocol: 'tcp', framing: 'octet-counting' } }, [event(), event()]);
    await until(() => octetFrames(counted.text()).length === 2);
    expect(octetFrames(counted.text()).every((m) => RFC5424.test(m))).toBe(true);

    const lines = await streamReceiver();
    await deliver({ kind: 'syslog', config: { host: '127.0.0.1', port: lines.port, protocol: 'tcp', framing: 'newline' } }, [event(), event(), event()]);
    await until(() => lines.text().split('\n').filter(Boolean).length === 3);
    expect(lines.text().split('\n').filter(Boolean).every((m) => RFC5424.test(m))).toBe(true);
  });

  let openssl = '';
  try {
    openssl = execFileSync('which', ['openssl']).toString().trim();
  } catch {}

  it.skipIf(!openssl)('sends over TLS, checking the certificate against the given CA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-siem-tls-'));
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const key = readFileSync(join(dir, 'key.pem'), 'utf8');
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    const receiver = await streamReceiver({ key, cert });
    await deliver({ kind: 'syslog', config: { host: '127.0.0.1', port: receiver.port, protocol: 'tls', framing: 'octet-counting', rejectUnauthorized: true, ca: cert } }, [event()]);
    await until(() => octetFrames(receiver.text()).length === 1);
    expect(RFC5424.test(octetFrames(receiver.text())[0])).toBe(true);
    // Without the CA the self-signed certificate is refused.
    await expect(deliver({ kind: 'syslog', config: { host: '127.0.0.1', port: receiver.port, protocol: 'tls', rejectUnauthorized: true } }, [event()])).rejects.toThrow();
  });

  it('fails when nothing listens (TCP)', async () => {
    const receiver = await streamReceiver();
    const port = receiver.port;
    await closers.pop()!();
    await expect(deliver({ kind: 'syslog', config: { host: '127.0.0.1', port, protocol: 'tcp' } }, [event()])).rejects.toThrow();
  });
});

describe('HTTP sinks', () => {
  it('generic: JSON lines signed with HMAC-SHA256 over "<timestamp>.<body>"', async () => {
    const receiver = await httpReceiver();
    const events = [event(), event({ action: 'credential.use' })];
    await deliver({ kind: 'http', config: { preset: 'generic', url: `${receiver.url}/ingest`, secret: 's3cret' } }, events);
    const [request] = receiver.received;
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/x-ndjson');
    const timestamp = String(request.headers['x-landflow-timestamp']);
    expect(request.headers['x-landflow-signature']).toBe(`sha256=${createHmac('sha256', 's3cret').update(`${timestamp}.${request.body}`).digest('hex')}`);
    const lines = request.body.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((l) => l.id)).toEqual(events.map((e) => e.id));
    expect(lines[1]).toMatchObject({ eventName: 'landflow.audit.credential.use', action: 'credential.use' });
    expect(signedHeaders(undefined, 'x')).toEqual({});
  });

  it('generic: a non-2xx answer fails the batch with the status', async () => {
    const receiver = await httpReceiver(() => ({ status: 503, body: 'busy' }));
    await expect(deliver({ kind: 'http', config: { preset: 'generic', url: receiver.url } }, [event()])).rejects.toThrow(/HTTP 503: busy/);
  });

  it('Datadog: a JSON array with DD-API-KEY', async () => {
    const receiver = await httpReceiver(() => ({ status: 202 }));
    await deliver({ kind: 'http', config: { preset: 'datadog', url: `${receiver.url}/api/v2/logs`, apiKey: 'dd-key', tags: 'env:test' } }, [event()]);
    const [request] = receiver.received;
    expect(request.url).toBe('/api/v2/logs');
    expect(request.headers['dd-api-key']).toBe('dd-key');
    const [log] = JSON.parse(request.body);
    expect(log).toMatchObject({ ddsource: 'landflow', ddtags: 'env:test', message: 'Published a workflow: Orders — ünïcode', evt: { name: 'landflow.audit.workflow.publish', outcome: 'success' }, usr: { id: 'usr_1' }, network: { client: { ip: '198.51.100.4' } } });
  });

  it('Elasticsearch: bulk create actions with the event id, ApiKey auth; 409s count as delivered, other item errors fail', async () => {
    let mode: 'ok' | 'conflict' | 'error' = 'ok';
    const receiver = await httpReceiver((request) => {
      const count = request.body.trim().split('\n').length / 2;
      const status = (i: number) => (mode === 'ok' ? 201 : mode === 'conflict' && i === 0 ? 409 : mode === 'error' && i === 0 ? 400 : 201);
      const items = Array.from({ length: count }, (_, i) => ({ create: { status: status(i), ...(status(i) >= 300 && { error: { type: 'mapper_parsing_exception', reason: 'bad field' } }) } }));
      return { status: 200, body: JSON.stringify({ errors: mode !== 'ok', items }) };
    });
    const events = [event(), event()];
    await deliver({ kind: 'http', config: { preset: 'elastic', url: receiver.url, index: 'landflow-audit', apiKey: 'es-key' } }, events);
    const [request] = receiver.received;
    expect(request.url).toBe('/_bulk');
    expect(request.headers.authorization).toBe('ApiKey es-key');
    const lines = request.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ create: { _index: 'landflow-audit', _id: events[0].id } });
    expect(lines[1]).toMatchObject({ '@timestamp': events[0].at, event: { action: 'workflow.publish', outcome: 'success' }, user: { id: 'usr_1' }, client: { ip: '198.51.100.4' } });
    mode = 'conflict';
    await deliver({ kind: 'http', config: { preset: 'elastic', url: receiver.url, index: 'landflow-audit' } }, events);
    mode = 'error';
    await expect(deliver({ kind: 'http', config: { preset: 'elastic', url: receiver.url, index: 'landflow-audit' } }, events)).rejects.toThrow(/refused 1 of 2 events: mapper_parsing_exception/);
    expect(elasticBulkUrl('https://es.example.com/')).toBe('https://es.example.com/_bulk');
    expect(elasticBulkUrl('https://es.example.com/custom/_bulk')).toBe('https://es.example.com/custom/_bulk');
  });

  it('Splunk HEC: /services/collector/event with the HEC token, one event object per audit event', async () => {
    const receiver = await httpReceiver(() => ({ status: 200, body: '{"text":"Success","code":0}' }));
    const events = [event(), event({ action: 'auth.sign_in' })];
    await deliver({ kind: 'splunk', config: { url: receiver.url, token: 'hec-token', index: 'main', source: 'landflow', sourcetype: 'landflow:audit' } }, events);
    const [request] = receiver.received;
    expect(request.url).toBe('/services/collector/event');
    expect(request.headers.authorization).toBe('Splunk hec-token');
    const objects = request.body.split('\n').map((l) => JSON.parse(l));
    expect(objects).toHaveLength(2);
    expect(objects[0]).toMatchObject({ index: 'main', source: 'landflow', sourcetype: 'landflow:audit', event: { id: events[0].id, action: 'workflow.publish' } });
    expect(objects[0].time).toBeCloseTo(Date.parse(events[0].at) / 1000, 3);
    expect(splunkEventUrl('https://splunk:8088/services/collector')).toBe('https://splunk:8088/services/collector');
    const refusing = await httpReceiver(() => ({ status: 403, body: '{"text":"Invalid token","code":4}' }));
    await expect(deliver({ kind: 'splunk', config: { url: refusing.url, token: 'bad' } }, events)).rejects.toThrow(/Splunk HEC answered HTTP 403/);
  });
});

// ---------------------------------------------------------------------------
// Outbox and settings
// ---------------------------------------------------------------------------

const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://siem.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const outboxRows = (destinationId: string) => database().all<{ event_id: string; attempts: number; next_at: string; last_error: string | null }>('SELECT * FROM audit_outbox WHERE destination_id = ?', destinationId);

describe('outbox', () => {
  it('backs off exponentially, capped at five minutes', () => {
    expect(backoffMs(1, 0.5)).toBe(2_000);
    expect(backoffMs(2, 0.5)).toBe(4_000);
    expect(backoffMs(5, 0.5)).toBe(32_000);
    expect(backoffMs(30, 0.5)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(30, 1)).toBe(MAX_BACKOFF_MS);
  });

  it('queues events for enabled destinations, retries a failed batch later, and delivers in order once it recovers', async () => {
    let failing = true;
    const receiver = await httpReceiver(() => (failing ? { status: 500, body: 'down' } : { status: 200 }));
    const created = await destinationsRoute.POST(req('POST', '/api/settings/audit/destinations', { name: 'Collector', kind: 'http', config: { preset: 'generic', url: receiver.url, secret: 'hmac-secret' } }));
    expect(created.status).toBe(201);
    const { destination } = (await created.json()) as { destination: AuditDestination };
    // The secret never comes back; `secretsSet` says it is there.
    expect(destination.config).not.toHaveProperty('secret');
    expect(destination.secretsSet).toEqual(['secret']);
    expect(JSON.stringify(database().all('SELECT data FROM audit_destinations'))).not.toContain('hmac-secret');

    const first = audit.recordAudit({ action: 'workflow.update', summary: 'first' })!;
    const second = audit.recordAudit({ action: 'workflow.update', summary: 'second' })!;
    const queued = outboxRows(destination.id).map((r) => r.event_id);
    expect(queued).toEqual(expect.arrayContaining([first.id, second.id]));

    expect(await drainOutbox()).toBe(0);
    const after = outboxRows(destination.id);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after.every((r) => r.attempts === 1 && r.last_error?.includes('HTTP 500') && Date.parse(r.next_at) > Date.now())).toBe(true);
    expect(auditDestinations.get(destination.id)).toMatchObject({ lastDelivery: { ok: false } });
    // Backing off: another pass doesn't call the receiver.
    const calls = receiver.received.length;
    await drainOutbox();
    expect(receiver.received.length).toBe(calls);

    failing = false;
    expect(retryDestinationNow(destination.id)).toBeGreaterThanOrEqual(2);
    const delivered = await drainOutbox();
    expect(delivered).toBeGreaterThanOrEqual(2);
    expect(outboxRows(destination.id)).toHaveLength(0);
    const ids = receiver.received.at(-1)!.body.trim().split('\n').map((l) => JSON.parse(l).id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    expect(auditDestinations.get(destination.id)).toMatchObject({ pending: 0, lastDelivery: { ok: true } });

    // Disabled: new events aren't queued for it.
    await destinationRoute.PATCH(req('PATCH', `/api/settings/audit/destinations/${destination.id}`, { enabled: false }), params({ id: destination.id }));
    audit.recordAudit({ action: 'workflow.update', summary: 'third' });
    expect(outboxRows(destination.id)).toHaveLength(0);
    // PATCH without the secret keeps it.
    await destinationRoute.PATCH(req('PATCH', `/api/settings/audit/destinations/${destination.id}`, { enabled: true, config: { preset: 'generic', url: receiver.url } }), params({ id: destination.id }));
    expect(auditDestinations.forSending(destination.id)?.config.secret).toBe('hmac-secret');
  });

  it('sends a test event straight away and reports the result', async () => {
    const receiver = await httpReceiver();
    const destination = auditDestinations.create({ name: 'Splunk', kind: 'splunk', enabled: true, config: { url: receiver.url, token: 'tok' } });
    const response = await testRoute.POST(req('POST', `/api/settings/audit/destinations/${destination.id}/test`), params({ id: destination.id }));
    const result = (await response.json()) as { ok: boolean; message: string };
    expect(result.ok).toBe(true);
    expect(JSON.parse(receiver.received[0].body).event).toMatchObject({ action: 'audit.test', details: { test: true } });

    const broken = auditDestinations.create({ name: 'Nowhere', kind: 'syslog', enabled: true, config: { host: '127.0.0.1', port: 1, protocol: 'tcp' } });
    const failed = (await (await testRoute.POST(req('POST', `/api/settings/audit/destinations/${broken.id}/test`), params({ id: broken.id }))).json()) as { ok: boolean; message: string };
    expect(failed.ok).toBe(false);
    resetOutboxBackoff();
  });

  it('validates destinations and drops their outbox when removed', async () => {
    expect((await destinationsRoute.POST(req('POST', '/api/settings/audit/destinations', { name: 'x', kind: 'syslog', config: {} }))).status).toBe(400);
    expect((await destinationsRoute.POST(req('POST', '/api/settings/audit/destinations', { name: 'x', kind: 'splunk', config: { url: 'https://splunk:8088' } }))).status).toBe(400);
    expect((await destinationsRoute.POST(req('POST', '/api/settings/audit/destinations', { name: 'x', kind: 'http', config: { preset: 'elastic', url: 'https://es:9200' } }))).status).toBe(400);
    const destination = auditDestinations.create({ name: 'Doomed', kind: 'syslog', enabled: true, config: { host: '127.0.0.1', port: 1 } });
    audit.recordAudit({ action: 'workflow.update' });
    expect(outboxRows(destination.id).length).toBe(1);
    await destinationRoute.DELETE(req('DELETE', `/api/settings/audit/destinations/${destination.id}`), params({ id: destination.id }));
    expect(outboxRows(destination.id)).toHaveLength(0);
    const view = (await (await settingsRoute.GET(req('GET', '/api/settings/audit'))).json()) as { destinations: AuditDestination[]; stored: number; settings: { retentionDays: number } };
    expect(view.destinations.some((d) => d.id === destination.id)).toBe(false);
    expect(view.stored).toBeGreaterThan(0);
    expect(view.settings.retentionDays).toBe(365);
  });
});

// ---------------------------------------------------------------------------
// mTLS: receivers that require a client certificate
// ---------------------------------------------------------------------------

describe('mTLS (client certificates)', () => {
  const ca = createCertificate({ commonName: 'TMP SIEM test CA', ca: true });
  const server = createCertificate({ commonName: 'localhost', issuer: ca, altNames: ['127.0.0.1', 'localhost'], usage: ['server'] });
  const client = createCertificate({ commonName: 'landflow-audit-client', organization: 'Landflow', issuer: ca, usage: ['client'] });
  const rogueCa = createCertificate({ commonName: 'TMP rogue CA', ca: true });
  const rogue = createCertificate({ commonName: 'rogue-client', issuer: rogueCa, usage: ['client'] });
  const encryptedKey = createPrivateKey(client.key).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'key-passphrase' }) as string;
  const peerName = (socket: TLSSocket) => socket.getPeerCertificate()?.subject?.CN as string | undefined;

  /** Syslog over TLS that only takes clients with a certificate from `ca`. */
  async function mtlsSyslogReceiver() {
    const chunks: string[] = [];
    const peers: Array<string | undefined> = [];
    const tlsServer = createTlsServer({ key: server.key, cert: server.cert, ca: [ca.cert], requestCert: true, rejectUnauthorized: true }, (socket) => {
      peers.push(peerName(socket));
      socket.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    });
    tlsServer.on('tlsClientError', () => {});
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => tlsServer.close(() => resolve())));
    return { text: () => chunks.join(''), peers, port: (tlsServer.address() as { port: number }).port };
  }

  /** An HTTPS endpoint that only takes clients with a certificate from `ca`. */
  async function mtlsHttpsReceiver() {
    const received: Array<Received & { peer?: string }> = [];
    const httpsServer = createHttpsServer({ key: server.key, cert: server.cert, ca: [ca.cert], requestCert: true, rejectUnauthorized: true }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), peer: peerName(req.socket as TLSSocket) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    httpsServer.on('tlsClientError', () => {});
    await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => httpsServer.close(() => resolve())));
    return { received, url: `https://127.0.0.1:${(httpsServer.address() as { port: number }).port}` };
  }

  it('syslog over TLS presents the client certificate; without one, or with an untrusted one, the receiver refuses', async () => {
    const receiver = await mtlsSyslogReceiver();
    const base = { host: '127.0.0.1', port: receiver.port, protocol: 'tls' as const, framing: 'octet-counting' as const, ca: ca.cert };
    await deliver({ kind: 'syslog', config: { ...base, clientCert: client.cert, clientKey: client.key } }, [event()]);
    await until(() => octetFrames(receiver.text()).length === 1);
    expect(RFC5424.test(octetFrames(receiver.text())[0])).toBe(true);
    expect(receiver.peers).toEqual(['landflow-audit-client']);
    // An encrypted key with its passphrase.
    await deliver({ kind: 'syslog', config: { ...base, clientCert: client.cert, clientKey: encryptedKey, clientKeyPassphrase: 'key-passphrase' } }, [event()]);
    await until(() => octetFrames(receiver.text()).length === 2);

    await expect(deliver({ kind: 'syslog', config: base }, [event()])).rejects.toThrow(/wants a client certificate \(mTLS\)/);
    await expect(deliver({ kind: 'syslog', config: { ...base, clientCert: rogue.cert, clientKey: rogue.key } }, [event()])).rejects.toThrow(/client certificate/);
    expect(octetFrames(receiver.text())).toHaveLength(2);
  });

  it('HTTPS destinations (JSON lines, Datadog, Elasticsearch, Splunk HEC) present it too', async () => {
    const receiver = await mtlsHttpsReceiver();
    const tls = { ca: ca.cert, clientCert: client.cert, clientKey: client.key };
    await deliver({ kind: 'http', config: { preset: 'generic', url: receiver.url, ...tls } }, [event()]);
    await deliver({ kind: 'http', config: { preset: 'datadog', url: receiver.url, apiKey: 'dd', ...tls } }, [event()]);
    await deliver({ kind: 'splunk', config: { url: receiver.url, token: 'tok', ...tls } }, [event()]);
    expect(receiver.received.map((r) => [r.url, r.peer])).toEqual([
      ['/', 'landflow-audit-client'],
      ['/', 'landflow-audit-client'],
      ['/services/collector/event', 'landflow-audit-client'],
    ]);
    await expect(deliver({ kind: 'http', config: { preset: 'generic', url: receiver.url, ca: ca.cert } }, [event()])).rejects.toThrow(/wants a client certificate|client certificate/);
    expect(receiver.received).toHaveLength(3);
  });

  it('the API checks the certificate and key, seals the key, keeps it on PATCH, and "Send test event" uses it', async () => {
    const receiver = await mtlsSyslogReceiver();
    const config = { host: '127.0.0.1', port: receiver.port, protocol: 'tls', ca: ca.cert, clientCert: client.cert };
    const create = (extra: Record<string, unknown>) => destinationsRoute.POST(req('POST', '/api/settings/audit/destinations', { name: 'TMP mTLS syslog', kind: 'syslog', config: { ...config, ...extra } }));

    const mismatch = await create({ clientKey: rogue.key });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toBe('Client certificate: The private key doesn’t belong to the certificate');
    expect((await (await create({})).json()).error).toBe('Enter the client certificate’s private key');
    expect((await (await create({ clientKey: encryptedKey })).json()).error).toBe('Client certificate: The private key is encrypted: enter its passphrase');
    expect((await (await create({ clientKey: client.key, ca: 'not a certificate' })).json()).error).toMatch(/CA certificate isn’t a PEM certificate/);

    const created = await create({ clientKey: encryptedKey, clientKeyPassphrase: 'key-passphrase' });
    expect(created.status).toBe(201);
    const { destination } = (await created.json()) as { destination: AuditDestination };
    expect(destination.config.clientCert).toContain('BEGIN CERTIFICATE');
    expect(destination.config).not.toHaveProperty('clientKey');
    expect(destination.config).not.toHaveProperty('clientKeyPassphrase');
    expect(destination.secretsSet).toEqual(expect.arrayContaining(['clientKey', 'clientKeyPassphrase']));
    expect(destination.clientCertificate).toMatchObject({ subject: expect.stringContaining('CN=landflow-audit-client'), issuer: expect.stringContaining('CN=TMP SIEM test CA') });
    // Sealed at rest: neither the key nor its passphrase is in the row.
    const stored = database().get<{ data: string }>('SELECT data FROM audit_destinations WHERE id = ?', destination.id)!.data;
    expect(stored).not.toContain('ENCRYPTED PRIVATE KEY');
    expect(stored).not.toContain('key-passphrase');

    const test = async () => (await (await testRoute.POST(req('POST', `/api/settings/audit/destinations/${destination.id}/test`), params({ id: destination.id }))).json()) as { ok: boolean; message?: string };
    expect(await test()).toMatchObject({ ok: true });
    await until(() => octetFrames(receiver.text()).length === 1);
    expect(octetFrames(receiver.text())[0]).toContain('audit.test');
    expect(receiver.peers).toEqual(['landflow-audit-client']);

    // PATCH without the key keeps it (and its passphrase).
    const patched = await destinationRoute.PATCH(req('PATCH', `/api/settings/audit/destinations/${destination.id}`, { config: { ...destination.config } }), params({ id: destination.id }));
    expect(patched.status).toBe(200);
    expect(await test()).toMatchObject({ ok: true });
    // Without the certificate the key goes too, and the receiver refuses.
    const { clientCert: _dropped, ...withoutCert } = destination.config;
    const dropped = (await (await destinationRoute.PATCH(req('PATCH', `/api/settings/audit/destinations/${destination.id}`, { config: withoutCert }), params({ id: destination.id }))).json()) as { destination: AuditDestination };
    expect(dropped.destination.secretsSet).not.toContain('clientKey');
    expect(dropped.destination.clientCertificate).toBeUndefined();
    const refused = await test();
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/wants a client certificate/);
    resetOutboxBackoff();
    await destinationRoute.DELETE(req('DELETE', `/api/settings/audit/destinations/${destination.id}`), params({ id: destination.id }));
  });
});
