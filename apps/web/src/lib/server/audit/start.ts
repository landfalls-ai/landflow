/** Boot hook for the audit log (bootstrap): its event listeners, SIEM outbox delivery and retention, and (queue mode on Postgres) the hash chain's sealer. Idempotent. */
import { startChainSealer } from './chain';
import { ensureListeners } from './index';
import { ensureAuditMetrics } from './metrics';
import { startAuditOutbox } from './outbox';

export function startAudit() {
  ensureListeners();
  startChainSealer();
  // The outbox gauges, also where LANDFLOW_AUDIT_OUTBOX=off (another host delivers, but each host reports the shared queue).
  ensureAuditMetrics();
  if (process.env.LANDFLOW_AUDIT_OUTBOX !== 'off') startAuditOutbox();
}
