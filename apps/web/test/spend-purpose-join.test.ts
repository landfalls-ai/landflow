/**
 * Join test (wave 11, carryover §2): SP01's telemetry and meter ↔ SP02's call sites. Each package tested its side with
 * fakes; here the real call sites run inside one real workflow run against fake model servers, and the real meter
 * writes the rows. Nothing sits between the two sides.
 *
 * The run: an agent with tools (three loop steps, an input guardrail judged by Strands through `systemOneJudge`, an
 * output guardrail judged by its own chat model), an agent with a similar-question cache (its question's embedding),
 * and a run report with "Add a Summary". Each call must land as an `ai_usage` row with the right `purpose`, the node it
 * ran under and, inside the agent loop, its `iteration`; the `ai.call` event carries the purpose.
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-purpose-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { database } = await import('@/lib/server/db');
const { listUsageEvents } = await import('@/lib/server/usage/query');

registry.registerBuiltin(corePlugin);

const GUARDRAIL_SYSTEM = 'You are a guardrail that classifies text';
const toolResults = (messages: Array<{ content?: unknown }> = []) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p: { type?: string }) => p.type === 'tool_result').length;

/** Anthropic: a guardrail gets a "fine" verdict; an agent with tools calls Echo twice, then answers (three loop steps). */
const fake = await startFakeModels({
  reply: (provider, body) => {
    if (provider !== 'anthropic') return undefined;
    if (JSON.stringify(body.system ?? '').includes(GUARDRAIL_SYSTEM)) return { text: '{"flagged": false, "confidence": 0.05, "reason": "fine"}', usage: { input: 40, output: 9 } };
    if (body.tools?.length && toolResults(body.messages) < 2) return { toolCalls: [{ id: `call_${toolResults(body.messages) + 1}`, name: 'Echo', arguments: { word: 'ping' } }], usage: { input: 100, output: 5 } };
    return { text: 'They hibernate in burrows.', usage: { input: 120, output: 6 } };
  },
});

/** Strands Decider (`POST /v1/systemone`) and Ollama embeddings (`POST /api/embed`) on one local server. */
const aux = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/systemone') return res.end(JSON.stringify({ model: 'strands-test', answers: { flagged: { noul: 0.1 } }, usage: { input_tokens: 30, output_tokens: 1 } }));
    if (req.url === '/api/embed') {
      const input = (JSON.parse(raw) as { input: string[] }).input;
      return res.end(JSON.stringify({ model: 'nomic-embed-text', embeddings: input.map(() => [0.1, 0.2, 0.3]), prompt_eval_count: 7 }));
    }
    res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => aux.listen(0, '127.0.0.1', resolve));
const auxUrl = `http://127.0.0.1:${(aux.address() as AddressInfo).port}`;

