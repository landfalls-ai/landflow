/**
 * Marketplace operations behind the API: add / refresh / remove marketplaces, read catalogs and
 * plugins, install and uninstall. An install creates agents (one per Claude Code agent, with the
 * plugin's skills attached), library skills and, for Landflow node plugins, a supervised process;
 * it records exactly what it created so uninstall removes that and nothing else.
 */
import { existsSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  ClaudeAgentFile,
  LandflowTeamData,
  Catalog,
  CatalogPlugin,
  ExploreFlow,
  ExplorePlugin,
  ExploreResult,
  InstallConfirmation,
  InstalledPlugin,
  InstallResult,
  LibrarySkill,
  MarketplaceFlowView,
  MarketplaceLocation,
  MarketplaceSummary,
  PluginDetail,
  ResolvedSource,
} from '../../shared/marketplace';
import type { KagentPlugin } from '../../shared/agents';
import { flowLink } from '../../shared/marketplace';
import { agentStore } from '../agents/store';
import { onConfigChanged } from '../config-store';
import { clusterActive, clusterState } from '../cluster/state';
import { registry } from '../plugins/registry';
import { logger } from '../telemetry';
import { traceMarketplace } from '../telemetry/marketplace';
import { agentTeamStore } from '../agent-teams/store';
import { singleton } from '../singleton';
import { agentFromClaude, skillFromClaude, titleCase } from './map';
import { commandLine, contentHash, downloadPlugin, freePort, nodePlugins, portFree, readInstallMarker, writeInstallMarker, type SupervisedPlugin } from './node-plugins';
import { importTemplate, previewTemplate } from '../templates';
import { localTemplates } from '../templates/store';
import { loadFlows, loadPlugin, pool, readFlow, type MarketplaceEntry } from './plugin';
import { HttpError } from '../errors';
import { clearTreeCache, FetchError, fetchJson, fetchLimited, readerFor } from './reader';
import { locationLabel, parseMarketplaceInput, resolveSource, sourceLabel } from './sources';
import { marketplaceStore, PRESETS, type StoredMarketplace } from './store';

const MAX_ENTRIES = 2_000;
const DETAIL_TTL_MS = 10 * 60_000;
/** Explore reads every plugin's files in a marketplace this small (and only the Landflow ones in a larger one). */
const EXPLORE_READ_ALL = 25;

/** A marketplace request the caller can fix or retry; `body` (extra response fields such as `missing`) travels as the error's details. */
export class MarketplaceError extends HttpError {
  constructor(message: string, status = 400, readonly body?: Record<string, unknown>) {
    super(message, status, { code: 'marketplace_error', ...(body && { details: body }) });
  }
}

/** sources.ts throws plain Errors for input it refuses (a bad address, a path with `..`): the caller's fault, so a 4xx. */
function refusing<T>(status: number, fn: () => T): T {
  try {
    return fn();
  } catch (caught) {
    if (caught instanceof HttpError || !(caught instanceof Error)) throw caught;
    throw new MarketplaceError(caught.message, status, undefined);
  }
}

/**
 * What loadPlugin threw, as the route answers it. Bad input is a FetchError already (an HttpError: path escapes, sizes,
 * upstream answers) or a warning in the result; a local plugin whose directory or file is gone is the marketplace's
 * fault, a 422 that does not show the host path; anything else (a TypeError, another filesystem error) stays a plain
 * Error, so handler() answers the generic 500 and logs it.
 */
function pluginReadError(caught: unknown): unknown {
  if (caught instanceof Error && (caught as NodeJS.ErrnoException).code === 'ENOENT') return new MarketplaceError('A file this plugin lists is missing from its marketplace', 422);
  return caught;
}

const sameLocation = (a: MarketplaceLocation, b: MarketplaceLocation) =>
  a.kind === 'github' && b.kind === 'github'
    ? a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && (a.ref ?? '') === (b.ref ?? '')
    : JSON.stringify(a) === JSON.stringify(b);

function summarize(m: StoredMarketplace): MarketplaceSummary {
  return {
    id: m.id,
    name: m.name ?? (m.location.kind === 'github' ? m.location.repo : m.input),
    ...(m.description && { description: m.description }),
    ...(m.owner && { owner: m.owner }),
    location: m.location,
    input: m.input,
    ...(m.preset && { preset: true }),
    removable: m.id !== PRESETS[0].id,
    plugins: m.entries?.length ?? 0,
    ...(m.fetchedAt && { fetchedAt: m.fetchedAt }),
    ...(m.error && { error: m.error }),
  };
}

const marketplaceName = (m: StoredMarketplace) => m.name ?? m.id;
const installedId = (plugin: string, m: StoredMarketplace) => `${plugin}@${marketplaceName(m)}`;

/** What "Add marketplace" takes to add `location` again elsewhere; none for a directory on this host. */
const shareSource = (location: MarketplaceLocation) =>
  location.kind === 'github' ? `${location.owner}/${location.repo}${location.ref ? `@${location.ref}` : ''}` : location.kind === 'url' ? location.url : undefined;

