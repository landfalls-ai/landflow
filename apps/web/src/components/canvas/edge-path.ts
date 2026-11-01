/**
 * The shape of a connection, shared by the editor and the read-only execution view. Forward connections and sub-node
 * connections are curves. A main connection that runs backwards (a loop: its input is left of its output) leaves the
 * output to the right, runs along a lane under every node it spans and comes into the input from the left, n8n's way,
 * so it never cuts through a node or hooks into its target from behind.
 */
import { getBezierPath, getSmoothStepPath, Position, useStore, type InternalNode, type ReactFlowState } from '@xyflow/react';

interface Ends {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
}

/** Under a node's frame: its name, subtitle and meta under a tile, the slot labels and + under an agent. */
const BELOW_NODE = 72;
const RADIUS = 16;
const OUT = 32;

export const isBackward = (ends: Pick<Ends, 'sourceX' | 'targetX'>, isAi: boolean) => !isAi && ends.sourceX - 16 > ends.targetX;

/** The y of a lane under every node (but notes and frames) that overlaps the span from `left` to `right`. */
function laneUnder(nodes: Map<string, InternalNode>, left: number, right: number, floor: number): number {
  let lane = floor;
  for (const node of nodes.values()) {
    if (node.type === 'sticky' || node.type === 'frame' || node.hidden) continue;
    const { x, y } = node.internals.positionAbsolute;
    const width = node.measured.width ?? node.width ?? 0;
    const height = node.measured.height ?? node.height ?? 0;
    if (x + width < left || x > right) continue;
    lane = Math.max(lane, y + height + BELOW_NODE);
  }
  return lane;
}

/** The lane a backward connection runs along (undefined for any other connection): re-read as nodes move. */
export function useLane(ends: Ends, isAi: boolean): number | undefined {
  const backward = isBackward(ends, isAi);
  const { sourceX, sourceY, targetX, targetY } = ends;
  return useStore((s: ReactFlowState) => (backward ? laneUnder(s.nodeLookup, targetX, sourceX, Math.max(sourceY, targetY) + BELOW_NODE) : undefined));
}

/** The path and where its label sits. `lane` comes from `useLane`; without it a loop drops a fixed distance. */
export function edgePath(ends: Ends, isAi: boolean, lane?: number): [path: string, labelX: number, labelY: number] {
  if (!isBackward(ends, isAi)) {
    const [path, labelX, labelY] = getBezierPath({ ...ends, curvature: isAi ? 0.35 : 0.3 });
    return [path, labelX, labelY];
  }
  const { sourceX, sourceY, targetX, targetY } = ends;
  const y = lane ?? Math.max(sourceY, targetY) + 130;
  const midX = (sourceX + targetX) / 2;
  const [down] = getSmoothStepPath({ sourceX, sourceY, targetX: midX, targetY: y, sourcePosition: Position.Right, targetPosition: Position.Right, borderRadius: RADIUS, offset: OUT });
  const [up] = getSmoothStepPath({ sourceX: midX, sourceY: y, targetX, targetY, sourcePosition: Position.Left, targetPosition: Position.Left, borderRadius: RADIUS, offset: OUT });
  return [`${down} ${up}`, midX, y];
}
