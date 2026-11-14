/**
 * The Landledger node and credential against the fake API: each operation's request and output, the rules a flow and
 * an agent meet (a sponsor for an agent, no decision from an agent or MCP), exact amounts, errors with hints.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { LandledgerNode } from '../src/nodes/landledger';
import { amountParameter, fromMicros, toMicros } from '../src/shared';
import { KEY, READ_KEY, startFakeLandledger, type FakeLandledger } from './fake-landledger';
import { credentials, jsonOf, run, testCredentials, type RequestOptions } from './helpers';

let fake: FakeLandledger;
beforeAll(async () => {
  fake = await startFakeLandledger();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const call = (parameters: JsonObject, extra: Omit<RequestOptions, 'credentials'> & { key?: string } = {}) =>
  run(LandledgerNode, parameters, { credentials: credentials(fake, extra.key ? { apiKey: extra.key } : {}), ...extra });
const last = () => fake.requests.at(-1)!;

const CREATE: JsonObject = {
  resource: 'request',
  operation: 'create',
  kind: 'infra_change',
  title: 'Second Postgres replica',
  costCenter: 'ENG-PLATFORM',
  amount: '1840.5',
  recurrence: 'monthly',
  requestedBy: 'person',
  requester: 'Eden.Tzur@landbright.test',
  note: 'Read load doubled',
  evidence: '{"lines":[{"label":"db.r6g.large","amount":"1840.50"}],"basis":"AWS price list"}',
  requestFields: { pullRequestUrl: 'https://github.com/landfalls-ai/infra/pull/42', runUrl: 'http://landflow.test/runs/ex_test' },
};

describe('credential', () => {
  it('checks health without the key, then who the key is and its scopes', async () => {
    const result = await testCredentials({ baseUrl: `${fake.url}/`, apiKey: KEY });
    expect(result).toMatchObject({ ok: true, message: 'Connected to Landledger 0.2.0 as Landflow flows (read, requests:write, reservations:write, decisions:relay)' });
    expect(fake.requests.map((r) => [r.method, r.path, r.headers.authorization])).toEqual([
      ['GET', '/api/health', undefined],
      ['GET', '/api/auth/me', `Bearer ${KEY}`],
    ]);
  });

  it('fails with the 401 hint on a wrong key', async () => {
    const result = await testCredentials({ baseUrl: fake.url, apiKey: 'll_wrong' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/401: Invalid API key/);
  });
});

describe('amounts', () => {
  it('are exact micro-units, never floats', () => {
    expect(toMicros('1840.5')).toBe(1_840_500_000n);
    expect(toMicros(0.1)).toBe(100_000n);
    expect(toMicros('1,200.000001')).toBe(1_200_000_001n);
    expect(toMicros('1.0000001')).toBeUndefined();
    expect(toMicros('abc')).toBeUndefined();
    expect(fromMicros(-1_500_000n)).toBe('-1.500000');
    expect(amountParameter(1840.5, 'Amount', 0)).toBe('1840.5');
    expect(amountParameter('100', 'Amount', 0)).toBe('100');
    expect(amountParameter('0', 'Amount', 0)).toBe('0');
    expect(() => amountParameter('-1', 'Amount', 0)).toThrow(/non-negative/);
  });
});

describe('Budget → Check', () => {
  it('subtracts actuals and reservations from the budget, and says whether a planned amount fits', async () => {
    const response = await call({ resource: 'budget', operation: 'check', costCenter: 'eng-agents', month: '2026-11', plannedAmount: '400' });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/budgets', query: { month: '2026-11' } });
    expect(jsonOf(response)).toEqual([
      {
        costCenter: 'ENG-AGENTS',
        name: 'Engineering agents',
        owner: 'amit.gal@landbright.test',
        month: '2026-11',
        currency: 'USD',
        budget: '2000.000000',
        actual: '1200.500000',
        reserved: '300.000000',
        remaining: '499.500000',
        forecast: '2400.000000',
        state: 'risk',
        plannedAmount: '400.000000',
        remainingAfter: '99.500000',
        fits: true,
      },
    ]);
    const tooMuch = jsonOf(await call({ resource: 'budget', operation: 'check', costCenter: 'ENG-AGENTS', plannedAmount: '500' }))[0];
    expect(tooMuch).toMatchObject({ remainingAfter: '-0.500000', fits: false });
  });

  it('a cost center without a budget has nothing left to fit in; an unknown one is an error naming the known ones', async () => {
    expect(jsonOf(await call({ resource: 'budget', operation: 'check', costCenter: 'ENG-PLATFORM', plannedAmount: '1' }))[0]).toMatchObject({ budget: null, remaining: null, state: 'none', fits: false });
    const missing = await call({ resource: 'budget', operation: 'check', costCenter: 'NOPE' });
    expect(missing.error?.message).toMatch(/no cost center NOPE in 2026-11/);
    expect(missing.error?.description).toMatch(/ENG-AGENTS, ENG-PLATFORM/);
  });
});

describe('Cost → Query', () => {
  it('asks /api/spend for a month and answers the total and groups, without the daily series', async () => {
    const response = await call({ resource: 'cost', operation: 'query', by: 'agent', window: 'month', month: '2026-11', filter: 'costCenter:ENG-AGENTS, provider:anthropic', layer: 'spread', provisional: false });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/spend', query: { by: 'agent', month: '2026-11', filter: 'costCenter:ENG-AGENTS,provider:anthropic', layer: 'spread', provisional: 'false' } });
    const [summary] = jsonOf(response);
    expect(summary).toMatchObject({ by: 'agent', total: { total: '1210.500000' } });
    expect(summary.groups).toHaveLength(2);
    expect(summary.daily).toBeUndefined();
  });

  it('a range of days, one item per group; a malformed filter is refused before the call', async () => {
    const groups = jsonOf(await call({ resource: 'cost', operation: 'query', by: 'costCenter', window: 'range', from: '2026-11-01T10:00:00Z', to: '2026-11-14', output: 'groups' }));
    expect(last().query).toMatchObject({ from: '2026-11-01', to: '2026-11-14' });
    expect(groups.map((g) => g.key)).toEqual(['ENG-AGENTS', 'ENG-PLATFORM']);
    expect(groups[0]).toMatchObject({ by: 'costCenter', currency: 'USD' });
    const bad = await call({ resource: 'cost', operation: 'query', filter: 'ENG-AGENTS' });
    expect(bad.error?.message).toMatch(/not dimension:value/);
  });
});

describe('Request', () => {
  it('Create raises it as the person, from this run, with the evidence and the pull request', async () => {
    const response = await call(CREATE, { idempotencyKey: 'ex_test:n1:0' });
    const body = last().body;
    expect(last()).toMatchObject({ method: 'POST', path: '/api/requests' });
    expect(body).toEqual({
      kind: 'infra_change',
      title: 'Second Postgres replica',
      note: 'Read load doubled',
      costCenter: 'ENG-PLATFORM',
      amount: { amount: '1840.5', currency: 'USD' },
      recurrence: 'monthly',
      evidence: { lines: [{ label: 'db.r6g.large', amount: '1840.50' }], basis: 'AWS price list' },
      origin: { type: 'landflow_run', workflowId: 'wf_test', executionId: 'ex_test', url: 'http://landflow.test/runs/ex_test' },
      related: [{ type: 'pull_request', url: 'https://github.com/landfalls-ai/infra/pull/42' }],
      requester: { kind: 'person', person: { email: 'eden.tzur@landbright.test' } },
      submit: true,
      idempotencyKey: 'ex_test:n1:0:0',
    });
    expect(jsonOf(response)[0]).toMatchObject({ created: true, request: { id: 'req_1', status: 'pending' } });
    // A retried step sends the same key: Landledger answers the first request (200), nothing is raised twice.
    const again = jsonOf(await call(CREATE, { idempotencyKey: 'ex_test:n1:0' }))[0];
    expect(again).toMatchObject({ created: false, request: { id: 'req_1' } });
    expect(fake.state.requests.size).toBe(1);
  });

  it('an agent raises it as itself with its sponsor, and can\'t raise it in a person\'s name', async () => {
    const asAgent = { ...CREATE, kind: 'ai_budget', requestedBy: 'agent', agentId: 'ag_1', agentName: 'Support triage', sponsor: 'amit.gal@landbright.test', requestFields: {} };
    const response = await call(asAgent, { mode: 'tool' });
    expect(response.error).toBeUndefined();
    expect(last().body.requester).toEqual({ kind: 'agent', agent: { id: 'ag_1', name: 'Support triage', system: 'landflow' }, sponsor: { email: 'amit.gal@landbright.test' } });
    const asPerson = await call(CREATE, { mode: 'tool' });
    expect(asPerson.error?.message).toBe('An agent raises a request as itself, with a sponsor');
    expect((await call(CREATE, { mode: 'mcp' })).error?.message).toMatch(/as itself/);
  });

  it('checks the fields before calling: title length, amount, currency, dates, evidence', async () => {
    expect((await call({ ...CREATE, title: 'ab' })).error?.message).toMatch(/3-200/);
    expect((await call({ ...CREATE, amount: '12.1234567' })).error?.message).toMatch(/six decimals/);
    expect((await call({ ...CREATE, currency: 'dollars' })).error?.message).toMatch(/ISO 4217/);
    expect((await call({ ...CREATE, requestFields: { start: '2026-12-01', end: '2026-11-01' } })).error?.message).toMatch(/End must be on or after Start/);
    expect((await call({ ...CREATE, evidence: '[1]' })).error?.message).toMatch(/JSON object/);
    expect(fake.requests).toHaveLength(0);
  });

  it('Get returns the request, Landledger\'s evidence and its hash; List the summaries; Mark Applied moves it on', async () => {
    await call(CREATE);
    const detail = jsonOf(await call({ resource: 'request', operation: 'get', requestId: 'req_1' }))[0];
    expect(detail.request).toMatchObject({ id: 'req_1', kind: 'infra_change' });
    expect(detail.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    const list = jsonOf(await call({ resource: 'request', operation: 'list', box: 'open', listFilters: { kind: 'infra_change', costCenter: 'ENG-PLATFORM' }, limit: 500 }));
    expect(last().query).toEqual({ box: 'open', kind: 'infra_change', costCenter: 'ENG-PLATFORM', limit: '200' });
    expect(list.map((r) => r.id)).toEqual(['req_1']);

    fake.state.requests.get('req_1').status = 'approved';
    const applied = jsonOf(await call({ resource: 'request', operation: 'markApplied', requestId: 'req_1', appliedNote: 'Replica up', links: '[{"label":"PR #42","url":"https://github.com/landfalls-ai/infra/pull/42"}]' }))[0];
    expect(last()).toMatchObject({ path: '/api/requests/req_1/applied', body: { note: 'Replica up', links: [{ label: 'PR #42', url: 'https://github.com/landfalls-ai/infra/pull/42' }] } });
    expect((applied.request as JsonObject).status).toBe('applied');
  });

  it('a read-only key gets the 403 with the scope it needs', async () => {
    const response = await call(CREATE, { key: READ_KEY });
    expect(response.error?.message).toBe('Landledger API error 403: This needs the requests:write scope');
    expect(response.error?.description).toMatch(/needs requests:write/);
  });
});

describe('Reservation', () => {
  it('reserves a month of an approved request (once per month) and releases it', async () => {
    await call(CREATE);
    fake.state.requests.get('req_1').status = 'approved';
    const first = jsonOf(await call({ resource: 'reservation', operation: 'create', requestId: 'req_1', month: '2026-12', reserveAmount: '1000' }))[0];
    const reservationId = (first.reservation as JsonObject).id as string;
    expect(last()).toMatchObject({ path: '/api/reservations', body: { requestId: 'req_1', month: '2026-12', amount: '1000' } });
    expect(first).toMatchObject({ created: true, reservation: { status: 'reserved', amount: '1000.000000' } });
    const again = jsonOf(await call({ resource: 'reservation', operation: 'create', requestId: 'req_1', month: '2026-12' }))[0];
    expect(again).toMatchObject({ created: false, reservation: { id: reservationId } });
    const released = jsonOf(await call({ resource: 'reservation', operation: 'release', reservationId, reason: 'Replica not needed' }))[0];
    expect(last()).toMatchObject({ path: `/api/reservations/${reservationId}/release`, body: { reason: 'Replica not needed' } });
    expect(released).toMatchObject({ status: 'released', remaining: '0.000000' });
  });
});

describe('Period → Status', () => {
  it('reads a known month, and calls a month nothing has moved yet open', async () => {
    expect(jsonOf(await call({ resource: 'period', operation: 'getStatus', month: '2026-10' }))[0]).toMatchObject({ month: '2026-10', status: 'locked', lockedBy: 'Dana', known: true });
    expect(jsonOf(await call({ resource: 'period', operation: 'getStatus', month: '2026-12' }))[0]).toMatchObject({ month: '2026-12', status: 'open', known: false });
    expect((await call({ resource: 'period', operation: 'getStatus', month: '2026-13' })).error?.message).toMatch(/not YYYY-MM/);
  });
});

describe('Decision → Relay', () => {
  const relay = (overrides: JsonObject = {}) => ({
    resource: 'decision',
    operation: 'relay',
    requestId: 'req_1',
    outcome: 'approve',
    person: 'Amit.Gal@landbright.test',
    evidenceSha256: 'a'.repeat(64),
    step: 1,
    channel: 'slack',
    ...overrides,
  });

  it('carries the person\'s decision with the evidence hash and the channel', async () => {
    await call(CREATE);
    const response = await call(relay());
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/requests/req_1/decisions',
      body: { outcome: 'approve', comment: '', evidenceSha256: 'a'.repeat(64), step: 1, person: { email: 'amit.gal@landbright.test' }, channel: 'slack' },
    });
    expect(jsonOf(response)[0]).toMatchObject({ request: { status: 'approved' }, decision: { via: 'relay', channel: 'slack' } });
  });

  it('is refused when an agent or an MCP client calls it', async () => {
    for (const mode of ['tool', 'mcp'] as const) {
      const response = await call(relay(), { mode });
      expect(response.error?.message).toBe('Decision → Relay is for flows only: an agent never decides');
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('a reject needs a reason; Landledger refuses someone outside the step or the requester', async () => {
    await call(CREATE);
    expect((await call(relay({ outcome: 'reject', comment: 'no' }))).error?.message).toMatch(/comment of 3 characters/);
    expect((await call(relay({ evidenceSha256: 'xyz' }))).error?.message).toMatch(/64 hex/);
    const outsider = await call(relay({ person: 'tal.levi@landbright.test' }));
    expect(outsider.error?.message).toBe('Landledger API error 403: tal.levi@landbright.test is not among this step\'s approvers');
    expect((await call(relay({ person: 'eden.tzur@landbright.test' }))).error?.message).toMatch(/requester can't decide/);
    const rejected = jsonOf(await call(relay({ outcome: 'reject', comment: 'Use the reserved instance' })))[0];
    expect((rejected.request as JsonObject).status).toBe('rejected');
  });

  it('a key without decisions:relay is refused by Landledger', async () => {
    await call(CREATE);
    const response = await call(relay(), { key: READ_KEY });
    expect(response.error?.message).toMatch(/403: An API key without decisions:relay/);
  });
});

describe('errors', () => {
  it('continue on fail turns a failure into an item; a 409 explains itself', async () => {
    fake.failNext(409, { error: { code: 'conflict', message: 'The month is closing' } });
    const response = await call({ resource: 'request', operation: 'get', requestId: 'req_1' }, { continueOnFail: true });
    expect(jsonOf(response)[0]).toMatchObject({ error: 'Landledger API error 409: The month is closing' });
    expect(jsonOf(response)[0].description).toMatch(/moved on/);
  });

  it('an unreachable Landledger names the Base URL', async () => {
    const response = await run(LandledgerNode, { resource: 'period', operation: 'getStatus' }, { credentials: { landledgerApi: { baseUrl: 'http://127.0.0.1:1', apiKey: KEY } } });
    expect(response.error?.message).toMatch(/Landledger API request failed/);
    expect(response.error?.description).toMatch(/Base URL/);
  });
});
