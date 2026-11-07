/**
 * The editor assistant's workflow-edit language (docs/assistant.md): small
 * operations a model proposes and the editor applies. applyOps() is pure
 * (workflow in, workflow out) and doubles as the validator: like the flow
 * builder, an op that can't apply (unknown node type, unknown node,
 * impossible connection) is dropped with a reason, and parameters a node
 * doesn't have are ignored. The server validates proposals with it against
 * the registry; the editor applies them with it against its own node types.
 */
import { nanoid } from 'nanoid';
import { changeParameter, defaultParameters, defaultVersionOf, indexedPorts } from '@landflow/protocol';
import { delegatesOf, replaceWithTeam, turnIntoTeamBlocker } from './turn-into-team';
import type { ConnectionType, NodeDescriptor, NodeRun, PropertyDescriptor, Workflow, WorkflowConnection, WorkflowNode } from './types';

/**
 * Nodes are referenced by name (what the model sees), by id, or by the `ref`
 * of a node added earlier in the same list.
 */
export type AssistantOp =
  | {
      op: 'addNode';
      /** Handle later ops use for this node (defaults to its name). */
      ref?: string;
      type: string;
      name?: string;
      parameters?: Record<string, unknown>;
      /** Wire it after this node (main), or, for a sub-node, attach it to this node. */
      after?: string;
      /** Insert it in front of this node: what fed that node feeds the new one instead. */
      before?: string;
      /** Output of `after` to wire from (If/Switch-like nodes: 0 = first branch). */
      output?: number;
    }
  | { op: 'setParameters'; node: string; parameters: Record<string, unknown> }
  | { op: 'connect'; from: string; to: string; output?: number; input?: number; type?: ConnectionType }
  | { op: 'disconnect'; from: string; to: string; type?: ConnectionType }
  | { op: 'removeNode'; node: string }
  | { op: 'renameNode'; node: string; name: string }
  /**
   * A Run an Agent node with agents attached as tools becomes one Run a Team node (docs/agent-teams.md). The editor saves the
   * team when the change is applied; the node's team is filled in then.
   */
  | { op: 'turnIntoTeam'; node: string }
  /** A node's run settings (retries, on error, timeout), not its parameters. */
  | { op: 'setNodeSettings'; node: string; settings: NodeSettingsPatch }
  /** The workflow's settings: its error workflow, timeout, automatic retries. */
  | { op: 'setWorkflowSettings'; settings: WorkflowSettingsPatch };

/** The node settings an op may change. */
export interface NodeSettingsPatch {
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTriesMs?: number;
  retryBackoff?: 'fixed' | 'exponential';
  onError?: 'stop' | 'continue';
  timeoutSeconds?: number;
  alwaysOutputData?: boolean;
  disabled?: boolean;
}

/** The workflow settings an op may change. */
export interface WorkflowSettingsPatch {
  errorWorkflowId?: string;
  timeoutSeconds?: number;
  retryMaxAttempts?: number;
  retryBaseDelaySeconds?: number;
}

const NODE_SETTINGS: Record<keyof NodeSettingsPatch, 'boolean' | 'number' | 'onError' | 'backoff'> = {
  retryOnFail: 'boolean',
  maxTries: 'number',
  waitBetweenTriesMs: 'number',
  retryBackoff: 'backoff',
  onError: 'onError',
  timeoutSeconds: 'number',
  alwaysOutputData: 'boolean',
  disabled: 'boolean',
};
const WORKFLOW_SETTINGS: Record<keyof WorkflowSettingsPatch, 'string' | 'number'> = {
  errorWorkflowId: 'string',
  timeoutSeconds: 'number',
  retryMaxAttempts: 'number',
  retryBaseDelaySeconds: 'number',
};

/** The settings of `raw` that `allowed` names, with the right types; undefined when none is left. */
function settingsOf<T>(raw: unknown, allowed: Record<string, 'boolean' | 'number' | 'string' | 'onError' | 'backoff'>): T | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const kind = allowed[key];
    if (kind === 'boolean' && typeof value === 'boolean') out[key] = value;
    else if (kind === 'number' && typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
    else if (kind === 'string' && typeof value === 'string' && value.trim()) out[key] = value.trim();
    else if (kind === 'onError' && (value === 'stop' || value === 'continue')) out[key] = value;
    else if (kind === 'backoff' && (value === 'fixed' || value === 'exponential')) out[key] = value;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

export type OpKind = AssistantOp['op'];

/** Descriptor of an available node type, or undefined. */
export type DescriptorLookup = (type: string) => NodeDescriptor | undefined;

export interface OpsResult {
  workflow: Workflow;
  /** The ops that applied, normalized: existing nodes by name, unknown parameters removed. */
  applied: AssistantOp[];
  /** Ops that were dropped, with the reason. */
  dropped: string[];
  /** Parameters that were left out because the node has no such parameter. */
  ignored: string[];
  /** Ids of the nodes that were added, in order. */
  added: string[];
}

const CONNECTION_TYPES: ConnectionType[] = ['main', 'ai_languageModel', 'ai_memory', 'ai_tool', 'ai_embedding', 'ai_document', 'ai_textSplitter', 'ai_retriever', 'ai_reranker'];
const COLUMN = 280;
const ROW = 170;

// ---------------------------------------------------------------------------
// Parsing model output
// ---------------------------------------------------------------------------

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const index = (value: unknown) => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
};
const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const connectionType = (value: unknown) => (CONNECTION_TYPES.includes(value as ConnectionType) ? (value as ConnectionType) : undefined);

/** Ops from loosely-shaped model JSON. Entries that aren't ops are dropped with a reason. */
export function parseOps(raw: unknown): { ops: AssistantOp[]; dropped: string[] } {
  const ops: AssistantOp[] = [];
  const dropped: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const o = record(entry);
    const op = parseOp(o);
    if (op) ops.push(op);
    else dropped.push(`unreadable change ${JSON.stringify(entry)?.slice(0, 80)}`);
  }
  return { ops, dropped };
}

