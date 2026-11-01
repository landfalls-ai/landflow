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
