/**
 * MCP both ways, on the MCP SDK v2. Client side: real MCP servers on a random port, reached by the client library,
 * the MCP Client Tool under an AI Agent (fake OpenAI model), the MCP Client node and agents' MCP servers:
 * - /mcp: a 2026-07-28 endpoint (`createMcpHandler`: `server/discover`, the `_meta` envelope; stateless);
 * - /legacy: a 2025-era Streamable HTTP endpoint with sessions (`initialize`, `Mcp-Session-Id`), as older servers
 *   still are, to check the client negotiates down and reconnects when a session is forgotten;
 * - /sse: the older SSE transport (a small hand-rolled server transport: v2 ships none).
 * Server side: the SDK's client against the MCP Server Trigger route (/mcp/<path>) and the instance server (/api/mcp),
 * called in-process through the route handlers, plus raw 2025-11-25 and 2026-07-28 requests.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer, WebStandardStreamableHTTPServerTransport, type CallToolResult, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/server';
import { runLoadOptions } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';
import type { Agent, AgentConfig } from '@/lib/shared/agents';
import { closedPort, startFakeOpenAi, type ChatReply, type FakeServer } from './fake-openai';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://mcp.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { credentials } = await import('@/lib/server/credentials/vault');
const { callMcpTool, closeMcpClients, endpointFrom, listMcpTools, selectTools } = await import('@/lib/server/mcp/client');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const { mcpClientNode, mcpClientToolNode } = await import('@/lib/server/nodes/mcp');
const { buildToolset } = await import('@/lib/server/agents/tools');
const { outputsOf, run, runFlow } = await import('./helpers');
const triggerRoute = await import('@/app/mcp/[...path]/route');
const instanceRoute = await import('@/app/api/mcp/route');
const settingsRoute = await import('@/app/api/settings/mcp/route');

registry.registerBuiltin(corePlugin);

// ---------------------------------------------------------------------------
// Remote MCP servers (node:http in front of web-standard handlers)
// ---------------------------------------------------------------------------

const BEARER = 'secret-token';
const API_KEY = 'k-123';

function remoteServer() {
  const server = new McpServer({ name: 'test-tools', version: '1.0.0' });
  server.registerTool('add', { description: 'Add two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }));
  server.registerTool('echo', { description: 'Echo a message', inputSchema: z.object({ message: z.string().describe('What to echo') }) }, async ({ message }) => ({
    content: [{ type: 'text', text: message }],
  }));
  server.registerTool(
    'weather',
    { description: 'The weather in a city', inputSchema: z.object({ city: z.string() }), outputSchema: z.object({ city: z.string(), tempC: z.number() }) },
    async ({ city }) => ({ content: [{ type: 'text', text: JSON.stringify({ city, tempC: 21 }) }], structuredContent: { city, tempC: 21 } }),
  );
  server.registerTool('fail', { description: 'Always fails' }, async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }));
  return server;
}

/** A node request as a web-standard Request (the body streamed). */
function toWebRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
  return new Request(new URL(req.url ?? '/', origin), { method, headers, body, ...(body && { duplex: 'half' }) } as RequestInit);
}

