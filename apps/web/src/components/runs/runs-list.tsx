'use client';
/**
 * Runs → All runs (docs/run-trace.md#the-runs-list): every run of every workflow, live. One filter row, repeated failures
 * folded into one row that opens, two words for starting a run again, and two ticked rows to compare. A row opens the run
 * inside its workflow's Runs tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bug, ChevronDown, ChevronLeft, Copy, ExternalLink, GitCompareArrows, ListRestart, MoreHorizontal, OctagonX, RotateCcw, Square, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { duration, plural, timeAgo } from '@/lib/client/format';
import { useLiveEvents } from '@/lib/client/live';
import type { ExecutionSummary } from '@/lib/shared/types';
import type { RunSearchResult } from '@/lib/server/journal/runs-query';
import { useViewer } from '@/components/auth/viewer';
import { can } from '@/lib/shared/auth';
import { RERUN_CHOICES, RERUN_LABEL, RERUN_WORD, RETRY_CHOICES, RETRY_LABEL, canRetry, deleteExecution, retryTitle, startRerun, startRetry, stopAllExecutions, stopAllSummary, type RerunBody, type RetryBody } from '@/components/executions/meta';
import { RUN_STATE, RunStateIcon, formatStamp, runStateOf, useNow } from '@/components/run/run-status';
import { LiveRuns, NeedsYouList } from '@/components/run-trace/run-lists';
import { TrendChart } from '@/components/run-trace/trend-chart';
import type { RunMeasure } from '@/lib/shared/run-compare';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Checkbox, Switch } from '@/components/ui/inputs';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '@/components/ui/popover';
import { groupFailures, groupTitle, type RunRow } from './failure-groups';
import { RunsFilters } from './runs-filters';
import { filtersQuery, matchesFilters, needsJournal, parseFilters, runsHref, type RunFilters } from './runs-query';

const LIMIT = 200;
const POLL_MS = 8000;
const AUTO_KEY = 'landflow-executions-autorefresh';
// Desktop: a table. Phone: a card per run, name and menu, then status and run time, then when it started.
const COLS = 'md:grid-cols-[minmax(180px,1.6fr)_minmax(120px,0.9fr)_minmax(150px,1fr)_96px_40px] max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-y-1';
const NEW_ROW: CSSProperties = { animation: 'lf-slide-right 0.24s cubic-bezier(0.22, 1, 0.36, 1) both, lf-flash 1.2s ease-out' };

const hrefOf = (e: ExecutionSummary) => `/workflows/${e.workflowId}/executions/${e.id}`;

type MenuView = 'main' | 'retry' | 'rerun' | 'delete';

/** The ⋯ of a run: Open, Debug, the two re-run words (their choices one step in), Copy id, Cancel or Delete. */
function RowMenu({ execution, onChanged }: { execution: ExecutionSummary; onChanged: () => void }) {
  const router = useRouter();
  const [view, setView] = useState<MenuView>('main');
  const live = execution.status === 'running';
  // A queued run hasn't started: it can only be canceled (DELETE takes it out of the queue).
  const queued = execution.status === 'queued';
  const again = async (start: () => Promise<string>, label: string) => {
    try {
      const id = await start();
      toast.success(label);
      router.push(`/workflows/${execution.workflowId}/executions/${id}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const retry = (body: RetryBody) => again(() => startRetry(execution.id, body), body.from === 'start' ? 'Retrying from the start' : execution.error?.nodeName ? `Retrying from “${execution.error.nodeName}”` : 'Retrying the run');
  const rerun = (body: RerunBody) => again(() => startRerun(execution.id, body), 'Re-running with the same input');
  const remove = async () => {
    try {
      await deleteExecution(execution.id);
      toast.success(live ? 'Canceling the run' : queued ? 'Queued run canceled' : 'Run deleted');
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const copyId = () => {
    navigator.clipboard
      ?.writeText(execution.id)
      .then(() => toast.success('Run id copied'))
      .catch(() => toast.error('Could not copy the id'));
  };
  return (
    <Popover
      title="Run"
      trigger={({ open, toggle }) => (
        <button
          onClick={() => {
            setView('main');
            toggle();
          }}
          aria-label="Run actions"
          aria-expanded={open}
          className={cn('relative z-10 grid size-7 place-items-center rounded-full text-t3 transition-colors hover:bg-acdim hover:text-t1 max-md:size-11', open && 'bg-acdim text-t1')}
        >
          <MoreHorizontal className="size-4" />
        </button>
      )}
      className="w-[250px]"
    >
      {(close) => {
        if (view === 'delete')
          return (
            <div role="alertdialog" aria-label="Delete this run?" className="p-2">
              <p className="text-[13px] font-semibold text-t1">Delete this run?</p>
              <p className="mt-1 text-[12px] text-t2">It is removed from the history for good.</p>
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={() => setView('main')} className="h-7 rounded-full px-3 text-[12px] font-semibold max-md:h-11 max-md:px-4 text-t2 hover:bg-acdim">
                  Cancel
                </button>
                <button
                  onClick={() => {
                    close();
                    void remove();
                  }}
                  className="h-7 rounded-full border border-rdbd bg-rddim px-3 text-[12px] font-semibold text-rd hover:border-rd max-md:h-11 max-md:px-4"
                >
                  Delete
                </button>
              </div>
            </div>
          );
        if (view === 'retry' || view === 'rerun') {
          const choices = view === 'retry' ? RETRY_CHOICES : RERUN_CHOICES;
          return (
            <>
              <button type="button" onClick={() => setView('main')} className="flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[12px] font-semibold text-t2 hover:bg-acdim">
                <ChevronLeft className="size-3.5" /> {view === 'retry' ? RETRY_LABEL : RERUN_WORD}
              </button>
              <MenuSeparator />
              {choices.map((choice) => (
                <MenuItem
                  key={choice.label}
                  onClick={() => {
                    close();
                    void (view === 'retry' ? retry(choice.body as RetryBody) : rerun(choice.body as RerunBody));
                  }}
                >
                  {choice.label}
                </MenuItem>
              ))}
            </>
          );
        }
        return (
          <>
            <MenuItem onClick={() => router.push(hrefOf(execution))}>
              <ExternalLink /> Open
            </MenuItem>
            {!live && !queued && (
              <MenuItem onClick={() => router.push(`/workflows/${execution.workflowId}?execution=${execution.id}`)}>
                <Bug /> Debug in editor
              </MenuItem>
            )}
            {!live && !queued && (
              <>
                <MenuSeparator />
                {canRetry(execution) && (
                  <MenuItem onClick={() => setView('retry')} hint="›">
                    <ListRestart /> {RETRY_LABEL}
                  </MenuItem>
                )}
                <MenuItem onClick={() => setView('rerun')} hint="›">
                  <RotateCcw /> {RERUN_WORD}
                </MenuItem>
              </>
            )}
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                close();
                copyId();
              }}
            >
              <Copy /> Copy id
            </MenuItem>
            {live || queued ? (
              <MenuItem
                danger
                onClick={() => {
                  close();
                  void remove();
                }}
              >
                <Square /> Cancel run
              </MenuItem>
            ) : (
              <MenuItem danger onClick={() => setView('delete')}>
                <Trash2 /> Delete…
              </MenuItem>
            )}
          </>
        );
      }}
    </Popover>
  );
}

function Row({ execution, now, index, isNew, onChanged, picked, onPick, nested }: { execution: ExecutionSummary; now: number; index: number; isNew: boolean; onChanged: () => void; picked: boolean; onPick: () => void; nested?: boolean }) {
  const state = runStateOf(execution);
  const live = execution.status === 'running';
  const failed = execution.status === 'error';
  const queued = execution.status === 'queued';
  const ms = live ? Math.max(0, now - Date.parse(execution.startedAt)) : execution.durationMs;
  return (
    <div
      role="row"
      className={cn(
        'group relative grid items-center gap-3 border-b border-hair px-4 py-2.5 text-[13px] transition-colors duration-150 last:border-b-0',
        // A phone: each run its own rounded card, like Workflows.
        'max-md:overflow-hidden max-md:rounded-2xl max-md:border max-md:last:border-b',
        COLS,
        nested && 'md:pl-8',
        failed ? 'bg-rddim hover:bg-[color-mix(in_oklab,var(--rd)_12%,var(--sf))]' : 'hover:bg-sf2 max-md:bg-sf',
        picked && 'outline outline-1 -outline-offset-1 outline-ac',
        !isNew && 'animate-fade-up',
      )}
      style={isNew ? NEW_ROW : { animationDelay: `${Math.min(index, 20) * 20}ms` }}
    >
      {/* The whole row is a link; the checkbox and the menu sit above it. */}
      <Link href={hrefOf(execution)} className="absolute inset-0" aria-label={`Open the run of ${execution.workflowName}, ${execution.status}`} />
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', RUN_STATE[state].bar)} />
      <div role="cell" className="flex min-w-0 items-center gap-1.5 max-md:col-start-1 max-md:row-start-1 max-md:flex-wrap">
        <span className="relative z-10 flex max-md:size-11 max-md:-my-2 max-md:-ml-2 max-md:items-center max-md:justify-center">
          <Checkbox checked={picked} onChange={onPick} ariaLabel={`Pick the run of ${execution.workflowName} ${timeAgo(execution.startedAt)} to compare`} />
        </span>
        <span className="truncate font-semibold text-t1">{execution.workflowName}</span>
        {execution.rerunOf && <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--viz-1)_14%,transparent)] px-2 text-[11px] text-viz-1">{RERUN_LABEL[execution.rerunOf.scope].toLowerCase()}</span>}
        {execution.debug && <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--viz-2)_14%,transparent)] px-2 text-[11px] text-viz-2">debug</span>}
        {execution.retryOf && (
          <span title={retryTitle(execution)} className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--viz-7)_14%,transparent)] px-2 text-[11px] text-viz-7">
            retry #{execution.retryAttempt ?? 1}
          </span>
        )}
        {execution.retriedBy && (
          <span title={`Retried by ${execution.retriedBy}`} className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--viz-7)_14%,transparent)] px-2 text-[11px] text-viz-7">
            retried
          </span>
        )}
        {execution.resumedAfterRestart && (
          <span title="The host restarted during the run; it continued from its last checkpoint" className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--viz-4)_14%,transparent)] px-2 text-[11px] text-viz-4">
            resumed after restart
          </span>
        )}
      </div>
      <div role="cell" className={cn('flex min-w-0 items-center gap-1.5 font-semibold max-md:col-start-1 max-md:row-start-2', RUN_STATE[state].text)}>
        <RunStateIcon state={state} />
        <span className="truncate">{state === 'paused' && execution.paused ? `Paused · ${execution.paused.nodeName}` : RUN_STATE[state].label}</span>
      </div>
      <div role="cell" className="min-w-0 max-md:col-span-full max-md:row-start-3 max-md:flex max-md:gap-1.5 max-md:text-[12px]">
        <div className="truncate tabular-nums text-t1 max-md:text-t2">{formatStamp(execution.startedAt)}</div>
        <div className="text-[11px] text-t3 max-md:text-[12px]">
          <span className="md:hidden">· </span>
          {timeAgo(execution.startedAt)}
        </div>
      </div>
      <div role="cell" className={cn('font-mono text-[12px] tabular-nums max-md:col-start-2 max-md:row-start-2 max-md:justify-self-end', live ? 'text-warn' : 'text-t2')}>
        {queued ? '—' : duration(ms)}
      </div>
      <div role="cell" className="flex justify-end max-md:col-start-2 max-md:row-start-1">
        <RowMenu execution={execution} onChanged={onChanged} />
      </div>
      {failed && execution.error && (
        <div className="col-span-full -mt-1 flex min-w-0 items-center gap-3 text-[12px] text-rd max-md:mt-0 max-md:flex-wrap max-md:gap-y-1">
          <span className="truncate max-md:line-clamp-2 max-md:whitespace-normal">
            {execution.error.nodeName && <span className="font-semibold">{execution.error.nodeName}: </span>}
            {execution.error.message}
          </span>
          {execution.retryAt && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-viz-7">
              <Timer className="size-3" /> Automatic retry at <span className="tabular-nums">{formatStamp(execution.retryAt)}</span>
            </span>
          )}
        </div>
      )}
      {live && <div className="lf-shimmer absolute inset-x-0 bottom-0 h-[2px]" />}
    </div>
  );
}

/** "Failed ×9 · Post to Slack: no credential": one row for the repeats; it opens to the runs. */
function GroupRow({ group, children }: { group: Extract<RunRow, { kind: 'group' }>; children: (open: boolean) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const latest = group.runs[0];
  return (
    <>
      <div role="row" className="relative border-b border-hair bg-rddim last:border-b-0 max-md:overflow-hidden max-md:rounded-2xl max-md:border">
        <span className="absolute inset-y-0 left-0 w-[3px] bg-rd" />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${groupTitle(group)}, ${open ? 'hide' : 'show'} the ${group.runs.length} runs`}
          className="flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left text-[13px] hover:bg-[color-mix(in_oklab,var(--rd)_12%,var(--sf))] max-md:min-h-11 max-md:items-start"
        >
          <ChevronDown className={cn('size-4 shrink-0 text-rd transition-transform max-md:mt-0.5', !open && '-rotate-90')} />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-rd max-md:whitespace-normal md:truncate">{groupTitle(group)}</span>
            <span className="block text-[12px] text-t2">
              {group.workflowName} · latest {timeAgo(latest.startedAt)}
            </span>
          </span>
        </button>
      </div>
      {children(open)}
    </>
  );
}

/** Header action: stop every run of every workflow, after a confirm. Shown only while something runs. */
function StopAllButton({ onStopped }: { onStopped: () => void }) {
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      const summary = stopAllSummary(await stopAllExecutions());
      if (summary) toast.success(summary);
      else toast('Nothing was running');
      onStopped();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover
      title="Stop all runs?"
      trigger={({ open, toggle }) => (
        <Button size="sm" variant={open ? 'danger' : 'outline'} onClick={toggle} loading={busy} aria-expanded={open} className="max-md:h-11">
          {!busy && <OctagonX className="size-3.5" />} Stop all
        </Button>
      )}
      className="w-[300px] p-3"
    >
      {(close) => (
        <div role="alertdialog" aria-label="Stop all runs?">
          <p className="text-[13px] font-semibold text-t1 max-md:hidden">Stop all runs?</p>
          <p className="mt-1 text-[12px] leading-snug text-t2">In every workflow: running runs are aborted, waiting and queued ones canceled, and pending automatic retries dropped.</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={close} className="max-md:h-11">
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              className="max-md:h-11"
              onClick={() => {
                close();
                void stop();
              }}
            >
              <OctagonX className="size-3" /> Stop all
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function RunsList() {
  // Stop all reaches every project's runs: admins only (the route enforces it; a null viewer is a host without sign-in).
  const viewer = useViewer();
  const canStopAll = !viewer || can(viewer, 'settings:manage');
  const params = useSearchParams();
  const router = useRouter();
  const paramsKey = params.toString();
  const [filters, setFilters] = useState<RunFilters>(() => parseFilters(params));
  const [executions, setExecutions] = useState<ExecutionSummary[]>();
  const [journalIds, setJournalIds] = useState<Set<string>>();
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [trend, setTrend] = useState<RunMeasure[]>();
  const [auto, setAuto] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const known = useRef<Set<string>>(undefined);
  const flashed = useRef(new Set<string>());

  // The URL is the filters: a link with a query (Home, the old Executions page) lands filtered.
  useEffect(() => {
    setFilters(parseFilters(new URLSearchParams(paramsKey)));
  }, [paramsKey]);
  const change = (next: RunFilters) => {
    setFilters(next);
    setPicked([]);
    router.replace(runsHref(next), { scroll: false });
  };

  useEffect(() => {
    try {
      setAuto(localStorage.getItem(AUTO_KEY) !== 'off');
    } catch {}
  }, []);
  useEffect(() => {
    api<{ workflows: Array<{ id: string; name: string }> }>('/api/workflows')
      .then((r) => setWorkflows(r.workflows.map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => {});
  }, []);

  const { workflowId } = filters;
  const load = useCallback(() => {
    api<{ executions: ExecutionSummary[] }>(`/api/executions?limit=${LIMIT}${workflowId ? `&workflowId=${encodeURIComponent(workflowId)}` : ''}`, { background: true })
      .then((r) => setExecutions(r.executions))
      .catch(() => setExecutions((current) => current ?? []));
  }, [workflowId]);
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 150);
  }, [load]);
  useEffect(() => {
    known.current = undefined;
    load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [auto, refresh]);
  useLiveEvents((event) => {
    if (!auto || event.channel !== 'execution') return;
    if (['execution.started', 'execution.finished', 'execution.paused', 'execution.resumed'].includes(event.event.type)) refresh();
  });
  const toggleAuto = (value: boolean) => {
    setAuto(value);
    try {
      localStorage.setItem(AUTO_KEY, value ? 'on' : 'off');
    } catch {}
    if (value) refresh();
  };

  // Actor, tool and check filters read the journal: ask the search for those runs' ids.
  const journalKey = JSON.stringify([filters.actor, filters.tool, filters.failedSteps, filters.failedCheck, filters.workflowId, filters.from, filters.to]);
  useEffect(() => {
    if (!needsJournal(filters)) return setJournalIds(undefined);
    let current = true;
    const q = new URLSearchParams({ limit: '100' });
    for (const key of ['actor', 'tool', 'workflowId', 'from', 'to'] as const) if (filters[key]) q.set(key, filters[key]);
    if (filters.failedSteps) q.set('failedSteps', 'true');
    if (filters.failedCheck) q.set('failedCheck', filters.failedCheck === '*' ? '' : filters.failedCheck);
    api<RunSearchResult>(`/api/runs/search?${q}`)
      .then((r) => current && setJournalIds(new Set(r.items.map((i) => i.executionId))))
      .catch(() => current && setJournalIds(new Set()));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalKey]);

  // A chosen workflow's runs over time.
  useEffect(() => {
    if (!workflowId) return setTrend(undefined);
    let current = true;
    api<{ runs: RunMeasure[] }>(`/api/runs/measures?workflowId=${encodeURIComponent(workflowId)}`)
      .then((r) => current && setTrend(r.runs))
      .catch(() => current && setTrend(undefined));
    return () => {
      current = false;
    };
  }, [workflowId]);

  if (executions) {
    if (!known.current) known.current = new Set(executions.map((e) => e.id));
    else
      for (const e of executions)
        if (!known.current.has(e.id)) {
          known.current.add(e.id);
          flashed.current.add(e.id);
        }
  }

  const list = useMemo(() => executions ?? [], [executions]);
  const visible = useMemo(() => list.filter((e) => matchesFilters(e, filters) && (!journalIds || journalIds.has(e.id))), [list, filters, journalIds]);
  const rows = useMemo(() => groupFailures(visible), [visible]);
  const running = list.filter((e) => e.status === 'running').length;
  const now = useNow(running > 0);
  const filtered = visible.length !== list.length;
  const workflowChoices = useMemo(() => {
    const byId = new Map(workflows.map((w) => [w.id, w.name]));
    for (const e of list) if (!byId.has(e.workflowId)) byId.set(e.workflowId, e.workflowName);
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [workflows, list]);
  const pick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  let index = 0;
  const renderRun = (execution: ExecutionSummary, nested?: boolean) => (
    <Row key={execution.id} execution={execution} now={now} index={index++} isNew={flashed.current.has(execution.id)} onChanged={refresh} picked={picked.includes(execution.id)} onPick={() => pick(execution.id)} nested={nested} />
  );

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader
        title="Runs"
        meta={executions && <span>{filtered ? `${plural(visible.length, 'run')} of ${list.length}` : plural(list.length, 'recent run')}</span>}
        actions={
          <>
            {picked.length > 0 && (
              <Button
                size="sm"
                variant="primary"
                className="max-md:h-11"
                disabled={picked.length < 2}
                title={picked.length < 2 ? 'Tick one more run to compare' : undefined}
                onClick={() => router.push(`/runs/compare?a=${encodeURIComponent(picked[0])}&b=${encodeURIComponent(picked[1])}`)}
              >
                <GitCompareArrows className="size-3.5" /> Compare {picked.length}
              </Button>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-t2">
              <Switch checked={auto} onChange={toggleAuto} label="Auto refresh" />
              Auto refresh
              {auto && <span className="size-1.5 rounded-full bg-gn animate-pulse-soft" />}
            </label>
            {canStopAll && running > 0 && <StopAllButton onStopped={refresh} />}
          </>
        }
      />
      <PageBody className="flex flex-col gap-4">
        <NeedsYouList />
        <LiveRuns executions={list} />
        <RunsFilters filters={filters} onChange={change} workflows={workflowChoices} />
        {workflowId && (
          <Link href={`/workflows/${workflowId}/executions`} className="-mt-2 text-[12px] text-t2 hover:text-t1">
            Open in workflow →
          </Link>
        )}
        {trend && trend.length > 0 && (
          <section aria-label="Over time">
            <h2 className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Over time · {trend.length} runs</h2>
            <TrendChart runs={trend} />
          </section>
        )}

        <div role="table" aria-label="Runs" className="overflow-hidden rounded-2xl border border-hair bg-sf max-md:flex max-md:flex-col max-md:gap-2 max-md:overflow-visible max-md:rounded-none max-md:border-0 max-md:bg-transparent">
          <div role="row" className={cn('grid items-center gap-3 border-b border-hair px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 max-md:sr-only', COLS)}>
            <span role="columnheader">Workflow</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Started</span>
            <span role="columnheader">Run time</span>
            <span />
          </div>
          {!executions &&
            Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="border-b border-hair px-4 py-3 last:border-b-0">
                <div className="h-4 rounded bg-acdim animate-pulse-soft" style={{ animationDelay: `${i * 90}ms`, width: `${70 - i * 6}%` }} />
              </div>
            ))}
          {rows.map((row) =>
            row.kind === 'run' ? (
              renderRun(row.run)
            ) : (
              <GroupRow key={row.key} group={row}>
                {(open) => open && row.runs.map((run) => renderRun(run, true))}
              </GroupRow>
            ),
          )}
          {executions && !visible.length && (
            <EmptyState compact className="py-10" title={list.length ? 'No runs match' : 'No runs yet'} hint={list.length ? 'Loosen a filter or clear the search.' : 'Run a workflow and it shows up here.'} />
          )}
        </div>
        {list.length >= LIMIT && <p className="text-center text-[12px] text-t3">Showing the latest {LIMIT} runs</p>}
      </PageBody>
    </div>
  );
}
