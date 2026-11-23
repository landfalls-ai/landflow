/**
 * Fathom against a fake API: credential test, Meeting → Get Many Changed Since (paging, oldest first, cursor) and Get,
 * the activity item mapping (meeting vs action items, kinds, hints, privacy), the lists, and the Fathom Trigger
 * (create / checkExists / delete, signed, forged and stale webhooks, redelivery key). Live tests: LANDFLOW_INTEGRATION=fathom.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type JsonObject } from '@landflow/protocol';
import { ACTIVITY_ITEM_SCHEMA, runWebhook, runWebhookMethod } from '@landflow/sdk';
import { plugin } from '../src/main';
import { Fathom } from '../src/nodes/fathom';
import { FathomTrigger } from '../src/nodes/fathom-trigger';
import { customerOf, signFathom, sinceIso, verifyFathomSignature } from '../src/fathom';
import { KEY, meeting, startFakeFathom, SUMMARY, withNotes, type FakeFathom } from './fake-fathom';
import { jsonOf, run, testCredentials, type FakeApi } from './helpers';

let api: FakeApi;
let admin: FakeApi;
let state: FakeFathom;
const fresh = (): FakeFathom => ({
  webhooks: new Map(),
  meetings: [
    withNotes(1, '2026-11-12T09:00:00Z'),
    meeting(2, '2026-11-12T10:00:00Z'),
    withNotes(3, '2026-11-12T11:00:00Z'),
    meeting(4, '2026-11-12T12:00:00Z', { calendar_invitees: [{ name: 'Dana', email: 'dana@acme.example', email_domain: 'acme.example', is_external: false }] }),
    withNotes(5, '2026-11-12T13:00:00Z'),
  ],
});
beforeAll(async () => {
  api = await startFakeFathom(() => state);
  admin = await startFakeFathom(() => state, { admin: true });
});
afterAll(async () => {
  await api.close();
  await admin.close();
});
beforeEach(() => {
  state = fresh();
  api.requests.length = 0;
});

const credentials = (url = api.url) => ({ fathomApi: { apiKey: KEY, baseUrl: url } });
const meetings = (parameters: JsonObject = {}, options: JsonObject = {}) =>
  run(Fathom, { resource: 'meeting', operation: 'getManySince', since: '2026-11-12T00:00:00Z', returnAll: true, meetingOptions: options, ...parameters }, { credentials: credentials() });

function expectActivity(item: JsonObject, extra: string[] = []) {
  const keys = Object.keys(ACTIVITY_ITEM_SCHEMA.properties as object).filter((k) => k !== 'cursor');
  expect(Object.keys(item).filter((k) => !extra.includes(k)).filter((k) => k !== 'cursor').sort()).toEqual(keys.sort());
  expect(String(item.summary).length).toBeLessThanOrEqual(600);
  expect(item.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

describe('credential', () => {
  it('passes with the key and fails with a wrong one', async () => {
    expect(await testCredentials('fathomApi', credentials().fathomApi)).toMatchObject({ ok: true });
    const bad = await testCredentials('fathomApi', { apiKey: 'nope', baseUrl: api.url });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.message).toMatch(/401/);
  });
  it('sends the key as X-Api-Key', async () => {
    await meetings();
    expect(api.requests[0].headers['x-api-key']).toBe(KEY);
  });
});

describe('Meeting → Get Many Changed Since', () => {
  it('pages through the cursor and returns oldest first with a cursor', async () => {
    const items = jsonOf(await meetings());
    expect(items.map((i) => i.sourceId)).toEqual([1, 2, 3, 4, 5].map((n) => `fathom:meeting:${n}`));
    expect(api.requests.filter((r) => r.path === '/meetings').length).toBe(3); // 5 meetings, 2 a page
    expect(api.requests[1].query.get('cursor')).toBe('2');
    expect(items[0].cursor).toBe('2026-11-12T09:00:00Z');
    items.forEach((i) => expectActivity(i));
  });

  it('continues after a cursor (strictly after) and honours the limit', async () => {
    const after = jsonOf(await meetings({ since: '2026-11-12T11:00:00Z' }));
    expect(after.map((i) => i.sourceId)).toEqual(['fathom:meeting:4', 'fathom:meeting:5']);
    expect(api.requests[0].query.get('created_after')).toBe('2026-11-12T11:00:00.000Z');
    const limited = jsonOf(await meetings({ returnAll: false, limit: 2 }));
    expect(limited.map((i) => i.sourceId)).toEqual(['fathom:meeting:1', 'fathom:meeting:2']);
  });

  it('maps a meeting: kind, url, actor, time, hints and a clipped plain summary', async () => {
    const [notes, held] = jsonOf(await meetings());
    expect(notes).toMatchObject({
      source: 'fathom',
      sourceId: 'fathom:meeting:1',
      kind: 'work.meeting_notes',
      url: 'https://fathom.video/share/1',
      actorEmail: 'dana@acme.example',
      occurredAt: '2026-11-12T09:00:00.000Z',
      title: 'Meeting 1',
      teamHint: 'Sales',
      customerHint: 'globex.example',
      initiativeHint: null,
    });
    expect(String(notes.summary).length).toBeLessThanOrEqual(600);
    expect(String(notes.summary)).toMatch(/^Summary Renewal discussed\./);
    expect(SUMMARY.length).toBeGreaterThan(600);
    expect(held).toMatchObject({ kind: 'work.meeting_held', summary: 'Meeting with Dana, Pat' });
  });

  it('reads summaries only when asked, and no transcript by default', async () => {
    await meetings();
    const query = api.requests[0].query;
    expect(query.get('include_summary')).toBe('true');
    expect(query.get('include_transcript')).toBeNull();
    api.requests.length = 0;
    const items = jsonOf(await meetings({}, { includeSummary: false }));
    expect(api.requests[0].query.get('include_summary')).toBeNull();
    expect(items[0].kind).toBe('work.meeting_held');
  });

  it('uses Internal Domains for the customer hint, and the recorder domain when empty', async () => {
    const items = jsonOf(await meetings({}, { internalDomains: 'acme.example, globex.example' }));
    expect(items[0].customerHint).toBeNull();
    expect(jsonOf(await meetings())[3].customerHint).toBeNull(); // meeting 4 has only internal invitees
    expect(customerOf(state.meetings[0], '')).toBe('globex.example');
  });

  it('can output one item per action item', async () => {
    const items = jsonOf(await meetings({}, { actionItemItems: true }));
    const forOne = items.filter((i) => String(i.sourceId).startsWith('fathom:action:1:') || i.sourceId === 'fathom:meeting:1');
    expect(forOne.map((i) => i.sourceId)).toEqual(['fathom:meeting:1', 'fathom:action:1:1', 'fathom:action:1:2']);
    const [, first, second] = forOne;
    expect(first).toMatchObject({ kind: 'work.action_item', title: 'Send the quote', actorEmail: 'dana@acme.example', url: 'https://fathom.video/share/1?t=600' });
    expect(second).toMatchObject({ actorEmail: 'dana@acme.example', title: 'Book a kickoff' }); // no assignee email: the recorder
    expectActivity(first);
    expect(items.length).toBe(2 + 1 * 0 + 3 * 3); // 3 meetings with 2 action items + 2 without
  });
});

describe('Meeting → Get and transcript gating', () => {
  const get = (options: JsonObject = {}, id: string = '3') => run(Fathom, { resource: 'meeting', operation: 'get', recordingId: id, meetingOptions: options }, { credentials: credentials() });

  it('finds the meeting across pages and returns the item plus text without a transcript', async () => {
    const [item] = jsonOf(await get({}, '5'));
    expectActivity(item, ['text']);
    expect(item.sourceId).toBe('fathom:meeting:5');
    expect(String(item.text)).toContain('Summary');
    expect(String(item.text)).toContain('- [ ] Send the quote (Dana)');
    expect(String(item.text)).toContain('- [x] Book a kickoff');
    expect(JSON.stringify(item)).not.toContain('Secret words');
    expect(api.requests.some((r) => r.query.get('include_transcript'))).toBe(false);
  });

  it('adds the transcript only with Include Transcript', async () => {
    const [item] = jsonOf(await get({ includeTranscript: true }));
    expect(String(item.text)).toContain('[00:00:05] Dana: Secret words');
    expect((item.raw as JsonObject).transcript).toBeTruthy();
    expect(api.requests[0].query.get('include_transcript')).toBe('true');
  });

  it('fails clearly for an unknown recording or a bad id', async () => {
    expect((await get({}, '99')).error?.message).toMatch(/No meeting with recording ID 99/);
    expect((await get({}, 'abc')).error?.message).toMatch(/numeric/);
  });

  it('Recording → Get Transcript needs the switch', async () => {
    const call = (extra: JsonObject) => run(Fathom, { resource: 'recording', operation: 'getTranscript', recordingId: '3', ...extra }, { credentials: credentials() });
    expect((await call({})).error?.message).toMatch(/Transcripts are off/);
    const [t] = jsonOf(await call({ includeTranscript: true }));
    expect(t.text).toBe('[00:00:05] Dana: Secret words');
    const [s] = jsonOf(await run(Fathom, { resource: 'recording', operation: 'getSummary', recordingId: '3' }, { credentials: credentials() }));
    expect(s).toMatchObject({ recording_id: 3, template_name: 'general' });
  });
});

describe('lists', () => {
  it('lists teams, meeting types, team members (paged, lowercase email) and users (admin only)', async () => {
    const list = (resource: string, extra: JsonObject = {}, url = api.url) => run(Fathom, { resource, operation: 'getAll', returnAll: true, ...extra }, { credentials: credentials(url) });
    expect(jsonOf(await list('team'))).toEqual([{ name: 'Sales', created_at: '2026-01-01T00:00:00Z' }]);
    expect(jsonOf(await list('meetingType'))[0]).toMatchObject({ name: 'External' });
    expect(jsonOf(await list('teamMember')).map((m) => m.email)).toEqual(['dana@acme.example', 'lee@acme.example']);
    expect(jsonOf(await list('teamMember', { teamName: 'Empty' }))).toEqual([]);
    expect(jsonOf(await list('user', {}, admin.url))[0]).toMatchObject({ email: 'dana@acme.example', status: 'active' });
    expect((await list('user')).error?.message).toMatch(/403/);
  });
});

describe('helpers', () => {
  it('reads Since as an ISO time or cursor, and defaults to 24 hours', () => {
    expect(sinceIso('2026-11-12T09:00:00Z')).toBe('2026-11-12T09:00:00.000Z');
    expect(sinceIso('', Date.parse('2026-11-12T00:00:00Z'))).toBe('2026-11-11T00:00:00.000Z');
    expect(() => sinceIso('later')).toThrow(/Since/);
  });
});

describe('Fathom Trigger', () => {
  const URL_ = 'https://landflow.example/api/webhook/app/wf_f/n1';
  const node = { id: 'n1', name: 'Fathom Trigger', type: 'fathom.fathomTrigger', typeVersion: 1 };
  const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'fathom' };
  const base = (parameters: JsonObject) => ({ protocol: PROTOCOL_VERSION, workflowId: 'wf_f', node, parameters, webhookUrl: URL_, credentials: credentials() });
  const method = (name: 'create' | 'delete' | 'checkExists', staticData: JsonObject, parameters: JsonObject = {}) =>
    runWebhookMethod(FathomTrigger, { ...base(parameters), method: name, staticData }, extras);
  const created = async (parameters: JsonObject = {}) => (await method('create', {}, parameters)).staticData as JsonObject;
  const deliver = (staticData: JsonObject, payload: JsonObject, options: { parameters?: JsonObject; signature?: string; timestamp?: number; id?: string } = {}) => {
    const raw = JSON.stringify(payload);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const id = options.id ?? 'msg_1';
    return runWebhook(
      FathomTrigger,
      {
        ...base(options.parameters ?? {}),
        staticData,
        request: {
          method: 'POST',
          path: '/hook',
          headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': options.signature ?? signFathom(String(staticData.secret), raw, id, timestamp) },
          query: {},
          body: Buffer.from(raw).toString('base64'),
        },
      },
      extras,
    );
  };

  it('creates the webhook through the API with the chosen includes, then checks and deletes it', async () => {
    const data = await created({ triggeredFor: ['my_recordings', 'shared_team_recordings'], options: { includeTranscript: true } });
    expect(data).toMatchObject({ url: URL_, id: 'wh_1' });
    expect(String(data.secret)).toMatch(/^whsec_/);
    expect(state.webhooks.get('wh_1')).toMatchObject({
      destination_url: URL_,
      triggered_for: ['my_recordings', 'shared_team_recordings'],
      include_transcript: true,
      include_summary: true,
      include_action_items: true,
    });
    const params = { triggeredFor: ['my_recordings', 'shared_team_recordings'], options: { includeTranscript: true } };
    expect((await method('checkExists', data, params)).exists).toBe(true);
    expect((await method('checkExists', data, {})).exists).toBe(false); // options changed: re-create
    expect((await method('checkExists', {}, params)).exists).toBe(false);
    expect((await method('delete', data, params)).staticData).toEqual({});
    expect(state.webhooks.size).toBe(0);
  });

  it('keeps the transcript out of the webhook by default and tolerates a webhook already gone', async () => {
    const data = await created();
    expect(state.webhooks.get('wh_1')).toMatchObject({ include_transcript: false });
    state.webhooks.clear();
    expect((await method('delete', data)).error).toBeUndefined();
  });

  it('fails creation with a bad key', async () => {
    const response = await runWebhookMethod(FathomTrigger, { ...base({}), credentials: credentials(), method: 'create', staticData: {} }, { ...extras });
    expect(response.error).toBeUndefined();
    const bad = await runWebhookMethod(FathomTrigger, { ...base({}), credentials: { fathomApi: { apiKey: 'x', baseUrl: api.url } }, method: 'create', staticData: {} }, extras);
    expect(bad.error?.message).toMatch(/401/);
  });

  it('turns a signed meeting into an activity item with the delivery id as idempotency key', async () => {
    const data = await created();
    const payload = withNotes(7, '2026-11-12T14:00:00Z');
    const ok = await deliver(data, payload, { id: 'msg_abc' });
    expect(ok.idempotencyKey).toBe('msg_abc');
    expect(ok.items).toHaveLength(1);
    const item = ok.items![0].json as JsonObject;
    expectActivity(item);
    expect(item).toMatchObject({ sourceId: 'fathom:meeting:7', kind: 'work.meeting_notes' });
    expect(JSON.stringify(item)).not.toContain('Secret words');
  });

  it('puts the transcript in raw only when asked, and fans out action items', async () => {
    const data = await created();
    const payload = withNotes(7, '2026-11-12T14:00:00Z');
    const withTranscript = await deliver(data, payload, { parameters: { options: { includeTranscript: true, actionItemItems: true } } });
    const items = withTranscript.items!.map((i) => i.json as JsonObject);
    expect(items.map((i) => i.sourceId)).toEqual(['fathom:meeting:7', 'fathom:action:7:1', 'fathom:action:7:2']);
    expect(JSON.stringify(items[0].raw)).toContain('Secret words');
    expect(JSON.stringify(items[1].raw)).not.toContain('Secret words');
  });

  it('rejects a bad signature, a missing one, a wrong secret and a stale timestamp', async () => {
    const data = await created();
    const payload = withNotes(7, '2026-11-12T14:00:00Z');
    const bad = await deliver(data, payload, { signature: 'v1,AAAA' });
    expect(bad.response?.status).toBe(401);
    expect(bad.items).toBeUndefined();
    const other = await deliver(data, payload, { signature: signFathom('whsec_' + Buffer.from('other-secret').toString('base64'), JSON.stringify(payload), 'msg_1', Math.floor(Date.now() / 1000)) });
    expect(other.response?.status).toBe(401);
    const stale = await deliver(data, payload, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.response?.status).toBe(401);
    const unregistered = await deliver({}, payload, { signature: 'v1,AAAA' });
    expect(unregistered.response?.status).toBe(401);
  });

  it('accepts any one of several space-delimited signatures, and a wider tolerance', async () => {
    const data = await created();
    const raw = JSON.stringify(withNotes(7, '2026-11-12T14:00:00Z'));
    const ts = Math.floor(Date.now() / 1000) - 3600;
    const good = signFathom(String(data.secret), raw, 'msg_1', ts);
    expect(verifyFathomSignature(String(data.secret), raw, { id: 'msg_1', timestamp: String(ts), signature: `v1,AAAA ${good}` }, { toleranceSeconds: 7200 })).toBe(true);
    expect(verifyFathomSignature(String(data.secret), raw + ' ', { id: 'msg_1', timestamp: String(ts), signature: good }, { toleranceSeconds: 7200 })).toBe(false);
    expect(verifyFathomSignature(String(data.secret), raw, { id: 'msg_1', timestamp: String(ts), signature: good })).toBe(false);
  });
});

describe('manifest', () => {
  it('lists the nodes, the credential and the icon', () => {
    expect(plugin.info).toMatchObject({ id: 'fathom', icon: 'file:fathom.svg' });
    expect(plugin.nodes.map((n) => n.description.name)).toEqual(['fathom', 'fathomTrigger']);
    expect(plugin.credentialTypes!.map((c) => c.name)).toEqual(['fathomApi']);
    expect(FathomTrigger.description.triggerSource).toBe('appWebhook');
  });
});

describe.skipIf(!(process.env.LANDFLOW_INTEGRATION ?? '').includes('fathom'))('live Fathom', () => {
  it('accepts the key in FATHOM_API_KEY', async () => {
    const result = await testCredentials('fathomApi', { apiKey: process.env.FATHOM_API_KEY ?? '', baseUrl: '' });
    expect(result.ok).toBe(true);
  });
});
