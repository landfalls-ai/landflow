'use client';
/**
 * The workflow as an execution ran it: read-only, hatched background, nodes
 * coloured by their last run, edges labelled with the items they carried.
 * Node objects stay stable after layout; run state reaches the custom node
 * and edge views through context, so React Flow keeps its measurements.
 *
 * Canvas groups show as saved: a collapsed group is one box standing for the
 * nodes (and nested groups) inside it, outlined by how they ran (red when one
 * failed, blue while one waits), with their connections drawn to its edges.
 * Its chevron (or a double-click) expands it here only; the workflow keeps
 * its groups as they are. The node an execution waits at is marked waiting,
 * with what it waits for on hover.
 */
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Controls, Handle, Position, ReactFlow, ReactFlowProvider, getBezierPath, useNodesState, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { nodeColor } from '@/lib/client/node-style';
import { edgeCountsOf, statusesOf, summarizeGroupRun, withWaiting, type GroupRunSummary, type NodeStatus, type WaitInfo } from '@/lib/client/run-data';
import { GROUP_COLLAPSED_SIZE, GROUP_HANDLES, collapsedBoxes, depthOf, descendantGroupIds, descendantNodeIds, routeEdges } from '@/lib/shared/groups';
import type { NodeRun, NodeTypeInfo, Workflow, WorkflowNode } from '@/lib/shared/types';
import { EdgeLine } from '../canvas/edge-line';
import { handleId, NodeTile } from '../canvas/node-tile';
import { StickyNoteView } from '../canvas/sticky-note';
import { CompositeBadge, GroupBoxView, GroupFrameView } from '../canvas/group-frame';
import { useCompositeNames } from '../canvas/composite-names';

type ExecNode = Node<{ wf: Omit<WorkflowNode, 'position'> }, 'exec'>;
type ExecEdge = Edge<{ connectionType: string }, 'exec'>;
/** A line to or from a collapsed group's box, standing for the connections in `edgeIds`. */
type ExecProxyEdge = Edge<{ connectionType: string; edgeIds: string[] }, 'execProxy'>;
/** A sticky note, drawn under the nodes. */
type ExecSticky = Node<{ content: string; color: number }, 'sticky'>;

/** The workflow's sticky notes as read-only React Flow nodes. */
export function toReadOnlyStickies(workflow: Workflow): ExecSticky[] {
  return (workflow.stickyNotes ?? []).map((note) => ({
    id: note.id,
    type: 'sticky',
    position: { x: note.position[0], y: note.position[1] },
    width: note.width,
    height: note.height,
    zIndex: -1000,
    selectable: false,
    data: { content: note.content, color: note.color ?? 0 },
  }));
}

const ExecStickyView = memo(function ExecStickyView({ data }: NodeProps<ExecSticky>) {
  return <StickyNoteView content={data.content} color={data.color} className="cursor-default" />;
});

/** A canvas group under the notes: a frame, or (collapsed) a box in place of everything inside it. */
type ExecFrame = Node<{ name: string; color: number; collapsed: boolean; nodeIds: string[]; groups: number; composite?: { type: string; version: number } }, 'frame'>;

/**
 * The workflow's canvas groups as read-only React Flow nodes, nested ones above their parents. `collapsed` says which
 * are drawn collapsed (the saved state, unless expanded in the preview); groups inside a collapsed one are hidden.
 */
export function toReadOnlyGroups(workflow: Workflow, collapsed: (id: string, saved: boolean) => boolean = (_id, saved) => saved): ExecFrame[] {
  const groups = workflow.groups ?? [];
  const { hidden } = collapsedBoxes(groups, (g) => collapsed(g.id, Boolean(g.collapsed)));
  return groups.map((group) => {
    const closed = collapsed(group.id, Boolean(group.collapsed));
    const nodeIds = descendantNodeIds(groups, group.id);
    return {
      id: group.id,
      type: 'frame',
      position: { x: group.position[0], y: group.position[1] },
      width: closed ? GROUP_COLLAPSED_SIZE.width : group.width,
      height: closed ? GROUP_COLLAPSED_SIZE.height : group.height,
      zIndex: -2000 + depthOf(groups, group.id),
      selectable: false,
      // The body lets the pointer through to the canvas; the header and the box take it.
      style: { pointerEvents: 'none' },
      ...(hidden.has(group.id) && { hidden: true }),
      ariaLabel: `Group ${group.name}${closed ? ', collapsed' : ''}`,
      data: { name: group.name, color: group.color ?? 0, collapsed: closed, nodeIds, groups: descendantGroupIds(groups, group.id).length, ...(group.composite && { composite: { type: group.composite.type, version: group.composite.version } }) },
    };
  });
}

