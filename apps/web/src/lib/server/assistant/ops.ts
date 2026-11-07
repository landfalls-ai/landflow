/**
 * Assistant edit operations checked against the live registry: the shared
 * applyOps() with the available node types, like the flow builder validates
 * its drafts. What comes back is safe for the editor to apply.
 */
import { applyOps, parseOps, structuralWarnings, swallowWarnings, wiringWarnings, type AssistantOp, type DescriptorLookup } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { newCompositeErrors, serverCompositeLookup } from '../composites';
import { availableTypes, mainOutputs } from './research';

export function registryLookup(types: NodeTypeInfo[] = availableTypes()): DescriptorLookup {
  const byType = new Map(types.map((t) => [t.type, t.descriptor]));
  return (type) => byType.get(type);
}

export interface ValidatedOps {
  ops: AssistantOp[];
  /** Ops that were dropped, as reasons. */
  dropped: string[];
  /** Parameters left out because the node has no such parameter. */
  ignored: string[];
  /** What the applied ops leave dangling (see structuralWarnings). */
  warnings: string[];
  /** Warnings shown on the card without sending the change back (a fix that hides an error instead of fixing it). */
  cautions: string[];
  /** The workflow with the ops applied. */
  workflow: Workflow;
}

/** Parse model output into ops and keep the ones that apply to `workflow`. */
export function validateOps(workflow: Workflow, raw: unknown, lookup: DescriptorLookup = registryLookup()): ValidatedOps {
  const parsed = parseOps(raw);
  const result = applyOps(workflow, parsed.ops, lookup);
  const wiring = wiringWarnings(workflow, result.workflow, lookup);
  return {
    ops: result.applied,
    dropped: [...parsed.dropped, ...result.dropped],
    ignored: result.ignored,
    warnings: [...structuralWarnings(workflow, result.workflow, lookup), ...wiring.branches, ...compositeWarnings(workflow, result.workflow, lookup)],
    cautions: [...wiring.purpose, ...swallowWarnings(result.applied)],
    workflow: result.workflow,
  };
}

/** What the ops break in the workflow's composites (docs/composites.md), read with the same node descriptors. */
function compositeWarnings(before: Workflow, after: Workflow, lookup: DescriptorLookup): string[] {
  if (!after.groups?.some((g) => g.composite)) return [];
  const { composite } = serverCompositeLookup();
  return newCompositeErrors(before, after, { node: lookup, composite }).map((issue) => `the composite contract: ${issue.message}`);
}

/** The node types that split items into branches by a test. A node that already has named outputs needs none of them. */
export const BRANCHING_TYPES = new Set(['core.if', 'core.filter', 'core.switch']);

/**
 * Adding an If / Filter / Switch straight after a node that already branches (Run Report: “Passed” and “Send back”)
 * duplicates its branching. Returns one sentence per such step, naming the outputs to connect from instead.
 */
export function redundantBranches(workflow: Workflow, ops: AssistantOp[], types: NodeTypeInfo[]): string[] {
  const byName = (reference: string) => workflow.nodes.find((n) => n.name === reference || n.id === reference);
  /** ref → name, for nodes these ops add. */
  const refs = new Map(ops.flatMap((op) => (op.op === 'addNode' ? [[op.ref ?? op.name ?? op.type, op.name ?? op.type] as const] : [])));
  const named = (reference: string) => byName(refs.get(reference) ?? reference);
  const typeOf = (reference: string) => named(reference)?.type;
  const out: string[] = [];
  const check = (from: string, to: string, output: number | undefined) => {
    if (output !== undefined || !BRANCHING_TYPES.has(typeOf(to) ?? '')) return;
    const source = named(from);
    if (!source) return;
    const outputs = mainOutputs(source, types).filter((o) => o.name);
    if (outputs.length < 2) return;
    const list = outputs.map((o) => `output ${o.index} “${o.name}”`).join(', ');
    out.push(`${source.name} already branches: ${list}. Connect from those outputs instead of adding “${named(to)?.name}”.`);
  };
  for (const op of ops) {
    if (op.op === 'addNode' && op.after) check(op.after, op.ref ?? op.name ?? op.type, op.output);
    else if (op.op === 'connect' && (op.type ?? 'main') === 'main') check(op.from, op.to, op.output);
  }
  return [...new Set(out)];
}

/**
 * Ops that add a node the same kind and name as one proposed earlier and still waiting (an earlier reply, or this
 * one). Those adds are dropped and later ops that name their ref use the waiting node instead.
 */
export function withoutRepeatedAdds(workflow: Workflow, waiting: ReadonlySet<string>, raw: unknown): { ops: unknown; repeated: string[] } {
  if (!Array.isArray(raw) || !waiting.size) return { ops: raw, repeated: [] };
  const alias = new Map<string, string>();
  const repeated: string[] = [];
  const fields = ['from', 'to', 'after', 'before', 'node'] as const;
  const ops: unknown[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      ops.push(entry);
      continue;
    }
    let op = entry as Record<string, unknown>;
    for (const field of fields) {
      const value = op[field];
      if (typeof value === 'string' && alias.has(value)) op = { ...op, [field]: alias.get(value) };
    }
    const type = typeof op.type === 'string' ? op.type : undefined;
    if (op.op === 'addNode' && type) {
      const name = typeof op.name === 'string' ? op.name.trim().toLowerCase() : undefined;
      const sameParameters = (n: { parameters: Record<string, unknown> }) => Boolean(op.parameters) && JSON.stringify(n.parameters) === JSON.stringify(op.parameters);
      const same = workflow.nodes.find((n) => waiting.has(n.id) && n.type === type && (name === undefined ? sameParameters(n) : n.name.toLowerCase() === name));
      if (same) {
        alias.set(String(op.ref ?? op.name ?? type), same.name);
        repeated.push(`“${same.name}” was proposed earlier and is still waiting to be applied: use it, don't add it again`);
        continue;
      }
    }
    ops.push(op);
  }
  return { ops, repeated };
}
