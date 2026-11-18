/**
 * What Spotlight can know about the tenant, through tools (wave ag4, the person's ask of 2026-11-18: "I expect that the
 * Spotlight will know all the agents available for it … the plugins that are currently plugged into the tenant … the
 * knowledge bases available for the tenant … and its available models"), and what it reads of a run to fix it.
 *
 * Contract file: backbone/contracts/ag4/tenant-catalog.ts (wave ag4, owner AG18, copied byte for byte by AG19 and
 * AG20), copied to apps/web/src/lib/shared/tenant-catalog.ts. Types, tool names and pure helpers only: no import, no
 * zod, no I/O. Change it here first (the owner only), then copy.
 *
 * One layer, two doors (contracts/ag4/README.md "The tenant tool layer"):
 * - Spotlight's own tool loops (the editor's chat, `lib/server/assistant/chat.ts`, and the Agent architect,
 *   `architect.ts`) call these tools in-process with the person's actor (AG18 `lib/server/assistant/tenant-tools.ts`).
 * - The instance MCP server (`/api/mcp`) exposes the same functions under the same names (AG18
 *   `lib/server/mcp/agent-tools.ts`), so Claude Code, the kagent harness or any MCP client can do what Spotlight does.
 * A tool answers only what the caller may read (`canResource`); credentials by name and type, never data.
 */

/** The read tools, by name, in both doors. `get_run_log` is AG20's (the run reader); the rest AG18's. */
export const TENANT_READ_TOOLS = [
  'list_agents',
  'get_agent',
  'list_tool_nodes',
  'list_knowledge_bases',
  'list_models',
  'list_credentials',
  'read_agent_practices',
  'get_run_log',
] as const;
export type TenantReadTool = (typeof TENANT_READ_TOOLS)[number];

/** The write tools of the MCP door (Spotlight's chat writes through its cards and ops, never through these). */
export const TENANT_WRITE_TOOLS = ['create_agent', 'update_agent', 'test_agent', 'publish_agent'] as const;
export type TenantWriteTool = (typeof TENANT_WRITE_TOOLS)[number];

/** A tool of an agent, as the catalog lists it. */
export interface CatalogAgentTool {
  /** The tool's call name (`send_email`) or the knowledge base's collection. */
  name: string;
  kind: 'node' | 'workflow' | 'agent' | 'mcp' | 'knowledge' | 'a2a';
  /** A node tool's node type (`messaging.sendEmail`) and its plugin's display name ("Messaging"). */
  nodeType?: string;
  plugin?: string;
  asksFirst?: boolean;
  /** The credential's name, or `missing` when the node needs one and the tool has none. Never data. */
  credential?: string | 'missing';
}

export interface CatalogAgent {
  id: string;
  name: string;
  role?: string;
  description?: string;
  /** `provider/model` of the published version (the draft's when never published); absent: the host's or project's default. */
  model?: string;
  /** "this conversation" or "across sessions". */
  memory: 'this conversation' | 'across sessions';
  tools: CatalogAgentTool[];
  /** The collections it searches (also listed in `tools` with kind `knowledge`). */
  knowledge: string[];
  /** Published version number; absent: never published (a Run an Agent node cannot run it yet). */
  published?: number;
  draftDiffers: boolean;
  /** Workflows (the caller can read) that run it: how many, and up to 5 names. */
  usedBy: { count: number; names: string[] };
}

/** A node an agent can use as a tool (an action node of a plugin that is online), with what it needs. */
export interface CatalogToolNode {
  nodeType: string;
  displayName: string;
  /** The plugin's display name ("Triage", "Messaging", "Databases") and id. */
  plugin: string;
  pluginId: string;
  description: string;
  /** Its operations (`resource/operation` or the operation alone), when it has them. */
  operations?: string[];
  /** Writes something outside (send, post, create, update, delete…): an agent's tool for it asks first by default. */
  writes: boolean;
  /** The credential types it needs, each with the caller's credentials of that type, by name only. */
  credentials: Array<{ type: string; displayName: string; required: boolean; yours: string[] }>;
}

export interface CatalogKnowledgeBase {
  collection: string;
  store: string;
  description?: string;
  /** Number of documents, when the store answers. */
  documents?: number;
  /** How it is searched: an embeddings model's name, or `keyword` (Landflow's built-in BM25, ag3 AG13). */
  search: string;
  /** The folder it was indexed from (under the files directory), when known. */
  indexedFrom?: string;
  /** The agents that search it. */
  usedBy: string[];
}

