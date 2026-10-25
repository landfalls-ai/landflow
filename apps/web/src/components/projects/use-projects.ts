'use client';
/**
 * Projects on the client: the projects the viewer sees (the sidebar switcher, project pages, the Move dialog) and
 * the credentials a workflow's project may use (the node panel's picker). Rules: lib/shared/projects.ts.
 */
import { useCallback, useEffect, useState } from 'react';
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

/** The credentials a workflow's project may use (undefined until loaded, or without a workflow), and that project. */
export function useCredentialScope(workflowId: string | undefined) {
  const [scope, setScope] = useState<{ ids: Set<string>; projectId?: string }>();
  const load = useCallback(async () => {
    if (!workflowId) return setScope(undefined);
    try {
      const { credentials, projectId } = await api<{ credentials: Array<{ id: string }>; projectId?: string }>(`/api/credentials?workflowId=${encodeURIComponent(workflowId)}`);
      setScope({ ids: new Set(credentials.map((c) => c.id)), projectId });
    } catch {
      setScope(undefined);
    }
  }, [workflowId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { scope, reload: load };
}
