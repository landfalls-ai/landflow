/**
 * Counters of what the HTTP layer turned away: `landflow.http.denied{reason}` (the guard's refusals) and
 * `landflow.ratelimit.refused{bucket}` (429s). Created on the host meter, again when the meter provider changes.
 */
import type { Counter, Meter } from '@opentelemetry/api';
import { hostMetrics } from '../telemetry/metrics';

let cached: { meter: Meter; denied: Counter; refused: Counter } | undefined;

function counters() {
  const { meter } = hostMetrics();
  if (cached?.meter !== meter) {
    cached = {
      meter,
      denied: meter.createCounter('landflow.http.denied', { description: 'Requests the auth guard refused, by reason' }),
      refused: meter.createCounter('landflow.ratelimit.refused', { description: 'Requests refused with 429 by an API rate limit, by bucket (api, public)' }),
    };
  }
  return cached;
}

export const countDenied = (reason: string) => counters().denied.add(1, { reason });
export const countRateLimitRefused = (bucket: string) => counters().refused.add(1, { bucket });
