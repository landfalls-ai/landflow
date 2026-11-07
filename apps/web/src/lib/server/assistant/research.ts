/**
 * Deterministic context for the editor assistant: node docs from the
 * registry, a node's parameters, run samples and neighbours, the workflow
 * outline and a keyword search over the node catalog. No model calls here;
 * suggest.ts and the chat tools turn these into prompt text.
 */
import { indexedPorts, isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import { collectionShape, type RunDigest } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo, PropertyDescriptor, Workflow, WorkflowNode } from '@/lib/shared/types';
import { registry } from '../plugins/registry';

/** The node types a proposal may use. */
export const availableTypes = (): NodeTypeInfo[] => registry.nodeTypes().filter((t) => t.available);

const json = (value: unknown, max = 1200) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const conditions = (show?: Record<string, unknown[]>, hide?: Record<string, unknown[]>) =>
  [
    ...Object.entries(show ?? {}).map(([key, values]) => `${key} ∈ ${values.map((v) => JSON.stringify(v)).join('|')}`),
    ...Object.entries(hide ?? {}).map(([key, values]) => `${key} ∉ ${values.map((v) => JSON.stringify(v)).join('|')}`),
  ].join(', ');

/** A number's range, as `1000–3600000`, `≥ 1` or `≤ 100`. */
const range = (p: PropertyDescriptor) => {
  const { minValue: min, maxValue: max } = p.typeOptions ?? {};
  return p.type !== 'number' ? '' : min !== undefined && max !== undefined ? `${min}–${max}` : min !== undefined ? `≥ ${min}` : max !== undefined ? `≤ ${max}` : '';
};

/** A field of a collection: its name, type, label (where the unit is, "Timeout (ms)") and range. */
const describeField = (f: PropertyDescriptor) => `${f.name} (${[f.type, f.displayName !== f.name && `“${f.displayName}”`, range(f)].filter(Boolean).join(', ')})`;

function describeProperty(p: PropertyDescriptor, parameters?: Record<string, unknown>): string {
  const parts = [`${p.name} (${[p.type, p.required && 'required', range(p)].filter(Boolean).join(', ')})`];
  if (p.displayName !== p.name) parts.push(`“${p.displayName}”`);
  if (p.description) parts.push(`— ${p.description.slice(0, 160)}`);
  const option = (o: NonNullable<PropertyDescriptor['options']>[number]) => [o.name !== String(o.value) && o.name, o.description?.slice(0, 120)].filter(Boolean).join(': ');
  if (p.options?.length) parts.push(`options: ${p.options.slice(0, 12).map((o) => `${JSON.stringify(o.value)}${option(o) ? ` (${option(o)})` : ''}`).join(', ')}`);
  if (p.default !== undefined && p.default !== '' && !(typeof p.default === 'object' && !Object.keys(p.default as object).length)) parts.push(`default ${json(p.default, 120)}`);
  const when = conditions(p.displayOptions?.show, p.displayOptions?.hide);
  if (when) parts.push(`shown when ${when}`);
  if (parameters && p.displayOptions && !isPropertyVisible(p, parameters)) parts.push('[hidden with the current parameters]');
  const fields = p.values ?? p.groups?.flatMap((g) => g.values);
  if (fields?.length) parts.push(`fields: ${fields.slice(0, 10).map(describeField).join(', ')}`);
  // Each field's allowed option values, then the exact stored shape: a model that only sees "fixedCollection" writes a flat list.
  const choices = fields?.filter((f) => f.options?.length && !f.typeOptions?.loadOptionsMethod).map((f) => `${f.name} ∈ ${f.options!.slice(0, 24).map((o) => JSON.stringify(o.value)).join('|')}${f.options!.length > 24 ? '|…' : ''}`);
  if (choices?.length) parts.push(`field options: ${choices.join('; ')}`);
  const shape = collectionShape(p);
  if (shape) parts.push(`— ${shape}`);
  return `- ${parts.join(' ')}`;
}

/**
 * The fields of one output item, from the node's `outputSchema`: `name (type) — what it holds`, so a later node reads the
 * field the node really writes (`$json.snapshot`) rather than one it guessed. Empty when the node declares no schema.
 */
export function outputFields(d: NodeTypeInfo['descriptor']): string {
  const properties = (d.outputSchema as { properties?: Record<string, { type?: unknown; description?: unknown }> } | undefined)?.properties;
  if (!properties || typeof properties !== 'object') return '';
  return Object.entries(properties)
    .slice(0, 12)
    .map(([name, p]) => `${name}${typeof p?.type === 'string' ? ` (${p.type})` : ''}${typeof p?.description === 'string' ? ` — ${p.description}` : ''}`)
    .join('; ');
}

