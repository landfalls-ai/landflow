/**
 * Transport metrics (docs/transports.md "Explainability"): `landflow.transport.calls` (by plugin, kind, reason and
 * outcome), `landflow.transport.switches` (the main transport changed, by plugin, from and to) and the gauge
 * `landflow.transport.queue_depth` (a broker's waiting events, or the calls in flight on a direct kind, by plugin,
 * kind and endpoint). Built from the host meter like the assistant's instruments, re-created when the meter provider
 * changes.
 */
import type { Meter } from '@opentelemetry/api';
import { hostMetrics } from './metrics';

function create(meter: Meter) {
  return {
    calls: meter.createCounter('landflow.transport.calls', { description: 'Plugin calls by transport kind and the reason the selector chose it' }),
    switches: meter.createCounter('landflow.transport.switches', { description: 'Changes of a plugin’s main transport (hysteresis)' }),
  };
}

let cached: { meter: Meter; instruments: ReturnType<typeof create> } | undefined;

export function transportMetrics() {
  const { meter } = hostMetrics();
  if (cached?.meter !== meter) cached = { meter, instruments: create(meter) };
  return cached.instruments;
}

export function recordTransportCall(pluginId: string, kind: string, reason: string, outcome: string) {
  transportMetrics().calls.add(1, { 'landflow.plugin.id': pluginId, 'landflow.transport': kind, 'landflow.transport.reason': reason, 'landflow.outcome': outcome });
}

export function recordTransportSwitch(pluginId: string, from: string, to: string) {
  transportMetrics().switches.add(1, { 'landflow.plugin.id': pluginId, 'landflow.transport.from': from, 'landflow.transport.to': to });
}

export interface QueueDepthSample {
  pluginId: string;
  kind: string;
  endpoint: string;
  /** `broker`: events waiting (depth or lag); `inflight`: this host's calls in flight on the endpoint. */
  measure: 'broker' | 'inflight';
  value: number;
}

const observed = new WeakSet<object>();

/** `landflow.transport.queue_depth`, read from `sample()` at every collection. Registered once per meter provider. */
export function observeTransportQueues(sample: () => QueueDepthSample[]) {
  const { meter } = hostMetrics();
  if (observed.has(meter)) return;
  observed.add(meter);
  meter.createObservableGauge('landflow.transport.queue_depth', { description: 'Events waiting on a broker’s request channel, or calls in flight on a direct transport' }).addCallback((result) => {
    for (const s of sample()) result.observe(s.value, { 'landflow.plugin.id': s.pluginId, 'landflow.transport': s.kind, 'landflow.plugin.endpoint': s.endpoint, 'landflow.transport.measure': s.measure });
  });
}
