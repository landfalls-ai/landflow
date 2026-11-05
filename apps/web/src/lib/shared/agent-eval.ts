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
  /** The published version's last average, when it has one. */
  baseline?: number;
  reason?: string;
}

/** Whether a run's average is good enough to publish, against the published version's last average. */
export function gateVerdict(average: number, baseline?: number): GateVerdict {
  const base = { average, ...(baseline !== undefined && { baseline }) };
  if (average < GATE_MIN_AVERAGE) return { ...base, ok: false, reason: `The draft averages ${average.toFixed(1)} / 5, below the ${GATE_MIN_AVERAGE} the gate asks for.` };
  if (baseline !== undefined && average < baseline - GATE_MAX_DROP)
    return { ...base, ok: false, reason: `The draft averages ${average.toFixed(1)} / 5, ${(baseline - average).toFixed(1)} below the published version's ${baseline.toFixed(1)}.` };
  return { ...base, ok: true };
}

export const meanScore = (results: Pick<AgentEvalResult, 'score'>[]): number => (results.length ? Math.round((results.reduce((sum, r) => sum + r.score, 0) / results.length) * 100) / 100 : 0);