async function sendWebResponse(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

/** The older SSE transport, server side (GET opens the stream and names the POST endpoint; each POST is one message). */
class SseServerTransport implements Transport {
  readonly sessionId = randomUUID();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  constructor(
    private readonly res: ServerResponse,
    private readonly endpoint: string,
  ) {}
  async start() {
    this.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    this.res.write(`event: endpoint\ndata: ${this.endpoint}?sessionId=${this.sessionId}\n\n`);
    this.res.on('close', () => this.onclose?.());
  }
  async send(message: JSONRPCMessage) {
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }
  async close() {
    this.res.end();
  }
  handlePost(body: string) {
    this.onmessage?.(JSON.parse(body) as JSONRPCMessage);
  }
}

const modern = createMcpHandler(() => remoteServer());
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
const sseSessions = new Map<string, SseServerTransport>();
const seen: Array<{ method: string; path: string; authorization?: string; apiKey?: string }> = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', origin);
  seen.push({ method: req.method ?? '', path: url.pathname, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined });
  const deny = () => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
  if (url.pathname.startsWith('/secure/') && req.headers.authorization !== `Bearer ${BEARER}`) return deny();
  if (url.pathname.startsWith('/header/') && req.headers['x-api-key'] !== API_KEY) return deny();
  const path = url.pathname.replace(/^\/(secure|header)/, '');

  if (path === '/mcp') return sendWebResponse(res, await modern.fetch(toWebRequest(req, origin)));
  if (path === '/legacy') {
    const id = req.headers['mcp-session-id'] as string | undefined;
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      if (id) return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
      const created = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => void sessions.set(sid, created) });
      created.onclose = () => void (created.sessionId && sessions.delete(created.sessionId));
      await remoteServer().connect(created);
      transport = created;
    }
    return sendWebResponse(res, await transport.handleRequest(toWebRequest(req, origin)));
  }
  if (path === '/sse' && req.method === 'GET') {
    const transport = new SseServerTransport(res, url.pathname.replace(/sse$/, 'messages'));
    sseSessions.set(transport.sessionId, transport);
    res.on('close', () => sseSessions.delete(transport.sessionId));
    await remoteServer().connect(transport);
    return;
  }
  if (path === '/messages' && req.method === 'POST') {
    const transport = sseSessions.get(url.searchParams.get('sessionId') ?? '');
    if (!transport) return res.writeHead(404).end('Unknown session');
    transport.handlePost(await readBody(req));
    return res.writeHead(202).end('Accepted');
  }
  res.writeHead(404).end('Not found');
}

const remote = createServer((req, res) => void handle(req, res).catch((error) => res.writeHead(500).end(String(error))));
let origin = '';
let fake: FakeServer;

/** Model turns: call `add` when it is offered, else list the tool names it was given; after a tool result, the default answer. */
function chat(body: { messages: Array<{ role: string }>; tools?: Array<{ function: { name: string } }> }): ChatReply | undefined {
  const names = (body.tools ?? []).map((tool) => tool.function.name);
  if (body.messages[body.messages.length - 1].role === 'tool') return undefined;
  if (names.includes('add')) {
    return {
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] },
      finish_reason: 'tool_calls',
    };
  }
  return { message: { role: 'assistant', content: `tools: ${names.join(',')}` }, finish_reason: 'stop' };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  fake = await startFakeOpenAi({ chat });
});

