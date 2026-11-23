/**
 * Credential types of the core plugin (qualified as `core.<name>`). The host
 * stores the values encrypted and hands them to nodes per call; the tests here
 * back the "Test connection" button.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { S3Client } from '@aws-sdk/client-s3'; // C22: loaded on first use (s3ClientOf), not at start
import { lookup } from 'node:dns/promises'; // C22:
import { isIP } from 'node:net'; // C22:
import { stripBrackets } from '../net/addresses'; // C22:
import { Agent as HttpAgent } from 'node:http'; // C22:
import { Agent as HttpsAgent } from 'node:https'; // C22:
import { assertAddressAllowed, assertUrlAllowed, guardedLookup, outboundPolicy } from '../net/safe-fetch'; // C22:
import { defineCredentialType, type NodeOperationError } from '@landflow/sdk';
import { checkCredentialClaims, parseBoundClaims } from '../jwt-claims';
import { testGatewayCredential } from '../llm-gateway/models';
import { OPENAI_BASE_URL, openAiConnection, openAiModels } from './models';
import { STRANDS_BASE_URL, TYPESAFE_BASE_URL, strandsConnection, systemOneDecide, typesafeConnection, typesafeModels } from './systemone';

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
      name: 'gateway',
      displayName: 'Gateway',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None (call the provider)', value: 'none' },
        { name: 'LiteLLM', value: 'litellm' },
      ],
      description: 'LiteLLM: the Base URL is your LiteLLM proxy and the API key a virtual key; usage is attributed to projects, agents and people',
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
    if (data.gateway === 'litellm') return testGatewayCredential(data, ctx.http);
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
    {
      name: 'gateway',
      displayName: 'Gateway',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None (call the provider)', value: 'none' },
        { name: 'LiteLLM', value: 'litellm' },
      ],
      description: 'LiteLLM: the Base URL is your LiteLLM proxy and the API key a virtual key; usage is attributed to projects, agents and people',
    },
  ],
  async test(data, ctx) {
    const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
    if (!apiKey) return { ok: false, message: 'Enter an API key' };
    if (data.gateway === 'litellm') return testGatewayCredential(data, ctx.http);
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

/** TypeSafe AI's Jev, a decision model: agent guardrails can use it as their judge (see ./typesafe). */
export const typesafeApiCredential = defineCredentialType({
  name: 'typesafeApi',
  displayName: 'TypeSafe API',
  description: 'An API key for TypeSafe AI’s Jev, a fast yes/no model that agent guardrails can use as their judge instead of the agent’s chat model.',
  icon: 'lucide:scale',
  documentationUrl: 'https://docs.typesafe.ai',
  properties: [
    { name: 'apiKey', displayName: 'API Key', type: 'string', required: true, typeOptions: { password: true } },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: '', placeholder: TYPESAFE_BASE_URL, description: 'Optional: a gateway or compatible host in front of the API' },
  ],
  async test(data) {
    try {
      const models = await typesafeModels(typesafeConnection(data));
      return { ok: true, message: `API key accepted: ${models.length} models available` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/** AWS's Strands Decider, an open-source decision model you serve yourself (`strands-decider serve <model> --port 8000`): same API as Jev. */
export const strandsDeciderApiCredential = defineCredentialType({
  name: 'strandsDeciderApi',
  displayName: 'Strands Decider',
  description: 'The address of a Strands Decider server (AWS, open source, Apache-2.0) that agent guardrails can use as their judge. Runs on your own machine or cluster.',
  icon: 'lucide:scale',
  documentationUrl: 'https://github.com/strands-labs/strands-decider',
  properties: [
    { name: 'baseUrl', displayName: 'Server address', type: 'string', required: true, default: STRANDS_BASE_URL, description: 'Where `strands-decider serve` listens; /v1/systemone is added to it' },
    { name: 'apiKey', displayName: 'API Key', type: 'string', default: '', typeOptions: { password: true }, description: 'Only if you put a gateway in front of the server' },
    { name: 'model', displayName: 'Model name', type: 'string', default: '', description: 'Only if your server expects one in the request' },
  ],
  async test(data) {
    try {
      // A tiny real question: the server has no model list to read.
      const result = await systemOneDecide(strandsConnection(data), 'ping', { ok: 'Is this a greeting?' });
      return { ok: true, message: `Connected: ${result.model} answered` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
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

/** The response body as text, or undefined when it runs past `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
    {
      name: 'boundClaims',
      displayName: 'Bound Claims',
      type: 'string',
      default: '',
      typeOptions: { rows: 4 },
      placeholder: 'repository: my-org/my-repo\nref: refs/heads/main',
      description:
        'One “claim: value” per line; every line must match the token. * matches within one segment and stops at / and : (repo:my-org/app:ref:refs/heads/*; GitHub’s repo:my-org/app:* never matches). Required for GitHub Actions and GitLab tokens: bind repository, project_path or sub with the owner written out (no * before the first /).',
    },
    {
      name: 'singleUse',
      displayName: 'Single Use',
      type: 'boolean',
      default: false,
      description:
        'Accept each token once (by its jti, or a hash of the token): a token copied from a log cannot start a second run. Needs tokens with an expiry. A CI job must mint a token per call, so a retry that reuses one is refused.',
    },
  ],
  async test(data, ctx) {
    const rules = checkCredentialClaims(data);
    if (!rules.ok) return { ok: false, message: rules.message };
    const endsInStar = parseBoundClaims(String(data.boundClaims ?? '')).claims.find(({ claim, pattern }) => claim === 'sub' && pattern.endsWith(':*'));
    if (endsInStar) return { ok: false, message: `“sub: ${endsInStar.pattern}” never matches: * stops at a colon, so write each segment (repo:my-org/app:ref:refs/heads/*) or bind repository instead` };
    const url = String(data.jwksUrl ?? '').trim();
    if (data.keyType !== 'jwks' || !url) return { ok: true, message: 'The credential is complete' };
    try {
      // As the trigger fetches it: no redirects followed, and a bounded read.
      const response = await ctx.http(url, { headers: { accept: 'application/json' }, redirect: 'manual' });
      if (!response.ok) return { ok: false, message: `The JWKS URL answered ${response.status}` };
      const body = await readCapped(response, 1_000_000);
      if (body === undefined) return { ok: false, message: 'The JWKS URL answered with a body that is too large to be a key set' };
      let keys: unknown;
      try {
        keys = (JSON.parse(body) as { keys?: unknown[] }).keys;
      } catch {
        return { ok: false, message: 'The JWKS URL did not return a key set' };
      }
      if (!Array.isArray(keys)) return { ok: false, message: 'The JWKS URL did not return a key set' };
      return { ok: true, message: `The JWKS URL answered with ${keys.length} key${keys.length === 1 ? '' : 's'}` };
    } catch (caught) {
      return { ok: false, message: `The JWKS URL could not be read: ${(caught as Error).message}` };
    }
  },
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

// ---------------------------------------------------------------------------
// C22: S3 (knowledge sources)
// ---------------------------------------------------------------------------

/**
 * The outbound policy for an address a person typed (an S3 endpoint, a site's start address): literal addresses, and every address
 * the name resolves to, are refused in the production profile unless LANDFLOW_OUTBOUND_ALLOW lists them. The AWS SDK makes its own
 * connections, so this is the check before them. Throws OutboundBlockedError.
 */
export async function assertOutboundTarget(url: URL): Promise<void> {
  assertUrlAllowed(url);
  const host = stripBrackets(url.hostname);
  if (isIP(host)) return;
  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(host, { all: true });
  } catch (caught) {
    // A name that does not resolve is refused when private addresses are blocked: it could resolve to one a moment later.
    if (outboundPolicy().blockPrivate) throw new Error(`Blocked: ${host} could not be resolved (${(caught as Error).message})`);
    return;
  }
  for (const entry of answers) assertAddressAllowed(host, entry.address);
}

/**
 * An S3 client built from the credential's own keys: never the default AWS chain (no profile, no environment, no instance role), so
 * what a source reads is what the person gave it. Path-style by default (LocalStack, MinIO).
 */
export async function s3ClientOf(data: Record<string, unknown>): Promise<S3Client> {
  const accessKeyId = String(data.accessKeyId ?? '').trim();
  const secretAccessKey = String(data.secretAccessKey ?? '').trim();
  if (!accessKeyId || !secretAccessKey) throw new Error('The S3 credential needs an access key id and a secret access key');
  const endpoint = String(data.endpoint ?? '').trim();
  const { S3Client } = await import('@aws-sdk/client-s3');
  // Every connection the SDK makes (a virtual-hosted bucket name is a host of its own) resolves through the outbound policy's
  // guarded lookup, so the address that is checked is the address that is connected to.
  return new S3Client({
    requestHandler: { httpAgent: new HttpAgent({ lookup: guardedLookup as never }), httpsAgent: new HttpsAgent({ lookup: guardedLookup as never }) },
    region: String(data.region ?? '').trim() || 'us-east-1',
    ...(endpoint && { endpoint }),
    forcePathStyle: data.forcePathStyle !== false && data.forcePathStyle !== 'false',
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 2,
  });
}

/** An S3 (or S3-compatible) account for knowledge sources: keys, region and, for LocalStack or MinIO, the endpoint. */
export const s3ApiCredential = defineCredentialType({
  name: 's3Api',
  displayName: 'S3',
  description: 'An S3 bucket account, or an S3-compatible server (LocalStack: http://127.0.0.1:54566, MinIO). Knowledge sources read from it; the AWS default credentials are never used.',
  icon: 'lucide:cloud',
  documentationUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
  properties: [
    { name: 'endpoint', displayName: 'Endpoint', type: 'string', default: '', description: 'Leave empty for AWS. LocalStack: http://127.0.0.1:54566' },
    { name: 'region', displayName: 'Region', type: 'string', default: 'us-east-1' },
    { name: 'accessKeyId', displayName: 'Access Key ID', type: 'string', default: '', required: true },
    { name: 'secretAccessKey', displayName: 'Secret Access Key', type: 'string', default: '', required: true, typeOptions: { password: true } },
    { name: 'forcePathStyle', displayName: 'Force Path Style', type: 'boolean', default: true, description: 'On for LocalStack and MinIO' },
  ],
  async test(data) {
    let client: S3Client | undefined;
    try {
      const endpoint = String(data.endpoint ?? '').trim();
      if (endpoint) await assertOutboundTarget(new URL(endpoint));
      client = await s3ClientOf(data);
      const { ListBucketsCommand } = await import('@aws-sdk/client-s3');
      const listed = await client.send(new ListBucketsCommand({}), { abortSignal: AbortSignal.timeout(5_000) });
      return { ok: true, message: `Connected: ${listed.Buckets?.length ?? 0} bucket${listed.Buckets?.length === 1 ? '' : 's'} visible` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    } finally {
      client?.destroy();
    }
  },
});
