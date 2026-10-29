/**
 * Canvas groups (`workflow.groups`): labelled frames behind nodes, stored beside the nodes like sticky notes and
 * ignored by the engine. Groups are a list of their own rather than pseudo-nodes for the same reasons as notes: the
 * engine, the runner, `$('Node')`, node counts and everything else that reads `workflow.nodes` stay untouched.
 *
 * Groups nest: `parentId` names the group a group sits in, and `nodeIds` lists only a group's own nodes. A collapsed
 * group stands for everything inside it, nested groups included: their nodes are drawn as its box (`collapsedBoxes`)
 * and their connections end at it (`routeEdges`).
 *
 * Pure geometry, tree and normalisation helpers shared by the editor (grouping, moving, collapsing, drag in and out),
 * the read-only canvases (executions, versions, templates), the importer and the templates; nothing here touches
 * React Flow.
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

/** Where `rect` fits without covering any of `taken`: moved straight down past what it would cover, `gap` apart. */
export function clearSpot(rect: Rect, taken: readonly Rect[], gap = 40): { x: number; y: number } {
  let y = rect.y;
  for (let i = 0; i < 200; i++) {
    const hits = taken.filter((r) => r.x < rect.x + rect.width + gap && r.x + r.width + gap > rect.x && r.y < y + rect.height + gap && r.y + r.height + gap > y);
    if (!hits.length) break;
    y = Math.max(...hits.map((r) => r.y + r.height)) + gap;
  }
  return { x: rect.x, y };
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
 * drawn inside a bigger one wins. Collapsed groups don't take nodes (callers mark groups hidden inside a collapsed one
 * as collapsed too).
 */
export function groupAt<T extends Pick<WorkflowGroup, 'id' | 'position' | 'width' | 'height' | 'collapsed'>>(groups: T[], point: { x: number; y: number }): T | undefined {
  return groups
    .filter((g) => !g.collapsed && containsPoint(frameOf(g), point))
    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

/**
 * Groups as they can be saved: unique ids, a trimmed name, a size within limits, and members that exist, each node in
 * one group only (the first that lists it). Groups left empty are kept (a frame can be emptied by dragging nodes out).
 * A `parentId` stays when it names another group and doesn't make a loop (the link that would close one is dropped).
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
      ...(group.composite && typeof group.composite.type === 'string' && group.composite.type && Number.isInteger(group.composite.version) && { composite: group.composite }),
    });
  }
  // Parents: known groups only, no loops. Links are taken in list order, so the one that would close a loop goes.
  const parents = new Map<string, string>();
  const first = new Set<string>();
  for (const group of groups ?? []) {
    if (!group || typeof group.id !== 'string' || first.has(group.id)) continue;
    first.add(group.id);
    const parentId = group.parentId;
    if (typeof parentId !== 'string' || !ids.has(parentId) || parentId === group.id) continue;
    let at: string | undefined = parentId;
    while (at && at !== group.id) at = parents.get(at);
    if (!at) parents.set(group.id, parentId);
  }
  const linked = parents.size ? out.map((g) => (parents.has(g.id) ? { ...g, parentId: parents.get(g.id) } : g)) : out;
  return linked.some((g) => g.composite) ? linked.map((g) => (g.composite ? { ...g, composite: prunedComposite(g, linked, known) } : g)) : linked;
}

/**
 * A composite's bindings kept to its members (docs/composites.md): its own nodes, those of plain groups nested in it
 * and the composites nested directly in it, so a node dragged out of the frame leaves its slot. Fallback targets
 * must be nodes that exist.
 */
function prunedComposite(group: WorkflowGroup, groups: readonly WorkflowGroup[], known: ReadonlySet<string>): NonNullable<WorkflowGroup['composite']> {
  const members = new Set<string>();
  const walk = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    groups.find((g) => g.id === id)?.nodeIds.forEach((n) => members.add(n));
    for (const child of groups) {
      if (child.parentId !== id) continue;
      if (child.composite) members.add(child.id);
      else walk(child.id, seen);
    }
  };
  walk(group.id, new Set());
  const { type, version, slots, params, fallback } = group.composite!;
  const kept: Record<string, string[]> = {};
  for (const [slot, ids] of Object.entries(slots && typeof slots === 'object' ? slots : {})) {
    const live = Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string' && members.has(id)))] : [];
    if (live.length) kept[slot] = live;
  }
  const targets = Array.isArray(fallback) ? fallback.filter((f) => f && typeof f.target === 'string' && known.has(f.target)).map((f) => ({ target: f.target, ...(Number.isInteger(f.targetIndex) && f.targetIndex! > 0 && { targetIndex: f.targetIndex }) })) : [];
  return { type, version, slots: kept, ...(params && typeof params === 'object' && Object.keys(params).length > 0 && { params }), ...(targets.length > 0 && { fallback: targets }) };
}

/** The group a node belongs to. */
export function groupOfNode<T extends Pick<WorkflowGroup, 'nodeIds'>>(groups: readonly T[], nodeId: string): T | undefined {
  return groups.find((g) => g.nodeIds.includes(nodeId));
}

// ---------------------------------------------------------------------------
// Nesting
// ---------------------------------------------------------------------------

/** What the tree helpers read of a group (the editor's frames and saved groups both fit). */
export type GroupLink = Pick<WorkflowGroup, 'id' | 'nodeIds'> & { parentId?: string; collapsed?: boolean };