afterAll(async () => {
  await closeMcpClients();
  await closeMcpEndpoints();
  await modern.close();
  remote.closeAllConnections();
  await new Promise<void>((resolve) => remote.close(() => resolve()));
  await fake.close();
  waits.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const text = (result: CallToolResult | { content?: unknown }) =>
  ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

// ---------------------------------------------------------------------------
// Client library
// ---------------------------------------------------------------------------

describe('MCP client library', () => {
  it('lists and calls tools on a 2026-07-28 server (server/discover, no initialize)', async () => {
    const endpoint = endpointFrom({ endpointUrl: `${origin}/mcp` }, {});
    const tools = await listMcpTools(endpoint);
    expect(tools.map((t) => t.name)).toEqual(['add', 'echo', 'weather', 'fail']);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] });
    expect(text(await callMcpTool(endpoint, 'add', { a: 2, b: 40 }))).toBe('42');
    expect(await callMcpTool(endpoint, 'weather', { city: 'Oslo' })).toMatchObject({ structuredContent: { city: 'Oslo', tempC: 21 } });
    expect(await callMcpTool(endpoint, 'fail', {})).toMatchObject({ isError: true, content: [{ type: 'text', text: 'it broke' }] });
    expect(seen.some((r) => r.path === '/mcp')).toBe(true);
  });

  it('negotiates down to a 2025-era server with sessions, reusing one session', async () => {
    const endpoint = endpointFrom({ endpointUrl: `${origin}/legacy` }, {});
    const before = sessions.size;
    const tools = await listMcpTools(endpoint);
    expect(tools.map((t) => t.name)).toEqual(['add', 'echo', 'weather', 'fail']);
    expect(sessions.size).toBe(before + 1);
    expect(text(await callMcpTool(endpoint, 'add', { a: 2, b: 40 }))).toBe('42');
    expect(await callMcpTool(endpoint, 'weather', { city: 'Oslo' })).toMatchObject({ structuredContent: { city: 'Oslo', tempC: 21 } });
    expect(sessions.size).toBe(before + 1);
  });

  it('reconnects once when the server forgot the session', async () => {
    const endpoint = endpointFrom({ endpointUrl: `${origin}/legacy` }, {});
    await listMcpTools(endpoint);
    sessions.clear();
    expect(text(await callMcpTool(endpoint, 'echo', { message: 'again' }))).toBe('again');
  });

  it('speaks the older SSE transport', async () => {
    const endpoint = endpointFrom({ endpointUrl: `${origin}/sse`, serverTransport: 'sse' }, {});
    expect((await listMcpTools(endpoint)).map((t) => t.name)).toContain('echo');
    expect(text(await callMcpTool(endpoint, 'echo', { message: 'over sse' }))).toBe('over sse');
  });

  it('sends the credential’s bearer token or header, and explains a rejection', async () => {
    const bearer = endpointFrom({ endpointUrl: `${origin}/secure/mcp`, authentication: 'bearerAuth' }, { httpBearerAuth: { token: BEARER } });
    expect(await listMcpTools(bearer)).toHaveLength(4);
    expect(seen.filter((r) => r.path === '/secure/mcp').at(-1)?.authorization).toBe(`Bearer ${BEARER}`);
    const header = endpointFrom({ endpointUrl: `${origin}/header/mcp`, authentication: 'headerAuth' }, { httpHeaderAuth: { name: 'X-Api-Key', value: API_KEY } });
    expect(text(await callMcpTool(header, 'add', { a: 1, b: 1 }))).toBe('2');

    const wrong = endpointFrom({ endpointUrl: `${origin}/secure/mcp`, authentication: 'bearerAuth' }, { httpBearerAuth: { token: 'nope' } });
    await expect(listMcpTools(wrong)).rejects.toThrow(/rejected the credentials \(401\)/);
    expect(() => endpointFrom({ endpointUrl: `${origin}/secure/mcp`, authentication: 'bearerAuth' }, {})).toThrow(/Bearer Auth credential/);
    expect(() => endpointFrom({ endpointUrl: 'ftp://x' }, {})).toThrow(/http/);
    await expect(listMcpTools(endpointFrom({ endpointUrl: `http://127.0.0.1:${await closedPort()}/mcp` }, {}))).rejects.toThrow(/Cannot connect/);
  });

  it('returns an unknown tool or bad arguments as an error result', async () => {
    const endpoint = endpointFrom({ endpointUrl: `${origin}/mcp` }, {});
    const unknown = await callMcpTool(endpoint, 'nope', {});
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/nope/);
    expect((await callMcpTool(endpoint, 'add', { a: 'x' })).isError).toBe(true);
  });

  it('selects all, some, or all but some tools', () => {
    const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(selectTools(tools, 'all', ['a'], ['b']).map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(selectTools(tools, 'selected', ['a', 'c'], []).map((t) => t.name)).toEqual(['a', 'c']);
    expect(selectTools(tools, 'except', [], ['b']).map((t) => t.name)).toEqual(['a', 'c']);
  });
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

describe('MCP Client Tool', () => {
  const agentFlow = (parameters: Record<string, unknown>, toolCredentials?: Record<string, Record<string, string>>) =>
    runFlow(
      [
        { name: 'Agent', type: 'core.aiAgent', parameters: { prompt: 'What is 2 + 3?' } },
        { name: 'Model', type: 'core.openAiChatModel', parameters: { model: 'gpt-test' }, credentials: { openAiApi: { baseUrl: fake.url } } },
        { name: 'MCP', type: 'core.mcpClientTool', parameters, ...(toolCredentials && { credentials: toolCredentials }) },
      ],
      [
        ['Start', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['MCP', 'Agent', 'ai_tool'],
      ],
    );

  it('gives the AI Agent every tool of the server, with its schema, and runs the calls', async () => {
    const result = await agentFlow({ endpointUrl: `${origin}/secure/mcp`, authentication: 'bearerAuth' }, { httpBearerAuth: { token: BEARER } });
    const [answer] = outputsOf(result, 'Agent')[0];
    expect(answer.output).toBe('The answer is 5');
    expect(answer.steps).toMatchObject([{ input: { a: 2, b: 3 }, output: '5' }]);
    const offered = fake.requests.filter((r) => r.path === '/v1/chat/completions').at(-2)!.body.tools;
    expect(offered.map((t: { function: { name: string } }) => t.function.name)).toEqual(['add', 'echo', 'weather', 'fail']);
    expect(offered[1].function).toMatchObject({ description: 'Echo a message', parameters: { type: 'object', properties: { message: { type: 'string', description: 'What to echo' } } } });
    // The call shows up as a run of the MCP Client Tool.
    expect(result.runData.MCP.some((r) => r.source === 'tool' && r.status === 'success')).toBe(true);
  });

  it('offers only the selected tools, or all except some', async () => {
    const selected = await agentFlow({ endpointUrl: `${origin}/mcp`, include: 'selected', includeTools: ['echo', 'weather'] });
    expect(outputsOf(selected, 'Agent')[0][0].output).toBe('tools: echo,weather');
    const except = await agentFlow({ endpointUrl: `${origin}/mcp`, include: 'except', excludeTools: ['add', 'fail'] });
    expect(outputsOf(except, 'Agent')[0][0].output).toBe('tools: echo,weather');
  });

  it('fails the run clearly when the server rejects the credential', async () => {
    const result = await agentFlow({ endpointUrl: `${origin}/secure/mcp`, authentication: 'bearerAuth' }, { httpBearerAuth: { token: 'wrong' } });
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/rejected the credentials \(401\)/);
  });

  it('loads the tool list for the pickers', async () => {
    const options = await runLoadOptions(mcpClientToolNode, 'tools', { endpointUrl: `${origin}/header/mcp`, authentication: 'headerAuth' }, { httpHeaderAuth: { name: 'x-api-key', value: API_KEY } });
    expect(options).toContainEqual({ name: 'add', value: 'add', description: 'Add two numbers' });
    expect(options).toHaveLength(4);
  });
});

describe('MCP Client node', () => {
  const params = (extra: Record<string, unknown>) => ({ endpointUrl: `${origin}/mcp`, ...extra });

  it('calls a tool per item and outputs its text, content and structured content', async () => {
    const add = await run(mcpClientNode, params({ tool: 'add', arguments: '{"a": 1, "b": 2}' }), [{}, {}]);
    expect(add.error).toBeUndefined();
    expect(add.json()).toEqual([
      { tool: 'add', text: '3', content: [{ type: 'text', text: '3' }] },
      { tool: 'add', text: '3', content: [{ type: 'text', text: '3' }] },
    ]);
    const weather = await run(mcpClientNode, params({ tool: 'weather', arguments: { city: 'Rome' } }));
    expect(weather.json()[0]).toMatchObject({ tool: 'weather', structuredContent: { city: 'Rome', tempC: 21 } });
  });

  it('fails on an error result, bad arguments, or a missing tool', async () => {
    expect((await run(mcpClientNode, params({ tool: 'fail' }))).error?.message).toBe('fail returned an error: it broke');
    expect((await run(mcpClientNode, params({ tool: 'add', arguments: '{oops' }))).error?.message).toMatch(/not valid JSON/);
    expect((await run(mcpClientNode, params({ tool: 'add', arguments: '[1]' }))).error?.message).toMatch(/must be a JSON object/);
    expect((await run(mcpClientNode, params({ tool: '' }))).error?.message).toBe('Choose a tool');
  });

  it('uses the credential', async () => {
    const ok = await run(mcpClientNode, { endpointUrl: `${origin}/secure/mcp`, authentication: 'bearerAuth', tool: 'echo', arguments: '{"message":"hi"}' }, [{}], {
      httpBearerAuth: { token: BEARER },
    });
    expect(ok.json()[0]).toMatchObject({ text: 'hi' });
    const denied = await run(mcpClientNode, { endpointUrl: `${origin}/secure/mcp`, authentication: 'bearerAuth', tool: 'echo' }, [{}], { httpBearerAuth: { token: 'bad' } });
    expect(denied.error?.message).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe('Agents with MCP servers', () => {
  const agentWith = (tools: AgentConfig['tools']) => {
    const config = { name: 'MCP agent', skills: [], memory: { crossSession: false }, tools } as unknown as AgentConfig;
    return { agent: { id: 'ag_mcp', ...config } as unknown as Agent, config };
  };

  it('offers each tool of the server, through the credential vault, and calls them', async () => {
    const credential = credentials.create({ name: 'Remote MCP', type: 'core.httpBearerAuth', data: { token: BEARER } });
    const { agent, config } = agentWith([
      {
        id: 'tool_mcp',
        type: 'mcp',
        name: 'Remote',
        parameters: { endpointUrl: `${origin}/secure/mcp`, authentication: 'bearerAuth', include: 'except', excludeTools: ['fail'] },
        credentials: { httpBearerAuth: { id: credential.id, name: credential.name } },
        requireApproval: true,
      },
      { id: 'tool_down', type: 'mcp', name: 'Down', parameters: { endpointUrl: `http://127.0.0.1:${await closedPort()}/mcp` } },
    ]);
    const { tools, unavailable } = await buildToolset(agent, config);
    expect(tools.map((t) => t.name)).toEqual(['add', 'echo', 'weather']);
    expect(tools[0]).toMatchObject({ kind: 'node', nodeType: 'core.mcpClientTool', label: 'Remote · add', requireApproval: true });
    expect(unavailable).toEqual([expect.stringMatching(/^Down: Cannot connect/)]);
    const add = tools.find((t) => t.name === 'add')!;
    expect(await add.invoke({ a: 20, b: 22 }, {} as Parameters<typeof add.invoke>[1])).toEqual({ output: '42' });
  });
});

// ---------------------------------------------------------------------------
// MCP Server Trigger (/mcp/<path>)
// ---------------------------------------------------------------------------

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
type Route = { GET: Handler; POST: Handler; DELETE: Handler };

/** A fetch that answers through a route module's handlers (and records the statuses). */
function routeFetch(route: Route, statuses: number[] = []) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const segments = new URL(request.url).pathname.split('/').filter(Boolean).slice(1);
    const response = await route[request.method as keyof Route](request, { params: Promise.resolve({ path: segments }) });
    statuses.push(response.status);
    return response;
  };
}

/** A v2 client against a route; `legacy` pins the 2025-11-25 handshake (an older agent), the default negotiates 2026-07-28. */
async function connect(url: string, route: Route, headers: Record<string, string> = {}, legacy = false) {
  const client = new Client({ name: 'landflow-test', version: '1.0.0' }, { versionNegotiation: { mode: legacy ? 'legacy' : 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: routeFetch(route), requestInit: { headers } }));
  return client;
}

describe('MCP Server Trigger', () => {
  const trigger = triggerRoute as unknown as Route;
  const save = (id: string, path: string, extra: Partial<Workflow> & { trigger?: Record<string, unknown>; credentials?: Record<string, { id: string; name: string }> } = {}) => {
    const { trigger: triggerParameters, credentials: triggerCredentials, ...rest } = extra;
    return store.saveWorkflow({
      id,
      name: `Tools ${id}`,
      active: true,
      nodes: [
        {
          id: 'mcp',
          name: 'MCP Server',
          type: 'core.mcpTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: { path, ...triggerParameters },
          ...(triggerCredentials && { credentials: triggerCredentials }),
        },
        { id: 'calc', name: 'Calculator', type: 'core.calculatorTool', typeVersion: 1, position: [0, 200], parameters: {} },
        {
          id: 'greet',
          name: 'Greet',
          type: 'core.executeWorkflow',
          typeVersion: 1,
          position: [200, 200],
          notes: 'Greet someone by name',
          parameters: {
            workflowId: 'wf_mcp_child',
            inputSource: 'map',
            workflowInputs: { values: [{ name: 'name', value: "{{ $fromAI('name', 'Who to greet', 'string') }}" }] },
          },
        },
      ],
      connections: [
        { id: 'c1', type: 'ai_tool', source: 'calc', target: 'mcp', sourceIndex: 0, targetIndex: 0 },
        { id: 'c2', type: 'ai_tool', source: 'greet', target: 'mcp', sourceIndex: 0, targetIndex: 0 },
      ],
      ...rest,
    } as Workflow);
  };

  beforeAll(() => {
    store.saveWorkflow({
      id: 'wf_mcp_child',
      name: 'Greeter',
      nodes: [
        { id: 'called', name: 'Called', type: 'core.workflowTrigger', typeVersion: 1, position: [0, 0], parameters: { inputs: { fields: [{ name: 'name', type: 'string', required: true }] } } },
        {
          id: 'set',
          name: 'Greeting',
          type: 'core.set',
          typeVersion: 1,
          position: [200, 0],
          parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'greeting', type: 'string', value: 'Hello {{ $json.name }}' }] } },
        },
      ],
      connections: [{ id: 'c1', type: 'main', source: 'called', target: 'set', sourceIndex: 0, targetIndex: 0 }],
    } as Workflow);
    save('wf_mcp_tools', 'team/tools', { trigger: { instructions: 'Math and greetings.' } });
  });

  it('initializes, lists the attached tools with their schemas, and calls them as executions with mode mcp', async () => {
    const client = await connect('http://mcp.test/mcp/team/tools', trigger);
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()).toMatchObject({ name: 'landflow', title: 'Tools wf_mcp_tools' });
    expect(client.getInstructions()).toBe('Math and greetings.');
    // An older agent: the 2025-11-25 handshake on the same route.
    const older = await connect('http://mcp.test/mcp/team/tools', trigger, {}, true);
    expect(older.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect((await older.listTools()).tools.map((t) => t.name)).toEqual(['Calculator', 'Greet']);
    await older.close();

    const executions = () => store.listExecutions({ workflowId: 'wf_mcp_tools' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['Calculator', 'Greet']);
    expect(tools[1]).toMatchObject({
      description: 'Greet someone by name',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Who to greet' } }, required: ['name'] },
    });
    expect(executions()).toHaveLength(0);

    const sum = (await client.callTool({ name: 'Calculator', arguments: { expression: '6*7' } })) as CallToolResult;
    expect(sum.isError).toBeFalsy();
    expect(JSON.parse(text(sum))).toMatchObject({ result: 42 });

    const greeting = (await client.callTool({ name: 'Greet', arguments: { name: 'Ada' } })) as CallToolResult;
    expect(greeting.isError).toBeFalsy();
    expect(JSON.parse(text(greeting))).toEqual({ greeting: 'Hello Ada' });

    const recorded = executions();
    expect(recorded).toHaveLength(2);
    expect(recorded.every((e) => e.mode === 'mcp' && e.status === 'success')).toBe(true);
    const record = store.getExecution(recorded[0].id)!;
    expect(record.runData.greet?.[0]).toMatchObject({ source: 'tool', status: 'success' });
    expect(store.listExecutions({ workflowId: 'wf_mcp_child' })).toHaveLength(1);

    const unknown = (await client.callTool({ name: 'nope', arguments: {} })) as CallToolResult;
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/Unknown tool "nope"/);
    await client.close();
  });

  it('checks bearer and header auth', async () => {
    const bearer = credentials.create({ name: 'Trigger token', type: 'core.httpBearerAuth', data: { token: 'trigger-secret' } });
    const header = credentials.create({ name: 'Trigger key', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: 'trigger-key' } });
    save('wf_mcp_bearer', 'secure', { trigger: { authentication: 'bearerAuth' }, credentials: { httpBearerAuth: { id: bearer.id, name: bearer.name } } });
    save('wf_mcp_header', 'keyed', { trigger: { authentication: 'headerAuth' }, credentials: { httpHeaderAuth: { id: header.id, name: header.name } } });

    await expect(connect('http://mcp.test/mcp/secure', trigger)).rejects.toMatchObject({ status: 401 });
    await expect(connect('http://mcp.test/mcp/secure', trigger, { Authorization: 'Bearer wrong' })).rejects.toMatchObject({ status: 401 });
    const ok = await connect('http://mcp.test/mcp/secure', trigger, { Authorization: 'Bearer trigger-secret' });
    expect((await ok.listTools()).tools).toHaveLength(2);
    await ok.close();

    await expect(connect('http://mcp.test/mcp/keyed', trigger, { 'X-Api-Key': 'wrong' })).rejects.toMatchObject({ status: 401 });
    const keyed = await connect('http://mcp.test/mcp/keyed', trigger, { 'X-Api-Key': 'trigger-key' });
    expect((await keyed.callTool({ name: 'Calculator', arguments: { expression: '1+1' } })).isError).toBeFalsy();
    await keyed.close();

    const raw = await trigger.POST(new Request('http://mcp.test/mcp/secure', { method: 'POST', body: '{}' }), { params: Promise.resolve({ path: ['secure'] }) });
    expect(raw.status).toBe(401);
    expect(raw.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('answers 404 for an inactive workflow or an unknown path, and 405 for GET', async () => {
    save('wf_mcp_inactive', 'sleeping', { active: false });
    await expect(connect('http://mcp.test/mcp/sleeping', trigger)).rejects.toMatchObject({ status: 404 });
    await expect(connect('http://mcp.test/mcp/nothing-here', trigger)).rejects.toMatchObject({ status: 404 });
    const get = await trigger.GET(new Request('http://mcp.test/mcp/team/tools'), { params: Promise.resolve({ path: ['team', 'tools'] }) });
    expect(get.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Instance MCP server (/api/mcp)
// ---------------------------------------------------------------------------

describe('Instance MCP server', () => {
  const instance = instanceRoute as unknown as Route;
  const settings = settingsRoute as unknown as { GET: Handler; PATCH: Handler; POST: Handler };
  const URL_ = 'http://mcp.test/api/mcp';
  const initialize = (token?: string) =>
    instance.POST(
      new Request(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      }),
    );
  const patch = async (enabled: boolean) =>
    (await settings.PATCH(new Request('http://mcp.test/api/settings/mcp', { method: 'PATCH', body: JSON.stringify({ enabled }) }))).json() as Promise<{
      access: { enabled: boolean; hasToken: boolean; tokenHint?: string };
      token?: string;
    }>;
  let token = '';
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { result, data: result.isError ? undefined : JSON.parse(text(result)) };
  };

  it('is off by default (403), and needs the token once on (401)', async () => {
    expect((await (await settings.GET(new Request('http://mcp.test/api/settings/mcp'))).json()).access).toMatchObject({ enabled: false, hasToken: false });
    expect((await initialize()).status).toBe(403);

    const on = await patch(true);
    expect(on.access).toMatchObject({ enabled: true, hasToken: true });
    expect(on.token).toMatch(/^lf_mcp_/);
    expect(on.access.tokenHint).toBe(on.token!.slice(-4));
    token = on.token!;
    // Turning it on again keeps the token and doesn't show it.
    expect((await patch(true)).token).toBeUndefined();

    expect((await initialize()).status).toBe(401);
    expect((await initialize('lf_mcp_wrong')).status).toBe(401);
    expect((await initialize(token)).status).toBe(200);

    client = await connect(URL_, instance, { Authorization: `Bearer ${token}` });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'create_workflow',
        'execute_workflow',
        'get_execution',
        'get_node_type',
        'get_workflow',
        'list_executions',
        'list_node_types',
        'list_workflows',
        'search_node_types',
        'update_workflow',
        'validate_workflow',
      ].sort(),
    );
    expect(client.getInstructions()).toMatch(/workflow/i);
  });

  it('finds node types and their parameters', async () => {
    const triggers = (await call('list_node_types', { kind: 'trigger' })).data;
    expect(triggers.nodeTypes.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['core.manualTrigger', 'core.webhook', 'core.mcpTrigger']));
    expect(triggers.nodeTypes.every((t: { kind: string }) => t.kind === 'trigger')).toBe(true);

    const search = (await call('search_node_types', { query: 'mcp client' })).data;
    expect(search.nodeTypes.slice(0, 2).map((t: { type: string }) => t.type).sort()).toEqual(['core.mcpClient', 'core.mcpClientTool']);

    const node = (await call('get_node_type', { type: 'core.set' })).data;
    expect(node).toMatchObject({ type: 'core.set', kind: 'action', plugin: 'core' });
    expect(node.properties.map((p: { name: string }) => p.name)).toContain('fields');
    expect((await call('get_node_type', { type: 'core.nope' })).result.isError).toBe(true);
  });

  it('creates, reads, validates, updates and runs a workflow, then reads its executions', async () => {
    const draft = {
      name: 'Made over MCP',
      nodes: [
        { name: 'Start', type: 'core.manualTrigger' },
        { name: 'Shout', type: 'core.set', parameters: { mode: 'manual', includeOtherFields: true, fields: { values: [{ name: 'loud', type: 'string', value: '{{ $json.word.toUpperCase() }}' }] } } },
      ],
      connections: [{ source: 'Start', target: 'Shout' }],
    };
    const created = (await call('create_workflow', draft)).data;
    expect(created).toMatchObject({ name: 'Made over MCP', active: false, url: `http://mcp.test/workflows/${created.id}`, validation: { valid: true, errors: [] } });

    const listed = (await call('list_workflows', { query: 'made over' })).data;
    expect(listed.workflows).toEqual([expect.objectContaining({ id: created.id, nodeCount: 2 })]);

    const saved = (await call('get_workflow', { id: created.id })).data;
    expect(saved.nodes.map((n: { name: string }) => n.name)).toEqual(['Start', 'Shout']);
    expect(saved.connections).toEqual([expect.objectContaining({ source: saved.nodes[0].id, target: saved.nodes[1].id, type: 'main' })]);

    const invalid = (await call('validate_workflow', { workflow: { name: 'Bad', nodes: [{ name: 'X', type: 'core.doesNotExist' }], connections: [{ source: 'X', target: 'Y' }] } })).data;
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join('\n')).toMatch(/X/);
    expect((await call('validate_workflow', { id: created.id })).data).toMatchObject({ valid: true });

    const updated = (await call('update_workflow', { id: created.id, name: 'Made over MCP v2', nodes: [...saved.nodes, { name: 'Done', type: 'core.noOp' }], connections: [...saved.connections, { source: 'Shout', target: 'Done' }] })).data;
    expect(updated).toMatchObject({ name: 'Made over MCP v2', validation: { valid: true } });
    const after = store.getWorkflow(created.id)!;
    expect(after.nodes.map((n) => n.name)).toEqual(['Start', 'Shout', 'Done']);
    expect(after.nodes[1].id).toBe(saved.nodes[1].id);

    const ran = (await call('execute_workflow', { id: created.id, input: [{ word: 'hi' }, { word: 'there' }] })).data;
    expect(ran).toMatchObject({ mode: 'mcp', status: 'success', lastNode: 'Done', output: { items: [{ word: 'hi', loud: 'HI' }, { word: 'there', loud: 'THERE' }], total: 2 } });
    expect(ran.nodes.map((n: { node: string }) => n.node)).toEqual(['Start', 'Shout', 'Done']);

    const background = (await call('execute_workflow', { id: created.id, input: { word: 'later' }, wait: false })).data;
    expect(background).toMatchObject({ status: 'running', executionId: expect.any(String) });

    const executions = (await call('list_executions', { workflowId: created.id })).data;
    expect(executions.executions.map((e: { id: string }) => e.id)).toContain(ran.id);
    expect(executions.executions.every((e: { mode: string }) => e.mode === 'mcp')).toBe(true);

    const one = (await call('get_execution', { id: ran.id, includeData: true })).data;
    expect(one).toMatchObject({ id: ran.id, status: 'success', output: { total: 2 } });
    expect(Object.keys(one.runData)).toHaveLength(3);
    expect((await call('get_execution', { id: 'ex_nope' })).result.isError).toBe(true);
    expect((await call('execute_workflow', { id: 'wf_nope' })).result.isError).toBe(true);

    // The published version runs only when asked for; the draft stays the default.
    const unpublished = await call('execute_workflow', { id: created.id, version: 'published' });
    expect(unpublished.result.isError).toBe(true);
    expect(JSON.stringify(unpublished.result.content)).toMatch(/not published/);
    const { publishDraft } = await import('@/lib/server/publish');
    await publishDraft(created.id);
    await call('update_workflow', { id: created.id, nodes: saved.nodes, connections: saved.connections });
    expect((await call('execute_workflow', { id: created.id, input: { word: 'live' }, version: 'published' })).data).toMatchObject({ status: 'success', lastNode: 'Done' });
    expect((await call('execute_workflow', { id: created.id, input: { word: 'draft' } })).data).toMatchObject({ status: 'success', lastNode: 'Shout' });
  });

  it('replaces the token, and turns off', async () => {
    await client.close();
    const { token: next } = (await (await settings.POST(new Request('http://mcp.test/api/settings/mcp', { method: 'POST' }))).json()) as { token: string };
    expect(next).toMatch(/^lf_mcp_/);
    expect(next).not.toBe(token);
    expect((await initialize(token)).status).toBe(401);
    expect((await initialize(next)).status).toBe(200);
    await patch(false);
    expect((await initialize(next)).status).toBe(403);
  });
});
