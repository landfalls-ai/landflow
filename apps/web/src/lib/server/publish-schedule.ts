/**
 * Scheduled publishes: publish a saved version (or unpublish) at a chosen time. A schedule is a row in
 * `scheduled_publishes` (./publish-schedule-store.ts), so it survives restarts and is "re-armed" by reading the table:
 * a ticker looks for due rows every few seconds. It runs on the leader in queue mode and on the single host otherwise
 * (bootstrap `leaderService`); rows still pending after a restart or a leader change run as soon as someone ticks.
 * A schedule that is overdue by more than `LATE_MS` still runs (the publish is what was asked for), noting how late it was.
 *
 * What runs is `publishVersion()` / `unpublishWorkflow()` (./publish.ts), the one code that publishes, so governance
 * (nodes the policy blocks) and the audit log apply as for a click. Four-eyes publishing: scheduling creates a publish
 * request (governance/approvals.ts) that carries the schedule; approving it only releases the schedule, which then goes
 * live at its time with the requester as publisher. A schedule made while four-eyes was off, whose time comes after
 * it was switched on, becomes a publish request instead of going live (status `requested`).
 */
import { nanoid } from 'nanoid';
import { can } from '../shared/auth';
import type { ScheduledPublish } from '../shared/publish';
import { recordAudit } from './audit';
import { userNames, type UserRecord } from './auth/users';
import { ApprovalError, fourEyesApplies, getRequest, requestPublish } from './governance/approvals';
import { publishBlockedReason } from './governance/policy';
import { publishedVersionId } from './publications';
import { PublishError, publishVersion, unpublishWorkflow } from './publish';
import { type ScheduleRow, saveScheduleRow, scheduleRow, scheduleRows } from './publish-schedule-store';
import { singleton } from './singleton';
import { store } from './store';
import { logger } from './telemetry/logger';
import { getVersion, recordVersion, versionFor } from './versions';
import { HttpError } from './errors';

const TICK_MS = 5_000;
/** A schedule can be set at most this far ahead (a year). */
const MAX_AHEAD_MS = 366 * 24 * 3600_000;

