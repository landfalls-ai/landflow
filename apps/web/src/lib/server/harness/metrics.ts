/**
 * Counters of the hook ingest (docs/observability.md): `landflow.harness.events{harness,outcome}` for every event taken
 * (`applied`, `late`, `limited`, `refused`) and `landflow.harness.unknown_events{harness}` for an event name the registry entry
 * does not list (C15 FR-6). Labels are bounded: a registry id and a fixed outcome, never a session or a key. A tally is
 * kept in process too, so tests need no exporter.
 */
import type { Counter, Meter } from '@opentelemetry/api';
import { singleton } from '../singleton';
import { hostMetrics } from '../telemetry/metrics';

export type HarnessOutcome = 'applied' | 'late' | 'limited' | 'refused';

let cached: { meter: Meter; events: Counter; unknown: Counter } | undefined;
const tally = () => singleton('harness-metrics-tally', () => ({ events: new Map<string, number>(), unknown: new Map<string, number>() }));

function counters() {
  const { meter } = hostMetrics();
  if (cached?.meter !== meter) {
    cached = {
      meter,
      events: meter.createCounter('landflow.harness.events', { description: 'Harness hook events taken, by harness and outcome' }),
      unknown: meter.createCounter('landflow.harness.unknown_events', { description: 'Harness hook events whose name the registry entry does not list, by harness' }),
    };
  }
  return cached;
}

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

export function countHarnessEvent(harness: string, outcome: HarnessOutcome) {
  bump(tally().events, `${harness}:${outcome}`);
  try {
    counters().events.add(1, { harness, outcome });
  } catch {
    // Metrics never break the ingest.
  }
}

export function countUnknownEvent(harness: string) {
  bump(tally().unknown, harness);
  try {
    counters().unknown.add(1, { harness });
  } catch {
    // Metrics never break the ingest.
  }
}

/** What this process counted (tests). */
export const harnessTally = () => ({ events: Object.fromEntries(tally().events), unknown: Object.fromEntries(tally().unknown) });
