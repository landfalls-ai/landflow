/**
 * What an agent works with, as the Run Trace shows it beside the agent (docs/run-trace.md, "Connections"): its model,
 * memory, tools, knowledge bases, skills and the agents it can ask, from its published settings; and for one deployed to
 * kagent, the runtime, Claude Code plugins and network policies of the deployment. Icons are the node type's, or a
 * brand's (lib/shared/brand-icons.ts): Ollama for an Ollama model, GitHub for the GitHub policy.
 */
import type { WorkflowNode } from '@landflow/engine';
import type { Agent, AgentConfig, AgentToolConfig } from '../../shared/agents';
import { brandIcon, brandOfProvider } from '../../shared/brand-icons';
import { mergeConnections, type ActorConnection } from '../../shared/run-trace';
import { agentStore } from './store';

const PROVIDER: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', ollama: 'Ollama' };

/** `host:port` of a URL, when it is one. */
export function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.trim() || url.includes('{{')) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

const iconOf = (provider: string | undefined) => {
  const brand = brandOfProvider(provider);
  return brand ? brandIcon(brand) : undefined;
};

/** The model of an agent's settings. */
export function modelConnection(model: AgentConfig['model'], from: ActorConnection['from'] = 'agent'): ActorConnection | undefined {
  if (!model?.model) return undefined;
  const icon = iconOf(model.provider);
  const detail = [PROVIDER[model.provider] ?? model.provider, hostOf(model.baseUrl)].filter(Boolean).join(' · ');
  return { kind: 'model', name: model.model, ...(detail && { detail }), ...(icon && { icon }), from };
}

function toolConnection(tool: AgentToolConfig): ActorConnection {
  switch (tool.type) {
    case 'node': {
      const p = tool.parameters ?? {};
      const what = [p.resource, p.operation].filter((v): v is string => typeof v === 'string' && Boolean(v) && !v.includes('{{')).join(' · ');
      return { kind: 'tool', name: tool.name, ...(what && { detail: what }), nodeType: tool.nodeType, from: 'agent' };
    }
    case 'workflow':
      return { kind: 'tool', name: tool.name, detail: 'a workflow', icon: 'lucide:workflow', from: 'agent' };
    case 'agent': {
      const other = agentStore.get(tool.agentId);
      return { kind: 'agent', name: (other?.published?.config ?? other)?.name ?? 'Another agent', detail: 'a Landflow agent', icon: 'lucide:bot', from: 'agent' };
    }
    case 'mcp': {
      if (tool.preset === 'github') return { kind: 'tool', name: 'GitHub MCP', detail: tool.access === 'review' ? 'Tool · pull requests, reviews, line comments' : 'Tool · pull requests, files, issues (read only)', icon: brandIcon('github'), from: 'agent' };
      const host = hostOf(tool.parameters?.endpointUrl);
      return { kind: 'tool', name: tool.name, detail: host ? `MCP server · ${host}` : 'MCP server', icon: brandIcon('mcp'), from: 'agent' };
    }
    case 'knowledge': {
      const embeddings = `${PROVIDER[tool.embeddings.provider] ?? tool.embeddings.provider} ${tool.embeddings.model}`;
      const store = { memory: 'in memory', sqlite: 'SQLite', pgvector: 'Postgres pgvector' }[tool.store] ?? tool.store;
      const icon = tool.store === 'pgvector' ? brandIcon('postgresql') : tool.store === 'sqlite' ? brandIcon('sqlite') : 'lucide:library';
      return { kind: 'knowledge', name: tool.collection, detail: `${store} · ${embeddings}`, icon, from: 'agent' };
    }
    case 'a2a': {
      const host = hostOf(tool.parameters?.agentUrl);
      return { kind: 'agent', name: tool.name, detail: host ? `A2A · ${host}` : 'A2A agent', icon: 'lucide:radio-tower', from: 'agent' };
    }
  }
}

/**
 * What an agent's published settings connect it to. `skip`: what the flow gives it instead (a model or memory sub-node),
 * and `tools: false` to leave its tools out (a team member's asks are the chart's lines).
 */
export function agentConnections(agent: Agent, skip: { model?: boolean; memory?: boolean; tools?: boolean } = {}): ActorConnection[] {
  const config = agent.published?.config ?? agent;
  const out: ActorConnection[] = [];
  const model = skip.model ? undefined : modelConnection(config.model);
  if (model) out.push(model);
  if (!skip.memory && config.memory?.crossSession) out.push({ kind: 'memory', name: 'Remembers across sessions', icon: 'lucide:brain', from: 'agent' });
  if (!skip.tools) for (const tool of config.tools ?? []) out.push(toolConnection(tool));
  for (const skill of config.skills ?? []) out.push({ kind: 'skill', name: skill.name, icon: 'lucide:graduation-cap', from: 'agent' });
  return out;
}