const anthropic = credentials.create({ name: 'Fake Claude', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
const strands = credentials.create({ name: 'Fake Strands', type: 'core.strandsDeciderApi', data: { baseUrl: auxUrl } });
const ref = (c: { id: string; name: string }) => ({ id: c.id, name: c.name });

afterAll(async () => {
  await fake.close();
  await new Promise<void>((resolve) => aux.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const nsfwOnly = { nsfw: {} };
const worker = agentStore.create({
  name: 'Burrow desk',
  instructions: 'Answer briefly.',
  model: { provider: 'anthropic', model: 'claude-join', credential: ref(anthropic) },
  tools: [{ id: 't_echo', type: 'node', name: 'Echo', description: 'Echo the input', nodeType: 'core.noOp', parameters: {} }],
  guardrails: {
    input: { enabled: true, action: 'block', reply: 'No.', judge: { provider: 'strands', credential: ref(strands) }, checks: nsfwOnly },
    output: { enabled: true, action: 'block', reply: 'No.', checks: nsfwOnly },
  },
} as never);
agentStore.publish(worker.id);
const cached = agentStore.create({
  name: 'Cached desk',
  instructions: 'Answer briefly.',
  model: { provider: 'anthropic', model: 'claude-join', credential: ref(anthropic) },
  cache: { enabled: true, ttlSeconds: 600, semantic: { enabled: true, threshold: 0.92, model: 'nomic-embed-text', baseUrl: auxUrl } },
} as never);
agentStore.publish(cached.id);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

type Row = { id: string; operation: string; provider: string; purpose: string | null; node_id: string | null; iteration: number | null; session_id: string | null; agent_id: string | null };

describe('spend-purpose-join: SP02 call sites write SP01 attribution', () => {
  it('a guardrail, a Strands judge, a cache embedding and a run report summary each land with their purpose, node and iteration', async () => {
    const workflow: Workflow = {
      id: 'wf_spend_purpose_join',
      name: 'Spend purpose join',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Ask', 'core.messageAgent', { agentId: worker.id, message: 'Where do wombats hibernate?', conversation: 'new' }),
        node('Ask cached', 'core.messageAgent', { agentId: cached.id, message: 'How are you today?', conversation: 'new' }),
        node('Report', 'core.runReport', { gate: 'warn', profile: 'generic', summarize: true }),
        node('Summary model', 'core.openAiChatModel', { model: 'gpt-join' }, { credentials: { openAiApi: ref(openAi) } }),
      ],
      connections: [edge('Start', 'Ask'), edge('Ask', 'Ask cached'), edge('Ask cached', 'Report'), edge('Summary model', 'Report', 'ai_languageModel')],
    };
    store.saveWorkflow(workflow);
    const record = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(record.error?.message ?? record.status).toBe('success');

    const rows = database().all<Row>('SELECT id, operation, provider, purpose, node_id, iteration, session_id, agent_id FROM ai_usage WHERE execution_id = ? ORDER BY at, id', record.executionId);
    const of = (purpose: string) => rows.filter((r) => r.purpose === purpose);

    // The agent loop: three chat calls under the Run an Agent node, each with its step.
    const answers = of('answer').filter((r) => r.agent_id === worker.id);
    expect(answers.map((r) => r.iteration).sort()).toEqual([1, 2, 3]);
    expect(answers.every((r) => r.node_id === 'Ask' && r.provider === 'anthropic' && r.session_id)).toBe(true);

    // The input guardrail's Strands judge (systemOneJudge) and the output guardrail's chat-model verdict: both guardrail
    // calls, under the node, outside any loop step.
    const guardrails = of('guardrail');
    expect(guardrails.map((r) => r.provider).sort()).toEqual(['anthropic', 'strands']);
    expect(guardrails.every((r) => r.node_id === 'Ask' && r.iteration === null && r.agent_id === worker.id)).toBe(true);

    // The similar-question cache's embedding, under the second agent's node.
    expect(of('cache-embed')).toEqual([expect.objectContaining({ operation: 'embeddings', provider: 'ollama', node_id: 'Ask cached', agent_id: cached.id, iteration: null })]);
    // Its answer is an answer, in loop step 1.
    expect(of('answer').filter((r) => r.agent_id === cached.id)).toEqual([expect.objectContaining({ node_id: 'Ask cached', iteration: 1 })]);

    // The run report's summary: made by the model connected to the Report node (the innermost node is the sub-node).
    expect(of('summary')).toEqual([expect.objectContaining({ operation: 'chat', provider: 'openai', node_id: 'Summary model', iteration: null })]);

    // Every row has a purpose, and the ai.call event of each carries the same purpose and usage id.
    expect(rows.every((r) => r.purpose)).toBe(true);
    const events = listUsageEvents({ kinds: ['ai.call'] }, { limit: 200 }).filter((e) => rows.some((r) => r.id === e.attrs?.usageId));
    expect(events).toHaveLength(rows.length);
    for (const event of events) expect(event.attrs?.purpose, String(event.attrs?.usageId)).toBe(rows.find((r) => r.id === event.attrs?.usageId)!.purpose);
  });
});