const hiddenHandle = '!size-2 !min-h-0 !min-w-0 !border-0 !bg-transparent opacity-0';
const toggleButton = 'nodrag grid size-5 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1';

const ExecFrameView = memo(function ExecFrameView({ id, data }: NodeProps<ExecFrame>) {
  const ctx = useContext(CanvasContext)!;
  const toggle = () => ctx.toggleGroup(id, !data.collapsed);
  const names = useCompositeNames(Boolean(data.composite));
  const composite = data.composite && names[data.composite.type];
  if (!data.collapsed)
    return (
      <GroupFrameView
        name={data.name}
        color={data.color}
        count={data.nodeIds.length}
        badge={data.composite && <CompositeBadge icon={composite?.icon} label={`${composite?.displayName ?? data.composite.type} v${data.composite.version}`} title="A composite: checked against its type’s contract (docs/composites.md)" />}
        headerClassName="cursor-default"
        actions={
          <button title="Collapse (here only)" aria-label={`Collapse group ${data.name}`} onClick={toggle} className={cn(toggleButton, 'size-6')}>
            <ChevronsDownUp className="size-3.5" />
          </button>
        }
      />
    );
  const summary = ctx.groupRuns[id];
  const dimmed = ctx.dimIdle && summary?.state === 'idle';
  const icons = data.nodeIds.map((nodeId) => {
    const info = ctx.nodeTypes[ctx.typeOf[nodeId] ?? ''];
    return { icon: info?.descriptor.icon, color: nodeColor(info) };
  });
  const nested = data.groups ? `, ${data.groups} group${data.groups === 1 ? '' : 's'}` : '';
  return (
    <div className={cn('size-full transition-[opacity,filter] duration-300', dimmed && 'opacity-40 grayscale')}>
      <GroupBoxView
        name={data.name}
        color={data.color}
        count={data.nodeIds.length}
        icons={icons}
        selected={Boolean(ctx.selectedNodeId && data.nodeIds.includes(ctx.selectedNodeId))}
        status={
          summary && {
            tone: summary.state,
            label: summary.label,
            title: `${data.name}: ${data.nodeIds.length} node${data.nodeIds.length === 1 ? '' : 's'}${nested} · ${summary.ran} ran${summary.failed ? `, ${summary.failed} failed` : ''}${
              summary.state === 'waiting' ? ` · ${summary.label}` : ''
            } · double-click to expand (here only)`,
          }
        }
        // `nopan`: a double-click expands the box instead of zooming the canvas.
        className="nopan cursor-default"
        onDoubleClick={toggle}
        actions={
          <button title="Expand (here only: the workflow keeps it collapsed)" aria-label={`Expand group ${data.name}`} onClick={toggle} className={toggleButton}>
            <ChevronsUpDown className="size-3.5" />
          </button>
        }
      >
        <Handle type="target" position={Position.Left} id={GROUP_HANDLES.in} isConnectable={false} className={hiddenHandle} />
        <Handle type="source" position={Position.Right} id={GROUP_HANDLES.out} isConnectable={false} className={hiddenHandle} />
        <Handle type="source" position={Position.Top} id={GROUP_HANDLES.aiOut} isConnectable={false} className={hiddenHandle} />
        <Handle type="target" position={Position.Bottom} id={GROUP_HANDLES.aiIn} isConnectable={false} className={hiddenHandle} />
      </GroupBoxView>
    </div>
  );
});

/** Workflow → React Flow elements, with the editor's handle ids ("<type>:<index>"). */
export function toReadOnlyFlow(workflow: Workflow): { nodes: ExecNode[]; edges: ExecEdge[] } {
  return {
    nodes: workflow.nodes.map(({ position, ...wf }) => ({ id: wf.id, type: 'exec', position: { x: position[0], y: position[1] }, data: { wf } })),
    edges: workflow.connections.map((c) => ({
      id: c.id,
      type: 'exec',
      source: c.source,
      target: c.target,
      sourceHandle: handleId(c.type, c.type === 'main' ? c.sourceIndex : 0),
      targetHandle: handleId(c.type, c.targetIndex ?? 0),
      data: { connectionType: c.type },
    })),
  };
}