function getMarketplace(id: string): StoredMarketplace {
  const m = marketplaceStore.marketplace(id);
  if (!m) throw new MarketplaceError('Marketplace not found', 404);
  return m;
}

/** Read `.claude-plugin/marketplace.json` from wherever the marketplace lives. */
async function fetchManifest(location: MarketplaceLocation): Promise<Record<string, unknown>> {
  if (location.kind === 'url') return fetchJson<Record<string, unknown>>(location.url);
  const reader = readerFor(location.kind === 'github' ? { kind: 'github', owner: location.owner, repo: location.repo, ref: location.ref ?? 'HEAD', path: '' } : { kind: 'local', root: location.path, path: '' });
  const text = await reader.text('.claude-plugin/marketplace.json').catch((error: Error) => {
    throw new MarketplaceError(`No .claude-plugin/marketplace.json in ${locationLabel(location)} (${error.message})`, 404);
  });
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MarketplaceError(`marketplace.json in ${locationLabel(location)} isn’t valid JSON`);
  }
}

function parseManifest(json: Record<string, unknown>) {
  if (!Array.isArray(json.plugins)) throw new MarketplaceError('marketplace.json has no "plugins" list');
  const entries = json.plugins.filter((p): p is MarketplaceEntry => Boolean(p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')).slice(0, MAX_ENTRIES);
  const metadata = (json.metadata ?? {}) as Record<string, unknown>;
  const owner = json.owner as { name?: unknown } | undefined;
  return {
    name: typeof json.name === 'string' && json.name.trim() ? json.name.trim() : undefined,
    description: typeof json.description === 'string' ? json.description : typeof metadata.description === 'string' ? metadata.description : undefined,
    owner: typeof owner?.name === 'string' ? owner.name : undefined,
    pluginRoot: typeof metadata.pluginRoot === 'string' ? metadata.pluginRoot : undefined,
    entries,
  };
}

const details = new Map<string, { at: number; detail: PluginDetail }>();

/**
 * A flow's node types: on this instance, from this plugin's own node plugin once installed, or still needed. Worked out
 * on every read, not cached with the detail, since installing another plugin changes it.
 */
function withNeeds(detail: PluginDetail): PluginDetail {
  const known = new Set(registry.nodeTypes().map((t) => t.type));
  const own = detail.nodePlugin ? `${detail.nodePlugin.id}.` : undefined;
  return { ...detail, flows: detail.flows.map((flow) => ({ ...flow, needs: flow.nodeTypes.filter((type) => !known.has(type) && !(own && type.startsWith(own))) })) };
}

/**
 * What an exported plugin (./export.ts) says about how its agents relate: a sub-agent tool pointing at another exported
 * agent follows it to the copy just created, and `.landflow/team.json` becomes a team of those copies.
 */
function linkExported(created: Array<{ file: ClaudeAgentFile; id: string }>, team: LandflowTeamData | undefined, teams: Array<{ id: string; name: string }>) {
  const bySource = new Map(created.flatMap((c) => (c.file.landflow?.sourceId ? [[c.file.landflow.sourceId, c.id] as const] : [])));
  for (const { id } of created) {
    const agent = agentStore.get(id);
    if (!agent?.tools.some((t) => t.type === 'agent' && bySource.has(t.agentId))) continue;
    agentStore.saveDraft(id, { tools: agent.tools.map((t) => (t.type === 'agent' && bySource.has(t.agentId) ? { ...t, agentId: bySource.get(t.agentId)! } : t)) });
  }
  if (!team) return;
  const bySlug = new Map(created.map((c) => [c.file.path.split('/').pop()!.replace(/\.md$/i, ''), c.id] as const));
  const members = team.team.members.flatMap((member) => {
    if (member.kind !== 'agent') return [member];
    const agentId = typeof member.agent === 'string' ? bySlug.get(member.agent) : undefined;
    if (!agentId) return [];
    const { agent: _slug, ...rest } = member;
    return [{ ...rest, agentId }];
  });
  const made = agentTeamStore.create({ ...team.team, members: members as never });
  teams.push({ id: made.id, name: made.draft.name });
}

export const marketplace = {
  list(): MarketplaceSummary[] {
    return marketplaceStore.marketplaces().map(summarize);
  },

  presets() {
    return PRESETS.map(({ id, input, label, description }) => ({ id, input, label, description, added: Boolean(marketplaceStore.marketplace(id)) }));
  },

  async add(input: string): Promise<MarketplaceSummary> {
    const location = refusing(400, () => parseMarketplaceInput(input));
    const existing = marketplaceStore.marketplaces().find((m) => sameLocation(m.location, location));
    if (existing) throw new MarketplaceError(`Already added as “${summarize(existing).name}”`, 409, { marketplace: summarize(existing) });
    const preset = PRESETS.find((p) => sameLocation(p.location, location));
    // Fetch before saving: a marketplace that can't be read isn't added.
    const parsed = await traceMarketplace('fetch', { 'landflow.marketplace.source': locationLabel(location) }, async () => parseManifest(await fetchManifest(location)));
    if (marketplaceStore.marketplaces().some((m) => m.name && m.name === parsed.name)) throw new MarketplaceError(`A marketplace named “${parsed.name}” is already added`, 409);
    const added = marketplaceStore.addMarketplace(input.trim(), location, preset?.id);
    const saved = marketplaceStore.updateMarketplace(added.id, { ...parsed, fetchedAt: new Date().toISOString(), error: undefined })!;
    logger.info('marketplace added', { 'landflow.marketplace.id': saved.id, 'landflow.marketplace.name': saved.name, 'landflow.marketplace.plugins': parsed.entries.length });
    return summarize(saved);
  },

  async refresh(id: string): Promise<MarketplaceSummary> {
    const m = getMarketplace(id);
    clearTreeCache();
    for (const key of details.keys()) if (key.startsWith(`${id}:`)) details.delete(key);
    try {
      const parsed = await traceMarketplace('fetch', { 'landflow.marketplace.id': id, 'landflow.marketplace.source': locationLabel(m.location) }, async () => parseManifest(await fetchManifest(m.location)));
      return summarize(marketplaceStore.updateMarketplace(id, { ...parsed, fetchedAt: new Date().toISOString(), error: undefined })!);
    } catch (error) {
      marketplaceStore.updateMarketplace(id, { error: (error as Error).message });
      throw error;
    }
  },

  remove(id: string) {
    const m = getMarketplace(id);
    if (m.preset && m.id === PRESETS[0].id) throw new MarketplaceError('The Anthropic official marketplace is built in');
    const installed = marketplaceStore.installed().filter((p) => p.marketplaceId === id);
    if (installed.length) throw new MarketplaceError(`Uninstall its plugins first: ${installed.map((p) => p.plugin).join(', ')}`, 409);
    marketplaceStore.removeMarketplace(id);
  },

  /** The plugin list; the first open of a marketplace fetches it. */
  async catalog(id: string): Promise<Catalog> {
    let m = getMarketplace(id);
    if (!m.entries) {
      await this.refresh(id);
      m = getMarketplace(id);
    }
    const installed = new Set(marketplaceStore.installed().map((p) => p.id));
    const plugins: CatalogPlugin[] = (m.entries ?? []).map((entry) => {
      const source = refusing(422, () => resolveSource(entry.source, m.location, m.pluginRoot));
      const author = entry.author as { name?: unknown } | string | undefined;
      const keywords = [...(Array.isArray(entry.keywords) ? entry.keywords : []), ...(Array.isArray(entry.tags) ? entry.tags : [])].filter((k): k is string => typeof k === 'string');
      return {
        name: entry.name,
        ...(typeof entry.displayName === 'string' && { displayName: entry.displayName }),
        description: typeof entry.description === 'string' ? entry.description : '',
        ...(typeof entry.version === 'string' && { version: entry.version }),
        ...(typeof entry.category === 'string' && { category: entry.category }),
        ...(typeof author === 'string' ? { author } : typeof author?.name === 'string' && { author: author.name }),
        ...(typeof entry.homepage === 'string' && /^https?:\/\//.test(entry.homepage) && { homepage: entry.homepage }),
        keywords: [...new Set(keywords)],
        sourceLabel: sourceLabel(source, entry.source),
        supported: source.kind !== 'unsupported',
        ...(source.kind === 'unsupported' && { unsupportedReason: source.reason }),
        landflow: Boolean(entry.landflow),
        flows: Array.isArray(entry.flows) ? entry.flows.length : 0,
        installed: installed.has(installedId(entry.name, m)),
      };
    });
    const categories = [...new Set(plugins.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort();
    return { marketplace: summarize(m), plugins, categories };
  },

  /**
   * Every added marketplace at once. Plugins come from the catalogs (a marketplace not read yet is fetched now); their
   * files are read only where it is cheap and useful: entries that declare a node plugin or list flows, and every entry
   * of a marketplace with at most EXPLORE_READ_ALL plugins. A marketplace or plugin that can't be read is skipped and
   * reported, never fatal.
   */
  async explore(): Promise<ExploreResult> {
    const registered = new Map(registry.list().map((p) => [p.id, p]));
    const result: ExploreResult = { plugins: [], flows: [], categories: [], errors: [] };
    const templates = localTemplates.list();
    for (const m of marketplaceStore.marketplaces()) {
      let catalog: Catalog;
      try {
        catalog = await this.catalog(m.id);
      } catch (error) {
        result.errors.push({ marketplaceId: m.id, marketplace: summarize(m).name, message: (error as Error).message });
        continue;
      }
      const ref = { id: m.id, name: catalog.marketplace.name };
      const readAll = catalog.plugins.length <= EXPLORE_READ_ALL;
      const entries: ExplorePlugin[] = catalog.plugins.map((plugin) => ({ ...plugin, marketplace: ref }));
      result.plugins.push(...entries);
      const flows = await pool(entries, 6, async (entry): Promise<ExploreFlow[]> => {
        const plugin = entry;
        if (!plugin.supported || !(readAll || plugin.landflow || plugin.flows > 0)) return [];
        let detail: PluginDetail;
        try {
          detail = await this.detail(m.id, plugin.name);
        } catch (error) {
          result.errors.push({ marketplaceId: m.id, marketplace: ref.name, message: `${plugin.name}: ${(error as Error).message}` });
          return [];
        }
        entry.read = { ...(detail.nodePlugin && { nodePlugin: { id: detail.nodePlugin.id, runtime: detail.nodePlugin.runtime } }), agents: detail.agents.length, skills: detail.skills.length };
        if (detail.flows.length) entry.flows = detail.flows.length;
        const live = detail.nodePlugin && registered.get(detail.nodePlugin.id);
        if (live) entry.registered = { ...(live.info.icon && { icon: live.info.icon }), ...(live.info.color && { color: live.info.color }), status: live.status, nodes: live.nodes.length };
        const pluginKey = installedId(plugin.name, m);
        return detail.flows.map((flow) => {
          const template = templates.find((t) => t.origin?.installedId === pluginKey && t.origin.path === flow.path);
          return { ...flow, marketplace: ref, plugin: plugin.name, ...(plugin.displayName && { pluginDisplayName: plugin.displayName }), pluginInstalled: plugin.installed, ...(template && { templateId: template.id }) };
        });
      });
      result.flows.push(...flows.flat());
    }
    result.categories = [...new Set(result.plugins.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort();
    return result;
  },

  /**
   * A plugin for kagent's Claude Code runtime (docs/a2a.md, "Claude Code plugins"): `<plugin>@<marketplace>` as its GitHub
   * repository pinned to the commit it is at now, so every sandbox loads the same files. Claude Code loads the plugin whole,
   * and kagent needs its `.claude-plugin/plugin.json` to do that.
   */
  async claudePlugin(id: string): Promise<KagentPlugin> {
    const at = id.lastIndexOf('@');
    const name = id.slice(0, at);
    const market = id.slice(at + 1);
    const named = () => marketplaceStore.marketplaces().find((x) => marketplaceName(x) === market);
    let m = named();
    if (!m) {
      // A marketplace not fetched yet (the built-in Anthropic one, until Explore opens) has no name to match: fetch it.
      for (const unread of marketplaceStore.marketplaces().filter((x) => !x.name)) await this.catalog(unread.id).catch(() => undefined);
      m = named();
    }
    if (at <= 0 || !m) throw new MarketplaceError(`The plugin ${id} is in no added marketplace: add “${market}” on the Marketplace page`, 404);
    const detail = await this.detail(m.id, name);
    if (detail.source.kind !== 'github') throw new MarketplaceError(`The plugin ${id} is on this host, and kagent fetches plugins from git: use one from a GitHub marketplace`, 422);
    if (!detail.claudeManifest) throw new MarketplaceError(`The plugin ${id} has no .claude-plugin/plugin.json, which kagent needs to give it to Claude Code`, 422);
    const pinned = await pinnedSource(detail.source);
    const commit = pinned.kind === 'github' ? (pinned.sha ?? (/^[0-9a-f]{40}$/i.test(pinned.ref) ? pinned.ref : undefined)) : undefined;
    if (pinned.kind !== 'github' || !commit) throw new MarketplaceError(`The plugin ${id} couldn’t be pinned to a commit: GitHub didn’t answer`, 502);
    return { id, url: `https://github.com/${pinned.owner}/${pinned.repo}.git`, commit: commit.toLowerCase(), ...(pinned.path && { path: pinned.path }) };
  },

  /** Read a plugin's files: what it contains and what Landflow would create from it. */
  async detail(id: string, name: string, fresh = false): Promise<PluginDetail> {
    const key = `${id}:${name}`;
    const cached = details.get(key);
    if (!fresh && cached && Date.now() - cached.at < DETAIL_TTL_MS) return withNeeds({ ...cached.detail, plugin: { ...cached.detail.plugin, installed: Boolean(marketplaceStore.installedOne(installedId(name, getMarketplace(id)))) } });
    const catalog = await this.catalog(id);
    const plugin = catalog.plugins.find((p) => p.name === name);
    const m = getMarketplace(id);
    const entry = m.entries?.find((e) => e.name === name);
    if (!plugin || !entry) throw new MarketplaceError(`No plugin “${name}” in this marketplace`, 404);
    const source = refusing(422, () => resolveSource(entry.source, m.location, m.pluginRoot));
    if (source.kind === 'unsupported') throw new MarketplaceError(`Can’t install “${name}”: ${source.reason}`, 422);
    const fromRoot = typeof entry.source === 'string' && (entry.source === '.' || entry.source === './');
    const loaded = await traceMarketplace('detail', { 'landflow.marketplace.id': id, 'landflow.marketplace.plugin': name }, () => loadPlugin(readerFor(source), entry, fromRoot).catch((caught) => Promise.reject(pluginReadError(caught))));
    const flows = loaded.flows.map((flow) => ({ ...flow, needs: [], link: flowLink(marketplaceName(m), name, flow.path, shareSource(m.location)) }));
    const detail: PluginDetail = { marketplaceId: id, plugin, source, ...loaded, flows };
    details.set(key, { at: Date.now(), detail });
    return withNeeds(detail);
  },

  /** One flow of a plugin for its share page, read only. `ref` is the marketplace's id or name; `path` the file in the plugin. */
  async flow(ref: string, name: string, path: string): Promise<MarketplaceFlowView> {
    const m = marketplaceStore.marketplace(ref) ?? marketplaceStore.marketplaces().find((x) => x.name === ref);
    if (!m) throw new MarketplaceError(`The marketplace “${ref}” isn’t added on this instance`, 404, { missing: 'marketplace' });
    const detail = await this.detail(m.id, name);
    const flow = detail.flows.find((f) => f.path === path);
    if (!flow) throw new MarketplaceError(`No flow “${path}” in ${name}`, 404);
    let file;
    try {
      file = await readFlow(readerFor(detail.source), path);
    } catch (error) {
      if (error instanceof FetchError) throw error;
      const missing = pluginReadError(error);
      if (missing !== error) throw missing;
      // Not JSON, or not a template file: the flow's fault.
      throw new MarketplaceError(`${path}: ${(error as Error).message}`, 422);
    }
    const pluginKey = installedId(name, m);
    const template = localTemplates.list().find((t) => t.origin?.installedId === pluginKey && t.origin.path === path);
    const { id, name: marketplaceTitle, description, owner, location } = summarize(m);
    return {
      marketplace: { id, name: marketplaceTitle, ...(description && { description }), ...(owner && { owner }), location },
      plugin: detail.plugin,
      flow,
      template: previewTemplate(file),
      flows: detail.flows.map((f) => ({ path: f.path, name: f.name })),
      ...(template && { templateId: template.id }),
      link: flowLink(marketplaceName(m), name, path, shareSource(location)),
    };
  },

  async install(id: string, name: string, options: { confirm?: boolean } = {}): Promise<InstallResult | InstallConfirmation> {
    const m = getMarketplace(id);
    const pluginKey = installedId(name, m);
    if (marketplaceStore.installedOne(pluginKey)) throw new MarketplaceError(`${pluginKey} is already installed`, 409);
    const detail = await this.detail(id, name, true);
    const { nodePlugin } = detail;
    if (!detail.agents.length && !detail.skills.length && !nodePlugin && !detail.flows.length) {
      const parts = detail.unsupported.map((u) => `${u.kind} (${u.items.length})`).join(', ');
      throw new MarketplaceError(`Nothing in “${name}” runs in Landflow yet${parts ? `: it only has ${parts}` : ''}`, 422, { unsupported: detail.unsupported });
    }
    const repository = sourceLabel(detail.source, undefined);
    if (nodePlugin && !options.confirm) {
      return {
        needsConfirmation: true,
        plugin: name,
        repository,
        ...(nodePlugin.install && { install: commandLine(nodePlugin.install) }),
        command: commandLine(nodePlugin.start),
        warning: `Installing “${name}” downloads code from ${repository} and runs it on this machine as the host’s user. Only install plugins you trust.`,
      };
    }

    return traceMarketplace('install', { 'landflow.marketplace.id': id, 'landflow.marketplace.plugin': name, 'landflow.marketplace.node_plugin': Boolean(nodePlugin) }, async () => {
      const createdAgents: Array<{ id: string; name: string }> = [];
      const createdFrom: Array<{ file: ClaudeAgentFile; id: string }> = [];
      const createdTeams: Array<{ id: string; name: string }> = [];
      const createdSkills: LibrarySkill[] = [];
      const createdTemplates: Array<{ id: string; name: string }> = [];
      const pluginDir = nodePlugin ? join(marketplaceStore.dir, 'plugins', name.replace(/[^\w.-]/g, '_')) : undefined;
      const logFile = join(marketplaceStore.dir, 'logs', `${name.replace(/[^\w.-]/g, '_')}.log`);
      try {
        let nodeRecord: InstalledPlugin['nodePlugin'];
        if (nodePlugin && pluginDir) {
          // The riskiest step first, so a failure leaves nothing else behind. A branch or tag is pinned to its commit, so
          // queue mode's other processes download the very same files.
          const downloadSource = await pinnedSource(detail.source);
          await downloadPlugin(readerFor(downloadSource), pluginDir);
          const hash = contentHash(pluginDir);
          const revision = `rev_${nanoid(10)}`;
          const spec = { key: pluginKey, pluginId: nodePlugin.id, dir: pluginDir, manifest: nodePlugin, revision };
          await nodePlugins.prepare(spec, logFile);
          writeInstallMarker(pluginDir, { key: pluginKey, revision, contentHash: hash });
          const taken = new Set([...nodePlugins.ports(), ...marketplaceStore.installed().flatMap((p) => (p.nodePlugin ? [p.nodePlugin.port, p.nodePlugin.grpcPort ?? 0] : []))]);
          const port = await freePort(taken);
          const grpcPort = nodePlugin.transports?.includes('grpc') ? await freePort(new Set([...taken, port])) : undefined;
          const started: SupervisedPlugin = { ...spec, port, ...(grpcPort && { grpcPort }), ...(clusterActive() && { announce: false }) };
          nodePlugins.start(started, logFile);
          if (clusterActive()) void registerLocal(started);
          nodeRecord = {
            pluginId: nodePlugin.id,
            dir: pluginDir,
            command: commandLine(nodePlugin.start),
            manifest: nodePlugin,
            port,
            ...(grpcPort && { grpcPort }),
            revision,
            contentHash: hash,
            ...(downloadSource !== detail.source && { source: downloadSource }),
          };
        }
        const source = { plugin: name, marketplace: marketplaceName(m), installedId: pluginKey };
        const at = new Date().toISOString();
        for (const skill of detail.skills) createdSkills.push({ ...skillFromClaude(skill), source, installedAt: at });
        marketplaceStore.addSkills(createdSkills);
        for (const agent of detail.agents) {
          // Each agent gets its own copies of the plugin's skills.
          const team = detail.plugin.displayName ?? titleCase(name);
          const created = agentStore.create(agentFromClaude(agent, { pluginId: pluginKey, skills: detail.skills.map(skillFromClaude), team }));
          createdAgents.push({ id: created.id, name: created.name });
          createdFrom.push({ file: agent, id: created.id });
        }
        linkExported(createdFrom, detail.landflowTeam, createdTeams);
        if (detail.flows.length) {
          // Read again rather than trust the cached detail: the files are what gets installed.
          const entry = m.entries?.find((e) => e.name === name);
          const fromRoot = typeof entry?.source === 'string' && (entry.source === '.' || entry.source === './');
          const { flows } = await loadFlows(readerFor(detail.source), entry ?? { name }, fromRoot);
          for (const flow of flows) {
            const origin = { kind: 'marketplace' as const, installedId: pluginKey, plugin: name, marketplace: marketplaceName(m), path: flow.path };
            const template = importTemplate(flow.file, pluginKey, undefined, undefined, origin);
            createdTemplates.push({ id: template.id, name: template.name });
          }
        }
        const installed: InstalledPlugin = {
          id: pluginKey,
          plugin: name,
          marketplaceId: id,
          marketplaceName: marketplaceName(m),
          ...(typeof detail.manifest.version === 'string' && { version: detail.manifest.version }),
          ...(detail.plugin.description && { description: detail.plugin.description }),
          source: detail.source,
          installedAt: at,
          agents: createdAgents,
          skills: createdSkills.map((s) => ({ id: s.id, name: s.name })),
          ...(createdTemplates.length && { templates: createdTemplates }),
          ...(createdTeams.length && { teams: createdTeams }),
          unsupported: detail.unsupported,
          ...(nodeRecord && { nodePlugin: nodeRecord }),
        };
        marketplaceStore.saveInstalled(installed);
        if (nodeRecord) announceNodePlugins();
        logger.info('marketplace plugin installed', {
          'landflow.marketplace.plugin': pluginKey,
          'landflow.marketplace.agents': createdAgents.length,
          'landflow.marketplace.skills': createdSkills.length,
          'landflow.marketplace.flows': createdTemplates.length,
          'landflow.marketplace.node_plugin': nodeRecord?.pluginId ?? 'none',
        });
        return { installed: withStatus(installed), notSupported: detail.unsupported, warnings: detail.warnings };
      } catch (error) {
        // Roll back whatever was created.
        for (const agent of createdAgents) agentStore.delete(agent.id);
        for (const team of createdTeams) agentTeamStore.delete(team.id);
        marketplaceStore.removeSkills(createdSkills.map((s) => s.id));
        for (const template of createdTemplates) localTemplates.delete(template.id);
        if (pluginDir) {
          await stopOne(pluginKey);
          rmSync(pluginDir, { recursive: true, force: true });
        }
        throw error;
      }
    });
  },

  async uninstall(pluginKey: string) {
    const installed = marketplaceStore.installedOne(pluginKey);
    if (!installed) throw new MarketplaceError('Plugin not installed', 404);
    return traceMarketplace('uninstall', { 'landflow.marketplace.plugin': pluginKey }, async () => {
      if (installed.nodePlugin) {
        await stopOne(pluginKey);
        rmSync(installed.nodePlugin.dir, { recursive: true, force: true });
      }
      const agents = installed.agents.filter((a) => agentStore.delete(a.id)).length;
      for (const team of installed.teams ?? []) agentTeamStore.delete(team.id);
      marketplaceStore.removeSkills(installed.skills.map((s) => s.id));
      // The plugin's flows; workflows made from them stay (they are the users' now).
      const templates = (installed.templates ?? []).filter((t) => localTemplates.delete(t.id)).length;
      marketplaceStore.removeInstalled(pluginKey);
      if (installed.nodePlugin) announceNodePlugins();
      logger.info('marketplace plugin uninstalled', { 'landflow.marketplace.plugin': pluginKey, 'landflow.marketplace.agents': agents, 'landflow.marketplace.flows': templates });
      return { removed: { agents, skills: installed.skills.length, nodePlugin: Boolean(installed.nodePlugin), ...(installed.templates?.length && { flows: templates }) } };
    });
  },

  installed(): InstalledPlugin[] {
    return marketplaceStore.installed().map(withStatus);
  },

  logs(pluginKey: string): string[] {
    const installed = marketplaceStore.installedOne(pluginKey);
    if (!installed?.nodePlugin) throw new MarketplaceError('Not a node plugin', 404);
    return nodePlugins.logs(pluginKey, join(marketplaceStore.dir, 'logs', `${installed.plugin.replace(/[^\w.-]/g, '_')}.log`));
  },

  async restart(pluginKey: string) {
    const installed = marketplaceStore.installedOne(pluginKey);
    if (!installed?.nodePlugin) throw new MarketplaceError('Not a node plugin', 404);
    const running = clusterActive() ? nodePlugins.specs().find((spec) => spec.key === pluginKey) : undefined;
    await nodePlugins.stop(pluginKey);
    if (running) {
      // Queue mode: this process's copy, where it ran (its directory and ports).
      nodePlugins.start(running, logFileOf(installed));
      void registerLocal(running);
    } else startOne(installed);
    return withStatus(installed);
  },

  skills(): LibrarySkill[] {
    return marketplaceStore.skills();
  },

  /** Start every installed node plugin (host startup). Queue mode: startClusterSync() does it, in every main and worker. */
  startNodePlugins() {
    if (clusterActive()) return;
    for (const installed of marketplaceStore.installed()) if (installed.nodePlugin) startOne(installed);
  },

  syncNodePlugins: () => syncNodePlugins(),

  /**
   * Queue mode, every main and worker: run the installed node plugins now, and again when an install, update or
   * removal happens (the `marketplace` control message, or the installed list changing in the database), and every
   * minute. Returns what stops it.
   */
  startClusterSync(): () => void {
    let timer: NodeJS.Timeout | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void syncNodePlugins(), 250);
      timer.unref?.();
    };
    const stopListening = onConfigChanged(['config_files'], soon);
    const every = setInterval(() => void syncNodePlugins(), 60_000);
    every.unref?.();
    void syncNodePlugins();
    return () => {
      stopListening();
      clearTimeout(timer);
      clearInterval(every);
    };
  },
};

const logFileOf = (installed: InstalledPlugin) => join(marketplaceStore.dir, 'logs', `${installed.plugin.replace(/[^\w.-]/g, '_')}.log`);

/**
 * A GitHub branch or tag pinned to the commit it points at now (one API call), so every process downloads the same
 * files; anything else (a commit already, a local directory, the API unreachable) as it is.
 */
async function pinnedSource(source: ResolvedSource): Promise<ResolvedSource> {
  if (source.kind !== 'github' || source.sha || /^[0-9a-f]{40}$/i.test(source.ref)) return source;
  try {
    const { body } = await fetchLimited(`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`, { accept: 'application/vnd.github.sha', maxBytes: 1024 });
    const sha = body.toString('utf8').trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? { ...source, ref: sha, sha } : source;
  } catch {
    return source;
  }
}

/** Queue mode: tell the other processes the installed node plugins changed (they sync theirs). */
function announceNodePlugins() {
  if (!clusterActive()) return;
  void clusterState().relay?.broadcast('control', { t: 'marketplace' });
}

/** Queue mode: the endpoints of this process's copy of a plugin, on loopback. */
const localEndpoints = (spec: Pick<SupervisedPlugin, 'port' | 'grpcPort'>) => [`http://127.0.0.1:${spec.port}`, ...(spec.grpcPort ? [`grpc://127.0.0.1:${spec.grpcPort}`] : [])];

/**
 * Queue mode: register this process's copy in its own registry once it answers (it doesn't announce), as a local
 * endpoint that is never shared through `plugin_registrations`. Retried with backoff while it starts.
 */
async function registerLocal(spec: SupervisedPlugin, attempts = 30): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const running = nodePlugins.specs().find((current) => current.key === spec.key);
    if (!running || running.port !== spec.port || running.revision !== spec.revision) return false;
    const results = await Promise.allSettled(localEndpoints(spec).map((endpoint) => registry.addEndpoint(endpoint, 'static', undefined, { local: true })));
    if (results.every((result) => result.status === 'fulfilled')) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 250 * 2 ** attempt)).unref?.());
  }
  logger.warn('marketplace plugin did not answer; not registered here', { 'landflow.plugin.id': spec.pluginId, 'landflow.plugin.port': spec.port });
  return false;
}

