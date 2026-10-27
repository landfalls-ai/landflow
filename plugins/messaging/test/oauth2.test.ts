/** The OAuth2 variants of the Slack and Discord credentials: nodes accept either type, read the fresh `accessToken` the host sends, and report refusals in words the host renews on. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { Discord } from '../src/nodes/discord';
import { Slack } from '../src/nodes/slack';
import { plugin } from '../src/main';
import { jsonOf, loadOptions, run, startFakeApi, testCredentials, type FakeApi, type FakeRequest } from './helpers';

/** What the host's `looksUnauthorized` (apps/web credentials/oauth2.ts) treats as a refused token. */
const looksUnauthorized = (message: string) => /\b401\b|\bunauthori[sz]ed\b|invalid[_ ]token|(?:access )?token (?:has )?expired|expired[_ ]token/i.test(message);

const BOT = 'xoxb-bot-token-123';
let slackToken = 'xoxb-oauth-token-1';
let discordToken = 'discord-access-token-1';
const DISCORD_BOT = 'discord-bot-token-9';

function fake(req: FakeRequest) {
  if (req.path.startsWith('/slack/')) {
    const auth = req.headers.authorization;
    if (auth === 'Bearer xoxb-expired') return { body: { ok: false, error: 'token_expired' } };
    if (auth !== `Bearer ${BOT}` && auth !== `Bearer ${slackToken}`) return { body: { ok: false, error: 'invalid_auth' } };
    switch (req.path.slice('/slack/'.length)) {
      case 'auth.test':
        return { body: { ok: true, team: 'Acme', user: 'landflow-bot' } };
      case 'chat.postMessage':
        return { body: { ok: true, channel: req.body.channel, ts: '1.1', message: { text: req.body.text } } };
      case 'conversations.list':
        return { body: { ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: '' } } };
    }
    return { body: { ok: false, error: 'unknown_method' } };
  }
  const auth = req.headers.authorization;
  const path = req.path.replace(/^\/api\/v10/, '');
  if (auth !== `Bearer ${discordToken}` && auth !== `Bot ${DISCORD_BOT}`) return { status: 401, body: { message: '401: Unauthorized', code: 0 } };
  if (path === '/users/@me') return { body: { id: 'U1', username: auth.startsWith('Bot') ? 'landflow-bot' : 'ann' } };
  if (path === '/users/@me/guilds') return { body: [{ id: 'G1', name: 'Alpha' }] };
  if (path === '/channels/CH1/messages' && req.method === 'POST') {
    // Only a bot can post: a user's Bearer token is refused like Discord does.
    if (!auth.startsWith('Bot ')) return { status: 403, body: { message: 'Missing Access', code: 50001 } };
    return { body: { id: '5001', channel_id: 'CH1', ...req.body } };
  }
  return { status: 404, body: { message: 'Unknown route', code: 0 } };
}

let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi(fake);
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
  slackToken = 'xoxb-oauth-token-1';
  discordToken = 'discord-access-token-1';
});

const slackBase = () => `${api.url}/slack`;
const slackToken_ = () => ({ slackApi: { accessToken: BOT, baseUrl: slackBase() } });
const slackOAuth = (accessToken = slackToken) => ({ slackOAuth2Api: { accessToken, baseUrl: slackBase(), expiresAt: '2030-01-01T00:00:00.000Z' } });
const discordBase = () => `${api.url}/api/v10`;
const discordOAuth = (extra: JsonObject = {}) => ({ discordOAuth2Api: { accessToken: discordToken, baseUrl: discordBase(), ...extra } });

