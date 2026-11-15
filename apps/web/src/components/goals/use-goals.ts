'use client';
/** Goals and people on the client: the tree from GET /api/goals, and who can own a goal or lead a project. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { GoalsResponse, ProjectBriefView } from '@/lib/shared/goals';
import type { UserView } from '@/lib/shared/auth';
import type { ProjectDetail } from '@/lib/shared/projects';
import { useViewer } from '@/components/auth/viewer';

export function useGoals(enabled = true) {
  const [data, setData] = useState<GoalsResponse>();
  const [error, setError] = useState<string>();
  const reload = useCallback(
    () =>
      api<GoalsResponse>('/api/goals')
        .then((r) => {
          setData(r);
          setError(undefined);
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    if (enabled) void reload();
  }, [reload, enabled]);
  return { data, error, reload };
}

export interface Person {
  id: string;
  name: string;
}

/**
 * The people who can own a goal: a project's members; for a company goal every user when the viewer may list them, else
 * just the viewer.
 */
export function usePeople(projectId?: string): Person[] {
  const viewer = useViewer();
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    let live = true;
    const fallback = viewer ? [{ id: viewer.id, name: viewer.name }] : [];
    const load = projectId
      ? api<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}`).then((r) => r.project.members.map((m) => ({ id: m.userId, name: m.name })))
      : api<{ users: UserView[] }>('/api/users').then((r) => r.users.filter((u) => !u.disabled).map((u) => ({ id: u.id, name: u.name })));
    load.catch(() => fallback).then((list) => live && setPeople(list));
    return () => {
      live = false;
    };
  }, [projectId, viewer]);
  return people;
}

/** The goals a project serves, in order (GET /api/projects/:id → `brief.goals`). */
export async function projectGoalIds(projectId: string): Promise<string[]> {
  const { project } = await api<{ project: ProjectDetail & { brief?: ProjectBriefView } }>(`/api/projects/${encodeURIComponent(projectId)}`);
  return (project.brief?.goals ?? []).map((g) => g.id);
}

/** Replace the goals a project serves (PUT /api/projects/:id/goals). */
export const putProjectGoals = (projectId: string, goalIds: string[]) => api(`/api/projects/${encodeURIComponent(projectId)}/goals`, { method: 'PUT', json: { goalIds } });
