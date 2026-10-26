/**
 * External secrets' instance settings (Settings → External secrets, owners and admins), in the `settings` table under
 * `external_secrets`:
 *
 * - `allowInParameters`: node parameter expressions may read `$secrets` at run time (off by default; n8n allows them
 *   in credentials only). Anyone who can edit a workflow can then use every secret, so it is an admin's choice.
 *
 * Read from the database on every use (one small row), so the host, queue workers and a second host agree without
 * a restart.
 */
import { database } from '../db';
import { parse } from '../db/rows';

const SETTINGS_KEY = 'external_secrets';

export interface ExternalSecretsSettings {
  allowInParameters: boolean;
}

/** The node error when parameters read `$secrets` and the setting is off. */
export const PARAMETERS_NOT_ALLOWED =
  '$secrets (external secrets) can’t be used in node parameters on this instance: an owner or admin can turn on “Allow in node parameters” in Settings → External secrets, or move the value into a credential field';

export function readSecretsSettings(): ExternalSecretsSettings {
  let saved: Partial<ExternalSecretsSettings> | undefined;
  try {
    saved = parse<Partial<ExternalSecretsSettings>>(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY)?.value);
  } catch {
    saved = undefined;
  }
  return { allowInParameters: saved?.allowInParameters === true };
}

/** Change the settings given; returns the new settings. */
export function writeSecretsSettings(patch: Partial<ExternalSecretsSettings>): ExternalSecretsSettings {
  const next = { ...readSecretsSettings(), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  database().upsert('settings', { key: SETTINGS_KEY, value: JSON.stringify(next) });
  return next;
}

/** Whether node parameters may read `$secrets`. */
export const secretsAllowedInParameters = (): boolean => readSecretsSettings().allowInParameters;
