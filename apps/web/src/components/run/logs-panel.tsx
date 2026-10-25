'use client';
/**
 * n8n's Logs panel: every node run in start order on the left (sub-node
 * calls nested under the node that made them, with a mini waterfall), the
 * selected run's input or output on the right. Knows nothing about where it
 * is mounted; the host owns selection, height and actions.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, CircleX, Loader2, Pause, Recycle, ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { duration } from '@/lib/client/format';
import { nodeColor, tint } from '@/lib/client/node-style';
import { runsInOrder, type RunEntry } from '@/lib/client/run-data';
import type { LogEntry } from '@landflow/protocol';
import type { NodeRun, NodeTypeInfo } from '@/lib/shared/types';
import { NodeIcon } from '../ui/icon';
import { DataView } from './data-view';
import { RUN_STATE, RunStateIcon, statusText, useNow, type RunState } from './run-status';

export interface LogsSelection {
  nodeId: string;
  /** Index into runData[nodeId]. */
  runIndex: number;
}

export interface LogsNode {
  name: string;
  type?: string;
}

/** Nodes that started but haven't finished (or where the debugger is holding the run). */
export interface LogsPending {
  nodeId: string;
  state: 'running' | 'paused';
  startedAt?: string;
}

export interface LogsPanelProps {
  runData: Record<string, NodeRun[]>;
  /** node id → name and type, for labels and icons. */
  nodes: Record<string, LogsNode>;
  /** type → node type info. */
  nodeTypes: Record<string, NodeTypeInfo>;
  /** Overall status for the summary line; omitted means "no run yet". */
  status?: RunState;
  /** Origin of the waterfall and, while running, of the ticking elapsed time. */
  startedAt?: string;
  durationMs?: number;
  running?: boolean;
  pending?: LogsPending[];
  /** Controlled selection; falls back to the failed run, else the last run. */
  selected?: LogsSelection;
  onSelect?: (selection: LogsSelection) => void;
  /** Buttons for the selected run (e.g. Re-run task / Re-run from here). */
  actions?: (entry: RunEntry) => ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Extra controls in the header, left of the collapse toggle. */
  headerActions?: ReactNode;
  emptyHint?: ReactNode;
  className?: string;
}

interface Row extends RunEntry {
  key: string;
  depth: number;
  childCount: number;
  parentKey?: string;
  /** A node still running (or paused before): no data yet. */
  pending?: LogsPending;
}

type Entry = RunEntry & { pending?: LogsPending };

const keyOf = (e: Entry) => (e.pending ? `pending:${e.nodeId}` : `${e.nodeId}:${e.runIndex}`);
const startOf = (run: NodeRun) => Date.parse(run.startedAt);
// Open-ended window for nodes that haven't finished; paused ones sort last.
const OPEN_MS = 1e13;
const LAST = new Date(4e12).toISOString();

/**
 * Runs in start order, each sub-node call placed under the parent run whose
 * time window contains it. Pending nodes take part, so a running agent's
 * model and tool calls nest under it before it finishes.
 */
export function buildLogRows(runData: Record<string, NodeRun[]>, pending: LogsPending[] = []): Row[] {
  const pseudo: Entry[] = pending.map((p) => ({
    nodeId: p.nodeId,
    runIndex: -1,
    pending: p,
    run: { startedAt: p.startedAt ?? LAST, durationMs: OPEN_MS, status: 'success', source: 'main', inputs: [], outputs: [] },
  }));
  const entries: Entry[] = [...runsInOrder(runData), ...pseudo].sort((a, b) => startOf(a.run) - startOf(b.run));
  const byNode = new Map<string, Entry[]>();
  for (const entry of entries) byNode.set(entry.nodeId, [...(byNode.get(entry.nodeId) ?? []), entry]);

  const children = new Map<string, Entry[]>();
  const roots: Entry[] = [];
  for (const entry of entries) {
    const parentId = entry.run.parentNodeId;
    const candidates = parentId ? (byNode.get(parentId) ?? []) : [];
    if (!candidates.length) {
      roots.push(entry);
      continue;
    }
    const t = startOf(entry.run);
    const parent =
      candidates.find((c) => startOf(c.run) <= t && t <= startOf(c.run) + c.run.durationMs + 1) ??
      [...candidates].reverse().find((c) => startOf(c.run) <= t) ??
      candidates[0];
    const key = keyOf(parent);
    children.set(key, [...(children.get(key) ?? []), entry]);
  }

  const rows: Row[] = [];
  const seen = new Set<string>();
  const walk = (entry: Entry, depth: number, parentKey?: string) => {
    const key = keyOf(entry);
    if (seen.has(key)) return;
    seen.add(key);
    const kids = children.get(key) ?? [];
    rows.push({ ...entry, key, depth, childCount: kids.length, parentKey });
    for (const kid of kids) walk(kid, depth + 1, key);
  };
  for (const root of roots) walk(root, 0);
  // Anything left over (a parent cycle) still shows, flat.
  for (const entry of entries) walk(entry, 0);
  return rows;
}

