'use client';
/**
 * Overview → Executions (n8n's global list): every run of every workflow in
 * a table, live. A row opens the execution inside its workflow's Executions
 * tab. `?workflowId=` preselects a workflow; legacy `?id=` links redirect.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bug, ExternalLink, ListRestart, Loader2, MoreHorizontal, OctagonX, RotateCcw, SkipForward, Square, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { duration, plural, timeAgo } from '@/lib/client/format';
import { useLiveEvents } from '@/lib/client/live';
import type { ExecutionRecord, ExecutionSummary } from '@/lib/shared/types';
import { useViewer } from '@/components/auth/viewer';
import { can } from '@/lib/shared/auth';
import { ExecutionMarks, RERUN_LABEL, canRetry, deleteExecution, retryTitle, startRerun, startRetry, stopAllExecutions, stopAllSummary, type RetryBody } from '@/components/executions/meta';
import { RUN_STATE, RunStateIcon, formatStamp, runStateOf, useNow } from '@/components/run/run-status';
import { LiveRuns, NeedsYouList } from '@/components/run-trace/run-lists';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, Switch } from '@/components/ui/inputs';
import { Segmented } from '@/components/ui/segmented';
import { MenuItem, MenuSeparator, Popover } from '@/components/ui/popover';

type Filter = 'all' | 'error' | 'running';
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Failed' },
  { value: 'running', label: 'Running' },
];
const LIMIT = 200;
const POLL_MS = 8000;
const AUTO_KEY = 'landflow-executions-autorefresh';
// Desktop: seven columns. Phone: a card per run, name and menu, then status and run time, then when it started.
const COLS = 'md:grid-cols-[minmax(180px,1.6fr)_minmax(120px,0.9fr)_minmax(150px,1fr)_96px_minmax(130px,0.8fr)_44px_40px] max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-y-1';
const NEW_ROW: CSSProperties = { animation: 'lf-slide-right 0.24s cubic-bezier(0.22, 1, 0.36, 1) both, lf-flash 1.2s ease-out' };

const hrefOf = (e: ExecutionSummary) => `/workflows/${e.workflowId}/executions/${e.id}`;

function RowMenu({ execution, onChanged }: { execution: ExecutionSummary; onChanged: () => void }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const live = execution.status === 'running';
  // A queued run hasn't started: it can only be canceled (DELETE takes it out of the queue).
  const queued = execution.status === 'queued';
  const rerun = async (body: Parameters<typeof startRerun>[1], label: string) => {
    try {
      const id = await startRerun(execution.id, body);
      toast.success(label);
      router.push(`/workflows/${execution.workflowId}/executions/${id}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const retry = async (body: RetryBody, label: string) => {
    try {
      const id = await startRetry(execution.id, body);
      toast.success(label);
      router.push(`/workflows/${execution.workflowId}/executions/${id}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const remove = async () => {
    try {
      await deleteExecution(execution.id);
      toast.success(live ? 'Canceling the run' : queued ? 'Queued run canceled' : 'Execution deleted');
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Popover
      trigger={({ open, toggle }) => (
        <button
          onClick={() => {
            setConfirm(false);
            toggle();
          }}
          aria-label="Execution actions"
          aria-expanded={open}
          className={cn('relative z-10 grid size-7 place-items-center rounded-full text-t3 transition-colors hover:bg-acdim hover:text-t1 max-md:size-11', open && 'bg-acdim text-t1')}
        >
          <MoreHorizontal className="size-4" />
        </button>
      )}
      className="w-[250px]"
    >
      {(close) =>
        confirm ? (
          <div role="alertdialog" aria-label="Delete this execution?" className="p-2">
            <p className="text-[13px] font-semibold text-t1">Delete this execution?</p>
            <p className="mt-1 text-[12px] text-t2">It is removed from the history for good.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setConfirm(false)} className="h-7 rounded-full px-3 text-[12px] font-semibold max-md:h-11 max-md:px-4 text-t2 hover:bg-acdim">
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
        ) : (
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
                  <>
                    <MenuItem
                      onClick={() => {
                        close();
                        void retry({}, execution.error?.nodeName ? `Retrying from “${execution.error.nodeName}”` : 'Retrying the run');
                      }}
                    >
                      <SkipForward /> Retry from {execution.error?.nodeName ?? 'where it stopped'}
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        close();
                        void retry({ from: 'start' }, 'Retrying from the start');
                      }}
                    >
                      <ListRestart /> Retry from the start
                    </MenuItem>
                  </>
                )}
                <MenuItem
                  onClick={() => {
                    close();
                    void rerun({ scope: 'all', version: 'current' }, 'Re-running with the same input');
                  }}
                >
                  <RotateCcw /> Re-run with saved workflow
                </MenuItem>
              </>
            )}
            <MenuSeparator />
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
              <MenuItem danger onClick={() => setConfirm(true)}>
                <Trash2 /> Delete…
              </MenuItem>
            )}
          </>
        )
      }
    </Popover>
  );
}

function Row({ execution, now, index, isNew, onChanged }: { execution: ExecutionSummary; now: number; index: number; isNew: boolean; onChanged: () => void }) {
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
        // A phone: each run its own rounded card, like Workflows and Search runs.
        'max-md:overflow-hidden max-md:rounded-2xl max-md:border max-md:last:border-b',
        COLS,
        failed ? 'bg-rddim hover:bg-[color-mix(in_oklab,var(--rd)_12%,var(--sf))]' : 'hover:bg-sf2 max-md:bg-sf',
        !isNew && 'animate-fade-up',
      )}
      style={isNew ? NEW_ROW : { animationDelay: `${Math.min(index, 20) * 20}ms` }}
    >
      {/* The whole row is a link; the menu sits above it. */}
      <Link href={hrefOf(execution)} className="absolute inset-0" aria-label={`Open the run of ${execution.workflowName}, ${execution.status} (${execution.id})`} />
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', RUN_STATE[state].bar)} />
      <div role="cell" className="flex min-w-0 items-center gap-1.5 max-md:col-start-1 max-md:row-start-1 max-md:flex-wrap">
        <span className="truncate font-semibold text-t1">{execution.workflowName}</span>
        {execution.rerunOf && (
          <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--viz-1)_14%,transparent)] px-2 text-[11px] text-viz-1">{RERUN_LABEL[execution.rerunOf.scope].toLowerCase()}</span>
        )}
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
          <span
            title="The host restarted during the run; it continued from its last checkpoint"
            className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--viz-4)_14%,transparent)] px-2 text-[11px] text-viz-4"
          >
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
      <div role="cell" className="truncate font-mono text-[12px] text-t3 max-md:hidden">
        {execution.id}
      </div>
      <div role="cell" className="flex justify-center max-md:hidden">
        <ExecutionMarks execution={{ mode: execution.mode }} />
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

