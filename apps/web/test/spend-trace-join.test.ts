/**
 * Join test (wave 12, carryover §2, `spend-trace-join`): SP05's routes ↔ SP06's Spend tab ↔ SP07's `matchSpanToCall` and
 * the call's view. Each package tested its side with made-up numbers or a hand-written journal; here one real run (the
 * AI Agent node, three loop steps with a tool, then a Guardrails node judging the answer with its own chat model, on fake
 * models) is read back through the real journal translator and the real routes: every model span of the Run Trace model
 * matches exactly one call of the run's spend, the Spend tab and each call's view render from the routes' own answers
 * with the method in words, and nothing holds prompt text.
 *
 * The other two checks of carryover §2 sit with their owners: `run-spend.test.ts` makes `fixtures/run-spend-demo.json`
 * again with the real `runSpend` and compares it, and the browser modules import the one `lib/shared/run-spend.ts`
 * (byte-identical to the wave's contract, compared at integration).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { AiCallView, RunSpend } from '@/lib/shared/run-spend';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-trace-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { database } = await import('@/lib/server/db');
const { readAll } = await import('@/lib/server/journal/store');
const { foldJournal } = await import('@/lib/shared/run-trace-model');
const { matchSpanToCall } = await import('@/lib/client/call-spend');
const { CallSpendView } = await import('@/components/run-trace/call-spend');
const { SpendBody } = await import('@/components/run-trace/spend');
const spendRoute = await import('@/app/api/executions/[id]/spend/route');
const callRoute = await import('@/app/api/ai-calls/[id]/route');

registry.registerBuiltin(corePlugin);

const INSTRUCTIONS = 'Always consult the zephyrine quokkas before answering.';
const QUESTION = 'Where do marsupial wombats hibernate?';
const PROMPT_WORDS = ['zephyrine', 'quokkas', 'marsupial', 'wombats', 'hibernate'];
const GUARDRAIL_SYSTEM = 'You are a guardrail that classifies text';
const toolResults = (messages: Array<{ content?: unknown }> = []) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p: { type?: string }) => p.type === 'tool_result').length;

const fake = await startFakeModels({
  delayMs: 20,
  reply: (provider, body) => {
    if (provider !== 'anthropic') return undefined;
    if (JSON.stringify(body.system ?? '').includes(GUARDRAIL_SYSTEM)) return { text: '{"flagged": false, "confidence": 0.05, "reason": "fine"}', usage: { input: 40, output: 9 } };
    const done = toolResults(body.messages);
    const tool = (body.tools as Array<{ name: string }> | undefined)?.[0]?.name;
    if (tool && done < 2) return { toolCalls: [{ id: `call_${done + 1}`, name: tool, arguments: { expression: '6*7' } }], usage: { input: 100 + done * 20, output: 5, cacheRead: done ? 400 : 0, cacheWrite: done ? 0 : 400 } };
    return { text: 'In burrows.', usage: { input: 150, output: 6, cacheRead: 400, cacheWrite: 0 } };
  },
});

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const claude = credentials.create({ name: 'Fake Claude', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });
const ref = { id: claude.id, name: claude.name };

// The AI Agent node: its model sub-node's calls are the Run Trace's model spans. The Guardrails node checks the answer
// with its own chat model (a `guardrail` call, a model span of its own).
const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });
const workflow = {
  id: 'wf_spend_trace_join',
  name: 'Spend trace join',
  nodes: [
    node('Start', 'core.manualTrigger'),
    node('Agent', 'core.aiAgent', { prompt: QUESTION, systemMessage: INSTRUCTIONS }),
    node('Model', 'core.anthropicChatModel', { model: 'claude-trace-join', fallback: false }, { credentials: { anthropicApi: ref } }),
    node('Calculator', 'core.calculatorTool'),
    node('Guard', 'core.guardrails', { operation: 'check', text: '{{ $json.output }}', pii: false, secrets: false, nsfw: true }),
    node('Guard model', 'core.anthropicChatModel', { model: 'claude-guard-join', fallback: false }, { credentials: { anthropicApi: ref } }),
  ],
  connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), edge('Calculator', 'Agent', 'ai_tool'), edge('Agent', 'Guard'), edge('Guard model', 'Guard', 'ai_languageModel')],
} as unknown as Workflow;
store.saveWorkflow(workflow);

const get = async <T,>(route: { GET: unknown }, id: string) => {
  const response = await (route.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request(`http://landflow.test/${id}`), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  const text = await response.clone().text();
  return { text, body: (await response.json()) as T };
};

describe('spend-trace-join: the routes, the Spend tab and the call’s view on one real run', () => {
  it('every model span matches one call; the tab and each call render from the routes with the method named and no prompt text', async () => {
    const record = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(record.error?.message ?? record.status).toBe('success');
    const usage = database().all<{ id: string }>("SELECT id FROM ai_usage WHERE execution_id = ? AND operation = 'chat'", record.executionId);
    for (let i = 0; i < 300 && database().all(`SELECT id FROM ai_call_parts WHERE usage_id IN (${usage.map(() => '?').join(',')})`, ...usage.map((u) => u.id)).length < 3; i++) await new Promise((r) => setTimeout(r, 20));

    const spend = await get<RunSpend>(spendRoute, record.executionId);
    // Three loop steps and the output guardrail's verdict.
    expect(spend.body.calls.map((c) => c.purpose).sort()).toEqual(['answer', 'answer', 'answer', 'guardrail']);
    expect(spend.body.calls.filter((c) => c.purpose === 'answer').map((c) => c.iteration).sort()).toEqual([1, 2, 3]);

    // The Run Trace model from the real journal: each model span is exactly one call, no call claimed twice.
    const model = foldJournal(readAll(record.executionId));
    const spans = Object.values(model.spans).filter((s) => s.kind === 'model');
    expect(spans.length).toBeGreaterThanOrEqual(3);
    const matched = spans.map((s) => matchSpanToCall(s, spend.body.calls));
    expect(matched.every(Boolean)).toBe(true);
    expect(new Set(matched.map((c) => c!.usageId)).size).toBe(spans.length);
    const answers = spend.body.calls.filter((c) => c.purpose === 'answer').map((c) => c.usageId);
    expect(answers.every((id) => matched.some((c) => c!.usageId === id))).toBe(true);

    // SP06's tab from the route's answer and the real model: the method in words, every call opens its span.
    const tab = renderToStaticMarkup(createElement(SpendBody, { spend: spend.body, open: () => {}, model }));
    expect(tab).toContain('Estimated');
    expect(tab).toContain('Guardrail check');
    expect(tab.match(/aria-label="Open the call at/g)?.length ?? 0).toBeGreaterThanOrEqual(3);

    // SP07's view of each call from the route's answer.
    for (const call of spend.body.calls) {
      const view = await get<AiCallView>(callRoute, call.usageId);
      const html = renderToStaticMarkup(createElement(CallSpendView, { view: view.body }));
      if (view.body.parts) expect(html, call.usageId).toContain('Estimated');
      else expect(html, call.usageId).toContain('No split for this call');
      for (const word of PROMPT_WORDS) {
        expect(view.text.toLowerCase(), call.usageId).not.toContain(word);
        expect(html.toLowerCase(), call.usageId).not.toContain(word);
      }
    }
    for (const word of PROMPT_WORDS) {
      expect(spend.text.toLowerCase()).not.toContain(word);
      expect(tab.toLowerCase()).not.toContain(word);
    }
  });
});
