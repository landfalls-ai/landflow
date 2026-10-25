/**
 * Hooks redaction of external secret values (./redact.ts) into the logger (every line) and into the rows written to
 * the executions, execution steps and checkpoints tables, once per process. ./runtime.ts loads it, so it is in place
 * wherever nodes run (the host, a queue worker).
 */
import { setRowFilter } from '../db/database';
import { singleton } from '../singleton';
import { addLogScrubber } from '../telemetry/logger';
import { hasSecretValues, redactJsonText, redactValue } from './redact';

/** Tables whose rows hold run data: their JSON columns are redacted before they are written. */
const RUN_TABLES = new Set(['executions', 'execution_steps', 'execution_checkpoints']);

export function installRedaction(): void {
  singleton('external-secrets-redaction', () => {
    addLogScrubber((record) => (hasSecretValues() ? redactValue(record) : record));
    setRowFilter((table, row) => {
      if (!RUN_TABLES.has(table) || !hasSecretValues()) return row;
      const out: typeof row = {};
      for (const [key, value] of Object.entries(row)) out[key] = typeof value === 'string' ? redactJsonText(value) : value;
      return out;
    });
    return true;
  });
}

installRedaction();
