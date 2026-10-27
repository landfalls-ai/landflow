'use client';
/**
 * "Describe your workflow": the local model drafts a flow from the node
 * catalog, the editor lays it out and drops it on the canvas, with test data
 * pinned on the trigger so Execute shows the logic working straight away.
 * Spotlight uses it for the first message on an empty canvas.
 */
import { useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { api } from '@/lib/client/api';
import type { FlowTemplate, TemplateNode } from '@/lib/client/templates';
import type { ConnectionType, NodeItem } from '@/lib/shared/types';
import { useEditor } from './store';

interface FlowDraft {
  name: string;
  nodes: TemplateNode[];
  edges: Array<[string, string, number, ConnectionType]>;
  pinData?: Record<string, NodeItem[]>;
  model: string;
  durationMs: number;
  dropped: string[];
}

/** Columns by longest path from the trigger; sub-nodes under the node they attach to. */
function layout(draft: FlowDraft): TemplateNode[] {
  const main = draft.edges.filter(([, , , type]) => type === 'main');
  const subs = draft.edges.filter(([, , , type]) => type !== 'main');
  const subKeys = new Set(subs.map(([from]) => from));
  const column: Record<string, number> = {};
  const visit = (key: string, depth: number, seen: Set<string>) => {
    if (seen.has(key) || (column[key] ?? -1) >= depth) return;
    column[key] = depth;
    for (const [from, to] of main) if (from === key) visit(to, depth + 1, new Set(seen).add(key));
  };
  for (const n of draft.nodes) if (!subKeys.has(n.key) && !main.some(([, to]) => to === n.key)) visit(n.key, 0, new Set());
  const rows: Record<number, number> = {};
  const placed = draft.nodes.map((n) => {
    if (subKeys.has(n.key)) return n;
    const c = column[n.key] ?? 0;
    const r = (rows[c] = (rows[c] ?? -1) + 1);
    return { ...n, x: c * 280, y: r * 170 };
  });
  // Centre each column vertically.
  for (const n of placed) if (!subKeys.has(n.key)) n.y -= (rows[column[n.key] ?? 0] * 170) / 2;
  for (const n of placed) {
    if (!subKeys.has(n.key)) continue;
    const [, parent] = subs.find(([from]) => from === n.key)!;
    const anchor = placed.find((p) => p.key === parent)!;
    const index = subs.filter(([, to]) => to === parent).findIndex(([from]) => from === n.key);
    n.x = anchor.x + 10 + index * 110;
    n.y = anchor.y + 200;
  }
  return placed;
}

export interface BuiltFlow {
  name: string;
  nodes: number;
  model: string;
  durationMs: number;
  dropped: number;
  /** Test data was pinned on the trigger. */
  pinned: boolean;
}

/** Draft a flow from a description and drop it on the canvas (one undo step). Throws when the model can't. */
export function useBuildFlow() {
  const { fitView } = useReactFlow();
  const [busy, setBusy] = useState(false);
  const build = async (prompt: string): Promise<BuiltFlow> => {
    setBusy(true);
    try {
      const { draft } = await api<{ draft: FlowDraft }>('/api/ai/build', { method: 'POST', json: { prompt } });
      const state = useEditor.getState();
      const right = state.nodes.length ? Math.max(...state.nodes.map((n) => n.position.x)) + 360 : 0;
      const top = state.nodes.length ? Math.min(...state.nodes.map((n) => n.position.y)) : 0;
      const template: FlowTemplate = { id: 'ai', title: draft.name, description: prompt, icon: 'lucide:sparkles', color: 'var(--viz-7)', nodes: layout(draft), edges: draft.edges, pinData: draft.pinData };
      state.applyTemplate(template, { x: right, y: top });
      if (/^untitled/i.test(state.name) || !state.name) state.setMeta({ name: draft.name });
      setTimeout(() => fitView({ padding: 0.25, duration: 600, maxZoom: 1.1 }), 60);
      return { name: draft.name, nodes: draft.nodes.length, model: draft.model, durationMs: draft.durationMs, dropped: draft.dropped.length, pinned: Boolean(draft.pinData && Object.keys(draft.pinData).length) };
    } finally {
      setBusy(false);
    }
  };
  return { build, busy };
}
