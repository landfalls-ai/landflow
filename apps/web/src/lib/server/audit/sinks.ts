/**
 * Delivery of audit events to SIEM destinations (./destinations). `deliver(destination, events)` sends one batch
 * and throws with a short reason when the destination did not take all of it (the outbox retries, ./outbox):
 *
 * - **syslog**: RFC 5424, one message per event over UDP, TCP or TLS (RFC 6587 octet counting or newline framing).
 *   PRI is the facility with severity informational (warning for failures and denials), MSGID the action,
 *   STRUCTURED-DATA a `landflow@32473` element with the event's fields, and MSG the event as JSON (ASCII only).
 * - **http** `generic`: the batch as JSON lines (`application/x-ndjson`), signed like the alert webhooks:
 *   `X-Landflow-Timestamp` (Unix seconds) and `X-Landflow-Signature: sha256=HMAC-SHA256(secret, "<ts>.<body>")`.
 * - **http** `datadog`: Datadog's logs intake (a JSON array, `DD-API-KEY`); `elastic`: the bulk API (`create` actions
 *   with the event id as `_id`, so a retried batch doesn't duplicate; `Authorization: ApiKey …`).
 * - **splunk**: the HTTP Event Collector (`/services/collector/event`, `Authorization: Splunk <token>`).
 *
 * HTTP goes through node:http(s) so a destination can trust a private CA or (Splunk's self-signed default) skip
 * verification. Syslog over TLS and HTTPS destinations can also present a client certificate (mTLS) when the receiver
 * asks for one: `clientCert` and `clientKey` (PEM, the key sealed at rest, ./destinations) with an optional passphrase.
 * Destinations are configured by admins, so their addresses are not restricted.
 */
import { createHmac } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { AuditDestinationConfig, AuditEvent } from '../../shared/audit';
import { telemetryConfig } from '../telemetry/config';
import type { SendableDestination } from './destinations';
import { auditEventName } from './otel';

const TIMEOUT_MS = 10_000;
const TLS_SETTLE_MS = 1_000;
const TLS_TICKET_WAIT_MS = 300;
/** Events per HTTP request (syslog sends one message per event anyway). */
export const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The event as the HTTP sinks send it: the stored event plus its OTel event name and the service. */
export function siemRecord(event: AuditEvent): Record<string, unknown> {
  return { ...event, eventName: auditEventName(event.action), service: telemetryConfig.serviceName, host: host() };
}

let cachedHost: string | undefined;
const host = () => (cachedHost ??= (hostname() || 'landflow').replace(/[^\x21-\x7e]/g, '').slice(0, 255) || 'landflow');

/** JSON with every non-ASCII character escaped, so a message is the same bytes whatever the receiver assumes. */
const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// ---------------------------------------------------------------------------
// Syslog (RFC 5424)
// ---------------------------------------------------------------------------

