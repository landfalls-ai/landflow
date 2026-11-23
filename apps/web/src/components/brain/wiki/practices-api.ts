'use client';
/**
 * The Practices routes the Brain page calls (docs/practices.md#routes), as small functions, and the list the workbench
 * keeps: the practices the viewer sees and how many wait for them. A failed list shows in words in the view; the activity
 * button simply has no count.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { PracticeApproveInput, PracticeDetailResponse, PracticeDraftInput, PracticesResponse, PracticeView } from '@/lib/shared/practices';
import type { editInput } from './practices-logic';

const base = '/api/practices';
const at = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const getPractice = (id: string) => api<PracticeDetailResponse>(at(id));
export const draftPractice = (input: PracticeDraftInput) => api<{ practice: PracticeView }>(base, { method: 'POST', json: input });
export const editPractice = (id: string, input: ReturnType<typeof editInput>) => api<{ practice: PracticeView }>(at(id), { method: 'PATCH', json: input });
export const approvePractice = (id: string, input: PracticeApproveInput) => api<{ practice: PracticeView }>(`${at(id)}/approve`, { method: 'POST', json: input });
export const rejectVersion = (id: string, version: number, reason: string) => api<{ practice: PracticeView }>(`${at(id)}/versions/${version}/reject`, { method: 'POST', json: { reason } });
export const retirePractice = (id: string) => api<{ practice: PracticeView }>(`${at(id)}/retire`, { method: 'POST', json: {} });

export interface PracticeList {
  data?: PracticesResponse;
  error?: string;
  /** Retired practices, loaded when the view opens that folder. */
  retired?: PracticeView[];
  reload: () => void;
  loadRetired: () => void;
}

/** The practices the viewer sees. `background`: the list loads with the page, not because the person asked. */
export function usePracticeList(): PracticeList {
  const [data, setData] = useState<PracticesResponse>();
  const [error, setError] = useState<string>();
  const [retired, setRetired] = useState<PracticeView[]>();
  const reload = useCallback(() => {
    api<PracticesResponse>(base, { background: true })
      .then((r) => (setData(r), setError(undefined)))
      .catch((e: Error) => setError(e instanceof SyntaxError ? 'Practices are not available on this host.' : e.message));
  }, []);
  useEffect(reload, [reload]);
  const loadRetired = useCallback(() => {
    api<PracticesResponse>(`${base}?status=retired`)
      .then((r) => setRetired(r.practices))
      .catch(() => setRetired([]));
  }, []);
  return { data, error, retired, reload: useCallback(() => (reload(), retired && loadRetired()), [reload, retired, loadRetired]), loadRetired };
}
