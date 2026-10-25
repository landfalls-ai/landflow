/** Webhook signature helpers, and app webhook triggers (WebhookMethod + ReceiveWebhook) in process, over HTTP and over gRPC. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import {
  defineNode,
  definePlugin,
  githubSignature,
  hmacSha256,
  runWebhook,
  runWebhookMethod,
  slackSignature,
  stripeSignature,
  verifyGitHubSignature,
  verifyHmacSha256,
  verifySlackSignature,
  verifyStripeSignature,
} from '../src';
import { serveGrpc } from '../src/grpc';
import { createFetchHandler } from '../src/http';

const GRPC_PORT = 47351;
const SECRET = 'It\'s a Secret to Everybody';
const BODY = 'Hello, World!';

describe('signatures', () => {
  it('matches GitHub\'s documented X-Hub-Signature-256 example', () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    const expected = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(githubSignature(SECRET, BODY)).toBe(expected);
    expect(verifyGitHubSignature(SECRET, BODY, expected)).toBe(true);
    expect(verifyGitHubSignature(SECRET, Buffer.from(BODY), expected.toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
    expect(verifyGitHubSignature(SECRET, `${BODY} `, expected)).toBe(false);
    expect(verifyGitHubSignature('other', BODY, expected)).toBe(false);
    expect(verifyGitHubSignature(SECRET, BODY, expected.slice('sha256='.length))).toBe(false);
    expect(verifyGitHubSignature(SECRET, BODY, undefined)).toBe(false);
    expect(verifyGitHubSignature('', BODY, githubSignature('', BODY))).toBe(false);
  });

  it('verifies plain and base64 HMACs', () => {
    expect(verifyHmacSha256({ secret: 'k', payload: 'p', signature: hmacSha256('k', 'p') })).toBe(true);
    expect(verifyHmacSha256({ secret: 'k', payload: 'p', signature: hmacSha256('k', 'p', 'base64'), encoding: 'base64' })).toBe(true);
    expect(verifyHmacSha256({ secret: 'k', payload: 'p', signature: hmacSha256('k', 'q') })).toBe(false);
  });

  it('verifies Stripe-style t=…,v1=… signatures within the tolerance', () => {
    const now = 1_760_000_000_000;
    const t = now / 1000;
    const header = stripeSignature('whsec_test', BODY, t);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyStripeSignature('whsec_test', BODY, header, { now })).toBe(true);
    expect(verifyStripeSignature('whsec_test', BODY, `${header},v1=${'0'.repeat(64)}`, { now })).toBe(true);
    expect(verifyStripeSignature('whsec_test', `${BODY}!`, header, { now })).toBe(false);
    expect(verifyStripeSignature('whsec_test', BODY, header, { now: now + 301_000 })).toBe(false);
    expect(verifyStripeSignature('whsec_test', BODY, header, { now: now + 301_000, toleranceSeconds: 600 })).toBe(true);
    expect(verifyStripeSignature('whsec_test', BODY, `v1=${header.split('v1=')[1]}`, { now })).toBe(false);
    expect(verifyStripeSignature('whsec_test', BODY, 'garbage', { now })).toBe(false);
  });

  it('verifies Slack v0 signatures within the tolerance', () => {
    const now = 1_531_420_618_000;
    const ts = '1531420618';
    const body = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather';
    const signature = slackSignature('8f742231b10e8888abcd99yyyzzz85a5', body, ts);
    expect(signature).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(verifySlackSignature('8f742231b10e8888abcd99yyyzzz85a5', body, ts, signature, { now })).toBe(true);
    expect(verifySlackSignature('8f742231b10e8888abcd99yyyzzz85a5', body, ts, signature, { now: now + 10 * 60_000 })).toBe(false);
    expect(verifySlackSignature('8f742231b10e8888abcd99yyyzzz85a5', body, '1531420619', signature, { now })).toBe(false);
    expect(verifySlackSignature('wrong', body, ts, signature, { now })).toBe(false);
  });
});

// ---- A fake service with a hooks API --------------------------------------

interface Hook {
  id: string;
  url: string;
  secret: string;
}

let hooks: Map<string, Hook>;
let hookServer: Server;
let hookApi: string;
let nextHook = 1;

/** An app webhook trigger against the fake service: registers a hook with a random secret, verifies GitHub-style signatures. */
const hookTrigger = defineNode({
  description: {
    name: 'hookTrigger',
    displayName: 'Hook Trigger',
    description: 'Starts on calls from the fake service',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    inputs: [],
    outputs: [{ type: 'main' }],
    properties: [{ name: 'events', displayName: 'Events', type: 'string', default: 'push' }],
  },
  webhookMethods: {
    async checkExists(ctx) {
      const id = ctx.getStaticData().hookId;
      if (!id) return false;
      const response = await ctx.helpers.httpRequest({ url: `${hookApi}/hooks/${id}` });
      return response.status === 200;
    },
    async create(ctx) {
      const secret = `s-${nextHook}`;
      const response = await ctx.helpers.httpRequest({ method: 'POST', url: `${hookApi}/hooks`, body: { url: ctx.getWebhookUrl(), secret, events: ctx.getNodeParameter('events') } });
      if (response.status !== 201) return false;
      const hook = response.body as Hook;
      ctx.logger.info('hook created', { id: hook.id });
      Object.assign(ctx.getStaticData(), { hookId: hook.id, secret });
    },
    async delete(ctx) {
      const id = ctx.getStaticData().hookId;
      if (id) await ctx.helpers.httpRequest({ method: 'DELETE', url: `${hookApi}/hooks/${id}` });
      ctx.setStaticData({});
    },
  },
  async webhook(ctx) {
    const secret = String(ctx.getStaticData().secret ?? '');
    if (!verifyGitHubSignature(secret, ctx.getRawBody(), ctx.getHeader('X-Hub-Signature-256'))) return { response: { status: 401, json: { error: 'bad signature' } } };
    const body = ctx.getBody<JsonObject>();
    if (body.zen) return { response: { status: 200, body: 'pong' } };
    ctx.getStaticData().lastDelivery = ctx.getHeader('x-delivery') ?? null;
    return { items: [{ event: ctx.getHeader('x-event') ?? 'unknown', body }], idempotencyKey: ctx.getHeader('x-delivery') };
  },
});

