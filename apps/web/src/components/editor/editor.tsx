'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Background, BackgroundVariant, ControlButton, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type OnConnectEnd, type OnEdgesChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
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
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, streamEvents } from '@/lib/client/api';
import { duration, timeAgo } from '@/lib/client/format';
import { useLiveEvents } from '@/lib/client/live';
import { tint } from '@/lib/client/node-style';
import { TEMPLATES } from '@/lib/client/templates';
import type { DebugCommand, ExecutionEvent, ExecutionRecord, ImportReport, NodeTypeInfo, Workflow } from '@/lib/shared/types';
import type { PolicyWarnings } from '@/lib/shared/governance';
import { Badge, executionTone } from '../ui/badge';
import { Button } from '../ui/button';
import { NodeIcon } from '../ui/icon';
import { Kbd } from '../ui/inputs';
import { WorkflowTabs } from '../shell/workflow-tabs';
import { AiBuilder, AiBuilderPopover } from './ai-builder';
import { prefetchFailure, useAssistant } from './assistant';
import { AssistantPanel } from './assistant-panel';
import { ChatPanel, type ChatApproval, type ChatChunk, type ChatFile, type ChatOutcome } from './chat-panel';
import { parseClipboard, type ClipboardData } from './clipboard';
import { FlowEdgeView } from './flow-edge';
import { FlowNodeView } from './flow-node';
import { CanvasMenu, selectForMenu, useCanvasMenu } from './canvas-menu';
import { GroupNodeView, GroupProxyEdgeView } from './group-node';
import { canvasGraph, type GroupProxyEdge } from './groups';
import { ImportReportDialog, showImportReport } from './import-report';
import { NodeCreator } from './node-creator';
import { NodePanel } from './node-panel';
import { EditorLogs } from './editor-logs';
import { ShortcutsDialog, useShortcuts } from './shortcuts-dialog';
import { StickyNodeView } from './sticky-node';
import { useEditor, type CanvasNode, type FlowEdge, type RunCommand } from './store';
import { TagsEditor } from './tags-editor';
import { VersionHistory, useVersionHistory } from './version-history';
import { WorkflowMenu } from './workflow-menu';
import { PublishControl } from './publish-control';
import { EditLockBanner, editorTabHeaders, useEditLock, useEditLockSync } from './edit-lock';

const nodeTypesMap = { lf: FlowNodeView, sticky: StickyNodeView, frame: GroupNodeView };
const edgeTypesMap = { lf: FlowEdgeView, groupProxy: GroupProxyEdgeView };

type RunResult = { executionId?: string; status: string; lastNodeId?: string; error?: { message: string }; approval?: ChatApproval };

