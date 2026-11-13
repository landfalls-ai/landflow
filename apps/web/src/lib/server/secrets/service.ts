/**
 * External secrets: the configured providers (Settings → External secrets) and reading secrets from them.
 *
 * - Providers are built from their saved settings on first use and rebuilt when they change, also when another
 *   process (a queue worker, a second host) changed them: every read compares the row's `updated_at`.
 * - Values are read at run time and reused for a short time (LANDFLOW_SECRETS_CACHE_TTL seconds, default 60; 0
 *   reads every time). Concurrent reads of one secret share one request. Refresh (or any change to the provider)
 *   empties its part of the cache. Values live in memory only.
 * - Names are listed on connect, test and refresh and kept with the provider, for the Settings page and the
 *   expression editor's suggestions. Values are never listed.
 *
 * Plain server module (no Next.js imports), so workers resolve secrets the same way the host does.
 */
import type { SecretProviderCheck, SecretProviderKind, SecretProviderView } from '../../shared/secrets';
import { formatSecretReference } from '@landflow/engine';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { PROVIDERS, SecretProviderError, type ProviderConfig, type SecretsProvider, type SecretValue } from './providers';
import { redactText } from './redact';
import { recordAudit } from '../audit';
import { configOf, providerStore, viewOf, type StoredProvider } from './store';

/** `$secrets.<name>`: an identifier, so `$secrets.vault.x` reads without brackets. */
export const PROVIDER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export class SecretsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SecretsError';
  }
}

/** Seconds a value is reused. */
export function cacheTtlSeconds(): number {
  const raw = process.env.LANDFLOW_SECRETS_CACHE_TTL;
  const parsed = raw === undefined || raw.trim() === '' ? 60 : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}

/** The instance's environment, for `{environment}` in provider settings. */
const environment = () => process.env.LANDFLOW_ENVIRONMENT?.trim() || undefined;

interface State {
  instances: Map<string, { version: string; provider: SecretsProvider }>;
  values: Map<string, { value: SecretValue; expires: number }>;
  inflight: Map<string, Promise<SecretValue | undefined>>;
  /** Reads that reached a provider (tests check the cache with it). */
  fetches: number;
}

const state = singleton<State>('external-secrets', () => ({ instances: new Map(), values: new Map(), inflight: new Map(), fetches: 0 }));

const cacheKey = (provider: string, name: string) => `${provider}\u0000${name}`;

function dropCache(provider: string) {
  for (const key of [...state.values.keys()]) if (key.startsWith(`${provider}\u0000`)) state.values.delete(key);
}

function dropInstance(name: string) {
  state.instances.get(name)?.provider.close?.();
  state.instances.delete(name);
  dropCache(name);
}

function build(stored: Pick<StoredProvider, 'kind' | 'settings' | 'secrets'>): SecretsProvider {
  const definition = PROVIDERS[stored.kind];
  if (!definition) throw new SecretsError(`Unknown provider kind "${stored.kind}"`);
  try {
    return definition.create(configOf(stored), { environment: environment() });
  } catch (error) {
    if (error instanceof SecretProviderError) throw new SecretsError(error.message);
    throw error;
  }
}

/** The live provider for a saved one, rebuilt when its row changed. */
function instance(name: string): SecretsProvider {
  const version = providerStore.version(name);
  if (!version) {
    dropInstance(name);
    throw new SecretsError(`External secrets provider “${name}” isn’t set up on this instance (Settings → External secrets)`, 404);
  }
  const current = state.instances.get(name);
  if (current?.version === version) return current.provider;
  dropInstance(name);
  const stored = providerStore.get(name)!;
  if (!stored.enabled) throw new SecretsError(`External secrets provider “${name}” is turned off`, 409);
  const provider = build(stored);
  state.instances.set(name, { version, provider });
  return provider;
}

const checked = (ok: boolean, message: string, count?: number): SecretProviderCheck => ({ ok, at: new Date().toISOString(), message: redactText(message), ...(count !== undefined && { count }) });

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ProviderInput {
  name?: string;
  kind?: SecretProviderKind;
  enabled?: boolean;
  /** Field values; a secret field left empty keeps its saved value, `null` clears a field. */
  settings?: Record<string, string | number | null | undefined>;
}