const failingTrigger = defineNode({
  description: { ...hookTrigger.description, name: 'failingTrigger', displayName: 'Failing Trigger' },
  webhookMethods: {
    create: () => false,
    async delete() {
      throw new Error('service down');
    },
  },
  webhook: () => [{ json: { ok: true } }],
});

const plugin = definePlugin({ info: { id: 'hooks', name: 'Hooks', version: '1.0.0' }, nodes: [hookTrigger, failingTrigger] });
const handle = createFetchHandler(plugin);
let server: grpc.Server;
let client: grpc.Client;

const grpcCall = <T>(method: string, request: unknown) =>
  new Promise<T>((resolve, reject) =>
    (client as unknown as Record<string, Function>)[method](request, { deadline: Date.now() + 3000 }, (error: Error | null, response: T) =>
      error ? reject(error) : resolve(response),
    ),
  );

const post = async (path: string, body: unknown) => (await handle(new Request(`http://plugin${path}`, { method: 'POST', body: JSON.stringify(body) }))).json();

type Transport = { method(request: WebhookMethodRequest): Promise<WebhookMethodResponse>; webhook(request: WebhookRequest): Promise<WebhookResponse> };
const transports: Record<'in-process' | 'http' | 'grpc', Transport> = {
  'in-process': {
    method: (request) => runWebhookMethod(request.node.type.endsWith('failingTrigger') ? failingTrigger : hookTrigger, request, { pluginId: 'hooks' }),
    webhook: (request) => runWebhook(hookTrigger, request, { pluginId: 'hooks' }),
  },
  http: { method: (request) => post(HTTP_PATHS.webhookMethod, request), webhook: (request) => post(HTTP_PATHS.webhook, request) },
  grpc: {
    method: async (request) => webhookMethodResponseFromMsg(await grpcCall<WebhookMethodResponseMsg>('WebhookMethod', webhookMethodRequestToMsg(request))),
    webhook: async (request) => webhookResponseFromMsg(await grpcCall<ReceiveWebhookResponseMsg>('ReceiveWebhook', webhookRequestToMsg(request))),
  },
};

beforeAll(async () => {
  hooks = new Map();
  hookServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const id = /^\/hooks\/([^/]+)$/.exec(req.url ?? '')?.[1];
      if (req.method === 'POST' && req.url === '/hooks') {
        const input = JSON.parse(raw) as Omit<Hook, 'id'>;
        const hook = { id: `h${nextHook++}`, url: input.url, secret: input.secret };
        hooks.set(hook.id, hook);
        return send(201, hook);
      }
      if (id && req.method === 'GET') return hooks.has(id) ? send(200, hooks.get(id)) : send(404, { message: 'Not Found' });
      if (id && req.method === 'DELETE') return hooks.delete(id) ? send(204) : send(404, { message: 'Not Found' });
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  hookApi = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;
  server = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
  client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
});
afterAll(async () => {
  client.close();
  server.forceShutdown();
  await new Promise<void>((resolve) => hookServer.close(() => resolve()));
});

it('advertises the webhook endpoints when the plugin has app webhook triggers', async () => {
  const wellKnown = await (await handle(new Request(`http://plugin${HTTP_PATHS.wellKnown}`))).json();
  expect(wellKnown.endpoints).toMatchObject({ webhookMethod: HTTP_PATHS.webhookMethod, webhook: HTTP_PATHS.webhook });
  const manifest = await (await handle(new Request(`http://plugin${HTTP_PATHS.manifest}`))).json();
  expect(manifest.nodes[0]).toMatchObject({ kind: 'trigger', triggerSource: 'appWebhook' });
});

