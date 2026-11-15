/**
 * The two triggers: Clickland Alert Trigger (create / checkExists / delete against the fake, signed, forged, stale and
 * filtered deliveries, the redelivery key) and Clickland Trigger (baseline, new alert events and notes, manual mode).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type JsonObject } from '@landflow/protocol';
import { runWebhook, runWebhookMethod } from '@landflow/sdk';
import { ClicklandAlertTrigger } from '../src/nodes/clickland-alert-trigger';
import { advance, ClicklandTrigger } from '../src/nodes/clickland-trigger';
import { signStandardWebhook, verifyStandardWebhook } from '../src/signature';
import { startFakeClickland, type FakeClickland } from './fake-clickland';
import { credentials, extras, jsonOf, run } from './helpers';

let fake: FakeClickland;
beforeAll(async () => {
  fake = await startFakeClickland();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

describe('Standard Webhooks signature', () => {
  const secret = `whsec_${Buffer.from('a test secret').toString('base64')}`;
  const body = '{"type":"alert.firing"}';
  const now = Date.parse('2026-11-14T15:03:00Z');
  const ts = Math.floor(now / 1000);

  it('accepts a good signature, also among several', () => {
    const good = signStandardWebhook(secret, body, 'evt_1', ts);
    expect(verifyStandardWebhook(secret, body, { id: 'evt_1', timestamp: String(ts), signature: good }, { now })).toBe(true);
    expect(verifyStandardWebhook(secret, Buffer.from(body), { id: 'evt_1', timestamp: String(ts), signature: `v1,AAAA ${good}` }, { now })).toBe(true);
  });

  it('rejects a changed body, another id, another secret, a missing header and another version', () => {
    const good = signStandardWebhook(secret, body, 'evt_1', ts);
    expect(verifyStandardWebhook(secret, `${body} `, { id: 'evt_1', timestamp: String(ts), signature: good }, { now })).toBe(false);
    expect(verifyStandardWebhook(secret, body, { id: 'evt_2', timestamp: String(ts), signature: good }, { now })).toBe(false);
    expect(verifyStandardWebhook(`whsec_${Buffer.from('other').toString('base64')}`, body, { id: 'evt_1', timestamp: String(ts), signature: good }, { now })).toBe(false);
    expect(verifyStandardWebhook(secret, body, { id: 'evt_1', timestamp: String(ts), signature: null }, { now })).toBe(false);
    expect(verifyStandardWebhook(secret, body, { id: 'evt_1', timestamp: String(ts), signature: good.replace('v1,', 'v2,') }, { now })).toBe(false);
    expect(verifyStandardWebhook('', body, { id: 'evt_1', timestamp: String(ts), signature: good }, { now })).toBe(false);
  });

  it('rejects an expired or future timestamp outside the tolerance', () => {
    const old = ts - 3600;
    const signed = signStandardWebhook(secret, body, 'evt_1', old);
    expect(verifyStandardWebhook(secret, body, { id: 'evt_1', timestamp: String(old), signature: signed }, { now })).toBe(false);
    expect(verifyStandardWebhook(secret, body, { id: 'evt_1', timestamp: String(old), signature: signed }, { now, toleranceSeconds: 7200 })).toBe(true);
    const future = ts + 600;
    expect(verifyStandardWebhook(secret, body, { id: 'evt_1', timestamp: String(future), signature: signStandardWebhook(secret, body, 'evt_1', future) }, { now })).toBe(false);
    expect(verifyStandardWebhook(secret, body, { id: 'evt_1', timestamp: `${ts}.5`, signature: signed }, { now })).toBe(false);
  });
});

describe('Clickland Alert Trigger', () => {
  const URL_ = 'https://landflow.example/api/webhook/app/wf_c/n1';
  const node = { id: 'n1', name: 'Clickland Alert Trigger', type: 'clickland.clicklandAlertTrigger', typeVersion: 1 };
  const base = (parameters: JsonObject, webhookUrl = URL_) => ({ protocol: PROTOCOL_VERSION, workflowId: 'wf_c', node, parameters, webhookUrl, credentials: credentials(fake) });
  const method = (name: 'create' | 'delete' | 'checkExists', staticData: JsonObject, parameters: JsonObject = {}, webhookUrl?: string) =>
    runWebhookMethod(ClicklandAlertTrigger, { ...base(parameters, webhookUrl), method: name, staticData }, extras);
  const created = async (parameters: JsonObject = {}) => {
    const response = await method('create', {}, parameters);
    expect(response.error).toBeUndefined();
    return response.staticData as JsonObject;
  };
  const event = (type = 'alert.firing', alertId = 'al_1'): JsonObject => ({
    type,
    id: 'evt_1',
    timestamp: '2026-11-14T15:03:00.000Z',
    data: {
      alert: { id: alertId, name: 'API errors', signal: 'logs', query: 'service:api level:error', groupBy: null, thresholdType: 'above', threshold: 10, windowMinutes: 5 },
      status: type === 'alert.firing' ? 'firing' : 'ok',
      groupKey: '',
      value: 42,
      fingerprint: `${alertId}:`,
      window: { from: '2026-11-14T14:58:00.000Z', to: '2026-11-14T15:03:00.000Z' },
      url: `http://127.0.0.1:4711/alerts/${alertId}`,
      searchUrl: 'http://127.0.0.1:4711/search?signal=logs',
      samples: [{ body: 'timeout' }],
    },
  });
  const deliver = (staticData: JsonObject, payload: JsonObject, options: { parameters?: JsonObject; signature?: string; timestamp?: number; id?: string } = {}) => {
    const raw = JSON.stringify(payload);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const id = options.id ?? 'msg_1';
    return runWebhook(
      ClicklandAlertTrigger,
      {
        ...base(options.parameters ?? {}),
        staticData,
        request: {
          method: 'POST',
          path: '/hook',
          headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': options.signature ?? signStandardWebhook(String(staticData.secret ?? ''), raw, id, timestamp) },
          query: {},
          body: Buffer.from(raw).toString('base64'),
        },
      },
      extras,
    );
  };

  it('creates the subscription with the events and alert filter, stores id and secret', async () => {
    const data = await created({ events: ['alert.resolved', 'alert.firing'], alertId: 'al_9' });
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/webhooks', body: { url: URL_, events: ['alert.firing', 'alert.resolved'], alertId: 'al_9' } });
    expect(fake.requests.at(-1)!.body.description).toMatch(/Landflow workflow wf_c/);
    expect(data).toMatchObject({ id: 'wh_1', url: URL_ });
    expect(String(data.secret)).toMatch(/^whsec_/);
  });

  it('checkExists asks Clickland and compares url, events and alert id', async () => {
    const params = { events: ['alert.firing'], alertId: '' };
    const data = await created(params);
    expect((await method('checkExists', data, params)).exists).toBe(true);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', path: '/api/webhooks/wh_1' });
    // Options changed, URL changed, nothing stored: re-create.
    expect((await method('checkExists', data, { events: ['alert.firing', 'alert.resolved'] })).exists).toBe(false);
    expect((await method('checkExists', data, params, 'https://other.example/hook')).exists).toBe(false);
    expect((await method('checkExists', {}, params)).exists).toBe(false);
    // Changed or gone on Clickland's side.
    fake.state.webhooks.get('wh_1').url = 'https://elsewhere.example';
    expect((await method('checkExists', data, params)).exists).toBe(false);
    fake.state.webhooks.clear();
    expect((await method('checkExists', data, params)).exists).toBe(false);
  });

  it('create removes an earlier subscription it could not confirm, so deliveries do not double', async () => {
    const first = await created();
    const second = (await method('create', first, {})).staticData as JsonObject;
    expect(second.id).toBe('wh_2');
    expect([...fake.state.webhooks.keys()]).toEqual(['wh_2']);
  });

  it('delete removes it, a 404 is already gone, other errors keep the record', async () => {
    const data = await created();
    expect((await method('delete', data)).staticData).toEqual({});
    expect(fake.state.webhooks.size).toBe(0);
    const gone = await method('delete', data);
    expect(gone.error).toBeUndefined();
    const again = await created();
    fake.failNext(500);
    const failed = await method('delete', again);
    expect(failed.error?.message).toMatch(/500/);
    expect(fake.state.webhooks.size).toBe(1);
  });

  it('turns a signed delivery into one item with data, type and id; webhook-id is the idempotency key', async () => {
    const data = await created();
    const ok = await deliver(data, event(), { id: 'msg_abc' });
    expect(ok.idempotencyKey).toBe('msg_abc');
    expect(ok.items).toHaveLength(1);
    expect(ok.items![0].json).toMatchObject({ type: 'alert.firing', id: 'evt_1', status: 'firing', value: 42, alert: { id: 'al_1', name: 'API errors' }, samples: [{ body: 'timeout' }] });
  });

  it('rejects a forged, unregistered or stale delivery with 401', async () => {
    const data = await created();
    expect((await deliver(data, event(), { signature: 'v1,AAAA' })).response?.status).toBe(401);
    expect((await deliver(data, event(), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).response?.status).toBe(401);
    const forged = await deliver(data, event(), { signature: signStandardWebhook(`whsec_${Buffer.from('nope').toString('base64')}`, JSON.stringify(event()), 'msg_1', Math.floor(Date.now() / 1000)) });
    expect(forged.response?.status).toBe(401);
    expect(forged.items).toBeUndefined();
    expect((await deliver({}, event(), { signature: 'v1,AAAA' })).response?.status).toBe(401);
  });

  it('ignores events not selected and other alerts, answering 200 so Clickland does not retry', async () => {
    const data = await created({ events: ['alert.firing'], alertId: 'al_1' });
    const resolved = await deliver(data, event('alert.resolved'), { parameters: { events: ['alert.firing'], alertId: 'al_1' } });
    expect(resolved.response?.status).toBe(200);
    expect(resolved.items).toBeUndefined();
    const other = await deliver(data, event('alert.firing', 'al_2'), { parameters: { events: ['alert.firing'], alertId: 'al_1' } });
    expect(other.items).toBeUndefined();
    const note = await deliver(data, { type: 'note.created', id: 'evt_n', data: { note: {} } }, { parameters: { events: ['alert.firing'] } });
    expect(note.items).toBeUndefined();
  });
});

describe('Clickland Trigger', () => {
  const poll = (events: string[], pollState?: JsonObject, mode: 'poll' | 'manual' = 'poll') =>
    run(ClicklandTrigger, { pollInterval: 60, events }, { credentials: credentials(fake), mode, items: [], ...(pollState && { pollState }) });
  const alert = (id: string, changedAt: string) => ({ id, name: `Alert ${id}`, query: 'level:error', states: [{ groupKey: '', state: 'firing', value: 3, changedAt }] });

  it('first poll sets a baseline and emits nothing; later polls emit new events oldest first, once', async () => {
    fake.state.alerts = [alert('al_1', '2026-11-14T15:00:00.000Z')];
    fake.state.events.al_1 = [{ id: 'ev_1', state: 'firing', createdAt: '2026-11-14T15:00:00.000Z' }];
    const first = await poll(['alertEvent']);
    expect(first.outputs).toEqual([[]]);
    expect(first.pollState).toMatchObject({ events: { since: '2026-11-14T15:00:00.000Z', seen: [], exclusive: true } });
    expect(jsonOf(await poll(['alertEvent'], first.pollState))).toEqual([]);

    fake.state.alerts = [alert('al_1', '2026-11-14T15:05:00.000Z'), alert('al_2', '2026-11-14T15:04:00.000Z')];
    fake.state.events.al_1 = [{ id: 'ev_3', state: 'ok', createdAt: '2026-11-14T15:05:00.000Z' }, ...fake.state.events.al_1];
    fake.state.events.al_2 = [{ id: 'ev_2', state: 'firing', createdAt: '2026-11-14T15:04:00.000Z' }];
    const second = await poll(['alertEvent'], first.pollState);
    expect(jsonOf(second).map((j) => [j.event, (j.alertEvent as JsonObject).id, (j.alert as JsonObject).id])).toEqual([
      ['alert.event', 'ev_2', 'al_2'],
      ['alert.event', 'ev_3', 'al_1'],
    ]);
    expect(jsonOf(second)[0].alert).not.toHaveProperty('states');
    expect(jsonOf(await poll(['alertEvent'], second.pollState))).toEqual([]);
  });

  it('does not read events of alerts that did not change', async () => {
    fake.state.alerts = [alert('al_1', '2026-11-14T15:00:00.000Z'), alert('al_2', '2026-11-14T14:00:00.000Z')];
    const first = await poll(['alertEvent']);
    fake.requests.length = 0;
    fake.state.alerts[0].states[0].changedAt = '2026-11-14T15:10:00.000Z';
    await poll(['alertEvent'], first.pollState);
    expect(fake.requests.filter((r) => r.path.endsWith('/events')).map((r) => r.path)).toEqual(['/api/alerts/al_1/events']);
  });

  it('emits new notes when asked, and none of them at baseline', async () => {
    fake.state.notes = [{ id: 'nt_1', title: 'old', createdAt: '2026-11-14T15:00:00.000Z' }];
    const first = await poll(['note']);
    expect(first.outputs).toEqual([[]]);
    fake.state.notes.unshift({ id: 'nt_2', title: 'new', createdAt: '2026-11-14T15:01:00.000Z' });
    const second = await poll(['note'], first.pollState);
    expect(jsonOf(second)).toEqual([{ event: 'note.created', note: expect.objectContaining({ id: 'nt_2' }) }]);
    expect(fake.requests.some((r) => r.path === '/api/alerts')).toBe(false);
  });

  it('manual mode shows the latest few and stores nothing', async () => {
    fake.state.alerts = [alert('al_1', '2026-11-14T15:00:00.000Z')];
    fake.state.events.al_1 = Array.from({ length: 8 }, (_, n) => ({ id: `ev_${n}`, createdAt: `2026-11-14T15:0${n}:00.000Z` })).reverse();
    const out = await poll(['alertEvent'], undefined, 'manual');
    expect(jsonOf(out).map((j) => (j.alertEvent as JsonObject).id)).toEqual(['ev_7', 'ev_6', 'ev_5', 'ev_4', 'ev_3']);
    expect(out.pollState).toBeUndefined();
  });

  it('advance keeps the ids seen at the boundary time', () => {
    const at = '2026-11-14T15:00:00.000Z';
    const step = advance({ since: at, seen: ['a'], exclusive: false }, [{ id: 'a', at, entry: { n: 1 } }, { id: 'b', at, entry: { n: 2 } }]);
    expect(step.fresh).toEqual([{ n: 2 }]);
    expect(step.cursor).toEqual({ since: at, seen: ['a', 'b'], exclusive: false });
    expect(advance({ since: at, seen: [], exclusive: true }, [{ id: 'a', at, entry: {} }]).fresh).toEqual([]);
    expect(advance(step.cursor, [{ id: 'b', at, entry: {} }]).fresh).toEqual([]);
  });
});
