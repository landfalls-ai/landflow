'use client';
/**
 * Editor state. The canvas works on React Flow nodes/edges; `toWorkflow()`
 * turns them back into the engine's Workflow document. Handle ids encode the
 * port as "<connectionType>:<indexAmongPortsOfThatType>".
 *
 * Sticky notes are React Flow nodes too, but they live in `stickies`, apart
 * from `nodes`: the engine never sees them and everything that reads
 * `node.data.wf` keeps working. Canvas edits go through `record()`, which keeps
 * an undo history (drags and typing coalesce into one step). The workflow's name,
 * tags and settings share that history: one step per rename (committed on blur or
 * Enter), per tag added or removed and per Save of the settings dialog.
 *
 * Canvas groups (`groups`, React Flow nodes of type `frame`, see ./groups.ts) work the same way: frames behind the
 * nodes, saved as `workflow.groups`. Moving a frame moves what is inside it, and nodes and frames dropped into or out
 * of a frame join or leave it (groups nest).
 */
import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { defaultParameters, defaultVersionOf, portParameters, withPropertyDefaults } from '@landflow/protocol';
import type { NodeProgress } from '@/lib/client/node-progress';
import { edgeCountsOf, statusesOf, waitSummary, withWaiting, type NodeStatus, type WaitInfo } from '@/lib/client/run-data';
import type { FlowTemplate } from '@/lib/client/templates';
import type {
  ConnectionType,
  ExecutionEvent,
  GroupComposite,
  ExecutionRecord,
  ExecutionState,
  NodeItem,
  NodeRun,
  NodeTypeInfo,
  PauseReason,
  StickyNote,
  Workflow,
  WorkflowNode,
  WorkflowSettings,
} from '@/lib/shared/types';
import { STICKY_DEFAULT_CONTENT, STICKY_DEFAULT_SIZE } from '../canvas/sticky-note';
import { preparePaste, remapReferences, selectionOrigin, serializeSelection, type ClipboardData } from './clipboard';
import { GROUP_NAME_MAX, NODE_TILE, NODE_WIDE_TILE, ancestorsOf, clearSpot, descendantGroupIds, descendantNodeIds, nodeBox, normalizeGroups } from '@/lib/shared/groups';
import { autoBind, bindSlot, compositeLookup, compositeOfNode, instantiateComposite, unbindSlot, type CompositeFix, type CompositeTypeInfo } from '@/lib/shared/composites';
import {
  adoptFrames,
  adoptNodes,
  fromFrames,
  groupAround,
  hiddenFrameIds,
  hiddenNodeIds,
  linksOf,
  memberMoves,
  nextGroupName,
  refitFrames,
  refitMembers,
  removeFrames,
  toFrames,
  withoutMembers,
  type GroupData,
  type GroupFlowNode,
} from './groups';

/** Tidy up: the space between columns (a square tile's column is 280px, as before). */
const TIDY_GAP_X = 280 - NODE_TILE;
/** Tidy up: from one sub-node to the next under their parent, wider than a sub-node's name. */
const SUBNODE_PITCH = 170;

export type { NodeRunState, NodeStatus } from '@/lib/client/run-data';
export type { GroupData, GroupFlowNode } from './groups';

export interface FlowNodeData extends Record<string, unknown> {
  wf: Omit<WorkflowNode, 'position'>;
}
export interface FlowEdgeData extends Record<string, unknown> {
  connectionType: ConnectionType;
}
export type FlowNode = Node<FlowNodeData, 'lf'>;
export type FlowEdge = Edge<FlowEdgeData, 'lf'>;
export interface StickyData extends Record<string, unknown> {
  /** Markdown. */
  content: string;
  /** Index into STICKY_COLORS. */
  color: number;
}
export type StickyFlowNode = Node<StickyData, 'sticky'>;
/** Everything React Flow draws: group frames and notes first, so they sit under the nodes. */
export type CanvasNode = FlowNode | StickyFlowNode | GroupFlowNode;

/** Notes sit under nodes and edges; a selected note (z + 1000) still stays under unselected nodes' edges. */
export const STICKY_Z = -1000;

export interface PausedAt {
  nodeId: string;
  nodeName: string;
  reason: PauseReason;
  inputs: NodeItem[][];
}

/** Which execution's data the canvas is showing, when it is not the run that just happened. */
export interface ViewedExecution {
  id: string;
  status: ExecutionRecord['status'];
  startedAt: string;
}

export interface LogLine {
  id: string;
  at: string;
  nodeId?: string;
  nodeName?: string;
  kind: 'start' | 'finish' | 'error' | 'log' | 'info' | 'pause';
  source?: string;
  message: string;
  durationMs?: number;
  offsetMs: number;
}

export interface PaletteRequest {
  /** Restrict to nodes that can attach to this port type. */
  connectionType?: ConnectionType | 'trigger';
  /** Auto-connect the new node to this node/handle. */
  from?: { nodeId: string; handleId: string; handleType: 'source' | 'target' };
  /** Split this edge: the new node goes between its two ends. */
  insertInto?: string;
  position?: { x: number; y: number };
  /** Fill a composite's slot (docs/composites.md): offer only the nodes it accepts, put the new one in the frame and bind it. */
  slot?: { groupId: string; slot: string };
}

/** What the toolbar, node toolbars and the node panel can ask the editor to run. */
/** `by: 'spotlight'`: Spotlight asked for the run, so its timeline reports it, not a toast. */
export type RunCommand = { kind: 'run'; by?: 'spotlight' } | { kind: 'debug' } | { kind: 'node'; nodeId: string; scope: 'from' | 'only' };

interface EditorState {
  workflowId: string;
  name: string;
  description?: string;
  active: boolean;
  tags: string[];
  /** Workflow settings (error workflow, time zone, timeout, callers, saved executions). */
  settings: WorkflowSettings;
  nodes: FlowNode[];
  edges: FlowEdge[];
  stickies: StickyFlowNode[];
  /** Canvas groups: frames around nodes (./groups.ts). */
  groups: GroupFlowNode[];
  /** Undo / redo depth, for the toolbar buttons. */
  history: { past: number; future: number };
  /** Counts every recorded edit, undo and redo: whether the graph changed since a moment (Spotlight's Undo all fixes). */
  edits: number;
  nodeTypes: Record<string, NodeTypeInfo>;
  /** Composite types (GET /api/composites): the contracts composite frames are checked against. */
  composites: CompositeTypeInfo[];
  dirty: boolean;
  openNodeId?: string;
  palette?: PaletteRequest;
  /** Node id → fixed output used instead of running it (n8n pin data). */
  pinData: Record<string, NodeItem[]>;
  /** The node added last: new nodes chain onto it, and it pops in. */
  lastAddedId?: string;

  running: boolean;
  /** A run going on without this page's stream (the editor was reloaded mid-run), followed through the live events (follow-run.ts). */
  following?: string;
  /** The current run was started in debug mode. */
  debugging: boolean;
  paused?: PausedAt;
  /** Node ids the debugger stops before. Kept per workflow in localStorage. */
  breakpoints: string[];
  viewing?: ViewedExecution;
  /** Set by <Editor>; lets nodes and panels start runs. */
  run?: (command: RunCommand) => void;
  /** Set by <Editor>: save the draft (false when it couldn't). Spotlight saves before it publishes. */
  save?: () => Promise<boolean>;
  /** Execution whose data is on the canvas (the live run, or one opened from history). */
  executionId?: string;
  executionStartedAt?: number;
  /** Server clock at execution.started — timeline offsets are measured from it. */
  serverStartedAt?: number;
  /** Time spent paused in the debugger, left out of timeline offsets. */
  pausedMs: number;
  pausedSince?: number;
  statuses: Record<string, NodeStatus>;
  runs: Record<string, NodeRun[]>;
  edgeCounts: Record<string, number>;
  flowing: Record<string, number>;
  /** The latest `node.progress` of each node running now: its caption on the canvas, a team's working member. */
  progress: Record<string, NodeProgress>;
  log: LogLine[];
  /** Outcome of the run on the canvas, for the logs header. */
  runStatus?: ExecutionState;
  /** A waiting run on the canvas: what it waits for (its node is marked `waiting`). */
  wait?: WaitInfo;
  runStartedAt?: string;
  runDurationMs?: number;