/** The reply text of a finished chat run: the last node's reply / output / text (or its JSON). */
function replyOf(result: RunResult): string | undefined {
  const last = result.lastNodeId ? useEditor.getState().runs[result.lastNodeId]?.at(-1) : undefined;
  const json = last?.outputs[0]?.[0]?.json as Record<string, unknown> | undefined;
  const reply = json?.reply ?? json?.output ?? json?.text;
  return reply === undefined ? (json ? JSON.stringify(json, null, 2) : undefined) : String(reply);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

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

function Canvas({ onSave }: { onSave: () => void }) {
  const flowNodes = useEditor((s) => s.nodes);
  const stickies = useEditor((s) => s.stickies);
  const groups = useEditor((s) => s.groups);
  const flowEdges = useEditor((s) => s.edges);
  const canUndo = useEditor((s) => s.history.past > 0);
  const canRedo = useEditor((s) => s.history.future > 0);
  // Group frames, then notes, then nodes; collapsed groups hide their nodes and take over their connections.
  const { nodes, edges } = useMemo<{ nodes: CanvasNode[]; edges: (FlowEdge | GroupProxyEdge)[] }>(() => canvasGraph(groups, stickies, flowNodes, flowEdges), [groups, stickies, flowNodes, flowEdges]);
  // Read-only (someone else holds the edit lock) swaps the store's editing actions, so re-read them.
  const readOnly = useEditLock((s) => s.readOnly);
  const { onNodesChange, onEdgesChange, onConnect, openNode, openPalette } = useEditor.getState();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const fitted = useRef(false);
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
        useAssistant.getState().setOpen(!useAssistant.getState().open);
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
      onNodeDoubleClick={(_e, node) => node.type === 'lf' && openNode(node.id)}
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
      <Controls position="bottom-left" showInteractive={false} className="!bottom-3 !left-3">
        <ControlButton onClick={() => useEditor.getState().undo()} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">
          <Undo2 />
        </ControlButton>
        <ControlButton onClick={() => useEditor.getState().redo()} disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
          <Redo2 />
        </ControlButton>
      </Controls>
      <MiniMap
        position="bottom-right"
        className="!bottom-3 !right-3"
        pannable
        zoomable
        nodeColor={(node) => (node.type === 'sticky' ? 'var(--acbd)' : node.type === 'frame' ? 'color-mix(in oklab, var(--t3) 14%, transparent)' : 'var(--bd)')}
      />
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

function EmptyCanvas() {
  const empty = useEditor((s) => s.nodes.length === 0 && s.stickies.length === 0 && s.groups.length === 0);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const { fitView } = useReactFlow();
  if (!empty) return null;
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
      <div className="pointer-events-auto w-full max-w-[640px] animate-fade-up px-6" style={{ animationDelay: '80ms' }}>
        <AiBuilder />
      </div>
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

/** n8n's floating canvas buttons, top right: add a node, tidy up, fit view. */
function CanvasToolbar() {
  const { fitView } = useReactFlow();
  const hasNodes = useEditor((s) => s.nodes.length > 0);
  const creatorOpen = useEditor((s) => Boolean(s.palette));
  const [aiOpen, setAiOpen] = useState(false);
  const { screenToFlowPosition } = useReactFlow();
  const addNote = () => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    const center = pane ? screenToFlowPosition({ x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }) : { x: 0, y: 0 };
    useEditor.getState().addSticky({ x: center.x - 130, y: center.y - 90 });
  };
  if (creatorOpen) return null;
  const button = 'grid size-9 place-items-center text-t2 transition-colors hover:bg-acdim hover:text-t1';
  return (
    <>
      <AiBuilderPopover open={aiOpen && hasNodes} onClose={() => setAiOpen(false)} />
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
              title="Build with AI: describe steps to add"
              aria-label="Build with AI"
              onClick={() => setAiOpen((o) => !o)}
              className={cn(button, 'border-t border-hair', aiOpen && 'bg-acdim')}
            >
              <Sparkles className="size-4 text-viz-7" />
            </button>
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
  const [chatOpen, setChatOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const name = useEditor((s) => s.name);
  const dirty = useEditor((s) => s.dirty);
  const running = useEditor((s) => s.running);
  const debugging = useEditor((s) => s.debugging);
  const breakpoints = useEditor((s) => s.breakpoints);
  const hasChatTrigger = useEditor((s) => s.nodes.some((n) => n.data.wf.type === 'core.chatTrigger'));
  const assistantOpen = useAssistant((s) => s.open);
  const readOnly = useEditLock((s) => s.readOnly);
  const { takeOver } = useEditLockSync(workflowId, loaded);

  // The assistant's conversation lasts while this workflow is open.
  useEffect(() => useAssistant.getState().bind(workflowId), [workflowId]);

  useEffect(() => {
    let cancelled = false;
    const requested = new URLSearchParams(window.location.search).get('execution');
    Promise.all([api<{ workflow: Workflow }>(`/api/workflows/${workflowId}`), api<{ nodeTypes: NodeTypeInfo[] }>('/api/node-types')])
      .then(([{ workflow }, { nodeTypes }]) => {
        if (cancelled) return;
        useEditor.getState().load(workflow, nodeTypes);
        setLoaded(true);
        setChatOpen(workflow.nodes.some((n) => n.type === 'core.chatTrigger') && !requested);
        // Show an execution from history if one was asked for, else the last run, so the canvas isn't blank.
        const record = requested
          ? api<{ execution: ExecutionRecord }>(`/api/executions/${requested}`)
          : api<{ executions: { id: string }[] }>(`/api/executions?workflowId=${workflowId}&limit=1`).then(
              ({ executions }) => executions[0] && api<{ execution: ExecutionRecord }>(`/api/executions/${executions[0].id}`),
            );
        record
          .then((r) => r && !useEditor.getState().running && useEditor.getState().loadExecution(r.execution, Boolean(requested)))
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
    api<{ nodeTypes: NodeTypeInfo[] }>('/api/node-types')
      .then(({ nodeTypes }) => useEditor.getState().setNodeTypes(nodeTypes))
      .catch(() => {});
    if (event.event.type === 'plugin.registered') toast(event.event.message);
    if (event.event.type === 'plugin.offline') toast.warning(event.event.message);
  });

  // Breakpoints edited mid-debug apply to the running execution straight away.
  useEffect(() => {
    const { executionId } = useEditor.getState();
    if (!running || !debugging || !executionId) return;
    api(`/api/executions/${executionId}/debug`, { method: 'POST', json: { breakpoints } }).catch(() => {});
  }, [breakpoints, running, debugging]);

  const save = useCallback(async (): Promise<boolean> => {
    if (useEditLock.getState().readOnly) {
      const environment = useEditLock.getState().protectedEnvironment;
      toast.error(environment ? `${environment} is a protected environment: workflows change only by pull or promotion` : 'Someone else is editing this workflow: it’s read-only here');
      return false;
    }
    setSaving(true);
    try {
      // `active` stays out: a save is a draft, and Publish / Unpublish (PublishControl) change what is live.
      const { active: _active, ...draft } = useEditor.getState().toWorkflow();
      const { workflow, policyWarnings } = await api<{ workflow: Workflow } & PolicyWarnings>(`/api/workflows/${workflowId}`, { method: 'PUT', json: draft, headers: editorTabHeaders() });
      useEditor.getState().markSaved();
      toast.success(`Saved “${workflow.name}”`);
      // Nodes the governance policy doesn't allow: the save stands, publishing is refused and they fail when run.
      if (policyWarnings?.length) toast.warning(`${policyWarnings.length === 1 ? '1 node is' : `${policyWarnings.length} nodes are`} blocked by policy`, { description: policyWarnings.map((w) => `${w.nodeName}: ${w.message}`).join('\n') });
      return true;
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [workflowId]);

  const execute = useCallback(
    async (extra: Record<string, unknown> = {}, debug = false, onChunk?: (chunk: ChatChunk) => void): Promise<RunResult | undefined> => {
      const state = useEditor.getState();
      if (state.running) return undefined;
      state.startRun(debug);
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
            if (event === 'started') useEditor.setState({ executionId: (data as { executionId: string }).executionId });
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
      return result;
    },
    [workflowId],
  );

  const report = useCallback((result: RunResult | undefined, started: number, label: string) => {
    if (!result) return;
    if (result.status === 'error') prefetchFailure();
    if (result.status === 'success') toast.success(`${label} succeeded in ${duration(Date.now() - started)}`);
    else if (result.status === 'canceled') toast(`${label} stopped`);
    else toast.error(`${label} failed${result.error?.message ? `: ${result.error.message}` : ''}`);
  }, []);

  const runCommand = useCallback(
    async (command: RunCommand) => {
      const started = Date.now();
      if (command.kind === 'run') return report(await execute(), started, 'Workflow');
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

  const stop = () => {
    const { debugging: inDebug, executionId } = useEditor.getState();
    if (inDebug && executionId) void sendDebug(executionId, 'stop');
    else abortRef.current?.abort();
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
      <div className="grid h-screen place-items-center">
        <Loader2 className="size-5 animate-spin text-t3" />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="flex h-screen flex-col">
        <header className="relative flex h-[52px] shrink-0 items-center gap-3 border-b border-hair bg-bg px-4">
          <Link href="/workflows" aria-label="Back to workflows" className="grid size-8 place-items-center rounded-full text-t2 hover:bg-acdim hover:text-t1">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex min-w-0 max-w-[calc(50%-150px)] items-center gap-3">
            <input
              value={name}
              onChange={(e) => useEditor.getState().setMeta({ name: e.target.value })}
              aria-label="Workflow name"
              size={Math.max(12, Math.min(name.length + 1, 40))}
              className="min-w-0 max-w-[300px] shrink bg-transparent text-[15px] font-semibold text-t1 outline-none"
            />
            <TagsEditor />
            <span className={cn('flex shrink-0 items-center gap-1.5 text-[12px]', dirty ? 'text-warn' : 'text-t3')}>
              <span className={cn('size-1.5 rounded-full transition-colors', dirty ? 'bg-warn' : 'bg-gn')} />
              {dirty ? 'Unsaved' : 'Saved'}
            </span>
          </div>

          <WorkflowTabs
            workflowId={workflowId}
            active="editor"
            beforeLeave={async () => useEditor.getState().dirty && (await save())}
            className="absolute left-1/2 -translate-x-1/2"
          />

          <div className="ml-auto flex items-center gap-2">
            <PublishControl workflowId={workflowId} onSave={save} />
            <Button
              variant={assistantOpen ? 'outline' : 'ghost'}
              onClick={() => useAssistant.getState().setOpen(!assistantOpen)}
              title="Assistant: build and fix this workflow with AI (⌘I)"
              aria-pressed={assistantOpen}
            >
              <Sparkles className="size-3.5 text-viz-7" /> Assistant
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => useVersionHistory.getState().setOpen(true)}
              title="Version history: every save is a version"
              aria-label="Version history"
            >
              <History className="size-4" />
            </Button>
            <Button onClick={() => void save()} loading={saving} disabled={readOnly} title="Save (⌘S)" variant={dirty ? 'primary' : 'outline'}>
              Save
            </Button>
            <WorkflowMenu onSave={save} />
          </div>
          {running && <span className="lf-shimmer absolute inset-x-0 bottom-[-1px] h-[2px]" />}
        </header>

        <EditLockBanner onTakeOver={() => void takeOver()} />
        <StatusStrip />

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <Canvas onSave={() => void save()} />
              <EmptyCanvas />
              <CanvasToolbar />
              <ExecuteBar
                running={running}
                breakpoints={breakpoints.length}
                hasChat={hasChatTrigger}
                chatOpen={chatOpen}
                onRun={() => void runCommand({ kind: 'run' })}
                onDebug={() => void runCommand({ kind: 'debug' })}
                onStop={stop}
                onChat={() => setChatOpen((o) => !o)}
              />
            </div>
            <EditorLogs />
          </div>
          <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} onSend={sendChat} onDecide={decideChat} />
          <AssistantPanel />
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

/** n8n's big "Execute workflow" button, bottom centre, with Debug beside it. */
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
  if (empty) return null;
  const { running, breakpoints, hasChat, chatOpen, onRun, onDebug, onStop, onChat } = props;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center">
      <div className="pointer-events-auto flex animate-fade-up items-center gap-2 rounded-full border border-hair bg-sf/90 p-1.5 shadow-pop backdrop-blur">
        {running ? (
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
            <MessageCircle className="size-3.5 text-viz-7" /> {chatOpen ? 'Hide chat' : 'Open chat'}
          </Button>
        )}
      </div>
    </div>
  );
}
