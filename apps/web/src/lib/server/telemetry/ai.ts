/** `gen_ai.chat {model}` / `gen_ai.embeddings {model}` client spans (OTel GenAI conventions) and the `landflow.ai.*` metrics. */
import type { Attributes } from '@opentelemetry/api';
import { hostMetrics, outcomeOf, type Outcome } from './metrics';
import { SpanKind, withSpan } from './spans';

export interface ChatRequest {
  /** `gen_ai.system`: anthropic, ollama, openai… */
  system: string;
  model: string;
  /** Extra request attributes, e.g. `gen_ai.request.max_tokens`, `server.address`. */
  attributes?: Attributes;
}

export interface ChatResponse {
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
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
            ...(response.finishReasons && { 'gen_ai.response.finish_reasons': response.finishReasons }),
            ...(response.dimensions && { 'gen_ai.embeddings.dimension.count': response.dimensions }),
          });
          if (response.inputTokens) instruments.aiTokens.add(response.inputTokens, { ...base, 'gen_ai.token.type': 'input' });
          if (response.outputTokens) instruments.aiTokens.add(response.outputTokens, { ...base, 'gen_ai.token.type': 'output' });
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
