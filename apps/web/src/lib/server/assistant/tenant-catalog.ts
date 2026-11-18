/**
 * AG18: what Spotlight and MCP clients can know about the tenant (contracts/ag4/README.md "The tenant tool layer"):
 * the agents the caller can read, the nodes an agent can use as tools with their plugin and credential needs, the
 * knowledge bases, the models and the credentials by name. Every function answers only what `actor` may read (no actor:
 * the instance's view, as the MCP server gives the instance access token). Nothing here reads a secret: credentials are
 * names and types.
 */
import type {
  CatalogAgent,
  CatalogAgentTool,
  CatalogCredential,
  CatalogFolder,
  CatalogKnowledgeBase,
  CatalogModel,
  CatalogToolNode,
  KnowledgeListing,
} from '@/lib/shared/tenant-catalog';
import { writesOutside } from '@/lib/shared/run-check';
import { isNodeKnowledge, type Agent, type AgentConfig, type AgentToolConfig } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { agentStore, configOf } from '../agents/store';
import { listKnowledgeDocuments } from '../agents/knowledge';
import { credentials } from '../credentials/vault';
import { filesDir } from '../nodes/files';
import { canResource, withOwnership, type Actor } from '../projects';
import { credentialUsableBy } from '../projects/access';
import { homeProjectId } from '../projects/store';
import { redactValue } from '../secrets/redact';
import { store } from '../store';
import { agentTeamStore } from '../agent-teams/store';
import { registry } from '../plugins/registry';
import { agentResources, builderModel } from './agent-resources';
import { availableTypes, searchNodes } from './research';

/** The instance's view: what the MCP server gives a caller with no user behind it. */
const INSTANCE: Actor = { id: 'instance', role: 'owner' };
const who = (actor: Actor | undefined): Actor => actor ?? INSTANCE;

const clip = (value: string | undefined, max: number) => {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined;
};

/** The action nodes an agent can use as tools (the Abilities tab's filter, as architect.ts `usableAsTool`). */
const usable = (t: NodeTypeInfo) => t.descriptor.kind === 'action' && t.descriptor.inputs.every((p) => p.type === 'main' || !p.required);

/** Words that say nothing about what a tool does: left out of a query so "IP addresses and domains in an alert" is matched on its content words. */
const STOP = new Set(['and', 'or', 'the', 'an', 'in', 'of', 'to', 'for', 'with', 'from', 'on', 'at', 'by', 'it', 'is', 'my', 'our', 'that', 'this', 'each', 'all']);
const contentWords = (query: string) => query.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w.toLowerCase())).join(' ');

const qualified = (pluginId: string, name: string) => (name.includes('.') ? name : `${pluginId}.${name}`);

/** The operation values a node offers (`operation` option properties), if any. */
function operationsOf(info: NodeTypeInfo): string[] {
  const values = new Set<string>();
  for (const p of info.descriptor.properties) {
    if (p.name !== 'operation' || !p.options?.length) continue;
    for (const o of p.options) values.add(String(o.value));
  }
  return [...values];
}

/** Whether a node writes outside (send, post, create, update, delete…), by the rule the run check uses. */
function nodeWrites(info: NodeTypeInfo): boolean {
  const ops = operationsOf(info);
  const probe = (parameters: Record<string, unknown>) => writesOutside({ type: info.type, parameters });
  return ops.length ? ops.some((operation) => probe({ operation })) || probe({}) : probe({});
}

let indexed: { at: number; map: Map<string, NodeTypeInfo> } | undefined;
function typesIndex(): Map<string, NodeTypeInfo> {
  // The registry answers from memory; a short cache keeps a listing of many agents from rebuilding the map per tool.
  if (!indexed || Date.now() - indexed.at > 1000) indexed = { at: Date.now(), map: new Map(availableTypes().map((t) => [t.type, t])) };
  return indexed.map;
}

const credentialName = (ref: { id: string; name: string } | undefined): string | undefined => (ref ? (credentials.get(ref.id)?.name ?? ref.name) : undefined);