/** The groups a group sits in, nearest first. A loop (which normalizeGroups never lets through) stops the walk. */
export function ancestorsOf(groups: readonly GroupLink[], id: string): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out: string[] = [];
  for (let at = byId.get(id)?.parentId; at && byId.has(at) && at !== id && !out.includes(at); at = byId.get(at)?.parentId) out.push(at);
  return out;
}

/** The groups inside a group, at any depth (parents before their children). */
export function descendantGroupIds(groups: readonly GroupLink[], id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const at = queue.shift()!;
    for (const g of groups) if (g.parentId === at && g.id !== id && !out.includes(g.id)) out.push(g.id), queue.push(g.id);
  }
  return out;
}

/** Every node inside a group: its own and those of the groups nested in it. */
export function descendantNodeIds(groups: readonly GroupLink[], id: string): string[] {
  const inside = new Set([id, ...descendantGroupIds(groups, id)]);
  return groups.filter((g) => inside.has(g.id)).flatMap((g) => g.nodeIds);
}

/** How deep a group is nested (0: top level). */
export function depthOf(groups: readonly GroupLink[], id: string): number {
  return ancestorsOf(groups, id).length;
}

/**
 * What collapsing hides: each node inside a collapsed group mapped to the box it is drawn as (the outermost collapsed
 * group around it), and the groups hidden inside a collapsed one. `collapsed` overrides the saved state (the read-only
 * canvases expand groups without changing the workflow).
 */
export function collapsedBoxes(groups: readonly GroupLink[], collapsed: (group: GroupLink) => boolean = (g) => Boolean(g.collapsed)): { boxOf: Map<string, string>; hidden: Set<string> } {
  const boxOf = new Map<string, string>();
  const hidden = new Set<string>();
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const group of groups) {
    const chain = [group.id, ...ancestorsOf(groups, group.id)];
    const closed = chain.filter((id) => collapsed(byId.get(id)!));
    if (closed.some((id) => id !== group.id)) hidden.add(group.id);
    const box = closed.at(-1);
    if (box) for (const nodeId of group.nodeIds) boxOf.set(nodeId, box);
  }
  return { boxOf, hidden };
}

/**
 * The expanded, shown group a dropped frame lands in: the smallest one holding the frame's centre that is bigger than
 * the frame, leaving out the frame itself and the groups inside it. Hidden groups count as collapsed.
 */
export function parentAt<T extends Pick<WorkflowGroup, 'id' | 'position' | 'width' | 'height' | 'collapsed'>>(groups: T[], rect: Rect, exclude: ReadonlySet<string>): T | undefined {
  const area = rect.width * rect.height;
  return groupAt(
    groups.filter((g) => !exclude.has(g.id) && g.width * g.height > area),
    centerOf(rect),
  );
}

/** Handles of a collapsed box: main connections in on the left and out on the right, sub-node ones on top and bottom. */
export const GROUP_HANDLES = { in: 'group:in', out: 'group:out', aiIn: 'group:ai-in', aiOut: 'group:ai-out' } as const;

/** A collapsed composite's named output (docs/composites.md): its handle id. */
export const compositePortHandle = (port: string) => `composite:out:${port}`;

/**
 * A collapsed box's named outputs: box id → (`<node id>:<source handle>` → the port's handle). Connections leaving the
 * box from a port's node and output are drawn from that port; the rest from the box's plain output.
 */
export type BoxPorts = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** A connection as the router sees it (the editor's and the read-only canvases' edges both fit). */
export interface RoutableEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: { connectionType?: string };
}

/** One line drawn to or from a collapsed box, standing for the connections in `edgeIds`. */
export interface BoxRoute {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  connectionType: string;
  edgeIds: string[];
}

/**
 * Connections with collapsed groups in the way: those between shown nodes pass through; those with an end inside a
 * collapsed group become one line per box, node and port (however many connections it stands for); those inside one
 * box disappear with it.
 */
export function routeEdges<E extends RoutableEdge>(edges: readonly E[], boxOf: ReadonlyMap<string, string>, ports?: BoxPorts): { edges: E[]; routes: BoxRoute[] } {
  if (!boxOf.size) return { edges: edges as E[], routes: [] };
  const shown: E[] = [];
  const routes = new Map<string, BoxRoute>();
  for (const edge of edges) {
    const fromBox = boxOf.get(edge.source);
    const toBox = boxOf.get(edge.target);
    if (!fromBox && !toBox) {
      shown.push(edge);
      continue;
    }
    if (fromBox && fromBox === toBox) continue;
    const type = edge.data?.connectionType ?? 'main';
    const main = type === 'main';
    const source = fromBox ?? edge.source;
    const target = toBox ?? edge.target;
    const port = fromBox && main ? ports?.get(fromBox)?.get(`${edge.source}:${edge.sourceHandle ?? 'main:0'}`) : undefined;
    const sourceHandle = fromBox ? (port ?? (main ? GROUP_HANDLES.out : GROUP_HANDLES.aiOut)) : (edge.sourceHandle ?? null);
    const targetHandle = toBox ? (main ? GROUP_HANDLES.in : GROUP_HANDLES.aiIn) : (edge.targetHandle ?? null);
    const id = `proxy:${source}:${sourceHandle}:${target}:${targetHandle}`;
    const existing = routes.get(id);
    if (existing) existing.edgeIds.push(edge.id);
    else routes.set(id, { id, source, target, sourceHandle, targetHandle, connectionType: type, edgeIds: [edge.id] });
  }
  return { edges: shown, routes: [...routes.values()] };
}
