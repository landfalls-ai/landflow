/** Discord node (bot token and webhook) and both credential types against a fake API. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { Discord } from '../src/nodes/discord';
import { jsonOf, loadOptions, run, startFakeApi, testCredentials, type FakeApi, type FakeRequest } from './helpers';

const BOT_TOKEN = 'test-bot-token-123';
const HOOK_TOKEN = 'test-hook-secret-456';

/** 250 messages, newest first, ids 1250 … 1001. */
const HISTORY = Array.from({ length: 250 }, (_, i) => ({
  id: String(1250 - i),
  channel_id: 'CH1',
  content: `message ${1250 - i}`,
  author: { id: 'U1', username: 'ann', global_name: 'Ann' },
  timestamp: '2026-10-25T10:00:00.000000+00:00',
  edited_timestamp: null,
  attachments: [],
  embeds: [],
}));

let rateLimitOnce = false;

function discord(req: FakeRequest) {
  if (req.path.startsWith('/api/webhooks/')) {
    if (req.path !== `/api/webhooks/111/${HOOK_TOKEN}`) return { status: 401, body: { message: 'Invalid Webhook Token', code: 50027 } };
    if (req.method === 'GET') return { body: { id: '111', name: 'Deploy bot', channel_id: 'CH1', guild_id: 'G1' } };
    return {
      body: { id: '9001', channel_id: 'CH1', content: req.body.content, author: { username: req.body.username ?? 'Deploy bot' }, wait: req.query.get('wait') },
    };
  }
  if (req.headers.authorization !== `Bot ${BOT_TOKEN}`) return { status: 401, body: { message: '401: Unauthorized', code: 0 } };
  if (rateLimitOnce) {
    rateLimitOnce = false;
    return { status: 429, headers: { 'retry-after': '1' }, body: { message: 'You are being rate limited.', retry_after: 0.05, global: false } };
  }
  const path = req.path.replace(/^\/api\/v10/, '');
  if (path === '/users/@me') return { body: { id: 'B1', username: 'landflow-bot', bot: true } };
  if (path === '/users/@me/guilds')
    return {
      body: [
        { id: 'G2', name: 'Zeta' },
        { id: 'G1', name: 'Alpha' },
      ],
    };
  if (path === '/guilds/G1/channels') {
    return {
      body: [
        { id: 'CAT', type: 4, name: 'Text Channels', position: 0 },
        { id: 'CH2', type: 0, name: 'random', position: 2 },
        { id: 'CH1', type: 0, name: 'general', position: 1 },
        { id: 'V1', type: 2, name: 'Lounge', position: 3 },
        { id: 'F1', type: 15, name: 'forum', position: 4 },
      ],
    };
  }
  if (path === '/channels/CH1/messages' && req.method === 'POST') return { body: { id: '5001', channel_id: 'CH1', ...req.body } };
  if (path === '/channels/CH1/messages' && req.method === 'GET') {
    const before = req.query.get('before');
    const limit = Number(req.query.get('limit') ?? 50);
    const start = before ? HISTORY.findIndex((m) => m.id === before) + 1 : 0;
    return { body: HISTORY.slice(start, start + limit) };
  }
  if (path === '/channels/CH9/messages') return { status: 403, body: { message: 'Missing Access', code: 50001 } };
  if (path === '/channels/CH1/messages/42' && req.method === 'DELETE') return { status: 204 };
  if (path.startsWith('/channels/CH1/messages/42/reactions/') && req.method === 'PUT') return { status: 204 };
  return { status: 404, body: { message: 'Unknown route', code: 0 } };
}

let api: FakeApi;
const bot = () => ({ discordBotApi: { botToken: BOT_TOKEN, baseUrl: `${api.url}/api/v10` } });
const webhook = (token = HOOK_TOKEN) => ({ discordWebhookApi: { webhookUrl: `${api.url}/api/webhooks/111/${token}` } });

beforeAll(async () => {
  api = await startFakeApi(discord);
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
  rateLimitOnce = false;
});

describe('Discord credentials', () => {
  it('bot token: GET /users/@me', async () => {
    expect(await testCredentials('discordBotApi', { botToken: BOT_TOKEN, baseUrl: `${api.url}/api/v10` })).toEqual({
      ok: true,
      message: 'Authenticated as landflow-bot',
    });
    expect(api.requests[0].path).toBe('/api/v10/users/@me');
    expect(await testCredentials('discordBotApi', { botToken: 'nope-nope', baseUrl: `${api.url}/api/v10` })).toEqual({
      ok: false,
      message: 'Discord API error 401: 401: Unauthorized',
    });
  });

  it('webhook: GET the webhook URL', async () => {
    expect(await testCredentials('discordWebhookApi', { webhookUrl: `${api.url}/api/webhooks/111/${HOOK_TOKEN}` })).toEqual({
      ok: true,
      message: 'Webhook "Deploy bot" posts to channel CH1',
    });
    const bad = await testCredentials('discordWebhookApi', { webhookUrl: `${api.url}/api/webhooks/111/wrong-token-x` });
    expect(bad).toEqual({ ok: false, message: 'Discord API error 401: Invalid Webhook Token (code 50027)' });
    expect(await testCredentials('discordWebhookApi', { webhookUrl: 'not a url' })).toEqual({
      ok: false,
      message: 'The Discord webhook URL is not a valid URL',
    });
  });
});

