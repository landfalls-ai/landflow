'use client';
/**
 * A task in a dialog (a bottom sheet on a phone): its fields, an agent's wake-up, check out and release, "Ask to run now",
 * and the last runs with Approve and Deny. Editors change it; everyone else reads it as text. A server message about a
 * field shows under that field (docs/projects-and-goals.md#the-tasks-tab-and-needs-you).
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { useViewer } from '@/components/auth/viewer';
import { GoalPicker } from '@/components/goals/goal-picker';
import { useGoals, usePeople } from '@/components/goals/use-goals';
import { filterTree } from '@/components/goals/tree';
import { Dialog, Field } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { Input, Select, Textarea } from '@/components/ui/inputs';
import { Segmented } from '@/components/ui/segmented';
import { TaskActions } from '@/components/run-trace/needs-you-actions';
import {
  TASK_LIMITS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type ProjectTaskInput,
  type ProjectTaskView,
  type TaskPriority,
  type TaskRun,
  type TaskStatus,
} from '@/lib/shared/project-tasks';
import { cronPreset, presetCron, WAKE_NOTE, WAKE_PRESET_LABELS, WAKE_PRESETS, type WakePreset } from './schedule';
import { assigneeValue, fieldOfSaveError, missingAssigneeOption, parseAssignee, RUN_LABELS, RUN_TONES, untilText, type TaskField } from './tasks-model';
import { askToRun, checkoutTask, createTask, deleteTask, fetchTask, releaseTask, updateTask } from './use-tasks';

interface AgentOption {
  id: string;
  name: string;
}

const errorText = (e: unknown) => (e as Error).message;

/** The wake-up choice with its note and, once saved, the next wake-up. */
export function ScheduleField({ preset, cron, onPreset, onCron, nextWakeAt, error }: { preset: WakePreset; cron: string; onPreset: (p: WakePreset) => void; onCron: (c: string) => void; nextWakeAt?: string; error?: string }) {
  return (
    <div>
      <Segmented label="Wake-up" value={preset} onChange={onPreset} options={WAKE_PRESETS.map((p) => ({ value: p, label: WAKE_PRESET_LABELS[p] }))} />
      {preset === 'custom' && <Input aria-label="Cron schedule" className="mt-2 font-mono max-md:h-11" value={cron} onChange={(e) => onCron(e.target.value)} placeholder="0 9 * * 1-5" />}
      <p className="mt-1.5 text-[12px] leading-snug text-t3">{WAKE_NOTE}</p>
      {nextWakeAt && preset !== 'none' && <p className="mt-0.5 text-[12px] text-t2">Next wake-up {untilText(nextWakeAt)} ({new Date(nextWakeAt).toLocaleString()})</p>}
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-rd">
          {error}
        </p>
      )}
    </div>
  );
}

function ReadLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-t3">{label}</div>
      <div className="text-[13px] text-t1">{children}</div>
    </div>
  );
}

