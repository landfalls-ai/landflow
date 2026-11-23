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

/** Two decimals, with a thousands separator from $1,000. */
const MONEY = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** `12 runs · 1 failed · 3 updates · $0.42 this week`; zeros are left out; nothing moved says so. */
export function progressText(p: GoalProgress): string {
  const when = p.window === 30 ? 'in 30 days' : p.window === 1 ? 'today' : 'this week';
  const runs = p.runs.ok + p.runs.failed;
  const parts: string[] = [];
  if (runs > 0) parts.push(plural(runs, 'run'));
  if (p.runs.failed > 0) parts.push(`${p.runs.failed} failed`);
  if (p.updates > 0) parts.push(plural(p.updates, 'update'));
  if (p.costUsd > 0) parts.push(p.costUsd < 0.01 ? '< $0.01' : `$${MONEY.format(p.costUsd)}`);
  if (parts.length === 0) return `No activity ${when}`;
  return `${parts.join(' · ')} ${when}`;
}

/** `truncate`: cut the words to one line with an ellipsis (a table row); otherwise they wrap. */
export function GoalProgressLine({ progress, className, truncate }: { progress: GoalProgress; className?: string; truncate?: boolean }) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[12px] text-t3 ${className ?? ''}`}>
      {progress.moved && <span role="img" aria-label="Moved" className="size-1.5 shrink-0 rounded-full bg-ac" />}
      <span className={truncate ? 'min-w-0 truncate' : 'min-w-0'}>{progressText(progress)}</span>
    </span>
  );
}

/** The answer indexed by goal; an answer without `progress` (an older host) is an empty map. */
export function indexProgress(response?: Partial<GoalProgressResponse> | null): Map<string, GoalProgress> {
  const map = new Map<string, GoalProgress>();
  for (const p of response?.progress ?? []) map.set(p.goalId, p);
  return map;
}

/**
 * The progress answer for a window, as the host last gave it. A failed fetch keeps the last good answer (progress is extra:
 * never an error, never a blank that was there a moment ago); `ready` is true once any answer has arrived. `refresh` is
 * anything whose change should ask again, such as the goals the screen just reloaded.
 */
export function useGoalProgressState(window: ProgressWindow, projectId?: string, refresh?: unknown): { map: Map<string, GoalProgress>; ready: boolean } {
  const [state, setState] = useState<{ map: Map<string, GoalProgress>; ready: boolean }>(() => ({ map: new Map(), ready: false }));
  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ progress: '1', window: String(window) });
    if (projectId) qs.set('projectId', projectId);
    api<Partial<GoalProgressResponse>>(`/api/goals?${qs}`)
      .then((r) => live && setState({ map: indexProgress(r), ready: true }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [window, projectId, refresh]);
  return state;
}

export const useGoalProgress = (window: ProgressWindow, projectId?: string, refresh?: unknown): Map<string, GoalProgress> => useGoalProgressState(window, projectId, refresh).map;
