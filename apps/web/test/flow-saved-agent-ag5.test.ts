/**
 * AG25 (wave ag5): the first flow ask uses a saved agent (docs/assistant.md "Build a workflow"). The scripted build model
 * places an inline AI Agent for an ask that calls for an agent: the guard after the model turns it into a Run an Agent
 * step (a saved agent, designed after Apply); an AI Agent that stays always has its Chat Model; the plan path carries
 * the same rule. Local fake model only; nothing leaves this machine. The editor side is `flow-saved-agent-ag5-editor.test.ts`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeModels, type FakeReply } from './fake-ai-services';

let answer = '{}';
let queue: Array<string | FakeReply> = [];
const fake = await startFakeModels({
  reply: () => {
    const next = queue.length ? queue.shift()! : answer;
    return typeof next === 'string' ? { text: next } : next;
  },
});
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-saved-agent-ag5-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { buildFlow, savedAgentSteps } = await import('@/lib/server/flow-builder');
const { candidatesFor } = await import('@/lib/server/assistant/build-plan');
const { availableTypes } = await import('@/lib/server/assistant/research');
const buildRoute = await import('@/app/api/ai/build/route');
registry.registerBuiltin(corePlugin);

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  queue = [];
  fake.requests.length = 0;
  delete process.env.LANDFLOW_BUILDER_MODEL;
});

const G1 = "Every weekday at 8:00, have an agent write last month's sales summary by region, then post it to our reports endpoint at http://127.0.0.1:3524/reports/sales.";
const CLASSIFY = 'Classify each ticket as bug or question, then post it to http://127.0.0.1:3524/reports/sales.';
const inlineAgent = (extra: object[] = [], connections: object[] = []) =>
  JSON.stringify({
    name: 'Sales summary',
    nodes: [
      { key: 'a', type: 'core.schedule', name: 'Weekdays at 8', parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } } },
      { key: 'b', type: 'core.aiAgent', name: 'Write summary', parameters: { prompt: "Write last month's sales summary by region" } },
      { key: 'c', type: 'core.httpRequest', name: 'Post it', parameters: { method: 'POST', url: 'http://127.0.0.1:3524/reports/sales' } },
      ...extra,
    ],
    connections: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, ...connections],
  });
const types = (nodes: Array<{ type: string }>) => nodes.map((n) => n.type);

describe('the first flow ask uses a saved agent', () => {
  it('turns the AI Agent the model placed for an ask that calls an agent into a Run an Agent step with no agent bound', async () => {
    answer = inlineAgent();
    const draft = await buildFlow(G1);
    expect(types(draft.nodes)).not.toContain('core.aiAgent');
    const step = draft.nodes.find((n) => n.type === 'core.messageAgent')!;
    expect(step.name).toBe('Write summary');
    expect(step.parameters).toMatchObject({ agentId: '', message: "Write last month's sales summary by region" });
    expect(draft.left?.some((l) => /needs a new agent: Write summary/.test(l.text))).toBe(true);
    expect(draft.reuses?.some((r) => /Run an Agent step, not an inline AI Agent/.test(r))).toBe(true);
  });

  it('removes the Chat Model, memory and tools wired to it, and says which tools it had', async () => {
    answer = inlineAgent(
      [{ key: 'm', type: 'core.ollamaChatModel', name: 'Model' }, { key: 'k', type: 'core.simpleMemory', name: 'Memory' }, { key: 't', type: 'core.calculatorTool', name: 'Calculator' }],
      [{ from: 'm', to: 'b', type: 'ai_languageModel' }, { from: 'k', to: 'b', type: 'ai_memory' }, { from: 't', to: 'b', type: 'ai_tool' }],
    );
    const draft = await buildFlow(G1);
    expect(types(draft.nodes).sort()).toEqual(['core.httpRequest', 'core.messageAgent', 'core.schedule']);
    expect(draft.edges.every((e) => e[3] === 'main')).toBe(true);
    expect(draft.reuses?.join(' ')).toMatch(/tools it had: Calculator/);
  });

  it('carries the removed AI Agent\'s system message, Chat Model and tools on the draft for the new agent\'s design', async () => {
    answer = JSON.stringify(JSON.parse(inlineAgent(
      [{ key: 'm', type: 'core.anthropicChatModel', name: 'Model', parameters: { model: 'claude-haiku-5' } }, { key: 't', type: 'core.calculatorTool', name: 'Calculator' }],
      [{ from: 'm', to: 'b', type: 'ai_languageModel' }, { from: 't', to: 'b', type: 'ai_tool' }],
    )));
    const parsed = JSON.parse(answer);
    parsed.nodes.find((n: { key: string }) => n.key === 'b').parameters.systemMessage = 'You write sales summaries.';
    answer = JSON.stringify(parsed);
    const draft = await buildFlow(G1);
    expect(draft.newAgents?.['Write summary']).toEqual({ instructions: 'You write sales summaries.', tools: ['Calculator'], toolNodes: [{ nodeType: 'core.calculatorTool' }], model: 'anthropic/claude-haiku-5' });
  });

  it('rewrites what the steps after the converted one read of the AI Agent\'s output to the Run an Agent step\'s reply', () => {
    const byType = new Map(availableTypes().map((t) => [t.type, t]));
    const nodes = [
      { key: 'a', type: 'core.schedule', name: 'Weekdays', parameters: {} },
      { key: 'b', type: 'core.aiAgent', name: 'Write summary', parameters: { prompt: 'Write it' } },
      { key: 'c', type: 'core.httpRequest', name: 'Post it', parameters: { body: '{{ $json.output }}', other: ["{{ $('Write summary').item.json.output }}", '{{ $json.title }}'] } },
    ];
    const edges: Array<[string, string, number, 'main']> = [['a', 'b', 0, 'main'], ['b', 'c', 0, 'main']];
    const out = savedAgentSteps(nodes, edges, G1, byType);
    expect(out.nodes.find((n) => n.key === 'c')!.parameters).toEqual({ body: '{{ $json.reply }}', other: ["{{ $('Write summary').item.json.reply }}", '{{ $json.title }}'] });
  });

  it('keeps an AI Agent for a small step the ask did not call an agent, with the builder model wired as its Chat Model', async () => {
    answer = inlineAgent();
    const draft = await buildFlow(CLASSIFY);
    const agent = draft.nodes.find((n) => n.type === 'core.aiAgent')!;
    expect(agent).toBeTruthy();
    const model = draft.edges.find((e) => e[1] === agent.key && e[3] === 'ai_languageModel');
    expect(model).toBeTruthy();
    expect(draft.nodes.find((n) => n.key === model![0])!.type).toBe('core.ollamaChatModel');
  });

  it('wires the Anthropic Chat Model when the host builder model is Anthropic, and adds none when one is wired', async () => {
    process.env.LANDFLOW_BUILDER_MODEL = 'anthropic/claude-sonnet-5-5';
    answer = inlineAgent();
    const own = await buildFlow(CLASSIFY);
    const node = own.nodes.find((n) => n.type === 'core.anthropicChatModel')!;
    expect(node.parameters).toMatchObject({ model: 'claude-sonnet-5-5' });
    answer = inlineAgent([{ key: 'm', type: 'core.ollamaChatModel', name: 'Model' }], [{ from: 'm', to: 'b', type: 'ai_languageModel' }]);
    const wired = await buildFlow(CLASSIFY);
    expect(types(wired.nodes).filter((t) => /ChatModel/.test(t))).toEqual(['core.ollamaChatModel']);
  });

  it('does not read "AI Agent" in the ask as a call for an agent', () => {
    const byType = new Map(availableTypes().map((t) => [t.type, t]));
    const nodes = [{ key: 'b', type: 'core.aiAgent', name: 'AI Agent', parameters: {} }];
    expect(savedAgentSteps(nodes, [], 'Add an AI Agent that answers questions', byType).nodes[0].type).toBe('core.aiAgent');
    expect(savedAgentSteps(nodes, [], 'Add an agent that answers questions', byType).nodes[0].type).toBe('core.messageAgent');
  });

  it('does not read a person\'s role or a header as a call for an agent', () => {
    const byType = new Map(availableTypes().map((t) => [t.type, t]));
    const nodes = [{ key: 'b', type: 'core.aiAgent', name: 'Summarise', parameters: {} }];
    for (const ask of ['When a support agent closes a ticket, summarise it with AI', 'Set the User-Agent header and summarise the reply']) expect(savedAgentSteps(nodes, [], ask, byType).nodes[0].type).toBe('core.aiAgent');
  });

  it('no longer tells the model to use core.aiAgent to draft a reply when the ask names an agent', async () => {
    answer = inlineAgent();
    await buildFlow(G1);
    const prompt = JSON.stringify(fake.last('/api/chat')?.body);
    expect(prompt).not.toMatch(/core\.aiAgent only for a small step that needs no specialist \(classify, summarize, extract, draft a reply\)/);
    expect(prompt).toMatch(/never core\.aiAgent, when the request says \\"agent\\"/);
  });

  it('offers the Run an Agent step to the plan when the ask says agent, even with no saved agent', () => {
    expect(candidatesFor(G1, availableTypes(), { agents: false }).types.map((t) => t.type)).toContain('core.messageAgent');
    expect(candidatesFor(CLASSIFY, availableTypes(), { agents: false }).types.map((t) => t.type)).not.toContain('core.messageAgent');
  });

  it('carries the same rule on the plan path (the build route with a plan)', async () => {
    const plan = {
      name: 'Sales summary',
      steps: [
        { key: 's1', type: 'core.schedule', name: 'Weekdays at 8', does: 'Run every weekday at 8' },
        { key: 's2', type: 'core.aiAgent', name: 'Write summary', does: "Write last month's sales summary", from: 's1' },
        { key: 's3', type: 'core.httpRequest', name: 'Post it', does: 'Post it', from: 's2' },
      ],
      assumptions: [],
      cannot: [],
    };
    answer = JSON.stringify({ parameters: {} });
    const response = await (buildRoute.POST as unknown as (r: Request) => Promise<Response>)(new Request('http://ag5.test/api/ai/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: G1, plan }) }));
    expect(response.status).toBe(200);
    const { draft } = (await response.json()) as { draft: { nodes: Array<{ type: string; name: string; parameters?: { agentId?: string } }> } };
    expect(types(draft.nodes)).toContain('core.messageAgent');
    expect(types(draft.nodes)).not.toContain('core.aiAgent');
    expect(draft.nodes.find((n) => n.type === 'core.messageAgent')!.parameters?.agentId).toBe('');
  });
});
