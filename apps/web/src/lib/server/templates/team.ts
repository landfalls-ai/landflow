/**
 * Team templates (docs/templates.md#team-templates): a team, its Landflow agents and optionally one workflow that runs it,
 * saved as one template, and created again with fresh ids. This file builds the bundle (`bundleTeam`), turns the
 * credentials the agents name into slots, and on use creates the agents and the team with every reference rewritten
 * (`createFromBundle`, `remapWorkflow`). The workflow's own part is the templates module's (./index.ts).
 */
import { chartOrder, type AgentTeam, type AgentTeamConfig, type TeamMember } from '../../shared/agent-teams';
import type { Agent, AgentConfig, AgentToolConfig, CredentialRef } from '../../shared/agents';
import { isNodeKnowledge } from '../../shared/agents';
import type { TemplateBundle, TemplateCredentialSlot, TemplateFace, TemplateTeamSummary } from '../../shared/templates';
import type { Workflow, WorkflowNode } from '../../shared/types';
import { agentTeamStore, issuesOf } from '../agent-teams/store';
import { agentStore, configOf } from '../agents/store';
import { credentials as vault } from '../credentials/vault';
import { registry } from '../plugins/registry';
import { HttpError } from '../errors';

/** Agents one template may hold: the team's members and whoever they delegate to. */
export const MAX_BUNDLE_AGENTS = 30;

