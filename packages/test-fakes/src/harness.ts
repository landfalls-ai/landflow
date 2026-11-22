/**
 * The fake contract: one way to start an outside service's stand-in on a free loopback port, point a credential at it,
 * script a failure, reset it between tests, read what it holds and what it was asked. Test-only; node built-ins only.
 *
 *   const slack = fakeSlack();            // or defineFake({ name, token, initial, routes }) for a new service
 *   beforeAll(() => slack.start());       // one instance per test file: a free port each, so files never share state
 *   beforeEach(() => slack.reset());      // the seed again, an empty log, no scripts
 *   afterAll(() => slack.stop());
 *   …run the node with a credential whose base URL is `slack.url` and whose token is `slack.token`…
 *   expect(slack.state().channels['#ops'].messages[0].text).toBe('hello');   // the outcome, not the request shape
 *
 * Every request needs the fake's token (a credential wiring bug is a 401 the test sees), is logged, and then goes to
 * `routes(state, request)`, which edits the live state and answers. A scripted failure (`script`) is answered before the
 * token is checked, like a rate limiter in front of the service. A fake binds 127.0.0.1 and reaches nothing else.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as a route sees it. */
export interface FakeRequest {
  method: string;
  /** The path without the query. */
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body (a form body parsed too; undefined when empty or not parseable). */
  body: unknown;
  /** The body as sent. */
  raw: Buffer;
}

/** What a route answers (JSON unless `body` is a string). */
export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A logged request: what came in, and what the fake answered. */
export interface FakeLogEntry extends FakeRequest {
  status: number;
  /** The token was missing or wrong. */
  refused: boolean;
  /** A script answered it. */
  scripted: boolean;
}

/** A failure for the next `times` matching calls. */
export interface FakeScript {
  status: number;
  /** Seconds, sent as `Retry-After`. */
  retryAfter?: number;
  /** Wait this long before answering (a slow service; 0 by default). */
  delayMs?: number;
  /** The body to send (default: `{ error: 'scripted' }`). */
  body?: unknown;
  /** How many calls (default 1). */
  times?: number;
  /** Only calls this accepts spend the script (default: every call). */
  match?: (request: FakeRequest) => boolean;
}

export interface Fake<S> {
  readonly name: string;
  /** The token the fake accepts: put it in the credential. */
  readonly token: string;
  /** `http://127.0.0.1:<port>`, set by `start()` (empty before). */
  readonly url: string;
  /** Bind 127.0.0.1 on a free port; resolves to the base URL. Throws when already started. */
  start(): Promise<string>;
  /** The seed again; the log and every script cleared. */
  reset(): void;
  /** A deep copy of what the fake holds: change it and nothing changes. */
  state(): S;
  /** Answer the next `times` matching calls with a failure. */
  script(script: FakeScript): void;
  /** Every request since start or the last reset, in order. */
  requests(): FakeLogEntry[];
  stop(): Promise<void>;
}

export interface FakeSpec<S> {
  name: string;
  token: string;
  /** Is the request authorised? Default: `Authorization: Bearer <token>`. */
  auth?: (request: FakeRequest, token: string) => boolean;
  /** The answer to an unauthorised request (default 401 `{ error: 'unauthorized' }`). */
  refusal?: (request: FakeRequest) => FakeReply;
  /** A fresh state: called at definition and by every `reset()`. */
  initial(): S;
  /** Handle one authorised request: edit `state` and answer. A throw is a 500. */
  routes(state: S, request: FakeRequest): FakeReply | Promise<FakeReply>;
}

const bearer = (request: FakeRequest, token: string) => request.headers.authorization === `Bearer ${token}`;

function parseBody(raw: Buffer, headers: IncomingHttpHeaders): unknown {
  const text = raw.toString('utf8');
  if (!text) return undefined;
  if (String(headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Define a fake. The instance is not listening until `start()`. */
export function defineFake<S>(spec: FakeSpec<S>): Fake<S> {
  let state = spec.initial();
  let log: FakeLogEntry[] = [];
  let scripts: Array<FakeScript & { left: number }> = [];
  let server: Server | undefined;
  let url = '';

  async function answer(request: FakeRequest): Promise<{ reply: FakeReply; refused: boolean; scripted: boolean }> {
    const index = scripts.findIndex((s) => s.left > 0 && (!s.match || s.match(request)));
    if (index >= 0) {
      const script = scripts[index];
      script.left -= 1;
      if (script.left <= 0) scripts.splice(index, 1);
      if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      return {
        reply: { status: script.status, body: script.body ?? { error: 'scripted' }, ...(script.retryAfter !== undefined && { headers: { 'retry-after': String(script.retryAfter) } }) },
        refused: false,
        scripted: true,
      };
    }
    if (!(spec.auth ?? bearer)(request, spec.token)) return { reply: spec.refusal?.(request) ?? { status: 401, body: { error: 'unauthorized' } }, refused: true, scripted: false };
    return { reply: await spec.routes(state, request), refused: false, scripted: false };
  }

  const fake: Fake<S> = {
    name: spec.name,
    token: spec.token,
    get url() {
      return url;
    },
    async start() {
      if (server) throw new Error(`fake ${spec.name}: already started`);
      const current = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          const target = new URL(req.url ?? '/', 'http://fake');
          const raw = Buffer.concat(chunks);
          const request: FakeRequest = { method: req.method ?? 'GET', path: target.pathname, query: target.searchParams, headers: req.headers, body: parseBody(raw, req.headers), raw };
          let outcome: { reply: FakeReply; refused: boolean; scripted: boolean };
          try {
            outcome = await answer(request);
          } catch (error) {
            outcome = { reply: { status: 500, body: { error: String(error) } }, refused: false, scripted: false };
          }
          const status = outcome.reply.status ?? 200;
          log.push({ ...request, status, refused: outcome.refused, scripted: outcome.scripted });
          const body = outcome.reply.body;
          res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...outcome.reply.headers });
          res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
        });
      });
      await new Promise<void>((resolve, reject) => {
        current.once('error', reject);
        current.listen(0, '127.0.0.1', resolve);
      });
      server = current;
      url = `http://127.0.0.1:${(current.address() as AddressInfo).port}`;
      return url;
    },
    reset() {
      state = spec.initial();
      log = [];
      scripts = [];
    },
    state: () => structuredClone(state),
    script(script) {
      scripts.push({ ...script, left: script.times ?? 1 });
    },
    requests: () => [...log],
    async stop() {
      const current = server;
      if (!current) return;
      server = undefined;
      url = '';
      current.closeAllConnections();
      await new Promise<void>((resolve) => current.close(() => resolve()));
    },
  };
  return fake;
}
