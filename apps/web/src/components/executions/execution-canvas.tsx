'use client';
/**
 * The workflow as an execution ran it: read-only, hatched background, nodes
 * coloured by their last run, edges labelled with the items they carried.
 * Node objects stay stable after layout; run state reaches the custom node
 * and edge views through context, so React Flow keeps its measurements.
 */
import { createContext, memo, useContext, useEffect, useMemo } from 'react';
import { Controls, ReactFlow, ReactFlowProvider, getBezierPath, useNodesState, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { cn } from '@/lib/utils';
import { nodeColor } from '@/lib/client/node-style';
import { edgeCountsOf, statusesOf, type NodeStatus } from '@/lib/client/run-data';
import type { NodeRun, NodeTypeInfo, Workflow, WorkflowNode } from '@/lib/shared/types';
import { EdgeLine } from '../canvas/edge-line';
import { handleId, NodeTile } from '../canvas/node-tile';
import { StickyNoteView } from '../canvas/sticky-note';

type ExecNode = Node<{ wf: Omit<WorkflowNode, 'position'> }, 'exec'>;
type ExecEdge = Edge<{ connectionType: string }, 'exec'>;
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
      targetHandle: handleId(c.type, c.type === 'main' ? c.targetIndex : 0),
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

const nodeTypesMap = { exec: ExecNodeView, sticky: ExecStickyView };
const edgeTypesMap = { exec: ExecEdgeView };

export interface ExecutionCanvasProps {
  workflow: Workflow;
  nodeTypes: Record<string, NodeTypeInfo>;
  runData: Record<string, NodeRun[]>;
  /** Nodes started but not finished. */
  activeNodeIds?: string[];
  /** Where the debugger is holding the run. */
  pausedNodeId?: string;
  running?: boolean;
  selectedNodeId?: string;
  onNodeClick?: (nodeId: string) => void;
  className?: string;
}

function Canvas({ workflow, nodeTypes, runData, activeNodeIds = [], pausedNodeId, running = false, selectedNodeId, onNodeClick, className }: ExecutionCanvasProps) {
  const flow = useMemo(() => toReadOnlyFlow(workflow), [workflow]);
  const allNodes = useMemo(() => [...toReadOnlyStickies(workflow), ...flow.nodes], [workflow, flow]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ExecNode | ExecSticky>(allNodes);
  useEffect(() => setNodes(allNodes), [allNodes, setNodes]);

  const state = useMemo<CanvasState>(() => {
    const statuses: Record<string, NodeStatus> = { ...statusesOf(runData) };
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
    };
  }, [flow, workflow, nodeTypes, runData, activeNodeIds, pausedNodeId, running, selectedNodeId]);

  return (
    <CanvasContext.Provider value={state}>
      <div className={cn('canvas-readonly relative size-full', className)}>
        <ReactFlow
          nodes={nodes}
          edges={flow.edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypesMap}
          edgeTypes={edgeTypesMap}
          onNodeClick={(_, node) => node.type !== 'sticky' && onNodeClick?.(node.id)}
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
