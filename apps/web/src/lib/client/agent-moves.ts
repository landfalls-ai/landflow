/**
 * AG17: the editor's side of "a Run an Agent node follows its agent" (docs/agents.md#from-workflows). On open, a tab that holds the
 * edit lock and loads a flow that still wires sub-nodes into a bound node posts the move (`POST /api/workflows/:id/agent-moves`
 * with the loaded `updatedAt`, as the person); the server's start pass moves the flows nobody opens. No store, no server import.
 */
import type { Workflow } from '@landflow/engine';
import { api, ApiError } from '@/lib/client/api';
import { MOVES_CHANGED, hasWiredOverrides, type AgentMove, type AgentMoveResult } from '@/lib/shared/agent-bubbles';

export { MOVES_CHANGED };

/** The record of a flow, newest first (each moved item's state read against its agent now). */
export const readMoves = async (workflowId: string): Promise<AgentMove[]> => (await api<{ moves: AgentMove[] }>(`/api/workflows/${workflowId}/agent-moves`, { background: true })).moves;

/** Tell the canvas (AG16's bubbles) and the notice that the flow's moves changed. */
export function announceMoves(workflowId: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(MOVES_CHANGED, { detail: { workflowId } }));
}

/** A person's choice or a retry on kept items: the same route, only these sub-nodes, `resolve` for "Use … everywhere". */
export async function moveNow(workflow: Pick<Workflow, 'id' | 'updatedAt'>, request: { subNodeIds?: string[]; resolve?: Record<string, 'useEverywhere'> } = {}): Promise<AgentMoveResult> {
  const result = await api<AgentMoveResult>(`/api/workflows/${workflow.id}/agent-moves`, { method: 'POST', json: { ...(workflow.updatedAt && { updatedAt: workflow.updatedAt }), ...request } });
  announceMoves(workflow.id);
  return result;
}

/**
 * On open: move the flow's own wiring into its agents, when it has any and this tab may edit (`holdsLock` resolves true when it does).
 * A 412 (the flow was saved meanwhile) reloads it and tries once more. Answers the result when something moved, else nothing.
 */
export async function moveOnOpen(workflow: Workflow, holdsLock: () => Promise<boolean> = () => Promise.resolve(true)): Promise<AgentMoveResult | undefined> {
  if (!hasWiredOverrides(workflow) || !(await holdsLock())) return undefined;
  let current = workflow;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await moveNow(current);
      return result.moved.length ? result : undefined;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 412 || attempt === 1) return undefined;
      current = (await api<{ workflow: Workflow }>(`/api/workflows/${workflow.id}`, { background: true })).workflow;
      if (!hasWiredOverrides(current)) return undefined;
    }
  }
  return undefined;
}
