/**
 * The choice of a transport per call (docs/transports.md, "Choosing a transport per call"). It replaces the registry's
 * `activeEndpoint()`: given a plugin's endpoints, its policy and the call's context it answers `{ endpoint, kind,
 * reason }`, and the reason goes on the `plugin.rpc` span as `landflow.transport.reason`.
 *
 * Today: `pinned` → the pinned kind; the allow-list filters; `only` when one kind is left; otherwise the direct
 * preference (gRPC, then HTTP, then a broker by its latency prior) as `auto.latency`. The Auto scoring (latency and
 * failure windows, spill-over, breaker, hysteresis) is a later wave: `SelectorInputs` is where its measurements plug
 * in, and every input is optional so the selector works without them.
 */
import type { ExecutionMode } from '@landflow/protocol';
import type { PluginStatus } from '../../shared/types';
import type { TransportCapabilities, TransportChoice, TransportKind, TransportPolicy, TransportReason } from '../../shared/transports';
import type { RpcMethod } from '../telemetry';
import { DIRECT_PREFERENCE } from './direct';

/** Why the call is made: editor runs, pickers and credential tests stay fast; production runs may spill over. */
export type RunMode = 'manual' | 'production' | 'mcp';

/** What the selector knows about the call it chooses for. */
export interface CallContext {
  method: RpcMethod;
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
 * selector falls back to the static preference. The Auto wave fills them from stats.ts (60 s windows) and the broker
 * drivers (depth, consumers, lag).
 */
export interface SelectorInputs {
  capabilities?: (kind: TransportKind) => TransportCapabilities | undefined;
  /** Moving-average latency for this endpoint, method and size bucket. */
  latencyMs?: (endpoint: string, context: CallContext) => number | undefined;
  /** Transport failures and timeouts (a node error in a normal reply doesn't count). */
  failures?: (endpoint: string) => { consecutive: number; recent: number; of: number } | undefined;
  /** Calls in flight against the plugin's `maxConcurrency`. */
  inflight?: (endpoint: string) => number | undefined;
  maxConcurrency?: (pluginId: string) => number | undefined;
  /** Brokers: depth or consumer lag, consumers and publish latency. */
  queue?: (endpoint: string) => { depth?: number; consumers?: number; lag?: number; publishMs?: number } | undefined;
  /** The endpoint's circuit breaker is open (rule 6). */
  breakerOpen?: (endpoint: string) => boolean;
}

export type Selection = TransportChoice | { error: string };

export const isChoice = (selection: Selection): selection is TransportChoice => 'endpoint' in selection;

/** The run mode of an execution: editor runs are `manual`, agent tool calls `mcp`, everything else `production`. */
export function runModeOf(mode: ExecutionMode | undefined): RunMode {
  if (mode === 'manual') return 'manual';
  if (mode === 'mcp') return 'mcp';
  return 'production';
}

const LATENCY_PRIOR: Record<TransportCapabilities['latency'], number> = { low: 0, medium: 1, high: 2 };

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

/**
 * Expected time to finish the call over this candidate: today the static rank. The Auto wave replaces the body with
 * base latency + a queueing estimate (direct: a penalty near the concurrency limit; broker: depth ÷ consumers × service
 * time) + an error penalty, and the rules on spill-over, breaker and hysteresis around `select()`.
 */
export function score(candidate: Candidate, _context: CallContext, inputs: SelectorInputs): number {
  return staticRank(candidate.kind, inputs);
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

  // Only one kind left: no choice to make.
  const kinds = new Set(fit.map((c) => c.kind));
  if (kinds.size === 1) return choice(fit[0]!, skippedForSize ? 'auto.size' : 'only');

  // TODO(wave Auto): breaker (auto.breaker), spill-over (auto.spillover) and failover (auto.failover) around the score.
  let best = fit[0]!;
  let bestScore = score(best, context, inputs);
  for (const candidate of fit.slice(1)) {
    const s = score(candidate, context, inputs);
    if (s < bestScore) {
      best = candidate;
      bestScore = s;
    }
  }
  return choice(best, skippedForSize ? 'auto.size' : 'auto.latency');
}

const choice = (candidate: Candidate, reason: TransportReason): TransportChoice => ({ endpoint: candidate.endpoint, kind: candidate.kind, reason });
