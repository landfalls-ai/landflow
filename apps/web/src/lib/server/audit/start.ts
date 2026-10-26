/** Boot hook for the audit log (bootstrap): its event listeners, SIEM outbox delivery and retention, and (queue mode on Postgres) the hash chain's sealer. Idempotent. */
import { startChainSealer } from './chain';
import { ensureListeners } from './index';
import { startAuditOutbox } from './outbox';

export function startAudit() {
  ensureListeners();
  startChainSealer();
  if (process.env.LANDFLOW_AUDIT_OUTBOX !== 'off') startAuditOutbox();
}
