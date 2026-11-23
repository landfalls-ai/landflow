/** `gen_ai.chat {model}` / `gen_ai.embeddings {model}` client spans (OTel GenAI conventions) and the `landflow.ai.*` metrics. */
import type { Attributes } from '@opentelemetry/api';
import type { CallPurpose } from '../../shared/ai-call';
import type { CallNote } from '../ai-usage/call-context';
import { afterModelCall, beforeModelCall, currentUsageScope, isUsageCapError, type UsageScope } from '../ai-usage/scope';
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
  /** The LLM gateway's call id (`x-litellm-call-id`) and the cost it reported (`x-litellm-response-cost`), when the call went through one. */
  callId?: string;
  gatewayCost?: number;
  /** The gateway is the server's configured one, so its cost may stand in for an unpriced model's. */
  gatewayCostTrusted?: boolean;
  /** The id the server's gateway gave the response, so the spend import pairs this call's row with its spend row. */
  gatewayRequestId?: string;
  /** SHA-256 of the server's own gateway key, when the call was made with it. */
  gatewayKeyHash?: string;
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
  /** The server-configured gateway's call id and the key's hash, so the spend import never counts the call again. */
  callId?: string;
  gatewayKeyHash?: string;
}

/** Run one embeddings call in a `gen_ai.embeddings {model}` span; it counts in the same `landflow.ai.*` metrics as chat (input tokens only). */
export function traceEmbeddings<T>(request: ChatRequest, call: () => Promise<T>, describe: (result: T) => EmbeddingsResponse): Promise<T> {
  return traceGenAi('embeddings', request, call, (result) => {
    const response = describe(result);
    return { responseModel: response.responseModel, inputTokens: response.inputTokens, ...(response.dimensions && { dimensions: response.dimensions }), ...(response.callId && { callId: response.callId }), ...(response.gatewayKeyHash && { gatewayKeyHash: response.gatewayKeyHash }) };
  });
}

/**
 * Why a call was made (SP01): the note's purpose; else `embed` for embeddings; else `answer` for a chat call inside a
 * scope with an execution or a session; else unset.
 */
export function effectivePurpose(note: Omit<CallNote, 'draft'>, operation: 'chat' | 'embeddings', scope: UsageScope | undefined): CallPurpose | undefined {
  if (note.purpose) return note.purpose;
  if (operation === 'embeddings') return 'embed';
  if (scope && (scope.lookup('executionId') || scope.lookup('sessionId'))) return 'answer';
  return undefined;
}

/**
 * The call note and the active node, read when the call starts. Loaded with `import()` so http.ts's static import
 * closure (test/runtime.test.ts) stays as it was; the modules are cached after the first call.
 */
async function callContext() {
  const [{ currentCallNote }, { activeNode }] = await Promise.all([import('../ai-usage/call-context'), import('../ai-usage/node-context')]);
  return { note: currentCallNote(), node: activeNode() };
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
  // SP01: what the code around the call knows: why it is made, which loop step, which node.
  const { note, node } = await callContext();
  const purpose = effectivePurpose(note, operation, currentUsageScope());
  const purposeLabel = purpose ?? 'none';
  let outcome: Outcome = 'ok';
  try {
    return await withSpan(
      `gen_ai.${operation} ${request.model}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          ...base,
          'gen_ai.operation.name': operation,
          ...(purpose && { 'landflow.ai.purpose': purpose }),
          ...(note.iteration !== undefined && { 'landflow.ai.iteration': note.iteration }),
          ...(node && { 'landflow.node.id': node.id }),
          ...request.attributes,
        },
      },
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
            ...(response.callId && { 'litellm.call_id': response.callId }),
            ...(response.dimensions && { 'gen_ai.embeddings.dimension.count': response.dimensions }),
          });
          // `input` is the whole prompt; the cache types are parts of it, never added to it (SP01).
          const tokenBase = { ...base, 'landflow.ai.purpose': purposeLabel };
          if (response.inputTokens) instruments.aiTokens.add(response.inputTokens, { ...tokenBase, 'gen_ai.token.type': 'input' });
          if (response.outputTokens) instruments.aiTokens.add(response.outputTokens, { ...tokenBase, 'gen_ai.token.type': 'output' });
          if (response.cacheReadTokens) instruments.aiTokens.add(response.cacheReadTokens, { ...tokenBase, 'gen_ai.token.type': 'cache_read' });
          if (response.cacheWriteTokens) instruments.aiTokens.add(response.cacheWriteTokens, { ...tokenBase, 'gen_ai.token.type': 'cache_write' });
          const spanId = span.spanContext().spanId;
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
            ...(response.callId && { callId: response.callId }),
            ...(response.gatewayCost !== undefined && { gatewayCost: response.gatewayCost }),
            ...(response.gatewayCostTrusted && { gatewayCostTrusted: true }),
            ...(response.gatewayRequestId && { gatewayRequestId: response.gatewayRequestId }),
            ...(response.gatewayKeyHash && { gatewayKeyHash: response.gatewayKeyHash }),
            // SP01: attribution for the row.
            ...(node && { nodeId: node.id }),
            ...(spanId && !/^0+$/.test(spanId) && { spanId }),
            ...(purpose && { purpose }),
            ...(note.iteration !== undefined && { iteration: note.iteration }),
            ...(note.callerAgentId && { callerAgentId: note.callerAgentId }),
            durationMs: Math.round(performance.now() - started),
            ...(response.finishReasons?.[0] && { stopReason: response.finishReasons[0] }),
          };
          let cost: number | undefined;
          try {
            cost = afterModelCall(usage);
          } catch (error) {
            if (isUsageCapError(error)) instruments.aiCapsReached.add(1, { ...base, 'landflow.ai.cap.when': 'after' });
            throw error;
          }
          if (cost !== undefined) span.setAttribute('landflow.ai.cost_usd', cost);
          if (cost) instruments.aiCost.add(cost, { ...base, 'landflow.ai.purpose': purposeLabel });
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
    instruments.aiRequests.add(1, { ...base, 'landflow.ai.purpose': purposeLabel, 'landflow.outcome': outcome });
    instruments.aiDuration.record(performance.now() - started, base);
  }
}
