/** The models a LiteLLM gateway serves (GET /v1/models with Landflow's virtual key), and the credential test for it. */
import type { ModelOption, ModelProvider } from '../../shared/agents';
import { hashKey, LiteLlmClient, type Fetcher } from './client';
import { credentials } from '../credentials/vault';
import { gatewayRoot, isGatewayCredential, type GatewayConnection } from './settings';

const CACHE_MS = 60_000;
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|rerank/i;
const cache = new Map<string, { at: number; ids: Array<{ id: string; owned_by?: string }> }>();

/** What a gateway lists as models, as the picker's options: cached for 60 seconds per base URL and key. */
export async function gatewayModelOptions(connection: Pick<GatewayConnection, 'baseUrl' | 'apiKey'>, provider: ModelProvider, fetcher?: Fetcher): Promise<ModelOption[]> {
  const baseUrl = gatewayRoot(connection.baseUrl);
  const key = `${baseUrl} ${connection.apiKey ? hashKey(connection.apiKey) : ''}`;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    const client = new LiteLlmClient({ baseUrl, ...(connection.apiKey && { key: connection.apiKey }), ...(fetcher && { fetcher }) });
    entry = { at: Date.now(), ids: await client.models() };
    cache.set(key, entry);
  }
  return entry.ids
    .filter((m) => !NOT_CHAT.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ provider, model: m.id, label: m.id, description: 'via LiteLLM' }));
}

/** Forget the cached lists (tests; after a credential changes). */
export const forgetGatewayModels = () => cache.clear();

/** The credential's "Test connection" for a LiteLLM gateway. */
export async function testGatewayCredential(data: Record<string, unknown>, fetcher?: Fetcher): Promise<{ ok: boolean; message: string }> {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const baseUrl = text(data.baseUrl);
  const apiKey = text(data.apiKey);
  if (!baseUrl) return { ok: false, message: 'Enter the Base URL of your LiteLLM proxy, e.g. http://127.0.0.1:54100' };
  const client = new LiteLlmClient({ baseUrl: gatewayRoot(baseUrl), ...(apiKey && { key: apiKey }), ...(fetcher && { fetcher }), timeoutMs: 15_000 });
  const health = await client.health();
  if (!health.live) return { ok: false, message: `Cannot reach LiteLLM at ${gatewayRoot(baseUrl)}${health.error ? `: ${health.error}` : ''}` };
  try {
    const models = await client.models();
    return { ok: true, message: `Connected to LiteLLM: ${models.length} model${models.length === 1 ? '' : 's'}` };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403) return { ok: false, message: `LiteLLM refused the virtual key (${status})` };
    return { ok: false, message: `LiteLLM answered with an error: ${(error as Error).message}` };
  }
}

/**
 * Whether a saved credential has Gateway = LiteLLM (the field is not a secret, so it reads without opening the vault). The
 * chat model nodes hand `anthropicModel` the credential's id and keys; this is how it learns the credential is a gateway.
 */
export function savedCredentialIsGateway(credentialId: string | undefined): boolean {
  if (!credentialId) return false;
  try {
    return isGatewayCredential(credentials.get(credentialId)?.data);
  } catch {
    return false;
  }
}
