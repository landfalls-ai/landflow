/** Credentials, TestCredentials and poll triggers over HTTP and gRPC, plus definePlugin validation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, type ExecuteRequest, type ExecuteResponse, type NodeDescriptor } from '@landflow/protocol';
import {
  executeRequestToMsg,
  executeResponseFromMsg,
  grpc,
  loadLandflowProto,
  loadOptionsRequestToMsg,
  manifestFromMsg,
  optionsFromMsg,
  testCredentialsRequestToMsg,
  type ExecuteResponseMsg,
  type ManifestMsg,
} from '@landflow/protocol/grpc';
import { buildManifest, defineNode, definePlugin, pollIntervalProperty, runLoadOptions, runNode, runTestCredentials, SECRET_KEY, type IExecuteContext } from '../src';
import { serveGrpc } from '../src/grpc';
import { createFetchHandler } from '../src/http';
import { demoPlugin, executeRequest, startFakeApi, TOKEN, type FakeApi } from './fixtures';

const GRPC_PORT = 47332;

let api: FakeApi;
let server: grpc.Server;
let client: grpc.Client;
const handle = createFetchHandler(demoPlugin);

const grpcCall = <T>(method: string, request: unknown) =>
  new Promise<T>((resolve, reject) =>
    (client as unknown as Record<string, Function>)[method](request, { deadline: Date.now() + 3000 }, (error: Error | null, response: T) =>
      error ? reject(error) : resolve(response),
    ),
  );

/** One Execute over each transport. */
const transports: Record<'http' | 'grpc', (request: ExecuteRequest) => Promise<ExecuteResponse>> = {
  http: async (request) =>
    (await handle(new Request(`http://plugin${HTTP_PATHS.execute}`, { method: 'POST', body: JSON.stringify(request) }))).json(),
  grpc: async (request) => executeResponseFromMsg(await grpcCall<ExecuteResponseMsg>('Execute', executeRequestToMsg(request))),
};

beforeAll(async () => {
  api = await startFakeApi();
  server = await serveGrpc(demoPlugin, { port: GRPC_PORT, host: '127.0.0.1' });
  client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
});
afterAll(async () => {
  client.close();
  server.forceShutdown();
  await api.close();
});

describe('SECRET_KEY', () => {
  it('treats addresses and kinds as non-secret', () => {
    for (const key of ['accessToken', 'refresh_token', 'apiKey', 'clientSecret', 'authorization', 'password']) expect(SECRET_KEY.test(key), key).toBe(true);
    for (const key of ['tokenUrl', 'token_uri', 'tokenEndpoint', 'tokenType', 'baseUrl', 'host']) expect(SECRET_KEY.test(key), key).toBe(false);
  });
});

describe('manifest', () => {
  it('declares credential types (testable when test exists) over HTTP and gRPC', async () => {
    const http = await (await handle(new Request(`http://plugin${HTTP_PATHS.manifest}`))).json();
    const viaGrpc = manifestFromMsg(await grpcCall<ManifestMsg>('GetManifest', {}));
    for (const manifest of [http, viaGrpc]) {
      expect(manifestSchema.safeParse(manifest).success).toBe(true);
      expect(manifest.credentialTypes).toEqual([
        expect.objectContaining({ name: 'demoApi', displayName: 'Demo API', testable: true, documentationUrl: 'https://example.com/docs' }),
        expect.not.objectContaining({ testable: true }),
      ]);
      expect(manifest.nodes.find((n: { name: string }) => n.name === 'echo').credentials).toEqual([{ name: 'demoApi', required: true }]);
      expect(manifest.nodes.find((n: { name: string }) => n.name === 'feed').properties[0]).toMatchObject({ name: 'pollInterval', type: 'number', default: 30 });
    }
    expect(JSON.stringify(http)).not.toContain('test(');
    const wellKnown = await (await handle(new Request(`http://plugin${HTTP_PATHS.wellKnown}`))).json();
    expect(wellKnown.endpoints.testCredentials).toBe(HTTP_PATHS.testCredentials);
  });

  it('validates credential references and poll triggers', () => {
    const base = { displayName: 'X', description: '', version: 1, inputs: [], outputs: [{ type: 'main' as const }], properties: [] };
    const info = { id: 'x', name: 'X', version: '1' };
    const plugin = (description: Partial<NodeDescriptor>) =>
      definePlugin({ info, nodes: [defineNode({ description: { ...base, name: 'n', kind: 'action', ...description }, execute: () => [] })] });
    expect(() => plugin({ credentials: [{ name: 'missing' }] })).toThrow(/credential type "missing", which is not in credentialTypes/);
    expect(() => plugin({ kind: 'trigger', triggerSource: 'poll' })).toThrow(/needs a number property "pollInterval"/);
    expect(() => plugin({ triggerSource: 'poll', properties: [pollIntervalProperty()] })).toThrow(/kind "action"/);
    expect(() => definePlugin({ info, nodes: [], credentialTypes: [{ name: 'a.b', displayName: 'A', properties: [] }] })).toThrow(/must be an identifier/);
    expect(pollIntervalProperty(5)).toMatchObject({ default: 10, typeOptions: { minValue: 10 } });
  });
});

