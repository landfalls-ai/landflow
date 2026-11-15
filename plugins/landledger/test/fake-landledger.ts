/**
 * An in-memory Landledger API for the tests: the routes of Landledger's docs/reference/api.md the plugin calls, with
 * the rules of the reviewed wave 2 contract (c3c0115) that matter to it: scopes per key (a relay key holds neither
 * requests:write nor admin; webhooks:write manages only its own subscriptions), a key must name the requester and that
 * person confirms (`awaiting_confirmation`), `createdBy` and `origin.verified` stamped by Landledger, idempotent creates
 * (same body 200, another body 409), decisions only from a person's session, and the raw Slack relay (the channel's
 * signature, team and app, a person's own link, the budget owner's step only, a card hash served within 30 minutes).
 * Fake keys only; nothing here talks to a real service. Every request is recorded; `failNext` makes the next call
 * answer an error. A test acts as a person with `Authorization: Person <email>`.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifySlackSignature } from '@landflow/sdk';

/** The flows' key: read, requests:write, reservations:write (Landflow's Landledger node). */
export const KEY = 'll_test_key_full_000000000000000000';
/** read only. */
export const READ_KEY = 'll_test_key_read_000000000000000000';
/** webhooks:write only (a Landledger Trigger's own credential). */
export const WEBHOOKS_KEY = 'll_test_key_hooks_00000000000000000';
/** decisions:relay only (Decision → Relay's own credential). */
export const RELAY_KEY = 'll_test_key_relay_00000000000000000';
/** A key made before the review: decisions:relay with requests:write (Landledger now refuses to mint one). */
export const MIXED_RELAY_KEY = 'll_test_key_mixed_00000000000000000';
/** admin (every scope). */
export const ADMIN_KEY = 'll_test_key_admin_00000000000000000';
/** notes:draft only (Note → Submit Draft's own credential). */
export const NOTES_KEY = 'll_test_key_notes_00000000000000000';
/** Another flow's key with requests:write: what a forged request would be raised with. */
export const OTHER_KEY = 'll_test_key_other_00000000000000000';

const KEYS: Record<string, { id: string; name: string; scopes: string[] }> = {
  [KEY]: { id: 'key_flows', name: 'Landflow flows', scopes: ['read', 'requests:write', 'reservations:write'] },
  [READ_KEY]: { id: 'key_read', name: 'Read only', scopes: ['read'] },
  [WEBHOOKS_KEY]: { id: 'key_hooks', name: 'Landflow webhooks', scopes: ['webhooks:write'] },
  [RELAY_KEY]: { id: 'key_relay', name: 'Landflow relay', scopes: ['decisions:relay'] },
  [MIXED_RELAY_KEY]: { id: 'key_mixed', name: 'Old flows key', scopes: ['read', 'requests:write', 'decisions:relay'] },
  [ADMIN_KEY]: { id: 'key_admin', name: 'Admin', scopes: ['admin'] },
  [OTHER_KEY]: { id: 'key_other', name: 'Someone else', scopes: ['read', 'requests:write'] },
  [NOTES_KEY]: { id: 'key_notes', name: 'Landflow notes', scopes: ['notes:draft'] },
};

/** The relay channel the fake knows: Slack, with this signing secret, team and app. */
export const SLACK_CHANNEL = { id: 'rch_slack', signingSecret: 'test-signing-secret-landledger', teamId: 'T_LANDDEV', appId: 'A_LANDLEDGER' };

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
  /** Idempotency key → request id and the body it came with. */
  keys: Map<string, { id: string; body: string }>;
  /** The workflows each key id is bound to (its `landflow_run` origins are `verified`). */
  bound: Map<string, string[]>;
  /** Slack member id → the person's email: the links people made from their own session. */
  links: Map<string, string>;
  /** Evidence hashes served per request id, with when (ms). */
  served: Map<string, Array<{ sha: string; at: number }>>;
  /** Note drafts per `month|costCenter`, every version kept. */
  notes: Map<string, any>;
}

