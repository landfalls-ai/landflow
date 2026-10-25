/**
 * Canvas groups in the editor. A group is a React Flow node of type `frame` that lives in the store's `groups`, apart
 * from `nodes` and `stickies` (the engine never sees it). Its `width` / `height` are the expanded frame; a collapsed
 * group is drawn as a compact box at the frame's top-left corner, its nodes hidden and their connections re-routed to
 * the box (`canvasGraph`). Pure helpers, so the store logic stays testable without a canvas.
 */
import type { Edge, Node } from '@xyflow/react';
import { DEFAULT_GROUP_NAME, GROUP_COLLAPSED_SIZE, NODE_TILE, centerOf, frameAround, groupAt, growToFit, nodeBox, normalizeGroups, type Rect } from '@/lib/shared/groups';
import type { ConnectionType, WorkflowGroup } from '@/lib/shared/types';
import type { FlowEdge, FlowNode, StickyFlowNode } from './store';

export interface GroupData extends Record<string, unknown> {
  name: string;
  /** Index into the sticky-note palette (STICKY_COLORS). */
  color: number;
  collapsed: boolean;
  /** Ids of the nodes in the group. */
  nodeIds: string[];
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

/** Frames sit under the notes (-1000), the edges and the nodes. */
export const GROUP_Z = -2000;
/** Handles of a collapsed box: main connections in on the left and out on the right, sub-node ones on top and bottom. */
export const GROUP_HANDLES = { in: 'group:in', out: 'group:out', aiIn: 'group:ai-in', aiOut: 'group:ai-out' } as const;

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
    data: { name: group.name, color: group.color ?? 0, collapsed: Boolean(group.collapsed), nodeIds: [...group.nodeIds] },
  }));
}

/** Frames → `workflow.groups`, members limited to nodes that exist. */
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
    })),
    nodes.map((n) => n.id),
  );
}

/** A frame as the shared geometry helpers see it. */
function asGroup(frame: GroupFlowNode) {
  return { id: frame.id, position: [frame.position.x, frame.position.y] as [number, number], width: frame.width ?? 0, height: frame.height ?? 0, collapsed: frame.data.collapsed };
}

const withData = (frame: GroupFlowNode, patch: Partial<GroupData>): GroupFlowNode => ({ ...frame, data: { ...frame.data, ...patch } });

/** "Group", or "Group 2", "Group 3"… when the name is taken. */
export function nextGroupName(frames: readonly GroupFlowNode[]): string {
  const names = new Set(frames.map((f) => f.data.name));
  if (!names.has(DEFAULT_GROUP_NAME)) return DEFAULT_GROUP_NAME;
  let i = 2;
  while (names.has(`${DEFAULT_GROUP_NAME} ${i}`)) i++;
  return `${DEFAULT_GROUP_NAME} ${i}`;
}

/** A new frame around these nodes. */
export function frameFor(id: string, name: string, nodes: readonly FlowNode[]): GroupFlowNode | undefined {
  const rect = frameAround(nodes.map(nodeRect));
  if (!rect) return undefined;
  return toFrames([{ id, name, nodeIds: nodes.map((n) => n.id), position: [rect.x, rect.y], width: rect.width, height: rect.height }])[0];
}

/** Frames without these nodes as members (unchanged frames keep their identity). */
export function withoutMembers(frames: GroupFlowNode[], ids: ReadonlySet<string>): GroupFlowNode[] {
  return frames.map((f) => (f.data.nodeIds.some((id) => ids.has(id)) ? withData(f, { nodeIds: f.data.nodeIds.filter((id) => !ids.has(id)) }) : f));
}

/**
 * Moving a frame moves its nodes: position changes for the members of every frame in `changes` that moved (by the
 * same distance). Members dragged along in the same gesture are left alone, and so are frames being resized (a resize
 * from the top or left edge moves the frame, not its content).
 */