export class BundleError extends HttpError {
  static readonly errorName: string = 'BundleError';
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

// ---- credential references ---------------------------------------------------------------------------------------

interface RefInfo {
  /** Qualified credential type. */
  type: string;
  optional: boolean;
  /** Who uses it, for the slot's description ("Developer (model)"). */
  where: string;
}

/** Return the reference that replaces `ref`, or undefined to remove it. */
type Visit = (ref: CredentialRef, info: RefInfo) => CredentialRef | undefined;

const typeOf = (ref: CredentialRef, fallback: string) => vault.get(ref.id)?.type ?? fallback;
const qualify = (nodeType: string, key: string) => (key.includes('.') ? key : `${nodeType.slice(0, nodeType.indexOf('.'))}.${key}`);

function visitMap(holder: { credentials?: Record<string, CredentialRef> }, fallback: (key: string) => string, where: string, visit: Visit) {
  if (!holder.credentials) return;
  for (const [key, ref] of Object.entries(holder.credentials)) {
    const next = visit(ref, { type: typeOf(ref, fallback(key)), optional: false, where });
    if (next) holder.credentials[key] = next;
    else delete holder.credentials[key];
  }
  if (!Object.keys(holder.credentials).length) delete holder.credentials;
}

/** Every credential reference in an agent's config (model, tools, knowledge bases, channels), edited in place. */
export function visitAgentCredentials(config: AgentConfig, visit: Visit) {
  const who = config.name;
  if (config.model?.credential) {
    const openai = config.model.provider === 'openai';
    const next = visit(config.model.credential, { type: typeOf(config.model.credential, openai ? 'core.openAiApi' : 'core.anthropicApi'), optional: !openai, where: `${who} (model)` });
    if (next) config.model.credential = next;
    else delete config.model.credential;
  }
  for (const tool of config.tools) {
    const where = `${who} (${'name' in tool ? tool.name : tool.type})`;
    if (tool.type === 'node') visitMap(tool, (key) => qualify(tool.nodeType, key), where, visit);
    else if (tool.type === 'mcp' || tool.type === 'a2a') visitMap(tool, (key) => qualify('core.x', key), where, visit);
    else if (tool.type === 'knowledge' && isNodeKnowledge(tool)) visitMap(tool, (key) => qualify(tool.nodeType, key), where, visit);
    else if (tool.type === 'knowledge') {
      if (tool.credential) {
        const next = visit(tool.credential, { type: typeOf(tool.credential, 'core.postgres'), optional: false, where });
        if (next) tool.credential = next;
        else delete tool.credential;
      }
      if (tool.embeddings.credential) {
        const next = visit(tool.embeddings.credential, { type: typeOf(tool.embeddings.credential, 'core.openAiApi'), optional: false, where });
        if (next) tool.embeddings.credential = next;
        else delete tool.embeddings.credential;
      }
    }
  }
  for (const channel of config.channels) {
    const fallback = channel.type === 'telegram' ? 'messaging.telegramApi' : channel.type === 'slack' ? 'messaging.slackApi' : 'core.microsoftBotApi';
    const next = channel.credential && visit(channel.credential, { type: typeOf(channel.credential, fallback), optional: false, where: `${who} (${channel.type} channel)` });
    if (next) channel.credential = next;
    else (channel as { credential?: CredentialRef }).credential = undefined;
  }
  // A channel without its credential can't connect: it isn't created.
  config.channels = config.channels.filter((c) => c.credential);
}

/** The credential references of a team's remote members. */
export function visitTeamCredentials(team: AgentTeamConfig, visit: Visit) {
  for (const member of team.members) if (member.kind === 'a2a') visitMap(member, (key) => qualify('core.x', key), `${member.title} (remote)`, visit);
}

/** Replace the references of agents and team with slots (one per credential type and referenced credential). */
function slotReferences(agents: AgentConfig[], team: AgentTeamConfig): TemplateCredentialSlot[] {
  const slots: TemplateCredentialSlot[] = [];
  const byRef = new Map<string, TemplateCredentialSlot>();
  const users = new Map<string, Set<string>>();
  const visit: Visit = (ref, info) => {
    const key = `${info.type}\u0000${ref.id}`;
    let slot = byRef.get(key);
    if (!slot) {
      const base = info.type.slice(info.type.indexOf('.') + 1).replace(/[^\w-]/g, '') || 'credential';
      let id = base;
      for (let i = 2; slots.some((s) => s.id === id); i++) id = `${base}_${i}`;
      slot = { id, type: info.type, name: registry.credentialType(info.type)?.descriptor.displayName ?? ref.name ?? base, ...(info.optional && { optional: true }) };
      slots.push(slot);
      byRef.set(key, slot);
    } else if (!info.optional) delete slot.optional;
    (users.get(slot.id) ?? users.set(slot.id, new Set()).get(slot.id)!).add(info.where);
    return { id: slot.id, name: slot.name };
  };
  for (const config of agents) visitAgentCredentials(config, visit);
  visitTeamCredentials(team, visit);
  return slots.map((slot) => ({ ...slot, description: `Used by ${[...users.get(slot.id)!].join(', ')}` }));
}

// ---- save ---------------------------------------------------------------------------------------------------------

/** The agent ids a workflow's nodes name (Run an Agent nodes). */
export const workflowAgentIds = (workflow: Pick<Workflow, 'nodes'>): string[] =>
  workflow.nodes.flatMap((n) => (n.type === 'core.messageAgent' && typeof n.parameters.agentId === 'string' && n.parameters.agentId ? [n.parameters.agentId] : []));

/** Run a Team nodes of a workflow that run `teamId`. */
export const runsTeam = (workflow: Pick<Workflow, 'nodes'>, teamId: string): boolean => workflow.nodes.some((n) => n.type === 'core.runTeam' && n.parameters.teamId === teamId);

/** The agents a team needs, in the order found: its members, the agents the workflow runs, and whoever those delegate to. */
function collectAgents(team: AgentTeamConfig, workflow: Pick<Workflow, 'nodes'> | undefined): Agent[] {
  const found = new Map<string, Agent>();
  const queue = [...team.members.flatMap((m) => (m.kind === 'agent' ? [m.agentId] : [])), ...(workflow ? workflowAgentIds(workflow) : [])];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (found.has(id)) continue;
    const agent = agentStore.get(id);
    if (!agent) continue;
    found.set(id, agent);
    if (found.size > MAX_BUNDLE_AGENTS) throw new BundleError(`A template holds at most ${MAX_BUNDLE_AGENTS} agents`);
    // Its published version is what runs; sub-agents are those of that version.
    for (const tool of (agent.published?.config ?? configOf(agent)).tools) if (tool.type === 'agent') queue.push(tool.agentId);
  }
  return [...found.values()];
}