export interface FakeLandledger {
  url: string;
  requests: FakeRequest[];
  state: FakeState;
  reset(): void;
  failNext(status: number, body?: unknown): void;
  close(): Promise<void>;
}

const fresh = (): FakeState => ({
  requests: new Map(),
  approvers: new Map(),
  reservations: new Map(),
  webhooks: new Map(),
  keys: new Map(),
  bound: new Map(),
  links: new Map([
    ['U_AMIT', 'amit.gal@landbright.test'],
    ['U_EDEN', 'eden.tzur@landbright.test'],
    ['U_SHIRA', 'shira.navon@landbright.test'],
    ['U_TAL', 'tal.levi@landbright.test'],
  ]),
  served: new Map(),
  notes: new Map(),
});
const RELAYABLE_KINDS = ['infra_change', 'ai_budget', 'tool_or_seat', 'other'];
const STALE_MS = 30 * 60 * 1000;
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

/** The contracts the fake knows (`GET /api/contracts/seats`): Linear grants the Landbright app `linear`. */
export const CONTRACTS = [
  {
    id: 'con_linear',
    version: 1,
    vendor: 'Linear',
    product: 'Business',
    costCenter: { code: 'ENG-PLATFORM', name: 'Platform' },
    tcv: '3000.000000',
    annualValue: '3000.000000',
    termStart: '2026-01-01',
    termEnd: '2026-12-31',
    termMonths: 12,
    seats: { paid: 20, used: 17, reserved: 1, left: 2 },
    seatPrice: '12.500000',
    renewalDate: '2027-01-01',
    landbrightApp: 'linear',
  },
];

