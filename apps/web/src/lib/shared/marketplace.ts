/**
 * Marketplaces (docs/marketplace.md): Claude Code plugin marketplaces whose agents and skills
 * install as Landflow agents and library skills, plus Landflow node plugins the host runs.
 * Types shared by the API routes and the React client (and `flowLink`). No runtime imports.
 */
import type { AgentConfig, AgentSkill } from './agents';
import type { TemplateDetail } from './templates';

/** Where a marketplace's `.claude-plugin/marketplace.json` comes from. */
export type MarketplaceLocation =
  | { kind: 'github'; owner: string; repo: string; ref?: string }
  /** A direct link to a marketplace.json: relative plugin sources can't resolve. */
  | { kind: 'url'; url: string }
  /** A directory on the host (only with LANDFLOW_MARKETPLACE_ALLOW_LOCAL=1). */
  | { kind: 'local'; path: string };

export interface MarketplaceSummary {
  id: string;
  /** The marketplace's own `name`, once fetched. */
  name: string;
  description?: string;
  owner?: string;
  location: MarketplaceLocation;
  /** What the user typed: `anthropics/claude-plugins-official`, a URL… */
  input: string;
  preset?: boolean;
  /** False for the built-in Anthropic official marketplace. */
  removable: boolean;
  plugins: number;
  fetchedAt?: string;
  error?: string;
}

/** A plugin source resolved to something we can read, or why we can't. */
export type ResolvedSource =
  | { kind: 'github'; owner: string; repo: string; ref: string; path: string; sha?: string }
  | { kind: 'local'; root: string; path: string }
  | { kind: 'unsupported'; reason: string };

export interface CatalogPlugin {
  name: string;
  displayName?: string;
  description: string;
  version?: string;
  category?: string;
  author?: string;
  homepage?: string;
  keywords: string[];
  /** e.g. `./plugins/feature-dev` or `github.com/acme/tools @ v1.2 · plugins/x`. */
  sourceLabel: string;
  supported: boolean;
  unsupportedReason?: string;
  /** The entry declares a Landflow node plugin (`landflow` field). */
  landflow: boolean;
  /** Flows the entry lists (`flows` field); the plugin's `flows/` folder may hold more, counted once it is read. */
  flows: number;
  installed: boolean;
}

/**
 * A flow a plugin ships: a Landflow template file (`landflow/template`, version 1) under `flows/`, or listed in the
 * entry's or plugin.json's `flows`. Installing the plugin adds it to Templates, instance-wide.
 */
export interface MarketplaceFlow {
  /** The file inside the plugin. */
  path: string;
  name: string;
  description: string;
  categories: string[];
  /** Distinct node types it uses. */
  nodeTypes: string[];
  nodeCount: number;
  /** Credential slots it asks for when used. */
  credentials: string[];
  /** Node types neither on this instance nor from this plugin's own node plugin: the template says "Needs a plugin". */
  needs: string[];
  /** Its share page (`flowLink`), filled in with `needs`. */
  link?: string;
}

/** A flow's contents as its share page shows them: Templates' view of the file, nothing saved. */
export type FlowPreview = Pick<TemplateDetail, 'name' | 'description' | 'categories' | 'credentials' | 'setup' | 'dataTables' | 'workflow' | 'nodeTypes' | 'nodeCount' | 'problems'>;

/**
 * GET /api/marketplaces/:id/plugins/:name/flow?path= — one flow for its share page, read only (no run, no test; the
 * page installs the plugin). `:id` is the marketplace's id or its name, so a link works on every instance that added
 * the same marketplace.
 */
export interface MarketplaceFlowView {
  marketplace: Pick<MarketplaceSummary, 'id' | 'name' | 'description' | 'owner' | 'location'>;
  plugin: CatalogPlugin;
  flow: MarketplaceFlow;
  template: FlowPreview;
  /** All the plugin's flows (this one included), for the page's list. */
  flows: Array<Pick<MarketplaceFlow, 'path' | 'name'>>;
  /** The plugin is installed: the template this flow became, where "Use template" is. */
  templateId?: string;
  /** This page's link (see `flowLink`). */
  link: string;
}

