/**
 * A run's status, settled from its session on every read (no hook in the agent runtime): the process may have restarted
 * mid-run, or the run's tool approval may have been decided in the agent's session. Terminal statuses are final.
 */
import type { AgentSession } from '../../shared/agents';
import { OPEN_TASK_RUN_STATUSES, TASK_LIMITS, type TaskRun } from '../../shared/project-tasks';
import { isRunning } from '../agents/runtime';
import { agentStore } from '../agents/store';
import { patchRun } from './store';

const RUNNING_FRESH_MS = 10 * 60_000;
const APPROVED_GRACE_MS = 2 * 60_000;
export const RESTARTED = 'Landflow restarted before the run finished';

/** Cut a reply or error to the contract's length. */
export const cut = (text: string): string => (text.length > TASK_LIMITS.reply ? `${text.slice(0, TASK_LIMITS.reply - 1)}…` : text);

/** The agent's last answer in a session. */
export function lastReply(session: AgentSession): string | undefined {
  for (let i = session.timeline.length - 1; i >= 0; i--) {
    const entry = session.timeline[i];
    if (entry.type === 'assistant' && entry.text.trim()) return entry.text;
  }
  return undefined;
}

/** What went wrong in a session: its last error, or the notice a cap leaves. */
export function sessionProblem(session: AgentSession): string | undefined {
  for (let i = session.timeline.length - 1; i >= 0; i--) {
    const entry = session.timeline[i];
    if (entry.type === 'error') return entry.message;
    if (entry.type === 'notice' && entry.message.startsWith('Stopped: ')) return entry.message;
  }
  return undefined;
}

const finished = () => new Date().toISOString();

/** The run as it is now: open ones are looked at against their session and saved when it moved on. */
export function reconcileRun(run: TaskRun, now = Date.now()): TaskRun {
  if (!(OPEN_TASK_RUN_STATUSES as readonly string[]).includes(run.status) || run.status === 'requested') return run;
  const age = now - Date.parse(run.decidedAt ?? run.requestedAt);
  const lost = () => patchRun(run.id, { status: 'failed', error: RESTARTED, finishedAt: finished() }) ?? run;
  const session = run.sessionId ? agentStore.getSession(run.sessionId) : undefined;
  if (!run.sessionId || !session) {
    // The runner saves the session in its first moments: before that, give it a grace period.
    if (run.sessionId && isRunning(run.sessionId)) return run;
    return age > APPROVED_GRACE_MS ? lost() : run;
  }
  if (isRunning(session.id)) return run.status === 'running' ? run : (patchRun(run.id, { status: 'running' }) ?? run);
  switch (session.status) {
    case 'idle':
      return patchRun(run.id, { status: 'done', reply: cut(lastReply(session) ?? ''), finishedAt: finished() }) ?? run;
    case 'error':
      return patchRun(run.id, { status: 'failed', error: cut(sessionProblem(session) ?? 'The run failed'), finishedAt: finished() }) ?? run;
    case 'awaiting_approval':
      return run.status === 'waiting' ? run : (patchRun(run.id, { status: 'waiting' }) ?? run);
    default:
      // `running` in the saved session, but nothing runs it here: fresh if it was saved lately, else a restart ended it.
      return now - Date.parse(session.updatedAt) < RUNNING_FRESH_MS ? run : lost();
  }
}