export function memberMoves(
  frames: readonly GroupFlowNode[],
  nodes: readonly FlowNode[],
  changes: readonly { type: string; id?: string; position?: { x: number; y: number }; resizing?: boolean }[],
): { type: 'position'; id: string; position: { x: number; y: number } }[] {
  const resizing = new Set(changes.filter((c) => c.type === 'dimensions' && c.resizing !== undefined).map((c) => c.id));
  const moving = new Set(changes.filter((c) => c.type === 'position').map((c) => c.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const moves: { type: 'position'; id: string; position: { x: number; y: number } }[] = [];
  for (const change of changes) {
    if (change.type !== 'position' || !change.position || !change.id || resizing.has(change.id)) continue;
    const frame = frames.find((f) => f.id === change.id);
    if (!frame) continue;
    const dx = change.position.x - frame.position.x;
    const dy = change.position.y - frame.position.y;
    if (!dx && !dy) continue;
    for (const id of frame.data.nodeIds) {
      const node = byId.get(id);
      if (node && !moving.has(id)) moves.push({ type: 'position', id, position: { x: node.position.x + dx, y: node.position.y + dy } });
    }
  }
  return moves;
}

/**
 * Nodes dropped after a drag join the expanded group their centre landed in (its frame grows to fit them) or leave
 * their group when they landed outside it.
 */
export function adoptNodes(frames: GroupFlowNode[], nodes: readonly FlowNode[], ids: readonly string[]): GroupFlowNode[] {
  let next = frames;
  for (const id of ids) {
    const node = nodes.find((n) => n.id === id);
    if (!node) continue;
    const rect = nodeRect(node);
    const target = groupAt(next.map(asGroup), centerOf(rect));
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
  }
  return next;
}

/** After a frame was resized: nodes now inside it (and in no other group) join, members now outside leave. */
export function refitMembers(frames: GroupFlowNode[], nodes: readonly FlowNode[], frameId: string): GroupFlowNode[] {
  const frame = frames.find((f) => f.id === frameId);
  if (!frame || frame.data.collapsed) return frames;
  const groups = frames.map(asGroup);
  const elsewhere = new Set(frames.filter((f) => f.id !== frameId).flatMap((f) => f.data.nodeIds));
  const nodeIds = nodes.filter((n) => !elsewhere.has(n.id) && !n.hidden && groupAt(groups, centerOf(nodeRect(n)))?.id === frameId).map((n) => n.id);
  if (nodeIds.length === frame.data.nodeIds.length && nodeIds.every((id) => frame.data.nodeIds.includes(id))) return frames;
  return frames.map((f) => (f.id === frameId ? withData(f, { nodeIds }) : f));
}

/** Frames fitted around their members again (after the graph was laid out anew). Empty frames stay where they are. */
export function refitFrames(frames: GroupFlowNode[], nodes: readonly FlowNode[]): GroupFlowNode[] {
  return frames.map((f) => {
    const rect = frameAround(nodes.filter((n) => f.data.nodeIds.includes(n.id)).map(nodeRect));
    return rect ? { ...f, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height } : f;
  });
}

function frameRect(frame: GroupFlowNode): Rect {
  return { x: frame.position.x, y: frame.position.y, width: frame.width ?? 0, height: frame.height ?? 0 };
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What screen readers announce for a frame. */
export function frameLabel(data: GroupData): string {
  return `Group ${data.name || DEFAULT_GROUP_NAME}, ${plural(data.nodeIds.length, 'node')}${data.collapsed ? ', collapsed' : ''}`;
}

/**
 * What React Flow draws: frames under the notes under the nodes. Members of a collapsed group are hidden and their
 * connections to the rest of the workflow are drawn to the group's box instead (one line per box, node and port,
 * however many connections it stands for); connections inside the group disappear with it. Without collapsed groups
 * the store's arrays pass through unchanged.
 */
export function canvasGraph(
  frames: readonly GroupFlowNode[],
  stickies: readonly StickyFlowNode[],
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
): { nodes: (GroupFlowNode | StickyFlowNode | FlowNode)[]; edges: (FlowEdge | GroupProxyEdge)[] } {
  // The frame's body lets the pointer through (to the canvas and the nodes on it); its header and box take it (GroupNodeView).
  const shownFrames = frames.map((f) =>
    f.data.collapsed
      ? { ...f, width: GROUP_COLLAPSED_SIZE.width, height: GROUP_COLLAPSED_SIZE.height, ariaLabel: frameLabel(f.data), style: { ...f.style, pointerEvents: 'none' as const } }
      : { ...f, ariaLabel: frameLabel(f.data), style: { ...f.style, pointerEvents: 'none' as const } },
  );
  const hiddenIn = new Map<string, string>();
  for (const f of frames) if (f.data.collapsed) for (const id of f.data.nodeIds) hiddenIn.set(id, f.id);
  if (!hiddenIn.size) return { nodes: [...shownFrames, ...stickies, ...nodes], edges: edges as FlowEdge[] };

  const shownNodes = nodes.map((n) => (hiddenIn.has(n.id) ? { ...n, hidden: true, selected: false } : n));
  const shownEdges: (FlowEdge | GroupProxyEdge)[] = [];
  const proxies = new Map<string, GroupProxyEdge>();
  for (const edge of edges) {
    const fromGroup = hiddenIn.get(edge.source);
    const toGroup = hiddenIn.get(edge.target);
    if (!fromGroup && !toGroup) {
      shownEdges.push(edge);
      continue;
    }
    if (fromGroup && fromGroup === toGroup) continue;
    const type = edge.data?.connectionType ?? 'main';
    const main = type === 'main';
    const source = fromGroup ?? edge.source;
    const target = toGroup ?? edge.target;
    const sourceHandle = fromGroup ? (main ? GROUP_HANDLES.out : GROUP_HANDLES.aiOut) : (edge.sourceHandle ?? null);
    const targetHandle = toGroup ? (main ? GROUP_HANDLES.in : GROUP_HANDLES.aiIn) : (edge.targetHandle ?? null);
    const id = `proxy:${source}:${sourceHandle}:${target}:${targetHandle}`;
    const existing = proxies.get(id);
    if (existing) {
      proxies.set(id, { ...existing, data: { connectionType: type, count: (existing.data?.count ?? 1) + 1 } });
      continue;
    }
    proxies.set(id, {
      id,
      type: 'groupProxy',
      source,
      target,
      sourceHandle,
      targetHandle,
      selectable: false,
      deletable: false,
      focusable: false,
      data: { connectionType: type, count: 1 },
    });
  }
  return { nodes: [...shownFrames, ...stickies, ...shownNodes], edges: [...shownEdges, ...proxies.values()] };
}
