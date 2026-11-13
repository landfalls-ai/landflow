'use client';
/**
 * A workflow's Executions tab (n8n's shape): the editor-style top bar with
 * the Editor | Executions switch, a list of execution cards on the left and
 * the selected execution (the route's child page) on the right. The list,
 * the workflow and the node types live here so they survive moving between
 * executions.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Check, ListFilter, RefreshCw, Timer, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { useLiveEvents } from '@/lib/client/live';
import type { ExecutionSummary, NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { WorkflowTabs } from '../shell/workflow-tabs';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/inputs';
import { Popover } from '../ui/popover';
import { RUN_STATE, RunStateIcon, formatStamp, runStateOf, statusText, useNow, type RunState } from '../run/run-status';
import { ExecutionMarks } from './meta';

interface ExecutionsContextValue {
  workflowId: string;
  workflow?: Workflow;
  workflowMissing: boolean;
  nodeTypes: Record<string, NodeTypeInfo>;
  /** Undefined until the first load. */
  executions?: ExecutionSummary[];
  refresh: () => void;
  /** Show an execution of this workflow. */
  open: (executionId: string, how?: 'push' | 'replace') => void;
}

const ExecutionsContext = createContext<ExecutionsContextValue | null>(null);

export function useExecutions() {
  const value = useContext(ExecutionsContext);
  if (!value) throw new Error('useExecutions must be used inside <ExecutionsShell>');
  return value;
}

const LIMIT = 100;
const POLL_MS = 8000;
const AUTO_KEY = 'landflow-executions-autorefresh';
const NEW_ROW: CSSProperties = { animation: 'lf-slide-right 0.24s cubic-bezier(0.22, 1, 0.36, 1) both, lf-flash 1.2s ease-out' };

type Filter = 'all' | RunState;
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'success', label: 'Succeeded' },
  { value: 'error', label: 'Failed' },
  { value: 'running', label: 'Running' },
  { value: 'paused', label: 'Paused' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'queued', label: 'Queued' },
  { value: 'canceled', label: 'Canceled' },
];

function readAuto() {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off';
  } catch {
    return true;
  }
}

function ExecutionCard({ execution, workflowId, selected, now, index, isNew }: { execution: ExecutionSummary; workflowId: string; selected: boolean; now: number; index: number; isNew: boolean }) {
  const state = runStateOf(execution);
  const live = execution.status === 'running';
  const ms = live ? Math.max(0, now - Date.parse(execution.startedAt)) : execution.durationMs;
  return (
    <Link
      href={`/workflows/${workflowId}/executions/${execution.id}`}
      data-id={execution.id}
      aria-current={selected || undefined}
      className={cn(
        'group relative block overflow-hidden rounded-[10px] border border-l-[3px] px-3 py-2 transition-[background-color,border-color,box-shadow,translate] duration-150',
        selected ? 'border-acbd bg-acdim shadow-[0_1px_0_var(--hair)]' : 'border-hair bg-sf hover:-translate-y-px hover:shadow-[0_4px_14px_rgba(0,0,0,0.07)]',
        // After the all-sides colour, or tailwind-merge drops it.
        RUN_STATE[state].border,
        !isNew && 'animate-fade-up',
      )}
      style={isNew ? NEW_ROW : { animationDelay: `${Math.min(index, 18) * 24}ms` }}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-semibold tabular-nums text-t1">{formatStamp(execution.startedAt)}</span>
        <ExecutionMarks execution={execution} className="ml-auto" />
      </div>
      <div className={cn('mt-0.5 flex items-center gap-1.5 text-[12px]', RUN_STATE[state].text)}>
        <RunStateIcon state={state} className="size-3" />
        <span className="truncate tabular-nums">{state === 'paused' && execution.paused ? `Paused before ${execution.paused.nodeName}` : statusText(state, ms)}</span>
      </div>
      {execution.error && <div className="mt-0.5 truncate text-[11px] text-t3">{execution.error.nodeName ? `${execution.error.nodeName}: ` : ''}{execution.error.message}</div>}
      {execution.retryAt && (
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-viz-7">
          <Timer className="size-3 shrink-0" />
          <span className="truncate tabular-nums">Automatic retry at {formatStamp(execution.retryAt)}</span>
        </div>
      )}
      {live && <div className="lf-shimmer absolute inset-x-0 bottom-0 h-[2px]" />}
    </Link>
  );
}