function parseOp(o: Record<string, unknown> | undefined): AssistantOp | undefined {
  if (!o) return undefined;
  const from = text(o.from) ?? text(o.source);
  const to = text(o.to) ?? text(o.target);
  const node = text(o.node) ?? text(o.nodeName);
  // Only renameNode gives `name` a meaning of its own (the new name); elsewhere a model's `name` is the node it means.
  const subject = node ?? text(o.name);
  switch (text(o.op) ?? text(o.action)) {
    case 'addNode': {
      const type = text(o.type) ?? text(o.nodeType);
      if (!type) return undefined;
      return {
        op: 'addNode',
        type,
        ...(text(o.ref) && { ref: text(o.ref) }),
        ...(text(o.name) && { name: text(o.name) }),
        ...(record(o.parameters) && { parameters: record(o.parameters) }),
        ...(text(o.after) && { after: text(o.after) }),
        ...(text(o.before) && { before: text(o.before) }),
        ...(index(o.output) !== undefined && { output: index(o.output) }),
      };
    }
    case 'setParameters':
      return subject && record(o.parameters) ? { op: 'setParameters', node: subject, parameters: record(o.parameters)! } : undefined;
    case 'connect':
      return from && to
        ? {
            op: 'connect',
            from,
            to,
            ...(index(o.output) !== undefined && { output: index(o.output) }),
            ...(index(o.input) !== undefined && { input: index(o.input) }),
            ...(connectionType(o.type) && { type: connectionType(o.type) }),
          }
        : undefined;
    case 'disconnect':
      return from && to ? { op: 'disconnect', from, to, ...(connectionType(o.type) && { type: connectionType(o.type) }) } : undefined;
    case 'removeNode':
      return subject ? { op: 'removeNode', node: subject } : undefined;
    case 'renameNode': {
      const name = text(o.name) ?? text(o.newName);
      return node && name ? { op: 'renameNode', node, name } : undefined;
    }
    case 'turnIntoTeam':
      return node ? { op: 'turnIntoTeam', node } : undefined;
    case 'setNodeSettings': {
      const settings = settingsOf<NodeSettingsPatch>(o.settings, NODE_SETTINGS);
      return node && settings ? { op: 'setNodeSettings', node, settings } : undefined;
    }
    case 'setWorkflowSettings': {
      const settings = settingsOf<WorkflowSettingsPatch>(o.settings, WORKFLOW_SETTINGS);
      return settings ? { op: 'setWorkflowSettings', settings } : undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function uniqueName(base: string, nodes: WorkflowNode[]) {
  const names = new Set(nodes.map((n) => n.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rewrites `$('Old')`, `$("Old")` and `$node["Old"]` in every string of a parameter value. */
function renameReferences(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    const name = escapeRegExp(from);
    return value.replace(new RegExp(`(\\$\\(\\s*|\\$node\\[\\s*)(['"])${name}\\2`, 'g'), (_m, head: string, quote: string) => `${head}${quote}${to}${quote}`);
  }
  if (Array.isArray(value)) return value.map((v) => renameReferences(v, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameReferences(v, from, to)]));
  return value;
}

/**
 * Numbers outside a field's range, top level or in a collection, taken out of the patch with a reason: a model that
 * reads "30 minute timeout" for a field in milliseconds sets 30, which the editor would refuse.
 */
/**
 * A value the agent fills, as the engine reads it: `{{ $fromAI('key', 'description', 'type') }}`, what the "Let the model
 * decide" button writes. Spotlight's model sometimes writes a bare `$fromAI`, or the call without the braces: both become
 * that expression, with the parameter's name, display name and type. Top-level parameters only.
 */
export function fromAIValues(properties: PropertyDescriptor[], patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  for (const [key, value] of Object.entries(patch)) {
    const v = typeof value === 'string' ? value.trim().replace(/^=/, '') : '';
    if (!/^\$fromAI\b/.test(v)) continue;
    if (/^\$fromAI\s*\(.*\)$/s.test(v)) {
      out[key] = `{{ ${v} }}`;
      continue;
    }
    const prop = properties.find((p) => p.name === key);
    const label = (prop?.displayName ?? key).replace(/['"`]/g, '’');
    const type = prop?.type === 'number' ? 'number' : prop?.type === 'boolean' ? 'boolean' : 'string';
    out[key] = `{{ $fromAI('${key}', '${label}', '${type}') }}`;
  }
  return out;
}

function outOfRange(properties: PropertyDescriptor[], patch: Record<string, unknown>, nodeName: string) {
  const notes: string[] = [];
  const check = (prop: PropertyDescriptor | undefined, value: unknown) => {
    const n = typeof value === 'string' && value.trim() && !value.includes('{{') ? Number(value) : value;
    if (prop?.type !== 'number' || typeof n !== 'number' || Number.isNaN(n)) return true;
    const { minValue, maxValue } = prop.typeOptions ?? {};
    const bound = minValue !== undefined && n < minValue ? `under its minimum of ${minValue}` : maxValue !== undefined && n > maxValue ? `over its maximum of ${maxValue}` : undefined;
    if (bound) notes.push(`“${prop.displayName}” of “${nodeName}”: ${n} is ${bound}`);
    return !bound;
  };
  const kept = Object.fromEntries(
    Object.entries(patch).flatMap(([key, value]): Array<[string, unknown]> => {
      const props = properties.filter((p) => p.name === key);
      const collection = props.find((p) => p.type === 'collection');
      if (collection && value && typeof value === 'object' && !Array.isArray(value)) {
        const inner = Object.entries(value).filter(([k, v]) => check(collection.values?.find((p) => p.name === k), v));
        // A collection left with nothing would replace the node's own values.
        return inner.length || !Object.keys(value).length ? [[key, Object.fromEntries(inner)]] : [];
      }
      return check(props.find((p) => p.type === 'number'), value) ? [[key, value]] : [];
    }),
  );
  return { patch: kept, notes };
}

/** Set parameters the way the editor does (dependent fields reset, defaults filled), in declaration order. */
function mergeParameters(descriptor: NodeDescriptor, current: Record<string, unknown>, patch: Record<string, unknown>) {
  const known = new Set(descriptor.properties.filter((p) => p.type !== 'notice').map((p) => p.name));
  const ignored = Object.keys(patch).filter((key) => !known.has(key));
  let parameters = current;
  const order = [...new Set(descriptor.properties.map((p) => p.name))].filter((name) => name in patch && known.has(name));
  for (const name of order) parameters = changeParameter(descriptor.properties, parameters, name, patch[name]);
  return { parameters, ignored, applied: order };
}

interface PlannedConnection {
  type: ConnectionType;
  source: WorkflowNode;
  target: WorkflowNode;
  sourceIndex: number;
  targetIndex: number;
}

/** Whether `source` → `target` can exist (flow-builder rules), with the port indexes filled in. */
function planConnection(
  workflow: Workflow,
  lookup: DescriptorLookup,
  source: WorkflowNode,
  target: WorkflowNode,
  wanted: { type?: ConnectionType; output?: number; input?: number },
): PlannedConnection | string {
  if (source.id === target.id) return `“${source.name}” can’t connect to itself`;
  const sd = lookup(source.type);
  const td = lookup(target.type);
  if (!sd) return `unknown node type ${source.type}`;
  if (!td) return `unknown node type ${target.type}`;
  // Without a type, an edge touching a sub-node is that sub-node's capability.
  const type = wanted.type ?? (sd.kind === 'subnode' ? sd.supplies : td.kind === 'subnode' ? td.supplies : undefined) ?? 'main';

  if (type === 'main') {
    const outputs = sd.outputs.filter((p) => p.type === 'main');
    const inputs = td.inputs.filter((p) => p.type === 'main');
    const output = wanted.output ?? 0;
    if (!outputs.length) return `“${source.name}” has no output to connect from`;
    if (output >= outputs.length) return `“${source.name}” has no output ${output} (it has ${outputs.length})`;
    if (!inputs.length) return `“${target.name}” takes no input${td.kind === 'trigger' ? ' (it is a trigger)' : ''}`;
    // Default to the first free input, so a Merge's two branches land on input 1 and 2.
    const taken = new Set(workflow.connections.filter((c) => c.target === target.id && c.type === 'main').map((c) => c.targetIndex));
    const input = wanted.input ?? Math.max(0, inputs.findIndex((_p, i) => !taken.has(i)));
    if (input >= inputs.length) return `“${target.name}” has no input ${input}`;
    return { type, source, target, sourceIndex: output, targetIndex: input };
  }

  const fits = (from: NodeDescriptor, to: NodeDescriptor) =>
    to.inputs.some((p) => p.type === type) && (from.supplies === type || from.outputs.some((p) => p.type === type) || (type === 'ai_tool' && Boolean(from.usableAsTool)));
  if (fits(sd, td)) return { type, source, target, sourceIndex: 0, targetIndex: 0 };
  // Models often wire the agent to its sub-node; the edge runs sub-node → agent.
  if (fits(td, sd)) return { type, source: target, target: source, sourceIndex: 0, targetIndex: 0 };
  return `“${source.name}” can’t be attached to “${target.name}” as ${type}`;
}

/** Add a planned connection; a port with maxConnections drops its oldest edge, as in the editor. */
function addConnection(workflow: Workflow, lookup: DescriptorLookup, plan: PlannedConnection, newId: () => string): Workflow | string {
  const same = (c: WorkflowConnection) => c.target === plan.target.id && c.type === plan.type && c.targetIndex === plan.targetIndex;
  if (workflow.connections.some((c) => same(c) && c.source === plan.source.id && c.sourceIndex === plan.sourceIndex)) {
    return `“${plan.source.name}” is already connected to “${plan.target.name}”`;
  }
  const port = lookup(plan.target.type)?.inputs.filter((p) => p.type === plan.type)[plan.targetIndex];
  let connections = workflow.connections;
  const existing = connections.filter(same);
  if (port?.maxConnections && existing.length >= port.maxConnections) connections = connections.filter((c) => c.id !== existing[0].id);
  const connection: WorkflowConnection = {
    id: `e_${newId()}`,
    type: plan.type,
    source: plan.source.id,
    sourceIndex: plan.sourceIndex,
    target: plan.target.id,
    targetIndex: plan.targetIndex,
  };
  return { ...workflow, connections: [...connections, connection] };
}

const overlaps = (workflow: Workflow, x: number, y: number, self: string) =>
  workflow.nodes.some((n) => n.id !== self && Math.abs(n.position[0] - x) < 100 && Math.abs(n.position[1] - y) < 90);

/** The first spot from (x, y) that no other node covers, stepping down (or right, for sub-nodes). */
function freeSpot(workflow: Workflow, x: number, y: number, self: string, step: [number, number] = [0, ROW]): [number, number] {
  let [px, py] = [x, y];
  for (let i = 0; i < 12 && overlaps(workflow, px, py, self); i++) [px, py] = [px + step[0], py + step[1]];
  return [px, py];
}

/** Where a new node goes: after its source, under the agent it attaches to, or right of everything. */
function placeAdded(workflow: Workflow, lookup: DescriptorLookup, id: string): [number, number] {
  const byId = (nodeId: string) => workflow.nodes.find((n) => n.id === nodeId);
  const subEdge = workflow.connections.find((c) => c.source === id && c.type !== 'main');
  if (subEdge && byId(subEdge.target)) {
    const parent = byId(subEdge.target)!;
    const siblings = workflow.connections.filter((c) => c.target === parent.id && c.type !== 'main' && c.source !== id).length;
    return freeSpot(workflow, parent.position[0] + siblings * 110, parent.position[1] + 200, id, [110, 0]);
  }
  const incoming = workflow.connections.find((c) => c.target === id && c.type === 'main');
  if (incoming && byId(incoming.source)) {
    const parent = byId(incoming.source)!;
    const parentDescriptor = lookup(parent.type);
    const branchOffset = parentDescriptor && parentDescriptor.outputs.filter((p) => p.type === 'main').length > 1 ? incoming.sourceIndex * ROW : 0;
    return freeSpot(workflow, parent.position[0] + COLUMN, parent.position[1] + branchOffset, id);
  }
  const others = workflow.nodes.filter((n) => n.id !== id);
  if (!others.length) return [0, 0];
  const right = others.reduce((a, b) => (b.position[0] > a.position[0] ? b : a));
  return freeSpot(workflow, right.position[0] + COLUMN, right.position[1], id);
}

/**
 * Splice `node` in front of `before`: the main edges into `before` (only the
 * one from `after`, if given) now end at `node`, and `node` feeds `before`.
 * With no such edge, `after` (if given) is wired to `node` as usual.
 */
function insertBefore(
  workflow: Workflow,
  lookup: DescriptorLookup,
  node: WorkflowNode,
  before: WorkflowNode,
  after: WorkflowNode | undefined,
  output: number | undefined,
  newId: () => string,
): Workflow | string {
  const descriptor = lookup(node.type)!;
  if (descriptor.kind !== 'action' || !descriptor.inputs.some((p) => p.type === 'main') || !descriptor.outputs.some((p) => p.type === 'main')) {
    return `only nodes with an input and an output can be inserted`;
  }
  const feeding = workflow.connections.filter(
    (c) => c.target === before.id && c.type === 'main' && (!after || (c.source === after.id && (output === undefined || c.sourceIndex === output))),
  );
  let next: Workflow = {
    ...workflow,
    connections: workflow.connections.map((c) => (feeding.includes(c) ? { ...c, id: `e_${newId()}`, target: node.id, targetIndex: 0 } : c)),
  };
  if (!feeding.length && after) {
    const plan = planConnection(next, lookup, after, node, { type: 'main', output });
    const connected = typeof plan === 'string' ? plan : addConnection(next, lookup, plan, newId);
    if (typeof connected === 'string') return connected;
    next = connected;
  }
  const plan = planConnection(next, lookup, node, before, { type: 'main', input: feeding[0]?.targetIndex });
  return typeof plan === 'string' ? plan : addConnection(next, lookup, plan, newId);
}

/** An inserted node takes its target's place; the target and everything after it move one column right. */
function makeRoom(workflow: Workflow, id: string, target: string): Workflow {
  const anchor = workflow.nodes.find((n) => n.id === target)!;
  const moved = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const current = queue.pop()!;
    if (moved.has(current) || current === id) continue;
    moved.add(current);
    for (const c of workflow.connections) if (c.source === current && c.type === 'main') queue.push(c.target);
  }
  // Sub-nodes travel with the node they attach to.
  for (const c of workflow.connections) if (c.type !== 'main' && moved.has(c.target)) moved.add(c.source);
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) =>
      n.id === id ? { ...n, position: [...anchor.position] } : moved.has(n.id) ? { ...n, position: [n.position[0] + COLUMN, n.position[1]] } : n,
    ),
  };
}

/**
 * Apply `ops` to a copy of `workflow`, one by one. Each op sees the result of
 * the ones before it; an op that can't apply is dropped and the rest go on.
 */
export function applyOps(workflow: Workflow, ops: AssistantOp[], lookup: DescriptorLookup, options: { newId?: () => string } = {}): OpsResult {
  const newId = options.newId ?? (() => nanoid(8));
  let wf: Workflow = { ...workflow, nodes: [...workflow.nodes], connections: [...workflow.connections] };
  const applied: AssistantOp[] = [];
  const dropped: string[] = [];
  const ignored: string[] = [];
  const added: string[] = [];
  /** ref → node id, for nodes added by these ops. */
  const refs = new Map<string, string>();
  /** New node id → the node it was inserted in front of. */
  const insertions = new Map<string, string>();
  /** New node id → the node its `after` wired it from (main). */
  const mainAfter = new Map<string, string>();

  const find = (reference: string): WorkflowNode | undefined => {
    const byRef = refs.get(reference);
    if (byRef) return wf.nodes.find((n) => n.id === byRef);
    const lower = reference.toLowerCase();
    return (
      wf.nodes.find((n) => n.name === reference) ??
      wf.nodes.find((n) => n.id === reference) ??
      wf.nodes.find((n) => n.name.toLowerCase() === lower)
    );
  };
  /** How later ops refer to a node: its ref if these ops added it, else its name. */
  const handle = (node: WorkflowNode) => [...refs].find(([, id]) => id === node.id)?.[0] ?? node.name;

  for (const op of ops) {
    switch (op.op) {
      case 'addNode': {
        const descriptor = lookup(op.type);
        if (!descriptor) {
          dropped.push(`add “${op.name ?? op.type}”: unknown node type ${op.type}`);
          break;
        }
        const ref = op.ref ?? op.name ?? descriptor.displayName;
        if (refs.has(ref)) {
          dropped.push(`add “${op.name ?? op.type}”: ref “${ref}” is used twice`);
          break;
        }
        const after = op.after ? find(op.after) : undefined;
        if (op.after && !after) {
          dropped.push(`add “${op.name ?? op.type}”: no node “${op.after}” to add it after`);
          break;
        }
        const before = op.before ? find(op.before) : undefined;
        if (op.before && !before) {
          dropped.push(`add “${op.name ?? op.type}”: no node “${op.before}” to insert it before`);
          break;
        }
        const id = `n_${newId()}`;
        const name = uniqueName(op.name ?? descriptor.displayName, wf.nodes);
        const ranged = outOfRange(descriptor.properties, fromAIValues(descriptor.properties, op.parameters ?? {}), name);
        dropped.push(...ranged.notes);
        const merged = mergeParameters(descriptor, defaultParameters(descriptor), ranged.patch);
        ignored.push(...merged.ignored.map((key) => `“${name}” has no parameter “${key}”`));
        const node: WorkflowNode = { id, name, type: op.type, typeVersion: defaultVersionOf(descriptor), position: [0, 0], parameters: merged.parameters };
        let next: Workflow = { ...wf, nodes: [...wf.nodes, node] };
        if (before) {
          const inserted = insertBefore(next, lookup, node, before, after, op.output, newId);
          if (typeof inserted === 'string') {
            dropped.push(`add “${name}” before “${before.name}”: ${inserted}`);
            break;
          }
          next = inserted;
          insertions.set(id, before.id);
        } else if (after) {
          // A sub-node attaches to `after`; anything else is wired from it.
          const plan =
            descriptor.kind === 'subnode'
              ? planConnection(next, lookup, node, after, { type: descriptor.supplies })
              : planConnection(next, lookup, after, node, { type: 'main', output: op.output });
          const connected = typeof plan === 'string' ? plan : addConnection(next, lookup, plan, newId);
          if (typeof connected === 'string') {
            dropped.push(`add “${name}” after “${after.name}”: ${connected}`);
            break;
          }
          next = connected;
          if (descriptor.kind !== 'subnode') mainAfter.set(id, after.id);
        }
        wf = next;
        refs.set(ref, id);
        added.push(id);
        const parameters = Object.fromEntries(merged.applied.map((key) => [key, ranged.patch[key]]));
        applied.push({
          op: 'addNode',
          ref,
          type: op.type,
          name,
          ...(merged.applied.length && { parameters }),
          ...(after && { after: handle(after) }),
          ...(before && { before: handle(before) }),
          ...(after && op.output !== undefined && { output: op.output }),
        });
        break;
      }

      case 'setParameters': {
        const node = find(op.node);
        if (!node) {
          dropped.push(`set parameters: no node “${op.node}”`);
          break;
        }
        const descriptor = lookup(node.type);
        if (!descriptor) {
          dropped.push(`set parameters of “${node.name}”: unknown node type ${node.type}`);
          break;
        }
        const ranged = outOfRange(descriptor.properties, fromAIValues(descriptor.properties, op.parameters), node.name);
        dropped.push(...ranged.notes);
        const merged = mergeParameters(descriptor, node.parameters, ranged.patch);
        ignored.push(...merged.ignored.map((key) => `“${node.name}” has no parameter “${key}”`));
        if (!merged.applied.length) {
          if (ranged.notes.length) break;
          dropped.push(`set parameters of “${node.name}”: none of ${Object.keys(op.parameters).join(', ') || 'them'} exist`);
          break;
        }
        wf = { ...wf, nodes: wf.nodes.map((n) => (n.id === node.id ? { ...n, parameters: merged.parameters } : n)) };
        applied.push({ op: 'setParameters', node: handle(node), parameters: Object.fromEntries(merged.applied.map((key) => [key, ranged.patch[key]])) });
        break;
      }

      case 'connect': {
        const source = find(op.from);
        const target = find(op.to);
        if (!source || !target) {
          dropped.push(`connect “${op.from}” → “${op.to}”: no node “${!source ? op.from : op.to}”`);
          break;
        }
        // Already wired that way (often by an addNode's `after`): nothing to do, and nothing wrong.
        const output = op.output ?? 0;
        const wired = (a: WorkflowNode, b: WorkflowNode) =>
          wf.connections.some((c) => c.source === a.id && c.target === b.id && (op.type ? c.type === op.type : true) && (c.type !== 'main' || c.sourceIndex === output));
        if (wired(source, target) || (op.type !== 'main' && op.type !== undefined && wired(target, source))) break;
        const plan = planConnection(wf, lookup, source, target, op);
        const connected = typeof plan === 'string' ? plan : addConnection(wf, lookup, plan, newId);
        if (typeof plan === 'string' || typeof connected === 'string') {
          dropped.push(`connect “${source.name}” → “${target.name}”: ${typeof plan === 'string' ? plan : connected}`);
          break;
        }
        wf = connected;
        // A node these ops added "after" an agent, then attach to it as a tool, a model or a memory, is that and not also
        // a step after it: the main edge its `after` made goes (it would run the tool once more when the agent is done).
        if (plan.type !== 'main' && mainAfter.get(plan.source.id) === plan.target.id) {
          wf = { ...wf, connections: wf.connections.filter((c) => !(c.type === 'main' && c.source === plan.target.id && c.target === plan.source.id)) };
          mainAfter.delete(plan.source.id);
          const ref = handle(plan.source);
          const i = applied.findIndex((a) => a.op === 'addNode' && a.ref === ref);
          if (i >= 0) {
            const { after: _after, output: _output, ...rest } = applied[i] as Extract<AssistantOp, { op: 'addNode' }>;
            applied[i] = rest;
          }
        }
        applied.push({
          op: 'connect',
          from: handle(plan.source),
          to: handle(plan.target),
          ...(plan.type !== 'main' && { type: plan.type }),
          ...(plan.type === 'main' && plan.sourceIndex > 0 && { output: plan.sourceIndex }),
          ...(plan.type === 'main' && op.input !== undefined && { input: plan.targetIndex }),
        });
        break;
      }

      case 'disconnect': {
        const source = find(op.from);
        const target = find(op.to);
        const matches = (c: WorkflowConnection, a?: WorkflowNode, b?: WorkflowNode) =>
          a && b && c.source === a.id && c.target === b.id && (!op.type || c.type === op.type);
        // The edges the way it was asked; else, since sub-node edges run sub-node → agent, a sub-node edge the other way.
        // ("Disconnect Tech Lead → Check Branch" is the main edge after the lead, not the tool edge into it as well.)
        const forward = wf.connections.filter((c) => matches(c, source, target));
        const remove = forward.length ? forward : wf.connections.filter((c) => matches(c, target, source) && c.type !== 'main');
        if (!source || !target || !remove.length) {
          dropped.push(`disconnect “${op.from}” → “${op.to}”: ${!source || !target ? `no node “${!source ? op.from : op.to}”` : 'they aren’t connected'}`);
          break;
        }
        wf = { ...wf, connections: wf.connections.filter((c) => !remove.includes(c)) };
        applied.push({ op: 'disconnect', from: handle(source), to: handle(target), ...(op.type && { type: op.type }) });
        break;
      }

      case 'removeNode': {
        const node = find(op.node);
        if (!node) {
          dropped.push(`remove: no node “${op.node}”`);
          break;
        }
        const applyAs = handle(node);
        const pinData = wf.pinData && Object.fromEntries(Object.entries(wf.pinData).filter(([id]) => id !== node.id));
        wf = {
          ...wf,
          nodes: wf.nodes.filter((n) => n.id !== node.id),
          connections: wf.connections.filter((c) => c.source !== node.id && c.target !== node.id),
          ...(pinData && { pinData }),
        };
        for (const [ref, id] of refs) if (id === node.id) refs.delete(ref);
        if (added.includes(node.id)) added.splice(added.indexOf(node.id), 1);
        applied.push({ op: 'removeNode', node: applyAs });
        break;
      }

      case 'renameNode': {
        const node = find(op.node);
        if (!node) {
          dropped.push(`rename: no node “${op.node}”`);
          break;
        }
        if (node.name === op.name) {
          dropped.push(`rename “${node.name}”: it already has that name`);
          break;
        }
        if (wf.nodes.some((n) => n.id !== node.id && n.name === op.name)) {
          dropped.push(`rename “${node.name}”: another node is called “${op.name}”`);
          break;
        }
        const applyAs = handle(node);
        wf = {
          ...wf,
          nodes: wf.nodes.map((n) => ({
            ...n,
            ...(n.id === node.id && { name: op.name }),
            parameters: renameReferences(n.parameters, node.name, op.name) as Record<string, unknown>,
          })),
        };
        applied.push({ op: 'renameNode', node: applyAs, name: op.name });
        break;
      }

      case 'turnIntoTeam': {
        const node = find(op.node);
        if (!node) {
          dropped.push(`turn into a team: no node “${op.node}”`);
          break;
        }
        const blocker = turnIntoTeamBlocker(wf, node.id);
        if (blocker) {
          dropped.push(`turn “${node.name}” into a team: ${blocker}`);
          break;
        }
        // The team gets its id when the editor saves it; until then the node stands for it.
        wf = replaceWithTeam(wf, node.id, delegatesOf(wf, node.id).map((n) => n.id), { id: '', name: `${node.name} team` });
        applied.push({ op: 'turnIntoTeam', node: handle(node) });
        break;
      }

      case 'setNodeSettings': {
        const node = find(op.node);
        const settings = settingsOf<NodeSettingsPatch>(op.settings, NODE_SETTINGS);
        if (!node || !settings) {
          dropped.push(node ? `settings of “${node.name}”: nothing to change` : `settings: no node “${op.node}”`);
          break;
        }
        wf = { ...wf, nodes: wf.nodes.map((n) => (n.id === node.id ? { ...n, ...settings } : n)) };
        applied.push({ op: 'setNodeSettings', node: handle(node), settings });
        break;
      }

      case 'setWorkflowSettings': {
        const settings = settingsOf<WorkflowSettingsPatch>(op.settings, WORKFLOW_SETTINGS);
        if (!settings) {
          dropped.push('workflow settings: nothing to change');
          break;
        }
        wf = { ...wf, settings: { ...(wf.settings ?? {}), ...settings } };
        applied.push({ op: 'setWorkflowSettings', settings });
        break;
      }
    }
  }

  // Lay out new nodes once their connections are known, in the order they were added.
  for (const id of added) {
    const target = insertions.get(id);
    wf = target ? makeRoom(wf, id, target) : { ...wf, nodes: wf.nodes.map((n) => (n.id === id ? { ...n, position: placeAdded(wf, lookup, id) } : n)) };
  }
  return { workflow: wf, applied, dropped, ignored, added };
}

/** The ids reachable from `id` along main connections (a node in a loop reaches itself). */
function downstream(workflow: Workflow, id: string): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.pop()!;
    for (const c of workflow.connections) {
      if (c.source === current && c.type === 'main' && !seen.has(c.target)) {
        seen.add(c.target);
        queue.push(c.target);
      }
    }
  }
  return seen;
}

