'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import Link from 'next/link';
import { Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type OnConnectEnd, type OnEdgesChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowLeft,
  Bug,
  History,
  Loader2,
  Maximize,
  MessageCircle,
  Pause,
  Play,
  Plus,
  Redo2,
  Sparkles,
  Square,
  StepForward,
  StickyNote,
  Undo2,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, streamEvents, type ApiError } from '@/lib/client/api';
import { duration, plural, timeAgo } from '@/lib/client/format';
import { useLiveEvents } from '@/lib/client/live';
import { isPhone, usePhone } from '@/lib/client/use-phone';
import { tint } from '@/lib/client/node-style';
import { TEMPLATES } from '@/lib/client/templates';
import type { DebugCommand, ExecutionEvent, ExecutionRecord, ImportReport, NodeTypeInfo, Workflow } from '@/lib/shared/types';
import type { PolicyWarnings } from '@/lib/shared/governance';
import type { NodeProgress } from '@/lib/client/node-progress';
import { Badge, executionTone } from '../ui/badge';
import { Button } from '../ui/button';
import { NodeIcon } from '../ui/icon';
import { Kbd } from '../ui/inputs';
import { Segmented } from '../ui/segmented';
import { WorkflowTabs } from '../shell/workflow-tabs';
import { prefetchFailure, spotlightOwnsRun, useAssistant } from './assistant';
import { BrainCanvasCard } from '../brain/canvas-card';
import { focusSpotlight, SpotlightPanel } from './spotlight';
import { BuildProgressBar, GhostEdgeView, GhostNodeView, useGhosts } from './building';
import { AUTOSAVE_MS, shouldAutosave, showColumnSwitch, showMinimap, useChatColumn, visibleColumn } from './chrome';
import { ChatPanel, type ChatApproval, type ChatChunk, type ChatFile, type ChatOutcome } from './chat-panel';
import { parseClipboard, type ClipboardData } from './clipboard';
import { FlowEdgeView } from './flow-edge';
import { FlowNodeView } from './flow-node';
import { CanvasMenu, selectForMenu, useCanvasMenu } from './canvas-menu';
import { GroupNodeView, GroupProxyEdgeView } from './group-node';
import { boxPorts, loadComposites, useCompositeReports } from './composites';
import { canvasGraph, type GroupProxyEdge } from './groups';
import { ImportReportDialog, showImportReport } from './import-report';
import { NodeCreator } from './node-creator';
import { NodePanel } from './node-panel';
import { StepList } from './step-list';
import { EditorLogs } from './editor-logs';
import { ShortcutsDialog, useShortcuts } from './shortcuts-dialog';
import { StickyNodeView } from './sticky-node';
import { useEditor, type CanvasNode, type FlowEdge, type RunCommand } from './store';
import { VersionHistory, useVersionHistory } from './version-history';
import { WorkflowMenu } from './workflow-menu';
import { PublishControl } from './publish-control';
import { ListeningBar, listenForTestEvent, stopListening, testTriggerFor, useTestListener } from './test-listener';
import { EditLockBanner, editorTabHeaders, useEditLock, useEditLockSync } from './edit-lock';
import { followable, useFollowRun } from './follow-run';
import { pinFromRun } from './pin-from-run';
import { useFollowWaiting } from './waiting';

const nodeTypesMap = { lf: FlowNodeView, sticky: StickyNodeView, frame: GroupNodeView, ghost: GhostNodeView };
const edgeTypesMap = { lf: FlowEdgeView, groupProxy: GroupProxyEdgeView, ghost: GhostEdgeView };

/** What an edit changes in the store: the autosave timer restarts when any of these does. */
const AUTOSAVE_WATCHED = ['nodes', 'edges', 'stickies', 'groups', 'name', 'description', 'tags', 'settings', 'pinData'] as const;
/** A save that waits for someone's approval keeps the Save button and skips autosave. None does today: saves are drafts and Publish asks. */
const GOVERNED_SAVES = false;

type RunResult = { executionId?: string; status: string; lastNodeId?: string; error?: { message: string }; approval?: ChatApproval };

/** The reply text of a finished chat run: the last node's reply / output / text (or its JSON). */
function replyOf(result: RunResult): string | undefined {
  const last = result.lastNodeId ? useEditor.getState().runs[result.lastNodeId]?.at(-1) : undefined;
  const json = last?.outputs[0]?.[0]?.json as Record<string, unknown> | undefined;
  const reply = json?.reply ?? json?.output ?? json?.text;
  return reply === undefined ? (json ? JSON.stringify(json, null, 2) : undefined) : String(reply);
}


function describeClip(data: Pick<ClipboardData, 'nodes' | 'stickyNotes' | 'groups'>) {
  const groups = data.groups?.length ?? 0;
  return [groups && plural(groups, 'group'), data.nodes.length && plural(data.nodes.length, 'node'), data.stickyNotes.length && plural(data.stickyNotes.length, 'note')]
    .filter(Boolean)
    .join(', ');
}

/** Keyboard and clipboard events that belong to a field, a dialog or the node panel, not to the canvas. */
function notForCanvas(event: Event) {
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return true;
  const state = useEditor.getState();
  return Boolean(state.openNodeId || state.palette || document.querySelector('[role="dialog"]'));
}

/** Paste n8n's clipboard JSON: the importer converts it, then it is pasted like Landflow nodes. */
async function pasteN8n(data: unknown, at?: { x: number; y: number }) {
  try {
    const { workflow, report } = await api<{ workflow: Workflow; report: ImportReport }>('/api/workflows/import', { method: 'POST', json: { data, create: false } });
    const count = useEditor.getState().paste({ kind: 'landflow/nodes', version: 1, nodes: workflow.nodes, connections: workflow.connections, stickyNotes: workflow.stickyNotes ?? [], pinData: workflow.pinData }, at);
    if (report.placeholders.length || report.warnings.length) showImportReport(report, `Pasted ${plural(count, 'element')} from n8n`);
    else toast.success(`Pasted ${describeClip({ nodes: workflow.nodes, stickyNotes: workflow.stickyNotes ?? [] })} from n8n`);
  } catch (e) {
    toast.error(`Could not paste the n8n nodes: ${(e as Error).message}`);
  }
}

/**
 * A node that reports progress grows while it runs (a team node becomes the member at work, with the strip and moments
 * above it): when it no longer fits between the top of the canvas and the run controls, the view moves to it, never
 * zooming in. Not once the person has panned or zoomed during the run.
 */
function KeepRunningInView({ moved }: { moved: RefObject<boolean> }) {
  const { fitView, getZoom } = useReactFlow();
  const ids = useEditor(useShallow((s) => (s.running ? Object.keys(s.progress) : [])));
  const overflows = useStore((s) => {
    const [, y, zoom] = s.transform;
    return ids.some((id) => {
      const node = s.nodeLookup.get(id);
      if (!node?.measured?.height) return false;
      // The strip and moments sit above the node; the sub-node labels and the run controls below it.
      const top = (node.internals.positionAbsolute.y - 72) * zoom + y;
      const bottom = (node.internals.positionAbsolute.y + node.measured.height + 28) * zoom + y;
      return top < 8 || bottom > s.height - 64;
    });
  });
  useEffect(() => {
    if (!overflows || moved.current || !ids.length) return;
    const timer = setTimeout(() => void fitView({ nodes: ids.map((id) => ({ id })), padding: { top: '96px', bottom: '120px', left: '48px', right: '48px' }, maxZoom: getZoom(), duration: 300 }), 60);
    return () => clearTimeout(timer);
  }, [overflows, ids, moved, fitView, getZoom]);
  return null;
}

