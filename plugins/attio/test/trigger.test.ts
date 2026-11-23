/** Attio Trigger: webhook lifecycle against a fake REST API, signed deliveries, id-only payloads turned into activity items. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type JsonObject, type WebhookMethodRequest, type WebhookRequest } from '@landflow/protocol';
import { ACTIVITY_SUMMARY_MAX, hmacSha256, runWebhook, runWebhookMethod } from '@landflow/sdk';
import { plugin } from '../src/main';
import { AttioTrigger } from '../src/nodes/attio-trigger';
import { FakeAttio, LIST_ID, MEMBER_ID, OBJECTS, TOKEN, WORKSPACE_ID } from './fake-attio';
import { startFakeApi, type FakeApi } from './helpers';

const URL_ = 'https://landflow.example/api/webhook/app/wf_attio/n1';
const fake = new FakeAttio();
let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi(fake.handle);
});
afterAll(() => api.close());
beforeEach(() => {
  fake.seed();
  api.requests.length = 0;
});

const creds = () => ({ attioApi: { accessToken: TOKEN, baseUrl: api.url } });
const node = { id: 'n1', name: 'Attio Trigger', type: 'attio.attioTrigger', typeVersion: 1 };
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'attio' };
const base = { protocol: PROTOCOL_VERSION, workflowId: 'wf_attio', node, webhookUrl: URL_ };
const method = (m: WebhookMethodRequest['method'], staticData: JsonObject, parameters: JsonObject = {}, url = URL_) =>
  runWebhookMethod(AttioTrigger, { ...base, webhookUrl: url, method: m, staticData, parameters, credentials: creds() }, extras);

const SECRET = 'whsec-1';
const event = (e: JsonObject): JsonObject => ({ webhook_id: 'wh-1', events: [{ actor: { type: 'workspace-member', id: MEMBER_ID }, ...e }] });
const deliver = (staticData: JsonObject, payload: JsonObject | string, options: { signature?: string; headers?: Record<string, string>; parameters?: JsonObject } = {}) => {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return runWebhook(
    AttioTrigger,
    {
      ...base,
      parameters: options.parameters ?? {},
      staticData,
      credentials: creds(),
      request: { method: 'POST', path: '/hook', headers: { 'content-type': 'application/json', 'attio-signature': options.signature ?? hmacSha256(SECRET, raw), 'idempotency-key': 'idem-1', ...options.headers }, query: {}, body: Buffer.from(raw).toString('base64') },
    } satisfies WebhookRequest,
    extras,
  );
};
const stored = { webhookId: 'wh-1', url: URL_, secret: SECRET, lookups: {} };
const body = (r: { response?: { body?: string } }) => JSON.parse(r.response?.body ?? 'null');

describe('webhook methods', () => {
  it('create registers the subscriptions through POST /v2/webhooks and keeps id and secret', async () => {
    expect((await method('checkExists', {})).exists ?? false).toBe(false);
    const created = await method('create', {});
    expect(created.error).toBeUndefined();
    expect(created.staticData).toMatchObject({ webhookId: 'wh-1', url: URL_, secret: 'whsec-1' });
    const post = api.requests.find((r) => r.method === 'POST')!;
    expect(post.path).toBe('/v2/webhooks');
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.body.data.target_url).toBe(URL_);
    expect(post.body.data.subscriptions).toEqual(
      ['record.created', 'record.updated', 'list-entry.created', 'list-entry.updated', 'note.created', 'task.created'].map((event_type) => ({ event_type, filter: null })),
    );
  });

  it('create honours the chosen events and refuses a non-HTTPS URL or no events', async () => {
    const created = await method('create', {}, { events: ['note.created'] });
    expect(fake.hooks[0].subscriptions).toEqual([{ event_type: 'note.created', filter: null }]);
    expect(created.error).toBeUndefined();
    const http = await method('create', {}, {}, 'http://landflow.local/hook');
    expect(http.error?.message).toMatch(/HTTPS/);
    expect((await method('create', {}, { events: [] })).error?.message).toMatch(/at least one event/);
  });

  it('checkExists asks Attio: true while the hook is there, false when it is gone or points elsewhere', async () => {
    const { staticData } = await method('create', {});
    expect((await method('checkExists', staticData!)).exists).toBe(true);
    expect((await method('checkExists', { ...staticData!, url: 'https://old.example/hook' })).exists ?? false).toBe(false);
    fake.hooks = [];
    expect((await method('checkExists', staticData!)).exists ?? false).toBe(false);
  });

  it('create replaces a stale webhook and reports an Attio conflict readably', async () => {
    const first = await method('create', {});
    const again = await method('create', first.staticData!);
    expect(again.error).toBeUndefined();
    expect(fake.hooks.map((h) => h.id)).toEqual(['wh-2']);
    const conflict = await method('create', {});
    expect(conflict.error?.message).toMatch(/409/);
  });

  it('delete removes the webhook, and a webhook that is already gone is not an error', async () => {
    const { staticData } = await method('create', {});
    const deleted = await method('delete', staticData!);
    expect(deleted.error).toBeUndefined();
    expect(fake.hooks).toEqual([]);
    expect(api.requests.some((r) => r.method === 'DELETE' && r.path === '/v2/webhooks/wh-1')).toBe(true);
    expect((await method('delete', staticData!)).error).toBeUndefined();
  });
});

describe('deliveries', () => {
  it('rejects a bad, a missing and a foreign-secret signature, and a call before the webhook was created', async () => {
    const payload = event({ event_type: 'task.created', id: { workspace_id: WORKSPACE_ID, task_id: 't-1' } });
    for (const signature of ['deadbeef', hmacSha256('another-secret', JSON.stringify(payload)), '']) {
      const r = await deliver(stored, payload, { signature });
      expect(r.response?.status).toBe(401);
      expect(r.items).toBeUndefined();
    }
    expect((await deliver({}, payload)).response?.status).toBe(401);
    expect(api.requests).toEqual([]);
  });

  it('accepts a signature in the legacy header and in upper case hex', async () => {
    const payload = event({ event_type: 'task.created', id: { workspace_id: WORKSPACE_ID, task_id: 't-1' } });
    const raw = JSON.stringify(payload);
    const r = await deliver(stored, raw, { signature: hmacSha256(SECRET, raw).toUpperCase() });
    expect(r.items).toHaveLength(1);
    const legacy = await runWebhook(AttioTrigger, { ...base, parameters: {}, staticData: stored, credentials: creds(), request: { method: 'POST', path: '/hook', headers: { 'x-attio-signature': hmacSha256(SECRET, raw) }, query: {}, body: Buffer.from(raw).toString('base64') } }, extras);
    expect(legacy.items).toHaveLength(1);
  });

  it('turns a deal record.updated (stage won) into a deal_won item with company, actor and URL', async () => {
    const payload = event({ event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, object_id: OBJECTS.deals, record_id: 'r-renewal', attribute_id: 'attr-stage' } });
    const r = await deliver(stored, payload);
    expect(r.error).toBeUndefined();
    expect(r.idempotencyKey).toBe('idem-1');
    expect(r.items).toHaveLength(1);
    const item = r.items![0].json;
    expect(item).toMatchObject({
      source: 'attio',
      sourceId: 'attio:deals:r-renewal:2026-11-10T12:00:00.000Z',
      url: 'https://app.attio.com/acme/deals/r-renewal',
      actorEmail: 'ana@acme.example',
      occurredAt: '2026-11-10T12:00:00.000Z',
      kind: 'work.deal_won',
      customerHint: 'Acme Inc',
      teamHint: null,
      initiativeHint: null,
    });
    expect(Object.keys(item).sort()).toEqual(['actorEmail', 'customerHint', 'initiativeHint', 'kind', 'occurredAt', 'raw', 'source', 'sourceId', 'summary', 'teamHint', 'title', 'url']);
    expect(String(item.summary).length).toBeLessThanOrEqual(ACTIVITY_SUMMARY_MAX);
    expect(item.summary).toContain('stage: Won');
  });

  it('maps an open stage to deal_moved, a configured won stage to deal_won, and sets the team hint', async () => {
    const payload = event({ event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, object_id: OBJECTS.deals, record_id: 'r-pilot' } });
    const moved = await deliver(stored, payload, { parameters: { options: { teamHint: 'Sales' } } });
    expect(moved.items![0].json).toMatchObject({ kind: 'work.deal_moved', teamHint: 'Sales', customerHint: 'Acme Inc' });
    const won = await deliver(stored, payload, { parameters: { options: { wonStages: 'Won, In Progress' } } });
    expect(won.items![0].json.kind).toBe('work.deal_won');
  });

  it('maps a list entry stage change to an item named after the list and the parent deal', async () => {
    const r = await deliver(stored, event({ event_type: 'list-entry.updated', id: { workspace_id: WORKSPACE_ID, list_id: LIST_ID, entry_id: 'e-renewal', attribute_id: 'a' }, parent_object_id: OBJECTS.deals, parent_record_id: 'r-renewal' }));
    expect(r.items![0].json).toMatchObject({ sourceId: 'attio:sales_pipeline:e-renewal:2026-11-10T12:00:00.000Z', kind: 'work.deal_won', customerHint: 'Acme Inc', actorEmail: 'ana@acme.example', url: 'https://app.attio.com/acme/deals/r-renewal' });
    const moved = await deliver(stored, event({ event_type: 'list-entry.created', id: { workspace_id: WORKSPACE_ID, list_id: LIST_ID, entry_id: 'e-pilot' }, parent_object_id: OBJECTS.deals, parent_record_id: 'r-pilot' }));
    expect(moved.items![0].json).toMatchObject({ kind: 'work.deal_moved', title: 'Globex pilot added to Sales pipeline' });
  });

  it('maps a note to discussion and a task to action_item, fetching them by id', async () => {
    const note = await deliver(stored, event({ event_type: 'note.created', id: { workspace_id: WORKSPACE_ID, note_id: 'n-1' }, parent_object_id: OBJECTS.deals, parent_record_id: 'r-renewal' }));
    expect(note.items![0].json).toMatchObject({ sourceId: 'attio:notes:n-1:2026-11-10T13:00:00.000Z', kind: 'work.discussion', customerHint: 'Acme Inc', title: 'Note: Call recap on Acme renewal' });
    expect(note.items![0].json.summary).toContain('wants SSO');
    const task = await deliver(stored, event({ event_type: 'task.created', id: { workspace_id: WORKSPACE_ID, task_id: 't-1' } }));
    expect(task.items![0].json).toMatchObject({ sourceId: 'attio:tasks:t-1:2026-11-11T08:00:00.000Z', kind: 'work.action_item', customerHint: 'Acme Inc', actorEmail: 'ana@acme.example' });
  });

  it('a person record gets the company as customer; a company is its own customer', async () => {
    const person = await deliver(stored, event({ event_type: 'record.created', id: { workspace_id: WORKSPACE_ID, object_id: OBJECTS.people, record_id: 'r-pat' } }));
    expect(person.items![0].json).toMatchObject({ sourceId: 'attio:people:r-pat:2026-10-02T09:00:00.000Z', customerHint: 'Acme Inc', kind: 'work.deal_moved' });
    const company = await deliver(stored, event({ event_type: 'record.created', id: { workspace_id: WORKSPACE_ID, object_id: OBJECTS.companies, record_id: 'r-acme' } }));
    expect(company.items![0].json.customerHint).toBe('Acme Inc');
  });

  it('skips events the node did not choose, other objects, and records that are gone; caches slugs', async () => {
    const created = event({ event_type: 'record.created', id: { workspace_id: WORKSPACE_ID, object_id: OBJECTS.deals, record_id: 'r-pilot' } });
    expect(body(await deliver(stored, created, { parameters: { events: ['note.created'] } }))).toEqual({ ignored: 'filtered out' });
    expect(body(await deliver(stored, created, { parameters: { objects: 'companies' } }))).toEqual({ ignored: 'filtered out' });
    expect(body(await deliver(stored, event({ event_type: 'record.updated', id: { workspace_id: WORKSPACE_ID, object_id: OBJECTS.deals, record_id: 'nope' } })))).toEqual({ ignored: 'filtered out' });
    expect(body(await deliver(stored, { webhook_id: 'x', events: [] }))).toEqual({ ignored: 'no events' });
    const r = await deliver(stored, created);
    expect(r.staticData).toMatchObject({ secret: SECRET, lookups: { objects: { [OBJECTS.deals]: 'deals' } } });
  });

  it('falls back to a hash of the body as idempotency key and fails (so Attio retries) when the API is down', async () => {
    const payload = event({ event_type: 'task.created', id: { workspace_id: WORKSPACE_ID, task_id: 't-1' } });
    const raw = JSON.stringify(payload);
    const r = await runWebhook(AttioTrigger, { ...base, parameters: {}, staticData: stored, credentials: creds(), request: { method: 'POST', path: '/hook', headers: { 'attio-signature': hmacSha256(SECRET, raw) }, query: {}, body: Buffer.from(raw).toString('base64') } }, extras);
    expect(r.idempotencyKey).toBe(hmacSha256('attio', raw));
    fake.fail.set('GET /v2/tasks/t-1', { status: 500, body: { message: 'boom' } });
    const failed = await deliver(stored, payload);
    expect(failed.error?.message).toMatch(/500/);
    expect(failed.items).toBeUndefined();
  });
});
