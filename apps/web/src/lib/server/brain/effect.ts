/**
 * Measuring a suggestion's effect (docs/second-brain.md#7-measuring-the-effect). Applying records a baseline over the week
 * before; 7 and 14 days later the same metric is measured over the days since, and at 14 days the suggestion is marked
 * worked (10% better or more), worse (10% worse or more) or no effect. The outcome becomes a `change` fact on the target.
 *
 * The built-in metrics come from the usage ledger, production runs only (editor runs are left out). A flow detector may
 * declare its own instead (`proposal.metricSpec`, from the Detector Trigger or Suggest Improvement node): a query over the
 * ledger, measured here at once, or a sub-workflow that returns the number, which takes a moment and so runs async (the
 * baseline is recorded `pending` on Apply and filled in right after; see settleBaseline).
 */
import type { JsonObject } from '@landflow/sdk';
import { flowDetectorWorkflow, isFlowDetector, type MetricSpec, type Proposal, type ProposalMetric, type ProposalMetricName, type ProposalOutcome } from '../../shared/brain';
import { database, type Database, type SqlValue } from '../db';
import { workflowForCall } from '../publish';
import { percentile, usageAggregate } from '../usage/query';
import { covers, scopeForWorkflow } from './scope';
import { upsertFact } from './facts';

const DAY_MS = 86_400_000;
const PRODUCTION = "COALESCE(json_extract(attrs, '$.mode'), '') <> 'manual'";

