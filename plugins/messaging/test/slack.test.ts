/** Slack node and the slackApi credential against a fake Web API. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { Slack } from '../src/nodes/slack';
import { jsonOf, loadOptions, run, startFakeApi, testCredentials, type FakeApi, type FakeRequest } from './helpers';

const TOKEN = 'xoxb-test-token-123';

/** 5 channels served 2 per page with cursors, like conversations.list. */
const CHANNELS = Array.from({ length: 5 }, (_, i) => ({
  id: `C00${i}`,
  name: ['random', 'general', 'dev', 'ops', 'design'][i],
  is_private: i === 3,
  is_archived: false,
  is_member: true,
  num_members: 10 + i,
  topic: { value: `topic ${i}`, creator: 'U1' },
  purpose: { value: `purpose ${i}`, creator: 'U1' },
  created: 1700000000 + i,
}));

function slack(req: FakeRequest) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return { body: { ok: false, error: 'invalid_auth' } };
  const method = req.path.slice(1);
  const body = (req.body ?? {}) as JsonObject;
  switch (method) {
    case 'auth.test':
      return { body: { ok: true, url: 'https://acme.slack.com/', team: 'Acme', user: 'landflow-bot', team_id: 'T1', user_id: 'U1' } };
    case 'chat.postMessage':
      if (body.channel === 'C404') return { body: { ok: false, error: 'channel_not_found' } };
      if (body.channel === 'CSCOPE') return { body: { ok: false, error: 'missing_scope', needed: 'chat:write', provided: 'channels:read' } };
      if (body.channel === 'CFATAL') return { body: { ok: false, error: 'internal_error' } };
      return {
        body: {
          ok: true,
          channel: body.channel,
          ts: '1700000000.000100',
          message: { text: body.text, ts: '1700000000.000100' },
          response_metadata: { warnings: [] },
        },
      };
    case 'chat.update':
      return { body: { ok: true, channel: body.channel, ts: body.ts, text: body.text, message: { text: body.text } } };
    case 'chat.delete':
      return { body: { ok: true, channel: body.channel, ts: body.ts } };
    case 'chat.getPermalink':
      return {
        body: {
          ok: true,
          channel: req.query.get('channel'),
          permalink: `https://acme.slack.com/archives/${req.query.get('channel')}/p${req.query.get('message_ts')}`,
        },
      };
    case 'conversations.list': {
      const start = Number(req.query.get('cursor') ?? 0);
      const page = CHANNELS.slice(start, start + Math.min(2, Number(req.query.get('limit'))));
      const next = start + page.length < CHANNELS.length ? String(start + page.length) : '';
      return { body: { ok: true, channels: page, response_metadata: { next_cursor: next } } };
    }
    case 'users.lookupByEmail':
      if (req.query.get('email') !== 'ann@example.com') return { body: { ok: false, error: 'users_not_found' } };
      return {
        body: {
          ok: true,
          user: {
            id: 'U9',
            name: 'ann',
            real_name: 'Ann Lee',
            tz: 'Europe/Berlin',
            is_bot: false,
            is_admin: true,
            deleted: false,
            profile: { email: 'ann@example.com', display_name: 'ann', title: 'CTO', image_72: 'x' },
          },
        },
      };
    case 'reactions.add':
      return { body: { ok: true } };
    case 'rate.limited':
      return { status: 429, headers: { 'retry-after': '30' }, body: { ok: false, error: 'ratelimited' } };
    default:
      return { body: { ok: false, error: 'unknown_method' } };
  }
}

let api: FakeApi;
const credentials = () => ({ slackApi: { accessToken: TOKEN, baseUrl: api.url } });
const call = (parameters: JsonObject) => run(Slack, parameters, { credentials: credentials() });

beforeAll(async () => {
  api = await startFakeApi(slack);
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
});

