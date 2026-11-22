/**
 * The audit row for a key refused for its address or its use cap (`api.denied`, reason `ip_not_allowed` or
 * `uses_exhausted`): one a minute per key and route (the throttle of denied reads, audit/http.ts) and under that
 * layer's per-minute ceiling, so a caller hammering a leaked key can't flood the log. The row names the key's id and
 * label, never the key; the caller's address is the request's own (audit context). Recorded inside the request's audit
 * context, which then leaves the generic refusal row out.
 */
import { recordAudit } from '../audit';
import { deniedReadDue, deniedReadUnderCap } from '../audit/http';
import { auditRequestContext } from '../audit/context';

export type KeyRefusal = 'ip_not_allowed' | 'uses_exhausted';

/** What a refusal says to the caller: never the list. */
export const KEY_REFUSAL_MESSAGE: Record<KeyRefusal, string> = {
  ip_not_allowed: 'This API key can’t be used from this address',
  uses_exhausted: 'This API key has used all its uses',
};

const SUMMARY: Record<KeyRefusal, string> = {
  ip_not_allowed: 'refused: called from an address outside its allow-list',
  uses_exhausted: 'refused: it has used all its uses',
};

export function noteKeyRefusal(reason: KeyRefusal, key: { id: string; label: string }, status = 401): void {
  const ctx = auditRequestContext();
  if (!deniedReadDue(`key:${key.id}`, `${reason}:${ctx?.route ?? ctx?.path ?? ''}`) || !deniedReadUnderCap()) {
    // Throttled: this refusal is accounted for, so the generic layer must not write a row of its own for it.
    if (ctx) ctx.recorded++;
    return;
  }
  recordAudit({
    action: 'api.denied',
    outcome: 'denied',
    status,
    target: { type: 'api_key', id: key.id, name: key.label },
    summary: `The API key “${key.label}” ${SUMMARY[reason]}`,
    details: { reason, keyId: key.id },
  });
}
