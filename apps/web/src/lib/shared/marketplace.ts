/**
 * Marketplaces (docs/marketplace.md): Claude Code plugin marketplaces whose agents and skills
 * install as Landflow agents and library skills, plus Landflow node plugins the host runs.
 * Types shared by the API routes and the React client. No runtime imports.
 */
import type { AgentSkill } from './agents';

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
  installed: boolean;
}

export interface Catalog {
  marketplace: MarketplaceSummary;
  plugins: CatalogPlugin[];
  categories: string[];
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
  agents: ClaudeAgentFile[];
  skills: ClaudeSkillFile[];
  unsupported: UnsupportedComponent[];
  nodePlugin?: NodePluginManifest;
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
