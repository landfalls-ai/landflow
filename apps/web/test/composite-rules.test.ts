/**
 * Composite governance rules (docs/specs/14-composite-governance-rules.md): a node that matches a rule must sit inside
 * (or outside) a composite frame. Judged against the core node descriptors, then through the governance document:
 * workflowViolations (save warnings), publishBlockedReason (errors only) and the default of no rules.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NodeDescriptor } from '@landflow/protocol';
import type { Workflow, WorkflowGroup, WorkflowNode } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-composite-rules-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { compositeViolations } = await import('@/lib/server/governance/composite-rules');
const policy = await import('@/lib/server/governance/policy');
const { AI_STEP_RULE } = await import('@/lib/shared/governance');

registry.registerBuiltin(corePlugin);
const descriptors = new Map<string, NodeDescriptor>();
for (const node of corePlugin.nodes) descriptors.set(`core.${node.description.name}`, node.description);
const lookup = { node: (type: string) => descriptors.get(type) };

const node = (id: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters: {}, ...extra }) as WorkflowNode;
const group = (id: string, nodeIds: string[], extra: Partial<WorkflowGroup> = {}): WorkflowGroup => ({ id, name: id, nodeIds, ...extra }) as WorkflowGroup;
const frame = (id: string, nodeIds: string[], extra: Partial<WorkflowGroup> = {}) => group(id, nodeIds, { composite: { type: 'core.aiStep', version: 1, slots: {} }, ...extra });
const flow = (nodes: WorkflowNode[], groups: WorkflowGroup[] = []): Workflow => ({ id: 'wf_rules', name: 'Rules', nodes, connections: {}, groups }) as unknown as Workflow;

describe('require-inside', () => {
  it('flags an AI node outside a frame and accepts it inside one', () => {
    const outside = flow([node('Ask', 'core.chainLlm')]);
    const found = compositeViolations(outside, [AI_STEP_RULE], lookup);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'Ask', rule: 'composite', ruleId: 'ai-calls-in-ai-step', severity: 'error' });
    expect(found[0].message).toContain('AI calls only inside an AI step');

    const inside = flow([node('Ask', 'core.chainLlm')], [frame('g1', ['Ask'])]);
    expect(compositeViolations(inside, [AI_STEP_RULE], lookup)).toEqual([]);
  });

  it('ignores nodes the rule does not match, and disabled ones', () => {
    expect(compositeViolations(flow([node('Set', 'core.set')]), [AI_STEP_RULE], lookup)).toEqual([]);
    expect(compositeViolations(flow([node('Ask', 'core.chainLlm', { disabled: true })]), [AI_STEP_RULE], lookup)).toEqual([]);
  });

  it('counts a plain group nested in a frame, and a different frame type does not count', () => {
    const nested = flow([node('Ask', 'core.chainLlm')], [frame('g1', []), group('g2', ['Ask'], { parentId: 'g1' })]);
    expect(compositeViolations(nested, [AI_STEP_RULE], lookup)).toEqual([]);
    const other = flow([node('Ask', 'core.chainLlm')], [frame('g1', ['Ask'], { composite: { type: 'triage.aiTriage', version: 1, slots: {} } })]);
    expect(compositeViolations(other, [AI_STEP_RULE], lookup)).toHaveLength(1);
  });

  it('with nested: false, only the nearest frame counts', () => {
    const wf = flow([node('Ask', 'core.chainLlm')], [frame('g1', []), frame('g2', ['Ask'], { parentId: 'g1', composite: { type: 'triage.aiTriage', version: 1, slots: {} } })]);
    expect(compositeViolations(wf, [AI_STEP_RULE], lookup)).toEqual([]);
    expect(compositeViolations(wf, [{ ...AI_STEP_RULE, nested: false }], lookup)).toHaveLength(1);
  });

  it('warns, never errors, when the node’s plugin is not loaded and the rule reads descriptors', () => {
    const found = compositeViolations(flow([node('X', 'ghost.node')]), [AI_STEP_RULE], lookup);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warn');
    const byType = { ...AI_STEP_RULE, match: { type: 'ghost.node' } };
    expect(compositeViolations(flow([node('X', 'ghost.node')]), [byType], lookup)[0].severity).toBe('error');
  });
});

describe('forbid-inside', () => {
  it('flags a matching node inside the frame', () => {
    const rule = { ...AI_STEP_RULE, id: 'no-set', name: 'No Set in an AI step', kind: 'forbid-inside' as const, match: { type: 'core.set' }, severity: 'warn' as const };
    const wf = flow([node('Set', 'core.set')], [frame('g1', ['Set'])]);
    expect(compositeViolations(wf, [rule], lookup)).toMatchObject([{ nodeId: 'Set', severity: 'warn' }]);
    expect(compositeViolations(flow([node('Set', 'core.set')]), [rule], lookup)).toEqual([]);
  });
});

describe('through the governance document', () => {
  const wf = flow([node('Ask', 'core.chainLlm')]);

  it('is silent with no rules (the default)', () => {
    expect(policy.getGovernancePolicy().compositeRules).toEqual([]);
    expect(policy.workflowViolations(wf)).toEqual([]);
    expect(policy.publishBlockedReason(wf)).toBeUndefined();
  });

  it('warns on save and refuses to publish for an error rule, and only warns for a warn rule', () => {
    policy.updateGovernancePolicy({ compositeRules: [AI_STEP_RULE] });
    expect(policy.workflowViolations(wf)).toHaveLength(1);
    expect(policy.publishBlockedReason(wf)).toContain('AI calls only inside an AI step');
    expect(() => policy.assertPublishable(wf)).toThrow(policy.PolicyError);
    expect(policy.workflowViolations(flow([node('Ask', 'core.chainLlm')], [frame('g1', ['Ask'])]))).toEqual([]);

    policy.updateGovernancePolicy({ compositeRules: [{ ...AI_STEP_RULE, severity: 'warn' }] });
    expect(policy.workflowViolations(wf)).toHaveLength(1);
    expect(policy.publishBlockedReason(wf)).toBeUndefined();
  });

  it('rejects a malformed rule and keeps rules when another section is patched', () => {
    expect(() => policy.governancePatchSchema.parse({ compositeRules: [{ id: 'x' }] })).toThrow();
    policy.updateGovernancePolicy({ compositeRules: [AI_STEP_RULE] });
    policy.updateGovernancePolicy({ nodes: { blockCode: true } });
    expect(policy.getGovernancePolicy().compositeRules).toHaveLength(1);
    policy.updateGovernancePolicy({ nodes: { blockCode: false }, compositeRules: [] });
    expect(policy.getGovernancePolicy().compositeRules).toEqual([]);
  });
  it('counts a rule once when a second copy of the module registers it (a production build bundles one per layer)', async () => {
    policy.updateGovernancePolicy({ compositeRules: [AI_STEP_RULE] });
    vi.resetModules();
    // A fresh copy of the policy module that never imported the rules still sees them.
    const copyPolicy = await import('@/lib/server/governance/policy');
    expect(copyPolicy.workflowViolations(wf)).toHaveLength(1);
    // A second copy of the rules registering again replaces the check instead of doubling it.
    const copy = await import('@/lib/server/governance/composite-rules');
    expect(copy.compositeViolations).not.toBe(compositeViolations);
    expect(policy.workflowViolations(wf)).toHaveLength(1);
    expect(copyPolicy.workflowViolations(wf)).toHaveLength(1);
    policy.updateGovernancePolicy({ compositeRules: [] });
  });
});
