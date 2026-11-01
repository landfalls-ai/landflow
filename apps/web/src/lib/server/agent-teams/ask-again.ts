/**
 * "Ask this member again" (Run Trace): the same message to the same member, in a new turn. It is a re-run of the Run a Team
 * node from the earlier run (everything before the node keeps that run's outputs), with the node's message changed for this
 * run only: the lead is told to ask that one member exactly that message and report the answer back as it came. The saved
 * workflow is not touched; the new execution's workflow snapshot carries the changed message.
 */
import type { Workflow } from '@landflow/engine';
import { RerunError } from '../runner';

export const RUN_TEAM = 'core.runTeam';

/** What the lead is told, instead of the node's own message, when a person asks one member again. */
export function askAgainMessage(member: string, message: string): string {
  return [
    `A person wants one member of the team asked again. Ask ${member}, and only ${member}, exactly this, once:`,
    '',
    message,
    '',
    `Do not ask anyone else and do not do the work yourself. When ${member} answers, report its answer back as it came.`,
  ].join('\n');
}

/** The workflow with the Run a Team node's message replaced (a copy; the stored workflow is left alone). */
export function askMemberAgain(workflow: Workflow | undefined, nodeId: string, ask: { member: string; message: string }): Workflow {
  if (!workflow) throw new RerunError('The workflow of this execution no longer exists', 404);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) throw new RerunError('That node is not in the workflow any more');
  if (node.type !== RUN_TEAM) throw new RerunError('Only a Run a Team node can ask a member again');
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) => (n.id === nodeId ? { ...n, parameters: { ...n.parameters, message: askAgainMessage(ask.member, ask.message) } } : n)),
  };
}
