/**
 * Canvas groups in the editor. A group is a React Flow node of type `frame` that lives in the store's `groups`, apart
 * from `nodes` and `stickies` (the engine never sees it). Its `width` / `height` are the expanded frame; a collapsed
 * group is drawn as a compact box at the frame's top-left corner, its nodes hidden and their connections re-routed to
 * the box (`canvasGraph`). Pure helpers, so the store logic stays testable without a canvas.
 *
 * Groups nest (`data.parentId`, `data.nodeIds` being a group's own nodes): moving a frame moves everything inside it,
 * a frame dropped into a bigger one joins it (and leaves it when dragged out), a parent grows to fit what joins it,
 * collapsing a parent hides the groups inside it too, and removing a group hands its nodes and groups to its parent.
 */
import type { Edge, Node } from '@xyflow/react';
import {
  DEFAULT_GROUP_NAME,
  GROUP_COLLAPSED_SIZE,
  GROUP_HANDLES,
  NODE_TILE,
  ancestorsOf,
  centerOf,
  collapsedBoxes,
  depthOf,
  descendantGroupIds,
  descendantNodeIds,
  frameAround,
  groupAt,
  growToFit,
  nodeBox,
  normalizeGroups,
  parentAt,
  routeEdges,
  type BoxPorts,
  type GroupLink,
  type Rect,
} from '@/lib/shared/groups';
import type { ConnectionType, GroupComposite, WorkflowGroup } from '@/lib/shared/types';
import type { FlowEdge, FlowNode, StickyFlowNode } from './store';
import { plural } from '@/lib/client/format';

export { GROUP_HANDLES };

export interface GroupData extends Record<string, unknown> {
  name: string;
  /** Index into the sticky-note palette (STICKY_COLORS). */
  color: number;
  collapsed: boolean;
  /** Ids of the group's own nodes (not those of the groups nested in it). */
  nodeIds: string[];
  /** The group this one sits in. */
  parentId?: string;
  /** Typed by a composite (docs/composites.md): its contract, version and slot bindings. */
  composite?: GroupComposite;
}
/** `frame`, not React Flow's built-in `group` type (which comes with its own styles). */
export type GroupFlowNode = Node<GroupData, 'frame'>;

export interface GroupProxyData extends Record<string, unknown> {
  connectionType: ConnectionType;
  /** Connections this line stands for. */
  count: number;
}
/** A connection drawn to or from a collapsed group's box in place of the hidden node's. */
export type GroupProxyEdge = Edge<GroupProxyData, 'groupProxy'>;

/** Frames sit under the notes (-1000), the edges and the nodes; a nested frame one step above its parent. */
export const GROUP_Z = -2000;

type PositionChange = { type: 'position'; id: string; position: { x: number; y: number } };

/** The room a node takes on the canvas (as measured, else a plain tile), its name below the tile included. */
export function nodeRect(node: Pick<FlowNode, 'position' | 'measured' | 'width' | 'height'>): Rect {
  return nodeBox(node.position, { width: node.measured?.width ?? node.width ?? NODE_TILE, height: node.measured?.height ?? node.height ?? NODE_TILE });
}

export function toFrames(groups: readonly WorkflowGroup[] = []): GroupFlowNode[] {
  return groups.map((group) => ({
    id: group.id,
    type: 'frame',
    position: { x: group.position[0], y: group.position[1] },
    width: group.width,
    height: group.height,
    zIndex: GROUP_Z,
    dragHandle: '.lf-frame-handle',
    data: { name: group.name, color: group.color ?? 0, collapsed: Boolean(group.collapsed), nodeIds: [...group.nodeIds], ...(group.parentId && { parentId: group.parentId }), ...(group.composite && { composite: group.composite }) },
  }));
}

