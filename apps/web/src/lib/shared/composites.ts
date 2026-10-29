/**
 * Composites (docs/composites.md): a canvas group typed by a composite type, a contract its nodes are checked against.
 * The type names slots (steps the frame must or may contain, each with a matcher over node descriptors), ports (named
 * inputs and outputs) and rules; the group's `composite` names the type, pins its version and binds nodes to slots.
 *
 * Pure helpers shared by the editor (live checks, binding, inserting), the server (the publish gate, template
 * problems, the runner's scopes) and the AI assistant. Nothing here reads a registry: callers pass a `CompositeLookup`.
 */
import type { CompositePort, CompositeRule, CompositeSlot, CompositeTypeDescriptor, ConnectionType, JsonObject, NodeDescriptor, NodeMatcher } from '@landflow/protocol';
import type { GroupComposite, Workflow, WorkflowConnection, WorkflowGroup, WorkflowNode } from '@landflow/engine';
import { frameAround, nodeBox, type Rect } from './groups';

export type { CompositeTypeDescriptor, GroupComposite, NodeMatcher };

/** Where a composite type comes from. */
export type CompositeSource = { kind: 'plugin'; pluginId: string; pluginName: string } | { kind: 'local'; createdBy?: string; updatedAt?: string };

/** A composite type as the host lists it (GET /api/composites). */
export interface CompositeTypeInfo {
  /** Fully-qualified: `triage.aiTriage` (`local.<name>` for the ones saved on this instance). */
  type: string;
  source: CompositeSource;
  /** The newest version. */
  descriptor: CompositeTypeDescriptor;
  /** Every version the source declares, newest first. */
  versions: number[];
  /** Each of those versions' descriptors, newest first, when there are several (frames pin a version). */
  all?: CompositeTypeDescriptor[];
  /** Plugin types: the plugin is online. */
  available: boolean;
}

/** What the checks read: node descriptors by type, and composite types by type and version (none: the newest). */
export interface CompositeLookup {
  node(type: string): NodeDescriptor | undefined;
  composite(type: string, version?: number): CompositeTypeDescriptor | undefined;
}

