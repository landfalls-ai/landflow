/**
 * OpenTelemetry instrumentation of the executor: the `workflow.execute` and
 * `node.execute {type}` spans and the flow metrics of docs/observability.md.
 * Only `@opentelemetry/api` is used, so all of it is a no-op until the host
 * registers an SDK.
 */
import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type MeterProvider,
  type Span,
  type UpDownCounter,
} from '@opentelemetry/api';
import type { RunSource } from './types';

export const ENGINE_SCOPE = '@landflow/engine';
const ENGINE_VERSION = '0.1.0';

/** Bucket boundaries (ms) for every Landflow duration histogram. */
export const DURATION_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

export const engineTracer = () => trace.getTracer(ENGINE_SCOPE, ENGINE_VERSION);

/** `landflow.node.source` values: the port a sub-node was used through. */
export const SOURCE_ATTRIBUTE: Record<RunSource, string> = {
  main: 'main',
  tool: 'ai_tool',
  model: 'ai_languageModel',
  memory: 'ai_memory',
  embedding: 'ai_embedding',
  document: 'ai_document',
  textSplitter: 'ai_textSplitter',
  retriever: 'ai_retriever',
  reranker: 'ai_reranker',
};

interface Instruments {
  executions: Counter;
  executionDuration: Histogram;
  executionsActive: UpDownCounter;
  nodeRuns: Counter;
  nodeDuration: Histogram;
  nodeItems: Counter;
}

let cached: { provider: MeterProvider; instruments: Instruments } | undefined;

/**
 * Instruments are bound to the meter provider that was global when they were
 * created (the metrics API has no proxy), so re-create them if it changes.
 */
export function engineMetrics(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider !== provider) {
    const meter = provider.getMeter(ENGINE_SCOPE, ENGINE_VERSION);
    const advice = { explicitBucketBoundaries: DURATION_BUCKETS_MS };
    cached = {
      provider,
      instruments: {
        executions: meter.createCounter('landflow.executions', { description: 'Finished workflow executions' }),
        executionDuration: meter.createHistogram('landflow.execution.duration', { description: 'Workflow execution duration', unit: 'ms', advice }),
        executionsActive: meter.createUpDownCounter('landflow.executions.active', { description: 'Executions in progress (running or paused)' }),
        nodeRuns: meter.createCounter('landflow.node.runs', { description: 'Node runs, main flow and sub-node uses' }),
        nodeDuration: meter.createHistogram('landflow.node.duration', { description: 'Node run duration', unit: 'ms', advice }),
        nodeItems: meter.createCounter('landflow.node.items', { description: 'Items into and out of nodes' }),
      },
    };
  }
  return cached.instruments;
}

/** The span's ids, if it is actually recorded (no SDK or not sampled: undefined). */
export function recordedIds(span: Span): { traceId: string; spanId: string } | undefined {
  if (!span.isRecording()) return undefined;
  const { traceId, spanId } = span.spanContext();
  return { traceId, spanId };
}

export function failSpan(span: Span, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Start a child span of `parent` (default: the active context) and return it with its context. */
export function startChild(name: string, attributes: Attributes, parent: Context = context.active()): { span: Span; context: Context } {
  const span = engineTracer().startSpan(name, { attributes }, parent);
  return { span, context: trace.setSpan(parent, span) };
}
