/** A demo plugin exercising credentials, polling, spans, metrics and traced HTTP, plus a fake external API. */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecuteRequest, JsonObject } from '@landflow/protocol';
import { defineCredentialType, defineNode, definePlugin, NodeOperationError, pollIntervalProperty } from '../src';

/** Fake values only. */
export const TOKEN = 'fake-token-123:ABCdef';
export const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
export const PARENT_SPAN_ID = '00f067aa0ba902b7';
export const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

export interface DemoApiCredentials extends JsonObject {
  accessToken: string;
  baseUrl: string;
}

/** The "external service": records what it received. */
export interface FakeApi {
  url: string;
  requests: { path: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

export async function startFakeApi(): Promise<FakeApi> {
  const requests: FakeApi['requests'] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url ?? '/', headers: req.headers });
    const authorized = req.headers.authorization === `Bearer ${TOKEN}` || (req.url ?? '').startsWith(`/bot${TOKEN}/`);
    res.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(authorized ? { ok: true, name: 'demo-bot' } : { ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const demoApi = defineCredentialType<DemoApiCredentials>({
  name: 'demoApi',
  displayName: 'Demo API',
  documentationUrl: 'https://example.com/docs',
  properties: [
    { name: 'accessToken', displayName: 'Access token', type: 'string', required: true, typeOptions: { password: true } },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://api.example.com' },
  ],
  async test(data, ctx) {
    const response = await ctx.http(`${data.baseUrl}/me`, { headers: { authorization: `Bearer ${data.accessToken}` } });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
    const body = (await response.json()) as { name: string };
    return { ok: true, message: `Authenticated as ${body.name}` };
  },
});

const untestable = defineCredentialType({
  name: 'plainKey',
  displayName: 'Plain key',
  properties: [{ name: 'key', displayName: 'Key', type: 'string', typeOptions: { password: true } }],
});

export const echo = defineNode({
  description: {
    name: 'echo',
    displayName: 'Echo',
    description: '',
    version: 1,
    kind: 'action',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'demoApi', required: true }],
    properties: [],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const credentials = ctx.getCredentials<DemoApiCredentials>('demoApi');
    const same = ctx.getCredentials<DemoApiCredentials>();
    return ctx.span('demo.work', { 'demo.items': items.length }, async (span) => {
      span.setAttribute('demo.api_key', credentials.accessToken);
      await ctx.span('demo.smtp', { 'server.address': '127.0.0.1' }, () => undefined, { kind: 'client' });
      const response = await ctx.http(`${credentials.baseUrl}/bot${credentials.accessToken}/ping?secret=${credentials.accessToken}&q=1`);
      ctx.metrics.counter('demo.items.processed', { description: 'Items echoed' }).add(items.length, { 'demo.kind': 'echo' });
      ctx.metrics.histogram('demo.work.duration', { unit: 'ms' }).record(12);
      ctx.metrics.gauge('demo.queue.depth').set(3);
      ctx.logger.info(`calling with ${credentials.accessToken}`, { authorization: `Bearer ${credentials.accessToken}`, 'demo.status': response.status });
      return items.map((item) => ({ json: { ...item.json, status: response.status, sameCredential: same?.accessToken === credentials.accessToken } }));
    });
  },
});

export const fail = defineNode({
  description: {
    name: 'fail',
    displayName: 'Fail',
    description: '',
    version: 1,
    kind: 'action',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'demoApi' }],
    properties: [],
  },
  execute(ctx) {
    throw new NodeOperationError(`rejected token ${ctx.getCredentials<DemoApiCredentials>('demoApi').accessToken}`);
  },
});

/** A well-behaved poll trigger: baseline on the first poll, recent items in manual mode. */
export const feed = defineNode({
  description: {
    name: 'feed',
    displayName: 'Feed Trigger',
    description: '',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    inputs: [],
    outputs: [{ type: 'main' }],
    properties: [pollIntervalProperty(30)],
  },
  execute(ctx) {
    if (ctx.mode === 'manual') return [{ id: 10 }];
    if (ctx.isFirstPoll()) {
      ctx.setPollState({ lastId: 10 });
      return [];
    }
    const { lastId } = ctx.getPollState<{ lastId: number }>()!;
    ctx.setPollState({ lastId: lastId + 2 });
    return [{ id: lastId + 1 }, { id: lastId + 2 }];
  },
});

/** A sloppy poll trigger: ignores the baseline rule and never sets state. */
export const sloppy = defineNode({
  description: {
    name: 'sloppy',
    displayName: 'Sloppy Trigger',
    description: '',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    inputs: [],
    outputs: [{ type: 'main' }],
    properties: [pollIntervalProperty()],
  },
  execute: () => [{ id: 1 }, { id: 2 }],
});

export const picker = defineNode({
  description: {
    name: 'picker',
    displayName: 'Picker',
    description: '',
    version: 1,
    kind: 'action',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'demoApi' }],
    properties: [{ name: 'channel', displayName: 'Channel', type: 'options', typeOptions: { loadOptionsMethod: 'channels' } }],
  },
  execute: (ctx) => ctx.getInputData(),
  methods: {
    loadOptions: {
      channels: (ctx) => {
        const { accessToken } = ctx.getCredentials<DemoApiCredentials>('demoApi');
        return [{ name: `token has ${accessToken.length} chars`, value: ctx.getNodeParameter('prefix', 'c') + '1' }];
      },
    },
  },
});

export const demoPlugin = definePlugin({
  info: { id: 'demo', name: 'Demo', version: '1.0.0' },
  nodes: [echo, fail, feed, sloppy, picker],
  credentialTypes: [demoApi, untestable],
});

export function executeRequest(type: string, overrides: Partial<ExecuteRequest> = {}, apiUrl = 'http://127.0.0.1:1'): ExecuteRequest {
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_1',
    workflowId: 'wf_1',
    mode: 'manual',
    node: { id: 'n1', name: 'My node', type: `demo.${type}`, typeVersion: 1 },
    parameters: {},
    itemParameters: [{}, {}],
    inputs: [[{ json: { a: 1 } }, { json: { a: 2 } }]],
    credentials: { demoApi: { accessToken: TOKEN, baseUrl: apiUrl } },
    ...overrides,
  };
}
