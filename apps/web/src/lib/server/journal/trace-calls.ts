/** A traced agent's model requests as journal spans (docs/run-trace.md). */
import type { AgentTraceSummary } from '../../shared/agents';
import type { JournalDraft, RunActor } from '../../shared/run-trace';

/**
 * Each model request the landflow-harness mod reported as a `model` span under the member's request (`<request>/model:<n>`):
 * named by the model, with its tokens, cache reads and writes, cost and model, and its own start and end. The run's fold
 * counts a model span as one request and takes it off the request's totals, which stay as the mod's sum.
 */
export function traceModelCalls(caller: RunActor, trace: AgentTraceSummary, requestSpan: string, record: (draft: JournalDraft) => void) {
  (trace.calls ?? []).forEach((call, index) => {
    const spanId = `${requestSpan}/model:${index + 1}`;
    const ended = typeof call.at === 'number' && Number.isFinite(call.at) && call.at > 0 ? call.at : undefined;
    const at = (ms: number | undefined) => (ms === undefined ? {} : { at: new Date(ms).toISOString() });
    const actor: RunActor = { id: `model:${call.model}`, name: call.model, type: 'model' };
    record({
      type: 'span.started',
      spanId,
      parentSpanId: requestSpan,
      kind: 'model',
      name: call.model,
      actor,
      caller,
      attrs: { ...(call.agent && { subagent: call.agent }), durationMs: call.ms },
      ...at(ended === undefined ? undefined : ended - call.ms),
    });
    record({
      type: 'span.ended',
      spanId,
      status: 'success',
      usage: { inputTokens: call.inputTokens, outputTokens: call.outputTokens, cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: call.cacheWriteTokens, costUsd: call.costUsd, model: call.model },
      ...at(ended),
    });
  });
}
