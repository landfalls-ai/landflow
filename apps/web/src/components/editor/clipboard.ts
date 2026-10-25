/**
 * Copy and paste of canvas selections. The clipboard carries Landflow JSON
 * (`{ kind: 'landflow/nodes', nodes, connections, stickyNotes }`, nodes in the
 * engine's shape), so a selection can move between workflows and tabs. n8n's
 * clipboard JSON (`{ nodes, connections }` keyed by node name) is recognised
 * here and converted by the importer (POST /api/workflows/import).
 *
 * Everything in this module is pure, so paste renaming is unit-tested.
 */
import type { NodeItem, StickyNote, Workflow, WorkflowConnection, WorkflowNode } from '@/lib/shared/types';

export const CLIPBOARD_KIND = 'landflow/nodes';

/** What ⌘C puts on the clipboard. */
export interface ClipboardData {
  kind: typeof CLIPBOARD_KIND;
  version: 1;
  nodes: WorkflowNode[];
  /** Only connections whose two ends were copied. */
  connections: WorkflowConnection[];
  stickyNotes: StickyNote[];
  /** Pinned output of copied nodes, by node id. */
  pinData?: Record<string, NodeItem[]>;
}

export type ParsedClipboard = { kind: 'landflow'; data: ClipboardData } | { kind: 'n8n'; data: unknown };

/** The selected nodes and notes of a workflow, with the connections between them. */
export function serializeSelection(workflow: Pick<Workflow, 'nodes' | 'connections' | 'stickyNotes' | 'pinData'>, nodeIds: Set<string>, stickyIds: Set<string>): ClipboardData {
  const nodes = workflow.nodes.filter((n) => nodeIds.has(n.id));
  const pinData = Object.fromEntries(Object.entries(workflow.pinData ?? {}).filter(([id]) => nodeIds.has(id)));
  return {
    kind: CLIPBOARD_KIND,
    version: 1,
    nodes: structuredClone(nodes),
    connections: workflow.connections.filter((c) => nodeIds.has(c.source) && nodeIds.has(c.target)).map((c) => ({ ...c })),
    stickyNotes: structuredClone((workflow.stickyNotes ?? []).filter((s) => stickyIds.has(s.id))),
    ...(Object.keys(pinData).length && { pinData: structuredClone(pinData) }),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Recognise clipboard text: Landflow's clipboard, a Landflow workflow export (connections as an array) or n8n JSON
 * (connections keyed by node name, node types like `n8n-nodes-base.set`). Anything else is not ours.
 */
export function parseClipboard(text: string): ParsedClipboard | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (Array.isArray(value)) value = value.length === 1 ? value[0] : undefined;
  if (isObject(value) && isObject(value.workflow) && Array.isArray(value.workflow.nodes)) value = value.workflow;
  if (!isObject(value) || !Array.isArray(value.nodes)) return undefined;
  const nodes = value.nodes.filter(isObject);
  if (value.kind === CLIPBOARD_KIND || (Array.isArray(value.connections) && nodes.every((n) => typeof n.id === 'string' && Array.isArray(n.position)))) {
    return {
      kind: 'landflow',
      data: {
        kind: CLIPBOARD_KIND,
        version: 1,
        nodes: nodes as unknown as WorkflowNode[],
        connections: (Array.isArray(value.connections) ? value.connections : []) as WorkflowConnection[],
        stickyNotes: (Array.isArray(value.stickyNotes) ? value.stickyNotes : []) as StickyNote[],
        ...(isObject(value.pinData) && { pinData: value.pinData as Record<string, NodeItem[]> }),
      },
    };
  }
  const looksN8n = nodes.length > 0 && nodes.every((n) => typeof n.type === 'string' && typeof n.name === 'string') && (value.connections === undefined || isObject(value.connections));
  return looksN8n ? { kind: 'n8n', data: value } : undefined;
}

/** n8n's naming for copies: "HTTP Request" → "HTTP Request1", "HTTP Request1" → "HTTP Request2". */
export function uniqueNodeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const match = /^(.*?)(\d+)$/.exec(name);
  const base = match ? match[1] : name;
  let i = match ? Number(match[2]) + 1 : 1;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXPRESSION = /\{\{[\s\S]*?\}\}/g;

/**
 * Point `$('Old')`, `$("Old")` and `$node["Old"]` at renamed nodes. Only text inside `{{ }}` is touched and only exact
 * quoted names match, so "Set" never rewrites "Set 2" and plain text that mentions a node stays as it is.
 */
export function remapReferences<T>(value: T, renames: Record<string, string>): T {
  const entries = Object.entries(renames).filter(([from, to]) => from !== to);
  if (!entries.length) return value;
  const patterns = entries.map(([from, to]) => {
    const name = escapeRegex(from);
    return {
      pattern: new RegExp(`(\\$\\(\\s*|\\$node\\[\\s*)(['"\`])${name}\\2`, 'g'),
      replace: (_m: string, prefix: string, quote: string) => `${prefix}${quote}${to.replaceAll(quote, `\\${quote}`)}${quote}`,
    };
  });
  const rewrite = (text: string) =>
    text.includes('{{') ? text.replace(EXPRESSION, (segment) => patterns.reduce((out, { pattern, replace }) => out.replace(pattern, replace), segment)) : text;
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return rewrite(input);
    if (Array.isArray(input)) return input.map(walk);
    if (isObject(input)) return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, walk(entry)]));
    return input;
  };
  return walk(value) as T;
}