/**
 * What a change leaves dangling: nodes that lost their only input, nodes that
 * now get a second input (an insert that forgot its disconnect), new nodes
 * wired to nothing, new root nodes missing a required sub-node.
 */
export function structuralWarnings(before: Workflow, after: Workflow, lookup: DescriptorLookup): string[] {
  const warnings: string[] = [];
  const existed = new Set(before.nodes.map((n) => n.id));
  const inputs = (wf: Workflow, id: string) => wf.connections.filter((c) => c.target === id && c.type === 'main');
  const fed = (wf: Workflow, id: string) => inputs(wf, id).length > 0;
  const name = (id: string) => after.nodes.find((n) => n.id === id)?.name ?? id;
  /** Attached to an agent as a tool (or another sub-node slot): it runs when the agent calls it, with no input of its own. */
  const attached = (id: string) => after.connections.some((c) => c.source === id && c.type !== 'main');
  for (const node of after.nodes) {
    const descriptor = lookup(node.type);
    if (!descriptor || descriptor.kind === 'trigger') continue;
    if (existed.has(node.id)) {
      if (fed(before, node.id) && !fed(after, node.id) && !attached(node.id)) warnings.push(`“${node.name}” no longer receives any input`);
      const now = inputs(after, node.id);
      // An edge back from something downstream closes a loop (docs/assistant.md): a second input by design.
      const closesLoop = now.filter((c) => !before.connections.some((b) => b.id === c.id)).every((c) => downstream(after, node.id).has(c.source));
      if (now.length > 1 && now.length > inputs(before, node.id).length && !closesLoop && descriptor.inputs.filter((p) => p.type === 'main').length === 1) {
        warnings.push(`“${node.name}” now gets input from both ${now.map((c) => `“${name(c.source)}”`).join(' and ')}`);
      }
      continue;
    }
    if (descriptor.kind === 'subnode') {
      if (!after.connections.some((c) => c.source === node.id && c.type !== 'main')) warnings.push(`new node “${node.name}” isn’t attached to anything`);
      continue;
    }
    if (!fed(after, node.id) && !attached(node.id)) warnings.push(`new node “${node.name}” has no input`);
    // Only the slots the node's parameters show (an agent's Fallback Model only with the switch on).
    for (const { port, index } of indexedPorts(descriptor.inputs, node.parameters).filter((p) => p.visible && p.port.type !== 'main' && p.port.required)) {
      if (!after.connections.some((c) => c.target === node.id && c.type === port.type && (c.targetIndex ?? 0) === index)) warnings.push(`new node “${node.name}” needs a ${port.displayName ?? port.type} attached`);
    }
  }
  return warnings;
}