/**
 * A flow's share link: `/marketplace/flows/<marketplace name>/<plugin>/<path in the plugin>`, plus `?source=` (what
 * "Add marketplace" takes) so an instance that hasn't added the marketplace can offer to.
 */
export function flowLink(marketplace: string, plugin: string, path: string, source?: string): string {
  const parts = [marketplace, plugin, ...path.split('/').filter(Boolean)].map(encodeURIComponent).join('/');
  return `/marketplace/flows/${parts}${source ? `?source=${encodeURIComponent(source)}` : ''}`;
}

export interface Catalog {
  marketplace: MarketplaceSummary;
  plugins: CatalogPlugin[];
  categories: string[];
}

/** A plugin in Explore: a catalog entry of any added marketplace, with what Explore read of its files. */
export interface ExplorePlugin extends CatalogPlugin {
  marketplace: { id: string; name: string };
  /** Read from the plugin's files (Explore reads Landflow plugins, and every plugin of a small marketplace). */
  read?: { nodePlugin?: { id: string; runtime: NodePluginManifest['runtime'] }; agents: number; skills: number };
  /** Its node plugin as this instance's registry knows it, once installed: the brand icon and live status. */
  registered?: { icon?: string; color?: string; status: string; nodes: number };
}

/** A flow in Explore: one marketplace plugin's flow, with where it comes from and the template it became here. */
export interface ExploreFlow extends MarketplaceFlow {
  marketplace: { id: string; name: string };
  plugin: string;
  pluginDisplayName?: string;
  pluginInstalled: boolean;
  /** The template the flow became when its plugin was installed. */
  templateId?: string;
}

/**
 * GET /api/marketplaces/explore — every added marketplace at once: their plugins, the flows of the Landflow plugins
 * among them, and the marketplaces that couldn't be read. The Templates library and the registry's own plugins are
 * merged in on the page.
 */
export interface ExploreResult {
  plugins: ExplorePlugin[];
  flows: ExploreFlow[];
  categories: string[];
  errors: Array<{ marketplaceId: string; marketplace: string; message: string }>;
}

export interface ClaudeAgentFile {
  path: string;
  name: string;
  description: string;
  model?: string;
  tools: string[];
  color?: string;
  /** The system prompt. */
  body: string;
  /** What a Landflow export put in `.landflow/agents/<file name>.json`: the config Claude Code has no place for. */
  landflow?: LandflowAgentData;
}

/** `.landflow/agents/<slug>.json`: an exported agent's Landflow-only data (docs/marketplace.md#export-agents-as-plugins). */
export const LANDFLOW_AGENT_KIND = 'landflow/agent';
export interface LandflowAgentData {
  kind: typeof LANDFLOW_AGENT_KIND;
  version: 1;
  /** The agent's id where it was exported: other exported agents' sub-agent tools point at it. */
  sourceId?: string;
  /** The config without schedules, channels and credentials. */
  config: Partial<AgentConfig>;
  /** The prompt written as the agent file's body: when the body no longer equals it, it was edited and replaces the instructions. */
  body: string;
}

/** `.landflow/team.json`: an exported team; members that are Landflow agents name their agent file by `agent` (its slug). */
export const LANDFLOW_TEAM_KIND = 'landflow/team';
export interface LandflowTeamData {
  kind: typeof LANDFLOW_TEAM_KIND;
  version: 1;
  team: { name: string; goal?: string; description?: string; members: Array<Record<string, unknown>> };
}

export interface ClaudeSkillFile {
  /** Directory of the skill inside the plugin. */
  dir: string;
  name: string;
  description: string;
  body: string;
  allowedTools: string[];
  references: Array<{ name: string; content: string }>;
}

export type UnsupportedKind = 'commands' | 'hooks' | 'mcpServers' | 'lspServers' | 'outputStyles' | 'bin' | 'monitors' | 'workflows';

