/**
 * The choice of a transport per call (docs/transports.md, "Choosing a transport per call"). It replaces the registry's
 * `activeEndpoint()`: given a plugin's endpoints, its policy and the call's context it answers `{ endpoint, kind,
 * reason }`, and the reason goes on the `plugin.rpc` span as `landflow.transport.reason`.
 *
 * `pinned` → the pinned kind; the allow-list filters; `only` when one kind is left. Otherwise Auto: every candidate
 * gets a score (the expected time to finish: base latency, a queueing estimate, an error penalty) and the rules apply
 * around it: size and delivery skips (`auto.size`), interactive calls stay on the direct kinds, production bursts spill
 * over to a buffering broker (`auto.spillover`), open breakers and endpoints asked to wait after a `capacity` refusal
 * are left out (`auto.breaker`), and the main transport hysteresis settled on (auto.ts) wins over a slightly better
 * score. Every measurement in `SelectorInputs` is optional: without them the score is the latency prior of the kind,
 * which gives the static order gRPC, HTTP, then brokers by their prior.
 */
import type { ExecutionMode } from '@landflow/protocol';
import type { PluginStatus } from '../../shared/types';
import type { BreakerState, TransportCapabilities, TransportChoice, TransportKind, TransportObjective, TransportPolicy, TransportReason } from '../../shared/transports';
import { transportLabel } from '../../shared/transports';
import type { RpcMethod } from '../telemetry';
import { DIRECT_PREFERENCE } from './direct';

/** Why the call is made: editor runs, pickers and credential tests stay fast; production runs may spill over. */
export type RunMode = 'manual' | 'production' | 'mcp';

/** What the selector knows about the call it chooses for. */
export interface CallContext {
  /** `Health` is the probe: what the hysteresis windows rank kinds on (auto.ts). */
  method: RpcMethod | 'Health';
  mode?: RunMode;
  /** Items in the request (Execute). */
  items?: number;
  /** Serialized size of the request, when known: brokers with a smaller limit are skipped. */
  payloadBytes?: number;
  /** The call may be repeated (an idempotent node, or an idempotency key): at-least-once delivery is allowed. */
  idempotent?: boolean;
  executionId?: string;
}

/** One of a plugin's endpoints as the selector sees it. */
export interface Candidate {
  endpoint: string;
  kind: TransportKind;
  status: PluginStatus;
  /** The registry's last probe or manifest round trip. */
  latencyMs?: number;
}

/**
 * Measurements and capabilities the scoring reads, per endpoint or kind. Every field is optional: without them the
 * selector falls back to the static preference. auto.ts fills them from stats.ts (60 s windows), the breakers and
 * the broker clients (depth, consumers, lag).
 */
export interface SelectorInputs {
  capabilities?: (kind: TransportKind) => TransportCapabilities | undefined;
  /** Moving-average latency for this endpoint, method and size bucket. */
  latencyMs?: (endpoint: string, context: CallContext) => number | undefined;
  /** Transport failures and timeouts (a node error in a normal reply doesn't count). */
  failures?: (endpoint: string) => { consecutive: number; recent: number; of: number } | undefined;
  /** Calls in flight over this endpoint. */
  inflight?: (endpoint: string) => number | undefined;
  /** Calls in flight over the plugin's direct endpoints together (one process behind HTTP and gRPC). */
  inflightDirect?: (pluginId: string) => number | undefined;
  maxConcurrency?: (pluginId: string) => number | undefined;
  /** Brokers: depth or consumer lag, consumers, publish latency, and the announced instances' `maxConcurrency`. */
  queue?: (endpoint: string) => { depth?: number; consumers?: number; lag?: number; publishMs?: number; maxConcurrency?: number } | undefined;
  /** The endpoint's circuit breaker is open (rule 6). */
  breakerOpen?: (endpoint: string) => boolean;
  /** The breaker's state, when known (half-open lets a trial through). */
  breaker?: (endpoint: string) => BreakerState | undefined;
  /** The main transport hysteresis settled on for the plugin (rule 4); absent until the first window. */
  main?: (pluginId: string) => TransportKind | undefined;
  /** A remote `capacity` refusal asked to wait: no call to this endpoint before then (epoch ms). */
  retryAfterUntil?: (endpoint: string) => number | undefined;
  now?: () => number;
}

export type Selection = TransportChoice | { error: string };

export const isChoice = (selection: Selection): selection is TransportChoice => 'endpoint' in selection;

