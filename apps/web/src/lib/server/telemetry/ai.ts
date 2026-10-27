/** `gen_ai.chat {model}` / `gen_ai.embeddings {model}` client spans (OTel GenAI conventions) and the `landflow.ai.*` metrics. */
import type { Attributes } from '@opentelemetry/api';
import { afterModelCall, beforeModelCall, isUsageCapError } from '../ai-usage/scope';
import { hostMetrics, outcomeOf, type Outcome } from './metrics';
import { SpanKind, withSpan } from './spans';

export interface ChatRequest {
  /** `gen_ai.system`: anthropic, ollama, openai… */
  system: string;
  model: string;
  /** The model credential the call uses, for the caps per credential (lib/server/ai-usage). */
  credentialId?: string;
  /** Extra request attributes, e.g. `gen_ai.request.max_tokens`, `server.address`. */
  attributes?: Attributes;
}

export interface ChatResponse {
  responseModel?: string;
  /** The whole prompt, cached tokens included. */
  inputTokens?: number;
  outputTokens?: number;
  /** Parts of `inputTokens` served from the provider's cache (Anthropic cache reads, OpenAI cached input) and written to it (Anthropic). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  finishReasons?: string[];
}

/** Run one chat-completion call in a `gen_ai.chat {model}` span and record its metrics. */
export function traceChat<T>(request: ChatRequest, call: () => Promise<T>, describe: (result: T) => ChatResponse): Promise<T> {
  return traceGenAi('chat', request, call, describe);
}

export interface EmbeddingsResponse {
  responseModel?: string;
  inputTokens?: number;
  /** `gen_ai.embeddings.dimension.count` */
  dimensions?: number;
}

/** Run one embeddings call in a `gen_ai.embeddings {model}` span; it counts in the same `landflow.ai.*` metrics as chat (input tokens only). */
export function traceEmbeddings<T>(request: ChatRequest, call: () => Promise<T>, describe: (result: T) => EmbeddingsResponse): Promise<T> {
  return traceGenAi('embeddings', request, call, (result) => {
    const response = describe(result);
    return { responseModel: response.responseModel, inputTokens: response.inputTokens, ...(response.dimensions && { dimensions: response.dimensions }) };
  });
}

async function traceGenAi<T>(
  operation: 'chat' | 'embeddings',
  request: ChatRequest,
  call: () => Promise<T>,
  describe: (result: T) => ChatResponse & { dimensions?: number },
): Promise<T> {
  const instruments = hostMetrics();
  const base = { 'gen_ai.system': request.system, 'gen_ai.request.model': request.model };
  // AI usage caps (lib/server/ai-usage): a reached cap refuses the call before it is made.
  try {
    beforeModelCall({ provider: request.system, model: request.model, operation, ...(request.credentialId && { credentialId: request.credentialId }) });
  } catch (error) {
    if (isUsageCapError(error)) instruments.aiCapsReached.add(1, { ...base, 'landflow.ai.cap.when': 'before' });
    throw error;
  }
  const started = performance.now();
  let outcome: Outcome = 'ok';
  try {
    return await withSpan(
      `gen_ai.${operation} ${request.model}`,
      { kind: SpanKind.CLIENT, attributes: { ...base, 'gen_ai.operation.name': operation, ...request.attributes } },
      async (span) => {
        try {
          const result = await call();
          const response = describe(result);
          span.setAttributes({
            ...(response.responseModel && { 'gen_ai.response.model': response.responseModel }),
            ...(response.inputTokens !== undefined && { 'gen_ai.usage.input_tokens': response.inputTokens }),
            ...(response.outputTokens !== undefined && { 'gen_ai.usage.output_tokens': response.outputTokens }),
            ...(response.cacheReadTokens && { 'gen_ai.usage.cache_read.input_tokens': response.cacheReadTokens }),
            ...(response.cacheWriteTokens && { 'gen_ai.usage.cache_creation.input_tokens': response.cacheWriteTokens }),
            ...(response.finishReasons && { 'gen_ai.response.finish_reasons': response.finishReasons }),
            ...(response.dimensions && { 'gen_ai.embeddings.dimension.count': response.dimensions }),
          });
          if (response.inputTokens) instruments.aiTokens.add(response.inputTokens, { ...base, 'gen_ai.token.type': 'input' });
          if (response.outputTokens) instruments.aiTokens.add(response.outputTokens, { ...base, 'gen_ai.token.type': 'output' });
          // Token & cost tracking: priced, stored, and stopped here when it went over a cap.
          const usage = {
            provider: request.system,
            model: response.responseModel || request.model,
            operation,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            cacheReadTokens: response.cacheReadTokens,
            cacheWriteTokens: response.cacheWriteTokens,
            ...(request.credentialId && { credentialId: request.credentialId }),
          };
          let cost: number | undefined;
          try {
            cost = afterModelCall(usage);
          } catch (error) {
            if (isUsageCapError(error)) instruments.aiCapsReached.add(1, { ...base, 'landflow.ai.cap.when': 'after' });
            throw error;
          }
          if (cost !== undefined) span.setAttribute('landflow.ai.cost_usd', cost);
          if (cost) instruments.aiCost.add(cost, base);
          return result;
        } catch (error) {
          span.setAttribute('error.type', (error as Error)?.name ?? 'Error');
          throw error;
        }
      },
    );
  } catch (error) {
    outcome = outcomeOf(error);
    throw error;
  } finally {
    instruments.aiRequests.add(1, { ...base, 'landflow.outcome': outcome });
    instruments.aiDuration.record(performance.now() - started, base);
  }
}
