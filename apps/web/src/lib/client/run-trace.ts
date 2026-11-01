'use client';
/**
 * Run Trace on the client: the journal of one execution, live (`useRunJournal`), what needs a person across runs
 * (`useNeedsYou`), and the two things a person can do from the trace: settle a failed check, decide a tool approval.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JournalEvent, RunActor } from '../shared/run-trace';
import { foldJournal, type RunModel } from '../shared/run-trace-model';
import { api, streamEvents } from './api';
import { useLiveEvents } from './live';

/** `GET /api/executions/:id/events` */
export interface JournalPage {
  events: JournalEvent[];
  last: number;
  more: boolean;
}

export interface RunJournal {
  events: JournalEvent[];
  /** The whole journal folded (the screens fold again with `until` when the slider is moved). */
  model: RunModel;
  loading: boolean;
  error?: string;
  /** Read what is missing now (after settling a check, say). */
  refresh: () => void;
}

const PAGE = 1000;

/** The journal of an execution: loaded from the API, kept current by the `journal` events of the live stream. */
export function useRunJournal(executionId: string | undefined): RunJournal {
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const [loading, setLoading] = useState(Boolean(executionId));
  const [error, setError] = useState<string>();
  const last = useRef(0);
  const loadingMore = useRef(false);

  const append = useCallback((incoming: JournalEvent[]) => {
    const fresh = incoming.filter((e) => e.seq > last.current).sort((a, b) => a.seq - b.seq);
    if (!fresh.length) return;
    last.current = fresh[fresh.length - 1].seq;
    setEvents((current) => [...current, ...fresh]);
  }, []);

  /** Read everything after `last`, page by page. */
  const catchUp = useCallback(async () => {
    if (!executionId || loadingMore.current) return;
    loadingMore.current = true;
    try {
      for (;;) {
        const page = await api<JournalPage>(`/api/executions/${executionId}/events?after=${last.current}&limit=${PAGE}`);
        append(page.events);
        if (!page.more || !page.events.length) break;
      }
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loadingMore.current = false;
      setLoading(false);
    }
  }, [executionId, append]);

  useEffect(() => {
    last.current = 0;
    setEvents([]);
    setError(undefined);
    setLoading(Boolean(executionId));
    void catchUp();
  }, [executionId, catchUp]);

  useLiveEvents((event) => {
    if (event.channel !== 'journal' || event.executionId !== executionId) return;
    const first = event.events[0];
    // A gap (a dropped stream, a batch missed): read what is missing from the API.
    if (first && first.seq > last.current + 1) void catchUp();
    else append(event.events);
  });

  // The stream may have been down while the run went on: resync now and then while the page is open and the run is live.
  const model = useMemo(() => foldJournal(events), [events]);
  const live = model.live;
  useEffect(() => {
    if (!executionId || !live) return;
    const timer = setInterval(() => void catchUp(), 15_000);
    return () => clearInterval(timer);
  }, [executionId, live, catchUp]);

  const refresh = useCallback(() => void catchUp(), [catchUp]);
  return { events, model, loading, error, refresh };
}

/** One thing waiting for a person (`GET /api/runs/needs-you`). */
export interface NeedsYouRow {
  executionId: string;
  workflowId: string;
  workflowName: string;
  /** `gate`: a Run report waits for someone to accept its failed checks or send the work back. */
  kind: 'approval' | 'form' | 'question' | 'gate' | 'check';
  title: string;
  detail?: string;
  actor?: RunActor;
  spanId?: string;
  since: string;
}

export function useNeedsYou(): {
  items: NeedsYouRow[] | undefined;
  refresh: () => void;
} {
  const [items, setItems] = useState<NeedsYouRow[]>();
  const refresh = useCallback(() => {
    api<{ items: NeedsYouRow[] }>('/api/runs/needs-you')
      .then((r) => setItems(r.items))
      .catch(() => setItems((current) => current ?? []));
  }, []);
  useEffect(refresh, [refresh]);
  // A run waiting or finishing changes the list.
  useLiveEvents((event) => {
    if (event.channel === 'execution' && (event.event.type === 'execution.finished' || event.event.type === 'execution.resumed')) refresh();
  });
  return { items, refresh };
}

/** Settle a failed check: accept it as is, or send it back for a fix. */
export function resolveCheck(
  executionId: string,
  body: {
    spanId: string;
    name: string;
    subject?: string;
    decision: 'accepted' | 'sent_back';
    note?: string;
  },
) {
  return api<unknown>(`/api/executions/${executionId}/checks`, {
    method: 'POST',
    json: body,
  });
}

/** Answer a Run report waiting on its failed checks: accept them as is, or send the work back (POST /api/executions/:id/gate). */
export function decideGate(executionId: string, decision: 'accepted' | 'sent_back', note?: string) {
  return api<{ status: string }>(`/api/executions/${executionId}/gate`, { method: 'POST', json: { decision, ...(note && { note }) } });
}

/**
 * Decide the tool calls an execution waits on (the AI Agent node's approvals). Returns false when the wait is not a tool
 * approval (a form, an approval node): the caller sends the person to the execution instead.
 */
export async function decideToolApprovals(executionId: string, approved: boolean): Promise<boolean> {
  const { approval } = await api<{
    approval: {
      calls: Array<{ id: string }>;
      decisions?: Record<string, unknown>;
    } | null;
  }>(`/api/executions/${executionId}/approvals`);
  if (!approval) return false;
  const open = approval.calls.filter((call) => approval.decisions?.[call.id] === undefined);
  for (const call of open) await streamEvents(`/api/executions/${executionId}/approvals`, { callId: call.id, approved }, () => {});
  return true;
}
