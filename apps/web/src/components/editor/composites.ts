'use client';
/**
 * Composites in the editor (docs/composites.md): the live contract checks of the canvas's composite frames, the lookup
 * they read (the store's node types and composite types), and the named outputs a collapsed composite draws. The
 * store does the edits (binding, filling a slot, inserting a type); the frame (./group-node.tsx) shows the result.
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/lib/client/api';
import { compositeLookup, compositeReports, type CompositeLookup, type CompositeReport, type CompositeTypeInfo } from '@/lib/shared/composites';
import { compositePortHandle, type BoxPorts } from '@/lib/shared/groups';
import type { NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { fromFrames } from './groups';
import { parseHandle, useEditor, type FlowEdge, type FlowNode, type GroupFlowNode } from './store';

/** Fetch the composite types the canvas's frames are checked against into the store. */
export function loadComposites() {
  api<{ composites: CompositeTypeInfo[] }>('/api/composites')
    .then(({ composites }) => useEditor.getState().setComposites(composites))
    .catch(() => {});
}

/** The lookup over the editor's node types and composite types. */
export function editorLookup(nodeTypes: Record<string, NodeTypeInfo>, composites: readonly CompositeTypeInfo[]): CompositeLookup {
  return compositeLookup(nodeTypes, composites);
}

/** What the checks read of the canvas: no positions, so a drag doesn't re-run them. */
export function checkedGraph(nodes: readonly FlowNode[], edges: readonly FlowEdge[], groups: readonly GroupFlowNode[]): Pick<Workflow, 'nodes' | 'connections' | 'groups'> {
  return {
    nodes: nodes.map((n) => ({ ...n.data.wf, position: [0, 0] })),
    connections: edges.map((e) => {
      const source = parseHandle(e.sourceHandle);
      const target = parseHandle(e.targetHandle);
      return { id: e.id, type: source.type, source: e.source, sourceIndex: source.index, target: e.target, targetIndex: target.index };
    }),
    groups: fromFrames(groups, nodes),
  };
}

/** The canvas's composite frames checked against their contracts, by group id. Recomputed when the graph changes, not on drags. */
export function useCompositeReports(): Map<string, CompositeReport> {
  const datas = useEditor(useShallow((s) => s.nodes.map((n) => n.data)));
  const edges = useEditor((s) => s.edges);
  const frames = useEditor(useShallow((s) => s.groups.map((g) => g.data)));
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const composites = useEditor((s) => s.composites);
  return useMemo(() => {
    const { nodes, groups } = useEditor.getState();
    if (!groups.some((g) => g.data.composite)) return new Map();
    const reports = compositeReports(checkedGraph(nodes, edges, groups), editorLookup(nodeTypes, composites));
    return new Map(reports.map((r) => [r.groupId, r]));
    // datas and frames stand for the nodes' and groups' content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datas, edges, frames, nodeTypes, composites]);
}

/** The report of one frame (undefined for plain groups). */
export function useCompositeReport(groupId: string): CompositeReport | undefined {
  return useCompositeReports().get(groupId);
}

/** Collapsed composites draw their outputs as named handles: which connection leaves through which. */
export function boxPorts(frames: readonly GroupFlowNode[], reports: ReadonlyMap<string, CompositeReport>): BoxPorts | undefined {
  const out = new Map<string, Map<string, string>>();
  for (const frame of frames) {
    const report = frame.data.collapsed ? reports.get(frame.id) : undefined;
    if (!report?.outputs.length) continue;
    out.set(frame.id, new Map(report.outputs.filter((p) => p.nodeId).map((p) => [`${p.nodeId}:main:${p.index}`, compositePortHandle(p.name)])));
  }
  return out.size ? out : undefined;
}

/** A frame's issue counts, for its header chip. */
export function issueCounts(report: CompositeReport | undefined): { errors: number; warnings: number } {
  const errors = report?.issues.filter((i) => i.severity === 'error').length ?? 0;
  return { errors, warnings: (report?.issues.length ?? 0) - errors };
}