export interface CatalogModel {
  /** `provider/model`. */
  model: string;
  provider: string;
  note?: string;
  /** The host's builder model (`LANDFLOW_BUILDER_MODEL`): the default an agent gets when nobody names one. */
  isDefault: boolean;
}

export interface CatalogCredential {
  name: string;
  type: string;
}

/** A top-level folder under the files directory a new knowledge base could be indexed from (names and counts only). */
export interface CatalogFolder {
  path: string;
  files: number;
}

/** What `list_knowledge_bases` answers: the bases that exist, and the folders a new one could come from. */
export interface KnowledgeListing {
  bases: CatalogKnowledgeBase[];
  folders: CatalogFolder[];
  /** How a new one would be searched on this host (`keyword` when there is no embeddings model). */
  newSearch: string;
}

/** One node of a run, as `get_run_log` reads it (AG20). */
export interface RunLogNode {
  name: string;
  type: string;
  status: 'success' | 'error' | 'skipped' | 'waiting';
  durationMs?: number;
  error?: { message: string; description?: string; httpCode?: number };
  /** Up to 3 items of its input and of its output, clipped (`clip` of assistant-ops). */
  input?: unknown[];
  output?: unknown[];
  /** The plugin's log lines for this node's call, newest last, at most 20 (`get_plugin_logs`'s source). */
  logs?: string[];
  /** A Run an Agent / Run a Team node: the agent's tool calls in order, each with its status and error. */
  agentCalls?: Array<{ tool: string; status: 'success' | 'error' | 'denied' | 'empty'; error?: string; input?: unknown; output?: unknown }>;
  /** The agent that ran (id and name) and its reply's first 400 characters. */
  agent?: { id: string; name: string; reply?: string };
}

/** What `get_run_log` answers for one execution (the latest of the workflow when no id is given). */
export interface RunLog {
  executionId: string;
  status: 'success' | 'error' | 'running' | 'waiting' | 'canceled';
  startedAt: string;
  /** The first failing node, when one failed. */
  failed?: string;
  nodes: RunLogNode[];
}

/** One line per agent for a prompt or a reply: "Alert triager (published v2): claude-sonnet-5-5; tools …; knowledge …". */
export function agentLine(a: CatalogAgent): string {
  const state = a.published ? `published v${a.published}${a.draftDiffers ? ', draft has changes' : ''}` : 'not published';
  const tools = a.tools.filter((t) => t.kind !== 'knowledge').map((t) => `${t.name}${t.asksFirst ? ' (asks first)' : ''}`);
  const parts = [
    a.model ? a.model.split('/').pop() : 'default model',
    tools.length ? `tools ${tools.join(', ')}` : 'no tools',
    a.knowledge.length ? `knowledge ${a.knowledge.join(', ')}` : '',
    a.usedBy.count ? `used by ${a.usedBy.count} workflow${a.usedBy.count === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `${a.name} (${state})${a.description ? ` — ${a.description}` : ''}: ${parts.join('; ')}`;
}

/** What a tool node needs before it can run, in words ("needs a SMTP credential: yours: Mailpit SMTP"). */
export function credentialNeedLine(node: CatalogToolNode): string | undefined {
  const needed = node.credentials.filter((c) => c.required);
  if (!needed.length) return undefined;
  return needed
    .map((c) => `needs a ${c.displayName} credential${c.yours.length ? `: yours: ${c.yours.join(', ')}` : ': you have none yet'}`)
    .join('; ');
}

/**
 * Spotlight's sentence when it reuses an agent (AG19): "Reuses “Alert triager”: it already <why>." `why` is the
 * model's, trimmed to one clause.
 */
export function reuseSentence(name: string, why: string): string {
  const clause = why.trim().replace(/^(?:because|since|as)\s+/i, '').replace(/[.\s]+$/, '');
  return `Reuses “${name}”${clause ? `: ${clause}` : ''}.`;
}

/** The first failing node of a run log and its error, in one clause of at most 12 words (chat.ts's rule). */
export function failureClause(log: RunLog): string | undefined {
  const node = log.nodes.find((n) => n.status === 'error');
  if (!node) return undefined;
  const words = (node.error?.message ?? 'failed').replace(/\s+/g, ' ').split(' ').slice(0, 10).join(' ');
  return `“${node.name}”: ${words}`;
}
