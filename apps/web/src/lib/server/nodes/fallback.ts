/**
 * Model fallback ("Enable Fallback Model", as on n8n's AI Agent). A root node
 * with the switch on takes a second chat model on `ai_languageModel` port 1;
 * when a call to the primary model throws, the same call is retried on the
 * fallback. The switch-over is logged as a warning on the root node and marked
 * with a `landflow.ai.fallback` event on its span; the failed primary call stays
 * in the run data as an errored model run.
 */
import { trace } from '@opentelemetry/api';
import { NodeOperationError, type IExecuteContext, type PortDescriptor, type PropertyDescriptor } from '@landflow/sdk';
import type { LanguageModel } from '@landflow/engine';

export const FALLBACK_PROPERTY: PropertyDescriptor = {
  name: 'needsFallback',
  displayName: 'Enable Fallback Model',
  type: 'boolean',
  default: false,
  noDataExpression: true,
  description: 'Retry on a second chat model when a call to the first one fails',
};

/** The second chat-model port, shown while “Enable Fallback Model” is on. */
export const FALLBACK_PORT: PortDescriptor = {
  type: 'ai_languageModel',
  displayName: 'Fallback Model',
  required: true,
  maxConnections: 1,
  displayOptions: { show: { needsFallback: [true] } },
};

export interface FallbackModel extends LanguageModel {
  /** Calls that failed on the primary and went to the fallback. */
  readonly fallbacks: number;
  /** `provider/model` of the model that answered the last call. */
  readonly lastModel: string;
}

const label = (model: LanguageModel) => `${model.provider}/${model.model}`;

export function withFallback(primary: LanguageModel, fallback: LanguageModel, log?: (message: string) => void): FallbackModel {
  let fallbacks = 0;
  let lastModel = label(primary);
  return {
    provider: primary.provider,
    model: primary.model,
    get fallbacks() {
      return fallbacks;
    },
    get lastModel() {
      return lastModel;
    },
    async generate(input) {
      try {
        const turn = await primary.generate(input);
        lastModel = label(primary);
        return turn;
      } catch (error) {
        // A reached AI usage cap applies to every model: no point asking the fallback.
        if (input.signal?.aborted || (error as Error)?.name === 'UsageCapError') throw error;
        fallbacks++;
        const reason = (error as Error).message ?? String(error);
        log?.(`${label(primary)} failed (${reason}); retrying on the fallback model ${label(fallback)}`);
        trace.getActiveSpan()?.addEvent('landflow.ai.fallback', {
          'gen_ai.request.model': primary.model,
          'landflow.ai.fallback.model': fallback.model,
          'landflow.ai.fallback.provider': fallback.provider,
          'error.message': reason.slice(0, 500),
        });
        const turn = await fallback.generate(input);
        lastModel = label(fallback);
        return turn;
      }
    },
  };
}

/** The chat model of a root node, wrapped with its fallback model when “Enable Fallback Model” is on. */
export async function connectedModel(ctx: IExecuteContext, node: string): Promise<LanguageModel | FallbackModel> {
  const get = ctx.getInputConnectionData;
  if (!get) throw new NodeOperationError(`The ${node} must run in-process`);
  const needsFallback = Boolean(ctx.getNodeParameter('needsFallback', 0, false));
  const [model] = await get<LanguageModel>('ai_languageModel', needsFallback ? 0 : undefined);
  if (!model) throw new NodeOperationError('No chat model connected', { description: 'Attach a chat model (Anthropic, Ollama or OpenAI) to the “Chat Model” slot.' });
  if (!needsFallback) return model;
  const [fallback] = await get<LanguageModel>('ai_languageModel', 1);
  if (!fallback) throw new NodeOperationError('No fallback model connected', { description: 'Attach a chat model to the “Fallback Model” slot, or turn off “Enable Fallback Model”.' });
  return withFallback(model, fallback, (message) => ctx.logger.warn(message));
}

export const isFallbackModel = (model: LanguageModel): model is FallbackModel => 'fallbacks' in model;