export interface UnsupportedComponent {
  kind: UnsupportedKind;
  /** File names or server names. */
  items: string[];
}

/**
 * `landflow.plugin.json` in a plugin directory, or the `landflow` field of a marketplace entry:
 * a node plugin the host downloads and runs. It announces itself to the registry like any plugin.
 */
export interface NodePluginManifest {
  /** The plugin id it announces (definePlugin info.id). */
  id: string;
  name?: string;
  runtime: 'node' | 'python' | 'go' | 'binary';
  /** argv run once in the plugin directory after download, e.g. ["npm", "install", "--omit=dev"]. */
  install?: string[];
  /** argv that serves the plugin, e.g. ["tsx", "src/main.ts"] or ["python3", "main.py"]. */
  start: string[];
  /** Transports to enable; the host picks the ports (LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT). Default ["http"]. */
  transports?: Array<'http' | 'grpc'>;
  /** Extra environment variables (non-secret). */
  env?: Record<string, string>;
}

export interface PluginDetail {
  marketplaceId: string;
  plugin: CatalogPlugin;
  source: ResolvedSource;
  /** `.claude-plugin/plugin.json` merged with the entry, as read. */
  manifest: Record<string, unknown>;
  /** The plugin has a `.claude-plugin/plugin.json`: kagent's Claude Code runtime loads only such plugins. */
  claudeManifest?: boolean;
  agents: ClaudeAgentFile[];
  skills: ClaudeSkillFile[];
  unsupported: UnsupportedComponent[];
  nodePlugin?: NodePluginManifest;
  flows: MarketplaceFlow[];
  /** A team exported with the plugin (`.landflow/team.json`): installing creates it from the plugin's agents. */
  landflowTeam?: LandflowTeamData;
  readme?: string;
  /** Things that didn't load (a skill without SKILL.md, a file too large…). */
  warnings: string[];
}

export interface NodePluginStatus {
  state: 'installing' | 'starting' | 'running' | 'restarting' | 'stopped' | 'crashed';
  pid?: number;
  port?: number;
  restarts: number;
  lastExit?: string;
  startedAt?: string;
}

export interface InstalledPlugin {
  /** `<plugin>@<marketplace name>` */
  id: string;
  plugin: string;
  marketplaceId: string;
  marketplaceName: string;
  version?: string;
  description?: string;
  source: ResolvedSource;
  installedAt: string;
  agents: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string }>;
  /** Templates made from the plugin's flows (instance-wide); uninstall deletes them. */
  templates?: Array<{ id: string; name: string }>;
  /** The team an exported plugin carried (`.landflow/team.json`); uninstall deletes it. */
  teams?: Array<{ id: string; name: string }>;
  unsupported: UnsupportedComponent[];
  nodePlugin?: {
    pluginId: string;
    dir: string;
    /** The command the host runs (shown before install). */
    command: string;
    manifest: NodePluginManifest;
    port: number;
    grpcPort?: number;
    status?: NodePluginStatus;
    /** This install (an update gets a new one): queue mode restarts every process's copy when it changes. */
    revision?: string;
    /** A hash of the downloaded files: workers that download the plugin themselves check they got the same code. */
    contentHash?: string;
    /** Where the files were downloaded from (a GitHub branch or tag pinned to its commit): workers download the same. */
    source?: ResolvedSource;
  };
}

/** A skill installed from a plugin, ready to add to any agent. */
export interface LibrarySkill extends AgentSkill {
  source: { plugin: string; marketplace: string; installedId: string };
  installedAt: string;
}

export interface InstallResult {
  installed: InstalledPlugin;
  /** Components that came with the plugin but don't run in Landflow yet. */
  notSupported: UnsupportedComponent[];
  warnings: string[];
}

/** What a node-plugin install will run; the API refuses without `confirm: true`. */
export interface InstallConfirmation {
  needsConfirmation: true;
  plugin: string;
  repository: string;
  install?: string;
  command: string;
  warning: string;
}
