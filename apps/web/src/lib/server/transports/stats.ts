/**
 * Auto's measurements (docs/transports.md "Choosing a transport per call", inputs): per endpoint, over a 60 s window,
 * the latency of every call by method and size bucket, the transport failures and timeouts (a node error in a normal
 * reply doesn't count), and the calls in flight. The plugin's direct endpoints (HTTP, gRPC) reach one process, so
 * `inflightDirect(pluginId)` sums them against the plugin's `maxConcurrency`; a brokered endpoint's calls count on
 * their own.
 *
 * Pure bookkeeping with an injectable clock (the simulations in test/transports-auto.test.ts use a fake one); the
 * controller in auto.ts records into it and the selector reads it through `SelectorInputs`.
 */
import { DIRECT_PREFERENCE } from './direct';

export const WINDOW_MS = 60_000;
/** The last outcomes the breaker and the error penalty look at (rule 6: "more than half of the last 20"). */
export const OUTCOME_WINDOW = 20;
const MAX_SAMPLES = 2_000;

/** Request sizes bucketed for the latency windows: under 4 KiB, 64 KiB, 1 MiB, more. */
export type SizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl';

export function sizeBucket(bytes: number | undefined): SizeBucket {
  if (bytes === undefined || bytes < 4 * 1024) return 'xs';
  if (bytes < 64 * 1024) return 's';
  if (bytes < 1024 * 1024) return 'm';
  if (bytes < 8 * 1024 * 1024) return 'l';
  return 'xl';
}

/**
 * How a call ended, as the transport saw it. `remote` is a reply carrying an error: delivered, measured, not a failure.
 * `skipped` says nothing about the transport (a `capacity` refusal, a call its caller aborted): only the in-flight count moves.
 */
export type CallOutcome = 'ok' | 'remote' | 'failure' | 'timeout' | 'skipped';

interface Sample {
  at: number;
  ms: number;
  method: string;
  bucket: SizeBucket;
}

interface Outcome {
  at: number;
  failed: boolean;
  /** A Health probe: feeds the breaker, not the error rate or the call count. */
  probe?: boolean;
}

interface EndpointRecord {
  pluginId: string;
  kind: string;
  samples: Sample[];
  outcomes: Outcome[];
  consecutive: number;
  inflight: number;
  /** Calls started since the record was made (the Plugins page shows the window's). */
  lastAt?: number;
}

export interface FailureCounts {
  /** Failures in a row, reset by a success. */
  consecutive: number;
  /** Failures among the last `of` outcomes (at most OUTCOME_WINDOW). */
  recent: number;
  of: number;
}

export interface LatencyPercentiles {
  p50Ms: number;
  p95Ms: number;
  calls: number;
}

export const isDirectKind = (kind: string) => DIRECT_PREFERENCE.includes(kind);

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

export class TransportStats {
  private readonly records = new Map<string, EndpointRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  private record(endpoint: string, pluginId?: string, kind?: string): EndpointRecord {
    let record = this.records.get(endpoint);
    if (!record) {
      record = { pluginId: pluginId ?? '', kind: kind ?? '', samples: [], outcomes: [], consecutive: 0, inflight: 0 };
      this.records.set(endpoint, record);
    } else {
      if (pluginId) record.pluginId = pluginId;
      if (kind) record.kind = kind;
    }
    return record;
  }

  /** Drop what fell out of the window; the outcome ring keeps its last OUTCOME_WINDOW entries whatever their age. */
  private prune(record: EndpointRecord): void {
    const cutoff = this.now() - WINDOW_MS;
    if (record.samples.length && record.samples[0]!.at < cutoff) record.samples = record.samples.filter((s) => s.at >= cutoff);
    if (record.samples.length > MAX_SAMPLES) record.samples = record.samples.slice(-MAX_SAMPLES);
    if (record.outcomes.length > OUTCOME_WINDOW) record.outcomes = record.outcomes.slice(-OUTCOME_WINDOW);
  }

  /** A call left for the endpoint. */
  begin(pluginId: string, endpoint: string, kind: string): void {
    const record = this.record(endpoint, pluginId, kind);
    record.inflight++;
    record.lastAt = this.now();
  }

  /**
   * A call came back. `ms` is recorded as a latency sample for `ok` and `remote` outcomes (a failed or timed-out call
   * says nothing about how long the transport takes); failures and timeouts count against the endpoint.
   */
  end(endpoint: string, call: { method: string; bucket?: SizeBucket; ms: number; outcome: CallOutcome; inflight?: boolean }): void {
    const record = this.record(endpoint);
    if (call.inflight !== false) record.inflight = Math.max(0, record.inflight - 1);
    if (call.outcome === 'skipped') return;
    const at = this.now();
    const failed = call.outcome === 'failure' || call.outcome === 'timeout';
    if (!failed) record.samples.push({ at, ms: call.ms, method: call.method, bucket: call.bucket ?? 'xs' });
    record.outcomes.push({ at, failed, ...(call.method === 'Health' && { probe: true }) });
    record.consecutive = failed ? record.consecutive + 1 : 0;
    this.prune(record);
  }