describe('slackApi credential', () => {
  it('runs auth.test and reports team and user', async () => {
    expect(await testCredentials('slackApi', { accessToken: TOKEN, baseUrl: api.url })).toEqual({
      ok: true,
      message: 'Authenticated as landflow-bot in team Acme',
    });
    expect(api.requests[0]).toMatchObject({ method: 'POST', path: '/auth.test' });
  });

  it("returns Slack's error code on failure", async () => {
    const result = await testCredentials('slackApi', { accessToken: 'xoxb-wrong-000', baseUrl: api.url });
    expect(result).toEqual({ ok: false, message: 'Slack API error: invalid_auth' });
  });
});

describe('Slack message', () => {
  it('sends with chat.postMessage: JSON body, bearer token, blocks and thread options', async () => {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*hi*' } }];
    const response = await call({
      resource: 'message',
      operation: 'post',
      channelId: 'C001',
      text: 'hi',
      blocksUi: JSON.stringify({ blocks }),
      otherOptions: { thread_ts: '1699.0001', reply_broadcast: true, unfurl_links: false },
    });
    expect(response.error).toBeUndefined();
    const request = api.requests[0];
    expect(request).toMatchObject({ method: 'POST', path: '/chat.postMessage' });
    expect(request.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(request.body).toEqual({ channel: 'C001', text: 'hi', blocks, thread_ts: '1699.0001', reply_broadcast: true, unfurl_links: false });
    // ok and response_metadata are dropped
    expect(jsonOf(response)).toEqual([{ channel: 'C001', ts: '1700000000.000100', message: { text: 'hi', ts: '1700000000.000100' } }]);
  });

  it('accepts blocks as a plain array and requires text or blocks', async () => {
    await call({ resource: 'message', operation: 'post', channelId: 'C001', blocksUi: '[{"type":"divider"}]' });
    expect(api.requests[0].body).toEqual({ channel: 'C001', text: '', blocks: [{ type: 'divider' }] });
    expect((await call({ resource: 'message', operation: 'post', channelId: 'C001' })).error?.message).toBe('Set Text or Blocks');
    expect((await call({ resource: 'message', operation: 'post', channelId: 'C001', blocksUi: '{oops' })).error?.message).toMatch(/^Blocks is not valid JSON/);
  });

  it('updates, deletes and gets a permalink', async () => {
    const updated = await call({ resource: 'message', operation: 'update', channelId: 'C001', ts: '1.2', text: 'new' });
    expect(api.requests[0]).toMatchObject({ path: '/chat.update', body: { channel: 'C001', ts: '1.2', text: 'new' } });
    expect(jsonOf(updated)[0]).toMatchObject({ channel: 'C001', ts: '1.2', text: 'new' });

    const deleted = await call({ resource: 'message', operation: 'delete', channelId: 'C001', ts: '1.2' });
    expect(api.requests[1]).toMatchObject({ path: '/chat.delete', body: { channel: 'C001', ts: '1.2' } });
    expect(jsonOf(deleted)).toEqual([{ success: true, channel: 'C001', ts: '1.2' }]);

    const link = await call({ resource: 'message', operation: 'getPermalink', channelId: 'C001', ts: '1.2' });
    expect(api.requests[2]).toMatchObject({ method: 'GET', path: '/chat.getPermalink' });
    expect(api.requests[2].query.get('message_ts')).toBe('1.2');
    expect(jsonOf(link)).toEqual([{ channel: 'C001', permalink: 'https://acme.slack.com/archives/C001/p1.2' }]);
  });

  it('maps ok:false to node errors with hints', async () => {
    const notFound = await call({ resource: 'message', operation: 'post', channelId: 'C404', text: 'x' });
    expect(notFound.error).toMatchObject({ message: 'Slack API error: channel_not_found', itemIndex: 0 });
    expect(notFound.error?.description).toMatch(/invite the bot/);
    const scope = await call({ resource: 'message', operation: 'post', channelId: 'CSCOPE', text: 'x' });
    expect(scope.error?.description).toBe(
      'The token lacks the scope "chat:write" (it has: channels:read). Add it under "OAuth & Permissions" and reinstall the app.',
    );
  });
});

describe('Slack channel: Get Many', () => {
  it('follows cursors to return all channels, simplified', async () => {
    const response = await call({ resource: 'channel', operation: 'getAll', returnAll: true });
    expect(api.requests.map((r) => r.query.get('cursor'))).toEqual([null, '2', '4']);
    expect(api.requests[0].query.get('types')).toBe('public_channel');
    expect(api.requests[0].query.get('exclude_archived')).toBe('true');
    expect(jsonOf(response)).toHaveLength(5);
    expect(jsonOf(response)[3]).toEqual({
      id: 'C003',
      name: 'ops',
      is_private: true,
      is_archived: false,
      is_member: true,
      num_members: 13,
      topic: 'topic 3',
      purpose: 'purpose 3',
      created: 1700000003,
    });
    expect(response.outputs[0].every((item) => item.pairedItem?.item === 0)).toBe(true);
  });

  it('stops at the limit and returns raw objects when Simplify is off', async () => {
    const response = await call({
      resource: 'channel',
      operation: 'getAll',
      returnAll: false,
      limit: 3,
      simplify: false,
      filters: { types: ['public_channel', 'private_channel'], excludeArchived: false },
    });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0].query.get('types')).toBe('public_channel,private_channel');
    expect(api.requests[0].query.get('exclude_archived')).toBe('false');
    expect(api.requests[1].query.get('limit')).toBe('1');
    expect(jsonOf(response).map((c) => c.id)).toEqual(['C000', 'C001', 'C002']);
    expect(jsonOf(response)[0].topic).toEqual({ value: 'topic 0', creator: 'U1' });
  });
});