/** Node types that decide a path: with nothing after them they do nothing. */
const BRANCH_TYPES = new Set(['core.if', 'core.filter', 'core.switch']);
/** Node types that only reshape items: with nothing reading them they are leftovers. */
const SHAPING_TYPES = new Set(['core.set', 'core.code', 'core.noOp', 'core.sort', 'core.limit', 'core.removeDuplicates', 'core.aggregate']);

/** The ids reached from `id` leaving through main output `index` only (the first hop is that output). */
function reachedFrom(workflow: Workflow, id: string, index: number): Set<string> {
  const seen = new Set<string>();
  const queue = workflow.connections.filter((c) => c.source === id && c.type === 'main' && (c.sourceIndex ?? 0) === index).map((c) => c.target);
  while (queue.length) {
    const current = queue.pop()!;
    // A loop back to the branching node starts over rather than joining branches.
    if (seen.has(current) || current === id) continue;
    seen.add(current);
    for (const c of workflow.connections) if (c.source === current && c.type === 'main') queue.push(c.target);
  }
  return seen;
}

/**
 * Wiring mistakes a build can leave: a new connection from one branch of an If / Switch to a node a sibling branch also
 * reaches (the success path wired into the rejection), and a new node nothing reads that isn't a final action. The
 * first is sent back for a fix; the second can be an unfinished build, so it is only shown on the card.
 */
