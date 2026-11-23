/**
 * An in-memory Clickland API for the tests (the routes of Clickland's docs/reference/api.md the plugin calls). Fake
 * keys only; nothing here talks to a real service. Every request is recorded; `failNext` makes the next call answer an
 * error.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export const KEY = 'ck_test_key_0000000000000000000000';

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface FakeState {
  alerts: any[];
  /** Events per alert id, newest first. */
  events: Record<string, any[]>;
  notes: any[];
  webhooks: Map<string, any>;
  views: Map<string, any>;
}

export interface FakeClickland {
  url: string;
  requests: FakeRequest[];
  state: FakeState;
  reset(): void;
  failNext(status: number, body?: unknown): void;
  close(): Promise<void>;
}

const fresh = (): FakeState => ({ alerts: [], events: {}, notes: [], webhooks: new Map(), views: new Map() });

const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };

export async function startFakeClickland(): Promise<FakeClickland> {
  let state = fresh();
  const requests: FakeRequest[] = [];
  let failure: { status: number; body?: unknown } | undefined;
  let counter = 0;
  const next = (prefix: string) => `${prefix}_${++counter}`;

  function route(r: FakeRequest): { status?: number; body?: unknown } {
    if (r.path === '/api/health') return { body: { status: 'ok', clickhouse: 'ok', postgres: 'ok', version: '0.1.0' } };
    if (r.headers.authorization !== `Bearer ${KEY}`) return { status: 401, body: { error: { code: 'unauthorized', message: 'Invalid API key' } } };
    if (failure) {
      const f = failure;
      failure = undefined;
      return { status: f.status, body: f.body ?? { error: { code: 'internal', message: 'boom' } } };
    }
    const parts = r.path.split('/').filter(Boolean).slice(1); // after "api"
    const [head, id, sub, index] = parts;
    switch (`${r.method} ${head}${id !== undefined ? '/:id' : ''}${sub ? `/${sub}` : ''}${index !== undefined ? '/:i' : ''}`) {
      case 'POST search':
        if (r.body?.query === 'bad(') return { status: 400, body: { error: { code: 'bad_request', message: 'Unexpected end of query', details: { position: 4 } } } };
        return { body: { rows: [{ cursor: 'c2', timestamp: '2026-11-14T15:00:02.000Z', service: 'api', body: 'second' }, { cursor: 'c1', timestamp: '2026-11-14T15:00:01.000Z', service: 'api', body: 'first' }], nextCursor: 'c1', stats: { rowsRead: 2, bytesRead: 10, elapsedMs: 3 } } };
      case 'POST search/:id':
        if (id === 'histogram') return { body: { bucketSeconds: 60, series: [{ key: 'api', points: [['2026-11-14T15:00:00.000Z', 12]] }] } };
        break;
      case 'POST patterns':
        return { body: { patterns: [{ template: 'Connection to <*> refused after <NUM> ms', count: 812, share: 0.41, example: 'x', services: ['api'] }], sampled: 5000, total: 9120 } };
      case 'GET traces/:id':
        return id === 'missing' ? notFound : { body: { traceId: id, spans: [{ spanId: 's1' }], services: ['api'], durationMs: 12, errorCount: 0, startedAt: '2026-11-14T15:00:00.000Z' } };
      case 'GET services':
        return { body: { services: [{ name: 'api', requests: 10, errors: 1, errorRate: 0.1, p50Ms: 4, p95Ms: 20, p99Ms: 40, logErrors: 2 }, { name: 'checkout', requests: 5, errors: 0, errorRate: 0, p50Ms: 3, p95Ms: 9, p99Ms: 11, logErrors: 0 }] } };
      case 'GET metrics/:id':
        if (id === 'names') return { body: { metrics: [{ name: 'http.server.duration', type: 'histogram', unit: 'ms', description: '', services: ['api'] }] } };
        break;
      case 'POST metrics/:id':
        if (id === 'query') return { body: { bucketSeconds: 60, series: [{ key: 'api', points: [] }] } };
        break;
      case 'GET alerts':
        return { body: { alerts: state.alerts } };
      case 'POST alerts': {
        const alert = { id: next('al'), ...r.body, states: [] };
        state.alerts.push(alert);
        return { status: 201, body: alert };
      }
      case 'GET alerts/:id': {
        const alert = state.alerts.find((a) => a.id === id);
        return alert ? { body: alert } : notFound;
      }
      case 'PUT alerts/:id': {
        const index_ = state.alerts.findIndex((a) => a.id === id);
        if (index_ < 0) return notFound;
        state.alerts[index_] = { ...r.body, id, states: state.alerts[index_].states };
        return { body: state.alerts[index_] };
      }
      case 'DELETE alerts/:id': {
        const before = state.alerts.length;
        state.alerts = state.alerts.filter((a) => a.id !== id);
        return state.alerts.length < before ? { status: 204 } : notFound;
      }
      case 'GET alerts/:id/events': {
        const limit = Number(r.query.limit ?? 50);
        return { body: { events: (state.events[id] ?? []).slice(0, limit) } };
      }
      case 'GET notes': {
        const limit = Number(r.query.limit ?? 50);
        return { body: { notes: state.notes.filter((n) => !r.query.service || n.service === r.query.service).slice(0, limit) } };
      }
      case 'POST notes': {
        const note = { id: next('nt'), ...r.body, createdAt: new Date().toISOString() };
        state.notes.unshift(note);
        return { status: 201, body: note };
      }
      case 'POST knowledge/:id':
        if (id === 'search') return { body: { results: [{ pageContent: `About: ${r.body?.query}`, score: 0.83, metadata: { kind: 'note', title: 'Checkout timeouts', service: 'checkout', url: 'http://127.0.0.1:4711/notes/nt_1', id: 'nt_1' } }] } };
        break;
      case 'POST views': {
        const view = { id: next('vw'), spec: r.body.spec, pinned: Boolean(r.body.pinned), title: r.body.spec?.title, version: 1 };
        state.views.set(view.id, view);
        return { status: 201, body: { id: view.id, url: `http://127.0.0.1:4711/views/${view.id}`, resourceUri: 'ui://clickland/view', marker: `[[clickland:view:${view.id}]]` } };
      }
      case 'GET views':
        return { body: { views: [...state.views.values()].filter((v) => r.query.pinned !== 'true' || v.pinned).map(({ id: vid, title, pinned }) => ({ id: vid, title, pinned, createdAt: '2026-11-14T15:00:00.000Z', createdBy: 'test' })) } };
      case 'GET views/:id':
        return state.views.has(id) ? { body: state.views.get(id) } : notFound;
      case 'PUT views/:id': {
        const view = state.views.get(id);
        if (!view) return notFound;
        if (r.body.version !== undefined && r.body.version !== view.version) return { status: 409, body: { error: { code: 'conflict', message: 'The view changed since version ' + r.body.version } } };
        const { version: _v, ...changes } = r.body;
        Object.assign(view, changes, { version: view.version + 1 });
        return { body: view };
      }
      case 'POST views/:id/panels': {
        const view = state.views.get(id);
        if (!view) return notFound;
        const panels = [...view.spec.panels];
        panels.splice(r.body.position ?? panels.length, 0, r.body.panel);
        view.spec = { ...view.spec, panels };
        view.version++;
        return { body: view };
      }
      case 'DELETE views/:id/panels/:i': {
        const view = state.views.get(id);
        if (!view) return notFound;
        view.spec = { ...view.spec, panels: view.spec.panels.filter((_: unknown, n: number) => n !== Number(index)) };
        view.version++;
        return { body: view };
      }
      case 'POST webhooks': {
        const hook = { id: next('wh'), url: r.body.url, events: r.body.events, alertId: r.body.alertId ?? null, description: r.body.description ?? '', createdAt: new Date().toISOString() };
        state.webhooks.set(hook.id, hook);
        return { status: 201, body: { ...hook, secret: `whsec_${Buffer.from(`secret-of-${hook.id}`).toString('base64')}` } };
      }
      case 'GET webhooks/:id':
        return state.webhooks.has(id) ? { body: state.webhooks.get(id) } : notFound;
      case 'DELETE webhooks/:id':
        return state.webhooks.delete(id) ? { status: 204 } : notFound;
    }
    return notFound;
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      const request: FakeRequest = { method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
      requests.push(request);
      const reply = route(request);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(reply.body === undefined || reply.status === 204 ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get state() {
      return state;
    },
    reset() {
      state = fresh();
      counter = 0;
      requests.length = 0;
      failure = undefined;
    },
    failNext(status, body) {
      failure = { status, body };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
