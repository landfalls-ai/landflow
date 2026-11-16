"use client";
/**
 * The run's Spend section on the client (wave 12, SP06): `useRunSpend` reads `GET /api/executions/:id/spend` (again every
 * 10 seconds while the run is live) and the pure helpers turn a `RunSpend` into the rows, the cache sentence, the
 * composition bar and the call rows the Spend tab draws. Numbers and names only; the answer holds no prompt text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { CALL_PURPOSE_LABELS } from "../shared/ai-call";
import {
  PROMPT_PART_LABELS,
  type CountMethod,
  type PromptPart,
} from "../shared/ai-call-parts";
import { formatCost, formatTokens } from "../shared/ai-usage";
import type { RunModel } from "../shared/run-trace-model";
import {
  type CacheLine,
  type RunSpend,
  type SpendCall,
  type SpendComposition,
  type SpendSlice,
  type SpendTotals,
} from "../shared/run-spend";

export const SPEND_REFRESH_MS = 10_000;

export interface RunSpendState {
  spend?: RunSpend;
  loading: boolean;
  error?: string;
}

/** Whether the run's spend must be read once more: the run was live and is not any more (the last calls land after the last poll). */
export const readsAtEnd = (wasLive: boolean, live: boolean): boolean =>
  wasLive && !live;

/** The run's spend, kept current while the run is live. `retry` reads again (after a failed read). */
export function useRunSpend(
  executionId: string | undefined,
  live = false,
): RunSpendState & { retry: () => void } {
  const [state, setState] = useState<RunSpendState>({
    loading: Boolean(executionId),
  });
  const wasLive = useRef(false);
  /** Bumped by every new run (and its cleanup); an answer of an older read is ignored. */
  const generation = useRef(0);
  const read = useCallback(async () => {
    if (!executionId) return;
    const mine = generation.current;
    try {
      const spend = await api<RunSpend>(
        `/api/executions/${executionId}/spend`,
        { background: true },
      );
      if (mine === generation.current) setState({ spend, loading: false });
    } catch (e) {
      if (mine === generation.current)
        setState((s) => ({
          ...s,
          loading: false,
          error: (e as Error).message,
        }));
    }
  }, [executionId]);
  useEffect(() => {
    generation.current += 1;
    setState({ loading: Boolean(executionId) });
    void read();
    return () => {
      generation.current += 1;
    };
  }, [executionId, read]);
  useEffect(() => {
    if (readsAtEnd(wasLive.current, live)) void read();
    wasLive.current = live;
  }, [live, read]);
  useEffect(() => {
    if (!executionId || !live) return;
    const timer = setInterval(() => void read(), SPEND_REFRESH_MS);
    return () => clearInterval(timer);
  }, [executionId, live, read]);
  const retry = useCallback(() => {
    setState((s) => ({ ...s, loading: !s.spend, error: undefined }));
    void read();
  }, [read]);
  return { ...state, retry };
}

export type SpendBy = "purpose" | "model" | "node" | "agent" | "step";
export const SPEND_BY_LABELS: Record<SpendBy, string> = {
  purpose: "Purpose",
  model: "Model",
  node: "Node",
  agent: "Agent",
  step: "Step",
};

export interface SpendRow {
  key: string;
  label: string;
  calls: number;
  /** "12.3k in · 1,450 out" */
  tokens: string;
  cached: string;
  cost: string;
  /** Percent of the run's cost (of its tokens when nothing cost anything), whole numbers. */
  share: number;
  unpriced: boolean;
}

const slicesOf = (spend: RunSpend, by: SpendBy): SpendSlice[] =>
  by === "purpose"
    ? spend.byPurpose
    : by === "model"
      ? spend.byModel
      : by === "node"
        ? spend.byNode
        : by === "agent"
          ? spend.byAgent
          : spend.byIteration;

/** What an unpriced row shows where a cost would be. */
export const UNPRICED = "No price";

export const costOf = (
  t: Pick<SpendTotals, "cost" | "calls" | "unpricedCalls">,
): string =>
  t.calls > 0 && t.unpricedCalls === t.calls ? UNPRICED : formatCost(t.cost);

/** One row per slice of the chosen breakdown, as the table shows it. A step's label is "Step 2". */
export function spendRows(spend: RunSpend, by: SpendBy): SpendRow[] {
  const slices = slicesOf(spend, by);
  const ordered =
    by === "step"
      ? [...slices].sort((a, b) => Number(a.key) - Number(b.key))
      : slices;
  return ordered.map((s) => ({
    key: s.key,
    label: by === "step" ? `Step ${s.key}` : s.label,
    calls: s.calls,
    tokens: `${formatTokens(s.inputTokens)} in · ${formatTokens(s.outputTokens)} out`,
    cached: s.cacheReadTokens ? formatTokens(s.cacheReadTokens) : "",
    cost: costOf(s),
    share: Math.round(s.share * 100),
    unpriced: s.calls > 0 && s.unpricedCalls === s.calls,
  }));
}

export const MISS_REASON_WORDS: Record<
  CacheLine["missReasons"][number],
  string
> = {
  "instructions-changed": "the instructions changed",
  "tools-changed": "the tools changed",
  "below-minimum": "the prompt may be under the provider’s minimum for caching",
  expired: "the cache expired (more than 5 minutes apart)",
  "not-requested": "the model asked for no cache",
  unknown: "the reason is not known",
};

