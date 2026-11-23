/** The SAP poll trigger, the event trigger and OAuth tokens against the fake S/4HANA server. No real SAP system is called. */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { FakeS4, cloudEvent, deliveryOf, deliverCloudEvent } from './fake-s4';
import { SALES, basicCredential, deliver, freshState, nodeNamed, run, webhookMethod } from './helpers';
import { sapTrigger } from '../src/nodes/sap-trigger';
import { sapEvent } from '../src/nodes/sap-event';

const fake = new FakeS4();
let clock = Date.parse('2026-11-06T00:00:00Z');
const advance = (ms = 600_000) => (clock += ms);
beforeAll(async () => {
  process.env.LANDFLOW_SAP_ALLOWED_HOSTS = '127.0.0.1';
  await fake.start();
});
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  clock = Date.parse('2026-11-06T00:00:00Z');
  fake.now = () => clock;
  freshState();
});

const creds = () => basicCredential(fake);
const TRIGGER = { authentication: 'basic', service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder', timestampProperty: 'LastChangeDateTime', pollInterval: 300, maxRecordsPerPoll: 100 };
const poll = (parameters: JsonObject = {}, pollState?: JsonObject, mode: 'poll' | 'manual' = 'poll') => run('sapTrigger', { ...TRIGGER, ...parameters }, { credentials: creds(), mode, ...(pollState && { pollState }) });

describe('SAP Trigger (Poll) descriptor', () => {
  it('is a poll trigger with a one minute minimum and no tool use', () => {
    const d = sapTrigger.description;
    expect(d.triggerSource).toBe('poll');
    expect(d.kind).toBe('trigger');
    expect('usableAsTool' in d).toBe(false);
    expect(d.properties.find((p) => p.name === 'pollInterval')?.typeOptions?.minValue).toBe(60);
  });
});

describe('SAP Trigger (Poll)', () => {
  it('the first poll sets a baseline and emits nothing; no change means no run', async () => {
    const first = await poll();
    expect(first.error).toBeUndefined();
    expect(first.items).toEqual([]);
    expect(first.pollState).toMatchObject({ cursor: '2026-11-05T09:00:00.000Z' });
    const second = await poll({}, first.pollState);
    expect(second.items).toEqual([]);
    expect(second.pollState?.cursor).toBe('2026-11-05T09:00:00.000Z');
  });

  it('a change on SAP fires one run, once', async () => {
    const baseline = await poll();
    advance();
    const order = fake.addOrder('10100077');
    const hit = await poll({}, baseline.pollState);
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0]).toMatchObject({ SalesOrder: order.SalesOrder, SoldToParty: '10100077', __keys: { SalesOrder: String(order.SalesOrder) } });
    const again = await poll({}, hit.pollState);
    expect(again.items).toEqual([]);
    const third = await poll({}, again.pollState);
    expect(third.items).toEqual([]);
  });

  it('an order that changes again is emitted again, an untouched one is not', async () => {
    const baseline = await poll();
    advance();
    fake.touch('A_SalesOrder', { SalesOrder: '4500000002' }, { DeliveryBlockReason: '02' });
    const changed = await poll({}, baseline.pollState);
    expect(changed.items.map((i: any) => i.SalesOrder)).toEqual(['4500000002']);
    advance();
    fake.touch('A_SalesOrder', { SalesOrder: '4500000002' }, { DeliveryBlockReason: '' });
    const again = await poll({}, changed.pollState);
    expect(again.items.map((i: any) => i.SalesOrder)).toEqual(['4500000002']);
  });

  it('keeps the cursor across a restart: the state alone is enough, and a past change is not replayed', async () => {
    const baseline = await poll();
    advance();
    fake.addOrder('1');
    const one = await poll({}, baseline.pollState);
    expect(one.items).toHaveLength(1);
    const state = JSON.parse(JSON.stringify(one.pollState));
    freshState(); // a new plugin process: no metadata cache, no memory
    advance();
    fake.addOrder('2');
    const next = await poll({}, state);
    expect(next.items.map((i: any) => i.SoldToParty)).toEqual(['2']);
  });

  it('a record written late with an older timestamp (inside the overlap) is still seen', async () => {
    const baseline = await poll();
    advance(3_600_000);
    fake.addOrder('10100010'); // moves the cursor forward
    const first = await poll({}, baseline.pollState);
    expect(first.items).toHaveLength(1);
    fake.addOrder('10100011', { LastChangeDateTime: clock - 120_000, CreationDate: clock - 120_000 }); // two minutes older than the cursor
    const second = await poll({}, first.pollState);
    expect(second.items.map((i: any) => i.SoldToParty)).toEqual(['10100011']);
  });

  it('a date-only property is read with a day of overlap and still reports a changed record once', async () => {
    const params = { service: 'API_BUSINESS_PARTNER', entitySet: 'A_BusinessPartner', timestampProperty: 'LastChangeDate' };
    const baseline = await poll(params);
    expect(baseline.items).toEqual([]);
    expect(baseline.pollState?.cursor).toBe('2026-11-03T00:00:00.000Z');
    // The window reaches back more than a day: 1001 (11-02) is inside it and is silent.
    const quiet = await poll(params, baseline.pollState);
    expect(quiet.items).toEqual([]);
    fake.touch('A_BusinessPartner', { BusinessPartner: '1002' }, { SearchTerm1: 'GLOBEX2' }, Date.parse('2026-11-03T00:00:00Z'));
    const changed = await poll(params, baseline.pollState);
    expect(changed.items.map((i: any) => i.BusinessPartner)).toEqual(['1002']);
    const silent = await poll(params, changed.pollState);
    expect(silent.items).toEqual([]);
  });

  it('reads at most Max Records per Poll, oldest first, and catches up on the next poll', async () => {
    const baseline = await poll({ maxRecordsPerPoll: 2 });
    for (const customer of ['A', 'B', 'C']) {
      advance();
      fake.addOrder(customer);
    }
    const one = await poll({ maxRecordsPerPoll: 2 }, baseline.pollState);
    expect(one.items.map((i: any) => i.SoldToParty)).toEqual(['A', 'B']);
    const two = await poll({ maxRecordsPerPoll: 2 }, one.pollState);
    expect(two.items.map((i: any) => i.SoldToParty)).toEqual(['C']);
  });

  it('an extra filter narrows the feed; changing it starts again from a baseline', async () => {
    const baseline = await poll({ extraFilter: "SoldToParty eq 'WANTED'" });
    advance();
    fake.addOrder('OTHER');
    advance();
    fake.addOrder('WANTED');
    const hit = await poll({ extraFilter: "SoldToParty eq 'WANTED'" }, baseline.pollState);
    expect(hit.items.map((i: any) => i.SoldToParty)).toEqual(['WANTED']);
    const rebase = await poll({ extraFilter: "SoldToParty eq 'OTHER'" }, hit.pollState);
    expect(rebase.items).toEqual([]);
    expect((rebase.pollState as any).scope).not.toBe((hit.pollState as any).scope);
  });

  it('Execute in the editor shows the five most recent and returns no state', async () => {
    fake.addOrder('X');
    const manual = await poll({}, undefined, 'manual');
    expect(manual.items).toHaveLength(5);
    expect((manual.items[0] as any).SoldToParty).toBe('X');
    expect(manual.pollState).toBeUndefined();
  });

  it('an error leaves the state alone: the failure comes back and no state is returned', async () => {
    const baseline = await poll();
    fake.blockedServices.add('API_SALES_ORDER_SRV');
    const bad = await poll({}, baseline.pollState);
    expect(bad.error?.message).toMatch(/403/);
    expect(bad.pollState).toBeUndefined();
  });

  it('timestamp options come from $metadata (date types, change names first) and fall back to the catalog', async () => {
    const { loadOptions } = await import('./helpers');
    const live = await loadOptions('sapTrigger', 'timestampProperties', { authentication: 'basic', service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder' }, creds());
    expect(live.map((o) => o.value)).toEqual(['LastChangeDateTime', 'CreationDate']);
    const offline = await loadOptions('sapTrigger', 'timestampProperties', { authentication: 'basic', service: 'API_PRODUCT_SRV', entitySet: 'A_Product' });
    expect(offline.map((o) => o.value)).toEqual(['LastChangeDateTime', 'LastChangeDate']);
    const sets = await loadOptions('sapTrigger', 'entitySets', { authentication: 'basic', service: 'API_BUSINESS_PARTNER' });
    expect(sets.map((o) => o.value)).toEqual(['A_BusinessPartner']);
  });
});

describe('SAP Event Trigger', () => {
  const SECRET = 'a-long-random-secret-1234';
  const cred = { sapEventApi: { secret: SECRET } };
  const headerFor = (event = cloudEvent({ id: 'evt-1' }), mode: 'structured' | 'binary' | 'batch' = 'structured', secret = SECRET, header = 'x-sap-event-secret') => deliveryOf(event, mode, secret ? { header, value: secret } : undefined);
  const send = (d: { headers: Record<string, string>; body: string }, params: JsonObject = {}, credentials = cred, method = 'POST') => deliver('sapEvent', { eventTypes: '*', ...params }, credentials, d.headers, d.body, method);

  it('is an app webhook trigger with a required secret credential', () => {
    expect(sapEvent.description.triggerSource).toBe('appWebhook');
    expect(sapEvent.description.credentials).toEqual([{ name: 'sapEventApi', required: true }]);
  });

  it('registers nothing at SAP: create needs a long secret and remembers the URL, checkExists and delete follow', async () => {
    const weak = await webhookMethod('sapEvent', 'create', {}, { sapEventApi: { secret: 'short' } });
    expect(weak.error?.message).toMatch(/at least 16 characters/);
    const created = await webhookMethod('sapEvent', 'create', {}, cred);
    expect(created.error).toBeUndefined();
    expect(created.staticData).toEqual({ url: 'http://host.test/api/webhook/app/wf_test/n1' });
    expect((await webhookMethod('sapEvent', 'checkExists', {}, cred, created.staticData)).exists).toBe(true);
    expect((await webhookMethod('sapEvent', 'checkExists', {}, cred, { url: 'http://other' })).exists).toBe(false);
    expect((await webhookMethod('sapEvent', 'delete', {}, cred, created.staticData)).staticData).toEqual({});
    expect(fake.requests).toHaveLength(0);
  });

  it('a valid delivery starts a run with the parsed event, keyed for redelivery', async () => {
    const r = await send(headerFor());
    expect(r.error).toBeUndefined();
    expect(r.items).toHaveLength(1);
    expect((r.items![0].json as any)).toMatchObject({ id: 'evt-1', entity: 'BusinessPartner', action: 'Changed', keys: { BusinessPartner: '1000' } });
    expect(r.idempotencyKey).toBe('/default/sap.s4.beh/FAKE|evt-1');
    const again = await send(headerFor());
    expect(again.idempotencyKey).toBe(r.idempotencyKey);
  });

  it('refuses a wrong, missing or unconfigured secret and does not start a run', async () => {
    for (const d of [headerFor(undefined, 'structured', 'wrong-secret-wrong-secret'), headerFor(undefined, 'structured', '')]) {
      const r = await send(d);
      expect(r.response?.status).toBe(401);
      expect(r.items).toBeUndefined();
    }
    const unset = await send(headerFor(), {}, { sapEventApi: { secret: '' } });
    expect(unset.response?.status).toBe(401);
    const wrongHeader = await send(headerFor(undefined, 'structured', SECRET, 'x-other'));
    expect(wrongHeader.response?.status).toBe(401);
  });

  it('honours a configured header name', async () => {
    const r = await send(headerFor(undefined, 'structured', SECRET, 'x-broker-token'), {}, { sapEventApi: { secret: SECRET, headerName: 'X-Broker-Token' } } as never);
    expect(r.items).toHaveLength(1);
  });

  it('answers 400 to a body that is not a CloudEvent and 405 to a GET', async () => {
    const bad = await send({ headers: { 'content-type': 'application/json', 'x-sap-event-secret': SECRET }, body: '{"hello":1}' });
    expect(bad.response?.status).toBe(400);
    expect(JSON.stringify(bad.response)).toMatch(/missing/);
    const get = await send(headerFor(), {}, cred, 'GET');
    expect(get.response?.status).toBe(405);
  });

  it('reads binary mode and a batch (one run, all events)', async () => {
    const binary = await send(headerFor(cloudEvent({ id: 'b1', type: 'sap/s4/beh/salesorder/v1/SalesOrder/Created/v1', data: { SalesOrder: '4500000009' } }), 'binary'));
    expect(binary.items![0].json).toMatchObject({ id: 'b1', entity: 'SalesOrder', action: 'Created', keys: { SalesOrder: '4500000009' } });
    const batch = await send(headerFor([cloudEvent({ id: 'x1' }), cloudEvent({ id: 'x2' })] as never, 'batch'));
    expect(batch.items!.map((i) => (i.json as any).id)).toEqual(['x1', 'x2']);
  });

  it('filters by event type and answers 200 without a run for the rest', async () => {
    const params = { eventTypes: '*SalesOrder.Created*' };
    const skipped = await send(headerFor(), params);
    expect(skipped.items).toBeUndefined();
    expect(skipped.response?.status).toBe(200);
    const taken = await send(headerFor(cloudEvent({ type: 'sap.s4.beh.salesorder.v1.SalesOrder.Created.v1' })), params);
    expect(taken.items).toHaveLength(1);
  });

  it('the fake delivery helper posts to a URL (used by the live check)', async () => {
    const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const result = await deliverCloudEvent(`http://127.0.0.1:${port}/hook`, cloudEvent({ id: 'live' }), { secret: SECRET });
    server.close();
    expect(result.status).toBe(200);
    expect(received[0].headers['x-sap-event-secret']).toBe(SECRET);
    expect(JSON.parse(received[0].body).id).toBe('live');
  });
});

describe('OAuth 2.0 against the fake token endpoint', () => {
  const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${fake.url}/sap/public/bc/sec/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  async function authorize(verifier: string) {
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const query = new URLSearchParams({ response_type: 'code', client_id: 'landflow', redirect_uri: 'http://localhost:3650/api/oauth2/callback', state: 's1', code_challenge: challenge, code_challenge_method: 'S256' });
    const response = await fetch(`${fake.url}/sap/public/bc/sec/oauth2/authorize?${query}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('state')).toBe('s1');
    return location.searchParams.get('code')!;
  }

  it('a PKCE round trip: code, token, a node call, refresh, and a revoked refresh token', async () => {
    const verifier = b64url(randomBytes(32));
    const code = await authorize(verifier);
    const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: 'not-the-verifier', client_id: 'landflow' });
    expect(wrong.status).toBe(400);
    const code2 = await authorize(verifier);
    const ok = await token({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: 'landflow' });
    expect(ok.status).toBe(200);
    expect(ok.body.refresh_token).toMatch(/^rt_/);
    const credential = { sapS4hanaOAuth2Api: { baseUrl: fake.url, accessToken: ok.body.access_token, clientId: 'landflow' } };
    const read = await run('sapOData', { ...SALES, authentication: 'oAuth2', operation: 'list', top: 1 }, { credentials: credential });
    expect(read.error).toBeUndefined();
    expect(fake.requests.at(-1)!.headers.authorization).toBe(`Bearer ${ok.body.access_token}`);
    // A used code cannot be exchanged twice.
    expect((await token({ grant_type: 'authorization_code', code: code2, code_verifier: verifier })).status).toBe(400);
    // Refresh: a new access token, the old one keeps working until it expires.
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(ok.body.access_token);
    fake.refreshTokens.delete(ok.body.refresh_token);
    expect((await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token })).status).toBe(400);
  });

  it('an expired access token reads like a 401, which makes the host renew it once', async () => {
    const ok = await token({ grant_type: 'client_credentials' }, { authorization: `Basic ${Buffer.from('client:secret').toString('base64')}` });
    expect(ok.status).toBe(200);
    const credential = { sapS4hanaOAuth2ClientApi: { baseUrl: fake.url, accessToken: ok.body.access_token, clientId: 'client' } };
    const params = { ...SALES, authentication: 'oAuth2Client', operation: 'list', top: 1 };
    expect((await run('sapOData', params, { credentials: credential })).error).toBeUndefined();
    clock += 2 * 3_600_000;
    const stale = await run('sapOData', params, { credentials: credential });
    expect(stale.error?.message).toMatch(/401 Unauthorized/);
    // The host then sends a renewed token with the repeated call.
    const renewed = await token({ grant_type: 'client_credentials' }, { authorization: `Basic ${Buffer.from('client:secret').toString('base64')}` });
    expect((await run('sapOData', params, { credentials: { sapS4hanaOAuth2ClientApi: { baseUrl: fake.url, accessToken: renewed.body.access_token, clientId: 'client' } } })).error).toBeUndefined();
  });

  it('the OAuth credential types extend the host\'s generic type and pin the grant', async () => {
    const { plugin } = await import('../src/main');
    const pkce = plugin.credentialTypes!.find((c) => c.name === 'sapS4hanaOAuth2Api')!;
    const cc = plugin.credentialTypes!.find((c) => c.name === 'sapS4hanaOAuth2ClientApi')!;
    expect(pkce.extends).toEqual(['oAuth2Api']);
    expect(cc.extends).toEqual(['oAuth2Api']);
    expect(pkce.properties.find((p) => p.name === 'grantType')?.default).toBe('pkce');
    expect(cc.properties.find((p) => p.name === 'grantType')?.default).toBe('clientCredentials');
    expect(nodeNamed('sapOData').description.credentials?.map((c) => c.name)).toEqual(['sapS4hanaBasicApi', 'sapS4hanaOAuth2Api', 'sapS4hanaOAuth2ClientApi', 'sapSandboxApi']);
  });
});