/**
 * The bundle for a team (and the workflow that runs it): every Landflow agent with its published config (the draft
 * while unpublished), credential references turned into slots. The team is its draft. `workflow` is only read for the
 * agents it names and checked to run this team.
 */
export function bundleTeam(team: AgentTeam, workflow?: Workflow): { bundle: TemplateBundle; slots: TemplateCredentialSlot[] } {
  if (workflow && !runsTeam(workflow, team.id)) throw new BundleError(`“${workflow.name}” doesn’t run this team: it needs a Run a Team node set to it`);
  const config = structuredClone(team.draft);
  const missing = config.members.filter((m) => m.kind === 'agent' && !agentStore.get(m.agentId));
  if (missing.length) throw new BundleError(`The agent of ${missing.map((m) => `“${m.title}”`).join(', ')} no longer exists: fix the team first`);
  const agents = collectAgents(config, workflow).map((agent) => ({ key: agent.id, config: structuredClone(agent.published?.config ?? configOf(agent)), published: Boolean(agent.published) }));
  const slots = slotReferences(
    agents.map((a) => a.config),
    config,
  );
  return {
    bundle: { teamKey: team.id, team: config, ...(team.published && { teamPublished: true }), agents, hasWorkflow: Boolean(workflow), ...(workflow && { workflowKey: workflow.id }) },
    slots,
  };
}

// ---- use ----------------------------------------------------------------------------------------------------------

export interface BundleHooks {
  createAgent(create: () => Agent): Agent;
  createTeam(create: () => AgentTeam): AgentTeam;
}

export interface CreatedBundle {
  team: AgentTeam;
  agents: Agent[];
  /** The bundle's agent keys → the new agent ids. */
  agentIds: Map<string, string>;
  warnings: string[];
}

type Picked = { id: string; name: string } | undefined;

/**
 * Create the bundle's agents and team as drafts (published again when they were published and the team can run), with
 * fresh ids. Credentials come from `picks` (slot id → saved credential); a reference without one is dropped. Sub-agent
 * tools follow the new agents; a workflow tool follows `workflowId` (the workflow the template creates) or is dropped.
 */
export function createFromBundle(bundle: TemplateBundle, picks: Record<string, Picked>, hooks: BundleHooks, options: { teamName?: string; workflowId?: string }): CreatedBundle {
  const warnings: string[] = [];
  const created: Agent[] = [];
  const agentIds = new Map<string, string>();
  const swap: Visit = (ref) => picks[ref.id];
  try {
    const finals = new Map<string, AgentConfig>();
    for (const source of bundle.agents) {
      const config = structuredClone(source.config);
      visitAgentCredentials(config, swap);
      // Schedules and channels are switched on by the person, like an imported agent's.
      config.schedules = config.schedules.map((s) => ({ ...s, enabled: false }));
      config.channels = config.channels.map((c) => ({ ...c, enabled: false }));
      finals.set(source.key, config);
      // Sub-agent tools can only point at agents that exist: they are added in the second pass.
      const agent = hooks.createAgent(() => agentStore.create({ ...config, tools: config.tools.filter((t) => t.type !== 'agent') }));
      created.push(agent);
      agentIds.set(source.key, agent.id);
    }
    bundle.agents.forEach((source, i) => {
      const config = finals.get(source.key)!;
      const tools = config.tools.flatMap((tool): AgentToolConfig[] => {
        if (tool.type === 'agent') {
          const agentId = agentIds.get(tool.agentId);
          return agentId ? [{ ...tool, agentId }] : [];
        }
        if (tool.type === 'workflow') {
          if (bundle.workflowKey && tool.workflowId === bundle.workflowKey && options.workflowId) return [{ ...tool, workflowId: options.workflowId }];
          warnings.push(`${config.name}: the workflow tool “${tool.name}” points at a workflow outside the template and was left out`);
          return [];
        }
        return [tool];
      });
      const current = agentStore.saveDraft(created[i].id, { tools }) ?? created[i];
      created[i] = source.published ? (agentStore.publish(current.id) ?? current) : current;
    });

    const teamConfig = structuredClone(bundle.team);
    visitTeamCredentials(teamConfig, swap);
    teamConfig.name = options.teamName?.trim() || teamConfig.name;
    teamConfig.members = teamConfig.members.map((m): TeamMember => (m.kind === 'agent' ? { ...m, agentId: agentIds.get(m.agentId) ?? m.agentId } : m));
    let team = hooks.createTeam(() => agentTeamStore.create(teamConfig));
    if (bundle.teamPublished) {
      if (issuesOf(team.draft).length) warnings.push(`${team.draft.name}: not published, ${issuesOf(team.draft)[0]}`);
      else team = agentTeamStore.publish(team.id) ?? team;
    }
    return { team, agents: created, agentIds, warnings };
  } catch (caught) {
    // Nothing half-made stays behind.
    for (const agent of created) agentStore.delete(agent.id);
    throw caught;
  }
}