export interface PastePlan {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  stickyNotes: StickyNote[];
  pinData: Record<string, NodeItem[]>;
  /** Old name → new name, for nodes renamed because the name was taken. */
  renamed: Record<string, string>;
}

export interface PasteOptions {
  /** Names already on the canvas. */
  existingNames: Iterable<string>;
  /** Where the top-left corner of the pasted selection goes; otherwise every position moves by `offset`. */
  at?: { x: number; y: number };
  offset?: { x: number; y: number };
  newId: (kind: 'node' | 'edge' | 'sticky') => string;
}

/** The top-left corner of a selection's nodes and notes. */
export function selectionOrigin(data: Pick<ClipboardData, 'nodes' | 'stickyNotes'>): { x: number; y: number } {
  const points = [...data.nodes.map((n) => n.position), ...data.stickyNotes.map((s) => s.position)];
  if (!points.length) return { x: 0, y: 0 };
  return { x: Math.min(...points.map((p) => p[0])), y: Math.min(...points.map((p) => p[1])) };
}

/**
 * Turn clipboard data into nodes that can join a workflow: fresh ids, names made unique against the canvas (and each
 * other), positions moved, `$('Name')` references between pasted nodes following their renamed targets, connections
 * and pinned data re-keyed. Connections to nodes that weren't copied are dropped.
 */
export function preparePaste(data: ClipboardData, options: PasteOptions): PastePlan {
  const taken = new Set(options.existingNames);
  const ids: Record<string, string> = {};
  const renamed: Record<string, string> = {};
  const origin = selectionOrigin(data);
  const shift = options.at ? { x: options.at.x - origin.x, y: options.at.y - origin.y } : (options.offset ?? { x: 40, y: 60 });
  const move = (p: [number, number]): [number, number] => [Math.round(p[0] + shift.x), Math.round(p[1] + shift.y)];

  const staged = data.nodes.map((node) => {
    const id = options.newId('node');
    ids[node.id] = id;
    const name = uniqueNodeName(node.name, taken);
    taken.add(name);
    if (name !== node.name) renamed[node.name] = name;
    return { ...structuredClone(node), id, name, position: move(node.position) };
  });
  // Only references to nodes that were pasted along follow a rename; references to other nodes keep their target.
  const nodes = staged.map((node) => (Object.keys(renamed).length ? { ...node, parameters: remapReferences(node.parameters, renamed) } : node));

  const connections = data.connections
    .filter((c) => ids[c.source] && ids[c.target])
    .map((c) => ({ ...c, id: options.newId('edge'), source: ids[c.source], target: ids[c.target] }));
  const stickyNotes = data.stickyNotes.map((note) => ({ ...structuredClone(note), id: options.newId('sticky'), position: move(note.position) }));
  const pinData = Object.fromEntries(Object.entries(data.pinData ?? {}).flatMap(([id, items]) => (ids[id] ? [[ids[id], structuredClone(items)]] : [])));
  return { nodes, connections, stickyNotes, pinData, renamed };
}
