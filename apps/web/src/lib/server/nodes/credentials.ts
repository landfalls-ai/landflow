/**
 * Credential types of the core plugin (qualified as `core.<name>`). The host
 * stores the values encrypted and hands them to nodes per call; the tests here
 * back the "Test connection" button.
 */
import Anthropic from '@anthropic-ai/sdk';
import { defineCredentialType, type NodeOperationError } from '@landflow/sdk';
import { OPENAI_BASE_URL, openAiConnection, openAiModels } from './models';

export const openAiApiCredential = defineCredentialType({
  name: 'openAiApi',
  displayName: 'OpenAI API',
  description: 'OpenAI, or any OpenAI-compatible server: Ollama (http://127.0.0.1:11434/v1), vLLM, LM Studio, OpenRouter…',
  icon: 'lucide:aperture',
  documentationUrl: 'https://platform.openai.com/api-keys',
  properties: [
    {
      name: 'apiKey',
      displayName: 'API Key',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'Leave empty for local servers that need none, such as Ollama',
    },
    {
      name: 'baseUrl',
      displayName: 'Base URL',
      type: 'string',
      default: OPENAI_BASE_URL,
      description: 'The API root, ending in /v1. Ollama: http://127.0.0.1:11434/v1',
    },
    {
      name: 'organization',
      displayName: 'Organization ID',
      type: 'string',
      default: '',
      description: 'Optional, for keys that belong to several organizations',
    },
  ],
  async test(data, ctx) {
    try {
      const connection = openAiConnection(data);
      const models = await openAiModels(connection, ctx.http);
      return { ok: true, message: `Connected to ${connection.label}: ${models.length} model${models.length === 1 ? '' : 's'} available` };
    } catch (error) {
      const { message, description } = error as NodeOperationError;
      return { ok: false, message: [message, description].filter(Boolean).join(' — ') };
    }
  },
});

export const anthropicApiCredential = defineCredentialType({
  name: 'anthropicApi',
  displayName: 'Anthropic API',
  description: 'An Anthropic API key for the Anthropic Chat Model. Without one, the server’s ANTHROPIC_API_KEY or `ant` profile is used.',
  icon: 'lucide:sparkles',
  documentationUrl: 'https://console.anthropic.com/settings/keys',
  properties: [
    { name: 'apiKey', displayName: 'API Key', type: 'string', required: true, typeOptions: { password: true } },
    {
      name: 'baseUrl',
      displayName: 'Base URL',
      type: 'string',
      default: '',
      placeholder: 'https://api.anthropic.com',
      description: 'Optional: a proxy or gateway in front of the API',
    },
  ],
  async test(data) {
    const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
    if (!apiKey) return { ok: false, message: 'Enter an API key' };
    const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl.trim() : '';
    const client = new Anthropic({ apiKey, ...(baseUrl && { baseURL: baseUrl }), maxRetries: 0, timeout: 15_000 });
    try {
      // Listing models is free and needs a valid key.
      const page = await client.models.list({ limit: 100 });
      return { ok: true, message: `API key accepted: ${page.data.length}${page.has_more ? '+' : ''} models available` };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) return { ok: false, message: 'Anthropic rejected the API key (401)' };
      if (error instanceof Anthropic.PermissionDeniedError) return { ok: false, message: `Anthropic denied access (403): ${error.message}` };
      if (error instanceof Anthropic.APIConnectionError) return { ok: false, message: `Cannot reach ${baseUrl || 'the Anthropic API'}: ${error.message}` };
      if (error instanceof Anthropic.APIError) return { ok: false, message: `Anthropic API error ${error.status ?? ''}: ${error.message}`.replace(' :', ':') };
      throw error;
    }
  },
});
