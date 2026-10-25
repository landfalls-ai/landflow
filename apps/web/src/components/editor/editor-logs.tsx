'use client';
/**
 * The editor's docked Logs panel: the shared n8n-style LogsPanel fed from the
 * live run (or the execution loaded on the canvas), with re-run actions, the
 * raw event stream for debugging, and a draggable height.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { PanelBottomOpen, Play, SkipForward, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LogsPanel, type LogsNode, type LogsPending } from '../run/logs-panel';
import type { RunState } from '../run/run-status';
import { Button } from '../ui/button';
import { useEditor } from './store';

const HEIGHT_KEY = 'landflow-logs-height';
const MIN_HEIGHT = 180;

function readHeight() {
  try {
    const stored = Number(localStorage.getItem(HEIGHT_KEY));
    return stored >= MIN_HEIGHT ? stored : 300;
  } catch {
    return 300;
  }
}

function EventStream() {
  const log = useEditor((s) => s.log);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [log.length]);
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto border-t border-hair px-3 py-2 font-mono text-[11px] leading-5">
      {log.map((line) => (
        <div key={line.id} className="flex gap-3 animate-fade-up">
          <span className="w-16 shrink-0 text-right text-t3">+{line.offsetMs}ms</span>
          <span className={cn('w-12 shrink-0', line.kind === 'error' ? 'text-rd' : line.kind === 'finish' ? 'text-gn' : line.kind === 'pause' ? 'text-warn' : 'text-t3')}>{line.kind}</span>
          {line.nodeName && <span className="shrink-0 font-semibold text-t1">{line.nodeName}</span>}
          <span className="min-w-0 truncate text-t2">{line.message}</span>
        </div>
      ))}
      {!log.length && <div className="py-8 text-center text-t3">Events from the next run stream here: node starts and finishes, debugger pauses, plugin logs.</div>}
    </div>
  );
}

export function EditorLogs() {
  const runs = useEditor((s) => s.runs);
  const statuses = useEditor((s) => s.statuses);
  const flowNodes = useEditor((s) => s.nodes);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const running = useEditor((s) => s.running);
  const paused = useEditor((s) => s.paused);
  const runStatus = useEditor((s) => s.runStatus);
  const runStartedAt = useEditor((s) => s.runStartedAt);
  const runDurationMs = useEditor((s) => s.runDurationMs);
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState(false);
  const [height, setHeight] = useState(300);
  const drag = useRef<{ y: number; height: number } | null>(null);

  useEffect(() => setHeight(readHeight()), []);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const nodes = useMemo(() => Object.fromEntries(flowNodes.map((n) => [n.id, { name: n.data.wf.name, type: n.data.wf.type } satisfies LogsNode])), [flowNodes]);
  const pending = useMemo<LogsPending[]>(
    () =>
      Object.entries(statuses)
        .filter(([, st]) => st.state === 'running' || st.state === 'paused')
        .map(([nodeId, st]) => ({ nodeId, state: st.state === 'paused' ? 'paused' : 'running', startedAt: st.startedAt })),
    [statuses],
  );
  const status: RunState | undefined = paused ? 'paused' : runStatus;

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { y: e.clientY, height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const max = Math.round(window.innerHeight * 0.7);
    setHeight(Math.max(MIN_HEIGHT, Math.min(max, drag.current.height + drag.current.y - e.clientY)));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {}
  };

  const runNode = (nodeId: string, scope: 'only' | 'from') => useEditor.getState().run?.({ kind: 'node', nodeId, scope });
  const select = (nodeId: string) => useEditor.setState((s) => ({ nodes: s.nodes.map((n) => (n.selected === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId })) }));

  return (
    <div className="relative z-20 shrink-0 border-t border-hair bg-sf transition-[height] duration-200 ease-out" style={{ height: open ? height : 40 }}>
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize logs"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="group absolute inset-x-0 -top-1.5 z-10 flex h-3 cursor-row-resize items-center justify-center"
        >
          <span className="h-1 w-10 rounded-full bg-bd opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      )}
      <div className="flex h-full min-h-0 flex-col">
        <LogsPanel
          runData={runs}
          nodes={nodes}
          nodeTypes={nodeTypes}
          status={status}
          startedAt={runStartedAt}
          durationMs={runDurationMs}
          running={running}
          pending={pending}
          collapsed={!open || events}
          onToggle={() => {
            if (events) setEvents(false);
            else setOpen((o) => !o);
          }}
          onSelect={({ nodeId }) => select(nodeId)}
          className={cn(events && open ? 'h-auto flex-none' : 'min-h-0 flex-1')}
          emptyHint="Execute the workflow to see every node's input and output here, in the order they ran."
          headerActions={
            <Button
              size="sm"
              variant={events ? 'outline' : 'ghost'}
              onClick={() => {
                setOpen(true);
                setEvents((v) => !v);
              }}
              title="Raw event stream: starts, finishes, debugger pauses, plugin logs"
            >
              <Terminal className="size-3.5" /> Events
            </Button>
          }
          actions={(entry) =>
            entry.run.source === 'main' && (
              <>
                <Button size="sm" variant="ghost" onClick={() => useEditor.getState().openNode(entry.nodeId)} title="Open this node's details">
                  <PanelBottomOpen className="size-3.5" /> Open
                </Button>
                <Button size="sm" variant="ghost" disabled={running} onClick={() => runNode(entry.nodeId, 'only')} title="Run only this node again, with the same input">
                  <Play className="size-3.5" /> Re-run task
                </Button>
                <Button size="sm" disabled={running} onClick={() => runNode(entry.nodeId, 'from')} title="Re-run from this node; upstream results are reused">
                  <SkipForward className="size-3.5" /> Run from here
                </Button>
              </>
            )
          }
        />
        {open && events && <EventStream />}
      </div>
    </div>
  );
}