  load(workflow: Workflow, nodeTypes: NodeTypeInfo[]): void;
  setNodeTypes(nodeTypes: NodeTypeInfo[]): void;
  setComposites(composites: CompositeTypeInfo[]): void;
  /** React Flow changes for nodes and notes alike; they are routed by id. */
  onNodesChange(changes: NodeChange<CanvasNode>[]): void;
  onEdgesChange(changes: EdgeChange<FlowEdge>[]): void;
  onConnect(connection: Connection): void;
  addNode(type: string, position: { x: number; y: number }, connectFrom?: PaletteRequest['from']): string | undefined;
  /** Add a node from the node creator: placed, wired and (for edge splits) inserted. */
  placeNode(type: string, request: PaletteRequest, fallback: { x: number; y: number }): string | undefined;
  setPinData(nodeId: string, items?: NodeItem[]): void;
  /** Drop a starter flow onto the canvas (fresh ids, defaults filled in). */
  applyTemplate(template: FlowTemplate, origin?: { x: number; y: number }): void;
  /** Swap in an edited copy of toWorkflow() (assistant changes), keeping run data; `focus` gets selected. Returns an undo. */
  replaceGraph(workflow: Workflow, focus?: { id: string; added: boolean }): () => void;
  /** Lay the graph out left to right in columns, sub-nodes under their parents. */
  tidyUp(): void;
  updateNode(id: string, patch: Partial<Omit<WorkflowNode, 'id' | 'position'>>): void;
  /** Rename a node and point `$('Old')` references in every node at the new name. False when the name is empty or taken. */
  renameNode(id: string, name: string): boolean;
  /** Remove nodes and/or sticky notes by id. */
  removeNodes(ids: string[]): void;
  duplicateNode(id: string): void;
  /** ⌘D: copy the selected nodes, notes and the connections between them next to the originals. */
  duplicateSelection(): void;
  /** The selection as clipboard data (undefined when nothing is selected). */
  copySelection(): ClipboardData | undefined;
  /** Add clipboard data: fresh ids, unique names, at `at` (top-left corner) or offset from the original positions. Returns the number of nodes and notes. */
  paste(data: ClipboardData, at?: { x: number; y: number }): number;
  /** Import a whole workflow into this one (to the right of what is already on the canvas). */
  mergeWorkflow(workflow: Pick<Workflow, 'nodes' | 'connections' | 'stickyNotes' | 'pinData' | 'groups'>): number;
  addSticky(position: { x: number; y: number }): string;
  updateSticky(id: string, patch: Partial<StickyData>): void;
  /** ⌘A: select every visible node and sticky note (not the frames, so ⌘G can group them). */
  selectAll(): void;
  /** ⌘G: a frame around the selected nodes and frames (nodes leave other groups, frames nest in it). Returns the group id. */
  groupSelection(): string | undefined;
  /**
   * ⇧⌘G: remove frames, keeping their nodes (selected afterwards) and nested groups, which go to the group around the
   * removed one. Defaults to the selected groups, else those of the selected nodes.
   */
  ungroup(ids?: string[]): void;
  /** Rename, recolour, collapse or expand a group; type it by a composite, or (`composite: undefined`) make it plain again. */
  updateGroup(id: string, patch: Partial<Pick<GroupData, 'name' | 'color' | 'collapsed' | 'composite'>>): void;
  /** A new frame of a composite type at `at` (its top-left corner), with the type's starter nodes. Returns the group id. */
  insertComposite(type: string, at: { x: number; y: number }): string | undefined;
  /** Bind a member of a composite to a slot, or (`slot` undefined) to none. */
  bindSlotOf(groupId: string, id: string, slot?: string): void;
  /** Apply the fix a composite issue offers. */
  fixComposite(groupId: string, fix: CompositeFix): void;
  undo(): void;
  redo(): void;
  /** Rename (one undo step per rename: typing coalesces until commitName()), describe, or set the tags (one step per change). */
  setMeta(patch: Partial<Pick<EditorState, 'name' | 'description' | 'active' | 'tags'>>): void;
  /** The settings dialog's Save: one undo step (none when nothing changed). */
  setSettings(settings: WorkflowSettings): void;
  /** The title lost focus or got Enter: the rename is done, the next one is a new undo step (a name typed back to the old one leaves none). */
  commitName(): void;
  openNode(id?: string): void;
  openPalette(request?: PaletteRequest): void;
  markSaved(): void;
  toggleBreakpoint(id: string): void;
  startRun(debug?: boolean): void;
  applyEvent(event: ExecutionEvent): void;
  finishRun(): void;
  loadExecution(record: ExecutionRecord, viewing?: boolean): void;
  /** Show a run that goes on without this page's stream, with the nodes `progress` names as running, and follow it. */
  attachRun(record: ExecutionRecord, progress?: Record<string, NodeProgress>, viewing?: boolean): void;
  clearRun(): void;
  toWorkflow(): Workflow;
}

export function handleId(type: ConnectionType, index: number) {
  return `${type}:${index}`;
}
export function parseHandle(id?: string | null): { type: ConnectionType; index: number } {
  const [type, index] = (id ?? 'main:0').split(':');
  return { type: type as ConnectionType, index: Number(index ?? 0) };
}

