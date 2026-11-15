/**
 * Attribution on each model call (wave 11, SP01): node, span, purpose, iteration, caller agent, duration and stop reason
 * on the `ai_usage` row; the call context; the metrics' cache token types and purpose label; the `ai.call` event keys;
 * the recorded-call listener. Model calls are fakes (traceChat with a synthetic response, the fake OpenAI-compatible server).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ai-attr-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const reader = new TestReader();
const spans = new InMemorySpanExporter();

const { aiUsageMeter, UsageScope, runInUsageScope, savePriceOverrides } = await import('@/lib/server/ai-usage');
const { traceChat, traceEmbeddings } = await import('@/lib/server/telemetry/ai');
const { withCallNote, withCallPurpose, setRecordedCallListener } = await import('@/lib/server/ai-usage/call-context');
const { runInNode } = await import('@/lib/server/ai-usage/node-context');
const { listUsageEvents } = await import('@/lib/server/usage/query');
const { database } = await import('@/lib/server/db');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
type RecordedCall = import('@/lib/server/ai-usage/call-context').RecordedCall;

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  savePriceOverrides([{ provider: 'anthropic', model: 'claude-test', input: 1, output: 2 }]);
  aiUsageMeter().invalidatePrices();
});

afterAll(async () => {
  setRecordedCallListener(undefined);
  await fake.close();
  trace.disable();
  metrics.disable();
  context.disable();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const request = { system: 'anthropic', model: 'claude-test' };
const reply = { responseModel: 'claude-test', inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10, finishReasons: ['end_turn'] };
const chat = (extra: Partial<typeof reply> & { gatewayRequestId?: string; callId?: string; gatewayKeyHash?: string } = {}) => traceChat(request, async () => 'ok', () => ({ ...reply, ...extra }));
const rows = (where = '1=1', ...params: string[]) => database().all<Record<string, any>>(`SELECT * FROM ai_usage WHERE ${where} ORDER BY at, id`, ...params); // eslint-disable-line @typescript-eslint/no-explicit-any
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('what each call was for', () => {
  it('writes node, span, purpose, iteration, duration and stop reason for a chat call under a node and an agent loop', async () => {
    const scope = new UsageScope({ executionId: 'ex_attr_1', workflowId: 'wf_attr' }, [], undefined, aiUsageMeter());
    await runInUsageScope(scope, () =>
      runInNode({ id: 'n_ab12', name: 'Agent', type: 'core.aiAgent' }, () => withCallNote({ iteration: 2 }, () => traceChat(request, async () => { await wait(); return 'ok'; }, () => reply))),
    );
    const [row] = rows('execution_id = ?', 'ex_attr_1');
    expect(row).toMatchObject({ node_id: 'n_ab12', purpose: 'answer', iteration: 2, stop_reason: 'end_turn', cache_read_tokens: 60, cache_write_tokens: 10 });
    expect(row.duration_ms).toBeGreaterThanOrEqual(4);
    expect(row.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(spans.getFinishedSpans().some((s) => s.spanContext().spanId === row.span_id && s.attributes['landflow.node.id'] === 'n_ab12' && s.attributes['landflow.ai.iteration'] === 2)).toBe(true);
  });

  it('gives an embeddings call embed, an explicit purpose its own, and leaves a call outside any run unset', async () => {
    const scope = new UsageScope({ executionId: 'ex_attr_2' }, [], undefined, aiUsageMeter());
    await runInUsageScope(scope, async () => {
      await traceEmbeddings(request, async () => 1, () => ({ inputTokens: 10 }));
      await withCallPurpose('summary', () => chat());
    });
    expect(rows('execution_id = ?', 'ex_attr_2').map((r) => [r.operation, r.purpose])).toEqual(expect.arrayContaining([['embeddings', 'embed'], ['chat', 'summary']]));
    // A spotlight call has neither an execution nor a session: no purpose.
    const spot = new UsageScope({ surface: 'spotlight', userId: 'usr_attr_spot' }, [], undefined, aiUsageMeter());
    await runInUsageScope(spot, () => chat());
    expect(rows('user_id = ?', 'usr_attr_spot')[0].purpose).toBeNull();
  });

  it('names the lead as the caller of a team member and a sub-agent, and nobody for the lead itself', async () => {
    const lead = new UsageScope({ agentId: 'ag_lead', sessionId: 'ses_attr_3' }, [], undefined, aiUsageMeter());
    const member = new UsageScope({ agentId: 'ag_member', sessionId: 'ses_attr_3m' }, [], lead);
    await runInUsageScope(lead, () => chat());
    await runInUsageScope(member, () => chat());
    expect(rows('agent_id = ?', 'ag_lead')[0].caller_agent_id).toBeNull();
    expect(rows('agent_id = ?', 'ag_member')[0].caller_agent_id).toBe('ag_lead');
  });

  it('keeps an imported row’s cost floor on takeover and gains the columns', async () => {
    const db = database();
    db.insertNew('ai_usage', { id: 'au_imported_attr', at: new Date().toISOString(), day: aiUsageMeter().today(), source: 'litellm', runtime: 'litellm', provider: 'anthropic', model: 'claude-test', operation: 'chat', input_tokens: 100, output_tokens: 20, cost: 5, gateway_request_id: 'req_attr_1' });
    const heard: RecordedCall[] = [];
    setRecordedCallListener((call) => heard.push(call));
    const scope = new UsageScope({ executionId: 'ex_attr_4' }, [], undefined, aiUsageMeter());
    await runInUsageScope(scope, () => runInNode({ id: 'n_take', name: 'N', type: 't' }, () => chat({ gatewayRequestId: 'req_attr_1' })));
    const [row] = rows('id = ?', 'au_imported_attr');
    expect(row).toMatchObject({ cost: 5, node_id: 'n_take', purpose: 'answer', stop_reason: 'end_turn', execution_id: 'ex_attr_4' });
    expect(rows("gateway_request_id = 'req_attr_1'")).toHaveLength(1);
    expect(heard.map((c) => c.usageId)).toEqual(['au_imported_attr']);
    setRecordedCallListener(undefined);
  });

  it('adds the new keys to the ai.call event and keeps the seven Landledger reads', async () => {
    const scope = new UsageScope({ agentId: 'ag_ev', sessionId: 'ses_ev' }, [], undefined, aiUsageMeter());
    await runInUsageScope(scope, () => runInNode({ id: 'n_ev', name: 'N', type: 't' }, () => withCallNote({ iteration: 3 }, () => chat())));
    const event = listUsageEvents({ kinds: ['ai.call'] }, { limit: 50 }).find((e) => e.attrs?.sessionId === 'ses_ev')!;
    // Landledger reads these seven (landledger apps/api/src/ingest/build.ts 179-188).
    expect(event.attrs).toMatchObject({ provider: 'anthropic', model: 'claude-test', operation: 'chat', input: 100, output: 20, cacheRead: 60, cacheWrite: 10 });
    expect(event.attrs).toMatchObject({ purpose: 'answer', nodeId: 'n_ev', sessionId: 'ses_ev', iteration: 3, usageId: rows('session_id = ?', 'ses_ev')[0].id });
  });
});

describe('the call context and the listener', () => {
  const draft = { segments: [{ part: 'system' as never, where: 'system' as const, text: 'secret words' }] };

  it('inherits purpose and iteration, not the draft; the first chat call takes the draft, later ones none', async () => {
    const heard: RecordedCall[] = [];
    setRecordedCallListener((call) => heard.push(call));
    const scope = new UsageScope({ executionId: 'ex_attr_5' }, [], undefined, aiUsageMeter());
    await runInUsageScope(scope, () =>
      withCallNote({ purpose: 'judge', iteration: 4, draft }, async () => {
        await withCallNote({}, () => chat());
        await chat();
        await chat();
      }),
    );
    expect(heard.map((c) => [c.note.purpose, c.note.iteration, c.note.draft ? 'draft' : 'none'])).toEqual([['judge', 4, 'none'], ['judge', 4, 'draft'], ['judge', 4, 'none']]);
    setRecordedCallListener(undefined);
  });

  it('survives a listener that throws, and a new listener replaces the old one', async () => {
    const first = vi.fn(() => { throw new Error('boom'); });
    const second = vi.fn();
    setRecordedCallListener(first);
    const scope = new UsageScope({ executionId: 'ex_attr_6' }, [], undefined, aiUsageMeter());
    await runInUsageScope(scope, () => chat());
    expect(rows('execution_id = ?', 'ex_attr_6')).toHaveLength(1);
    setRecordedCallListener(second);
    await runInUsageScope(scope, () => chat());
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    setRecordedCallListener(undefined);
  });
});

describe('metrics', () => {
  it('counts cache_read and cache_write apart from input, with the purpose and no id label', async () => {
    await reader.collect();
    const scope = new UsageScope({ executionId: 'ex_attr_7', workflowId: 'wf_x' }, [], undefined, aiUsageMeter());
    await runInUsageScope(scope, () => runInNode({ id: 'n_m', name: 'N', type: 't' }, () => withCallPurpose('guardrail', () => chat())));
    const { resourceMetrics } = await reader.collect();
    const points = (name: string): DataPoint<number>[] =>
      resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).filter((m) => m.descriptor.name === name).flatMap((m) => m.dataPoints as DataPoint<number>[]);
    const tokens = points('landflow.ai.tokens').filter((p) => p.attributes['landflow.ai.purpose'] === 'guardrail');
    const byType = Object.fromEntries(tokens.map((p) => [p.attributes['gen_ai.token.type'], p.value]));
    expect(byType).toEqual({ input: 100, output: 20, cache_read: 60, cache_write: 10 });
    for (const name of ['landflow.ai.tokens', 'landflow.ai.cost', 'landflow.ai.requests']) {
      const point = points(name).find((p) => p.attributes['landflow.ai.purpose'] === 'guardrail');
      expect(point, name).toBeDefined();
      expect(Object.keys(point!.attributes).some((k) => /node|execution|agent|user|session|run/.test(k.replace('landflow.ai.', '')))).toBe(false);
    }
  });
});

describe('a real run', () => {
  it('records the innermost node an agent workflow’s model call ran under', async () => {
    savePriceOverrides([{ provider: 'openai', model: 'gpt-test', input: 1, output: 2 }]);
    aiUsageMeter().invalidatePrices();
    const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
    const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });
    const workflow: Workflow = {
      id: 'wf_attr_run',
      name: 'Attribution run',
      nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.aiAgent', { prompt: 'hi' }), node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } })],
      connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
    };
    store.saveWorkflow(workflow);
    await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    const [row] = rows('workflow_id = ?', 'wf_attr_run');
    expect(row).toMatchObject({ node_id: 'Model', purpose: 'answer' }); // the innermost node: the model sub-node
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
