/**
 * A fake Twilio REST API (the 2010-04-01 subset the Twilio node uses): Basic auth, form bodies, Twilio-shaped JSON
 * (`SM…` / `MM…` / `CA…` SIDs, `status`, `num_media`, `date_created`…), list paging with `next_page_uri`, Twilio's
 * `{ code, message, more_info, status }` errors, and a switch to answer the next request(s) with a 429 + Retry-After
 * or a 5xx. Every request is recorded, so a test can assert that a send went out exactly once.
 *
 * In-process: `const twilio = await startFakeTwilio(); … twilio.requests; twilio.failNext({ status: 429, retryAfter: 1 })`.
 * Standalone (the walk-through): `pnpm --filter @landflow/plugin-messaging fake-twilio [--port 7560] [--write-env <path>] [--delay-ms 400]`
 * prints the test Account SID and Auth Token, writes them to the env file, and adds control routes without auth:
 * `GET /__fake/requests`, `DELETE /__fake/requests`, `POST /__fake/fail {status, retryAfter?, times?}`, `GET /__fake/health`.
 * Fake credentials only; nothing here talks to Twilio.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeTwilioRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** The form fields (`MediaUrl` may repeat). Empty for GETs. */
  form: Record<string, string[]>;
  /** Whether the Basic auth matched. */
  authorized: boolean;
  at: string;
}

export interface FakeFailure {
  status: number;
  /** Seconds, sent as `Retry-After` (429 only by default; any status may carry it). */
  retryAfter?: number;
  /** How many requests fail (default 1). */
  times?: number;
  code?: number;
  message?: string;
}

export interface FakeTwilioOptions {
  port?: number;
  host?: string;
  accountSid?: string;
  authToken?: string;
  apiKey?: { sid: string; secret: string };
  /** Hold every reply back this long (ms), like a real API on a real network (the walk-through uses 400 so a campaign overlaps). */
  delayMs?: number;
  /** Serve the `/__fake/*` control routes (on by default standalone, off in tests unless asked). */
  control?: boolean;
  log?: (line: string) => void;
}

export interface FakeTwilio {
  url: string;
  port: number;
  accountSid: string;
  authToken: string;
  apiKey: { sid: string; secret: string };
  /** Every request, in order, auth header included (tests may inspect it; the standalone control route strips it). */
  requests: FakeTwilioRequest[];
  messages: Record<string, unknown>[];
  calls: Record<string, unknown>[];
  /** Answer the next request(s) with this failure instead of handling them. */
  failNext(failure: FakeFailure): void;
  /** Forget requests, messages, calls and pending failures. */
  reset(): void;
  close(): Promise<void>;
}

const API = '/2010-04-01';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const PHONE = /^(whatsapp:)?\+[1-9]\d{6,14}$/;
const MESSAGING_SERVICE = /^MG[0-9a-fA-F]{32}$/;

/** Twilio's date format: `Mon, 26 Oct 2026 11:42:41 +0000`. */
export function twilioDate(date = new Date()): string {
  return date.toUTCString().replace(/ GMT$/, ' +0000');
}

function errorBody(status: number, code: number, message: string) {
  return { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status };
}

const ERRORS = {
  unauthorized: () => errorBody(401, 20003, 'Authentication Error - invalid username'),
  notFound: (what: string, id: string) => errorBody(404, 20404, `The requested resource /${what}/${id} was not found`),
  toRequired: () => errorBody(400, 21604, "A 'To' phone number is required."),
  fromRequired: () => errorBody(400, 21603, "A 'From' phone number is required."),
  bodyRequired: () => errorBody(400, 21602, 'Message body is required.'),
  invalidTo: (to: string) => errorBody(400, 21211, `The 'To' number ${to} is not a valid phone number.`),
  invalidFrom: (from: string) => errorBody(400, 21212, `The 'From' number ${from} is not a valid phone number, shortcode, or alphanumeric sender ID.`),
  notSmsCapable: (to: string) => errorBody(400, 21614, `'To' number: ${to}, is not a valid mobile number`),
  channelMismatch: () => errorBody(400, 63007, 'Twilio could not find a Channel with the specified From address'),
  tooMuchMedia: () => errorBody(400, 21623, 'Number of media files exceeds allowed limit'),
  urlRequired: () => errorBody(400, 21205, 'Url parameter is required.'),
  pageTooFar: () => errorBody(400, 20006, 'Invalid Page parameter'),
} as const;

