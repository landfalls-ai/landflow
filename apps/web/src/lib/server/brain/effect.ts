/**
 * Measuring a suggestion's effect (docs/second-brain.md#7-measuring-the-effect). Applying records a baseline over the week
 * before; 7 and 14 days later the same metric is measured over the days since, and at 14 days the suggestion is marked
 * worked (10% better or more), worse (10% worse or more) or no effect. The outcome becomes a `change` fact on the target.
 *
 * Every metric comes from the usage ledger, production runs only (editor runs are left out).
 */
import type { Proposal, ProposalMetric, ProposalMetricName, ProposalOutcome } from '../../shared/brain';
import { database, type Database, type SqlValue } from '../db';
import { percentile } from '../usage/query';
import { upsertFact } from './facts';

const DAY_MS = 86_400_000;
const PRODUCTION = "COALESCE(json_extract(attrs, '$.mode'), '') <> 'manual'";

/** The metric a suggestion is measured by, from its detector. */
export function metricFor(proposal: Pick<Proposal, 'detector' | 'target'>): ProposalMetricName | undefined {
  switch (proposal.detector) {
    case 'failure-hot-spot':
    case 'flaky-call':
    case 'no-safety-net':
      return 'failureRate';
    case 'slow-step':
      return 'p95Ms';
    case 'ai-cost':
      return 'costPerRun';
    case 'hand-run-rhythm':
      return 'manualRuns';
    case 'agent-quality':
      return 'thumbsDownRate';
    default:
      return proposal.target.type === 'workflow' && proposal.target.id ? 'failureRate' : undefined;
  }
}

/** `metric` for a workflow or agent over [from, to). */
export function measure(metric: ProposalMetricName, target: Proposal['target'], from: number, to: number, db: Database = database()): number {
  const window: SqlValue[] = [new Date(from).toISOString(), new Date(to).toISOString()];
  const subject = target.type === 'agent' ? 'agent_id = ?' : 'workflow_id = ?';
  const id = target.id ?? '';
  const count = (where: string, ...params: SqlValue[]) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_events WHERE at >= ? AND at < ? AND ${where}`, ...window, ...params)?.n ?? 0);
  switch (metric) {
    case 'runs':
      return count(`kind = 'run.finished' AND ${subject} AND ${PRODUCTION}`, id);
    case 'failureRate': {
      const runs = count(`kind = 'run.finished' AND ${subject} AND ${PRODUCTION}`, id);
      const failed = count(`kind = 'run.finished' AND ${subject} AND ${PRODUCTION} AND json_extract(attrs, '$.status') = 'error'`, id);
      return runs ? failed / runs : 0;
    }
    case 'p95Ms':
      return percentile(`at >= ? AND at < ? AND kind = 'run.finished' AND ${subject} AND ${PRODUCTION}`, [...window, id], 0.95, db);
    case 'costPerRun': {
      const runs = count(`kind = 'run.finished' AND ${subject}`, id);
      const cost = Number(db.get<{ c: number }>(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events WHERE at >= ? AND at < ? AND kind = 'ai.call' AND ${subject}`, ...window, id)?.c ?? 0);
      return runs ? cost / runs : cost;
    }
    case 'manualRuns':
      return count(`kind = 'run.finished' AND ${subject} AND json_extract(attrs, '$.mode') = 'manual'`, id);
    case 'thumbsDownRate': {
      const all = count(`kind = 'feedback' AND ${subject}`, id);
      const down = count(`kind = 'feedback' AND ${subject} AND json_extract(attrs, '$.rating') = 'down'`, id);
      return all ? down / all : 0;
    }
  }
}

/** The week before `at`, as the baseline to compare against. */
export function baselineFor(proposal: Pick<Proposal, 'detector' | 'target'>, at = Date.now(), db: Database = database()): ProposalMetric | undefined {
  const metric = metricFor(proposal);
  if (!metric || !proposal.target.id) return undefined;
  return { metric, value: measure(metric, proposal.target, at - 7 * DAY_MS, at, db), days: 7, at: new Date(at).toISOString(), better: 'lower' };
}

/** Compare `after` with `before` (lower is better): 10% either way decides. */
export function outcomeOf(before: number, after: number): ProposalOutcome {
  if (before === 0 && after === 0) return 'no-effect';
  if (before === 0) return after > 0 ? 'worse' : 'no-effect';
  const change = (after - before) / before;
  if (change <= -0.1) return 'worked';
  if (change >= 0.1) return 'worse';
  return 'no-effect';
}

const formats: Record<ProposalMetricName, (n: number) => string> = {
  failureRate: (n) => `${Math.round(n * 1000) / 10}% of runs failing`,
  p95Ms: (n) => `p95 ${(n / 1000).toFixed(1)} s`,
  costPerRun: (n) => `$${n.toFixed(4)} per run`,
  manualRuns: (n) => `${n} runs by hand`,
  thumbsDownRate: (n) => `${Math.round(n * 100)}% thumbs down`,
  runs: (n) => `${n} runs`,
};

export const formatMetric = (metric: ProposalMetricName, value: number) => formats[metric](value);

/**
 * The checks due for one applied suggestion: at 7 days a check, at 14 the outcome. Returns the updated suggestion, or
 * undefined when nothing was due.
 */
export function checkEffect(proposal: Proposal, now = Date.now(), db: Database = database()): Proposal | undefined {
  if (proposal.status !== 'applied' || !proposal.appliedAt || !proposal.baseline || !proposal.target.id) return undefined;
  if (proposal.outcome && proposal.outcome !== 'pending') return undefined;
  const applied = Date.parse(proposal.appliedAt);
  const checks = proposal.checks ?? [];
  const due = [7, 14].find((days) => now - applied >= days * DAY_MS && !checks.some((c) => c.days === days));
  if (!due) return undefined;
  const { metric } = proposal.baseline;
  const value = measure(metric, proposal.target, applied, applied + due * DAY_MS, db) * (metric === 'manualRuns' ? 7 / due : 1);
  const check: ProposalMetric = { metric, value, days: due, at: new Date(now).toISOString(), better: 'lower' };
  const next: Proposal = { ...proposal, checks: [...checks, check], updatedAt: new Date(now).toISOString(), outcome: 'pending' };
  if (due === 14) {
    next.outcome = outcomeOf(proposal.baseline.value, value);
    const words = { worked: 'helped', worse: 'made it worse', 'no-effect': 'made no clear difference', pending: '' }[next.outcome];
    upsertFact(
      {
        id: `${proposal.target.type}:${proposal.target.id}:change:${proposal.id}`,
        subjectType: proposal.target.type === 'agent' ? 'agent' : 'workflow',
        subjectId: proposal.target.id,
        ...(proposal.target.name && { subjectName: proposal.target.name }),
        kind: 'change',
        statement: `Applying “${proposal.title}” ${words}: ${formatMetric(metric, proposal.baseline.value)} before, ${formatMetric(metric, value)} in the two weeks after.`,
        evidence: [{ label: 'Suggestion', value: proposal.title }],
        confidence: 0.8,
        ...(proposal.projectId && { projectId: proposal.projectId }),
      },
      db,
    );
  }
  return next;
}
