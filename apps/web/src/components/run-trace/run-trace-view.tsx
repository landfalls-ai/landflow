'use client';
/**
 * Run Trace of one execution: header (live or finished, who is working now, reported vs checked), the Needs you strip,
 * the Story | Trace | Team | Report tabs, a time slider to replay the run, and the detail of a tapped row.
 * Phone first: one column; `/runs/:id` shows it full screen, the execution page embeds it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Hourglass, Pause, Play, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { decideGate, decideToolApprovals, resolveCheck, useRunJournal, type RunJournal } from '@/lib/client/run-trace';
import { api } from '@/lib/client/api';
import { useWorkingMembers } from '@/lib/client/run-controls';
import type { ExecutionRecord } from '@/lib/shared/types';
import { RUN_PROFILES, resolveRunProfile } from '@/lib/shared/run-profiles';
import { foldChanges } from '@/lib/shared/run-changes';
import { githubOf } from '@/lib/shared/run-repo';
import { lineCommentsNote } from '@/lib/shared/line-comments';
import { buildRunReport, checksLine, type RunReport } from '@/lib/shared/run-report';
import { cut, fmtMs, foldJournal, preview, quietMs, type NeedsYouItem, type RunCheckItem, type RunModel } from '@/lib/shared/run-trace-model';
import { useNow } from '../run/run-status';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Textarea } from '../ui/inputs';
import { Artifacts } from './artifacts';
import { LineCommentsProvider, useLineComments } from './line-comments';
import { Card, ToneBadge, clock } from './parts';
import { Report } from './report';
import { MembersAtWork, RerunOfBadge, RunControlsProvider } from './run-controls';
import { TakeOver } from '../editor/team-pause';
import { DetailSheet, type Open } from './sheet';
import { Story } from './story';
import { Team } from './team';
import { Trace } from './trace';

const TABS = [
  ['story', 'Story'],
  ['trace', 'Trace'],
  ['team', 'Team'],
  ['artifacts', 'Artifacts'],
  ['report', 'Report'],
] as const;
type Tab = (typeof TABS)[number][0];
const TAB_KEY = 'landflow-run-trace-tab';
const QUIET_MS = 5 * 60_000;

function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return TABS.some(([id]) => id === v) ? (v as Tab) : 'story';
  } catch {
    return 'story';
  }
}

/** Whether a run has agents or requests to tell (the embedded view opens on Run trace then). */
export function hasAgentSpans(model: RunModel) {
  return model.order.some((s) => s.kind === 'agent' || s.kind === 'delegate' || s.kind === 'handoff');
}

const VERDICT_TONE = { pass: 'ok', warn: 'warn', fail: 'bad' } as const;

function Head({ model, report, now, replay }: { model: RunModel; report?: RunReport; now: number; replay: boolean }) {
  const quiet = !replay ? quietMs(model, now) : 0;
  const working = model.working.slice(-2);
  const waiting = model.status === 'waiting' || model.needsYou.some((n) => n.kind === 'wait');
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <RerunOfBadge model={model} />
      {model.live ? (
        <Badge tone="warning">
          <span className="size-1.5 rounded-full bg-warn animate-pulse-soft" />
          {replay ? 'Replay' : 'Live'} · {fmtMs(model.t1 - model.t0)}
        </Badge>
      ) : waiting ? (
        <Badge tone="accent">
          <Hourglass className="size-3" /> Waiting · {fmtMs(model.t1 - model.t0)}
        </Badge>
      ) : (
        <Badge tone={model.status === 'success' ? 'success' : model.status === 'error' ? 'danger' : 'muted'}>
          {model.status === 'success' ? 'Finished' : model.status === 'error' ? 'Failed' : model.status} · {fmtMs(model.t1 - model.t0)}
        </Badge>
      )}
      {quiet >= QUIET_MS && model.live && (
        <Badge tone="danger" title="No new event from the run">
          <TriangleAlert className="size-3" /> Quiet for {Math.floor(quiet / 60_000)} min
        </Badge>
      )}
      {working.map((w) => (
        <Badge key={w.spanId} tone="neutral" className="max-w-full">
          <span className="truncate">
            {w.actor.name} {w.actor.type === 'human' ? 'deciding' : 'working'} · {cut(w.name, 40)}
          </span>
        </Badge>
      ))}
      {!model.live && !waiting && !model.empty && (
        <>
          {model.outcome.reported && (
            <Badge tone="muted" className="max-w-full">
              <span className="truncate">Reported: {preview(model.outcome.reported.text, 40)}</span>
            </Badge>
          )}
          {report && (
            <ToneBadge tone={VERDICT_TONE[report.verdict]}>
              {report.label} · {checksLine(report)}
            </ToneBadge>
          )}
        </>
      )}
      {model.run?.attrs?.rebuilt === true && (
        <Badge tone="muted" title="This run was recorded before Run Trace: its trace was rebuilt from the run data. Progress notes, artifacts, checks and decisions were not kept.">
          Rebuilt from the run data
        </Badge>
      )}
    </div>
  );
}

