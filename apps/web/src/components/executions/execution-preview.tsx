'use client';
/**
 * The right side of a workflow's Executions tab: when it ran and how it
 * ended, actions (debug in editor, retry / re-run, delete, debugger
 * controls for a paused run), the workflow as it ran, and the Logs panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bug,
  Check,
  ChevronDown,
  CircleDashed,
  CircleX,
  Copy,
  ExternalLink,
  History,
  ListRestart,
  Pause,
  Play,
  Power,
  Redo2,
  Repeat,
  RotateCcw,
  SkipForward,
  Square,
  StepForward,
  Timer,
  Trash2,
  Waypoints,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { useLiveEvents } from '@/lib/client/live';
import { useRunJournal } from '@/lib/client/run-trace';
import { progressLine, type NodeProgress } from '@/lib/client/node-progress';
import type { RunEntry } from '@/lib/client/run-data';
import type { DebugCommand, ExecutionRecord } from '@/lib/shared/types';
import { RunTraceBody, hasAgentSpans } from '../run-trace/run-trace-view';
import { LogsPanel, type LogsNode, type LogsPending, type LogsSelection } from '../run/logs-panel';
import { RUN_STATE, RunStateIcon, formatStamp, runStateOf, statusText, useNow } from '../run/run-status';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '../ui/popover';
import { useTeamLeads } from '../agents/faces';
import { TeamAskCard, TeamNowCard, teamQuestionOf } from '../editor/team-live';
import { liveTeam } from '../editor/team-strip';
import { AgentSessionPanel, type AgentNodeRef } from './agent-session-panel';
import { ExecutionCanvas } from './execution-canvas';
import { useExecutions } from './executions-shell';
import { MODE_META, RERUN_LABEL, canRetry, deleteExecution, startRerun, startRetry, type RerunBody, type RetryBody } from './meta';
import { AiUsageChip, BufferedChip, FeedbackChip, ParentChip, SubWorkflowWait, waitedChildren } from './run-extras';
import { Segmented } from '../ui/segmented';

const HEIGHT_KEY = 'landflow-logs-height';
const COLLAPSED_KEY = 'landflow-logs-collapsed';
const VIEW_KEY = 'landflow-run-view';
const HEADER_H = 40;

function readNumber(key: string, fallback: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function Sep() {
  return <span className="h-3 w-px bg-bd" />;
}

/** The run's OpenTelemetry trace id: copyable, and a link when the host has LANDFLOW_TRACE_URL. */
function TraceId({ traceId, url }: { traceId: string; url?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(traceId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy the trace id'),
    );
  };
  return (
    <span className="flex items-center gap-1 rounded-full border border-hair py-px pl-2 pr-0.5 text-[12px] text-t2" title={`Trace ${traceId}`}>
      <Waypoints className="size-3 shrink-0" />
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-t2 hover:text-t1" title="Open the trace">
          {traceId.slice(0, 12)}…
          <ExternalLink className="size-3" />
        </a>
      ) : (
        <span className="font-mono text-t3">{traceId.slice(0, 12)}…</span>
      )}
      <button onClick={copy} aria-label="Copy trace id" title="Copy trace id" className="grid size-5 place-items-center rounded-full text-t3 transition-colors hover:bg-acdim hover:text-t1">
        {copied ? <Check className="size-3 text-gn" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}

function Skeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-hair px-5 py-4">
        <div className="h-6 w-48 rounded-md bg-acdim animate-pulse-soft" />
        <div className="mt-2 h-4 w-72 rounded-md bg-acdim animate-pulse-soft [animation-delay:120ms]" />
      </div>
      <div className="canvas-readonly min-h-0 flex-1 bg-[repeating-linear-gradient(-45deg,transparent_0_14px,var(--acdim)_14px_28px)]" />
    </div>
  );
}