/** The workflow's nodes with the new team and agent ids: Run a Team nodes point at `team`, Run an Agent nodes at the agents' copies. */
export function remapWorkflow<N extends WorkflowNode>(nodes: N[], bundle: TemplateBundle, team: { id: string; name: string }, agentIds: Map<string, string>): N[] {
  return nodes.map((node) => {
    if (node.type === 'core.runTeam' && node.parameters.teamId === bundle.teamKey) return { ...node, parameters: { ...node.parameters, teamId: team.id, teamName: team.name } };
    if (node.type === 'core.messageAgent' && typeof node.parameters.agentId === 'string' && agentIds.has(node.parameters.agentId)) return { ...node, parameters: { ...node.parameters, agentId: agentIds.get(node.parameters.agentId) } };
    return node;
  });
}

/** Whether one of the workflow's nodes has a `repository` parameter (a GitHub node's). */
const hasRepository = (workflow: Pick<Workflow, 'nodes'> | undefined) => Boolean(workflow?.nodes.some((n) => 'repository' in n.parameters));

/** What the person chooses when using the template, in a few words: each credential it names, a model, a repository. */
export function teamPicks(bundle: TemplateBundle, slots: TemplateCredentialSlot[], workflow?: Pick<Workflow, 'nodes'>): string[] {
  const picks = slots.map((slot) => (/credential$/i.test(slot.name) ? slot.name : `${slot.name} credential`));
  const providers = new Set(bundle.agents.flatMap((a) => (a.config.model ? [a.config.model.provider] : [])));
  if (providers.has('ollama') || providers.has('anthropic')) picks.push('Ollama or Claude model');
  if (providers.has('openai')) picks.push('OpenAI model');
  if (hasRepository(workflow)) picks.push('Repository');
  return [...new Set(picks)];
}

/** What a card says about a bundle: the members' faces, what the person picks, and the counts. */
export const teamSummary = (bundle: TemplateBundle, slots: TemplateCredentialSlot[] = [], workflow?: Pick<Workflow, 'nodes'>): TemplateTeamSummary => ({
  name: bundle.team.name,
  faces: chartOrder(bundle.team).map((m): TemplateFace => {
    const config = m.kind === 'agent' ? bundle.agents.find((a) => a.key === m.agentId)?.config : undefined;
    return config ? { name: m.title, ...(config.icon && { icon: config.icon }), ...(config.color && { color: config.color }), ...(config.avatar && { avatar: config.avatar }) } : { name: m.title };
  }),
  picks: teamPicks(bundle, slots, workflow),
  members: bundle.team.members.length,
  agents: bundle.agents.length,
  remote: bundle.team.members.filter((m) => m.kind === 'a2a').length,
  hasWorkflow: bundle.hasWorkflow,
});
