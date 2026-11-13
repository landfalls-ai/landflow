/**
 * Audit reliability metrics: a failed audit write is no longer only a log line. `landflow.audit.write_failures{action}`
 * counts events that could not be stored (recordAudit and the generic layer swallow the error unless the action is
 * required, see `LANDFLOW_AUDIT_FAIL_CLOSED` in ./index), `landflow.audit.outbox.delivery_failures{destination}` counts
 * failed SIEM deliveries, and two observable gauges read the outbox when the metrics are collected: its depth and the
 * age (seconds) of its oldest row. A tally is kept in process too, so tests and `outboxHealth()` need no exporter.
 * Own scope and instruments (not telemetry/metrics.ts), re-created when the global meter provider changes.
 */
import { metrics, type Counter, type MeterProvider } from '@opentelemetry/api';
import { database } from '../db';
import { singleton } from '../singleton';
import { telemetryConfig } from '../telemetry/config';

const SCOPE = 'landflow-audit';

interface Instruments {
  writeFailures: Counter;
  deliveryFailures: Counter;
}

let cached: { provider: MeterProvider; instruments: Instruments } | undefined;

/** The oldest queued row's age and the queue's depth, over every destination (or one). */
export function outboxHealth(destinationId?: string, now = Date.now()): { depth: number; oldestAgeSeconds: number } {
  try {
    const where = destinationId ? 'WHERE destination_id = ?' : '';
    const args = destinationId ? [destinationId] : [];
    const row = database().get<{ n: number | string; oldest: string | null }>(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM audit_outbox ${where}`, ...args);
    const oldest = row?.oldest ? Date.parse(row.oldest) : NaN;
    return { depth: Number(row?.n ?? 0), oldestAgeSeconds: Number.isFinite(oldest) ? Math.max(0, Math.round((now - oldest) / 1000)) : 0 };
  } catch {
    return { depth: 0, oldestAgeSeconds: 0 };
  }
}

/** Register the instruments (a healthy process reports the gauges too). Cheap: re-created only when the meter provider changes. */
export function ensureAuditMetrics() {
  try {
    instruments();
  } catch {
    // Metrics never break the audit path.
  }
}

function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider === provider) return cached.instruments;
  const meter = provider.getMeter(SCOPE, telemetryConfig.serviceVersion);
  meter.createObservableGauge('landflow.audit.outbox.depth', { description: 'Audit events queued for SIEM destinations and not yet delivered' }).addCallback((result) => result.observe(outboxHealth().depth));
  meter.createObservableGauge('landflow.audit.outbox.oldest_age', { description: 'Age of the oldest undelivered audit outbox row', unit: 's' }).addCallback((result) => result.observe(outboxHealth().oldestAgeSeconds));
  cached = {
    provider,
    instruments: {
      writeFailures: meter.createCounter('landflow.audit.write_failures', { description: 'Audit events that could not be stored, by action' }),
      deliveryFailures: meter.createCounter('landflow.audit.outbox.delivery_failures', { description: 'Failed deliveries of audit events to SIEM destinations, by destination' }),
    },
  };
  return cached.instruments;
}

const tally = () => singleton('audit-failure-tally', () => ({ writes: new Map<string, number>(), deliveries: new Map<string, number>() }));

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

/** An audit event could not be stored (`action` is the event's, `api.request` for the generic layer's). */
export function recordAuditWriteFailure(action: string) {
  bump(tally().writes, action);
  try {
    instruments().writeFailures.add(1, { action });
  } catch {
    // Metrics never break the audit path.
  }
}

/** A delivery to a SIEM destination failed. */
export function recordAuditDeliveryFailure(destination: string) {
  bump(tally().deliveries, destination);
  try {
    instruments().deliveryFailures.add(1, { destination });
  } catch {
    // As above.
  }
}

/** Failures counted in this process since it started (or since `resetAuditFailureTally`). */
export function auditFailureTally(): { writes: Record<string, number>; deliveries: Record<string, number> } {
  const t = tally();
  return { writes: Object.fromEntries(t.writes), deliveries: Object.fromEntries(t.deliveries) };
}

export function resetAuditFailureTally() {
  const t = tally();
  t.writes.clear();
  t.deliveries.clear();
}
