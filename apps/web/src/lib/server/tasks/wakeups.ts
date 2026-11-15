/**
 * Project task wake-ups (docs/projects-and-goals.md#tasks): on a timer the leader finds the tasks whose wake-up is due and
 * asks for a run (a `requested` run, merged into one already open), then moves the schedule on. A wake-up only asks: no
 * agent runs here, a person's Approve starts it. The tick also settles runs a restart cut short.
 */
import { agentStore } from '../agents/store';
import { envInt } from '../config';
import { recordAudit } from '../audit';
import { singleton } from '../singleton';
import { instanceTimezone } from '../settings';
import { logger } from '../telemetry/logger';
import { nextWake } from './next-wake';
import { reconcileRun } from './reconcile';
import { dueTasks, requestRun, runsWith, setNextWake } from './store';
import { agentProblem } from './views';
import { getProject } from '../projects/store';

export { nextWake } from './next-wake';

const MAX_PER_TICK = 200;
const STALE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export const taskWakeups = singleton('task-wakeups', () => {
  let timer: NodeJS.Timeout | undefined;
  /** Task id to the day its problem was last logged (one line per task and day). */
  const logged = new Map<string, number>();

  /** Ask for the runs of every due task; returns how many new runs were requested. */
  function tick(at = new Date()): number {
    let requested = 0;
    for (const task of dueTasks(at.toISOString(), MAX_PER_TICK)) {
      if (task.assignee?.kind !== 'agent' || !task.wake) continue;
      const project = getProject(task.projectId);
      const problem = !project ? 'its project is gone' : agentProblem(task.assignee.id, project);
      const unpublished = !problem && !agentStore.get(task.assignee.id)?.published;
      if (problem || unpublished) {
        const day = Math.floor(at.getTime() / DAY_MS);
        if (logged.get(task.id) !== day) {
          logged.set(task.id, day);
          logger.warn('a task wake-up was not requested', { 'landflow.task.id': task.id, 'landflow.project.id': task.projectId, reason: problem ?? 'the agent is not published' });
        }
        continue;
      }
      const { run, merged } = requestRun(task, task.assignee.id, 'wake');
      if (!merged) {
        requested++;
        recordAudit({ action: 'project.task.run_requested', actor: 'system', target: { type: 'task', id: task.id, name: task.title }, project: task.projectId, summary: `A wake-up asked for a run of “${task.title}”`, details: { runId: run.id, agentId: run.agentId, reason: 'wake' } });
      }
      let next: string | undefined;
      try {
        next = nextWake(task.wake.cron, at, instanceTimezone())?.toISOString();
      } catch {
        next = undefined;
      }
      setNextWake(task.id, next ?? null);
    }
    // Runs a restart cut short: settled against their sessions.
    for (const run of runsWith(['approved', 'running', 'waiting'], MAX_PER_TICK, new Date(at.getTime() - STALE_MS).toISOString())) reconcileRun(run, at.getTime());
    return requested;
  }

  return {
    tick,
    /** Start the timer (every LANDFLOW_TASK_WAKEUP_SECONDS; 0 turns wake-ups off). */
    start() {
      const seconds = envInt('LANDFLOW_TASK_WAKEUP_SECONDS', { fallback: 60, min: 0, max: 3600 });
      if (timer || seconds === 0) return;
      timer = setInterval(() => {
        try {
          tick();
        } catch (error) {
          logger.warn('the task wake-up tick failed', { error });
        }
      }, seconds * 1_000);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    get running() {
      return timer !== undefined;
    },
  };
});