/** Stop this process's copy; queue mode also drops its local endpoints from the registry. */
async function stopOne(key: string) {
  const running = nodePlugins.specs().find((spec) => spec.key === key);
  await nodePlugins.stop(key);
  if (running && running.announce === false) for (const endpoint of localEndpoints(running)) registry.removeEndpoint(endpoint);
}

/** The sync guard, shared by every module graph: a second graph's sync must wait for (and re-run after) the first. */
const syncGuard = () => singleton('marketplace-sync', () => ({ running: undefined as Promise<void> | undefined, again: false }));

/**
 * Queue mode: make this process run exactly the installed node plugins. A plugin is started from its directory when this
 * process can see it with the same install in it (a shared data directory), else downloaded again from the same source
 * into a directory of this process, checked against the install's content hash and prepared; it runs on its recorded
 * port (another free one if taken here) without announcing, and is registered locally. Plugins no longer installed, or
 * replaced by another install (an update), are stopped.
 */
async function syncNodePlugins(): Promise<void> {
  const guard = syncGuard();
  if (guard.running) {
    guard.again = true;
    return guard.running;
  }
  guard.running = (async () => {
    do {
      guard.again = false;
      await syncOnce().catch((error: Error) => logger.warn('marketplace: syncing node plugins failed', { error: error.message }));
    } while (guard.again);
  })().finally(() => (guard.running = undefined));
  return guard.running;
}

