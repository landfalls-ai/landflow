/**
 * The spend-anomaly detector (SP23, docs/second-brain.md#4-detectors-and-suggestions, docs/llm-gateway.md#forecasts-and-unusual-spend):
 * an agent or a workflow whose spend of the last 7 days was unusual for it and nobody acknowledged. Read from the flags
 * `ai-usage/anomalies.ts` stores (a person's and a model's stay out: the inbox names no person). It has no operations:
 * there is nothing to apply, the suggestion says where to look.
 */
import { homeProjectId } from '../projects/store';
import { amountOf, baselineSentence, flagHref, listFlags } from '../ai-usage/spend-flags';
import { agentStore } from '../agents/store';
import { aiUsageMeter } from '../ai-usage';
import { store } from '../store';
import type { DetectContext, Finding } from './detectors';
import { fingerprintOf } from './proposals';

const DAY_MS = 86_400_000;

export function spendAnomalyFindings(ctx: DetectContext): Finding[] {
  const since = aiUsageMeter().today(ctx.now - 7 * DAY_MS);
  const findings: Finding[] = [];
  for (const flag of listFlags('anomaly', since, ctx.db)) {
    if (flag.acknowledgedAt || (flag.dimension !== 'agent' && flag.dimension !== 'workflow')) continue;
    const agent = flag.dimension === 'agent' ? agentStore.get(flag.key) : undefined;
    const workflow = flag.dimension === 'workflow' ? store.getWorkflow(flag.key) : undefined;
    const name = agent?.name ?? workflow?.name;
    if (!name) continue;
    const projectId = homeProjectId(flag.dimension, flag.key);
    findings.push({
      proposal: {
        source: 'detector',
        detector: 'spend-anomaly',
        fingerprint: fingerprintOf('spend-anomaly', `${flag.dimension}|${flag.key}|${flag.day}`),
        ...(projectId && { projectId }),
        target: { type: flag.dimension, id: flag.key, name },
        title: `Unusual AI spend on ${flag.day}: ${flag.dimension} “${name}”`,
        why: `It used ${amountOf(flag.metric, flag.value)} on ${flag.day}, ${baselineSentence(flag)}${flag.score ? `, a score of ${flag.score}` : ''}. ${flag.runs} run${flag.runs === 1 ? '' : 's'} made it${flag.surfaces.length ? `, mostly ${flag.surfaces.join(', ')}` : ''}. Open the AI page at that day, find the runs that cost the most, and check whether the work was meant to be that big. Nothing is changed for you.`,
        evidence: [
          { label: 'Day', value: flag.day, href: flagHref(flag) },
          { label: flag.metric === 'cost' ? 'Spent' : 'Tokens', value: amountOf(flag.metric, flag.value) },
          ...(flag.baselineMedian !== undefined ? [{ label: 'Usual a day (median)', value: amountOf(flag.metric, flag.baselineMedian) }] : []),
          ...(flag.baselineDays !== undefined ? [{ label: 'Observed days in the baseline', value: flag.baselineDays }] : []),
          { label: 'Score', value: flag.score ?? 'none (flat baseline)' },
          { label: 'Runs', value: flag.runs },
        ],
        effect: 'A surprise in the bill found the day it happens, not at the month’s end',
        ops: [],
        risk: 'low',
        confidence: 0.8,
        score: Math.round(Math.max(1, Math.min(10, flag.value)) * 0.8 * 100) / 100,
      },
    });
  }
  return findings;
}