describe('manifest', () => {
  const byName = (name: string) => plugin.credentialTypes!.find((t) => t.name === name)!;

  it('declares OAuth2 types that extend oAuth2Api with the provider URLs fixed', () => {
    const slack = byName('slackOAuth2Api');
    expect(slack.extends).toEqual(['oAuth2Api']);
    const hidden = (type: typeof slack) => Object.fromEntries(type.properties.filter((p) => p.type === 'hidden').map((p) => [p.name, p.default]));
    expect(hidden(slack)).toEqual({
      grantType: 'authorizationCode',
      authUrl: 'https://slack.com/oauth/v2/authorize',
      accessTokenUrl: 'https://slack.com/api/oauth.v2.access',
      authentication: 'body',
    });
    expect(slack.properties.find((p) => p.name === 'scope')?.default).toContain('chat:write');
    const discord = byName('discordOAuth2Api');
    expect(discord.extends).toEqual(['oAuth2Api']);
    expect(hidden(discord)).toMatchObject({ authUrl: 'https://discord.com/oauth2/authorize', accessTokenUrl: 'https://discord.com/api/oauth2/token', userInfoUrl: 'https://discord.com/api/users/@me' });
    expect(discord.properties.find((p) => p.name === 'scope')?.default).toBe('identify guilds');
    // The token types keep working and do not extend anything.
    expect(byName('slackApi').extends).toBeUndefined();
    expect(byName('discordBotApi').extends).toBeUndefined();
  });

  it('lists both credential types on the nodes, picked by Authentication', () => {
    expect(Slack.description.credentials).toEqual([
      { name: 'slackApi', required: true, displayOptions: { show: { authentication: ['accessToken'] } } },
      { name: 'slackOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ]);
    expect(Slack.description.properties.find((p) => p.name === 'authentication')?.default).toBe('accessToken');
  });
});

describe('Slack', () => {
  const post = (credentials: Record<string, JsonObject>, parameters: JsonObject = {}) =>
    run(Slack, { resource: 'message', operation: 'post', channelId: 'C1', text: 'hi', ...parameters }, { credentials });

  it('tests the OAuth2 credential with auth.test', async () => {
    expect(await testCredentials('slackOAuth2Api', { accessToken: slackToken, baseUrl: slackBase() })).toEqual({ ok: true, message: 'Authenticated as landflow-bot in team Acme' });
  });

  it('accepts the token credential and the OAuth2 one, with or without the Authentication parameter', async () => {
    for (const [credentials, parameters] of [
      [slackToken_(), {}],
      [slackToken_(), { authentication: 'accessToken' }],
      [slackOAuth(), { authentication: 'oAuth2' }],
      // Only the other type was sent (a load-options call or a stale parameter): that one is used.
      [slackOAuth(), {}],
      [slackOAuth(), { authentication: 'accessToken' }],
      [slackToken_(), { authentication: 'oAuth2' }],
    ] as Array<[Record<string, JsonObject>, JsonObject]>) {
      const response = await post(credentials, parameters);
      expect(response.error, JSON.stringify([credentials, parameters])).toBeUndefined();
      expect(jsonOf(response)[0]).toMatchObject({ channel: 'C1', ts: '1.1' });
    }
  });

  it('prefers the credential the Authentication parameter names when both arrive', async () => {
    api.requests.length = 0;
    await post({ ...slackToken_(), ...slackOAuth('xoxb-oauth-token-1') }, { authentication: 'oAuth2' });
    expect(api.requests[0].headers.authorization).toBe('Bearer xoxb-oauth-token-1');
    await post({ ...slackToken_(), ...slackOAuth() }, { authentication: 'accessToken' });
    expect(api.requests[1].headers.authorization).toBe(`Bearer ${BOT}`);
  });

  it('reads the token from every call: a renewed accessToken is used at once', async () => {
    expect((await post(slackOAuth())).error).toBeUndefined();
    slackToken = 'xoxb-oauth-token-2';
    const stale = await post(slackOAuth('xoxb-oauth-token-1'));
    expect(stale.error?.message).toContain('invalid_auth');
    expect((await post(slackOAuth('xoxb-oauth-token-2'))).error).toBeUndefined();
    expect(api.requests.map((r) => r.headers.authorization)).toEqual(['Bearer xoxb-oauth-token-1', 'Bearer xoxb-oauth-token-1', 'Bearer xoxb-oauth-token-2']);
  });

  it('words a refused or expired token so the host renews it and runs the node again', async () => {
    const refused = await post(slackOAuth('xoxb-wrong'));
    expect(looksUnauthorized(`${refused.error?.message} ${refused.error?.description}`)).toBe(true);
    const expired = await post(slackOAuth('xoxb-expired'));
    expect(looksUnauthorized(`${expired.error?.message} ${expired.error?.description}`)).toBe(true);
  });

  it('loads channels with the OAuth2 credential alone', async () => {
    expect(await loadOptions(Slack, 'getChannels', {}, slackOAuth())).toEqual([{ name: '#general', value: 'C1' }]);
  });
});

describe('Discord', () => {
  const guilds = (credentials: Record<string, JsonObject>, authentication?: string) =>
    run(Discord, { ...(authentication && { authentication }), resource: 'guild', operation: 'getAll' }, { credentials });
  const send = (credentials: Record<string, JsonObject>, authentication?: string) =>
    run(Discord, { ...(authentication && { authentication }), resource: 'message', operation: 'send', guildId: 'G1', channelId: 'CH1', content: 'hi' }, { credentials });

  it('tests the OAuth2 credential with GET /users/@me', async () => {
    expect(await testCredentials('discordOAuth2Api', { accessToken: discordToken, baseUrl: discordBase() })).toEqual({ ok: true, message: 'Authenticated as ann' });
  });

  it('the load-options calls accept either credential type', async () => {
    expect(await loadOptions(Discord, 'getGuilds', {}, discordOAuth())).toEqual([{ name: 'Alpha', value: 'G1' }]);
    expect(await loadOptions(Discord, 'getGuilds', {}, { discordBotApi: { botToken: DISCORD_BOT, baseUrl: discordBase() } })).toEqual([{ name: 'Alpha', value: 'G1' }]);
  });

  it('calls with the access token as a Bearer, or the bot token when one is entered', async () => {
    await send({ discordBotApi: { botToken: DISCORD_BOT, baseUrl: discordBase() } }, 'botToken');
    expect(api.requests[0].headers.authorization).toBe(`Bot ${DISCORD_BOT}`);
    const asUser = await send(discordOAuth(), 'oAuth2');
    expect(api.requests[1].headers.authorization).toBe(`Bearer ${discordToken}`);
    expect(asUser.error?.message).toContain('403');
    const asBot = await send(discordOAuth({ botToken: DISCORD_BOT }), 'oAuth2');
    expect(api.requests[2].headers.authorization).toBe(`Bot ${DISCORD_BOT}`);
    expect(asBot.error).toBeUndefined();
    expect(jsonOf(asBot)[0]).toMatchObject({ id: '5001', content: 'hi' });
  });

  it('uses the OAuth2 credential when the parameter is missing, and reads a renewed token at once', async () => {
    expect((await send(discordOAuth({ botToken: DISCORD_BOT }))).error).toBeUndefined();
    discordToken = 'discord-access-token-2';
    const stale = await run(Discord, { authentication: 'oAuth2', resource: 'message', operation: 'getAll', guildId: 'G1', channelId: 'CH1', limit: 1 }, { credentials: { discordOAuth2Api: { accessToken: 'discord-access-token-1', baseUrl: discordBase() } } });
    expect(stale.error?.message).toContain('401');
    expect(looksUnauthorized(stale.error?.message ?? '')).toBe(true);
  });
});