/** What an EgressPolicy opens, by the names Landflow's setup gives them (deploy/kind). */
function policyConnection(name: string, deployment: string): ActorConnection {
  if (name === `${deployment}-landflow`) return { kind: 'network', name: 'Landflow', detail: 'its run reports and tools', icon: 'lucide:radio', from: 'kagent' };
  if (/github/i.test(name)) return { kind: 'network', name: 'GitHub', detail: `${name}: the gateway adds the token`, icon: brandIcon('github'), from: 'kagent' };
  // Landflow's package policy reaches only the package cache in front of the registries (deploy/k8s/components/package-cache).
  if (/package|registry|npm|pypi/i.test(name)) return { kind: 'network', name: 'Package cache', detail: `${name} · npm, Go, PyPI, Alpine through landflow-cache`, icon: 'lucide:package', from: 'kagent' };
  return { kind: 'network', name, icon: 'lucide:globe', from: 'kagent' };
}

/** The runtime, plugins and network policies of an agent's kagent deployment; none when it isn't deployed. */
export function kagentConnections(agent: Agent): ActorConnection[] {
  const d = agent.kagent;
  if (!d) return [];
  const claude = Boolean(d.plugins?.length || d.trace || /claude/i.test(d.harness ?? ''));
  const out: ActorConnection[] = [];
  if (claude) out.push({ kind: 'runtime', name: 'Claude Code', detail: d.harness ? `harness ${d.harness}` : 'kagent’s Claude Code harness', icon: brandIcon('claude'), from: 'kagent' });
  out.push({ kind: 'runtime', name: 'kagent', detail: `${d.name}${claude ? ' · sandbox, hot start' : ' · kagent’s own runtime'}`, icon: brandIcon('kagent'), from: 'kagent' });
  for (const plugin of d.plugins ?? []) {
    const [name, marketplace] = plugin.id.split('@');
    out.push(
      name === 'landflow-harness'
        ? d.guard === 'strict'
          ? { kind: 'plugin', name, detail: 'Landflow’s mod: read-only on the code, usage, redaction', icon: 'lucide:lock', from: 'kagent' }
          : { kind: 'plugin', name, detail: `Landflow’s mod: usage, ${d.guard === 'report' ? 'guardrails report only' : 'guardrails'}, redaction`, icon: 'lucide:shield-check', from: 'kagent' }
        : { kind: 'plugin', name: name ?? plugin.id, ...(marketplace && { detail: marketplace }), icon: brandIcon('claude'), from: 'kagent' },
    );
  }
  const policies = [...(d.egressPolicies ?? []), ...(d.trace ? [`${d.name}-landflow`] : [])];
  for (const policy of new Set(policies)) out.push(policyConnection(policy, d.name));
  return out;
}

const trimmed = (url: string) => url.replace(/\/+$/, '');

/**
 * The Landflow agent deployed to kagent that answers at an A2A URL: by the URL its deployment recorded, else by the
 * kagent name the URL ends with (`…/agents/<namespace>/<name>`) when only one deployed agent has it.
 */
export function deployedAgentAt(url: string | undefined): Agent | undefined {
  if (!url) return undefined;
  const deployed = agentStore.list().filter((agent) => agent.kagent);
  const want = trimmed(url);
  const exact = deployed.find((a) => a.kagent?.trace?.a2aUrl && trimmed(a.kagent.trace.a2aUrl) === want);
  if (exact) return exact;
  const name = /\/agents\/[^/]+\/([^/?#]+)$/.exec(want)?.[1];
  const named = name ? deployed.filter((a) => a.kagent?.name === decodeURIComponent(name)) : [];
  return named.length === 1 ? named[0] : undefined;
}

/** A remote agent at an A2A URL: the Landflow agent behind it when it is one deployed to kagent, else the URL's host. */
export function remoteConnections(url: string | undefined): ActorConnection[] {
  const agent = deployedAgentAt(url);
  if (agent) return mergeConnections(kagentConnections(agent), agentConnections(agent));
  const host = hostOf(url);
  return host ? [{ kind: 'runtime', name: 'A2A agent', detail: host, icon: 'lucide:radio-tower' }] : [];
}

/** What a Run an Agent node's agent or an A2A Agent node's remote agent works with (the journal's `connectionsOf`). */
export function nodeConnections(node: WorkflowNode, flow: { model: boolean; memory: boolean }): ActorConnection[] | undefined {
  const p = node.parameters ?? {};
  const plain = (value: unknown) => (typeof value === 'string' && value.trim() && !value.includes('{{') ? value.trim() : undefined);
  if (node.type === 'core.messageAgent') {
    const agent = plain(p.agentId) ? agentStore.get(String(p.agentId)) : undefined;
    // It runs here, in Landflow's own runtime, whether or not it is also deployed to kagent.
    return agent ? agentConnections(agent, flow) : undefined;
  }
  if (node.type === 'core.a2aAgent') return remoteConnections(plain(p.agentUrl));
  return undefined;
}