async function syncOnce() {
  const wanted = new Map(marketplaceStore.installed().flatMap((installed) => (installed.nodePlugin ? [[installed.id, installed] as const] : [])));
  for (const spec of nodePlugins.specs()) {
    const installed = wanted.get(spec.key);
    const revision = installed?.nodePlugin?.revision ?? installed?.installedAt;
    if (installed && spec.revision === revision) continue;
    logger.info(installed ? 'marketplace plugin updated elsewhere; restarting it here' : 'marketplace plugin uninstalled elsewhere; stopping it here', { 'landflow.marketplace.plugin': spec.key });
    await stopOne(spec.key);
    // Only a copy this process downloaded for itself (the installed directory is the installing main's to remove).
    if (!installed && spec.dir.startsWith(instanceDir() + sep)) rmSync(spec.dir, { recursive: true, force: true });
  }
  const running = new Map(nodePlugins.specs().map((spec) => [spec.key, spec]));
  for (const installed of wanted.values()) {
    const spec = running.get(installed.id);
    if (spec) {
      // Running: make sure this process's registry has it (a registration that timed out is tried again).
      if (spec.announce === false && localEndpoints(spec).some((endpoint) => !registry.endpointInfo(endpoint))) void registerLocal(spec, 1);
      continue;
    }
    try {
      await startHere(installed);
    } catch (error) {
      logger.warn('marketplace plugin could not start here', { 'landflow.marketplace.plugin': installed.id, error: (error as Error).message });
    }
  }
}

