/**
 * Governance below the instance (lib/server/governance/scopes.ts): a project's settings (which plugins and node types
 * its workflows may use, who approves its publish requests) and a workflow's own policy (four-eyes publishing even
 * when the instance doesn't ask for it, a stricter node allow-list). Each level can only narrow what the one above
 * allows. Shapes shared by the API (/api/projects/<id>/settings, /api/workflows/<id>/policy), the project's Settings
 * tab and the workflow settings dialog. No runtime imports.
 *
 * Amended in wave 9 by PC13 alone (docs/projects-and-goals.md#project-settings-for-agents): a project's settings for the
 * agents that run in it (a default model, a knowledge base, which agents and which kinds of tools), each off by default
 * and each only narrowing. PC15 copies it byte for byte (its settings card); no other wave-9 package touches it.
 */
import type { AgentModel, KnowledgeBaseToolConfig } from './agents';
import { brainPageTitle } from './notion-brain'; // NB06:

/** An allow-list of plugins and node types (`off`: no list, everything the level above allows). */
export interface ScopedNodePolicy {
  mode: 'off' | 'allow';
  /** Plugin ids (`core` is the built-in nodes), `*` matches any characters. */
  plugins: string[];
  /** Node type ids (`core.httpRequest`, `messaging.*`). */
  types: string[];
}

/**
 * Who approves a project's publish requests when four-eyes publishing applies: `default` (the instance's rule),
 * `admins` (the project's admins), `editors` (its admins and editors) or `instance` (instance owners and admins only).
 * Always on top of the instance's approver role, and never the requester.
 */
export type ProjectApprovers = 'default' | 'admins' | 'editors' | 'instance';

export const PROJECT_APPROVER_LABELS: Record<ProjectApprovers, string> = {
  default: 'As the instance says (Settings → Governance)',
  admins: 'The project’s admins',
  editors: 'The project’s admins and editors',
  instance: 'Instance owners and admins only',
};

// ---- PC13: agents in the project -----------------------------------------------------------------------------

/**
 * The kinds of agent tools a project can allow. A tool's kind on the server (agents/tools.ts `BuiltTool`): `knowledge`
 * when it searches a knowledge base, `mcp` when it is an MCP server's tool (`nodeType` is the MCP Client Tool), else its
 * `kind` (`node`, `workflow`, `agent` for a sub-agent, `a2a`). Skills, memory, a team's notebook and consult tools, and a
 * workflow's own connected tools (Run an Agent, kind `flow`, already under the node allow-list) are never withheld.
 */
export const PROJECT_TOOL_KINDS = ['node', 'mcp', 'knowledge', 'workflow', 'agent', 'a2a'] as const;
export type ProjectToolKind = (typeof PROJECT_TOOL_KINDS)[number];
export const PROJECT_TOOL_KIND_LABELS: Record<ProjectToolKind, string> = {
  node: 'Nodes',
  mcp: 'MCP servers',
  knowledge: 'Knowledge bases',
  workflow: 'Workflows',
  agent: 'Sub-agents',
  a2a: 'A2A agents',
};

/** `allow`: only the agents listed (and the project's own agents, always) may run in the project. */
export interface ProjectAgentList {
  mode: 'off' | 'allow';
  /** Agent ids; at most 200. */
  ids: string[];
}

/** `allow`: agents running in the project get only these kinds of tools; the rest are withheld with a notice. */
export interface ProjectToolKinds {
  mode: 'off' | 'allow';
  kinds: ProjectToolKind[];
}

/**
 * NB06: the project's own Notion brain as its knowledge base: the company's Notion pages under the brain page (or the root,
 * by the link's `knowledgeScope`), indexed into `landflow-notion-<project>` (docs/features/notion-brain.md). It names no collection
 * and no credential: the runtime builds the tool for this project's own link only.
 */
export interface NotionBrainKnowledge {
  id?: string;
  type: 'knowledge';
  source: 'notion-brain';
  name: string;
  description: string;
}

/** One knowledge base every agent running in the project can search, as the tool `project_knowledge`. */
export interface ProjectKnowledge {
  enabled: boolean;
  /** An agent knowledge base's settings (a vector collection or a plugin node; its credentials must be usable in the project), or the project's Notion brain. */
  tool: KnowledgeBaseToolConfig | NotionBrainKnowledge;
}

/** The label the project's Notion brain has in connections and the Run Trace: `Notion · <brain page title>`. */
export const notionBrainLabel = (projectName: string) => `Notion · ${brainPageTitle(projectName)}`;

