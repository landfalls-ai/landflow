/**
 * Per-environment variable values (the `variable_environment_values` table, migration 1001). A variable keeps its
 * value, and may have a value per environment: on an instance whose LANDFLOW_ENVIRONMENT matches, `$vars.KEY` reads
 * that one instead. Git sync carries them in variables.json (`environments`, with values only), so a variable can
 * say what it is in every environment and each instance picks its own after a pull or promotion.
 */
import { database } from '../db';
import { auditVariableEnvironments } from '../variable-store';
import { currentEnvironment, ENVIRONMENT_NAME, EnvironmentError } from './settings';

const MAX_VALUE_LENGTH = 10_000;

interface Row {
  key: string;
  environment: string;
  value: string;
}

export const environmentValues = {
  /** `{ environment: value }` of one variable. */
  of(key: string): Record<string, string> {
    return Object.fromEntries(
      database()
        .all<Row>('SELECT key, environment, value FROM variable_environment_values WHERE key = ? ORDER BY environment', key)
        .map((row) => [row.environment, row.value]),
    );
  },

  /** Every variable's per-environment values, by key. */
  all(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const row of database().all<Row>('SELECT key, environment, value FROM variable_environment_values ORDER BY key, environment')) (out[row.key] ??= {})[row.environment] = row.value;
    return out;
  },

  /** Set (a string) or remove (`null`) values; other environments stay. */
  set(key: string, values: Record<string, string | null>): Record<string, string> {
    const before = this.of(key);
    const after = this.put(key, values);
    auditVariableEnvironments(key, {}, before, values);
    return after;
  },

  /** `set` without the audit event (a rename moves the values; the variable's own `variable.update` covers it). */
  put(key: string, values: Record<string, string | null>): Record<string, string> {
    const db = database();
    const now = new Date().toISOString();
    for (const [environment, value] of Object.entries(values)) {
      if (!ENVIRONMENT_NAME.test(environment)) throw new EnvironmentError(`“${environment}” is not an environment name`);
      if (value !== null && (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH)) throw new EnvironmentError(`The ${environment} value of ${key} must be a string of at most ${MAX_VALUE_LENGTH} characters`);
    }
    db.transaction(() => {
      for (const [environment, value] of Object.entries(values)) {
        if (value === null) db.delete('variable_environment_values', { key, environment });
        else db.upsert('variable_environment_values', { key, environment, value, updated_at: now });
      }
    });
    return this.of(key);
  },

  /** Make the values exactly `values` (sync). */
  replace(key: string, values: Record<string, string>): void {
    const current = this.of(key);
    const change: Record<string, string | null> = { ...values };
    for (const environment of Object.keys(current)) if (!(environment in values)) change[environment] = null;
    this.set(key, change);
  },

  rename(from: string, to: string): void {
    const values = this.of(from);
    if (!Object.keys(values).length) return;
    this.remove(from);
    this.put(to, values);
  },

  remove(key: string): void {
    database().delete('variable_environment_values', { key });
  },

  /** `$vars` for this instance: each variable's value for the current environment where it has one. */
  overlay(record: Record<string, string>): Record<string, string> {
    const environment = currentEnvironment();
    if (!environment) return record;
    const rows = database().all<Row>('SELECT key, environment, value FROM variable_environment_values WHERE environment = ?', environment);
    if (!rows.length) return record;
    const out = { ...record };
    for (const row of rows) if (row.key in out) out[row.key] = row.value;
    return out;
  },
};
