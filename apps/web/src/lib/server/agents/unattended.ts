/**
 * AG23, AP02: the asks-first tools a run nobody watches will wait for or refuse, said before publishing (docs/agents.md#production-approvals).
 *
 * A webhook, schedule, app trigger or form starts a run with no person in the editor. The person's decision of 2026-11-18: a Run
 * an Agent step whose Tool Approvals is Ask pauses at a tool that asks first and waits in Needs you (the approval inbox,
 * docs/approval-inbox.md), so the line says `waitLine`; a step that still refuses (Refuse, a model or tools wired to it, an MCP
 * call, the hosted chat, a host with no inbox) says `refusesLine` with why. One `PublishLine` per tool and trigger, for the
 * publish card, the Publish menu and the session's last line.
 */
import type { Workflow } from '@landflow/engine';
import type { UnattendedApproval } from '../../shared/unattended';
import { EXPIRY_VARIABLE, expiryMinutes, refusesLine, waitLine, type RefuseWhy } from '../../shared/approval-inbox'; // AP02:
import { inboxPort } from '../approval-inbox/port'; // AP02:
import { PIN_PARAM } from '../../shared/agent-versions';
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

/** AP02: why a trigger's runs cannot wait, whatever the step says (an MCP call answers its caller at once; the hosted chat page cannot show an approval). */
function triggerRefuses(type: string): RefuseWhy | undefined {
  if (type === 'core.mcpTrigger') return 'mcp';
  if (type === 'core.chatTrigger') return 'hostedChat';
  return undefined;
}

/**
 * For each trigger of the version that starts without a person, each Run an Agent step whose agent version (its pin, else the
 * published one, else the draft; `latest` names agents read at their latest published version, as an update offer would re-pin them) has a tool that asks first: a `PublishLine`
 * (`outcome: 'waits'` with the expiry a request opened now would get, or `'refuses'` with why). `undefined`: no such workflow or version.
 */
export function unattendedApprovals(workflowId: string, version?: number | 'draft', latest: readonly string[] = []): UnattendedApproval[] | undefined {
  const graph = graphOf(workflowId, version);
  if (!graph) return undefined;
  const triggers = new Map<string, { word: string; why?: RefuseWhy }>();
  for (const n of graph.nodes) {
    const word = n.disabled ? undefined : unattendedTrigger(n.type);
    if (!word) continue;
    const why = triggerRefuses(n.type);
    const known = triggers.get(word);
    // A word that some trigger can wait for waits (a flow with a webhook and an MCP trigger: the webhook's runs wait; the MCP trigger has its own word).
    if (!known || (known.why && !why)) triggers.set(word, { word, ...(why && { why }) });
  }
  if (!triggers.size) return [];
  const minutes = expiryMinutes(process.env[EXPIRY_VARIABLE]);
  const out: UnattendedApproval[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (node.disabled || node.type !== 'core.messageAgent') continue;
    const agent = agentStore.get(String(node.parameters?.agentId ?? ''));
    if (!agent) continue;
    const pin = node.parameters?.[PIN_PARAM];
    const config = (typeof pin === 'number' && !latest.includes(agent.id) ? agentVersionConfig(agent.id, pin) : undefined) ?? (agent.published ? agent.published.config : configOf(agent));
    // What the step does at run time: a step saved without Tool Approvals refuses, and a model or tools wired to it go through no decision.
    const stepWhy: RefuseWhy | undefined =
      node.parameters?.toolApprovals !== 'askInChat' ? 'refuseSetting' : graph.connections.some((c) => c.target === node.id && (c.type === 'ai_languageModel' || c.type === 'ai_tool')) ? 'wired' : undefined;
    for (const tool of config.tools) {
      if (!tool.requireApproval) continue;
      const name = 'name' in tool && typeof tool.name === 'string' ? tool.name : tool.type;
      for (const { word: trigger, why: triggerWhy } of triggers.values()) {
        const key = `${node.id}|${name}|${trigger}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const why = stepWhy ?? triggerWhy ?? (inboxPort() ? undefined : 'noInbox');
        const base = { tool: name, agent: agent.name, node: node.name ?? node.id, trigger };
        out.push(why ? { ...base, line: refusesLine(name, trigger, why), outcome: 'refuses', why } : { ...base, line: waitLine(name, trigger, minutes), outcome: 'waits', expiresAfterMinutes: minutes });
      }
    }
  }
  return out;
}
