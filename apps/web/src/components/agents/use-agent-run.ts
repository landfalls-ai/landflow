'use client';
/**
 * Talks to an agent: POST /api/agents/:id/chat and the approvals route both answer with an SSE stream of
 * AgentStreamEvents (`data:` lines). Timeline entries are upserted by id as they stream.
 */
import { useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { api, ApiError, streamEvents } from '@/lib/client/api';
import { NOT_AVAILABLE_MESSAGE } from './project-names';
import type { AgentSession, AgentStreamEvent, RunEndReason, SessionStatus, TimelineEntry, TokenUsage } from '@/lib/shared/agents';

/** Ids of entries shown before the server echoes them. */
const LOCAL = 'local_';
const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/** AG05: what a person already decided on the session's waiting calls, by call id (`session.pending.calls[].decision`). */
export type Decisions = Record<string, 'approved' | 'denied'>;
const decisionsOf = (session: Pick<AgentSession, 'pending'> | undefined): Decisions =>
  Object.fromEntries((session?.pending?.calls ?? []).flatMap((c) => (c.decision ? [[c.callId, c.decision] as const] : [])));

/** `projectId`: the test chat's "Test in project" (the chat is given that project's block; absent: the agent's home). */
export function useAgentRun(agentId: string, initial?: AgentSession, initialTraceUrls?: Record<string, string>, projectId?: string) {
  const [entries, setEntries] = useState<TimelineEntry[]>(initial?.timeline ?? []);
  const [sessionId, setSessionId] = useState<string | undefined>(initial?.id);
  const [traceIds, setTraceIds] = useState<string[]>(initial?.traceIds ?? []);
  /** Trace UI links by trace id, when the host has LANDFLOW_TRACE_URL. */
  const [traceUrls, setTraceUrls] = useState<Record<string, string>>(initialTraceUrls ?? {});
  const [usage, setUsage] = useState<TokenUsage>(initial?.usage ?? NO_USAGE);
  const [status, setStatus] = useState<SessionStatus>(initial?.status ?? 'idle');
  const [reason, setReason] = useState<RunEndReason>();
  const [running, setRunning] = useState(false);
  const sessionIdRef = useRef<string>(undefined); // AG05: the quiet 409 refresh reads the session it was deciding in
  const controller = useRef<AbortController>(undefined);
  // AG05: the calls already decided, so their Approve and Deny go away; read from the session, updated by each decision.
  const [decisions, setDecisions] = useState<Decisions>(decisionsOf(initial));

  // A different session loaded into the same view (the Sessions tab's detail).
  useEffect(() => {
    if (!initial) return;
    setEntries(initial.timeline);
    setSessionId(initial.id);
    setTraceIds(initial.traceIds);
    setTraceUrls(initialTraceUrls ?? {});
    setUsage(initial.usage);
    setStatus(initial.status);
    setDecisions(decisionsOf(initial)); // AG05:
  }, [initial, initialTraceUrls]);

  useEffect(() => {
    sessionIdRef.current = sessionId; // AG05:
  }, [sessionId]);

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

  // A session `load` still in flight when a message is sent (or the chat is reset) must not land over the new run.
  const loadToken = useRef(0);

  // AG05: `quiet`: a 409 ("Already approved", "not waiting") means the call was decided elsewhere or a moment ago: refresh, no error.
  const consume = async (path: string, body: unknown, quiet = false) => {
    loadToken.current++;
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
      return !failed;
    } catch (error) {
      if (c.signal.aborted) return false;
      if (quiet && error instanceof ApiError && error.status === 409) {
        // AG05: say what it was decided as, then show the session as it is.
        const was = /^Already (approved|denied)/.exec(error.message)?.[1] as Decisions[string] | undefined;
        const callId = (body as { callId?: string }).callId;
        if (was && callId) setDecisions((d) => ({ ...d, [callId]: was }));
        const id = sessionIdRef.current;
        if (id) await load(id).catch(() => {});
        return true;
      }
      // AG05: a decision the server did not take is not a decision: the buttons come back.
      if (quiet) {
        const callId = (body as { callId?: string }).callId;
        if (callId)
          setDecisions((d) => {
            const { [callId]: _gone, ...rest } = d;
            return rest;
          });
      }
      setStatus('error');
      // 403 from the chat route: the agent isn't available in the chosen project (shown in the chat, not only as a toast).
      localError(projectId && error instanceof ApiError && error.status === 403 ? NOT_AVAILABLE_MESSAGE : (error as Error).message);
      return false;
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
      ...(projectId && { projectId }),
    });
  };

  // AG05: a call decided once is not decided again; a decision streams the run on only when it was the last one waiting.
  const decide = (callId: string, approved: boolean) => {
    if (!sessionId || decisions[callId]) return Promise.resolve(false);
    setDecisions((d) => ({ ...d, [callId]: approved ? 'approved' : 'denied' }));
    return consume(`/api/agents/${agentId}/sessions/${sessionId}/approvals`, { callId, approved }, true);
  };

  /** AG05: every call still waiting decided the same way, one after the other, each once; the last one resumes the run. */
  const decideAll = async (callIds: string[], approved: boolean) => {
    for (const callId of callIds) if (!(await decide(callId, approved))) break;
  };

  /** Stops reading the stream. */
  const stop = () => controller.current?.abort();

  const reset = () => {
    loadToken.current++;
    controller.current?.abort();
    controller.current = undefined;
    setRunning(false);
    setEntries([]);
    setSessionId(undefined);
    setTraceIds([]);
    setUsage(NO_USAGE);
    setStatus('idle');
    setReason(undefined);
    setDecisions({}); // AG05:
  };

  /** Opens an earlier session of this agent in the chat: what was said so far, and the next message continues it. */
  const load = async (id: string) => {
    controller.current?.abort();
    controller.current = undefined;
    setRunning(false);
    const token = ++loadToken.current;
    const body = await api<{ session: AgentSession; traceUrls?: Record<string, string> }>(`/api/agents/${agentId}/sessions/${encodeURIComponent(id)}`);
    if (token !== loadToken.current) return;
    setEntries(body.session.timeline);
    setSessionId(body.session.id);
    setTraceIds(body.session.traceIds);
    setTraceUrls(body.traceUrls ?? {});
    setUsage(body.session.usage);
    setStatus(body.session.status);
    setReason(undefined);
    setDecisions(decisionsOf(body.session)); // AG05:
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
    decideAll, // AG05:
    decisions, // AG05:
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