export function wiringWarnings(before: Workflow, after: Workflow, lookup: DescriptorLookup): { branches: string[]; purpose: string[] } {
  const warnings: string[] = [];
  const purpose: string[] = [];
  const name = (id: string) => after.nodes.find((n) => n.id === id)?.name ?? id;
  const typeOf = (id: string) => after.nodes.find((n) => n.id === id)?.type ?? '';
  const isNew = (c: WorkflowConnection) => !before.connections.some((b) => b.id === c.id);
  for (const source of after.nodes) {
    const descriptor = lookup(source.type);
    const outs = new Set(after.connections.filter((c) => c.source === source.id && c.type === 'main').map((c) => c.sourceIndex ?? 0));
    const branches = BRANCH_TYPES.has(source.type) || (descriptor?.outputs.filter((p) => p.type === 'main').length ?? 0) > 1;
    if (!branches || outs.size < 2) continue;
    for (const c of after.connections.filter((x) => x.source === source.id && x.type === 'main' && isNew(x))) {
      // A Merge joins branches on purpose.
      if (typeOf(c.target) === 'core.merge') continue;
      const mine = c.sourceIndex ?? 0;
      const other = [...outs].find((o) => o !== mine && reachedFrom(after, source.id, o).has(c.target));
      if (other !== undefined) warnings.push(`“${name(c.target)}” is reached from both output ${mine} and output ${other} of “${source.name}”: one branch leads into the other`);
    }
  }
  const existed = new Set(before.nodes.map((n) => n.id));
  for (const node of after.nodes) {
    if (existed.has(node.id)) continue;
    const descriptor = lookup(node.type);
    if (!descriptor || descriptor.kind !== 'action' || !descriptor.outputs.some((p) => p.type === 'main')) continue;
    if (after.connections.some((c) => c.source === node.id)) continue;
    const parents = after.connections.filter((c) => c.target === node.id && c.type === 'main');
    const sideStub = parents.some((p) => after.connections.some((c) => c.source === p.source && c.type === 'main' && c.target !== node.id && (c.sourceIndex ?? 0) === (p.sourceIndex ?? 0)));
    if (BRANCH_TYPES.has(node.type) || (SHAPING_TYPES.has(node.type) && sideStub)) purpose.push(`new node “${node.name}” has no purpose: nothing reads its output`);
  }
  return { branches: warnings, purpose };
}

