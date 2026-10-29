/**
 * Assistant edit operations checked against the live registry: the shared
 * applyOps() with the available node types, like the flow builder validates
 * its drafts. What comes back is safe for the editor to apply.
 */
import { applyOps, parseOps, structuralWarnings, type AssistantOp, type DescriptorLookup } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { newCompositeErrors, serverCompositeLookup } from '../composites';
import { availableTypes } from './research';

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
  /** The workflow with the ops applied. */
  workflow: Workflow;
}

/** Parse model output into ops and keep the ones that apply to `workflow`. */
export function validateOps(workflow: Workflow, raw: unknown, lookup: DescriptorLookup = registryLookup()): ValidatedOps {
  const parsed = parseOps(raw);
  const result = applyOps(workflow, parsed.ops, lookup);
  return {
    ops: result.applied,
    dropped: [...parsed.dropped, ...result.dropped],
    ignored: result.ignored,
    warnings: [...structuralWarnings(workflow, result.workflow, lookup), ...compositeWarnings(workflow, result.workflow, lookup)],
    workflow: result.workflow,
  };
}

/** What the ops break in the workflow's composites (docs/composites.md), read with the same node descriptors. */
function compositeWarnings(before: Workflow, after: Workflow, lookup: DescriptorLookup): string[] {
  if (!after.groups?.some((g) => g.composite)) return [];
  const { composite } = serverCompositeLookup();
  return newCompositeErrors(before, after, { node: lookup, composite }).map((issue) => `the composite contract: ${issue.message}`);
}