describe('Slack user and reaction', () => {
  it('looks up a user by email', async () => {
    const response = await call({ resource: 'user', operation: 'getByEmail', email: 'ann@example.com' });
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: '/users.lookupByEmail' });
    expect(jsonOf(response)).toEqual([
      {
        id: 'U9',
        name: 'ann',
        real_name: 'Ann Lee',
        display_name: 'ann',
        email: 'ann@example.com',
        title: 'CTO',
        tz: 'Europe/Berlin',
        is_bot: false,
        is_admin: true,
        deleted: false,
      },
    ]);
    const missing = await call({ resource: 'user', operation: 'getByEmail', email: 'nobody@example.com' });
    expect(missing.error?.message).toBe('Slack API error: users_not_found');
  });

  it('adds a reaction, stripping colons from the emoji', async () => {
    const response = await call({ resource: 'reaction', operation: 'add', channelId: 'C001', timestamp: '1.2', name: ':thumbsup:' });
    expect(api.requests[0]).toMatchObject({ method: 'POST', path: '/reactions.add', body: { channel: 'C001', timestamp: '1.2', name: 'thumbsup' } });
    expect(jsonOf(response)).toEqual([{ success: true, channel: 'C001', timestamp: '1.2', name: 'thumbsup' }]);
  });
});

describe('Slack channel picker', () => {
  it('lists public and private channels through every page, sorted by name', async () => {
    const options = await loadOptions(Slack, 'getChannels', {}, credentials());
    expect(api.requests[0].query.get('types')).toBe('public_channel,private_channel');
    expect(options.map((o) => o.name)).toEqual(['#design', '#dev', '#general', '#ops', '#random']);
    expect(options.find((o) => o.name === '#ops')).toEqual({ name: '#ops', value: 'C003', description: 'private' });
  });

  it('surfaces Slack errors to the editor', async () => {
    await expect(loadOptions(Slack, 'getChannels', {}, { slackApi: { accessToken: 'xoxb-bad-1111', baseUrl: api.url } })).rejects.toThrow(
      'Slack API error: invalid_auth',
    );
  });
});
