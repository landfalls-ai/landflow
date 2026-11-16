/**
 * Which tabs a Run Trace shows and when it offers the time slider: pure, so the view and its test share them.
 * A short single-flow run has Story and Trace; Team and Artifacts appear only with something in them, and the Run
 * report is the summary on top of the Story.
 */
import type { RunChanges } from '@/lib/shared/run-changes';
import type { RunReport } from '@/lib/shared/run-report';
import { formatCost } from '@/lib/shared/ai-usage';
import { fmtMs, type RunModel } from '@/lib/shared/run-trace-model';

export type Tab = 'story' | 'trace' | 'team' | 'artifacts' | 'spend'; // SP06: spend
export const TAB_LABELS: Record<Tab, string> = { story: 'Story', trace: 'Trace', team: 'Team', artifacts: 'Artifacts', spend: 'Spend' }; // SP06: spend

/** A run shorter than this has nothing to replay. */
export const SCRUBBER_MIN_MS = 5000;

/** Who took part: everyone but the models and the flow itself. */
export const participantsOf = (model: RunModel) => model.actors.filter((a) => a.actor.type !== 'model' && a.actor.type !== 'system');

/** Files agents wrote count as made, as the Artifacts tab shows them. */
export const madeCount = (model: RunModel, changes?: RunChanges) => model.artifacts.length + (changes?.files.length ?? 0);

export function visibleTabs(model: RunModel, changes?: RunChanges): Tab[] {
  const tabs: Tab[] = ['story', 'trace'];
  if (participantsOf(model).length > 1) tabs.push('team');
  if (madeCount(model, changes) > 0) tabs.push('artifacts');
  // SP06: Spend shows when the run used model tokens.
  if (model.tokens.inputTokens + model.tokens.outputTokens > 0) tabs.push('spend');
  return tabs;
}

/** The slider replays a run: a run of under five seconds, or with one participant, has nothing to step through. */
export function showScrubber(model: RunModel): boolean {
  const ms = model.t1 - model.t0;
  return (model.live || ms >= SCRUBBER_MIN_MS) && participantsOf(model).length > 1;
}

/** The summary's tiles: run time always, and the others only when they are not zero. */
export function summaryTiles(model: RunModel, changes?: RunChanges): Array<[value: string, label: string]> {
  const requests = model.order.filter((s) => s.kind === 'delegate' || s.kind === 'handoff').length;
  const tokens = model.tokens.inputTokens + model.tokens.outputTokens;
  const people = participantsOf(model).length;
  const made = madeCount(model, changes);
  const tiles: Array<[string, string, number]> = [
    [fmtMs(model.t1 - model.t0), 'run time', 1],
    [String(people), 'taking part', people > 1 ? 1 : 0],
    [String(requests), 'requests', requests],
    [tokens.toLocaleString(), model.tokens.costUsd !== undefined && model.tokens.costUsd > 0 ? `tokens · ${formatCost(model.tokens.costUsd)}` : 'tokens', tokens],
    [String(model.failedSteps.length), 'failed steps', model.failedSteps.length],
    [String(made), 'artifacts', made],
  ];
  return tiles.filter((t) => t[2] > 0).map(([v, l]) => [v, l]);
}

/** What should happen next: only when the report found something (a passing run has no next step). */
export function nextSteps(report: RunReport): string[] {
  return report.verdict === 'pass' ? [] : report.next;
}
