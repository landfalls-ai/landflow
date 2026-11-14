/**
 * A knowledge base a plugin answers (docs/agents.md#knowledge-bases-from-a-plugin): the agent's knowledge tool runs the
 * plugin node (here an in-process stand-in for Clickland's Knowledge → Search) with its fixed parameters, the model's
 * question and the picked credential; the passages reach the grounded check; the documents route refuses it; exports
 * drop its credential, team templates swap it by slot, and the Run Trace names it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, defineNode, definePlugin, type JsonObject } from '@landflow/sdk';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { AgentConfig, AgentGuardrail, NodeKnowledgeBaseConfig } from '@/lib/shared/agents';
import { KNOWLEDGE_NODE_PRESETS } from '@/lib/shared/agents';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-plugin-knowledge-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
const seen: Array<{ messages: AgentMessage[]; tools: ToolSpec[] }> = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        seen.push({ messages: structuredClone(input.messages), tools: input.tools });
        const step = script.shift();
        if (!step) throw new Error('The script ran out of turns');
        return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, ...step(input) };
      },
    };
  },
}));

/** What the stand-in node was asked: its parameters and the credential it got. */
const calls: Array<{ parameters: JsonObject; apiKey?: string }> = [];

const clicklandApi = defineCredentialType({
  name: 'clicklandApi',
  displayName: 'Clickland API',
  properties: [{ name: 'apiKey', displayName: 'API Key', type: 'string', typeOptions: { password: true }, default: '' }],
});

/** The shape of Clickland's node: resource / operation, a `query`, and `{ results }` out. */
const knowledgeNode = defineNode({
  description: {
    name: 'clickland',
    displayName: 'Clickland',
    description: 'Clickland stand-in',
    version: 1,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    credentials: [{ name: 'clicklandApi', required: true }],
    properties: [
      { name: 'resource', displayName: 'Resource', type: 'options', default: 'knowledge', options: [{ name: 'Knowledge', value: 'knowledge' }] },
      { name: 'operation', displayName: 'Operation', type: 'options', default: 'search', options: [{ name: 'Search', value: 'search' }] },
      { name: 'query', displayName: 'Question', type: 'string', default: '' },
    ],
  },
  async execute(ctx) {
    const parameters = { resource: ctx.getNodeParameter('resource', 0), operation: ctx.getNodeParameter('operation', 0), query: ctx.getNodeParameter('query', 0) } as JsonObject;
    calls.push({ parameters, apiKey: ctx.getCredentials<{ apiKey: string }>('clicklandApi').apiKey });
    return [{ json: { results: [{ pageContent: 'Checkout timeouts on 2026-11-10 came from the payments pool (max 10 connections).', metadata: { kind: 'note', id: 'nt_1' }, score: 0.9 }] } }];
  },
});

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { buildToolset, knowledgeResults, nodeKnowledgeTool } = await import('@/lib/server/agents/tools');
const { agentConnections } = await import('@/lib/server/agents/connections');
const { portableConfig } = await import('@/lib/server/marketplace/export');
const { visitAgentCredentials } = await import('@/lib/server/templates/team');
const documentsRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/documents/route');

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(definePlugin({ info: { id: 'clickland', name: 'Clickland', version: '1.0.0' }, nodes: [knowledgeNode], credentialTypes: [clicklandApi] }));

const credential = credentials.create({ name: 'Clickland (test)', type: 'clickland.clicklandApi', data: { apiKey: 'ck_test_key_0000000000000000000000' } });

const preset = KNOWLEDGE_NODE_PRESETS.find((p) => p.key === 'clickland')!;
const kb = (patch: Partial<NodeKnowledgeBaseConfig> = {}): NodeKnowledgeBaseConfig => ({
  id: 'kb1',
  type: 'knowledge',
  source: 'node',
  name: 'search_clickland',
  description: preset.description,
  nodeType: preset.nodeType,
  parameters: { ...preset.parameters },
  queryParameter: preset.queryParameter,
  credentials: { clicklandApi: { id: credential.id, name: credential.name } },
  ...patch,
});

beforeEach(() => {
  script.length = 0;
  seen.length = 0;
  calls.length = 0;
});

