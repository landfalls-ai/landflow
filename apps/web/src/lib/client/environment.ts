'use client';
/**
 * The instance's environment (GET /api/environment), fetched once per page load and shared by the shell badge, the
 * workflow editor (which turns read-only in a protected environment) and the places that create workflows (the
 * workflows list, projects, templates, agents), which disable their create buttons there.
 */
import { useEffect, useState } from 'react';
import type { EnvironmentView } from '../shared/secrets';
import { api } from './api';

let pending: Promise<EnvironmentView | undefined> | undefined;

export function loadEnvironment(): Promise<EnvironmentView | undefined> {
  pending ??= api<EnvironmentView>('/api/environment').catch(() => {
    pending = undefined;
    return undefined;
  });
  return pending;
}

/** The environment view, or undefined while loading (and when it can't be read). */
export function useEnvironment(): EnvironmentView | undefined {
  const [view, setView] = useState<EnvironmentView>();
  useEffect(() => {
    let live = true;
    void loadEnvironment().then((v) => live && setView(v));
    return () => {
      live = false;
    };
  }, []);
  return view;
}

/** Why workflows can't be created or changed here (a protected environment), or undefined when they can. */
export function readOnlyReason(view: EnvironmentView | undefined): string | undefined {
  if (!view?.protected) return undefined;
  return `${view.name ?? 'This'} is a protected environment: workflows are read-only here and change only by pull or promotion`;
}

/** `readOnlyReason` of this instance's environment: create buttons are disabled with it as their tooltip. */
export function useWorkflowsReadOnly(): string | undefined {
  return readOnlyReason(useEnvironment());
}
