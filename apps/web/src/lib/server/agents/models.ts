/**
 * The agent's chat model, built from its config with the same providers as the chat model nodes. The credential's
 * fields may read `$secrets` (resolved when the model is built, with the usual cache and redaction).
 */
import type { LanguageModel } from '@landflow/engine';
import type { AgentModel, ModelOption, ModelProvider } from '../../shared/agents';
import { credentials } from '../credentials/vault';
import { anthropicModel, ollamaModel, openAiConnection, openAiModel, openAiModels } from '../nodes/models';
import { ollamaUrl } from '../config';


const ANTHROPIC_MODELS: ModelOption[] = [
  { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: 'Best for agentic work' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'Faster, lower cost' },
  { provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: 'Fastest, cheapest' },
  { provider: 'anthropic', model: 'claude-fable-5-1', label: 'Claude Fable 5.1', description: 'Most capable' },
];

const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|rerank/i;

export async function agentModel(config: AgentModel | undefined): Promise<LanguageModel> {
  if (!config?.model) throw new Error('Choose a model for this agent first');
  const temperature = config.temperature;
  switch (config.provider) {
    case 'anthropic': {
      const data = config.credential ? await credentials.dataWithSecrets(config.credential, 'core.anthropicApi') : undefined;
      const apiKey = typeof data?.apiKey === 'string' ? data.apiKey.trim() : '';
      const baseUrl = typeof data?.baseUrl === 'string' ? data.baseUrl.trim() : '';
      return anthropicModel({ model: config.model, effort: 'medium', maxTokens: 16_000, fallback: true, promptCache: true, ...(apiKey && { apiKey, ...(baseUrl && { baseUrl }) }), ...(config.credential?.id && { credentialId: config.credential.id }) });
    }
    case 'openai': {
      if (!config.credential) throw new Error('Choose an OpenAI API credential for this agent’s model');
      return openAiModel(openAiConnection(await credentials.dataWithSecrets(config.credential, 'core.openAiApi'), config.credential.id), { model: config.model, ...(temperature !== undefined && { temperature }) });
    }
    case 'ollama':
      return ollamaModel({ baseUrl: config.baseUrl?.trim() || ollamaUrl(), model: config.model, ...(temperature !== undefined && { temperature }) });
    default:
      throw new Error(`Unknown model provider "${(config as { provider: string }).provider}"`);
  }
}

/** Models for the builder's picker. */
export async function modelOptions(provider: ModelProvider, options: { credentialId?: string; baseUrl?: string }): Promise<ModelOption[]> {
  if (provider === 'anthropic') return ANTHROPIC_MODELS;
  if (provider === 'openai') {
    if (!options.credentialId) return [];
    const connection = openAiConnection(await credentials.dataWithSecrets({ id: options.credentialId, name: options.credentialId }, 'core.openAiApi'));
    const models = await openAiModels(connection);
    return models
      .filter((m) => !NOT_CHAT.test(m.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ provider, model: m.id, label: m.id, description: `${connection.label}${m.owned_by ? ` · ${m.owned_by}` : ''}` }));
  }
  const base = (options.baseUrl?.trim() || ollamaUrl()).replace(/\/+$/, '');
  const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Ollama at ${base} answered ${response.status}`);
  const data = (await response.json()) as { models: Array<{ name: string; details?: { parameter_size?: string }; capabilities?: string[] }> };
  return data.models
    .filter((m) => !NOT_CHAT.test(m.name) && (!m.capabilities || m.capabilities.includes('completion')))
    .map((m) => ({
      provider,
      model: m.name,
      label: m.name,
      description: [m.details?.parameter_size, m.capabilities ? (m.capabilities.includes('tools') ? 'tools ✓' : 'no tool support') : undefined].filter(Boolean).join(' · '),
    }));
}
