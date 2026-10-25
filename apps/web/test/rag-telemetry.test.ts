import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { defineNode } from '@landflow/sdk';
import type { Embeddings, LanguageModel } from '@landflow/engine';
import { searchTerms } from '@/lib/server/rag/search';
import { outputsOf, runFlow } from './helpers';

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

const spans = new InMemorySpanExporter();
const reader = new TestReader();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});
afterAll(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});
beforeEach(() => spans.reset());

const named = (name: string) => spans.getFinishedSpans().filter((span) => span.name === name);
const parentOf = (span: ReadableSpan) => spans.getFinishedSpans().find((s) => s.spanContext().spanId === span.parentSpanContext?.spanId);
async function points(name: string) {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).filter((m) => m.descriptor.name === name).flatMap((m) => m.dataPoints as DataPoint<number>[]);
}

const embed = (text: string) => {
  const vector = new Array<number>(16).fill(0);
  for (const word of searchTerms(text)) vector[[...word].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 16] += 1;
  return vector;
};
const embeddingsNode = defineNode({
  description: { name: 'embed', displayName: 'Embed', description: '', version: 1, kind: 'subnode', supplies: 'ai_embedding', inputs: [], outputs: [{ type: 'ai_embedding' }], properties: [] },
  supplyData: (): Embeddings => ({ provider: 'test', model: 'hash', embedDocuments: async (texts) => texts.map(embed), embedQuery: async (text) => embed(text) }),
});
const modelNode = defineNode({
  description: {
    name: 'model',
    displayName: 'Model',
    description: '',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_languageModel',
    inputs: [],
    outputs: [{ type: 'ai_languageModel' }],
    properties: [{ name: 'fail', displayName: 'Fail', type: 'boolean', default: false }],
  },
  supplyData: (ctx): LanguageModel => {
    const fail = Boolean(ctx.getNodeParameter('fail'));
    return {
      provider: 'test',
      model: fail ? 'primary' : 'backup',
      async generate(input) {
        if (fail) throw new Error('overloaded');
        const last = input.messages.at(-1)!;
        if (input.tools.length && last.role === 'user') return { text: '', toolCalls: [{ id: 'c1', name: 'search', input: { query: 'refund days' } }], stopReason: 'tool_use' };
        return { text: 'done', toolCalls: [], stopReason: 'stop' };
      },
    };
  },
});
const extra = { embed: embeddingsNode, model: modelNode };

describe('retrieval, guardrails and fallback telemetry', () => {
  it('traces inserts and tool searches as vector_store spans under the right node runs', async () => {
    const insert = await runFlow(
      [
        { name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection: 'telemetry', clearStore: true } },
        { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: { jsonMode: 'expressionData', jsonData: '{{ $json.text }}' } },
        { name: 'Embed', type: 'test.embed' },
      ],
      [['Start', 'Store'], ['Loader', 'Store', 'ai_document'], ['Embed', 'Store', 'ai_embedding']],
      { input: [{ text: 'Refunds within 30 days' }, { text: 'Free shipping over 50 euros' }], extra },
    );
    expect(insert.status).toBe('success');
    const [inserted] = named('vector_store.insert memory');
    expect(inserted.attributes).toMatchObject({
      'landflow.vector_store': 'memory',
      'db.system.name': 'landflow.memory',
      'db.collection.name': 'telemetry',
      'db.operation.name': 'insert',
      'landflow.retrieval.documents': 2,
    });
    expect(parentOf(inserted)?.name).toBe('node.execute core.vectorStoreInMemory');
    expect(named('node.execute test.embed')[0].attributes['landflow.node.source']).toBe('ai_embedding');
    expect(named('node.execute core.documentDefaultDataLoader')[0].attributes['landflow.node.source']).toBe('ai_document');

    spans.reset();
    const result = await runFlow(
      [
        { name: 'Agent', type: 'core.aiAgent', parameters: { prompt: 'How long for a refund?' } },
        { name: 'Model', type: 'test.model' },
        { name: 'Docs', type: 'core.vectorStoreInMemory', parameters: { mode: 'retrieve-as-tool', collection: 'telemetry', toolName: 'search', options: { searchMode: 'hybrid' } } },
        { name: 'Embed', type: 'test.embed' },
      ],
      [['Start', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Docs', 'Agent', 'ai_tool'], ['Embed', 'Docs', 'ai_embedding']],
      { extra },
    );
    expect(outputsOf(result, 'Agent')[0][0].output).toBe('done');
    const [query] = named('vector_store.query memory');
    expect(query.attributes).toMatchObject({ 'db.operation.name': 'query', 'landflow.retrieval.mode': 'hybrid', 'landflow.retrieval.top_k': 4, 'landflow.retrieval.documents': 2 });
    const tool = parentOf(query)!;
    expect(tool.attributes).toMatchObject({ 'landflow.node.source': 'ai_tool', 'landflow.node.name': 'Docs' });
    expect(parentOf(tool)?.attributes['landflow.node.name']).toBe('Agent');

    const requests = await points('landflow.retrieval.requests');
    expect(requests.find((p) => p.attributes['db.operation.name'] === 'query' && p.attributes['landflow.outcome'] === 'ok')?.value).toBeGreaterThanOrEqual(1);
  });

  it('marks a fallback on the root node’s span', async () => {
    const result = await runFlow(
      [
        { name: 'Agent', type: 'core.aiAgent', parameters: { prompt: 'hi', needsFallback: true } },
        { name: 'Primary', type: 'test.model', parameters: { fail: true } },
        { name: 'Backup', type: 'test.model' },
      ],
      [['Start', 'Agent'], ['Primary', 'Agent', 'ai_languageModel', 0, 0], ['Backup', 'Agent', 'ai_languageModel', 0, 1]],
      { extra },
    );
    expect(outputsOf(result, 'Agent')[0][0].output).toBe('done');
    const [agent] = named('node.execute core.aiAgent');
    const event = agent.events.find((e) => e.name === 'landflow.ai.fallback');
    expect(event?.attributes).toMatchObject({ 'gen_ai.request.model': 'primary', 'landflow.ai.fallback.model': 'backup', 'error.message': 'overloaded' });
  });

  it('traces each Guardrails check and counts results', async () => {
    await runFlow([{ name: 'Guard', type: 'core.guardrails', parameters: { operation: 'check', text: '{{ $json.t }}', pii: true, secrets: true, jailbreak: true } }], [['Start', 'Guard']], {
      input: [{ t: 'hello' }, { t: 'mail me at jane@example.com' }],
    });
    const checks = named('guardrails.check');
    expect(checks.map((s) => s.attributes['landflow.guardrails.passed'])).toEqual([true, false]);
    expect(checks[1].attributes).toMatchObject({ 'landflow.guardrails.mode': 'check', 'landflow.guardrails.checks': ['pii', 'secrets', 'jailbreak'], 'landflow.guardrails.violations': 1, 'landflow.guardrails.failed': ['pii'] });
    expect(JSON.stringify(checks.map((s) => s.attributes))).not.toContain('jane@example.com');
    const counted = await points('landflow.guardrails.checks');
    expect(counted.find((p) => p.attributes['landflow.guardrails.result'] === 'fail')?.value).toBeGreaterThanOrEqual(1);
  });
});
