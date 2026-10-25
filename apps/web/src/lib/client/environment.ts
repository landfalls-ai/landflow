'use client';
/**
 * The instance's environment (GET /api/environment), fetched once per page load and shared by the shell badge and
 * the workflow editor (which turns read-only in a protected environment).
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
