/** Boot hook for the audit log (bootstrap): its event listeners, SIEM outbox delivery and retention. Idempotent. */
import { ensureListeners } from './index';
import { startAuditOutbox } from './outbox';

export function startAudit() {
  ensureListeners();
  if (process.env.LANDFLOW_AUDIT_OUTBOX !== 'off') startAuditOutbox();
}
