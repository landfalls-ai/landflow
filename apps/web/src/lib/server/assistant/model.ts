/**
 * The assistant's model: the local builder model on Ollama by default (the
 * same OLLAMA_URL / LANDFLOW_BUILDER_MODEL as the flow builder), or a request
 * override: a bare Ollama model name, `anthropic/<model>`, `openai/<model>` or `litellm/<model>` (the instance's LLM gateway).
 * All adapters emit the usual `gen_ai.chat` spans.
 */
import type { LanguageModel } from '@landflow/engine';
import { anthropicModel, ollamaModel, openAiConnection, openAiModel } from '../nodes/models';
import { ollamaUrl } from '../config';
import { gatewayConnection } from '../llm-gateway/settings';

export const DEFAULT_ASSISTANT_MODEL = process.env.LANDFLOW_BUILDER_MODEL ?? 'qwen3-coder:30b';

export function assistantModel(override?: string | LanguageModel): LanguageModel {
  if (override && typeof override === 'object') return override;
  const name = override?.trim() || DEFAULT_ASSISTANT_MODEL;
  const [provider, ...rest] = name.split('/');
  const model = rest.join('/');
  if (provider === 'anthropic' && model) return anthropicModel({ model, effort: 'low', maxTokens: 4096, fallback: false });
  if (provider === 'openai' && model) {
    // Server-side settings only: OPENAI_API_KEY and OPENAI_BASE_URL (any OpenAI-compatible API).
    return openAiModel(openAiConnection({ apiKey: process.env.OPENAI_API_KEY ?? '', baseUrl: process.env.OPENAI_BASE_URL ?? '' }), { model, temperature: 0.2 });
  }
  if (provider === 'litellm' && model) return gatewayAssistantModel(model);
  return ollamaModel({ baseUrl: ollamaUrl(), model: name, temperature: 0.2 });
}

/**
 * `litellm/<model>`: the instance's gateway (Settings → AI → LLM gateway, else LANDFLOW_LLM_GATEWAY_URL and _KEY), looked up
 * when the call is made, over the OpenAI-compatible path with the gateway's virtual key.
 */
function gatewayAssistantModel(model: string): LanguageModel {
  return {
    provider: 'litellm',
    model,
    async generate(input) {
      const gateway = await gatewayConnection();
      if (!gateway) throw new Error('No LLM gateway: set one in Settings → AI → LLM gateway, or LANDFLOW_LLM_GATEWAY_URL');
      const connection = openAiConnection({ baseUrl: `${gateway.baseUrl}/v1`, apiKey: gateway.apiKey ?? '', gateway: 'litellm' }, gateway.credentialId);
      return openAiModel(connection, { model, temperature: 0.2 }).generate(input);
    },
  };
}

/** `provider/model`, for responses and span attributes. */
export const modelLabel = (model: LanguageModel) => `${model.provider}/${model.model}`;

/** An error's message plus its description (provider errors put the server's reason there). */
export function errorText(error: unknown): string {
  const { message, description } = error as { message?: string; description?: string };
  const detail = description?.trim().slice(0, 300);
  return detail && !message?.includes(detail) ? `${message}: ${detail}` : (message ?? String(error));
}
