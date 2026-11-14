/**
 * The Clickland observability assistant flow (plugins/clickland/flows/clickland-observability-assistant.json) end to
 * end, the way Clickland's API calls it (docs/features/clickland.md#the-assistant-chat-contract): imported and used as
 * a template (the team, the four agents and their Clickland and Anthropic credentials picked), published with the
 * shared secret, refused without it, then a streamed answer where the lead asks the Logs analyst (who runs its own
 * Clickland tool), renders a view and ends with the view's marker; the session's history afterwards. The model is a
 * local fake Anthropic API; Clickland is an in-process stand-in for the plugin's node. No network.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin, type IPlugin, type JsonObject, type NodeDescriptor } from '@landflow/sdk';
import type { NodeKnowledgeBaseConfig, NodeToolConfig } from '@/lib/shared/agents';
import { readSse, startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-clickland-assistant-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://chat.test' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const { publishDraft } = await import('@/lib/server/publish');
const templates = await import('@/lib/server/templates');
const chatRoute = await import('@/app/chat/[...path]/route');

const repo = join(import.meta.dirname, '..', '..', '..');
const file = JSON.parse(readFileSync(join(repo, 'plugins/clickland/flows/clickland-observability-assistant.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/plugin-manifests/clickland.json'), 'utf8'));

/** What the stand-in Clickland node was asked: resource, operation, the parameters and the key it got. */
const calls: Array<{ op: string; parameters: JsonObject; apiKey: string }> = [];
const describeOf = (name: string) => manifest.nodes.find((n: NodeDescriptor) => n.name === name) as NodeDescriptor;
const clicklandNode = defineNode({
  description: describeOf('clickland'),
  async execute(ctx) {
    const resource = ctx.getNodeParameter<string>('resource', 0);
    const operation = ctx.getNodeParameter<string>('operation', 0);
    const op = `${resource}.${operation}`;
    const parameters: JsonObject = {};
    for (const name of ['query', 'lastMinutes', 'spec', 'viewId']) {
      const value = ctx.getNodeParameter(name, 0, undefined as never);
      if (value !== undefined && value !== '') parameters[name] = value as JsonObject[string];
    }
    calls.push({ op, parameters, apiKey: ctx.getCredentials<{ apiKey: string }>('clicklandApi').apiKey });
    if (op === 'logs.getPatterns') return [{ json: { patterns: [{ template: 'Connection to <*> refused after <NUM> ms', count: 812, share: 0.41 }], sampled: 5000, total: 9120 } }];
    if (op === 'views.render') return [{ json: { id: 'vw_1', url: 'http://127.0.0.1:4711/views/vw_1', resourceUri: 'ui://clickland/view', marker: '[[clickland:view:vw_1]]' } }];
    if (op === 'knowledge.search') return [{ json: { results: [] } }];
    return [{ json: {} }];
  },
});
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(definePlugin({ info: manifest.plugin, nodes: [clicklandNode], credentialTypes: manifest.credentialTypes } as unknown as Parameters<typeof definePlugin>[0]) as IPlugin);

/**
 * The fake model: the lead asks the Logs analyst, then renders a view, then answers with the marker; the Logs analyst
 * reads log patterns, then answers. Who is talking is told by the tools it has.
 */
const toolResults = (body: { messages?: Array<{ content: unknown }> }) =>
  (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string; content?: unknown }>).filter((p) => p.type === 'tool_result') : []));
const fake = await startFakeModels({
  reply: (_provider, body) => {
    const tools: string[] = (body.tools ?? []).map((t: { name?: string }) => t.name);
    const results = toolResults(body);
    if (tools.includes('Logs_analyst')) {
      if (results.length === 0) return { toolCalls: [{ id: 'l1', name: 'Logs_analyst', arguments: { message: 'What do checkout’s error logs say in the last hour?', reason: 'to see what the errors are' } }] };
      if (results.length === 1)
        return { toolCalls: [{ id: 'l2', name: 'render_view', arguments: { spec: { title: 'Checkout errors', range: { lastMinutes: 60 }, panels: [{ type: 'patterns', title: 'Error patterns', query: 'service:checkout level:error' }] } } }] };
      const marker = /\[\[clickland:view:[\w-]+\]\]/.exec(JSON.stringify(results.at(-1)))?.[0] ?? '';
      return { text: `Checkout's errors are refused connections (812 in the last hour).\n${marker}` };
    }
    if (tools.includes('log_patterns')) {
      if (results.length === 0) return { toolCalls: [{ id: 'p1', name: 'log_patterns', arguments: { query: 'service:checkout level:error', lastMinutes: 60 } }] };
      return { text: 'Top pattern: Connection to <*> refused after <NUM> ms (812, 41%).' };
    }
    return { text: 'unexpected caller' };
  },
});
afterAll(() => fake.close());

const clickland = credentials.create({ name: 'Clickland (test)', type: 'clickland.clicklandApi', data: { baseUrl: 'http://clickland.invalid:4710', apiKey: 'ck_test_key_0000000000000000000000' } });
const anthropic = credentials.create({ name: 'Fake Anthropic', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });

const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split('?')[0].split('/').filter(Boolean) }) });
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  chatRoute.POST(new Request('http://chat.test/chat/clickland-assistant', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), ctx('clickland-assistant'));
const get = (path: string, headers: Record<string, string> = {}) => chatRoute.GET(new Request(`http://chat.test/chat/${path}`, { headers }), ctx(path));

