'use client';
/** The Sessions tab: every conversation the agent had (test chat, schedules, channels, workflows, other agents) and its timeline. */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Bot, Clock, Code, FlaskConical, Loader2, MessagesSquare, RefreshCw, Send, Trash2, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { AgentSession, SessionSource, SessionStatus, SessionSummary } from '@/lib/shared/agents';
import type { ChatFeedback, FeedbackRating } from '@/lib/shared/chat-feedback';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Segmented } from '../ui/segmented';
import { TimelineView, TraceChip, type ToolEntry } from './timeline';
import { REASON_LABEL, useAgentRun } from './use-agent-run';

const SOURCE: Record<SessionSource, { label: string; icon: typeof Bot; tone: Tone }> = {
  test: { label: 'Test', icon: FlaskConical, tone: 'accent' },
  schedule: { label: 'Schedule', icon: Clock, tone: 'neutral' },
  telegram: { label: 'Telegram', icon: Send, tone: 'neutral' },
  slack: { label: 'Slack', icon: MessagesSquare, tone: 'neutral' },
  teams: { label: 'Teams', icon: MessagesSquare, tone: 'neutral' },
  workflow: { label: 'Workflow', icon: Workflow, tone: 'neutral' },
  agent: { label: 'Agent', icon: Bot, tone: 'neutral' },
  api: { label: 'API', icon: Code, tone: 'neutral' },
};

const STATUS: Record<SessionStatus, { label: string; tone: Tone }> = {
  idle: { label: 'Idle', tone: 'muted' },
  running: { label: 'Running', tone: 'accent' },
  awaiting_approval: { label: 'Needs approval', tone: 'warning' },
  error: { label: 'Failed', tone: 'danger' },
};

export function SourceBadge({ source }: { source: SessionSource }) {
  const meta = SOURCE[source] ?? SOURCE.api;
  return (
    <Badge tone={meta.tone}>
      <meta.icon className="size-3" /> {meta.label}
    </Badge>
  );
}

function StatusBadge({ status }: { status: SessionStatus }) {
  const meta = STATUS[status] ?? STATUS.idle;
  return (
    <Badge tone={meta.tone} className={status === 'running' ? 'animate-pulse-soft' : undefined}>
      {meta.label}
    </Badge>
  );
}

type Audience = 'all' | 'people' | 'automations';
const PAGE = 50;
const versionLabel = (version: 'draft' | number) => (version === 'draft' ? 'Draft' : `v${version}`);
const tokens = (u: { inputTokens: number; outputTokens: number }) => (u.inputTokens + u.outputTokens).toLocaleString();

