/**
 * Rows of `scheduled_publishes` (migration 1840): a publish or unpublish at a chosen time. The logic is in
 * ./publish-schedule.ts; this file only reads and writes rows so the four-eyes module can clear a schedule when its
 * request is approved without importing the scheduler.
 */
import type { ScheduledPublish, ScheduledPublishStatus } from '../shared/publish';
import { database } from './db';

export interface ScheduleRow {
  id: string;
  workflow_id: string;
  action: 'publish' | 'unpublish';
  version_id: string | null;
  run_at: string;
  status: ScheduledPublishStatus;
  note: string | null;
  created_by: string | null;
  created_at: string;
  request_id: string | null;
  finished_at: string | null;
  result: string | null;
}

export function scheduleRow(id: string): ScheduleRow | undefined {
  return database().get<ScheduleRow>('SELECT * FROM scheduled_publishes WHERE id = ?', id);
}

export function saveScheduleRow(row: ScheduleRow) {
  database().upsert('scheduled_publishes', { ...row });
}

/** Schedules of a workflow (newest run time first), or the ones in `statuses` of every workflow. */
export function scheduleRows(options: { workflowId?: string; statuses?: ScheduledPublishStatus[]; limit?: number } = {}): ScheduleRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.workflowId) {
    clauses.push('workflow_id = ?');
    params.push(options.workflowId);
  }
  if (options.statuses?.length) {
    clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
    params.push(...options.statuses);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  return database().all<ScheduleRow>(`SELECT * FROM scheduled_publishes ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY run_at DESC, id DESC LIMIT ${limit}`, ...params);
}

/** The schedule an approved four-eyes request releases: from then on it waits for its time. Returns it when it changed. */
export function releaseScheduleAfterApproval(scheduleId: string): ScheduleRow | undefined {
  return database().transaction(() => {
    const row = scheduleRow(scheduleId);
    if (row?.status !== 'awaiting_approval') return undefined;
    const next = { ...row, status: 'pending' as const };
    saveScheduleRow(next);
    return next;
  });
}

export type { ScheduledPublish };
