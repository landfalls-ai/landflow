import type { ExecutionRecord } from '../../shared/types';
import { unattendedTrigger } from '../agents/unattended';
import { store } from '../store';
import { getVersion } from '../versions';

/**
 * Wave ap1: the type of the first node a run executed, for a record saved before the wave (it has no `triggerType`). Its own graph,
 * else the saved version it started with, else the saved workflow; undefined when nothing can be read.
 */
export function derivedTrigger(record: ExecutionRecord): string | undefined {
  const first = record.executionOrder?.[0];
  if (!first) return undefined;
  const workflow = record.workflow ?? (record.versionId ? getVersion(record.workflowId, record.versionId)?.workflow : undefined) ?? store.getWorkflow(record.workflowId);
  return workflow?.nodes.find((n) => n.id === first || n.name === first)?.type;
}

/** The trigger a run is judged by: the one stamped on its record, else the one derived from its first node. */
export function recordTrigger(record: ExecutionRecord): string | undefined {
  return record.triggerType ?? derivedTrigger(record);
}

/** Whether a run begun by this trigger type can wait in Needs you: a known trigger that can wait, or the manual one. */
export function triggerCanWait(type: string | undefined): boolean {
  return Boolean(type) && (type === 'core.manualTrigger' || Boolean(unattendedTrigger(type!))) && type !== 'core.chatTrigger' && type !== 'core.mcpTrigger';
}
