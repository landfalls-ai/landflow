/**
 * What every external secrets provider implements. A provider is built from its saved settings (secret fields
 * already decrypted) and answers three questions: does the connection work, which secret names exist, and what is
 * one secret's value. Names are listed for the Settings page and autocomplete; values are read only when a credential
 * that references them is used, and never listed.
 */
import type { SecretValue } from '@landflow/engine';
import type { SecretProviderKindInfo } from '../../../shared/secrets';

export type { SecretValue };

/** A provider's settings: the form's values (strings and numbers), secrets decrypted. */
export type ProviderConfig = Record<string, string | number | undefined>;

export interface ProviderContext {
  /** The instance's environment (LANDFLOW_ENVIRONMENT), for `{environment}` in a path or prefix. */
  environment?: string;
  /** Network calls; the tests pass none (providers call fake servers at the configured URLs). */
  fetch?: typeof fetch;
}

export interface SecretsProvider {
  /** Connect and check access; resolves to a short description ("12 secrets in landflow/"). */
  test(): Promise<string>;
  /** Every secret name, sorted. */
  listNames(): Promise<string[]>;
  /** One secret's value, or undefined when there is no such secret. */
  getSecret(name: string): Promise<SecretValue | undefined>;
  /** Stop background work (token renewal). */
  close?(): void;
}

export interface ProviderDefinition extends SecretProviderKindInfo {
  /** Settings that are secrets: stored sealed, never returned. */
  secretFields: string[];
  create(config: ProviderConfig, context: ProviderContext): SecretsProvider;
}

/** A provider refused or couldn't be reached. Messages never contain secret values. */
export class SecretProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SecretProviderError';
  }
}

/** `{environment}` in a path or prefix → the instance's environment (empty without one). */
export function withEnvironment(text: string | number | undefined, environment?: string): string {
  return String(text ?? '').replaceAll('{environment}', environment ?? '');
}

/** A string setting, trimmed ('' when unset). */
export const str = (config: ProviderConfig, key: string): string => String(config[key] ?? '').trim();

/** A secret's text as a value: a JSON object becomes its keys, anything else stays text. */
export function parseSecretText(text: string): SecretValue {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not JSON: plain text.
    }
  }
  return text;
}
