/**
 * Canvas groups (`workflow.groups`): labelled frames behind nodes, stored beside the nodes like sticky notes and
 * ignored by the engine. Groups are a list of their own rather than pseudo-nodes for the same reasons as notes: the
 * engine, the runner, `$('Node')`, node counts and everything else that reads `workflow.nodes` stay untouched.
 *
 * Pure geometry and normalisation shared by the editor (grouping, moving, collapsing, drag in and out), the importer
 * and the templates; nothing here touches React Flow.
 */
import type { WorkflowGroup } from '@landflow/engine';

export type { WorkflowGroup };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room around the nodes of a new frame; the label sits in the taller top margin. */
export const GROUP_PADDING = { side: 40, top: 64, bottom: 40 };
export const GROUP_MIN_SIZE = { width: 220, height: 140 };
export const GROUP_MAX_SIZE = 20_000;
/** A collapsed group: one compact box at the frame's top-left corner. */
export const GROUP_COLLAPSED_SIZE = { width: 248, height: 76 };
export const GROUP_NAME_MAX = 120;
export const DEFAULT_GROUP_NAME = 'Group';

/** A node tile is 88px square (240px wide for root nodes with sub-node inputs); its name hangs below it, up to 170px wide. */
export const NODE_TILE = 88;
export const NODE_WIDE_TILE = 240;
const NODE_LABEL = { width: 170, height: 40 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function containsPoint(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** The room a node takes on the canvas, its name below the tile included. */
export function nodeBox(position: { x: number; y: number }, size: { width: number; height: number } = { width: NODE_TILE, height: NODE_TILE }): Rect {
  const overhang = Math.max(0, (NODE_LABEL.width - size.width) / 2);
  return { x: position.x - overhang, y: position.y, width: size.width + overhang * 2, height: size.height + NODE_LABEL.height };
}

/** A group's frame as a rectangle (its expanded size, also while collapsed). */
export function frameOf(group: Pick<WorkflowGroup, 'position' | 'width' | 'height'>): Rect {
  return { x: group.position[0], y: group.position[1], width: group.width, height: group.height };
}

/** The bounding box of some rectangles (undefined for none). */
export function boundsOf(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** A frame around these node rectangles: padded, label room on top, at least the minimum size, rounded to whole pixels. */
export function frameAround(rects: Rect[]): Rect | undefined {
  const box = boundsOf(rects);
  if (!box) return undefined;
  const width = Math.max(GROUP_MIN_SIZE.width, box.width + GROUP_PADDING.side * 2);
  const height = Math.max(GROUP_MIN_SIZE.height, box.height + GROUP_PADDING.top + GROUP_PADDING.bottom);
  return {
    x: Math.round(box.x - (width - box.width) / 2),
    y: Math.round(box.y - GROUP_PADDING.top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** `frame` grown (never shrunk) so `rect` fits inside it with the padding. */
export function growToFit(frame: Rect, rect: Rect): Rect {
  const x = Math.min(frame.x, rect.x - GROUP_PADDING.side);
  const y = Math.min(frame.y, rect.y - GROUP_PADDING.top);
  const right = Math.max(frame.x + frame.width, rect.x + rect.width + GROUP_PADDING.side);
  const bottom = Math.max(frame.y + frame.height, rect.y + rect.height + GROUP_PADDING.bottom);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
}

/**
 * The expanded group whose frame holds `point` (a node's centre): the smallest frame when several overlap, so a group
 * drawn inside a bigger one wins. Collapsed groups don't take nodes.
 */
export function groupAt<T extends Pick<WorkflowGroup, 'id' | 'position' | 'width' | 'height' | 'collapsed'>>(groups: T[], point: { x: number; y: number }): T | undefined {
  return groups
    .filter((g) => !g.collapsed && containsPoint(frameOf(g), point))
    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

/**
 * Groups as they can be saved: unique ids, a trimmed name, a size within limits, and members that exist, each node in
 * one group only (the first that lists it). Groups left empty are kept (a frame can be emptied by dragging nodes out).
 */
export function normalizeGroups(groups: readonly WorkflowGroup[] | undefined, nodeIds: Iterable<string>): WorkflowGroup[] {
  const known = new Set(nodeIds);
  const placed = new Set<string>();
  const ids = new Set<string>();
  const out: WorkflowGroup[] = [];
  for (const group of groups ?? []) {
    if (!group || typeof group.id !== 'string' || !group.id || ids.has(group.id)) continue;
    ids.add(group.id);
    const nodeIdsOf = (Array.isArray(group.nodeIds) ? group.nodeIds : []).filter((id) => typeof id === 'string' && known.has(id) && !placed.has(id));
    nodeIdsOf.forEach((id) => placed.add(id));
    const position: [number, number] = Array.isArray(group.position) ? [Math.round(Number(group.position[0]) || 0), Math.round(Number(group.position[1]) || 0)] : [0, 0];
    out.push({
      id: group.id,
      name: (typeof group.name === 'string' ? group.name.trim() : '').slice(0, GROUP_NAME_MAX) || DEFAULT_GROUP_NAME,
      nodeIds: [...new Set(nodeIdsOf)],
      position,
      width: Math.round(clamp(Number(group.width) || GROUP_MIN_SIZE.width, 40, GROUP_MAX_SIZE)),
      height: Math.round(clamp(Number(group.height) || GROUP_MIN_SIZE.height, 40, GROUP_MAX_SIZE)),
      ...(Number.isInteger(group.color) && group.color! > 0 && group.color! <= 9 && { color: group.color }),
      ...(group.collapsed === true && { collapsed: true }),
    });
  }
  return out;
}

/** The group a node belongs to. */
export function groupOfNode<T extends Pick<WorkflowGroup, 'nodeIds'>>(groups: readonly T[], nodeId: string): T | undefined {
  return groups.find((g) => g.nodeIds.includes(nodeId));
}
