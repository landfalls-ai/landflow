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
  icon: 'brand:openai',
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

export const cohereApiCredential = defineCredentialType({
  name: 'cohereApi',
  displayName: 'Cohere API',
  description: 'A Cohere API key for the Cohere Reranker. Cohere-compatible servers (vLLM, Jina, gateways) work with their own Base URL.',
  icon: 'lucide:arrow-down-wide-narrow',
  documentationUrl: 'https://dashboard.cohere.com/api-keys',
  properties: [
    { name: 'apiKey', displayName: 'API Key', type: 'string', default: '', typeOptions: { password: true }, description: 'Leave empty for compatible servers that need none' },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://api.cohere.com', description: 'The API root; /v2/rerank is added to it' },
  ],
  async test(data, ctx) {
    const base = String(data.baseUrl || 'https://api.cohere.com').replace(/\/+$/, '');
    try {
      const response = await ctx.http(`${base}/v2/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(data.apiKey && { authorization: `Bearer ${String(data.apiKey)}` }) },
        body: JSON.stringify({ model: 'rerank-v3.5', query: 'ping', documents: ['pong'], top_n: 1 }),
      });
      if (response.status === 401 || response.status === 403) return { ok: false, message: `${base} refused the API key (${response.status})` };
      // An unknown model or a thin body (400, 404, 422) still means the server is there and took the key.
      return response.ok || [400, 404, 422].includes(response.status) ? { ok: true, message: `Connected to ${base}` } : { ok: false, message: `${base} answered ${response.status}` };
    } catch (error) {
      return { ok: false, message: `Can’t reach ${base}: ${(error as Error).message}` };
    }
  },
});

export const anthropicApiCredential = defineCredentialType({
  name: 'anthropicApi',
  displayName: 'Anthropic API',
  description: 'An Anthropic API key for the Anthropic Chat Model. Without one, the server’s ANTHROPIC_API_KEY or `ant` profile is used.',
  icon: 'brand:anthropic',
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

/** n8n's Bearer Auth: `Authorization: Bearer <token>`. The MCP nodes use it; any HTTP node could. */
export const httpBearerAuthCredential = defineCredentialType({
  name: 'httpBearerAuth',
  displayName: 'Bearer Auth',
  description: 'A token sent as “Authorization: Bearer <token>” (MCP servers, HTTP APIs), or expected from callers (MCP Server Trigger)',
  icon: 'lucide:key-round',
  properties: [{ name: 'token', displayName: 'Bearer Token', type: 'string', required: true, typeOptions: { password: true } }],
});

/** n8n's Basic Auth: a user name and password (expected from callers of a Webhook or Form Trigger). */
export const httpBasicAuthCredential = defineCredentialType({
  name: 'httpBasicAuth',
  displayName: 'Basic Auth',
  description: 'A user name and password that callers of a Webhook or Form Trigger must send (browsers ask for them)',
  icon: 'lucide:user-lock',
  properties: [
    { name: 'user', displayName: 'User', type: 'string', required: true },
    { name: 'password', displayName: 'Password', type: 'string', required: true, typeOptions: { password: true } },
  ],
});

/** n8n's JWT Auth: how a Webhook or Form Trigger verifies the JWT callers send as a Bearer token. */
export const jwtAuthCredential = defineCredentialType({
  name: 'jwtAuth',
  displayName: 'JWT Auth',
  description: 'Verifies the JWT callers of a Webhook or Form Trigger send: a shared secret (HS256), a public key or a JWKS URL',
  icon: 'lucide:file-key',
  properties: [
    {
      name: 'keyType',
      displayName: 'Key Type',
      type: 'options',
      default: 'passphrase',
      options: [
        { name: 'Passphrase (HMAC secret)', value: 'passphrase' },
        { name: 'PEM Public Key', value: 'pemKey' },
        { name: 'JWKS URL', value: 'jwks', description: 'The issuer’s key set, e.g. https://example.auth0.com/.well-known/jwks.json' },
      ],
    },
    { name: 'secret', displayName: 'Secret', type: 'string', default: '', typeOptions: { password: true }, displayOptions: { show: { keyType: ['passphrase'] } } },
    { name: 'publicKey', displayName: 'Public Key', type: 'string', default: '', typeOptions: { rows: 4 }, placeholder: '-----BEGIN PUBLIC KEY-----', displayOptions: { show: { keyType: ['pemKey'] } } },
    { name: 'jwksUrl', displayName: 'JWKS URL', type: 'string', default: '', displayOptions: { show: { keyType: ['jwks'] } } },
    {
      name: 'algorithm',
      displayName: 'Algorithm',
      type: 'options',
      default: 'HS256',
      options: ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256'].map((value) => ({ name: value, value })),
      description: 'HS* for a passphrase; RS*, ES* or PS* for a public key or JWKS',
    },
    { name: 'issuer', displayName: 'Issuer', type: 'string', default: '', description: 'Require this `iss` claim (optional)' },
    { name: 'audience', displayName: 'Audience', type: 'string', default: '', description: 'Require this `aud` claim (optional)' },
  ],
});

/** n8n's Header Auth: one header name and value. */
export const httpHeaderAuthCredential = defineCredentialType({
  name: 'httpHeaderAuth',
  displayName: 'Header Auth',
  description: 'A custom header such as “X-API-Key”, sent with requests or expected from callers (MCP Server Trigger)',
  icon: 'lucide:key-square',
  properties: [
    { name: 'name', displayName: 'Header Name', type: 'string', required: true, placeholder: 'X-API-Key' },
    { name: 'value', displayName: 'Header Value', type: 'string', required: true, typeOptions: { password: true } },
  ],
});
