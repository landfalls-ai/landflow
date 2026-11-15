'use client';
/** Project tasks on the client: the list with keyset paging, and the calls the tab and the dialog make (contracts/w10/tasks-api.md). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import type { ProjectTaskInput, ProjectTasksResponse, ProjectTaskView, TaskRun, TaskStatus } from '@/lib/shared/project-tasks';

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/tasks`;

export interface TaskFilter {
  status?: TaskStatus;
  mine?: boolean;
}

export const tasksUrl = (projectId: string, filter: TaskFilter, cursor?: string) => {
  const q = new URLSearchParams();
  if (filter.status) q.set('status', filter.status);
  if (filter.mine) q.set('mine', '1');
  if (cursor) q.set('cursor', cursor);
  const text = q.toString();
  return `${base(projectId)}${text ? `?${text}` : ''}`;
};

/** The tasks of a project under a filter; `more` appends the next page, `replace` swaps one task after a change. */
export function useTasks(projectId: string, filter: TaskFilter) {
  const [tasks, setTasks] = useState<ProjectTaskView[]>();
  const [cursor, setCursor] = useState<string>();
  const [canCreate, setCanCreate] = useState(false);
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);
  const { status, mine } = filter;

  const reload = useCallback(() => {
    const mineSeq = ++seq.current;
    return api<ProjectTasksResponse>(tasksUrl(projectId, { status, mine }))
      .then((r) => {
        if (mineSeq !== seq.current) return;
        setTasks(r.tasks);
        setCursor(r.nextCursor);
        setCanCreate(r.canCreate);
        setError(undefined);
      })
      .catch((e: Error) => mineSeq === seq.current && setError(e.message));
  }, [projectId, status, mine]);
  useEffect(() => {
    setTasks(undefined);
    void reload();
  }, [reload]);

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api<ProjectTasksResponse>(tasksUrl(projectId, { status, mine }, cursor));
      setTasks((current) => [...(current ?? []), ...r.tasks.filter((t) => !current?.some((c) => c.id === t.id))]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };
  const replace = (task: ProjectTaskView) => setTasks((current) => current?.map((t) => (t.id === task.id ? task : t)));
  return { tasks, canCreate, error, hasMore: Boolean(cursor), loadingMore, more, reload, replace };
}

export const fetchTask = (projectId: string, taskId: string) => api<{ task: ProjectTaskView }>(`${base(projectId)}/${encodeURIComponent(taskId)}`).then((r) => r.task);
export const createTask = (projectId: string, input: ProjectTaskInput) => api<{ task: ProjectTaskView }>(base(projectId), { method: 'POST', json: input }).then((r) => r.task);
export const updateTask = (projectId: string, taskId: string, input: Partial<ProjectTaskInput>) =>
  api<{ task: ProjectTaskView }>(`${base(projectId)}/${encodeURIComponent(taskId)}`, { method: 'PATCH', json: input }).then((r) => r.task);
export const deleteTask = (projectId: string, taskId: string) => api<void>(`${base(projectId)}/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
export const checkoutTask = (projectId: string, taskId: string) => api<{ task: ProjectTaskView }>(`${base(projectId)}/${encodeURIComponent(taskId)}/checkout`, { method: 'POST' }).then((r) => r.task);
export const releaseTask = (projectId: string, taskId: string) => api<{ task: ProjectTaskView }>(`${base(projectId)}/${encodeURIComponent(taskId)}/checkout`, { method: 'DELETE' }).then((r) => r.task);
export const askToRun = (projectId: string, taskId: string) => api<{ run: TaskRun; merged: boolean }>(`${base(projectId)}/${encodeURIComponent(taskId)}/runs`, { method: 'POST' });
