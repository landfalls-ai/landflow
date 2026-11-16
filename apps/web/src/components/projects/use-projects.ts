'use client';
/**
 * Projects on the client: the projects the viewer sees (the sidebar switcher, project pages, the Move dialog) and
 * the credentials a workflow's project may use (the node panel's picker). Rules: lib/shared/projects.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '@/lib/client/api';
import type { ProjectView } from '@/lib/shared/projects';

interface ProjectsState {
  projects?: ProjectView[];
  error?: string;
  refresh(): Promise<void>;
}

export const useProjectStore = create<ProjectsState>((set) => ({
  async refresh() {
    try {
      const { projects } = await api<{ projects: ProjectView[] }>('/api/projects');
      set({ projects, error: undefined });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },
}));

/** Loads on first use; call `refresh()` after a change. */
export function useProjects() {
  const state = useProjectStore();
  useEffect(() => {
    void useProjectStore.getState().refresh();
  }, []);
  return state;
}

/** Projects the viewer may create things in or move things to (editor or admin there). */
export const writableProjects = (projects: ProjectView[] | undefined) => (projects ?? []).filter((p) => p.role === 'admin' || p.role === 'editor');

/** How a project is named in lists: personal projects are "Personal" for their own user. */
export function projectLabel(project: Pick<ProjectView, 'name' | 'type' | 'ownerId'>, viewerId?: string): string {
  if (project.type === 'personal') return project.ownerId === viewerId ? 'Personal' : `${project.name} (personal)`;
  return project.name;
}

/**
 * The credentials a workflow's project may use (undefined until loaded, or without a workflow), and that project.
 * `failed` is set when the request failed (the scope stays unknown: nothing may be picked on its behalf); `reload` retries and says whether it worked.
 * A scope that was loaded for another workflow is never returned.
 */
export function useCredentialScope(workflowId: string | undefined) {
  const [state, setState] = useState<{ workflowId: string; scope?: { ids: Set<string>; projectId?: string }; failed?: boolean }>();
  // Only the newest request may set the state: a slow answer for an earlier workflow or an earlier retry is dropped.
  const latest = useRef(0);
  const load = useCallback(async (): Promise<boolean> => {
    const mine = ++latest.current;
    if (!workflowId) {
      setState(undefined);
      return true;
    }
    try {
      const { credentials, projectId } = await api<{ credentials: Array<{ id: string }>; projectId?: string }>(`/api/credentials?workflowId=${encodeURIComponent(workflowId)}`);
      if (mine === latest.current) setState({ workflowId, scope: { ids: new Set(credentials.map((c) => c.id)), projectId } });
      return true;
    } catch {
      if (mine === latest.current) setState({ workflowId, failed: true });
      return false;
    }
  }, [workflowId]);
  useEffect(() => {
    void load();
  }, [load]);
  const current = workflowId && state?.workflowId === workflowId ? state : undefined;
  return { scope: current?.scope, failed: Boolean(current?.failed), reload: load };
}
