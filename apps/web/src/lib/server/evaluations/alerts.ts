/**
 * Alerts on a falling evaluation score: when an offline run finishes, each rule of kind `evaluation` (alert rules in
 * Settings → Alerts) checks the run's metric averages against its own limits: below a minimum score, or down by more than
 * a share against the previous finished run of the same workflow (the same metric). One message per rule per run,
 * naming every metric that tripped, through the rule's channels.
 */
import type { AlertRule } from '../../shared/alerts';
import type { EvaluationRunSummary } from '../../shared/evaluations';
import { alerts } from '../alerts/service';
import { customNotice, publicUrl, type AlertNotice } from '../alerts/message';
import { inScope } from '../alerts/rules';
import { store } from '../store';
import { listRuns } from './store';

export interface MetricProblem {
  metric: string;
  average: number;
  /** Why it alerts. */
  reasons: string[];
  previous?: number;
}

const num = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

/** The previous finished run of the workflow, before `run`. */
export function previousRun(run: Pick<EvaluationRunSummary, 'workflowId' | 'number'>): EvaluationRunSummary | undefined {
  return listRuns(run.workflowId).find((candidate) => candidate.number < run.number && candidate.status === 'success');
}

/** Which metrics of `run` a rule's limits trip. Pure: tests call it with two summaries. */
export function metricProblems(rule: Pick<AlertRule, 'evaluation'>, run: Pick<EvaluationRunSummary, 'metrics'>, previous?: Pick<EvaluationRunSummary, 'metrics'>): MetricProblem[] {
  const limits = rule.evaluation ?? {};
  const problems: MetricProblem[] = [];
  for (const [metric, summary] of Object.entries(run.metrics)) {
    if (limits.metric && limits.metric !== metric) continue;
    const reasons: string[] = [];
    if (limits.below !== undefined && summary.average < limits.below) reasons.push(`average ${num(summary.average)} is below the minimum ${num(limits.below)}`);
    const before = previous?.metrics[metric]?.average;
    if (limits.dropPercent && before !== undefined && before > 0) {
      const drop = ((before - summary.average) / before) * 100;
      if (drop > limits.dropPercent) reasons.push(`down ${num(Math.round(drop * 10) / 10)}% from ${num(before)} on the previous run (limit ${num(limits.dropPercent)}%)`);
    }
    if (reasons.length) problems.push({ metric, average: summary.average, reasons, ...(before !== undefined && { previous: before }) });
  }
  return problems;
}

/** The message for a rule that tripped. */
export function evaluationNotice(rule: Pick<AlertRule, 'id' | 'name'>, run: EvaluationRunSummary, problems: MetricProblem[], previous?: EvaluationRunSummary): AlertNotice {
  const names = problems.map((problem) => problem.metric).join(', ');
  return customNotice({
    event: 'evaluationScore',
    rule,
    about: { id: run.workflowId, name: run.workflowName },
    subject: `Evaluation score fell: ${run.workflowName} (${names})`,
    facts: [
      { label: 'Workflow', value: run.workflowName },
      { label: 'Run', value: `#${run.number}${run.trigger === 'schedule' ? ' (scheduled)' : ''}, ${run.completed} of ${run.total} cases${run.failed ? `, ${run.failed} failed` : ''}` },
      ...problems.map((problem) => ({ label: problem.metric, value: problem.reasons.join('; ') })),
      ...(previous ? [{ label: 'Compared with', value: `run #${previous.number}` }] : []),
    ],
    link: `${publicUrl()}/workflows/${run.workflowId}#evaluations`,
  });
}

/** A run finished: tell the rules whose limits its metrics trip. */
export async function alertOnEvaluation(run: EvaluationRunSummary): Promise<void> {
  if (!Object.keys(run.metrics).length) return;
  const previous = previousRun(run);
  const tags = store.getWorkflow(run.workflowId)?.tags;
  await alerts.broadcast('evaluation', (rule) => {
    if (!inScope(rule.workflows, run.workflowId, tags)) return undefined;
    const problems = metricProblems(rule, run, previous);
    return problems.length ? evaluationNotice(rule, run, problems, previous) : undefined;
  });
}
