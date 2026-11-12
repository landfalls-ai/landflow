/**
 * On Suggestion Decided (core.suggestionDecidedTrigger, nodes/usage.ts): published workflows that start from it run when
 * someone decides a suggestion: applies it, dismisses it, snoozes it, or takes one of the buttons a flow put on it
 * (Suggest Improvement's Actions). One run per decision, one item: the whole suggestion plus what was decided.
 *
 * Loops can't form: a decision made by a workflow that starts from this trigger never fires it, and neither does a
 * suggestion about such a workflow. A trigger sees the suggestions its workflow's creator could see (./scope.ts).
 * The decision is saved before this runs, and the run starts in the background, so the person's click is not held up.
 */
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { NodeItem } from '@landflow/sdk';
import type { Proposal, ProposalDecision } from '../../shared/brain';
import { workflowForCall } from '../publish';
import { runWorkflow } from '../runner';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { fireTrigger } from '../telemetry/triggers';
import { covers, scopeForWorkflow } from './scope';

export const DECIDED_TRIGGER = 'core.suggestionDecidedTrigger';
const CACHE_MS = 5_000;

export interface Listener {
  workflow: Workflow;
  node: WorkflowNode;
}

const state = () => singleton('decided-trigger', () => ({ armed: { at: 0, list: [] as Listener[] } }));

const hasTrigger = (workflow: Workflow | undefined) => Boolean(workflow?.nodes.some((n) => n.type === DECIDED_TRIGGER));

/** Published workflows with an enabled On Suggestion Decided, re-read at most every 5 seconds. */
function armed(): Listener[] {
  const s = state();
  if (Date.now() - s.armed.at < CACHE_MS) return s.armed.list;
  const list: Listener[] = [];
  for (const saved of store.listWorkflows()) {
    if (!saved.active || !hasTrigger(saved)) continue;
    const workflow = workflowForCall(saved.id, 'trigger') ?? saved;
    for (const node of workflow.nodes) if (node.type === DECIDED_TRIGGER && !node.disabled) list.push({ workflow, node });
  }
  s.armed = { at: Date.now(), list };
  return list;
}

const asList = (value: unknown): string[] =>
  (Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : []).map((v) => v.trim()).filter(Boolean);

/** The decision's kind for the Decisions filter: applied, dismissed, snoozed, or the action's id. */
const kindOf = (decision: ProposalDecision) => decision.action;

/** Whether a trigger node with these parameters asks for this decision of this suggestion. */
export function decidedMatches(proposal: Proposal, decision: ProposalDecision, parameters: Record<string, unknown>): boolean {
  const detector = typeof parameters.detector === 'string' ? parameters.detector.trim() : '';
  if (detector && proposal.detector !== detector) return false;
  const label = typeof parameters.label === 'string' ? parameters.label.trim().toLowerCase() : '';
  if (label && (proposal.label ?? '').trim().toLowerCase() !== label) return false;
  const decisions = asList(parameters.decisions);
  if (decisions.length && !decisions.includes(kindOf(decision))) return false;
  const workflowId = typeof parameters.workflowId === 'string' ? parameters.workflowId.trim() : '';
  if (workflowId && !(proposal.target.type === 'workflow' && proposal.target.id === workflowId)) return false;
  return true;
}

/** The workflows (and trigger nodes) this decision starts. `by`: the workflow that made it, if one did. */
export function decisionListeners(proposal: Proposal, decision: ProposalDecision, by?: string): Listener[] {
  // No loops: what a decided-triggered workflow does never triggers one, and neither do suggestions about it.
  if (by && hasTrigger(store.getWorkflow(by))) return [];
  if (proposal.target.type === 'workflow' && proposal.target.id && hasTrigger(store.getWorkflow(proposal.target.id))) return [];
  const subject = proposal.target.type === 'agent' ? { agentId: proposal.target.id } : proposal.target.type === 'workflow' ? { workflowId: proposal.target.id } : {};
  return armed().filter((l) => decidedMatches(proposal, decision, l.node.parameters ?? {}) && covers(scopeForWorkflow(l.workflow.id), subject));
}

/** Published workflows that start when `detector`'s suggestion is applied: any with a Detector that matches (or none) and Decisions that include applied (or none). */
export function decidedBuilders(detector: string): Array<{ id: string; name: string }> {
  return armed()
    .filter((l) => {
      const wanted = typeof l.node.parameters?.detector === 'string' ? l.node.parameters.detector.trim() : '';
      const decisions = asList(l.node.parameters?.decisions);
      return (!wanted || wanted === detector) && (!decisions.length || decisions.includes('applied'));
    })
    .map((l) => ({ id: l.workflow.id, name: l.workflow.name }));
}

/** The trigger's item: the whole suggestion, then the decision (the action's own label is `actionLabel`: `label` is the suggestion's). */
export function decidedItem(proposal: Proposal, decision: ProposalDecision): NodeItem {
  const isAction = !['applied', 'dismissed', 'snoozed'].includes(decision.action);
  const json = {
    id: proposal.id,
    source: proposal.source,
    detector: proposal.detector,
    label: proposal.label,
    title: proposal.title,
    why: proposal.why,
    evidence: proposal.evidence,
    effect: proposal.effect,
    target: proposal.target,
    actions: proposal.actions ?? [],
    ops: proposal.ops,
    risk: proposal.risk,
    confidence: proposal.confidence,
    decision: isAction ? 'action' : decision.action,
    action: isAction ? decision.action : undefined,
    actionLabel: decision.label,
    reason: decision.reason,
    note: decision.note,
    by: decision.by,
    at: decision.at,
  };
  return { json: JSON.parse(JSON.stringify(json)) as NodeItem['json'] };
}

/** Start the listening workflows, in the background. Returns who it starts. */
export function dispatchDecision(proposal: Proposal, decision: ProposalDecision, by?: string): Array<{ id: string; name: string }> {
  const listeners = decisionListeners(proposal, decision, by);
  const items = [decidedItem(proposal, decision)];
  for (const entry of listeners) {
    const start = () =>
      fireTrigger({ source: 'suggestion', workflowId: entry.workflow.id, nodeName: entry.node.name }, () =>
        runWorkflow({ workflow: entry.workflow, mode: 'trigger', startNodeId: entry.node.id, triggerItems: items }),
      ).catch((error) => logger.warn('On Suggestion Decided could not start its workflow', { error, 'landflow.workflow.id': entry.workflow.id }));
    const timer = setTimeout(() => void start(), 0);
    timer.unref?.();
  }
  return [...new Map(listeners.map((l) => [l.workflow.id, { id: l.workflow.id, name: l.workflow.name }])).values()];
}

/** Forget the cached list (tests, after publishing). */
export function resetDecidedTrigger() {
  state().armed = { at: 0, list: [] };
}
