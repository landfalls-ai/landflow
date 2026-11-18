/**
 * AG21 × AG17: the graph an agent update tests (agents/updates.ts) and publishes (publish.ts `publishUpdate`), apart from both so
 * neither imports the other. It reads AG17's `agent_flow_moves` rows (agents/flow-moves.ts writes them) and imports none of
 * flow-moves' own imports (teams, projects, the registry): this module stays a leaf.
 */
import type { Workflow } from '@landflow/engine';
import type { AgentPin } from '../../shared/agent-versions';
import type { AgentConfig, AgentModel } from '../../shared/agents';
import { database, type Database } from '../db';
import { agentStore } from './store';
import { agentVersionConfig } from './versions';

/** One pin the update moves: the node, its agent, the version production pins now and the one the update pins. */
export interface PinMove {
  nodeId: string;
  agentId: string;
  from: number;
  to: number;
}

interface MoveRow {
  sub_node_id: string;
  slot: string;
  moved_as: string | null;
  agent_tool_id: string | null;
  snapshot: string;
  at: string;
}

const EDGE_OF_SLOT: Record<string, string> = { model: 'ai_languageModel', tool: 'ai_tool', memory: 'ai_memory' };
// The rules flow-moves.ts applies: a Run an Agent node's plain agent id, and a model by provider, model, base URL and credential.
const plainAgentOf = (node: Workflow['nodes'][number]): string | undefined => {
  const id = node.type === 'core.messageAgent' ? node.parameters?.agentId : undefined;
  return typeof id === 'string' && id.trim() !== '' && !id.trim().startsWith('=') && !id.includes('{{') ? id.trim() : undefined;
};
const sameModel = (a?: AgentModel, b?: AgentModel): boolean => Boolean(a && b) && a!.provider === b!.provider && a!.model === b!.model && (a!.baseUrl ?? '') === (b!.baseUrl ?? '') && (a!.credential?.id ?? '') === (b!.credential?.id ?? '');

/**
 * The production graph an update publishes (and tests): without the wired sub-nodes AG17 moved into (or found already in) the
 * agent whose pin moves, when the version the update pins owns them. A production version published before the move still wires
 * them; pinned to a version that holds the moved tool, the run would offer it twice (`slugify` and `slugify_2`), and a wired chat
 * model would win over the version's own. Owned: every item when the new version was published at or after the move (it was made
 * from the draft the move wrote, with whatever a person changed since, the model included); else a tool or knowledge base the new
 * version holds (by its agent tool id), or the moved model when the new version runs it. Anything else stays wired, so nothing the
 * flow ran is dropped. Sub-nodes left with no outgoing edge leave with their edges.
 */
export function withoutPublishedMoves(
  workflowId: string,
  graph: Workflow,
  moves: readonly PinMove[],
  versionOf: (agentId: string, version: number) => { config: AgentConfig; publishedAt?: string } | undefined = publishedVersion,
  db: Database = database(),
): Workflow {
  const dropEdges = new Set<string>();
  const candidates = new Set<string>();
  for (const move of moves) {
    if (move.from === move.to) continue;
    const node = graph.nodes.find((n) => n.id === move.nodeId);
    if (!node || plainAgentOf(node) !== move.agentId) continue;
    const target = versionOf(move.agentId, move.to);
    if (!target) continue;
    const rows = db.all<MoveRow>(`SELECT sub_node_id, slot, moved_as, agent_tool_id, snapshot, at FROM agent_flow_moves WHERE workflow_id = ? AND node_id = ? AND agent_id = ? AND outcome IN ('moved', 'same')`, workflowId, move.nodeId, move.agentId);
    for (const row of rows) {
      const snapshot = JSON.parse(row.snapshot) as { nodes: Array<{ id: string }>; connections: Array<{ id: string; target: string }>; moved?: { model?: AgentModel } };
      const after = target.publishedAt !== undefined && target.publishedAt >= row.at;
      const holds = row.moved_as === 'model'
        ? sameModel(target.config.model, snapshot.moved?.model)
        : Boolean(row.agent_tool_id) && target.config.tools.some((t) => t.id === row.agent_tool_id);
      if (!after && !holds) continue;
      const subId = row.sub_node_id.split('@')[0]!;
      for (const c of graph.connections) if (c.source === subId && c.target === node.id && c.type === EDGE_OF_SLOT[row.slot]) dropEdges.add(c.id);
      // The edges that left with it (a vector store's own embeddings), never another edge into the bound node.
      for (const c of snapshot.connections) if (c.target !== node.id) dropEdges.add(c.id);
      candidates.add(subId);
      for (const n of snapshot.nodes) candidates.add(n.id);
    }
  }
  if (!dropEdges.size) return graph;
  const kept = graph.connections.filter((c) => !dropEdges.has(c.id));
  const gone = new Set(graph.nodes.filter((n) => candidates.has(n.id) && !kept.some((c) => c.source === n.id)).map((n) => n.id));
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !gone.has(n.id)),
    connections: kept.filter((c) => !gone.has(c.source) && !gone.has(c.target)),
    ...(graph.pinData && { pinData: Object.fromEntries(Object.entries(graph.pinData).filter(([id]) => !gone.has(id))) }),
  };
}

/**
 * The graph an update tests and publishes: the production version's, without the wiring AG17 moved into an agent whose pin moves
 * to a version that owns it (`withoutPublishedMoves`).
 */
export function updateGraph(workflowId: string, graph: Workflow, current: readonly AgentPin[], wanted: readonly AgentPin[]): Workflow {
  const from = new Map(current.map((p) => [`${p.nodeId}:${p.agentId}`, p.version]));
  const moves = wanted.flatMap((p) => {
    const was = from.get(`${p.nodeId}:${p.agentId}`);
    return was === undefined || was === p.version ? [] : [{ nodeId: p.nodeId, agentId: p.agentId, from: was, to: p.version }];
  });
  return moves.length ? withoutPublishedMoves(workflowId, graph, moves) : graph;
}

/** One published version of an agent: its config and when it was published. */
function publishedVersion(agentId: string, version: number): { config: AgentConfig; publishedAt?: string } | undefined {
  const config = agentVersionConfig(agentId, version);
  if (!config) return undefined;
  const agent = agentStore.get(agentId);
  const publishedAt = [agent?.published, ...(agent?.history ?? [])].find((v) => v?.version === version)?.publishedAt
    ?? database().get<{ published_at: string }>('SELECT published_at FROM agent_versions WHERE agent_id = ? AND version = ?', agentId, version)?.published_at;
  return { config, ...(publishedAt && { publishedAt }) };
}