/** The month the fake has closed as far as the notes (its accrual accepted, the snapshot frozen). */
export const NOTES_MONTH = '2026-10';
/** What the notes may cite (Landledger's NoteFigures): the month as a whole and one cost center. */
export const NOTE_FIGURES = [
  {
    costCenter: 'TOTAL', name: 'The month', actual: '1210.500000', budget: '2000.000000', forecastDay10: '1300.000000',
    varianceBudget: '-789.500000', varianceBudgetPct: '-39.5', varianceForecast: '-89.500000',
    drivers: [{ dimension: 'service', key: 'landflow-host', label: 'landflow-host', amount: '900.000000', previous: '700.000000', change: '200.000000' }],
  },
  {
    costCenter: 'ENG-AGENTS', name: 'Engineering agents', actual: '1200.500000', budget: '2000.000000', forecastDay10: '1250.000000',
    varianceBudget: '-799.500000', varianceBudgetPct: '-40.0', varianceForecast: '-49.500000',
    drivers: [{ dimension: 'model', key: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', amount: '800.250000', previous: '650.000000', change: '150.250000' }],
  },
];
/** The frozen snapshot's sha256. */
export const SNAPSHOT_SHA = createHash('sha256').update(JSON.stringify(NOTE_FIGURES)).digest('hex');
/** The estimated cost of services over any window (`GET /api/cost/window`). */
export const WINDOW_COST: Record<string, string> = { checkout: '41.250000', 'landflow-host': '12.000000' };

const CITE_FIELD: Record<string, string> = { actual: 'actual', budget: 'budget', forecast_day10: 'forecastDay10', variance_budget: 'varianceBudget', variance_forecast: 'varianceForecast' };
/** The snapshot's figure a cite names, or undefined. */
function citedValue(figures: any, cite: any): string | undefined {
  if (CITE_FIELD[cite.figure]) return figures[CITE_FIELD[cite.figure]] ?? undefined;
  const dimension = String(cite.figure).replace('driver_', '');
  return figures.drivers.find((d: any) => d.dimension === dimension && d.key === cite.key)?.change;
}
const cents = (value: unknown) => Math.round(Number(value) * 100);

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

  function serve(requestId: string, request: any) {
    const evidence = { month: '2026-11', currency: 'USD', adds: request.amount.amount, why: 'In the budget owner\'s range' };
    const evidenceSha256 = sha({ request, evidence });
    const list = state.served.get(requestId) ?? [];
    list.push({ sha: evidenceSha256, at: Date.now() });
    state.served.set(requestId, list);
    return { request, evidence, evidenceSha256, servedAt: new Date().toISOString() };
  }

  /** A person's decision on the pending step (a session, or a verified relay press); the rules Landledger keeps. */
  function decide(request: any, email: string, outcome: string, comment: string, evidenceSha256: string, relay: { channelId: string; externalUserId: string } | null) {
    if (request.status !== 'pending') return err(409, 'conflict', 'The request is not pending');
    if (email && email === request.requesterEmail) return err(403, 'forbidden', 'The requester can\'t decide their own request');
    if (!(state.approvers.get(request.id) ?? []).includes(email)) return err(403, 'forbidden', `This step is for Budget Owners; ${email} isn't in it`);
    const served = (state.served.get(request.id) ?? []).filter((x) => x.sha === evidenceSha256).at(-1);
    if (!served || Date.now() - served.at > STALE_MS) return err(409, 'conflict', 'The request changed or the evidence is stale; reopen it');
    const decision = {
      id: next('dec'),
      step: 1,
      stepKey: request.steps[0]?.key ?? 'budget_owner',
      outcome,
      comment,
      person: { id: 'usr_a', name: email === 'shira.navon@landbright.test' ? 'Shira Navon' : 'Amit Gal', email, sub: null },
      at: '2026-11-14T15:05:00.000Z',
      evidenceSha256,
      via: relay ? 'relay' : 'console',
      relayedBy: relay ? 'Landflow relay' : null,
      channel: relay ? 'slack' : null,
      relay: relay ? { ...relay, kind: 'slack' } : null,
      ownerRole: 'owner',
    };
    request.decisions.push(decision);
    request.status = outcome === 'approve' ? 'approved' : 'rejected';
    if (request.seat && outcome === 'approve') request.seat.status = 'reserved';
    return { status: 201, body: { request, decision } };
  }

  function route(r: FakeRequest): { status?: number; body?: unknown } {
    if (r.path === '/api/health') return { body: { status: 'ok', postgres: 'ok', migrations: 9, version: '0.2.0' } };
    const auth = String(r.headers.authorization ?? '');
    const personEmail = auth.startsWith('Person ') ? auth.slice(7).trim().toLowerCase() : '';
    const key = auth.replace(/^Bearer /, '');
    const keyRow = KEYS[key];
    if (!keyRow && !personEmail) return err(401, 'unauthorized', 'Invalid API key');
    const scopes = personEmail ? ['read', 'requests:write'] : keyRow.scopes;
    const need = (scope: string) => (scopes.includes(scope) || scopes.includes('admin') ? undefined : err(403, 'forbidden', `This needs the ${scope} scope`));
    if (failure) {
      const f = failure;
      failure = undefined;
      return { status: f.status, body: f.body ?? { error: { code: 'internal', message: 'boom' } } };
    }
    const [head, id, sub, sub2] = r.path.split('/').filter(Boolean).slice(1); // after "api"
    switch (`${r.method} ${head}${id !== undefined ? '/:id' : ''}${sub ? `/${sub}` : ''}${sub2 ? `/${sub2}` : ''}`) {
      case 'GET auth/:id':
        if (id !== 'me') break;
        if (personEmail) return { body: { kind: 'person', user: { id: `usr_${personEmail}`, name: personEmail, email: personEmail, roles: [], groups: [] }, scopes, authMode: 'oidc' } };
        return { body: { kind: 'key', user: { id: keyRow.id, name: keyRow.name, email: null, roles: [], groups: [] }, scopes, authMode: 'oidc' } };
      case 'GET budgets':
        return need('read') ?? { body: { ...BUDGETS, month: r.query.month ?? BUDGETS.month } };
      case 'GET spend':
        return need('read') ?? { body: { ...SPEND, by: r.query.by ?? 'costCenter' } };
      case 'GET periods':
        return need('read') ?? { body: { periods: [{ month: '2026-10', status: 'locked', openedAt: '2026-10-01T00:00:00.000Z', closingBy: 'Dana', closingAt: '2026-11-02T08:00:00.000Z', lockedBy: 'Dana', lockedAt: '2026-11-03T08:00:00.000Z' }] } };
      case 'GET requests': {
        const denied = need('read');
        if (denied) return denied;
        let list = [...state.requests.values()].reverse();
        if (r.query.status) list = list.filter((x) => x.status === r.query.status);
        if (r.query.kind) list = list.filter((x) => x.kind === r.query.kind);
        if (r.query.box === 'mine' && keyRow) list = list.filter((x) => x.createdBy.id === keyRow.id);
        return { body: { requests: list.map(summary), counts: { waiting: 0, mine: 0, decided: 0, open: state.requests.size, confirm: 0 } } };
      }
      case 'POST requests': {
        const denied = need('requests:write');
        if (denied) return denied;
        const b = r.body ?? {};
        if (keyRow && !b.requester) return err(400, 'bad_request', 'A key must say who asks: requester');
        if (keyRow && !b.origin) return err(400, 'bad_request', 'A key must say where the request comes from: origin');
        if (b.requester?.kind === 'agent' && !b.requester.sponsor) return err(400, 'bad_request', 'An agent needs a sponsor');
        if (typeof b.amount?.amount !== 'string') return err(400, 'bad_request', 'amount.amount is a decimal string');
        if (b.amount.currency && b.amount.currency !== 'USD') return err(422, 'unprocessable', 'Only USD until FX is set up');
        if (b.seat && b.kind !== 'tool_or_seat') return err(400, 'bad_request', '`seat` is for a tool_or_seat request');
        if (b.seat) {
          const contract = CONTRACTS.find((c) => c.id === b.seat.contractId);
          if (!contract) return err(400, 'bad_request', `No contract ${b.seat.contractId}`);
          if (Math.round(Number(b.seat.seats ?? 1) * Number(b.seat.seatPrice) * 1e6) !== Math.round(Number(b.amount.amount) * 1e6) || b.recurrence !== 'monthly') {
            return err(400, 'bad_request', 'A seat request is seats × seat price a month');
          }
        }
        const caller = keyRow?.id ?? `usr_${personEmail}`;
        const idem = b.idempotencyKey ? `${caller}:${b.idempotencyKey}` : undefined;
        const { idempotencyKey: _k, ...rest } = b;
        const bodyText = JSON.stringify(rest);
        if (idem && state.keys.has(idem)) {
          const first = state.keys.get(idem)!;
          if (first.body !== bodyText) return err(409, 'conflict', 'This idempotency key came with another body');
          return { status: 200, body: { request: state.requests.get(first.id) } };
        }
        const reqId = next('req');
        const person = b.requester?.kind === 'agent' ? b.requester.sponsor : (b.requester?.person ?? { email: personEmail });
        const bound = keyRow ? (state.bound.get(keyRow.id) ?? []) : [];
        const verified = !keyRow || (b.origin?.type === 'landflow_run' && bound.includes(String(b.origin.workflowId)));
        const named = Boolean(keyRow);
        const status = b.submit === false ? 'draft' : named ? 'awaiting_confirmation' : 'pending';
        const request = {
          id: reqId,
          number: `R-${counter}`,
          kind: b.kind,
          title: b.title,
          note: b.note ?? '',
          status,
          costCenter: { code: b.costCenter, name: b.costCenter, owner: null },
          amount: { amount: Number(b.amount.amount).toFixed(6), currency: b.amount.currency ?? 'USD' },
          recurrence: b.recurrence,
          start: b.start ?? '2026-11-14',
          end: b.end ?? null,
          evidence: b.evidence ?? {},
          origin: { ...(b.origin ?? { type: 'console' }), verified },
          related: b.related ?? [],
          seat: b.seat ? { contractId: b.seat.contractId, vendor: 'Linear', product: 'Business', seats: Number(b.seat.seats ?? 1), seatPrice: Number(b.seat.seatPrice).toFixed(6), status: 'none' } : null,
          requester: b.requester?.kind === 'agent' ? { kind: 'agent', agent: b.requester.agent, sponsor: { id: 'usr_s', name: 'Sponsor', email: person.email ?? null, sub: person.sub ?? null } } : { kind: 'person', person: { id: 'usr_r', name: 'Requester', email: person.email ?? null, sub: person.sub ?? null } },
          requesterEmail: person.email ?? null,
          createdVia: keyRow ? 'key' : 'session',
          createdByKey: keyRow?.name ?? null,
          createdBy: keyRow ? { kind: 'key', id: keyRow.id, name: keyRow.name } : { kind: 'person', id: `usr_${personEmail}`, name: personEmail },
          confirmation: named ? { person: { id: 'usr_r', name: 'Requester', email: person.email ?? null, sub: person.sub ?? null }, status: 'waiting', at: null, reason: '' } : null,
          steps: [{ position: 1, key: 'budget_owner', label: 'Budget owner', status: 'pending' }],
          decisions: [],
          reservations: [],
          createdAt: '2026-11-14T15:00:00.000Z',
        };
        state.requests.set(reqId, request);
        state.approvers.set(reqId, ['amit.gal@landbright.test', 'shira.navon@landbright.test']);
        if (idem) state.keys.set(idem, { id: reqId, body: bodyText });
        return { status: 201, body: { request } };
      }
      case 'GET requests/:id': {
        const denied = need('read');
        if (denied) return denied;
        const request = state.requests.get(id);
        if (!request) return notFound;
        return { body: serve(id, request) };
      }
      case 'POST requests/:id/confirm': {
        const request = state.requests.get(id);
        if (!request) return notFound;
        if (!personEmail || personEmail !== request.requesterEmail) return err(403, 'forbidden', 'Only the named person confirms it, in their own session');
        if (request.status !== 'awaiting_confirmation') return err(409, 'conflict', 'It is not waiting on a confirmation');
        request.status = 'pending';
        request.confirmation = { ...request.confirmation, status: 'confirmed', at: '2026-11-14T15:02:00.000Z' };
        return { body: { request } };
      }
      case 'POST requests/:id/decisions': {
        const request = state.requests.get(id);
        if (!request) return notFound;
        if (!personEmail) return err(403, 'forbidden', 'An API key never decides: relays go through POST /api/relays/slack');
        const b = r.body ?? {};
        if (!/^[0-9a-f]{64}$/.test(String(b.evidenceSha256))) return err(400, 'bad_request', 'evidenceSha256');
        return decide(request, personEmail, b.outcome, b.comment ?? '', b.evidenceSha256, null);
      }
      case 'POST relays/:id': {
        if (id !== 'slack') break;
        if (!scopes.includes('decisions:relay')) return err(403, 'forbidden', 'This needs the decisions:relay scope');
        const b = r.body ?? {};
        if (typeof b.body !== 'string' || !/^v0=[0-9a-f]{64}$/.test(String(b.signature)) || !/^\d{1,12}$/.test(String(b.timestamp))) return err(400, 'bad_request', 'body, signature and timestamp as Slack sent them');
        if (b.channelId && b.channelId !== SLACK_CHANNEL.id) return notFound;
        if (!verifySlackSignature(SLACK_CHANNEL.signingSecret, b.body, b.timestamp, b.signature)) return err(401, 'unauthorized', 'The Slack signature does not match, or the press is older than 5 minutes');
        let payload: any;
        try {
          payload = JSON.parse(new URLSearchParams(b.body).get('payload') ?? '');
        } catch {
          return err(400, 'bad_request', 'Not a Slack interaction');
        }
        if (payload.team?.id !== SLACK_CHANNEL.teamId || payload.api_app_id !== SLACK_CHANNEL.appId) return err(401, 'unauthorized', 'Another Slack team or app');
        const action = payload.actions?.[0] ?? {};
        if (action.action_id !== 'landledger.approve' && action.action_id !== 'landledger.reject') return err(400, 'bad_request', 'Not a Landledger button');
        if (action.action_id === 'landledger.reject') return err(400, 'bad_request', 'A reject needs a comment: use the reject form');
        const m = /^ll1\|(req_[\w-]{1,80})\|(\d{1,2})\|([0-9a-f]{64})$/.exec(String(action.value ?? ''));
        if (!m) return err(400, 'bad_request', 'The button value is not ll1|request|step|hash');
        const email = state.links.get(String(payload.user?.id ?? ''));
        if (!email) return err(403, 'forbidden', 'This Slack user is not linked to a Landledger person');
        const request = state.requests.get(m[1]);
        if (!request) return notFound;
        if (!RELAYABLE_KINDS.includes(request.kind) || request.steps[0]?.key !== 'budget_owner') return err(403, 'forbidden', 'Only the budget owner\'s step is decided through a relay; this one is decided in Landledger');
        return decide(request, email, 'approve', '', m[3], { channelId: SLACK_CHANNEL.id, externalUserId: String(payload.user.id) });
      }
      case 'GET close/:id/snapshot': {
        const denied = need('read');
        if (denied) return denied;
        if (id !== NOTES_MONTH) return err(404, 'not_found', `No snapshot for ${id}: the accrual is not accepted yet`);
        return { body: { id: 'snap_1', month: id, sha256: SNAPSHOT_SHA, frozenAt: '2026-11-15T08:00:00.000Z', frozenBy: 'Dana Controller', current: true, figures: { month: id, currency: 'USD', total: { total: NOTE_FIGURES[0].actual }, notes: NOTE_FIGURES } } };
      }
      case 'GET notes/:id/figures': {
        if (!scopes.includes('notes:draft')) {
          const denied = need('read');
          if (denied) return denied;
        }
        if (id !== NOTES_MONTH) return err(404, 'not_found', `No snapshot for ${id}`);
        return { body: { snapshotSha256: SNAPSHOT_SHA, needed: NOTE_FIGURES } };
      }
      case 'POST notes/:id/drafts': {
        const denied = need('notes:draft');
        if (denied) return denied;
        const b = r.body ?? {};
        if (id !== NOTES_MONTH) return err(404, 'not_found', `No snapshot for ${id}`);
        if (b.snapshotSha256 !== SNAPSHOT_SHA) return err(409, 'conflict', 'That snapshot is not the month\'s current one');
        const figures = NOTE_FIGURES.find((f) => f.costCenter === b.costCenter);
        if (!figures) return err(400, 'bad_request', `${b.costCenter} needs no note this month`);
        if (typeof b.text !== 'string' || b.text.trim().length < 10) return err(400, 'bad_request', 'text: 10 characters or more');
        const mismatches = (b.cites ?? []).flatMap((c: any) => {
          const value = citedValue(figures, c);
          return value === undefined ? [{ figure: c.figure, key: c.key ?? null, cited: c.amount, snapshot: null }] : cents(value) !== cents(c.amount) ? [{ figure: c.figure, key: c.key ?? null, cited: c.amount, snapshot: value }] : [];
        });
        if (mismatches.length) return { status: 422, body: { error: { code: 'unprocessable', message: 'A cited figure does not match the snapshot', details: { mismatches } } } };
        const key = `${id}|${b.costCenter}`;
        const note = state.notes.get(key) ?? { id: next('note'), month: id, costCenter: b.costCenter, name: figures.name, status: 'drafted', accepted: null, versions: [], current: true };
        note.versions.push({ version: note.versions.length + 1, text: b.text, cites: b.cites ?? [], kind: 'draft', by: keyRow?.name ?? personEmail, agent: b.agent ?? null, sponsor: b.sponsor ?? null, runId: b.runId ?? null, at: '2026-11-15T08:05:00.000Z', snapshotSha256: b.snapshotSha256, decision: null });
        state.notes.set(key, note);
        return { status: 201, body: note };
      }
      case 'GET cost/:id': {
        if (id !== 'window') break;
        const denied = need('read');
        if (denied) return denied;
        const services = String(r.query.services ?? '').split(',').filter(Boolean);
        if (!services.length || !r.query.from || !r.query.to) return err(400, 'bad_request', 'services, from and to');
        const rows = services.map((service) => ({ service, known: service in WINDOW_COST, amount: WINDOW_COST[service] ?? '0.000000', days: [] }));
        const total = rows.reduce((sum, x) => sum + Number(x.amount), 0).toFixed(6);
        return { body: { from: r.query.from, to: r.query.to, currency: 'USD', basis: 'estimated', method: 'Each day\'s cost by the share of the day inside the window', total, services: rows } };
      }
      case 'GET contracts/:id': {
        if (id !== 'seats') break;
        const denied = need('read');
        if (denied) return denied;
        const contract = CONTRACTS.find((c) => c.landbrightApp === r.query.landbrightApp);
        if (!contract) return err(404, 'not_found', `No contract grants ${r.query.landbrightApp}`);
        return { body: { contract, seatPrice: contract.seatPrice, left: contract.seats.left } };
      }
      case 'POST requests/:id/seats/release': {
        const denied = need('requests:write');
        if (denied) return denied;
        const request = state.requests.get(id);
        if (!request) return notFound;
        if (keyRow && request.createdBy.id !== keyRow.id && !scopes.includes('admin')) return err(403, 'forbidden', 'Only the creating key, the requester or an admin releases its seats');
        const reason = r.body?.reason;
        if (!['access_denied', 'grant_revoked', 'not_needed'].includes(reason)) return err(400, 'bad_request', 'reason: access_denied, grant_revoked or not_needed');
        if (!request.seat || !['reserved', 'applied'].includes(request.seat.status)) return err(409, 'conflict', 'Nothing is held for this request');
        if (request.seat.status === 'applied' && reason !== 'grant_revoked') return err(409, 'conflict', 'An applied seat is released only when its grant was revoked');
        const from = request.seat.status;
        request.seat = { ...request.seat, status: 'released', releasedReason: reason, releaseNote: r.body?.note ?? '' };
        for (const res of request.reservations) res.status = 'released';
        return { body: { request, released: { seats: request.seat.seats, from, reason } } };
      }
      case 'POST requests/:id/applied': {
        const denied = need('requests:write');
        if (denied) return denied;
        const request = state.requests.get(id);
        if (!request) return notFound;
        if (keyRow && request.createdBy.id !== keyRow.id && !scopes.includes('admin')) return err(403, 'forbidden', 'Only the creating key, the requester or an admin marks it applied');
        if (request.status !== 'approved') return err(409, 'conflict', 'Only an approved request can be applied');
        request.status = 'applied';
        request.appliedNote = r.body?.note ?? '';
        request.appliedLinks = r.body?.links ?? [];
        if (request.seat?.status === 'reserved') request.seat.status = 'applied';
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
        const denied = need('webhooks:write');
        if (denied) return denied;
        const own = [...state.webhooks.values()].filter((w) => scopes.includes('admin') || w.createdByKey === keyRow?.id);
        return { body: { webhooks: own } };
      }
      case 'POST webhooks': {
        const denied = need('webhooks:write');
        if (denied) return denied;
        const hook = { id: next('wh'), url: r.body.url, events: r.body.events, description: r.body.description ?? '', createdBy: keyRow?.name ?? personEmail, createdByKey: keyRow?.id ?? null, createdAt: '2026-11-14T15:00:00.000Z' };
        state.webhooks.set(hook.id, hook);
        return { status: 201, body: { ...hook, secret: `whsec_${Buffer.from(`secret-of-${hook.id}`).toString('base64')}` } };
      }
      case 'DELETE webhooks/:id': {
        const denied = need('webhooks:write');
        if (denied) return denied;
        const hook = state.webhooks.get(id);
        if (!hook || (!scopes.includes('admin') && hook.createdByKey !== keyRow?.id)) return notFound;
        state.webhooks.delete(id);
        return { status: 204 };
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