/** A lookup over the lists the API returns. */
export function compositeLookup(nodeTypes: Record<string, { descriptor: NodeDescriptor }> | Map<string, NodeDescriptor>, composites: Iterable<{ type: string; descriptor: CompositeTypeDescriptor; all?: CompositeTypeDescriptor[] }>): CompositeLookup {
  const byType = new Map<string, CompositeTypeDescriptor[]>();
  for (const info of composites) byType.set(info.type, info.all ?? [info.descriptor]);
  return {
    node: (type) => (nodeTypes instanceof Map ? nodeTypes.get(type) : nodeTypes[type]?.descriptor),
    composite: (type, version) => {
      const list = byType.get(type);
      if (!list?.length) return undefined;
      return version === undefined ? [...list].sort((a, b) => b.version - a.version)[0] : list.find((d) => d.version === version);
    },
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const list = <T>(value: T | T[] | undefined): T[] | undefined => (value === undefined ? undefined : Array.isArray(value) ? value : [value]);

const DESCRIPTOR_FIELDS = ['kind', 'supplies', 'category', 'capability', 'input'] as const;
const hasNodeFields = (m: NodeMatcher) => m.type !== undefined || DESCRIPTOR_FIELDS.some((f) => m[f] !== undefined);

/**
 * Whether a node of `type` (described by `descriptor`) fills a slot with this matcher: every field given matches, and
 * one of `anyOf` does. A matcher naming a `composite` never takes a node (put the alternatives in `anyOf`). Without a
 * descriptor (its plugin is offline) only `type` can be judged.
 */
export function nodeMatches(type: string, descriptor: NodeDescriptor | undefined, matcher: NodeMatcher): boolean {
  if (matcher.composite !== undefined) return false;
  const types = list(matcher.type);
  if (types && !types.includes(type)) return false;
  if (!descriptor) {
    if (!types && DESCRIPTOR_FIELDS.some((f) => matcher[f] !== undefined)) return false;
  } else {
    const kinds = list(matcher.kind);
    if (kinds && !kinds.includes(descriptor.kind)) return false;
    const supplies = list(matcher.supplies);
    if (supplies && (!descriptor.supplies || !supplies.includes(descriptor.supplies))) return false;
    const categories = list(matcher.category)?.map((c) => c.toLowerCase());
    if (categories && !(descriptor.categories ?? []).some((c) => categories.includes(c.toLowerCase()))) return false;
    const capabilities = list(matcher.capability);
    if (capabilities && !(descriptor.capabilities ?? []).some((c) => capabilities.includes(c))) return false;
    if (matcher.input && !descriptor.inputs.some((port) => port.type === matcher.input)) return false;
  }
  return !matcher.anyOf || matcher.anyOf.some((m) => nodeMatches(type, descriptor, m));
}

/** Whether a nested composite of `type` fills a slot with this matcher. */
export function compositeMatches(type: string, matcher: NodeMatcher): boolean {
  const own = matcher.composite !== undefined ? Boolean(list(matcher.composite)?.includes(type)) : !hasNodeFields(matcher) && Boolean(matcher.anyOf);
  return own && (!matcher.anyOf || matcher.anyOf.some((m) => compositeMatches(type, m)));
}

/** The slot takes nested composites only, never a node. */
export function takesCompositeOnly(matcher: NodeMatcher): boolean {
  if (hasNodeFields(matcher)) return false;
  return matcher.composite !== undefined || Boolean(matcher.anyOf?.length && matcher.anyOf.every(takesCompositeOnly));
}

/** A matcher in a few words, for "Accepts …" and the node creator's filter. */
export function describeMatcher(matcher: NodeMatcher, lookup?: Pick<CompositeLookup, 'node'>): string {
  const parts: string[] = [];
  const types = list(matcher.type);
  if (types) parts.push(types.map((t) => lookup?.node(t)?.displayName ?? t).join(' or '));
  const supplies = list(matcher.supplies);
  if (supplies) parts.push(supplies.map((s) => SUPPLY_LABEL[s] ?? s).join(' or '));
  const capabilities = list(matcher.capability);
  if (capabilities) parts.push(`a node that can ${capabilities.join(' or ')}`);
  const categories = list(matcher.category);
  if (categories) parts.push(`a${matcher.input ? 'n' : ''} ${categories.join(' or ')} node`);
  if (matcher.input && !categories) parts.push(`a node with a ${SUPPLY_LABEL[matcher.input] ?? matcher.input} input`);
  else if (matcher.input) parts.push(`with a ${SUPPLY_LABEL[matcher.input] ?? matcher.input} input`);
  const kinds = list(matcher.kind);
  if (kinds && !parts.length) parts.push(`a${kinds[0] === 'action' ? 'n' : ''} ${kinds.join(' or ')}`);
  const composites = list(matcher.composite);
  if (composites) parts.push(`a ${composites.join(' or ')} composite`);
  const own = parts.join(' ');
  const any = matcher.anyOf?.map((m) => describeMatcher(m, lookup)).join(', or ');
  return [own, any].filter(Boolean).join(own && any ? ', and ' : '') || 'any node';
}

const SUPPLY_LABEL: Partial<Record<ConnectionType, string>> = {
  ai_languageModel: 'a chat model',
  ai_tool: 'a tool',
  ai_memory: 'a memory',
  ai_embedding: 'an embeddings model',
  ai_document: 'a document loader',
  ai_textSplitter: 'a text splitter',
  ai_retriever: 'a retriever',
  ai_reranker: 'a reranker',
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

type GroupsOf = Pick<Workflow, 'groups'>;

/**
 * A composite's members: its own nodes and those of plain groups nested in it, down to (not into) nested composites.
 * `composites` are the nested composite groups whose nearest composite ancestor is this one: what a composite slot
 * can bind. `all` is every node inside, nested composites' included.
 */
export function compositeMembers(workflow: GroupsOf, groupId: string): { nodes: string[]; composites: string[]; all: string[] } {
  const groups = workflow.groups ?? [];
  const nodes: string[] = [];
  const composites: string[] = [];
  const all: string[] = [];
  const walk = (id: string, own: boolean) => {
    const group = groups.find((g) => g.id === id);
    if (!group) return;
    if (own) nodes.push(...group.nodeIds);
    all.push(...group.nodeIds);
    for (const child of groups) {
      if (child.parentId !== id || child.id === groupId) continue;
      if (own && child.composite) composites.push(child.id);
      walk(child.id, own && !child.composite);
    }
  };
  walk(groupId, true);
  return { nodes, composites, all };
}

/** The composite a node fills a slot of (its nearest composite frame), if any. */
export function compositeOfNode(workflow: GroupsOf, nodeId: string): WorkflowGroup | undefined {
  const groups = workflow.groups ?? [];
  let group = groups.find((g) => g.nodeIds.includes(nodeId));
  for (let guard = 0; group && guard < 50; guard++) {
    if (group.composite) return group;
    group = group.parentId ? groups.find((g) => g.id === group!.parentId) : undefined;
  }
  return undefined;
}

/** The slot a node or nested composite is bound to. */
export function slotOf(composite: GroupComposite | undefined, id: string): string | undefined {
  if (!composite) return undefined;
  return Object.entries(composite.slots).find(([, ids]) => ids.includes(id))?.[0];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type CompositeFix =
  | { kind: 'onError'; nodeId: string; value: 'stop' | 'continue' }
  | { kind: 'upgrade'; version: number }
  | { kind: 'unbind'; slot: string; id: string };

export interface CompositeIssue {
  groupId: string;
  /** Errors block publishing; warnings don't. */
  severity: 'error' | 'warning';
  code: 'unknown-type' | 'version' | 'slot-empty' | 'slot-full' | 'slot-mismatch' | 'closed' | 'feeds' | 'on-error' | 'reaches' | 'sealed';
  message: string;
  slot?: string;
  nodeId?: string;
  fix?: CompositeFix;
}

export interface SlotReport extends Pick<CompositeSlot, 'name' | 'displayName' | 'description' | 'accepts' | 'locked'> {
  min: number;
  max?: number;
  /** Bound node (or nested composite) ids that are in the frame. */
  filled: string[];
  /** Filled, within its bounds, and every node fits. */
  ok: boolean;
  /** Takes nested composites, not nodes. */
  composite: boolean;
}

export interface RuleReport {
  rule: CompositeRule['rule'];
  label: string;
  ok: boolean;
}

export interface PortReport {
  name: string;
  displayName: string;
  /** Outputs: the node and output index the port carries. */
  nodeId?: string;
  index: number;
  /** Outputs: something outside the frame is connected to it. */
  wired: boolean;
}

export interface CompositeReport {
  groupId: string;
  name: string;
  type: string;
  version: number;
  /** The contract checked against; absent when no version of the type is known here. */
  descriptor?: CompositeTypeDescriptor;
  /** A newer version of the type exists. */
  latestVersion?: number;
  slots: SlotReport[];
  rules: RuleReport[];
  inputs: PortReport[];
  outputs: PortReport[];
  /** Members bound to no slot. */
  free: string[];
  issues: CompositeIssue[];
}

type Graph = Pick<Workflow, 'nodes' | 'connections' | 'groups'>;

const nameOf = (nodes: Map<string, WorkflowNode>, id: string) => nodes.get(id)?.name ?? id;
const quote = (text: string) => `“${text}”`;
const joinNames = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Every composite frame of the workflow, checked against its contract. */
export function compositeReports(workflow: Graph, lookup: CompositeLookup): CompositeReport[] {
  const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
  const groups = new Map((workflow.groups ?? []).map((g) => [g.id, g]));
  const reports: CompositeReport[] = [];
  for (const group of workflow.groups ?? []) {
    if (!group.composite) continue;
    reports.push(checkOne(group, group.composite, workflow, nodes, groups, lookup));
  }
  return reports;
}

/** The issues of every composite frame, errors first. */
export function compositeIssues(workflow: Graph, lookup: CompositeLookup): CompositeIssue[] {
  return compositeReports(workflow, lookup)
    .flatMap((r) => r.issues)
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

function checkOne(group: WorkflowGroup, composite: GroupComposite, workflow: Graph, nodes: Map<string, WorkflowNode>, groups: Map<string, WorkflowGroup>, lookup: CompositeLookup): CompositeReport {
  const issues: CompositeIssue[] = [];
  const issue = (severity: CompositeIssue['severity'], code: CompositeIssue['code'], message: string, extra: Partial<CompositeIssue> = {}) => issues.push({ groupId: group.id, severity, code, message, ...extra });
  const latest = lookup.composite(composite.type);
  let descriptor = lookup.composite(composite.type, composite.version);
  const base: CompositeReport = { groupId: group.id, name: group.name, type: composite.type, version: composite.version, slots: [], rules: [], inputs: [], outputs: [], free: [], issues };
  if (!descriptor && !latest) {
    issue('warning', 'unknown-type', `${quote(group.name)}: its contract ${composite.type} isn’t available here (its plugin is offline or not installed), so it isn’t checked`);
    return base;
  }
  if (!descriptor) {
    descriptor = latest!;
    issue('warning', 'version', `${quote(group.name)} was built for ${composite.type} v${composite.version}, which isn’t declared any more: checked against v${latest!.version}`, { fix: { kind: 'upgrade', version: latest!.version } });
  }
  const members = compositeMembers(workflow, group.id);
  const memberSet = new Set(members.nodes);
  const nestedSet = new Set(members.composites);
  const inside = new Set(members.all);
  const report: CompositeReport = { ...base, descriptor, ...(latest && latest.version > descriptor.version && { latestVersion: latest.version }) };

  // Slots
  const bound = new Set<string>();
  const slotNodes = new Map<string, string[]>();
  for (const slot of descriptor.slots) {
    const takesComposite = takesCompositeOnly(slot.accepts);
    const filled = (composite.slots[slot.name] ?? []).filter((id) => memberSet.has(id) || nestedSet.has(id));
    filled.forEach((id) => bound.add(id));
    slotNodes.set(
      slot.name,
      filled.filter((id) => memberSet.has(id)),
    );
    const min = slot.min ?? 1;
    let ok = true;
    if (filled.length < min) {
      ok = false;
      issue('error', 'slot-empty', filled.length === 0 ? `${slot.displayName} is empty: add ${describeMatcher(slot.accepts, lookup)}` : `${slot.displayName} needs at least ${min}; it has ${filled.length}`, { slot: slot.name });
    }
    if (slot.max !== undefined && filled.length > slot.max) {
      ok = false;
      issue('error', 'slot-full', `${slot.displayName} takes ${slot.max === 1 ? 'one' : `at most ${slot.max}`}; ${filled.length} are bound to it`, { slot: slot.name });
    }
    for (const id of filled) {
      const node = nodes.get(id);
      const fits = node ? nodeMatches(node.type, lookup.node(node.type), slot.accepts) : compositeMatches(groups.get(id)?.composite?.type ?? '', slot.accepts);
      if (!fits) {
        ok = false;
        issue('error', 'slot-mismatch', `${quote(node?.name ?? groups.get(id)?.name ?? id)} can’t fill ${slot.displayName}: it takes ${describeMatcher(slot.accepts, lookup)}`, { slot: slot.name, nodeId: id, fix: { kind: 'unbind', slot: slot.name, id } });
      }
    }
    report.slots.push({ name: slot.name, displayName: slot.displayName, ...(slot.description && { description: slot.description }), accepts: slot.accepts, ...(slot.locked && { locked: true }), min, ...(slot.max !== undefined && { max: slot.max }), filled, ok, composite: takesComposite });
  }
  report.free = members.nodes.filter((id) => !bound.has(id));
  if (descriptor.closed) for (const id of report.free) issue('error', 'closed', `${quote(nameOf(nodes, id))} fills no slot, and ${descriptor.displayName} allows only its slots`, { nodeId: id });

  const slotLabel = (name: string) => descriptor.slots.find((s) => s.name === name)?.displayName ?? name;
  const main = workflow.connections.filter((c) => c.type === 'main');

  // Ports
  const outPorts = descriptor.outputs ?? [];
  for (const port of outPorts) {
    const nodeId = port.slot ? slotNodes.get(port.slot)?.[0] : undefined;
    const index = port.index ?? 0;
    const wired = Boolean(nodeId && main.some((c) => c.source === nodeId && c.sourceIndex === index && !inside.has(c.target)));
    report.outputs.push({ name: port.name, displayName: port.displayName ?? port.name, ...(nodeId && { nodeId }), index, wired });
  }
  for (const port of descriptor.inputs ?? []) {
    const nodeId = port.slot ? slotNodes.get(port.slot)?.[0] : undefined;
    report.inputs.push({ name: port.name, displayName: port.displayName ?? port.name, ...(nodeId && { nodeId }), index: port.index ?? 0, wired: Boolean(nodeId && main.some((c) => c.target === nodeId && !inside.has(c.source))) });
  }

  // Rules
  for (const rule of descriptor.rules ?? []) {
    let ok = true;
    if (rule.rule === 'feeds') {
      const via = rule.via ?? 'main';
      const from = new Set(slotNodes.get(rule.from) ?? []);
      for (const target of slotNodes.get(rule.to) ?? []) {
        if (!from.size) break;
        if (!workflow.connections.some((c) => c.type === via && c.target === target && from.has(c.source))) {
          ok = false;
          issue('error', 'feeds', `${slotLabel(rule.from)} isn’t connected to ${quote(nameOf(nodes, target))}${via === 'main' ? '' : ` (${SUPPLY_LABEL[via] ?? via} input)`}`, { slot: rule.to, nodeId: target });
        }
      }
      report.rules.push({ rule: rule.rule, label: `${slotLabel(rule.from)} feeds ${slotLabel(rule.to)}`, ok });
    } else if (rule.rule === 'onError') {
      for (const slot of rule.slots) {
        for (const id of slotNodes.get(slot) ?? []) {
          const node = nodes.get(id);
          if (!node || (node.onError ?? 'stop') === rule.value) continue;
          ok = false;
          issue('error', 'on-error', rule.value === 'continue' ? `${quote(node.name)} stops on error: ${descriptor.displayName} needs it to continue, so a failure still reaches the rest of the frame` : `${quote(node.name)} continues on error: ${descriptor.displayName} needs it to stop`, { slot, nodeId: id, fix: { kind: 'onError', nodeId: id, value: rule.value } });
        }
      }
      report.rules.push({ rule: rule.rule, label: `${joinNames(rule.slots.map(slotLabel))} ${rule.value === 'continue' ? 'continue' : 'stop'} on error`, ok });
    } else if (rule.rule === 'reaches') {
      const goal = new Set(slotNodes.get(rule.to) ?? []);
      if (goal.size) {
        const entries = entryNodes(members.all, inside, main, nodes, lookup);
        for (const entry of entries) {
          if (reaches(entry, goal, inside, main)) continue;
          ok = false;
          issue('error', 'reaches', `${quote(nameOf(nodes, entry))} doesn’t lead to ${slotLabel(rule.to)}`, { slot: rule.to, nodeId: entry });
        }
      }
      report.rules.push({ rule: rule.rule, label: `Every path from the input reaches ${slotLabel(rule.to)}`, ok });
    } else if (rule.rule === 'sealed') {
      const exits = new Set(report.outputs.filter((p) => p.nodeId).map((p) => `${p.nodeId}:${p.index}`));
      const inputSlots = (descriptor.inputs ?? []).flatMap((p) => (p.slot ? [p.slot] : []));
      const entryAllowed = new Set(inputSlots.flatMap((s) => slotNodes.get(s) ?? []));
      for (const c of main) {
        if (inside.has(c.source) && !inside.has(c.target) && !exits.has(`${c.source}:${c.sourceIndex}`)) {
          ok = false;
          issue('warning', 'sealed', `${quote(nameOf(nodes, c.source))} connects out of the frame${outPorts.length ? `; only ${joinNames(outPorts.map((p) => p.displayName ?? p.name))} should` : ''}`, { nodeId: c.source });
        }
        if (!inside.has(c.source) && inside.has(c.target) && inputSlots.length && !entryAllowed.has(c.target)) {
          ok = false;
          issue('warning', 'sealed', `${quote(nameOf(nodes, c.source))} connects into ${quote(nameOf(nodes, c.target))}; the frame takes its input at ${joinNames(inputSlots.map(slotLabel))}`, { nodeId: c.target });
        }
      }
      report.rules.push({ rule: rule.rule, label: outPorts.length ? `Connections leave only through ${joinNames(outPorts.map((p) => p.displayName ?? p.name))}` : 'Connections stay inside the frame', ok });
    }
  }
  return report;
}

/** Where the frame's input lands: members fed from outside, else the members nothing inside feeds (sub-nodes aside). */
function entryNodes(all: string[], inside: Set<string>, main: WorkflowConnection[], nodes: Map<string, WorkflowNode>, lookup: CompositeLookup): string[] {
  const fed = all.filter((id) => main.some((c) => c.target === id && !inside.has(c.source)));
  if (fed.length) return fed;
  return all.filter((id) => {
    const node = nodes.get(id);
    if (!node || lookup.node(node.type)?.kind === 'subnode') return false;
    return !main.some((c) => c.target === id && inside.has(c.source));
  });
}

function reaches(from: string, goal: Set<string>, inside: Set<string>, main: WorkflowConnection[]): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    if (goal.has(at)) return true;
    for (const c of main) if (c.source === at && inside.has(c.target) && !seen.has(c.target)) (seen.add(c.target), queue.push(c.target));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/** The slots that would take this node now: they accept it and have room. Unfilled required slots come first. */
export function slotsFor(report: Pick<CompositeReport, 'slots'>, type: string, descriptor: NodeDescriptor | undefined): SlotReport[] {
  return report.slots
    .filter((slot) => !slot.composite && nodeMatches(type, descriptor, slot.accepts) && (slot.max === undefined || slot.filled.length < slot.max))
    .sort((a, b) => Number(b.filled.length < b.min) - Number(a.filled.length < a.min));
}

/** `composite` with `id` bound to `slot` (and to no other slot). */
export function bindSlot(composite: GroupComposite, slot: string, id: string): GroupComposite {
  const slots = unbindAll(composite.slots, id);
  return { ...composite, slots: { ...slots, [slot]: [...(slots[slot] ?? []), id] } };
}

/** `composite` with `id` bound to no slot (and dropped from the fallback targets). */
export function unbindSlot(composite: GroupComposite, id: string): GroupComposite {
  return { ...composite, slots: unbindAll(composite.slots, id) };
}

function unbindAll(slots: Record<string, string[]>, id: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(slots)) {
    const kept = ids.filter((x) => x !== id);
    if (kept.length) out[name] = kept;
  }
  return out;
}

/**
 * Bind a node that just joined a composite to the slot it obviously fills: the only slot that accepts it with room,
 * else the only unfilled required one that does. Unchanged when it's already bound or the choice isn't clear.
 */
export function autoBind(workflow: Graph, groupId: string, nodeId: string, lookup: CompositeLookup): GroupComposite | undefined {
  const group = workflow.groups?.find((g) => g.id === groupId);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!group?.composite || !node || slotOf(group.composite, nodeId)) return undefined;
  const report = compositeReports({ ...workflow, groups: [group, ...(workflow.groups ?? []).filter((g) => g.id !== groupId)] }, lookup).find((r) => r.groupId === groupId);
  if (!report?.descriptor) return undefined;
  const candidates = slotsFor(report, node.type, lookup.node(node.type));
  const needed = candidates.filter((s) => s.filled.length < s.min);
  const pick = candidates.length === 1 ? candidates[0] : needed.length === 1 ? needed[0] : undefined;
  return pick ? bindSlot(group.composite, pick.name, nodeId) : undefined;
}

/** Drop bindings to ids that aren't members any more, and fallback targets that are gone. */
export function pruneComposite(composite: GroupComposite, members: Iterable<string>, nodeIds: Iterable<string>): GroupComposite {
  const keep = new Set(members);
  const known = new Set(nodeIds);
  const slots: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(composite.slots ?? {})) {
    const kept = [...new Set(ids.filter((id) => typeof id === 'string' && keep.has(id)))];
    if (kept.length) slots[name] = kept;
  }
  const fallback = composite.fallback?.filter((f) => known.has(f.target));
  return {
    type: composite.type,
    version: composite.version,
    slots,
    ...(composite.params && Object.keys(composite.params).length > 0 && { params: composite.params }),
    ...(fallback?.length && { fallback }),
  };
}

// ---------------------------------------------------------------------------
// Inserting and making types
// ---------------------------------------------------------------------------

/**
 * A new frame of this type at `at` (the canvas point for the frame's top-left corner): the starter's nodes with fresh
 * ids and unique names, their connections, and the group with the slots bound. A type without a starter gives an
 * empty frame, its slots shown as placeholders.
 */
export function instantiateComposite(type: string, descriptor: CompositeTypeDescriptor, at: { x: number; y: number }, options: { takenNames: Iterable<string>; newId: () => string; groupId: string }): { nodes: WorkflowNode[]; connections: WorkflowConnection[]; group: WorkflowGroup } {
  const taken = new Set(options.takenNames);
  const ids = new Map<string, string>();
  const nodes: WorkflowNode[] = (descriptor.starter?.nodes ?? []).map((n) => {
    const id = options.newId();
    ids.set(n.id, id);
    let name = n.name;
    for (let i = 2; taken.has(name); i++) name = `${n.name} ${i}`;
    taken.add(name);
    return {
      id,
      name,
      type: n.type,
      typeVersion: n.typeVersion ?? 1,
      position: [Math.round(at.x + n.position[0]), Math.round(at.y + n.position[1])],
      parameters: { ...(n.parameters ?? {}) },
      ...(n.onError && { onError: n.onError }),
      ...(n.retryOnFail && { retryOnFail: true }),
      ...(n.maxTries && { maxTries: n.maxTries }),
    } as WorkflowNode;
  });
  const connections: WorkflowConnection[] = (descriptor.starter?.connections ?? []).flatMap((c) => {
    const source = ids.get(c.source);
    const target = ids.get(c.target);
    if (!source || !target) return [];
    return [{ id: options.newId(), type: c.type ?? 'main', source, sourceIndex: c.sourceIndex ?? 0, target, targetIndex: c.targetIndex ?? 0 }];
  });
  const slots: Record<string, string[]> = {};
  for (const n of descriptor.starter?.nodes ?? []) if (n.slot) (slots[n.slot] ??= []).push(ids.get(n.id)!);
  const frame: Rect = frameAround(nodes.map((n) => nodeBox({ x: n.position[0], y: n.position[1] }))) ?? { x: at.x, y: at.y, width: 520, height: 280 };
  const placeholders = descriptor.slots.filter((s) => (s.min ?? 1) > (slots[s.name]?.length ?? 0)).length;
  return {
    nodes,
    connections,
    group: {
      id: options.groupId,
      name: descriptor.displayName,
      nodeIds: nodes.map((n) => n.id),
      position: [Math.min(frame.x, at.x), Math.min(frame.y, at.y)],
      width: Math.max(frame.width, 520),
      height: Math.max(frame.height, placeholders ? 300 : 220),
      composite: { type, version: descriptor.version, slots },
    },
  };
}

/** Lowercase identifier from a label: "AI triage (fail-open)" → `aiTriageFailOpen`. */
export function identifierFrom(label: string): string {
  const words = label.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const id = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[a-zA-Z]/.test(id) ? id : `composite${id}`;
}

/**
 * A composite type proposed from a plain group: one slot per node type inside (exact type, as many as there are),
 * outputs where main connections leave the frame, a `feeds` rule per sub-node connection, an `onError` rule for slots
 * whose nodes all continue, and the members as the starter. The author loosens the matchers before saving.
 */
export function proposeComposite(workflow: Graph, groupId: string, lookup: Pick<CompositeLookup, 'node'>): { descriptor: CompositeTypeDescriptor; slots: Record<string, string[]> } | undefined {
  const group = workflow.groups?.find((g) => g.id === groupId);
  if (!group) return undefined;
  const members = compositeMembers(workflow, groupId).nodes;
  const memberSet = new Set(members);
  const nodes = workflow.nodes.filter((n) => memberSet.has(n.id));
  const byType = new Map<string, WorkflowNode[]>();
  for (const node of nodes) byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
  const slotNames = new Set<string>();
  const slots: CompositeSlot[] = [];
  const bindings: Record<string, string[]> = {};
  const slotOfNode = new Map<string, string>();
  for (const [type, list] of byType) {
    const descriptor = lookup.node(type);
    const label = descriptor?.displayName ?? list[0].name;
    let name = identifierFrom(label);
    for (let i = 2; slotNames.has(name); i++) name = `${identifierFrom(label)}${i}`;
    slotNames.add(name);
    slots.push({ name, displayName: label, accepts: descriptor?.kind === 'subnode' && descriptor.supplies ? { supplies: descriptor.supplies } : { type }, ...(list.length > 1 && { min: list.length }), max: list.length });
    bindings[name] = list.map((n) => n.id);
    list.forEach((n) => slotOfNode.set(n.id, name));
  }
  const outputs: CompositePort[] = [];
  const portNames = new Set<string>();
  for (const c of workflow.connections) {
    if (c.type !== 'main' || !memberSet.has(c.source) || memberSet.has(c.target)) continue;
    const slot = slotOfNode.get(c.source)!;
    if (outputs.some((p) => p.slot === slot && (p.index ?? 0) === c.sourceIndex)) continue;
    const node = workflow.nodes.find((n) => n.id === c.source)!;
    const label = lookup.node(node.type)?.outputs[c.sourceIndex]?.displayName ?? (c.sourceIndex ? `${node.name} ${c.sourceIndex + 1}` : node.name);
    let name = identifierFrom(label);
    for (let i = 2; portNames.has(name); i++) name = `${identifierFrom(label)}${i}`;
    portNames.add(name);
    outputs.push({ name, displayName: label, slot, index: c.sourceIndex });
  }
  const rules: CompositeRule[] = [];
  for (const c of workflow.connections) {
    if (c.type === 'main' || !memberSet.has(c.source) || !memberSet.has(c.target)) continue;
    const from = slotOfNode.get(c.source)!;
    const to = slotOfNode.get(c.target)!;
    if (!rules.some((r) => r.rule === 'feeds' && r.from === from && r.to === to)) rules.push({ rule: 'feeds', from, to, via: c.type });
  }
  const continuing = slots.filter((s) => bindings[s.name].every((id) => nodes.find((n) => n.id === id)?.onError === 'continue')).map((s) => s.name);
  if (continuing.length) rules.push({ rule: 'onError', slots: continuing, value: 'continue' });
  const origin = { x: group.position[0], y: group.position[1] };
  const descriptor: CompositeTypeDescriptor = {
    name: identifierFrom(group.name),
    displayName: group.name,
    description: '',
    version: 1,
    ...(outputs.length && { outputs }),
    slots,
    ...(rules.length && { rules }),
    starter: {
      nodes: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        ...(n.typeVersion !== 1 && { typeVersion: n.typeVersion }),
        position: [Math.round(n.position[0] - origin.x), Math.round(n.position[1] - origin.y)],
        ...(Object.keys(n.parameters ?? {}).length > 0 && { parameters: stripCredentials(n.parameters) }),
        ...(n.onError && n.onError !== 'stop' && { onError: n.onError }),
        ...(n.retryOnFail && { retryOnFail: true }),
        ...(n.maxTries && { maxTries: n.maxTries }),
        slot: slotOfNode.get(n.id)!,
      })),
      connections: workflow.connections.filter((c) => memberSet.has(c.source) && memberSet.has(c.target)).map((c) => ({ source: c.source, sourceIndex: c.sourceIndex, target: c.target, targetIndex: c.targetIndex, ...(c.type !== 'main' && { type: c.type }) })),
    },
  };
  return { descriptor, slots: bindings };
}