function uniqueName(base: string, nodes: FlowNode[]) {
  const names = new Set(nodes.map((n) => n.data.wf.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function toStickies(notes: StickyNote[] = []): StickyFlowNode[] {
  return notes.map((note) => ({
    id: note.id,
    type: 'sticky',
    position: { x: note.position[0], y: note.position[1] },
    width: note.width,
    height: note.height,
    zIndex: STICKY_Z,
    data: { content: note.content, color: note.color ?? 0 },
  }));
}

function fromStickies(stickies: StickyFlowNode[]): StickyNote[] {
  return stickies.map((s) => ({
    id: s.id,
    content: s.data.content,
    position: [Math.round(s.position.x), Math.round(s.position.y)],
    width: Math.round(s.width ?? s.measured?.width ?? STICKY_DEFAULT_SIZE.width),
    height: Math.round(s.height ?? s.measured?.height ?? STICKY_DEFAULT_SIZE.height),
    ...(s.data.color ? { color: s.data.color } : {}),
  }));
}

function toFlow(workflow: Pick<Workflow, 'nodes' | 'connections'>): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = workflow.nodes.map(({ position, ...wf }) => ({
    id: wf.id,
    type: 'lf',
    position: { x: position[0], y: position[1] },
    data: { wf },
  }));
  const edges: FlowEdge[] = workflow.connections.map((c) => ({
    id: c.id,
    type: 'lf',
    source: c.source,
    target: c.target,
    sourceHandle: handleId(c.type, c.type === 'main' ? c.sourceIndex : 0),
    // Sub-node slots are indexed too (an agent's Fallback Model is ai_languageModel 1).
    targetHandle: handleId(c.type, c.targetIndex ?? 0),
    data: { connectionType: c.type },
  }));
  return { nodes, edges };
}

const emptyRun = {
  running: false,
  following: undefined,
  debugging: false,
  paused: undefined,
  viewing: undefined,
  executionId: undefined,
  serverStartedAt: undefined,
  pausedMs: 0,
  pausedSince: undefined,
  statuses: {},
  runs: {},
  edgeCounts: {},
  flowing: {},
  progress: {} as Record<string, NodeProgress>,
  log: [] as LogLine[],
  runStatus: undefined,
  wait: undefined,
  runStartedAt: undefined,
  runDurationMs: undefined,
};

// ---- undo history ---------------------------------------------------------
// Snapshots hold references: every edit replaces arrays and objects instead of mutating them, so they stay valid.

interface Snapshot {
  nodes: FlowNode[];
  edges: FlowEdge[];
  stickies: StickyFlowNode[];
  groups: GroupFlowNode[];
  pinData: Record<string, NodeItem[]>;
  name: string;
  description?: string;
  tags: string[];
  settings: WorkflowSettings;
}
const HISTORY_LIMIT = 100;
/** `saved`: savedContent() of the last save (or load), so undo / redo back to it is not "Unsaved". */
const history = { past: [] as Snapshot[], future: [] as Snapshot[], last: undefined as { key: string; at: number } | undefined, batch: 0, dragging: false, resizing: false, saved: '' };

const snapshotOf = (s: Snapshot): Snapshot => ({ nodes: s.nodes, edges: s.edges, stickies: s.stickies, groups: s.groups, pinData: s.pinData, name: s.name, description: s.description, tags: s.tags, settings: s.settings });

/** What saving a snapshot writes, without selection and measurements. */
const savedContent = (s: Snapshot) =>
  JSON.stringify([
    s.name,
    s.description ?? '',
    s.tags,
    s.settings,
    s.pinData,
    s.nodes.map((n) => [n.data.wf, Math.round(n.position.x), Math.round(n.position.y)]),
    s.edges.map((e) => [e.id, e.source, e.sourceHandle, e.target, e.targetHandle]),
    fromStickies(s.stickies),
    fromFrames(s.groups, s.nodes),
  ]);

const unselect = <T extends { selected?: boolean }>(list: T[]) => list.map((item) => (item.selected ? { ...item, selected: false } : item));

const breakpointKey = (workflowId: string) => `landflow-breakpoints:${workflowId}`;

function readBreakpoints(workflowId: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(breakpointKey(workflowId)) ?? '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeBreakpoints(workflowId: string, ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(breakpointKey(workflowId), JSON.stringify(ids));
    else localStorage.removeItem(breakpointKey(workflowId));
  } catch {}
}

export const useEditor = create<EditorState>((set, get) => {
  /**
   * Save the canvas as an undo step before an edit. Edits with the same `key` within `windowMs` share one step (a drag,
   * typing into one node's parameters), and nested edits inside batch() count once.
   */
  const record = (key?: string, windowMs = 1200) => {
    if (history.batch) return;
    const now = Date.now();
    if (key && history.last?.key === key && now - history.last.at < windowMs) {
      history.last.at = now;
      return;
    }
    history.past.push(snapshotOf(get()));
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future = [];
    history.last = key ? { key, at: now } : undefined;
    set((s) => ({ history: { past: history.past.length, future: 0 }, edits: s.edits + 1 }));
  };
  const batch = <T,>(fn: () => T): T => {
    record();
    history.batch++;
    try {
      return fn();
    } finally {
      history.batch--;
    }
  };
  const restore = (snapshot: Snapshot) => {
    set((s) => ({
      nodes: unselect(snapshot.nodes),
      edges: snapshot.edges,
      stickies: unselect(snapshot.stickies),
      groups: unselect(snapshot.groups),
      pinData: snapshot.pinData,
      name: snapshot.name,
      description: snapshot.description,
      tags: snapshot.tags,
      settings: snapshot.settings,
      openNodeId: snapshot.nodes.some((n) => n.id === s.openNodeId) ? s.openNodeId : undefined,
      history: { past: history.past.length, future: history.future.length },
      edits: s.edits + 1,
      // Back at what was saved: "Saved" again.
      dirty: savedContent(snapshot) !== history.saved,
    }));
  };
  /** Add pasted / imported / duplicated elements, selected, with one undo step. */
  const addPlan = (plan: ReturnType<typeof preparePaste>) => {
    record();
    const flow = toFlow({ nodes: plan.nodes, connections: plan.connections });
    const stickies = toStickies(plan.stickyNotes);
    const frames = toFrames(plan.groups);
    // Pasted groups that came without their parent join the group they land in, like a dropped frame.
    const outer = frames.filter((f) => !f.data.parentId).map((f) => f.id);
    set((s) => ({
      nodes: [...unselect(s.nodes), ...flow.nodes.map((n) => ({ ...n, selected: true }))],
      edges: [...unselect(s.edges), ...flow.edges],
      stickies: [...unselect(s.stickies), ...stickies.map((n) => ({ ...n, selected: true }))],
      groups: adoptFrames([...unselect(s.groups), ...frames.map((n) => ({ ...n, selected: true }))], outer),
      pinData: { ...s.pinData, ...plan.pinData },
      lastAddedId: flow.nodes.at(-1)?.id ?? s.lastAddedId,
      dirty: true,
    }));
    return flow.nodes.length + stickies.length + frames.length;
  };
  const newId = (kind: 'node' | 'edge' | 'sticky' | 'group') => `${{ node: 'n', edge: 'e', sticky: 's', group: 'g' }[kind]}_${nanoid(8)}`;

  // ---- composites (docs/composites.md) ----
  const lookup = () => compositeLookup(get().nodeTypes, get().composites);
  const withComposite = (groups: GroupFlowNode[], id: string, composite: GroupComposite) => groups.map((g) => (g.id === id ? { ...g, data: { ...g.data, composite } } : g));
  /** Nodes bound to a locked slot (a type's required core step): they can't be deleted while the frame is typed. */
  const lockedIds = (): Set<string> => {
    const locked = new Set<string>();
    for (const frame of get().groups) {
      const composite = frame.data.composite;
      if (!composite) continue;
      const descriptor = lookup().composite(composite.type, composite.version) ?? lookup().composite(composite.type);
      for (const slot of descriptor?.slots ?? []) if (slot.locked) composite.slots[slot.name]?.forEach((id) => locked.add(id));
    }
    return locked;
  };
  /**
   * A node added for a composite's slot: it joins the frame, is bound to the slot, and is wired the way the type's
   * `feeds` rules say (a chat model to the reasoner's model input, say).
   */
  const fillSlot = (groupId: string, slot: string, nodeId: string) => {
    const frame = get().groups.find((g) => g.id === groupId);
    const composite = frame?.data.composite;
    if (!frame || !composite) return;
    set((s) => {
      // It joins the group it was placed in (the frame grows to fit it, like a dropped node); placed elsewhere, the frame takes it.
      let groups = adoptNodes(s.groups, s.nodes, [nodeId]);
      const holder = groups.find((g) => g.data.nodeIds.includes(nodeId));
      const inside = holder && (holder.id === groupId || ancestorsOf(linksOf(groups), holder.id).includes(groupId));
      if (!inside) groups = groups.map((g) => (g.id === groupId ? { ...g, data: { ...g.data, nodeIds: [...g.data.nodeIds, nodeId] } } : g.id === holder?.id ? { ...g, data: { ...g.data, nodeIds: g.data.nodeIds.filter((n) => n !== nodeId) } } : g));
      return { groups: withComposite(groups, groupId, bindSlot(composite, slot, nodeId)) };
    });
    const descriptor = lookup().composite(composite.type, composite.version) ?? lookup().composite(composite.type);
    for (const rule of descriptor?.rules ?? []) {
      if (rule.rule !== 'feeds') continue;
      const via = rule.via ?? 'main';
      const pairs =
        rule.from === slot ? (composite.slots[rule.to] ?? []).map((target) => [nodeId, target]) : rule.to === slot ? (composite.slots[rule.from] ?? []).map((source) => [source, nodeId]) : [];
      for (const [source, target] of pairs) {
        if (get().edges.some((e) => e.source === source && e.target === target && e.data?.connectionType === via)) continue;
        get().onConnect({ source, sourceHandle: handleId(via, 0), target, targetHandle: handleId(via, 0) });
      }
    }
  };
  /** Nodes that just joined a frame bind to the slot they obviously fill (autoBind) in the composite they're now in. */
  const bindJoined = (groups: GroupFlowNode[], ids: readonly string[]): GroupFlowNode[] => {
    if (!groups.some((g) => g.data.composite)) return groups;
    let next = groups;
    for (const id of ids) {
      const s = get();
      const workflow = { nodes: s.nodes.map((n) => ({ ...n.data.wf, position: [0, 0] as [number, number] })), connections: s.toWorkflow().connections, groups: fromFrames(next, s.nodes) };
      const frame = compositeOfNode(workflow, id);
      const bound = frame && autoBind(workflow, frame.id, id, lookup());
      if (frame && bound) next = withComposite(next, frame.id, bound);
    }
    return next;
  };

  return {
  workflowId: '',
  name: '',
  active: false,
  tags: [],
  settings: {},
  nodes: [],
  edges: [],
  stickies: [],
  groups: [],
  history: { past: 0, future: 0 },
  edits: 0,
  nodeTypes: {},
  composites: [],
  dirty: false,
  pinData: {},
  breakpoints: [],
  ...emptyRun,

  load(workflow, nodeTypes) {
    Object.assign(history, { past: [], future: [], last: undefined, batch: 0, dragging: false, resizing: false, saved: '' });
    set({
      workflowId: workflow.id,
      name: workflow.name,
      description: workflow.description,
      active: Boolean(workflow.active),
      tags: workflow.tags ?? [],
      settings: workflow.settings ?? {},
      ...toFlow(workflow),
      stickies: toStickies(workflow.stickyNotes),
      groups: toFrames(normalizeGroups(workflow.groups, workflow.nodes.map((n) => n.id))),
      history: { past: 0, future: 0 },
      nodeTypes: Object.fromEntries(nodeTypes.map((t) => [t.type, t])),
      dirty: false,
      openNodeId: undefined,
      palette: undefined,
      pinData: workflow.pinData ?? {},
      lastAddedId: undefined,
      breakpoints: readBreakpoints(workflow.id).filter((id) => workflow.nodes.some((n) => n.id === id)),
      ...emptyRun,
    });
    history.saved = savedContent(get());
  },

  setNodeTypes(nodeTypes) {
    set({ nodeTypes: Object.fromEntries(nodeTypes.map((t) => [t.type, t])) });
  },

  setComposites(composites) {
    set({ composites });
  },

  onNodesChange(changes) {
    // One undo step per drag or resize gesture; deletes coalesce with the edge removals React Flow sends right after.
    const drag = changes.find((c) => c.type === 'position');
    if (drag?.type === 'position' && drag.dragging && !history.dragging) record();
    if (drag?.type === 'position') history.dragging = Boolean(drag.dragging);
    const resize = changes.find((c) => c.type === 'dimensions' && c.resizing !== undefined);
    if (resize?.type === 'dimensions' && resize.resizing && !history.resizing) record();
    if (resize?.type === 'dimensions') history.resizing = Boolean(resize.resizing);
    if (changes.some((c) => c.type === 'remove')) record('remove', 80);

    // Nodes in a composite's locked slot stay (ungroup the frame, or remove its type, to delete them).
    if (changes.some((c) => c.type === 'remove')) {
      const locked = lockedIds();
      if (locked.size) changes = changes.filter((c) => c.type !== 'remove' || !locked.has(c.id));
    }
    // Ghosts (a change being built, ./building.tsx) are drawn beside the real nodes and are not in the store.
    changes = changes.filter((c) => !('id' in c && c.id.startsWith('n_ghost-')));
    if (!changes.length) return;
    const stickyIds = new Set(get().stickies.map((n) => n.id));
    const frameIds = new Set(get().groups.map((n) => n.id));
    const isSticky = (c: NodeChange<CanvasNode>) => ('id' in c ? stickyIds.has(c.id) : c.item.type === 'sticky');
    const isFrame = (c: NodeChange<CanvasNode>) => ('id' in c ? frameIds.has(c.id) : c.item.type === 'frame');
    const forNotes = changes.filter(isSticky) as NodeChange<StickyFlowNode>[];
    const forFrames = changes.filter(isFrame) as NodeChange<GroupFlowNode>[];
    const forNodes = changes.filter((c) => !isSticky(c) && !isFrame(c)) as NodeChange<FlowNode>[];
    const meaningful = changes.some((c) => c.type === 'position' || c.type === 'remove' || c.type === 'add' || (c.type === 'dimensions' && c.resizing !== undefined));
    // Groups: a moved frame takes what is inside it along; dropped nodes and frames join or leave groups; a resized
    // frame refits its members; a removed frame hands what it held to the group around it.
    const moves = forFrames.length ? memberMoves(get().groups, get().nodes, changes) : { nodes: [], frames: [] };
    const dropped = forNodes.flatMap((c) => (c.type === 'position' && c.dragging === false ? [c.id] : []));
    const droppedFrames = forFrames.flatMap((c) => (c.type === 'position' && c.dragging === false ? [c.id] : []));
    const resized = forFrames.flatMap((c) => (c.type === 'dimensions' && c.resizing === false ? [c.id] : []));
    const removed = new Set(forNodes.flatMap((c) => (c.type === 'remove' ? [c.id] : [])));
    const removedFrames = new Set(forFrames.flatMap((c) => (c.type === 'remove' ? [c.id] : [])));
    const frameChanges = removedFrames.size ? forFrames.filter((c) => c.type !== 'remove') : forFrames;
    set((s) => {
      const nodes = forNodes.length || moves.nodes.length ? applyNodeChanges([...forNodes, ...moves.nodes], s.nodes) : s.nodes;
      let groups = frameChanges.length || moves.frames.length ? applyNodeChanges([...frameChanges, ...moves.frames], s.groups) : s.groups;
      if (removedFrames.size) groups = removeFrames(groups, removedFrames).frames;
      if (removed.size) groups = withoutMembers(groups, removed);
      if (dropped.length) groups = bindJoined(adoptNodes(groups, nodes, dropped), dropped);
      if (droppedFrames.length) groups = adoptFrames(groups, droppedFrames);
      for (const id of resized) groups = refitMembers(groups, nodes, id);
      return {
        ...(nodes !== s.nodes && { nodes }),
        ...(forNotes.length && { stickies: applyNodeChanges(forNotes, s.stickies) }),
        ...(groups !== s.groups && { groups }),
        dirty: s.dirty || meaningful,
      };
    });
  },

  onEdgesChange(changes) {
    const meaningful = changes.some((c) => c.type === 'remove' || c.type === 'add');
    if (meaningful) record('remove', 80);
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges), dirty: s.dirty || meaningful }));
  },

  onConnect(connection) {
    const source = parseHandle(connection.sourceHandle);
    const target = parseHandle(connection.targetHandle);
    if (source.type !== target.type) return;
    record();
    set((s) => {
      // Respect maxConnections on the target port.
      const targetNode = s.nodes.find((n) => n.id === connection.target);
      const descriptor = targetNode && s.nodeTypes[targetNode.data.wf.type]?.descriptor;
      const port = descriptor?.inputs.filter((p) => p.type === target.type)[target.index];
      let edges = s.edges;
      if (port?.maxConnections) {
        const existing = edges.filter((e) => e.target === connection.target && e.targetHandle === connection.targetHandle);
        if (existing.length >= port.maxConnections) edges = edges.filter((e) => e.id !== existing[0].id);
      }
      return {
        edges: addEdge({ ...connection, id: `e_${nanoid(8)}`, type: 'lf', data: { connectionType: source.type } }, edges),
        dirty: true,
      };
    });
  },

  addNode(type, position, connectFrom) {
    const info = get().nodeTypes[type];
    if (!info) return undefined;
    return batch(() => {
    const id = `n_${nanoid(8)}`;
    // Added from a sub-node slot: switch to the mode that shows the matching output (a vector store on a Tool slot → “As Tool”).
    const slotType = connectFrom?.handleType === 'target' ? parseHandle(connectFrom.handleId).type : undefined;
    const slotPort = slotType && slotType !== 'main' ? info.descriptor.outputs.find((p) => p.type === slotType) : undefined;
    const node: FlowNode = {
      id,
      type: 'lf',
      position,
      data: {
        wf: {
          id,
          name: uniqueName(info.descriptor.displayName, get().nodes),
          type,
          typeVersion: defaultVersionOf(info.descriptor),
          parameters: slotPort?.displayOptions ? withPropertyDefaults(info.descriptor.properties, portParameters(slotPort)) : defaultParameters(info.descriptor),
        },
      },
      selected: true,
    };
    set((s) => ({ nodes: [...unselect(s.nodes), node], stickies: unselect(s.stickies), dirty: true, lastAddedId: id }));
    if (connectFrom) {
      const fromHandle = parseHandle(connectFrom.handleId);
      const descriptor = info.descriptor;
      if (connectFrom.handleType === 'source') {
        // existing node output → new node input of the same type
        const index = descriptor.inputs.filter((p) => p.type === fromHandle.type).length ? 0 : -1;
        if (index >= 0) get().onConnect({ source: connectFrom.nodeId, sourceHandle: connectFrom.handleId, target: id, targetHandle: handleId(fromHandle.type, 0) });
      } else {
        // new sub-node (or upstream node) output → existing node input
        const hasOutput = descriptor.outputs.some((p) => p.type === fromHandle.type) || (fromHandle.type === 'ai_tool' && descriptor.usableAsTool);
        if (hasOutput) {
          const sourceHandle = descriptor.outputs.some((p) => p.type === fromHandle.type) ? handleId(fromHandle.type, 0) : handleId('ai_tool', 0);
          get().onConnect({ source: id, sourceHandle, target: connectFrom.nodeId, targetHandle: connectFrom.handleId });
        }
      }
    }
    return id;
    });
  },

  placeNode(type, request, fallback) {
    const state = get();
    const info = state.nodeTypes[type];
    if (!info) return undefined;
    return batch(() => {
    const from = request.from;
    const anchor = from && state.nodes.find((n) => n.id === from.nodeId);
    const split = request.insertInto ? state.edges.find((e) => e.id === request.insertInto) : undefined;
    let position = request.position;
    if (!position && anchor && from) {
      const handle = parseHandle(from.handleId);
      if (from.handleType === 'target' && handle.type !== 'main') {
        // Sub-node: under the parent's port, next to its siblings.
        const siblings = state.edges.filter((e) => e.target === anchor.id && e.data?.connectionType !== 'main').length;
        position = { x: anchor.position.x + siblings * 110, y: anchor.position.y + 190 };
      } else {
        // Next step: one column to the right, branches fanned out by output index.
        const outputs = state.nodeTypes[anchor.data.wf.type]?.descriptor.outputs.filter((p) => p.type === 'main').length ?? 1;
        position = { x: anchor.position.x + 260, y: anchor.position.y + (handle.index - (outputs - 1) / 2) * 150 };
      }
    }
    position ??= fallback;
    // Don't drop it on top of another node.
    const taken = (p: { x: number; y: number }) => state.nodes.some((n) => Math.abs(n.position.x - p.x) < 120 && Math.abs(n.position.y - p.y) < 110);
    if (!split) for (let i = 0; i < 12 && taken(position); i++) position = { x: position.x, y: position.y + 140 };

    if (split) {
      // Make room: everything downstream of the split shifts one column right.
      const downstream = new Set<string>([split.target]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const e of get().edges) if (e.data?.connectionType === 'main' && downstream.has(e.source) && !downstream.has(e.target)) downstream.add(e.target), (grew = true);
      }
      set((s) => ({ nodes: s.nodes.map((n) => (downstream.has(n.id) ? { ...n, position: { x: n.position.x + 260, y: n.position.y } } : n)), edges: s.edges.filter((e) => e.id !== split.id) }));
      position = { x: (anchor?.position.x ?? position.x) + 260, y: anchor?.position.y ?? position.y };
    }
    const id = get().addNode(type, position, from);
    if (id && split && info.descriptor.inputs.some((p) => p.type === 'main') && info.descriptor.outputs.some((p) => p.type === 'main')) {
      get().onConnect({ source: id, sourceHandle: handleId('main', 0), target: split.target, targetHandle: split.targetHandle ?? handleId('main', 0) });
    }
    if (id && request.slot) fillSlot(request.slot.groupId, request.slot.slot, id);
    return id;
    });
  },

  setPinData(nodeId, items) {
    record();
    set((s) => {
      const pinData = { ...s.pinData };
      if (items) pinData[nodeId] = items;
      else delete pinData[nodeId];
      return { pinData, dirty: true };
    });
  },

  applyTemplate(template, origin = { x: 0, y: 0 }) {
    record();
    const { nodeTypes, nodes: existing } = get();
    const ids: Record<string, string> = {};
    const nodes: FlowNode[] = [];
    for (const t of template.nodes) {
      const info = nodeTypes[t.type];
      if (!info) continue;
      const id = `n_${nanoid(8)}`;
      ids[t.key] = id;
      nodes.push({
        id,
        type: 'lf',
        position: { x: origin.x + t.x, y: origin.y + t.y },
        data: {
          wf: {
            id,
            name: uniqueName(t.name, [...existing, ...nodes]),
            type: t.type,
            typeVersion: defaultVersionOf(info.descriptor),
            parameters: { ...defaultParameters(info.descriptor), ...t.parameters },
            ...(t.notes && { notes: t.notes }),
          },
        },
      });
    }
    const edges: FlowEdge[] = template.edges
      .filter(([from, to]) => ids[from] && ids[to])
      .map(([from, to, sourceIndex = 0, type = 'main']) => ({
        id: `e_${nanoid(8)}`,
        type: 'lf',
        source: ids[from],
        target: ids[to],
        sourceHandle: handleId(type, type === 'main' ? sourceIndex : 0),
        targetHandle: handleId(type, 0),
        data: { connectionType: type },
      }));
    const pinData = Object.fromEntries(Object.entries(template.pinData ?? {}).filter(([key]) => ids[key]).map(([key, items]) => [ids[key], items]));
    set((s) => ({
      nodes: [...s.nodes.map((n) => ({ ...n, selected: false })), ...nodes],
      edges: [...s.edges, ...edges],
      pinData: { ...s.pinData, ...pinData },
      lastAddedId: nodes.at(-1)?.id,
      dirty: true,
    }));
  },

  replaceGraph(workflow, focus) {
    record();
    const before = { nodes: get().nodes, edges: get().edges, pinData: get().pinData, groups: get().groups };
    const flow = toFlow(workflow);
    set((s) => {
      const oldNodes = new Map(s.nodes.map((n) => [n.id, n]));
      const oldEdges = new Map(s.edges.map((e) => [e.id, e]));
      const kept = new Set(flow.nodes.map((n) => n.id));
      return {
        groups: withoutMembers(s.groups, new Set(s.nodes.map((n) => n.id).filter((id) => !kept.has(id)))),
        nodes: flow.nodes.map((n) => {
          const old = oldNodes.get(n.id);
          const selected = focus ? n.id === focus.id : Boolean(old?.selected);
          return old ? { ...old, position: n.position, data: n.data, selected } : { ...n, selected };
        }),
        edges: flow.edges.map((e) => oldEdges.get(e.id) ?? e),
        pinData: workflow.pinData ?? {},
        ...(focus?.added && { lastAddedId: focus.id }),
        openNodeId: flow.nodes.some((n) => n.id === s.openNodeId) ? s.openNodeId : undefined,
        dirty: true,
      };
    });
    // Undoing is an edit too: ⌘Z afterwards goes back to before the undo.
    return () => {
      record();
      set({ ...before, dirty: true });
    };
  },

  tidyUp() {
    record();
    const { nodes, edges, nodeTypes } = get();
    const main = edges.filter((e) => e.data?.connectionType === 'main');
    const subEdges = edges.filter((e) => e.data?.connectionType !== 'main');
    const subIds = new Set(subEdges.map((e) => e.source));
    const flow = nodes.filter((n) => !subIds.has(n.id));
    // Column = longest path from a root.
    const column: Record<string, number> = {};
    const visit = (id: string, depth: number, seen: Set<string>) => {
      if (seen.has(id) || (column[id] ?? -1) >= depth) return;
      column[id] = depth;
      const next = new Set(seen).add(id);
      for (const e of main) if (e.source === id) visit(e.target, depth + 1, next);
    };
    for (const n of flow) if (!main.some((e) => e.target === n.id)) visit(n.id, 0, new Set());
    // A loop no root leads into starts from its first node.
    for (const n of flow) if (column[n.id] === undefined) visit(n.id, 0, new Set());
    // Rows: follow parents' order (and output index) so branches don't cross.
    const columns: string[][] = [];
    for (const n of flow) (columns[column[n.id]] ??= []).push(n.id);
    // A node sits level with its parents (a chain stays on one line), nodes in a column at least a row apart.
    const row: Record<string, number> = {};
    columns.forEach((ids, c) => {
      const parentsOf = (id: string) => (c === 0 ? [] : main.filter((e) => e.target === id && row[e.source] !== undefined));
      const key = (id: string) => {
        const parents = parentsOf(id);
        if (!parents.length) return nodes.find((n) => n.id === id)!.position.y;
        return parents.reduce((sum, e) => sum + row[e.source] + parseHandle(e.sourceHandle).index * 0.1, 0) / parents.length;
      };
      const sorted = ids.sort((a, b) => key(a) - key(b));
      const placed = sorted.some((id) => parentsOf(id).length);
      if (!placed) return sorted.forEach((id, i) => (row[id] = i - (ids.length - 1) / 2));
      // Wanted rows (a node without parents goes under the one before it), pushed apart, then the column shifted back by
      // the average push so siblings spread evenly around their parent.
      const wanted = sorted.map((id) => (parentsOf(id).length ? key(id) : undefined));
      const rows: number[] = [];
      sorted.forEach((_id, i) => {
        const want = wanted[i] ?? (i ? rows[i - 1] + 1 : 0);
        rows.push(i ? Math.max(want, rows[i - 1] + 1) : want);
      });
      const shift = rows.reduce((sum, r, i) => sum + r - (wanted[i] ?? r), 0) / rows.length;
      sorted.forEach((id, i) => (row[id] = Math.round((rows[i] - shift) * 2) / 2));
    });
    // Columns as wide as their widest node, with room between them for output names, the + and an edge's count: two
    // agents side by side used to sit 40px apart, their connection squeezed past the outputs' names.
    const widthOf = (n: FlowNode) => n.measured?.width ?? (nodeTypes[n.data.wf.type]?.descriptor.inputs.some((p) => p.type !== 'main') ? NODE_WIDE_TILE : NODE_TILE);
    const columnWidth = columns.map((ids) => Math.max(NODE_TILE, ...ids.map((id) => widthOf(nodes.find((n) => n.id === id)!))));
    const columnX = columnWidth.map((_w, c) => columnWidth.slice(0, c).reduce((x, w) => x + w + TIDY_GAP_X, 0));
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of flow) {
      const c = column[n.id];
      // Centred in its column, and square tiles keep the old 280px rhythm.
      positions[n.id] = { x: columnX[c] + (columnWidth[c] - widthOf(n)) / 2, y: row[n.id] * 170 };
    }
    // Sub-nodes in a row centred under their parent, far enough apart for their names (150px under a 64px circle).
    for (const parent of new Set(subEdges.map((e) => e.target))) {
      const children = [...new Set(subEdges.filter((e) => e.target === parent).map((e) => e.source))];
      const base = positions[parent];
      const node = nodes.find((n) => n.id === parent);
      if (!base || !node) continue;
      const left = base.x + widthOf(node) / 2 - ((children.length - 1) * SUBNODE_PITCH + 64) / 2;
      children.forEach((id, i) => (positions[id] = { x: left + i * SUBNODE_PITCH, y: base.y + 200 }));
    }
    set((s) => {
      const nodes = s.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n));
      return { nodes, groups: s.groups.length ? refitFrames(s.groups, nodes) : s.groups, dirty: true };
    });
  },

  updateNode(id, patch) {
    record(`node:${id}`, 1500);
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { wf: { ...n.data.wf, ...patch } } } : n)),
      dirty: true,
    }));
  },

  renameNode(id, name) {
    const next = name.trim();
    const old = get().nodes.find((n) => n.id === id)?.data.wf.name;
    if (old === undefined || !next) return false;
    if (next === old) return true;
    if (get().nodes.some((n) => n.id !== id && n.data.wf.name === next)) return false;
    record();
    set((s) => ({
      nodes: s.nodes.map((n) => {
        const wf = n.id === id ? { ...n.data.wf, name: next } : n.data.wf;
        return { ...n, data: { wf: { ...wf, parameters: remapReferences(wf.parameters, { [old]: next }) } } };
      }),
      dirty: true,
    }));
    return true;
  },

  removeNodes(ids) {
    const locked = lockedIds();
    const drop = new Set(ids.filter((id) => !locked.has(id)));
    if (!drop.size) return;
    record();
    if (get().breakpoints.some((id) => drop.has(id))) {
      const breakpoints = get().breakpoints.filter((id) => !drop.has(id));
      writeBreakpoints(get().workflowId, breakpoints);
      set({ breakpoints });
    }
    set((s) => ({
      nodes: s.nodes.filter((n) => !drop.has(n.id)),
      stickies: s.stickies.some((n) => drop.has(n.id)) ? s.stickies.filter((n) => !drop.has(n.id)) : s.stickies,
      groups: s.groups.length ? withoutMembers(removeFrames(s.groups, drop).frames, drop) : s.groups,
      edges: s.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target)),
      openNodeId: s.openNodeId && drop.has(s.openNodeId) ? undefined : s.openNodeId,
      pinData: Object.fromEntries(Object.entries(s.pinData).filter(([nodeId]) => !drop.has(nodeId))),
      dirty: true,
    }));
  },

  duplicateNode(id) {
    const data = serializeSelection(get().toWorkflow(), new Set([id]), new Set([id]), new Set([id]));
    if (data.nodes.length || data.stickyNotes.length || data.groups?.length) addPlan(preparePaste(data, { existingNames: get().nodes.map((n) => n.data.wf.name), offset: { x: 40, y: 60 }, newId }));
  },

  duplicateSelection() {
    const data = get().copySelection();
    if (data) addPlan(preparePaste(data, { existingNames: get().nodes.map((n) => n.data.wf.name), offset: { x: 40, y: 60 }, newId }));
  },

  copySelection() {
    const s = get();
    const nodeIds = new Set(s.nodes.filter((n) => n.selected).map((n) => n.id));
    const stickyIds = new Set(s.stickies.filter((n) => n.selected).map((n) => n.id));
    const groupIds = new Set(s.groups.filter((n) => n.selected).map((n) => n.id));
    if (!nodeIds.size && !stickyIds.size && !groupIds.size) return undefined;
    return serializeSelection(s.toWorkflow(), nodeIds, stickyIds, groupIds);
  },

  paste(data, at) {
    const existing = get().nodes.map((n) => n.data.wf.name);
    // Pasting where the copy came from: step down and right so the copy doesn't hide the original.
    let offset = { x: 40, y: 60 };
    if (!at) {
      const origin = selectionOrigin(data);
      const taken = (dx: number, dy: number) => get().nodes.some((n) => Math.abs(n.position.x - origin.x - dx) < 8 && Math.abs(n.position.y - origin.y - dy) < 8);
      for (let i = 1; i < 20 && taken(offset.x, offset.y); i++) offset = { x: 40 * (i + 1), y: 60 * (i + 1) };
    }
    return addPlan(preparePaste(data, { existingNames: existing, at, offset, newId }));
  },

  mergeWorkflow(workflow) {
    const s = get();
    const data: ClipboardData = {
      kind: 'landflow/nodes',
      version: 1,
      nodes: workflow.nodes,
      connections: workflow.connections,
      stickyNotes: workflow.stickyNotes ?? [],
      groups: workflow.groups,
      pinData: workflow.pinData,
    };
    // Next to what is already there, so the import doesn't land on top of it.
    const right = [...s.nodes.map((n) => n.position.x + 240), ...s.stickies.map((n) => n.position.x + (n.width ?? STICKY_DEFAULT_SIZE.width))];
    const top = [...s.nodes.map((n) => n.position.y), ...s.stickies.map((n) => n.position.y)];
    const at = right.length ? { x: Math.max(...right) + 120, y: Math.min(...top) } : undefined;
    return addPlan(preparePaste(data, { existingNames: s.nodes.map((n) => n.data.wf.name), at, offset: { x: 0, y: 0 }, newId }));
  },

  addSticky(position) {
    record();
    const id = newId('sticky');
    const [note] = toStickies([{ id, content: STICKY_DEFAULT_CONTENT, position: [Math.round(position.x), Math.round(position.y)], ...STICKY_DEFAULT_SIZE }]);
    set((s) => ({ stickies: [...unselect(s.stickies), { ...note, selected: true }], nodes: unselect(s.nodes), dirty: true }));
    return id;
  },

  updateSticky(id, patch) {
    record(`sticky:${id}:${Object.keys(patch).join(',')}`, 1500);
    set((s) => ({ stickies: s.stickies.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)), dirty: true }));
  },

  selectAll() {
    const hidden = hiddenNodeIds(get().groups);
    set((s) => ({
      nodes: s.nodes.map((n) => (n.hidden || n.selected || hidden.has(n.id) ? n : { ...n, selected: true })),
      stickies: s.stickies.map((n) => (n.selected ? n : { ...n, selected: true })),
      groups: unselect(s.groups),
    }));
  },

  groupSelection() {
    const s = get();
    const hiddenNodes = hiddenNodeIds(s.groups);
    const hiddenFrames = hiddenFrameIds(s.groups);
    const pickedNodes = s.nodes.filter((n) => n.selected && !n.hidden && !hiddenNodes.has(n.id)).map((n) => n.id);
    const pickedFrames = s.groups.filter((g) => g.selected && !hiddenFrames.has(g.id)).map((g) => g.id);
    const made = groupAround(unselect(s.groups), s.nodes, newId('group'), nextGroupName(s.groups), pickedNodes, pickedFrames);
    if (!made) return undefined;
    record();
    set((s) => ({
      groups: made.frames.map((g) => (g.id === made.frame.id ? { ...g, selected: true } : g)),
      nodes: unselect(s.nodes),
      stickies: unselect(s.stickies),
      dirty: true,
    }));
    return made.frame.id;
  },

  ungroup(ids) {
    const s = get();
    const selectedNodes = new Set(s.nodes.filter((n) => n.selected).map((n) => n.id));
    const selectedGroups = s.groups.filter((g) => g.selected).map((g) => g.id);
    const drop = new Set(ids ?? (selectedGroups.length ? selectedGroups : s.groups.filter((g) => g.data.nodeIds.some((id) => selectedNodes.has(id))).map((g) => g.id)));
    if (!s.groups.some((g) => drop.has(g.id))) return;
    record();
    const removed = removeFrames(s.groups, drop);
    const freed = new Set(removed.freed);
    set((s) => ({
      groups: removed.frames,
      nodes: s.nodes.map((n) => (freed.has(n.id) ? (n.selected ? n : { ...n, selected: true }) : n.selected ? { ...n, selected: false } : n)),
      stickies: unselect(s.stickies),
      dirty: true,
    }));
  },

  updateGroup(id, patch) {
    const frame = get().groups.find((g) => g.id === id);
    if (!frame) return;
    record(`group:${id}:${Object.keys(patch).join(',')}`, 1500);
    const next = { ...patch, ...(patch.name !== undefined && { name: patch.name.slice(0, GROUP_NAME_MAX) }) };
    // Collapsing hides what is inside (nested groups too), so none of it can stay selected.
    const links = linksOf(get().groups);
    const members = patch.collapsed ? new Set(descendantNodeIds(links, id)) : undefined;
    const inner = patch.collapsed ? new Set(descendantGroupIds(links, id)) : undefined;
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, data: { ...g.data, ...next } } : inner?.has(g.id) && g.selected ? { ...g, selected: false } : g)),
      ...(members && { nodes: s.nodes.map((n) => (members.has(n.id) && n.selected ? { ...n, selected: false } : n)) }),
      dirty: true,
    }));
  },

  insertComposite(type, at) {
    const info = get().composites.find((c) => c.type === type);
    if (!info) return undefined;
    return batch(() => {
      const s = get();
      const groupId = newId('group');
      const made = instantiateComposite(type, info.descriptor, at, { takenNames: s.nodes.map((n) => n.data.wf.name), newId: () => newId('node'), groupId });
      // A frame doesn't land on what is already there (or get nested into a frame by it): it moves down until it's clear.
      const [gx, gy] = made.group.position;
      const taken = [...s.nodes.map((n) => nodeBox(n.position, n.measured?.width && n.measured.height ? { width: n.measured.width, height: n.measured.height } : undefined)), ...s.groups.map((g) => ({ x: g.position.x, y: g.position.y, width: g.width ?? 0, height: g.height ?? 0 }))];
      const dy = clearSpot({ x: gx, y: gy, width: made.group.width, height: made.group.height }, taken).y - gy;
      made.group.position = [gx, gy + dy];
      for (const n of made.nodes) n.position = [n.position[0], n.position[1] + dy];
      // The starter gives what it sets; the rest of each node's parameters are its defaults.
      const nodes = made.nodes.map((n) => {
        const descriptor = s.nodeTypes[n.type]?.descriptor;
        return descriptor ? { ...n, typeVersion: info.descriptor.starter?.nodes.find((x) => x.type === n.type)?.typeVersion ?? defaultVersionOf(descriptor), parameters: { ...defaultParameters(descriptor), ...n.parameters } } : n;
      });
      const flow = toFlow({ nodes, connections: made.connections.map((c) => ({ ...c, id: newId('edge') })) });
      const [frame] = toFrames([made.group]);
      set((s) => ({
        nodes: [...unselect(s.nodes), ...flow.nodes],
        edges: [...s.edges, ...flow.edges],
        stickies: unselect(s.stickies),
        groups: adoptFrames([...unselect(s.groups), { ...frame, selected: true }], [frame.id]),
        lastAddedId: flow.nodes.at(-1)?.id ?? s.lastAddedId,
        dirty: true,
      }));
      return groupId;
    });
  },

  bindSlotOf(groupId, id, slot) {
    const composite = get().groups.find((g) => g.id === groupId)?.data.composite;
    if (!composite) return;
    record();
    set((s) => ({ groups: withComposite(s.groups, groupId, slot ? bindSlot(composite, slot, id) : unbindSlot(composite, id)), dirty: true }));
  },

  fixComposite(groupId, fix) {
    const composite = get().groups.find((g) => g.id === groupId)?.data.composite;
    if (!composite) return;
    if (fix.kind === 'onError') return get().updateNode(fix.nodeId, { onError: fix.value });
    if (fix.kind === 'unbind') return get().bindSlotOf(groupId, fix.id);
    record();
    set((s) => ({ groups: withComposite(s.groups, groupId, { ...composite, version: fix.version }), dirty: true }));
  },

  undo() {
    const previous = history.past.pop();
    if (!previous) return;
    history.future.push(snapshotOf(get()));
    history.last = undefined;
    restore(previous);
  },

  redo() {
    const next = history.future.pop();
    if (!next) return;
    history.past.push(snapshotOf(get()));
    history.last = undefined;
    restore(next);
  },

  setMeta(patch) {
    // The title is typed a key at a time: one step from the first key to commitName().
    if (patch.name !== undefined) record('meta:name', Infinity);
    else if (patch.tags || patch.description !== undefined) record();
    set({ ...patch, dirty: true });
  },

  setSettings(settings) {
    if (JSON.stringify(settings) === JSON.stringify(get().settings)) return;
    record();
    set({ settings, dirty: true });
  },

  commitName() {
    if (history.last?.key !== 'meta:name') return;
    history.last = undefined;
    // Typed back to the old name: drop the step.
    if (history.past.at(-1)?.name !== get().name) return;
    history.past.pop();
    set((s) => ({ history: { past: history.past.length, future: history.future.length }, dirty: savedContent(s) !== history.saved }));
  },

  openNode(id) {
    set({ openNodeId: id });
  },

  openPalette(request) {
    set({ palette: request });
  },

  markSaved() {
    history.saved = savedContent(get());
    set({ dirty: false });
  },

  toggleBreakpoint(id) {
    const { breakpoints, workflowId } = get();
    const next = breakpoints.includes(id) ? breakpoints.filter((b) => b !== id) : [...breakpoints, id];
    writeBreakpoints(workflowId, next);
    set({ breakpoints: next });
  },

  startRun(debug = false) {
    set({ ...emptyRun, running: true, debugging: debug, executionStartedAt: Date.now(), runStatus: 'running', runStartedAt: new Date().toISOString() });
  },

  applyEvent(event) {
    if (event.type === 'execution.started') set({ serverStartedAt: Date.parse(event.at) });
    if (event.type === 'execution.resumed') {
      const since = get().pausedSince;
      if (since !== undefined) set((s) => ({ pausedMs: s.pausedMs + (Date.parse(event.at) - since), pausedSince: undefined }));
    }
    const t0 = get().serverStartedAt ?? Date.parse(event.at);
    // Offsets use server timestamps so network latency doesn't skew the waterfall, minus time paused in the debugger.
    const end = event.type === 'node.finished' ? Date.parse(event.run.startedAt) + event.durationMs : Date.parse(event.at);
    const line = (l: Omit<LogLine, 'id' | 'at' | 'offsetMs'>): LogLine => ({ id: nanoid(6), at: event.at, offsetMs: Math.max(0, end - t0 - get().pausedMs), ...l });
    if (event.type === 'execution.paused') set({ pausedSince: Date.parse(event.at) });

    switch (event.type) {
      case 'execution.started':
        set((s) => ({ executionId: event.executionId, runStartedAt: event.at, log: [...s.log, line({ kind: 'info', message: `Execution ${event.executionId} started (${event.mode})` })] }));
        break;
      case 'execution.paused':
        set((s) => ({
          paused: { nodeId: event.nodeId, nodeName: event.nodeName, reason: event.reason, inputs: event.inputs },
          statuses: { ...s.statuses, [event.nodeId]: { ...s.statuses[event.nodeId], state: 'paused' } },
          log: [...s.log, line({ kind: 'pause', nodeId: event.nodeId, nodeName: event.nodeName, message: event.reason === 'breakpoint' ? 'paused at breakpoint' : 'paused (step)' })],
        }));
        break;
      case 'execution.resumed':
        set((s) => {
          const nodeId = s.paused?.nodeId;
          const statuses = { ...s.statuses };
          if (nodeId && statuses[nodeId]?.state === 'paused') statuses[nodeId] = { ...statuses[nodeId], state: 'idle' };
          return { paused: undefined, statuses, log: [...s.log, line({ kind: 'info', message: event.command === 'stop' ? 'stopped by debugger' : event.command })] };
        });
        break;
      case 'node.started':
        set((s) => ({
          statuses: { ...s.statuses, [event.nodeId]: { ...s.statuses[event.nodeId], state: 'running', startedAt: event.at } },
          log: [...s.log, line({ kind: 'start', nodeId: event.nodeId, nodeName: event.nodeName, source: event.source, message: event.source === 'main' ? 'started' : `${event.source} call` })],
        }));
        break;
      case 'node.finished': {
        set((s) => {
          const previous = s.statuses[event.nodeId];
          const status: NodeStatus = {
            state: event.status,
            itemCounts: event.itemCounts,
            durationMs: event.durationMs,
            error: event.run.error?.message,
            uses: event.source === 'main' ? undefined : (previous?.uses ?? 0) + 1,
            reused: Boolean(event.run.reused),
          };
          const edgeCounts = { ...s.edgeCounts };
          const flowing = { ...s.flowing };
          const now = Date.now();
          for (const edge of s.edges) {
            if (event.source === 'main' && edge.source === event.nodeId && edge.data?.connectionType === 'main') {
              const { index } = parseHandle(edge.sourceHandle);
              const count = event.itemCounts[index] ?? 0;
              edgeCounts[edge.id] = (edgeCounts[edge.id] ?? 0) + count;
              if (count > 0 && !event.run.reused) flowing[edge.id] = now;
            }
            if (event.source !== 'main' && edge.source === event.nodeId && edge.data?.connectionType !== 'main') {
              if (!event.run.reused) flowing[edge.id] = now;
              edgeCounts[edge.id] = (edgeCounts[edge.id] ?? 0) + 1;
            }
          }
          const { [event.nodeId]: _done, ...progress } = s.progress;
          return {
            statuses: { ...s.statuses, [event.nodeId]: status },
            progress,
            runs: { ...s.runs, [event.nodeId]: [...(s.runs[event.nodeId] ?? []), event.run] },
            edgeCounts,
            flowing,
            log: [
              ...s.log,
              line({
                kind: event.status === 'error' ? 'error' : 'finish',
                nodeId: event.nodeId,
                nodeName: event.nodeName,
                source: event.source,
                durationMs: event.durationMs,
                message: event.run.reused
                  ? 'reused from earlier run'
                  : event.status === 'error'
                    ? (event.run.error?.message ?? 'failed')
                    : `${event.itemCounts.map((c) => `${c} item${c === 1 ? '' : 's'}`).join(' · ') || 'done'}`,
              }),
            ],
          };
        });
        break;
      }
      case 'node.progress':
        set((s) => ({ progress: { ...s.progress, [event.nodeId]: { ...event, since: s.progress[event.nodeId]?.since ?? event.at } } }));
        break;
      case 'node.log':
        set((s) => ({ log: [...s.log, line({ kind: 'log', nodeId: event.nodeId, nodeName: s.nodes.find((n) => n.id === event.nodeId)?.data.wf.name, message: `${event.level}: ${event.message}` })] }));
        break;
      case 'execution.finished':
        set((s) => ({
          running: false,
          paused: undefined,
          progress: {},
          runStatus: event.status,
          runDurationMs: event.durationMs,
          // The node it waits at has no finished run yet: mark it, with what it waits for.
          ...(event.status === 'waiting' && event.wait
            ? { wait: event.wait, statuses: { ...s.statuses, [event.wait.nodeId]: { ...s.statuses[event.wait.nodeId], state: 'waiting' as const, wait: waitSummary(event.wait) } } }
            : { wait: undefined }),
          log: [
            ...s.log,
            line({
              kind: event.status === 'success' || event.status === 'waiting' ? 'info' : 'error',
              durationMs: event.durationMs,
              message:
                event.status === 'success'
                  ? `Finished successfully`
                  : event.status === 'waiting'
                    ? `Waiting at ${event.wait?.nodeName ?? 'a node'}${event.wait?.until ? ` until ${new Date(event.wait.until).toLocaleString()}` : ''}; it continues in the background`
                    : `Finished with ${event.status}: ${event.error?.message ?? ''}`,
            }),
          ],
        }));
        break;
    }
  },

  finishRun() {
    set((s) => {
      // A run that ends while paused leaves no node "paused".
      const statuses = Object.fromEntries(Object.entries(s.statuses).map(([id, st]) => [id, st.state === 'paused' || st.state === 'running' ? { ...st, state: 'idle' as const } : st]));
      // A stream that ended without execution.finished was aborted.
      const runStatus = s.runStatus === 'running' ? ('canceled' as const) : s.runStatus;
      const runDurationMs = s.runDurationMs ?? (s.runStartedAt ? Date.now() - Date.parse(s.runStartedAt) : undefined);
      return { running: false, paused: undefined, statuses, runStatus, runDurationMs };
    });
  },

  loadExecution(record, viewing = false) {
    const edgeCounts = edgeCountsOf(get().edges, record.runData);
    set({
      ...emptyRun,
      executionId: record.executionId,
      statuses: withWaiting(statusesOf(record.runData), record),
      wait: record.status === 'waiting' ? record.wait : undefined,
      runs: record.runData,
      edgeCounts,
      runStatus: record.status,
      runStartedAt: record.startedAt,
      runDurationMs: record.durationMs,
      viewing: viewing ? { id: record.executionId, status: record.status, startedAt: record.startedAt } : undefined,
    });
  },

  attachRun(record, progress = {}, viewing = false) {
    get().loadExecution(record, viewing);
    const started = Date.parse(record.startedAt);
    set((s) => ({
      running: true,
      following: record.executionId,
      executionStartedAt: started,
      serverStartedAt: started,
      progress,
      statuses: { ...s.statuses, ...Object.fromEntries(Object.entries(progress).map(([id, p]) => [id, { ...s.statuses[id], state: 'running' as const, startedAt: p.since ?? p.at }])) },
    }));
  },

  clearRun() {
    set({ ...emptyRun });
  },

  toWorkflow() {
    const s = get();
    return {
      id: s.workflowId,
      name: s.name,
      description: s.description,
      active: s.active,
      tags: s.tags,
      // Always sent (also when empty) so clearing a setting or the last note reaches the server.
      settings: s.settings,
      stickyNotes: fromStickies(s.stickies),
      groups: fromFrames(s.groups, s.nodes),
      pinData: Object.keys(s.pinData).length ? Object.fromEntries(Object.entries(s.pinData).filter(([id]) => s.nodes.some((n) => n.id === id))) : undefined,
      nodes: s.nodes.map((n) => ({ ...n.data.wf, position: [Math.round(n.position.x), Math.round(n.position.y)] as [number, number] })),
      connections: s.edges.map((e) => {
        const source = parseHandle(e.sourceHandle);
        const target = parseHandle(e.targetHandle);
        return { id: e.id, type: source.type, source: e.source, sourceIndex: source.index, target: e.target, targetIndex: target.index };
      }),
    };
  },
  };
});
