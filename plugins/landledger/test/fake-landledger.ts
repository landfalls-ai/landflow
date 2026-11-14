/**
 * An in-memory Landledger API for the tests: the routes of Landledger's docs/reference/api.md the plugin calls, with
 * the rules that matter to it (scopes per key, a key must name the requester, idempotent creates, who may decide).
 * Fake keys only; nothing here talks to a real service. Every request is recorded; `failNext` makes the next call
 * answer an error.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Every scope a flow uses (not admin). */
export const KEY = 'll_test_key_full_000000000000000000';
/** read only. */
export const READ_KEY = 'll_test_key_read_000000000000000000';
/** admin (the trigger's registration). */
export const ADMIN_KEY = 'll_test_key_admin_00000000000000000';

const SCOPES: Record<string, string[]> = {
  [KEY]: ['read', 'requests:write', 'reservations:write', 'decisions:relay'],
  [READ_KEY]: ['read'],
  [ADMIN_KEY]: ['admin', 'read', 'requests:write', 'reservations:write', 'decisions:relay'],
};

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface FakeState {
  requests: Map<string, any>;
  /** The step's approvers per request id (emails), as Landledger resolves them. */
  approvers: Map<string, string[]>;
  reservations: Map<string, any>;
  webhooks: Map<string, any>;
  /** Idempotency key → request id. */
  keys: Map<string, string>;
}

export interface FakeLandledger {
  url: string;
  requests: FakeRequest[];
  state: FakeState;
  reset(): void;
  failNext(status: number, body?: unknown): void;
  close(): Promise<void>;
}

const fresh = (): FakeState => ({ requests: new Map(), approvers: new Map(), reservations: new Map(), webhooks: new Map(), keys: new Map() });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
const notFound = err(404, 'not_found', 'Not found');
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const BUDGETS = {
  month: '2026-11',
  currency: 'USD',
  versions: [],
  rows: [
    { code: 'ENG-AGENTS', name: 'Engineering agents', owner: 'amit.gal@landbright.test', monthToDate: '1200.500000', invoiced: '0.000000', budget: '2000.000000', forecast: '2400.000000', reserved: '300.000000', state: 'risk', available: '799.500000', variance: '400.000000', variancePct: '20.0', months: [] },
    { code: 'ENG-PLATFORM', name: 'Platform', owner: null, monthToDate: '10.000000', invoiced: '0.000000', budget: null, forecast: null, reserved: '0.000000', state: 'none', available: null, variance: null, variancePct: null, months: [] },
  ],
  totals: {},
};

export const SPEND = {
  from: '2026-11-01',
  to: '2026-11-30',
  basis: 'billing',
  by: 'costCenter',
  layer: 'direct',
  filters: [],
  currency: 'USD',
  total: { estimated: '1210.500000', invoiced: '0.000000', total: '1210.500000', provisional: '5.000000', previous: null, corrections: '0.000000' },
  groups: [
    { key: 'ENG-AGENTS', label: 'ENG-AGENTS', sub: 'Engineering agents', estimated: '1200.500000', invoiced: '0.000000', total: '1200.500000', previous: null, share: '99.2', provisional: '5.000000', clicklandUrl: null },
    { key: 'ENG-PLATFORM', label: 'ENG-PLATFORM', sub: 'Platform', estimated: '10.000000', invoiced: '0.000000', total: '10.000000', previous: null, share: '0.8', provisional: '0.000000', clicklandUrl: null },
  ],
  daily: { days: ['2026-11-01'], series: [] },
  attribution: { direct: '1210.500000', sharedPool: '0.000000', unallocated: '0.000000', total: '1210.500000', directShare: '100.0' },
  drill: 'service',
  warnings: [],
};