/** The run mode of an execution: editor runs are `manual`, agent tool calls `mcp`, everything else `production`. */
export function runModeOf(mode: ExecutionMode | undefined): RunMode {
  if (mode === 'manual') return 'manual';
  if (mode === 'mcp') return 'mcp';
  return 'production';
}

/** When nothing says otherwise, a plugin takes this many calls at once (the SDKs' default). */
export const DEFAULT_MAX_CONCURRENCY = 16;

/**
 * Rule 3: production calls fill the direct transport up to this share of `maxConcurrency` before spilling over.
 * `latency` keeps every direct slot for itself (spill only when the plugin is full), `throughput` hands bursts to the
 * broker earlier so the direct path stays responsive.
 */
export const SPILL_SHARE: Record<TransportObjective, number> = { balanced: 0.8, latency: 1, throughput: 0.6 };

/** The in-flight count from which production calls spill over, for a limit and an objective. */
export const spillThreshold = (limit: number, objective: TransportObjective = 'balanced') => Math.max(1, Math.floor(limit * SPILL_SHARE[objective]));

/** Latency priors in ms while an endpoint has no measurements: the direct kinds, then brokers by the driver's prior. */
export const PRIOR_MS: { direct: Record<string, number>; broker: Record<TransportCapabilities['latency'], number>; unknown: number } = {
  direct: { grpc: 4, http: 6 },
  broker: { low: 12, medium: 40, high: 150 },
  unknown: 200,
};

const LATENCY_PRIOR: Record<TransportCapabilities['latency'], number> = { low: 0, medium: 1, high: 2 };

export const isDirect = (kind: TransportKind) => DIRECT_PREFERENCE.includes(kind);

/** Interactive calls (rule 2): editor and agent runs, pickers, credential tests, the webhook handshakes and hand-offs with a caller waiting. */
export function isInteractive(context: CallContext): boolean {
  if (context.mode === 'manual' || context.mode === 'mcp') return true;
  return context.method !== 'Execute';
}

/**
 * The static preference while there are no measurements: the direct kinds in their order (gRPC first: binary,
 * multiplexed), then brokers by their latency prior (NATS before Kafka), unknown kinds last. Lower is better.
 */
export function staticRank(kind: TransportKind, inputs: SelectorInputs): number {
  const direct = DIRECT_PREFERENCE.indexOf(kind);
  if (direct >= 0) return direct;
  const prior = inputs.capabilities?.(kind)?.latency;
  return DIRECT_PREFERENCE.length + (prior ? LATENCY_PRIOR[prior] : 3);
}

/** The latency prior of a kind in ms. */
export function priorMs(kind: TransportKind, inputs: SelectorInputs): number {
  if (isDirect(kind)) return PRIOR_MS.direct[kind] ?? PRIOR_MS.direct.http!;
  const prior = inputs.capabilities?.(kind)?.latency;
  return prior ? PRIOR_MS.broker[prior] : PRIOR_MS.unknown;
}

export interface ScoreOptions {
  pluginId?: string;
  objective?: TransportObjective;
}

/** The parts of a score, for explanations and tests. */
export interface ScoreParts {
  baseMs: number;
  queueMs: number;
  errorMs: number;
  total: number;
}

/**
 * Expected time to finish the call over this candidate, in ms: the base latency (the window's moving average for the
 * method and size bucket, else the kind's prior), plus a queueing estimate (direct: a penalty that grows with the
 * plugin's utilisation and explodes past the limit; broker: depth ÷ consumers × service time, plus publish latency),
 * plus an error penalty (4 × the recent failure share, and every failure in a row, in units of the base latency).
 * The objective weighs the queueing part: `latency` doubles it, `throughput` halves it for buffering brokers.
 */
