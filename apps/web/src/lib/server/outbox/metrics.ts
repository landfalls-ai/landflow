/**
 * Event outbox metrics (docs/observability.md): the backlog and the age of the oldest waiting row per kind of outbox
 * (`topic`, never a subscription id) and a counter of delivery attempts by outcome. Own scope, instruments re-created when
 * the meter provider changes, a tally in process so tests need no exporter.
 */
import { metrics, type Counter, type MeterProvider } from '@opentelemetry/api';
import { database } from '../db';
import { singleton } from '../singleton';
import { telemetryConfig } from '../telemetry/config';
import { SUBSCRIPTION_TOPIC } from './core';

const SCOPE = 'landflow-outbox';

export type DeliveryOutcome = 'delivered' | 'failed' | 'dead' | 'gone';

const cache = () => singleton('outbox-metrics', () => ({ current: undefined as { provider: MeterProvider; delivered: Counter } | undefined, outcomes: new Map<string, number>() }));

/** Waiting rows and the age (seconds) of the oldest, over every subscription; dead rows are counted apart. */
export function outboxHealth(now = Date.now()): { backlog: number; oldestAgeSeconds: number; dead: number } {
  try {
    const row = database().get<{ live: number | bigint | null; dead: number | bigint | null; oldest: string | null }>(
      'SELECT SUM(CASE WHEN dead_at IS NULL THEN 1 ELSE 0 END) AS live, SUM(CASE WHEN dead_at IS NULL THEN 0 ELSE 1 END) AS dead, MIN(CASE WHEN dead_at IS NULL THEN created_at END) AS oldest FROM event_outbox WHERE topic = ?',
      SUBSCRIPTION_TOPIC,
    );
    const oldest = row?.oldest ? Date.parse(row.oldest) : NaN;
    return { backlog: Number(row?.live ?? 0), dead: Number(row?.dead ?? 0), oldestAgeSeconds: Number.isFinite(oldest) ? Math.max(0, Math.round((now - oldest) / 1000)) : 0 };
  } catch {
    return { backlog: 0, dead: 0, oldestAgeSeconds: 0 };
  }
}

function instruments(): { delivered: Counter } {
  const provider = metrics.getMeterProvider();
  const held = cache();
  if (held.current?.provider === provider) return held.current;
  const meter = provider.getMeter(SCOPE, telemetryConfig.serviceVersion);
  meter.createObservableGauge('landflow.outbox.backlog', { description: 'Events waiting to be delivered, by outbox kind' }).addCallback((result) => result.observe(outboxHealth().backlog, { topic: SUBSCRIPTION_TOPIC }));
  meter.createObservableGauge('landflow.outbox.oldest_age_s', { description: 'Age of the oldest waiting event, by outbox kind', unit: 's' }).addCallback((result) => result.observe(outboxHealth().oldestAgeSeconds, { topic: SUBSCRIPTION_TOPIC }));
  held.current = { provider, delivered: meter.createCounter('landflow.outbox.delivered', { description: 'Delivery attempts of outbox events, by outbox kind and outcome (delivered, failed, dead, gone)' }) };
  return held.current;
}

/** Register the instruments (idempotent). */
export function ensureOutboxMetrics() {
  try {
    instruments();
  } catch {
    // Metrics never break delivery.
  }
}

/** Count one delivery attempt. */
export function recordDelivery(outcome: DeliveryOutcome) {
  const tally = cache().outcomes;
  tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
  try {
    instruments().delivered.add(1, { topic: SUBSCRIPTION_TOPIC, outcome });
  } catch {
    // Metrics never break delivery.
  }
}

/** What this process counted so far (tests, diagnostics). */
export const deliveryTally = (): Record<string, number> => Object.fromEntries(cache().outcomes);