function NeedsYou({
  items,
  executionId,
  executionHref,
  open,
  onResolve,
  busy,
  onDecided,
}: {
  items: NeedsYouItem[];
  executionId: string;
  executionHref?: string;
  open: (o: Open) => void;
  onResolve: (item: RunCheckItem, decision: 'accepted' | 'sent_back') => void;
  busy?: string;
  onDecided: () => void;
}) {
  const [deciding, setDeciding] = useState<string>();
  // Send back's note: the line comments from the Artifacts tab, or what the person wrote over them.
  const store = useLineComments();
  const comments = store?.comments ?? [];
  const [draft, setDraft] = useState<string>();
  const [noting, setNoting] = useState(false);
  const note = draft ?? lineCommentsNote(comments);
  // A Run report waiting on its failed checks stands for them: they are answered together, as that wait.
  const gated = items.some((n) => n.kind === 'wait' && n.attrs.wait === 'gate');
  const shown = gated ? items.filter((n) => n.kind === 'wait') : items;
  if (!shown.length) return null;
  const gate = async (spanId: string, decision: 'accepted' | 'sent_back') => {
    setDeciding(`${spanId}:${decision}`);
    try {
      await decideGate(executionId, decision, decision === 'sent_back' ? note.trim() || undefined : undefined);
      toast.success(decision === 'accepted' ? 'Accepted as is' : 'Sent back for a fix');
      if (decision === 'sent_back') {
        store?.clear();
        setDraft(undefined);
      }
      onDecided();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeciding(undefined);
    }
  };
  const decide = async (spanId: string, approved: boolean) => {
    setDeciding(`${spanId}:${approved}`);
    try {
      const done = await decideToolApprovals(executionId, approved);
      if (done) {
        toast.success(approved ? 'Approved' : 'Rejected');
        onDecided();
      } else if (executionHref) {
        toast.message('Open the run to answer this one');
        window.location.assign(executionHref);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeciding(undefined);
    }
  };
  return (
    <div className="flex flex-col gap-2" aria-label="Needs you">
      {shown.map((n) =>
        n.kind === 'wait' ? (
          <Card key={`w${n.spanId}`} tone="warn" className="bg-warndim">
            <div className="text-[13px] text-t1">
              <b>{n.attrs.wait === 'pause' ? n.title : `Needs ${n.actor.name}`}</b>
              <span className="text-t2">
                {' '}
                · {n.attrs.wait === 'pause' ? 'paused' : n.caller ? `${n.caller.name} waiting` : 'waiting'} since {clock(n.since)}
              </span>
            </div>
            <p className="mt-1 line-clamp-3 text-[13.5px] text-t1">{n.detail ?? n.title}</p>
            {n.attrs.wait === 'gate' && (comments.length > 0 || noting) && (
              <div className="mt-2 flex flex-col gap-1">
                <label htmlFor={`note-${n.spanId}`} className="text-[12px] text-t2">
                  Note for Send back
                  {comments.length > 0 && ` · ${comments.length} line comment${comments.length === 1 ? '' : 's'} from the Artifacts tab`}
                </label>
                <Textarea id={`note-${n.spanId}`} rows={Math.min(8, note.split('\n').length + 1)} value={note} onChange={(e) => setDraft(e.target.value)} placeholder="What should the fix change?" />
              </div>
            )}
            <div className="mt-2.5 flex flex-wrap gap-2">
              {n.attrs.wait === 'gate' ? (
                <>
                  <Button variant="outline" loading={deciding === `${n.spanId}:accepted`} disabled={Boolean(deciding)} onClick={() => gate(n.spanId, 'accepted')}>
                    Accept as is
                  </Button>
                  <Button variant="primary" loading={deciding === `${n.spanId}:sent_back`} disabled={Boolean(deciding)} onClick={() => gate(n.spanId, 'sent_back')}>
                    Send back for a fix
                  </Button>
                  {!comments.length && !noting && (
                    <Button variant="ghost" onClick={() => setNoting(true)}>
                      Add a note
                    </Button>
                  )}
                </>
              ) : n.attrs.wait === 'approval' ? (
                <>
                  <Button variant="primary" loading={deciding === `${n.spanId}:true`} disabled={Boolean(deciding)} onClick={() => decide(n.spanId, true)}>
                    Approve
                  </Button>
                  <Button variant="danger" loading={deciding === `${n.spanId}:false`} disabled={Boolean(deciding)} onClick={() => decide(n.spanId, false)}>
                    Reject
                  </Button>
                </>
              ) : n.attrs.wait === 'pause' ? (
                <TakeOver executionId={executionId} member={String(n.attrs.member ?? n.actor.name)} remote={n.attrs.mode === 'redirect'} onDone={onDecided} className="w-full" />
              ) : n.attrs.wait === 'form' ? (
                // A form wait (a team member's question among them) is answered on the run's form page.
                <a
                  href={`/form/waiting/${executionId}`}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex h-8 items-center rounded-full bg-ac2 px-[15px] text-[13px] font-semibold text-on-ac hover:bg-ac2-hover"
                >
                  Answer
                </a>
              ) : (
                executionHref && (
                  <Link
                    href={executionHref}
                    className="inline-flex h-8 items-center rounded-full bg-ac2 px-[15px] text-[13px] font-semibold text-on-ac hover:bg-ac2-hover"
                  >
                    Open to answer
                  </Link>
                )
              )}
              <Button variant="outline" onClick={() => open({ kind: 'span', id: n.spanId })}>
                Details
              </Button>
            </div>
          </Card>
        ) : (
          <Card key={`c${n.check.id}`} tone="bad" className="bg-rddim">
            <div className="text-[13px] text-t1">
              <b>Check failed</b>
              <span className="text-t2"> · {cut(n.title, 60)}</span>
            </div>
            {n.detail && <p className="mt-1 line-clamp-3 text-[13px] text-t2">{n.detail}</p>}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button variant="outline" loading={busy === n.check.id} disabled={Boolean(busy)} onClick={() => onResolve(n.check, 'accepted')}>
                Accept as is
              </Button>
              <Button variant="primary" loading={busy === n.check.id} disabled={Boolean(busy)} onClick={() => onResolve(n.check, 'sent_back')}>
                Send back for a fix
              </Button>
              <Button variant="ghost" onClick={() => open({ kind: 'check', id: n.check.id })}>
                Details
              </Button>
            </div>
          </Card>
        ),
      )}
    </div>
  );
}

export function RunTraceView({ executionId, executionHref, className }: { executionId: string; executionHref?: string; className?: string }) {
  const journal = useRunJournal(executionId);
  return <RunTraceBody executionId={executionId} executionHref={executionHref} className={className} journal={journal} />;
}

/** The trace of a journal the caller already loaded (the execution page reads it once for its view switch). */
export function RunTraceBody(props: Parameters<typeof TraceBody>[0]) {
  const { executionId } = props;
  // Which workflow the run is of and whether it re-ran another: the controls (re-run, copy to the editor) and the header use them.
  const [meta, setMeta] = useState<Pick<ExecutionRecord, 'workflowId' | 'rerunOf'>>();
  useEffect(() => {
    let cancelled = false;
    setMeta(undefined);
    api<{ execution: ExecutionRecord }>(`/api/executions/${executionId}`)
      .then((r) => !cancelled && setMeta({ workflowId: r.execution.workflowId, rerunOf: r.execution.rerunOf }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [executionId]);
  // Line comments on diffs are kept per run and read by the gate's Send back.
  return (
    <RunControlsProvider value={{ executionId, workflowId: meta?.workflowId, rerunOf: meta?.rerunOf }}>
      <LineCommentsProvider executionId={executionId}>
        <TraceBody {...props} />
      </LineCommentsProvider>
    </RunControlsProvider>
  );
}

function TraceBody({
  executionId,
  executionHref,
  className,
  journal,
}: {
  executionId: string;
  executionHref?: string;
  className?: string;
  journal: RunJournal;
}) {
  const { events, model: full, loading, error, refresh } = journal;
  const [tab, setTabState] = useState<Tab>('story');
  const [cursor, setCursor] = useState<number>();
  const [target, setTarget] = useState<Open>();
  const [busy, setBusy] = useState<string>();
  const [settled, setSettled] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState(false);

  const working = useWorkingMembers(executionId, full.live);

  // A link from a team node's ribbon (?tab=team&member=Developer) opens that tab, and the member's sheet once it loads.
  const [wanted, setWanted] = useState<string>();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const asked = params.get('tab');
    setTabState(asked && TABS.some(([id]) => id === asked) ? (asked as Tab) : readTab());
    const member = params.get('member');
    if (member) setWanted(member);
    // A link from a notebook note (?span=<id>) opens the span the note was written in.
    const span = params.get('span');
    if (span) setWantedSpan(span);
  }, []);
  const [wantedSpan, setWantedSpan] = useState<string>();
  useEffect(() => {
    if (!wantedSpan || full.empty) return;
    if (wantedSpan in full.spans) setTarget({ kind: 'span', id: wantedSpan });
    setWantedSpan(undefined);
  }, [wantedSpan, full]);
  useEffect(() => {
    if (!wanted || full.empty) return;
    const stats = full.actors.find((a) => a.actor.name.trim().toLowerCase() === wanted.trim().toLowerCase());
    if (!stats) return;
    setTarget({ kind: 'actor', id: stats.actor.id });
    setWanted(undefined);
  }, [wanted, full]);
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {}
  };

  const now = useNow(full.live || playing, 1000);
  // Follow the end of a live run unless the slider was moved; a replay folds at the cursor.
  const replay = cursor !== undefined && cursor < (full.live ? now : full.t1) - 1000;
  const model = useMemo(
    () => (replay ? foldJournal(events, { until: cursor }) : full.live ? foldJournal(events, { now }) : full),
    [events, full, replay, cursor, now],
  );
  // Code changes and the repository, from the journal up to the slider (the Artifacts tab, the detail sheet's diffs and links).
  const seen = useMemo(() => (replay ? events.filter((e) => Date.parse(e.at) <= (cursor as number)) : events), [events, replay, cursor]);
  const changes = useMemo(() => foldChanges(seen), [seen]);
  const github = useMemo(() => githubOf(seen), [seen]);

  // The Run report's checks, live, with the run's profile or the one picked on the Report tab: the header's verdict and the tab.
  const [profileId, setProfileId] = useState<keyof typeof RUN_PROFILES>();
  const report = useMemo(
    () => (model.empty ? undefined : buildRunReport(model, profileId ? RUN_PROFILES[profileId] : resolveRunProfile(model.run?.attrs.profile), { changes })),
    [model, profileId, changes],
  );

  // "Watch": replay from the start to the end at 30x.
  useEffect(() => {
    if (!playing) return;
    const end = full.live ? now : full.t1;
    const timer = setInterval(() => {
      setCursor((c) => {
        const next = (c ?? full.t0) + 3000;
        if (next >= end) {
          setPlaying(false);
          return undefined;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(timer);
  }, [playing, full.t0, full.t1, full.live, now]);

  const open = useCallback((o: Open) => setTarget(o), []);
  const onJump = useCallback((ms: number) => {
    setPlaying(false);
    setCursor(ms);
  }, []);

  const onResolve = async (item: RunCheckItem, decision: 'accepted' | 'sent_back') => {
    setBusy(item.id);
    try {
      await resolveCheck(executionId, {
        spanId: item.spanId,
        name: item.check.name,
        ...(item.check.subject && { subject: item.check.subject }),
        decision,
      });
      setSettled((s) => new Set(s).add(item.id));
      toast.success(decision === 'accepted' ? 'Accepted as is' : 'Sent back for a fix');
      refresh();
      setTarget(undefined);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (loading && !events.length)
    return (
      <div className={cn('flex flex-col gap-3 p-4', className)} aria-busy>
        {[60, 90, 75].map((w, i) => (
          <div key={i} className="h-12 rounded-2xl bg-acdim animate-pulse-soft" style={{ width: `${w}%`, animationDelay: `${i * 100}ms` }} />
        ))}
      </div>
    );
  if (error && !events.length) return <EmptyState title="The run trace could not be loaded" hint={error} />;
  if (model.empty && !events.length)
    return (
      <EmptyState
        title="No trace for this run"
        hint="Runs from before Run Trace, runs past the retention period and runs started with trace content off have no journal."
        className={className}
      />
    );

  const needs = replay ? [] : model.needsYou.filter((n) => n.kind !== 'check' || !settled.has(n.check.id));
  const span = Math.max(1, (full.live ? now : full.t1) - full.t0);
  const at = replay ? (cursor as number) : full.live ? now : full.t1;

  return (
    <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pb-0 pt-3', className)}>
      <div className="flex flex-col gap-1.5">
        <h2 className="break-words text-[16px] font-semibold leading-tight text-t1">{model.run?.name ?? 'Run'}</h2>
        <Head model={model} report={report} now={now} replay={replay} />
      </div>

      {!replay && <MembersAtWork executionId={executionId} members={working.members} onChanged={() => { working.refresh(); refresh(); }} />}

      <NeedsYou items={needs} executionId={executionId} executionHref={executionHref} open={open} onResolve={onResolve} busy={busy} onDecided={refresh} />

      <div role="tablist" aria-label="Run views" className="grid grid-cols-5 gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`rt-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="rt-panel"
            onClick={() => setTab(id)}
            className={cn(
              'h-9 rounded-full text-[13px] text-t2 transition-all duration-200 hover:text-t1',
              tab === id && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="rt-panel" aria-labelledby={`rt-tab-${tab}`} className="min-w-0">
        {tab === 'story' && <Story model={model} open={open} />}
        {tab === 'trace' && <Trace model={model} open={open} />}
        {tab === 'team' && <Team model={model} open={open} />}
        {tab === 'artifacts' && <Artifacts executionId={executionId} model={model} changes={changes} repo={github} open={open} replay={replay} />}
        {tab === 'report' && <Report model={model} report={report} open={open} profile={profileId} onProfile={(id) => setProfileId(id as keyof typeof RUN_PROFILES | undefined)} />}
      </div>

      {/* The time slider stays at the bottom of the scrolling area. */}
      <div className="sticky bottom-0 z-30 -mx-4 mt-2 border-t border-hair bg-bg/95 px-4 pb-[max(10px,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (!playing && !replay) setCursor(full.t0);
              setPlaying(!playing);
            }}
            className="grid size-9 shrink-0 place-items-center rounded-full border border-bd text-t1 hover:border-ac"
            aria-label={playing ? 'Pause the replay' : 'Replay the run'}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" fill="currentColor" />}
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(((at - full.t0) / span) * 1000)}
            onChange={(e) => {
              setPlaying(false);
              const v = Number(e.target.value);
              setCursor(v >= 995 ? undefined : full.t0 + (v / 1000) * span);
            }}
            aria-label="Move through the run"
            aria-valuetext={`${clock(at)}`}
            className="h-9 min-w-0 flex-1 accent-[var(--ac)]"
          />
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setCursor(undefined);
            }}
            disabled={!replay}
            className="w-[72px] shrink-0 rounded-md text-right font-mono text-[12px] tabular-nums text-t2 enabled:underline enabled:decoration-dotted enabled:hover:text-t1"
            aria-label={replay ? 'Back to the end of the run' : 'Time of the run'}
          >
            {replay ? clock(at) : model.live ? 'live' : clock(at)}
          </button>
        </div>
      </div>

      {target && (
        <DetailSheet
          target={target}
          model={model}
          onClose={() => setTarget(undefined)}
          open={open}
          onJump={onJump}
          onResolve={onResolve}
          busy={Boolean(busy)}
          changes={changes}
          repo={github}
        />
      )}
    </div>
  );
}
