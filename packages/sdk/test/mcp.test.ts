/**
 * The MCP face (docs/protocol.md §15.2): modes and precedence, the token rule, credentials from LANDFLOW_MCP_CREDENTIALS,
 * tool results, `list_options`, both protocol revisions over Streamable HTTP (the official client pinned to 2026-07-28
 * and in legacy mode) and over an in-memory stdio-equivalent transport.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { defineCredentialType, defineNode, definePlugin, NodeOperationError, type IExecuteContext } from '../src';
import { createDispatcher } from '../src/dispatcher';
import { bearerTokenMatches, createMcpFace, isLoopbackHost, LIST_OPTIONS_TOOL, loadMcpCredentials, mcpMode, serveMcpStdio, toolResultFromResponse } from '../src/mcp';
import { serve, type ServeResult } from '../src/serve';
import { createTelemetry } from '../src/telemetry';
import { mcpRequest } from './mcp-client';

// Stream T2-D's port range: 7460–7479.
const HTTP_PORT = 7464;
const TOKEN = 'mcp-test-token';

const api = defineCredentialType({
  name: 'demoApi',
  displayName: 'Demo API',
  properties: [
    { name: 'accessToken', displayName: 'Access token', type: 'string', required: true, typeOptions: { password: true } },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://api.example.com' },
  ],
});

const greet = defineNode({
  description: {
    name: 'greet',
    displayName: 'Greet',
    description: 'Say hello.',
    version: 1,
    kind: 'action',
    usableAsTool: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'demoApi', required: true }],
    outputSchema: { type: 'object', properties: { greeting: { type: 'string' } } },
    properties: [
      { name: 'name', displayName: 'Name', type: 'string', default: 'world', required: true },
      { name: 'channel', displayName: 'Channel', type: 'options', typeOptions: { loadOptionsMethod: 'channels' }, default: '' },
    ],
  },
  execute(ctx: IExecuteContext) {
    const { accessToken } = ctx.getCredentials<{ accessToken: string }>('demoApi');
    const name = ctx.getNodeParameter<string>('name');
    if (name === 'boom') throw new NodeOperationError('boom', { description: 'asked to fail' });
    return [{ json: { greeting: `hello ${name}`, tokenLength: accessToken.length, channel: ctx.getNodeParameter<string>('channel', 0, '') } }];
  },
  methods: { loadOptions: { channels: (ctx) => [{ name: `token ${ctx.getCredentials<{ accessToken: string }>('demoApi').accessToken.length}`, value: 'general' }] } },
});

const free = defineNode({
  description: { name: 'free', displayName: 'Free', description: 'No credential.', version: 1, kind: 'action', usableAsTool: true, inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx: IExecuteContext) {
    const items = ctx.getInputData();
    const ms = typeof items[0]?.json.ms === 'number' ? items[0].json.ms : 0;
    if (ms) await new Promise<void>((resolve, reject) => (setTimeout(resolve, ms), ctx.signal?.addEventListener('abort', () => reject(ctx.signal!.reason), { once: true })));
    return items.map((item) => ({ json: { got: item.json } }));
  },
});

const plugin = definePlugin({ info: { id: 'mcpdemo', name: 'MCP demo', version: '1.0.0', description: 'A demo for the MCP face' }, nodes: [greet, free], credentialTypes: [api] });

const quietTelemetry = (exporter?: InMemorySpanExporter) =>
  createTelemetry({ pluginId: 'mcpdemo', env: exporter ? { OTEL_SDK_DISABLED: 'false', OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' } : { OTEL_SDK_DISABLED: 'true' }, logWriter: () => {}, ...(exporter && { spanExporters: [exporter] }) });

const running: ServeResult[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  await Promise.all(running.splice(0).map((result) => result.stop()));
  for (const key of ['LANDFLOW_MCP', 'LANDFLOW_MCP_TOKEN', 'LANDFLOW_MCP_CREDENTIALS', 'LANDFLOW_TRANSPORTS']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('configuration', () => {
  it('mcpMode: the flag, then LANDFLOW_MCP, then the option; http by default', () => {
    expect(mcpMode(undefined, {}, [])).toBe('http');
    expect(mcpMode(false, {}, [])).toBe('off');
    expect(mcpMode({ enabled: false }, {}, [])).toBe('off');
    expect(mcpMode({ stdio: true }, {}, [])).toBe('stdio');
    expect(mcpMode(undefined, { LANDFLOW_MCP: 'off' }, [])).toBe('off');
    expect(mcpMode({ stdio: true }, { LANDFLOW_MCP: 'on' }, [])).toBe('stdio');
    expect(mcpMode(false, { LANDFLOW_MCP: 'stdio' }, [])).toBe('stdio');
    expect(mcpMode(false, { LANDFLOW_MCP: 'off' }, ['node', 'main.ts', '--mcp-stdio'])).toBe('stdio');
    expect(() => mcpMode(undefined, { LANDFLOW_MCP: 'maybe' }, [])).toThrow(/one of on, off, stdio/);
  });

  it('isLoopbackHost', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'example.com', undefined]) expect(isLoopbackHost(host), String(host)).toBe(false);
  });

  it('loadMcpCredentials: inline JSON or a file, keyed by local type name; clear errors', () => {
    expect(loadMcpCredentials(undefined)).toEqual({});
    expect(loadMcpCredentials('{"demoApi":{"accessToken":"t"},"messaging.slackApi":{"token":"x"}}')).toEqual({ demoApi: { accessToken: 't' }, slackApi: { token: 'x' } });
    const dir = mkdtempSync(join(tmpdir(), 'landflow-mcp-'));
    const file = join(dir, 'credentials.json');
    writeFileSync(file, JSON.stringify({ demoApi: { accessToken: 'from-file' } }));
    expect(loadMcpCredentials(file)).toEqual({ demoApi: { accessToken: 'from-file' } });
    expect(() => loadMcpCredentials('{not json')).toThrow(/not valid JSON/);
    expect(() => loadMcpCredentials('[]')).toThrow(/JSON object keyed by credential type/);
    expect(() => loadMcpCredentials('{"demoApi":"nope"}')).toThrow(/must be an object of fields/);
  });

  it('bearerTokenMatches is case-insensitive on the scheme and exact on the token', () => {
    expect(bearerTokenMatches('Bearer abc', 'abc')).toBe(true);
    expect(bearerTokenMatches('bearer abc', 'abc')).toBe(true);
    expect(bearerTokenMatches('Bearer abcd', 'abc')).toBe(false);
    expect(bearerTokenMatches('Basic abc', 'abc')).toBe(false);
    expect(bearerTokenMatches(null, 'abc')).toBe(false);
  });

  it('toolResultFromResponse: structuredContent { items } plus a text; isError for a node error', () => {
    expect(toolResultFromResponse({ outputs: [[{ json: { a: 1 } }]] })).toEqual({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { items: [{ a: 1 }] } });
    expect(toolResultFromResponse({ outputs: [[{ json: { a: 1 } }, { json: { a: 2 } }]] }, ['x'])).toMatchObject({ content: [{ type: 'text', text: expect.stringMatching(/^2 items .*x\)$/) }], structuredContent: { items: [{ a: 1 }, { a: 2 }] } });
    expect(toolResultFromResponse({ outputs: [], error: { message: 'boom', description: 'why' } })).toEqual({ isError: true, content: [{ type: 'text', text: 'boom\nwhy' }] });
  });
});

describe('the face over a dispatcher', () => {
  const face = async (credentials = {}) => createMcpFace({ dispatcher: createDispatcher(plugin, { telemetry: await quietTelemetry() }), loopback: true, credentials });

  it('lists the tools of the manifest without _meta, and list_options only with a credential and dynamic options', async () => {
    const bare = await face();
    expect(bare.tools.map((t) => t.name)).toEqual(['greet', 'free']);
    expect(bare.tools[0]).not.toHaveProperty('_meta');
    expect(bare.tools[0]!.outputSchema).toEqual({ type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { greeting: { type: 'string' } } } } }, required: ['items'] });
    const configured = await face({ demoApi: { accessToken: 'secret-token' } });
    expect(configured.tools.map((t) => t.name)).toEqual(['greet', 'free', LIST_OPTIONS_TOOL]);
  });

  it('over an in-memory transport (the stdio path): a missing credential is a tool error naming the type and fields; a configured one runs; list_options resolves', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = await serveMcpStdio(await face(), { transport: serverSide });
    const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(clientSide);
    const missing = await client.callTool({ name: 'greet', arguments: { name: 'x' } });
    expect(missing.isError).toBe(true);
    expect((missing.content[0] as { text: string }).text).toMatch(/demoApi \(fields: accessToken, baseUrl\).*LANDFLOW_MCP_CREDENTIALS/);
    const ok = await client.callTool({ name: 'free', arguments: { anything: 1 } });
    expect(ok.structuredContent).toEqual({ items: [{ got: { anything: 1 } }] });
    await client.close();
    await handle.close();

    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const h2 = await serveMcpStdio(await face({ demoApi: { accessToken: 'secret-token' } }), { transport: s2 });
    const client2 = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await client2.connect(c2);
    const tools = await client2.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['greet', 'free', LIST_OPTIONS_TOOL]);
    const result = await client2.callTool({ name: 'greet', arguments: { name: 'Ada' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ items: [{ greeting: 'hello Ada', tokenLength: 12, channel: '' }] });
    const failed = await client2.callTool({ name: 'greet', arguments: { name: 'boom' } });
    expect(failed).toMatchObject({ isError: true, content: [{ type: 'text', text: 'boom\nasked to fail' }] });
    const options = await client2.callTool({ name: LIST_OPTIONS_TOOL, arguments: { tool: 'greet', parameter: 'channel' } });
    expect(options.structuredContent).toEqual({ options: [{ name: 'token 12', value: 'general' }] });
    await expect(client2.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool "nope"/);
    await client2.close();
    await h2.close();
  });
});

describe('serve() and /mcp', () => {
  it('is off with LANDFLOW_MCP=off and when the port is not loopback and no token is set (the plugin still serves)', async () => {
    process.env.LANDFLOW_MCP = 'off';
    const off = await serve(plugin, { http: HTTP_PORT, host: '127.0.0.1', registryUrl: false, telemetry: await quietTelemetry() });
    running.push(off);
    expect(off.transports).toEqual(['http']);
    expect(off.mcp).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, { method: 'POST' })).status).toBe(404);
    expect(((await (await fetch(`http://127.0.0.1:${HTTP_PORT}/.well-known/landflow`)).json()) as { endpoints: { mcp?: string } }).endpoints.mcp).toBeUndefined();
    await off.stop();
    running.pop();

    delete process.env.LANDFLOW_MCP;
    const lines: string[] = [];
    const telemetry = await createTelemetry({ pluginId: 'mcpdemo', env: { OTEL_SDK_DISABLED: 'true' }, logWriter: (line) => lines.push(line) });
    const noToken = await serve(plugin, { http: HTTP_PORT, registryUrl: false, telemetry });
    running.push(noToken);
    expect(noToken.transports).toEqual(['http']);
    expect(lines.some((line) => /MCP face not started/.test(line) && /LANDFLOW_MCP_TOKEN/.test(line))).toBe(true);
    expect((await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, { method: 'POST' })).status).toBe(404);

    process.env.LANDFLOW_TRANSPORTS = 'http,mcp';
    await expect(serve(plugin, { http: HTTP_PORT + 1, registryUrl: false, telemetry: await quietTelemetry() })).rejects.toThrow(/names "mcp" but the MCP face is MCP face not started/);
  });

  it('serves /mcp with a token on a non-loopback host: 401 without it, both protocol revisions with it, spans carry mcp.tool.name', async () => {
    process.env.LANDFLOW_MCP_TOKEN = TOKEN;
    process.env.LANDFLOW_MCP_CREDENTIALS = JSON.stringify({ demoApi: { accessToken: 'secret-token' } });
    const exporter = new InMemorySpanExporter();
    const result = await serve(plugin, { http: HTTP_PORT, registryUrl: false, telemetry: await quietTelemetry(exporter) });
    running.push(result);
    expect(result.transports).toEqual(['http', 'mcp']);
    expect(result.mcp?.tools.map((t) => t.name)).toEqual(['greet', 'free', LIST_OPTIONS_TOOL]);
    const url = `http://127.0.0.1:${HTTP_PORT}/mcp`;
    expect(((await (await fetch(`http://127.0.0.1:${HTTP_PORT}/.well-known/landflow`)).json()) as { endpoints: { mcp?: string } }).endpoints.mcp).toBe('/mcp');

    const unauthorized = await mcpRequest(url, 'tools/list', {});
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toMatch(/^Bearer realm=/);
    expect((await mcpRequest(url, 'tools/list', {}, { token: 'wrong' })).status).toBe(401);

    // 2026-07-28: the official client pinned to that revision.
    const modern = new Client({ name: 'modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await modern.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    expect((await modern.listTools()).tools.map((t) => t.name)).toEqual(['greet', 'free', LIST_OPTIONS_TOOL]);
    const called = await modern.callTool({ name: 'greet', arguments: { name: 'Grace', extra: true } });
    expect(called.structuredContent).toEqual({ items: [{ greeting: 'hello Grace', tokenLength: 12, channel: '' }] });
    expect((called.content[0] as { text: string }).text).toMatch(/passed only as input item fields: extra/);
    await modern.close();

    // 2025-11-25: the legacy handshake (initialize) on the same endpoint.
    const legacy = new Client({ name: 'legacy', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    await legacy.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    expect((await legacy.listTools()).tools.map((t) => t.name)).toEqual(['greet', 'free', LIST_OPTIONS_TOOL]);
    expect((await legacy.callTool({ name: 'free', arguments: { n: 1 } })).structuredContent).toEqual({ items: [{ got: { n: 1 } }] });
    await legacy.close();

    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'plugin.execute mcpdemo.greet');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(spans[0]!.attributes).toMatchObject({ 'rpc.system': 'mcp', 'mcp.tool.name': 'greet', 'landflow.execution.mode': 'mcp' });
  });

  it('needs no token on loopback, and the request stream closing cancels the call', async () => {
    const result = await serve(plugin, { http: HTTP_PORT, host: '127.0.0.1', registryUrl: false, telemetry: await quietTelemetry() });
    running.push(result);
    const url = `http://127.0.0.1:${HTTP_PORT}/mcp`;
    const listed = await mcpRequest(url, 'tools/list', {});
    expect(listed.status).toBe(200);
    expect((listed.body?.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['greet', 'free']);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(mcpRequest(url, 'tools/call', { name: 'free', arguments: { ms: 2_000 } }, { signal: controller.signal, name: 'free' })).rejects.toThrow();
    expect(result.dispatcher.inFlight).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.dispatcher.inFlight).toBe(0);
    // The face is still healthy after a client went away.
    expect((await mcpRequest(url, 'tools/call', { name: 'free', arguments: { ok: 1 } }, { name: 'free' })).body?.result).toMatchObject({ structuredContent: { items: [{ got: { ok: 1 } }] } });
  });
});