/** Frames → `workflow.groups`, members limited to nodes that exist, parents to groups that exist. */
export function fromFrames(frames: readonly GroupFlowNode[], nodes: readonly Pick<FlowNode, 'id'>[]): WorkflowGroup[] {
  return normalizeGroups(
    frames.map((f) => ({
      id: f.id,
      name: f.data.name,
      nodeIds: f.data.nodeIds,
      position: [f.position.x, f.position.y],
      width: f.width ?? f.measured?.width ?? 0,
      height: f.height ?? f.measured?.height ?? 0,
      ...(f.data.color ? { color: f.data.color } : {}),
      ...(f.data.collapsed && { collapsed: true }),
      ...(f.data.parentId && { parentId: f.data.parentId }),
      ...(f.data.composite && { composite: f.data.composite }),
    })),
    nodes.map((n) => n.id),
  );
}

/** A frame as the shared helpers see it. */
function asGroup(frame: GroupFlowNode) {
  return {
    id: frame.id,
    position: [frame.position.x, frame.position.y] as [number, number],
    width: frame.width ?? 0,
    height: frame.height ?? 0,
    collapsed: frame.data.collapsed,
    nodeIds: frame.data.nodeIds,
    parentId: frame.data.parentId,
  };
}

/** The frames as tree links, for ancestorsOf / descendantNodeIds and friends. */
export const linksOf = (frames: readonly GroupFlowNode[]): GroupLink[] => frames.map(asGroup);

/** Frames that can take a dropped node or frame: hidden ones (inside a collapsed group) count as collapsed. */
function dropTargets(frames: readonly GroupFlowNode[]) {
  const { hidden } = collapsedBoxes(linksOf(frames));
  return frames.map((f) => (hidden.has(f.id) ? { ...asGroup(f), collapsed: true } : asGroup(f)));
}

/** Nodes hidden on the canvas because a group around them is collapsed. */
export function hiddenNodeIds(frames: readonly GroupFlowNode[]): Set<string> {
  return new Set(collapsedBoxes(linksOf(frames)).boxOf.keys());
}

/** Frames hidden on the canvas because a group around them is collapsed. */
export function hiddenFrameIds(frames: readonly GroupFlowNode[]): Set<string> {
  return collapsedBoxes(linksOf(frames)).hidden;
}

const withData = (frame: GroupFlowNode, patch: Partial<GroupData>): GroupFlowNode => ({ ...frame, data: { ...frame.data, ...patch } });

/** A frame moved into another group, or (no parent) to the top level. */
function withParent(frame: GroupFlowNode, parentId: string | undefined): GroupFlowNode {
  if (frame.data.parentId === parentId) return frame;
  const { parentId: _old, ...data } = frame.data;
  return { ...frame, data: parentId ? { ...data, parentId } : data };
}

/** "Group", or "Group 2", "Group 3"… when the name is taken. */
export function nextGroupName(frames: readonly GroupFlowNode[]): string {
  const names = new Set(frames.map((f) => f.data.name));
  if (!names.has(DEFAULT_GROUP_NAME)) return DEFAULT_GROUP_NAME;
  let i = 2;
  while (names.has(`${DEFAULT_GROUP_NAME} ${i}`)) i++;
  return `${DEFAULT_GROUP_NAME} ${i}`;
}

/** A new frame around these nodes and frames (the frames' expanded size, so expanding them later still fits). */
export function frameFor(id: string, name: string, nodes: readonly FlowNode[], frames: readonly GroupFlowNode[] = []): GroupFlowNode | undefined {
  const rect = frameAround([...nodes.map(nodeRect), ...frames.map(frameRect)]);
  if (!rect) return undefined;
  return toFrames([{ id, name, nodeIds: nodes.map((n) => n.id), position: [rect.x, rect.y], width: rect.width, height: rect.height }])[0];
}

/**
 * ⌘G: a new group around the picked nodes and frames. Picked frames move into it with everything inside them (a
 * picked frame inside another picked one comes along with its parent, as do picked nodes inside a picked frame); the
 * other picked nodes leave their groups for it. It sits in the innermost group that held all of them, which grows to
 * fit it. Undefined when nothing is picked.
 */
