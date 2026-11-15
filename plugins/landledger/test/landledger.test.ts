/**
 * The Landledger node and its two credentials against the fake API: each operation's request and output, the rules a
 * flow and an agent meet (a sponsor for an agent, a person named by a key confirms, no decision from an agent or MCP,
 * a relay is the raw signed Slack press with a relay-only key), exact amounts, errors with hints.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { LandledgerNode } from '../src/nodes/landledger';
import { amountParameter, fromMicros, toMicros } from '../src/shared';
import { executeRequest, extras } from './helpers';
import { runNode } from '@landflow/sdk';
import { KEY, MIXED_RELAY_KEY, NOTES_KEY, NOTES_MONTH, READ_KEY, RELAY_KEY, SLACK_CHANNEL, SNAPSHOT_SHA, startFakeLandledger, WEBHOOKS_KEY, type FakeLandledger } from './fake-landledger';
import { credentials, jsonOf, relayCredentials, run, slackPress, testCredentials, type RequestOptions } from './helpers';

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
  it('checks health without the key, then who the key is (its id) and its scopes', async () => {
    const result = await testCredentials({ baseUrl: `${fake.url}/`, apiKey: KEY });
    expect(result).toEqual({ ok: true, message: 'Connected to Landledger 0.2.0 as Landflow flows (key key_flows): read, requests:write, reservations:write' });
    expect(fake.requests.map((r) => [r.method, r.path, r.headers.authorization])).toEqual([
      ['GET', '/api/health', undefined],
      ['GET', '/api/auth/me', `Bearer ${KEY}`],
    ]);
    expect((await testCredentials({ baseUrl: fake.url, apiKey: WEBHOOKS_KEY })).message).toBe('Connected to Landledger 0.2.0 as Landflow webhooks (key key_hooks): webhooks:write');
  });

  it('warns when the flows\' key also holds decisions:relay', async () => {
    const result = await testCredentials({ baseUrl: fake.url, apiKey: MIXED_RELAY_KEY });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/read, requests:write, decisions:relay\. Warning: this key also holds decisions:relay: relays take their own key/);
  });

  it('fails with the 401 hint on a wrong key', async () => {
    const result = await testCredentials({ baseUrl: fake.url, apiKey: 'll_wrong' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/401: Invalid API key/);
  });
});

describe('relay credential', () => {
  it('passes a key with decisions:relay alone', async () => {
    expect(await testCredentials({ baseUrl: fake.url, apiKey: RELAY_KEY }, 'landledgerRelayApi')).toEqual({ ok: true, message: 'Connected to Landledger 0.2.0 as Landflow relay (key key_relay): decisions:relay' });
  });

  it('refuses a relay key that also holds requests:write, and a key without decisions:relay', async () => {
    const mixed = await testCredentials({ baseUrl: fake.url, apiKey: MIXED_RELAY_KEY }, 'landledgerRelayApi');
    expect(mixed.ok).toBe(false);
    expect(mixed.message).toMatch(/a relay key must hold decisions:relay only; this one also holds requests:write/);
    const flows = await testCredentials({ baseUrl: fake.url, apiKey: KEY }, 'landledgerRelayApi');
    expect(flows).toMatchObject({ ok: false });
    expect(flows.message).toMatch(/has no decisions:relay/);
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
    // A key naming a person: it waits on that person's confirmation; Landledger stamps who raised it and whether the origin is vouched for.
    expect(jsonOf(response)[0]).toMatchObject({
      created: true,
      request: { id: 'req_1', status: 'awaiting_confirmation', createdBy: { kind: 'key', id: 'key_flows' }, origin: { workflowId: 'wf_test', verified: false } },
    });
    // A retried step sends the same key: Landledger answers the first request (200), nothing is raised twice.
    const again = jsonOf(await call(CREATE, { idempotencyKey: 'ex_test:n1:0' }))[0];
    expect(again).toMatchObject({ created: false, request: { id: 'req_1' } });
    expect(fake.state.requests.size).toBe(1);
  });

  it('an unsaved workflow raises nothing (no made-up origin); the same idempotency key with another body is a 409', async () => {
    for (const workflowId of ['', 'unsaved']) {
      const response = await runNode(LandledgerNode, { ...executeRequest('landledger', CREATE, { credentials: credentials(fake) }), workflowId }, extras);
      expect(response.error?.message).toBe('Save the workflow before it raises a Landledger request');
    }
    expect(fake.requests).toHaveLength(0);
    await call({ ...CREATE, requestFields: { idempotencyKey: 'same' } });
    const changed = await call({ ...CREATE, amount: '2000', requestFields: { idempotencyKey: 'same' } });
    expect(changed.error?.message).toBe('Landledger API error 409: This idempotency key came with another body');
    expect(changed.error?.description).toMatch(/idempotency key came back with a different body/);
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

describe('Tool or seat', () => {
  const SEAT: JsonObject = {
    ...CREATE,
    kind: 'tool_or_seat',
    title: 'Linear seat for Tal Levi',
    amount: '12.5',
    requester: 'sub-tal',
    evidence: '{}',
    seatContractId: 'con_linear',
    seats: 1,
    seatPrice: '12.500000',
    requestFields: { landbrightRequestId: 'REQ-41', landbrightRequestUrl: 'http://localhost:5173/requests/REQ-41', idempotencyKey: 'landbright-REQ-41' },
  };

  it('Contract → Seats finds the contract that grants a Landbright app; an app no contract names is found: false, not an error', async () => {
    const [found] = jsonOf(await call({ resource: 'contract', operation: 'getSeats', landbrightApp: 'linear' }));
    expect(last()).toMatchObject({ method: 'GET', path: '/api/contracts/seats', query: { landbrightApp: 'linear' } });
    expect(found).toMatchObject({ found: true, landbrightApp: 'linear', seatPrice: '12.500000', left: 2, contract: { id: 'con_linear', costCenter: { code: 'ENG-PLATFORM' } } });
    expect(jsonOf(await call({ resource: 'contract', operation: 'getSeats', landbrightApp: 'figma' }))[0]).toEqual({ found: false, landbrightApp: 'figma', contract: null, seatPrice: null, left: 0 });
    const read = await call({ resource: 'contract', operation: 'getSeats', landbrightApp: 'linear' }, { key: WEBHOOKS_KEY });
    expect(read.error?.message).toMatch(/403: This needs the read scope/);
  });

  it('Create carries the seat terms and the Landbright request as a related source; seat terms only on a tool_or_seat', async () => {
    const [out] = jsonOf(await call(SEAT));
    expect(last().body).toMatchObject({
      kind: 'tool_or_seat',
      amount: { amount: '12.5', currency: 'USD' },
      recurrence: 'monthly',
      seat: { contractId: 'con_linear', seats: 1, seatPrice: '12.5' },
      requester: { kind: 'person', person: { sub: 'sub-tal' } },
      related: [{ type: 'landbright_request', id: 'REQ-41', url: 'http://localhost:5173/requests/REQ-41' }],
      idempotencyKey: 'landbright-REQ-41',
    });
    expect(out).toMatchObject({ created: true, request: { kind: 'tool_or_seat', seat: { contractId: 'con_linear', status: 'none' } } });
    // The same parameters on an infra change send no seat; a seat price that isn't an amount is refused before the call.
    await call({ ...SEAT, kind: 'infra_change', requestFields: {} });
    expect(last().body.seat).toBeUndefined();
    const before = fake.requests.length;
    expect((await call({ ...SEAT, seatPrice: 'twelve' })).error?.message).toMatch(/Seat Price must be a non-negative amount/);
    expect((await call({ ...SEAT, seats: 0 })).error?.message).toMatch(/Seats must be a whole number from 1 to 100/);
    expect(fake.requests.length).toBe(before);
    // Landledger checks the terms add up.
    expect((await call({ ...SEAT, amount: '20', requestFields: {} })).error?.message).toMatch(/400: A seat request is seats × seat price a month/);
  });

  it('Break-glass: the Landbright request is the origin with breakGlass, and this run a related source', async () => {
    const [out] = jsonOf(await call({ ...SEAT, requestFields: { ...(SEAT.requestFields as JsonObject), landbrightRequestId: 'REQ-43', idempotencyKey: 'landbright-REQ-43', breakGlass: true } }));
    expect(last().body.origin).toEqual({ type: 'landbright_request', id: 'REQ-43', url: 'http://localhost:5173/requests/REQ-41', breakGlass: true });
    expect(last().body.related).toEqual([{ type: 'landflow_run', workflowId: expect.any(String), executionId: expect.any(String) }]);
    expect(out).toMatchObject({ created: true, request: { origin: { type: 'landbright_request', breakGlass: true, verified: false } } });
    const before = fake.requests.length;
    expect((await call({ ...SEAT, requestFields: { breakGlass: true } })).error?.message).toMatch(/Break-glass needs the Landbright request/);
    expect(fake.requests.length).toBe(before);
  });

  it('Release Seats gives a reserved seat back with its reason; an applied seat only when its grant was revoked; nothing held is a 409', async () => {
    const [{ request }] = jsonOf(await call(SEAT)) as Array<{ request: JsonObject }>;
    const id = String(request.id);
    const seat = fake.state.requests.get(id);
    seat.status = 'approved';
    seat.seat.status = 'reserved';
    const [released] = jsonOf(await call({ resource: 'request', operation: 'releaseSeats', requestId: id, seatReason: 'access_denied', seatNote: 'Landbright denied REQ-41' }));
    expect(last()).toMatchObject({ method: 'POST', path: `/api/requests/${id}/seats/release`, body: { reason: 'access_denied', note: 'Landbright denied REQ-41' } });
    expect(last().headers.authorization).toBe(`Bearer ${KEY}`);
    expect(released).toMatchObject({ request: { seat: { status: 'released' } }, released: { from: 'reserved', reason: 'access_denied' } });
    const again = await call({ resource: 'request', operation: 'releaseSeats', requestId: id, seatReason: 'access_denied' });
    expect(again.error?.message).toMatch(/409: Nothing is held for this request/);

    seat.seat.status = 'applied';
    expect((await call({ resource: 'request', operation: 'releaseSeats', requestId: id, seatReason: 'not_needed' })).error?.message).toMatch(/409: An applied seat is released only when its grant was revoked/);
    expect(jsonOf(await call({ resource: 'request', operation: 'releaseSeats', requestId: id, seatReason: 'grant_revoked' }))[0]).toMatchObject({ released: { from: 'applied', reason: 'grant_revoked' } });
    expect((await call({ resource: 'request', operation: 'releaseSeats', requestId: id, seatReason: 'lost' })).error?.message).toMatch(/Reason "lost" is not one of/);
  });

  it('Cancel withdraws a request not yet decided, with its reason; a decided one is a 409', async () => {
    const [{ request }] = jsonOf(await call({ ...SEAT, requestFields: { landbrightRequestId: 'REQ-44', idempotencyKey: 'landbright-REQ-44' } })) as Array<{ request: JsonObject }>;
    const id = String(request.id);
    const [cancelled] = jsonOf(await call({ resource: 'request', operation: 'cancel', requestId: id, cancelReason: 'Landbright REQ-44 expired waiting on Landledger' }));
    expect(last()).toMatchObject({ method: 'POST', path: `/api/requests/${id}/cancel`, body: { reason: 'Landbright REQ-44 expired waiting on Landledger' } });
    expect(cancelled).toMatchObject({ id, status: 'cancelled' });
    expect((await call({ resource: 'request', operation: 'cancel', requestId: id })).error?.message).toMatch(/409: Request is cancelled/);
  });

  it('Mark Applied moves a reserved seat to used', async () => {
    const [{ request }] = jsonOf(await call(SEAT)) as Array<{ request: JsonObject }>;
    const seat = fake.state.requests.get(String(request.id));
    seat.status = 'approved';
    seat.seat.status = 'reserved';
    await call({ resource: 'request', operation: 'markApplied', requestId: request.id, appliedNote: 'Granted in Landbright as REQ-41', links: '[{"label":"REQ-41","url":"http://localhost:5173/requests/REQ-41"}]' });
    expect(seat).toMatchObject({ status: 'applied', seat: { status: 'applied' }, appliedNote: 'Granted in Landbright as REQ-41' });
  });
});

describe('Notes key credential', () => {
  it('passes a key with notes:draft alone, and refuses one without it or with a write scope besides', async () => {
    const ok = await testCredentials({ baseUrl: fake.url, apiKey: NOTES_KEY }, 'landledgerNotesKey');
    expect(ok).toEqual({ ok: true, message: 'Connected to Landledger 0.2.0 as Landflow notes (key key_notes): notes:draft' });
    const without = await testCredentials({ baseUrl: fake.url, apiKey: READ_KEY }, 'landledgerNotesKey');
    expect(without).toMatchObject({ ok: false, message: expect.stringMatching(/the key has no notes:draft \(read\)/) });
    const admin = await testCredentials({ baseUrl: fake.url, apiKey: KEY }, 'landledgerNotesKey');
    expect(admin.ok).toBe(false);
  });
});

describe('Close, Notes and the cost of a window', () => {
  const notes = (parameters: JsonObject, extra: Omit<RequestOptions, 'credentials'> & { key?: string } = {}) =>
    run(LandledgerNode, { resource: 'note', ...parameters }, { credentials: { landledgerNotesKey: { baseUrl: fake.url, apiKey: extra.key ?? NOTES_KEY } }, ...extra });
  const DRAFT: JsonObject = {
    operation: 'submitDraft',
    month: NOTES_MONTH,
    noteCostCenter: 'ENG-AGENTS',
    snapshotSha256: SNAPSHOT_SHA,
    noteText: 'Engineering agents came in 799.50 under budget; Claude Sonnet 5.5 rose 150.25 on last month.',
    cites: JSON.stringify([{ figure: 'variance_budget', amount: '-799.50' }, { figure: 'driver_model', key: 'claude-sonnet-5-5', amount: 150.25 }]),
    noteAgentId: 'wf_notes',
    noteAgentName: 'Variance note drafter',
    noteSponsor: 'Eden.Tzur@landbright.test',
  };

  it('Close → Snapshot reads the frozen figures with the flows\' key; a month not frozen yet is a 404', async () => {
    const [snapshot] = jsonOf(await call({ resource: 'close', operation: 'getSnapshot', month: NOTES_MONTH }));
    expect(last()).toMatchObject({ method: 'GET', path: `/api/close/${NOTES_MONTH}/snapshot` });
    expect(snapshot).toMatchObject({ month: NOTES_MONTH, sha256: SNAPSHOT_SHA, current: true });
    expect((await call({ resource: 'close', operation: 'getSnapshot', month: '2026-11' })).error?.message).toMatch(/404: No snapshot for 2026-11/);
  });

  it('Note → Figures reads what each note may cite with the notes key', async () => {
    const [figures] = jsonOf(await notes({ operation: 'getFigures', month: NOTES_MONTH }));
    expect(last().headers.authorization).toBe(`Bearer ${NOTES_KEY}`);
    expect(figures).toMatchObject({ snapshotSha256: SNAPSHOT_SHA, needed: [{ costCenter: 'TOTAL' }, { costCenter: 'ENG-AGENTS', drivers: [{ dimension: 'model', change: '150.250000' }] }] });
  });

  it('Note → Submit Draft sends the text, exact cites, the agent, its sponsor and this run', async () => {
    const [note] = jsonOf(await notes(DRAFT));
    expect(last()).toMatchObject({ method: 'POST', path: `/api/notes/${NOTES_MONTH}/drafts` });
    expect(last().body).toEqual({
      costCenter: 'ENG-AGENTS',
      snapshotSha256: SNAPSHOT_SHA,
      text: DRAFT.noteText,
      cites: [{ figure: 'variance_budget', amount: '-799.500000' }, { figure: 'driver_model', key: 'claude-sonnet-5-5', amount: '150.250000' }],
      agent: { id: 'wf_notes', name: 'Variance note drafter', system: 'landflow' },
      sponsor: { email: 'eden.tzur@landbright.test' },
      runId: 'ex_test',
    });
    expect(note).toMatchObject({ costCenter: 'ENG-AGENTS', status: 'drafted', versions: [{ version: 1, kind: 'draft' }] });
  });

  it('a cited figure that differs from the snapshot is Landledger\'s 422, with the mismatches in the message', async () => {
    const refused = await notes({ ...DRAFT, cites: '[{"figure":"actual","amount":"1300"}]' });
    expect(refused.error?.message).toBe('Landledger API error 422: A cited figure does not match the snapshot (mismatches: [{"figure":"actual","key":null,"cited":"1300.000000","snapshot":"1200.500000"}])');
    expect(refused.error?.description).toMatch(/cite only the figures Notes → Figures lists/);
    const stale = await notes({ ...DRAFT, snapshotSha256: 'b'.repeat(64) });
    expect(stale.error?.message).toMatch(/409: That snapshot is not the month's current one/);
  });

  it('checks the draft before calling: the snapshot hash, the text, each figure, a driver\'s key; an agent drafts as itself', async () => {
    const before = fake.requests.length;
    expect((await notes({ ...DRAFT, snapshotSha256: 'abc' })).error?.message).toMatch(/64 hex characters/);
    expect((await notes({ ...DRAFT, noteText: 'Short' })).error?.message).toMatch(/10-8,000 characters/);
    expect((await notes({ ...DRAFT, cites: '[{"figure":"revenue","amount":"1"}]' })).error?.message).toMatch(/"revenue" is not one of actual, budget/);
    expect((await notes({ ...DRAFT, cites: '[{"figure":"driver_service","amount":"1"}]' })).error?.message).toMatch(/needs the key of the driver/);
    expect((await notes({ ...DRAFT, cites: '[{"figure":"actual","amount":"lots"}]' })).error?.message).toMatch(/the amount must be a decimal/);
    expect((await notes({ ...DRAFT, noteAgentId: '' }, { mode: 'tool' })).error?.message).toMatch(/An agent drafts a note as itself/);
    expect(fake.requests.length).toBe(before);
    // A key without notes:draft is Landledger's 403.
    expect((await notes(DRAFT, { key: KEY })).error?.message).toMatch(/403: This needs the notes:draft scope/);
  });

  it('Cost → Window asks for the services over the window, as ISO instants; an empty window is refused before the call', async () => {
    const [window] = jsonOf(await call({ resource: 'cost', operation: 'window', services: 'checkout, landflow-host, checkout, ghost', windowFrom: '2026-11-14T10:00:00+02:00', windowTo: '2026-11-14T11:30:00Z' }));
    expect(last()).toMatchObject({ method: 'GET', path: '/api/cost/window', query: { services: 'checkout,landflow-host,ghost', from: '2026-11-14T08:00:00.000Z', to: '2026-11-14T11:30:00.000Z' } });
    expect(window).toMatchObject({ basis: 'estimated', total: '53.250000', services: [{ service: 'checkout', known: true }, { service: 'landflow-host' }, { service: 'ghost', known: false, amount: '0.000000' }] });
    const before = fake.requests.length;
    expect((await call({ resource: 'cost', operation: 'window', services: 'checkout', windowFrom: '2026-11-14T11:00:00Z', windowTo: '2026-11-14T10:00:00Z' })).error?.message).toMatch(/From must be before To/);
    expect((await call({ resource: 'cost', operation: 'window', services: ' , ', windowFrom: '2026-11-14T10:00:00Z', windowTo: '2026-11-14T11:00:00Z' })).error?.message).toMatch(/name at least one service/);
    expect(fake.requests.length).toBe(before);
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

describe('Key → Who Am I', () => {
  it('names the node\'s key: the id a request\'s createdBy carries, its name and scopes', async () => {
    expect(jsonOf(await call({ resource: 'key', operation: 'me' }))).toEqual([{ kind: 'key', id: 'key_flows', name: 'Landflow flows', scopes: ['read', 'requests:write', 'reservations:write'] }]);
  });
});

describe('Decision → Relay', () => {
  /** A pending request (confirmed by its requester) and the hash Landledger served for it. */
  async function pending() {
    await call(CREATE);
    fake.state.requests.get('req_1').status = 'pending';
    const detail = jsonOf(await call({ resource: 'request', operation: 'get', requestId: 'req_1' }))[0];
    return { value: `ll1|req_1|1|${detail.evidenceSha256}`, sha: String(detail.evidenceSha256) };
  }
  const relay = (press: { body: string; signature: string; timestamp: string }, overrides: JsonObject = {}) => ({
    resource: 'decision',
    operation: 'relay',
    channel: 'slack',
    slackBody: press.body,
    slackSignature: press.signature,
    slackTimestamp: press.timestamp,
    ...overrides,
  });
  const relayCall = (parameters: JsonObject, options: Omit<RequestOptions, 'credentials'> & { key?: string } = {}) =>
    run(LandledgerNode, parameters, { credentials: relayCredentials(fake, options.key), ...options });

  it('carries the press exactly as Slack sent it, with the relay key; Landledger decides as the person who linked that Slack user', async () => {
    const { value, sha } = await pending();
    const press = slackPress({ user: 'U_AMIT', value });
    const response = await relayCall(relay(press, { relayChannelId: SLACK_CHANNEL.id }));
    expect(response.error).toBeUndefined();
    expect(last()).toMatchObject({ method: 'POST', path: '/api/relays/slack' });
    expect(last().headers.authorization).toBe(`Bearer ${RELAY_KEY}`);
    expect(last().body).toEqual({ body: press.body, signature: press.signature, timestamp: press.timestamp, channelId: SLACK_CHANNEL.id });
    expect(jsonOf(response)[0]).toMatchObject({
      request: { status: 'approved' },
      decision: { via: 'relay', channel: 'slack', person: { email: 'amit.gal@landbright.test' }, evidenceSha256: sha, relay: { externalUserId: 'U_AMIT' } },
    });
  });

  it('is refused when an agent or an MCP client calls it', async () => {
    const press = slackPress({ value: `ll1|req_1|1|${'a'.repeat(64)}` });
    for (const mode of ['tool', 'mcp'] as const) {
      const response = await relayCall(relay(press), { mode });
      expect(response.error?.message).toBe('Decision → Relay is for flows only: an agent never decides');
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('checks the press is whole before calling: the body, the signature and the timestamp as Slack sent them', async () => {
    const press = slackPress({ value: `ll1|req_1|1|${'a'.repeat(64)}` });
    expect((await relayCall(relay(press, { slackBody: '' }))).error?.message).toBe('Slack Request Body is empty');
    expect((await relayCall(relay(press, { slackSignature: 'v1,abc' }))).error?.message).toMatch(/v0=<64 hex/);
    expect((await relayCall(relay(press, { slackTimestamp: 'yesterday' }))).error?.message).toMatch(/Unix seconds/);
    expect(fake.requests).toHaveLength(0);
  });

  it('Landledger refuses a bad signature, another team, an unlinked user, someone outside the step, the requester, a stale card and a Finance step', async () => {
    const { value } = await pending();
    const forged = await relayCall(relay(slackPress({ value, secret: 'not-the-channel-secret' })));
    expect(forged.error?.message).toMatch(/^Landledger API error 401: The Slack signature does not match/);
    expect(forged.error?.description).toMatch(/Slack's signature/);
    expect((await relayCall(relay(slackPress({ value, team: 'T_ELSEWHERE' })))).error?.message).toMatch(/401: Another Slack team or app/);
    expect((await relayCall(relay(slackPress({ value, user: 'U_NOBODY' })))).error?.message).toMatch(/403: This Slack user is not linked/);
    expect((await relayCall(relay(slackPress({ value, user: 'U_TAL' })))).error?.message).toMatch(/403: This step is for Budget Owners; tal\.levi@landbright\.test isn't in it/);
    expect((await relayCall(relay(slackPress({ value, user: 'U_EDEN' })))).error?.message).toMatch(/requester can't decide/);
    const stale = await relayCall(relay(slackPress({ value: `ll1|req_1|1|${'c'.repeat(64)}` })));
    expect(stale.error?.message).toBe('Landledger API error 409: The request changed or the evidence is stale; reopen it');
    expect(stale.error?.description).toMatch(/served more than 30 minutes ago/);
    fake.state.requests.get('req_1').steps[0].key = 'finance';
    expect((await relayCall(relay(slackPress({ value })))).error?.message).toMatch(/403: Only the budget owner's step is decided through a relay/);
    expect(fake.state.requests.get('req_1').status).toBe('pending');
  });

  it('a key without decisions:relay is refused by Landledger', async () => {
    const { value } = await pending();
    const response = await relayCall(relay(slackPress({ value })), { key: READ_KEY });
    expect(response.error?.message).toBe('Landledger API error 403: This needs the decisions:relay scope');
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