/** Twilio's magic test numbers: +15005550001 is always invalid, +15005550009 can't receive SMS. */
function validateTo(to: string | undefined): ReturnType<typeof errorBody> | undefined {
  if (!to) return ERRORS.toRequired();
  if (!PHONE.test(to) || to.endsWith('5005550001')) return ERRORS.invalidTo(to);
  if (to.endsWith('5005550009')) return ERRORS.notSmsCapable(to);
  return undefined;
}

function parseForm(text: string): Record<string, string[]> {
  const form: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(text)) (form[key] ??= []).push(value);
  return form;
}

const first = (form: Record<string, string[]>, key: string) => form[key]?.[0];

/** A page of a list, Twilio style: `Page` (0-based) and `PageSize`, `next_page_uri` while there is more, `PageToken` carried for shape. */
function page<T extends { sid?: unknown }>(entries: T[], key: string, path: string, query: URLSearchParams) {
  const pageSize = Math.min(1000, Math.max(1, Number(query.get('PageSize') ?? 50) || 50));
  const index = Math.max(0, Number(query.get('Page') ?? 0) || 0);
  const start = index * pageSize;
  const slice = entries.slice(start, start + pageSize);
  const uri = (page: number, token?: string) => {
    const q = new URLSearchParams(query);
    q.set('PageSize', String(pageSize));
    q.set('Page', String(page));
    if (token) q.set('PageToken', token);
    else q.delete('PageToken');
    return `${path}?${q.toString()}`;
  };
  const more = start + pageSize < entries.length;
  return {
    first_page_uri: uri(0),
    end: start + slice.length - 1,
    previous_page_uri: index > 0 ? uri(index - 1, `PB${slice[0]?.sid ?? ''}`) : null,
    uri: uri(index, query.get('PageToken') ?? undefined),
    page_size: pageSize,
    start,
    next_page_uri: more ? uri(index + 1, `PA${slice.at(-1)?.sid ?? ''}`) : null,
    page: index,
    [key]: slice,
  };
}

/** `YYYY-MM-DD` of a Twilio date, for the DateSent / StartTime filters. */
const dayOf = (value: unknown) => (typeof value === 'string' && value ? new Date(value).toISOString().slice(0, 10) : '');

function dateFilter(query: URLSearchParams, field: string, dayField: (entry: Record<string, unknown>) => string) {
  const exact = query.get(field);
  const after = query.get(`${field}>`);
  const before = query.get(`${field}<`);
  return (entry: Record<string, unknown>) => {
    const day = dayField(entry);
    if (exact && day !== exact) return false;
    if (after && !(day > after)) return false;
    if (before && !(day < before)) return false;
    return true;
  };
}

