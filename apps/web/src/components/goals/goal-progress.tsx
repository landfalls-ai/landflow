'use client';
/**
 * The quiet line under a goal's title that says whether it is moving (docs/projects-and-goals.md#progress). The numbers
 * come from the host, counted from what the viewer may see; this file only words them. Progress is extra: an older host
 * or a failed answer shows nothing, never an error.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { plural } from '@/lib/client/format';
import type { GoalProgress, GoalProgressResponse, ProgressWindow } from '@/lib/shared/goal-progress';

/** `12 runs · 1 failed · 3 updates · $0.42 this week`; zeros are left out; nothing moved says so. */
export function progressText(p: GoalProgress): string {
  const when = p.window === 30 ? 'in 30 days' : p.window === 1 ? 'today' : 'this week';
  const runs = p.runs.ok + p.runs.failed;
  const parts: string[] = [];
  if (runs > 0) parts.push(plural(runs, 'run'));
  if (p.runs.failed > 0) parts.push(`${p.runs.failed} failed`);
  if (p.updates > 0) parts.push(plural(p.updates, 'update'));
  if (p.costUsd > 0) parts.push(p.costUsd < 0.01 ? '< $0.01' : `$${p.costUsd.toFixed(2)}`);
  if (parts.length === 0) return `No activity ${when}`;
  return `${parts.join(' · ')} ${when}`;
}

export function GoalProgressLine({ progress, className }: { progress: GoalProgress; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[12px] text-t3 ${className ?? ''}`}>
      {progress.moved && <span role="img" aria-label="Moved" className="size-1.5 shrink-0 rounded-full bg-ac" />}
      <span className="min-w-0">{progressText(progress)}</span>
    </span>
  );
}

/** The answer indexed by goal; an answer without `progress` (an older host) is an empty map. */
export function indexProgress(response?: Partial<GoalProgressResponse> | null): Map<string, GoalProgress> {
  const map = new Map<string, GoalProgress>();
  for (const p of response?.progress ?? []) map.set(p.goalId, p);
  return map;
}

export function useGoalProgress(window: ProgressWindow, projectId?: string): Map<string, GoalProgress> {
  const [map, setMap] = useState<Map<string, GoalProgress>>(() => new Map());
  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ progress: '1', window: String(window) });
    if (projectId) qs.set('projectId', projectId);
    api<Partial<GoalProgressResponse>>(`/api/goals?${qs}`)
      .then((r) => live && setMap(indexProgress(r)))
      .catch(() => live && setMap(new Map()));
    return () => {
      live = false;
    };
  }, [window, projectId]);
  return map;
}