/**
 * While a change is being built (new look), a ghost that lands outside the view brings the whole flow and its ghosts into
 * view, never zooming in: a node added after the last one is often past the right edge.
 */
function KeepGhostsInView({ ids }: { ids: string[] }) {
  const { fitView, getZoom } = useReactFlow();
  const outside = useStore((s) => {
    const [x, y, zoom] = s.transform;
    return ids.some((id) => {
      const node = s.nodeLookup.get(id);
      if (!node) return false;
      const { x: nx, y: ny } = node.internals.positionAbsolute;
      const w = node.measured?.width ?? 80;
      const h = node.measured?.height ?? 80;
      // The node and its label below; the run controls sit at the bottom.
      return nx * zoom + x < 8 || (nx + w) * zoom + x > s.width - 8 || ny * zoom + y < 8 || (ny + h + 40) * zoom + y > s.height - 72;
    });
  });
  useEffect(() => {
    if (!outside || !ids.length) return;
    const timer = setTimeout(() => void fitView({ padding: { top: '72px', bottom: '120px', left: '48px', right: '48px' }, maxZoom: getZoom(), duration: 400 }), 80);
    return () => clearTimeout(timer);
  }, [outside, ids, fitView, getZoom]);
  return null;
}

/** ⌘I, the Spotlight button and the empty canvas's hint: the right column shows Spotlight (unfolded, caret in its box). */
function showSpotlight() {
  useChatColumn.getState().apply('show-spotlight');
  focusSpotlight();
}