export function scoreParts(candidate: Candidate, context: CallContext, inputs: SelectorInputs, options: ScoreOptions = {}): ScoreParts {
  const baseMs = inputs.latencyMs?.(candidate.endpoint, context) ?? priorMs(candidate.kind, inputs);
  const objective = options.objective ?? 'balanced';
  const capabilities = inputs.capabilities?.(candidate.kind);
  let queueMs: number;
  if (isDirect(candidate.kind)) {
    const limit = (options.pluginId ? inputs.maxConcurrency?.(options.pluginId) : undefined) || DEFAULT_MAX_CONCURRENCY;
    const inflight = (options.pluginId ? inputs.inflightDirect?.(options.pluginId) : undefined) ?? inputs.inflight?.(candidate.endpoint) ?? 0;
    const utilisation = inflight / limit;
    // M/M/1-shaped: ×1 at 50 %, ×4 at 80 %, ×19 at 95 %; past the limit every extra call waits one service time in the plugin's queue.
    queueMs = utilisation < 1 ? baseMs * (Math.min(utilisation, 0.95) / (1 - Math.min(utilisation, 0.95))) : baseMs * 19 + baseMs * (inflight - limit + 1);
  } else {
    const queue = inputs.queue?.(candidate.endpoint);
    const waiting = queue?.lag ?? queue?.depth ?? 0;
    const consumers = Math.max(1, queue?.consumers ?? 1);
    queueMs = (waiting / consumers) * baseMs + (queue?.publishMs ?? 0);
    // What this host alone has in flight beyond what the announced instances take at once waits too.
    const inflight = inputs.inflight?.(candidate.endpoint) ?? 0;
    if (queue?.maxConcurrency && inflight > queue.maxConcurrency) queueMs += ((inflight - queue.maxConcurrency) / queue.maxConcurrency) * baseMs;
    if (objective === 'throughput' && capabilities?.buffering) queueMs *= 0.5;
  }
  if (objective === 'latency') queueMs *= 2;
  const failures = inputs.failures?.(candidate.endpoint);
  const share = failures && failures.of ? failures.recent / failures.of : 0;
  const errorMs = baseMs * 4 * share + baseMs * Math.min(failures?.consecutive ?? 0, 5);
  return { baseMs, queueMs, errorMs, total: baseMs + queueMs + errorMs };
}

export function score(candidate: Candidate, context: CallContext, inputs: SelectorInputs, options: ScoreOptions = {}): number {
  return scoreParts(candidate, context, inputs, options).total;
}

/** Candidates by score, best first (ties: the static rank). */
export function rank(candidates: Candidate[], context: CallContext, inputs: SelectorInputs, options: ScoreOptions = {}): Array<{ candidate: Candidate; score: number }> {
  return candidates
    .map((candidate) => ({ candidate, score: score(candidate, context, inputs, options) }))
    .sort((a, b) => a.score - b.score || staticRank(a.candidate.kind, inputs) - staticRank(b.candidate.kind, inputs));
}

/** Rule 2's order for interactive calls: the main direct kind, the other direct kinds, then brokers by latency prior (non-buffering first), then by score. */
function interactiveOrder(candidates: Candidate[], context: CallContext, inputs: SelectorInputs, options: ScoreOptions, main: TransportKind | undefined): Candidate[] {
  const tier = (c: Candidate) => {
    if (isDirect(c.kind)) return c.kind === main ? 0 : 1 + DIRECT_PREFERENCE.indexOf(c.kind);
    const capabilities = inputs.capabilities?.(c.kind);
    return 10 + (capabilities ? LATENCY_PRIOR[capabilities.latency] * 2 + (capabilities.buffering ? 1 : 0) : 7);
  };
  return rank(candidates, context, inputs, options)
    .map((r, index) => ({ ...r, index }))
    .sort((a, b) => tier(a.candidate) - tier(b.candidate) || a.index - b.index)
    .map((r) => r.candidate);
}