export function ExecutionPreview({ workflowId, executionId }: { workflowId: string; executionId?: string }) {
  const { executions, open } = useExecutions();
  const router = useRouter();

  // n8n opens the newest execution when none is in the URL; a phone shows the list instead, one screen at a time.
  useEffect(() => {
    if (!executionId && executions?.length && window.matchMedia('(min-width: 768px)').matches) open(executions[0].id, 'replace');
  }, [executionId, executions, open]);

  if (executionId) return <ExecutionDetail key={executionId} executionId={executionId} />;
  if (executions && !executions.length)
    return (
      <div className="grid flex-1 place-items-center">
        <EmptyState
          title="No executions yet"
          hint="Every run of this workflow (manual, webhook, chat or schedule) shows up here with each node's data."
          action={
            <Button variant="primary" onClick={() => router.push(`/workflows/${workflowId}`)}>
              <Play className="size-3.5" fill="currentColor" /> Open the editor to run it
            </Button>
          }
        />
      </div>
    );
  return <Skeleton />;
}

function ExecutionDetail({ executionId }: { executionId: string }) {
  const router = useRouter();
  const { workflowId, workflow: currentWorkflow, nodeTypes, executions, refresh, open } = useExecutions();
  const [record, setRecord] = useState<ExecutionRecord>();
  const [traceUrl, setTraceUrl] = useState<string>();
  const [missing, setMissing] = useState(false);
  const [picked, setPicked] = useState<LogsSelection>();
  const [busy, setBusy] = useState<string>();
  const [active, setActive] = useState<Record<string, string>>({});
  // What running nodes last reported (a remote agent's steps), by node id; livePick: the one open in the detail pane.
  const [progress, setProgress] = useState<Record<string, NodeProgress>>({});
  const [livePick, setLivePick] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  // Canvas | Run trace: the person's choice (remembered), else Run trace for runs with agents.
  const [chosenView, setChosenView] = useState<'canvas' | 'trace'>();
  const journal = useRunJournal(executionId);
  const [height, setHeight] = useState(320);
  const bodyRef = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setHeight(readNumber(HEIGHT_KEY, 320));
    setCollapsed(readNumber(COLLAPSED_KEY, 0) === 1);
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'canvas' || v === 'trace') setChosenView(v);
    } catch {}
  }, []);

  const load = useCallback(() => {
    api<{
      execution: ExecutionRecord;
      traceUrl?: string;
      progress?: Record<string, NodeProgress>;
    }>(`/api/executions/${executionId}`)
      .then((r) => {
        setRecord(r.execution);
        setTraceUrl(r.traceUrl);
        setMissing(false);
        if (r.execution.status !== 'running') {
          setActive({});
          setProgress({});
        } else if (r.progress) setProgress((current) => ({ ...r.progress, ...current }));
      })
      .catch(() => setMissing(true));
  }, [executionId]);
  const reload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(load, 100);
  }, [load]);
  useEffect(load, [load]);

  const live = record?.status === 'running';
  const queued = record?.status === 'queued';
  useLiveEvents((event) => {
    if (event.channel !== 'execution') return;
    // A pending automatic retry started: show its link.
    if (record?.retryAt && event.event.type === 'execution.started' && event.workflowId === record.workflowId) reload();
    // A sub-execution this run waits for finished: show the new count.
    const finishedId = event.event.type === 'execution.finished' ? event.event.executionId : undefined;
    if (finishedId && waitedChildren(record)?.some((child) => child.executionId === finishedId)) reload();
    if (event.event.executionId !== executionId) return;
    const e = event.event;
    if (e.type === 'node.started') setActive((a) => ({ ...a, [e.nodeId]: e.at }));
    else if (e.type === 'node.progress')
      setProgress((p) => ({
        ...p,
        [e.nodeId]: { ...e, since: p[e.nodeId]?.since ?? e.at },
      }));
    else if (e.type === 'node.finished') {
      setProgress(({ [e.nodeId]: _, ...rest }) => rest);
      setActive(({ [e.nodeId]: _, ...rest }) => rest);
      reload();
    } else if (e.type === 'execution.started' || e.type === 'execution.paused' || e.type === 'execution.resumed' || e.type === 'execution.finished') reload();
  });
  // Resync now and then while live (the page may have opened mid-run), queued (to see it start) or waiting for sub-workflows (their count).
  const waitsForChildren = Boolean(waitedChildren(record));
  useEffect(() => {
    if (!live && !queued && !waitsForChildren) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [live, queued, waitsForChildren, load]);

  // A link with the wrong workflow in it still lands in the right place.
  useEffect(() => {
    if (record && record.workflowId !== workflowId) router.replace(`/workflows/${record.workflowId}/executions/${record.executionId}`);
  }, [record, workflowId, router]);

  const now = useNow(live);
  const canvasWorkflow = record?.workflow ?? currentWorkflow;
  const nodes = useMemo(() => {
    const map: Record<string, LogsNode> = {};
    for (const n of canvasWorkflow?.nodes ?? []) map[n.id] = { name: n.name, type: n.type };
    for (const [id, name] of Object.entries(record?.nodeNames ?? {})) map[id] = { ...map[id], name };
    return map;
  }, [canvasWorkflow, record?.nodeNames]);

  const runData = useMemo(() => record?.runData ?? {}, [record?.runData]);
  // Until the user picks a run: the failed node, else follow the latest node to finish.
  const selection = useMemo<LogsSelection | undefined>(() => {
    if (picked && runData[picked.nodeId]?.[picked.runIndex]) return picked;
    const nodeId = (!live && record?.error?.nodeId && runData[record.error.nodeId] ? record.error.nodeId : undefined) ?? record?.executionOrder.at(-1);
    return nodeId && runData[nodeId] ? { nodeId, runIndex: runData[nodeId].length - 1 } : undefined;
  }, [picked, runData, record, live]);

  // Running nodes: from node.started events, plus (when the page opened mid-run) any node whose sub-nodes have been called but which hasn't finished.
  const running = useMemo<Record<string, string>>(() => {
    if (!live) return {};
    const inferred: Record<string, string> = {};
    for (const runs of Object.values(runData))
      for (const run of runs) {
        const parent = run.parentNodeId;
        if (parent && !runData[parent] && (!inferred[parent] || run.startedAt < inferred[parent])) inferred[parent] = run.startedAt;
      }
    // A node that reported progress is running, also when the page missed its node.started (opened mid-run).
    const reporting = Object.fromEntries(Object.values(progress).map((p) => [p.nodeId, p.since ?? p.at]));
    return { ...inferred, ...reporting, ...active };
  }, [live, runData, active, progress]);
  // The one-line caption over a node on the canvas: "Developer · Running the tests".
  const captions = useMemo(() => (live ? Object.fromEntries(Object.entries(progress).map(([id, p]) => [id, progressLine(p)])) : {}), [live, progress]);
  // Running team nodes: who works now and on what, for the strip above the node.
  const teams = useMemo(
    () => (live ? Object.fromEntries(Object.entries(progress).flatMap(([id, p]) => (liveTeam(p.data) ? [[id, liveTeam(p.data)!]] : []))) : {}),
    [live, progress],
  );
  const activeIds = useMemo(() => Object.keys(running), [running]);
  const pending = useMemo<LogsPending[]>(() => {
    const list: LogsPending[] = activeIds.filter((id) => !record?.paused || id !== record.paused.nodeId).map((id) => ({ nodeId: id, state: 'running', startedAt: running[id] }));
    if (record?.paused) list.push({ nodeId: record.paused.nodeId, state: 'paused' });
    return live ? list : [];
  }, [activeIds, running, record?.paused, live]);

  // A Run a Team node's session is its lead's: the lead's agent, by team.
  const teamLeads = useTeamLeads(canvasWorkflow?.nodes);
  // Run an Agent and Run a Team nodes that run or ran in this execution (the agent is the node's parameter, else the one
  // its output names; a team's is its lead).
  const agentNodes = useMemo<AgentNodeRef[]>(() => {
    const list: AgentNodeRef[] = [];
    for (const n of canvasWorkflow?.nodes ?? []) {
      if (!runData[n.id] && !(n.id in running)) continue;
      if (n.type === 'core.runTeam') {
        const lead = teamLeads[String(n.parameters?.teamId ?? '')];
        if (lead) list.push({ nodeId: n.id, name: nodes[n.id]?.name ?? n.name, agentId: lead });
        continue;
      }
      if (n.type !== 'core.messageAgent') continue;
      const param = n.parameters?.agentId;
      const output = runData[n.id]?.flatMap((r) => r.outputs.flat()).find((item) => typeof item.json?.agentId === 'string')?.json.agentId;
      const agentId = typeof param === 'string' && param && !param.includes('{{') && !param.startsWith('=') ? param : typeof output === 'string' ? output : undefined;
      if (agentId) list.push({ nodeId: n.id, name: nodes[n.id]?.name ?? n.name, agentId });
    }
    return list;
  }, [canvasWorkflow, runData, running, nodes, teamLeads]);
  const setCollapsedPersist = (value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
    } catch {}
  };

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startY = e.clientY;
    const startH = height;
    const max = Math.max(200, (bodyRef.current?.clientHeight ?? 800) - 120);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let latest = startH;
    const move = (ev: PointerEvent) => {
      latest = Math.round(Math.min(max, Math.max(160, startH + startY - ev.clientY)));
      setHeight(latest);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(latest));
      } catch {}
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  if (missing)
    return (
      <div className="grid flex-1 place-items-center">
        <EmptyState
          title="Execution not found"
          hint="It may have been deleted, or pruned: only the latest 300 runs are kept."
          action={<Button onClick={() => router.replace(`/workflows/${workflowId}/executions`)}>Show the newest execution</Button>}
        />
      </div>
    );
  if (!record) return <Skeleton />;

  const state = runStateOf(record);
  const durationMs = live ? Math.max(0, now - Date.parse(record.startedAt)) : record.durationMs;
  const lastRuns = Object.values(record.runData).map((runs) => runs.at(-1));
  const reusedCount = lastRuns.filter((r) => r?.reused).length;
  const ranCount = lastRuns.length - reusedCount;
  const name = (id?: string) => (id ? (nodes[id]?.name ?? id) : undefined);
  const mode = MODE_META[record.mode] ?? MODE_META.manual;
  const ModeIcon = mode.icon;
  const errorNodeId = record.error?.nodeId;
  // A checkpoint step is `<nodeId>#<runIndex>` of the last node that finished, or `start`.
  const resumedStep = record.resumedAfterRestart?.stepId;
  const resumedAfter = resumedStep && resumedStep !== 'start' ? `, after “${name(resumedStep.split('#')[0])}”` : '';

  const launch = async (key: string, start: () => Promise<string>, label: string) => {
    setBusy(key);
    try {
      const newId = await start();
      toast.success(label);
      refresh();
      open(newId);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(undefined);
    }
  };
  const act = (key: string, body: RerunBody, label: string) => launch(key, () => startRerun(record.executionId, body), label);
  const retry = (body: RetryBody, label: string) => launch('retry', () => startRetry(record.executionId, body), label);

  const debug = async (command: DebugCommand) => {
    try {
      await api(`/api/executions/${record.executionId}/debug`, { method: 'POST', json: { command } });
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    try {
      await deleteExecution(record.executionId);
      toast.success(queued ? 'Queued run canceled' : 'Canceling the run');
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    setBusy('delete');
    try {
      await deleteExecution(record.executionId);
      toast.success('Execution deleted');
      const list = executions ?? [];
      const at = list.findIndex((e) => e.id === record.executionId);
      const next = list[at + 1] ?? list[at - 1];
      refresh();
      if (next && next.id !== record.executionId) open(next.id, 'replace');
      else router.replace(`/workflows/${workflowId}/executions`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(undefined);
    }
  };

  const selectNode = (nodeId: string) => {
    const runs = record.runData[nodeId];
    if (!runs?.length) {
      // A running node (a teammate being called) has no run yet: open its live steps.
      if (progress[nodeId]) {
        setLivePick(nodeId);
        if (collapsed) setCollapsedPersist(false);
      }
      return;
    }
    setLivePick(undefined);
    setPicked({ nodeId, runIndex: runs.length - 1 });
    if (collapsed) setCollapsedPersist(false);
  };

  const hasSnapshot = Boolean(record.workflow);
  const retryable = canRetry(record);
  const retryMenu = (close: () => void) => {
    const run = (key: string, body: RerunBody, label: string) => {
      close();
      void act(key, body, label);
    };
    const runRetry = (body: RetryBody, label: string) => {
      close();
      void retry(body, label);
    };
    const original = !hasSnapshot ? 'no snapshot' : undefined;
    // A retry's original workflow is the snapshot, else the saved version the run started on.
    const retryOriginal = !hasSnapshot && !record.versionId ? 'no snapshot' : undefined;
    const where = errorNodeId ? 'from node with error' : 'from where it stopped';
    return (
      <>
        {retryable && (
          <>
            <MenuLabel>{errorNodeId ? <>Retry from “{name(errorNodeId)}”</> : 'Retry from where it stopped'}</MenuLabel>
            <MenuItem onClick={() => runRetry({ version: 'current' }, errorNodeId ? `Retrying from “${name(errorNodeId)}”` : 'Retrying the run')}>
              <SkipForward /> Retry with currently saved workflow ({where})
            </MenuItem>
            <MenuItem
              disabled={Boolean(retryOriginal)}
              hint={retryOriginal}
              onClick={() => runRetry({ version: 'original' }, errorNodeId ? `Retrying “${name(errorNodeId)}” with the original workflow` : 'Retrying with the original workflow')}
            >
              <History /> Retry with original workflow ({where})
            </MenuItem>
            <MenuItem onClick={() => runRetry({ from: 'start' }, 'Retrying from the start')}>
              <ListRestart /> Retry from the start (same input)
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuLabel>Re-run the whole execution</MenuLabel>
        <MenuItem onClick={() => run('rerun', { scope: 'all', version: 'current' }, 'Re-running with the same input')}>
          <RotateCcw /> Re-run with currently saved workflow
        </MenuItem>
        <MenuItem disabled={!hasSnapshot} hint={original} onClick={() => run('rerun', { scope: 'all', version: 'original' }, 'Re-running the original workflow')}>
          <History /> Re-run with original workflow
        </MenuItem>
      </>
    );
  };

  const runActions = (entry: RunEntry) =>
    !live && entry.run.source === 'main' ? (
      <>
        <Button
          size="sm"
          loading={busy === `only:${entry.nodeId}`}
          onClick={() => void act(`only:${entry.nodeId}`, { scope: 'only', nodeId: entry.nodeId }, `Re-running “${name(entry.nodeId)}”`)}
          title="Run just this node again with the same input; everything else is reused"
        >
          <Play className="size-3" /> Re-run task
        </Button>
        <Button
          size="sm"
          loading={busy === `from:${entry.nodeId}`}
          onClick={() => void act(`from:${entry.nodeId}`, { scope: 'from', nodeId: entry.nodeId }, `Re-running from “${name(entry.nodeId)}”`)}
          title="Run this node and everything after it; earlier nodes are reused"
        >
          <SkipForward className="size-3.5" /> Re-run from here
        </Button>
      </>
    ) : null;

  const hasTrace = hasAgentSpans(journal.model);
  const view = chosenView ?? (hasTrace ? 'trace' : 'canvas');
  const chooseView = (next: 'canvas' | 'trace') => {
    setChosenView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {}
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ------------------------------------------------------------ header */}
      <div className="relative shrink-0 border-b border-hair px-5 py-3">
        {live && <div className="lf-shimmer absolute inset-x-0 top-0 h-[2px]" />}
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="min-w-0 animate-fade-up">
            <h1 className="text-[20px] font-semibold leading-tight tabular-nums text-t1">{formatStamp(record.startedAt)}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
              <span className={cn('flex items-center gap-1.5 font-semibold tabular-nums', RUN_STATE[state].text)}>
                <RunStateIcon state={state} />
                {state === 'paused' && record.paused ? `Paused before ${record.paused.nodeName}` : statusText(state, durationMs)}
              </span>
              <Sep />
              <span className="text-t2">
                {ranCount} node{ranCount === 1 ? '' : 's'}
                {reusedCount > 0 && <span className="text-t3"> · {reusedCount} reused</span>}
              </span>
              <Sep />
              <span className="font-mono text-[12px] text-t3">ID#{record.executionId}</span>
              {record.traceId && <TraceId traceId={record.traceId} url={traceUrl} />}
              <span className="flex items-center gap-1 rounded-full border border-hair px-2 text-[12px] text-t2" title={mode.label}>
                <ModeIcon className="size-3" /> {record.mode}
              </span>
              {record.versionNumber !== undefined && (
                <span
                  className={cn('flex items-center gap-1 rounded-full border px-2 text-[12px]', record.versionPublished ? 'border-acbd text-ac' : 'border-hair text-t2')}
                  title={record.versionPublished ? 'The published version when the run started (draft and publish)' : 'A draft: not the published version when the run started'}
                >
                  Ran version {record.versionNumber} ({record.versionPublished ? 'published' : 'draft'})
                </span>
              )}
              {record.mcp && (
                <span className="flex items-center gap-1 rounded-full border border-hair px-2 text-[12px] text-t2" title={`MCP tool ${record.mcp.tool} of plugin ${record.mcp.pluginId}, called by ${record.mcp.caller}`}>
                  tool <span className="font-mono">{record.mcp.tool}</span> · called by <span className="font-mono">{record.mcp.caller}</span>
                </span>
              )}
              {record.debug && (
                <span className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--viz-2)_14%,transparent)] px-2 text-[12px] text-viz-2">
                  <Bug className="size-3" /> debug run
                </span>
              )}
              {record.rerunOf && (
                <button
                  onClick={() => open(record.rerunOf!.executionId)}
                  title="Open the execution this re-ran"
                  className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--viz-1)_14%,transparent)] px-2 text-[12px] text-viz-1 transition-opacity hover:opacity-80"
                >
                  <RotateCcw className="size-3" />
                  {RERUN_LABEL[record.rerunOf.scope]}
                  {record.rerunOf.nodeId && <> “{name(record.rerunOf.nodeId)}”</>} of <span className="font-mono">{record.rerunOf.executionId}</span>
                </button>
              )}
              {record.retryOf && (
                <button
                  onClick={() => open(record.retryOf!)}
                  title="Open the execution this retried"
                  className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--viz-7)_14%,transparent)] px-2 text-[12px] text-viz-7 transition-opacity hover:opacity-80"
                >
                  <Repeat className="size-3" />
                  Retry #{record.retryAttempt ?? 1} of <span className="font-mono">{record.retryOf}</span>
                </button>
              )}
              {record.retriedBy && (
                <button
                  onClick={() => open(record.retriedBy!)}
                  title="Open the retry of this execution"
                  className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--viz-7)_14%,transparent)] px-2 text-[12px] text-viz-7 transition-opacity hover:opacity-80"
                >
                  <Redo2 className="size-3" />
                  Retried by <span className="font-mono">{record.retriedBy}</span>
                </button>
              )}
              {record.retryAt && (
                <span className="flex items-center gap-1 rounded-full border border-hair px-2 text-[12px] text-viz-7" title="Retrying it yourself replaces the automatic retry">
                  <Timer className="size-3" /> Automatic retry at <span className="tabular-nums">{formatStamp(record.retryAt)}</span>
                </span>
              )}
              {record.resumedAfterRestart && (
                <span
                  className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--viz-4)_14%,transparent)] px-2 text-[12px] text-viz-4"
                  title={`The host restarted during the run. On ${formatStamp(record.resumedAfterRestart.at)} it continued from its last checkpoint${resumedAfter} (step ${resumedStep}).`}
                >
                  <Power className="size-3" /> Resumed after restart
                </span>
              )}
              <ParentChip parentId={record.parentExecutionId} onOpen={open} />
              <BufferedChip buffered={record.buffered} />
              <AiUsageChip usage={record.aiUsage} />
              <FeedbackChip key={record.executionId} executionId={record.executionId} feedback={record.chatFeedback} />
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2 animate-slide-left">
            {live ? (
              record.paused ? (
                <>
                  <Button size="sm" onClick={() => void debug('step')} title="Run the next node, then pause again">
                    <StepForward className="size-3.5" /> Step
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void debug('continue')} title="Run until the next breakpoint">
                    <Play className="size-3.5" fill="currentColor" /> Continue
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void debug('stop')}>
                    <Square className="size-3" fill="currentColor" /> Stop
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="danger" loading={busy === 'cancel'} onClick={() => void cancel()}>
                  <Square className="size-3" fill="currentColor" /> Cancel
                </Button>
              )
            ) : queued ? (
              <Button size="sm" variant="danger" loading={busy === 'cancel'} onClick={() => void cancel()} title="Take this run out of the queue">
                <Square className="size-3" fill="currentColor" /> Cancel
              </Button>
            ) : (
              <>
                <Button onClick={() => router.push(`/workflows/${workflowId}?execution=${record.executionId}`)} title="Open the workflow in the editor with this execution's data loaded">
                  <Bug className="size-3.5" /> Debug in editor
                </Button>
                <Popover
                  trigger={({ open: isOpen, toggle }) => (
                    <Button
                      variant={record.status === 'error' ? 'primary' : 'outline'}
                      onClick={toggle}
                      loading={busy === 'retry' || busy === 'rerun'}
                      aria-expanded={isOpen}
                      title={retryable ? 'Retry from where it stopped, or re-run everything' : 'Re-run this execution with the same input'}
                    >
                      <RotateCcw className="size-3.5" /> {retryable ? 'Retry' : 'Re-run'}
                      <ChevronDown className={cn('size-3.5 transition-transform duration-200', isOpen && 'rotate-180')} />
                    </Button>
                  )}
                  className="w-[380px]"
                >
                  {retryMenu}
                </Popover>
                <Popover
                  trigger={({ open: isOpen, toggle }) => (
                    <Button size="icon" variant={isOpen ? 'danger' : 'ghost'} onClick={toggle} loading={busy === 'delete'} aria-label="Delete execution" title="Delete execution">
                      {busy !== 'delete' && <Trash2 className="size-4" />}
                    </Button>
                  )}
                  className="w-[260px] p-3"
                >
                  {(close) => (
                    <div role="alertdialog" aria-label="Delete this execution?">
                      <p className="text-[13px] font-semibold text-t1">Delete this execution?</p>
                      <p className="mt-1 text-[12px] leading-snug text-t2">It is removed from the history for good, with all of its node data.</p>
                      <div className="mt-3 flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={close}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            close();
                            void remove();
                          }}
                        >
                          <Trash2 className="size-3" /> Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </Popover>
              </>
            )}
          </div>
        </div>

        {live && record.paused && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-warnbd bg-warndim px-3 py-2 text-[13px] text-warn animate-fade-up">
            <Pause className="size-3.5 animate-pulse-soft" fill="currentColor" strokeWidth={0} />
            The debugger is holding this run before <b className="font-semibold">{record.paused.nodeName}</b>
            <span className="text-[12px] opacity-80">({record.paused.reason === 'breakpoint' ? 'breakpoint' : 'stepping'})</span>
          </div>
        )}
        <SubWorkflowWait record={record} onOpen={open} />
        {queued && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-hair bg-nudim px-3 py-2 text-[13px] text-t2 animate-fade-up">
            <CircleDashed className="size-3.5 shrink-0" />
            <span>
              Queued{record.queued?.queuedAt && <> since <span className="tabular-nums">{formatStamp(record.queued.queuedAt)}</span></>}
              {record.queued?.worker ? ': waiting for a worker to take it (queue mode).' : ': the workflow is busy at its concurrency limit. It starts by itself when a slot frees up.'}
            </span>
          </div>
        )}
        {record.error && !live && (
          <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd animate-fade-up [animation-delay:60ms]">
            <CircleX className="mt-px size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              {record.error.nodeName && <span className="font-semibold">{record.error.nodeName}: </span>}
              {record.error.message}
            </div>
            {errorNodeId && record.runData[errorNodeId] && (
              <button onClick={() => selectNode(errorNodeId)} className="shrink-0 rounded-full border border-rdbd px-2.5 text-[12px] font-semibold transition-colors hover:bg-rd hover:text-bg">
                Show node
              </button>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------- canvas + logs */}
      <div className="flex shrink-0 items-center gap-2 border-b border-hair px-4 py-1.5">
        <Segmented
          label="View"
          value={view}
          onChange={chooseView}
          options={[
            { value: 'canvas', label: 'Canvas' },
            { value: 'trace', label: 'Run trace' },
          ]}
        />
        <Link href={`/runs/${executionId}`} className="ml-auto flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-t2 hover:bg-acdim hover:text-t1">
          Full screen <ExternalLink className="size-3" />
        </Link>
      </div>
      {/* On a phone the canvas is small: a running team gets a Now card over either view (team-live.tsx). */}
      {Object.entries(teams).map(([nodeId, team]) => {
        const node = canvasWorkflow?.nodes.find((n) => n.id === nodeId);
        const teamId = typeof node?.parameters.teamId === 'string' ? node.parameters.teamId : undefined;
        return node && teamId ? (
          <div key={nodeId} className="shrink-0 px-3 pt-3 sm:hidden">
            <TeamNowCard teamId={teamId} live={team} nodeName={node.name} executionId={executionId} onOpenTrace={view === 'canvas' ? () => chooseView('trace') : undefined} />
          </div>
        ) : null;
      })}
      {/* A run waiting on a team member's question: the question and its Answer button, on a phone over either view. */}
      {(() => {
        const node = record.status === 'waiting' && record.wait?.nodeId ? canvasWorkflow?.nodes.find((n) => n.id === record.wait!.nodeId) : undefined;
        const asked = node && teamQuestionOf(record.wait, node.id);
        const teamId = typeof node?.parameters.teamId === 'string' ? node.parameters.teamId : undefined;
        return node && asked && teamId ? (
          <div className="shrink-0 px-3 pt-3 sm:hidden">
            <TeamAskCard teamId={teamId} waiting={asked} nodeName={node.name} executionId={executionId} />
          </div>
        ) : null;
      })()}
      {view === 'trace' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RunTraceBody executionId={executionId} executionHref={`/workflows/${record.workflowId}/executions/${executionId}`} journal={journal} />
        </div>
      )}
      {view === 'canvas' && (
        <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
          {/* The flow stays in view while agents work: the session panel above the logs shrinks first. */}
          <div className="relative min-h-[200px] flex-1 animate-in">
            {canvasWorkflow ? (
              <ExecutionCanvas
                workflow={canvasWorkflow}
                nodeTypes={nodeTypes}
                runData={record.runData}
                activeNodeIds={live ? activeIds : undefined}
                pausedNodeId={live ? record.paused?.nodeId : undefined}
                wait={record.status === 'waiting' ? record.wait : undefined}
                running={live}
                selectedNodeId={livePick && progress[livePick] ? livePick : selection?.nodeId}
                captions={captions}
                teams={teams}
                executionId={executionId}
                onNodeClick={selectNode}
              />
            ) : (
              <div className="canvas-readonly grid size-full place-items-center bg-[repeating-linear-gradient(-45deg,transparent_0_14px,var(--acdim)_14px_28px)] text-[13px] text-t3">
                Loading workflow…
              </div>
            )}
            {!hasSnapshot && !live && canvasWorkflow && (
              <div className="pointer-events-none absolute left-3 top-3 rounded-full border border-hair bg-sf px-2.5 py-0.5 text-[11px] text-t3 animate-fade-up">
                Showing the current workflow: this execution has no snapshot
              </div>
            )}
          </div>
          {agentNodes.length > 0 && <AgentSessionPanel executionId={executionId} nodes={agentNodes} running={activeIds} selectedNodeId={selection?.nodeId} live={live} progress={progress} />}
          {!collapsed && (
            <div role="separator" aria-orientation="horizontal" aria-label="Resize logs" onPointerDown={onResizeStart} className="group relative z-10 -my-1 h-2 shrink-0 cursor-row-resize touch-none">
              <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-hair transition-colors group-hover:h-0.5 group-hover:bg-viz-1" />
            </div>
          )}
          <div className="shrink-0 border-t border-hair animate-fade-up [animation-delay:80ms]" style={{ height: collapsed ? HEADER_H + (live ? 2 : 0) : height }}>
            <LogsPanel
              runData={record.runData}
              nodes={nodes}
              nodeTypes={nodeTypes}
              status={state}
              startedAt={record.startedAt}
              durationMs={record.durationMs}
              running={live}
              pending={pending}
              selected={selection}
              onSelect={(next) => {
                setLivePick(undefined);
                setPicked(next);
              }}
              progress={progress}
              livePick={livePick}
              onLivePick={setLivePick}
              actions={runActions}
              collapsed={collapsed}
              onToggle={() => setCollapsedPersist(!collapsed)}
              emptyHint={record.status === 'canceled' ? 'The run was canceled before any node finished.' : queued ? 'Nothing has run yet: the execution is waiting in the queue.' : undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}
