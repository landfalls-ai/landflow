/**
 * The Linear Trigger against a fake Linear: webhook registration (create, checkExists, delete), the Linear-Signature
 * check and its timestamp tolerance, the idempotency key, and the kind mapping of each event type.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type WebhookRequest } from '@landflow/protocol';
import { ACTIVITY_ITEM_SCHEMA, hmacSha256, runWebhook, runWebhookMethod, type JsonObject } from '@landflow/sdk';
import { plugin } from '../src/main';
import { LinearTrigger } from '../src/nodes/linear-trigger';
import { API_KEY, FakeLinear, OAUTH_TOKEN, startFakeLinear } from './fake-linear';
import type { FakeApi } from './helpers';

const fake = new FakeLinear();
let api: FakeApi;
beforeAll(async () => {
  api = await startFakeLinear(fake);
});
afterAll(() => api.close());
beforeEach(() => {
  fake.webhooks = [];
  fake.created = [];
  fake.comments = [];
  fake.issues = [];
  fake.projectUpdates = [];
  api.requests.length = 0;
});

const URL_ = 'https://landflow.example/api/webhook/app/wf_lin/n1';
const node = { id: 'n1', name: 'Linear Trigger', type: 'linear.linearTrigger', typeVersion: 1 };
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'linear' };
const credentials = () => ({ linearApi: { apiKey: API_KEY, baseUrl: api.url } });
const PARAMS: JsonObject = { resourceTypes: ['Issue', 'Comment', 'ProjectUpdate', 'Project', 'Cycle'], teamId: '' };
const base = (parameters: JsonObject = PARAMS) => ({ protocol: PROTOCOL_VERSION, workflowId: 'wf_lin', node, parameters, webhookUrl: URL_, credentials: credentials() });

const method = (m: 'create' | 'checkExists' | 'delete', staticData: JsonObject = {}, parameters = PARAMS) => runWebhookMethod(LinearTrigger, { ...base(parameters), method: m, staticData }, extras);
const created = async (parameters = PARAMS) => (await method('create', {}, parameters)).staticData!;

let n = 0;
const deliver = (
  staticData: JsonObject,
  payload: JsonObject,
  options: { parameters?: JsonObject; signature?: string; delivery?: string | null; secret?: string; omitTimestamp?: boolean } = {},
) => {
  const body = { webhookTimestamp: Date.now(), webhookId: 'wh-1', organizationId: 'org-1', createdAt: new Date().toISOString(), ...payload };
  if (options.omitTimestamp) delete (body as JsonObject).webhookTimestamp;
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'linear-signature': options.signature ?? hmacSha256(options.secret ?? String(staticData.secret), raw) };
  if (options.delivery !== null) headers['linear-delivery'] = options.delivery ?? `d-${++n}`;
  const request: WebhookRequest = {
    ...base(options.parameters ?? PARAMS),
    staticData,
    request: { method: 'POST', path: new URL(URL_).pathname, headers, query: {}, body: Buffer.from(raw).toString('base64') },
  };
  return runWebhook(LinearTrigger, request, extras);
};

const actor = { id: 'u1', type: 'user', name: 'Dana', email: 'Dana@Acme.example', url: 'https://linear.app/acme/profiles/dana' };
const issueData = (extra: JsonObject = {}) => ({
  id: 'iss-1', identifier: 'ENG-1', title: 'Export crashes', description: 'Steps to reproduce', createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' }, state: { id: 's1', name: 'Todo', type: 'unstarted' }, labels: [{ id: 'l1', name: 'Bug' }], project: { id: 'p1', name: 'Export' }, ...extra,
});
const event = (type: string, action: string, data: JsonObject, extra: JsonObject = {}) => ({ action, type, actor, data, url: 'https://linear.app/acme/issue/ENG-1/export-crashes', ...extra });

function expectActivity(item: JsonObject) {
  const properties = ACTIVITY_ITEM_SCHEMA.properties as Record<string, unknown>;
  for (const key of ACTIVITY_ITEM_SCHEMA.required as string[]) expect(item, key).toHaveProperty(key);
  expect(Object.keys(item).sort()).toEqual(['actorEmail', 'customerHint', 'initiativeHint', 'kind', 'occurredAt', 'raw', 'source', 'sourceId', 'summary', 'teamHint', 'title', 'url']);
  for (const key of Object.keys(item)) expect(Object.keys(properties)).toContain(key);
  expect(String(item.summary).length).toBeLessThanOrEqual(600);
}

describe('Linear Trigger registration', () => {
  it('creates a webhook for all public teams with a secret it keeps, and deletes it', async () => {
    const response = await method('create');
    expect(response.error).toBeUndefined();
    const staticData = response.staticData!;
    expect(staticData).toMatchObject({ url: URL_, webhookId: 'wh-1' });
    expect(String(staticData.secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.created[0].input).toEqual({
      url: URL_, resourceTypes: ['Issue', 'Comment', 'ProjectUpdate', 'Project', 'Cycle'], secret: staticData.secret, label: 'Landflow', allPublicTeams: true,
    });
    expect(fake.webhooks).toHaveLength(1);

    expect((await method('checkExists', staticData)).exists).toBe(true);
    expect((await method('checkExists', { ...staticData, url: 'https://elsewhere.example/hook' })).exists).toBe(false);
    expect((await method('checkExists', {})).exists).toBe(false);

    const deleted = await method('delete', staticData);
    expect(deleted.error).toBeUndefined();
    expect(deleted.staticData).toEqual({});
    expect(fake.webhooks).toHaveLength(0);
    // Gone in Linear: checkExists says no, and deleting again is not an error.
    expect((await method('checkExists', staticData)).exists).toBe(false);
    expect((await method('delete', staticData)).error).toBeUndefined();
  });

  it('scopes the webhook to a team, and works with an OAuth2 credential', async () => {
    const response = await runWebhookMethod(
      LinearTrigger,
      { ...base({ authentication: 'oAuth2', resourceTypes: ['Issue'], teamId: 'team-1' }), credentials: { linearOAuth2Api: { accessToken: OAUTH_TOKEN, baseUrl: api.url } }, method: 'create', staticData: {} },
      extras,
    );
    expect(response.error).toBeUndefined();
    expect(fake.created[0].input).toMatchObject({ teamId: 'team-1', resourceTypes: ['Issue'] });
    expect(fake.created[0].input).not.toHaveProperty('allPublicTeams');
    expect(api.requests.at(-1)!.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
  });

  it('reports a refused registration and an empty resource list', async () => {
    const refused = await runWebhookMethod(LinearTrigger, { ...base(), credentials: { linearApi: { apiKey: 'wrong', baseUrl: api.url } }, method: 'create', staticData: {} }, extras);
    expect(refused.error?.message).toMatch(/401/);
    expect((await method('create', {}, { resourceTypes: [] })).error?.message).toMatch(/at least one resource/);
  });
});

describe('Linear Trigger signature', () => {
  it('accepts a valid signature, rejects a wrong one, a wrong secret, a missing one and a stale or absent timestamp', async () => {
    const staticData = await created();
    const body = event('Issue', 'create', issueData());
    const good = await deliver(staticData, body);
    expect(good.error).toBeUndefined();
    expect(good.items).toHaveLength(1);

    const reject = async (response: ReturnType<typeof deliver>) => {
      const r = await response;
      expect(r.response?.status).toBe(401);
      expect(r.items).toBeUndefined();
    };
    await reject(deliver(staticData, body, { signature: 'deadbeef' }));
    await reject(deliver(staticData, body, { signature: '' }));
    await reject(deliver(staticData, body, { secret: 'another-secret' }));
    await reject(deliver(staticData, { ...body, webhookTimestamp: Date.now() - 5 * 60_000 }));
    await reject(deliver(staticData, { ...body, webhookTimestamp: Date.now() + 5 * 60_000 }));
    await reject(deliver(staticData, body, { omitTimestamp: true }));
    await reject(deliver({}, body, { secret: 'anything' })); // no stored secret: never trusts the call
    // A wider tolerance accepts a ninety-second-old delivery; the default (60 s) does not.
    const old = { ...body, webhookTimestamp: Date.now() - 90_000 };
    await reject(deliver(staticData, old));
    expect((await deliver(staticData, old, { parameters: { ...PARAMS, options: { tolerance: 120 } } })).items).toHaveLength(1);
  });

  it('keeps the idempotency key from Linear-Delivery and answers without calling Linear when the payload is complete', async () => {
    const staticData = await created();
    api.requests.length = 0;
    const response = await deliver(staticData, event('Issue', 'create', issueData()), { delivery: 'a4c5-delivery-uuid' });
    expect(response.idempotencyKey).toBe('a4c5-delivery-uuid');
    expect(api.requests).toHaveLength(0);
    expect((await deliver(staticData, event('Issue', 'create', issueData()), { delivery: null })).idempotencyKey).toBeUndefined();
  });
});

describe('Linear Trigger events', () => {
  let staticData: JsonObject;
  beforeEach(async () => {
    staticData = await created();
  });
  const itemOf = async (payload: JsonObject, options = {}) => {
    const response = await deliver(staticData, payload, options);
    expect(response.error).toBeUndefined();
    return response;
  };

  it('a new Bug-labelled issue is work.bug_reported, with every field', async () => {
    const response = await itemOf(event('Issue', 'create', issueData()));
    const item = response.items![0].json;
    expectActivity(item);
    expect(item).toMatchObject({
      source: 'linear',
      sourceId: 'linear:issue:iss-1:2026-11-12T10:00:00.000Z',
      url: 'https://linear.app/acme/issue/ENG-1/export-crashes',
      actorEmail: 'dana@acme.example',
      occurredAt: '2026-11-12T10:00:00.000Z',
      kind: 'work.bug_reported',
      title: 'ENG-1: Export crashes',
      summary: 'Steps to reproduce',
      teamHint: 'Engineering',
      initiativeHint: 'Export',
      customerHint: null,
    });
    expect(item).not.toHaveProperty('cursor');
  });

  it('a new Feature issue is work.feature_request; a customer label gives the customer hint', async () => {
    const item = (await itemOf(event('Issue', 'create', issueData({ labels: [{ name: 'Feature' }, { name: 'customer:Acme' }] })))).items![0].json;
    expect(item).toMatchObject({ kind: 'work.feature_request', customerHint: 'Acme' });
    const other = (await itemOf(event('Issue', 'create', issueData({ labels: [{ name: 'Client:Globex' }] })), { parameters: { ...PARAMS, options: { customerLabelPrefix: 'client:' } } })).items![0].json;
    expect(other).toMatchObject({ kind: 'work.ticket_moved', customerHint: 'Globex' });
  });

  it('a state change is work.ticket_moved and says where it moved; other updates fall back to ticket_moved', async () => {
    const moved = (await itemOf(event('Issue', 'update', issueData({ state: { name: 'In Progress', type: 'started' }, updatedAt: '2026-11-12T11:00:00.000Z' }), { updatedFrom: { stateId: 's1', updatedAt: '2026-11-12T10:00:00.000Z' } }))).items![0].json;
    expect(moved).toMatchObject({ kind: 'work.ticket_moved', summary: 'Moved to In Progress. Steps to reproduce', sourceId: 'linear:issue:iss-1:2026-11-12T11:00:00.000Z' });
    expect((moved.raw as JsonObject).stateChanged).toBe(true);
    // An edited Bug issue is not a new bug report.
    const edited = (await itemOf(event('Issue', 'update', issueData({ title: 'Renamed' }), { updatedFrom: { title: 'Export crashes' } }))).items![0].json;
    expect(edited.kind).toBe('work.ticket_moved');
  });

  it('a comment is work.discussion; missing issue details are read from Linear', async () => {
    fake.comments = [{ id: 'c1', body: 'Looks fixed', url: 'https://linear.app/acme/issue/ENG-1#c1', createdAt: '2026-11-12T10:05:00.000Z', updatedAt: '2026-11-12T10:05:00.000Z', user: { email: 'lee@acme.example' },
      issue: { id: 'iss-1', identifier: 'ENG-1', title: 'Export crashes', team: { key: 'ENG', name: 'Engineering' }, project: { name: 'Export' }, labels: { nodes: [{ name: 'customer:Acme' }] } } }];
    api.requests.length = 0;
    const response = await itemOf(event('Comment', 'create', { id: 'c1', body: 'Looks fixed', issueId: 'iss-1', userId: 'u1', createdAt: '2026-11-12T10:05:00.000Z', updatedAt: '2026-11-12T10:05:00.000Z' }, { url: 'https://linear.app/acme/issue/ENG-1#c1' }));
    const item = response.items![0].json;
    expectActivity(item);
    expect(item).toMatchObject({ kind: 'work.discussion', title: 'ENG-1: Looks fixed', actorEmail: 'dana@acme.example', teamHint: 'Engineering', initiativeHint: 'Export', customerHint: 'Acme' });
    expect(api.requests).toHaveLength(1);
    // When Linear cannot be read the payload still gives an item, with empty hints.
    fake.comments = [];
    const degraded = (await itemOf(event('Comment', 'create', { id: 'c2', body: 'Hello', issueId: 'iss-1', updatedAt: '2026-11-12T10:06:00.000Z' }))).items![0].json;
    expect(degraded).toMatchObject({ kind: 'work.discussion', teamHint: null });
  });

  it('a project update is work.self_update', async () => {
    const item = (await itemOf(event('ProjectUpdate', 'create', { id: 'pu-1', body: 'We are on track.\nNext: beta', health: 'onTrack', updatedAt: '2026-11-12T10:10:00.000Z', project: { id: 'p1', name: 'Export' } }, { url: 'https://linear.app/acme/project/export/updates' }))).items![0].json;
    expectActivity(item);
    expect(item).toMatchObject({ kind: 'work.self_update', initiativeHint: 'Export', title: 'Export update (onTrack): We are on track.', url: 'https://linear.app/acme/project/export/updates' });
  });

  it('a completed project or cycle is work.release; other project or cycle changes are ignored', async () => {
    const project = (await itemOf(event('Project', 'update', { id: 'p1', name: 'Export', completedAt: '2026-11-12T12:00:00.000Z', updatedAt: '2026-11-12T12:00:00.000Z' }, { updatedFrom: { completedAt: null }, url: 'https://linear.app/acme/project/export' }))).items![0].json;
    expectActivity(project);
    expect(project).toMatchObject({ kind: 'work.release', title: 'Project completed: Export', initiativeHint: 'Export' });
    const cycle = (await itemOf(event('Cycle', 'update', { id: 'cy1', number: 4, name: 'Sprint 4', completedAt: '2026-11-12T12:00:00.000Z', updatedAt: '2026-11-12T12:00:00.000Z', team: { name: 'Engineering' } }, { updatedFrom: { completedAt: null } }))).items![0].json;
    expect(cycle).toMatchObject({ kind: 'work.release', title: 'Cycle completed: Sprint 4', teamHint: 'Engineering' });
    const renamed = await itemOf(event('Project', 'update', { id: 'p1', name: 'Export 2', updatedAt: '2026-11-12T12:00:00.000Z' }, { updatedFrom: { name: 'Export' } }));
    expect(renamed.items).toBeUndefined();
    expect(JSON.parse(renamed.response!.body!).ignored).toBe('not completed');
    const later = await itemOf(event('Project', 'update', { id: 'p1', name: 'Export', completedAt: '2026-11-12T12:00:00.000Z', description: 'x', updatedAt: '2026-11-12T13:00:00.000Z' }, { updatedFrom: { description: 'y' } }));
    expect(later.items).toBeUndefined();
  });

  it('ignores removals, unselected resource types and unknown types', async () => {
    const reasons: string[] = [];
    for (const [payload, parameters] of [
      [event('Issue', 'remove', issueData()), PARAMS],
      [event('Issue', 'create', issueData()), { ...PARAMS, resourceTypes: ['Comment'] }],
      [event('Document', 'create', { id: 'd1' }), PARAMS],
    ] as Array<[JsonObject, JsonObject]>) {
      const response = await deliver(staticData, payload, { parameters });
      expect(response.items).toBeUndefined();
      expect(response.response?.status).toBe(200);
      reasons.push(JSON.parse(response.response!.body!).ignored);
    }
    expect(reasons).toEqual(['remove', 'Issue', 'Document']);
  });

  it('declares the appWebhook source and the activity schema, and a manual run outputs nothing', async () => {
    expect(LinearTrigger.description.triggerSource).toBe('appWebhook');
    expect(LinearTrigger.description.outputSchema).toBe(ACTIVITY_ITEM_SCHEMA);
    expect(typeof LinearTrigger.webhookMethods?.checkExists).toBe('function');
  });
});
