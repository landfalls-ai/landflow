/**
 * Whether a test run passed, for Spotlight's "Test and fix" (docs/assistant.md): Spotlight runs the workflow and, while
 * a run doesn't pass, asks the assistant for a fix. A run passes when it succeeded, no node failed, and items reached
 * the end of the flow. A run where every branch ended with no items stopped somewhere, which is a bug more often than not.
 */

export interface CheckedNode {
  id: string;
  name: string;
  /** Attached to an agent as its model, memory or a tool: not a step of the flow. */
  sub: boolean;
}

export interface CheckedRun {
  nodes: CheckedNode[];
  /** Main connections. */
  edges: Array<{ source: string; target: string }>;
  /** Node id → its run: the error, or how many items it put out. Nodes that didn't run are missing. */
  ran: Record<string, { error?: string; items: number }>;
  /** How the execution ended (success, error, canceled, waiting). */
  status?: string;
  error?: string;
}

/** `node`: where it went wrong (when one node did), or, on a pass, the last step that put out items. */
export type RunVerdict = { passed: boolean; node?: string; summary: string };

export function checkRun(run: CheckedRun): RunVerdict {
  const failed = run.nodes.find((n) => !n.sub && run.ran[n.id]?.error) ?? run.nodes.find((n) => run.ran[n.id]?.error);
  if (failed) return { passed: false, node: failed.name, summary: `failed at “${failed.name}”: ${run.ran[failed.id].error}` };
  if (run.status !== 'success') return { passed: false, summary: `ended with ${run.status ?? 'no result'}${run.error ? `: ${run.error}` : ''}` };
  const steps = run.nodes.filter((n) => !n.sub && run.ran[n.id]);
  // Where each branch stopped: a node that ran and none of whose next nodes did.
  const ends = steps.filter((n) => !run.edges.some((e) => e.source === n.id && run.ran[e.target]));
  const reached = ends.filter((n) => run.ran[n.id].items > 0);
  if (ends.length && !reached.length) return { passed: false, node: ends[0].name, summary: `“${ends[0].name}” put out no items, so nothing reached the end of the flow` };
  const items = reached.reduce((sum, n) => sum + run.ran[n.id].items, 0);
  const last = reached.at(-1)?.name;
  return { passed: true, ...(last && { node: last }), summary: `${steps.length} step${steps.length === 1 ? '' : 's'}${last ? `, ${items} item${items === 1 ? '' : 's'} reached “${last}”` : ''}` };
}

export interface CheckedStep {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}

const listOf = (value: unknown, key: string) => {
  const list = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? list : [];
};

/**
 * Steps that run without an error but do nothing: an If or Filter with no conditions (it keeps every item), a Set in
 * manual mode with no fields. A drafted flow often has them, and a run that "passes" through them doesn't do the job.
 */
export function hollowSteps(steps: CheckedStep[]): Array<{ node: string; problem: string }> {
  return steps.flatMap((step) => {
    const p = step.parameters;
    if ((step.type === 'core.filter' || step.type === 'core.if') && 'conditions' in p && !listOf(p.conditions, 'condition').length) {
      return [{ node: step.name, problem: `“${step.name}” has no conditions, so it keeps every item` }];
    }
    if (step.type === 'core.set' && (p.mode ?? 'manual') === 'manual' && 'fields' in p && !listOf(p.fields, 'values').length) {
      return [{ node: step.name, problem: `“${step.name}” sets no fields` }];
    }
    return [];
  });
}

/**
 * A Code node in "each" mode runs once per item and returns that item's result. When it puts out several items for each
 * one it got (10 in, 100 out), its code worked on all the items every time (`items` rather than `$json`): the run
 * passes, but every result comes out many times over.
 */
export function multipliedSteps(run: CheckedRun, steps: Array<CheckedStep & { id: string }>): Array<{ node: string; problem: string }> {
  return steps.flatMap((step) => {
    if (step.type !== 'core.code' || step.parameters.mode !== 'each') return [];
    const out = run.ran[step.id]?.items ?? 0;
    const got = run.edges.filter((e) => e.target === step.id).reduce((sum, e) => sum + (run.ran[e.source]?.items ?? 0), 0);
    if (got < 2 || out < got * 2) return [];
    return [{ node: step.name, problem: `“${step.name}” runs once per item but put out ${out} items from ${got}, so its code handles every item each time: use mode “all” to work on all items at once, or return only this item’s result` }];
  });
}