/** One tool of an agent's config, as the catalog lists it. */
function toolOf(tool: AgentToolConfig, agents: Map<string, string>): CatalogAgentTool {
  const asksFirst = tool.requireApproval ? { asksFirst: true } : {};
  switch (tool.type) {
    case 'node': {
      const info = typesIndex().get(tool.nodeType);
      const needs = (info?.descriptor.credentials ?? []).filter((c) => c.required);
      let credential: string | undefined;
      if (needs.length) {
        const have = needs.map((c) => credentialName(tool.credentials?.[c.name] ?? tool.credentials?.[c.name.split('.').pop()!]));
        credential = have.every(Boolean) ? have[0] : 'missing';
      }
      return { name: tool.name, kind: 'node', nodeType: tool.nodeType, ...(info && { plugin: info.pluginName }), ...asksFirst, ...(credential && { credential }) };
    }
    case 'knowledge':
      return { name: isNodeKnowledge(tool) ? tool.name : tool.collection, kind: 'knowledge', ...asksFirst };
    case 'agent':
      return { name: `asks ${agents.get(tool.agentId) ?? 'another agent'}`, kind: 'agent', ...asksFirst };
    case 'workflow':
      return { name: tool.name, kind: 'workflow', ...asksFirst };
    case 'mcp':
      return { name: tool.name, kind: 'mcp', ...asksFirst };
    default:
      return { name: (tool as { name?: string }).name ?? 'tool', kind: 'a2a', ...asksFirst };
  }
}

/** The workflows (the caller can read) that run each agent: a Run an Agent node, or a Run a Team node whose team has it. */
function usedByMap(actor: Actor, projectId?: string): Map<string, string[]> {
  const teamMembers = new Map<string, string[]>();
  for (const team of agentTeamStore.list()) {
    const config = team.published ?? team.draft;
    teamMembers.set(team.id, config.members.flatMap((m) => (m.kind === 'agent' ? [m.agentId] : [])));
  }
  const used = new Map<string, Set<string>>();
  const add = (agentId: string, name: string) => used.set(agentId, (used.get(agentId) ?? new Set()).add(name));
  for (const w of store.listWorkflows()) {
    if (!canResource(actor, 'workflow', w.id, 'read')) continue;
    if (projectId && homeProjectId('workflow', w.id) !== projectId) continue;
    for (const n of w.nodes) {
      if (n.type === 'core.messageAgent' && typeof n.parameters.agentId === 'string') add(n.parameters.agentId, w.name);
      else if (n.type === 'core.runTeam' && typeof n.parameters.teamId === 'string') for (const id of teamMembers.get(n.parameters.teamId) ?? []) add(id, w.name);
    }
  }
  return new Map([...used].map(([id, names]) => [id, [...names]]));
}

function agentOf(agent: Agent, names: Map<string, string>, used: Map<string, string[]>): CatalogAgent {
  const config: AgentConfig = configOf(agent.published?.config ?? agent);
  const tools = config.tools.map((t) => toolOf(t, names));
  const wfs = used.get(agent.id) ?? [];
  const description = clip(config.description, 240) ?? clip(config.persona?.mission, 240);
  const role = clip(config.persona?.role, 80);
  return {
    id: agent.id,
    name: config.name,
    ...(role && { role }),
    ...(description && { description }),
    ...(config.model?.model && { model: `${config.model.provider}/${config.model.model}` }),
    memory: config.memory.crossSession ? 'across sessions' : 'this conversation',
    tools,
    knowledge: tools.filter((t) => t.kind === 'knowledge').map((t) => t.name),
    ...(agent.published && { published: agent.published.version }),
    draftDiffers: agent.published ? JSON.stringify(configOf(agent)) !== JSON.stringify(configOf(agent.published.config)) : false,
    usedBy: { count: wfs.length, names: wfs.slice(0, 5) },
  };
}