function SessionDetail({
  agentId,
  sessionId,
  onBack,
  childHref,
  onChanged,
}: {
  agentId: string;
  sessionId: string;
  onBack: () => void;
  childHref?: (entry: ToolEntry) => string | undefined;
  onChanged: () => void;
}) {
  const [session, setSession] = useState<AgentSession>();
  const [traceUrls, setTraceUrls] = useState<Record<string, string>>();
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<Record<string, ChatFeedback>>({});
  const [confirm, setConfirm] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const run = useAgentRun(agentId, session, traceUrls);

  const load = useCallback(
    () =>
      api<{ session: AgentSession; traceUrls?: Record<string, string>; feedback?: ChatFeedback[] }>(`/api/agents/${agentId}/sessions/${sessionId}`, { background: true })
        .then((r) => {
          setFeedback(Object.fromEntries((r.feedback ?? []).flatMap((f) => (f.entryId ? [[f.entryId, f]] : []))));
          setTraceUrls(r.traceUrls);
          setSession(r.session);
          setError(undefined);
        })
        .catch((e: Error) => setError(e.message)),
    [agentId, sessionId],
  );

  useEffect(() => {
    setSession(undefined);
    void load();
  }, [load]);

  // A run started elsewhere (a schedule, a channel): follow it until it settles.
  useEffect(() => {
    if (session?.status !== 'running' || run.running) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [session?.status, run.running, load]);

  const decide = async (callId: string, approved: boolean) => {
    setDeciding(true);
    try {
      await run.decide(callId, approved);
    } finally {
      setDeciding(false);
      void load();
      onChanged();
    }
  };

  const rate = async (entryId: string, rating: FeedbackRating | null) => {
    try {
      await api(`/api/agents/${agentId}/sessions/${sessionId}/feedback`, { method: 'PUT', json: { entryId, rating } });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async () => {
    try {
      await api(`/api/agents/${agentId}/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      toast('Deleted the session');
      onChanged();
      onBack();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="animate-fade-up">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5" /> All sessions
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {confirm ? (
            <span className="flex items-center gap-2 animate-in">
              <span className="text-[12px] text-t2">Delete this session?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" onClick={() => void remove()}>
                Delete
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" className="hover:bg-rddim hover:text-rd" onClick={() => setConfirm(true)} disabled={!session}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          )}
        </div>
      </div>

      {error && (
        <EmptyState
          title="Could not load the session"
          hint={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      )}
      {!session && !error && (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-t3">
          <Loader2 className="size-4 animate-spin" /> Loading session…
        </div>
      )}
      {session && (
        <>
          <div className="mb-4 rounded-2xl border border-hair bg-sf px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-t1">{session.title || 'Untitled session'}</h2>
              <StatusBadge status={run.running ? 'running' : run.status} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-t3">
              <SourceBadge source={session.source} />
              <span>
                <span className="text-t2">{session.userId}</span>
                {session.conversationKey && <span className="font-mono"> · {session.conversationKey}</span>}
              </span>
              <span>{versionLabel(session.version)}</span>
              <span title={new Date(session.createdAt).toLocaleString()}>started {timeAgo(session.createdAt)}</span>
              <span className="font-mono" title="Input · output tokens">
                {run.usage.inputTokens.toLocaleString()} in · {run.usage.outputTokens.toLocaleString()} out
              </span>
              {session.parentSessionId && (
                <span>
                  delegated from{' '}
                  {session.parentAgentId ? (
                    <Link
                      href={`/agents/${session.parentAgentId}?tab=sessions&session=${encodeURIComponent(session.parentSessionId)}`}
                      className="font-mono text-ac hover:underline"
                    >
                      {session.parentSessionId}
                    </Link>
                  ) : (
                    <span className="font-mono">{session.parentSessionId}</span>
                  )}
                </span>
              )}
            </div>
            {run.traceIds.length > 0 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Traces</span>
                {run.traceIds.map((id) => (
                  <TraceChip key={id} traceId={id} url={run.traceUrls[id]} />
                ))}
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-hair bg-sf px-4 py-4">
            {run.entries.length ? (
              <TimelineView
                entries={run.entries}
                childHref={childHref}
                onDecide={(callId, approved) => void decide(callId, approved)}
                deciding={deciding}
                wide
                feedback={feedback}
                onRate={(entryId, rating) => void rate(entryId, rating)}
              />
            ) : (
              <EmptyState compact title="Nothing happened in this session yet" />
            )}
            {run.reason && run.reason !== 'completed' && !run.running && (
              <p className={cn('mt-3 text-center text-[12px]', run.reason === 'error' ? 'text-rd' : 'text-warn')}>{REASON_LABEL[run.reason]}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function SessionsTab({
  agentId,
  sessionId,
  onOpen,
  childHref,
}: {
  agentId: string;
  sessionId?: string;
  onOpen: (sessionId?: string) => void;
  childHref?: (entry: ToolEntry) => string | undefined;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  // Who the list shows: undefined until it is known whether there are people's sessions (People opens first when there are).
  const [audience, setAudience] = useState<Audience>();
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const hovering = useRef(false);
  const scrolledAt = useRef(0);

  const url = (a: Audience, cursor?: string | null) => `/api/agents/${agentId}/sessions?limit=${PAGE}${a === 'all' ? '' : `&audience=${a}`}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

  const fetchPage = useCallback((a: Audience, cursor?: string | null) => api<{ sessions: SessionSummary[]; nextCursor: string | null }>(url(a, cursor), { background: true }), [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The first page of an audience (a person's own refresh, and the quiet one). */
  const load = useCallback(
    (a: Audience) => {
      setLoading(true);
      return fetchPage(a)
        .then((r) => {
          setSessions(r.sessions);
          setNext(r.nextCursor);
          setError(undefined);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [fetchPage],
  );

  // The first look: People when there are any, else everything.
  useEffect(() => {
    let live = true;
    setAudience(undefined);
    setSessions(undefined);
    void fetchPage('people')
      .then((r) => {
        if (!live) return;
        if (r.sessions.length) {
          setAudience('people');
          setSessions(r.sessions);
          setNext(r.nextCursor);
          setError(undefined);
        } else {
          setAudience('all');
          void load('all');
        }
      })
      .catch((e: Error) => {
        if (!live) return;
        setAudience('all');
        setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [agentId, fetchPage, load]);

  const choose = (a: Audience) => {
    setAudience(a);
    setSessions(undefined);
    setNext(null);
    void load(a);
  };

  const showMore = () => {
    if (!audience || !next) return;
    setMore(true);
    fetchPage(audience, next)
      .then((r) => {
        setSessions((before) => [...(before ?? []), ...r.sessions.filter((x) => !before?.some((y) => y.id === x.id))]);
        setNext(r.nextCursor);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setMore(false));
  };

  // New sessions show up on their own, quietly: not while a hand is on the list or it is being scrolled, and only the first page.
  useEffect(() => {
    if (sessionId || !audience) return;
    const onScroll = () => (scrolledAt.current = Date.now());
    window.addEventListener('scroll', onScroll, true);
    const timer = setInterval(() => {
      if (hovering.current || Date.now() - scrolledAt.current < 2000 || document.hidden) return;
      void fetchPage(audience)
        .then((r) =>
          setSessions((before) => {
            if (!before) return r.sessions;
            // Keep any further pages already opened: replace only the first page's rows.
            const fresh = new Set(r.sessions.map((x) => x.id));
            return [...r.sessions, ...before.filter((x) => !fresh.has(x.id) && x.updatedAt < (r.sessions.at(-1)?.updatedAt ?? ''))];
          }),
        )
        .catch(() => {});
    }, 6000);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      clearInterval(timer);
    };
  }, [sessionId, audience, fetchPage]);

  const sorted = sessions ?? [];

  if (sessionId)
    return <SessionDetail agentId={agentId} sessionId={sessionId} onBack={() => onOpen(undefined)} childHref={childHref} onChanged={() => audience && void load(audience)} />;

  return (
    <div className="animate-fade-up">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented<Audience>
          label="Who the sessions are with"
          value={audience ?? 'people'}
          onChange={choose}
          options={[
            { value: 'all', label: 'All' },
            { value: 'people', label: 'People', title: 'Test chat, Telegram, Slack and Teams' },
            { value: 'automations', label: 'Automations', title: 'Schedules, workflows, other agents and the API' },
          ]}
        />
        <span className="text-[13px] text-t2">{sessions ? `${sessions.length}${next ? '+' : ''} ${sessions.length === 1 && !next ? 'session' : 'sessions'}` : 'Loading…'}</span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Refresh" title="Refresh" onClick={() => audience && void load(audience)}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>
      {error && <p className="mb-3 rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">{error}</p>}
      {sessions && !sessions.length && (
        <div className="rounded-2xl border border-hair bg-sf">
          <EmptyState
            title={audience === 'people' ? 'No conversations with people yet' : audience === 'automations' ? 'Nothing has run on its own yet' : 'No sessions yet'}
            hint={
              audience === 'people'
                ? 'Your test chats and the conversations on Telegram, Slack and Teams land here.'
                : audience === 'automations'
                  ? 'Schedules, workflows, other agents and the API land here.'
                  : 'Every conversation lands here: the test chat, schedules, Telegram, workflows and other agents.'
            }
            action={<MessagesSquare className="size-6 text-t3" strokeWidth={1.5} />}
          />
        </div>
      )}
      {sorted.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-hair bg-sf" onMouseEnter={() => (hovering.current = true)} onMouseLeave={() => (hovering.current = false)}>
          <div className="hidden grid-cols-[92px_minmax(0,1fr)_110px_56px_56px_72px_56px_72px] gap-3 border-b border-hair px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 md:grid">
            <span>Source</span>
            <span>Session</span>
            <span>Status</span>
            <span className="text-right">Turns</span>
            <span className="text-right">Tools</span>
            <span className="text-right">Tokens</span>
            <span>Version</span>
            <span className="text-right">Updated</span>
          </div>
          {sorted.map((s) => (
            <button
              key={s.id}
              onClick={() => onOpen(s.id)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-hair px-4 py-2.5 text-left text-[12px] transition-colors last:border-b-0 hover:bg-acdim md:grid-cols-[92px_minmax(0,1fr)_110px_56px_56px_72px_56px_72px]"
            >
              <span className="hidden md:block">
                <SourceBadge source={s.source} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-t1">{s.title || 'Untitled session'}</span>
                <span className="block truncate text-t3">
                  {s.userId}
                  {s.parentSessionId && ' · delegated'}
                </span>
              </span>
              <span className="justify-self-end md:justify-self-start">
                <StatusBadge status={s.status} />
              </span>
              <span className="col-span-2 flex flex-wrap gap-x-3 text-t3 md:hidden">
                <SourceBadge source={s.source} />
                <span>{s.turns} turns</span>
                <span>{s.toolCalls} tools</span>
                <span>{tokens(s.usage)} tokens</span>
                <span>{versionLabel(s.version)}</span>
                <span>{timeAgo(s.updatedAt)}</span>
              </span>
              <span className="hidden text-right tabular-nums text-t2 md:block">{s.turns}</span>
              <span className="hidden text-right tabular-nums text-t2 md:block">{s.toolCalls}</span>
              <span className="hidden text-right font-mono text-t2 md:block">{tokens(s.usage)}</span>
              <span className="hidden text-t2 md:block">{versionLabel(s.version)}</span>
              <span className="hidden text-right tabular-nums text-t2 md:block">{timeAgo(s.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
      {next && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="outline" loading={more} onClick={showMore} className="max-md:min-h-11">
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}
