/**
 * AG23: the asks-first tools a run nobody watches will refuse, said before publishing (docs/agents.md#production-approvals).
 *
 * A webhook, schedule, channel, app trigger, the hosted chat or a form starts a run with no person in the editor, so a Run an
 * Agent step's tool that asks first is refused there (the agent runtime's `deny`). The person's decision of 2026-11-18 lets Spotlight
 * approve its own test runs; where a production run's approvals go is still theirs to decide, so production keeps refusing and
 * this says so: one line per tool, for the publish card and the Publish menu (`unattendedLine`).
 */
import type { Workflow } from '@landflow/engine';
import type { UnattendedApproval } from '../../shared/unattended';
import { PIN_PARAM } from '../../shared/agent-versions';
import { unattendedLine } from '../../shared/fix-autonomy';
import { registry } from '../plugins/registry';
import { publishedVersionId } from '../publications';
import { productionWorkflow } from '../publish';
import { store } from '../store';
import { getVersion, listVersions } from '../versions';
import { agentVersionConfig } from './versions';
import { agentStore, configOf } from './store';

export type { UnattendedApproval } from '../../shared/unattended';

/** The plain word for each core trigger that starts a production run without a person in the editor. */
const CORE_TRIGGER_WORDS: Record<string, string> = {
  'core.webhook': 'webhook',
  'core.schedule': 'schedule',
  'core.chatTrigger': 'chat',
  'core.formTrigger': 'form',
  'core.usageTrigger': 'usage event',
  'core.suggestionDecidedTrigger': 'suggestion decision',
  'core.detectorTrigger': 'detector',
  'core.capRaiseTrigger': 'cap raise',
  'core.errorTrigger': 'error workflow',
  'core.workflowTrigger': 'called workflow',
  'core.executeWorkflowTrigger': 'called workflow',
  'core.mcpTrigger': 'MCP call',
};

/**
 * The word for a trigger that starts a run without a person in the editor: every trigger but the manual one (a person's run)
 * and the evaluation one (an eval run, not production). Undefined for those and for a node that is no trigger.
 */
export function unattendedTrigger(type: string): string | undefined {
  if (type === 'core.manualTrigger' || type === 'core.evaluationTrigger') return undefined;
  if (CORE_TRIGGER_WORDS[type]) return CORE_TRIGGER_WORDS[type];
  const resolved = registry.resolve(type);
  if ('error' in resolved || resolved.descriptor.kind !== 'trigger') return undefined;
  const source = resolved.descriptor.triggerSource;
  if (source === 'manual') return 'trigger';
  return source === 'webhook' || source === 'schedule' || source === 'chat' ? source : 'app trigger';
}

/** What `which` of a workflow answers: the published version (its production copy, agents at their pins), a saved version by number, else the draft. */
function graphOf(workflowId: string, version?: number | 'draft'): Workflow | undefined {
  const saved = store.getWorkflow(workflowId);
  if (!saved) return undefined;
  if (version === 'draft') return saved;
  if (version !== undefined) {
    const summary = listVersions(workflowId).find((v) => v.number === version);
    const snapshot = summary && getVersion(workflowId, summary.id)?.workflow;
    if (!summary || !snapshot) return undefined;
    return publishedVersionId(workflowId) === summary.id ? (productionWorkflow({ ...saved, active: true }) ?? snapshot) : { ...saved, ...snapshot, id: workflowId };
  }
  return (publishedVersionId(workflowId) && productionWorkflow({ ...saved, active: true })) || saved;
}

/**
 * For each trigger of the version that starts without a person, each Run an Agent step whose agent version (its pin, else the
 * published one, else the draft) has a tool that asks first: `{ tool, agent, node, trigger, line }`. `undefined`: no such workflow or version.
 */
export function unattendedApprovals(workflowId: string, version?: number | 'draft'): UnattendedApproval[] | undefined {
  const graph = graphOf(workflowId, version);
  if (!graph) return undefined;
  const triggers = [...new Set(graph.nodes.filter((n) => !n.disabled).flatMap((n) => unattendedTrigger(n.type) ?? []))];
  if (!triggers.length) return [];
  const out: UnattendedApproval[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (node.disabled || node.type !== 'core.messageAgent') continue;
    const agent = agentStore.get(String(node.parameters?.agentId ?? ''));
    if (!agent) continue;
    const pin = node.parameters?.[PIN_PARAM];
    const config = (typeof pin === 'number' ? agentVersionConfig(agent.id, pin) : undefined) ?? (agent.published ? agent.published.config : configOf(agent));
    for (const tool of config.tools) {
      if (!tool.requireApproval) continue;
      const name = 'name' in tool && typeof tool.name === 'string' ? tool.name : tool.type;
      for (const trigger of triggers) {
        const key = `${node.id}|${name}|${trigger}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tool: name, agent: agent.name, node: node.name ?? node.id, trigger, line: unattendedLine(name, trigger) });
      }
    }
  }
  return out;
}
