'use client';
/**
 * Talks to an agent: POST /api/agents/:id/chat and the approvals route both answer with an SSE stream of
 * AgentStreamEvents (`data:` lines). Timeline entries are upserted by id as they stream.
 */
import { useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { api, streamEvents } from '@/lib/client/api';
import type { AgentSession, AgentStreamEvent, RunEndReason, SessionStatus, TimelineEntry, TokenUsage } from '@/lib/shared/agents';

/** Ids of entries shown before the server echoes them. */
const LOCAL = 'local_';
const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export function useAgentRun(agentId: string, initial?: AgentSession, initialTraceUrls?: Record<string, string>) {
  const [entries, setEntries] = useState<TimelineEntry[]>(initial?.timeline ?? []);
  const [sessionId, setSessionId] = useState<string | undefined>(initial?.id);
  const [traceIds, setTraceIds] = useState<string[]>(initial?.traceIds ?? []);
  /** Trace UI links by trace id, when the host has LANDFLOW_TRACE_URL. */
  const [traceUrls, setTraceUrls] = useState<Record<string, string>>(initialTraceUrls ?? {});
  const [usage, setUsage] = useState<TokenUsage>(initial?.usage ?? NO_USAGE);
  const [status, setStatus] = useState<SessionStatus>(initial?.status ?? 'idle');
  const [reason, setReason] = useState<RunEndReason>();
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController>(undefined);

  // A different session loaded into the same view (the Sessions tab's detail).
  useEffect(() => {
    if (!initial) return;
    setEntries(initial.timeline);
    setSessionId(initial.id);
    setTraceIds(initial.traceIds);
    setTraceUrls(initialTraceUrls ?? {});
    setUsage(initial.usage);
    setStatus(initial.status);
  }, [initial, initialTraceUrls]);

  useEffect(() => () => controller.current?.abort(), []);

  const upsert = (entry: TimelineEntry) =>
    setEntries((list) => {
      const index = list.findIndex((e) => e.id === entry.id);
      if (index >= 0) return list.map((e, i) => (i === index ? entry : e));
      const base = entry.type === 'user' ? list.filter((e) => !(e.type === 'user' && e.id.startsWith(LOCAL))) : list;
      return [...base, entry];
    });

  const localError = (message: string) =>
    upsert({
      id: `${LOCAL}${nanoid(6)}`,
      type: 'error',
      message,
      at: new Date().toISOString(),
    });

  const consume = async (path: string, body: unknown) => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setRunning(true);
    setReason(undefined);
    setStatus('running');
    let finished = false;
    let failed = false;
    try {
      await streamEvents(
        path,
        body,
        (name, data) => {
          // A failure the run itself could not record arrives as a named `error` event.
          if (name === 'error') {
            failed = true;
            setStatus('error');
            return localError((data as { message?: string }).message ?? 'The run failed');
          }
          const event = data as AgentStreamEvent;
          if (event.type === 'run.started') {
            setSessionId(event.sessionId);
            const traceId = event.traceId;
            if (traceId) setTraceIds((ids) => (ids.includes(traceId) ? ids : [...ids, traceId]));
            const traceUrl = event.traceUrl;
            if (traceId && traceUrl) setTraceUrls((urls) => ({ ...urls, [traceId]: traceUrl }));
          } else if (event.type === 'entry') {
            upsert(event.entry);
          } else if (event.type === 'run.finished') {
            finished = true;
            setSessionId(event.sessionId);
            setStatus(event.status);
            setReason(event.reason);
            setUsage(event.usage);
          }
        },
        c.signal,
      );
      if (!finished && !failed && !c.signal.aborted) {
        setStatus('error');
        localError('The run ended without a result. Check the server log.');
      }
    } catch (error) {
      if (c.signal.aborted) return;
      setStatus('error');
      localError((error as Error).message);
    } finally {
      if (controller.current === c) {
        controller.current = undefined;
        setRunning(false);
        if (c.signal.aborted && !finished) setStatus('idle');
      }
    }
  };

  const send = (message: string) => {
    upsert({
      id: `${LOCAL}${nanoid(6)}`,
      type: 'user',
      text: message,
      at: new Date().toISOString(),
    });
    return consume(`/api/agents/${agentId}/chat`, {
      message,
      ...(sessionId && { sessionId }),
    });
  };

  const decide = (callId: string, approved: boolean) => {
    if (!sessionId) return Promise.resolve();
    return consume(`/api/agents/${agentId}/sessions/${sessionId}/approvals`, {
      callId,
      approved,
    });
  };

  /** Stops reading the stream. */
  const stop = () => controller.current?.abort();

  const reset = () => {
    controller.current?.abort();
    controller.current = undefined;
    setRunning(false);
    setEntries([]);
    setSessionId(undefined);
    setTraceIds([]);
    setUsage(NO_USAGE);
    setStatus('idle');
    setReason(undefined);
  };

  /** Opens an earlier session of this agent in the chat: what was said so far, and the next message continues it. */
  const load = async (id: string) => {
    controller.current?.abort();
    controller.current = undefined;
    const body = await api<{ session: AgentSession; traceUrls?: Record<string, string> }>(`/api/agents/${agentId}/sessions/${encodeURIComponent(id)}`);
    setRunning(false);
    setEntries(body.session.timeline);
    setSessionId(body.session.id);
    setTraceIds(body.session.traceIds);
    setTraceUrls(body.traceUrls ?? {});
    setUsage(body.session.usage);
    setStatus(body.session.status);
    setReason(undefined);
  };

  const awaitingApproval = entries.some((e) => e.type === 'tool' && e.status === 'awaiting_approval');
  return {
    entries,
    sessionId,
    traceIds,
    traceUrls,
    usage,
    status,
    reason,
    running,
    awaitingApproval,
    send,
    decide,
    stop,
    reset,
    load,
  };
}

export const REASON_LABEL: Record<RunEndReason, string> = {
  completed: 'Completed',
  awaiting_approval: 'Waiting for approval',
  max_iterations: 'Stopped: reached the iteration limit (Settings → Max iterations)',
  budget: 'Stopped: the session token budget is used up',
  error: 'Stopped by an error',
  canceled: 'Canceled',
};