describe.each(['http', 'grpc'] as const)('credentials over %s', (transport) => {
  it('reach ctx.getCredentials(name) and ctx.getCredentials()', async () => {
    const response = await transports[transport](executeRequest('echo', {}, api.url));
    expect(response.error).toBeUndefined();
    expect(response.outputs[0][0].json).toMatchObject({ status: 200, sameCredential: true });
    expect(api.requests.at(-1)!.path.startsWith(`/bot${TOKEN}/ping`)).toBe(true);
  });

  it('give a node error when a required credential is missing', async () => {
    const response = await transports[transport](executeRequest('echo', { credentials: undefined }));
    expect(response.error?.message).toBe('No "demoApi" credentials were provided');
  });
});

describe('load options', () => {
  const credentials = { demoApi: { accessToken: TOKEN } };
  it('pass credentials over HTTP, gRPC and in-process', async () => {
    const body = JSON.stringify({ nodeType: 'picker', method: 'channels', parameters: { prefix: 'p' }, credentials });
    const http = await (await handle(new Request(`http://plugin${HTTP_PATHS.loadOptions}`, { method: 'POST', body }))).json();
    expect(http.options).toEqual([{ name: `token has ${TOKEN.length} chars`, value: 'p1' }]);
    const viaGrpc = optionsFromMsg(
      await grpcCall<{ options: never }>('LoadOptions', loadOptionsRequestToMsg({ nodeType: 'picker', method: 'channels', parameters: {}, credentials })),
    );
    expect(viaGrpc).toEqual([{ name: `token has ${TOKEN.length} chars`, value: 'c1' }]);
    expect(await runLoadOptions(demoPlugin.nodes[4], 'channels', {}, credentials)).toEqual(viaGrpc);
  });

  it('scrub credentials from load-options errors', async () => {
    const leaky = defineNode({
      description: { name: 'leaky', displayName: 'L', description: '', version: 1, kind: 'action', inputs: [], outputs: [], properties: [] },
      methods: {
        loadOptions: {
          list: (ctx) => {
            throw new Error(`bad token ${ctx.getCredentials<{ accessToken: string }>('demoApi').accessToken}`);
          },
        },
      },
    });
    await expect(runLoadOptions(leaky, 'list', {}, credentials)).rejects.toThrow('bad token [REDACTED]');
  });

  it('report a missing credential as a 400 / INVALID_ARGUMENT', async () => {
    const res = await handle(new Request(`http://plugin${HTTP_PATHS.loadOptions}`, { method: 'POST', body: JSON.stringify({ nodeType: 'picker', method: 'channels' }) }));
    expect(res.status).toBe(400);
    await expect(grpcCall('LoadOptions', loadOptionsRequestToMsg({ nodeType: 'picker', method: 'channels', parameters: {} }))).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
  });
});

