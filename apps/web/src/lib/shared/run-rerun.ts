/**
 * What a person can do from a span of the Run Trace to run it again (docs/run-trace.md#run-it-again): re-run the flow from
 * the node it belongs to (earlier nodes keep this run's outputs), ask a team member the same thing again, or copy the flow
 * to the editor with the run's outputs pinned. Pure: the screens and the tests share it.
 */
import type { RunModel, RunSpan } from './run-trace-model';

const isNodeSpan = (span: RunSpan | undefined): boolean => Boolean(span && span.nodeId && span.id.startsWith('node:'));

/** The span of the flow node a span belongs to (itself when it is one). */
export function nodeSpanOf(model: RunModel, spanId: string): RunSpan | undefined {
  for (let at: RunSpan | undefined = model.spans[spanId], guard = 0; at && guard < 50; at = at.parentId ? model.spans[at.parentId] : undefined, guard++) if (isNodeSpan(at)) return at;
  return undefined;
}

export interface RerunPlan {
  node: RunSpan;
  /** The nodes that ran before it: they keep this run's outputs (pinned). One entry per node. */
  pinned: RunSpan[];
  /** The node itself and what ran after it: they run again. */
  again: RunSpan[];
}

/** The flow's nodes as the run went, the first run of each. */
export function flowNodes(model: RunModel): RunSpan[] {
  const seen = new Set<string>();
  return model.order.filter((s) => {
    if (!isNodeSpan(s) || s.hidden || s.parentId !== 'run' || seen.has(s.nodeId!)) return false;
    seen.add(s.nodeId!);
    return true;
  });
}

/** What re-running from the node of `spanId` keeps and what it runs again. */
export function rerunPlan(model: RunModel, spanId: string): RerunPlan | undefined {
  const node = nodeSpanOf(model, spanId);
  if (!node) return undefined;
  const nodes = flowNodes(model);
  const index = nodes.findIndex((n) => n.nodeId === node.nodeId);
  if (index < 0) return { node, pinned: [], again: [node] };
  return { node: nodes[index], pinned: nodes.slice(0, index), again: nodes.slice(index) };
}

export interface RerunStep {
  name: string;
  nodeId: string;
  /** The node failed in this run (in any of its runs, when a loop ran it several times). */
  failed: boolean;
}

export interface RerunDiagram {
  /** The nodes that keep this run's outputs, in run order. */
  kept: RerunStep[];
  /** The node the re-run starts at. */
  from: RerunStep;
  /** The nodes after it, which run again, in run order. */
  again: RerunStep[];
  /** One line in plain words: "Planner and Developer keep this run's outputs; Typecheck runs again, then Review and Merge." */
  sentence: string;
}

/** "A", "A and B", "A, B and C". */
export const joinNames = (names: string[]): string => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The re-run as a small diagram. The nodes are the ones this run ran, in the order they first ran (a node a loop ran several
 * times shows once). A span inside a node (a member's request, a tool step) maps to its node. A node that never ran in this
 * run (a branch not taken) is left out: the diagram shows what happened, not the workflow's graph, so "after" means after in
 * this run's order. `undefined` when the span is in no node.
 */
export function rerunDiagram(model: RunModel, spanId: string): RerunDiagram | undefined {
  const plan = rerunPlan(model, spanId);
  if (!plan) return undefined;
  const failedIds = new Set(model.order.filter((s) => isNodeSpan(s) && s.status === 'error').map((s) => s.nodeId!));
  const step = (s: RunSpan): RerunStep => ({ name: s.name, nodeId: s.nodeId!, failed: failedIds.has(s.nodeId!) });
  const [first, ...after] = plan.again;
  const kept = plan.pinned.map(step);
  const from = step(first);
  const again = after.map(step);
  const parts: string[] = [];
  if (kept.length) parts.push(`${joinNames(kept.map((k) => k.name))} ${kept.length > 1 ? 'keep' : 'keeps'} this run's outputs`);
  parts.push(`${from.name} runs again${again.length ? `, then ${joinNames(again.map((a) => a.name))}` : ''}`);
  return { kept, from, again, sentence: `${parts.join('; ')}.` };
}

export interface AskAgain {
  /** The Run a Team node. */
  nodeId: string;
  member: string;
  message: string;
}

/** A member's request under a Run a Team node, asked by its lead: the member and what it was asked. */
export function askAgainOf(model: RunModel, spanId: string): AskAgain | undefined {
  const span = model.spans[spanId];
  if (!span || span.kind !== 'delegate' || !span.parentId) return undefined;
  const parent = model.spans[span.parentId];
  if (!parent || !isNodeSpan(parent) || parent.attrs.nodeType !== 'core.runTeam') return undefined;
  const input = span.input;
  const message = typeof input === 'string' ? input : input && typeof input === 'object' && typeof (input as { message?: unknown }).message === 'string' ? (input as { message: string }).message : undefined;
  return message?.trim() ? { nodeId: parent.nodeId!, member: span.name, message } : undefined;
}

/** The editor's link for "Copy to editor": the workflow with this run's outputs pinned, up to (not including) the node. */
export function copyToEditorHref(workflowId: string, executionId: string, nodeId?: string) {
  return `/workflows/${workflowId}?execution=${encodeURIComponent(executionId)}&pin=${encodeURIComponent(nodeId ?? 'all')}`;
}
