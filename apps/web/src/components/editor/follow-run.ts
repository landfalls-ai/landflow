'use client';
/**
 * A run goes on when the editor that started it closes or reloads (it outlives the request, docs/features/editor.md).
 * Opened again, the editor shows it running (`attachRun`) and this follows it through the live events: nodes starting
 * and a team's progress straight away, and the record read again as nodes finish (and every few seconds, for events
 * missed), until it ends. Stop works as usual: it asks the server.
 */
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { duration } from '@/lib/client/format';
import { useLiveEvents } from '@/lib/client/live';
import type { NodeProgress } from '@/lib/client/node-progress';
import type { ExecutionRecord } from '@/lib/shared/types';
import { useEditor } from './store';

/** Runs the editor started itself, which it picks up again: not production runs, and not debug runs (they stop with the page). */
export function followable(record: ExecutionRecord): boolean {
  return record.status === 'running' && (record.mode === 'manual' || record.mode === 'chat') && !record.debug;
}

/** Newer of the two reports per node, for the nodes the record still names as running. */
function latest(snapshot: Record<string, NodeProgress>, current: Record<string, NodeProgress>): Record<string, NodeProgress> {
  return Object.fromEntries(Object.entries(snapshot).map(([id, p]) => [id, current[id] && Date.parse(current[id].at) > Date.parse(p.at) ? current[id] : { ...p, since: current[id]?.since ?? p.since }]));
}

export function useFollowRun() {
  const following = useEditor((s) => s.following);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(() => {
    const id = useEditor.getState().following;
    if (!id) return;
    api<{ execution: ExecutionRecord; progress?: Record<string, NodeProgress> }>(`/api/executions/${id}`)
      .then(({ execution, progress = {} }) => {
        const state = useEditor.getState();
        if (state.following !== id) return;
        // Keep the log of what was seen live.
        const log = state.log;
        if (execution.status === 'running') state.attachRun(execution, latest(progress, state.progress), Boolean(state.viewing));
        else {
          state.loadExecution(execution, Boolean(state.viewing));
          if (execution.status === 'success') toast.success(`Workflow succeeded in ${duration(execution.durationMs)}`);
          else if (execution.status === 'canceled') toast('Workflow stopped');
          else if (execution.status === 'error') toast.error(`Workflow failed${execution.error?.message ? `: ${execution.error.message}` : ''}`);
        }
        useEditor.setState({ log });
      })
      .catch(() => {});
  }, []);
  const schedule = useCallback(
    (ms: number) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(reload, ms);
    },
    [reload],
  );

  useEffect(() => {
    if (!following) return;
    const every = setInterval(reload, 4000);
    return () => {
      clearInterval(every);
      clearTimeout(timer.current);
    };
  }, [following, reload]);

  useLiveEvents((event) => {
    const id = useEditor.getState().following;
    if (event.channel !== 'execution' || !id || event.event.executionId !== id) return;
    const e = event.event;
    if (e.type === 'node.started' || e.type === 'node.progress' || e.type === 'node.log') useEditor.getState().applyEvent(e);
    else schedule(150);
  });
}
