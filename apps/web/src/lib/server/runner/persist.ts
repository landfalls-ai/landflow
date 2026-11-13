/**
 * Saving what a run did: progress writes that must not fail it, and the save settings that decide which executions are kept.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import type { WorkflowSettings } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { store } from '../store';
import { logger } from '../telemetry';

/** A write that keeps a run recoverable: if it fails, the run goes on (it only loses its checkpoint). */
export function saveProgress(write: () => void) {
  try {
    write();
  } catch (error) {
    logger.warn('could not save execution progress', { error });
  }
}

/** settings.save*Executions (default: keep). A waiting execution is always kept: it has to be resumed. */
function keepExecution(record: ExecutionRecord, settings: WorkflowSettings = {}): boolean {
  // Evaluation results link to their executions.
  if (record.status === 'waiting' || record.evaluation) return true;
  if (record.mode === 'manual' && settings.saveManualExecutions === false) return false;
  if (record.status === 'success' && settings.saveSuccessfulExecutions === false) return false;
  if (record.status === 'error' && settings.saveFailedExecutions === false) return false;
  return true;
}

export function persist(record: ExecutionRecord, settings: WorkflowSettings | undefined, keep = false) {
  if (!keep && !keepExecution(record, settings)) {
    // It may have been saved while it waited.
    store.deleteExecution(record.executionId);
    return;
  }
  // The resume state's run data duplicates the record's: keep one copy on disk.
  const saved = record.resumeState ? { ...record, resumeState: { ...record.resumeState, runData: {}, executionOrder: [] } } : record;
  store.saveExecution(saved);
}
