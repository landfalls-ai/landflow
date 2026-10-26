/**
 * Auto, the controller behind the selector (docs/transports.md "Choosing a transport per call", phase 5). It owns
 * the measurements (stats.ts), one circuit breaker per endpoint (breaker.ts), the Retry-After holds that remote
 * `capacity` refusals leave behind, the main-transport hysteresis (rule 4: switch only when another kind is ≥ 20 %
 * better for three 10 s windows in a row, then stay ≥ 60 s), the health probes (rule 5: every 15 s per endpoint,
 * `Execute` is never a probe) and the explainability: the feed events on the Plugins page, the
 * `landflow.transport.*` metrics and the numbers the plugin card shows.
 *
 * The registry wraps every call in `run()`, which records the outcome and classifies errors (`classifyError`): a
 * transport failure or a timeout counts against the endpoint and its breaker, a node error in a normal reply doesn't,
 * a provably undelivered call or a `capacity` refusal may move once (the registry does the moving). Everything is
 * driven by an injectable clock so the simulations in test/transports-auto.test.ts run on a fake one; in the host the
 * singleton ticks every 5 s and is started from `registry.start()`.
 */
import { isMessagingError, RemoteError, TimeoutError as MessagingTimeoutError, UndeliverableError } from '@landflow/transports';
import type { PluginStatus, RegistryEvent } from '../../shared/types';
import { transportLabel, type BreakerState, type TransportAutoSummary, type TransportChoice, type TransportKind, type TransportPolicy } from '../../shared/transports';
import { bus } from '../bus';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { observeTransportQueues, recordTransportCall, recordTransportSwitch, type QueueDepthSample } from '../telemetry/transport-metrics';
import { CircuitBreaker } from './breaker';
import { transportPolicies } from './policy-store';
import { bestDirect, clearlyBetter, DEFAULT_MAX_CONCURRENCY, isDirect, isInteractive, rank, type CallContext, type Candidate, type SelectorInputs } from './selector';
import { sizeBucket, TransportStats, type CallOutcome } from './stats';

