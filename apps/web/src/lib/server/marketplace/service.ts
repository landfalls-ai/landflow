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
  Catalog,
  CatalogPlugin,
  InstallConfirmation,
  InstalledPlugin,
  InstallResult,
  LibrarySkill,
  MarketplaceLocation,
  MarketplaceSummary,
  PluginDetail,
  ResolvedSource,
} from '../../shared/marketplace';
import { agentStore } from '../agents/store';
import { onConfigChanged } from '../config-store';
import { clusterActive, clusterState } from '../cluster/state';
import { registry } from '../plugins/registry';
import { logger } from '../telemetry';
import { traceMarketplace } from '../telemetry/marketplace';
import { agentFromClaude, skillFromClaude } from './map';
import { commandLine, contentHash, downloadPlugin, freePort, nodePlugins, portFree, readInstallMarker, writeInstallMarker, type SupervisedPlugin } from './node-plugins';
import { loadPlugin, type MarketplaceEntry } from './plugin';
import { clearTreeCache, fetchJson, fetchLimited, readerFor } from './reader';
import { locationLabel, parseMarketplaceInput, resolveSource, sourceLabel } from './sources';
import { marketplaceStore, PRESETS, type StoredMarketplace } from './store';

const MAX_ENTRIES = 2_000;
const DETAIL_TTL_MS = 10 * 60_000;

export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
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

export const marketplace = {
  list(): MarketplaceSummary[] {
    return marketplaceStore.marketplaces().map(summarize);
  },

  presets() {
    return PRESETS.map(({ id, input, label, description }) => ({ id, input, label, description, added: Boolean(marketplaceStore.marketplace(id)) }));
  },

  async add(input: string): Promise<MarketplaceSummary> {
    const location = parseMarketplaceInput(input);
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
      const source = resolveSource(entry.source, m.location, m.pluginRoot);
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
        installed: installed.has(installedId(entry.name, m)),
      };
    });
    const categories = [...new Set(plugins.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort();
    return { marketplace: summarize(m), plugins, categories };
  },

  /** Read a plugin's files: what it contains and what Landflow would create from it. */
  async detail(id: string, name: string, fresh = false): Promise<PluginDetail> {
    const key = `${id}:${name}`;
    const cached = details.get(key);
    if (!fresh && cached && Date.now() - cached.at < DETAIL_TTL_MS) return { ...cached.detail, plugin: { ...cached.detail.plugin, installed: Boolean(marketplaceStore.installedOne(installedId(name, getMarketplace(id)))) } };
    const catalog = await this.catalog(id);
    const plugin = catalog.plugins.find((p) => p.name === name);
    const m = getMarketplace(id);
    const entry = m.entries?.find((e) => e.name === name);
    if (!plugin || !entry) throw new MarketplaceError(`No plugin “${name}” in this marketplace`, 404);
    const source = resolveSource(entry.source, m.location, m.pluginRoot);
    if (source.kind === 'unsupported') throw new MarketplaceError(`Can’t install “${name}”: ${source.reason}`, 422);
    const fromRoot = typeof entry.source === 'string' && (entry.source === '.' || entry.source === './');
    const loaded = await traceMarketplace('detail', { 'landflow.marketplace.id': id, 'landflow.marketplace.plugin': name }, () => loadPlugin(readerFor(source), entry, fromRoot));
    const detail: PluginDetail = { marketplaceId: id, plugin, source, ...loaded };
    details.set(key, { at: Date.now(), detail });
    return detail;
  },

  async install(id: string, name: string, options: { confirm?: boolean } = {}): Promise<InstallResult | InstallConfirmation> {
    const m = getMarketplace(id);
    const pluginKey = installedId(name, m);
    if (marketplaceStore.installedOne(pluginKey)) throw new MarketplaceError(`${pluginKey} is already installed`, 409);
    const detail = await this.detail(id, name, true);
    const { nodePlugin } = detail;
    if (!detail.agents.length && !detail.skills.length && !nodePlugin) {
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
      const createdSkills: LibrarySkill[] = [];
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
          const created = agentStore.create(agentFromClaude(agent, { pluginId: pluginKey, skills: detail.skills.map(skillFromClaude) }));
          createdAgents.push({ id: created.id, name: created.name });
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
          unsupported: detail.unsupported,
          ...(nodeRecord && { nodePlugin: nodeRecord }),
        };
        marketplaceStore.saveInstalled(installed);
        if (nodeRecord) announceNodePlugins();
        logger.info('marketplace plugin installed', {
          'landflow.marketplace.plugin': pluginKey,
          'landflow.marketplace.agents': createdAgents.length,
          'landflow.marketplace.skills': createdSkills.length,
          'landflow.marketplace.node_plugin': nodeRecord?.pluginId ?? 'none',
        });
        return { installed: withStatus(installed), notSupported: detail.unsupported, warnings: detail.warnings };
      } catch (error) {
        // Roll back whatever was created.
        for (const agent of createdAgents) agentStore.delete(agent.id);
        marketplaceStore.removeSkills(createdSkills.map((s) => s.id));
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
      marketplaceStore.removeSkills(installed.skills.map((s) => s.id));
      marketplaceStore.removeInstalled(pluginKey);
      if (installed.nodePlugin) announceNodePlugins();
      logger.info('marketplace plugin uninstalled', { 'landflow.marketplace.plugin': pluginKey, 'landflow.marketplace.agents': agents });
      return { removed: { agents, skills: installed.skills.length, nodePlugin: Boolean(installed.nodePlugin) } };
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

let syncing: Promise<void> | undefined;
let syncAgain = false;

/**
 * Queue mode: make this process run exactly the installed node plugins. A plugin is started from its directory when this
 * process can see it with the same install in it (a shared data directory), else downloaded again from the same source
 * into a directory of this process, checked against the install's content hash and prepared; it runs on its recorded
 * port (another free one if taken here) without announcing, and is registered locally. Plugins no longer installed, or
 * replaced by another install (an update), are stopped.
 */
async function syncNodePlugins(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      syncAgain = false;
      await syncOnce().catch((error: Error) => logger.warn('marketplace: syncing node plugins failed', { error: error.message }));
    } while (syncAgain);
  })().finally(() => (syncing = undefined));
  return syncing;
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
  if (!existsSync(dir) || !matches(dir)) {
    dir = join(instanceDir(), installed.plugin.replace(/[^\w.-]/g, '_'));
    if (!matches(dir)) {
      await downloadPlugin(readerFor(record.source ?? installed.source), dir);
      const hash = contentHash(dir);
      if (record.contentHash && hash !== record.contentHash) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`its source changed since it was installed (${hash.slice(0, 19)}… instead of ${record.contentHash.slice(0, 19)}…): reinstall it`);
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

