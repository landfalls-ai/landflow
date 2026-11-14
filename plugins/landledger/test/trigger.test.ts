/**
 * The Landledger Trigger: registration with an admin key (create / checkExists / delete against the fake), a
 * subscription an admin made (the credential's secret, nothing registered), signed, forged, stale and filtered
 * deliveries, and the redelivery key; the Standard Webhooks signature itself.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type JsonObject } from '@landflow/protocol';
import { runWebhook, runWebhookMethod } from '@landflow/sdk';
import { LandledgerTrigger } from '../src/nodes/landledger-trigger';
import { signStandardWebhook, verifyStandardWebhook } from '../src/signature';
import { ADMIN_KEY, KEY, startFakeLandledger, type FakeLandledger } from './fake-landledger';
import { credentials, extras } from './helpers';

let fake: FakeLandledger;
beforeAll(async () => {
  fake = await startFakeLandledger();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

describe('Standard Webhooks signature', () => {
  const secret = `whsec_${Buffer.from('a test secret').toString('base64')}`;
  const body = '{"type":"request.decided"}';
  const now = Date.parse('2026-11-14T15:03:00Z');
  const ts = Math.floor(now / 1000);

  it('accepts a good signature, also among several; rejects a changed body, id, secret, version or a stale stamp', () => {
    const good = signStandardWebhook(secret, body, 'msg_1', ts);
    expect(verifyStandardWebhook(secret, body, { id: 'msg_1', timestamp: String(ts), signature: `v1,AAAA ${good}` }, { now })).toBe(true);
    expect(verifyStandardWebhook(secret, `${body} `, { id: 'msg_1', timestamp: String(ts), signature: good }, { now })).toBe(false);
    expect(verifyStandardWebhook(secret, body, { id: 'msg_2', timestamp: String(ts), signature: good }, { now })).toBe(false);
    expect(verifyStandardWebhook(`whsec_${Buffer.from('other').toString('base64')}`, body, { id: 'msg_1', timestamp: String(ts), signature: good }, { now })).toBe(false);
    expect(verifyStandardWebhook(secret, body, { id: 'msg_1', timestamp: String(ts), signature: good.replace('v1,', 'v2,') }, { now })).toBe(false);
    expect(verifyStandardWebhook(secret, body, { id: 'msg_1', timestamp: String(ts - 3600), signature: signStandardWebhook(secret, body, 'msg_1', ts - 3600) }, { now })).toBe(false);
    expect(verifyStandardWebhook('', body, { id: 'msg_1', timestamp: String(ts), signature: good }, { now })).toBe(false);
  });
});

describe('Landledger Trigger', () => {
  const URL_ = 'https://landflow.example/api/webhook/app/wf_l/n1';
  const node = { id: 'n1', name: 'Landledger Trigger', type: 'landledger.landledgerTrigger', typeVersion: 1 };
  const admin = () => credentials(fake, { apiKey: ADMIN_KEY });
  const base = (parameters: JsonObject, creds: Record<string, JsonObject>, webhookUrl = URL_) => ({ protocol: PROTOCOL_VERSION, workflowId: 'wf_l', node, parameters, webhookUrl, credentials: creds });
  const method = (name: 'create' | 'delete' | 'checkExists', staticData: JsonObject, parameters: JsonObject = {}, creds = admin(), webhookUrl?: string) =>
    runWebhookMethod(LandledgerTrigger, { ...base(parameters, creds, webhookUrl), method: name, staticData }, extras);
  const created = async (parameters: JsonObject = {}) => {
    const response = await method('create', {}, parameters);
    expect(response.error).toBeUndefined();
    return response.staticData as JsonObject;
  };
  const request = { id: 'req_7', number: 'R-7', kind: 'infra_change', title: 'Second replica', status: 'pending', costCenter: { code: 'ENG-PLATFORM', name: 'Platform', owner: null }, amount: { amount: '1840.000000', currency: 'USD' } };
  const stepPending: JsonObject = {
    type: 'request.step_pending',
    timestamp: '2026-11-14T15:03:00.000Z',
    data: {
      request,
      step: { position: 1, key: 'owner', label: 'Budget owner', groups: ['Budget Owners'], deadlineAt: '2026-11-16T15:03:00.000Z', escalated: false },
      approvers: [{ name: 'Amit Gal', email: 'amit.gal@landbright.test', sub: 'sub-amit', via: 'group', group: 'Budget Owners' }],
      url: 'http://localhost:4811/requests/req_7',
      evidenceSha256: 'b'.repeat(64),
    },
  };
  const deliver = (staticData: JsonObject, payload: JsonObject, options: { parameters?: JsonObject; signature?: string; timestamp?: number; id?: string; creds?: Record<string, JsonObject>; secret?: string } = {}) => {
    const raw = JSON.stringify(payload);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const id = options.id ?? 'evt_1';
    const secret = options.secret ?? String(staticData.secret ?? '');
    return runWebhook(
      LandledgerTrigger,
      {
        ...base(options.parameters ?? {}, options.creds ?? admin()),
        staticData,
        request: {
          method: 'POST',
          path: '/hook',
          headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': options.signature ?? signStandardWebhook(secret, raw, id, timestamp) },
          query: {},
          body: Buffer.from(raw).toString('base64'),
        },
      },
      extras,
    );
  };

  it('subscribes on publish with the chosen events and keeps id and secret', async () => {
    const data = await created({ events: ['request.decided', 'request.step_pending'] });
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/webhooks', body: { url: URL_, events: ['request.decided', 'request.step_pending'] } });
    expect(fake.requests.at(-1)!.body.description).toMatch(/Landflow workflow wf_l/);
    expect(data).toMatchObject({ id: 'wh_1', url: URL_, events: 'request.decided,request.step_pending' });
    expect(String(data.secret)).toMatch(/^whsec_/);
  });

  it('checkExists asks Landledger and compares the URL and events; a change re-subscribes, replacing the old one', async () => {
    const data = await created();
    expect((await method('checkExists', data)).exists).toBe(true);
    expect((await method('checkExists', data, { events: ['request.decided'] })).exists ?? false).toBe(false);
    expect((await method('checkExists', data, {}, admin(), 'https://elsewhere.example/hook')).exists ?? false).toBe(false);
    const again = await method('create', data, { events: ['request.decided'] });
    expect(again.error).toBeUndefined();
    expect([...fake.state.webhooks.keys()]).toEqual(['wh_2']);
    fake.state.webhooks.clear();
    expect((await method('checkExists', again.staticData as JsonObject, { events: ['request.decided'] })).exists ?? false).toBe(false);
  });

  it('unsubscribes on unpublish; a subscription already gone is fine', async () => {
    const data = await created();
    const removed = await method('delete', data);
    expect(removed.error).toBeUndefined();
    expect(removed.staticData).toEqual({});
    expect(fake.state.webhooks.size).toBe(0);
    expect((await method('delete', data)).error).toBeUndefined();
  });

  it('without an admin key, registration fails with the scope it needs', async () => {
    const response = await method('create', {}, {}, credentials(fake));
    expect(response.error?.message).toMatch(/403/);
    expect(response.error?.description).toMatch(/needs admin/);
  });

  it('turns a signed delivery into an item with the request id, kind and cost center lifted out, once per webhook-id', async () => {
    const data = await created();
    const response = await deliver(data, stepPending, { id: 'evt_42' });
    expect(response.error).toBeUndefined();
    expect(response.idempotencyKey).toBe('evt_42');
    expect(response.items).toHaveLength(1);
    expect(response.items![0].json).toMatchObject({
      type: 'request.step_pending',
      id: 'evt_42',
      timestamp: '2026-11-14T15:03:00.000Z',
      requestId: 'req_7',
      kind: 'infra_change',
      costCenter: 'ENG-PLATFORM',
      evidenceSha256: 'b'.repeat(64),
      approvers: [{ email: 'amit.gal@landbright.test' }],
      step: { position: 1 },
    });
  });

  it('a missing, forged or stale signature answers 401 and starts nothing', async () => {
    const data = await created();
    for (const options of [{ signature: '' }, { secret: `whsec_${Buffer.from('forged').toString('base64')}` }, { timestamp: Math.floor(Date.now() / 1000) - 3600 }]) {
      const response = await deliver(data, stepPending, options);
      expect(response.response?.status).toBe(401);
      expect(response.items).toBeUndefined();
    }
  });

  it('an event not chosen, another kind or cost center answers 200 and starts nothing; budget.at_risk carries its cost center', async () => {
    const data = await created({ events: ['request.step_pending', 'budget.at_risk'], kinds: 'ai_budget', costCenters: 'ENG-AGENTS' });
    const parameters = { events: ['request.step_pending', 'budget.at_risk'], kinds: 'ai_budget', costCenters: 'ENG-AGENTS' };
    const other = await deliver(data, { type: 'period.closing', timestamp: 't', data: { month: '2026-11' } }, { parameters });
    expect(other.response).toMatchObject({ status: 200 });
    expect(other.items).toBeUndefined();
    expect((await deliver(data, stepPending, { parameters })).items).toBeUndefined();
    const aiBudget = { ...stepPending, data: { ...(stepPending.data as JsonObject), request: { ...request, kind: 'ai_budget', costCenter: { code: 'ENG-AGENTS', name: 'Agents', owner: null } } } };
    expect((await deliver(data, aiBudget, { parameters })).items).toHaveLength(1);
    const risk = { type: 'budget.at_risk', timestamp: 't', data: { month: '2026-11', costCenter: 'ENG-AGENTS', name: 'Agents', owner: null, state: 'risk', budget: '2000.000000', actual: '1900.000000', reserved: '0.000000', forecast: '2600.000000' } };
    expect((await deliver(data, risk, { parameters })).items![0].json).toMatchObject({ type: 'budget.at_risk', costCenter: 'ENG-AGENTS', requestId: null, kind: null, state: 'risk' });
  });

  it('with the secret of a subscription an admin made, registers nothing and checks deliveries with it', async () => {
    const secret = `whsec_${Buffer.from('made by an admin').toString('base64')}`;
    const creds = credentials(fake, { apiKey: KEY, webhookSecret: secret });
    const response = await method('create', {}, {}, creds);
    expect(response.error).toBeUndefined();
    expect((await method('checkExists', {}, {}, creds)).exists).toBe(true);
    expect(fake.requests).toHaveLength(0);
    expect((await deliver({}, stepPending, { creds, secret })).items).toHaveLength(1);
    expect((await deliver({}, stepPending, { creds, secret: `whsec_${Buffer.from('nope').toString('base64')}` })).response?.status).toBe(401);
  });
});
