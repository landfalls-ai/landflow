/**
 * Access Request (`core.accessRequestTrigger`, nodes/access.ts): the published workflow that starts from it runs once for each
 * request made on the Access page or in its chat. One flow per instance: only the one an admin installed (the settings key
 * `access_requests` names it), and only while it is armed. A copy of the template from the gallery never handles a request, so
 * what an approver is shown is what the admin put there. Armed list cached for 5 seconds, as the cap-raise trigger.
 */
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { NodeItem } from '@landflow/sdk';
import { outsideRequest } from '../auth/context';
import { workflowForCall } from '../publish';
import { runWorkflow } from '../runner';
import { singleton } from '../singleton';
import { store } from '../store';

export const ACCESS_TRIGGER = 'core.accessRequestTrigger';
const CACHE_MS = 5_000;

export interface ArmedAccess {
  workflow: Workflow;
  node: WorkflowNode;
}

/** What the trigger's item holds: the request and the people who may decide it (no credential, no other person's data). */
export interface AccessRequestItem {
  requestId: string;
  entry: { id: string; name: string; system: string; targetLabel: string };
  requester: { id: string; name: string; email: string };
  account?: string;
  durationMinutes: number | null;
  durationText: string;
  reason: string;
  channel: 'form' | 'chat';
  /** Comma-separated emails of who may decide, never the requester. */
  approvers: string;
  /** Answer Choices for Ask a Person: the asked duration first, then the shorter ones ("60: 1 h\n15: 15 min"). */
  durationChoices: string;
  /** The text the approver reads. */
  summary: string;
}

const state = () => singleton('access-trigger', () => ({ armed: { at: 0, list: [] as ArmedAccess[] } }));

export function armedAccess(): ArmedAccess[] {
  const s = state();
  if (Date.now() - s.armed.at < CACHE_MS) return s.armed.list;
  const list: ArmedAccess[] = [];
  for (const saved of store.listWorkflows()) {
    if (!saved.active || !saved.nodes.some((n) => n.type === ACCESS_TRIGGER)) continue;
    const workflow = workflowForCall(saved.id, 'trigger') ?? saved;
    for (const node of workflow.nodes) if (node.type === ACCESS_TRIGGER && !node.disabled) list.push({ workflow, node });
  }
  s.armed = { at: Date.now(), list };
  return list;
}

/** The flow a request starts: the installed one when armed, else none. */
export const accessFlow = (installed?: string): ArmedAccess | undefined => (installed ? armedAccess().find((entry) => entry.workflow.id === installed) : undefined);

/** Start the flow's run with one item; resolves when the run has finished or is waiting for a person. */
export async function fireAccessRequest(entry: ArmedAccess, item: AccessRequestItem, executionId: string): Promise<{ workflowId: string; executionId: string; error?: string }> {
  const triggerItems: NodeItem[] = [{ json: item as unknown as NodeItem['json'] }];
  // The run is the flow's, not the requester's: it must not run as the person who asked.
  const record = await outsideRequest(() => runWorkflow({ workflow: entry.workflow, mode: 'trigger', startNodeId: entry.node.id, triggerItems, executionId }));
  return { workflowId: entry.workflow.id, executionId: record.executionId, ...(record.status === 'error' && { error: record.error?.message ?? 'The access flow failed' }) };
}

export function resetAccessTrigger() {
  state().armed = { at: 0, list: [] };
}