export async function startFakeLandledger(): Promise<FakeLandledger> {
  let state = fresh();
  const requests: FakeRequest[] = [];
  let failure: { status: number; body?: unknown } | undefined;
  let counter = 0;
  const next = (prefix: string) => `${prefix}_${++counter}`;

  function summary(request: any) {
    const { evidence: _e, steps: _s, decisions: _d, reservations: _r, related: _rel, ...rest } = request;
    return { ...rest, stepLabel: request.status === 'pending' ? 'Step 1 of 1 · Budget owner' : request.status, stepCount: 1, budgetLeftAfter: null };
  }

  function route(r: FakeRequest): { status?: number; body?: unknown } {
    if (r.path === '/api/health') return { body: { status: 'ok', postgres: 'ok', migrations: 9, version: '0.2.0' } };
    const key = String(r.headers.authorization ?? '').replace(/^Bearer /, '');
    const scopes = SCOPES[key];
    if (!scopes) return err(401, 'unauthorized', 'Invalid API key');
    const need = (scope: string) => (scopes.includes(scope) || scopes.includes('admin') ? undefined : err(403, 'forbidden', `This needs the ${scope} scope`));
    if (failure) {
      const f = failure;
      failure = undefined;
      return { status: f.status, body: f.body ?? { error: { code: 'internal', message: 'boom' } } };
    }
    const [head, id, sub] = r.path.split('/').filter(Boolean).slice(1); // after "api"
    switch (`${r.method} ${head}${id !== undefined ? '/:id' : ''}${sub ? `/${sub}` : ''}`) {
      case 'GET auth/:id':
        if (id !== 'me') break;
        return { body: { kind: 'key', user: { id: 'key_1', name: 'Landflow flows', email: null, roles: [], groups: [] }, scopes, authMode: 'oidc' } };
      case 'GET budgets':
        return need('read') ?? { body: { ...BUDGETS, month: r.query.month ?? BUDGETS.month } };
      case 'GET spend':
        return need('read') ?? { body: { ...SPEND, by: r.query.by ?? 'costCenter' } };
      case 'GET periods':
        return need('read') ?? { body: { periods: [{ month: '2026-10', status: 'locked', openedAt: '2026-10-01T00:00:00.000Z', closingBy: 'Dana', closingAt: '2026-11-02T08:00:00.000Z', lockedBy: 'Dana', lockedAt: '2026-11-03T08:00:00.000Z' }] } };
      case 'GET requests':
        return need('read') ?? { body: { requests: [...state.requests.values()].reverse().map(summary), counts: { waiting: 0, mine: 0, decided: 0, open: state.requests.size } } };
      case 'POST requests': {
        const denied = need('requests:write');
        if (denied) return denied;
        const b = r.body ?? {};
        if (!b.requester) return err(400, 'bad_request', 'A key must say who asks: requester');
        if (!b.origin) return err(400, 'bad_request', 'A key must say where the request comes from: origin');
        if (b.requester.kind === 'agent' && !b.requester.sponsor) return err(400, 'bad_request', 'An agent needs a sponsor');
        if (typeof b.amount?.amount !== 'string') return err(400, 'bad_request', 'amount.amount is a decimal string');
        const idem = b.idempotencyKey ? `${key}:${b.idempotencyKey}` : undefined;
        if (idem && state.keys.has(idem)) return { status: 200, body: { request: state.requests.get(state.keys.get(idem)!) } };
        const reqId = next('req');
        const person = b.requester.kind === 'agent' ? b.requester.sponsor : b.requester.person;
        const request = {
          id: reqId,
          number: `R-${counter}`,
          kind: b.kind,
          title: b.title,
          note: b.note ?? '',
          status: b.submit === false ? 'draft' : 'pending',
          costCenter: { code: b.costCenter, name: b.costCenter, owner: null },
          amount: { amount: Number(b.amount.amount).toFixed(6), currency: b.amount.currency },
          recurrence: b.recurrence,
          start: b.start ?? '2026-11-14',
          end: b.end ?? null,
          evidence: b.evidence ?? {},
          origin: b.origin,
          related: b.related ?? [],
          requester: b.requester.kind === 'agent' ? { kind: 'agent', agent: b.requester.agent, sponsor: { id: 'usr_s', name: 'Sponsor', email: person.email ?? null, sub: person.sub ?? null } } : { kind: 'person', person: { id: 'usr_r', name: 'Requester', email: person.email ?? null, sub: person.sub ?? null } },
          requesterEmail: person.email ?? null,
          createdVia: 'key',
          steps: [],
          decisions: [],
          reservations: [],
          createdAt: '2026-11-14T15:00:00.000Z',
        };
        state.requests.set(reqId, request);
        state.approvers.set(reqId, ['amit.gal@landbright.test']);
        if (idem) state.keys.set(idem, reqId);
        return { status: 201, body: { request } };
      }
      case 'GET requests/:id': {
        const denied = need('read');
        if (denied) return denied;
        const request = state.requests.get(id);
        if (!request) return notFound;
        const evidence = { month: '2026-11', currency: 'USD', adds: request.amount.amount, why: 'In the budget owner\'s range' };
        return { body: { request, evidence, evidenceSha256: sha({ request, evidence }) } };
      }
      case 'POST requests/:id/decisions': {
        if (!scopes.includes('decisions:relay')) return err(403, 'forbidden', 'An API key without decisions:relay can\'t decide');
        const request = state.requests.get(id);
        if (!request) return notFound;
        const b = r.body ?? {};
        if (!b.person) return err(403, 'forbidden', 'A relay names the person');
        if (!/^[0-9a-f]{64}$/.test(String(b.evidenceSha256))) return err(400, 'bad_request', 'evidenceSha256');
        if (request.status !== 'pending') return err(409, 'conflict', 'The request is not pending');
        const email = String(b.person.email ?? '');
        if (email && email === request.requesterEmail) return err(403, 'forbidden', 'The requester can\'t decide their own request');
        if (!(state.approvers.get(id) ?? []).includes(email)) return err(403, 'forbidden', `${email || b.person.sub} is not among this step's approvers`);
        const decision = { id: next('dec'), step: 1, stepKey: 'owner', outcome: b.outcome, comment: b.comment ?? '', person: { id: 'usr_a', name: 'Amit Gal', email, sub: null }, at: '2026-11-14T15:05:00.000Z', evidenceSha256: b.evidenceSha256, via: 'relay', relayedBy: 'Landflow flows', channel: b.channel ?? null };
        request.decisions.push(decision);
        request.status = b.outcome === 'approve' ? 'approved' : 'rejected';
        return { status: 201, body: { request, decision } };
      }
      case 'POST requests/:id/applied': {
        const denied = need('requests:write');
        if (denied) return denied;
        const request = state.requests.get(id);
        if (!request) return notFound;
        if (request.status !== 'approved') return err(409, 'conflict', 'Only an approved request can be applied');
        request.status = 'applied';
        request.appliedNote = r.body?.note ?? '';
        return { body: { request } };
      }
      case 'POST reservations': {
        const denied = need('reservations:write');
        if (denied) return denied;
        const request = state.requests.get(r.body?.requestId);
        if (!request) return notFound;
        if (!['approved', 'applied'].includes(request.status)) return err(409, 'conflict', 'Only an approved request reserves');
        const month = r.body.month ?? '2026-12';
        const existing = [...state.reservations.values()].find((x) => x.requestId === request.id && x.month === month);
        if (existing) return { status: 200, body: { reservation: existing } };
        const reservation = { id: next('res'), requestId: request.id, requestTitle: request.title, costCenter: request.costCenter.code, month, amount: Number(r.body.amount ?? request.amount.amount).toFixed(6), consumed: '0.000000', remaining: Number(r.body.amount ?? request.amount.amount).toFixed(6), status: 'reserved', createdAt: '2026-11-14T15:10:00.000Z', closedAt: null, note: '' };
        state.reservations.set(reservation.id, reservation);
        return { status: 201, body: { reservation } };
      }
      case 'POST reservations/:id/release': {
        const denied = need('reservations:write');
        if (denied) return denied;
        const reservation = state.reservations.get(id);
        if (!reservation) return notFound;
        Object.assign(reservation, { status: 'released', remaining: '0.000000', note: r.body?.reason ?? '', closedAt: '2026-11-14T15:20:00.000Z' });
        return { body: { reservation } };
      }
      case 'GET webhooks': {
        const denied = need('admin');
        return denied ?? { body: { webhooks: [...state.webhooks.values()] } };
      }
      case 'POST webhooks': {
        const denied = need('admin');
        if (denied) return denied;
        const hook = { id: next('wh'), url: r.body.url, events: r.body.events, description: r.body.description ?? '', createdBy: 'key_admin', createdAt: '2026-11-14T15:00:00.000Z' };
        state.webhooks.set(hook.id, hook);
        return { status: 201, body: { ...hook, secret: `whsec_${Buffer.from(`secret-of-${hook.id}`).toString('base64')}` } };
      }
      case 'DELETE webhooks/:id': {
        const denied = need('admin');
        if (denied) return denied;
        return state.webhooks.delete(id) ? { status: 204 } : notFound;
      }
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
