/**
 * SB19: the models Spotlight may think with, and the one it uses unless a person picks another (docs/assistant.md).
 *
 * The list comes only from what the server is configured for: Ollama's pulled chat models, `litellm/<model>` when the
 * instance has a gateway (Settings → AI → LLM gateway, or LANDFLOW_LLM_GATEWAY_URL), `anthropic/…` only when the server has
 * ANTHROPIC_API_KEY and `openai/…` only when it has OPENAI_API_KEY. Never a model reachable only through a member's own
 * credential, and never a request field: every Spotlight route checks `model` against this list (wave 5's lesson: a member
 * must not spend the server's key by sending `anthropic/…`). The default is saved in `settings` (key `spotlight`).
 */
import { createHash } from 'node:crypto';
import type { SpotlightModel } from '../../shared/spotlight-models';
import { database } from '../db';
import { envString, ollamaUrl } from '../config';
import { modelOptions } from '../agents/models';
import { gatewayModelOptions } from '../llm-gateway/models';
import { gatewayConnection } from '../llm-gateway/settings';
import { openAiConnection, openAiModels } from '../nodes/models';
import { DEFAULT_ASSISTANT_MODEL } from './model';

export type { SpotlightModel } from '../../shared/spotlight-models';

const KEY = 'spotlight';
const CACHE_MS = 60_000;
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|rerank/i;

let cache: { key: string; at: number; models: SpotlightModel[] } | undefined;

/** Forget the cached list (tests; after Settings changes the gateway). */
export const forgetSpotlightModels = () => {
  cache = undefined;
};

const fingerprint = (value: string | undefined) => (value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : '');

/** The models this server offers Spotlight, local ones first. Cached for 60 seconds. */
export async function spotlightModels(): Promise<SpotlightModel[]> {
  const gateway = await gatewayConnection().catch(() => undefined);
  const anthropicKey = envString('ANTHROPIC_API_KEY');
  const openAiKey = envString('OPENAI_API_KEY');
  const key = [ollamaUrl(), gateway?.baseUrl ?? '', fingerprint(gateway?.apiKey), fingerprint(anthropicKey), fingerprint(openAiKey), envString('OPENAI_BASE_URL') ?? ''].join('|');
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.models;

  const models: SpotlightModel[] = [];
  const add = (model: SpotlightModel) => {
    if (!models.some((m) => m.id === model.id)) models.push(model);
  };

  // Ollama: a bare name. The server's default is always listed, so Spotlight still has a model when Ollama is down.
  const local = await modelOptions('ollama', {}).catch(() => []);
  for (const m of local) if (!NOT_CHAT.test(m.model)) add({ id: m.model, label: m.model, source: 'ollama', local: true });
  add({ id: DEFAULT_ASSISTANT_MODEL, label: DEFAULT_ASSISTANT_MODEL, source: 'ollama', local: true });

  if (gateway) {
    const served = await gatewayModelOptions({ baseUrl: gateway.baseUrl, ...(gateway.apiKey && { apiKey: gateway.apiKey }) }, 'openai').catch(() => []);
    for (const m of served) add({ id: `litellm/${m.model}`, label: m.model, source: 'gateway', local: false });
  }
  if (anthropicKey) {
    for (const m of await modelOptions('anthropic', {}).catch(() => [])) add({ id: `anthropic/${m.model}`, label: m.label, source: 'anthropic', local: false });
  }
  if (openAiKey) {
    // The server's key and base URL only: the models it lists, or none when the endpoint does not answer.
    const listed = await openAiModels(openAiConnection({ apiKey: openAiKey, baseUrl: envString('OPENAI_BASE_URL') ?? '' })).catch(() => []);
    for (const m of listed.filter((m) => !NOT_CHAT.test(m.id)).sort((a, b) => a.id.localeCompare(b.id))) add({ id: `openai/${m.id}`, label: m.id, source: 'openai', local: false });
  }

  cache = { key, at: Date.now(), models };
  return models;
}

/** The saved default model, as a person chose it in Settings (it may no longer be listed). */
export function spotlightDefault(): string | undefined {
  try {
    const raw = database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY)?.value;
    const model = (raw ? (JSON.parse(raw) as { model?: unknown }) : undefined)?.model;
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Save the default; a model the server does not offer is refused (the message the routes answer 400 with). */
export async function saveSpotlightDefault(model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const checked = await resolveSpotlightModel(model.trim());
  if ('error' in checked) return { ok: false, error: checked.error };
  database().upsert('settings', { key: KEY, value: JSON.stringify({ model: checked.model }) });
  return { ok: true };
}

/** The default in force: the saved one while it is still listed, else the server's own (LANDFLOW_BUILDER_MODEL). */
export async function effectiveSpotlightDefault(): Promise<string> {
  const saved = spotlightDefault();
  if (saved && (await spotlightModels()).some((m) => m.id === saved)) return saved;
  return DEFAULT_ASSISTANT_MODEL;
}

/**
 * The model a Spotlight call uses: none asked → the default; one asked and listed → it; one asked and not listed → the
 * refusal the routes answer 400 with.
 */
export async function resolveSpotlightModel(requested?: string): Promise<{ model: string } | { error: string }> {
  const name = requested?.trim();
  if (!name) return { model: await effectiveSpotlightDefault() };
  if ((await spotlightModels()).some((m) => m.id === name)) return { model: name };
  return { error: `Not a model this server offers: ${name}` };
}