  /** A probe (`Health`) never counts as in flight; its latency is a sample of last resort. */
  probe(pluginId: string, endpoint: string, kind: string, ms: number, ok: boolean): void {
    this.record(endpoint, pluginId, kind);
    this.end(endpoint, { method: 'Health', ms, outcome: ok ? 'ok' : 'failure', inflight: false });
  }

  /** A failed call that never counted as in flight (nothing was sent): only the outcome is recorded. */
  fail(pluginId: string, endpoint: string, kind: string): void {
    this.record(endpoint, pluginId, kind);
    this.end(endpoint, { method: 'none', ms: 0, outcome: 'failure', inflight: false });
  }

  /** Forget an endpoint (it left the registry). */
  forget(endpoint: string): void {
    this.records.delete(endpoint);
  }

  /**
   * The moving-average latency of the endpoint: this method and size bucket, then this method, then any call, then
   * probes. Asked for `Health`, the probes come first: the same ping on every transport is what the hysteresis compares.
   */
  latencyMs(endpoint: string, method?: string, bucket?: SizeBucket): number | undefined {
    const record = this.records.get(endpoint);
    if (!record) return undefined;
    this.prune(record);
    const calls = record.samples.filter((s) => s.method !== 'Health');
    const probes = record.samples.filter((s) => s.method === 'Health');
    const tiers = method === 'Health' ? [probes, calls] : [
      method && bucket ? calls.filter((s) => s.method === method && s.bucket === bucket) : [],
      method ? calls.filter((s) => s.method === method) : [],
      calls,
      probes,
    ];
    const found = tiers.find((tier) => tier.length);
    return found ? mean(found.map((s) => s.ms)) : undefined;
  }

  private windowed(endpoints: string | string[]): EndpointRecord[] {
    const list = (Array.isArray(endpoints) ? endpoints : [endpoints]).map((e) => this.records.get(e)).filter((r): r is EndpointRecord => Boolean(r));
    for (const record of list) this.prune(record);
    return list;
  }

  /** p50/p95 of the window's calls over one endpoint or a kind's endpoints (probes only when there is no call), for the Plugins page. */
  percentiles(endpoints: string | string[]): LatencyPercentiles | undefined {
    const records = this.windowed(endpoints);
    const calls = records.flatMap((r) => r.samples.filter((s) => s.method !== 'Health'));
    const pool = (calls.length ? calls : records.flatMap((r) => r.samples)).map((s) => s.ms).sort((a, b) => a - b);
    if (!pool.length) return undefined;
    const at = (q: number) => pool[Math.min(pool.length - 1, Math.floor(q * pool.length))]!;
    return { p50Ms: at(0.5), p95Ms: at(0.95), calls: calls.length };
  }

  failures(endpoint: string): FailureCounts | undefined {
    const record = this.records.get(endpoint);
    if (!record) return undefined;
    this.prune(record);
    const recent = record.outcomes.filter((o) => o.failed).length;
    return { consecutive: record.consecutive, recent, of: record.outcomes.length };
  }

  /** Failures and timeouts over the window's outcomes (not the last-20 ring), 0..1; undefined without calls. */
  errorRate(endpoints: string | string[]): number | undefined {
    const cutoff = this.now() - WINDOW_MS;
    const outcomes = this.windowed(endpoints).flatMap((r) => r.outcomes.filter((o) => o.at >= cutoff && !o.probe));
    return outcomes.length ? outcomes.filter((o) => o.failed).length / outcomes.length : undefined;
  }

  /** Calls of the window (completed, any outcome but probes) over one endpoint or several. */
  calls(endpoints: string | string[]): number {
    const cutoff = this.now() - WINDOW_MS;
    return this.windowed(endpoints).reduce((n, r) => n + r.outcomes.filter((o) => o.at >= cutoff && o.failed && !o.probe).length + r.samples.filter((s) => s.at >= cutoff && s.method !== 'Health').length, 0);
  }

  inflight(endpoint: string): number {
    return this.records.get(endpoint)?.inflight ?? 0;
  }

  /** Calls in flight over the plugin's direct endpoints: one process answers HTTP and gRPC, so they share its `maxConcurrency`. */
  inflightDirect(pluginId: string): number {
    let total = 0;
    for (const record of this.records.values()) if (record.pluginId === pluginId && isDirectKind(record.kind)) total += record.inflight;
    return total;
  }

  /** Every endpoint with a record, for the queue-depth gauge. */
  endpoints(): Array<{ endpoint: string; pluginId: string; kind: string; inflight: number }> {
    return [...this.records.entries()].map(([endpoint, r]) => ({ endpoint, pluginId: r.pluginId, kind: r.kind, inflight: r.inflight }));
  }
}
