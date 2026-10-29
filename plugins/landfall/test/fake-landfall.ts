/**
 * An in-memory Landfall: every route the plugin calls, with the same auth split (API key on org routes, ingest token on
 * POST /triggers, heartbeat token on pings), dedup by connection + dedupKey while a room is open, optimistic
 * concurrency on timeline appends, ended statuses, 422 for an unknown or unhealthy remote-source connection and a 429
 * path (a request counter per token, plus `throttle()` to force one). Fake tokens only; nothing here talks to a real service.
 *
 *   pnpm --filter @landflow/plugin-landfall fake-landfall      # listens on FAKE_LANDFALL_PORT (default 7398)
 *
 * Helpers for a flow's end-to-end run: GET /_fake/state dumps everything; POST /_fake/incidents/:id/status {status} sets
 * a status (and appends status.changed); POST /_fake/connections/:id {healthy} flips a connection's health.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SEED = {
  orgSlug: 'acme',
  apiKey: 'lf_key_fake_0123456789abcdef',
  ingestToken: 'fake-ingest-token-0123456789',
  connectionId: 'conn_landflow',
  unhealthyConnectionId: 'conn_down',
  heartbeatName: 'nightly-backup',
  heartbeatToken: 'fake-heartbeat-token-0123456789',
};

export const ENDED = ['resolved', 'closed', 'mitigated', 'recovered', 'done', 'archived'];
/** Event types the real server refuses on the generic append route. */
export const REFUSED_TYPES = ['agent.step', 'incident.triggered', 'severity.proposed', 'demo.marked', 'selfmon.marked', 'context.attached', 'context.detached', 'cluster.uninvolved'];
const HUMAN_STAMPED = ['chat.message', 'remediation.applied-externally', 'status.changed', 'severity.changed'];

export interface FakeEvent {
  id: string;
  incidentId: string;
  seq: number;
  type: string;
  actorType: string;
  actorId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface FakeIncident {
  id: string;
  createdAt: string;
  number: number;
  displayId: string;
  title: string;
  status: string;
  severity: string;
  category: string;
  categoryConfirmed: boolean;
  alertSource?: string;
  alertContext?: Record<string, unknown>;
  alertEntity: { kind: string; id: string } | null;
  connectionId?: string;
  dedupKey?: string;
  events: FakeEvent[];
}

export interface FakeRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization?: string;
  body?: any;
}

export interface FakeLandfallOptions {
  port?: number;
  /** Requests allowed per token per window (Landfall: 300 per 60 s). */
  rateLimit?: { limit: number; windowMs: number };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const NAMES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests' };

export class FakeLandfall {
  incidents: FakeIncident[] = [];
  connections = new Map<string, { healthy: boolean }>([
    [SEED.connectionId, { healthy: true }],
    [SEED.unhealthyConnectionId, { healthy: false }],
  ]);
  heartbeats = new Map<string, { token: string; pings: string[] }>([[SEED.heartbeatName, { token: SEED.heartbeatToken, pings: [] }]]);
  requests: FakeRequestLog[] = [];
  /** Appends to make stale: before the next N event POSTs a "colleague" writes an event, so expectedSeq is out of date. */
  concurrentWrites = 0;
  private forced429 = { count: 0, retryAfter: 1 };
  private hits = new Map<string, number[]>();
  private nextNumber = 1;
  private nextId = 1;
  server?: Server;
  url = '';

