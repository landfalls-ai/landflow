/**
 * Resources and prompts on the MCP Server Trigger (`resources` / `prompts` parameters): listing runs nothing, static text is
 * served as it is, an expression or a sub-workflow is an execution with mode `mcp`, a trigger without any declares no
 * resources or prompts capability. Read with the SDK's client through the /mcp/<path> route, in-process.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-content-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://mcp.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { closeMcpEndpoints } = await import('@/lib/server/mcp/server');
const { resourceDefs, promptDefs, isDynamic, promptMessages } = await import('@/lib/server/mcp/trigger-content');
const triggerRoute = await import('@/app/mcp/[...path]/route');

registry.registerBuiltin(corePlugin);

afterAll(async () => {
  await closeMcpEndpoints();
  waits.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
const route = triggerRoute as unknown as Record<string, Handler>;

async function connect(path: string) {
  const fetchThroughRoute = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const segments = new URL(request.url).pathname.split('/').filter(Boolean).slice(1);
    return route[request.method](request, { params: Promise.resolve({ path: segments }) });
  };
  const client = new Client({ name: 'landflow-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://mcp.test/mcp/${path}`), { fetch: fetchThroughRoute }));
  return client;
}

const executions = (id: string) => store.listExecutions({ workflowId: id });

function saveTrigger(id: string, path: string, parameters: Record<string, unknown>) {
  return store.saveWorkflow({
    id,
    name: `Content ${id}`,
    active: true,
    nodes: [{ id: 'mcp', name: 'MCP Server', type: 'core.mcpTrigger', typeVersion: 1, position: [0, 0], parameters: { path, ...parameters } }],
    connections: [],
  } as Workflow);
}

const resources = {
  items: [
    { uri: 'doc://handbook', name: 'Handbook', description: 'The team handbook', mimeType: 'text/markdown', source: 'text', text: '# Handbook\nBe kind.' },
    { uri: 'doc://today', name: 'Today', source: 'text', text: 'It is {{ "Tuesday" }} for {{ $json.resource }}' },
    { uri: 'doc://report', name: 'Report', mimeType: 'application/json', source: 'workflow', workflowId: 'wf_content_child' },
  ],
};
const prompts = {
  items: [
    { name: 'greet', description: 'Greet someone', source: 'text', text: 'Say hello nicely.' },
    { name: 'review', description: 'Review code', arguments: 'language, focus?', source: 'text', text: 'Review this {{ $json.arguments.language }} code{{ $json.arguments.focus ? " for " + $json.arguments.focus : "" }}.' },
    { name: 'report', arguments: 'topic', source: 'workflow', workflowId: 'wf_content_child' },
  ],
};

beforeAll(() => {
  // Answers { text } for a resource ({ uri }) and { messages } for a prompt ({ name, arguments }).
  store.saveWorkflow({
    id: 'wf_content_child',
    name: 'Content provider',
    nodes: [
      { id: 'called', name: 'Called', type: 'core.workflowTrigger', typeVersion: 1, position: [0, 0], parameters: { inputSource: 'passthrough' } },
      {
        id: 'set',
        name: 'Answer',
        type: 'core.set',
        typeVersion: 1,
        position: [200, 0],
        parameters: {
          mode: 'manual',
          includeOtherFields: false,
          fields: { values: [{ name: 'text', type: 'string', value: '{{ $json.uri ? "report for " + $json.uri : "write about " + $json.arguments.topic }}' }] },
        },
      },
    ],
    connections: [{ id: 'c1', type: 'main', source: 'called', target: 'set', sourceIndex: 0, targetIndex: 0 }],
  } as Workflow);
  saveTrigger('wf_content', 'content/server', { resources, prompts, instructions: 'Docs and prompts.' });
  saveTrigger('wf_content_none', 'content/none', {});
});

describe('definitions', () => {
  it('reads the parameters, with an optional marker on arguments', () => {
    expect(resourceDefs({ resources }).map((d) => [d.uri, d.mimeType, d.source])).toEqual([
      ['doc://handbook', 'text/markdown', 'text'],
      ['doc://today', 'text/plain', 'text'],
      ['doc://report', 'application/json', 'workflow'],
    ]);
    expect(promptDefs({ prompts })[1].arguments).toEqual([
      { name: 'language', required: true },
      { name: 'focus', required: false },
    ]);
    expect(resourceDefs({ resources: { items: [{ uri: '' }] } })).toEqual([]);
    expect(resourceDefs(undefined)).toEqual([]);
    expect(isDynamic(resourceDefs({ resources })[0])).toBe(false);
    expect(isDynamic(resourceDefs({ resources })[1])).toBe(true);
    expect(isDynamic(resourceDefs({ resources })[2])).toBe(true);
    expect(promptMessages({ messages: [{ role: 'assistant', text: 'x' }, { role: 'user', content: { type: 'text', text: 'y' } }] })).toEqual([
      { role: 'assistant', text: 'x' },
      { role: 'user', text: 'y' },
    ]);
    expect(promptMessages({ text: 'plain' })).toEqual([{ role: 'user', text: 'plain' }]);
  });
});

describe('MCP Server Trigger resources and prompts', () => {
  it('declares the capabilities only when something is defined', async () => {
    const withContent = await connect('content/server');
    expect(withContent.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    await withContent.close();
    const without = await connect('content/none');
    expect(without.getServerCapabilities()?.resources).toBeUndefined();
    expect(without.getServerCapabilities()?.prompts).toBeUndefined();
    await without.close();
  });

  it('lists resources and prompts without running anything', async () => {
    const client = await connect('content/server');
    const listed = await client.listResources();
    expect(listed.resources).toEqual([
      { uri: 'doc://handbook', name: 'Handbook', description: 'The team handbook', mimeType: 'text/markdown' },
      { uri: 'doc://today', name: 'Today', mimeType: 'text/plain' },
      { uri: 'doc://report', name: 'Report', mimeType: 'application/json' },
    ]);
    const prompts_ = await client.listPrompts();
    expect(prompts_.prompts).toEqual([
      { name: 'greet', description: 'Greet someone', arguments: [] },
      { name: 'review', description: 'Review code', arguments: [{ name: 'language', required: true }, { name: 'focus', required: false }] },
      { name: 'report', arguments: [{ name: 'topic', required: true }] },
    ]);
    expect(executions('wf_content')).toHaveLength(0);
    await client.close();
  });

  it('serves static text without an execution, and expressions and sub-workflows as executions', async () => {
    const client = await connect('content/server');
    const handbook = await client.readResource({ uri: 'doc://handbook' });
    expect(handbook.contents).toEqual([{ uri: 'doc://handbook', mimeType: 'text/markdown', text: '# Handbook\nBe kind.' }]);
    expect(executions('wf_content')).toHaveLength(0);

    const today = await client.readResource({ uri: 'doc://today' });
    expect(today.contents[0]).toMatchObject({ uri: 'doc://today', text: 'It is Tuesday for doc://today' });
    const report = await client.readResource({ uri: 'doc://report' });
    expect(report.contents[0]).toMatchObject({ uri: 'doc://report', mimeType: 'application/json', text: 'report for doc://report' });
    const recorded = executions('wf_content');
    expect(recorded).toHaveLength(2);
    expect(recorded.every((e) => e.mode === 'mcp' && e.status === 'success')).toBe(true);
    expect(executions('wf_content_child')).toHaveLength(1);

    await expect(client.readResource({ uri: 'doc://nope' })).rejects.toThrow(/Unknown resource "doc:\/\/nope"/);
    await client.close();
  });

  it('gets prompts: static, with arguments in an expression, from a sub-workflow, and checks required arguments', async () => {
    const client = await connect('content/server');
    expect(await client.getPrompt({ name: 'greet' })).toEqual({ description: 'Greet someone', messages: [{ role: 'user', content: { type: 'text', text: 'Say hello nicely.' } }] });
    const before = executions('wf_content').length;
    const review = await client.getPrompt({ name: 'review', arguments: { language: 'Go', focus: 'bugs' } });
    expect(review.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Review this Go code for bugs.' } }]);
    expect((await client.getPrompt({ name: 'review', arguments: { language: 'Rust' } })).messages[0].content).toMatchObject({ text: 'Review this Rust code.' });
    const fromWorkflow = await client.getPrompt({ name: 'report', arguments: { topic: 'whales' } });
    expect(fromWorkflow.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'write about whales' } }]);
    expect(executions('wf_content').length).toBe(before + 3);
    await expect(client.getPrompt({ name: 'review', arguments: {} })).rejects.toThrow(/needs the argument language/);
    await expect(client.getPrompt({ name: 'nope' })).rejects.toThrow(/Unknown prompt "nope"/);
    await client.close();
  });

  it('shows the resources and prompts parameters in the node description', () => {
    const resolved = registry.resolve('core.mcpTrigger');
    if ('error' in resolved) throw new Error(resolved.error);
    const names = resolved.descriptor.properties.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['resources', 'prompts']));
    const client = registry.resolve('core.mcpClient');
    if ('error' in client) throw new Error(client.error);
    const operation = client.descriptor.properties.find((p) => p.name === 'operation');
    expect(operation?.options?.map((o) => o.value)).toEqual(['callTool', 'listResources', 'readResource', 'listPrompts', 'getPrompt']);
  });
});
