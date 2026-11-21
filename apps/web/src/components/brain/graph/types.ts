/**
 * The Graph tab's layout types: a node or edge as the simulation and the canvas hold them (the API's `GraphNode` plus a
 * position). Not copied; named after the types of Supermemory's memory-graph (src/types.ts) the layout modules were adapted from.
 */
import type { GraphEdgeType, GraphNode } from '@/lib/shared/brain-graph';

export interface LayoutNode {
  id: string;
  kind: 'subject' | 'fact';
  /** The API's node (statement, version, …). */
  data: GraphNode;
  x: number;
  y: number;
  /** Diameter in world units. */
  size: number;
  /** An earlier version, drawn faded. */
  faded: boolean;
  // d3-force writes these.
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
}

export interface LayoutEdge {
  source: string | LayoutNode;
  target: string | LayoutNode;
  type: GraphEdgeType;
}

export const SUBJECT_SIZE = 30;
export const FACT_SIZE = 16;