/** Whether the project's knowledge setting is its Notion brain. */
export const isNotionBrainKnowledge = (tool: ProjectKnowledge['tool']): tool is NotionBrainKnowledge => tool.source === 'notion-brain';

/** The tool name the project's knowledge base gets in every run (a name an agent's own tool already has is renamed by `dedupe`). */
export const PROJECT_KNOWLEDGE_TOOL = 'project_knowledge';

/** Whether `agentId` may run in a project with these settings: the list is off, the agent is the project's own, or it is listed. */
export function agentAllowedBy(settings: Pick<ProjectSettings, 'agents'>, agentId: string, homeHere: boolean): boolean {
  return settings.agents?.mode !== 'allow' || homeHere || settings.agents.ids.includes(agentId);
}

/** Whether a tool of `kind` may be offered in a project with these settings (undefined kind: never withheld). */
export function toolKindAllowedBy(settings: Pick<ProjectSettings, 'agentTools'>, kind: ProjectToolKind | undefined): boolean {
  return kind === undefined || settings.agentTools?.mode !== 'allow' || settings.agentTools.kinds.includes(kind);
}

/** The project's memory backend (C07): the built-in stores, or a plugin node that flags `memoryProvider` (and the credential it uses). */
export type ProjectMemory = { backend: 'built-in' } | { backend: 'provider'; nodeType: string; credentialId?: string };

export interface ProjectSettings {
  nodes: ScopedNodePolicy;
  approvers: ProjectApprovers;
  /**
   * Publishing and promoting this project's workflows needs a second person's approval, whatever the instance says
   * (as the workflow's own policy does for one workflow). Who approves follows `approvers`.
   */
  fourEyes: boolean;
  /**
   * The second brain may read item contents of this project's runs (a failing node's input and output, clipped) when it
   * writes a fix (docs/second-brain.md#principles). Off: metadata only.
   */
  brainPayloads?: boolean;
  /** PC13: the model an agent running here uses when neither the workflow's node nor the agent names one. */
  defaultModel?: AgentModel;
  /** PC13: absent or disabled: no project knowledge base. */
  knowledge?: ProjectKnowledge;
  /** PC13: absent: mode off. */
  agents?: ProjectAgentList;
  /** PC13: absent: mode off. */
  agentTools?: ProjectToolKinds;
  /** C07: where this project's memory lives. Absent: the built-in backend (facts, notebook, agent memory). */
  memory?: ProjectMemory;
  updatedAt?: string;
  updatedBy?: string;
}

export interface WorkflowPolicy {
  /** Publishing (and unpublishing, when the instance's setting says so) this workflow needs a second person's approval. */
  fourEyes: boolean;
  nodes: ScopedNodePolicy;
  updatedAt?: string;
  updatedBy?: string;
}

export const EMPTY_NODE_POLICY: ScopedNodePolicy = { mode: 'off', plugins: [], types: [] };
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = { nodes: EMPTY_NODE_POLICY, approvers: 'default', fourEyes: false };
export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = { fourEyes: false, nodes: EMPTY_NODE_POLICY };

/** GET /api/projects/<id>/settings */
export interface ProjectSettingsView {
  settings: ProjectSettings;
  /** The viewer may change them (the project's admins). */
  canEdit: boolean;
  plugins: Array<{ id: string; name: string }>;
  nodeTypes: Array<{ type: string; displayName: string; pluginId: string }>;
  /** PC13: the agents available in the project (its own, shared to it, or to all projects), for the allow-list. Always set from wave 9 on; optional so a client copy compiles against an older route. */
  availableAgents?: Array<{ id: string; name: string; home: boolean }>;
  /** C07: the installed plugin nodes that flag `memoryProvider`, with the credential types each declares, for the Memory row. */
  memoryProviders?: Array<{ type: string; displayName: string; pluginName: string; credentialTypes: string[] }>;
}

/** GET /api/workflows/<id>/policy */
export interface WorkflowPolicyView {
  policy: WorkflowPolicy;
  /** The viewer may change it (admins of the workflow's project). */
  canEdit: boolean;
  /** Four-eyes publishing is on for the whole instance (the workflow's own switch then changes nothing). */
  instanceFourEyes: boolean;
  /** The project's own allow-list, for the dialog to show what applies already. */
  project?: { id: string; name: string; nodes: ScopedNodePolicy };
}