/** Every agent the caller can read, published or not, optionally matched by a text query. */
export function catalogAgents(actor: Actor | undefined, options: { query?: string; projectId?: string } = {}): CatalogAgent[] {
  const me = who(actor);
  const all = agentStore.list().filter((a) => canResource(me, 'agent', a.id, 'read') && (!options.projectId || homeProjectId('agent', a.id) === options.projectId));
  const names = new Map(all.map((a) => [a.id, a.published?.config.name ?? a.name]));
  const used = usedByMap(me, options.projectId);
  const terms = (options.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const list = all.map((a) => agentOf(a, names, used));
  if (!terms.length) return list;
  const haystack = (a: CatalogAgent) => [a.name, a.role, a.description, ...a.tools.map((t) => `${t.name} ${t.plugin ?? ''}`)].join(' ').toLowerCase();
  return list.filter((a) => terms.some((t) => haystack(a).includes(t)));
}

/** One agent with its instructions and each tool's parameters (a credential by name; no secret is read). */
export function catalogAgent(actor: Actor | undefined, id: string, projectId?: string): (CatalogAgent & { instructions: string; toolParameters: Array<{ name: string; parameters: Record<string, unknown> }> }) | undefined {
  const me = who(actor);
  const agent = agentStore.get(id);
  if (!agent || !canResource(me, 'agent', id, 'read') || (projectId && homeProjectId('agent', id) !== projectId)) return undefined;
  const names = new Map(agentStore.list().map((a) => [a.id, a.published?.config.name ?? a.name]));
  const config = configOf(agent.published?.config ?? agent);
  return {
    ...agentOf(agent, names, usedByMap(me, projectId)),
    instructions: config.instructions,
    toolParameters: config.tools.flatMap((t) => (t.type === 'node' ? [{ name: t.name, parameters: redactValue(t.parameters) }] : [])),
  };
}

/** Action nodes of plugins that are online that an agent can use as a tool, with what each needs. Best match first with a query. */
export function catalogToolNodes(actor: Actor | undefined, options: { query?: string; types?: string[]; projectId?: string } = {}): CatalogToolNode[] {
  const mine = who(actor);
  const wanted = options.types?.length ? new Set(options.types) : undefined;
  const types = availableTypes().filter((t) => usable(t) && (!wanted || wanted.has(t.type)));
  const have = withOwnership(mine, 'credential', credentials.list()).filter((c) => !options.projectId || credentialUsableBy(c.id, options.projectId));
  const byType = new Map<string, string[]>();
  for (const c of have) byType.set(c.type, [...(byType.get(c.type) ?? []), c.name]);
  const describe = (info: NodeTypeInfo): CatalogToolNode => {
    const ops = operationsOf(info);
    return {
      nodeType: info.type,
      displayName: info.descriptor.displayName,
      plugin: info.pluginName,
      pluginId: info.pluginId,
      description: clip(info.descriptor.description, 200) ?? '',
      ...(ops.length && { operations: ops.slice(0, 30) }),
      writes: nodeWrites(info),
      credentials: (info.descriptor.credentials ?? []).map((c) => {
        const type = qualified(info.pluginId, c.name);
        return { type, displayName: credentialDisplayName(type), required: Boolean(c.required), yours: byType.get(type) ?? [] };
      }),
    };
  };
  let chosen: NodeTypeInfo[];
  if (options.query?.trim()) {
    // Best match first: the node that covers the most of the query's content words, then the keyword score.
    const words = contentWords(options.query).toLowerCase().split(' ').filter(Boolean);
    const rank = searchNodes(words.join(' ') || options.query, types, types.length);
    const score = new Map(rank.map((h) => [h.type, h.score]));
    const covers = (t: NodeTypeInfo) => {
      const d = t.descriptor;
      const text = `${d.displayName} ${t.type} ${(d.keywords ?? []).join(' ')} ${d.description}`.toLowerCase();
      return words.filter((w) => text.includes(w)).length;
    };
    // Wave ag4 carryover: of two nodes that cover the query as well (Postgres, SQLite for "the sales database"), the one
    // whose credential the person already has ranks first: it works right away, and the person named no server.
    const ready = (t: NodeTypeInfo) => ((t.descriptor.credentials ?? []).some((c) => byType.has(qualified(t.pluginId, c.name))) ? 1 : 0);
    chosen = types
      .filter((t) => score.has(t.type))
      .sort((a, b) => covers(b) - covers(a) || ready(b) - ready(a) || score.get(b.type)! - score.get(a.type)! || a.descriptor.displayName.localeCompare(b.descriptor.displayName))
      .slice(0, 12);
  } else chosen = [...types].sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.descriptor.displayName.localeCompare(b.descriptor.displayName));
  return chosen.map(describe);
}

