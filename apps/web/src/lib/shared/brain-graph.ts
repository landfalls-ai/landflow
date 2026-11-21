/**
 * The memory graph (docs/second-brain.md#the-graph): what GET /api/brain/graph answers and the Graph tab draws.
 * Subjects (a workflow, an agent, an entity, a project) and facts are nodes; an `about` edge joins a fact to its subject
 * and, with history on, a version edge (`updates`, `extends`, `derives`) joins a version to its parent. Pure types and
 * labels, no zod and no runtime imports, so a client module can hold them under the CSP rule.
 */
import type { FactKind, FactRelation, FactSubject } from './brain';

export interface GraphSubjectNode {
  /** `s:<type>:<id>`. */
  id: string;
  kind: 'subject';
  subjectType: FactSubject | 'project';
  /** The subject's id (an entity's is `<type>/<id>`). */
  subjectId: string;
  label: string;
  /** The Brain page that opens for this subject, when it has one (`customer/acme`). */
  page?: string;
}

export interface GraphFactNode {
  /** `f:<fact id>`. */
  id: string;
  kind: 'fact';
  factId: string;
  /** The chain's root (the fact's own id for a fact that never changed). */
  chainId: string;
  /** Plain text: the client renders it as text, never as HTML. */
  statement: string;
  factKind: FactKind;
  version: number;
  latest: boolean;
  relation?: FactRelation;
  /** The previous version (or the fact an extends/derives chain follows), so a client can join versions across pages. */
  parentId?: string;
  confidence: number;
  firstSeen: string;
  lastSeen: string;
  status: 'active' | 'stale';
  forgotten?: boolean;
}

export type GraphNode = GraphSubjectNode | GraphFactNode;
export type GraphEdgeType = 'about' | FactRelation;

export interface GraphEdge {
  from: string;
  to: string;
  type: GraphEdgeType;
}

export interface GraphPage {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nextCursor?: string;
}

export interface GraphQuery {
  /** A subject key (`workflow/<id>`, `agent/<id>`, `entity/<type>/<id>`, `project/<id>`); none: the whole visible brain. */
  about?: string;
  depth: 1 | 2;
  history: boolean;
  forgotten: boolean;
  cursor?: string;
  limit: number;
}

export const GRAPH_PAGE_LIMIT = 500;

export const GRAPH_EDGE_LABELS: Record<GraphEdgeType, string> = {
  about: 'About',
  updates: 'Updates',
  extends: 'Extends',
  derives: 'Derives',
};

export const subjectNodeId = (type: string, id: string) => `s:${type}:${id}`;
export const factNodeId = (factId: string) => `f:${factId}`;