describe('the Clickland observability assistant', () => {
  let workflowId = '';

  it('is used as a template: the team and four agents, with the Clickland and Anthropic credentials picked', async () => {
    const imported = templates.importTemplate(file, 'tester');
    const used = await templates.useTemplate(imported.id, { credentials: { clickland: clickland.id, anthropic: anthropic.id } });
    workflowId = used.workflow!.id;
    expect(used.agents!.map((a) => a.name).sort()).toEqual(['Clickland observability lead', 'Logs analyst', 'Metrics analyst', 'Traces analyst']);
    const lead = agentStore.get(used.agents!.find((a) => a.name === 'Clickland observability lead')!.id)!;
    const knowledge = lead.tools.find((t) => t.type === 'knowledge') as NodeKnowledgeBaseConfig;
    expect(knowledge).toMatchObject({ source: 'node', nodeType: 'clickland.clickland', credentials: { clicklandApi: { id: clickland.id } } });
    const logs = agentStore.get(used.agents!.find((a) => a.name === 'Logs analyst')!.id)!;
    expect(logs.model).toMatchObject({ provider: 'anthropic', credential: { id: anthropic.id } });
    expect((logs.tools as NodeToolConfig[]).map((t) => [t.name, t.credentials?.clicklandApi?.id])).toEqual([
      ['search_logs', clickland.id],
      ['log_patterns', clickland.id],
      ['log_volume', clickland.id],
      ['render_view', clickland.id],
    ]);
    // The flow's Run an Agent nodes point at the new agents.
    const flow = store.getWorkflow(workflowId)!;
    expect(flow.nodes.filter((n) => n.type === 'core.messageAgent').every((n) => used.agents!.some((a) => a.id === n.parameters.agentId))).toBe(true);
  });

  it('stays shut while the shared secret is empty, and asks for it once set', async () => {
    await publishDraft(workflowId, 'tester', 'chat');
    expect((await post({ sessionId: 's1', message: 'hi' }, { authorization: basic('clickland', '') })).status).toBe(401);

    const flow = store.getWorkflow(workflowId)!;
    const trigger = flow.nodes.find((n) => n.type === 'core.chatTrigger')!;
    trigger.parameters.basicAuthPassword = 'a-long-shared-secret';
    store.saveWorkflow(flow);
    await publishDraft(workflowId, 'tester', 'chat');
    const refused = await post({ sessionId: 's1', message: 'hi' });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ authRequired: true });
    expect((await post({ sessionId: 's1', message: 'hi' }, { authorization: basic('clickland', 'wrong') })).status).toBe(401);
  });

  it('streams the answer: the lead asks the Logs analyst, renders a view and ends with its marker', async () => {
    calls.length = 0;
    const response = await post({ sessionId: 'ck-user-1', message: 'Why is checkout failing?' }, { authorization: basic('clickland', 'a-long-shared-secret'), accept: 'text/event-stream' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = (await readSse(response)).map((e) => e.data);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', status: 'success', sessionId: 'ck-user-1' });
    expect(done.output).toContain('[[clickland:view:vw_1]]');
    const text = events.filter((e) => e.type === 'item').map((e) => e.content).join('');
    expect(text).toContain('[[clickland:view:vw_1]]');
    // The lead's tool calls are tool events: the analyst (with its reason) and the view. The analyst's own Clickland
    // calls run inside its tool call and are not streamed (a Run an Agent used as a tool: docs/limitations.md).
    const tools = events.filter((e) => e.type === 'tool').map((e) => [e.tool.name, e.tool.status]);
    expect(tools).toEqual([['Logs_analyst', 'started'], ['Logs_analyst', 'finished'], ['render_view', 'started'], ['render_view', 'finished']]);
    expect(events.find((e) => e.type === 'tool')).toMatchObject({ tool: { input: { reason: 'to see what the errors are' } }, agent: { name: 'Clickland observability lead' }, metadata: { nodeName: 'Observability lead' } });
    // The analyst ran its own Clickland tool; the view went to Clickland; both with the picked key.
    expect(calls.map((c) => c.op)).toEqual(['logs.getPatterns', 'views.render']);
    expect(calls[0].parameters).toMatchObject({ query: 'service:checkout level:error', lastMinutes: 60 });
    expect(calls[1].parameters.spec).toMatchObject({ title: 'Checkout errors', panels: [{ type: 'patterns' }] });
    expect(calls.every((c) => c.apiKey === 'ck_test_key_0000000000000000000000')).toBe(true);
  });

  it('keeps the session: Clickland loads the history by sessionId', async () => {
    const history = await (await get('clickland-assistant/session?sessionId=ck-user-1', { authorization: basic('clickland', 'a-long-shared-secret') })).json();
    expect(history.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(history.messages[1].text).toContain('[[clickland:view:vw_1]]');
    expect((await get('clickland-assistant/session?sessionId=ck-user-1')).status).toBe(401);
  });

  it('answers NDJSON without Accept: text/event-stream', async () => {
    const response = await post({ sessionId: 'ck-user-2', message: 'Why is checkout failing?' }, { authorization: basic('clickland', 'a-long-shared-secret') });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await response.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ type: 'done', status: 'success', sessionId: 'ck-user-2' });
  });
});