/** The credential type's display name when a plugin declares one, else the part after the plugin id. */
function credentialDisplayName(type: string): string {
  const info = registry.credentialType(type);
  return info?.descriptor.displayName ?? type.split('.').pop() ?? type;
}

/** The top-level folders of the files directory with how many files each holds (names and counts only). */
async function topFolders(): Promise<CatalogFolder[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = filesDir();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: CatalogFolder[] = [];
  let budget = 5000; // entries read in all: a huge files directory is counted up to here, not walked whole
  const count = async (dir: string, depth = 0): Promise<number> => {
    if (depth > 4 || budget <= 0) return 0;
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    budget -= items.length;
    let n = 0;
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) n += await count(join(dir, item.name), depth + 1);
      else if (item.isFile()) n += 1;
    }
    return n;
  };
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    out.push({ path: entry.name, files: await count(join(root, entry.name)) });
  }
  return out.slice(0, 50);
}

/** The knowledge bases agents search, with document counts, and the folders a new one could come from. */
export async function catalogKnowledge(actor: Actor | undefined, projectId?: string): Promise<KnowledgeListing> {
  const resources = await agentResources(who(actor), projectId);
  const bases: CatalogKnowledgeBase[] = [];
  for (const k of resources.knowledge) {
    let documents: number | undefined;
    let indexedFrom: string | undefined;
    if (k.store === 'sqlite' || k.store === 'memory') {
      try {
        const { documents: docs } = await listKnowledgeDocuments({ ...k, id: 'catalog', type: 'knowledge' } as Parameters<typeof listKnowledgeDocuments>[0]);
        documents = docs.length;
        const tops = new Set(docs.map((d) => (d.fileName.includes('/') ? d.fileName.split('/')[0] : '')));
        if (tops.size === 1 && [...tops][0]) indexedFrom = [...tops][0];
      } catch {
        documents = undefined;
      }
    }
    bases.push({
      collection: k.collection,
      store: k.store,
      ...(clip(k.description, 200) && { description: clip(k.description, 200) }),
      ...(documents !== undefined && { documents }),
      search: k.embeddings.provider === 'none' ? 'keyword' : k.embeddings.model,
      ...(indexedFrom && { indexedFrom }),
      usedBy: k.usedBy,
    });
  }
  const emb = resources.embeddings;
  return { bases, folders: await topFolders(), newSearch: !emb || emb.provider === 'none' ? 'keyword' : emb.model };
}

/** The chat models an agent can run on; the host's builder model first, marked as the default. */
export async function catalogModels(actor: Actor | undefined): Promise<CatalogModel[]> {
  const { models } = await agentResources(who(actor));
  const builder = builderModel().replace(/^ollama\//, '');
  const full = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;
  const list: CatalogModel[] = models.map((m) => ({ model: full(m), provider: m.provider, ...(m.note && { note: m.note }), isDefault: false }));
  const at = list.findIndex((m) => m.model === builder || m.model === `ollama/${builder}`);
  if (at >= 0) {
    list[at]!.isDefault = true;
    list.unshift(list.splice(at, 1)[0]!);
  } else {
    const prefix = /^([a-z]+)\//.exec(builderModel())?.[1];
    const provider = prefix ?? 'ollama';
    list.unshift({ model: prefix ? builderModel() : `ollama/${builderModel()}`, provider, note: 'the host’s builder model', isDefault: true });
  }
  return list;
}

/** The credentials the caller can see: name and type, never data. */
export function catalogCredentials(actor: Actor | undefined, projectId?: string): CatalogCredential[] {
  return withOwnership(who(actor), 'credential', credentials.list()).filter((c) => !projectId || credentialUsableBy(c.id, projectId)).map((c) => ({ name: c.name, type: c.type }));
}
