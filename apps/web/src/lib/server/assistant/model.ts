/**
 * The assistant's model: the local builder model on Ollama by default (the
 * same OLLAMA_URL / LANDFLOW_BUILDER_MODEL as the flow builder), or a request
 * override: a bare Ollama model name, `anthropic/<model>` or `openai/<model>`.
 * All adapters emit the usual `gen_ai.chat` spans.
 */
import type { LanguageModel } from '@landflow/engine';
import { anthropicModel, ollamaModel, openAiConnection, openAiModel } from '../nodes/models';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
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
  return ollamaModel({ baseUrl: OLLAMA_URL, model: name, temperature: 0.2 });
}

/** `provider/model`, for responses and span attributes. */
export const modelLabel = (model: LanguageModel) => `${model.provider}/${model.model}`;

/** An error's message plus its description (provider errors put the server's reason there). */
export function errorText(error: unknown): string {
  const { message, description } = error as { message?: string; description?: string };
  const detail = description?.trim().slice(0, 300);
  return detail && !message?.includes(detail) ? `${message}: ${detail}` : (message ?? String(error));
}