/** The transport for one call of `pluginId`, or why there is none. */
export function select(pluginId: string, candidates: Candidate[], policy: TransportPolicy, context: CallContext, inputs: SelectorInputs = {}): Selection {
  const online = candidates.filter((c) => c.status === 'online');
  if (!online.length) return { error: candidates.length ? `Plugin "${pluginId}" is offline — start it or check its endpoint` : `Plugin "${pluginId}" has no endpoint` };

  // The allow-list: everything else is out, whatever the mode.
  let allowed = online;
  if (policy.allowed?.length) {
    const kinds = new Set(policy.allowed);
    allowed = online.filter((c) => kinds.has(c.kind));
    if (!allowed.length) return { error: `Plugin "${pluginId}": none of its allowed transports (${policy.allowed.join(', ')}) is online` };
  }

  if (policy.mode === 'pinned' && policy.pinned) {
    const pinned = allowed.find((c) => c.kind === policy.pinned);
    return pinned ? choice(pinned, 'pinned') : { error: `Plugin "${pluginId}" is pinned to ${policy.pinned}, but no ${policy.pinned} endpoint is online` };
  }

  // Rule 1: skip what can't carry the call.
  let skippedForSize = false;
  let fit = allowed;
  if (context.payloadBytes !== undefined) {
    fit = allowed.filter((c) => {
      const max = inputs.capabilities?.(c.kind)?.maxMessageBytes;
      const fits = max === undefined || context.payloadBytes! <= max;
      if (!fits) skippedForSize = true;
      return fits;
    });
    if (!fit.length) return { error: `Plugin "${pluginId}": the call (${context.payloadBytes} bytes) is too large for every online transport` };
  }
  if (context.idempotent === false && inputs.capabilities) {
    // A call that must not repeat needs at-most-once; a transport that can only give at-least-once is out.
    const strict = fit.filter((c) => inputs.capabilities!(c.kind)?.delivery.includes('at-most-once') ?? true);
    if (strict.length) fit = strict;
  }

  const now = inputs.now?.() ?? Date.now();
  // Rule 6 and the capacity rule: an open breaker or a Retry-After keeps an endpoint out; half-open lets a trial through.
  const held = (c: Candidate) => {
    const state = inputs.breaker?.(c.endpoint) ?? (inputs.breakerOpen?.(c.endpoint) ? 'open' : 'closed');
    if (state === 'open') return `breaker open on ${c.endpoint}`;
    const until = inputs.retryAfterUntil?.(c.endpoint);
    if (until !== undefined && until > now) return `${transportLabel(c.kind)} asked to wait ${Math.ceil((until - now) / 1000)} s (capacity)`;
    return undefined;
  };
  const holds = new Map(fit.map((c) => [c.endpoint, held(c)] as const));
  const usable = fit.filter((c) => !holds.get(c.endpoint));

  // Only one kind left: no choice to make, beyond skipping a held endpoint when the kind has another.
  const kinds = new Set(fit.map((c) => c.kind));
  if (kinds.size === 1) return choice(usable[0] ?? fit[0]!, skippedForSize ? 'auto.size' : 'only');

  const plain: TransportReason = skippedForSize ? 'auto.size' : 'auto.latency';
  const options: ScoreOptions = { pluginId, objective: policy.objective };
  const main = inputs.main?.(pluginId);
  // Everything held: the least bad one goes, and the reason says why (a half-open breaker lets it through).
  if (!usable.length) {
    const best = rank(fit, context, inputs, options)[0]!.candidate;
    return choice(best, 'auto.breaker', holds.get(best.endpoint));
  }
  /** The reason when the plain winner was held back: what kept it out. */
  const heldReason = (preferred: Candidate | undefined, picked: Candidate): Selection => {
    const hold = preferred && preferred.endpoint !== picked.endpoint ? holds.get(preferred.endpoint) : undefined;
    return hold ? choice(picked, 'auto.breaker', hold) : choice(picked, plain);
  };

  // Rule 2: interactive calls stay on the direct kinds, then a low-latency broker.
  if (isInteractive(context)) {
    const order = interactiveOrder(fit, context, inputs, options, main);
    return heldReason(order[0], interactiveOrder(usable, context, inputs, options, main)[0]!);
  }

  // Rule 3: production calls fill the direct transport up to the objective's share of `maxConcurrency`; the rest spill over to a
  // buffering broker. Below the threshold the direct kinds come first (a broker is for bursts and failures, not a faster path).
  const direct = usable.filter((c) => isDirect(c.kind));
  const buffering = usable.filter((c) => !isDirect(c.kind) && inputs.capabilities?.(c.kind)?.buffering);
  if (direct.length) {
    const limit = inputs.maxConcurrency?.(pluginId) || DEFAULT_MAX_CONCURRENCY;
    const inflight = inputs.inflightDirect?.(pluginId) ?? 0;
    const directKind = direct.find((c) => c.kind === main)?.kind ?? rank(direct, context, inputs, options)[0]!.candidate.kind;
    if (buffering.length && inflight >= spillThreshold(limit, policy.objective)) {
      return choice(rank(buffering, context, inputs, options)[0]!.candidate, 'auto.spillover', `${transportLabel(directKind)} at ${inflight} of ${limit} calls`);
    }
    const preferredDirect = fit.find((c) => c.kind === main && isDirect(c.kind)) ?? rank(fit.filter((c) => isDirect(c.kind)), context, inputs, options)[0]!.candidate;
    return heldReason(preferredDirect, direct.find((c) => c.kind === directKind)!);
  }

  // Rule 4 (brokers only, or every direct kind held): the main transport keeps the call unless it is held; otherwise the best score.
  const preferred = fit.find((c) => c.kind === main) ?? rank(fit, context, inputs, options)[0]!.candidate;
  const picked = usable.find((c) => c.kind === main) ?? rank(usable, context, inputs, options)[0]!.candidate;
  return heldReason(preferred, picked);
}

const choice = (candidate: Candidate, reason: TransportReason, detail?: string): TransportChoice => ({ endpoint: candidate.endpoint, kind: candidate.kind, reason, ...(detail && { detail }) });