/** Split form values into settings and secrets by the kind's secret fields; unknown fields are refused. */
function splitSettings(kind: SecretProviderKind, input: ProviderInput['settings'] = {}, previous?: StoredProvider) {
  const definition = PROVIDERS[kind];
  const known = new Set(definition.fields.map((f) => f.name));
  const secret = new Set(definition.secretFields);
  const settings: Record<string, string | number> = { ...(previous?.settings ?? {}) };
  const secrets: Record<string, string> = { ...(previous?.secrets ?? {}) };
  for (const [key, raw] of Object.entries(input)) {
    if (!known.has(key)) throw new SecretsError(`${definition.label} has no setting “${key}”`);
    if (raw === undefined) continue;
    if (secret.has(key)) {
      if (raw === null) delete secrets[key];
      else if (String(raw) !== '') secrets[key] = String(raw);
      continue;
    }
    if (raw === null || raw === '') delete settings[key];
    else settings[key] = typeof raw === 'number' ? raw : String(raw).trim();
  }
  return { settings, secrets };
}

function checkRequired(kind: SecretProviderKind, config: ProviderConfig) {
  const definition = PROVIDERS[kind];
  const value = (name: string) => config[name] ?? definition.fields.find((f) => f.name === name)?.default;
  const missing = definition.fields.filter((field) => {
    if (!field.required) return false;
    if (field.showWhen && !field.showWhen.values.includes(String(value(field.showWhen.field) ?? ''))) return false;
    const current = value(field.name);
    return current === undefined || current === '';
  });
  if (missing.length) throw new SecretsError(`Missing ${missing.map((f) => f.label).join(', ')}`);
}

/** `secret_provider.create|update|delete`: the provider's name and kind and which fields changed, never a setting or secret value. */
function auditProvider(change: 'create' | 'update' | 'delete', provider: Pick<StoredProvider, 'name' | 'kind'>, details: Record<string, unknown>) {
  recordAudit({
    action: `secret_provider.${change}`,
    target: { type: 'secret_provider', id: provider.name, name: provider.name },
    summary: `${change === 'create' ? 'Added' : change === 'update' ? 'Changed' : 'Removed'} the external secrets provider ${provider.name} (${provider.kind})`,
    details: { provider: provider.name, kind: provider.kind, ...details },
  });
}