function Sidebar() {
  const { workflowId, executions, refresh } = useExecutions();
  const params = useParams<{ executionId?: string[] }>();
  const selectedId = params.executionId?.[0];
  const [filter, setFilter] = useState<Filter>('all');
  const [auto, setAuto] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const known = useRef<Set<string>>(undefined);
  const flashed = useRef(new Set<string>());

  useEffect(() => setAuto(readAuto()), []);
  const toggleAuto = (value: boolean) => {
    setAuto(value);
    try {
      localStorage.setItem(AUTO_KEY, value ? 'on' : 'off');
    } catch {}
    if (value) refresh();
  };

  // Polling backs up the live stream (missed events, other tabs' deletes).
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [auto, refresh]);
  useLiveEvents((event) => {
    if (!auto || event.channel !== 'execution' || event.workflowId !== workflowId) return;
    if (['execution.started', 'execution.finished', 'execution.paused', 'execution.resumed'].includes(event.event.type)) refresh();
  });

  // Executions that appear after the first load flash in.
  if (executions) {
    if (!known.current) known.current = new Set(executions.map((e) => e.id));
    else
      for (const e of executions)
        if (!known.current.has(e.id)) {
          known.current.add(e.id);
          flashed.current.add(e.id);
        }
  }

  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !executions || !selectedId) return;
    scrolled.current = true;
    listRef.current?.querySelector(`[data-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [executions, selectedId]);

  const anyLive = Boolean(executions?.some((e) => e.status === 'running'));
  const now = useNow(anyLive);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: executions?.length ?? 0 };
    for (const e of executions ?? []) c[runStateOf(e)] = (c[runStateOf(e)] ?? 0) + 1;
    return c;
  }, [executions]);
  const visible = (executions ?? []).filter((e) => filter === 'all' || runStateOf(e) === filter);

  return (
    <aside className="flex min-h-0 flex-col border-r border-hair bg-sf2">
      <div className="shrink-0 px-4 pb-2 pt-3.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-t1">Executions</h2>
          {executions && <span className="font-mono text-[11px] text-t3">{executions.length}</span>}
          <div className="ml-auto flex items-center gap-1">
            {!auto && (
              <button onClick={refresh} title="Refresh" aria-label="Refresh" className="grid size-7 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1">
                <RefreshCw className="size-3.5" />
              </button>
            )}
            <Popover
              trigger={({ open, toggle }) => (
                <button
                  onClick={toggle}
                  aria-label="Filter executions"
                  aria-expanded={open}
                  className={cn('relative grid size-7 place-items-center rounded-full transition-colors hover:bg-acdim hover:text-t1', filter !== 'all' || open ? 'bg-acdim text-t1' : 'text-t2')}
                >
                  <ListFilter className="size-3.5" />
                  {filter !== 'all' && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-viz-1 ring-2 ring-sf2 animate-pop" />}
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Status</div>
                  {FILTERS.map((f) => (
                    <button
                      key={f.value}
                      role="menuitemradio"
                      aria-checked={filter === f.value}
                      onClick={() => {
                        setFilter(f.value);
                        close();
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-t1 hover:bg-acdim"
                    >
                      {f.value === 'all' ? <span className="size-3.5" /> : <RunStateIcon state={f.value} className="animate-none" />}
                      <span>{f.label}</span>
                      <span className="ml-auto font-mono text-[11px] text-t3">{counts[f.value] ?? 0}</span>
                      <Check className={cn('size-3.5 text-t1', filter !== f.value && 'invisible')} />
                    </button>
                  ))}
                </>
              )}
            </Popover>
          </div>
        </div>
        <label className="mt-2 flex w-fit cursor-pointer select-none items-center gap-2 text-[12px] text-t2 max-md:min-h-11">
          <Switch checked={auto} onChange={toggleAuto} label="Auto refresh" />
          Auto refresh
          {auto && <span className="size-1.5 rounded-full bg-gn animate-pulse-soft" />}
        </label>
        {filter !== 'all' && (
          <div className="mt-2 flex items-center gap-1.5 animate-in">
            <span className={cn('flex items-center gap-1 rounded-full border border-hair bg-sf px-2 py-px text-[12px]', RUN_STATE[filter].text)}>
              <RunStateIcon state={filter} className="size-3 animate-none" />
              {FILTERS.find((f) => f.value === filter)?.label}
              <button onClick={() => setFilter('all')} aria-label="Clear filter" className="-mr-1 grid size-4 place-items-center rounded-full text-t3 hover:text-t1">
                <X className="size-3" />
              </button>
            </span>
            <span className="text-[12px] text-t3">
              {visible.length} of {executions?.length ?? 0}
            </span>
          </div>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3 pt-1">
        {!executions &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-[52px] rounded-[10px] border border-hair bg-sf animate-pulse-soft" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        {visible.map((execution, i) => (
          <ExecutionCard key={execution.id} execution={execution} workflowId={workflowId} selected={execution.id === selectedId} now={now} index={i} isNew={flashed.current.has(execution.id)} />
        ))}
        {executions && !visible.length && (
          <div className="px-2 py-8 text-center animate-in">
            <p className="text-[13px] font-semibold text-t1">{executions.length ? 'Nothing matches this filter' : 'No executions yet'}</p>
            <p className="mt-1 text-[12px] text-t3">{executions.length ? 'Pick another status.' : 'Run the workflow from the editor and it shows up here.'}</p>
          </div>
        )}
        {executions && executions.length >= LIMIT && <p className="px-2 pt-1 text-center text-[11px] text-t3">Showing the latest {LIMIT}</p>}
      </div>
    </aside>
  );
}

export function ExecutionsShell({ workflowId, children }: { workflowId: string; children: ReactNode }) {
  const router = useRouter();
  const selectedId = useParams<{ executionId?: string[] }>().executionId?.[0];
  const [workflow, setWorkflow] = useState<Workflow>();
  const [workflowMissing, setWorkflowMissing] = useState(false);
  const [nodeTypes, setNodeTypes] = useState<Record<string, NodeTypeInfo>>({});
  const [executions, setExecutions] = useState<ExecutionSummary[]>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(() => {
    api<{ executions: ExecutionSummary[] }>(`/api/executions?workflowId=${encodeURIComponent(workflowId)}&limit=${LIMIT}`)
      .then((r) => setExecutions(r.executions))
      .catch(() => setExecutions((current) => current ?? []));
  }, [workflowId]);
  // Bursts of events (a run finishing, a re-run starting) collapse into one request.
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 120);
  }, [load]);

  useEffect(() => {
    load();
    api<{ workflow: Workflow }>(`/api/workflows/${workflowId}`)
      .then((r) => setWorkflow(r.workflow))
      .catch(() => setWorkflowMissing(true));
    api<{ nodeTypes: NodeTypeInfo[] }>('/api/node-types')
      .then((r) => setNodeTypes(Object.fromEntries(r.nodeTypes.map((t) => [t.type, t]))))
      .catch(() => {});
  }, [workflowId, load]);

  const open = useCallback(
    (executionId: string, how: 'push' | 'replace' = 'push') => {
      const href = `/workflows/${workflowId}/executions/${executionId}`;
      if (how === 'replace') router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [router, workflowId],
  );

  const value = useMemo<ExecutionsContextValue>(
    () => ({ workflowId, workflow, workflowMissing, nodeTypes, executions, refresh, open }),
    [workflowId, workflow, workflowMissing, nodeTypes, executions, refresh, open],
  );

  return (
    <ExecutionsContext.Provider value={value}>
      <div className="flex h-screen flex-col overflow-hidden">
        <header className="relative flex h-[52px] shrink-0 items-center gap-3 border-b border-hair bg-bg px-4">
          <Link href="/workflows" aria-label="Back to workflows" className={cn('size-8 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1', selectedId ? 'hidden md:grid' : 'grid')}>
            <ArrowLeft className="size-4" />
          </Link>
          {selectedId && (
            <Link href={`/workflows/${workflowId}/executions`} aria-label="Back to executions" className="grid size-8 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1 md:hidden">
              <ArrowLeft className="size-4" />
            </Link>
          )}
          <span className="hidden max-w-[30%] truncate md:block text-[15px] font-semibold text-t1">{workflow?.name ?? (workflowMissing ? 'Deleted workflow' : ' ')}</span>
          {workflow?.active && <Badge tone="success" className="hidden md:inline-flex">Published</Badge>}
          <WorkflowTabs workflowId={workflowId} active="executions" className="md:absolute md:left-1/2 md:-translate-x-1/2" />
          <Link href={`/executions?workflowId=${workflowId}`} className="ml-auto hidden text-[12px] text-t2 transition-colors hover:text-t1 md:block">
            All executions
          </Link>
        </header>
        {/* On a phone the list and an open execution take the whole width in turn; the back arrow returns to the list. */}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)]">
          <div className={cn('min-h-0 flex-col [&>aside]:flex-1', selectedId ? 'hidden md:flex' : 'flex')}>
            <Sidebar />
          </div>
          <div className={cn('min-h-0 min-w-0 flex-col bg-bg', selectedId ? 'flex' : 'hidden md:flex')}>{children}</div>
        </div>
      </div>
    </ExecutionsContext.Provider>
  );
}