/** "53% of the prompt came from the cache · saved $0.04 · 0 misses", or why there is nothing to say. */
export function cacheSentence(cache: CacheLine): {
  line: string;
  reasons: string[];
} {
  if (cache.hitRate === undefined)
    return { line: "No call of this run reported cache numbers.", reasons: [] };
  const pct = Math.round(cache.hitRate * 100);
  const saved =
    cache.savedUsd > 0 ? ` · saved ${formatCost(cache.savedUsd)}` : "";
  const misses = ` · ${cache.missCalls} ${cache.missCalls === 1 ? "miss" : "misses"}`;
  const counts = new Map<CacheLine["missReasons"][number], number>();
  for (const r of cache.missReasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  const reasons = [...counts].map(([r, n]) =>
    n > 1 ? `${MISS_REASON_WORDS[r]} (${n} calls)` : MISS_REASON_WORDS[r],
  );
  return {
    line: `${pct}% of the prompt came from the cache${saved}${misses}`,
    reasons,
  };
}

export const COUNT_METHOD_LABELS: Record<CountMethod, string> = {
  provider: "Counted exactly",
  tokenizer: "Counted by the model’s tokenizer",
  estimate: "Estimated",
};

export interface CompositionBar {
  method: CountMethod;
  methodLabel: string;
  total: number;
  segments: Array<{
    part: PromptPart;
    label: string;
    tokens: number;
    tokensText: string;
    share: number;
  }>;
  /** Set when some calls have no split. */
  note?: string;
}

/** The prompt's parts as one stacked bar: largest first, shares of the parts' sum (0 to 1). */
export function compositionBars(
  composition: SpendComposition | undefined,
): CompositionBar | undefined {
  if (!composition) return undefined;
  const entries = (
    Object.entries(composition.parts) as Array<[PromptPart, number]>
  )
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, t]) => n + t, 0);
  const missing = composition.calls - composition.callsWithParts;
  return {
    method: composition.method,
    methodLabel: COUNT_METHOD_LABELS[composition.method],
    total,
    segments: entries.map(([part, tokens]) => ({
      part,
      label: PROMPT_PART_LABELS[part],
      tokens,
      tokensText: formatTokens(tokens),
      share: total ? tokens / total : 0,
    })),
    ...(missing > 0 && {
      note: `${composition.callsWithParts} of ${composition.calls} calls have a split. No split: the call was built outside Landflow.`,
    }),
  };
}

export interface SpendCallRow {
  usageId: string;
  at: string;
  purpose: string;
  model: string;
  tokens: string;
  cost: string;
  spanId?: string;
}

export function callRows(
  calls: SpendCall[],
  model?: Pick<RunModel, "spans">,
): SpendCallRow[] {
  return calls.map((c) => {
    const spanId = model ? matchCallToSpan(c, model) : undefined;
    return {
      usageId: c.usageId,
      at: c.at,
      purpose: c.purpose ? CALL_PURPOSE_LABELS[c.purpose] : "Not set",
      model: c.model,
      tokens: `${formatTokens(c.inputTokens)} in · ${formatTokens(c.outputTokens)} out`,
      cost: c.priced ? formatCost(c.cost) : UNPRICED,
      ...(spanId && { spanId }),
    };
  });
}

/** The run's headline tiles. */
export function totalTiles(
  t: SpendTotals,
): Array<[label: string, value: string]> {
  const tiles: Array<[string, string]> = [
    [
      "Cost",
      t.calls > 0 && t.unpricedCalls === t.calls
        ? UNPRICED
        : formatCost(t.cost),
    ],
    ["Tokens in", formatTokens(t.inputTokens)],
    ["Tokens out", formatTokens(t.outputTokens)],
    ["Cached", formatTokens(t.cacheReadTokens)],
    ["Calls", String(t.calls)],
  ];
  return tiles;
}

/**
 * The journal model span of a priced call (the inverse of `matchSpanToCall`): the call's `spanId` is the OpenTelemetry
 * id, the Run Trace's spans have journal ids. Same model name, `at` within [startedAt - 1 s, endedAt + 2 s], the same
 * agent when the span's actor or caller is one, the nearest to the span's end on a tie (a call is recorded when it ends).
 */
export function matchCallToSpan(
  call: Pick<SpendCall, "at" | "model" | "agentId">,
  model: Pick<RunModel, "spans">,
): string | undefined {
  const at = Date.parse(call.at);
  if (Number.isNaN(at)) return undefined;
  let best: { id: string; gap: number } | undefined;
  for (const span of Object.values(model.spans)) {
    if (span.kind !== "model" || span.name !== call.model) continue;
    const start = Date.parse(span.startedAt);
    const end = span.endedAt ? Date.parse(span.endedAt) : start;
    if (Number.isNaN(start) || at < start - 1000 || at > end + 2000) continue;
    const agent = [span.actor, span.caller].find((a) =>
      a?.id.startsWith("agent:"),
    );
    if (agent && call.agentId && agent.id !== `agent:${call.agentId}`) continue;
    const gap = Math.abs(at - end);
    if (!best || gap < best.gap) best = { id: span.id, gap };
  }
  return best?.id;
}
