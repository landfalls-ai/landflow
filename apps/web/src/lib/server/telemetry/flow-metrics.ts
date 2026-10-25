/**
 * Workflow-author metrics (the Record Metric node): `landflow.flow.<name>`
 * counters, histograms and gauges with a cardinality guard: attribute values
 * are cut to 100 characters and each metric keeps at most 1000 attribute sets;
 * further sets fold into one `otel.metric.overflow=true` series.
 */
import { metrics, type Attributes, type AttributeValue, type Counter, type Gauge, type Histogram, type MeterProvider } from '@opentelemetry/api';
import { singleton } from '../singleton';
import { HOST_SCOPE } from './metrics';
import { telemetryConfig } from './config';

export type FlowMetricType = 'counter' | 'histogram' | 'gauge';

export const FLOW_METRIC_PREFIX = 'landflow.flow.';
export const FLOW_METRIC_NAME = /^[a-z][a-z0-9_.]{0,100}$/;
export const MAX_ATTRIBUTE_SETS = 1000;
export const MAX_ATTRIBUTE_LENGTH = 100;
const OVERFLOW: Attributes = { 'otel.metric.overflow': true };

interface FlowMetric {
  type: FlowMetricType;
  instrument: Counter | Histogram | Gauge;
  sets: Set<string>;
}

const state = singleton('telemetry.flow-metrics', () => ({ provider: undefined as MeterProvider | undefined, metrics: new Map<string, FlowMetric>() }));

export class FlowMetricError extends Error {}

function instrumentFor(name: string, type: FlowMetricType, options: { unit?: string; description?: string }): FlowMetric {
  const provider = metrics.getMeterProvider();
  if (state.provider !== provider) {
    state.provider = provider;
    state.metrics.clear();
  }
  const fullName = FLOW_METRIC_PREFIX + name;
  const existing = state.metrics.get(fullName);
  if (existing) {
    if (existing.type !== type) throw new FlowMetricError(`Metric "${fullName}" is already recorded as a ${existing.type}`);
    return existing;
  }
  const meter = provider.getMeter(HOST_SCOPE, telemetryConfig.serviceVersion);
  const config = { ...(options.unit && { unit: options.unit }), description: options.description || `Recorded by Record Metric nodes` };
  const instrument =
    type === 'counter'
      ? meter.createCounter(fullName, config)
      : type === 'histogram'
        ? meter.createHistogram(fullName, config)
        : meter.createGauge(fullName, config);
  const created: FlowMetric = { type, instrument, sets: new Set() };
  state.metrics.set(fullName, created);
  return created;
}

function cleanValue(value: unknown): AttributeValue {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.slice(0, MAX_ATTRIBUTE_LENGTH);
}

/** Record one value. Throws FlowMetricError for an invalid name/value or a type clash. */
export function recordFlowMetric(
  name: string,
  type: FlowMetricType,
  value: number,
  attributes: Record<string, unknown>,
  options: { unit?: string; description?: string } = {},
) {
  if (!FLOW_METRIC_NAME.test(name))
    throw new FlowMetricError(`Invalid metric name "${name}": use lower case letters, digits, "_" and "." (start with a letter)`);
  if (!Number.isFinite(value)) throw new FlowMetricError(`Metric value must be a number`);
  if (type === 'counter' && value < 0) throw new FlowMetricError(`A counter can only go up (got ${value})`);
  const metric = instrumentFor(name, type, options);
  let clean: Attributes = Object.fromEntries(Object.entries(attributes).map(([key, entry]) => [key.slice(0, MAX_ATTRIBUTE_LENGTH), cleanValue(entry)]));
  const key = JSON.stringify(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b)));
  if (!metric.sets.has(key)) {
    if (metric.sets.size >= MAX_ATTRIBUTE_SETS) clean = OVERFLOW;
    else metric.sets.add(key);
  }
  if (metric.type === 'counter') (metric.instrument as Counter).add(value, clean);
  else if (metric.type === 'histogram') (metric.instrument as Histogram).record(value, clean);
  else (metric.instrument as Gauge).record(value, clean);
}