/** The constants of the rules, in one place (tests read them). */
export const AUTO = {
  /**
   * Rule 4: a 10 s window, three in a row, ≥ 20 % better (score ≤ 0.8 × the main's) and at least 2 ms better, then hold
   * 60 s. The floor keeps near-equal kinds (gRPC and HTTP to one process, a few ms each) from trading places on noise.
   */
  WINDOW_MS: 10_000,
  WINDOWS: 3,
  BETTER: 0.8,
  MIN_GAIN_MS: 2,
  HOLD_MS: 60_000,
  /** Rule 5: a Health ping every 15 s per endpoint, 2 s to answer. */
  PROBE_MS: 15_000,
  PROBE_TIMEOUT_MS: 2_000,
  /** Spill-over is "over" when no production call spilled for this long; one feed line per endpoint and change per gap. */
  SPILL_HOLD_MS: 10_000,
  EVENT_GAP_MS: 10_000,
  /** A `capacity` refusal without Retry-After holds the endpoint this long (the SDKs send `Retry-After: 1`). */
  DEFAULT_RETRY_AFTER_MS: 1_000,
  TICK_MS: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Error classification (rules 7 and the capacity rule)
// ---------------------------------------------------------------------------

export type VerdictKind =
  /** Provably not delivered: connection refused, DNS, gRPC UNAVAILABLE before sending, a broker that reported it unroutable. */
  | 'undelivered'
  /** The plugin refused the call for lack of room (HTTP 429, gRPC RESOURCE_EXHAUSTED, `lferror: capacity`): it didn't run. */
  | 'capacity'
  | 'timeout'
  /** A transport failure after the call may have gone out: counts against the endpoint, never moved. */
  | 'failure'
  /** The plugin answered with an error: delivered, not a transport matter. */
  | 'remote'
  /** The caller gave up before anything went out. */
  | 'aborted';

export interface Verdict {
  kind: VerdictKind;
  /** The call may go to another transport once (rule 7, and a `capacity` refusal). */
  movable: boolean;
  /** `capacity`: how long the endpoint asked to wait. */
  retryAfterMs?: number;
}

const GRPC = { DEADLINE_EXCEEDED: 4, RESOURCE_EXHAUSTED: 8, UNAVAILABLE: 14 } as const;
const NOT_CONNECTED = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|No connection established|Name resolution failed|UND_ERR_CONNECT_TIMEOUT/i;

/** Seconds or an HTTP date in a Retry-After value, as ms from now. */
export function parseRetryAfter(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(value));
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** What an error from a plugin client says about the call. */
export function classifyError(error: unknown): Verdict {
  const e = (error ?? {}) as { name?: string; code?: unknown; message?: string; status?: unknown; retryAfterMs?: unknown; details?: string; cause?: { code?: string }; metadata?: { get?: (key: string) => unknown[] } };
  if (error instanceof UndeliverableError) return error.reason === 'aborted' ? { kind: 'aborted', movable: false } : { kind: 'undelivered', movable: true };
  if (error instanceof MessagingTimeoutError) return { kind: 'timeout', movable: false };
  if (error instanceof RemoteError) {
    if (error.remoteCode === 'capacity') {
      const details = error.details as { retryAfterMs?: number; retryAfter?: number } | undefined;
      return { kind: 'capacity', movable: true, retryAfterMs: details?.retryAfterMs ?? (details?.retryAfter !== undefined ? details.retryAfter * 1000 : undefined) };
    }
    return { kind: 'remote', movable: false };
  }
  if (isMessagingError(error)) return { kind: 'failure', movable: false };
  if (e.name === 'AbortError' || e.message === 'Execution canceled') return { kind: 'aborted', movable: false };
  if (e.name === 'TimeoutError' || e.code === GRPC.DEADLINE_EXCEEDED) return { kind: 'timeout', movable: false };
  if (e.code === GRPC.RESOURCE_EXHAUSTED) {
    const header = e.metadata?.get?.('retry-after')?.[0];
    return { kind: 'capacity', movable: true, retryAfterMs: parseRetryAfter(typeof header === 'string' ? header : undefined) };
  }
  if (e.code === GRPC.UNAVAILABLE) return NOT_CONNECTED.test(`${e.details ?? ''} ${e.message ?? ''}`) ? { kind: 'undelivered', movable: true } : { kind: 'failure', movable: false };
  if (typeof e.code === 'number') return { kind: 'remote', movable: false };
  if (e.status === 429) return { kind: 'capacity', movable: true, retryAfterMs: typeof e.retryAfterMs === 'number' ? e.retryAfterMs : undefined };
  if (typeof e.status === 'number') return { kind: 'remote', movable: false };
  if (e.cause?.code && NOT_CONNECTED.test(e.cause.code)) return { kind: 'undelivered', movable: true };
  if (e.message && NOT_CONNECTED.test(e.message)) return { kind: 'undelivered', movable: true };
  return { kind: 'failure', movable: false };
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/** An endpoint as the controller needs it from the registry (probes, hysteresis, the gauge). */
export interface AutoEndpoint {
  pluginId: string;
  pluginName: string;
  endpoint: string;
  kind: TransportKind;
  status: PluginStatus;
  latencyMs?: number;
  health(timeoutMs: number): Promise<unknown>;
}

export interface AutoSource {
  autoEndpoints(): AutoEndpoint[];
}

export interface AutoCall {
  pluginId: string;
  pluginName: string;
  choice: TransportChoice;
  context: CallContext;
}

export interface TransportAutoOptions {
  now?: () => number;
  /** Where the feed events go (default: the registry channel of the bus). */
  emit?: (event: RegistryEvent) => void;
  policyOf?: (pluginId: string) => TransportPolicy;
  /** The registry's inputs the controller completes: capabilities, queue numbers, `maxConcurrency`. */
  base?: SelectorInputs;
  /** Overrides for tests. */
  windowMs?: number;
  holdMs?: number;
  probeMs?: number;
}

interface PluginAutoState {
  main?: { kind: TransportKind; since: number };
  challenger?: { kind: TransportKind; windows: number; better: number };
  spilling?: { to: TransportKind; since: number; lastAt: number; from: TransportKind };
}

/**
 * What the hysteresis windows rank: the probe round trip (the same `Health` ping on every transport, rule 5), the
 * queueing estimate and the error penalty. Execute times are never compared across kinds: they depend on the node.
 */
const REFERENCE: CallContext = { method: 'Health', mode: 'production' };

export class TransportAuto {
  readonly stats: TransportStats;
  private readonly now: () => number;
  private readonly emitEvent: (event: RegistryEvent) => void;
  private readonly policyOf: (pluginId: string) => TransportPolicy;
  private base: SelectorInputs;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly retryAfter = new Map<string, number>();
  private readonly plugins = new Map<string, PluginAutoState>();
  private readonly lastProbe = new Map<string, number>();
  private readonly lastEvent = new Map<string, number>();
  private readonly windowMs: number;
  private readonly holdMs: number;
  private readonly probeMs: number;
  private lastWindowAt = 0;
  private source?: AutoSource;
  private timer?: NodeJS.Timeout;

  constructor(options: TransportAutoOptions = {}) {
    this.now = options.now ?? Date.now;
    this.stats = new TransportStats(this.now);
    this.emitEvent = options.emit ?? ((event) => bus.publish({ channel: 'registry', event }));
    this.policyOf = options.policyOf ?? ((pluginId) => transportPolicies.get(pluginId));
    this.base = options.base ?? {};
    this.windowMs = options.windowMs ?? AUTO.WINDOW_MS;
    this.holdMs = options.holdMs ?? AUTO.HOLD_MS;
    this.probeMs = options.probeMs ?? AUTO.PROBE_MS;
  }

  /** Start the periodic work (windows, probes, the queue-depth gauge) over the registry's endpoints. Idempotent. */
  start(source: AutoSource, base?: SelectorInputs): void {
    this.source = source;
    if (base) this.base = base;
    observeTransportQueues(() => this.queueSamples());
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), AUTO.TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // -------------------------------------------------------------------------
  // What the selector reads
  // -------------------------------------------------------------------------

  breakerOf(endpoint: string): CircuitBreaker {
    let breaker = this.breakers.get(endpoint);
    if (!breaker) {
      breaker = new CircuitBreaker(this.now);
      this.breakers.set(endpoint, breaker);
    }
    return breaker;
  }

  /** `true` while a `capacity` refusal's Retry-After holds the endpoint. */
  heldForCapacity(endpoint: string): boolean {
    const until = this.retryAfter.get(endpoint);
    return until !== undefined && until > this.now();
  }

  private limitOf(pluginId: string): number {
    return this.base.maxConcurrency?.(pluginId) || DEFAULT_MAX_CONCURRENCY;
  }

  /**
   * The plugin's direct calls in flight; while a direct endpoint of the plugin is held after a `capacity` refusal the
   * plugin is reported full, so production calls spill over until the hold lifts ("feed it into spill-over").
   */
  inflightDirect(pluginId: string): number {
    const real = this.stats.inflightDirect(pluginId);
    const held = this.stats.endpoints().some((e) => e.pluginId === pluginId && isDirect(e.kind) && this.heldForCapacity(e.endpoint));
    return held ? Math.max(real, this.limitOf(pluginId)) : real;
  }

  /** The selector's inputs: the registry's (`base`) completed with the measurements, breakers, holds and the main kind. */
  inputs(base: SelectorInputs = this.base): SelectorInputs {
    this.base = base;
    return {
      ...base,
      now: this.now,
      latencyMs: (endpoint, context) => this.stats.latencyMs(endpoint, context.method, sizeBucket(context.payloadBytes)),
      failures: (endpoint) => this.stats.failures(endpoint),
      inflight: (endpoint) => this.stats.inflight(endpoint),
      inflightDirect: (pluginId) => this.inflightDirect(pluginId),
      maxConcurrency: (pluginId) => this.limitOf(pluginId),
      breaker: (endpoint) => this.breakers.get(endpoint)?.state() ?? 'closed',
      breakerOpen: (endpoint) => this.breakers.get(endpoint)?.state() === 'open',
      main: (pluginId) => this.plugins.get(pluginId)?.main?.kind,
      retryAfterUntil: (endpoint) => this.retryAfter.get(endpoint),
    };
  }

  private state(pluginId: string): PluginAutoState {
    let state = this.plugins.get(pluginId);
    if (!state) {
      state = {};
      this.plugins.set(pluginId, state);
    }
    return state;
  }

  /** The main kind hysteresis settled on, for tests and the card. */
  mainOf(pluginId: string): TransportKind | undefined {
    return this.plugins.get(pluginId)?.main?.kind;
  }

  /** The plugin's policy changed: forget the main kind and any challenger, so the next window (and call) chooses afresh. */
  policyChanged(pluginId: string): void {
    const state = this.plugins.get(pluginId);
    if (!state) return;
    state.main = undefined;
    state.challenger = undefined;
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  /** `classifyError`, for callers that hold the controller. */
  classify(error: unknown): Verdict {
    return classifyError(error);
  }

  /** Run one call over the chosen transport, recording its outcome; errors pass through (classified by `classifyError`). */
  async run<T>(call: AutoCall, fn: () => Promise<T>): Promise<T> {
    const { endpoint, kind } = call.choice;
    this.observe(call);
    this.stats.begin(call.pluginId, endpoint, kind);
    const started = this.now();
    let verdict: Verdict | undefined;
    try {
      const result = await fn();
      this.finish(call, started, 'ok');
      return result;
    } catch (error) {
      verdict = classifyError(error);
      this.finish(call, started, verdict.kind === 'remote' ? 'remote' : verdict.kind === 'timeout' ? 'timeout' : verdict.kind === 'failure' || verdict.kind === 'undelivered' ? 'failure' : 'skipped', verdict);
      throw error;
    }
  }

  private finish(call: AutoCall, started: number, outcome: CallOutcome, verdict?: Verdict): void {
    const { endpoint, kind } = call.choice;
    const ms = this.now() - started;
    this.stats.end(endpoint, { method: call.context.method, bucket: sizeBucket(call.context.payloadBytes), ms, outcome });
    if (outcome === 'ok' || outcome === 'remote') this.breakerChanged(call.pluginId, call.pluginName, endpoint, kind, this.breakerOf(endpoint).record(true));
    else if (outcome === 'failure' || outcome === 'timeout') this.breakerChanged(call.pluginId, call.pluginName, endpoint, kind, this.breakerOf(endpoint).record(false));
    if (verdict?.kind === 'capacity') this.noteCapacity(call, verdict.retryAfterMs);
    recordTransportCall(call.pluginId, kind, call.choice.reason, verdict?.kind ?? 'ok');
  }

  /** A remote `capacity` refusal: hold the endpoint for its Retry-After, say so once per gap. */
  noteCapacity(call: Pick<AutoCall, 'pluginId' | 'pluginName' | 'choice'>, retryAfterMs?: number): void {
    const { endpoint, kind } = call.choice;
    const wait = retryAfterMs ?? AUTO.DEFAULT_RETRY_AFTER_MS;
    this.retryAfter.set(endpoint, this.now() + wait);
    this.emit(`capacity:${endpoint}`, {
      type: 'plugin.transport',
      pluginId: call.pluginId,
      endpoint,
      kind,
      change: 'capacity',
      message: `${call.pluginName}: ${transportLabel(kind)} refused a call (capacity, retry after ${Math.ceil(wait / 1000)} s) — moved once, spilling over meanwhile`,
    });
  }

  /** Spill-over transitions, from the choices made (rule 3's feed lines). */
  private observe(call: AutoCall): void {
    if (isInteractive(call.context)) return;
    const state = this.state(call.pluginId);
    const now = this.now();
    const { choice } = call;
    if (choice.reason === 'auto.spillover') {
      if (!state.spilling || state.spilling.to !== choice.kind) {
        const from = (choice.detail?.match(/^(\S+)/)?.[1] ?? state.main?.kind ?? 'direct') as TransportKind;
        state.spilling = { to: choice.kind, since: now, lastAt: now, from };
        const p95 = this.directPercentiles(call.pluginId)?.p95Ms;
        this.emit(`spillover:${call.pluginId}`, {
          type: 'plugin.transport',
          pluginId: call.pluginId,
          endpoint: choice.endpoint,
          kind: choice.kind,
          change: 'spillover',
          message: `${call.pluginName} now spills over to ${transportLabel(choice.kind)}: ${choice.detail ?? 'the direct transport is near its limit'}${p95 !== undefined ? `, p95 ${formatMs(p95)}` : ''}`,
        });
      } else state.spilling.lastAt = now;
    } else if (state.spilling && isDirect(choice.kind) && now - state.spilling.lastAt >= AUTO.SPILL_HOLD_MS) this.endSpill(call.pluginId, call.pluginName, choice.kind);
  }

  private endSpill(pluginId: string, pluginName: string, kind: TransportKind): void {
    const state = this.state(pluginId);
    if (!state.spilling) return;
    state.spilling = undefined;
    this.emit(`direct:${pluginId}`, { type: 'plugin.transport', pluginId, kind, change: 'direct', message: `${pluginName} back on ${transportLabel(kind)}` });
  }

  private directPercentiles(pluginId: string) {
    const direct = this.stats.endpoints().filter((e) => e.pluginId === pluginId && isDirect(e.kind)).map((e) => e.endpoint);
    return direct.length ? this.stats.percentiles(direct) : undefined;
  }

  private breakerChanged(pluginId: string, pluginName: string, endpoint: string, kind: TransportKind, change: 'opened' | 'closed' | undefined): void {
    if (!change) return;
    const breaker = this.breakerOf(endpoint);
    if (change === 'opened') {
      this.emit(`breaker:${endpoint}`, { type: 'plugin.transport', pluginId, endpoint, kind, change: 'breaker.open', message: `${pluginName}: breaker open on ${endpoint} (${breaker.cause ?? 'failures'}); half-open in ${AUTO.PROBE_MS / 1000} s` }, true);
    } else {
      const main = this.plugins.get(pluginId)?.main?.kind;
      this.emit(`breaker:${endpoint}`, { type: 'plugin.transport', pluginId, endpoint, kind, change: 'breaker.closed', message: `${pluginName}: breaker closed on ${endpoint}${main === kind ? `; back on ${transportLabel(kind)}` : ''}` }, true);
    }
  }

  // -------------------------------------------------------------------------
  // Periodic work
  // -------------------------------------------------------------------------

  /** One pass: a hysteresis window when 10 s went by, spill-over expiry, and the probes that are due. Returns when the probes answered. */
  async tick(): Promise<void> {
    const now = this.now();
    const endpoints = this.source?.autoEndpoints() ?? [];
    if (now - this.lastWindowAt >= this.windowMs) {
      this.lastWindowAt = now;
      this.window(endpoints, now);
    }
    for (const [pluginId, state] of this.plugins) {
      if (state.spilling && now - state.spilling.lastAt >= AUTO.SPILL_HOLD_MS) this.endSpill(pluginId, endpoints.find((e) => e.pluginId === pluginId)?.pluginName ?? pluginId, state.spilling.from);
    }
    await this.probeDue(endpoints, now);
  }

  /** Rule 4 for every plugin: one 10 s window. */
  private window(endpoints: AutoEndpoint[], now: number): void {
    const byPlugin = new Map<string, AutoEndpoint[]>();
    for (const e of endpoints) byPlugin.set(e.pluginId, [...(byPlugin.get(e.pluginId) ?? []), e]);
    const inputs = this.inputs();
    for (const [pluginId, list] of byPlugin) {
      const policy = this.policyOf(pluginId);
      if (policy.mode === 'pinned') continue;
      const candidates: Candidate[] = list
        .filter((e) => e.status === 'online' && (!policy.allowed?.length || policy.allowed.includes(e.kind)))
        .filter((e) => this.breakerOf(e.endpoint).state() !== 'open' && !this.heldForCapacity(e.endpoint))
        .map((e) => ({ endpoint: e.endpoint, kind: e.kind, status: e.status, ...(e.latencyMs !== undefined && { latencyMs: e.latencyMs }) }));
      if (!candidates.length) continue;
      // The main kind is a direct one while the plugin has any (brokers take bursts and failures); brokers compete only among themselves.
      const direct = candidates.filter((c) => isDirect(c.kind));
      const ranked = rank(direct.length ? direct : candidates, REFERENCE, inputs, { pluginId, objective: policy.objective });
      const best = ranked[0]!;
      const state = this.state(pluginId);
      if (!state.main) {
        // The first choice keeps the static order (gRPC, then HTTP) unless another kind is clearly better, as for a switch.
        state.main = { kind: (direct.length ? bestDirect(direct, REFERENCE, inputs, { pluginId, objective: policy.objective })! : best.candidate).kind, since: now };
        continue;
      }
      if (best.candidate.kind === state.main.kind) {
        state.challenger = undefined;
        continue;
      }
      const mainScore = ranked.find((r) => r.candidate.kind === state.main!.kind)?.score ?? Number.POSITIVE_INFINITY;
      if (clearlyBetter(best.score, mainScore, AUTO.BETTER, AUTO.MIN_GAIN_MS)) {
        const better = Number.isFinite(mainScore) ? 1 - best.score / mainScore : 1;
        state.challenger = state.challenger?.kind === best.candidate.kind ? { ...state.challenger, windows: state.challenger.windows + 1, better } : { kind: best.candidate.kind, windows: 1, better };
        if (state.challenger.windows >= AUTO.WINDOWS && now - state.main.since >= this.holdMs) {
          const from = state.main.kind;
          state.main = { kind: best.candidate.kind, since: now };
          state.challenger = undefined;
          recordTransportSwitch(pluginId, from, best.candidate.kind);
          const pluginName = list[0]!.pluginName;
          this.emit(`switch:${pluginId}`, {
            type: 'plugin.transport',
            pluginId,
            kind: best.candidate.kind,
            change: 'switch',
            message: `${pluginName} now prefers ${transportLabel(best.candidate.kind)} over ${transportLabel(from)}: ${Math.round(better * 100)} % faster for ${(AUTO.WINDOWS * this.windowMs) / 1000} s`,
          }, true);
        }
      } else state.challenger = undefined;
    }
  }

  /** Rule 5: the Health pings that are due. Their latency is a sample of last resort; their outcome feeds the breaker. */
  async probeDue(endpoints: AutoEndpoint[], now = this.now()): Promise<void> {
    const due = endpoints.filter((e) => e.status === 'online' && now - (this.lastProbe.get(e.endpoint) ?? 0) >= this.probeMs);
    await Promise.all(due.map((e) => this.probe(e)));
  }

  async probe(e: AutoEndpoint): Promise<boolean> {
    this.lastProbe.set(e.endpoint, this.now());
    const started = this.now();
    let ok = true;
    try {
      await e.health(AUTO.PROBE_TIMEOUT_MS);
    } catch {
      ok = false;
    }
    this.stats.probe(e.pluginId, e.endpoint, e.kind, this.now() - started, ok);
    this.breakerChanged(e.pluginId, e.pluginName, e.endpoint, e.kind, this.breakerOf(e.endpoint).record(ok));
    return ok;
  }

  /** The endpoint left the registry: its numbers go with it. */
  forget(endpoint: string): void {
    this.stats.forget(endpoint);
    this.breakers.delete(endpoint);
    this.retryAfter.delete(endpoint);
    this.lastProbe.delete(endpoint);
  }

  // -------------------------------------------------------------------------
  // Explainability
  // -------------------------------------------------------------------------

  private emit(key: string, event: RegistryEvent, always = false): void {
    const now = this.now();
    if (!always && now - (this.lastEvent.get(key) ?? Number.NEGATIVE_INFINITY) < AUTO.EVENT_GAP_MS) return;
    this.lastEvent.set(key, now);
    logger.info(`transport: ${event.message}`, { 'landflow.plugin.id': 'pluginId' in event ? event.pluginId : undefined });
    this.emitEvent(event);
  }

  /** The numbers of one endpoint for the Plugins page. */
  endpointSummary(pluginId: string, endpoint: string, kind: TransportKind): TransportAutoSummary {
    return this.summary(pluginId, kind, [endpoint]);
  }

  /** The numbers of one kind of a plugin: its endpoints together, the worst breaker, the plugin's limit for direct kinds. */
  summary(pluginId: string, kind: TransportKind, endpoints: string[]): TransportAutoSummary {
    const percentiles = this.stats.percentiles(endpoints);
    const errorRate = this.stats.errorRate(endpoints);
    const states = endpoints.map((e) => this.breakers.get(e)?.state() ?? 'closed');
    const breaker: BreakerState = states.includes('open') ? 'open' : states.includes('half-open') ? 'half-open' : 'closed';
    const until = endpoints.map((e) => this.retryAfter.get(e)).filter((u): u is number => u !== undefined && u > this.now()).sort().at(-1);
    const state = this.plugins.get(pluginId);
    const inflight = endpoints.reduce((n, e) => n + this.stats.inflight(e), 0);
    const limit = isDirect(kind) ? this.limitOf(pluginId) : this.base.queue?.(endpoints[0] ?? '')?.maxConcurrency;
    return {
      ...(percentiles && { p50Ms: round(percentiles.p50Ms), p95Ms: round(percentiles.p95Ms) }),
      inflight,
      ...(limit && { limit }),
      ...(errorRate !== undefined && { errorRate: Math.round(errorRate * 1000) / 1000 }),
      calls: this.stats.calls(endpoints),
      breaker,
      ...(until && { retryAfterUntil: new Date(until).toISOString() }),
      ...(state?.main?.kind === kind && { main: true }),
      ...(state?.spilling?.to === kind && { spilling: true }),
    };
  }

  /** The queue-depth gauge: brokers' waiting events, direct kinds' calls in flight. */
  queueSamples(): QueueDepthSample[] {
    const samples: QueueDepthSample[] = [];
    for (const e of this.source?.autoEndpoints() ?? []) {
      if (isDirect(e.kind)) samples.push({ pluginId: e.pluginId, kind: e.kind, endpoint: e.endpoint, measure: 'inflight', value: this.stats.inflight(e.endpoint) });
      else {
        const queue = this.base.queue?.(e.endpoint);
        const value = queue?.lag ?? queue?.depth;
        if (value !== undefined) samples.push({ pluginId: e.pluginId, kind: e.kind, endpoint: e.endpoint, measure: 'broker', value });
      }
    }
    return samples;
  }
}

const round = (ms: number) => (ms >= 100 ? Math.round(ms) : Math.round(ms * 10) / 10);
const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${round(ms)} ms`);

export const transportAuto = singleton('transport-auto', () => new TransportAuto());