/** The metric a suggestion is measured by, from its detector. */
export function metricFor(proposal: Pick<Proposal, 'detector' | 'target' | 'metricSpec'>): ProposalMetricName | undefined {
  if (proposal.metricSpec) return 'custom';
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
export function measure(metric: Exclude<ProposalMetricName, 'custom'>, target: Proposal['target'], from: number, to: number, db: Database = database()): number {
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

/** How many days a declared usage metric is counted over: sums and counts are per week, so 7 and 14 days compare. */
const perWeek = (spec: MetricSpec | undefined, days: number) => (spec?.source === 'usage' && spec.usage?.aggregate !== 'avg' ? 7 / days : 1);

/**
 * A declared usage metric over [from, to): events of its kinds (and attribute filter) about the suggestion's workflow or
 * agent, or about everything the detector flow's creator can see. A target the creator can't see measures nothing (0).
 */
export function measureSpec(proposal: Pick<Proposal, 'detector' | 'target'>, spec: MetricSpec, from: number, to: number, db: Database = database()): number {
  const usage = spec.usage;
  if (!usage) return 0;
  const flow = proposal.detector && isFlowDetector(proposal.detector) ? flowDetectorWorkflow(proposal.detector) : undefined;
  const scope = scopeForWorkflow(flow);
  const { type, id } = proposal.target;
  const subject = usage.about === 'target' && id ? (type === 'agent' ? { agentId: id } : { workflowId: id }) : undefined;
  if (subject && !covers(scope, subject)) return 0;
  return usageAggregate(
    { kinds: usage.kinds, from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...subject, ...(usage.attrEquals && { attrEquals: usage.attrEquals }) },
    { aggregate: usage.aggregate, field: usage.field, scope },
    db,
  );
}

/** How long a metric sub-workflow may run unless the spec says. */
export const METRIC_TIMEOUT_SECONDS = 120;

/**
 * Run a declared metric's sub-workflow with `{ proposal, from, to, phase }` and read the number from the named field of
 * its first output item. A missing workflow, a failed or timed-out run, or a field that isn't a number gives undefined:
 * no value is recorded, never a made-up 0.
 */
export async function measureWorkflow(proposal: Proposal, spec: MetricSpec, from: number, to: number, phase: 'baseline' | 'check'): Promise<number | undefined> {
  const call = spec.workflow;
  if (!call) return undefined;
  try {
    const workflow = workflowForCall(call.workflowId, 'trigger');
    const { triggerOf, callerAllowed } = await import('../nodes/workflows');
    const trigger = workflow && triggerOf(workflow);
    const flow = proposal.detector && isFlowDetector(proposal.detector) ? flowDetectorWorkflow(proposal.detector) : undefined;
    if (!workflow || !trigger || !callerAllowed(workflow, flow)) return undefined;
    const { runWorkflow, lastNodeItems } = await import('../runner');
    const asJson = JSON.parse(JSON.stringify({ ...proposal, draft: undefined })) as JsonObject;
    const record = await runWorkflow({
      workflow,
      mode: 'trigger',
      startNodeId: trigger.id,
      triggerItems: [{ json: { proposal: asJson, from: new Date(from).toISOString(), to: new Date(to).toISOString(), phase } }],
      signal: AbortSignal.timeout((call.timeoutSeconds ?? METRIC_TIMEOUT_SECONDS) * 1000),
    });
    if (record.status !== 'success') return undefined;
    const raw = lastNodeItems(record)[0]?.json?.[call.field];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The week before `at`, as the baseline to compare against. A declared usage metric is measured here; a declared
 * sub-workflow one comes back `pending` (value 0, not real) and settleBaseline fills it in.
 */
export function baselineFor(proposal: Pick<Proposal, 'detector' | 'target' | 'metricSpec'>, at = Date.now(), db: Database = database()): ProposalMetric | undefined {
  const spec = proposal.metricSpec;
  if (spec) {
    const base = { metric: 'custom' as const, days: 7, at: new Date(at).toISOString(), better: spec.better, label: spec.label };
    if (spec.source === 'workflow') return { ...base, value: 0, pending: true };
    return { ...base, value: measureSpec(proposal, spec, at - 7 * DAY_MS, at, db) };
  }
  const metric = metricFor(proposal);
  if (!metric || !proposal.target.id) return undefined;
  return { metric, value: measure(metric as Exclude<ProposalMetricName, 'custom'>, proposal.target, at - 7 * DAY_MS, at, db), days: 7, at: new Date(at).toISOString(), better: 'lower' };
}

/** Whether a baseline still waits for its sub-workflow (`pending`) or has no value after a failed run. */
export const unsettled = (proposal: Pick<Proposal, 'baseline'>) => Boolean(proposal.baseline?.pending || proposal.baseline?.failed);

/**
 * Fill in a declared sub-workflow baseline: run it for the week before the suggestion was applied. Returns the updated
 * baseline (with a value, or `failed` when the run gave none), or undefined when there is nothing to settle.
 */
export async function settleBaseline(proposal: Proposal): Promise<ProposalMetric | undefined> {
  const { baseline, metricSpec: spec } = proposal;
  if (!baseline || !spec || spec.source !== 'workflow' || !unsettled(proposal)) return undefined;
  const at = Date.parse(baseline.at);
  const value = await measureWorkflow(proposal, spec, at - 7 * DAY_MS, at, 'baseline');
  const { pending: _pending, failed: _failed, ...rest } = baseline;
  void _pending;
  void _failed;
  return value === undefined ? { ...rest, value: 0, failed: true } : { ...rest, value };
}

/** Compare `after` with `before` (lower is better unless `better` says higher): 10% either way decides. */
export function outcomeOf(before: number, after: number, better: 'lower' | 'higher' = 'lower'): ProposalOutcome {
  if (before === 0 && after === 0) return 'no-effect';
  const sign = better === 'higher' ? -1 : 1;
  if (before === 0) return after === 0 ? 'no-effect' : better === 'higher' ? 'worked' : 'worse';
  const change = ((after - before) / Math.abs(before)) * sign;
  if (change <= -0.1) return 'worked';
  if (change >= 0.1) return 'worse';
  return 'no-effect';
}

const formats: Record<Exclude<ProposalMetricName, 'custom'>, (n: number) => string> = {
  failureRate: (n) => `${Math.round(n * 1000) / 10}% of runs failing`,
  p95Ms: (n) => `p95 ${(n / 1000).toFixed(1)} s`,
  costPerRun: (n) => `$${n.toFixed(4)} per run`,
  manualRuns: (n) => `${n} runs by hand`,
  thumbsDownRate: (n) => `${Math.round(n * 100)}% thumbs down`,
  runs: (n) => `${n} runs`,
};

const plain = (n: number) => String(Math.round(n * 100) / 100);

/** A metric's value in words; a declared metric shows its label and the number ("Initiatives merged or reused: 9"). */
export const formatMetric = (metric: ProposalMetricName, value: number, label?: string) => (metric === 'custom' ? `${label || 'Metric'}: ${plain(value)}` : formats[metric](value));

/** The check due now for an applied suggestion (7 days, then 14), or undefined when none is. */
function dueCheck(proposal: Proposal, now: number): number | undefined {
  if (proposal.status !== 'applied' || !proposal.appliedAt || !proposal.baseline || unsettled(proposal)) return undefined;
  if (!proposal.target.id && !proposal.metricSpec) return undefined;
  if (proposal.outcome && proposal.outcome !== 'pending') return undefined;
  const applied = Date.parse(proposal.appliedAt);
  const checks = proposal.checks ?? [];
  return [7, 14].find((days) => now - applied >= days * DAY_MS && !checks.some((c) => c.days === days));
}

/** The suggestion with `value` recorded as its check at `due` days; at 14 days the outcome and the `change` fact. */
function recordCheck(proposal: Proposal, due: number, value: number, now: number, db: Database): Proposal {
  const baseline = proposal.baseline!;
  const { metric } = baseline;
  const better = baseline.better ?? 'lower';
  const check: ProposalMetric = { metric, value, days: due, at: new Date(now).toISOString(), better, ...(baseline.label && { label: baseline.label }) };
  const next: Proposal = { ...proposal, checks: [...(proposal.checks ?? []), check], updatedAt: new Date(now).toISOString(), outcome: 'pending' };
  if (due === 14) {
    next.outcome = outcomeOf(baseline.value, value, better);
    const words = { worked: 'helped', worse: 'made it worse', 'no-effect': 'made no clear difference', pending: '' }[next.outcome];
    const { type, id } = proposal.target;
    const subjectType = type === 'agent' ? 'agent' : type === 'workflow' ? 'workflow' : 'instance';
    const statement =
      metric === 'custom'
        ? `Applying “${proposal.title}” ${words}: ${baseline.label} was ${plain(baseline.value)} before and ${plain(value)} in the two weeks after (${better} is better).`
        : `Applying “${proposal.title}” ${words}: ${formatMetric(metric, baseline.value)} before, ${formatMetric(metric, value)} in the two weeks after.`;
    upsertFact(
      {
        id: `${subjectType}:${id ?? 'instance'}:change:${proposal.id}`,
        subjectType,
        subjectId: id ?? 'instance',
        ...(proposal.target.name && { subjectName: proposal.target.name }),
        kind: 'change',
        statement,
        evidence: [{ label: 'Suggestion', value: proposal.title }],
        confidence: 0.8,
        ...(proposal.projectId && { projectId: proposal.projectId }),
      },
      db,
    );
  }
  return next;
}

/**
 * The checks due for one applied suggestion: at 7 days a check, at 14 the outcome. Returns the updated suggestion, or
 * undefined when nothing was due. A declared sub-workflow metric can't be measured here (it is async): see checkEffectAsync.
 */
export function checkEffect(proposal: Proposal, now = Date.now(), db: Database = database()): Proposal | undefined {
  if (proposal.metricSpec?.source === 'workflow') return undefined;
  const due = dueCheck(proposal, now);
  if (!due) return undefined;
  const applied = Date.parse(proposal.appliedAt!);
  const { metric } = proposal.baseline!;
  const spec = proposal.metricSpec;
  const value =
    metric === 'custom' && spec
      ? measureSpec(proposal, spec, applied, applied + due * DAY_MS, db) * perWeek(spec, due)
      : measure(metric as Exclude<ProposalMetricName, 'custom'>, proposal.target, applied, applied + due * DAY_MS, db) * (metric === 'manualRuns' ? 7 / due : 1);
  return recordCheck(proposal, due, value, now, db);
}

/** checkEffect for every kind of metric: a declared sub-workflow one runs it; a failed run records nothing and is tried again next time. */
export async function checkEffectAsync(proposal: Proposal, now = Date.now(), db: Database = database()): Promise<Proposal | undefined> {
  if (proposal.metricSpec?.source !== 'workflow') return checkEffect(proposal, now, db);
  const due = dueCheck(proposal, now);
  if (!due) return undefined;
  const applied = Date.parse(proposal.appliedAt!);
  const value = await measureWorkflow(proposal, proposal.metricSpec, applied, applied + due * DAY_MS, 'check');
  return value === undefined ? undefined : recordCheck(proposal, due, value, now, db);
}