/** Header action: stop every execution of every workflow, after a confirm. */
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
      trigger={({ open, toggle }) => (
        <Button size="sm" variant={open ? 'danger' : 'outline'} onClick={toggle} loading={busy} aria-expanded={open}>
          {!busy && <OctagonX className="size-3.5" />} Stop all
        </Button>
      )}
      className="w-[300px] p-3"
    >
      {(close) => (
        <div role="alertdialog" aria-label="Stop all executions?">
          <p className="text-[13px] font-semibold text-t1">Stop all executions?</p>
          <p className="mt-1 text-[12px] leading-snug text-t2">
            In every workflow: running executions are aborted, waiting and queued ones canceled, and pending automatic retries dropped.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
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

function ExecutionsInner() {
  // Stop all reaches every project's runs: admins only (the route enforces it; a null viewer is a host without sign-in).
  const viewer = useViewer();
  const canStopAll = !viewer || can(viewer, 'settings:manage');
  const params = useSearchParams();
  const router = useRouter();
  const legacyId = params.get('id');
  const [workflowId, setWorkflowId] = useState(params.get('workflowId') ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [executions, setExecutions] = useState<ExecutionSummary[]>();
  const [auto, setAuto] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const known = useRef<Set<string>>(undefined);
  const flashed = useRef(new Set<string>());

  // Old links (/executions?id=…) open the execution in its workflow.
  useEffect(() => {
    if (!legacyId) return;
    api<{ execution: ExecutionRecord }>(`/api/executions/${legacyId}`)
      .then((r) => router.replace(`/workflows/${r.execution.workflowId}/executions/${legacyId}`))
      .catch(() => {
        toast.error(`Execution ${legacyId} was not found`);
        router.replace('/executions');
      });
  }, [legacyId, router]);

  useEffect(() => {
    try {
      setAuto(localStorage.getItem(AUTO_KEY) !== 'off');
    } catch {}
  }, []);

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

  const chooseWorkflow = (id: string) => {
    setWorkflowId(id);
    router.replace(id ? `/executions?workflowId=${encodeURIComponent(id)}` : '/executions', { scroll: false });
  };

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
  const workflows = useMemo(() => [...new Map(list.map((e) => [e.workflowId, e.workflowName])).entries()], [list]);
  const counts = { all: list.length, error: list.filter((e) => e.status === 'error').length, running: list.filter((e) => e.status === 'running').length };
  const visible = list.filter((e) => (filter === 'all' ? true : e.status === filter));
  const now = useNow(counts.running > 0);

  if (legacyId)
    return (
      <div className="grid h-screen place-items-center text-[13px] text-t3">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Opening execution…
        </span>
      </div>
    );

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader
        title="Executions"
        meta={executions && <span>{plural(list.length, 'recent run')}</span>}
        actions={
          <>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-t2">
              <Switch checked={auto} onChange={toggleAuto} label="Auto refresh" />
              Auto refresh
              {auto && <span className="size-1.5 rounded-full bg-gn animate-pulse-soft" />}
            </label>
            {canStopAll && <StopAllButton onStopped={refresh} />}
          </>
        }
      />
      <PageBody className="flex flex-col gap-4">
        <NeedsYouList />
        <LiveRuns executions={list} />
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Status"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((f) => ({
              value: f.value,
              label: (
                <>
                  {f.value === 'error' && <span className="size-1.5 rounded-full bg-rd" />}
                  {f.value === 'running' && <span className={cn('size-1.5 rounded-full bg-warn', counts.running && 'animate-pulse-soft')} />}
                  {f.label}
                  <span
                    className={cn(
                      'rounded-full px-1.5 font-mono text-[11px] font-normal',
                      f.value === 'error' && counts.error ? 'bg-rddim text-rd' : f.value === 'running' && counts.running ? 'bg-warndim text-warn' : 'text-t3',
                    )}
                  >
                    {counts[f.value]}
                  </span>
                </>
              ),
            }))}
          />
          <div className="w-[240px]">
            <Select value={workflowId} onChange={(e) => chooseWorkflow(e.target.value)} aria-label="Workflow" className="h-8 rounded-full text-[13px]">
              <option value="">All workflows</option>
              {workflowId && !workflows.some(([id]) => id === workflowId) && <option value={workflowId}>{workflowId}</option>}
              {workflows.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          {workflowId && (
            <Link href={`/workflows/${workflowId}/executions`} className="text-[12px] text-t2 hover:text-t1">
              Open in workflow →
            </Link>
          )}
        </div>

        <div role="table" aria-label="Executions" className="overflow-hidden rounded-2xl border border-hair bg-sf max-md:flex max-md:flex-col max-md:gap-2 max-md:overflow-visible max-md:rounded-none max-md:border-0 max-md:bg-transparent">
          <div role="row" className={cn('grid items-center gap-3 border-b border-hair px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 max-md:sr-only', COLS)}>
            <span role="columnheader">Workflow</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Started</span>
            <span role="columnheader">Run time</span>
            <span role="columnheader">Execution ID</span>
            <span role="columnheader" className="text-center">
              Mode
            </span>
            <span />
          </div>
          {!executions &&
            Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="border-b border-hair px-4 py-3 last:border-b-0">
                <div className="h-4 rounded bg-acdim animate-pulse-soft" style={{ animationDelay: `${i * 90}ms`, width: `${70 - i * 6}%` }} />
              </div>
            ))}
          {visible.map((execution, i) => (
            <Row key={execution.id} execution={execution} now={now} index={i} isNew={flashed.current.has(execution.id)} onChanged={refresh} />
          ))}
          {executions && !visible.length && (
            <EmptyState
              compact
              className="py-10"
              title={list.length ? 'Nothing matches this filter' : 'No executions yet'}
              hint={list.length ? 'Try another status or workflow.' : 'Run a workflow and it shows up here.'}
            />
          )}
        </div>
        {list.length >= LIMIT && <p className="text-center text-[12px] text-t3">Showing the latest {LIMIT} runs</p>}
      </PageBody>
    </div>
  );
}

export default function ExecutionsPage() {
  return (
    <Suspense>
      <ExecutionsInner />
    </Suspense>
  );
}
