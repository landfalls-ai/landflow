/**
 * Saved external secrets providers, in the `external_secret_providers` table (migration 1000). Secret settings are
 * sealed with the credential vault's key (`credentials.sealSecret`, AES-256-GCM, like credentials) and only opened to
 * build the provider; the API sees which of them are set, never their values.
 */
import type { SecretProviderCheck, SecretProviderKind, SecretProviderView } from '../../shared/secrets';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { parse } from '../db/rows';
import type { ProviderConfig } from './providers';

export interface StoredProvider {
  name: string;
  kind: SecretProviderKind;
  enabled: boolean;
  settings: Record<string, string | number>;
  /** Secret settings, decrypted. */
  secrets: Record<string, string>;
  names: string[];
  lastCheck?: SecretProviderCheck;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  name: string;
  kind: string;
  enabled: number;
  settings: string;
  secrets: string | null;
  names: string | null;
  last_check: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): StoredProvider {
  let secrets: Record<string, string> = {};
  if (row.secrets) {
    try {
      secrets = JSON.parse(credentials.openSecret(row.secrets)) as Record<string, string>;
    } catch {
      // Sealed with another key: the provider can't connect until its secrets are entered again.
      secrets = {};
    }
  }
  return {
    name: row.name,
    kind: row.kind as SecretProviderKind,
    enabled: Boolean(row.enabled),
    settings: parse<Record<string, string | number>>(row.settings) ?? {},
    secrets,
    names: parse<string[]>(row.names) ?? [],
    ...(row.last_check && { lastCheck: parse<SecretProviderCheck>(row.last_check) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'name, kind, enabled, settings, secrets, names, last_check, created_at, updated_at';

export const providerStore = {
  list(): StoredProvider[] {
    return database().all<Row>(`SELECT ${COLUMNS} FROM external_secret_providers ORDER BY name`).map(fromRow);
  },

  get(name: string): StoredProvider | undefined {
    const row = database().get<Row>(`SELECT ${COLUMNS} FROM external_secret_providers WHERE name = ?`, name);
    return row ? fromRow(row) : undefined;
  },

  /** When the provider last changed (cheap: to notice changes made by another process). */
  version(name: string): string | undefined {
    return database().get<{ updated_at: string }>('SELECT updated_at FROM external_secret_providers WHERE name = ?', name)?.updated_at;
  },

  save(provider: StoredProvider): void {
    const hasSecrets = Object.values(provider.secrets).some((v) => v !== '' && v !== undefined);
    database().upsert('external_secret_providers', {
      name: provider.name,
      kind: provider.kind,
      enabled: provider.enabled,
      settings: JSON.stringify(provider.settings),
      secrets: hasSecrets ? credentials.sealSecret(JSON.stringify(provider.secrets)) : null,
      names: JSON.stringify(provider.names),
      last_check: provider.lastCheck ? JSON.stringify(provider.lastCheck) : null,
      created_at: provider.createdAt,
      updated_at: provider.updatedAt,
    });
  },

  /** Record a test or refresh without touching the settings (or `updated_at`, which would rebuild the provider). */
  saveCheck(name: string, check: SecretProviderCheck, names?: string[]): void {
    const row = database().get<Row>(`SELECT ${COLUMNS} FROM external_secret_providers WHERE name = ?`, name);
    if (!row) return;
    // Whole rows only: an upsert's insert half must satisfy NOT NULL on SQLite and Postgres.
    database().upsert('external_secret_providers', { ...row, last_check: JSON.stringify(check), names: names ? JSON.stringify(names) : row.names });
  },

  delete(name: string): boolean {
    return database().delete('external_secret_providers', { name }) > 0;
  },
};

/** The provider's settings for building it: settings and decrypted secrets together. */
export const configOf = (provider: Pick<StoredProvider, 'settings' | 'secrets'>): ProviderConfig => ({ ...provider.settings, ...provider.secrets });

export function viewOf(provider: StoredProvider): SecretProviderView {
  return {
    name: provider.name,
    kind: provider.kind,
    enabled: provider.enabled,
    settings: provider.settings,
    secretsSet: Object.keys(provider.secrets).filter((key) => provider.secrets[key] !== ''),
    names: provider.names,
    ...(provider.lastCheck && { lastCheck: provider.lastCheck }),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}