export const externalSecrets = {
  list(): SecretProviderView[] {
    return providerStore.list().map(viewOf);
  },

  get(name: string): SecretProviderView | undefined {
    const stored = providerStore.get(name);
    return stored && viewOf(stored);
  },

  /** Every enabled provider's secret names (for suggestions). */
  names(): Record<string, string[]> {
    return Object.fromEntries(
      providerStore
        .list()
        .filter((p) => p.enabled)
        .map((p) => [p.name, p.names]),
    );
  },

  create(input: ProviderInput): SecretProviderView {
    const name = input.name?.trim() ?? '';
    if (!PROVIDER_NAME.test(name)) throw new SecretsError('Provider names start with a letter and hold letters, digits and “_” (it is the name in $secrets.<name>)');
    if (!input.kind || !PROVIDERS[input.kind]) throw new SecretsError('Choose a provider kind');
    if (providerStore.get(name)) throw new SecretsError(`A provider named “${name}” already exists`, 409);
    const { settings, secrets } = splitSettings(input.kind, input.settings);
    checkRequired(input.kind, { ...settings, ...secrets });
    const now = new Date().toISOString();
    const stored: StoredProvider = { name, kind: input.kind, enabled: input.enabled ?? true, settings, secrets, names: [], createdAt: now, updatedAt: now };
    build(stored).close?.();
    providerStore.save(stored);
    auditProvider('create', stored, { enabled: stored.enabled });
    return viewOf(stored);
  },

  update(name: string, input: ProviderInput): SecretProviderView {
    const previous = providerStore.get(name);
    if (!previous) throw new SecretsError('Provider not found', 404);
    if (input.kind && input.kind !== previous.kind) throw new SecretsError('A provider’s kind can’t change: add another provider');
    const { settings, secrets } = splitSettings(previous.kind, input.settings, previous);
    checkRequired(previous.kind, { ...settings, ...secrets });
    // A new timestamp even within the same millisecond: other processes rebuild the provider when it moves.
    const now = new Date(Math.max(Date.now(), Date.parse(previous.updatedAt) + 1)).toISOString();
    const stored: StoredProvider = { ...previous, settings, secrets, enabled: input.enabled ?? previous.enabled, updatedAt: now };
    if (stored.enabled) build(stored).close?.();
    providerStore.save(stored);
    dropInstance(name);
    // Which settings changed (names only), and a secret field is only ever named as “changed”.
    const changed = Object.keys(input.settings ?? {}).filter((key) => {
      const sent = input.settings![key];
      if (sent === undefined) return false;
      if (key in settings) return String(settings[key] ?? '') !== String(previous.settings[key] ?? '');
      return sent !== null ? String(sent) !== '' : true;
    });
    auditProvider('update', stored, { enabledFrom: previous.enabled, enabledTo: stored.enabled, fieldsChanged: changed });
    return viewOf(stored);
  },

  delete(name: string): boolean {
    dropInstance(name);
    const before = providerStore.get(name);
    const deleted = providerStore.delete(name);
    if (deleted && before) auditProvider('delete', before, {});
    return deleted;
  },

  /**
   * Connect and list the names. With `settings` (the form's values over the saved ones), an unsaved configuration is
   * tested and nothing is stored; otherwise the saved provider is, and its names and result are kept.
   */
  async test(name: string, input?: ProviderInput): Promise<SecretProviderCheck> {
    const previous = providerStore.get(name);
    const kind = previous?.kind ?? input?.kind;
    if (!kind || !PROVIDERS[kind]) throw new SecretsError(previous ? `Unknown provider kind “${previous.kind}”` : 'Provider not found', previous ? 400 : 404);
    const unsaved = Boolean(input?.settings) || !previous;
    let provider: SecretsProvider | undefined;
    try {
      // A fresh connection either way (a refresh logs in again); the saved provider's cached values go too.
      if (!unsaved) dropInstance(name);
      const { settings, secrets } = unsaved ? splitSettings(kind, input?.settings, previous) : previous!;
      if (unsaved) checkRequired(kind, { ...settings, ...secrets });
      provider = build({ kind, settings, secrets });
      const message = await provider.test();
      const names = await provider.listNames();
      const result = checked(true, message, names.length);
      if (!unsaved) providerStore.saveCheck(name, result, names);
      return result;
    } catch (error) {
      if (!(error instanceof SecretsError || error instanceof SecretProviderError)) logger.warn('external secrets provider test failed', { 'landflow.secrets.provider': name, error });
      const result = checked(false, (error as Error).message);
      if (!unsaved) providerStore.saveCheck(name, result);
      return result;
    } finally {
      provider?.close?.();
    }
  },

  /** Reconnect, list the names again and forget cached values. */
  async refresh(name: string): Promise<SecretProviderView> {
    if (!providerStore.get(name)) throw new SecretsError('Provider not found', 404);
    await this.test(name);
    return this.get(name)!;
  },

  /**
   * One secret's value, from the cache or the provider. Throws a SecretsError naming the reference when the provider
   * isn't set up, the secret doesn't exist or the provider can't be reached.
   */
  async read(provider: string, name: string): Promise<SecretValue> {
    const key = cacheKey(provider, name);
    const live = instance(provider);
    const cached = state.values.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    let pending = state.inflight.get(key);
    if (!pending) {
      state.fetches++;
      pending = live
        .getSecret(name)
        .then((value) => {
          const ttl = cacheTtlSeconds();
          if (value !== undefined && ttl > 0) state.values.set(key, { value, expires: Date.now() + ttl * 1000 });
          return value;
        })
        .finally(() => state.inflight.delete(key));
      state.inflight.set(key, pending);
    }
    let value: SecretValue | undefined;
    try {
      value = await pending;
    } catch (error) {
      throw new SecretsError(`External secret ${formatSecretReference({ provider, name })}: ${redactText((error as Error).message)}`, 502);
    }
    if (value === undefined) throw new SecretsError(`External secret ${formatSecretReference({ provider, name })} doesn’t exist`, 404);
    return value;
  },

  /** Forget cached values (one provider, or all). */
  clearCache(provider?: string) {
    if (provider) dropCache(provider);
    else state.values.clear();
  },

  /** For tests: how many reads reached a provider. */
  stats: () => ({ fetches: state.fetches, cached: state.values.size }),

  /** Stop every provider's background work and forget them (tests). */
  closeAll() {
    for (const name of [...state.instances.keys()]) dropInstance(name);
    state.values.clear();
  },
};
