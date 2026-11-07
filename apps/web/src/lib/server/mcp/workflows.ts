/**
 * Workflows as coding agents write them over the instance MCP server: nodes may leave out ids,
 * positions, type versions and default parameters, and connections may name their nodes by name
 * instead of id. `normalizeWorkflow` fills all of that in; `validateWorkflow` checks a workflow
 * against the registry (node types, required parameters and sub-nodes, ports, connections).
 */
import { nanoid } from 'nanoid';
import { defaultParameters, defaultVersionOf, indexedPorts, isPropertyVisible, withPropertyDefaults, type NodeDescriptor } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import { registry } from '../plugins/registry';
import { unguardedRosterTargets } from '../chat';
import { workflowSchema } from '../schemas';
import { store } from '../store';
import type { ExecutionRecord } from '../../shared/types';
import { checkExpressionFields, describeIssue, fieldsOfItems, outputSchemaOf, schemaFields, type KnownFields } from './expression-fields';

export interface WorkflowValidation {
  valid: boolean;
  /** Problems that stop the workflow from running as intended. */
  errors: string[];
  /** Things to check (credentials to pick in the editor, unknown parameters, no trigger…). */
  warnings: string[];
}

interface NodeInput {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ConnectionInput {
  id?: string;
  type?: string;
  source: string;
  target: string;
  sourceIndex?: number;
  targetIndex?: number;
}

export interface WorkflowInput {
  nodes?: NodeInput[];
  connections?: ConnectionInput[];
  [key: string]: unknown;
}

const descriptorOf = (type: string): NodeDescriptor | undefined => {
  const resolved = registry.resolve(type);
  return 'error' in resolved ? undefined : resolved.descriptor;
};

/**
 * Fill in what an agent may leave out. Node ids, type versions and default parameters; positions
 * left to right (sub-nodes below the node they attach to); connection ids and types; connection
 * ends given as node names. `previous` keeps the positions of nodes that already exist.
 */
export function normalizeWorkflow<T extends WorkflowInput>(input: T, previous?: Pick<Workflow, 'nodes'>): T {
  const used = new Set<string>();
  const nodes = (input.nodes ?? []).map((node, index): NodeInput => {
    let id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : '';
    if (!id || used.has(id)) id = `n_${nanoid(8)}`;
    used.add(id);
    const descriptor = typeof node.type === 'string' ? descriptorOf(node.type) : undefined;
    const existing = previous?.nodes.find((n) => n.id === id);
    const old = existing ?? previous?.nodes.find((n) => n.name === node.name);
    return {
      ...node,
      id,
      typeVersion: node.typeVersion ?? existing?.typeVersion ?? (descriptor ? defaultVersionOf(descriptor) : 1),
      // A new node gets the defaults the editor would give it; an existing one keeps its parameters as sent.
      parameters: descriptor && !existing ? { ...defaultParameters(descriptor), ...node.parameters } : (node.parameters ?? {}),
      position: node.position ?? old?.position ?? [index * 240, 0],
    };
  });
  const idOf = (ref: string) => nodes.find((n) => n.id === ref)?.id ?? nodes.find((n) => n.name === ref)?.id ?? ref;
  const connections = (input.connections ?? []).map((connection) => ({
    id: connection.id || `e_${nanoid(8)}`,
    type: connection.type || 'main',
    source: idOf(String(connection.source ?? '')),
    target: idOf(String(connection.target ?? '')),
    sourceIndex: connection.sourceIndex ?? 0,
    targetIndex: connection.targetIndex ?? 0,
  }));
  // Sub-nodes without a position go under the node they supply.
  for (const connection of connections) {
    if (connection.type === 'main') continue;
    const sub = nodes.find((n) => n.id === connection.source);
    const root = nodes.find((n) => n.id === connection.target);
    const given = input.nodes?.find((n) => n.name === sub?.name)?.position;
    if (sub && root && !given && !previous?.nodes.some((n) => n.id === sub.id)) sub.position = [root.position![0], root.position![1] + 200];
  }
  return { ...input, nodes, connections };
}

const isEmpty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);