export function groupAround(
  frames: GroupFlowNode[],
  nodes: readonly FlowNode[],
  id: string,
  name: string,
  pickedNodeIds: readonly string[],
  pickedFrameIds: readonly string[],
): { frames: GroupFlowNode[]; frame: GroupFlowNode } | undefined {
  const links = linksOf(frames);
  const picked = new Set(pickedFrameIds);
  const topFrames = frames.filter((f) => picked.has(f.id) && !ancestorsOf(links, f.id).some((a) => picked.has(a)));
  const inside = new Set(topFrames.flatMap((f) => descendantNodeIds(links, f.id)));
  const loose = nodes.filter((n) => pickedNodeIds.includes(n.id) && !inside.has(n.id));
  if (!loose.length && !topFrames.length) return undefined;
  // The innermost group that holds every picked node and frame (the chains are nearest first).
  const chains = [
    ...loose.map((n) => {
      const own = frames.find((f) => f.data.nodeIds.includes(n.id));
      return own ? [own.id, ...ancestorsOf(links, own.id)] : [];
    }),
    ...topFrames.map((f) => ancestorsOf(links, f.id)),
  ];
  const parentId = chains[0].find((candidate) => chains.every((chain) => chain.includes(candidate)));
  const made = frameFor(id, name, loose, topFrames);
  if (!made) return undefined;
  const frame = withParent(made, parentId);
  const moved = new Set(topFrames.map((f) => f.id));
  const next = withoutMembers(frames, new Set(loose.map((n) => n.id))).map((f) => (moved.has(f.id) ? withParent(f, id) : f));
  return { frames: growAncestors([...next, frame], id), frame };
}

/** Frames without these nodes as members, nor bound to a composite's slots (unchanged frames keep their identity). */
export function withoutMembers(frames: GroupFlowNode[], ids: ReadonlySet<string>): GroupFlowNode[] {
  return frames.map((f) => (f.data.nodeIds.some((id) => ids.has(id)) || boundTo(f, ids) ? withData(f, { nodeIds: f.data.nodeIds.filter((id) => !ids.has(id)), ...unbound(f, ids) }) : f));
}

const boundTo = (frame: GroupFlowNode, ids: ReadonlySet<string>) => Boolean(frame.data.composite && Object.values(frame.data.composite.slots).some((bound) => bound.some((id) => ids.has(id))));

/** A composite frame's bindings without these ids (nothing for a plain group). */
function unbound(frame: GroupFlowNode, ids: ReadonlySet<string>): Partial<GroupData> {
  const composite = frame.data.composite;
  if (!composite || !boundTo(frame, ids)) return {};
  const slots = Object.fromEntries(Object.entries(composite.slots).flatMap(([slot, bound]) => {
    const kept = bound.filter((id) => !ids.has(id));
    return kept.length ? [[slot, kept]] : [];
  }));
  return { composite: { ...composite, slots } };
}

/**
 * Remove frames, keeping what they hold: their nodes and the groups inside them go to the nearest group around them
 * that stays (or to the top level). The nodes handed over are returned too (ungroup selects them).
 */
export function removeFrames(frames: GroupFlowNode[], ids: ReadonlySet<string>): { frames: GroupFlowNode[]; freed: string[] } {
  if (!frames.some((f) => ids.has(f.id))) return { frames, freed: [] };
  const links = linksOf(frames);
  const heir = (id: string) => ancestorsOf(links, id).find((a) => !ids.has(a));
  const inherited = new Map<string, string[]>();
  const freed: string[] = [];
  for (const f of frames) {
    if (!ids.has(f.id)) continue;
    freed.push(...f.data.nodeIds);
    const to = heir(f.id);
    if (to) inherited.set(to, [...(inherited.get(to) ?? []), ...f.data.nodeIds]);
  }
  const next = frames
    .filter((f) => !ids.has(f.id))
    .map((f) => {
      const parent = f.data.parentId && ids.has(f.data.parentId) ? withParent(f, heir(f.id)) : f;
      const extra = inherited.get(f.id);
      return extra?.length ? withData(parent, { nodeIds: [...parent.data.nodeIds, ...extra] }) : parent;
    });
  return { frames: next, freed };
}

