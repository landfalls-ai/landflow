'use client';
/**
 * What a person does from the Run Trace to a run: run it again from a node, ask a team member again, pause a member and
 * take over (docs/run-trace.md). Thin calls over `/api/executions/:id/rerun` and `/agents`.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export type MemberState = 'working' | 'pausing' | 'paused';

export interface WorkingMember {
  member: string;
  kind: 'agent' | 'remote';
  state: MemberState;
  since?: string;
}

/** Re-run from a node: the earlier nodes keep the outputs of this run. Resolves with the new execution's id. */
export async function rerunFromNode(executionId: string, nodeId: string): Promise<string> {
  const { executionId: id } = await api<{ executionId: string }>(`/api/executions/${executionId}/rerun`, { method: 'POST', json: { scope: 'from', nodeId, version: 'original' } });
  return id;
}

/** The same message to the same member again, as a re-run of the team node with the lead asked to ask only that member. */
export async function askMemberAgain(executionId: string, nodeId: string, member: string, message: string): Promise<string> {
  const { executionId: id } = await api<{ executionId: string }>(`/api/executions/${executionId}/rerun`, { method: 'POST', json: { scope: 'from', nodeId, version: 'original', askMember: { member, message } } });
  return id;
}

const memberPath = (executionId: string, member: string, action: 'pause' | 'continue') => `/api/executions/${executionId}/agents/${encodeURIComponent(member)}/${action}`;

export const pauseMember = (executionId: string, member: string) => api<WorkingMember>(memberPath(executionId, member, 'pause'), { method: 'POST' });
export const continueMember = (executionId: string, member: string, message?: string) =>
  api<WorkingMember>(memberPath(executionId, member, 'continue'), { method: 'POST', json: { ...(message?.trim() && { message: message.trim() }) } });

/** The team members of a running execution that can be paused, and which are paused; read every few seconds while `active`. */
export function useWorkingMembers(executionId: string | undefined, active: boolean): { members: WorkingMember[]; refresh: () => void } {
  const [members, setMembers] = useState<WorkingMember[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!executionId || !active) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    const read = () =>
      api<{ members: WorkingMember[] }>(`/api/executions/${executionId}/agents`)
        .then((r) => !cancelled && setMembers(r.members))
        .catch(() => {});
    void read();
    const timer = setInterval(read, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [executionId, active, tick]);
  return { members, refresh };
}
