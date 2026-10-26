'use client';
/**
 * A waiting execution on the editor's canvas (a run that ended `waiting`, or one opened from history) goes on in the
 * background: a Wait node's timer fires, a form or webhook call comes in, the sub-workflows an Execute Workflow node
 * waits for finish one by one. This follows it through the live events and reloads the record, so the canvas's
 * waiting mark ("Waiting on 2 of 3 sub-workflows") stays current and the rest of the run shows once it resumes.
 */
import { useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/client/api';
import { useLiveEvents } from '@/lib/client/live';
import { waitedChildren } from '@/lib/client/run-data';
import type { ExecutionRecord } from '@/lib/shared/types';
import { useEditor } from './store';

export function useFollowWaiting() {
  const executionId = useEditor((s) => s.executionId);
  const runStatus = useEditor((s) => s.runStatus);
  const running = useEditor((s) => s.running);
  const followed = useRef<string>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(() => {
    const id = followed.current;
    if (!id) return;
    api<{ execution: ExecutionRecord }>(`/api/executions/${id}`)
      .then(({ execution }) => {
        const state = useEditor.getState();
        // The canvas moved on (a new run, another execution): stop.
        if (state.running || state.executionId !== id) return void (followed.current = undefined);
        // Keep the raw event log of the run that led here.
        const log = state.log;
        state.loadExecution(execution, Boolean(state.viewing));
        useEditor.setState({ log });
        if (execution.status !== 'waiting' && execution.status !== 'running') followed.current = undefined;
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

  // Start following when the canvas shows a waiting execution; read it once more (children may have finished already).
  useEffect(() => {
    if (running || runStatus !== 'waiting' || !executionId || followed.current === executionId) return;
    followed.current = executionId;
    schedule(600);
  }, [running, runStatus, executionId, schedule]);
  useEffect(() => () => clearTimeout(timer.current), []);

  useLiveEvents((event) => {
    const id = followed.current;
    if (event.channel !== 'execution' || !id) return;
    const state = useEditor.getState();
    if (state.running || state.executionId !== id) return void (followed.current = undefined);
    const e = event.event;
    const own = e.executionId === id && (e.type === 'node.finished' || e.type.startsWith('execution.'));
    const child = e.type === 'execution.finished' && waitedChildren({ status: 'waiting', wait: state.wait })?.some((c) => c.executionId === e.executionId);
    if (own || child) schedule(150);
  });
}