/**
 * Moving a frame moves what is inside it: position changes for the nodes and nested frames of every frame in
 * `changes` that moved (by the same distance). Whatever is dragged along in the same gesture is left alone (and moves
 * once even when it sits in two moving frames), and so are frames being resized (a resize from the top or left edge
 * moves the frame, not its content).
 */
export function memberMoves(
  frames: readonly GroupFlowNode[],
  nodes: readonly FlowNode[],
  changes: readonly { type: string; id?: string; position?: { x: number; y: number }; resizing?: boolean }[],
): { nodes: PositionChange[]; frames: PositionChange[] } {
  const resizing = new Set(changes.filter((c) => c.type === 'dimensions' && c.resizing !== undefined).map((c) => c.id));
  const moving = new Set(changes.filter((c) => c.type === 'position').map((c) => c.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const frameById = new Map(frames.map((f) => [f.id, f]));
  const links = linksOf(frames);
  const nodeMoves = new Map<string, PositionChange>();
  const frameMoves = new Map<string, PositionChange>();
  for (const change of changes) {
    if (change.type !== 'position' || !change.position || !change.id || resizing.has(change.id)) continue;
    const frame = frameById.get(change.id);
    if (!frame) continue;
    const dx = change.position.x - frame.position.x;
    const dy = change.position.y - frame.position.y;
    if (!dx && !dy) continue;
    for (const id of descendantNodeIds(links, frame.id)) {
      const node = nodeById.get(id);
      if (node && !moving.has(id) && !nodeMoves.has(id)) nodeMoves.set(id, { type: 'position', id, position: { x: node.position.x + dx, y: node.position.y + dy } });
    }
    for (const id of descendantGroupIds(links, frame.id)) {
      const inner = frameById.get(id);
      if (inner && !moving.has(id) && !frameMoves.has(id)) frameMoves.set(id, { type: 'position', id, position: { x: inner.position.x + dx, y: inner.position.y + dy } });
    }
  }
  return { nodes: [...nodeMoves.values()], frames: [...frameMoves.values()] };
}

/** Each group around `id` grown (never shrunk) so the one inside it still fits, up to the top. */
export function growAncestors(frames: GroupFlowNode[], id: string): GroupFlowNode[] {
  let next = frames;
  let child = next.find((f) => f.id === id);
  while (child?.data.parentId) {
    const parent = next.find((f) => f.id === child!.data.parentId);
    if (!parent) break;
    const grown = growToFit(frameRect(parent), frameRect(child));
    if (!sameRect(grown, frameRect(parent))) {
      const resized = { ...parent, position: { x: grown.x, y: grown.y }, width: grown.width, height: grown.height };
      next = next.map((f) => (f.id === parent.id ? resized : f));
      child = resized;
    } else child = parent;
  }
  return next;
}

/**
 * Nodes dropped after a drag join the innermost expanded group their centre landed in (its frame, and the groups
 * around it, grow to fit them) or leave their group when they landed outside it.
 */
export function adoptNodes(frames: GroupFlowNode[], nodes: readonly FlowNode[], ids: readonly string[]): GroupFlowNode[] {
  let next = frames;
  for (const id of ids) {
    const node = nodes.find((n) => n.id === id);
    if (!node) continue;
    const rect = nodeRect(node);
    const target = groupAt(dropTargets(next), centerOf(rect));
    const current = next.find((f) => f.data.nodeIds.includes(id));
    next = next.map((f) => {
      if (f.id === target?.id) {
        const grown = growToFit(frameRect(f), rect);
        const nodeIds = f.data.nodeIds.includes(id) ? f.data.nodeIds : [...f.data.nodeIds, id];
        if (nodeIds === f.data.nodeIds && sameRect(grown, frameRect(f))) return f;
        return { ...f, position: { x: grown.x, y: grown.y }, width: grown.width, height: grown.height, data: { ...f.data, nodeIds } };
      }
      if (f.id === current?.id) return withData(f, { nodeIds: f.data.nodeIds.filter((n) => n !== id) });
      return f;
    });
    // A node that left a composite (for a group outside it) leaves its slot.
    if (target?.id !== current?.id) next = next.map((f) => (f.data.composite && boundTo(f, new Set([id])) && !insideOf(next, f.id, target?.id) ? withData(f, unbound(f, new Set([id]))) : f));
    if (target) next = growAncestors(next, target.id);
  }
  return next;
}

/**
 * Frames dropped after a drag (or pasted) move into the smallest expanded group bigger than them that holds their
 * centre (never one inside themselves); the groups around them grow to fit. Dropped outside every group, they go to
 * the top level.
 */
export function adoptFrames(frames: GroupFlowNode[], ids: readonly string[]): GroupFlowNode[] {
  let next = frames;
  for (const id of ids) {
    const frame = next.find((f) => f.id === id);
    if (!frame) continue;
    const exclude = new Set([id, ...descendantGroupIds(linksOf(next), id)]);
    const target = parentAt(dropTargets(next), frameRect(frame), exclude);
    next = next.map((f) => (f.id === id ? withParent(f, target?.id) : f));
    next = growAncestors(next, id);
  }
  return next;
}

/**
 * After a frame was resized: nodes now inside it (and in no other group) join and members now outside leave; groups
 * beside it (same parent, smaller) whose centre is now inside it move in, and groups inside it whose centre is now
 * outside move out to its parent. The groups around it grow to fit it.
 */
export function refitMembers(frames: GroupFlowNode[], nodes: readonly FlowNode[], frameId: string): GroupFlowNode[] {
  const frame = frames.find((f) => f.id === frameId);
  if (!frame || frame.data.collapsed) return frames;
  const targets = dropTargets(frames);
  const hidden = hiddenNodeIds(frames);
  const elsewhere = new Set(frames.filter((f) => f.id !== frameId).flatMap((f) => f.data.nodeIds));
  const nodeIds = nodes.filter((n) => !elsewhere.has(n.id) && !hidden.has(n.id) && groupAt(targets, centerOf(nodeRect(n)))?.id === frameId).map((n) => n.id);
  const rect = frameRect(frame);
  const area = rect.width * rect.height;
  const hiddenFrames = hiddenFrameIds(frames);
  let next = frames.map((f) => {
    if (f.id === frameId) return nodeIds.length === f.data.nodeIds.length && nodeIds.every((id) => f.data.nodeIds.includes(id)) ? f : withData(f, { nodeIds });
    if (hiddenFrames.has(f.id)) return f;
    const inside = containsCenter(rect, frameRect(f));
    if (f.data.parentId === frameId && !inside) return withParent(f, frame.data.parentId);
    if (f.data.parentId === frame.data.parentId && inside && frameRect(f).width * frameRect(f).height < area) return withParent(f, frameId);
    return f;
  });
  next = growAncestors(next, frameId);
  // Nodes that left it land in whatever group is around them now (its parent, usually).
  const left = frame.data.nodeIds.filter((id) => !nodeIds.includes(id));
  return left.length ? adoptNodes(next, nodes, left) : next;
}

/** Frames fitted around their members again (after the graph was laid out anew), inner ones first. Empty frames stay where they are. */
export function refitFrames(frames: GroupFlowNode[], nodes: readonly FlowNode[]): GroupFlowNode[] {
  const links = linksOf(frames);
  const order = [...frames].sort((a, b) => depthOf(links, b.id) - depthOf(links, a.id));
  const fitted = new Map(frames.map((f) => [f.id, f]));
  for (const f of order) {
    const rects = [...nodes.filter((n) => f.data.nodeIds.includes(n.id)).map(nodeRect), ...frames.filter((c) => c.data.parentId === f.id).map((c) => frameRect(fitted.get(c.id)!))];
    const rect = frameAround(rects);
    if (rect) fitted.set(f.id, { ...f, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height });
  }
  return frames.map((f) => fitted.get(f.id)!);
}

/** Whether group `id` is `outer` or sits somewhere inside it. */
function insideOf(frames: readonly GroupFlowNode[], outer: string, id: string | undefined): boolean {
  return Boolean(id && (id === outer || ancestorsOf(linksOf(frames), id).includes(outer)));
}

function frameRect(frame: GroupFlowNode): Rect {
  return { x: frame.position.x, y: frame.position.y, width: frame.width ?? 0, height: frame.height ?? 0 };
}

const containsCenter = (outer: Rect, inner: Rect) => {
  const c = centerOf(inner);
  return c.x >= outer.x && c.x <= outer.x + outer.width && c.y >= outer.y && c.y <= outer.y + outer.height;
};

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;


/** What screen readers announce for a frame: its name, the nodes inside it (nested ones included) and the groups nested in it. */
export function frameLabel(data: Pick<GroupData, 'name' | 'collapsed'>, nodeCount: number, groupCount = 0): string {
  return `Group ${data.name || DEFAULT_GROUP_NAME}, ${plural(nodeCount, 'node')}${groupCount ? `, ${plural(groupCount, 'group')}` : ''}${data.collapsed ? ', collapsed' : ''}`;
}

/**
 * What React Flow draws: frames (nested ones above their parents) under the notes under the nodes. Members of a
 * collapsed group, and the groups nested in it, are hidden; their connections to the rest of the workflow are drawn
 * to the outermost collapsed box instead (one line per box, node and port, however many connections it stands for);
 * connections inside the box disappear with it. Without collapsed groups the store's edges pass through unchanged.
 */
export function canvasGraph(
  frames: readonly GroupFlowNode[],
  stickies: readonly StickyFlowNode[],
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  ports?: BoxPorts,
): { nodes: (GroupFlowNode | StickyFlowNode | FlowNode)[]; edges: (FlowEdge | GroupProxyEdge)[] } {
  const links = linksOf(frames);
  const { boxOf, hidden } = collapsedBoxes(links);
  // The frame's body lets the pointer through (to the canvas and the nodes on it); its header and box take it (GroupNodeView).
  const shownFrames = frames.map((f) => {
    const label = frameLabel(f.data, descendantNodeIds(links, f.id).length, descendantGroupIds(links, f.id).length);
    const shown = { ...f, zIndex: GROUP_Z + depthOf(links, f.id), ariaLabel: label, style: { ...f.style, pointerEvents: 'none' as const } };
    if (hidden.has(f.id)) return { ...shown, hidden: true, selected: false };
    return f.data.collapsed ? { ...shown, width: GROUP_COLLAPSED_SIZE.width, height: GROUP_COLLAPSED_SIZE.height } : shown;
  });
  if (!boxOf.size) return { nodes: [...shownFrames, ...stickies, ...nodes], edges: edges as FlowEdge[] };

  const shownNodes = nodes.map((n) => (boxOf.has(n.id) ? { ...n, hidden: true, selected: false } : n));
  const routed = routeEdges(edges, boxOf, ports);
  const proxies = routed.routes.map<GroupProxyEdge>((route) => ({
    id: route.id,
    type: 'groupProxy',
    source: route.source,
    target: route.target,
    sourceHandle: route.sourceHandle,
    targetHandle: route.targetHandle,
    selectable: false,
    deletable: false,
    focusable: false,
    data: { connectionType: route.connectionType as ConnectionType, count: route.edgeIds.length },
  }));
  return { nodes: [...shownFrames, ...stickies, ...shownNodes], edges: [...routed.edges, ...proxies] };
}
