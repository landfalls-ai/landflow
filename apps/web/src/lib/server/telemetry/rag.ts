/**
 * Retrieval and guardrail spans (docs/observability.md): `vector_store.{insert,query} {store}` client spans
 * for vector store calls, `retrieval.rerank` for reranking and `guardrails.check` for the Guardrails node,
 * plus the `landflow.retrieval.*` and `landflow.guardrails.*` metrics. Embedding and model calls inside
 * them are their own `gen_ai.embeddings` / `gen_ai.chat` children.
 */
import { metrics, type Attributes, type Counter, type Histogram, type MeterProvider } from '@opentelemetry/api';
import { DURATION_BUCKETS_MS } from '@landflow/engine';
import { telemetryConfig } from './config';
import { HOST_SCOPE, outcomeOf, type Outcome } from './metrics';
import { SpanKind, withSpan } from './spans';

interface Instruments {
  retrievalRequests: Counter;
  retrievalDuration: Histogram;
  retrievalDocuments: Counter;
  guardrailChecks: Counter;
}

let cached: { provider: MeterProvider; instruments: Instruments } | undefined;

function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider !== provider) {
    const meter = provider.getMeter(HOST_SCOPE, telemetryConfig.serviceVersion);
    const advice = { explicitBucketBoundaries: DURATION_BUCKETS_MS };
    cached = {
      provider,
      instruments: {
        retrievalRequests: meter.createCounter('landflow.retrieval.requests', { description: 'Vector store inserts and queries' }),
        retrievalDuration: meter.createHistogram('landflow.retrieval.duration', { description: 'Duration of a vector store insert or query', unit: 'ms', advice }),
        retrievalDocuments: meter.createCounter('landflow.retrieval.documents', { description: 'Documents inserted into or returned by vector stores' }),
        guardrailChecks: meter.createCounter('landflow.guardrails.checks', { description: 'Texts checked by the Guardrails node' }),
      },
    };
  }
  return cached.instruments;
}

export type VectorStoreOperation = 'insert' | 'query';

export interface VectorStoreCall {
  /** `memory`, `sqlite` or `pgvector`. */
  store: string;
  /** `db.system.name`: `landflow.memory`, `sqlite`, `postgresql`. */
  system: string;
  collection: string;
  /** Extra attributes: `landflow.retrieval.mode`, `landflow.retrieval.top_k`… */
  attributes?: Attributes;
}

/** Run a vector store insert or query in a `vector_store.{operation} {store}` span; `count` is the documents it wrote or returned. */
export async function traceVectorStore<T>(operation: VectorStoreOperation, call: VectorStoreCall, fn: () => Promise<T>, count: (result: T) => number): Promise<T> {
  const base = { 'landflow.vector_store': call.store, 'db.operation.name': operation };
  const started = performance.now();
  let outcome: Outcome = 'ok';
  try {
    return await withSpan(
      `vector_store.${operation} ${call.store}`,
      {
        kind: SpanKind.CLIENT,
        attributes: { ...base, 'db.system.name': call.system, 'db.collection.name': call.collection, ...call.attributes },
      },
      async (span) => {
        const result = await fn();
        const documents = count(result);
        span.setAttribute('landflow.retrieval.documents', documents);
        if (documents) instruments().retrievalDocuments.add(documents, base);
        return result;
      },
    );
  } catch (error) {
    outcome = outcomeOf(error);
    throw error;
  } finally {
    instruments().retrievalRequests.add(1, { ...base, 'landflow.outcome': outcome });
    instruments().retrievalDuration.record(performance.now() - started, base);
  }
}

/** Rerank retrieved documents in a `retrieval.rerank` span (the model calls are its `gen_ai.chat` children). */
export function traceRerank<T>(info: { method: string; model?: string; documents: number; topK: number }, fn: () => Promise<T>): Promise<T> {
  return withSpan(
    'retrieval.rerank',
    {
      attributes: {
        'landflow.rerank.method': info.method,
        ...(info.model && { 'gen_ai.request.model': info.model }),
        'landflow.rerank.documents': info.documents,
        'landflow.retrieval.top_k': info.topK,
      },
    },
    fn,
  );
}

export interface GuardrailsResult {
  passed: boolean;
  violations: Array<{ check: string }>;
}

/** One Guardrails check of a text in a `guardrails.check` span; counts in `landflow.guardrails.checks` by result. */
export function traceGuardrails<T extends GuardrailsResult>(info: { mode: string; checks: string[]; stage?: string }, fn: () => Promise<T>): Promise<T> {
  return withSpan('guardrails.check', { attributes: { 'landflow.guardrails.mode': info.mode, 'landflow.guardrails.checks': info.checks, ...(info.stage && { 'landflow.guardrails.stage': info.stage }) } }, async (span) => {
    const result = await fn();
    const failed = [...new Set(result.violations.map((v) => v.check))];
    span.setAttributes({ 'landflow.guardrails.passed': result.passed, 'landflow.guardrails.violations': result.violations.length, 'landflow.guardrails.failed': failed });
    instruments().guardrailChecks.add(1, { 'landflow.guardrails.mode': info.mode, 'landflow.guardrails.result': result.passed ? 'pass' : 'fail' });
    return result;
  });
}