describe('TestCredentials', () => {
  const good = () => ({ credentialType: 'demoApi', data: { accessToken: TOKEN, baseUrl: api.url } });
  const bad = () => ({ credentialType: 'demoApi', data: { accessToken: 'wrong-token', baseUrl: api.url } });
  const http = (body: unknown) => handle(new Request(`http://plugin${HTTP_PATHS.testCredentials}`, { method: 'POST', body: JSON.stringify(body) }));

  it('works over HTTP', async () => {
    expect(await (await http(good())).json()).toEqual({ ok: true, message: 'Authenticated as demo-bot' });
    expect(await (await http(bad())).json()).toEqual({ ok: false, message: 'HTTP 401' });
    expect(await (await http({ credentialType: 'plainKey', data: {} })).json()).toEqual({ ok: false, message: 'Credential type "plainKey" has no connection test' });
    expect((await http({ credentialType: 'nope', data: {} })).status).toBe(404);
    expect((await http({ data: {} })).status).toBe(400);
  });

  it('works over gRPC', async () => {
    expect(await grpcCall('TestCredentials', testCredentialsRequestToMsg(good()))).toEqual({ ok: true, message: 'Authenticated as demo-bot' });
    expect(await grpcCall('TestCredentials', testCredentialsRequestToMsg(bad()))).toEqual({ ok: false, message: 'HTTP 401' });
    await expect(grpcCall('TestCredentials', testCredentialsRequestToMsg({ credentialType: 'nope', data: {} }))).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });

  it('runs in-process and never throws', async () => {
    expect(await runTestCredentials(demoPlugin, good())).toEqual({ ok: true, message: 'Authenticated as demo-bot' });
    expect(await runTestCredentials(demoPlugin, { credentialType: 'nope', data: {} })).toEqual({ ok: false, message: 'Unknown credential type "nope"' });
    // fetch to a closed port throws: reported as ok: false
    const result = await runTestCredentials(demoPlugin, { credentialType: 'demo.demoApi', data: { accessToken: TOKEN, baseUrl: 'http://127.0.0.1:1' } });
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });
});

describe.each(['http', 'grpc'] as const)('poll triggers over %s', (transport) => {
  const poll = (pollState?: Record<string, number>, mode: ExecuteRequest['mode'] = 'poll', type = 'feed') =>
    transports[transport](executeRequest(type, { mode, inputs: [], itemParameters: [], credentials: undefined, ...(pollState && { pollState }) }));

  it('round-trips pollState: baseline first, then new items with the next state', async () => {
    const first = await poll();
    expect(first.outputs).toEqual([[]]);
    expect(first.pollState).toEqual({ lastId: 10 });
    const second = await poll(first.pollState as never);
    expect(second.outputs[0].map((i) => i.json)).toEqual([{ id: 11 }, { id: 12 }]);
    expect(second.pollState).toEqual({ lastId: 12 });
  });

  it('returns recent items and no pollState in manual mode', async () => {
    const manual = await poll(undefined, 'manual');
    expect(manual.outputs[0].map((i) => i.json)).toEqual([{ id: 10 }]);
    expect(manual.pollState).toBeUndefined();
  });

  it('drops first-poll items of a sloppy trigger, gives it a baseline, and echoes unchanged state', async () => {
    const first = await poll(undefined, 'poll', 'sloppy');
    expect(first.outputs).toEqual([[]]);
    expect(first.pollState).toMatchObject({ baselineAt: expect.any(String) });
    expect(first.logs?.[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('First poll returned 2 item(s)') });
    const second = await poll(first.pollState as never, 'poll', 'sloppy');
    expect(second.outputs[0]).toHaveLength(2);
    expect(second.pollState).toEqual(first.pollState);
  });
});

describe('getCredentials semantics', () => {
  const probe = (fn: (ctx: IExecuteContext) => unknown) =>
    defineNode({
      description: { name: 'probe', displayName: 'P', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
      execute: (ctx) => [{ json: { value: (fn(ctx) ?? null) as never } }],
    });
  const run = (fn: (ctx: IExecuteContext) => unknown, credentials?: ExecuteRequest['credentials']) =>
    runNode(probe(fn), executeRequest('probe', { credentials, inputs: [[{ json: {} }]], itemParameters: [{}] }));

  it('returns the only credential without a name, undefined without any, and throws when ambiguous', async () => {
    expect((await run((ctx) => ctx.getCredentials()?.k, { a: { k: 'v1' } })).outputs[0][0].json.value).toBe('v1');
    expect((await run((ctx) => ctx.getCredentials())).outputs[0][0].json.value).toBeNull();
    expect((await run((ctx) => ctx.getCredentials(), { a: {}, b: {} })).error?.message).toBe('This node received several credentials (a, b)');
  });

  it('accepts qualified names and an optional flag', async () => {
    expect((await run((ctx) => ctx.getCredentials('demo.a').k, { a: { k: 'v1' } })).outputs[0][0].json.value).toBe('v1');
    expect((await run((ctx) => ctx.getCredentials('b', { optional: true }), { a: {} })).outputs[0][0].json.value).toBeNull();
  });

  it('keeps buildManifest free of credentialTypes when none are declared', () => {
    expect(buildManifest(definePlugin({ info: { id: 'x', name: 'X', version: '1' }, nodes: [] }))).not.toHaveProperty('credentialTypes');
  });
});