/** Check a workflow (normalized, or as saved) against the registry. */
export function validateWorkflow(input: unknown): WorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) errors.push(`${issue.path.join('.') || 'workflow'}: ${issue.message}`);
    return { valid: false, errors, warnings };
  }
  const workflow = parsed.data;
  const byId = new Map<string, (typeof workflow.nodes)[number]>();
  const descriptors = new Map<string, NodeDescriptor>();
  const parametersOf = new Map<string, Record<string, unknown>>();

  for (const node of workflow.nodes) {
    if (byId.has(node.id)) errors.push(`Two nodes have the id "${node.id}"`);
    byId.set(node.id, node);
    const resolved = registry.resolve(node.type);
    if ('error' in resolved) {
      errors.push(`Node "${node.name}": ${resolved.error}`);
      continue;
    }
    const { descriptor } = resolved;
    descriptors.set(node.id, descriptor);
    const parameters = withPropertyDefaults(descriptor.properties, node.parameters);
    parametersOf.set(node.id, parameters);
    const known = new Set(descriptor.properties.map((p) => p.name));
    const unknown = Object.keys(node.parameters).filter((key) => !known.has(key));
    if (unknown.length) warnings.push(`Node "${node.name}": unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')} (see get_node_type)`);
    for (const property of descriptor.properties) {
      if (!property.required || property.type === 'notice' || !isPropertyVisible(property, parameters)) continue;
      if (isEmpty(parameters[property.name])) errors.push(`Node "${node.name}": “${property.displayName}” (${property.name}) is required`);
    }
    for (const credential of descriptor.credentials ?? []) {
      if (credential.required && isPropertyVisible(credential, parameters) && !node.credentials?.[credential.name]) {
        warnings.push(`Node "${node.name}": needs a ${credential.name} credential, chosen in the editor`);
      }
    }
  }

  const counts = new Map<string, number>();
  const connected = new Set<string>();
  for (const connection of workflow.connections) {
    const source = byId.get(connection.source);
    const target = byId.get(connection.target);
    if (!source || !target) {
      errors.push(`Connection ${connection.id}: no node "${!source ? connection.source : connection.target}"`);
      continue;
    }
    connected.add(source.id);
    connected.add(target.id);
    const from = descriptors.get(source.id);
    const to = descriptors.get(target.id);
    if (!from || !to) continue;
    const label = `"${source.name}" → "${target.name}"`;
    const outputs = indexedPorts(from.outputs, parametersOf.get(source.id));
    const inputs = indexedPorts(to.inputs, parametersOf.get(target.id));
    const supplies = outputs.some((p) => p.port.type === connection.type && p.index === connection.sourceIndex) || (connection.type === 'ai_tool' && from.usableAsTool && connection.sourceIndex === 0);
    if (!supplies) errors.push(`${label}: "${source.name}" has no ${connection.type} output ${connection.sourceIndex}`);
    const input = inputs.find((p) => p.port.type === connection.type && p.index === connection.targetIndex);
    if (!input) {
      errors.push(`${label}: "${target.name}" has no ${connection.type} input ${connection.targetIndex}`);
      continue;
    }
    const key = `${target.id}:${connection.type}:${connection.targetIndex}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (input.port.maxConnections && counts.get(key)! > input.port.maxConnections) {
      errors.push(`"${target.name}": at most ${input.port.maxConnections} ${input.port.displayName ?? connection.type} connection${input.port.maxConnections > 1 ? 's' : ''}`);
    }
  }

  for (const node of workflow.nodes) {
    const descriptor = descriptors.get(node.id);
    if (!descriptor || node.disabled) continue;
    for (const { port, index, visible } of indexedPorts(descriptor.inputs, parametersOf.get(node.id))) {
      if (port.type === 'main' || !port.required || !visible) continue;
      if (!counts.get(`${node.id}:${port.type}:${index}`)) errors.push(`Node "${node.name}": nothing is attached to its required “${port.displayName ?? port.type}” input (${port.type})`);
    }
    if (descriptor.kind === 'subnode' && !workflow.connections.some((c) => c.source === node.id && c.type !== 'main')) {
      warnings.push(`Node "${node.name}" is a sub-node attached to nothing (connect it to a root node's ${descriptor.supplies ?? 'ai_*'} input)`);
    }
  }
  if (workflow.nodes.length && ![...descriptors.values()].some((d) => d.kind === 'trigger')) {
    warnings.push('No trigger node: the workflow can only run from a node you choose (add core.manualTrigger, core.webhook, core.schedule…)');
  }
  try {
    const open = unguardedRosterTargets(workflow as Workflow);
    if (open.length) {
      warnings.push(`Public chat: ${open.map((n) => `"${n}"`).join(', ')} can be picked by visitors without passing the Guardrails node. Connect the trigger through Guardrails to a Switch on agentKey that routes to each agent.`);
    }
  } catch {
    // Never blocks validation.
  }
  const loose = workflow.nodes.filter((n) => workflow.nodes.length > 1 && !connected.has(n.id));
  if (loose.length) warnings.push(`Not connected: ${loose.map((n) => `"${n.name}"`).join(', ')}`);
  // Expressions that read a field the node before them doesn't write (only where its fields are known).
  try {
    const workflowId = (input as { id?: unknown } | null)?.id;
    const lastRun = lastRunFields(typeof workflowId === 'string' ? workflowId : undefined);
    for (const issue of checkExpressionFields(
      workflow,
      (node) => descriptors.get(node.id),
      (node) => {
        const descriptor = descriptors.get(node.id);
        const declared = descriptor && schemaFields(outputSchemaOf(descriptor, parametersOf.get(node.id) ?? node.parameters));
        return declared ? { fields: declared, from: 'outputSchema' } : lastRun(node.id);
      },
    )) {
      warnings.push(describeIssue(issue));
    }
  } catch {
    // A failed check never blocks validation.
  }
  return { valid: !errors.length, errors, warnings };
}

/**
 * What each node of a saved workflow wrote in its most recent runs (the newest five executions), as the fields of its
 * output items; nothing for a draft or a node that never produced output.
 */
export function lastRunFields(workflowId: string | undefined): (nodeId: string) => KnownFields | undefined {
  const records: ExecutionRecord[] = [];
  let loaded = false;
  const load = () => {
    loaded = true;
    if (!workflowId) return;
    for (const summary of store.listExecutions({ workflowId, limit: 5 })) {
      const record = store.getExecution(summary.id);
      if (record) records.push(record);
    }
  };
  return (nodeId) => {
    if (!loaded) load();
    for (const record of records) {
      const run = [...(record.runData[nodeId] ?? [])].reverse().find((r) => r.status === 'success' && r.source === 'main');
      const fields = fieldsOfItems(run?.outputs[0] as Array<{ json: Record<string, unknown> }> | undefined);
      if (fields) return { fields, from: 'last run' };
    }
    return undefined;
  };
}