interface CanvasState {
  nodeTypes: Record<string, NodeTypeInfo>;
  statuses: Record<string, NodeStatus>;
  edgeCounts: Record<string, number>;
  typeOf: Record<string, string>;
  toolSources: Set<string>;
  outputsOf: Record<string, string[]>;
  subsOf: Record<string, string[]>;
  active: Set<string>;
  running: boolean;
  dimIdle: boolean;
  selectedNodeId?: string;
  /** How the nodes inside each group ran (nested groups' included). */
  groupRuns: Record<string, GroupRunSummary>;
  /** Collapse or expand a group in this view only. */
  toggleGroup(id: string, collapsed: boolean): void;
}

const CanvasContext = createContext<CanvasState | null>(null);

const ExecNodeView = memo(function ExecNodeView({ id, data }: NodeProps<ExecNode>) {
  const ctx = useContext(CanvasContext)!;
  const { wf } = data;
  const status = ctx.statuses[id];
  const dimmed = ctx.dimIdle && !status;
  return (
    <div className={cn('cursor-pointer transition-[opacity,filter] duration-300', dimmed && 'opacity-40 grayscale')} title={dimmed ? 'Did not run in this execution' : undefined}>
      <NodeTile
        name={wf.name}
        info={ctx.nodeTypes[wf.type]}
        parameters={wf.parameters}
        status={status}
        disabled={wf.disabled}
        selected={ctx.selectedNodeId === id}
        asTool={ctx.toolSources.has(id)}
        connectedOutputs={ctx.outputsOf[id]}
        subConnections={ctx.subsOf[id]}
        readOnly
      />
    </div>
  );
});

const ExecEdgeView = memo(function ExecEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<ExecEdge>) {
  const ctx = useContext(CanvasContext)!;
  const isAi = data?.connectionType !== 'main';
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: isAi ? 0.35 : 0.3 });
  // Items are on the move into a node that is running now (or out of a sub-node being called).
  const flowing = ctx.running && (isAi ? ctx.active.has(source) : ctx.active.has(target) && Boolean(ctx.statuses[source]));
  return (
    <EdgeLine
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      isAi={isAi}
      count={ctx.edgeCounts[id]}
      flowing={flowing}
      color={nodeColor(ctx.nodeTypes[ctx.typeOf[source] ?? ''])}
      roomy={Math.hypot(targetX - sourceX, targetY - sourceY) > 120}
    />
  );
});

/** A line to or from a collapsed box: the items its connections carried, or how many connections it stands for. */
const ExecProxyEdgeView = memo(function ExecProxyEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<ExecProxyEdge>) {
  const ctx = useContext(CanvasContext)!;
  const isAi = data?.connectionType !== 'main';
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: isAi ? 0.35 : 0.3 });
  const edgeIds = data?.edgeIds ?? [];
  const count = edgeIds.reduce((sum, edgeId) => sum + (ctx.edgeCounts[edgeId] ?? 0), 0);
  return (
    <EdgeLine
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      isAi={isAi}
      count={count || undefined}
      roomy={Math.hypot(targetX - sourceX, targetY - sourceY) > 120}
      overlay={
        !count && edgeIds.length > 1 ? (
          <div className="pointer-events-none rounded-full border border-hair bg-sf px-2 font-mono text-[10px] leading-[18px] text-t2">{edgeIds.length} connections</div>
        ) : undefined
      }
    />
  );
});

const nodeTypesMap = { exec: ExecNodeView, sticky: ExecStickyView, frame: ExecFrameView };
const edgeTypesMap = { exec: ExecEdgeView, execProxy: ExecProxyEdgeView };

export interface ExecutionCanvasProps {
  workflow: Workflow;
  nodeTypes: Record<string, NodeTypeInfo>;
  runData: Record<string, NodeRun[]>;
  /** Nodes started but not finished. */
  activeNodeIds?: string[];
  /** Where the debugger is holding the run. */
  pausedNodeId?: string;
  /** A waiting execution: what it waits for (its node is marked waiting, with the reason on hover). */
  wait?: WaitInfo;
  running?: boolean;
  selectedNodeId?: string;
  onNodeClick?: (nodeId: string) => void;
  className?: string;
}

