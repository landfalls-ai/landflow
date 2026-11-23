/**
 * What the server's own record of a run says an approver decided (as `recordedDecision` of the cap-raise flow, for each step):
 * the outputs of the named Ask a Person nodes, never the item an Apply node received (an expression or a Code node could write that).
 */
import { liveExecution } from '../runner';
import { store } from '../store';

export interface RecordedStep {
  name: string;
  approved: boolean;
  /** An email, `email:<address>`, `slack:<id>`, `timeout` or `unknown`. */
  by?: string;
  comment?: string;
  choice?: string;
  /** The node that recorded it, and the question it asked (the server compares both with what it built). */
  nodeId?: string;
  title?: string;
  originalText?: string;
}

export interface RecordedRun {
  workflowId: string;
  /** One entry per named step, in order; undefined for a step that has not answered. */
  steps: Array<RecordedStep | undefined>;
}

export async function recordedDecisions(executionId: string, stepNames: string[]): Promise<RecordedRun | undefined> {
  const record = liveExecution(executionId) ?? (await store.loadExecution(executionId));
  if (!record) return undefined;
  const workflow = record.workflow ?? store.getWorkflow(record.workflowId);
  const steps = stepNames.map((name): RecordedStep | undefined => {
    const node = (workflow?.nodes ?? []).find((n) => n.type === 'core.confirmDraft' && n.name === name);
    const outputs = node && record.runData[node.id]?.at(-1)?.outputs;
    const item = outputs?.[0]?.[0] ?? outputs?.[1]?.[0];
    if (!item) return undefined;
    const json = item.json as { approved?: unknown; by?: unknown; comment?: unknown; choice?: unknown; title?: unknown; originalText?: unknown };
    return {
      name,
      nodeId: node?.id,
      ...(typeof json.title === 'string' && { title: json.title }),
      ...(typeof json.originalText === 'string' && { originalText: json.originalText }),
      approved: Boolean(outputs?.[0]?.length) && json.approved === true,
      ...(typeof json.by === 'string' && { by: json.by }),
      ...(typeof json.comment === 'string' && { comment: json.comment }),
      ...(typeof json.choice === 'string' && { choice: json.choice }),
    };
  });
  return { workflowId: record.workflowId, steps };
}
