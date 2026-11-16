/**
 * The one rule that pairs a Run Trace model span with the ledger's call (`SpendCall`), used by the Spend tab (a call
 * row opens its span) and by the call sheet (a span shows its call), so both always agree. A call's `spanId` is an
 * OpenTelemetry id and the trace's spans have journal ids, so the two are paired by what they share:
 * - the model: the call's model is the span's `usage.model` or its name;
 * - the node, when both have one;
 * - the agent, when the span's actor or caller is a Landflow agent (`agent:<id>`) and the call has one;
 * - the time: the call's `at` is within `[startedAt - 1 s, endedAt + 2 s]` (a call is recorded when it ends). An open
 *   span (no `endedAt`) is treated as ending at its start, so a call recorded more than 2 s into a still-open span is
 *   not paired until the span ends.
 * It is one-to-one: a span pairs at most one call and a call at most one span. The nearest pair by `|at - end|` is
 * taken first (ties by span id, then call id), so back-to-back calls of one model each get their own span.
 */
import type { SpendCall } from '../shared/run-spend';

/** What the matcher reads of a Run Trace span (a `RunSpan` fits). */
export interface MatchSpan {
  id: string;
  kind?: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  caller?: { id: string };
  actor?: { id: string };
  usage?: { model?: string };
  nodeId?: string;
}

const BEFORE_MS = 1000;
const AFTER_MS = 2000;

/** The agent a span belongs to, when its actor or the one that asked is a Landflow agent (`agent:<id>`). */
const agentOf = (span: MatchSpan): string | undefined => {
  for (const id of [span.actor?.id, span.caller?.id]) if (id?.startsWith('agent:')) return id.slice('agent:'.length);
  return undefined;
};

/** The gap in ms between a call and a span's end when they can be the same call, else undefined. */
function gapOf(span: MatchSpan, call: SpendCall): number | undefined {
  const start = Date.parse(span.startedAt);
  const end = span.endedAt ? Date.parse(span.endedAt) : start;
  const at = Date.parse(call.at);
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(at)) return undefined;
  if (call.model !== (span.usage?.model ?? span.name) && call.model !== span.name) return undefined;
  const agent = agentOf(span);
  if (agent && call.agentId && call.agentId !== agent) return undefined;
  if (span.nodeId && call.nodeId && call.nodeId !== span.nodeId) return undefined;
  if (at < start - BEFORE_MS || at > end + AFTER_MS) return undefined;
  return Math.abs(at - end);
}

/** Every model span of `spans` paired with its call, one to one: span id → call. Spans of other kinds are skipped. */
export function matchSpansToCalls(spans: Iterable<MatchSpan>, calls: readonly SpendCall[]): Map<string, SpendCall> {
  const pairs: Array<{ span: string; call: SpendCall; gap: number }> = [];
  for (const span of spans) {
    if (span.kind !== undefined && span.kind !== 'model') continue;
    for (const call of calls) {
      const gap = gapOf(span, call);
      if (gap !== undefined) pairs.push({ span: span.id, call, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.span.localeCompare(b.span) || a.call.usageId.localeCompare(b.call.usageId));
  const bySpan = new Map<string, SpendCall>();
  const taken = new Set<string>();
  for (const { span, call } of pairs) {
    if (bySpan.has(span) || taken.has(call.usageId)) continue;
    bySpan.set(span, call);
    taken.add(call.usageId);
  }
  return bySpan;
}