/** Everything the registry knows about a node type, as prompt text. With `parameters`, hidden fields are marked. */
export function nodeDocs(info: NodeTypeInfo, parameters?: Record<string, unknown>): string {
  const d = info.descriptor;
  const ports = (list: typeof d.inputs) => list.map((p, i) => `${i}: ${p.type}${p.displayName ? ` “${p.displayName}”` : ''}${p.maxConnections ? ` (max ${p.maxConnections})` : ''}`).join('; ') || 'none';
  const lines = [
    `${d.displayName} — ${info.type} [${d.kind}${d.supplies ? `, supplies ${d.supplies}` : ''}${d.usableAsTool ? ', usable as an agent tool' : ''}]`,
    `${info.pluginId === 'core' ? 'Built in' : `${info.pluginName} plugin (${info.language})`}. ${d.description}`,
    `Inputs: ${ports(d.inputs)}. Outputs: ${ports(d.outputs)}.`,
  ];
  const fields = outputFields(d);
  if (fields) lines.push(`Each output item has: ${fields}.`);
  if (d.credentials?.length) lines.push(`Credentials: ${d.credentials.map((c) => `${c.name}${c.required ? ' (required)' : ''}`).join(', ')}.`);
  if (d.documentationUrl) lines.push(`Docs: ${d.documentationUrl}`);
  const properties = d.properties.filter((p) => p.type !== 'notice');
  const effective = parameters && withPropertyDefaults(d.properties, parameters);
  lines.push(properties.length ? 'Parameters:' : 'No parameters.', ...properties.map((p) => describeProperty(p, effective)));
  return lines.join('\n');
}

export interface SearchHit {
  type: string;
  displayName: string;
  description: string;
  kind: string;
  plugin: string;
  score: number;
}

/** Keyword search over display names, types, keywords, categories and descriptions. */
export function searchNodes(query: string, types: NodeTypeInfo[] = availableTypes(), limit = 8): SearchHit[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits = types.map((info) => {
    const d = info.descriptor;
    const name = d.displayName.toLowerCase();
    const type = info.type.toLowerCase();
    const keywords = (d.keywords ?? []).join(' ').toLowerCase();
    const categories = [...(d.categories ?? []), info.pluginName].join(' ').toLowerCase();
    const description = d.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name === term || type.endsWith(`.${term}`)) score += 8;
      else if (name.includes(term) || type.includes(term)) score += 4;
      if (keywords.includes(term)) score += 3;
      if (categories.includes(term)) score += 2;
      if (description.includes(term)) score += 1;
    }
    return { type: info.type, displayName: d.displayName, description: d.description.slice(0, 160), kind: d.kind, plugin: info.pluginName, score };
  });
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
    .slice(0, limit);
}

/** One line per plugin with its node names: what a workflow can be built from, at a glance. */
export function catalogSummary(types: NodeTypeInfo[] = availableTypes()): string {
  const byPlugin = new Map<string, string[]>();
  for (const t of types) {
    const plugin = t.pluginId === 'core' ? 'Built in' : t.pluginName;
    byPlugin.set(plugin, [...(byPlugin.get(plugin) ?? []), t.descriptor.displayName]);
  }
  return [...byPlugin].map(([plugin, names]) => `- ${plugin}: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ` and ${names.length - 12} more` : ''}`).join('\n');
}

/** One line per available node type: the menu a model picks "next node" ideas from. */
export function catalogIndex(types: NodeTypeInfo[] = availableTypes()): string {
  return types
    .filter((t) => t.descriptor.kind !== 'trigger')
    .map((t) => `- ${t.type}: ${t.descriptor.displayName} — ${t.descriptor.description.slice(0, 80)}`)
    .join('\n');
}

const nodeById = (workflow: Workflow, id: string) => workflow.nodes.find((n) => n.id === id);

/** Names of the nodes wired into and out of a node, with the connection type when it isn't main. */
export function neighbours(workflow: Workflow, nodeId: string) {
  const label = (id: string, type: string, index: number, outputs: boolean) => {
    const name = nodeById(workflow, id)?.name ?? id;
    return type === 'main' ? (outputs && index ? `${name} (from output ${index})` : name) : `${name} (${type})`;
  };
  return {
    upstream: workflow.connections.filter((c) => c.target === nodeId).map((c) => label(c.source, c.type, c.sourceIndex, true)),
    downstream: workflow.connections.filter((c) => c.source === nodeId).map((c) => label(c.target, c.type, c.sourceIndex, false)),
  };
}

function describeRun(run: RunDigest): string {
  const ports = (list: RunDigest['outputs'], label: string) =>
    list.map((p, i) => `${label}${list.length > 1 ? ` ${i}` : ''}: ${p.count} item${p.count === 1 ? '' : 's'}${p.sample.length ? `, first ${p.sample.length}: ${json(p.sample, 1500)}` : ''}`);
  return [
    `Status: ${run.status} in ${run.durationMs} ms.`,
    ...(run.error ? [`Error: ${run.error.message}${run.error.description ? ` — ${run.error.description}` : ''}`] : []),
    ...ports(run.inputs, 'Input'),
    ...ports(run.outputs, 'Output'),
    ...(run.logs?.length ? [`Logs: ${run.logs.join(' | ')}`] : []),
  ].join('\n');
}

