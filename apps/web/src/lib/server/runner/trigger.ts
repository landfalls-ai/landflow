import type { ExecutionRecord } from '../../shared/types';
import { unattendedTrigger } from '../agents/unattended';
import { store } from '../store';
import { MAX_WORKFLOW_DEPTH } from './types';
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

/** Stamped on a run whose start cannot be shown to come from a trigger that may wait (a parent that cannot be read, a type that is no trigger): not a trigger, so it never waits, and its refusal says `REFUSE_WHY.unknownOrigin`. */
export const UNKNOWN_ORIGIN = 'core.unknownOrigin';

/** How a record is looked up: the run's own record, live or saved (the agent node passes one that reads the live run first). */
export type FindRecord = (executionId: string) => ExecutionRecord | undefined;

/**
 * Wave ap1: what a run called by `parent` inherits: the hosted chat's refusal (`core.chatTrigger`) when the parent cannot be read or cannot wait
 * and is no editor's run, the MCP trigger's when it is an MCP call, else undefined. A parent from before the wave (no `triggerType`) is judged
 * by `recordTrigger`, so its own parent counts too (bounded by the nesting limit; past it, refuses).
 */
export function inheritedFrom(parent: ExecutionRecord | undefined, find: FindRecord = (id) => store.getExecution(id), depth = 0): string | undefined {
  if (!parent || depth > MAX_WORKFLOW_DEPTH) return UNKNOWN_ORIGIN;
  const editor = parent.mode === 'manual' || parent.mode === 'chat';
  const type = editor ? parent.triggerType : recordTrigger(parent, find, depth);
  if (parent.mode === 'mcp' || type === 'core.mcpTrigger') return 'core.mcpTrigger';
  if (type === 'core.chatTrigger') return 'core.chatTrigger';
  return !editor && !triggerCanWait(type) ? UNKNOWN_ORIGIN : undefined;
}

/**
 * The trigger a run is judged by: the one stamped on its record; else, for a sub-execution saved before the wave, the one its parent
 * hands down (a refusing parent (the hosted chat's or an unknown one) wins over the child's own first node, which is a workflow trigger that can wait); else the first node's type.
 */
export function recordTrigger(record: ExecutionRecord, find: FindRecord = (id) => store.getExecution(id), depth = 0): string | undefined {
  if (record.triggerType) return record.triggerType;
  if (record.parentExecutionId) {
    const inherited = inheritedFrom(find(record.parentExecutionId), find, depth + 1);
    if (inherited) return inherited;
  }
  return derivedTrigger(record);
}

/** Whether a run begun by this trigger type can wait in Needs you: a known trigger that can wait, or the manual one. */
export function triggerCanWait(type: string | undefined): boolean {
  return Boolean(type) && (type === 'core.manualTrigger' || Boolean(unattendedTrigger(type!))) && type !== 'core.chatTrigger' && type !== 'core.mcpTrigger';
}