// ---------------------------------------------------------------------------
// Collections, agent sub-nodes and credentials
// ---------------------------------------------------------------------------

const isExpression = (value: unknown) => typeof value === 'string' && (value.includes('{{') || value.startsWith('='));
const plain = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A sample value for a field: its first option, its default, or a placeholder by type. */
function sampleValue(f: PropertyDescriptor): unknown {
  if (f.options?.length) return f.options[0].value;
  if (f.default !== undefined && f.default !== '' && typeof f.default !== 'object') return f.default;
  return f.type === 'number' ? 0 : f.type === 'boolean' ? false : '…';
}

const shortOptions = (f: PropertyDescriptor, max = 20) => {
  const values = (f.options ?? []).map((o) => JSON.stringify(o.value));
  return values.slice(0, max).join('|') + (values.length > max ? `|… (${values.length} in all)` : '');
};

/**
 * How a collection / fixedCollection is stored in `node.parameters`, spelled out: group names, field names, the values an
 * options field allows and a one-line example. A model that only sees "fixedCollection" writes a flat array.
 * Empty for other types.
 */
export function collectionShape(p: PropertyDescriptor): string {
  const fieldText = (f: PropertyDescriptor) => `${f.name}: ${f.options?.length && !f.typeOptions?.loadOptionsMethod ? shortOptions(f) : f.type}`;
  const row = (fields: PropertyDescriptor[]) => `{ ${fields.slice(0, 8).map(fieldText).join(', ')} }`;
  const example = (fields: PropertyDescriptor[]) => JSON.stringify(Object.fromEntries(fields.slice(0, 4).map((f) => [f.name, sampleValue(f)])));
  if (p.type === 'collection' && p.values?.length) return `stored as one object { ${p.values.slice(0, 10).map(fieldText).join(', ')} }, e.g. ${example(p.values)}`;
  if (p.type === 'fixedCollection' && p.groups?.length) {
    const many = Boolean(p.typeOptions?.multipleValues);
    const groups = p.groups.map((g) => `"${g.name}": ${many ? `[${row(g.values)}, …]` : row(g.values)}`).join(', ');
    const g = p.groups[0];
    return `stored as an object keyed by group, ${many ? 'each group a list of rows' : 'each group one row'}: { ${groups} }, e.g. {"${g.name}":${many ? `[${example(g.values)}]` : example(g.values)}}`;
  }
  return '';
}

