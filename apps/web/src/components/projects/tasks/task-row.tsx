'use client';
/** One task in the list: a row on a desktop, a card on a phone (docs/projects-and-goals.md#the-tasks-tab-and-needs-you). */
import { Bot, User } from 'lucide-react';
import { timeAgo } from '@/lib/client/format';
import { TASK_PRIORITY_LABELS, type ProjectTaskView } from '@/lib/shared/project-tasks';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { lastRun, RUN_LABELS, RUN_TONES, untilText } from './tasks-model';

function Assignee({ task }: { task: ProjectTaskView }) {
  if (!task.assignee) return <span className="text-t3">Unassigned</span>;
  const Icon = task.assignee.kind === 'agent' ? Bot : User;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-t2">
      <Icon className="size-3.5 shrink-0 text-t3" aria-hidden />
      <span className="truncate">{task.assigneeName ?? (task.assignee.kind === 'agent' ? 'Removed agent' : 'Removed person')}</span>
    </span>
  );
}

function LastRun({ task }: { task: ProjectTaskView }) {
  const run = lastRun(task);
  if (!run) return <span className="text-t3">No runs</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge tone={RUN_TONES[run.status]}>{RUN_LABELS[run.status]}</Badge>
      <span className="text-[12px] text-t3">{timeAgo(run.finishedAt ?? run.decidedAt ?? run.requestedAt)}</span>
    </span>
  );
}

function Priority({ task }: { task: ProjectTaskView }) {
  if (task.priority === 'normal') return null;
  return <Badge tone={task.priority === 'high' ? 'danger' : 'muted'}>{TASK_PRIORITY_LABELS[task.priority]}</Badge>;
}

const WAKE_TITLE = (task: ProjectTaskView) => (task.wake ? `Wake-up: ${task.wake.cron}` : undefined);

/** The desktop row: title with priority, assignee, goal, next wake-up, last run. */
export function TaskRow({ task, onOpen }: { task: ProjectTaskView; onOpen: (task: ProjectTaskView) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      className="grid w-full grid-cols-[minmax(0,1fr)_150px_140px_96px_170px] items-center gap-3 border-b border-hair px-4 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-acdim/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ac"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-t1">{task.title}</span>
        <Priority task={task} />
        {task.checkedOutByName && <span className="shrink-0 text-[11px] text-t3">· held by {task.checkedOutByName}</span>}
      </span>
      <Assignee task={task} />
      <span className="truncate text-t2">{task.goalTitle ?? <span className="text-t3">No goal</span>}</span>
      <span className="text-t2" title={WAKE_TITLE(task)}>
        {task.nextWakeAt ? untilText(task.nextWakeAt) : <span className="text-t3">—</span>}
      </span>
      <LastRun task={task} />
    </button>
  );
}

/** The phone card: title and chips, the assignee, the last run; the whole card is one 44 px+ target. */
export function TaskCard({ task, onOpen }: { task: ProjectTaskView; onOpen: (task: ProjectTaskView) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      className={cn('flex min-h-[44px] w-full flex-col gap-1.5 border-b border-hair px-4 py-3 text-left text-[13px] last:border-b-0 active:bg-acdim/60')}
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-t1">{task.title}</span>
        <Priority task={task} />
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Assignee task={task} />
        {task.nextWakeAt && (
          <span className="text-[12px] text-t3" title={WAKE_TITLE(task)}>
            Wakes {untilText(task.nextWakeAt)}
          </span>
        )}
        {task.goalTitle && <span className="truncate text-[12px] text-t3">{task.goalTitle}</span>}
      </span>
      <LastRun task={task} />
    </button>
  );
}