it('rejects app webhook triggers without create and delete', () => {
  const broken = defineNode({ description: { ...hookTrigger.description, name: 'broken' }, async execute() {} } as never);
  expect(() => definePlugin({ info: { id: 'x', name: 'X', version: '1' }, nodes: [broken] })).toThrow(/needs webhookMethods.create and webhookMethods.delete/);
});

describe.each(['in-process', 'http', 'grpc'] as const)('app webhook lifecycle %s', (name) => {
  const transport = transports[name];
  const node = { id: 'n1', name: 'Hook', type: 'hooks.hookTrigger', typeVersion: 1 };
  const webhookUrl = `https://landflow.example/api/webhook/app/wf_${name}/n1`;
  const base = { protocol: PROTOCOL_VERSION, workflowId: `wf_${name}`, node, parameters: { events: 'push,issues' }, webhookUrl };
  const call = (method: WebhookMethodRequest['method'], staticData: JsonObject) => transport.method({ ...base, method, staticData });
  const deliver = (staticData: JsonObject, body: string, headers: Record<string, string>) =>
    transport.webhook({ ...base, staticData, request: { method: 'POST', path: new URL(webhookUrl).pathname, headers, query: {}, body: Buffer.from(body).toString('base64') } });

  it('checks, creates, receives and deletes', async () => {
    // gRPC (proto3) cannot tell false from absent: hosts read `exists !== true` as "not registered".
    expect((await call('checkExists', {})).exists ?? false).toBe(false);

    const created = await call('create', {});
    expect(created.error).toBeUndefined();
    const staticData = created.staticData!;
    expect(staticData).toMatchObject({ hookId: expect.stringMatching(/^h\d+$/), secret: expect.any(String) });
    expect(hooks.get(String(staticData.hookId))).toMatchObject({ url: webhookUrl });
    expect(created.logs?.[0]).toMatchObject({ level: 'info', message: 'hook created' });

    const exists = await call('checkExists', staticData);
    expect(exists.exists).toBe(true);
    expect(exists.staticData).toBeUndefined();

    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    const signed = { 'content-type': 'application/json', 'x-hub-signature-256': githubSignature(String(staticData.secret), payload), 'x-event': 'push', 'x-delivery': 'd-1' };
    const received = await deliver(staticData, payload, signed);
    expect(received.items).toEqual([{ json: { event: 'push', body: { ref: 'refs/heads/main' } } }]);
    expect(received.idempotencyKey).toBe('d-1');
    expect(received.staticData).toMatchObject({ lastDelivery: 'd-1', hookId: staticData.hookId });

    const forged = await deliver(staticData, payload, { ...signed, 'x-hub-signature-256': githubSignature('guess', payload) });
    expect(forged.items).toBeUndefined();
    expect(forged.response).toMatchObject({ status: 401, body: '{"error":"bad signature"}' });
    expect(forged.response?.headers?.['content-type']).toMatch(/json/);

    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' });
    expect(await deliver(staticData, ping, { 'content-type': 'application/json', 'x-hub-signature-256': githubSignature(String(staticData.secret), ping) })).toEqual({
      response: { status: 200, body: 'pong' },
    });

    const deleted = await call('delete', staticData);
    expect(deleted.error).toBeUndefined();
    expect(deleted.staticData).toEqual({});
    expect(hooks.has(String(staticData.hookId))).toBe(false);
    expect((await call('checkExists', staticData)).exists ?? false).toBe(false);
  });

  it('reports failures in error instead of throwing', async () => {
    const failing = { ...base, node: { ...node, type: 'hooks.failingTrigger' }, staticData: {} };
    expect((await transport.method({ ...failing, method: 'create' })).error?.message).toBe('The webhook could not be registered');
    expect((await transport.method({ ...failing, method: 'delete' })).error?.message).toBe('service down');
    expect((await transport.method({ ...failing, method: 'checkExists' })).exists ?? false).toBe(false);
  });
});

it('answers unknown node types with 404 (HTTP) and NOT_FOUND (gRPC)', async () => {
  const request = { protocol: PROTOCOL_VERSION, method: 'create', workflowId: 'w', node: { id: 'n', name: 'N', type: 'hooks.nope', typeVersion: 1 }, parameters: {}, webhookUrl: 'http://x', staticData: {} };
  const response = await handle(new Request(`http://plugin${HTTP_PATHS.webhookMethod}`, { method: 'POST', body: JSON.stringify(request) }));
  expect(response.status).toBe(404);
  const invalid = await handle(new Request(`http://plugin${HTTP_PATHS.webhook}`, { method: 'POST', body: JSON.stringify({ protocol: PROTOCOL_VERSION }) }));
  expect(invalid.status).toBe(400);
  await expect(grpcCall('WebhookMethod', webhookMethodRequestToMsg(request as WebhookMethodRequest))).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
});