function autoSelect(rows: Row[]): Row | undefined {
  const real = rows.filter((r) => !r.pending);
  return real.find((r) => r.run.status === 'error' && !r.run.reused) ?? [...real].reverse().find((r) => r.run.source === 'main') ?? real.at(-1);
}

function itemCount(items: NodeRun['outputs']) {
  return items.reduce((sum, branch) => sum + branch.length, 0);
}

function NodeBadge({ info, size = 22 }: { info?: NodeTypeInfo; size?: number }) {
  const color = nodeColor(info);
  return (
    <span className="grid shrink-0 place-items-center rounded-[7px]" style={{ width: size, height: size, background: tint(color, 14), color }}>
      <NodeIcon icon={info?.descriptor.icon} size={Math.round(size * 0.6)} strokeWidth={1.9} />
    </span>
  );
}

const LOG_LEVEL: Record<LogEntry['level'], string> = { debug: 'text-t3', info: 'text-t2', warn: 'text-warn', error: 'text-rd' };

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-6 items-center gap-1 rounded-full px-2.5 text-[12px] text-t2 transition-all duration-200 hover:text-t1',
            value === o.value && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RunDetail({ row, nodes, nodeTypes, actions }: { row: Row; nodes: Record<string, LogsNode>; nodeTypes: Record<string, NodeTypeInfo>; actions?: (entry: RunEntry) => ReactNode }) {
  const { run, nodeId, runIndex } = row;
  const node = nodes[nodeId];
  const info = node?.type ? nodeTypes[node.type] : undefined;
  const [side, setSide] = useState<'input' | 'output'>('output');
  const [branch, setBranch] = useState(0);
  const [logsOpen, setLogsOpen] = useState(false);
  const branches = side === 'output' ? run.outputs : run.inputs;
  const index = Math.min(branch, Math.max(0, branches.length - 1));
  const ports = (side === 'output' ? info?.descriptor.outputs : info?.descriptor.inputs)?.filter((p) => p.type === 'main') ?? [];
  const state: RunState = run.status;
  const parentName = run.parentNodeId ? (nodes[run.parentNodeId]?.name ?? run.parentNodeId) : undefined;

  const errorBox = side === 'output' && run.error && (
    <div className="flex gap-2.5 rounded-xl border border-rdbd bg-rddim px-3 py-2.5 text-rd animate-fade-up">
      <CircleX className="mt-px size-4 shrink-0" />
      <div className="min-w-0">
        <div className="text-[13px] font-semibold">{run.error.message}</div>
        {run.error.description && <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] opacity-85">{run.error.description}</div>}
      </div>
    </div>
  );

  return (
    <div key={row.key} className="flex min-h-0 flex-1 flex-col animate-in">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair px-3 py-2">
        <NodeBadge info={info} size={24} />
        <span className="truncate text-[14px] font-semibold text-t1">{node?.name ?? nodeId}</span>
        <span className={cn('flex items-center gap-1 rounded-full px-2 py-px text-[11px] font-semibold', RUN_STATE[state].soft, RUN_STATE[state].text)}>
          <RunStateIcon state={state} className="size-3" />
          {run.reused ? 'Reused' : RUN_STATE[state].label}
        </span>
        <span className="font-mono text-[11px] text-t3">{run.reused ? 'not run again' : duration(run.durationMs)}</span>
        {run.source !== 'main' && (
          <span className="rounded-full border border-acbd px-2 text-[11px] text-viz-7">
            {run.source} call{parentName && <> · used by {parentName}</>}
          </span>
        )}
        {runIndex > 0 && <span className="text-[11px] text-t3">run {runIndex + 1}</span>}
        {actions && <div className="ml-auto flex items-center gap-1.5">{actions(row)}</div>}
      </div>
      {run.reused && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hair bg-sf2 px-3 py-1.5 text-[12px] text-t3">
          <Recycle className="size-3.5" /> Copied from execution <span className="font-mono text-t2">{run.reused.executionId}</span>; this node was not run again.
        </div>
      )}
      <DataView
        key={`${row.key}:${side}:${index}`}
        items={branches[index]}
        emptyLabel={side === 'input' ? 'This node received no input items.' : run.error ? 'No output: the node failed.' : 'This node produced no output items.'}
        notice={errorBox || undefined}
        toolbar={
          <>
            <Segmented
              value={side}
              onChange={(v) => {
                setSide(v);
                setBranch(0);
              }}
              options={[
                { value: 'input', label: <>Input <span className="font-mono text-[10px] text-t3">{itemCount(run.inputs)}</span></> },
                { value: 'output', label: <>Output <span className="font-mono text-[10px] text-t3">{itemCount(run.outputs)}</span></> },
              ]}
            />
            {branches.length > 1 && (
              <div className="flex items-center gap-1">
                {branches.map((items, i) => (
                  <button
                    key={i}
                    onClick={() => setBranch(i)}
                    className={cn(
                      'h-6 rounded-full border px-2.5 text-[12px] transition-colors',
                      i === index ? 'border-gnbd bg-gndim font-semibold text-gn' : 'border-hair text-t2 hover:border-bd hover:text-t1',
                    )}
                  >
                    {ports[i]?.displayName ?? `${side === 'output' ? 'Output' : 'Input'} ${i + 1}`} <span className="font-mono text-[10px] opacity-75">{items.length}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        }
      />
      {Boolean(run.logs?.length) && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-hair">
          <button onClick={() => setLogsOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 hover:text-t1">
            <ChevronRight className={cn('size-3 transition-transform', logsOpen && 'rotate-90')} />
            <ScrollText className="size-3" /> Node logs <span className="font-mono normal-case">{run.logs!.length}</span>
            {!logsOpen && <span className={cn('min-w-0 truncate font-mono text-[11px] font-normal normal-case tracking-normal', LOG_LEVEL[run.logs!.at(-1)!.level])}>{run.logs!.at(-1)!.message}</span>}
          </button>
          {logsOpen && (
            <div className="px-3 pb-2 font-mono text-[11px]">
              {run.logs!.map((log, i) => (
                <div key={i} className={cn('flex gap-2 py-px animate-fade-up', LOG_LEVEL[log.level])} style={{ animationDelay: `${Math.min(i, 10) * 20}ms` }}>
                  <span className="w-10 shrink-0 uppercase opacity-70">{log.level}</span>
                  <span className="whitespace-pre-wrap break-words">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LogsPanel(props: LogsPanelProps) {
  const { runData, nodes, nodeTypes, status, startedAt, durationMs, running, pending, selected, onSelect, actions, collapsed, onToggle, headerActions, emptyHint, className } = props;
  const rows = useMemo(() => buildLogRows(runData, pending), [runData, pending]);
  const [internal, setInternal] = useState<LogsSelection>();
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const now = useNow(Boolean(running && startedAt));

  const nested = rows.some((r) => r.childCount > 0);
  const pick = selected ?? internal;
  const current = (pick && rows.find((r) => !r.pending && r.nodeId === pick.nodeId && r.runIndex === pick.runIndex)) || autoSelect(rows);
  const select = (row: Row) => {
    if (row.pending) return;
    setInternal({ nodeId: row.nodeId, runIndex: row.runIndex });
    onSelect?.({ nodeId: row.nodeId, runIndex: row.runIndex });
  };
  const toggleFold = (key: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Hide the children of folded rows (and their descendants).
  const visible = useMemo(() => {
    const hidden = new Set<string>();
    return rows.filter((row) => {
      if (row.parentKey && (folded.has(row.parentKey) || hidden.has(row.parentKey))) {
        hidden.add(row.key);
        return false;
      }
      return true;
    });
  }, [rows, folded]);

  // Waterfall: origin is the run start, span the whole run (still growing while live).
  const fresh = rows.filter((r) => !r.run.reused && !r.pending);
  const t0 = startedAt ? Date.parse(startedAt) : fresh.length ? Math.min(...fresh.map((r) => startOf(r.run))) : 0;
  const elapsed = running && startedAt ? Math.max(0, now - t0) : (durationMs ?? 0);
  const span = Math.max(1, elapsed, ...fresh.map((r) => startOf(r.run) + r.run.durationMs - t0));
  const nodeRuns = fresh.length;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const choices = visible.filter((r) => !r.pending);
    const i = choices.findIndex((r) => r.key === current?.key);
    const next = choices[Math.max(0, Math.min(choices.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      select(next);
      listRef.current?.querySelector(`[data-row="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  };

  const header = (
    <div
      className={cn('flex h-10 shrink-0 items-center gap-2.5 px-3', !collapsed && 'border-b border-hair', onToggle && 'cursor-pointer')}
      onClick={(e) => {
        if (onToggle && !(e.target as HTMLElement).closest('button')) onToggle();
      }}
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Logs</span>
      {status ? (
        <span className={cn('flex items-center gap-1.5 text-[13px] font-semibold tabular-nums', RUN_STATE[status].text)}>
          <RunStateIcon state={status} />
          {status === 'success' ? `Success in ${duration(elapsed)}` : statusText(status, elapsed)}
        </span>
      ) : (
        <span className="text-[13px] text-t3">No run yet</span>
      )}
      {nodeRuns > 0 && (
        <span className="text-[12px] text-t3">
          · {nodeRuns} node run{nodeRuns === 1 ? '' : 's'}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {headerActions}
        {onToggle && (
          <button onClick={onToggle} aria-label={collapsed ? 'Open logs' : 'Collapse logs'} className="grid size-7 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1">
            {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <section className={cn('flex h-full min-h-0 flex-col bg-sf', className)} aria-label="Logs">
      {(running || status === 'running') && <div className="lf-shimmer h-[2px] shrink-0" />}
      {header}
      {!collapsed && (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,40%)_minmax(0,1fr)]">
          <div ref={listRef} tabIndex={0} onKeyDown={onKeyDown} className="min-h-0 overflow-y-auto border-r border-hair p-1.5 outline-none" role="listbox" aria-label="Node runs">
            {visible.map((row, i) => {
              const { run, pending: p } = row;
              const node = nodes[row.nodeId];
              const info = node?.type ? nodeTypes[node.type] : undefined;
              const isSelected = !p && current?.key === row.key;
              const reused = Boolean(run.reused);
              const failed = !p && run.status === 'error' && !reused;
              const sub = run.source !== 'main';
              const since = p?.startedAt ? Date.parse(p.startedAt) : undefined;
              const left = ((p ? (since ?? t0) : startOf(run)) - t0) / span * 100;
              const width = (run.durationMs / span) * 100;
              const items = sub || p ? undefined : itemCount(run.outputs);
              return (
                <div
                  key={row.key}
                  data-row={row.key}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={p ? true : undefined}
                  onClick={() => select(row)}
                  className={cn(
                    'group relative flex h-8 items-center gap-1.5 rounded-lg border-l-2 pr-2 text-[13px] transition-colors duration-150 animate-fade-up',
                    p ? 'border-l-warn bg-warndim' : failed ? 'cursor-pointer border-l-rd bg-rddim' : 'cursor-pointer border-l-transparent',
                    isSelected ? (failed ? 'bg-rddim ring-1 ring-rdbd' : 'bg-acdim ring-1 ring-acbd') : !p && 'hover:bg-acdim',
                  )}
                  style={{ paddingLeft: 6 + row.depth * 18, animationDelay: `${Math.min(i, 16) * 22}ms` }}
                >
                  {row.depth > 0 && <span className="absolute bottom-0 top-0 border-l border-hair" style={{ left: row.depth * 18 - 4 }} />}
                  {row.childCount > 0 ? (
                    <button
                      aria-label={folded.has(row.key) ? 'Expand' : 'Collapse'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFold(row.key);
                      }}
                      className="-ml-1 grid size-4 shrink-0 place-items-center rounded text-t3 hover:text-t1"
                    >
                      <ChevronRight className={cn('size-3 transition-transform duration-150', !folded.has(row.key) && 'rotate-90')} />
                    </button>
                  ) : (
                    row.depth === 0 && nested && <span className="-ml-1 w-4 shrink-0" />
                  )}
                  <span className={cn(reused && 'opacity-45 grayscale')}>
                    <NodeBadge info={info} size={sub ? 18 : 22} />
                  </span>
                  <span className={cn('min-w-0 flex-1 truncate', p ? 'font-semibold text-warn' : reused ? 'text-t3' : failed ? 'font-semibold text-rd' : 'text-t1', sub && 'text-[12px]')}>
                    {node?.name ?? row.nodeId}
                  </span>
                  {p && <span className="shrink-0 text-[11px] text-warn">{p.state === 'paused' ? 'paused before' : 'running'}</span>}
                  {sub && !p && <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--viz-7)_12%,transparent)] px-1.5 text-[10px] text-viz-7">{run.source}</span>}
                  {reused ? (
                    <span title={`Reused from ${run.reused!.executionId}`} className="w-14 shrink-0 rounded-full border border-hair text-center text-[10px] leading-4 text-t3">
                      reused
                    </span>
                  ) : (
                    <span className="relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-wl ring-1 ring-hair" title={p ? undefined : `Started +${duration(Math.max(0, startOf(run) - t0))}`}>
                      {p ? (
                        p.state === 'running' && <span className="lf-shimmer absolute inset-y-0 right-0 rounded-full" style={{ left: `${Math.max(0, Math.min(97, left))}%` }} />
                      ) : (
                        <span
                          className={cn('absolute inset-y-0 rounded-full transition-[left,width] duration-300', failed ? 'bg-rd' : sub ? 'bg-viz-7' : 'bg-gn')}
                          style={{ left: `${Math.max(0, Math.min(100, left))}%`, width: `max(3px, ${Math.min(100, width)}%)` }}
                        />
                      )}
                    </span>
                  )}
                  <span className={cn('w-[46px] shrink-0 text-right font-mono text-[11px] tabular-nums', p ? 'text-warn' : 'text-t3')}>
                    {p ? (since && p.state === 'running' ? duration(Math.max(0, now - since)) : '') : reused ? '—' : duration(run.durationMs)}
                  </span>
                  <span className={cn('w-6 shrink-0 text-right font-mono text-[11px]', items ? 'text-t2' : 'text-t3')} title={items !== undefined ? `${items} output item${items === 1 ? '' : 's'}` : undefined}>
                    {items ?? ''}
                  </span>
                  {p ? (
                    p.state === 'paused' ? (
                      <Pause className="size-3.5 shrink-0 text-warn" fill="currentColor" strokeWidth={0} />
                    ) : (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-warn" />
                    )
                  ) : (
                    <RunStateIcon state={run.status} className={cn('size-3.5', reused && 'text-t3')} />
                  )}
                </div>
              );
            })}
            {!rows.length && (
              <div className="flex flex-col items-center gap-1 px-4 py-8 text-center animate-in">
                <span className="text-[13px] font-semibold text-t1">{running ? 'Waiting for the first node…' : 'No node runs'}</span>
                {emptyHint && <span className="max-w-[36ch] text-[12px] text-t3">{emptyHint}</span>}
              </div>
            )}
          </div>
          <div className="flex min-h-0 flex-col">
            {current ? (
              <RunDetail key={current.key} row={current} nodes={nodes} nodeTypes={nodeTypes} actions={actions} />
            ) : (
              <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-t3">{running ? 'Node data appears here as nodes finish.' : 'Select a node run to see its input and output.'}</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