describe('Discord bot', () => {
  const call = (parameters: JsonObject) => run(Discord, { authentication: 'botToken', resource: 'message', ...parameters }, { credentials: bot() });

  it('sends a message with embeds, TTS and a reply reference', async () => {
    const response = await call({
      operation: 'send',
      guildId: 'G1',
      channelId: 'CH1',
      content: 'Deployed',
      embeds: '{"title":"v1.2","color":5793266}',
      options: { tts: true, replyTo: '41' },
    });
    expect(response.error).toBeUndefined();
    expect(api.requests[0]).toMatchObject({ method: 'POST', path: '/api/v10/channels/CH1/messages' });
    expect(api.requests[0].headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(api.requests[0].body).toEqual({
      content: 'Deployed',
      embeds: [{ title: 'v1.2', color: 5793266 }],
      tts: true,
      message_reference: { message_id: '41', fail_if_not_exists: false },
    });
    expect(jsonOf(response)[0]).toMatchObject({ id: '5001', content: 'Deployed' });
  });

  it('pages back through history for Return All, simplified', async () => {
    const response = await call({ operation: 'getAll', channelId: 'CH1', returnAll: true });
    expect(api.requests.map((r) => [r.query.get('limit'), r.query.get('before')])).toEqual([
      ['100', null],
      ['100', '1151'],
      ['100', '1051'],
    ]);
    const messages = jsonOf(response);
    expect(messages).toHaveLength(250);
    expect(messages[0]).toEqual({
      id: '1250',
      channel_id: 'CH1',
      content: 'message 1250',
      author_id: 'U1',
      author: 'Ann',
      timestamp: '2026-10-25T10:00:00.000000+00:00',
      edited_timestamp: null,
      attachments: 0,
      embeds: 0,
    });
  });

  it('honours the limit and Simplify off', async () => {
    const response = await call({ operation: 'getAll', channelId: 'CH1', returnAll: false, limit: 120, simplify: false });
    expect(api.requests.map((r) => r.query.get('limit'))).toEqual(['100', '20']);
    expect(jsonOf(response)).toHaveLength(120);
    expect(jsonOf(response)[0].author).toEqual({ id: 'U1', username: 'ann', global_name: 'Ann' });
  });

  it('deletes a message and reacts with a URL-encoded emoji', async () => {
    expect(jsonOf(await call({ operation: 'deleteMessage', channelId: 'CH1', messageId: '42' }))).toEqual([{ success: true }]);
    expect(api.requests[0]).toMatchObject({ method: 'DELETE', path: '/api/v10/channels/CH1/messages/42' });
    expect(jsonOf(await call({ operation: 'react', channelId: 'CH1', messageId: '42', emoji: '👍' }))).toEqual([{ success: true }]);
    expect(api.requests[1].method).toBe('PUT');
    expect(api.requests[1].path).toBe(`/api/v10/channels/CH1/messages/42/reactions/${encodeURIComponent('👍')}/@me`);
  });

  it('waits retry_after and retries once on 429', async () => {
    rateLimitOnce = true;
    const response = await call({ operation: 'send', channelId: 'CH1', content: 'after the limit' });
    expect(response.error).toBeUndefined();
    expect(api.requests).toHaveLength(2);
    expect(jsonOf(response)[0]).toMatchObject({ content: 'after the limit' });
  });

  it("maps Discord's error body to the node error", async () => {
    const response = await call({ operation: 'send', channelId: 'CH9', content: 'x' });
    expect(response.error).toMatchObject({ message: 'Discord API error 403: Missing Access (code 50001)', itemIndex: 0 });
    expect(response.error?.description).toMatch(/invite it to the server/);
    expect((await call({ operation: 'send', channelId: 'CH1' })).error?.message).toBe('Set Message or Embeds');
  });

  it('loads servers and the text channels of the chosen server', async () => {
    expect(await loadOptions(Discord, 'getGuilds', {}, bot())).toEqual([
      { name: 'Alpha', value: 'G1' },
      { name: 'Zeta', value: 'G2' },
    ]);
    expect(await loadOptions(Discord, 'getChannels', { guildId: 'G1' }, bot())).toEqual([
      { name: '#general', value: 'CH1' },
      { name: '#random', value: 'CH2' },
      { name: '#Lounge', value: 'V1' },
    ]);
    expect(await loadOptions(Discord, 'getChannels', {}, bot())).toEqual([]);
  });
});

describe('Discord webhook', () => {
  it('sends content, username, avatar and embeds with ?wait=true', async () => {
    const response = await run(
      Discord,
      {
        authentication: 'webhook',
        resource: 'message',
        operation: 'send',
        content: 'Build passed',
        embeds: '[{"description":"all green"}]',
        options: { username: 'CI', avatar_url: 'https://example.com/ci.png' },
      },
      { credentials: webhook() },
    );
    expect(response.error).toBeUndefined();
    expect(api.requests[0]).toMatchObject({ method: 'POST', path: `/api/webhooks/111/${HOOK_TOKEN}` });
    expect(api.requests[0].query.get('wait')).toBe('true');
    expect(api.requests[0].headers.authorization).toBeUndefined();
    expect(api.requests[0].body).toEqual({
      content: 'Build passed',
      embeds: [{ description: 'all green' }],
      username: 'CI',
      avatar_url: 'https://example.com/ci.png',
    });
    expect(jsonOf(response)[0]).toMatchObject({ id: '9001', content: 'Build passed' });
  });

  it('never leaks the webhook token into errors', async () => {
    const response = await run(
      Discord,
      { authentication: 'webhook', resource: 'message', operation: 'send', content: 'x' },
      { credentials: webhook('leaky-token-789') },
    );
    expect(response.error?.message).toBe('Discord API error 401: Invalid Webhook Token (code 50027)');
    expect(JSON.stringify(response)).not.toContain('leaky-token-789');
  });

  it('needs the webhook credential when the connection type is Webhook', async () => {
    const response = await run(Discord, { authentication: 'webhook', resource: 'message', operation: 'send', content: 'x' }, { credentials: bot() });
    expect(response.error?.message).toBe('No "discordWebhookApi" credentials were provided');
  });
});
