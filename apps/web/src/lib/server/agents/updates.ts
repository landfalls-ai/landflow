/**
 * AG21: "Alert triager v3 is available": test the production graph with the newer agent versions, then publish it.
 * Loaded lazily by lib/server/publish.ts and the test-update route (it needs the runner).
 */
import type { NodeItem } from '@landflow/protocol';
import type { NodeRun } from '@landflow/engine';
import { getPublication } from '../publications';
import { runWorkflow } from '../runner/run';
import { store } from '../store';
import { applyVersion, getVersion } from '../versions';
import { PublishError } from '../publish';
import { pinsFor, repinned, withPins } from './versions';

/** The trigger and the items of the last production run: what the test replays. */
async function lastInput(workflowId: string): Promise<{ nodeId: string; items?: NodeItem[] } | undefined> {
  for (const summary of store.listExecutions({ workflowId, limit: 50 })) {
    if (summary.mode === 'manual') continue;
    const record = await store.loadExecution(summary.id);
    if (!record) continue;
    const nodeId = record.executionOrder.find((id) => record.runData[id]?.some((run: NodeRun) => run.source === 'main'));
    if (!nodeId) continue;
    const first = record.runData[nodeId]!.find((run) => run.source === 'main');
    const items = first?.inputs[0];
    if (items?.length) return { nodeId, items };
  }
  return undefined;
}

/**
 * Run the production version's graph once, by hand, with these agents at their latest published versions. The trigger's
 * data is replayed from the last production run, else the trigger's pinned test data, else 409 `no_input`.
 */
export async function testUpdate(workflowId: string, agentIds: readonly string[], by?: string, signal?: AbortSignal): Promise<{ executionId: string; status: string }> {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new PublishError('Workflow not found', 404);
  const production = getPublication(workflowId);
  const base = production && getVersion(workflowId, production.versionId);
  if (!production || !base) throw new PublishError('This workflow is not published, so there is no production version to test', 409, { code: 'not_published' });
  const wanted = repinned(pinsFor(base.id), agentIds);
  const graph = withPins(applyVersion(workflow, base), wanted);
  const replay = await lastInput(workflowId);
  const targets = new Set(graph.connections.map((c) => c.target));
  const pinned = Object.keys(graph.pinData ?? {}).find((id) => !targets.has(id));
  if (!replay && !pinned) throw new PublishError('There is no input to test with: run the workflow once in production, or pin test data on its trigger', 409, { code: 'no_input' });
  const record = await runWorkflow({
    workflow: graph,
    mode: 'manual',
    startNodeId: replay?.nodeId ?? pinned,
    ...(replay?.items && { triggerItems: replay.items }),
    ...(by && { startedBy: by }),
    ...(signal && { signal }),
  });
  return { executionId: record.executionId, status: record.status };
}