/** A node, its docs (with what's visible for its parameters), its neighbours and its last run. */
export function nodeContext(workflow: Workflow, nodeId: string, run: RunDigest | undefined, types: NodeTypeInfo[] = availableTypes()): string {
  const node = nodeById(workflow, nodeId);
  if (!node) return `No node with id ${nodeId}.`;
  const info = types.find((t) => t.type === node.type);
  const { upstream, downstream } = neighbours(workflow, nodeId);
  return [
    `Node “${node.name}” (${node.type})${node.disabled ? ' [disabled]' : ''}${node.onError === 'continue' ? ' [continues on error]' : ''}`,
    `Parameters: ${json(node.parameters, 2000)}`,
    `Upstream: ${upstream.join(', ') || 'none'}. Downstream: ${downstream.join(', ') || 'none'}.`,
    run ? `Last run:\n${describeRun(run)}` : 'Not run yet.',
    info ? `\nNode type docs:\n${nodeDocs(info, node.parameters)}` : `\nNode type ${node.type} is not available (its plugin is offline or unknown).`,
  ].join('\n');
}

/** The main outputs a node shows with its parameters: index (the handle's), name and whether the descriptor names it. */
export function mainOutputs(node: WorkflowNode, types: NodeTypeInfo[]): Array<{ index: number; name?: string }> {
  const info = types.find((t) => t.type === node.type);
  if (!info) return [];
  return indexedPorts(info.descriptor.outputs, node.parameters)
    .filter((p) => p.port.type === 'main' && p.visible)
    .map((p) => ({ index: p.index, ...(p.port.displayName && { name: p.port.displayName }) }));
}

export interface OutlineOptions {
  /** The node types, to list the outputs of nodes that branch. */
  types?: NodeTypeInfo[];
  /** Ids of nodes that were proposed but not applied yet (earlier replies, or this one). */
  pending?: ReadonlySet<string>;
  /** What the pending proposals are, one line each. */
  pendingSummaries?: string[];
  /** Nodes the pending proposals remove (no longer in the nodes above). */
  removed?: Array<{ name: string; type: string }>;
}

function summarizeNode(node: WorkflowNode, options: OutlineOptions, workflow: Workflow): string[] {
  const parameters = json(node.parameters, 300);
  const line = `- “${node.name}” (${node.type})${node.disabled ? ' [disabled]' : ''}${options.pending?.has(node.id) ? ' [pending: proposed, not applied yet]' : ''}: ${parameters}`;
  const outputs = options.types ? mainOutputs(node, options.types) : [];
  if (outputs.length < 2) return [line];
  const target = (index: number) => {
    const names = workflow.connections.filter((c) => c.type === 'main' && c.source === node.id && c.sourceIndex === index).map((c) => `“${nodeById(workflow, c.target)?.name ?? c.target}”`);
    return names.length ? names.join(', ') : 'nothing yet';
  };
  return [line, `  branches: ${outputs.map((o) => `output ${o.index}${o.name ? ` “${o.name}”` : ''} → ${target(o.index)}`).join('; ')}`];
}

/** The whole workflow as prompt text: nodes with parameters, then connections, then which nodes have run data. */
export function workflowOutline(workflow: Workflow, runs: Record<string, RunDigest> = {}, options: OutlineOptions = {}): string {
  const name = (id: string) => nodeById(workflow, id)?.name ?? id;
  const edges = workflow.connections.map((c) =>
    c.type === 'main'
      ? `- “${name(c.source)}”${c.sourceIndex ? ` [output ${c.sourceIndex}]` : ''} → “${name(c.target)}”${c.targetIndex ? ` [input ${c.targetIndex}]` : ''}`
      : `- “${name(c.source)}” → “${name(c.target)}” (${c.type})`,
  );
  const ran = Object.entries(runs)
    .filter(([id]) => nodeById(workflow, id))
    .map(([id, run]) => `“${name(id)}”: ${run.status}${run.error ? ` (${run.error.message.slice(0, 80)})` : `, ${run.outputs.map((p) => p.count).join('/')} out`}`);
  return [
    `Workflow “${workflow.name}”: ${workflow.nodes.length} node${workflow.nodes.length === 1 ? '' : 's'}.`,
    'Nodes:',
    ...(workflow.nodes.length ? workflow.nodes.flatMap((n) => summarizeNode(n, options, workflow)) : ['(none: the canvas is empty)']),
    'Connections:',
    ...(edges.length ? edges : ['(none)']),
    ...(options.pendingSummaries?.length ? ['Pending proposals (already in the nodes and connections above, waiting for the user to apply them; do not propose them again):', ...options.pendingSummaries.map((t) => `- ${t}`)] : []),
    ...(options.removed?.length ? ['Removed by pending proposals (the user asked for them to go; do not add them, or nodes doing their job, back):', ...options.removed.map((r) => `- “${r.name}” (${r.type})`)] : []),
    ...(ran.length ? [`Last run: ${ran.join('; ')}`] : ['No run data yet.']),
  ].join('\n');
}
