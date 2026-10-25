/**
 * Editor assistant spans and metrics (docs/observability.md): `assistant.suggest
 * {nodeType}` and `assistant.chat` spans around the model calls (the usual
 * `gen_ai.chat` spans nest inside), plus request, suggestion and feedback counters.
 */
import type { Attributes, Meter } from '@opentelemetry/api';
import { DURATION_BUCKETS_MS } from '@landflow/engine';
import { hostMetrics, outcomeOf } from './metrics';
import { SpanKind, withSpan, type Span } from './spans';

export type AssistantRequestKind = 'suggest' | 'chat';
/** Suggestion kinds, plus `proposal` for changes proposed in the chat. */
export type AssistantChangeKind = 'fix' | 'param' | 'data' | 'next' | 'proposal';

function create(meter: Meter) {
  return {
    requests: meter.createCounter('landflow.assistant.requests', { description: 'Assistant requests (after-run suggestions and chat turns)' }),
    duration: meter.createHistogram('landflow.assistant.duration', {
      description: 'Duration of an assistant request',
      unit: 'ms',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
    }),
    suggestions: meter.createCounter('landflow.assistant.suggestions', { description: 'Suggestions and chat proposals shown in the editor' }),
    applied: meter.createCounter('landflow.assistant.applied', { description: 'Suggestions and chat proposals the user applied' }),
    dismissed: meter.createCounter('landflow.assistant.dismissed', { description: 'Suggestions the user dismissed' }),
  };
}

let cached: { meter: Meter; instruments: ReturnType<typeof create> } | undefined;

/** Built from the host meter, re-created when the meter provider changes (as hostMetrics() is). */
function instruments() {
  const { meter } = hostMetrics();
  if (cached?.meter !== meter) cached = { meter, instruments: create(meter) };
  return cached.instruments;
}

/**
 * Run one assistant request in its span and count it. `fn` may return an
 * outcome other than `ok` (e.g. `skipped` when a node isn't worth a model call).
 */
export async function traceAssistant<T>(
  kind: AssistantRequestKind,
  attributes: Attributes,
  fn: (span: Span, setOutcome: (outcome: string) => void) => Promise<T>,
): Promise<T> {
  const base: Attributes = { 'landflow.assistant.request': kind };
  const nodeType = kind === 'suggest' ? attributes['landflow.node.type'] : undefined;
  const started = performance.now();
  let outcome = 'ok';
  try {
    return await withSpan(`assistant.${kind}${nodeType ? ` ${nodeType}` : ''}`, { kind: SpanKind.INTERNAL, attributes: { ...base, ...attributes } }, (span) =>
      fn(span, (value) => {
        outcome = value;
        span.setAttribute('landflow.outcome', value);
      }),
    );
  } catch (error) {
    outcome = outcomeOf(error);
    throw error;
  } finally {
    const { requests, duration } = instruments();
    requests.add(1, { ...base, 'landflow.outcome': outcome });
    duration.record(performance.now() - started, base);
  }
}

/** Suggestions or proposals the editor is about to show. */
export function recordSuggestions(kinds: AssistantChangeKind[]) {
  const { suggestions } = instruments();
  for (const kind of kinds) suggestions.add(1, { 'landflow.assistant.kind': kind });
}

export function recordAssistantFeedback(kind: AssistantChangeKind, action: 'applied' | 'dismissed') {
  const { applied, dismissed } = instruments();
  (action === 'applied' ? applied : dismissed).add(1, { 'landflow.assistant.kind': kind });
}
