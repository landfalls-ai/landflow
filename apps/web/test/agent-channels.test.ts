/**
 * Wave 6 agent channels, against fakes: Slack with an OAuth2 (installed app) credential, Slack slash commands (signed requests,
 * an immediate ack, the answer on the response_url, one session per user and channel), Microsoft Teams as a Bot Framework bot
 * (JWT validation with a fake OpenID metadata + JWKS, replies through the activity's serviceUrl, Adaptive Card approvals),
 * and approvals by email (signed, single-use links) for agents and for the AI Agent node, with a captured mail transport.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { JsonObject } from '@landflow/protocol';
import type { AgentChannel } from '@/lib/shared/agents';
import { startFakeModels, startFakeSlack } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-channels-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'https://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { defineCredentialType, definePlugin } = await import('@landflow/sdk');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { APPROVE_ACTION, settleSlackTasks, slackSignature } = await import('@/lib/server/slack');
const { resetTeamsCaches } = await import('@/lib/server/teams');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { approvalLinks, verifyLink, parseAddresses } = await import('@/lib/server/approval-email');
const eventsRoute = await import('@/app/api/slack/events/[agentId]/[channelId]/route');
const commandsRoute = await import('@/app/api/slack/commands/[agentId]/[channelId]/route');
const interactionsRoute = await import('@/app/api/slack/interactions/route');
const teamsRoute = await import('@/app/api/teams/messages/[agentId]/[channelId]/route');
const emailRoute = await import('@/app/api/approvals/email/[token]/route');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const { database } = await import('@/lib/server/db');

const messaging = definePlugin({
  info: { id: 'messaging', name: 'Messaging', version: '1.0.0', language: 'typescript' },
  credentialTypes: [
    defineCredentialType({
      name: 'slackApi',
      displayName: 'Slack API',
      properties: [
        { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } },
        { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://slack.com/api' },
        { name: 'signingSecret', displayName: 'Signing Secret', type: 'string', default: '', typeOptions: { password: true } },
      ],
    }),
    defineCredentialType({
      name: 'slackOAuth2Api',
      displayName: 'Slack OAuth2 API',
      extends: ['oAuth2Api'],
      properties: [
        { name: 'authUrl', displayName: 'Authorization URL', type: 'hidden', default: 'https://slack.com/oauth/v2/authorize' },
        { name: 'accessTokenUrl', displayName: 'Access Token URL', type: 'hidden', default: 'https://slack.com/api/oauth.v2.access' },
        { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://slack.com/api' },
        { name: 'signingSecret', displayName: 'Signing Secret', type: 'string', default: '', typeOptions: { password: true } },
      ],
    }),
  ],
  nodes: [],
});
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(messaging);

const SECRET = 'slack-signing-secret';
const TOKEN = 'xoxb-test-token';
const slack = await startFakeSlack({ token: TOKEN });
const models = await startFakeModels();
const slackApp = credentials.create({ name: 'Slack app', type: 'messaging.slackApi', data: { accessToken: TOKEN, baseUrl: slack.url, signingSecret: SECRET } });
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: models.url } });
const slackRef = { id: slackApp.id, name: slackApp.name };
const openAiRef = { id: openAi.id, name: openAi.name };

// ---------------------------------------------------------------------------
// A fake Slack response_url, Microsoft identity platform, Bot Connector and mailbox
// ---------------------------------------------------------------------------

interface Hit {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: JsonObject;
  raw: string;
}

async function listen(handle: (hit: Hit, respond: (status: number, body: unknown) => void) => void): Promise<{ url: string; hits: Hit[]; server: Server; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: JsonObject = {};
    try {
      body = raw ? (raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {};
    } catch {
      // not JSON
    }
    const hit = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body, raw };
    hits.push(hit);
    handle(hit, (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const responses = await listen((_hit, respond) => respond(200, { ok: true }));

const BOT_ID = 'bot-app-id';
const BOT_SECRET = 'bot-client-secret';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: strangerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };
let activityNumber = 0;
const connector = await listen((hit, respond) => {
  if (hit.method === 'POST' || hit.method === 'PUT') respond(200, { id: hit.method === 'PUT' ? 'updated' : `act-${++activityNumber}` });
  else respond(404, {});
});
const identity = await listen((hit, respond) => {
  if (hit.path.startsWith('/metadata')) return respond(200, { issuer: 'https://api.botframework.com', jwks_uri: `${identity.url}/keys`, id_token_signing_alg_values_supported: ['RS256'] });
  if (hit.path.startsWith('/keys')) return respond(200, { keys: [jwk] });
  if (hit.path.startsWith('/token')) {
    const params = hit.body as Record<string, string>;
    if (params.client_id !== BOT_ID || params.client_secret !== BOT_SECRET || params.scope !== 'https://api.botframework.com/.default') return respond(401, { error: 'invalid_client' });
    return respond(200, { access_token: 'bot-access-token', token_type: 'Bearer', expires_in: 3600 });
  }
  respond(404, {});
});

const botApp = credentials.create({
  name: 'Teams bot',
  type: 'core.microsoftBotApi',
  data: { appId: BOT_ID, appPassword: BOT_SECRET, openIdMetadataUrl: `${identity.url}/metadata`, tokenUrl: `${identity.url}/token` },
});
const botRef = { id: botApp.id, name: botApp.name };

const mailbox: Array<{ to: string; subject: string; text: string; html?: string }> = [];
setMailTransport({
  async send(message) {
    mailbox.push({ to: message.to, subject: message.subject, text: message.text, html: message.html });
  },
});

afterAll(async () => {
  await settleSlackTasks();
  setMailTransport(undefined);
  await Promise.all([slack.close(), models.close(), responses.close(), connector.close(), identity.close()]);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  slack.calls.length = 0;
  responses.hits.length = 0;
  connector.hits.length = 0;
  mailbox.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const signed = (body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> => ({
  'x-slack-request-timestamp': String(timestamp),
  'x-slack-signature': slackSignature(secret, timestamp, body),
});

const echoTool = { id: 't1', type: 'node', name: 'Echo', description: 'Echo the input', nodeType: 'core.noOp', parameters: {}, requireApproval: true };

function agentWith(channel: Partial<AgentChannel>, extra: Record<string, unknown> = {}) {
  const created = agentStore.create({
    name: 'Channel helper',
    instructions: 'Be brief.',
    model: { provider: 'openai', model: 'gpt-test', credential: openAiRef },
    channels: [{ id: 'ch1', type: 'slack', credential: slackRef, access: 'public', allowedUsers: [], newSessionAfterMinutes: 0, enabled: true, ...channel }],
    ...extra,
  });
  return agentStore.publish(created.id)!;
}

async function waitFor(condition: () => boolean, what: string, ms = 8_000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Slack with an installed (OAuth2) app
// ---------------------------------------------------------------------------

describe('Slack agent channel with an OAuth2 credential', () => {
  const oauth = credentials.create({
    name: 'Slack install',
    type: 'messaging.slackOAuth2Api',
    data: { clientId: 'cid', clientSecret: 'csecret', baseUrl: slack.url, signingSecret: SECRET },
  });
  credentials.saveOAuth2Token(oauth.id, { access_token: TOKEN, token_type: 'bot', obtained_at: new Date().toISOString(), team: { id: 'T1', name: 'Acme' } });
  const oauthRef = { id: oauth.id, name: oauth.name };

  it('verifies events with the credential’s signing secret and replies with the installed bot token', async () => {
    const agent = agentWith({ credential: oauthRef });
    const body = JSON.stringify({ type: 'event_callback', event_id: 'EvOauth1', event: { type: 'app_mention', channel: 'C9', user: 'U1', text: '<@U0BOT> hello', ts: '1700000009.000100' } });
    const response = await eventsRoute.POST(new Request('http://x/y', { method: 'POST', headers: signed(body), body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    expect(response.status).toBe(200);
    await settleSlackTasks();
    const [reply] = slack.of('chat.postMessage');
    expect(reply.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(reply.body).toMatchObject({ channel: 'C9', text: 'Echo: hello' });
    const wrong = await eventsRoute.POST(new Request('http://x/y', { method: 'POST', headers: signed(body, 'nope'), body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    expect(wrong.status).toBe(401);
  });

  it('checks interactivity clicks against OAuth2 credentials’ signing secrets too', async () => {
    const agent = agentWith({ credential: oauthRef }, { tools: [echoTool] });
    const body = JSON.stringify({ type: 'event_callback', event_id: 'EvOauth2', event: { type: 'app_mention', channel: 'C9', user: 'U1', text: '<@U0BOT> use the tool', ts: '1700000010.000100' } });
    await eventsRoute.POST(new Request('http://x/y', { method: 'POST', headers: signed(body), body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    await settleSlackTasks();
    const ask = slack.of('chat.postMessage')[0];
    const actions = (ask.body.blocks as JsonObject[]).find((b) => b.type === 'actions') as { elements: Array<{ action_id: string; value: string }> };
    const value = actions.elements.find((e) => e.action_id === APPROVE_ACTION)!.value;
    const form = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', user: { id: 'U1' }, container: { channel_id: 'C9', message_ts: ask.ts }, actions: [{ action_id: APPROVE_ACTION, value }] }) }).toString();
    const click = await interactionsRoute.POST(new Request('http://x/i', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(form) }, body: form }));
    expect(click.status).toBe(200);
    await settleSlackTasks();
    expect(slack.of('chat.update')).toHaveLength(1);
    expect(agentStore.getSession(agentStore.listSessions(agent.id)[0].id)!.status).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Slack slash commands
// ---------------------------------------------------------------------------

describe('Slack slash commands', () => {
  const command = (fields: Record<string, string>) =>
    new URLSearchParams({ command: '/ask', text: 'what is up?', user_id: 'U1', channel_id: 'C1', team_id: 'T1', response_url: `${responses.url}/respond/1`, trigger_id: `trig-${Math.random()}`, ...fields }).toString();
  const send = async (agentId: string, body: string, secret = SECRET, channelId = 'ch1') =>
    commandsRoute.POST(new Request(`http://x/api/slack/commands/${agentId}/${channelId}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(body, secret) }, body }), {
      params: Promise.resolve({ agentId, channelId }),
    });

  it('keeps the route public, and refuses unsigned, mis-signed and stale requests', async () => {
    expect(isPublicPath('/api/slack/commands/a/b')).toBe(true);
    const agent = agentWith({});
    const body = command({});
    expect((await send(agent.id, body, 'wrong')).status).toBe(401);
    const stale = await commandsRoute.POST(new Request('http://x/c', { method: 'POST', headers: signed(body, SECRET, Math.floor(Date.now() / 1000) - 600), body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    expect(stale.status).toBe(401);
    expect((await commandsRoute.POST(new Request('http://x/c', { method: 'POST', body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) })).status).toBe(401);
    expect((await send(agent.id, body, SECRET, 'nope')).status).toBe(404);
    expect(responses.hits).toHaveLength(0);
  });

  it('acknowledges at once and posts the agent’s answer to the response_url', async () => {
    const agent = agentWith({});
    const started = Date.now();
    const response = await send(agent.id, command({ text: 'what is up?' }));
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3_000);
    await settleSlackTasks();
    expect(responses.hits).toHaveLength(1);
    expect(responses.hits[0].body).toMatchObject({ response_type: 'in_channel', text: expect.stringContaining('Echo: what is up?') });
    expect(responses.hits[0].body.text).toContain('<@U1> ran `/ask what is up?`');
    // The bot token is not needed for a command's answer.
    expect(slack.calls).toHaveLength(0);
  });

  it('is one session per user and channel, and `new` starts over', async () => {
    const agent = agentWith({});
    await send(agent.id, command({ text: 'first' }));
    await settleSlackTasks();
    await send(agent.id, command({ text: 'second' }));
    await settleSlackTasks();
    await send(agent.id, command({ text: 'other user', user_id: 'U2' }));
    await send(agent.id, command({ text: 'other channel', channel_id: 'C2' }));
    await settleSlackTasks();
    const sessions = agentStore.listSessions(agent.id);
    expect(sessions).toHaveLength(3);
    const mine = agentStore.getSession(agentStore.findConversation(agent.id, 'slackcmd:ch1:C1:U1')!.id)!;
    expect(mine).toMatchObject({ source: 'slack', userId: 'slack:U1' });
    expect(sessions.find((s) => s.id === mine.id)!.turns).toBe(2);

    await send(agent.id, command({ text: 'new' }));
    await settleSlackTasks();
    expect(responses.hits.at(-1)!.body).toMatchObject({ response_type: 'ephemeral', text: 'Started a new conversation.' });
    await send(agent.id, command({ text: 'after reset' }));
    await settleSlackTasks();
    const fresh = agentStore.getSession(agentStore.findConversation(agent.id, 'slackcmd:ch1:C1:U1')!.id)!;
    expect(fresh.id).not.toBe(mine.id);
  });

  it('answers privately to people the channel does not allow, to an empty command and when commands are off', async () => {
    const agent = agentWith({ access: 'private', allowedUsers: ['U_OK'] });
    const stranger = await send(agent.id, command({ user_id: 'U_NO' }));
    expect(await stranger.json()).toMatchObject({ response_type: 'ephemeral', text: expect.stringContaining('only talks to people') });
    const empty = await send(agent.id, command({ user_id: 'U_OK', text: '' }));
    expect(await empty.json()).toMatchObject({ response_type: 'ephemeral', text: expect.stringContaining('Ask me something') });
    const off = agentWith({ slashCommands: false });
    expect(await (await send(off.id, command({}))).json()).toMatchObject({ response_type: 'ephemeral', text: expect.stringContaining('turned off') });
    await settleSlackTasks();
    expect(responses.hits).toHaveLength(0);
  });

  it('ignores a repeated trigger id', async () => {
    const agent = agentWith({});
    const body = command({ trigger_id: 'same-trigger' });
    await send(agent.id, body);
    await send(agent.id, body);
    await settleSlackTasks();
    expect(responses.hits).toHaveLength(1);
  });

  it('asks for tool approvals on the response_url, and the click continues there', async () => {
    const agent = agentWith({}, { tools: [echoTool] });
    await send(agent.id, command({ text: 'use the tool' }));
    await settleSlackTasks();
    const ask = responses.hits[0];
    expect(ask.body.text).toBe('Channel helper: approve Echo?');
    const actions = (ask.body.blocks as JsonObject[]).find((b) => b.type === 'actions') as { elements: Array<{ action_id: string; value: string }> };
    const value = actions.elements.find((e) => e.action_id === APPROVE_ACTION)!.value;
    expect(JSON.parse(value)).toMatchObject({ t: 'agent', cmd: 'C1' });
    expect(agentStore.getSession(agentStore.listSessions(agent.id)[0].id)!.status).toBe('awaiting_approval');

    const clickUrl = `${responses.url}/respond/click`;
    const form = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', user: { id: 'U1' }, channel: { id: 'C1' }, response_url: clickUrl, actions: [{ action_id: APPROVE_ACTION, value }] }) }).toString();
    const click = await interactionsRoute.POST(new Request('http://x/i', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(form) }, body: form }));
    expect(click.status).toBe(200);
    await settleSlackTasks();
    const replies = responses.hits.filter((h) => h.path === '/respond/click');
    expect(replies[0].body).toMatchObject({ replace_original: true, text: 'Echo: approved' });
    expect(replies[1].body).toMatchObject({ response_type: 'in_channel', text: expect.stringContaining('The answer is') });
    expect(slack.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Microsoft Teams
// ---------------------------------------------------------------------------

describe('Microsoft Teams channel', () => {
  const SERVICE = () => connector.url;
  beforeEach(() => resetTeamsCaches());

  function jwt(claims: Record<string, unknown> = {}, key = privateKey, header: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const head = part({ alg: 'RS256', typ: 'JWT', kid: 'key-1', ...header });
    const payload = part({ iss: 'https://api.botframework.com', aud: BOT_ID, serviceurl: SERVICE(), nbf: now - 10, exp: now + 3_600, ...claims });
    const signature = createSign('RSA-SHA256').update(`${head}.${payload}`).sign(key).toString('base64url');
    return `${head}.${payload}.${signature}`;
  }

  let counter = 0;
  const activity = (fields: Record<string, unknown> = {}) => ({
    type: 'message',
    id: `a-${++counter}`,
    serviceUrl: SERVICE(),
    channelId: 'msteams',
    from: { id: '29:user', name: 'Ana', aadObjectId: 'oid-ana' },
    recipient: { id: '28:bot', name: 'Helper' },
    conversation: { id: 'conv-1', conversationType: 'personal' },
    text: '<at>Helper</at> what is up?',
    ...fields,
  });

  async function post(agentId: string, body: unknown, token: string | null = jwt(), channelId = 'tm1') {
    const response = await teamsRoute.POST(
      new Request(`http://x/api/teams/messages/${agentId}/${channelId}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ agentId, channelId }) },
    );
    await settleSlackTasks();
    return response;
  }

  const teamsAgent = (channel: Partial<AgentChannel> = {}, extra: Record<string, unknown> = {}) =>
    agentWith({ id: 'tm1', type: 'teams', credential: botRef, ...channel }, extra);
  const sent = () => connector.hits.filter((h) => h.method === 'POST' || h.method === 'PUT');

  it('keeps the endpoint public and the credential testable', async () => {
    expect(isPublicPath('/api/teams/messages/a/b')).toBe(true);
    const type = registry.credentialType('core.microsoftBotApi')!;
    expect(type.descriptor.properties.map((p) => p.name)).toEqual(expect.arrayContaining(['appId', 'appPassword', 'tenantId', 'openIdMetadataUrl']));
    expect(identity.hits.filter((h) => h.path.startsWith('/token')).length).toBe(0);
  });

  it('validates the bearer JWT against the OpenID metadata and JWKS', async () => {
    const agent = teamsAgent();
    const good = await post(agent.id, activity());
    expect(good.status).toBe(200);
    expect(sent()).toHaveLength(1);
    expect(identity.hits.some((h) => h.path.startsWith('/metadata'))).toBe(true);
    expect(identity.hits.some((h) => h.path.startsWith('/keys'))).toBe(true);
    connector.hits.length = 0;

    const refused: Array<[string, string | null]> = [
      ['no token', null],
      ['a key the JWKS does not publish', jwt({}, strangerKey)],
      ['an unknown kid', jwt({}, privateKey, { kid: 'other' })],
      ['another audience', jwt({ aud: 'someone-else' })],
      ['another issuer', jwt({ iss: 'https://evil.example' })],
      ['an expired token', jwt({ exp: Math.floor(Date.now() / 1000) - 3_600 })],
      ['a token for another serviceUrl', jwt({ serviceurl: 'https://elsewhere.example' })],
      ['a token that is not yet valid', jwt({ nbf: Math.floor(Date.now() / 1000) + 3_600 })],
      ['garbage', 'abc.def.ghi'],
    ];
    for (const [label, token] of refused) {
      const response = await post(agent.id, activity({ text: `via ${label}` }), token);
      expect(response.status, label).toBe(401);
    }
    const none = await post(agent.id, activity(), jwt(), 'nope');
    expect(none.status).toBe(404);
    expect(sent()).toHaveLength(0);
  });

  it('replies through the activity’s serviceUrl with a bot token; the conversation is one session', async () => {
    const agent = teamsAgent();
    await post(agent.id, activity());
    const [reply] = sent();
    expect(reply.path).toBe(`/v3/conversations/conv-1/activities/${encodeURIComponent('a-' + counter)}`);
    expect(reply.headers.authorization).toBe('Bearer bot-access-token');
    expect(reply.body).toMatchObject({ type: 'message', text: 'Echo: what is up?', conversation: { id: 'conv-1' }, from: { id: '28:bot' }, recipient: { id: '29:user' } });
    await post(agent.id, activity({ text: 'and now?' }));
    expect(sent()[1].body.text).toBe('Echo: and now?');
    const sessions = agentStore.listSessions(agent.id);
    expect(sessions).toHaveLength(1);
    expect(agentStore.getSession(sessions[0].id)).toMatchObject({ source: 'teams', userId: 'teams:oid-ana', conversationKey: 'teams:tm1:conv-1' });
    expect(sessions[0].turns).toBe(2);
    // The token was fetched once and cached.
    expect(identity.hits.filter((h) => h.path.startsWith('/token')).length).toBeGreaterThanOrEqual(1);
    const tokenCalls = identity.hits.filter((h) => h.path.startsWith('/token')).length;
    await post(agent.id, activity({ text: 'cached?' }));
    expect(identity.hits.filter((h) => h.path.startsWith('/token')).length).toBe(tokenCalls);

    // /new starts a fresh conversation.
    await post(agent.id, activity({ text: '/new' }));
    expect(sent().at(-1)!.body.text).toBe('Started a new conversation.');
  });

  it('ignores other activity types, repeated ids and honours allow lists', async () => {
    const agent = teamsAgent({ access: 'private', allowedUsers: ['oid-ana'] });
    await post(agent.id, activity({ type: 'conversationUpdate', text: undefined }));
    expect(sent()).toHaveLength(0);
    const same = activity();
    await post(agent.id, same);
    await post(agent.id, same);
    expect(sent()).toHaveLength(1);
    await post(agent.id, activity({ from: { id: '29:stranger', name: 'Eve', aadObjectId: 'oid-eve' }, conversation: { id: 'conv-2' } }));
    expect(sent()[1].body.text).toContain('only talks to people');
  });

  it('asks for tool approvals as an Adaptive Card and continues once Approve is clicked', async () => {
    const agent = teamsAgent({}, { tools: [echoTool] });
    await post(agent.id, activity({ text: '<at>Helper</at> use the tool', conversation: { id: 'conv-approve' } }));
    const [ask] = sent();
    const card = (ask.body.attachments as Array<{ contentType: string; content: JsonObject }>)[0];
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const actions = card.content.actions as Array<{ type: string; title: string; verb: string; data: { landflowApproval: boolean; approved: boolean; target: JsonObject }; fallback: { type: string; data: JsonObject } }>;
    expect(actions.map((a) => [a.type, a.title, a.verb, a.fallback.type])).toEqual([
      ['Action.Execute', 'Approve', 'approve', 'Action.Submit'],
      ['Action.Execute', 'Reject', 'reject', 'Action.Submit'],
    ]);
    expect(actions[0].fallback.data).toEqual(actions[0].data);
    expect(JSON.stringify(card.content.body)).toContain('Echo');
    const session = agentStore.listSessions(agent.id)[0];
    expect(agentStore.getSession(session.id)!.status).toBe('awaiting_approval');

    // A message meanwhile waits for the decision.
    await post(agent.id, activity({ text: 'hurry', conversation: { id: 'conv-approve' } }));
    expect(sent()[1].body.text).toContain('waiting for an approval');

    // An Action.Submit click (the fallback): a message activity whose value is the action's data, replying to the card.
    const click = await post(agent.id, activity({ text: undefined, value: actions[0].data, replyToId: 'act-card', conversation: { id: 'conv-approve' } }));
    expect(click.status).toBe(200);
    const update = connector.hits.find((h) => h.method === 'PUT')!;
    expect(update.path).toBe('/v3/conversations/conv-approve/activities/act-card');
    expect(JSON.stringify(update.body.attachments)).toContain('Approved by Ana');
    expect((update.body.attachments as Array<{ content: JsonObject }>)[0].content.actions).toBeUndefined();
    expect(sent().at(-1)!.body.text).toEqual(expect.stringContaining('The answer is'));
    expect(agentStore.getSession(session.id)!.status).toBe('idle');
  });

  it('answers an Action.Execute click in the invoke response with the decided card and continues the run', async () => {
    const agent = teamsAgent({}, { tools: [echoTool] });
    await post(agent.id, activity({ text: 'use the tool', conversation: { id: 'conv-exec' } }));
    const card = (sent()[0].body.attachments as Array<{ content: JsonObject }>)[0].content;
    const [approve] = card.actions as Array<{ verb: string; data: JsonObject }>;
    const invoke = (fields: Record<string, unknown> = {}) =>
      activity({ type: 'invoke', name: 'adaptiveCard/action', text: undefined, value: { action: { type: 'Action.Execute', verb: approve.verb, data: approve.data }, trigger: 'manual' }, conversation: { id: 'conv-exec' }, ...fields });

    const response = await post(agent.id, invoke());
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { statusCode: number; type: string; value: JsonObject };
    expect(answer).toMatchObject({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive' });
    expect(JSON.stringify(answer.value.body)).toContain('Approved by Ana');
    expect(answer.value.actions).toBeUndefined();
    // No card update through the Bot Connector: the invoke answer replaced it.
    expect(connector.hits.some((h) => h.method === 'PUT')).toBe(false);
    expect(sent().at(-1)!.body.text).toEqual(expect.stringContaining('The answer is'));
    const session = agentStore.listSessions(agent.id)[0];
    expect(agentStore.getSession(session.id)!.status).toBe('idle');

    // A second click on the same card: the call is no longer waiting.
    const again = (await (await post(agent.id, invoke())).json()) as { type: string; value: string };
    expect(again).toMatchObject({ type: 'application/vnd.microsoft.activity.message', value: 'This approval is no longer waiting.' });
    // Other invokes are acknowledged and ignored.
    const other = await post(agent.id, activity({ type: 'invoke', name: 'signin/verifyState', text: undefined, value: {} }));
    expect(other.status).toBe(200);
  });

  it('answers an Action.Execute click from someone the channel does not allow with a message, and decides nothing', async () => {
    const agent = teamsAgent({ access: 'private', allowedUsers: ['oid-ana'] }, { tools: [echoTool] });
    await post(agent.id, activity({ text: 'use the tool', conversation: { id: 'conv-exec-2' } }));
    const card = (sent()[0].body.attachments as Array<{ content: JsonObject }>)[0].content;
    const [approve] = card.actions as Array<{ data: JsonObject }>;
    const response = await post(
      agent.id,
      activity({ type: 'invoke', name: 'adaptiveCard/action', text: undefined, value: { action: { type: 'Action.Execute', verb: 'approve', data: approve.data } }, from: { id: '29:eve', name: 'Eve', aadObjectId: 'oid-eve' }, conversation: { id: 'conv-exec-2' } }),
    );
    expect(await response.json()).toMatchObject({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: expect.stringContaining('only the people this agent talks to') });
    expect(agentStore.getSession(agentStore.listSessions(agent.id)[0].id)!.status).toBe('awaiting_approval');
  });

  it('refuses clicks from people the channel does not allow and clicks with another channel’s target', async () => {
    const agent = teamsAgent({ access: 'private', allowedUsers: ['oid-ana'] }, { tools: [echoTool] });
    await post(agent.id, activity({ text: 'use the tool', conversation: { id: 'conv-3' } }));
    const card = (sent()[0].body.attachments as Array<{ content: JsonObject }>)[0].content;
    const data = (card.actions as Array<{ data: JsonObject }>)[0].data;
    await post(agent.id, activity({ text: undefined, value: data, replyToId: 'x', from: { id: '29:eve', aadObjectId: 'oid-eve' }, conversation: { id: 'conv-3' } }));
    expect(sent().at(-1)!.body.text).toContain('only the people this agent talks to');
    expect(agentStore.getSession(agentStore.listSessions(agent.id)[0].id)!.status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// Approvals by email
// ---------------------------------------------------------------------------

describe('approvals by email', () => {
  const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
  const linksIn = (text: string) => ({
    approve: /Approve: (\S+)/.exec(text)![1],
    reject: /Reject:\s+(\S+)/.exec(text)![1],
  });
  const view = (url: string) => emailRoute.GET(new Request(url), { params: Promise.resolve({ token: tokenOf(url) }) });
  const decide = (url: string) => emailRoute.POST(new Request(url, { method: 'POST' }), { params: Promise.resolve({ token: tokenOf(url) }) });

  it('keeps the route public, signs tokens and rejects tampering and expiry', async () => {
    expect(isPublicPath('/api/approvals/email/abc')).toBe(true);
    const { approve } = approvalLinks({ t: 'wf', e: 'ex1', c: 'call1' }, 'ana@example.com', Date.now());
    expect(approve.startsWith('https://landflow.test/api/approvals/email/')).toBe(true);
    const token = tokenOf(approve);
    expect(verifyLink(token)).toMatchObject({ d: 'approve', m: 'ana@example.com', t: { t: 'wf', e: 'ex1', c: 'call1' } });
    const [body, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), m: 'eve@example.com' })).toString('base64url');
    expect(() => verifyLink(`${forged}.${signature}`)).toThrow(/not valid/);
    expect(() => verifyLink(token, Date.now() + 25 * 3_600_000)).toThrow(/expired/);
    expect(() => verifyLink('nonsense')).toThrow(/not valid/);
    expect(parseAddresses('ana@example.com, not-an-address; ben@example.com ana@example.com')).toEqual(['ana@example.com', 'ben@example.com']);
  });

  it('emails an agent’s approver a pair of links; opening one decides nothing, the button does, once', async () => {
    const agent = agentWith({}, { tools: [echoTool], settings: { approvalEmails: ['ana@example.com', 'ben@example.com'] } });
    const body = JSON.stringify({ type: 'event_callback', event_id: 'EvMail1', event: { type: 'app_mention', channel: 'C5', user: 'U1', text: '<@U0BOT> use the tool', ts: '1700000020.000100' } });
    await eventsRoute.POST(new Request('http://x/y', { method: 'POST', headers: signed(body), body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    await settleSlackTasks();
    await waitFor(() => mailbox.length === 2, 'two approval emails');
    expect(mailbox.map((m) => m.to).sort()).toEqual(['ana@example.com', 'ben@example.com']);
    const ana = mailbox.find((m) => m.to === 'ana@example.com')!;
    expect(ana.subject).toBe('Channel helper wants to run a tool: approve Echo?');
    expect(ana.html).toContain('Approve');
    const { approve, reject } = linksIn(ana.text);
    const session = agentStore.listSessions(agent.id)[0];
    expect(agentStore.getSession(session.id)!.status).toBe('awaiting_approval');

    // A mail scanner opening the links changes nothing.
    const page = await view(approve);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Approve this tool call?');
    await view(reject);
    expect(agentStore.getSession(session.id)!.status).toBe('awaiting_approval');

    const done = await decide(approve);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Approved');
    const finished = agentStore.getSession(session.id)!;
    expect(finished.status).toBe('idle');
    expect(finished.pending?.calls.find((c) => c.callId)?.decidedBy ?? finished.timeline.some((e) => e.type === 'tool')).toBeTruthy();
    // The answer went back to the Slack thread the conversation lives in.
    await waitFor(() => slack.of('chat.postMessage').some((m) => String(m.body.text).includes('The answer is')), 'the answer in Slack');

    // Single use: the same link again, the other link of the pair, and Ben's links are all spent.
    expect((await decide(approve)).status).toBe(409);
    expect(await (await decide(reject)).text()).toContain('no longer waiting');
    const benLinks = linksIn(mailbox.find((m) => m.to === 'ben@example.com')!.text);
    expect((await decide(benLinks.approve)).status).toBe(409);
    expect(database().get('SELECT group_id FROM approval_email_used WHERE email = ?', 'ana@example.com')).toBeTruthy();
  });

  it('a reject link rejects, and a tampered link does nothing', async () => {
    const agent = agentWith({}, { tools: [echoTool], settings: { approvalEmails: ['ana@example.com'] } });
    const body = JSON.stringify({ type: 'event_callback', event_id: 'EvMail2', event: { type: 'app_mention', channel: 'C5', user: 'U1', text: '<@U0BOT> use the tool', ts: '1700000021.000100' } });
    await eventsRoute.POST(new Request('http://x/y', { method: 'POST', headers: signed(body), body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    await settleSlackTasks();
    await waitFor(() => mailbox.length === 1, 'the approval email');
    const { approve, reject } = linksIn(mailbox[0].text);
    const tampered = `${approve.slice(0, -4)}AAAA`;
    expect((await decide(tampered)).status).toBe(400);
    const session = agentStore.listSessions(agent.id)[0];
    expect(agentStore.getSession(session.id)!.status).toBe('awaiting_approval');
    expect((await decide(reject)).status).toBe(200);
    const done = agentStore.getSession(session.id)!;
    expect(done.timeline.find((e) => e.type === 'tool')).toMatchObject({ status: 'denied' });
    expect((await decide(approve)).status).toBe(409);
  });

  describe('AI Agent node', () => {
    const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
    const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });
    function emailWorkflow(id: string, parameters: Record<string, unknown> = {}): Workflow {
      const workflow: Workflow = {
        id,
        name: `Email approvals ${id}`,
        nodes: [
          node('Start', 'core.manualTrigger'),
          node('Agent', 'core.aiAgent', { prompt: 'What is 6*7?', requireApproval: 'all', approvalChannel: 'email', approvalEmails: 'ana@example.com, ben@example.com', ...parameters }),
          node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: openAiRef } }),
          node('Calculator', 'core.calculatorTool'),
        ],
        connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), edge('Calculator', 'Agent', 'ai_tool')],
      };
      store.saveWorkflow(workflow);
      return workflow;
    }

    it('sends links to each approver, waits, and resumes on the first decision', async () => {
      const waiting = await runWorkflow({ workflow: emailWorkflow('wf_email_approve'), mode: 'manual', startNodeId: 'Start' });
      expect(waiting.error?.message).toBeUndefined();
      expect(waiting.status).toBe('waiting');
      expect(waiting.wait?.data?.approval).toMatchObject({ channel: 'email', email: { to: ['ana@example.com', 'ben@example.com'] } });
      expect(mailbox).toHaveLength(2);
      expect(mailbox[0].subject).toBe('Agent wants to run a tool: approve Calculator?');
      expect(mailbox[0].text).toContain('6*7');
      const ana = linksIn(mailbox.find((m) => m.to === 'ana@example.com')!.text);
      const ben = linksIn(mailbox.find((m) => m.to === 'ben@example.com')!.text);

      expect((await decide(ana.approve)).status).toBe(200);
      const done = store.getExecution(waiting.executionId)!;
      expect(done.status).toBe('success');
      expect(done.runData.Agent.at(-1)!.outputs[0][0].json).toMatchObject({ output: expect.stringContaining('42') });
      expect((await decide(ana.reject)).status).toBe(409);
      expect((await decide(ben.approve)).status).toBe(409);
    });

    it('a reject link finishes the run without running the tool; it records who decided', async () => {
      const waiting = await runWorkflow({ workflow: emailWorkflow('wf_email_reject'), mode: 'manual', startNodeId: 'Start' });
      const ben = linksIn(mailbox.find((m) => m.to === 'ben@example.com')!.text);
      expect((await decide(ben.reject)).status).toBe(200);
      const done = store.getExecution(waiting.executionId)!;
      expect(done.status).toBe('success');
      const steps = (done.runData.Agent.at(-1)!.outputs[0][0].json as { steps: Array<{ output: string }> }).steps;
      expect(steps[0].output).toBe('Not run: rejected by email:ben@example.com');
    });

    it('fails clearly without approver addresses, and without SMTP', async () => {
      const none = await runWorkflow({ workflow: emailWorkflow('wf_email_none', { approvalEmails: 'not an address' }), mode: 'manual', startNodeId: 'Start' });
      expect(none.status).toBe('error');
      expect(none.error?.message).toContain('approver emails');
      setMailTransport(undefined);
      const saved = process.env.LANDFLOW_SMTP_HOST;
      delete process.env.LANDFLOW_SMTP_HOST;
      try {
        const nomail = await runWorkflow({ workflow: emailWorkflow('wf_email_nosmtp'), mode: 'manual', startNodeId: 'Start' });
        expect(nomail.status).toBe('error');
        expect(nomail.error?.message).toContain('LANDFLOW_SMTP_HOST');
      } finally {
        if (saved !== undefined) process.env.LANDFLOW_SMTP_HOST = saved;
        setMailTransport({
          async send(message) {
            mailbox.push({ to: message.to, subject: message.subject, text: message.text, html: message.html });
          },
        });
      }
    });
  });
});