function Canvas({ workflow, nodeTypes, runData, activeNodeIds = [], pausedNodeId, wait, running = false, selectedNodeId, onNodeClick, className }: ExecutionCanvasProps) {
  // Groups expanded or collapsed in this view (by id); the rest show as saved. Reset for another workflow.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => setOverrides({}), [workflow.id]);
  const toggleGroup = useCallback((id: string, collapsed: boolean) => setOverrides((o) => ({ ...o, [id]: collapsed })), []);
  const collapsedOf = useCallback((id: string, saved: boolean) => overrides[id] ?? saved, [overrides]);

  const flow = useMemo(() => toReadOnlyFlow(workflow), [workflow]);
  const groups = useMemo(() => workflow.groups ?? [], [workflow]);
  const boxes = useMemo(() => collapsedBoxes(groups, (g) => collapsedOf(g.id, Boolean(g.collapsed))).boxOf, [groups, collapsedOf]);
  const routed = useMemo(() => routeEdges(flow.edges, boxes), [flow, boxes]);
  const edges = useMemo<(ExecEdge | ExecProxyEdge)[]>(
    () => [
      ...routed.edges,
      ...routed.routes.map<ExecProxyEdge>((route) => ({
        id: route.id,
        type: 'execProxy',
        source: route.source,
        target: route.target,
        sourceHandle: route.sourceHandle,
        targetHandle: route.targetHandle,
        data: { connectionType: route.connectionType, edgeIds: route.edgeIds },
      })),
    ],
    [routed],
  );
  const allNodes = useMemo(
    () => [...toReadOnlyGroups(workflow, collapsedOf), ...toReadOnlyStickies(workflow), ...flow.nodes.map((n) => (boxes.has(n.id) ? { ...n, hidden: true } : n))],
    [workflow, flow, collapsedOf, boxes],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<ExecNode | ExecSticky | ExecFrame>(allNodes);
  useEffect(() => setNodes(allNodes), [allNodes, setNodes]);

  const state = useMemo<CanvasState>(() => {
    const statuses: Record<string, NodeStatus> = wait ? withWaiting(statusesOf(runData), { status: 'waiting', wait }) : { ...statusesOf(runData) };
    for (const id of activeNodeIds) statuses[id] = { ...statuses[id], state: 'running' };
    if (pausedNodeId) statuses[pausedNodeId] = { ...statuses[pausedNodeId], state: 'paused' };
    const outputsOf: Record<string, string[]> = {};
    const subsOf: Record<string, string[]> = {};
    const toolSources = new Set<string>();
    for (const edge of flow.edges) {
      if (edge.data?.connectionType === 'main') (outputsOf[edge.source] ??= []).push(edge.sourceHandle ?? 'main:0');
      else (subsOf[edge.target] ??= []).push(edge.targetHandle ?? '');
      if (edge.data?.connectionType === 'ai_tool') toolSources.add(edge.source);
    }
    return {
      nodeTypes,
      statuses,
      edgeCounts: edgeCountsOf(flow.edges, runData),
      typeOf: Object.fromEntries(workflow.nodes.map((n) => [n.id, n.type])),
      toolSources,
      outputsOf,
      subsOf,
      active: new Set(activeNodeIds),
      running,
      dimIdle: !running && Object.keys(runData).length > 0,
      selectedNodeId,
      groupRuns: Object.fromEntries(groups.map((g) => [g.id, summarizeGroupRun(descendantNodeIds(groups, g.id), statuses)])),
      toggleGroup,
    };
  }, [flow, workflow, groups, nodeTypes, runData, activeNodeIds, pausedNodeId, wait, running, selectedNodeId, toggleGroup]);

  return (
    <CanvasContext.Provider value={state}>
      <div className={cn('canvas-readonly relative size-full', className)}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypesMap}
          edgeTypes={edgeTypesMap}
          onNodeClick={(_, node) => node.type === 'exec' && onNodeClick?.(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          fitView
          fitViewOptions={{ padding: 0.22, maxZoom: 1.05 }}
          minZoom={0.2}
          maxZoom={2}
        >
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>
    </CanvasContext.Provider>
  );
}

export function ExecutionCanvas(props: ExecutionCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
