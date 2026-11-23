/**
 * Slack as an activity source, against a fake workspace: Message → Get Many Since (patterns, paging, cursor, private
 * and bot filters, replies, hints), Message → Get, User → Get Many, Channel → Get Many by name, the Slack Activity
 * Trigger (signed and unsigned events, filters, lookups cached in static data) and the Slack Trigger's name filter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type JsonObject, type WebhookRequest } from '@landflow/protocol';
import { ACTIVITY_ITEM_SCHEMA, runWebhook, runWebhookMethod, slackSignature } from '@landflow/sdk';
import { plugin } from '../src/main';
import { Slack } from '../src/nodes/slack';
import { SlackActivityTrigger } from '../src/nodes/slack-activity-trigger';
import { SlackTrigger } from '../src/nodes/slack-trigger';
import { channelPatterns, hintsFor, hintsOf, permalink, plainSlackText, sinceTs } from '../src/slack-activity';
import { msg, startFakeSlack, TOKEN, user, type FakeWorkspace } from './fake-slack';
import { jsonOf, run, testCredentials, type FakeApi } from './helpers';

const SIGNING_SECRET = 'fake-signing-secret';
const BASE = 1_794_477_600; // 2026-11-12T10:00:00Z

function workspace(): FakeWorkspace {
  const many = Array.from({ length: 250 }, (_, i) => msg(1000 + i, `bulk ${i}`));
  return {
    users: [
      user('U1', 'Dana@Acme.example'),
      user('U2', 'lee@acme.example'),
      user('UB', '', { is_bot: true }),
      user('UD', 'gone@acme.example', { deleted: true }),
      ...Array.from({ length: 230 }, (_, i) => user(`UX${i}`, `x${i}@acme.example`)),
    ],
    channels: [
      {
        id: 'C1',
        name: 'customer-acme',
        is_member: true,
        messages: [
          msg(10, 'Kickoff with <@U2>: renewal <https://acme.example/plan|plan> &amp; pricing', { reply_count: 1, latest_reply: `${BASE + 40}.000100` }),
          msg(20, '', { subtype: 'channel_join', user: 'U2' }),
          { ...msg(30, 'deploy done', { bot_id: 'B1', subtype: 'bot_message' }), user: null },
          msg(50, 'We decided to ship the export', { user: 'U2' }),
        ],
        replies: { [`${BASE + 10}.000100`]: [msg(40, 'sounds good', { user: 'U2', thread_ts: `${BASE + 10}.000100` })] },
      },
      { id: 'C2', name: 'eng-platform', is_member: true, messages: [msg(15, 'Migrating the queue')] },
      { id: 'C3', name: 'random', is_member: true, messages: [msg(12, 'lunch?')] },
      { id: 'C4', name: 'customer-globex', is_member: false, messages: [msg(11, 'not readable')] },
      { id: 'C5', name: 'customer-bulk', is_member: true, messages: many },
      { id: 'G1', name: 'customer-secret', is_private: true, is_member: true, messages: [msg(13, 'private note')] },
      { id: 'D1', name: '', is_im: true, is_member: true, messages: [msg(14, 'a dm')] },
    ],
  };
}

let api: FakeApi;
let current = workspace();
beforeAll(async () => {
  api = await startFakeSlack(() => current);
});
afterAll(() => api.close());
beforeEach(() => {
  current = workspace();
  api.requests.length = 0;
});

const credentials = () => ({ slackApi: { accessToken: TOKEN, baseUrl: api.url, signingSecret: SIGNING_SECRET } });
const since = (params: JsonObject) => run(Slack, { resource: 'message', operation: 'getManySince', since: `${BASE}.000000`, returnAll: true, ...params }, { credentials: credentials() });

/** The item matches the activity item schema: required fields present, nothing else, types right. */
function expectActivity(item: JsonObject, extra: string[] = []) {
  const properties = ACTIVITY_ITEM_SCHEMA.properties as Record<string, { type: string | string[] }>;
  for (const key of ACTIVITY_ITEM_SCHEMA.required as string[]) expect(item, key).toHaveProperty(key);
  for (const [key, value] of Object.entries(item)) {
    if (extra.includes(key)) continue;
    expect(Object.keys(properties), `unexpected field ${key}`).toContain(key);
    const types = ([] as string[]).concat(properties[key].type);
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
    expect(types, `${key} is ${actual}`).toContain(actual);
  }
  expect(String(item.summary).length).toBeLessThanOrEqual(600);
  expect(item.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

describe('Slack activity helpers', () => {
  it('matches channel patterns, builds hints, permalinks and readable text', () => {
    const patterns = channelPatterns('#customer-*, proj-?x  eng');
    expect(patterns.map((p) => p.test('Customer-Acme'))).toEqual([true, false, false]);
    expect(patterns[1].test('proj-ax')).toBe(true);
    expect(patterns[2].test('eng')).toBe(true);
    expect(patterns[2].test('eng-2')).toBe(false);
    const hints = hintsOf({ initiativePrefix: 'proj-', teamMap: 'eng-*=R&D\ncs-*=CS' });
    expect(hintsFor('customer-acme', hints)).toEqual({ customerHint: 'acme', initiativeHint: null, teamHint: null });
    expect(hintsFor('proj-export', hints)).toEqual({ customerHint: null, initiativeHint: 'export', teamHint: null });
    expect(hintsFor('eng-platform', hints).teamHint).toBe('R&D');
    expect(hintsFor('customer-', hints).customerHint).toBeNull();
    expect(permalink('https://acme.slack.com/', 'C1', '1794477610.000100')).toBe('https://acme.slack.com/archives/C1/p1794477610000100');
    expect(permalink('https://acme.slack.com/', 'C1', '2.000200', '1.000100')).toBe('https://acme.slack.com/archives/C1/p2000200?thread_ts=1.000100&cid=C1');
    expect(plainSlackText('hi <@U1> in <#C1|general>, see <https://x.example|the doc> <!here> &lt;3')).toBe('hi @U1 in #general, see the doc @here <3');
    expect(sinceTs('2026-11-12T10:00:00Z')).toBe('1794477600.000000');
    expect(sinceTs('1794477600.5')).toBe('1794477600.5');
    expect(Number(sinceTs('', 1_794_477_600_000))).toBe(BASE - 86_400);
  });
});

describe('Slack Message → Get Many Since', () => {
  it('reads matching channels the app is in, oldest first, as activity items', async () => {
    const response = await since({ channelNames: 'customer-*, eng-*', activityOptions: { teamMap: 'eng-*=R&D' } });
    expect(response.error).toBeUndefined();
    const items = jsonOf(response);
    // C5's bulk messages come after the others (seconds 1000+).
    const first = items.slice(0, 3);
    expect(first.map((i) => i.title)).toEqual([
      '#customer-acme: Kickoff with @U2: renewal plan & pricing',
      '#eng-platform: Migrating the queue',
      '#customer-acme: We decided to ship the export',
    ]);
    expect(items).toHaveLength(253);
    for (const item of items) expectActivity(item);
    expect(first[0]).toMatchObject({
      source: 'slack',
      sourceId: `slack:T1:C1:${BASE + 10}.000100`,
      url: `https://acme.slack.com/archives/C1/p${BASE + 10}000100`,
      actorEmail: 'dana@acme.example',
      occurredAt: '2026-11-12T10:00:10.000Z',
      kind: 'work.discussion',
      customerHint: 'acme',
      teamHint: null,
      cursor: `${BASE + 10}.000100`,
    });
    expect(first[1]).toMatchObject({ teamHint: 'R&D', customerHint: null });
    // not a member of #customer-globex, private #customer-secret left out, joins and bots skipped, no replies.
    expect(items.some((i) => String(i.sourceId).includes(':C4:') || String(i.sourceId).includes(':G1:'))).toBe(false);
    expect(items.some((i) => i.summary === 'deploy done' || i.summary === 'sounds good')).toBe(false);
    // users.info once per person.
    expect(api.requests.filter((r) => r.path === '/users.info').map((r) => r.query.get('user')).sort()).toEqual(['U1', 'U2']);
  });

  it('follows history pages (cursor) and continues from an item’s cursor', async () => {
    const all = jsonOf(await since({ channelNames: 'customer-bulk' }));
    expect(all).toHaveLength(250);
    const pages = api.requests.filter((r) => r.path === '/conversations.history');
    expect(pages.map((r) => r.query.get('cursor'))).toEqual([null, 'next-200']);
    expect(pages[0].query.get('oldest')).toBe(`${BASE}.000000`);

    const limited = jsonOf(await since({ channelNames: 'customer-bulk', returnAll: false, limit: 100 }));
    expect(limited).toHaveLength(100);
    expect(limited[0].summary).toBe('bulk 0');
    const rest = jsonOf(await since({ channelNames: 'customer-bulk', since: String(limited[99].cursor) }));
    expect(rest).toHaveLength(150);
    expect(rest[0].summary).toBe('bulk 100');
    expect(new Set([...limited, ...rest].map((i) => i.sourceId)).size).toBe(250);
  });

  it('reads private channels and DMs, bots and thread replies only when asked', async () => {
    const items = jsonOf(await since({ channelNames: 'customer-a*, customer-s*, dm', activityOptions: { includePrivate: true, includeBots: true, includeReplies: true } }));
    expect(items.map((i) => i.summary)).toEqual([
      'Kickoff with @U2: renewal plan & pricing',
      'private note',
      'a dm',
      'deploy done',
      'sounds good',
      'We decided to ship the export',
    ]);
    const reply = items.find((i) => i.summary === 'sounds good')!;
    expect(reply.url).toBe(`https://acme.slack.com/archives/C1/p${BASE + 40}000100?thread_ts=${BASE + 10}.000100&cid=C1`);
    expect(api.requests.find((r) => r.path === '/conversations.list')!.query.get('types')).toBe('public_channel,private_channel,mpim,im');
  });

  it('reads channels by id, and needs a pattern or ids', async () => {
    const items = jsonOf(await since({ channelNames: '', activityOptions: { channelIds: 'C2, C3' } }));
    expect(items.map((i) => i.summary)).toEqual(['lunch?', 'Migrating the queue']);
    const failed = await since({ channelNames: '' });
    expect(failed.error?.message ?? JSON.stringify(failed)).toMatch(/Channel Names/);
  });
});

describe('Slack Message → Get, User → Get Many, Channel → Get Many', () => {
  it('gets one message, a thread reply too, with its full text', async () => {
    const long = 'x'.repeat(900);
    current.channels[1].messages.push(msg(60, long));
    const [item] = jsonOf(await run(Slack, { resource: 'message', operation: 'get', channelId: 'C2', ts: `${BASE + 60}.000100` }, { credentials: credentials() }));
    expectActivity(item, ['text']);
    expect(item.text).toBe(long);
    expect(String(item.summary)).toHaveLength(600);
    const [reply] = jsonOf(await run(Slack, { resource: 'message', operation: 'get', channelId: 'C1', ts: `${BASE + 40}.000100` }, { credentials: credentials() }));
    expect(reply).toMatchObject({ text: 'sounds good', actorEmail: 'lee@acme.example' });
    const privateOne = await run(Slack, { resource: 'message', operation: 'get', channelId: 'G1', ts: `${BASE + 13}.000100` }, { credentials: credentials() });
    expect(privateOne.error?.message).toMatch(/private/);
  });

  it('lists members with email over pages, without bots and deactivated members', async () => {
    const users = jsonOf(await run(Slack, { resource: 'user', operation: 'getAll', returnAll: true }, { credentials: credentials() }));
    expect(users).toHaveLength(232);
    expect(users[0]).toMatchObject({ id: 'U1', email: 'Dana@Acme.example', title: 'Engineer' });
    expect(users.some((u) => u.id === 'UB' || u.id === 'UD')).toBe(false);
    expect(api.requests.filter((r) => r.path === '/users.list').map((r) => r.query.get('cursor'))).toEqual([null, 'next-200']);
    const withAll = jsonOf(await run(Slack, { resource: 'user', operation: 'getAll', returnAll: false, limit: 3, userFilters: { includeBots: true, includeDeleted: true } }, { credentials: credentials() }));
    expect(withAll.map((u) => u.id)).toEqual(['U1', 'U2', 'UB']);
  });

  it('filters channels by name pattern', async () => {
    const channels = jsonOf(await run(Slack, { resource: 'channel', operation: 'getAll', returnAll: true, filters: { names: 'customer-*' } }, { credentials: credentials() }));
    expect(channels.map((c) => c.name)).toEqual(['customer-acme', 'customer-globex', 'customer-bulk']);
  });

  it('declares the activity schema on the operations and the trigger', () => {
    const slack = plugin.nodes.find((n) => n.description.name === 'slack')!.description;
    const ops = slack.properties.filter((p) => p.name === 'operation').flatMap((p) => p.options ?? []) as unknown as JsonObject[];
    expect(ops.find((o) => o.value === 'getManySince')!.outputSchema).toBe(ACTIVITY_ITEM_SCHEMA);
    expect((ops.find((o) => o.value === 'get' && o.outputSchema)!.outputSchema as JsonObject).required).toContain('text');
    expect(SlackActivityTrigger.description.outputSchema).toBe(ACTIVITY_ITEM_SCHEMA);
  });

  it('tests the credential against the fake workspace', async () => {
    expect(await testCredentials('slackApi', credentials().slackApi)).toMatchObject({ ok: true, message: 'Authenticated as landflow-bot in team Acme' });
    expect(await testCredentials('slackApi', { ...credentials().slackApi, accessToken: 'xoxb-wrong' })).toMatchObject({ ok: false });
  });
});

describe('Slack Activity Trigger', () => {
  const URL_ = 'https://landflow.example/api/webhook/app/wf_act/n1';
  const node = { id: 'n1', name: 'Slack Activity Trigger', type: 'messaging.slackActivityTrigger', typeVersion: 1 };
  const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' };
  const PARAMS: JsonObject = { channelNames: 'customer-*', options: { teamMap: 'customer-*=CS' } };
  const base = (parameters: JsonObject) => ({ protocol: PROTOCOL_VERSION, workflowId: 'wf_act', node, parameters, webhookUrl: URL_, credentials: credentials() });
  let n = 0;
  const callback = (event: JsonObject): JsonObject => ({ type: 'event_callback', team_id: 'T1', event_id: `Ev${++n}`, authorizations: [{ user_id: 'UBOT', is_bot: true }], event });
  const deliver = (staticData: JsonObject, payload: JsonObject, options: { parameters?: JsonObject; signature?: string; timestamp?: number } = {}) => {
    const raw = JSON.stringify(payload);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const request: WebhookRequest = {
      ...base(options.parameters ?? PARAMS),
      staticData,
      request: {
        method: 'POST',
        path: new URL(URL_).pathname,
        headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': options.signature ?? slackSignature(SIGNING_SECRET, raw, timestamp) },
        query: {},
        body: Buffer.from(raw).toString('base64'),
      },
    };
    return runWebhook(SlackActivityTrigger, request, extras);
  };
  const created = async (parameters = PARAMS) => (await runWebhookMethod(SlackActivityTrigger, { ...base(parameters), method: 'create', staticData: {} }, extras)).staticData!;

  it('publishes, verifies signatures and turns a message into an activity item', async () => {
    const staticData = await created();
    expect(staticData).toEqual({ url: URL_, teamId: 'T1', botUserId: 'UBOT', workspaceUrl: 'https://acme.slack.com/' });
    const event = callback({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'Renewal <@U2>', ts: `${BASE + 70}.000100` });

    const bad = await deliver(staticData, event, { signature: 'v0=deadbeef' });
    expect(bad.response?.status).toBe(401);
    expect(bad.items).toBeUndefined();
    const stale = await deliver(staticData, event, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.response?.status).toBe(401);

    const verification = await deliver(staticData, { type: 'url_verification', challenge: 'abc' });
    expect(JSON.parse(verification.response!.body!)).toEqual({ challenge: 'abc' });

    const good = await deliver(staticData, event);
    expect(good.error).toBeUndefined();
    expect(good.idempotencyKey).toBe(event.event_id);
    const item = good.items![0].json;
    expectActivity(item);
    expect(item).toMatchObject({
      sourceId: `slack:T1:C1:${BASE + 70}.000100`,
      url: `https://acme.slack.com/archives/C1/p${BASE + 70}000100`,
      actorEmail: 'dana@acme.example',
      title: '#customer-acme: Renewal @U2',
      customerHint: 'acme',
      teamHint: 'CS',
    });
    expect(item).not.toHaveProperty('cursor');
    // The channel name and email are kept: the next event needs no lookups.
    const cached = good.staticData!;
    expect(Object.keys((cached.lookups as JsonObject).channels as JsonObject)).toEqual(['C1']);
    api.requests.length = 0;
    const again = await deliver(cached, callback({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'again', ts: `${BASE + 80}.000100` }));
    expect(again.items).toHaveLength(1);
    expect(again.staticData).toBeUndefined();
    expect(api.requests).toHaveLength(0);
  });

  it('ignores other channels, private channels, joins, edits, bots and (when off) replies', async () => {
    const staticData = await created();
    const reasons: string[] = [];
    for (const event of [
      { type: 'message', channel: 'C3', channel_type: 'channel', user: 'U1', text: 'lunch', ts: '1.1' },
      { type: 'message', channel: 'G1', channel_type: 'group', user: 'U1', text: 'secret', ts: '1.2' },
      { type: 'message', channel: 'C1', channel_type: 'channel', subtype: 'channel_join', user: 'U2', ts: '1.3' },
      { type: 'message', channel: 'C1', channel_type: 'channel', subtype: 'message_changed', message: { text: 'x' }, ts: '1.4' },
      { type: 'message', channel: 'C1', channel_type: 'channel', bot_id: 'B1', subtype: 'bot_message', text: 'deploy', ts: '1.5' },
      { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UBOT', bot_id: 'B9', text: 'my own', ts: '1.6' },
      { type: 'reaction_added', user: 'U1', item: { channel: 'C1', ts: '1.0' } },
    ]) {
      const response = await deliver(staticData, callback(event as unknown as JsonObject));
      expect(response.items).toBeUndefined();
      reasons.push(JSON.parse(response.response!.body!).ignored);
    }
    expect(reasons).toEqual(['channel', 'private', 'channel_join', 'message_changed', 'bot_message', 'bot', 'reaction_added']);

    const reply = callback({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U2', text: 'a reply', ts: '2.2', thread_ts: '2.1' });
    expect((await deliver(staticData, reply)).items).toHaveLength(1);
    const off = await deliver(staticData, reply, { parameters: { ...PARAMS, includeReplies: false } });
    expect(JSON.parse(off.response!.body!).ignored).toBe('reply');
    const privateOn = await deliver(staticData, callback({ type: 'message', channel: 'G1', channel_type: 'group', user: 'U1', text: 'secret', ts: '1.2' }), {
      parameters: { ...PARAMS, includePrivate: true },
    });
    expect(privateOn.items![0].json).toMatchObject({ customerHint: 'secret', summary: 'secret' });
    const otherBot = await deliver(staticData, callback({ type: 'message', channel: 'C1', channel_type: 'channel', bot_id: 'B1', subtype: 'bot_message', text: 'deploy', ts: '1.5' }), {
      parameters: { ...PARAMS, includeBots: true },
    });
    expect(otherBot.items).toHaveLength(1);
  });

  it('refuses to publish without a signing secret', async () => {
    const response = await runWebhookMethod(SlackActivityTrigger, { ...base(PARAMS), credentials: { slackApi: { accessToken: TOKEN, baseUrl: api.url } }, method: 'create', staticData: {} }, extras);
    expect(response.error?.message).toMatch(/Signing Secret/);
  });
});

describe('Slack Trigger channel name filter', () => {
  it('starts runs only for channels whose name matches', async () => {
    const raw = (event: JsonObject) => JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: `E${event.channel}`, event });
    const deliver = (event: JsonObject) => {
      const body = raw(event);
      const timestamp = Math.floor(Date.now() / 1000);
      return runWebhook(
        SlackTrigger,
        {
          protocol: PROTOCOL_VERSION,
          workflowId: 'wf',
          node: { id: 'n2', name: 'Slack Trigger', type: 'messaging.slackTrigger', typeVersion: 1 },
          parameters: { events: ['message'], channelNames: 'customer-*' },
          webhookUrl: 'https://landflow.example/hook',
          credentials: credentials(),
          staticData: { url: 'https://landflow.example/hook', teamId: 'T1', botUserId: 'UBOT' },
          request: { method: 'POST', path: '/hook', headers: { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': slackSignature(SIGNING_SECRET, body, timestamp) }, query: {}, body: Buffer.from(body).toString('base64') },
        },
        { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' },
      );
    };
    const match = await deliver({ type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' });
    expect(match.items).toHaveLength(1);
    expect(match.items![0].json).toMatchObject({ channel: 'C1', text: 'hi' });
    expect(match.staticData).toMatchObject({ teamId: 'T1', lookups: { channels: { C1: { n: 'customer-acme' } } } });
    const miss = await deliver({ type: 'message', channel: 'C3', user: 'U1', text: 'hi', ts: '1.2' });
    expect(miss.items).toBeUndefined();
  });
});