/** Parameters as a starter keeps them: plain JSON, no credential ids of this instance. */
function stripCredentials(parameters: unknown): JsonObject {
  return JSON.parse(JSON.stringify(parameters ?? {}, (key, value) => (key === 'credentials' ? undefined : value)));
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** A composite frame as the executor runs it (packages/engine ExecutionScope), built from the groups and their types. */
export interface CompositeScope {
  id: string;
  name: string;
  type: string;
  /** Every node inside, nested frames' included. */
  nodeIds: string[];
  onError?: 'stop' | 'fallback';
  fallback?: Array<{ target: string; targetIndex: number }>;
  timeoutSeconds?: number;
  params?: Record<string, unknown>;
}

/** The scopes of a workflow's composites: those whose type asks for whole-frame error handling, a timeout or params. */
export function compositeScopes(workflow: Graph, lookup: Pick<CompositeLookup, 'composite'>): CompositeScope[] {
  const scopes: CompositeScope[] = [];
  for (const group of workflow.groups ?? []) {
    const composite = group.composite;
    if (!composite) continue;
    const descriptor = lookup.composite(composite.type, composite.version) ?? lookup.composite(composite.type);
    const params = { ...defaults(descriptor), ...(composite.params ?? {}) };
    const hasParams = Object.keys(params).length > 0;
    if (!descriptor || (descriptor.onError !== 'fallback' && !descriptor.timeoutSeconds && !hasParams)) continue;
    const nodeIds = compositeMembers(workflow, group.id).all.filter((id) => workflow.nodes.some((n) => n.id === id));
    if (!nodeIds.length) continue;
    scopes.push({
      id: group.id,
      name: group.name,
      type: composite.type,
      nodeIds,
      ...(descriptor.onError === 'fallback' && { onError: 'fallback' as const, fallback: (composite.fallback ?? []).map((f) => ({ target: f.target, targetIndex: f.targetIndex ?? 0 })) }),
      ...(descriptor.timeoutSeconds && { timeoutSeconds: descriptor.timeoutSeconds }),
      ...(hasParams && { params }),
    });
  }
  return scopes;
}

function defaults(descriptor: CompositeTypeDescriptor | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of descriptor?.properties ?? []) if (p.default !== undefined) out[p.name] = p.default;
  return out;
}
