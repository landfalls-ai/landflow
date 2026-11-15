/**
 * The Landledger Trigger: registration with a webhooks:write key of its own (create / checkExists / delete against the
 * fake; the secret kept in static data, never in an item), a subscription an admin made (the credential's secret,
 * nothing registered), signed, forged, stale and filtered deliveries, a tolerance capped at 5 minutes, the review's new
 * event types, and the redelivery key; the Standard Webhooks signature itself.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type JsonObject } from '@landflow/protocol';
import { runWebhook, runWebhookMethod } from '@landflow/sdk';
import { LandledgerTrigger } from '../src/nodes/landledger-trigger';
import { signStandardWebhook, verifyStandardWebhook } from '../src/signature';
import { ADMIN_KEY, KEY, READ_KEY, startFakeLandledger, WEBHOOKS_KEY, type FakeLandledger } from './fake-landledger';
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
  const admin = () => credentials(fake, { apiKey: WEBHOOKS_KEY });
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

  it('without webhooks:write, registration fails with the scope it needs', async () => {
    const response = await method('create', {}, {}, credentials(fake, { apiKey: READ_KEY }));
    expect(response.error?.message).toBe('Landledger API error 403: This needs the webhooks:write scope');
    expect(response.error?.description).toMatch(/needs webhooks:write/);
  });

  it('a webhooks:write key sees only its own subscriptions: another key\'s hook for the same URL is not ours', async () => {
    await runWebhookMethod(LandledgerTrigger, { ...base({}, credentials(fake, { apiKey: ADMIN_KEY })), method: 'create', staticData: {} }, extras);
    const [adminHook] = [...fake.state.webhooks.keys()];
    expect((await method('checkExists', { id: adminHook, secret: 'whsec_x', url: URL_, events: 'budget.at_risk,period.closing,request.applied,request.decided,request.step_pending' })).exists ?? false).toBe(false);
    const ours = await created();
    expect(ours.id).not.toBe(adminHook);
    expect((await method('checkExists', ours)).exists).toBe(true);
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

  it('keeps the whsec_ secret Landledger returns only in its static data: never in an item', async () => {
    const data = await created();
    const response = await deliver(data, stepPending);
    expect(JSON.stringify(response.items)).not.toContain(String(data.secret));
    expect(JSON.stringify(response.items)).not.toContain('whsec_');
  });

  it('caps the signature tolerance at 5 minutes, whatever the option says', async () => {
    const data = await created();
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const wide = await deliver(data, stepPending, { timestamp: tenMinutesAgo, parameters: { options: { tolerance: 3600 } } });
    expect(wide.response?.status).toBe(401);
    const fourMinutesAgo = Math.floor(Date.now() / 1000) - 240;
    expect((await deliver(data, stepPending, { timestamp: fourMinutesAgo, parameters: { options: { tolerance: 3600 } } })).items).toHaveLength(1);
  });

  it('starts on the review\'s new events: a request that needs confirmation, a relayed decision, the exceptions report', async () => {
    const events = ['request.needs_confirmation', 'decision.relayed', 'report.exceptions'];
    const data = await created({ events });
    const parameters = { events };
    const confirm = { type: 'request.needs_confirmation', timestamp: 't', data: { request: { ...request, status: 'awaiting_confirmation' }, person: { name: 'Shira Navon', email: 'shira.navon@landbright.test' }, createdBy: { kind: 'key', id: 'key_flows', name: 'Landflow flows' }, url: 'http://localhost:4811/requests/req_7' } };
    expect((await deliver(data, confirm, { parameters })).items![0].json).toMatchObject({ type: 'request.needs_confirmation', requestId: 'req_7', kind: 'infra_change', costCenter: 'ENG-PLATFORM', person: { email: 'shira.navon@landbright.test' }, url: 'http://localhost:4811/requests/req_7' });
    const relayed = { type: 'decision.relayed', timestamp: 't', data: { request, decision: { outcome: 'approve', via: 'relay' }, person: { name: 'Amit Gal' }, channel: { id: 'rch_1', kind: 'slack', name: 'Slack' }, url: 'u' } };
    expect((await deliver(data, relayed, { parameters, id: 'evt_2' })).items![0].json).toMatchObject({ type: 'decision.relayed', requestId: 'req_7', channel: { kind: 'slack' } });
    const report = { type: 'report.exceptions', timestamp: 't', data: { id: 'rep_1', sha256: 'f'.repeat(64), from: '2026-11-01', to: '2026-11-07', generatedAt: 't', rows: 3, url: 'u' } };
    expect((await deliver(data, report, { parameters, id: 'evt_3' })).items![0].json).toMatchObject({ type: 'report.exceptions', id: 'evt_3', requestId: null, rows: 3, sha256: 'f'.repeat(64) });
  });

  it('starts on seat.released, with the request id lifted out of the event', async () => {
    const data = await created({ events: ['seat.released'] });
    const released = { type: 'seat.released', timestamp: 't', data: { requestId: 'req_9', number: 'R-9', contractId: 'con_linear', seats: 1, reason: 'access_denied', from: 'reserved', url: 'u' } };
    expect((await deliver(data, released, { parameters: { events: ['seat.released'] } })).items![0].json).toMatchObject({ type: 'seat.released', requestId: 'req_9', kind: null, contractId: 'con_linear', reason: 'access_denied' });
  });

  it('starts on notes.draft_requested with the month, the snapshot and the figures each note may cite', async () => {
    const data = await created({ events: ['notes.draft_requested'] });
    const requested = { type: 'notes.draft_requested', timestamp: 't', data: { month: '2026-10', snapshotSha256: 'c'.repeat(64), needed: [{ costCenter: 'TOTAL', actual: '0.000000', drivers: [] }], draftUrl: 'http://127.0.0.1:4810/api/notes/2026-10/drafts', url: 'u' } };
    expect((await deliver(data, requested, { parameters: { events: ['notes.draft_requested'] } })).items![0].json).toMatchObject({ type: 'notes.draft_requested', month: '2026-10', snapshotSha256: 'c'.repeat(64), needed: [{ costCenter: 'TOTAL' }], requestId: null });
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
