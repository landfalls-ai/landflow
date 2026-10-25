/**
 * Trigger idempotency. A webhook or form call with an `Idempotency-Key` header (or an execute API
 * call with `idempotencyKey`) records the key against the execution it started, per workflow; the
 * same key again within the retention window gets that execution back instead of a new run. Keys
 * live in the `idempotency_keys` table and are pruned hourly with the other platform data.
 *
 * The runner checks and records keys synchronously while it creates the execution, so two calls
 * with the same key can't both start a run.
 */
import { database } from './db';

/** How long a key is remembered: LANDFLOW_IDEMPOTENCY_TTL_HOURS, default 24 h (Inngest's window). */
export function idempotencyTtlMs(): number {
  const hours = Number(process.env.LANDFLOW_IDEMPOTENCY_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
}

export const MAX_KEY_LENGTH = 255;

/** A trigger call that repeats an earlier one: `executionId` is the execution the key started. */
export class DuplicateRunError extends Error {
  constructor(
    readonly executionId: string,
    readonly key: string,
  ) {
    super(`A run with idempotency key "${key}" already exists (execution ${executionId})`);
    this.name = 'DuplicateRunError';
  }
}

/** The request's `Idempotency-Key` header, trimmed (undefined when absent or empty). */
export function idempotencyKeyOf(request: Request): string | undefined {
  const key = request.headers.get('idempotency-key')?.trim();
  return key ? key.slice(0, MAX_KEY_LENGTH) : undefined;
}

/** The execution a key started within the retention window, if any. */
export function findIdempotent(workflowId: string, key: string, now = Date.now()): string | undefined {
  const row = database().get<{ execution_id: string; created_at: string }>('SELECT execution_id, created_at FROM idempotency_keys WHERE workflow_id = ? AND key = ?', workflowId, key);
  if (!row || Date.parse(row.created_at) < now - idempotencyTtlMs()) return undefined;
  return row.execution_id;
}

/** Remember that `key` started `executionId` (an expired entry for the key is replaced). */
export function rememberIdempotent(workflowId: string, key: string, executionId: string, now = Date.now()) {
  database().upsert('idempotency_keys', { workflow_id: workflowId, key, execution_id: executionId, created_at: new Date(now).toISOString() });
}

/** Forget keys past the retention window. Returns how many went. */
export function pruneIdempotencyKeys(now = Date.now()): number {
  return database().deleteBefore('idempotency_keys', 'created_at', new Date(now - idempotencyTtlMs()).toISOString());
}