/** Where this process keeps the plugins it downloaded itself (queue mode without a shared data directory). */
const instanceDir = () => join(marketplaceStore.dir, 'instances', clusterState().config.instanceId);

/** Queue mode: start this process's copy of an installed plugin (downloading it when this process can't see its files). */
async function startHere(installed: InstalledPlugin) {
  const record = installed.nodePlugin!;
  const revision = record.revision ?? installed.installedAt;
  // Each process logs its own copy.
  const logFile = join(marketplaceStore.dir, 'logs', `${installed.plugin.replace(/[^\w.-]/g, '_')}.${clusterState().config.instanceId}.log`);
  const matches = (dir: string) => {
    const marker = readInstallMarker(dir);
    return Boolean(marker && marker.revision === revision && (!record.contentHash || marker.contentHash === record.contentHash));
  };
  let dir = record.dir;
  if (!existsSync(/*turbopackIgnore: true*/ dir) || !matches(dir)) {
    dir = join(instanceDir(), installed.plugin.replace(/[^\w.-]/g, '_'));
    if (!matches(dir)) {
      await downloadPlugin(readerFor(record.source ?? installed.source), dir);
      const hash = contentHash(dir);
      if (record.contentHash && hash !== record.contentHash) {
        rmSync(dir, { recursive: true, force: true });
        throw new MarketplaceError(`its source changed since it was installed (${hash.slice(0, 19)}… instead of ${record.contentHash.slice(0, 19)}…): reinstall it`, 409);
      }
      await nodePlugins.prepare({ key: installed.id, pluginId: record.pluginId, dir, manifest: record.manifest }, logFile);
      writeInstallMarker(dir, { key: installed.id, revision, contentHash: hash });
    }
  }
  // The recorded ports when they are free here (other processes on this host may hold them), else others.
  const taken = nodePlugins.ports();
  const port = !taken.has(record.port) && (await portFree(record.port)) ? record.port : await freePort(taken);
  const grpcPort = record.grpcPort
    ? !taken.has(record.grpcPort) && record.grpcPort !== port && (await portFree(record.grpcPort))
      ? record.grpcPort
      : await freePort(new Set([...taken, port]))
    : undefined;
  const spec: SupervisedPlugin = { key: installed.id, pluginId: record.pluginId, dir, manifest: record.manifest, port, ...(grpcPort && { grpcPort }), announce: false, revision };
  nodePlugins.start(spec, logFile);
  logger.info('marketplace plugin started here', { 'landflow.marketplace.plugin': installed.id, 'landflow.plugin.port': port, 'landflow.marketplace.dir': dir });
  void registerLocal(spec);
}

function startOne(installed: InstalledPlugin) {
  const record = installed.nodePlugin!;
  nodePlugins.start(
    { key: installed.id, pluginId: record.pluginId, dir: record.dir, manifest: record.manifest, port: record.port, ...(record.grpcPort && { grpcPort: record.grpcPort }), ...(record.revision && { revision: record.revision }) },
    logFileOf(installed),
  );
}

function withStatus(installed: InstalledPlugin): InstalledPlugin {
  if (!installed.nodePlugin) return installed;
  return { ...installed, nodePlugin: { ...installed.nodePlugin, status: nodePlugins.status(installed.id) ?? { state: 'stopped', restarts: 0, port: installed.nodePlugin.port } } };
}

