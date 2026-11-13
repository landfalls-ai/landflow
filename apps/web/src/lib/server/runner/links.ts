/**
 * What follows a stretch of a run: arming its wait, handing a sub-execution's result to its parent, the error workflow
 * and failure alerts.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { JsonObject } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { notifyFailure } from '../alerts/service';
import { workflowForCall } from '../publish';
import { store } from '../store';
import { fireTrigger, logger } from '../telemetry';
import { waits } from '../waits';
import { eachWaitOf, openChildren, settleChildren } from '../sub-executions';
import { clusterActive } from '../cluster/state';
import { refreshRows } from '../db/replication';
import { ERROR_TRIGGER } from './types';
import { live, finishedChildren, publicUrl } from './state';
import { lastNodeItems } from './live';
import { runWorkflow } from './run';
import { type ResumeRequest, resumeExecution } from './resume';

/** After a stretch of a run: arm its wait, hand a sub-execution's result to its parent, start the error workflow. */
export function afterRun(record: ExecutionRecord, workflow: Workflow | undefined) {
  if (record.status === 'waiting') {
    waits.track(record);
    // Waiting for a sub-execution that already finished (it ran on while this run was suspending).
    const childId = record.wait?.resume === 'subworkflow' ? String(record.wait.data?.executionId ?? '') : '';
    const child = childId ? finishedChildren.get(childId) : undefined;
    if (child) {
      finishedChildren.delete(childId);
      resumeParent(record.executionId, child);
    }
    // "Each item" mode: the children that finished on the way (kept here), and those whose word got lost (their saved records).
    if (eachWaitOf(record)) void settleChildren(record.executionId, openChildren(record).flatMap((id) => finishedChildren.get(id) ?? []), { sweep: true });
    dropFinishedChildren(record.executionId);
    return;
  }
  dropFinishedChildren(record.executionId);
  if (record.parentExecutionId) handOverToParent(record);
  // An automatic retry follows: the error workflow waits for the last attempt.
  if (record.status === 'error' && workflow && !record.retryAt) void runErrorWorkflow(record, workflow);
  // Failure alerts (Settings → Alerts), on the same terms: not while an automatic retry is pending.
  if (record.status === 'error' && !record.retryAt) notifyFailure(record, workflow);
}

/** Children kept for a parent that didn't wait for them (Execute Workflow without "wait for completion"). */
function dropFinishedChildren(parentId: string) {
  for (const [id, child] of finishedChildren) if (child.parentExecutionId === parentId) finishedChildren.delete(id);
}

/** A sub-execution finished: resume the parent if it waits for it. */
function handOverToParent(child: ExecutionRecord) {
  const parentId = child.parentExecutionId!;
  // Queue mode: the parent may run (or wait) in another process.
  if (clusterActive() && !live.has(parentId)) {
    void handOverAcross(child, parentId);
    return;
  }
  const parent = store.getExecution(parentId);
  if (parent?.status === 'waiting' && parent.wait?.resume === 'subworkflow' && parent.wait.data?.executionId === child.executionId) {
    resumeParent(parentId, child);
  } else if (eachWaitOf(parent)) {
    void settleChildren(parentId, [child]);
  } else if (live.has(parentId)) {
    finishedChildren.set(child.executionId, child);
  }
}

/** Queue mode: wait (up to a minute) for a parent still running elsewhere to start waiting for this child, then resume it. */
async function handOverAcross(child: ExecutionRecord, parentId: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (live.has(parentId)) {
      finishedChildren.set(child.executionId, child);
      return;
    }
    await refreshRows('executions', { id: parentId }).catch(() => {});
    const parent = store.getExecution(parentId);
    if (parent?.status === 'waiting') {
      if (parent.wait?.resume === 'subworkflow' && parent.wait.data?.executionId === child.executionId) resumeParent(parentId, child);
      else if (eachWaitOf(parent)) await settleChildren(parentId, [child]);
      return;
    }
    if (parent?.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function resumeParent(parentId: string, child: ExecutionRecord) {
  const request: ResumeRequest =
    child.status === 'success'
      ? { kind: 'subworkflow', outputs: [lastNodeItems(child)] }
      : {
          kind: 'subworkflow',
          error:
            child.status === 'canceled'
              ? `The sub-workflow was canceled (execution ${child.executionId})`
              : `Sub-workflow failed: ${child.error?.message ?? 'unknown error'} (execution ${child.executionId})`,
        };
  // Its own trace, like any resume: not a child of whatever span is active now.
  void context
    .with(ROOT_CONTEXT, () => resumeExecution(parentId, request))
    .catch((error) => logger.warn('could not resume the parent execution', { 'landflow.execution.id': parentId, error: (error as Error).message }));
}

/** n8n's Error Trigger item for a failed execution. */
export function errorItem(failed: ExecutionRecord, workflow: Pick<Workflow, 'id' | 'name'>): JsonObject {
  const lastNode = failed.error?.nodeName ?? (failed.lastNodeId ? failed.nodeNames?.[failed.lastNodeId] : undefined);
  return {
    execution: {
      id: failed.executionId,
      url: `${publicUrl()}/workflows/${workflow.id}/executions/${failed.executionId}`,
      error: { message: failed.error?.message ?? 'Unknown error' },
      ...(lastNode && { lastNodeExecuted: lastNode }),
      mode: failed.mode,
      ...(failed.rerunOf && { retryOf: failed.rerunOf.executionId }),
    },
    workflow: { id: workflow.id, name: workflow.name },
  };
}

/** settings.errorWorkflowId: run that workflow's Error Trigger for a failed, non-manual execution. */
async function runErrorWorkflow(failed: ExecutionRecord, workflow: Workflow) {
  const errorWorkflowId = workflow.settings?.errorWorkflowId;
  // Never for manual runs, never for itself, and an error workflow's own failure doesn't start another one.
  if (!errorWorkflowId || errorWorkflowId === workflow.id || failed.mode === 'manual' || failed.errorOf) return;
  // Its published version (draft and publish), or the saved workflow when it was never published.
  const target = workflowForCall(errorWorkflowId, failed.mode);
  const trigger = target?.nodes.find((node) => node.type === ERROR_TRIGGER && !node.disabled);
  if (!target || !trigger) {
    logger.warn('error workflow not run', { 'landflow.workflow.id': workflow.id, reason: target ? 'it has no Error Trigger' : `workflow ${errorWorkflowId} not found` });
    return;
  }
  try {
    await context.with(ROOT_CONTEXT, () =>
      fireTrigger({ source: 'error', workflowId: target.id, nodeName: trigger.name }, () =>
        runWorkflow({ workflow: target, mode: 'trigger', startNodeId: trigger.id, triggerItems: [{ json: errorItem(failed, workflow) }], errorOf: failed.executionId }),
      ),
    );
  } catch (error) {
    logger.warn('error workflow failed to start', { 'landflow.workflow.id': target.id, error: (error as Error).message });
  }
}