/** Problems with one parameter value against its descriptor: wrong shape, unknown keys, an option that doesn't exist. */
function valueProblems(p: PropertyDescriptor, value: unknown, label: string): string[] {
  if (value === undefined || value === null || isExpression(value)) return [];
  if (p.type === 'options') {
    if (p.typeOptions?.loadOptionsMethod || !p.options?.length || plain(value) || Array.isArray(value)) return [];
    return p.options.some((o) => String(o.value) === String(value)) ? [] : [`${label}: ${JSON.stringify(value)} is not one of ${shortOptions(p)}`];
  }
  if (p.type === 'collection' && p.values) {
    if (!plain(value)) return [`${label} must be one object, ${collectionShape(p)}`];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => {
      const field = p.values!.find((f) => f.name === key);
      return field ? valueProblems(field, v, `${label}.${key}`) : [`${label} has no field “${key}” (fields: ${p.values!.map((f) => f.name).join(', ')})`];
    });
  }
  if (p.type === 'fixedCollection' && p.groups) {
    if (!plain(value)) return [`${label} must be an object keyed by group, ${collectionShape(p)}`];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, group]) => {
      const g = p.groups!.find((x) => x.name === key);
      if (!g) return [`${label} has no group “${key}” (groups: ${p.groups!.map((x) => x.name).join(', ')}); ${collectionShape(p)}`];
      if (p.typeOptions?.multipleValues && !Array.isArray(group)) return [`${label}.${key} must be a list of rows, [{…}, …]`];
      return (Array.isArray(group) ? group : [group]).flatMap((r, i) => {
        if (!plain(r)) return [`${label}.${key}[${i}] must be an object with ${g.values.map((f) => f.name).join(', ')}`];
        return Object.entries(r as Record<string, unknown>).flatMap(([k, v]) => {
          const field = g.values.find((f) => f.name === k);
          return field ? valueProblems(field, v, `${label}.${key}[${i}].${k}`) : [`${label}.${key}[${i}] has no field “${k}” (fields: ${g.values.map((f) => f.name).join(', ')})`];
        });
      });
    });
  }
  return [];
}

/**
 * Parameters a proposal writes in a shape the node can't read: a fixedCollection that isn't `{ group: [rows] }`, a key the
 * collection doesn't have (`value` for `text`), an option value the list doesn't contain (an invented action). Checked on
 * new nodes and nodes whose parameters changed; sent back once like the other structural warnings.
 */
export function collectionWarnings(before: Workflow, after: Workflow, lookup: DescriptorLookup): string[] {
  const out: string[] = [];
  for (const node of after.nodes) {
    const was = before.nodes.find((n) => n.id === node.id);
    const descriptor = lookup(node.type);
    if (!descriptor) continue;
    for (const p of descriptor.properties) {
      const value = node.parameters[p.name];
      if (value === undefined || (was && JSON.stringify(was.parameters[p.name]) === JSON.stringify(value))) continue;
      out.push(...valueProblems(p, value, `“${node.name}” ${p.name}`));
    }
  }
  return [...new Set(out)].slice(0, 6);
}

/**
 * Nodes that serve an agent, wired wrongly. A new tool node (usable as a tool) placed after an agent as a normal step
 * runs once when the agent is done instead of being called by it; it needs an ai_tool connection. A new sub-node with only
 * a main connection never reaches the agent's model / tool / memory input.
 */
export function agentWiringWarnings(before: Workflow, after: Workflow, lookup: DescriptorLookup): string[] {
  const out: string[] = [];
  const existed = new Set(before.nodes.map((n) => n.id));
  const name = (id: string) => after.nodes.find((n) => n.id === id)?.name ?? id;
  for (const node of after.nodes) {
    if (existed.has(node.id)) continue;
    const d = lookup(node.type);
    if (!d || d.kind === 'trigger') continue;
    if (after.connections.some((c) => c.source === node.id && c.type !== 'main')) continue;
    if (d.kind === 'subnode') {
      if (after.connections.some((c) => (c.source === node.id || c.target === node.id) && c.type === 'main')) {
        out.push(`“${node.name}” supplies an agent (${d.supplies ?? 'ai_*'}): attach it to the agent with an ${d.supplies ?? 'ai_*'} connection, not a main one`);
      }
      continue;
    }
    const agents = after.connections
      .filter((c) => c.target === node.id && c.type === 'main')
      .map((c) => c.source)
      .filter((id) => lookup(after.nodes.find((n) => n.id === id)?.type ?? '')?.inputs.some((p) => p.type === 'ai_tool'));
    if (d.usableAsTool && agents.length) out.push(`“${node.name}” is wired after “${name(agents[0])}” as a normal step; if the agent should call it as a tool, attach it with an ai_tool connection (connect type ai_tool) instead`);
  }
  return out;
}

