/**
 * Run an Agent (nodes/agents.ts): a published agent as a step of a workflow. Its persona and capabilities come along;
 * a chat model connected to the node replaces the agent's own, connected tools join its capabilities for the run (and
 * run as the node's sub-nodes), and a connected memory keeps the conversation. Model calls go to the fake model server.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-node-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** A published agent on the fake Ollama, with a persona and a rule the model must see. */
const agent = agentStore.create({
  name: 'Math desk',
  persona: { role: 'Arithmetic helper', always: ['Check every sum with a tool'] },
  instructions: 'Answer with the number.',
  model: { provider: 'ollama', model: 'agent-own-model', baseUrl: fake.url.replace(/\/v1$/, '') },
});
agentStore.publish(agent.id);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_tool' | 'ai_memory' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

function workflow(id: string, connect: { model?: boolean; calculator?: boolean; memory?: boolean }, parameters: Record<string, unknown> = {}): Workflow {
  const wf: Workflow = {
    id,
    name: id,
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Agent', 'core.messageAgent', { agentId: agent.id, message: 'What is 6*7?', conversation: 'new', ...parameters }),
      ...(connect.model ? [node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } })] : []),
      ...(connect.calculator ? [node('Calculator', 'core.calculatorTool')] : []),
      ...(connect.memory ? [node('Memory', 'core.simpleMemory', { turns: 10 })] : []),
    ],
    connections: [
      edge('Start', 'Agent'),
      ...(connect.model ? [edge('Model', 'Agent', 'ai_languageModel')] : []),
      ...(connect.calculator ? [edge('Calculator', 'Agent', 'ai_tool')] : []),
      ...(connect.memory ? [edge('Memory', 'Agent', 'ai_memory')] : []),
    ],
  };
  store.saveWorkflow(wf);
  return wf;
}

const run = (wf: Workflow) => runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
const agentOutput = (record: Awaited<ReturnType<typeof run>>) => record.runData.Agent.at(-1)!.outputs[0][0].json as Record<string, unknown>;

describe('Run an Agent', () => {
  it('runs the agent on its own model with its persona when nothing is connected', async () => {
    const before = fake.requests.length;
    const record = await run(workflow('wf_agent_plain', {}));
    expect(record.error?.message ?? record.status).toBe('success');
    expect(agentOutput(record)).toMatchObject({ reply: 'Echo: What is 6*7?', agentId: agent.id, version: 1, model: 'ollama/agent-own-model', endReason: 'completed', steps: [] });
    const [request] = fake.requests.slice(before);
    expect(request.path).toBe('/api/chat');
    expect(JSON.stringify(request.body.messages[0])).toContain('Check every sum with a tool');
  });

  it('uses the connected chat model instead, and the connected tools as capabilities run on the canvas', async () => {
    const before = fake.requests.length;
    const record = await run(workflow('wf_agent_flow', { model: true, calculator: true }));
    expect(record.status).toBe('success');
    expect(agentOutput(record)).toMatchObject({ reply: expect.stringContaining('"result":42'), model: 'openai/gpt-test', steps: [{ tool: 'Calculator', kind: 'flow', status: 'success' }] });
    const calls = fake.requests.slice(before);
    // Both turns went to the connected model, never to the agent's own; the persona and the flow's tool went along.
    expect(calls.map((r) => r.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    expect(calls[0].body.messages[0].content).toContain('Arithmetic helper');
    expect(calls[0].body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('Calculator');
    // The tool ran as the Agent node's sub-node, so it has run data (it lights up like an AI Agent's tools).
    expect(record.runData.Calculator?.length).toBeGreaterThan(0);
    // The run is an agent session like any other, from the workflow.
    expect(agentStore.getSession(agentOutput(record).sessionId as string)).toMatchObject({ source: 'workflow', agentId: agent.id });
  });

  it('keeps the conversation in a connected memory, by session key', async () => {
    const wf = workflow('wf_agent_memory', { model: true, memory: true }, { conversation: 'key', sessionKey: 'customer-7' });
    expect((await run(wf)).status).toBe('success');
    const before = fake.requests.length;
    const second = await run({ ...wf, nodes: wf.nodes.map((n) => (n.id === 'Agent' ? { ...n, parameters: { ...n.parameters, message: 'And 7*8?' } } : n)) });
    expect(second.status).toBe('success');
    const sent = fake.requests[before].body.messages.map((m: { role: string; content: string }) => `${m.role}: ${m.content}`);
    expect(sent).toEqual(expect.arrayContaining(['user: What is 6*7?', 'assistant: Echo: What is 6*7?', 'user: And 7*8?']));
  });
});
