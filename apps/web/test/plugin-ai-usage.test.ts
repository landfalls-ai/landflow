/**
 * AI usage of plugin nodes that report their own model calls (`ctx.model` -> a `model` record): the registry's wrapper
 * counts them in the usage scope like the models node's calls (ai_usage rows, Insights totals, the caps), refuses a
 * `meterAiUsage` node once a cap is reached, stops a run that goes over one, and the journal shows a `model` span.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionEvent, ResolvedNodeType, Workflow } from '@landflow/engine';
import type { ExecuteRequest, ExecuteResponse } from '@landflow/protocol';
import type { JournalDraft } from '@/lib/shared/run-trace';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-plugin-ai-usage-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { withAiUsage } = await import('@/lib/server/ai-usage/plugin');
const { aiUsageMeter, executionScope, executionUsage, isUsageCapError, runInUsageScope } = await import('@/lib/server/ai-usage');
const { tagCredential } = await import('@/lib/server/ai-usage/credential-id');
const { createTranslator } = await import('@/lib/server/journal');
const { applyContent } = await import('@/lib/server/journal/content');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const model = (inputTokens: number, outputTokens: number) => ({ type: 'model' as const, model: 'qwen-test', provider: 'ollama', inputTokens, outputTokens, durationMs: 50, finishReason: 'stop', prompt: 'the question', answer: 'the answer' });
const request = (credentials?: ExecuteRequest['credentials']): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'ex_pai',
  workflowId: 'wf_pai',
  mode: 'manual',
  node: { id: 'n1', name: 'Generate', type: 'ai-sdk.generate', typeVersion: 1 },
  parameters: {},
  itemParameters: [{}],
  inputs: [[{ json: {} }]],
  ...(credentials && { credentials }),
});
const resolved = (records: ExecuteResponse['records'], meterAiUsage = true, calls = { n: 0 }): ResolvedNodeType => ({
  type: 'ai-sdk.generate',
  pluginId: 'ai-sdk',
  transport: 'http',
  descriptor: { name: 'generate', displayName: 'Generate', description: '', version: 1, kind: 'action', inputs: [], outputs: [], properties: [], ...(meterAiUsage && { meterAiUsage }) } as ResolvedNodeType['descriptor'],
  execute: async () => {
    calls.n++;
    return { outputs: [[{ json: { ok: true } }]], ...(records && { records }) };
  },
});

describe('withAiUsage', () => {
  it('counts a reported call in the execution scope: totals, a ledger row, the model', async () => {
    const scope = executionScope({ executionId: 'ex_pai_1', workflowId: 'wf_pai' });
    const response = await runInUsageScope(scope, () => withAiUsage(resolved([model(100, 20), model(30, 5)])).execute(request()));
    expect(response.outputs[0][0].json).toEqual({ ok: true });
    expect(executionUsage(scope)).toMatchObject({ inputTokens: 130, outputTokens: 25, calls: 2, models: [{ provider: 'ollama', model: 'qwen-test', calls: 2 }] });
    expect(aiUsageMeter().report({ executionId: 'ex_pai_1' }).totals).toMatchObject({ inputTokens: 130, outputTokens: 25, calls: 2 });
  });

  it('records the credential the request used', async () => {
    const scope = executionScope({ executionId: 'ex_pai_cred', workflowId: 'wf_pai' });
    const credential = tagCredential({ apiKey: 'k' }, 'cred_ai_sdk');
    await runInUsageScope(scope, () => withAiUsage(resolved([model(10, 2)])).execute(request({ aiSdkOpenAiCompatibleApi: credential })));
    expect(aiUsageMeter().sinceTotals('credential_id', 'cred_ai_sdk', 'day')).toMatchObject({ inputTokens: 10, outputTokens: 2, calls: 1 });
  });

  it('does nothing outside a usage scope and for nodes that report no model call', async () => {
    await expect(withAiUsage(resolved([model(5, 5)])).execute(request())).resolves.toBeDefined();
    const scope = executionScope({ executionId: 'ex_pai_none', workflowId: 'wf_pai' });
    await runInUsageScope(scope, () => withAiUsage(resolved(undefined)).execute(request()));
    expect(executionUsage(scope)).toBeUndefined();
  });

  it('stops a run whose call goes over the per-execution token cap, with the same UsageCapError', async () => {
    const scope = executionScope({ executionId: 'ex_pai_cap', workflowId: 'wf_pai', settings: { aiMaxTokensPerExecution: 100 } });
    const error = await runInUsageScope(scope, () => withAiUsage(resolved([model(90, 30)])).execute(request())).catch((e) => e);
    expect(isUsageCapError(error)).toBe(true);
    expect(error.message).toContain('AI usage cap reached: this execution used 120 tokens of its 100 tokens limit');
    // The call is counted even though the run stopped.
    expect(executionUsage(scope)).toMatchObject({ inputTokens: 90, outputTokens: 30, calls: 1 });
  });

  it('refuses a metering node before it runs once the cap is reached, but not a node that does not declare it', async () => {
    const scope = executionScope({ executionId: 'ex_pai_cap2', workflowId: 'wf_pai', settings: { aiMaxTokensPerExecution: 100 } });
    await runInUsageScope(scope, () => withAiUsage(resolved([model(100, 0)])).execute(request()));
    const calls = { n: 0 };
    const error = await runInUsageScope(scope, () => withAiUsage(resolved([], true, calls)).execute(request())).catch((e) => e);
    expect(isUsageCapError(error)).toBe(true);
    expect(calls.n).toBe(0);
    await expect(runInUsageScope(scope, () => withAiUsage(resolved([], false, calls)).execute(request()))).resolves.toBeDefined();
    expect(calls.n).toBe(1);
  });
});

describe('Run Trace', () => {
  const workflow: Workflow = { id: 'wf_pai', name: 'AI SDK', nodes: [{ id: 'gen', name: 'Generate', type: 'ai-sdk.generate', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] };
  const feed = () => {
    const drafts: JournalDraft[] = [];
    const translator = createTranslator({ workflow, executionId: 'ex_pai', emit: (d) => drafts.push(d) });
    const at = (s: number) => new Date(Date.parse('2026-11-07T10:00:00.000Z') + s * 1000).toISOString();
    const events = [
      { type: 'node.started', executionId: 'ex_pai', nodeId: 'gen', nodeName: 'Generate', source: 'main', at: at(0) },
      { type: 'node.record', executionId: 'ex_pai', nodeId: 'gen', nodeName: 'Generate', record: { ...model(100, 20), at: at(3) }, at: at(3) },
      { type: 'node.finished', executionId: 'ex_pai', nodeId: 'gen', nodeName: 'Generate', source: 'main', status: 'success', durationMs: 3000, itemCounts: [1], run: { startedAt: at(0), durationMs: 3000, status: 'success', source: 'main', inputs: [[]], outputs: [[{ json: { text: 'the answer', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } }]] }, at: at(3) },
    ] as unknown as ExecutionEvent[];
    for (const event of events) translator.feed(event);
    return drafts;
  };

  it('shows a model span under the node: model, tokens, duration, finish reason, prompt and answer', () => {
    const drafts = feed();
    const start = drafts.find((d) => d.type === 'span.started' && d.kind === 'model') as Extract<JournalDraft, { type: 'span.started' }>;
    expect(start).toMatchObject({ name: 'qwen-test', parentSpanId: 'node:gen:0', actor: { id: 'model:qwen-test', type: 'model' }, input: 'the question', attrs: { provider: 'ollama', durationMs: 50, finishReason: 'stop' } });
    expect(Date.parse(start.at!)).toBe(Date.parse('2026-11-07T10:00:03.000Z') - 50);
    const end = drafts.find((d) => d.type === 'span.ended' && d.spanId === start.spanId);
    expect(end).toMatchObject({ status: 'success', output: { text: 'the answer' }, usage: { inputTokens: 100, outputTokens: 20, model: 'qwen-test' } });
  });

  it('keeps the prompt and answer only as far as the trace content setting allows', () => {
    const drafts = feed();
    const kept = (mode: 'full' | 'summaries' | 'off') => {
      const start = applyContent(drafts.find((d) => d.type === 'span.started' && d.kind === 'model') as never, mode) as unknown as { input?: string; attrs?: unknown };
      const end = applyContent(drafts.find((d) => d.type === 'span.ended' && String(d.spanId).includes('/model:')) as never, mode) as unknown as { output?: unknown };
      return { start, end };
    };
    expect(kept('full').start.input).toBe('the question');
    expect(kept('off').start.input).toBeUndefined();
    expect(kept('off').end.output).toBeUndefined();
    expect(JSON.stringify(kept('off').start.attrs)).not.toContain('the question');
  });
});