/** Nodes that need a credential none of the ops can set: the person picks it in the node's panel. `visible`: whether the slot shows with these parameters. */
export function credentialWarnings(
  before: Workflow,
  after: Workflow,
  lookup: DescriptorLookup,
  visible: (credential: NonNullable<NodeDescriptor['credentials']>[number], parameters: Record<string, unknown>, descriptor: NodeDescriptor) => boolean,
): string[] {
  const out: string[] = [];
  for (const node of after.nodes) {
    const was = before.nodes.find((n) => n.id === node.id);
    if (was && JSON.stringify(was.parameters) === JSON.stringify(node.parameters)) continue;
    const d = lookup(node.type);
    if (!d) continue;
    for (const c of d.credentials ?? []) {
      if (c.required && visible(c, node.parameters, d) && !node.credentials?.[c.name]) out.push(`“${node.name}” needs the credential ${c.name} and none is set: pick one in the node's panel`);
    }
  }
  return out;
}

const SWALLOWS =/catch\s*(?:\([^)]*\))?\s*\{[^}]*\breturn\b|\.catch\s*\(\s*(?:\([^)]*\)|\w*)\s*=>\s*(?:\{[^}]*return\b|[^)]*\))|continueOnFail/;

/** Ops that make a node stop failing instead of fixing why it fails: onError continue, or code that catches and returns. */
export function swallowWarnings(ops: AssistantOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.op === 'setNodeSettings' && op.settings.onError === 'continue') out.push(`“${op.node}” is set to continue on error: the failure is hidden, not fixed`);
    const parameters = op.op === 'setParameters' ? op.parameters : op.op === 'addNode' ? op.parameters : undefined;
    const node = op.op === 'setParameters' ? op.node : op.op === 'addNode' ? (op.name ?? op.type) : '';
    if (!parameters) continue;
    for (const [key, value] of Object.entries(parameters)) {
      if (typeof value === 'string' && /code/i.test(key) && SWALLOWS.test(value)) out.push(`“${node}” catches its error and returns normally: the failure is hidden, not fixed`);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Describing (the proposal card's diff)
// ---------------------------------------------------------------------------

export interface DiffLine {
  sign: '+' | '~' | '→' | '−' | '✎';
  text: string;
}

const preview = (value: unknown) => {
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  return shown.length > 48 ? `${shown.slice(0, 47)}…` : shown;
};

/** One readable line per op: + node, ~ params, → connection, − removed, ✎ renamed. */
export function describeOps(ops: AssistantOp[], lookup?: DescriptorLookup): DiffLine[] {
  const names = new Map<string, string>();
  const name = (reference: string) => names.get(reference) ?? reference;
  return ops.map((op): DiffLine => {
    switch (op.op) {
      case 'addNode': {
        const label = op.name ?? lookup?.(op.type)?.displayName ?? op.type;
        if (op.ref) names.set(op.ref, label);
        const kind = lookup?.(op.type)?.displayName;
        const where = op.before
          ? ` before “${name(op.before)}”`
          : op.after
            ? ` after “${name(op.after)}”${op.output ? ` (output ${op.output})` : ''}`
            : '';
        const params = Object.entries(op.parameters ?? {}).slice(0, 3);
        const set = params.length ? ` · ${params.map(([key, value]) => `${key} = ${preview(value)}`).join(', ')}` : '';
        return { sign: '+', text: `“${label}”${kind && kind !== label ? ` (${kind})` : ''}${where}${set}` };
      }
      case 'setParameters':
        return {
          sign: '~',
          text: `“${name(op.node)}”: ${Object.entries(op.parameters)
            .map(([key, value]) => `${key} = ${preview(value)}`)
            .join(', ')}`,
        };
      case 'connect':
        return { sign: '→', text: `“${name(op.from)}” → “${name(op.to)}”${op.type && op.type !== 'main' ? ` as ${op.type.replace('ai_', '')}` : op.output ? ` (output ${op.output})` : ''}` };
      case 'disconnect':
        return { sign: '−', text: `connection “${name(op.from)}” → “${name(op.to)}”` };
      case 'removeNode':
        return { sign: '−', text: `“${name(op.node)}”` };
      case 'renameNode':
        names.set(op.name, op.name);
        return { sign: '✎', text: `“${name(op.node)}” → “${op.name}”` };
      case 'turnIntoTeam':
        return { sign: '~', text: `“${name(op.node)}” and the agents under it become a team (one Run a Team node)` };
      case 'setNodeSettings':
        return { sign: '~', text: `“${name(op.node)}” settings: ${Object.entries(op.settings).map(([key, value]) => `${key} = ${preview(value)}`).join(', ')}` };
      case 'setWorkflowSettings':
        return { sign: '~', text: `workflow settings: ${Object.entries(op.settings).map(([key, value]) => `${key} = ${preview(value)}`).join(', ')}` };
    }
  });
}

// ---------------------------------------------------------------------------
// Run digests (what the editor sends about a run)
// ---------------------------------------------------------------------------

export interface PortDigest {
  count: number;
  /** The first items' JSON, clipped. */
  sample: unknown[];
}

export interface RunDigest {
  status: string;
  durationMs: number;
  error?: { message: string; description?: string };
  inputs: PortDigest[];
  outputs: PortDigest[];
  logs?: string[];
}

/** A JSON value with long strings, long arrays and deep nesting cut short. */
export function clip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) {
    if (depth > 4) return `[${value.length} items]`;
    const head = value.slice(0, 8).map((v) => clip(v, depth + 1));
    return value.length > 8 ? [...head, `… ${value.length - 8} more`] : head;
  }
  if (value && typeof value === 'object') {
    if (depth > 4) return '{…}';
    const entries = Object.entries(value);
    const head = entries.slice(0, 30).map(([k, v]) => [k, clip(v, depth + 1)]);
    if (entries.length > 30) head.push(['…', `${entries.length - 30} more keys`]);
    return Object.fromEntries(head);
  }
  return value;
}

/** Counts plus the first `size` items of each port: enough to reason about, small enough to send. */
export function digestRun(run: NodeRun, size = 3): RunDigest {
  const port = (items: NodeRun['outputs'][number] | undefined): PortDigest => ({
    count: items?.length ?? 0,
    sample: (items ?? []).slice(0, size).map((item) => clip(item.json)),
  });
  return {
    status: run.status,
    durationMs: run.durationMs,
    ...(run.error && { error: { message: run.error.message, ...(run.error.description && { description: run.error.description }) } }),
    inputs: run.inputs.map(port),
    outputs: run.outputs.map(port),
    ...(run.logs?.length && { logs: run.logs.slice(-6).map((l) => `${l.level}: ${l.message}`.slice(0, 240)) }),
  };
}
