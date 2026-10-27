/** Slack Trigger (Events API app webhook trigger): lifecycle against a fake Web API, signed Events payloads, URL verification and retries; in process, over HTTP and gRPC. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HTTP_PATHS, PROTOCOL_VERSION, type JsonObject, type WebhookMethodRequest, type WebhookMethodResponse, type WebhookRequest, type WebhookResponse } from '@landflow/protocol';
import {
  grpc,
  loadLandflowProto,
  webhookMethodRequestToMsg,
  webhookMethodResponseFromMsg,
  webhookRequestToMsg,
  webhookResponseFromMsg,
  type ReceiveWebhookResponseMsg,
  type WebhookMethodResponseMsg,
} from '@landflow/protocol/grpc';
import { runWebhook, runWebhookMethod, slackSignature } from '@landflow/sdk';
import { serveGrpc } from '@landflow/sdk/grpc';
import { createFetchHandler } from '@landflow/sdk/http';
import { plugin } from '../src/main';
import { SlackTrigger } from '../src/nodes/slack-trigger';
import { run, startFakeApi, testCredentials, type FakeApi } from './helpers';

const TOKEN = 'xoxb-test-token-123';
const SIGNING_SECRET = 'slack-signing-secret-for-tests';
const URL_ = 'https://landflow.example/api/webhook/app/wf_slack/n1';
const GRPC_PORT = 47905;

let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi((req) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return { body: { ok: false, error: 'invalid_auth' } };
    if (req.path === '/auth.test') return { body: { ok: true, url: 'https://acme.slack.com/', team: 'Acme', user: 'landflow-bot', team_id: 'T1', user_id: 'UBOT' } };
    return { body: { ok: false, error: 'unknown_method' } };
  });
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
});

const credentials = (type = 'slackApi', extra: JsonObject = {}) => ({ [type]: { accessToken: TOKEN, baseUrl: api.url, signingSecret: SIGNING_SECRET, ...extra } });
const PARAMETERS: JsonObject = { events: ['message', 'app_mention', 'reaction_added', 'channel_created'] };

const callback = (event: JsonObject, extra: JsonObject = {}): JsonObject => ({
  token: 'legacy',
  team_id: 'T1',
  api_app_id: 'A1',
  type: 'event_callback',
  event_id: `Ev${JSON.stringify(event).length}`,
  event_time: 1_760_000_000,
  authorizations: [{ enterprise_id: null, team_id: 'T1', user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
  event,
  ...extra,
});

interface Transport {
  method(request: WebhookMethodRequest): Promise<WebhookMethodResponse>;
  webhook(request: WebhookRequest): Promise<WebhookResponse>;
}
const node = { id: 'n1', name: 'Slack Trigger', type: 'messaging.slackTrigger', typeVersion: 1 };
const handle = createFetchHandler(plugin);
let server: grpc.Server;
let client: grpc.Client;
const grpcCall = <T>(method: string, request: unknown) =>
  new Promise<T>((resolve, reject) =>
    (client as unknown as Record<string, Function>)[method](request, { deadline: Date.now() + 3000 }, (error: Error | null, response: T) => (error ? reject(error) : resolve(response))),
  );
const post = async (path: string, body: unknown) => (await handle(new Request(`http://plugin${path}`, { method: 'POST', body: JSON.stringify(body) }))).json();
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' };
const transports: Record<'in-process' | 'http' | 'grpc', Transport> = {
  'in-process': { method: (request) => runWebhookMethod(SlackTrigger, request, extras), webhook: (request) => runWebhook(SlackTrigger, request, extras) },
  http: { method: (request) => post(HTTP_PATHS.webhookMethod, request), webhook: (request) => post(HTTP_PATHS.webhook, request) },
  grpc: {
    method: async (request) => webhookMethodResponseFromMsg(await grpcCall<WebhookMethodResponseMsg>('WebhookMethod', webhookMethodRequestToMsg(request))),
    webhook: async (request) => webhookResponseFromMsg(await grpcCall<ReceiveWebhookResponseMsg>('ReceiveWebhook', webhookRequestToMsg(request))),
  },
};
beforeAll(async () => {
  server = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
  client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
});
afterAll(() => {
  client.close();
  server.forceShutdown();
});

const body = (response: WebhookResponse) => JSON.parse(response.response?.body ?? 'null');

describe.each(['in-process', 'http', 'grpc'] as const)('Slack Trigger (%s)', (name) => {
  const transport = transports[name];
  const base = { protocol: PROTOCOL_VERSION, workflowId: 'wf_slack', node, parameters: PARAMETERS, webhookUrl: URL_ };
  const method = (m: WebhookMethodRequest['method'], staticData: JsonObject, extra: Partial<WebhookMethodRequest> = {}) =>
    transport.method({ ...base, method: m, staticData, credentials: credentials(), ...extra });
  const deliver = (staticData: JsonObject, payload: JsonObject | string, options: { timestamp?: number; signature?: string; headers?: Record<string, string>; parameters?: JsonObject; creds?: Record<string, JsonObject> } = {}) => {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    return transport.webhook({
      ...base,
      parameters: options.parameters ?? PARAMETERS,
      staticData,
      credentials: options.creds ?? credentials(),
      request: {
        method: 'POST',
        path: new URL(URL_).pathname,
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': String(timestamp),
          'x-slack-signature': options.signature ?? slackSignature(SIGNING_SECRET, raw, timestamp),
          ...options.headers,
        },
        query: {},
        body: Buffer.from(raw).toString('base64'),
      },
    });
  };

  it('publishes (auth.test), answers the URL verification, turns events into items and unpublishes', async () => {
    expect((await method('checkExists', {})).exists ?? false).toBe(false);
    const created = await method('create', {});
    expect(created.error).toBeUndefined();
    const staticData = created.staticData!;
    expect(staticData).toEqual({ url: URL_, teamId: 'T1', botUserId: 'UBOT', team: 'Acme' });
    expect(api.requests.map((r) => r.path)).toEqual(['/auth.test']);
    expect((await method('checkExists', staticData)).exists).toBe(true);
    expect((await method('checkExists', { ...staticData, url: 'https://old.example/hook' })).exists ?? false).toBe(false);

    const verification = await deliver(staticData, { type: 'url_verification', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P', token: 'legacy' });
    expect(verification.items).toBeUndefined();
    expect(verification.response?.status).toBe(200);
    expect(body(verification)).toEqual({ challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });

    const message = callback({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'hello <@UBOT>', ts: '1760000000.000100', thread_ts: '1760000000.000050' });
    const received = await deliver(staticData, message, { headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' } });
    expect(received.error).toBeUndefined();
    expect(received.idempotencyKey).toBe(message.event_id);
    expect(received.items).toHaveLength(1);
    expect(received.items![0].json).toMatchObject({
      eventId: message.event_id,
      eventTime: 1_760_000_000,
      teamId: 'T1',
      apiAppId: 'A1',
      type: 'message',
      channel: 'C1',
      user: 'U1',
      text: 'hello <@UBOT>',
      ts: '1760000000.000100',
      threadTs: '1760000000.000050',
      event: message.event,
      raw: message,
    });
    expect((received.items![0].json.authorizations as JsonObject[])[0].user_id).toBe('UBOT');
    expect(received.staticData).toBeUndefined();

    const reaction = callback({ type: 'reaction_added', user: 'U2', reaction: 'eyes', item: { type: 'message', channel: 'C2', ts: '1760000001.000200' }, event_ts: '1760000002.000300' });
    expect((await deliver(staticData, reaction)).items![0].json).toMatchObject({ type: 'reaction_added', channel: 'C2', user: 'U2', text: '', ts: '1760000001.000200', threadTs: null });
    const created2 = callback({ type: 'channel_created', channel: { id: 'C9', name: 'new-channel', created: 1 }, event_ts: '1760000003.000100' });
    expect((await deliver(staticData, created2)).items![0].json).toMatchObject({ type: 'channel_created', channel: 'C9', user: null });

    const deleted = await method('delete', staticData);
    expect(deleted.error).toBeUndefined();
    expect(deleted.staticData).toEqual({});
    expect((await method('checkExists', {})).exists ?? false).toBe(false);
  });

  it('rejects calls without a valid signature (401), including stale and replayed ones', async () => {
    const staticData = (await method('create', {})).staticData!;
    const payload = callback({ type: 'message', channel: 'C1', user: 'U1', text: 'x', ts: '1.1' });
    for (const options of [
      { signature: slackSignature('wrong-secret', JSON.stringify(payload), Math.floor(Date.now() / 1000)) },
      { signature: '' },
      { timestamp: Math.floor(Date.now() / 1000) - 3600 },
      { headers: { 'x-slack-request-timestamp': 'not-a-number' } },
    ]) {
      const rejected = await deliver(staticData, payload, options);
      expect(rejected.items).toBeUndefined();
      expect(rejected.response?.status).toBe(401);
    }
    // The URL verification is signed too.
    expect((await deliver(staticData, { type: 'url_verification', challenge: 'c' }, { signature: 'v0=00' })).response?.status).toBe(401);
    // No signing secret in the credential: nothing can verify.
    const unsigned = await deliver(staticData, payload, { creds: credentials('slackApi', { signingSecret: '' }) });
    expect(unsigned.response?.status).toBe(401);
    // An option widens the tolerance.
    const old = await deliver(staticData, payload, { timestamp: Math.floor(Date.now() / 1000) - 3600, parameters: { ...PARAMETERS, options: { tolerance: 7200 } } });
    expect(old.items).toHaveLength(1);
  });

  it('filters by event type, bots, edits and channels', async () => {
    const staticData = (await method('create', {})).staticData!;
    const ignored = async (event: JsonObject, parameters: JsonObject = PARAMETERS) => {
      const response = await deliver(staticData, callback(event), { parameters });
      expect(response.items).toBeUndefined();
      expect(response.response?.status).toBe(200);
      return body(response).ignored;
    };
    expect(await ignored({ type: 'team_join', user: { id: 'U3' } })).toBe('team_join');
    // Bots: bot_id, subtype bot_message, the app's own user (static data and authorizations), an edited bot message.
    expect(await ignored({ type: 'message', channel: 'C1', bot_id: 'B1', text: 'x', ts: '1.1' })).toBe('bot');
    expect(await ignored({ type: 'message', channel: 'C1', subtype: 'bot_message', text: 'x', ts: '1.2' })).toBe('bot');
    expect(await ignored({ type: 'message', channel: 'C1', user: 'UBOT', text: 'x', ts: '1.3' })).toBe('bot');
    expect(await ignored({ type: 'message', channel: 'C1', subtype: 'message_changed', message: { text: 'y', bot_id: 'B1' }, ts: '1.4' }, { ...PARAMETERS, ignoreEdits: false })).toBe('bot');
    const withoutStatic = await deliver({}, callback({ type: 'reaction_added', user: 'UBOT', item: { channel: 'C1', ts: '1.5' } }));
    expect(body(withoutStatic).ignored).toBe('bot'); // known from the call's authorizations
    // Edits and deletions.
    expect(await ignored({ type: 'message', channel: 'C1', subtype: 'message_changed', message: { text: 'y', user: 'U1' }, ts: '1.6' })).toBe('message_changed');
    expect(await ignored({ type: 'message', channel: 'C1', subtype: 'message_deleted', ts: '1.7' })).toBe('message_deleted');
    // ...unless switched off.
    const edited = await deliver(staticData, callback({ type: 'message', channel: 'C1', subtype: 'message_changed', message: { text: 'edited', user: 'U1' }, ts: '1.8' }), { parameters: { ...PARAMETERS, ignoreEdits: false } });
    expect(edited.items![0].json).toMatchObject({ text: 'edited', user: 'U1', channel: 'C1' });
    const botsAllowed = await deliver(staticData, callback({ type: 'message', channel: 'C1', bot_id: 'B1', text: 'from a bot', ts: '1.9' }), { parameters: { ...PARAMETERS, ignoreBots: false } });
    expect(botsAllowed.items).toHaveLength(1);

    // Channels: only the listed ones (message, reaction item and channel_created object all count).
    const scoped = { ...PARAMETERS, watchWorkspace: false, channelIds: ' C1, C9 ' };
    expect(await ignored({ type: 'message', channel: 'C2', user: 'U1', text: 'x', ts: '2.1' }, scoped)).toBe('channel');
    expect(await ignored({ type: 'reaction_added', user: 'U1', item: { channel: 'C2', ts: '2.2' } }, scoped)).toBe('channel');
    expect(await ignored({ type: 'app_mention', user: 'U1', text: 'x', ts: '2.3' }, scoped)).toBe('channel'); // no channel at all
    const inScope: JsonObject[] = [
      { type: 'message', channel: 'C1', user: 'U1', text: 'x', ts: '2.4' },
      { type: 'reaction_added', user: 'U1', item: { channel: 'C1', ts: '2.5' } },
      { type: 'channel_created', channel: { id: 'C9', name: 'n' } },
    ];
    for (const event of inScope) {
      expect((await deliver(staticData, callback(event), { parameters: scoped })).items).toHaveLength(1);
    }
    // Any Event.
    expect((await deliver(staticData, callback({ type: 'link_shared', channel: 'C1', user: 'U1', links: [] }), { parameters: { events: ['*'] } })).items).toHaveLength(1);
  });

  it('ignores envelopes that are not events', async () => {
    const staticData = (await method('create', {})).staticData!;
    const limited = await deliver(staticData, { type: 'app_rate_limited', minute_rate_limited: 1760000000, team_id: 'T1', api_app_id: 'A1' });
    expect(limited.items).toBeUndefined();
    expect(body(limited)).toEqual({ ignored: 'app_rate_limited' });
  });

  it('reports a bad token, a missing signing secret and missing channels when publishing', async () => {
    const badToken = await method('create', {}, { credentials: credentials('slackApi', { accessToken: 'xoxb-nope' }) });
    expect(badToken.error?.message).toContain('invalid_auth');
    expect(badToken.staticData).toBeUndefined();
    const noSecret = await method('create', {}, { credentials: credentials('slackApi', { signingSecret: '' }) });
    expect(noSecret.error?.message).toContain('Signing Secret');
    const noChannels = await method('create', {}, { parameters: { ...PARAMETERS, watchWorkspace: false, channelIds: '' } });
    expect(noChannels.error?.message).toContain('channel IDs');
    const noEvents = await method('create', {}, { parameters: { events: [] } });
    expect(noEvents.error?.message).toContain('at least one event');
  });

  it('works with a Slack OAuth2 credential: the bot token is the accessToken, the team comes from auth.test', async () => {
    const oauth = { credentials: credentials('slackOAuth2Api', { expiresAt: '2030-01-01T00:00:00.000Z' }), parameters: { ...PARAMETERS, authentication: 'oAuth2' } };
    const created = await method('create', {}, oauth);
    expect(created.error).toBeUndefined();
    expect(created.staticData).toMatchObject({ teamId: 'T1', botUserId: 'UBOT' });
    expect(api.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    const payload = callback({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> hi', ts: '3.1' });
    const received = await deliver(created.staticData!, payload, { creds: oauth.credentials, parameters: oauth.parameters });
    expect(received.items![0].json).toMatchObject({ type: 'app_mention', text: '<@UBOT> hi' });
    // The other type is used when only it was sent.
    expect((await deliver(created.staticData!, payload, { creds: oauth.credentials })).items).toHaveLength(1);
  });
});

describe('Slack Trigger node', () => {
  it('has no event in a manual run', async () => {
    const response = await run(SlackTrigger, PARAMETERS, { credentials: credentials() });
    expect(response.error).toBeUndefined();
    expect(response.outputs).toEqual([[]]);
    expect(response.logs?.[0].message).toContain('manual run');
  });

  it('is an app webhook trigger accepting both Slack credential types, with the Request URL notice', () => {
    expect(SlackTrigger.description).toMatchObject({ kind: 'trigger', triggerSource: 'appWebhook' });
    expect(SlackTrigger.description.credentials).toEqual([
      { name: 'slackApi', required: true, displayOptions: { show: { authentication: ['accessToken'] } } },
      { name: 'slackOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ]);
    const properties = Object.fromEntries(SlackTrigger.description.properties.map((p) => [p.name, p]));
    expect(properties.notice.displayName).toContain('Request URL');
    expect(properties.events.options?.map((o) => o.value)).toEqual([
      '*', 'app_home_opened', 'app_mention', 'channel_created', 'channel_rename', 'file_public', 'file_shared', 'link_shared',
      'member_joined_channel', 'message', 'reaction_added', 'reaction_removed', 'team_join', 'user_change',
    ]);
    expect([properties.ignoreBots.default, properties.ignoreEdits.default, properties.watchWorkspace.default]).toEqual([true, true, true]);
  });

  it('keeps the Events URL guidance on both credential types and tests them', async () => {
    const types = Object.fromEntries(plugin.credentialTypes!.map((t) => [t.name, t]));
    expect(types.slackOAuth2Api.description).toContain('/api/webhook/app/<workflow id>/<node id>');
    for (const name of ['slackApi', 'slackOAuth2Api']) {
      expect(types[name].properties.find((p) => p.name === 'signingSecret')?.description).toContain('Slack Trigger');
    }
    expect((await testCredentials('slackApi', credentials().slackApi)).ok).toBe(true);
  });
});
