/**
 * Marketplace spans and metrics (docs/marketplace.md): `marketplace.{operation}` spans around
 * fetching catalogs and plugins, installs and uninstalls (the outbound GitHub requests nest inside
 * as HTTP client spans), plus operation counters and node-plugin process restarts.
 */
import type { Attributes, Meter } from '@opentelemetry/api';
import { DURATION_BUCKETS_MS } from '@landflow/engine';
import { hostMetrics, outcomeOf } from './metrics';
import { SpanKind, withSpan, type Span } from './spans';

export type MarketplaceOperation = 'fetch' | 'detail' | 'install' | 'uninstall' | 'deps';

function create(meter: Meter) {
  return {
    operations: meter.createCounter('landflow.marketplace.operations', { description: 'Marketplace fetches, plugin reads, installs and uninstalls' }),
    duration: meter.createHistogram('landflow.marketplace.duration', {
      description: 'Duration of a marketplace operation',
      unit: 'ms',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
    }),
    restarts: meter.createCounter('landflow.marketplace.plugin.restarts', { description: 'Restarts of node plugins the host runs' }),
  };
}

let cached: { meter: Meter; instruments: ReturnType<typeof create> } | undefined;

function instruments() {
  const { meter } = hostMetrics();
  if (cached?.meter !== meter) cached = { meter, instruments: create(meter) };
  return cached.instruments;
}

/** Run one marketplace operation in a `marketplace.{operation}` span and count it. */
export async function traceMarketplace<T>(operation: MarketplaceOperation, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const base: Attributes = { 'landflow.marketplace.operation': operation };
  const started = performance.now();
  let outcome = 'ok';
  try {
    return await withSpan(`marketplace.${operation}`, { kind: SpanKind.INTERNAL, attributes: { ...base, ...attributes } }, fn);
  } catch (error) {
    outcome = outcomeOf(error);
    throw error;
  } finally {
    const { operations, duration } = instruments();
    operations.add(1, { ...base, 'landflow.outcome': outcome });
    duration.record(performance.now() - started, base);
  }
}

export function recordPluginRestart(pluginId: string, reason: string) {
  instruments().restarts.add(1, { 'landflow.plugin.id': pluginId, 'landflow.marketplace.restart_reason': reason });
}