  constructor(private readonly options: FakeLandfallOptions = {}) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        try {
          const result = this.route(req, new URL(req.url ?? '/', 'http://fake'), body as any);
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(result.body === undefined ? '' : JSON.stringify(result.body));
        } catch (error) {
          const e = error instanceof HttpError ? error : new HttpError(500, String(error));
          res.writeHead(e.status, { 'content-type': 'application/json', ...e.headers });
          res.end(JSON.stringify({ statusCode: e.status, message: e.message, error: NAMES[e.status] ?? 'Error' }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.options.port ?? 0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Answer the next `count` requests (any route but /_fake) with a 429 and this Retry-After. */
  throttle(count: number, retryAfter = 1) {
    this.forced429 = { count, retryAfter };
  }

  reset() {
    this.incidents = [];
    this.requests = [];
    this.concurrentWrites = 0;
    this.forced429 = { count: 0, retryAfter: 1 };
    this.hits.clear();
    this.nextNumber = 1;
    this.connections.set(SEED.connectionId, { healthy: true });
    for (const h of this.heartbeats.values()) h.pings = [];
  }

  /** Seed an incident directly (tests). */
  seed(init: Partial<FakeIncident> & { title: string }): FakeIncident {
    const number = this.nextNumber++;
    const id = init.id ?? `inc_${this.nextId++}`;
    const incident: FakeIncident = {
      id,
      createdAt: new Date().toISOString(),
      number,
      displayId: `ACME-${number}`,
      status: 'open',
      severity: 'sev3',
      category: 'unknown',
      categoryConfirmed: false,
      alertEntity: null,
      events: [],
      ...init,
    };
    this.incidents.push(incident);
    this.append(incident, 'incident.opened', { title: incident.title, severity: incident.severity, number }, 'system');
    return incident;
  }

  append(incident: FakeIncident, type: string, payload: Record<string, unknown>, actorType = 'human'): FakeEvent {
    const event: FakeEvent = {
      id: `ev_${this.nextId++}`,
      incidentId: incident.id,
      seq: incident.events.length,
      type,
      actorType,
      actorId: actorType === 'human' ? 'member_1' : 'system',
      payload,
      occurredAt: new Date().toISOString(),
    };
    incident.events.push(event);
    if (type === 'status.changed' && typeof payload.status === 'string') incident.status = payload.status;
    return event;
  }

  // -------------------------------------------------------------------------

  private auth(req: IncomingMessage, allowed: string[]) {
    const header = req.headers.authorization ?? '';
    const token = /^Bearer (.+)$/.exec(header)?.[1];
    if (!token || !allowed.includes(token)) throw new HttpError(401, 'Unauthorized');
    return token;
  }

  private rateLimit(token: string) {
    const { limit, windowMs } = this.options.rateLimit ?? { limit: 300, windowMs: 60_000 };
    const now = Date.now();
    const recent = (this.hits.get(token) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.hits.set(token, recent);
    if (recent.length > limit) throw new HttpError(429, 'Too many requests', { 'retry-after': String(Math.ceil(windowMs / 1000)) });
  }

  private route(req: IncomingMessage, url: URL, body: any): { status: number; body?: unknown } {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    if (path.startsWith('/_fake/')) return this.control(method, path, body);
    this.requests.push({ method, path, query, authorization: req.headers.authorization, body });
    if (this.forced429.count > 0) {
      this.forced429.count--;
      throw new HttpError(429, 'Too many requests', { 'retry-after': String(this.forced429.retryAfter) });
    }

    if (method === 'POST' && path === '/triggers') {
      this.rateLimit(this.auth(req, [SEED.ingestToken]));
      return this.sourceTrigger(body);
    }
    const org = /^\/o\/([^/]+)(\/.*)$/.exec(path);
    if (!org) throw new HttpError(404, `Cannot ${method} ${path}`);
    const [, slug, rest] = org;
    const heartbeat = /^\/heartbeats\/([^/]+)\/ping$/.exec(rest);
    if (method === 'POST' && heartbeat) {
      const token = this.auth(req, [...this.heartbeats.values()].map((h) => h.token));
      this.rateLimit(token);
      this.needOrg(slug);
      const beat = this.heartbeats.get(decodeURIComponent(heartbeat[1]));
      if (!beat) throw new HttpError(404, `Heartbeat not found: ${heartbeat[1]}`);
      if (beat.token !== token) throw new HttpError(401, 'Unauthorized');
      beat.pings.push(new Date().toISOString());
      return { status: 204 };
    }
    this.rateLimit(this.auth(req, [SEED.apiKey]));
    this.needOrg(slug);

    if (method === 'POST' && rest === '/triggers') return this.manualTrigger(body);
    if (method === 'POST' && rest === '/incidents') return this.declare(body);
    if (method === 'GET' && rest === '/incidents') return this.list(query);
    const sub = /^\/incidents\/([^/]+)\/(events|state)$/.exec(rest);
    if (sub) {
      const incident = this.find(decodeURIComponent(sub[1]));
      if (sub[2] === 'events' && method === 'GET') return { status: 200, body: this.events(incident, query) };
      if (sub[2] === 'events' && method === 'POST') return this.appendRoute(incident, body);
      if (sub[2] === 'state' && method === 'GET') return this.state(incident, query);
    }
    throw new HttpError(404, `Cannot ${method} ${path}`);
  }

  private needOrg(slug: string) {
    if (slug !== SEED.orgSlug) throw new HttpError(404, `Organization not found: ${slug}`);
  }

  private find(id: string): FakeIncident {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) throw new HttpError(404, `Incident not found: ${id}`);
    return incident;
  }

  private view(i: FakeIncident) {
    const { events: _events, connectionId: _c, dedupKey: _d, ...view } = i;
    return view;
  }

  private result(outcome: string, incident: FakeIncident, reason?: string) {
    return {
      outcome,
      ...(reason && { reason }),
      incidentId: incident.id,
      tenantId: 'tenant_acme',
      entity: incident.alertEntity,
      proposedSeverity: incident.severity,
      workspaceUrl: `${this.url}/o/${SEED.orgSlug}/incidents/${incident.id}`,
    };
  }

  private sourceTrigger(body: any) {
    const bad = (m: string) => new HttpError(400, m);
    if (!body || body.landfallSource !== 'remote') throw bad('landfallSource must be "remote"');
    if (typeof body.connectionId !== 'string' || !body.connectionId) throw bad('connectionId is required');
    if (typeof body.title !== 'string' || !body.title) throw bad('title is required');
    if (!['sev1', 'sev2', 'sev3', 'sev4'].includes(body.severity)) throw bad('severity must be one of sev1, sev2, sev3, sev4');
    if (body.kind !== undefined && !['trigger', 'recovery'].includes(body.kind)) throw bad('kind must be trigger or recovery');
    if (body.entityHints !== undefined && !Array.isArray(body.entityHints)) throw bad('entityHints must be an array');
    if (body.occurredAt !== undefined && Number.isNaN(Date.parse(body.occurredAt))) throw bad('occurredAt must be an ISO date');
    if (body.url !== undefined && !/^https?:\/\//.test(body.url)) throw bad('url must be a URL');
    const connection = this.connections.get(body.connectionId);
    if (!connection) throw new HttpError(422, `Remote source trigger refused: connection ${body.connectionId} was not found`);
    if (!connection.healthy) throw new HttpError(422, `Remote source trigger refused: connection ${body.connectionId} is not healthy (last health check failed)`);

    const key: string | undefined = body.dedupKey;
    const open = key ? this.incidents.find((i) => i.connectionId === body.connectionId && i.dedupKey === key && !ENDED.includes(i.status)) : undefined;
    if (body.kind === 'recovery') {
      if (!open) {
        const placeholder = { id: 'none', alertEntity: null, severity: body.severity } as FakeIncident;
        return { status: 200, body: { ...this.result('ignored', placeholder, 'no open incident for this dedupKey'), incidentId: null } };
      }
      this.append(open, 'trigger.recovered', { dedupKey: key, title: body.title, summary: body.summary }, 'system');
      return { status: 200, body: this.result('recorded', open) };
    }
    if (open) {
      this.append(open, 'trigger.repeated', { dedupKey: key, title: body.title, summary: body.summary }, 'system');
      return { status: 200, body: this.result('attached', open) };
    }
    const hint = (body.entityHints as string[] | undefined)?.[0];
    const [kind, id] = hint?.includes(':') ? hint.split(/:(.*)/s) : [undefined, undefined];
    const incident = this.seed({
      title: body.title,
      severity: body.severity,
      alertSource: 'remote',
      alertContext: { summary: body.summary, url: body.url, occurredAt: body.occurredAt, entityHints: body.entityHints },
      alertEntity: kind && id ? { kind, id } : null,
      connectionId: body.connectionId,
      ...(key && { dedupKey: key }),
    });
    this.append(incident, 'incident.triggered', { source: 'remote', title: body.title, severity: body.severity, dedupKey: key, summary: body.summary }, 'system');
    return { status: 201, body: this.result('opened', incident) };
  }

  private manualTrigger(body: any) {
    if (!body || typeof body.title !== 'string' || !body.title) throw new HttpError(400, 'title is required');
    if (body.severity !== undefined && !['sev1', 'sev2', 'sev3', 'sev4'].includes(body.severity)) throw new HttpError(400, 'severity must be one of sev1, sev2, sev3, sev4');
    const incident = this.seed({
      title: body.title,
      severity: body.severity ?? 'sev3',
      alertSource: 'manual',
      alertEntity: typeof body.entityHint === 'string' && body.entityHint.includes(':') ? { kind: body.entityHint.split(':')[0], id: body.entityHint.split(':').slice(1).join(':') } : null,
    });
    return { status: 201, body: this.result('opened', incident) };
  }

  private declare(body: any) {
    if (body?.severity !== undefined && !['sev1', 'sev2', 'sev3', 'sev4'].includes(body.severity)) throw new HttpError(400, 'severity must be one of sev1, sev2, sev3, sev4');
    const incident = this.seed({ title: body?.title || 'Untitled incident', severity: body?.severity ?? 'sev3' });
    if (body?.description) this.append(incident, 'chat.message', { text: body.description, displayName: 'Fake Member' });
    return { status: 201, body: this.view(incident) };
  }

  private list(query: Record<string, string>) {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be an integer between 1 and 200');
    const status = query.status ?? 'open';
    if (!['open', 'closed', 'all'].includes(status)) throw new HttpError(400, 'status must be open, closed or all');
    const q = query.q?.toLowerCase();
    // Newest first, like a list view. The cursor is the offset into this order.
    const all = [...this.incidents]
      .sort((a, b) => b.number - a.number)
      .filter((i) => status === 'all' || (status === 'open') === !ENDED.includes(i.status))
      .filter((i) => !q || i.title.toLowerCase().includes(q));
    const offset = query.cursor ? Number(query.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'invalid cursor');
    const items = all.slice(offset, offset + limit).map((i) => this.view(i));
    return { status: 200, body: { items, nextCursor: offset + limit < all.length ? String(offset + limit) : null } };
  }

  private events(incident: FakeIncident, query: Record<string, string>) {
    let rows = incident.events;
    if (query.sinceSeq !== undefined) rows = rows.filter((e) => e.seq > Number(query.sinceSeq));
    if (query.beforeSeq !== undefined) rows = rows.filter((e) => e.seq < Number(query.beforeSeq));
    if (query.limit !== undefined) {
      const limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, 'limit must be an integer between 1 and 500');
      rows = rows.slice(-limit); // the newest `limit` rows, still ascending
    }
    return rows;
  }

  private state(incident: FakeIncident, query: Record<string, string>) {
    const through = query.throughSeq === undefined ? undefined : Number(query.throughSeq);
    const rows = incident.events.filter((e) => through === undefined || e.seq <= through);
    let status = 'open';
    for (const e of rows) if (e.type === 'status.changed' && typeof e.payload.status === 'string') status = e.payload.status;
    return {
      status: 200,
      body: {
        incidentId: incident.id,
        ...(through !== undefined && { throughSeq: through }),
        state: { number: incident.number, displayId: incident.displayId, title: incident.title, severity: incident.severity, status, eventCount: rows.length, lastSeq: rows.at(-1)?.seq ?? null },
      },
    };
  }

  private appendRoute(incident: FakeIncident, body: any) {
    if (this.concurrentWrites > 0) {
      this.concurrentWrites--;
      this.append(incident, 'chat.message', { text: 'a colleague wrote first', displayName: 'Colleague' });
    }
    if (!body || typeof body.type !== 'string' || !body.type) throw new HttpError(400, 'type is required');
    if (!Number.isInteger(body.expectedSeq)) throw new HttpError(400, 'expectedSeq must be an integer');
    if (body.payload === null || typeof body.payload !== 'object' || Array.isArray(body.payload)) throw new HttpError(400, 'payload must be an object');
    if (REFUSED_TYPES.includes(body.type)) throw new HttpError(400, `${body.type} cannot be appended through this route`);
    if (body.type === 'remediation.applied-externally') {
      const p = body.payload;
      if (!Number.isInteger(p.sourceSeq) || p.sourceSeq < 0) throw new HttpError(400, 'sourceSeq must be a non-negative integer');
      if (p.action !== undefined && (typeof p.action !== 'string' || !p.action.trim() || p.action.length > 500)) throw new HttpError(400, 'action must be 1 to 500 characters');
      if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 1000)) throw new HttpError(400, 'note must be at most 1000 characters');
      const source = incident.events.find((e) => e.seq === p.sourceSeq);
      if (!source || !['remediation.proposed', 'edge.action.proposed'].includes(source.type)) throw new HttpError(400, `Event ${p.sourceSeq} is not a suggestion (remediation.proposed or edge.action.proposed)`);
    }
    if (body.expectedSeq !== incident.events.length) throw new HttpError(409, `Conflict: expectedSeq ${body.expectedSeq}, next seq is ${incident.events.length}`);
    const payload = { ...body.payload };
    if (HUMAN_STAMPED.includes(body.type)) payload.displayName = 'Fake Member';
    return { status: 201, body: this.append(incident, body.type, payload) };
  }

  private control(method: string, path: string, body: any): { status: number; body?: unknown } {
    if (method === 'GET' && path === '/_fake/state') {
      return {
        status: 200,
        body: {
          incidents: this.incidents,
          heartbeats: Object.fromEntries([...this.heartbeats].map(([name, h]) => [name, h.pings])),
          connections: Object.fromEntries(this.connections),
          requests: this.requests.length,
        },
      };
    }
    const status = /^\/_fake\/incidents\/([^/]+)\/status$/.exec(path);
    if (method === 'POST' && status) {
      const incident = this.find(decodeURIComponent(status[1]));
      if (typeof body?.status !== 'string') throw new HttpError(400, 'status is required');
      this.append(incident, 'status.changed', { status: body.status, from: incident.status });
      return { status: 200, body: this.view(incident) };
    }
    const connection = /^\/_fake\/connections\/([^/]+)$/.exec(path);
    if (method === 'POST' && connection) {
      this.connections.set(decodeURIComponent(connection[1]), { healthy: body?.healthy !== false });
      return { status: 200, body: Object.fromEntries(this.connections) };
    }
    throw new HttpError(404, `Cannot ${method} ${path}`);
  }
}

export const startFakeLandfall = (options?: FakeLandfallOptions) => new FakeLandfall(options).start();

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeLandfall({ port: Number(process.env.FAKE_LANDFALL_PORT ?? 7398) });
  console.info(`fake Landfall on ${fake.url}`);
  console.info(`  credential landfallApi: baseUrl=${fake.url} orgSlug=${SEED.orgSlug} apiKey=${SEED.apiKey} ingestToken=${SEED.ingestToken} connectionId=${SEED.connectionId}`);
  console.info(`  credential landfallHeartbeatApi: baseUrl=${fake.url} orgSlug=${SEED.orgSlug} token=${SEED.heartbeatToken} (heartbeat "${SEED.heartbeatName}")`);
  console.info(`  unhealthy connection (422): ${SEED.unhealthyConnectionId}`);
  console.info(`  GET ${fake.url}/_fake/state · POST /_fake/incidents/:id/status {"status":"resolved"} · POST /_fake/connections/:id {"healthy":false}`);
}
