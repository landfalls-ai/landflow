/**
 * Environments: an instance is one environment (LANDFLOW_ENVIRONMENT: development, staging, production, …), with
 * its own database, credentials, variables and external secrets providers, and its own branch in the Git repository
 * (Settings → Source control's branch). Settings → Environments (the `environments` settings key) holds what the
 * instance knows about the others — their branches, for promotion — and how it takes changes in:
 *
 * - `protected`: workflows are read-only here (./protection.ts); LANDFLOW_ENVIRONMENT_PROTECTED=true|false wins;
 * - `publishOnPull`: what a pull does with publication (lib/server/sync `publish`: file, all or none);
 * - `credentialMap`: a file's `{ type, name }` credential reference → one of this instance's credentials, so a
 *   promoted workflow uses this environment's credential even when the names differ (otherwise names match);
 * - `rowTables`: data tables whose rows promotion copies to the target (opt-in per table);
 * - `secretMappings`: `$secrets` references that promoted credentials' secret fields get in the target.
 *
 * Without LANDFLOW_ENVIRONMENT none of this applies, and the instance behaves as it always did. Reads the database
 * only (no Git), so the sync code can use it.
 */
import type { CredentialMapping, CredentialSecretMapping, EnvironmentSettings, PullPublishMode } from '../../shared/secrets';
import { database } from '../db';
import { parse } from '../db/rows';

const SETTINGS_KEY = 'environments';
/** A name for LANDFLOW_ENVIRONMENT and the environments list. */
export const ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const DEFAULT_ENVIRONMENTS = ['development', 'staging', 'production'];

export class EnvironmentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/** This instance's environment, or undefined when LANDFLOW_ENVIRONMENT isn't set. */
export function currentEnvironment(): string | undefined {
  const name = process.env.LANDFLOW_ENVIRONMENT?.trim();
  return name && ENVIRONMENT_NAME.test(name) ? name : undefined;
}

export function readEnvironmentSettings(): EnvironmentSettings {
  try {
    return parse<EnvironmentSettings>(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY)?.value) ?? {};
  } catch {
    return {};
  }
}

export function writeEnvironmentSettings(next: EnvironmentSettings): void {
  database().upsert('settings', { key: SETTINGS_KEY, value: JSON.stringify(next) });
}

/** Whether workflows are read-only here, and why. */
export function protection(): { protected: boolean; source: 'env' | 'settings' | 'none' } {
  if (!currentEnvironment()) return { protected: false, source: 'none' };
  const env = process.env.LANDFLOW_ENVIRONMENT_PROTECTED?.trim().toLowerCase();
  if (env === 'true' || env === '1' || env === 'yes') return { protected: true, source: 'env' };
  if (env === 'false' || env === '0' || env === 'no') return { protected: false, source: 'env' };
  return readEnvironmentSettings().protected ? { protected: true, source: 'settings' } : { protected: false, source: 'none' };
}

export const isProtectedEnvironment = () => protection().protected;

/** The environments promotion knows, in order, this one included. */
export function environmentNames(): string[] {
  const configured = readEnvironmentSettings().environments;
  const fromEnv = process.env.LANDFLOW_ENVIRONMENTS?.split(',').map((e) => e.trim()).filter(Boolean);
  const list = (configured?.length ? configured : fromEnv?.length ? fromEnv : DEFAULT_ENVIRONMENTS).filter((e) => ENVIRONMENT_NAME.test(e));
  const current = currentEnvironment();
  return [...new Set([...list, ...(current ? [current] : [])])];
}

/** Settings → Source control's branch (this environment's), read from its settings. */
export function sourceControlBranch(): string | undefined {
  try {
    const stored = parse<{ config?: { branch?: string } }>(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'source_control')?.value);
    return stored?.config?.branch;
  } catch {
    return undefined;
  }
}

/** The Git branch of an environment: this one's is Source control's branch; another's is in the settings, else its name. */
export function branchOf(environment: string): string {
  const settings = readEnvironmentSettings();
  if (environment === currentEnvironment()) return sourceControlBranch() ?? settings.branches?.[environment] ?? environment;
  return settings.branches?.[environment] ?? environment;
}

/** What a pull does with publication when the caller doesn't say: the setting with an environment, else `file`. */
export function defaultPublishMode(): PullPublishMode {
  return (currentEnvironment() && readEnvironmentSettings().publishOnPull) || 'file';
}

/** The explicit credential mappings. */
export function credentialMappings(): CredentialMapping[] {
  return readEnvironmentSettings().credentialMap ?? [];
}

/** The mapped credential id for a file's reference, if one is mapped. */
export function mappedCredential(type: string, name: string): string | undefined {
  return credentialMappings().find((m) => m.type === type && m.name === name)?.credentialId;
}

/** Data tables (ids) whose rows promotion copies. */
export function rowTableIds(): string[] {
  return readEnvironmentSettings().rowTables ?? [];
}

/** The `$secrets` references for promoted credentials' secret fields (for promotions to `target`). */
export function secretMappingsFor(target: string): CredentialSecretMapping[] {
  return (readEnvironmentSettings().secretMappings ?? []).filter((m) => !m.environment || m.environment === target);
}
