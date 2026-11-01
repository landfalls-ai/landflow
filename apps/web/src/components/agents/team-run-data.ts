'use client';
/** What the team page reads about a team's latest run (GET /api/agent-teams/:id/last-run), shared by the member cards and the Last run section. */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { TeamMoment } from '@/lib/shared/team-progress';

export interface LastTeamRun {
  executionId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  nodeName: string;
  durationMs?: number;
  /** Going on now: read from the team node's live progress. */
  live?: boolean;
  /** The member at work (a live run). */
  member?: string;
  members: Array<{ title: string; tokens: number; budgetTokens?: number; estimated?: boolean; overBudget?: boolean; costUsd?: number; notAsked?: boolean; working?: boolean }>;
  moments?: TeamMoment[];
}

const LIVE_POLL_MS = 4_000;

/** "Claude Opus 5.5" for the Claude models, else the model's own name. */
export function modelLabel(model: { provider: string; model: string }): string {
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(model.model);
  if (model.provider === 'anthropic' && claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  return model.model;
}

/** The team's latest run (undefined while loading, null when there is none); while it goes on, read again every few seconds. */
export function useLastTeamRun(teamId: string): LastTeamRun | null | undefined {
  const [run, setRun] = useState<LastTeamRun | null>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let gone = false;
    api<{ run?: LastTeamRun }>(`/api/agent-teams/${teamId}/last-run`)
      .then((r) => !gone && setRun(r.run ?? null))
      .catch(() => !gone && setRun((prev) => prev ?? null));
    return () => {
      gone = true;
    };
  }, [teamId, tick]);
  const live = Boolean(run?.live);
  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(() => setTick((n) => n + 1), LIVE_POLL_MS);
    return () => clearTimeout(timer);
  }, [live, tick]);
  return run;
}
