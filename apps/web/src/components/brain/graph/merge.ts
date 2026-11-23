/**
 * Joining graph pages: a second page (Load more, a toggle) adds its nodes and edges to what is drawn. Nodes repeat when a
 * subject has facts on both pages, so they merge by id; a version whose parent came on another page gets its edge here,
 * since the server only draws an edge when both ends are on its page.
 */
import { factNodeId, type GraphEdge, type GraphNode, type GraphPage } from '@/lib/shared/brain-graph';

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const edgeKey = (e: GraphEdge) => `${e.from}>${e.to}>${e.type}`;

export function mergePage(current: GraphData, page: GraphPage, history: boolean): GraphData {
  const nodes = new Map(current.nodes.map((n) => [n.id, n]));
  for (const n of page.nodes) nodes.set(n.id, n);
  const edges = new Map(current.edges.map((e) => [edgeKey(e), e]));
  for (const e of page.edges) edges.set(edgeKey(e), e);
  for (const n of history ? nodes.values() : []) {
    if (n.kind !== 'fact' || !n.parentId) continue;
    const from = factNodeId(n.parentId);
    // Version edges exist only with history on.
    if (nodes.has(from)) edges.set(edgeKey({ from, to: n.id, type: n.relation ?? 'updates' }), { from, to: n.id, type: n.relation ?? 'updates' });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
