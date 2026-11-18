/** The eval gate of a standalone agent: test cases, a run of them, and the rule that decides whether a publish may go ahead. */

export const MAX_EVAL_CASES = 50;
/** A publish is held when the draft's average (1–5) falls this far below the published version's. */
export const GATE_MAX_DROP = 0.5;
/** …or when it is below this on its own. */
export const GATE_MIN_AVERAGE = 3;

export interface AgentEvalCase {
  id: string;
  /** What the person asks the agent. */
  input: string;
  /** The answer it should give; judged for correctness. Without one, the reply is judged for helpfulness. */
  expected?: string;
  createdAt: string;
}

export interface AgentEvalResult {
  caseId: string;
  input: string;
  expected?: string;
  reply: string;
  /** 1–5. A case that could not run scores 1 and carries `error`. */
  score: number;
  reasoning: string;
  error?: string;
}

export interface AgentEvalRun {
  id: string;
  agentId: string;
  /** The config that ran: the draft, or the published version it was saved against. */
  version: 'draft' | number;
  createdAt: string;
  average: number;
  judge: string;
  results: AgentEvalResult[];
}

export interface GateVerdict {
  /** The publish may go ahead. */
  ok: boolean;
  average: number;
  /** The published version's last average, when it has one (on the cases both versions ran, when `basis` is `same-cases`). */
  baseline?: number;
  reason?: string;
  /** AG24: what the draft was judged against: the cases both versions ran, or the threshold alone (rows from before ag5 have no basis: read them as before). */
  basis?: 'same-cases' | 'threshold';
  /** AG24: how many cases both versions ran (`basis: 'same-cases'`). */
  shared?: number;
}

/** AG24: the lowest-scoring cases of a held run, as a held answer carries them: no reply text. */
export interface GateLowCase {
  input: string;
  score: number;
  reasoning: string;
}

/** Whether a run's average is good enough to publish, against the published version's last average. */
export function gateVerdict(average: number, baseline?: number): GateVerdict {
  const base = { average, ...(baseline !== undefined && { baseline }) };
  if (average < GATE_MIN_AVERAGE) return { ...base, ok: false, reason: `The draft averages ${average.toFixed(1)} / 5, below the ${GATE_MIN_AVERAGE} the gate asks for.` };
  if (baseline !== undefined && average < baseline - GATE_MAX_DROP)
    return { ...base, ok: false, reason: `The draft averages ${average.toFixed(1)} / 5, ${(baseline - average).toFixed(1)} below the published version's ${baseline.toFixed(1)}.` };
  return { ...base, ok: true };
}

/**
 * AG24: the gate on cases both versions ran. With two or more shared case ids the draft is compared with the published version's
 * adopted run on those cases only (and must also clear the threshold on all its cases); with fewer (the change replaced the
 * cases, or the adopted run has no ids) it is judged against the threshold alone, and the reason says so.
 */
export function compareRuns(draft: Pick<AgentEvalRun, 'average' | 'results'>, adopted?: Pick<AgentEvalRun, 'average' | 'results'>): GateVerdict {
  const average = draft.average;
  const byId = new Map((adopted?.results ?? []).filter((r) => r.caseId).map((r) => [r.caseId, r.score]));
  const shared = draft.results.filter((r) => r.caseId && byId.has(r.caseId));
  if (!adopted) return { ...gateVerdict(average), basis: 'threshold' };
  if (shared.length < 2) {
    const base = { average, basis: 'threshold' as const };
    if (average < GATE_MIN_AVERAGE) return { ...base, ok: false, reason: `The draft averages ${average.toFixed(1)} / 5 on its new cases, below the ${GATE_MIN_AVERAGE.toFixed(1)} it asks for.` };
    return { ...base, ok: true };
  }
  const draftMean = meanScore(shared);
  const publishedMean = meanScore(shared.map((r) => ({ score: byId.get(r.caseId) ?? 0 })));
  const base = { average, baseline: publishedMean, basis: 'same-cases' as const, shared: shared.length };
  if (average < GATE_MIN_AVERAGE) return { ...base, ok: false, reason: `The draft averages ${average.toFixed(1)} / 5, below the ${GATE_MIN_AVERAGE.toFixed(1)} the gate asks for.` };
  if (draftMean < publishedMean - GATE_MAX_DROP)
    return { ...base, ok: false, reason: `On the ${shared.length} cases both versions ran, the draft averages ${draftMean.toFixed(1)} / 5, ${(publishedMean - draftMean).toFixed(1)} below the published version's ${publishedMean.toFixed(1)}.` };
  return { ...base, ok: true };
}

/** AG24: a held verdict as one line, with its score and what it was judged on (the publish card, the agent card, the session). */
export function heldLine(verdict: Pick<GateVerdict, 'average' | 'basis' | 'shared' | 'reason'>): string {
  const basis = verdict.basis === 'same-cases' ? `judged on the ${verdict.shared} cases both versions ran` : verdict.basis === 'threshold' ? `judged on its own cases against ${GATE_MIN_AVERAGE.toFixed(1)}` : '';
  return `Held by the eval gate: ${verdict.average.toFixed(1)} / 5${basis ? ` (${basis})` : ''}${verdict.reason ? `. ${verdict.reason}` : ''}`;
}

/** AG24: the held run's lowest cases (at most three), clipped. */
export function lowCasesOf(run: Pick<AgentEvalRun, 'results'>, limit = 3): GateLowCase[] {
  const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  return [...run.results]
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((r) => ({ input: clip(r.input, 160), score: r.score, reasoning: clip(r.reasoning ?? '', 200) }));
}

export const meanScore = (results: Pick<AgentEvalResult, 'score'>[]): number => (results.length ? Math.round((results.reduce((sum, r) => sum + r.score, 0) / results.length) * 100) / 100 : 0);