function RunItem({ run, task, names, onDecided }: { run: TaskRun; task: ProjectTaskView; names: Map<string, string>; onDecided: () => void }) {
  const who = [run.requestedBy && `asked by ${names.get(run.requestedBy) ?? 'someone'}`, run.decidedBy && `${run.status === 'denied' ? 'denied' : 'approved'} by ${names.get(run.decidedBy) ?? 'someone'}`].filter(Boolean).join(', ');
  return (
    <li className="space-y-1.5 border-b border-hair py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={RUN_TONES[run.status]}>{RUN_LABELS[run.status]}</Badge>
        <span className="text-[12px] text-t3">
          {run.reason === 'wake' ? 'Wake-up' : 'Asked'} · {timeAgo(run.requestedAt)}
          {who && ` · ${who}`}
        </span>
      </div>
      {run.error && <p className="text-[12px] text-rd">{run.error}</p>}
      {run.reply && (
        <details className="text-[12.5px] text-t2">
          <summary className="cursor-pointer text-t2 max-md:py-2">The reply</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{run.reply}</p>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {run.sessionId && (
          <Link href={`/agents/${encodeURIComponent(run.agentId)}?tab=sessions&session=${encodeURIComponent(run.sessionId)}`} className="inline-flex h-7 items-center rounded-[10px] border border-hair px-3 text-[12.5px] text-t1 hover:border-ac max-md:min-h-[44px]">
            Open session
          </Link>
        )}
        {run.status === 'requested' && (
          <TaskActions row={{ kind: 'task', taskRunId: run.id, taskRunStatus: 'requested', canDecide: task.canEdit, taskId: task.id, projectId: task.projectId }} skip={['open']} onDone={onDecided} onFailed={onDecided} />
        )}
      </div>
    </li>
  );
}

export function TaskDialog({ projectId, task: given, canCreate = true, onClose, onChanged, onDeleted }: { projectId: string; task?: ProjectTaskView; canCreate?: boolean; onClose: () => void; onChanged: (task: ProjectTaskView) => void; onDeleted: (id: string) => void }) {
  const viewer = useViewer();
  const people = usePeople(projectId);
  const goals = useGoals();
  const [task, setTask] = useState(given);
  const editable = task ? task.canEdit : canCreate;
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [title, setTitle] = useState(given?.title ?? '');
  const [description, setDescription] = useState(given?.description ?? '');
  const [status, setStatus] = useState<TaskStatus>(given?.status ?? 'todo');
  const [priority, setPriority] = useState<TaskPriority>(given?.priority ?? 'normal');
  const [goalId, setGoalId] = useState<string | undefined>(given?.goalId);
  const [assignee, setAssignee] = useState(assigneeValue(given?.assignee));
  const [preset, setPreset] = useState<WakePreset>(cronPreset(given?.wake?.cron));
  const [cron, setCron] = useState(given?.wake?.cron ?? '');
  const [errors, setErrors] = useState<Partial<Record<TaskField | 'other', string>>>({});
  const [busy, setBusy] = useState<'save' | 'delete' | 'checkout' | 'run'>();
  const [checkoutError, setCheckoutError] = useState<string>();
  const [runNote, setRunNote] = useState<string>();

  useEffect(() => {
    api<{ agents: AgentOption[] }>(`/api/agents?availableIn=${encodeURIComponent(projectId)}`)
      .then((r) => setAgents(r.agents))
      .catch(() => undefined);
  }, [projectId]);

  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const projectGoals = useMemo(() => (goals.data ? filterTree(goals.data.goals, { activeOnly: false, projectId }) : undefined), [goals.data, projectId]);
  const picked = parseAssignee(assignee);
  const isAgent = picked?.kind === 'agent';
  const missing = missingAssigneeOption(assignee, agents, people, task?.assigneeName);
  const wakeCron = isAgent ? (preset === 'custom' ? cron.trim() : presetCron(preset)) : undefined;

  const show = (message: string) => {
    const field = fieldOfSaveError(message, isAgent && preset === 'custom');
    setErrors({ [field === 'schedule' && !isAgent ? 'other' : (field ?? 'other')]: message });
  };
  const refresh = (next: ProjectTaskView) => {
    setTask(next);
    onChanged(next);
  };
  const reloadTask = () => task && fetchTask(projectId, task.id).then(refresh).catch(() => undefined);

  const save = async () => {
    setErrors({});
    if (!title.trim()) return setErrors({ title: 'A task needs a title' });
    if (isAgent && preset === 'custom' && !cron.trim()) return setErrors({ schedule: 'Type a schedule, or choose None' });
    setBusy('save');
    try {
      const body: ProjectTaskInput = { title: title.trim(), description: description.trim() || null, status, priority, goalId: goalId ?? null, assignee: picked ?? null, wake: wakeCron ? { cron: wakeCron } : null };
      const saved = task ? await updateTask(projectId, task.id, body) : await createTask(projectId, body);
      onChanged(saved);
      if (task) {
        setTask(saved);
        toast.success('Saved');
      } else onClose();
    } catch (e) {
      show(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async () => {
    if (!task || !(await confirmAction(`Delete “${task.title}”? Its runs go with it.`, { action: 'Delete task', danger: true }))) return;
    setBusy('delete');
    try {
      await deleteTask(projectId, task.id);
      onDeleted(task.id);
      onClose();
    } catch (e) {
      show(errorText(e));
      setBusy(undefined);
    }
  };
  const holder = task?.checkedOutBy;
  const mineHeld = Boolean(holder && viewer && holder === viewer.id);
  const checkout = async () => {
    if (!task) return;
    setBusy('checkout');
    setCheckoutError(undefined);
    try {
      refresh(await (holder && (mineHeld || task.canRelease) ? releaseTask(projectId, task.id) : checkoutTask(projectId, task.id)));
    } catch (e) {
      setCheckoutError(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };
  const ask = async () => {
    if (!task) return;
    setBusy('run');
    setRunNote(undefined);
    try {
      const r = await askToRun(projectId, task.id);
      setRunNote(r.merged ? 'Already asked' : 'Asked: someone approves it in Needs you');
      await reloadTask();
    } catch (e) {
      setRunNote(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  const err = (field: TaskField | 'other') =>
    errors[field] ? (
      <p role="alert" className="mt-1 text-[12px] text-rd">
        {errors[field]}
      </p>
    ) : null;
  const assigneeName = task?.assigneeName ?? (task?.assignee ? 'Removed' : 'Unassigned');
  const canHold = !holder || mineHeld || Boolean(task?.canRelease);
  const savedAgentTask = task?.assignee?.kind === 'agent';
  const hasOpenRun = task?.runs.some((r) => r.status === 'requested' || r.status === 'approved' || r.status === 'running' || r.status === 'waiting');

  return (
    <Dialog
      title={task ? task.title : 'New task'}
      subtitle={task ? `${TASK_STATUS_LABELS[task.status]} · ${TASK_PRIORITY_LABELS[task.priority]} priority` : undefined}
      width={640}
      onClose={onClose}
      footer={
        editable ? (
          <>
            {task && (
              <Button variant="danger" className="mr-auto max-md:min-h-[44px]" onClick={() => void remove()} loading={busy === 'delete'} disabled={busy !== undefined}>
                Delete
              </Button>
            )}
            <Button variant="ghost" className="max-md:min-h-[44px]" onClick={onClose}>
              {task ? 'Close' : 'Cancel'}
            </Button>
            <Button variant="primary" className="max-md:min-h-[44px]" onClick={() => void save()} loading={busy === 'save'} disabled={busy !== undefined}>
              {task ? 'Save' : 'Create task'}
            </Button>
          </>
        ) : (
          <Button variant="ghost" className="max-md:min-h-[44px]" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {editable ? (
        <div className="space-y-4">
          <Field id="task-title" label="Title" required>
            <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TASK_LIMITS.title} autoFocus={!task} className="max-md:h-11" />
            {err('title')}
          </Field>
          <Field id="task-description" label="Description">
            <Textarea id="task-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={TASK_LIMITS.description} rows={3} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="task-status" label="Status">
              <Select id="task-status" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} className="max-md:h-11">
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="task-priority" label="Priority">
              <Select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className="max-md:h-11">
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {TASK_PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field id="task-goal" label="Goal">
            <GoalPicker value={goalId} onChange={setGoalId} projectId={projectId} goals={projectGoals} allowNone noneLabel="No goal" ariaLabel="Goal" />
            {err('goal')}
          </Field>
          <Field id="task-assignee" label="Assignee">
            <Select
              id="task-assignee"
              value={assignee}
              onChange={(e) => {
                setAssignee(e.target.value);
                if (!e.target.value.startsWith('agent:')) setPreset('none');
              }}
              className="max-md:h-11"
            >
              <option value="">Unassigned</option>
              {missing && <option value={missing.value}>{missing.label}</option>}
              <optgroup label="Agents in this project">
                {agents.map((a) => (
                  <option key={a.id} value={`agent:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="People">
                {people.map((p) => (
                  <option key={p.id} value={`person:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            </Select>
            {err('assignee')}
          </Field>
          {isAgent && (
            <Field label="Wake-up">
              <ScheduleField preset={preset} cron={cron} onPreset={setPreset} onCron={setCron} nextWakeAt={task?.nextWakeAt} error={errors.schedule} />
            </Field>
          )}
          {err('other')}
        </div>
      ) : (
        <div className="space-y-3">
          {task?.description && <p className="whitespace-pre-wrap text-[13px] text-t2">{task.description}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <ReadLine label="Assignee">{assigneeName}</ReadLine>
            <ReadLine label="Goal">{task?.goalTitle ?? 'No goal'}</ReadLine>
            {task?.wake && (
              <ReadLine label="Wake-up">
                {WAKE_PRESET_LABELS[cronPreset(task.wake.cron)]}
                {cronPreset(task.wake.cron) === 'custom' && ` (${task.wake.cron})`}
                {task.nextWakeAt && ` · next ${untilText(task.nextWakeAt)}`}
              </ReadLine>
            )}
            {task?.checkedOutByName && <ReadLine label="Checked out by">{task.checkedOutByName}</ReadLine>}
          </div>
        </div>
      )}

      {task && (
        <div className="mt-5 space-y-4 border-t border-hair pt-4">
          {task.canEdit && (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-t2">{holder ? `Checked out by ${task.checkedOutByName ?? 'someone'}` : 'Nobody has it checked out'}</span>
                {canHold && (
                  <Button size="sm" variant="outline" className="max-md:min-h-[44px]" onClick={() => void checkout()} loading={busy === 'checkout'} disabled={busy !== undefined}>
                    {holder ? 'Release' : 'Check out'}
                  </Button>
                )}
                {savedAgentTask && (
                  <Button size="sm" variant="outline" className="max-md:min-h-[44px]" onClick={() => void ask()} loading={busy === 'run'} disabled={busy !== undefined}>
                    Ask to run now
                  </Button>
                )}
              </div>
              {checkoutError && (
                <p role="alert" className="mt-1 text-[12px] text-rd">
                  {checkoutError}
                </p>
              )}
              {runNote && <p className="mt-1 text-[12px] text-t2">{runNote}</p>}
              {savedAgentTask && hasOpenRun && !runNote && <p className="mt-1 text-[12px] text-t3">A request is open: a new one merges into it.</p>}
            </div>
          )}
          <div>
            <div className="mb-1 text-[12px] font-semibold text-t2">Last runs</div>
            {task.runs.length === 0 ? (
              <p className="text-[12px] text-t3">No runs yet.</p>
            ) : (
              <ul>
                {task.runs.map((run) => (
                  <RunItem key={run.id} run={run} task={task} names={names} onDecided={() => void reloadTask()} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