export class ScheduleError extends HttpError {
  static readonly errorName: string = 'ScheduleError';
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

function view(row: ScheduleRow, names = userNames()): ScheduledPublish {
  const workflow = store.getWorkflow(row.workflow_id);
  const version = row.version_id ? getVersion(row.workflow_id, row.version_id) : undefined;
  return {
    id: row.id,
    workflowId: row.workflow_id,
    ...(workflow && { workflowName: workflow.name }),
    action: row.action,
    ...(row.version_id && { versionId: row.version_id }),
    ...(version && { versionNumber: version.number }),
    runAt: row.run_at,
    status: row.status,
    ...(row.note && { note: row.note }),
    ...(row.created_by && { createdBy: row.created_by }),
    ...(row.created_by && names.get(row.created_by) && { createdByName: names.get(row.created_by) }),
    createdAt: row.created_at,
    ...(row.request_id && { requestId: row.request_id }),
    ...(row.finished_at && { finishedAt: row.finished_at }),
    ...(row.result && { result: row.result }),
  };
}

function audit(action: string, row: ScheduleRow, summary: string, outcome: 'success' | 'failure' = 'success', system = false) {
  const workflow = store.getWorkflow(row.workflow_id);
  recordAudit({
    action,
    outcome,
    ...(system && { actor: 'system' as const }),
    target: { type: 'workflow', id: row.workflow_id, ...(workflow && { name: workflow.name }) },
    summary,
    details: { scheduleId: row.id, publishAction: row.action, versionId: row.version_id, runAt: row.run_at, requestId: row.request_id },
  });
}

/** Parse `at` (a Date, ISO text or epoch milliseconds) and check it lies ahead. */
export function parseRunAt(at: string | number | Date, now = Date.now()): Date {
  const date = at instanceof Date ? at : typeof at === 'number' ? new Date(at) : new Date(/^\d+$/.test(at) ? Number(at) : at);
  if (Number.isNaN(date.getTime())) throw new ScheduleError('`at` is not a date and time (use ISO 8601, such as 2026-11-02T09:00:00Z)');
  if (date.getTime() <= now) throw new ScheduleError('`at` has to be in the future');
  if (date.getTime() > now + MAX_AHEAD_MS) throw new ScheduleError('`at` is more than a year ahead');
  return date;
}

export interface ScheduleAsk {
  workflowId: string;
  action: 'publish' | 'unpublish';
  at: string | number | Date;
  /** The saved version to publish (default: the saved draft, as it is now). */
  versionId?: string;
  note?: string;
  by?: string;
}

/** Schedule a publish or unpublish. With four-eyes publishing on this also files the request that approves it. */
export function schedulePublish(ask: ScheduleAsk): ScheduledPublish {
  const workflow = store.getWorkflow(ask.workflowId);
  if (!workflow) throw new ScheduleError('Workflow not found', 404);
  const runAt = parseRunAt(ask.at);
  let versionId: string | undefined;
  if (ask.action === 'publish') {
    const summary = ask.versionId ? { id: ask.versionId } : (versionFor(workflow) ?? recordVersion(workflow));
    const full = summary && getVersion(workflow.id, summary.id);
    if (!full) throw new ScheduleError(ask.versionId ? 'Version not found' : 'This workflow has no saved version to publish: save it first', ask.versionId ? 404 : 409);
    const blocked = publishBlockedReason(full.workflow);
    if (blocked) throw new ScheduleError(blocked, 422);
    versionId = full.id;
  }
  const duplicate = scheduleRows({ workflowId: workflow.id, statuses: ['pending', 'awaiting_approval'] }).find((r) => r.action === ask.action && r.version_id === (versionId ?? null) && r.run_at === runAt.toISOString());
  if (duplicate) return view(duplicate);
  const row: ScheduleRow = {
    id: `sp_${nanoid(12)}`,
    workflow_id: workflow.id,
    action: ask.action,
    version_id: versionId ?? null,
    run_at: runAt.toISOString(),
    status: 'pending',
    note: ask.note?.trim() || null,
    created_by: ask.by ?? null,
    created_at: new Date().toISOString(),
    request_id: null,
    finished_at: null,
    result: null,
  };
  if (fourEyesApplies(ask.action === 'unpublish' ? 'unpublish' : 'publish', workflow.id)) {
    try {
      const request = requestPublish({ workflowId: workflow.id, action: ask.action, versionId, note: ask.note, by: ask.by, schedule: { id: row.id, at: row.run_at } });
      row.request_id = request.id;
      row.status = 'awaiting_approval';
    } catch (error) {
      if (error instanceof ApprovalError) throw new ScheduleError(error.message, error.status);
      throw error;
    }
  }
  saveScheduleRow(row);
  audit('publish_schedule.create', row, `Scheduled a ${row.action} of “${workflow.name}” for ${row.run_at}${row.status === 'awaiting_approval' ? ' (waits for approval)' : ''}`);
  return view(row);
}

/** Schedules waiting on a four-eyes request that was rejected, withdrawn or went stale are canceled. */
function reconcile(rows: ScheduleRow[]): ScheduleRow[] {
  return rows.map((row) => {
    if (row.status !== 'awaiting_approval') return row;
    const request = row.request_id ? getRequest(row.request_id) : undefined;
    // `approved` releases the schedule in approveRequest; seeing it here means the release was missed.
    if (request?.status === 'pending') return row;
    const next: ScheduleRow = request?.status === 'approved' ? { ...row, status: 'pending' } : { ...row, status: 'canceled', finished_at: new Date().toISOString(), result: request ? `The approval request was ${request.status === 'stale' ? 'out of date' : request.status}` : 'The approval request is gone' };
    saveScheduleRow(next);
    if (next.status === 'canceled') audit('publish_schedule.cancel', next, `Scheduled ${row.action} canceled: ${next.result}`, 'success', true);
    return next;
  });
}

/** A workflow's schedules (pending first, then recent), or every pending one. */
export function listSchedules(options: { workflowId?: string; pending?: boolean; limit?: number } = {}): ScheduledPublish[] {
  const rows = reconcile(scheduleRows({ workflowId: options.workflowId, statuses: options.pending ? ['pending', 'awaiting_approval', 'running'] : undefined, limit: options.limit }));
  const live = rows.filter((r) => r.status === 'pending' || r.status === 'awaiting_approval' || r.status === 'running').sort((a, b) => a.run_at.localeCompare(b.run_at));
  const past = rows.filter((r) => !live.includes(r));
  const names = userNames();
  return [...live, ...past].map((row) => view(row, names));
}

export function getSchedule(id: string): ScheduledPublish | undefined {
  const row = scheduleRow(id);
  return row && view(reconcile([row])[0]);
}

/** Cancel a schedule that has not run: its creator, or an owner or admin. Withdraws its approval request too. */
export function cancelSchedule(id: string, user: Pick<UserRecord, 'id' | 'role'>, workflowId?: string): ScheduledPublish {
  const row = scheduleRow(id);
  if (!row || (workflowId && row.workflow_id !== workflowId)) throw new ScheduleError('Scheduled publish not found', 404);
  if (row.status !== 'pending' && row.status !== 'awaiting_approval') throw new ScheduleError(`This schedule is already ${row.status}`, 409);
  if (user.id !== row.created_by && !can(user, 'settings:manage')) throw new ScheduleError('Only who scheduled it, or an owner or admin, can cancel it', 403);
  const next: ScheduleRow = { ...row, status: 'canceled', finished_at: new Date().toISOString(), result: `Canceled by ${userNames().get(user.id) ?? user.id}` };
  saveScheduleRow(next);
  if (row.request_id) {
    // The request is withdrawn along with it (it may be decided already: then there is nothing to withdraw).
    void import('./governance/approvals').then((m) => {
      try {
        m.cancelRequest(row.request_id!, user);
      } catch {
        // decided or gone
      }
    });
  }
  audit('publish_schedule.cancel', next, `Canceled the scheduled ${row.action}`);
  return view(next);
}

/** Run one due row: publish, unpublish, or (four-eyes switched on since) ask for approval. */
async function run(row: ScheduleRow, now: Date): Promise<ScheduleRow> {
  const finish = (changes: Partial<ScheduleRow>): ScheduleRow => {
    const next = { ...row, ...changes, finished_at: new Date().toISOString() };
    saveScheduleRow(next);
    return next;
  };
  const workflow = store.getWorkflow(row.workflow_id);
  if (!workflow) return finish({ status: 'canceled', result: 'The workflow was deleted' });
  const late = now.getTime() - Date.parse(row.run_at);
  const how = late > 60_000 ? `, ${Math.round(late / 60_000)} min late` : '';
  const note = [row.note, `scheduled for ${row.run_at}${how}`].filter(Boolean).join(' — ');
  try {
    if (!row.request_id && fourEyesApplies(row.action === 'unpublish' ? 'unpublish' : 'publish', workflow.id)) {
      const request = requestPublish({ workflowId: workflow.id, action: row.action, versionId: row.version_id ?? undefined, note: row.note ?? undefined, by: row.created_by ?? 'system' });
      const next = finish({ status: 'requested', request_id: request.id, result: 'Four-eyes publishing is on: it became a publish request' });
      audit('publish_schedule.run', next, `Scheduled ${row.action} became a publish request (four-eyes publishing is on)`, 'success', true);
      return next;
    }
    const by = row.created_by ?? undefined;
    if (row.action === 'unpublish') {
      if (!publishedVersionId(workflow.id) && !workflow.active) {
        const next = finish({ status: 'done', result: 'It was not published' });
        audit('publish_schedule.run', next, 'Scheduled unpublish: nothing was published', 'success', true);
        return next;
      }
      await unpublishWorkflow(workflow.id, by, note);
    } else if (publishedVersionId(workflow.id) === row.version_id) {
      const next = finish({ status: 'done', result: 'That version was live already' });
      audit('publish_schedule.run', next, 'Scheduled publish: the version was live already', 'success', true);
      return next;
    } else {
      await publishVersion(workflow.id, row.version_id!, by, note);
    }
    const next = finish({ status: 'done', result: late > 60_000 ? `Ran ${Math.round(late / 60_000)} min late` : null });
    audit('publish_schedule.run', next, `Scheduled ${row.action} of “${workflow.name}” ran`, 'success', true);
    return next;
  } catch (error) {
    const message = (error as Error).message;
    const next = finish({ status: 'failed', result: message });
    audit('publish_schedule.run', next, `Scheduled ${row.action} failed: ${message}`, 'failure', true);
    if (!(error instanceof PublishError || error instanceof ApprovalError)) logger.warn('a scheduled publish failed', { error, 'landflow.workflow.id': row.workflow_id });
    return next;
  }
}

export const publishSchedules = singleton('publish-schedules', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  /** Run what is due at `now` (tests pass a clock). Returns the schedules that ran. */
  async function tick(now = new Date()): Promise<ScheduledPublish[]> {
    if (ticking) return [];
    ticking = true;
    try {
      reconcile(scheduleRows({ statuses: ['awaiting_approval'] }));
      const due = scheduleRows({ statuses: ['pending'], limit: 100 })
        .filter((row) => row.run_at <= now.toISOString())
        .sort((a, b) => a.run_at.localeCompare(b.run_at));
      const ran: ScheduledPublish[] = [];
      for (const row of due) {
        // Claim it: a second ticker (a leader change, a test) must not run it again.
        const claimed = scheduleRow(row.id);
        if (claimed?.status !== 'pending') continue;
        saveScheduleRow({ ...claimed, status: 'running' });
        ran.push(view(await run(claimed, now)));
      }
      return ran;
    } finally {
      ticking = false;
    }
  }

  /** Rows a crashed process left `running` ran or not: they are retried once the process that held them is gone. */
  function recover() {
    for (const row of scheduleRows({ statuses: ['running'] })) saveScheduleRow({ ...row, status: 'pending' });
  }

  return {
    /** Start the ticker; schedules left running by a crash are picked up again, and overdue ones run right away. */
    start() {
      if (timer) return;
      recover();
      timer = setInterval(() => void tick().catch((error: Error) => logger.warn('scheduled publish check failed', { error: error.message })), TICK_MS);
      timer.unref?.();
      void tick().catch((error: Error) => logger.warn('scheduled publish check failed', { error: error.message }));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
});