/** An SD-NAME: printable ASCII except `=`, space, `]` and `"`, at most 32 characters. */
const sdName = (text: string, fallback = '-') => text.replace(/[^\x21-\x7e]|[= \]"]/g, '').slice(0, 32) || fallback;
/** A PARAM-VALUE: `"`, `\` and `]` escaped. */
const sdValue = (text: string) => text.replace(/[\\"\]]/g, (c) => `\\${c}`);

/** Example private enterprise number (RFC 5612), as RFC 5424 suggests for SD-IDs without one of their own. */
export const SYSLOG_SD_ID = 'landflow@32473';

/** One RFC 5424 message for `event`. */
export function syslogMessage(event: AuditEvent, config: Pick<AuditDestinationConfig, 'facility' | 'appName'>): string {
  const severity = event.outcome === 'success' ? 6 : 4;
  const pri = (config.facility ?? 13) * 8 + severity;
  const params: [string, string | undefined][] = [
    ['id', event.id],
    ['action', event.action],
    ['outcome', event.outcome],
    ['actorType', event.actor.type],
    ['actorId', event.actor.id],
    ['actorEmail', event.actor.email],
    ['apiKeyId', event.apiKeyId],
    ['ip', event.ip],
    ['requestId', event.requestId],
    ['method', event.method],
    ['route', event.route],
    ['status', event.status === undefined ? undefined : String(event.status)],
    ['targetType', event.target?.type],
    ['targetId', event.target?.id],
    ['projectId', event.projectId],
    ['chainSeq', event.chain ? String(event.chain.seq) : undefined],
    ['hash', event.chain?.hash],
  ];
  const sd = `[${SYSLOG_SD_ID}${params
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => ` ${name}="${sdValue(value!)}"`)
    .join('')}]`;
  const appName = sdName(config.appName ?? 'landflow', 'landflow').slice(0, 48);
  return `<${pri}>1 ${event.at} ${host()} ${appName} ${process.pid} ${sdName(event.action)} ${sd} ${asciiJson(event)}`;
}

/** The TLS options of a destination: the CA to trust (or no verification) and the client certificate to present. */
export type TlsConfig = Pick<AuditDestinationConfig, 'rejectUnauthorized' | 'ca' | 'clientCert' | 'clientKey' | 'clientKeyPassphrase'>;

export function tlsOptions(config: TlsConfig): ConnectionOptions {
  return {
    rejectUnauthorized: config.rejectUnauthorized ?? true,
    ...(config.ca && { ca: config.ca }),
    ...(config.clientCert && config.clientKey && { cert: config.clientCert, key: config.clientKey, ...(config.clientKeyPassphrase && { passphrase: config.clientKeyPassphrase }) }),
  };
}

/** A clearer reason for the TLS errors a receiver that wants a client certificate gives. */
function tlsError(error: Error & { code?: string }, config: TlsConfig): Error {
  const text = `${error.code ?? ''} ${error.message}`;
  if (/CERTIFICATE_REQUIRED|certificate required/i.test(text)) {
    return new Error(config.clientCert ? `The receiver refused the client certificate (${error.message})` : `The receiver wants a client certificate (mTLS): add one to the destination (${error.message})`);
  }
  if (config.clientCert && /UNKNOWN_CA|BAD_CERTIFICATE|unknown ca|bad certificate|CERTIFICATE_UNKNOWN/i.test(text)) return new Error(`The receiver doesn’t trust the client certificate (${error.message})`);
  if (config.clientCert && /socket hang up|ECONNRESET/i.test(text)) return new Error(`The receiver closed the connection: it may not accept the client certificate (${error.message})`);
  return error;
}

function frame(message: string, framing: AuditDestinationConfig['framing']): string {
  return framing === 'newline' ? `${message}\n` : `${Buffer.byteLength(message)} ${message}`;
}

async function sendSyslogUdp(config: AuditDestinationConfig, messages: string[]): Promise<void> {
  const socket = createSocket(config.host?.includes(':') ? 'udp6' : 'udp4');
  try {
    for (const message of messages) {
      await new Promise<void>((resolve, reject) => socket.send(Buffer.from(message), config.port ?? 514, config.host, (error) => (error ? reject(error) : resolve())));
    }
  } finally {
    socket.close();
  }
}

async function sendSyslogStream(config: AuditDestinationConfig, messages: string[]): Promise<void> {
  const tls = config.protocol === 'tls';
  const port = config.port ?? (tls ? 6514 : 514);
  const payload = messages.map((m) => frame(m, config.framing)).join('');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(tls ? tlsError(error, config) : error);
      else resolve();
    };
    const socket: Socket = tls ? tlsConnect({ host: config.host, port, ...(config.host && !isIP(config.host) && { servername: config.host }), ...tlsOptions(config) }) : netConnect({ host: config.host!, port });
    const timer = setTimeout(() => done(new Error(`syslog ${config.host}:${port} timed out`)), TIMEOUT_MS);
    let written = false;
    const write = () => {
      if (written || settled) return;
      written = true;
      socket.end(payload, () => {
        if (!tls) return done();
        // TLS 1.3 servers refuse a client certificate after the client's handshake is done: give the alert a moment
        // to arrive (a receiver that closes its side settles it sooner).
        setTimeout(() => done(), TLS_SETTLE_MS);
      });
    };
    socket.once('error', (error) => done(error));
    socket.once(tls ? 'secureConnect' : 'connect', () => {
      // TLS 1.3 with a client certificate: the server accepts it after our handshake ends, and then sends a session
      // ticket, or drops the connection. Wait for one or the other (briefly: not every server sends tickets).
      if (tls && config.clientCert && (socket as TLSSocket).getProtocol() === 'TLSv1.3') {
        const wait = setTimeout(write, TLS_TICKET_WAIT_MS);
        socket.once('session', () => {
          clearTimeout(wait);
          // Not from inside OpenSSL's ticket callback.
          setImmediate(write);
        });
      } else write();
    });
    socket.once('close', (hadError) => {
      if (hadError) return;
      if (written) done();
      else done(new Error(`syslog ${config.host}:${port} closed the connection before taking any message${tls && config.clientCert ? ': it may not accept the client certificate' : ''}`));
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** POST `body` to `url` (node:http(s), so TLS options apply); the reply with up to 64 KB of its body. */
export function post(url: string, body: string, headers: Record<string, string>, tls: TlsConfig = {}): Promise<HttpReply> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<HttpReply>((resolve, reject) => {
    const req = send(
      target,
      {
        method: 'POST',
        headers: { 'content-length': String(Buffer.byteLength(body)), 'user-agent': `landflow/${telemetryConfig.serviceVersion}`, ...headers },
        timeout: TIMEOUT_MS,
        ...(target.protocol === 'https:' && tlsOptions(tls)),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size < 65_536) chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${target.host} timed out`)));
    req.on('error', (error) => reject(target.protocol === 'https:' ? tlsError(error, tls) : error));
    req.end(body);
  });
}

function refused(reply: HttpReply, what: string): Error {
  const text = reply.body.replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(`${what} answered HTTP ${reply.status}${text ? `: ${text}` : ''}`);
}

const ok = (reply: HttpReply) => reply.status >= 200 && reply.status < 300;

/** The generic sink's signature headers for `body` (verify with the same HMAC over `"<timestamp>.<body>"`). */
export function signedHeaders(secret: string | undefined, body: string, now = Date.now()): Record<string, string> {
  if (!secret) return {};
  const timestamp = String(Math.floor(now / 1000));
  return { 'x-landflow-timestamp': timestamp, 'x-landflow-signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}` };
}

async function sendGeneric(config: AuditDestinationConfig, events: AuditEvent[]) {
  const body = events.map((event) => JSON.stringify(siemRecord(event))).join('\n') + '\n';
  const reply = await post(config.url!, body, { 'content-type': 'application/x-ndjson', ...signedHeaders(config.secret, body) }, config);
  if (!ok(reply)) throw refused(reply, 'The endpoint');
}

async function sendDatadog(config: AuditDestinationConfig, events: AuditEvent[]) {
  const body = JSON.stringify(
    events.map((event) => ({
      ddsource: 'landflow',
      service: telemetryConfig.serviceName,
      hostname: host(),
      ...(config.tags && { ddtags: config.tags }),
      status: event.outcome === 'success' ? 'info' : 'warn',
      message: event.summary,
      timestamp: Date.parse(event.at),
      evt: { name: auditEventName(event.action), outcome: event.outcome, id: event.id },
      usr: { ...(event.actor.id && { id: event.actor.id }), ...(event.actor.name && { name: event.actor.name }), ...(event.actor.email && { email: event.actor.email }) },
      ...(event.ip && { network: { client: { ip: event.ip } } }),
      landflow: { audit: event },
    })),
  );
  const reply = await post(config.url!, body, { 'content-type': 'application/json', ...(config.apiKey && { 'dd-api-key': config.apiKey }) }, config);
  if (!ok(reply)) throw refused(reply, 'Datadog');
}

/** The bulk endpoint for an Elasticsearch base URL (or the URL itself when it already ends in /_bulk). */
export function elasticBulkUrl(url: string): string {
  const target = new URL(url);
  if (!/\/_bulk\/?$/.test(target.pathname)) target.pathname = `${target.pathname.replace(/\/+$/, '')}/_bulk`;
  return target.toString();
}

async function sendElastic(config: AuditDestinationConfig, events: AuditEvent[]) {
  const body =
    events
      .map(
        (event) =>
          `${JSON.stringify({ create: { _index: config.index, _id: event.id } })}\n${JSON.stringify({
            '@timestamp': event.at,
            message: event.summary,
            event: { action: event.action, category: event.category, outcome: event.outcome, id: event.id, dataset: 'landflow.audit' },
            ...(event.actor.id && { user: { id: event.actor.id, ...(event.actor.name && { name: event.actor.name }), ...(event.actor.email && { email: event.actor.email }) } }),
            ...(event.ip && { client: { ip: event.ip } }),
            ...(event.userAgent && { user_agent: { original: event.userAgent } }),
            landflow: { audit: event },
          })}`,
      )
      .join('\n') + '\n';
  const reply = await post(elasticBulkUrl(config.url!), body, { 'content-type': 'application/x-ndjson', ...(config.apiKey && { authorization: `ApiKey ${config.apiKey}` }) }, config);
  if (!ok(reply)) throw refused(reply, 'Elasticsearch');
  let result: { errors?: boolean; items?: { create?: { status?: number; error?: { type?: string; reason?: string } } }[] };
  try {
    result = JSON.parse(reply.body);
  } catch {
    throw new Error('Elasticsearch answered with something other than a bulk response');
  }
  if (!result.errors) return;
  // 409: already indexed by an earlier attempt of this batch.
  const failed = (result.items ?? []).map((item) => item.create).filter((item) => item && item.status !== undefined && (item.status < 200 || item.status >= 300) && item.status !== 409);
  if (failed.length) throw new Error(`Elasticsearch refused ${failed.length} of ${events.length} events: ${failed[0]?.error?.type ?? ''} ${failed[0]?.error?.reason ?? ''}`.trim());
}

/** The HEC event endpoint for a Splunk base URL (or the URL itself when it already names a collector endpoint). */
export function splunkEventUrl(url: string): string {
  const target = new URL(url);
  if (!/\/services\/collector/.test(target.pathname)) target.pathname = `${target.pathname.replace(/\/+$/, '')}/services/collector/event`;
  return target.toString();
}

async function sendSplunk(config: AuditDestinationConfig, events: AuditEvent[]) {
  const body = events
    .map((event) =>
      JSON.stringify({
        time: Date.parse(event.at) / 1000,
        host: host(),
        source: config.source ?? 'landflow',
        sourcetype: config.sourcetype ?? 'landflow:audit',
        ...(config.index && { index: config.index }),
        event: siemRecord(event),
      }),
    )
    .join('\n');
  const reply = await post(splunkEventUrl(config.url!), body, { 'content-type': 'application/json', authorization: `Splunk ${config.token ?? ''}` }, config);
  if (!ok(reply)) throw refused(reply, 'Splunk HEC');
}

// ---------------------------------------------------------------------------

/** Send one batch to `destination`. Throws with a short reason unless all of it was taken. */
export async function deliver(destination: Pick<SendableDestination, 'kind' | 'config'>, events: AuditEvent[]): Promise<void> {
  if (!events.length) return;
  const { config } = destination;
  switch (destination.kind) {
    case 'syslog': {
      const messages = events.map((event) => syslogMessage(event, config));
      return config.protocol === 'tcp' || config.protocol === 'tls' ? sendSyslogStream(config, messages) : sendSyslogUdp(config, messages);
    }
    case 'http':
      if (config.preset === 'datadog') return sendDatadog(config, events);
      if (config.preset === 'elastic') return sendElastic(config, events);
      return sendGeneric(config, events);
    case 'splunk':
      return sendSplunk(config, events);
    default:
      throw new Error(`Unknown destination kind ${String(destination.kind)}`);
  }
}