function Canvas({ onSave }: { onSave: () => void }) {
  const flowNodes = useEditor((s) => s.nodes);
  const stickies = useEditor((s) => s.stickies);
  const groups = useEditor((s) => s.groups);
  const flowEdges = useEditor((s) => s.edges);
  // Group frames, then notes, then nodes; collapsed groups hide their nodes and take over their connections (a
  // collapsed composite's through its named outputs).
  const reports = useCompositeReports();
  const ports = useMemo(() => boxPorts(groups, reports), [groups, reports]);
  const built = useMemo<{ nodes: CanvasNode[]; edges: (FlowEdge | GroupProxyEdge)[] }>(() => canvasGraph(groups, stickies, flowNodes, flowEdges, ports), [groups, stickies, flowNodes, flowEdges, ports]);
  // New look: the nodes and connections a change being built adds, as dashed ghosts (./building.tsx). Not in the store.
  const ghosts = useGhosts();
  const nodes = useMemo(() => (ghosts.nodes.length ? [...built.nodes, ...(ghosts.nodes as unknown as CanvasNode[])] : built.nodes), [built.nodes, ghosts.nodes]);
  const edges = useMemo(() => (ghosts.edges.length ? [...built.edges, ...(ghosts.edges as unknown as FlowEdge[])] : built.edges), [built.edges, ghosts.edges]);
  const ghostKey = ghosts.nodes.map((n) => n.id).join(',');
  const ghostIds = useMemo(() => (ghostKey ? ghostKey.split(',') : []), [ghostKey]);
  // Read-only (someone else holds the edit lock) swaps the store's editing actions, so re-read them.
  const readOnly = useEditLock((s) => s.readOnly);
  const { onNodesChange, onEdgesChange, onConnect, openNode, openPalette } = useEditor.getState();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const fitted = useRef(false);
  // The person panned or zoomed during the run on the canvas: leave the view where they put it.
  const moved = useRef(false);
  const running = useEditor((s) => s.running);
  useEffect(() => {
    if (running) moved.current = false;
  }, [running]);
  const wrapper = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number }>(undefined);

  useEffect(() => {
    if (!fitted.current && nodes.length) {
      fitted.current = true;
      setTimeout(() => fitView({ padding: 0.25, duration: 400, maxZoom: 1.1 }), 50);
    }
  }, [nodes.length, fitView]);

  /** Where pasted and new notes go: the pointer when it is over the canvas, else the middle of the view. */
  const dropPoint = useCallback(
    (fallbackToCenter: boolean) => {
      if (pointer.current) return screenToFlowPosition(pointer.current);
      const rect = wrapper.current?.getBoundingClientRect();
      if (!fallbackToCenter || !rect) return undefined;
      return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    },
    [screenToFlowPosition],
  );

  // Copy, cut and paste use the clipboard events, so no clipboard permission is needed.
  useEffect(() => {
    const copy = (event: ClipboardEvent, cut: boolean) => {
      if (notForCanvas(event) || window.getSelection()?.toString()) return;
      const state = useEditor.getState();
      const data = state.copySelection();
      if (!data) return;
      event.clipboardData?.setData('text/plain', JSON.stringify(data, null, 2));
      event.preventDefault();
      if (cut) state.removeNodes([...data.nodes.map((n) => n.id), ...data.stickyNotes.map((n) => n.id), ...(data.groups ?? []).map((g) => g.id)]);
      toast(`${cut ? 'Cut' : 'Copied'} ${describeClip(data)}`, { description: 'Paste with ⌘V, here or in another workflow' });
    };
    const onCopy = (event: ClipboardEvent) => copy(event, false);
    const onCut = (event: ClipboardEvent) => copy(event, true);
    const onPaste = (event: ClipboardEvent) => {
      if (notForCanvas(event)) return;
      const parsed = parseClipboard(event.clipboardData?.getData('text/plain') ?? '');
      if (!parsed) return;
      event.preventDefault();
      const at = dropPoint(false);
      if (parsed.kind === 'n8n') return void pasteN8n(parsed.data, at);
      const count = useEditor.getState().paste(parsed.data, at);
      if (count) toast(`Pasted ${describeClip(parsed.data)}`);
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, [dropPoint]);

  // Dropping a dragged connection on empty canvas opens the palette pre-wired.
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromNode || !state.fromHandle) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      const handleId = state.fromHandle.id ?? 'main:0';
      const type = handleId.split(':')[0];
      openPalette({
        connectionType: type === 'main' ? undefined : (type as 'ai_tool'),
        from: { nodeId: state.fromNode.id, handleId, handleType: state.fromHandle.type },
        position: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
      });
    },
    [openPalette, screenToFlowPosition],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      const state = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 's') {
        e.preventDefault();
        onSave();
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        state.run?.({ kind: e.shiftKey ? 'debug' : 'run' });
      } else if (mod && e.key === 'i') {
        e.preventDefault();
        showSpotlight();
      } else if (e.key === 'F8' && state.paused) {
        e.preventDefault();
        void sendDebug(state.executionId, 'continue');
      } else if (e.key === 'F10' && state.paused) {
        e.preventDefault();
        void sendDebug(state.executionId, 'step');
      } else if (e.key === 'F9' && !typing) {
        e.preventDefault();
        const selected = state.nodes.find((n) => n.selected);
        if (selected) state.toggleBreakpoint(selected.id);
      } else if (!typing && (e.key === 'n' || e.key === 'Tab') && !state.palette && !state.openNodeId) {
        e.preventDefault();
        openPalette({});
      } else if (!typing && e.shiftKey && e.altKey && e.code === 'KeyT') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[aria-label="Tidy up"]')?.click();
      } else if (!typing && mod && e.code === 'KeyA' && !e.shiftKey && !e.altKey && !notForCanvas(e)) {
        e.preventDefault();
        state.selectAll();
      } else if (!typing && mod && e.code === 'KeyG' && !e.altKey && !notForCanvas(e)) {
        e.preventDefault();
        if (e.shiftKey) state.ungroup();
        else state.groupSelection();
      } else if (!typing && mod && e.key === 'd') {
        e.preventDefault();
        if (!notForCanvas(e)) state.duplicateSelection();
      } else if (!typing && mod && e.key.toLowerCase() === 'z' && !notForCanvas(e)) {
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
      } else if (!typing && mod && e.key === 'y' && !notForCanvas(e)) {
        e.preventDefault();
        state.redo();
      } else if (!typing && !mod && !e.altKey && e.shiftKey && e.code === 'KeyS' && !notForCanvas(e)) {
        e.preventDefault();
        const at = dropPoint(true);
        if (at) state.addSticky({ x: at.x - 130, y: at.y - 90 });
      } else if (!typing && e.key === '?' && !notForCanvas(e)) {
        e.preventDefault();
        useShortcuts.getState().setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSave, openPalette, dropPoint]);

  return (
    <div
      ref={wrapper}
      className="absolute inset-0"
      onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
      onPointerLeave={() => (pointer.current = undefined)}
    >
    <ReactFlow<CanvasNode, FlowEdge | GroupProxyEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypesMap}
      edgeTypes={edgeTypesMap}
      onNodesChange={onNodesChange}
      // Changes to the lines drawn for collapsed groups name no stored edge, so the store skips them.
      onEdgesChange={onEdgesChange as OnEdgesChange<FlowEdge | GroupProxyEdge>}
      onNodeContextMenu={(e, node) => {
        e.preventDefault();
        if (readOnly) return;
        selectForMenu(node.id);
        useCanvasMenu.getState().open({ x: e.clientX, y: e.clientY, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
      }}
      onSelectionContextMenu={(e) => {
        e.preventDefault();
        if (!readOnly) useCanvasMenu.getState().open({ x: e.clientX, y: e.clientY, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
      }}
      onPaneContextMenu={(e) => {
        e.preventDefault();
        if (!readOnly) useCanvasMenu.getState().open({ x: e.clientX, y: e.clientY, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
      }}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      onMoveStart={(event) => {
        if (event) moved.current = true;
      }}
      onNodeDoubleClick={(_e, node) => node.type === 'lf' && openNode(node.id)}
      // A phone: the first tap selects a step (its toolbar shows), a tap on a step that was already selected opens it.
      // The node passed is as it was before this click, so `selected` means it was selected already.
      onNodeClick={(_e, node) => {
        if (isPhone() && node.type === 'lf' && node.selected) openNode(node.id);
      }}
      onPaneClick={() => useEditor.getState().palette && openPalette(undefined)}
      isValidConnection={(c) => (c.sourceHandle ?? 'main').split(':')[0] === (c.targetHandle ?? 'main').split(':')[0] && c.source !== c.target}
      deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: 'lf' }}
      connectionLineStyle={{ stroke: 'var(--t2)', strokeWidth: 1.5, strokeDasharray: '5 4' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--canvas-dot)" />
      <KeepRunningInView moved={moved} />
      <KeepGhostsInView ids={ghostIds} />
      {/* One toolbar for zoom, fit, tidy, add, undo and redo (CanvasToolbar); a phone pinches to zoom. */}
      {showMinimap(flowNodes.length) && (
        <MiniMap
          position="bottom-right"
          className="!bottom-3 !right-3 max-md:!hidden"
          pannable
          zoomable
          nodeColor={(node) => (node.type === 'sticky' ? 'var(--acbd)' : node.type === 'frame' ? 'color-mix(in oklab, var(--t3) 14%, transparent)' : 'var(--bd)')}
        />
      )}
    </ReactFlow>
    <CanvasMenu />
    </div>
  );
}

async function sendDebug(executionId: string | undefined, command: DebugCommand) {
  if (!executionId) return;
  try {
    await api(`/api/executions/${executionId}/debug`, { method: 'POST', json: { command } });
  } catch (e) {
    toast.error((e as Error).message);
  }
}

/** Stop a run on the server (it outlives the editor's request); one that already ended has nothing to stop. */
function stopExecution(executionId: string) {
  api(`/api/executions/${executionId}/stop`, { method: 'POST' }).catch(() => {});
}

/** An execution as GET /api/executions/:id gives it: with each running node's latest progress while it runs. */
type OpenedExecution = { execution: ExecutionRecord; progress?: Record<string, NodeProgress> };

function EmptyCanvas() {
  const empty = useEditor((s) => s.nodes.length === 0 && s.stickies.length === 0 && s.groups.length === 0);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const drafting = useAssistant((s) => s.drafting);
  const { fitView } = useReactFlow();
  if (!empty) return null;
  // Spotlight is drafting the flow: a placeholder of what is coming, not the ways to start.
  if (drafting) {
    return (
      <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center pb-24">
        <div className="flex animate-fade-up flex-col items-center gap-5">
          <div className="flex items-center">
            {[0, 1, 2, 3].map((i) => (
              <Fragment key={i}>
                {i > 0 && <span className="w-10 border-t-2 border-dashed border-bd" />}
                <span className="size-16 animate-pulse-soft rounded-[18px] border-2 border-dashed border-bd bg-sf" style={{ animationDelay: `${i * 180}ms` }} />
              </Fragment>
            ))}
          </div>
          <span className="flex items-center gap-2 text-[13px] text-t2">
            <Loader2 className="size-3.5 animate-spin text-viz-7" /> Spotlight is drafting the flow from the node catalog…
          </span>
        </div>
      </div>
    );
  }
  const templates = TEMPLATES.filter((t) => t.nodes.every((n) => nodeTypes[n.type]?.available));
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-8 overflow-y-auto pb-16">
      <button
        onClick={() => useEditor.getState().openPalette({ connectionType: 'trigger' })}
        className="group pointer-events-auto flex animate-fade-up flex-col items-center gap-3"
      >
        <span className="grid size-24 place-items-center rounded-[22px] border-2 border-dashed border-bd bg-sf text-t3 transition-all duration-200 group-hover:scale-105 group-hover:border-ac group-hover:text-ac group-hover:shadow-pop">
          <Plus className="size-8" strokeWidth={1.5} />
        </span>
        <span className="text-[14px] font-semibold text-t1">Add first step…</span>
        <span className="text-[12px] text-t3">
          or press <Kbd>N</Kbd>
        </span>
      </button>
      <button onClick={showSpotlight} className="pointer-events-auto -mt-4 animate-fade-up text-[12.5px] text-t3 transition-colors hover:text-t1" style={{ animationDelay: '80ms' }}>
        or describe it to Spotlight <Kbd>⌘I</Kbd>
      </button>
      {templates.length > 0 && (
        <div className="pointer-events-auto flex w-full max-w-[880px] flex-col items-center gap-3 px-6">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">or start from a template</div>
          <div className="grid w-full grid-cols-2 gap-2.5 lg:grid-cols-4">
            {templates.map((t, i) => (
              <button
                key={t.id}
                onClick={() => {
                  useEditor.getState().applyTemplate(t);
                  setTimeout(() => fitView({ padding: 0.25, duration: 500, maxZoom: 1.1 }), 60);
                  toast.success(`Added “${t.title}”: press Execute to try it`);
                }}
                style={{ animationDelay: `${120 + i * 60}ms` }}
                className="group flex animate-fade-up flex-col gap-2 rounded-2xl border border-hair bg-sf p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-bd hover:shadow-pop"
              >
                <span className="grid size-9 place-items-center rounded-[10px]" style={{ background: tint(t.color, 14) }}>
                  <NodeIcon icon={t.icon} size={18} style={{ color: t.color }} />
                </span>
                <span className="text-[13px] font-semibold text-t1">{t.title}</span>
                <span className="text-[12px] leading-snug text-t3">{t.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The one canvas toolbar, top right: add a node or note, tidy up, zoom in and out, fit view, undo and redo. */
function CanvasToolbar() {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const hasNodes = useEditor((s) => s.nodes.length > 0);
  const creatorOpen = useEditor((s) => Boolean(s.palette));
  const { screenToFlowPosition } = useReactFlow();
  const addNote = () => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    const center = pane ? screenToFlowPosition({ x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }) : { x: 0, y: 0 };
    useEditor.getState().addSticky({ x: center.x - 130, y: center.y - 90 });
  };
  const canUndo = useEditor((s) => s.history.past > 0);
  const canRedo = useEditor((s) => s.history.future > 0);
  if (creatorOpen) return null;
  const button = 'grid size-9 place-items-center text-t2 transition-colors hover:bg-acdim hover:text-t1 max-md:size-11 disabled:opacity-40';
  return (
    <>
      <div className="absolute right-3 top-3 z-20 flex animate-fade-up flex-col overflow-hidden rounded-xl border border-hair bg-sf shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
        <button title="Add node (N)" aria-label="Add node" onClick={() => useEditor.getState().openPalette({})} className={button}>
          <Plus className="size-4" />
        </button>
        <button title="Add sticky note (⇧S)" aria-label="Add sticky note" onClick={addNote} className={cn(button, 'border-t border-hair')}>
          <StickyNote className="size-4" />
        </button>
        {hasNodes && (
          <>
            <button
              title="Tidy up (⇧⌥T)"
              aria-label="Tidy up"
              onClick={() => {
                const pane = document.querySelector('.react-flow');
                pane?.classList.add('lf-tidy');
                useEditor.getState().tidyUp();
                setTimeout(() => fitView({ padding: 0.25, duration: 500, maxZoom: 1.1 }), 30);
                setTimeout(() => pane?.classList.remove('lf-tidy'), 600);
              }}
              className={cn(button, 'border-t border-hair')}
            >
              <WandSparkles className="size-4" />
            </button>
            {/* A phone pinches to zoom. */}
            <button title="Zoom in" aria-label="Zoom in" onClick={() => void zoomIn({ duration: 200 })} className={cn(button, 'border-t border-hair max-md:hidden')}>
              <ZoomIn className="size-4" />
            </button>
            <button title="Zoom out" aria-label="Zoom out" onClick={() => void zoomOut({ duration: 200 })} className={cn(button, 'border-t border-hair max-md:hidden')}>
              <ZoomOut className="size-4" />
            </button>
            <button
              title="Fit view (1)"
              aria-label="Fit view"
              onClick={() => fitView({ padding: 0.25, duration: 400, maxZoom: 1.1 })}
              className={cn(button, 'border-t border-hair')}
            >
              <Maximize className="size-4" />
            </button>
          </>
        )}
        <button title="Undo" aria-label="Undo" disabled={!canUndo} onClick={() => useEditor.getState().undo()} className={cn(button, 'border-t border-hair')}>
          <Undo2 className="size-4" />
        </button>
        <button title="Redo" aria-label="Redo" disabled={!canRedo} onClick={() => useEditor.getState().redo()} className={cn(button, 'border-t border-hair')}>
          <Redo2 className="size-4" />
        </button>
      </div>
    </>
  );
}

/** The strip under the top bar: debugger controls, or which past execution is shown. */
function StatusStrip() {
  const running = useEditor((s) => s.running);
  const debugging = useEditor((s) => s.debugging);
  const paused = useEditor((s) => s.paused);
  const executionId = useEditor((s) => s.executionId);
  const viewing = useEditor((s) => s.viewing);

  if (running && debugging) {
    return (
      <div className={cn('flex h-10 shrink-0 items-center gap-2.5 border-b px-4 text-[13px]', paused ? 'border-warnbd bg-warndim' : 'border-hair bg-sf2')}>
        {paused ? (
          <>
            <Pause className="size-3.5 text-warn" fill="currentColor" strokeWidth={0} />
            <span className="text-t1">
              Paused before{' '}
              <button className="font-semibold underline-offset-2 hover:underline" onClick={() => useEditor.getState().openNode(paused.nodeId)}>
                {paused.nodeName}
              </button>
            </span>
            <Badge tone="warning">{paused.reason === 'breakpoint' ? 'breakpoint' : 'step'}</Badge>
            <span className="text-[12px] text-t3">
              {paused.inputs[0]?.length ?? 0} input item{paused.inputs[0]?.length === 1 ? '' : 's'}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => useEditor.getState().openNode(paused.nodeId)}>
                Inspect input
              </Button>
              <Button size="sm" onClick={() => void sendDebug(executionId, 'step')} title="Run this node and pause before the next (F10)">
                <StepForward className="size-3.5" /> Step <Kbd>F10</Kbd>
              </Button>
              <Button size="sm" variant="primary" onClick={() => void sendDebug(executionId, 'continue')} title="Run to the next breakpoint (F8)">
                <Play className="size-3.5" fill="currentColor" /> Continue <Kbd>F8</Kbd>
              </Button>
              <Button size="sm" variant="danger" onClick={() => void sendDebug(executionId, 'stop')}>
                <Square className="size-3" fill="currentColor" /> Stop
              </Button>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="size-3.5 animate-spin text-t2" />
            <span className="text-t1">Debugging</span>
            <span className="text-[12px] text-t3">runs until the next breakpoint</span>
            <Button size="sm" variant="danger" className="ml-auto" onClick={() => void sendDebug(executionId, 'stop')}>
              <Square className="size-3" fill="currentColor" /> Stop
            </Button>
          </>
        )}
      </div>
    );
  }

  if (viewing && !running) {
    return (
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-hair bg-sf2 px-4 text-[13px]">
        <History className="size-3.5 text-t3" />
        <span className="text-t1">
          Showing execution <span className="font-mono text-[12px]">{viewing.id}</span>
        </span>
        <Badge tone={executionTone(viewing.status)}>{viewing.status}</Badge>
        <span className="text-[12px] text-t3">{timeAgo(viewing.startedAt)} · select a node and use Run node or Run from here to re-run part of it</span>
        <div className="ml-auto flex items-center gap-2">
          <Link href={`/workflows/${useEditor.getState().workflowId}/executions/${viewing.id}`} className="text-[12px] text-t2 hover:text-ac">
            Open in executions
          </Link>
          <Button size="icon-sm" variant="ghost" onClick={() => useEditor.getState().clearRun()} aria-label="Clear execution data">
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }
  return null;
}

export function Editor({ workflowId }: { workflowId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // A phone: the flow as a list of steps first, the canvas a tap away. A desktop always shows the canvas.
  const phone = usePhone();
  const [view, setView] = useState<'steps' | 'canvas'>('steps');
  const hasSteps = useEditor((s) => s.nodes.length > 0);
  const showSteps = phone && hasSteps && view === 'steps';
  // The right column holds one panel: Spotlight or the flow chat (./chrome).
  const columnState = useChatColumn((s) => s.column);
  const abortRef = useRef<AbortController | null>(null);
  // Stop pressed before the server named the execution: stopped as soon as it does.
  const stopWhenStarted = useRef(false);
  const name = useEditor((s) => s.name);
  const dirty = useEditor((s) => s.dirty);
  const running = useEditor((s) => s.running);
  const debugging = useEditor((s) => s.debugging);
  const breakpoints = useEditor((s) => s.breakpoints);
  const hasChatTrigger = useEditor((s) => s.nodes.some((n) => n.data.wf.type === 'core.chatTrigger'));
  const column = visibleColumn(columnState, hasChatTrigger);
  const chatOpen = column === 'chat';
  const nodeCount = useEditor((s) => s.nodes.length);
  const readOnly = useEditLock((s) => s.readOnly);
  const { takeOver } = useEditLockSync(workflowId, loaded);
  // A waiting run on the canvas keeps its waiting mark current and shows the rest once it resumes.
  useFollowWaiting();
  // A run this editor started before a reload goes on: show it live again.
  useFollowRun();
  const spotlightFolded = useAssistant((s) => s.collapsed);
  const spotlightOpen = !spotlightFolded;
  const spotlightVisible = column !== 'chat' && spotlightOpen;
  // On a phone, Spotlight's own runs take the canvas: the Execute bar steps aside while it drafts or tests.
  const spotlightWorks = useAssistant((s) => s.drafting || Boolean(s.testing));

  // Spotlight starts a build or a test: it takes the column (once, so the person can still switch to the chat while it works).
  const wasWorking = useRef(false);
  useEffect(() => {
    if (spotlightWorks && !wasWorking.current && useChatColumn.getState().column === 'chat') useChatColumn.getState().apply('show-spotlight');
    wasWorking.current = spotlightWorks;
  }, [spotlightWorks]);

  // The assistant's conversation lasts while this workflow is open.
  useEffect(() => useAssistant.getState().bind(workflowId), [workflowId]);

  useEffect(() => {
    let cancelled = false;
    const requested = new URLSearchParams(window.location.search).get('execution');
    // Node types for this workflow: its project's and its own allow-lists hide nodes in the node creator too.
    Promise.all([api<{ workflow: Workflow }>(`/api/workflows/${workflowId}`), api<{ nodeTypes: NodeTypeInfo[] }>(`/api/node-types?workflowId=${encodeURIComponent(workflowId)}`)])
      .then(([{ workflow }, { nodeTypes }]) => {
        if (cancelled) return;
        useEditor.getState().load(workflow, nodeTypes);
        loadComposites();
        setLoaded(true);
        useChatColumn.setState({ column: workflow.nodes.some((n) => n.type === 'core.chatTrigger') && !requested ? 'chat' : null });
        // Show an execution from history if one was asked for, else the last run, so the canvas isn't blank.
        const record = requested
          ? api<OpenedExecution>(`/api/executions/${requested}`)
          : api<{ executions: { id: string }[] }>(`/api/executions?workflowId=${workflowId}&limit=1`).then(({ executions }) => executions[0] && api<OpenedExecution>(`/api/executions/${executions[0].id}`));
        record
          .then((r) => {
            if (!r || useEditor.getState().running) return;
            // "Copy to editor" from the Run Trace: the steps before the asked node keep this run's outputs as pinned test data.
            const pin = requested ? new URLSearchParams(window.location.search).get('pin') : null;
            if (pin) {
              const count = pinFromRun(r.execution, pin);
              toast.success(count ? `Pinned the outputs of ${count} step${count === 1 ? '' : 's'} from this run` : 'No earlier outputs to pin', { description: 'Fix the flow, then run it: pinned steps return their data instead of running.' });
            }
            if (followable(r.execution)) useEditor.getState().attachRun(r.execution, r.progress, Boolean(requested));
            else useEditor.getState().loadExecution(r.execution, Boolean(requested));
          })
          .catch(() => requested && toast.error(`Execution ${requested} not found`));
      })
      .catch((e: Error) => toast.error(`Could not load workflow: ${e.message}`));
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  // Plugins come and go — keep node availability/transport fresh.
  useLiveEvents((event) => {
    if (event.channel !== 'registry' || event.event.type === 'plugin.heartbeat' || event.event.type.startsWith('scan.')) return;
    api<{ nodeTypes: NodeTypeInfo[] }>(`/api/node-types?workflowId=${encodeURIComponent(workflowId)}`)
      .then(({ nodeTypes }) => useEditor.getState().setNodeTypes(nodeTypes))
      .catch(() => {});
    loadComposites();
    if (event.event.type === 'plugin.registered') toast(event.event.message);
    if (event.event.type === 'plugin.offline') toast.warning(event.event.message);
  });

  // Breakpoints edited mid-debug apply to the running execution straight away.
  useEffect(() => {
    const { executionId } = useEditor.getState();
    if (!running || !debugging || !executionId) return;
    api(`/api/executions/${executionId}/debug`, { method: 'POST', json: { breakpoints } }).catch(() => {});
  }, [breakpoints, running, debugging]);

  // Autosave: set by the effect below; a save that finds edits made while it was in flight asks for another.
  const savingNow = useRef(false);
  const rearm = useRef<() => void>(undefined);
  const saveQueue = useRef<Promise<boolean> | undefined>(undefined);
  /** `auto`: the timed save (folds into the session's version); `quiet`: no "Saved" toast (defaults to `auto`). */
  const saveOnce = useCallback(async (auto = false, quiet = auto, leaving = false): Promise<boolean> => {
    if (useEditLock.getState().readOnly) {
      const environment = useEditLock.getState().protectedEnvironment;
      toast.error(environment ? `${environment} is a protected environment: workflows change only by pull or promotion` : 'Someone else is editing this workflow: it’s read-only here');
      return false;
    }
    setSaving(true);
    savingNow.current = true;
    try {
      // `active` stays out: a save is a draft, and Publish / Unpublish (PublishControl) change what is live.
      const { active: _active, ...draft } = useEditor.getState().toWorkflow();
      // Based on the version this tab loaded or last saved: someone else's newer save is refused (412) instead of overwritten.
      const base = useEditor.getState().baseUpdatedAt;
      const put = (baseline?: string) =>
        api<{ workflow: Workflow; triggerAuthWarnings?: Array<{ nodeName: string; message: string }> } & PolicyWarnings>(`/api/workflows/${workflowId}`, {
          method: 'PUT',
          json: draft,
          // A save sent while the page unloads survives it only with keepalive, which allows about 64 KB; a bigger one relies on the browser's prompt.
          ...(leaving && JSON.stringify(draft).length < 60_000 && { keepalive: true }),
          headers: { ...editorTabHeaders(), ...(auto && { 'x-landflow-autosave': '1' }), ...(baseline && { 'if-match': `"${baseline}"` }) },
        });
      let saved;
      try {
        saved = await put(base);
      } catch (e) {
        if ((e as ApiError).status !== 412) throw e;
        // Refused as stale. A scheduled publish, an approval or a folder move also moves `updatedAt`: if the stored content is still what this tab loaded or saved, nobody else's edit is at stake, so take the new version and save once more.
        const { workflow: stored } = await api<{ workflow: Workflow }>(`/api/workflows/${workflowId}`);
        if (!useEditor.getState().storedMatchesSaved(stored)) throw e;
        if (stored.updatedAt) useEditor.getState().rebase(stored.updatedAt);
        saved = await put(stored.updatedAt);
      }
      const { workflow, policyWarnings, triggerAuthWarnings } = saved;
      // The person opened another workflow while this save was in flight: its store is not this one's to mark.
      if (useEditor.getState().workflowId !== workflowId) return true;
      useEditor.getState().markSaved(workflow.updatedAt, workflow);
      // Edits made while the request was in flight are not in what was saved: the draft stays unsaved and saves again.
      const { active: _live, ...now } = useEditor.getState().toWorkflow();
      if (JSON.stringify(now) !== JSON.stringify(draft)) {
        useEditor.setState({ dirty: true });
        rearm.current?.();
      }
      if (!quiet) toast.success(`Saved “${workflow.name}”`);
      // Nodes the governance policy doesn't allow: the save stands, publishing is refused and they fail when run.
      if (policyWarnings?.length) toast.warning(`${policyWarnings.length === 1 ? '1 node is' : `${policyWarnings.length} nodes are`} blocked by policy`, { id: 'policy-warnings', description: policyWarnings.map((w) => `${w.nodeName}: ${w.message}`).join('\n') });
      // A trigger checking callers with a credential this workflow's project can't use: its calls are refused (403).
      if (triggerAuthWarnings?.length) toast.warning('Trigger authentication isn’t available to this project', { id: 'trigger-auth-warnings', description: triggerAuthWarnings.map((w) => `${w.nodeName}: ${w.message}`).join('\n') });
      return true;
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`, { id: 'save-failed' });
      return false;
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }, [workflowId]);

  /** One save at a time: a save asked for while another is in flight (⌘S, Publish, a tab) waits for it instead of racing it. */
  const save = useCallback(
    (auto = false, quiet = auto, leaving = false): Promise<boolean> => {
      const prior = saveQueue.current;
      const run = prior ? prior.catch(() => false).then(() => saveOnce(auto, quiet, leaving)) : saveOnce(auto, quiet, leaving);
      const tracked = run.finally(() => {
        if (saveQueue.current === tracked) saveQueue.current = undefined;
      });
      saveQueue.current = tracked;
      return tracked;
    },
    [saveOnce],
  );

  const execute = useCallback(
    async (extra: Record<string, unknown> = {}, debug = false, onChunk?: (chunk: ChatChunk) => void): Promise<RunResult | undefined> => {
      const state = useEditor.getState();
      if (state.running) return undefined;
      state.startRun(debug);
      stopWhenStarted.current = false;
      const controller = new AbortController();
      abortRef.current = controller;
      let result: RunResult | undefined;
      try {
        await streamEvents(
          `/api/workflows/${workflowId}/run`,
          {
            workflow: state.toWorkflow(),
            ...extra,
            // With no breakpoints set, debugging pauses before the first node.
            ...(debug && { debug: { breakpoints: state.breakpoints, step: state.breakpoints.length === 0 } }),
          },
          (event, data) => {
            if (event === 'started') {
              const { executionId } = data as { executionId: string };
              useEditor.setState({ executionId });
              if (stopWhenStarted.current) stopExecution(executionId);
            }
            if (event === 'execution') {
              const update = data as ExecutionEvent;
              // Streamed text and tool calls go to the chat panel; everything else to the canvas and the log.
              if (update.type === 'node.chunk') onChunk?.(update.chunk);
              else useEditor.getState().applyEvent(update);
            }
            if (event === 'result') result = data as RunResult;
          },
          controller.signal,
        );
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast.error((e as Error).message);
      } finally {
        useEditor.getState().finishRun();
        abortRef.current = null;
      }
      // The stream broke before the run ended (the connection dropped): it goes on on the server, so follow it there.
      const { executionId } = useEditor.getState();
      if (!result && !debug && executionId)
        api<OpenedExecution>(`/api/executions/${executionId}`)
          .then((r) => followable(r.execution) && !useEditor.getState().running && useEditor.getState().attachRun(r.execution, r.progress))
          .catch(() => {});
      return result;
    },
    [workflowId],
  );

  const report = useCallback((result: RunResult | undefined, started: number, label: string, spotlights = false) => {
    if (!result) return;
    if (result.status === 'error') prefetchFailure();
    if (spotlights || spotlightOwnsRun()) return;
    if (result.status === 'success') toast.success(`${label} succeeded in ${duration(Date.now() - started)}`);
    else if (result.status === 'canceled') toast(`${label} stopped`);
    else if (result.status === 'waiting') toast(`${label} is waiting; it continues in the background`);
    else toast.error(`${label} failed${result.error?.message ? `: ${result.error.message}` : ''}`);
  }, []);

  const runCommand = useCallback(
    async (command: RunCommand) => {
      const started = Date.now();
      if (useTestListener.getState().listening) return;
      // A Webhook or Form trigger without test data: listen for a test event instead, as n8n does.
      const listenOn = testTriggerFor(command);
      if (listenOn) return listenForTestEvent(listenOn);
      if (command.kind === 'run') return report(await execute(), started, 'Workflow', command.by === 'spotlight');
      if (command.kind === 'debug') return report(await execute({}, true), started, 'Debug run');

      const state = useEditor.getState();
      const node = state.nodes.find((n) => n.id === command.nodeId);
      if (!node) return;
      // Re-running part of a run needs that run's data for this node or its parents.
      const source = state.executionId;
      const hasInput =
        state.runs[node.id]?.some((r) => r.source === 'main') ||
        state.edges.some((e) => e.target === node.id && e.data?.connectionType === 'main' && state.runs[e.source]?.some((r) => r.source === 'main'));
      const label = command.scope === 'only' ? `“${node.data.wf.name}”` : `Run from “${node.data.wf.name}”`;
      if (source && hasInput) return report(await execute({ rerun: { executionId: source, scope: command.scope, nodeId: node.id } }), started, label);
      // Nothing to reuse yet: run what leads up to the node (and stop there for "only").
      return report(await execute(command.scope === 'only' ? { destinationNodeId: node.id } : {}), started, label);
    },
    [execute, report],
  );

  useEffect(() => {
    useEditor.setState({ run: (command) => void runCommand(command) });
    return () => useEditor.setState({ run: undefined });
  }, [runCommand]);

  useEffect(() => {
    useEditor.setState({ save });
    return () => useEditor.setState({ save: undefined });
  }, [save]);

  // Autosave: a draft saves itself 2 s after the last edit when the save needs nobody's approval and this tab holds the edit
  // lock (⌘S still saves now). Saves are drafts, so none needs approval today; `GOVERNED_SAVES` is where one would say so.
  useEffect(() => {
    if (!loaded) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Not while Spotlight is drafting the flow: a half-built draft is not worth a save (or a version).
    const allowed = () => shouldAutosave({ dirty: useEditor.getState().dirty && !useAssistant.getState().drafting, readOnly, governed: GOVERNED_SAVES, locked: !readOnly });
    const arm = () => {
      clearTimeout(timer);
      if (!allowed()) return;
      timer = setTimeout(() => {
        // A save still in flight: look again once it is done.
        if (savingNow.current) return arm();
        if (allowed()) void save(true);
      }, AUTOSAVE_MS);
    };
    rearm.current = arm;
    const unsubscribe = useEditor.subscribe((state, prev) => {
      if (AUTOSAVE_WATCHED.some((key) => state[key] !== prev[key])) arm();
    });
    const unsubscribeDrafting = useAssistant.subscribe((state, prev) => {
      if (state.drafting !== prev.drafting) arm();
    });
    // Leaving inside the 2 s wait (Back, reload, closing the tab) must not drop the last edit: save at once.
    const flush = () => {
      clearTimeout(timer);
      // The lock may have moved to another tab since this effect ran: ask the live state, so no read-only toast shows.
      if (allowed() && !useEditLock.getState().readOnly) void save(true, true, true);
    };
    const guard = (event: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty && !readOnly) event.preventDefault();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', guard);
    arm();
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', guard);
      unsubscribe();
      unsubscribeDrafting();
      rearm.current = undefined;
    };
  }, [loaded, readOnly, save]);

  const stop = () => {
    stopListening();
    const { debugging: inDebug, executionId, running } = useEditor.getState();
    if (inDebug && executionId) void sendDebug(executionId, 'stop');
    else if (inDebug) abortRef.current?.abort();
    // The run outlives this page's request, so Stop asks the server; the stream then ends with the run.
    else if (running && executionId) stopExecution(executionId);
    else if (running) stopWhenStarted.current = true;
  };

  const sendChat = useCallback(
    async (message: string, sessionId: string, files: ChatFile[], onChunk: (chunk: ChatChunk) => void): Promise<ChatOutcome> => {
      const attached = files.map(({ fileName, mimeType, data }) => ({ fileName, mimeType, data }));
      const result = await execute({ chat: { message, sessionId, ...(attached.length && { files: attached }) } }, false, onChunk);
      // An AI Agent waiting for a tool approval: the panel shows Approve / Reject.
      if (result?.status === 'waiting' && result.approval) return { executionId: result.executionId, approval: result.approval };
      if (result?.status === 'waiting') return { reply: 'The workflow is waiting (a Wait or form node); it continues in the background.', executionId: result.executionId };
      if (!result || result.status !== 'success') throw new Error(result?.error?.message ?? 'Execution failed');
      return { reply: replyOf(result), executionId: result.executionId };
    },
    [execute],
  );

  /** Approve or reject one waiting tool call; the resumed run streams like a chat run (POST /api/executions/:id/approvals). */
  const decideChat = useCallback(async (executionId: string, callId: string, approved: boolean, onChunk: (chunk: ChatChunk) => void): Promise<ChatOutcome> => {
    let result: RunResult | undefined;
    let resumed = false;
    let stillWaiting = false;
    try {
      await streamEvents(`/api/executions/${executionId}/approvals`, { callId, approved }, (event, data) => {
        if (event === 'decision') {
          const decision = data as { status: 'waiting' | 'resumed' };
          if (decision.status === 'waiting') stillWaiting = true;
          else if (!resumed) {
            resumed = true;
            useEditor.setState({ running: true, runStatus: 'running', executionId });
          }
        }
        if (event === 'execution') {
          const update = data as ExecutionEvent;
          if (update.type === 'node.chunk') onChunk(update.chunk);
          else useEditor.getState().applyEvent(update);
        }
        if (event === 'result') result = data as RunResult;
      });
    } finally {
      if (resumed) useEditor.getState().finishRun();
    }
    if (stillWaiting) return { stillWaiting: true };
    if (result?.status === 'waiting' && result.approval) return { executionId: result.executionId ?? executionId, approval: result.approval };
    if (!result || result.status !== 'success') throw new Error(result?.error?.message ?? 'Execution failed');
    return { reply: replyOf(result), executionId };
  }, []);

  if (!loaded) {
    return (
      <div className="grid h-dvh place-items-center">
        <Loader2 className="size-5 animate-spin text-t3" />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      {/* The whole screen (a phone has no tab bar here, sidebar.tsx): the box at the bottom of Spotlight stays on screen. */}
      <div className="flex h-dvh flex-col">
        {/* Seven controls: back, name, save state, Spotlight, Run, Publish, ⋯ (Save only where autosave is off; the tabs are
            navigation). Phone: two rows. Back, name, saved state and ⋯; then the tabs and Publish. */}
        <header className="relative flex h-[52px] shrink-0 items-center gap-3 border-b border-hair bg-bg px-4 max-md:h-auto max-md:flex-wrap max-md:gap-x-1.5 max-md:gap-y-1.5 max-md:px-2 max-md:pb-2 max-md:pt-[max(6px,env(safe-area-inset-top))]">
          <Link href="/workflows" aria-label="Back to workflows" className="grid size-8 shrink-0 place-items-center rounded-full text-t2 hover:bg-acdim hover:text-t1 max-md:size-11">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex min-w-0 max-w-[calc(50%-150px)] items-center gap-3 max-md:max-w-none max-md:flex-1 max-md:gap-2">
            <input
              value={name}
              onChange={(e) => useEditor.getState().setMeta({ name: e.target.value })}
              // One undo step per rename: it ends on blur or Enter.
              onBlur={() => useEditor.getState().commitName()}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              aria-label="Workflow name"
              size={Math.max(12, Math.min(name.length + 1, 40))}
              className="min-w-0 max-w-[300px] shrink bg-transparent text-[15px] font-semibold text-t1 outline-none"
            />
            <span
              role="status"
              className={cn('flex shrink-0 items-center gap-1.5 text-[12px]', dirty || saving ? 'text-warn' : 'text-t3')}
              title={saving ? 'Saving…' : dirty ? 'Unsaved: it saves by itself in a moment' : 'Saved'}
            >
              <span className={cn('size-1.5 rounded-full transition-colors', dirty || saving ? 'bg-warn' : 'bg-gn')} />
              <span className="max-md:sr-only">{saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span>
            </span>
          </div>

          <WorkflowTabs
            workflowId={workflowId}
            active="editor"
            beforeLeave={async () => useEditor.getState().dirty && (await save(false, true))}
            className="absolute left-1/2 -translate-x-1/2 max-md:static max-md:order-3 max-md:translate-x-0"
          />

          <div className="ml-auto flex items-center gap-2 max-md:contents">
            <Button
              variant={spotlightVisible ? 'outline' : 'ghost'}
              onClick={() => (spotlightVisible ? useAssistant.getState().setCollapsed(true) : showSpotlight())}
              title="Spotlight: build and fix this flow by talking (⌘I)"
              aria-pressed={spotlightVisible}
              className="max-md:hidden"
            >
              <Sparkles className="size-3.5 text-viz-7" /> Spotlight
            </Button>
            <Button
              variant={running ? 'danger' : 'outline'}
              onClick={() => (running ? stop() : void runCommand({ kind: 'run' }))}
              disabled={nodeCount === 0}
              title={running ? 'Stop the run' : 'Run the workflow (⌘↵)'}
              className="max-md:hidden"
            >
              {running ? <Square className="size-3" fill="currentColor" /> : <Play className="size-3.5" fill="currentColor" />} {running ? 'Stop' : 'Run'}
            </Button>
            <span className="contents max-md:[&>*]:order-4 max-md:[&>*:first-child]:ml-auto">
              <PublishControl workflowId={workflowId} onSave={save} />
            </span>
            {GOVERNED_SAVES && (
              <Button onClick={() => void save()} loading={saving} disabled={readOnly} title="Save (⌘S)" variant={dirty ? 'primary' : 'outline'}>
                Save
              </Button>
            )}
            <WorkflowMenu onSave={save} />
          </div>
          {/* Phone: the second row starts here. */}
          <span className="hidden max-md:order-2 max-md:block max-md:basis-full" aria-hidden />
          {running && <span className="lf-shimmer absolute inset-x-0 bottom-[-1px] h-[2px]" />}
        </header>

        <EditLockBanner onTakeOver={() => void takeOver()} />
        <StatusStrip />

        <div className="relative flex min-h-0 flex-1 max-md:flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <Canvas onSave={() => void save()} />
              <EmptyCanvas />
              {/* A phone opens on the Steps view (docs/mobile.md#the-steps-view); the canvas stays mounted under it. */}
              {showSteps ? <StepList /> : <CanvasToolbar />}
              {phone && hasSteps && <ViewSwitch view={view} onChange={setView} />}
              <BuildProgressBar />
              {!showSteps && <BrainCanvasCard />}
              {/* The run controls at the bottom, clear of zoom and the minimap. */}
              <div className={cn('pointer-events-none absolute inset-x-0 bottom-4 z-20 flex flex-wrap-reverse items-start justify-center gap-2 px-3 max-md:bottom-3', showMinimap(nodeCount) && 'md:pr-[232px]', spotlightWorks && 'max-md:hidden')}>
                <ExecuteBar
                  running={running}
                  breakpoints={breakpoints.length}
                  hasChat={hasChatTrigger}
                  chatOpen={chatOpen}
                  onRun={() => void runCommand({ kind: 'run' })}
                  onDebug={() => void runCommand({ kind: 'debug' })}
                  onStop={stop}
                  onChat={() => useChatColumn.getState().apply('toggle-chat')}
                />
              </div>
            </div>
            {/* On a phone, Spotlight's open sheet or the step cards say how each run went: the logs give them their room. */}
            <div className={cn('contents', (spotlightOpen || showSteps) && 'max-md:hidden')}>
              <EditorLogs />
            </div>
          </div>
          {/* One column beside the canvas (under it on a phone): Spotlight or the flow chat, never both, never over the canvas.
              The one not shown stays mounted, so a running build or chat goes on. */}
          <div className="flex min-h-0 flex-col max-md:contents">
            {showColumnSwitch({ hasChat: hasChatTrigger, column, spotlightFolded }) && (
              <div className="flex h-11 shrink-0 items-center border-b border-l border-hair bg-sf px-2 max-md:hidden">
                <Segmented
                  label="Right panel"
                  size="sm"
                  stretch
                  value={chatOpen ? 'chat' : 'spotlight'}
                  onChange={(value) => (value === 'chat' ? useChatColumn.getState().apply('show-chat') : showSpotlight())}
                  options={[
                    { value: 'spotlight', label: 'Spotlight', title: 'Build and fix this flow (⌘I)' },
                    { value: 'chat', label: 'Chat', title: 'Talk to this workflow' },
                  ]}
                />
              </div>
            )}
            <div className="flex min-h-0 flex-1 max-md:contents">
              <div className={chatOpen ? 'hidden' : 'contents'}>
                <SpotlightPanel hiddenOnPhone={chatOpen} />
              </div>
              <ChatPanel open={chatOpen} onClose={() => useChatColumn.getState().apply('close-chat')} onSend={sendChat} onDecide={decideChat} />
            </div>
          </div>
          <NodeCreator />
        </div>
        <NodePanel />
        <VersionHistory onSave={save} />
        <ShortcutsDialog />
        <ImportReportDialog />
      </div>
    </ReactFlowProvider>
  );
}

/** A phone's switch between the Steps view and the canvas, top left over both. */
function ViewSwitch({ view, onChange }: { view: 'steps' | 'canvas'; onChange: (view: 'steps' | 'canvas') => void }) {
  return (
    <div role="group" aria-label="View" className="absolute left-3 top-3 z-20 flex rounded-full border border-hair bg-sf p-0.5 shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
      {(
        [
          ['steps', 'Steps'],
          ['canvas', 'Canvas'],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={view === key}
          onClick={() => onChange(key)}
          className={cn('h-11 rounded-full px-4 text-[13px] font-semibold', view === key ? 'bg-acdim text-ac' : 'text-t2')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** n8n's big "Execute workflow" button, bottom centre next to Spotlight, with Debug beside it. */
function ExecuteBar(props: {
  running: boolean;
  breakpoints: number;
  hasChat: boolean;
  chatOpen: boolean;
  onRun: () => void;
  onDebug: () => void;
  onStop: () => void;
  onChat: () => void;
}) {
  const empty = useEditor((s) => s.nodes.length === 0);
  const debugging = useEditor((s) => s.debugging);
  const listening = useTestListener((s) => Boolean(s.listening));
  if (empty) return null;
  const { running, breakpoints, hasChat, chatOpen, onRun, onDebug, onStop, onChat } = props;
  return (
    <div className="pointer-events-auto flex shrink-0 animate-fade-up items-center gap-2 rounded-full border border-hair bg-sf/90 p-1.5 shadow-pop backdrop-blur">
        {listening ? (
          <ListeningBar />
        ) : running ? (
          <Button variant="danger" onClick={onStop} className="min-w-[150px]">
            <Square className="size-3" fill="currentColor" /> {debugging ? 'Stop debugging' : 'Stop'}
          </Button>
        ) : (
          <>
            <Button variant="primary" onClick={onRun} title="Execute workflow (⌘↵)" className="group gap-2 px-5">
              <Play className="size-3.5 transition-transform group-hover:scale-110" fill="currentColor" /> Execute workflow
            </Button>
            <Button
              onClick={onDebug}
              title={
                breakpoints
                  ? `Debug: pause at ${breakpoints} breakpoint${breakpoints === 1 ? '' : 's'} (⇧⌘↵)`
                  : 'Debug: pause before every node (⇧⌘↵). Add breakpoints with F9.'
              }
            >
              <Bug className="size-3.5 text-rd" /> Debug
              {breakpoints > 0 && (
                <span className="grid min-w-4 animate-pop place-items-center rounded-full bg-rd px-1 text-[10px] leading-4 text-bg">{breakpoints}</span>
              )}
            </Button>
          </>
        )}
        {hasChat && (
          <Button variant={chatOpen ? 'outline' : 'ghost'} onClick={onChat}>
            <MessageCircle className="size-3.5 text-viz-7" /> <span className="max-md:sr-only">{chatOpen ? 'Hide chat' : 'Open chat'}</span>
          </Button>
        )}
    </div>
  );
}
