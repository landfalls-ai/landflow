/**
 * Scheduled evaluation runs: a cron on the Evaluations tab (`evaluation_settings`, ./store.ts) starts the workflow's
 * evaluation by itself, in the schedule's time zone (default the workflow's, else the instance's). A leader service: in queue
 * mode exactly one main evaluates the crons (bootstrap `leaderService`), and the run goes on in that process.
 * The cron is checked once a minute (five fields; six with seconds first fire in the matching second of the minute's tick
 * only when it is zero, so use five); a run that is still going makes the next start wait for the following match.
 */
import type { EvaluationSchedule } from '../../shared/evaluations';
import { parseCron, timeParts } from '../agents/cron';
import { singleton } from '../singleton';
import { instanceTimezone } from '../settings';
import { store } from '../store';
import { logger } from '../telemetry';
import { evaluationTriggerOf } from './dataset';
import { EvaluationError, startEvaluationRun } from './runner';
import { getSettings, saveSettings, scheduledWorkflows } from './store';

const TICK_MS = 15_000;

/** Whether a schedule's cron is valid (the message says what is wrong). */
export function checkSchedule(schedule: Pick<EvaluationSchedule, 'cron' | 'timezone'>): string | undefined {
  try {
    const cron = parseCron(schedule.cron);
    if (cron.seconds) return 'Use five fields (minute hour day-of-month month day-of-week): scheduled evaluations are checked once a minute';
    if (schedule.timezone) new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone });
    return undefined;
  } catch (error) {
    return error instanceof RangeError ? `Unknown time zone “${schedule.timezone}”` : (error as Error).message;
  }
}

/** The next time (ISO) the cron fires after `from`, looking up to a year ahead; undefined when it never does. */
export function nextRun(schedule: Pick<EvaluationSchedule, 'cron' | 'timezone'>, from = new Date(), defaultZone = instanceTimezone()): string | undefined {
  try {
    const cron = parseCron(schedule.cron);
    const zone = schedule.timezone || defaultZone;
    const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const at = new Date(start + i * 60_000);
      if (cron.matches({ ...timeParts(at, zone), second: 0 })) return at.toISOString();
    }
  } catch {
    // An invalid cron has no next run.
  }
  return undefined;
}

export const evaluationSchedules = singleton('evaluation-schedules', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastMinute = '';
  const starting = new Set<string>();

  /** Start the runs whose cron matches the minute of `now`. */
  async function tick(now = new Date()): Promise<string[]> {
    const minute = now.toISOString().slice(0, 16);
    if (minute === lastMinute) return [];
    lastMinute = minute;
    const started: string[] = [];
    for (const { workflowId, schedule } of scheduledWorkflows()) {
      const workflow = store.getWorkflow(workflowId);
      if (!workflow || starting.has(workflowId)) continue;
      const zone = schedule.timezone || workflow.settings?.timezone?.trim() || instanceTimezone();
      let due = false;
      try {
        due = parseCron(schedule.cron).matches({ ...timeParts(now, zone), second: 0 });
      } catch (error) {
        record(workflowId, { lastError: `Invalid schedule: ${(error as Error).message}` });
        continue;
      }
      if (!due) continue;
      starting.add(workflowId);
      try {
        if (!evaluationTriggerOf(workflow)) throw new EvaluationError('The workflow has no Evaluation Trigger');
        const run = await startEvaluationRun(workflowId, { workflow, trigger: 'schedule', ...(schedule.maxRows && { maxRows: schedule.maxRows }) });
        record(workflowId, { lastRunAt: run.startedAt, lastRunId: run.id }, true);
        started.push(run.id);
      } catch (error) {
        // "Already running": the previous scheduled run is still going; the next match tries again.
        record(workflowId, { lastError: (error as Error).message });
        logger.warn('scheduled evaluation not started', { 'landflow.workflow.id': workflowId, error: (error as Error).message });
      } finally {
        starting.delete(workflowId);
      }
    }
    return started;
  }

  /** Remember the outcome on the schedule (`clearError`: a start worked). */
  function record(workflowId: string, patch: Partial<EvaluationSchedule>, clearError = false) {
    const settings = getSettings(workflowId);
    if (!settings.schedule) return;
    const { lastError: _old, ...rest } = settings.schedule;
    saveSettings(workflowId, { ...settings, schedule: { ...(clearError ? rest : settings.schedule), ...patch } });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch((error: Error) => logger.warn('evaluation schedule check failed', { error: error.message })), TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    /** Start what is due at `now` (tests pass a clock). */
    tick,
  };
});