export async function startFakeTwilio(options: FakeTwilioOptions = {}): Promise<FakeTwilio> {
  const accountSid = options.accountSid ?? sid('AC');
  const authToken = options.authToken ?? hex(16);
  const apiKey = options.apiKey ?? { sid: sid('SK'), secret: hex(16) };
  const requests: FakeTwilioRequest[] = [];
  const messages: Record<string, unknown>[] = [];
  const calls: Record<string, unknown>[] = [];
  const failures: FakeFailure[] = [];
  const log = options.log ?? (() => {});
  const accountPath = `${API}/Accounts/${accountSid}`;

  const authorized = (header: string | undefined) => {
    if (!header?.startsWith('Basic ')) return false;
    const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    const secret = rest.join(':');
    return (user === accountSid && secret === authToken) || (user === apiKey.sid && secret === apiKey.secret);
  };

  const account = () => ({
    sid: accountSid,
    friendly_name: 'Fake Twilio account',
    status: 'active',
    type: 'Full',
    owner_account_sid: accountSid,
    auth_token: '[redacted by the fake]',
    date_created: twilioDate(new Date('2026-01-01T00:00:00Z')),
    date_updated: twilioDate(new Date('2026-01-01T00:00:00Z')),
    uri: `${accountPath}.json`,
    subresource_uris: { messages: `${accountPath}/Messages.json`, calls: `${accountPath}/Calls.json` },
  });

  type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

  function createMessage(form: Record<string, string[]>): Reply {
    const to = first(form, 'To');
    const from = first(form, 'From');
    const service = first(form, 'MessagingServiceSid');
    const body = first(form, 'Body');
    const media = form.MediaUrl ?? [];
    const invalidTo = validateTo(to);
    if (invalidTo) return { status: 400, body: invalidTo };
    if (!from && !service) return { status: 400, body: ERRORS.fromRequired() };
    if (service && !MESSAGING_SERVICE.test(service)) return { status: 400, body: errorBody(400, 21701, 'The Messaging Service does not exist') };
    if (from && !PHONE.test(from) && !/^[A-Za-z0-9 ]{1,11}$/.test(from)) return { status: 400, body: ERRORS.invalidFrom(from) };
    if (from && from.startsWith('whatsapp:') !== to!.startsWith('whatsapp:')) return { status: 400, body: ERRORS.channelMismatch() };
    if (!body && !media.length && !first(form, 'ContentSid')) return { status: 400, body: ERRORS.bodyRequired() };
    if (media.length > 10) return { status: 400, body: ERRORS.tooMuchMedia() };
    const now = twilioDate();
    const messageSid = sid(media.length ? 'MM' : 'SM');
    const message = {
      sid: messageSid,
      account_sid: accountSid,
      messaging_service_sid: service ?? null,
      from: from ?? null,
      to,
      body: body ?? '',
      status: first(form, 'SendAt') ? 'scheduled' : 'queued',
      num_segments: String(Math.max(1, Math.ceil((body ?? '').length / 160))),
      num_media: String(media.length),
      direction: 'outbound-api',
      api_version: '2010-04-01',
      price: null,
      price_unit: 'USD',
      error_code: null,
      error_message: null,
      date_created: now,
      date_updated: now,
      date_sent: null,
      uri: `${accountPath}/Messages/${messageSid}.json`,
      subresource_uris: { media: `${accountPath}/Messages/${messageSid}/Media.json` },
      // What the fake received, for tests (Twilio does not echo these).
      _fake: { media, status_callback: first(form, 'StatusCallback') ?? null, content_sid: first(form, 'ContentSid') ?? null, content_variables: first(form, 'ContentVariables') ?? null },
    };
    messages.unshift(message);
    return { status: 201, body: message };
  }

  function createCall(form: Record<string, string[]>): Reply {
    const to = first(form, 'To');
    const from = first(form, 'From');
    if (!to) return { status: 400, body: ERRORS.toRequired() };
    if (!from) return { status: 400, body: ERRORS.fromRequired() };
    if (!PHONE.test(from)) return { status: 400, body: ERRORS.invalidFrom(from) };
    if (!PHONE.test(to) && !/^(sip:|client:)/.test(to)) return { status: 400, body: ERRORS.invalidTo(to) };
    if (!first(form, 'Url') && !first(form, 'Twiml')) return { status: 400, body: ERRORS.urlRequired() };
    const now = twilioDate();
    const callSid = sid('CA');
    const call = {
      sid: callSid,
      account_sid: accountSid,
      from,
      to,
      status: 'queued',
      direction: 'outbound-api',
      api_version: '2010-04-01',
      duration: null,
      price: null,
      price_unit: 'USD',
      start_time: null,
      end_time: null,
      date_created: now,
      date_updated: now,
      uri: `${accountPath}/Calls/${callSid}.json`,
      subresource_uris: { recordings: `${accountPath}/Calls/${callSid}/Recordings.json` },
      _fake: { url: first(form, 'Url') ?? null, twiml: first(form, 'Twiml') ?? null, status_callback: first(form, 'StatusCallback') ?? null, timeout: first(form, 'Timeout') ?? null, record: first(form, 'Record') ?? null, machine_detection: first(form, 'MachineDetection') ?? null },
    };
    calls.unshift(call);
    return { status: 201, body: call };
  }

  function route(request: FakeTwilioRequest): Reply {
    const { method, path, query, form } = request;
    if (options.control && path.startsWith('/__fake/')) {
      if (path === '/__fake/health') return { body: { ok: true, accountSid } };
      if (path === '/__fake/requests' && method === 'GET') {
        return { body: { requests: requests.filter((r) => !r.path.startsWith('/__fake/')).map(({ headers: _headers, ...rest }) => ({ ...rest, query: rest.query.toString() })) } };
      }
      if (path === '/__fake/requests' && method === 'DELETE') {
        requests.length = 0;
        return { body: { ok: true } };
      }
      if (path === '/__fake/fail' && method === 'POST') {
        const failure = JSON.parse(Buffer.from(first(form, '__raw') ?? '{}', 'base64').toString('utf8')) as FakeFailure;
        if (!failure.status) return { status: 400, body: { error: 'status is required' } };
        failures.push(failure);
        return { body: { ok: true, pending: failures.length } };
      }
      return { status: 404, body: { error: `no such control route ${method} ${path}` } };
    }
    if (!request.authorized) return { status: 401, body: ERRORS.unauthorized(), headers: { 'www-authenticate': 'Basic realm="Twilio API"' } };
    const failure = failures[0];
    if (failure) {
      if ((failure.times ?? 1) <= 1) failures.shift();
      else failure.times = (failure.times ?? 1) - 1;
      const status = failure.status;
      const code = failure.code ?? (status === 429 ? 20429 : status >= 500 ? 20500 : 20400);
      const message = failure.message ?? (status === 429 ? 'Too Many Requests' : status >= 500 ? 'Internal Server Error' : 'Bad Request');
      return { status, body: errorBody(status, code, message), headers: failure.retryAfter !== undefined ? { 'retry-after': String(failure.retryAfter) } : undefined };
    }
    if (!path.startsWith(`${accountPath}/`) && path !== `${accountPath}.json`) {
      const other = path.match(/^\/2010-04-01\/Accounts\/([^/.]+)/);
      return { status: 404, body: ERRORS.notFound('Accounts', other?.[1] ?? path) };
    }
    const rest = path.slice(accountPath.length);
    if (rest === '.json' && method === 'GET') return { body: account() };
    if (rest === '/Messages.json' && method === 'POST') return createMessage(form);
    if (rest === '/Messages.json' && method === 'GET') {
      const to = query.get('To');
      const from = query.get('From');
      const byDate = dateFilter(query, 'DateSent', (m) => dayOf(m.date_sent ?? m.date_created));
      const matching = messages.filter((m) => (!to || m.to === to) && (!from || m.from === from) && byDate(m));
      if ((Number(query.get('Page') ?? 0) || 0) * (Number(query.get('PageSize') ?? 50) || 50) > Math.max(0, matching.length - 1) && matching.length) return { status: 400, body: ERRORS.pageTooFar() };
      return { body: page(matching, 'messages', `${accountPath}/Messages.json`, query) };
    }
    let match = rest.match(/^\/Messages\/([^/]+)\.json$/);
    if (match && method === 'GET') {
      const found = messages.find((m) => m.sid === match![1]);
      return found ? { body: found } : { status: 404, body: ERRORS.notFound('Messages', match[1]) };
    }
    if (rest === '/Calls.json' && method === 'POST') return createCall(form);
    if (rest === '/Calls.json' && method === 'GET') {
      const to = query.get('To');
      const from = query.get('From');
      const status = query.get('Status');
      const byDate = dateFilter(query, 'StartTime', (c) => dayOf(c.start_time ?? c.date_created));
      const matching = calls.filter((c) => (!to || c.to === to) && (!from || c.from === from) && (!status || c.status === status) && byDate(c));
      return { body: page(matching, 'calls', `${accountPath}/Calls.json`, query) };
    }
    match = rest.match(/^\/Calls\/([^/]+)\.json$/);
    if (match && method === 'GET') {
      const found = calls.find((c) => c.sid === match![1]);
      return found ? { body: found } : { status: 404, body: ERRORS.notFound('Calls', match[1]) };
    }
    return { status: 404, body: errorBody(404, 20404, `The requested resource ${path} was not found`) };
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const raw = Buffer.concat(chunks).toString('utf8');
      const contentType = String(req.headers['content-type'] ?? '');
      const form = contentType.startsWith('application/x-www-form-urlencoded') ? parseForm(raw) : raw ? { __raw: [Buffer.from(raw, 'utf8').toString('base64')] } : {};
      const request: FakeTwilioRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        form,
        authorized: authorized(req.headers.authorization),
        at: new Date().toISOString(),
      };
      requests.push(request);
      let reply: Reply;
      try {
        reply = route(request);
      } catch (error) {
        reply = { status: 500, body: errorBody(500, 20500, String(error)) };
      }
      const status = reply.status ?? 200;
      log(`${request.method} ${request.path}${url.search} -> ${status}`);
      const respond = () => {
        res.writeHead(status, { 'content-type': 'application/json', 'twilio-request-id': `RQ${hex(16)}`, ...reply.headers });
        res.end(JSON.stringify(reply.body));
      };
      if (options.delayMs) setTimeout(respond, options.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    port,
    accountSid,
    authToken,
    apiKey,
    requests,
    messages,
    calls,
    failNext: (failure) => void failures.push({ ...failure }),
    reset: () => {
      requests.length = 0;
      messages.length = 0;
      calls.length = 0;
      failures.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Standalone: `tsx test/fake-twilio.ts [--port N] [--write-env path] [--delay-ms N]` (env FAKE_TWILIO_PORT, FAKE_TWILIO_ENV_FILE, FAKE_TWILIO_DELAY_MS). */
async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = Number(flag('--port') ?? process.env.FAKE_TWILIO_PORT ?? 7560);
  const envFile = flag('--write-env') ?? process.env.FAKE_TWILIO_ENV_FILE ?? join(tmpdir(), 't4a-twilio.env');
  const twilio = await startFakeTwilio({
    port,
    accountSid: process.env.FAKE_TWILIO_ACCOUNT_SID,
    authToken: process.env.FAKE_TWILIO_AUTH_TOKEN,
    delayMs: Number(flag('--delay-ms') ?? process.env.FAKE_TWILIO_DELAY_MS ?? 0) || undefined,
    control: true,
    log: (line) => console.log(`[fake-twilio] ${line}`),
  });
  const lines = [
    `TWILIO_BASE_URL=${twilio.url}`,
    `TWILIO_ACCOUNT_SID=${twilio.accountSid}`,
    `TWILIO_AUTH_TOKEN=${twilio.authToken}`,
    `TWILIO_API_KEY_SID=${twilio.apiKey.sid}`,
    `TWILIO_API_KEY_SECRET=${twilio.apiKey.secret}`,
  ];
  writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`[fake-twilio] listening on ${twilio.url} (2010-04-01 API + /__fake control routes)`);
  for (const line of lines) console.log(`[fake-twilio] ${line}`);
  console.log(`[fake-twilio] written to ${envFile}`);
  const stop = () => void twilio.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
