'use client';
/**
 * A project's Tasks tab (docs/projects-and-goals.md#the-tasks-tab-and-needs-you): a toolbar (status, Mine, New task), the
 * tasks grouped by status as rows on a desktop and cards on a phone, "Load more" for the next page, and the task dialog
 * (`?tab=tasks&task=<id>` opens it).
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { usePhone } from '@/lib/client/use-phone';
import { TASK_STATUS_LABELS, type ProjectTaskView, type TaskStatus } from '@/lib/shared/project-tasks';
import { TaskCard, TaskRow } from './task-row';
import { TaskDialog } from './task-dialog';
import { groupTasks } from './tasks-model';
import { fetchTask, useTasks } from './use-tasks';

type StatusFilter = TaskStatus | 'all';
const FILTERS: StatusFilter[] = ['all', 'todo', 'in_progress', 'blocked', 'done'];

const COLUMNS = ['Task', 'Assignee', 'Goal', 'Wake-up', 'Last run'];

export function TasksTab({ projectId }: { projectId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const phone = usePhone();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [mine, setMine] = useState(false);
  const { tasks, canCreate, error, hasMore, loadingMore, more, reload, replace } = useTasks(projectId, { status: status === 'all' ? undefined : status, mine });
  const openId = params.get('task') ?? undefined;
  const [creating, setCreating] = useState(false);
  const [linked, setLinked] = useState<ProjectTaskView>();

  const setOpen = (id?: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('tab', 'tasks');
    if (id) next.set('task', id);
    else next.delete('task');
    router.replace(`/projects/${encodeURIComponent(projectId)}?${next.toString()}`);
  };

  // A link names a task the list may not hold (another page, another filter): fetch it.
  const inList = tasks?.find((t) => t.id === openId);
  useEffect(() => {
    if (!openId || inList) return setLinked(undefined);
    let live = true;
    fetchTask(projectId, openId)
      .then((t) => live && setLinked(t))
      .catch(() => live && setOpen(undefined));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, projectId, Boolean(inList)]);
  const open = inList ?? (linked?.id === openId ? linked : undefined);

  const groups = useMemo(() => groupTasks(tasks ?? []), [tasks]);
  const onOpen = (t: ProjectTaskView) => setOpen(t.id);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          size="sm"
          options={FILTERS.map((f) => ({ value: f, label: f === 'all' ? 'All' : TASK_STATUS_LABELS[f] }))}
        />
        <Button size="sm" variant={mine ? 'primary' : 'outline'} aria-pressed={mine} className="max-md:min-h-[44px]" onClick={() => setMine((m) => !m)}>
          Mine
        </Button>
        {canCreate && (
          <Button size="sm" variant="primary" className="ml-auto max-md:min-h-[44px]" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> New task
          </Button>
        )}
      </div>

      <Card className="overflow-hidden p-0">
        {error ? (
          <EmptyState title="Tasks not available" hint={error} action={<Button size="sm" onClick={() => void reload()}>Try again</Button>} />
        ) : !tasks ? (
          <div className="px-4 py-6 text-[13px] text-t3">Loading…</div>
        ) : tasks.length === 0 ? (
          <EmptyState
            title={status !== 'all' || mine ? 'No tasks match' : 'No tasks yet'}
            hint={status !== 'all' || mine ? 'Change the filter to see more.' : canCreate ? 'A task is work with an assignee: an agent that wakes up on a schedule, or a person.' : undefined}
            action={canCreate && status === 'all' && !mine ? <Button size="sm" variant="primary" onClick={() => setCreating(true)}>New task</Button> : undefined}
          />
        ) : (
          <div>
            {!phone && (
              <div className="grid grid-cols-[minmax(0,1fr)_150px_140px_96px_170px] gap-3 border-b border-hair bg-sf2 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-t3" aria-hidden>
                {COLUMNS.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            )}
            {groups.map((g) => (
              <section key={g.status} aria-label={g.label}>
                <h3 className="border-b border-hair bg-sf2/60 px-4 py-1.5 text-[12px] font-semibold text-t2">
                  {g.label} <span className="font-normal text-t3">· {g.tasks.length}</span>
                </h3>
                {g.tasks.map((t) => (phone ? <TaskCard key={t.id} task={t} onOpen={onOpen} /> : <TaskRow key={t.id} task={t} onOpen={onOpen} />))}
              </section>
            ))}
          </div>
        )}
      </Card>
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" className="max-md:min-h-[44px]" onClick={() => void more()} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}

      {creating && <TaskDialog projectId={projectId} onClose={() => setCreating(false)} onChanged={() => void reload()} onDeleted={() => void reload()} />}
      {open && (
        <TaskDialog
          key={open.id}
          projectId={projectId}
          task={open}
          onClose={() => setOpen(undefined)}
          onChanged={(t) => {
            replace(t);
            void reload();
          }}
          onDeleted={() => void reload()}
        />
      )}
    </div>
  );
}
