/**
 * AG18: the tenant tools as Spotlight's tool loops call them (chat.ts and architect.ts) and as the instance MCP server
 * answers them (../mcp/agent-tools.ts): one implementation, two doors. Each answers only what the caller's actor may
 * read; credentials by name and type, never data. A tool call is a step of the trace, never a model call, so none of
 * this writes a usage row.
 */
import type { ToolSpec } from '@landflow/engine';
import { TENANT_READ_TOOLS, type CatalogAgent } from '@/lib/shared/tenant-catalog';
import type { Actor } from '../projects';
import { AGENT_PRACTICES } from './agent-practices';
import { catalogAgent, catalogAgents, catalogCredentials, catalogKnowledge, catalogModels, catalogToolNodes } from './tenant-catalog';

/** The tools this layer answers itself (`get_run_log` is the run reader's). */
export const TENANT_TOOL_NAMES = TENANT_READ_TOOLS.filter((n) => n !== 'get_run_log');
export type TenantToolName = (typeof TENANT_TOOL_NAMES)[number];

/** The answer's size per tool, in characters of JSON: a listing is cut to whole entries, never mid-JSON. */
const BUDGET: Record<TenantToolName, number> = { list_agents: 14_000, get_agent: 12_000, list_tool_nodes: 14_000, list_knowledge_bases: 8_000, list_models: 6_000, list_credentials: 6_000, read_agent_practices: 12_000 };

export const TENANT_TOOLS: ToolSpec[] = [
  {
    name: 'list_agents',
    description:
      'The agents this person can read, published or not: name, role, what each does, its model, its tools (with the plugin each comes from, which ask first, and the credential each uses by name), the knowledge bases it searches, whether it is published, and the workflows that run it. Call it before proposing or designing an agent: one that already covers the job is reused, not copied. Optional query narrows by words.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to match against names, roles, descriptions and tools' } } },
  },
  {
    name: 'get_agent',
    description: 'One agent in full: its instructions and each tool node\'s parameters (credentials by name only). Takes the agent\'s id or name. Call it after list_agents, when you must judge whether this agent fits.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The agent\'s id or its name' } }, required: ['id'] },
  },
  {
    name: 'list_tool_nodes',
    description:
      'The nodes an agent can use as tools, from the plugins that are online, found by what they do (query: "IP addresses and domains in an alert", "send an email", "query a database"): each with its plugin, operations, whether it writes outside (then the tool asks first) and the credential types it needs with the credentials this person already has of each type, by name. Call it before choosing a plugin or a tool for an agent; never guess a node type.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What the tool should do, in words' }, types: { type: 'array', items: { type: 'string' }, description: 'Only these node types' } } },
  },
  {
    name: 'list_knowledge_bases',
    description: 'The knowledge bases agents search (collection, store, how many documents, keyword or embeddings search, the folder it came from, who uses it) and the folders of the files directory a new one could be indexed from, by name and file count. Call it before attaching knowledge: an existing base that fits is attached as it is; a folder is indexed only when the person named it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_models',
    description: 'The chat models an agent can run on here, the host\'s default first (isDefault). Call it before naming a model: use the one the person named when it is listed, else the default, and say why.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_credentials',
    description: 'The credentials this person has, by name and type (never their values). Offer a fitting one by name; the person picks, you never pick or set one.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_agent_practices',
    description: 'The written best practices for building an agent: one job, the fewest tools, read before write, asks first on writes, instructions in four parts, what the agent decides, knowledge, test cases, the model rule, credentials, smoke test before publish. Call it before designing or changing an agent.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface TenantToolContext {
  /** The caller; absent: the instance's view (the MCP instance access token). */
  actor?: Actor;
  /** The MCP project scope: only that project's agents, workflows and usable credentials are answered. */
  projectId?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** JSON of `list`, whole entries only, within `budget` characters. */
function fit<T>(list: T[], budget: number, wrap: (items: T[]) => unknown = (items) => items): string {
  let items = list;
  let text = JSON.stringify(wrap(items));
  while (text.length > budget && items.length > 1) {
    items = items.slice(0, Math.max(1, Math.floor(items.length * 0.8)));
    text = JSON.stringify(wrap(items));
  }
  return text;
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Answers one tenant tool; `ok: false` is a failure to show (an agent that is not there). */
export async function tenantTool(name: string, args: Record<string, unknown>, ctx: TenantToolContext = {}): Promise<{ text: string; label: string; ok: boolean }> {
  const { actor, projectId } = ctx;
  switch (name as TenantToolName) {
    case 'list_agents': {
      const list = catalogAgents(actor, { query: str(args.query) || undefined, projectId });
      return { text: list.length ? fit(list, BUDGET.list_agents) : 'There are no agents yet.', label: `Looked at ${plural(list.length, 'agent')}`, ok: true };
    }
    case 'get_agent': {
      const asked = str(args.id) || str(args.name);
      const found = catalogAgent(actor, asked, projectId) ?? ((): ReturnType<typeof catalogAgent> => {
        const byName = catalogAgents(actor, { projectId }).find((a: CatalogAgent) => a.name.toLowerCase() === asked.toLowerCase());
        return byName ? catalogAgent(actor, byName.id, projectId) : undefined;
      })();
      if (!found) return { text: `Agent ${asked || '(none given)'} not found. Call list_agents for the agents you can read.`, label: `Looked for agent “${short(asked, 40)}”: not found`, ok: false };
      return { text: short(JSON.stringify(found), BUDGET.get_agent), label: `Read agent “${short(found.name, 40)}”`, ok: true };
    }
    case 'list_tool_nodes': {
      const query = str(args.query);
      const types = Array.isArray(args.types) ? args.types.filter((t): t is string => typeof t === 'string') : undefined;
      const list = catalogToolNodes(actor, { query: query || undefined, types, projectId });
      const label = query ? `Found ${plural(list.length, 'tool node')} for “${short(query, 40)}”` : `Looked at ${plural(list.length, 'tool node')}`;
      return { text: list.length ? fit(list, BUDGET.list_tool_nodes) : `No node an agent can use matches “${query}”. Try other words; if nothing fits, that part isn't available here.`, label, ok: true };
    }
    case 'list_knowledge_bases': {
      const listing = await catalogKnowledge(actor, projectId);
      return { text: fit(listing.bases, BUDGET.list_knowledge_bases, (bases) => ({ ...listing, bases })), label: `Looked at ${plural(listing.bases.length, 'knowledge base')}`, ok: true };
    }
    case 'list_models': {
      const list = await catalogModels(actor);
      return { text: fit(list, BUDGET.list_models), label: `Looked at ${plural(list.length, 'model')}`, ok: true };
    }
    case 'list_credentials': {
      const list = catalogCredentials(actor, projectId);
      return { text: list.length ? fit(list, BUDGET.list_credentials) : 'The person has no credentials yet.', label: `Looked at ${plural(list.length, 'credential')}`, ok: true };
    }
    case 'read_agent_practices':
      return { text: short(AGENT_PRACTICES, BUDGET.read_agent_practices), label: 'Read the agent best practices', ok: true };
    default:
      return { text: `Unknown tool ${name}.`, label: `Unknown tool ${name}`, ok: false };
  }
}

export const isTenantTool = (name: string): name is TenantToolName => (TENANT_TOOL_NAMES as readonly string[]).includes(name);
