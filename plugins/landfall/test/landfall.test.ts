/** The Landfall node and its credentials against the in-memory fake. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Landfall } from '../src/nodes/landfall';
import { parseHints } from '../src/nodes/landfall';
import { SEED, startFakeLandfall, type FakeLandfall } from './fake-landfall';
import { heartbeatCredentials, jsonOf, landfallCredentials, run, testCredentials } from './helpers';

let fake: FakeLandfall;
beforeAll(async () => {
  fake = await startFakeLandfall();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const node = (parameters: Record<string, unknown>, options: Parameters<typeof run>[2] = {}) =>
  run(Landfall, parameters as any, { credentials: landfallCredentials(fake), ...options });

describe('credentials', () => {
  it('landfallApi test lists one incident with the API key', async () => {
    const result = await testCredentials('landfallApi', { baseUrl: fake.url, orgSlug: SEED.orgSlug, apiKey: SEED.apiKey });
    expect(result.ok).toBe(true);
    expect(fake.requests[0]).toMatchObject({ path: `/o/${SEED.orgSlug}/incidents`, query: { limit: '1' }, authorization: `Bearer ${SEED.apiKey}` });
  });

  it('reports a wrong key without echoing it', async () => {
    const result = await testCredentials('landfallApi', { baseUrl: fake.url, orgSlug: SEED.orgSlug, apiKey: 'lf_key_wrong_value' });
    expect(result).toEqual({ ok: false, message: 'Landfall API error 401: Unauthorized' });
  });

  it('reports an unknown org and an unreachable server', async () => {
    expect((await testCredentials('landfallApi', { baseUrl: fake.url, orgSlug: 'nope', apiKey: SEED.apiKey })).message).toMatch(/404.*Organization not found/);
    const down = await testCredentials('landfallApi', { baseUrl: 'http://127.0.0.1:1', orgSlug: 'a', apiKey: 'k' });
    expect(down.message).toMatch(/Landfall API request failed: fetch failed/);
  });

  it('landfallHeartbeatApi checks only that the fields are set', async () => {
    expect((await testCredentials('landfallHeartbeatApi', { baseUrl: fake.url, orgSlug: 'a', token: 't' })).ok).toBe(true);
    expect((await testCredentials('landfallHeartbeatApi', { baseUrl: fake.url, orgSlug: 'a', token: '' })).ok).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('incident: open from alert and recover', () => {
  const alert = { resource: 'incident', operation: 'openFromAlert', title: 'checkout 5xx', severity: 'sev2' };

  it('opens a room with the ingest token and maps the fields', async () => {
    const response = await node({
      ...alert,
      additionalFields: { dedupKey: 'checkout-5xx', entityHints: 'service:checkout, env:prod', summary: 'error rate 12%', url: 'https://alerts.example/1', occurredAt: '2026-10-01T10:00:00Z' },
    });
    const [result] = jsonOf(response);
    expect(result).toMatchObject({ outcome: 'opened', opened: true, proposedSeverity: 'sev2', entity: { kind: 'service', id: 'checkout' } });
    const sent = fake.requests[0];
    expect(sent).toMatchObject({ method: 'POST', path: '/triggers', authorization: `Bearer ${SEED.ingestToken}` });
    expect(sent.body).toEqual({
      landfallSource: 'remote',
      connectionId: SEED.connectionId,
      title: 'checkout 5xx',
      severity: 'sev2',
      kind: 'trigger',
      dedupKey: 'checkout-5xx',
      entityHints: ['service:checkout', 'env:prod'],
      summary: 'error rate 12%',
      url: 'https://alerts.example/1',
      occurredAt: '2026-10-01T10:00:00.000Z',
    });
    expect(fake.incidents).toHaveLength(1);
  });

  it('a repeat attaches (opened false) and appends trigger.repeated', async () => {
    await node({ ...alert, additionalFields: { dedupKey: 'k1' } });
    const [second] = jsonOf(await node({ ...alert, additionalFields: { dedupKey: 'k1' } }));
    expect(second).toMatchObject({ outcome: 'attached', opened: false });
    expect(fake.incidents).toHaveLength(1);
    expect(fake.incidents[0].events.map((e) => e.type)).toContain('trigger.repeated');
  });

  it('a recovery with the same key is recorded and the room stays open', async () => {
    await node({ ...alert, additionalFields: { dedupKey: 'k2' } });
    const [recovered] = jsonOf(await node({ resource: 'incident', operation: 'recover', title: 'checkout 5xx', severity: 'sev2', dedupKey: 'k2' }));
    expect(recovered).toMatchObject({ outcome: 'recorded', opened: false });
    expect(fake.requests.at(-1)!.body).toMatchObject({ kind: 'recovery', dedupKey: 'k2' });
    expect(fake.incidents[0].status).toBe('open');
    const [after] = jsonOf(await node({ ...alert, additionalFields: { dedupKey: 'k2' } }));
    expect(after).toMatchObject({ outcome: 'attached' });
  });

  it('a new room opens once the old one has ended', async () => {
    await node({ ...alert, additionalFields: { dedupKey: 'k3' } });
    fake.append(fake.incidents[0], 'status.changed', { status: 'resolved' });
    const [again] = jsonOf(await node({ ...alert, additionalFields: { dedupKey: 'k3' } }));
    expect(again).toMatchObject({ outcome: 'opened', opened: true });
    expect(fake.incidents).toHaveLength(2);
  });

  it('a recovery for an unknown key is ignored', async () => {
    const [result] = jsonOf(await node({ resource: 'incident', operation: 'recover', title: 't', severity: 'sev3', dedupKey: 'never-opened' }));
    expect(result).toMatchObject({ outcome: 'ignored', opened: false });
  });

  it('the connection id can come from Additional Fields', async () => {
    await node(
      { ...alert, additionalFields: { connectionId: 'conn_other' } },
      { credentials: landfallCredentials(fake, { connectionId: '' }), continueOnFail: true },
    );
    expect(fake.requests[0].body.connectionId).toBe('conn_other');
  });

  it('explains a 422 for a missing or unhealthy connection', async () => {
    const unhealthy = await node(alert, { credentials: landfallCredentials(fake, { connectionId: SEED.unhealthyConnectionId }), continueOnFail: true });
    const [failure] = jsonOf(unhealthy);
    expect(failure.error).toMatch(/Landfall API error 422: Remote source trigger refused: .*not healthy/);
    expect(failure.description).toMatch(/exists and whose last health check passed/);
    const missing = await node(alert, { credentials: landfallCredentials(fake, { connectionId: 'conn_nope' }), continueOnFail: true });
    expect(jsonOf(missing)[0].error).toMatch(/422.*not found/);
  });

  it('needs a connection id and an ingest token', async () => {
    const noConnection = await node(alert, { credentials: landfallCredentials(fake, { connectionId: '' }), continueOnFail: true });
    expect(jsonOf(noConnection)[0].error).toMatch(/Connection ID is required/);
    const noToken = await node(alert, { credentials: landfallCredentials(fake, { ingestToken: '' }), continueOnFail: true });
    expect(jsonOf(noToken)[0].error).toMatch(/no Ingest Token/);
    const wrongToken = await node(alert, { credentials: landfallCredentials(fake, { ingestToken: 'bad' }), continueOnFail: true });
    expect(jsonOf(wrongToken)[0].description).toMatch(/ingest token/);
  });

  it('rejects an invalid date and a missing dedup key on recover', async () => {
    const date = await node({ ...alert, additionalFields: { occurredAt: 'not a date' } }, { continueOnFail: true });
    expect(jsonOf(date)[0].error).toMatch(/not a date/);
    const key = await node({ resource: 'incident', operation: 'recover', title: 't', severity: 'sev3', dedupKey: '' }, { continueOnFail: true });
    expect(jsonOf(key)[0].error).toMatch(/Dedup Key is required/);
  });

  it('parses entity hints from lists and lines', () => {
    expect(parseHints('a:b,\n c:d ,')).toEqual(['a:b', 'c:d']);
    expect(parseHints(['x:y', ' '])).toEqual(['x:y']);
  });
});

describe('incident: manual open, declare, get, get many', () => {
  it('Open Manually uses the org trigger route with the API key', async () => {
    const [result] = jsonOf(await node({ resource: 'incident', operation: 'openManually', title: 'by hand', severity: 'sev1', entityHint: 'service:db' }));
    expect(result).toMatchObject({ outcome: 'opened', opened: true, proposedSeverity: 'sev1', entity: { kind: 'service', id: 'db' } });
    expect(fake.requests[0]).toMatchObject({ path: `/o/${SEED.orgSlug}/triggers`, authorization: `Bearer ${SEED.apiKey}`, body: { title: 'by hand', severity: 'sev1', entityHint: 'service:db' } });
  });

  it('Declare returns the IncidentView', async () => {
    const [view] = jsonOf(await node({ resource: 'incident', operation: 'declare', title: 'declared', severity: 'sev4', description: 'why' }));
    expect(view).toMatchObject({ title: 'declared', severity: 'sev4', status: 'open', number: 1 });
    expect(view).not.toHaveProperty('events');
    expect(fake.incidents[0].events.map((e) => e.type)).toEqual(['incident.opened', 'chat.message']);
  });

  it('Get returns the state, optionally as of a seq', async () => {
    const incident = fake.seed({ title: 'state me' });
    fake.append(incident, 'status.changed', { status: 'mitigated' });
    const [latest] = jsonOf(await node({ resource: 'incident', operation: 'get', incidentId: incident.id, throughSeq: -1 }));
    expect(latest).toMatchObject({ incidentId: incident.id, state: { status: 'mitigated', title: 'state me' } });
    const [past] = jsonOf(await node({ resource: 'incident', operation: 'get', incidentId: incident.id, throughSeq: 0 }));
    expect(past).toMatchObject({ throughSeq: 0, state: { status: 'open' } });
    expect(fake.requests[0].query).toEqual({});
    expect(fake.requests[1].query).toEqual({ throughSeq: '0' });
  });

  it('Get maps a 404', async () => {
    const [failure] = jsonOf(await node({ resource: 'incident', operation: 'get', incidentId: 'inc_nope' }, { continueOnFail: true }));
    expect(failure.error).toBe('Landfall API error 404: Incident not found: inc_nope');
  });

  it('Get Many filters by status and search, pages with the cursor for Return All, and honours Limit', async () => {
    for (let n = 1; n <= 5; n++) fake.seed({ title: `svc ${n}` });
    fake.append(fake.incidents[0], 'status.changed', { status: 'closed' });
    const open = jsonOf(await node({ resource: 'incident', operation: 'getAll', returnAll: true, filters: { status: 'open' } }));
    expect(open.map((i) => i.number)).toEqual([5, 4, 3, 2]);
    const closed = jsonOf(await node({ resource: 'incident', operation: 'getAll', returnAll: true, filters: { status: 'closed' } }));
    expect(closed.map((i) => i.number)).toEqual([1]);
    expect(jsonOf(await node({ resource: 'incident', operation: 'getAll', returnAll: true, filters: { status: 'all', q: 'SVC 3' } })).map((i) => i.number)).toEqual([3]);
    expect(jsonOf(await node({ resource: 'incident', operation: 'getAll', returnAll: false, limit: 2, filters: { status: 'all' } })).map((i) => i.number)).toEqual([5, 4]);
  });

  it('Return All follows nextCursor across pages', async () => {
    for (let n = 1; n <= 205; n++) fake.seed({ title: `bulk ${n}` });
    fake.requests.length = 0;
    const all = jsonOf(await node({ resource: 'incident', operation: 'getAll', returnAll: true, filters: { status: 'all' } }));
    expect(all).toHaveLength(205);
    expect(fake.requests.map((r) => r.query.cursor)).toEqual([undefined, '200']);
  });
});

describe('timeline', () => {
  it('Get Events returns events ascending, with limit (newest rows) and sinceSeq', async () => {
    const incident = fake.seed({ title: 'events' });
    for (let n = 0; n < 4; n++) fake.append(incident, 'chat.message', { text: `m${n}` });
    const newest = jsonOf(await node({ resource: 'timeline', operation: 'getEvents', incidentId: incident.id, returnAll: false, limit: 2 }));
    expect(newest.map((e) => e.seq)).toEqual([3, 4]);
    const since = jsonOf(await node({ resource: 'timeline', operation: 'getEvents', incidentId: incident.id, returnAll: true, eventOptions: { sinceSeq: 2 } }));
    expect(since.map((e) => e.seq)).toEqual([3, 4]);
    expect(fake.requests.at(-1)!.query).toEqual({ sinceSeq: '2' });
  });

  it('Add Event reads the newest seq first and writes with expectedSeq', async () => {
    const incident = fake.seed({ title: 'add' });
    fake.append(incident, 'chat.message', { text: 'one' });
    const [event] = jsonOf(await node({ resource: 'timeline', operation: 'addEvent', incidentId: incident.id, eventType: 'chat.message', payload: '{"text":"hi"}' }));
    expect(event).toMatchObject({ seq: 2, type: 'chat.message', payload: { text: 'hi', displayName: 'Fake Member' } });
    expect(fake.requests.map((r) => `${r.method} ${r.query.limit ?? ''}`)).toEqual(['GET 1', 'POST ']);
    expect(fake.requests[1].body).toEqual({ type: 'chat.message', expectedSeq: 2, payload: { text: 'hi' } });
  });

  it('Add Event retries once on a conflict', async () => {
    const incident = fake.seed({ title: 'race' });
    fake.concurrentWrites = 1;
    const [event] = jsonOf(await node({ resource: 'timeline', operation: 'addEvent', incidentId: incident.id, eventType: 'note.custom', payload: '{}' }));
    expect(event.seq).toBe(2);
    expect(fake.requests.map((r) => r.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
  });

  it('Add Event gives up after the second conflict', async () => {
    const incident = fake.seed({ title: 'race' });
    fake.concurrentWrites = 2;
    const [failure] = jsonOf(await node({ resource: 'timeline', operation: 'addEvent', incidentId: incident.id, eventType: 'note.custom', payload: '{}' }, { continueOnFail: true }));
    expect(failure.error).toMatch(/Landfall API error 409: Conflict/);
    expect(failure.description).toMatch(/Try again/);
  });

  it('Add Event surfaces refused types and bad JSON', async () => {
    const incident = fake.seed({ title: 'refuse' });
    const refused = await node({ resource: 'timeline', operation: 'addEvent', incidentId: incident.id, eventType: 'agent.step', payload: '{}' }, { continueOnFail: true });
    expect(jsonOf(refused)[0].error).toMatch(/400.*cannot be appended/);
    const bad = await node({ resource: 'timeline', operation: 'addEvent', incidentId: incident.id, eventType: 'x', payload: '{nope' }, { continueOnFail: true });
    expect(jsonOf(bad)[0].error).toMatch(/Payload is not valid JSON/);
    const array = await node({ resource: 'timeline', operation: 'addEvent', incidentId: incident.id, eventType: 'x', payload: '[]' }, { continueOnFail: true });
    expect(jsonOf(array)[0].error).toMatch(/must be a JSON object/);
  });

  it('Add Note posts a chat.message', async () => {
    const incident = fake.seed({ title: 'note' });
    const [event] = jsonOf(await node({ resource: 'timeline', operation: 'addNote', incidentId: incident.id, text: 'restarted the pod' }));
    expect(event).toMatchObject({ type: 'chat.message', payload: { text: 'restarted the pod' } });
  });
});

describe('remediation', () => {
  it('records a fix applied outside Landfall, keyed by the suggestion seq', async () => {
    const incident = fake.seed({ title: 'fix' });
    const proposed = fake.append(incident, 'remediation.proposed', { remediationId: 'rem_1', description: 'restart' }, 'agent');
    const [event] = jsonOf(
      await node({
        resource: 'remediation',
        operation: 'recordAppliedExternally',
        incidentId: incident.id,
        sourceSeq: proposed.seq,
        additionalFields: { remediationId: 'rem_1', action: 'kubectl rollout restart deploy/checkout', note: 'JIRA-1' },
      }),
    );
    expect(event).toMatchObject({ type: 'remediation.applied-externally', payload: { sourceSeq: 1, remediationId: 'rem_1', action: 'kubectl rollout restart deploy/checkout', note: 'JIRA-1', displayName: 'Fake Member' } });
  });

  it('refuses a sourceSeq that is not a suggestion, and over-long text before calling Landfall', async () => {
    const incident = fake.seed({ title: 'fix' });
    const notSuggestion = await node({ resource: 'remediation', operation: 'recordAppliedExternally', incidentId: incident.id, sourceSeq: 0, additionalFields: {} }, { continueOnFail: true });
    expect(jsonOf(notSuggestion)[0].error).toMatch(/400.*not a suggestion/);
    fake.requests.length = 0;
    const long = await node(
      { resource: 'remediation', operation: 'recordAppliedExternally', incidentId: incident.id, sourceSeq: 1, additionalFields: { action: 'x'.repeat(501) } },
      { continueOnFail: true },
    );
    expect(jsonOf(long)[0].error).toMatch(/Action is 501 characters; Landfall accepts up to 500/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('heartbeat', () => {
  it('pings with the heartbeat token', async () => {
    const [result] = jsonOf(await run(Landfall, { resource: 'heartbeat', operation: 'ping', heartbeatName: SEED.heartbeatName }, { credentials: heartbeatCredentials(fake) }));
    expect(result).toEqual({ ok: true, heartbeat: SEED.heartbeatName });
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: `/o/${SEED.orgSlug}/heartbeats/${SEED.heartbeatName}/ping`, authorization: `Bearer ${SEED.heartbeatToken}` });
    expect(fake.heartbeats.get(SEED.heartbeatName)!.pings).toHaveLength(1);
  });

  it('maps a wrong token and an unknown heartbeat', async () => {
    const wrong = await run(Landfall, { resource: 'heartbeat', operation: 'ping', heartbeatName: SEED.heartbeatName }, { credentials: heartbeatCredentials(fake, { token: 'bad' }), continueOnFail: true });
    expect(jsonOf(wrong)[0].error).toMatch(/401/);
    const unknown = await run(Landfall, { resource: 'heartbeat', operation: 'ping', heartbeatName: 'nope' }, { credentials: heartbeatCredentials(fake), continueOnFail: true });
    expect(jsonOf(unknown)[0].error).toMatch(/404.*Heartbeat not found/);
  });
});

describe('errors and rate limits', () => {
  it('honours Retry-After once on a 429', async () => {
    fake.throttle(1, 0);
    const [view] = jsonOf(await node({ resource: 'incident', operation: 'declare', title: 'after throttle' }));
    expect(view).toMatchObject({ title: 'after throttle' });
    expect(fake.requests.map((r) => r.method)).toEqual(['POST', 'POST']);
  });

  it('fails when the second attempt is limited too, with the hint', async () => {
    fake.throttle(2, 0);
    const [failure] = jsonOf(await node({ resource: 'incident', operation: 'declare', title: 'x' }, { continueOnFail: true }));
    expect(failure.error).toMatch(/429/);
    expect(failure.description).toMatch(/300 requests per 60 s/);
  });

  it('does not wait for a long Retry-After', async () => {
    fake.throttle(1, 60);
    const [failure] = jsonOf(await node({ resource: 'incident', operation: 'declare', title: 'x' }, { continueOnFail: true }));
    expect(failure.error).toMatch(/429/);
    expect(fake.requests).toHaveLength(1);
  });

  it('stops at the first failing item without continueOnFail, naming it, and continues with it', async () => {
    const items = [{}, {}];
    const perItem = [{ incidentId: 'inc_nope' }, { incidentId: 'inc_nope' }];
    const stopped = await node({ resource: 'incident', operation: 'get', incidentId: '' }, { items, perItem });
    expect(stopped.error?.message).toMatch(/404/);
    const kept = await node({ resource: 'incident', operation: 'get', incidentId: '' }, { items, perItem, continueOnFail: true });
    expect(jsonOf(kept)).toHaveLength(2);
    expect(kept.outputs[0][1].pairedItem).toEqual({ item: 1 });
  });

  it('reports an unreachable Landfall', async () => {
    const [failure] = jsonOf(await node({ resource: 'incident', operation: 'getAll', returnAll: false, limit: 1, filters: {} }, { credentials: landfallCredentials(fake, { baseUrl: 'http://127.0.0.1:1' }), continueOnFail: true }));
    expect(failure.error).toMatch(/Landfall API request failed: fetch failed/);
  });

  it('never puts a token in an error', async () => {
    const [failure] = jsonOf(await node({ resource: 'incident', operation: 'get', incidentId: 'x' }, { credentials: landfallCredentials(fake, { apiKey: 'lf_key_secret_value' }), continueOnFail: true }));
    expect(JSON.stringify(failure)).not.toContain('lf_key_secret_value');
  });
});