describe('a knowledge base a plugin answers', () => {
  it('is a knowledge tool: the model sees { query }, the node gets its fixed parameters, the question and the credential', async () => {
    const built = nodeKnowledgeTool(kb());
    if ('error' in built) throw new Error(built.error);
    expect(built).toMatchObject({ name: 'search_clickland', knowledge: true, kind: 'node', nodeType: 'clickland.clickland' });
    expect(built.inputSchema).toEqual({ type: 'object', properties: { query: expect.objectContaining({ type: 'string' }) }, required: ['query'] });
    const agent = agentStore.create({ name: 'Probe', instructions: '', model: { provider: 'ollama', model: 'scripted-1' }, tools: [] });
    const session = newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
    const outcome = await built.invoke({ query: 'why does checkout time out?' }, { agent, session, depth: 0, maxDepth: 2, runId: 'run_1' } as never);
    expect(calls).toEqual([{ parameters: { resource: 'knowledge', operation: 'search', query: 'why does checkout time out?' }, apiKey: 'ck_test_key_0000000000000000000000' }]);
    expect(outcome.output).toEqual({ results: [expect.objectContaining({ pageContent: expect.stringContaining('payments pool'), metadata: { kind: 'note', id: 'nt_1' } })] });
  });

  it('is built from an agent config next to the other tools, and says what is wrong when the plugin is missing', async () => {
    const agent = agentStore.create({ name: 'Toolset', instructions: '', model: { provider: 'ollama', model: 'scripted-1' }, tools: [kb(), kb({ id: 'kb2', name: 'search_other', nodeType: 'nowhere.search' })] });
    const toolset = await buildToolset(agent, agent);
    expect(toolset.tools.map((t) => [t.name, Boolean(t.knowledge)])).toEqual([['search_clickland', true]]);
    expect(toolset.unavailable.join('\n')).toMatch(/search_other/);
    expect(nodeKnowledgeTool(kb({ queryParameter: 'question' }))).toEqual({ error: expect.stringContaining('no “question” parameter') });
  });

  it('turns any node answer into results', () => {
    expect(knowledgeResults({ results: [{ pageContent: 'a', metadata: {} }] })).toEqual({ results: [{ pageContent: 'a', metadata: {} }] });
    expect(knowledgeResults([{ title: 'x' }, 'plain'])).toEqual({ results: [{ pageContent: '{"title":"x"}', metadata: {} }, { pageContent: 'plain', metadata: {} }] });
    expect(knowledgeResults(undefined)).toEqual({ results: [] });
  });

  it('feeds the grounded check what it returned', async () => {
    const rule: AgentGuardrail = { enabled: true, action: 'block', reply: 'I could not verify that.', checks: { grounded: {} } };
    const agent = agentStore.create({ name: 'Grounded on Clickland', instructions: 'Answer from Clickland.', model: { provider: 'ollama', model: 'scripted-1' }, guardrails: { output: rule }, tools: [kb()] });
    script.push(
      () => ({ toolCalls: [{ id: 'c1', name: 'search_clickland', input: { query: 'checkout timeouts' } }] }),
      () => ({ text: 'The payments pool ran out of connections.' }),
      () => ({ text: '{"flagged":false,"confidence":0.05}' }),
    );
    const result = await runAgent({ agent, session: newSession(agent, { source: 'test', userId: 'you', version: 'draft' }), message: 'Why did checkout time out?' });
    expect(result.reply).toBe('The payments pool ran out of connections.');
    expect(seen[0].tools.find((t) => t.name === 'search_clickland')?.inputSchema).toMatchObject({ required: ['query'] });
    expect(JSON.stringify(seen[2].messages)).toContain('payments pool (max 10 connections)');
  });

  it('has no documents: the documents route answers 400 for every method', async () => {
    const agent = agentStore.create({ name: 'No uploads', instructions: '', model: { provider: 'ollama', model: 'scripted-1' }, tools: [kb()] });
    const ctx = { params: Promise.resolve({ id: agent.id, toolId: 'kb1' }) };
    const url = `http://localhost/api/agents/${agent.id}/knowledge/kb1/documents`;
    const form = new FormData();
    form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    for (const response of [
      await documentsRoute.GET(new Request(url), ctx),
      await documentsRoute.POST(new Request(url, { method: 'POST', body: form }), ctx),
      await documentsRoute.DELETE(new Request(`${url}?documentId=d1`, { method: 'DELETE' }), ctx),
    ]) {
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/answered by a plugin.*uploads are not supported/);
    }
  });

  it('travels without its credential, is swapped by slot in a team template, and is named in the Run Trace', () => {
    const config = { name: 'Lead', instructions: '', tools: [kb()], channels: [], schedules: [] } as unknown as AgentConfig;
    const portable = portableConfig(config);
    expect(portable.tools![0]).not.toHaveProperty('credentials');
    expect(portable.tools![0]).toMatchObject({ source: 'node', nodeType: 'clickland.clickland', parameters: { resource: 'knowledge', operation: 'search' } });

    const visited: string[] = [];
    const copy = structuredClone(config);
    visitAgentCredentials(copy, (ref, info) => {
      visited.push(`${info.type} ${ref.id}`);
      return { id: 'slot_clickland', name: 'Clickland' };
    });
    expect(visited).toEqual([`clickland.clicklandApi ${credential.id}`]);
    expect((copy.tools[0] as NodeKnowledgeBaseConfig).credentials).toEqual({ clicklandApi: { id: 'slot_clickland', name: 'Clickland' } });

    const agent = agentStore.create({ name: 'Traced', instructions: '', model: { provider: 'ollama', model: 'scripted-1' }, tools: [kb()] });
    expect(agentConnections(agent).find((c) => c.kind === 'knowledge')).toMatchObject({ name: 'search_clickland', detail: 'Clickland · plugin knowledge' });
  });
});
