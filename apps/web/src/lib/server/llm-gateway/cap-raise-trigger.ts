/**
 * Cap Raise Request (`core.capRaiseTrigger`, nodes/cap-raise.ts): the published workflow that starts from it runs once
 * for each request made on Insights → AI (docs/llm-gateway.md#asking-for-a-higher-cap). One cap-raise flow per instance:
 * only the one an admin installed (the settings key `ai_cap_raise` names it), and only while it is armed. No other
 * workflow with the trigger handles a request, so what the approver is shown is what the admin put there.
 *
 * Like On Usage Event (brain/usage-trigger.ts) the armed list is cached for 5 seconds. It is not a leader service: a
 * request starts its run on the process that took it.
 */
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { NodeItem } from '@landflow/sdk';
import { outsideRequest } from '../auth/context';
import { workflowForCall } from '../publish';
import { runWorkflow } from '../runner';
import { singleton } from '../singleton';
import { store } from '../store';

export const CAP_RAISE_TRIGGER = 'core.capRaiseTrigger';
const CACHE_MS = 5_000;

export interface ArmedCapRaise {
  workflow: Workflow;
  node: WorkflowNode;
}

/** What the trigger's item holds: the request, and the people who may decide it (no other person's data). */
export interface CapRaiseItem {
  requestId: string;
  capId: string;
  subject: string;
  metric: 'tokens' | 'cost';
  period: 'day' | 'month';
  current: number;
  requested: number;
  reason: string;
  requestedBy: { id: string; name: string };
  /** Comma-separated emails of the owners and admins other than the requester. */
  approvers: string;
}

const state = () => singleton('cap-raise-trigger', () => ({ armed: { at: 0, list: [] as ArmedCapRaise[] }, started: false }));

/** Published workflows with an enabled Cap Raise Request, re-read at most every 5 seconds. */
export function armedCapRaise(): ArmedCapRaise[] {
  const s = state();
  if (Date.now() - s.armed.at < CACHE_MS) return s.armed.list;
  const list: ArmedCapRaise[] = [];
  for (const saved of store.listWorkflows()) {
    if (!saved.active || !saved.nodes.some((n) => n.type === CAP_RAISE_TRIGGER)) continue;
    const workflow = workflowForCall(saved.id, 'trigger') ?? saved;
    for (const node of workflow.nodes) if (node.type === CAP_RAISE_TRIGGER && !node.disabled) list.push({ workflow, node });
  }
  s.armed = { at: Date.now(), list };
  return list;
}

/** The flow a request starts: the installed one (`installed`, the setup's workflow) when armed, else none. */
export function capRaiseFlow(installed?: string): ArmedCapRaise | undefined {
  if (!installed) return undefined;
  return armedCapRaise().find((entry) => entry.workflow.id === installed);
}

/** Start the flow's run with one item; resolves when the run has finished or is waiting for a person. */
export async function fireCapRaise(entry: ArmedCapRaise, item: CapRaiseItem): Promise<{ workflowId: string; executionId: string; error?: string }> {
  const triggerItems: NodeItem[] = [{ json: item as unknown as NodeItem['json'] }];
  // The run is the flow's, not the requester's: it must not run as the person who asked.
  const record = await outsideRequest(() => runWorkflow({ workflow: entry.workflow, mode: 'trigger', startNodeId: entry.node.id, triggerItems }));
  return { workflowId: entry.workflow.id, executionId: record.executionId, ...(record.status === 'error' && { error: record.error?.message ?? 'The cap-raise flow failed' }) };
}

/** Arm the cache (once per process). */
export function startCapRaiseTrigger() {
  const s = state();
  if (s.started) return;
  s.started = true;
  s.armed = { at: 0, list: [] };
}

/** Forget the cached list (tests, after the flow is installed or published). */
export function resetCapRaiseTrigger() {
  state().armed = { at: 0, list: [] };
}
