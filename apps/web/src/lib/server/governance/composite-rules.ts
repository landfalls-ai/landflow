/**
 * Composite governance rules (docs/specs/14-composite-governance-rules.md, docs/composites.md): "nodes matching X may
 * only sit inside a composite frame matching Y" (`require-inside`) or "must not" (`forbid-inside`). The rules are the
 * `compositeRules` of the governance document; this module judges a workflow against them and plugs into
 * `workflowViolations()` (./policy.ts) through `registerWorkflowRule()`, which is why it lives apart: it reads the
 * plugin registry, and the registry imports policy.ts. Importing this file registers the check; the composition root
 * (../runtime.ts) imports it at boot, so callers of policy.ts don't.
 */
import type { NodeDescriptor, NodeMatcher } from '@landflow/protocol';
import type { Workflow, WorkflowGroup } from '@landflow/engine';
import { compositeMatches, describeMatcher, nodeMatches, type CompositeLookup } from '../../shared/composites';
import type { GovernanceCompositeRule, GovernancePolicy, PolicyViolation } from '../../shared/governance';
import { normalizeGroups } from '../../shared/groups';
import { serverCompositeLookup } from '../composites';
import { registerWorkflowRule } from './policy';

type Judged = Pick<Workflow, 'nodes' | 'groups'>;

/** Fields of a matcher that need the node's descriptor (without it, only `type` can be judged). */
const needsDescriptor = (m: NodeMatcher): boolean =>
  [m.kind, m.supplies, m.category, m.capability, m.input].some((v) => v !== undefined) || Boolean(m.anyOf?.some(needsDescriptor));

/** The composite frames a node sits in, nearest first (only the nearest when `nested` is false). */
function framesOf(groups: WorkflowGroup[], nodeId: string, nested: boolean): WorkflowGroup[] {
  const frames: WorkflowGroup[] = [];
  let group = groups.find((g) => g.nodeIds.includes(nodeId));
  for (let guard = 0; group && guard < 50; guard++) {
    if (group.composite) {
      frames.push(group);
      if (!nested) break;
    }
    group = group.parentId ? groups.find((g) => g.id === group!.parentId) : undefined;
  }
  return frames;
}

/**
 * Every enabled node that breaks a rule. A node whose plugin is offline can't be judged by a rule that reads its
 * descriptor: that is a `warn` saying so, never an error.
 */
export function compositeViolations(workflow: Judged, rules: GovernanceCompositeRule[], lookup: Pick<CompositeLookup, 'node'>): PolicyViolation[] {
  if (!rules.length) return [];
  const groups = normalizeGroups(workflow.groups, workflow.nodes.map((n) => n.id));
  const out: PolicyViolation[] = [];
  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    const descriptor: NodeDescriptor | undefined = lookup.node(node.type);
    for (const rule of rules) {
      const base = { nodeId: node.id, nodeName: node.name, nodeType: node.type, rule: 'composite' as const, ruleId: rule.id };
      if (!descriptor && needsDescriptor(rule.match)) {
        out.push({ ...base, severity: 'warn', message: `${rule.name}: can’t tell whether this node is covered, since its plugin isn’t loaded` });
        continue;
      }
      if (!nodeMatches(node.type, descriptor, rule.match)) continue;
      const inside = framesOf(groups, node.id, rule.nested !== false).some((g) => compositeMatches(g.composite!.type, rule.composite));
      const frames = describeMatcher(rule.composite, lookup as CompositeLookup);
      if (rule.kind === 'require-inside' && !inside) {
        out.push({ ...base, severity: rule.severity, message: rule.message ?? `${rule.name}: put this node inside ${frames}` });
      } else if (rule.kind === 'forbid-inside' && inside) {
        out.push({ ...base, severity: rule.severity, message: rule.message ?? `${rule.name}: this node can’t sit inside ${frames}` });
      }
    }
  }
  return out;
}

registerWorkflowRule('composite-rules', (workflow: Judged, policy: GovernancePolicy) => compositeViolations(workflow, policy.compositeRules, serverCompositeLookup()));
