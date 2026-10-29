/**
 * Read one Claude Code plugin (plugin reference: standard layout, manifest component keys, how a
 * marketplace entry combines with plugin.json) into what Landflow can use: agents, skills, a
 * Landflow node-plugin manifest, and the components that don't run here yet.
 */
import type { z } from 'zod';
import type { ClaudeAgentFile, ClaudeSkillFile, MarketplaceFlow, NodePluginManifest, PluginDetail, UnsupportedComponent } from '../../shared/marketplace';
import { fileSchema } from '../templates/schema';
import { asText, parseFrontmatter, stringList } from './frontmatter';
import type { RepoFile, RepoReader } from './reader';
import { joinRelative } from './sources';

const MAX_AGENTS = 50;
const MAX_SKILLS = 100;
const MAX_REFERENCES = 30;
const MAX_REFERENCE_BYTES = 128 * 1024;
const MAX_REFERENCES_TOTAL = 1024 * 1024;
const MAX_FLOWS = 50;
const MAX_FLOW_BYTES = 1024 * 1024;
const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|toml|csv|xml|html?|rst)$/i;

/** A marketplace.json plugin entry, as listed. */
export type MarketplaceEntry = Record<string, unknown> & { name: string; source?: unknown };

type Loaded = Pick<PluginDetail, 'manifest' | 'agents' | 'skills' | 'unsupported' | 'nodePlugin' | 'flows' | 'readme' | 'warnings'>;

/** A flow file a plugin ships, parsed (a Landflow template file). */
export interface FlowFile {
  path: string;
  file: z.infer<typeof fileSchema>;
}

const paths = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

/** `<example>` blocks and their tags make long Claude Code agent descriptions; keep the prose. */
export function plainDescription(text: string): string {
  return text
    .replace(/<example>[\s\S]*?<\/example>/gi, '')
    .replace(/<\/?[a-z][\w-]*>/gi, '')
    .replace(/\s*Examples?:\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAgentFile(path: string, text: string): ClaudeAgentFile {
  const { data, body } = parseFrontmatter(text);
  const fileName = path.split('/').pop()!.replace(/\.md$/i, '');
  return {
    path,
    name: asText(data.name) ?? fileName,
    description: plainDescription(asText(data.description) ?? ''),
    ...(asText(data.model) && { model: asText(data.model) }),
    tools: stringList(data.tools),
    ...(asText(data.color) && { color: asText(data.color) }),
    body,
  };
}

export function parseSkillFile(dir: string, text: string): Omit<ClaudeSkillFile, 'references'> {
  const { data, body } = parseFrontmatter(text);
  return {
    dir,
    name: asText(data.name) ?? (dir.split('/').filter(Boolean).pop() || 'skill'),
    description: plainDescription(asText(data.description) ?? ''),
    body,
    allowedTools: stringList(data['allowed-tools'] ?? data.allowedTools),
  };
}

export function parseNodeManifest(value: unknown): NodePluginManifest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const argv = (x: unknown) => (Array.isArray(x) && x.length && x.every((a) => typeof a === 'string') ? (x as string[]) : undefined);
  const start = argv(v.start);
  const runtime = v.runtime === 'python' || v.runtime === 'go' || v.runtime === 'binary' ? v.runtime : 'node';
  if (typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v.id) || !start) return undefined;
  const install = argv(v.install);
  const transports = Array.isArray(v.transports) ? v.transports.filter((t): t is 'http' | 'grpc' => t === 'http' || t === 'grpc') : undefined;
  const env = v.env && typeof v.env === 'object' ? Object.fromEntries(Object.entries(v.env).filter(([k, x]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof x === 'string')) : undefined;
  return {
    id: v.id,
    ...(typeof v.name === 'string' && { name: v.name }),
    runtime,
    ...(install && { install }),
    start,
    ...(transports?.length && { transports }),
    ...(env && Object.keys(env).length && { env: env as Record<string, string> }),
  };
}

const under = (files: RepoFile[], dir: string) => {
  const prefix = dir ? `${dir.replace(/\/+$/, '')}/` : '';
  return files.filter((f) => f.path.startsWith(prefix));
};

async function readJson(reader: RepoReader, path: string, warnings: string[]): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await reader.text(path)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch (error) {
    warnings.push(`${path}: ${(error as Error).message}`);
    return undefined;
  }
}

/** Server names from `.mcp.json` (either the bare map or `{ mcpServers: {…} }`) or an inline map. */
const serverNames = (value: unknown): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const map = (value as Record<string, unknown>).mcpServers ?? value;
  return map && typeof map === 'object' ? Object.keys(map as object) : [];
};

/** What the plugin page lists for a flow (`needs` is filled in against this instance's nodes by the caller). */
export function flowSummary({ path, file }: FlowFile): MarketplaceFlow {
  const nodes = Array.isArray(file.template.workflow.nodes) ? (file.template.workflow.nodes as Array<{ type?: unknown }>) : [];
  const nodeTypes = [...new Set(nodes.map((n) => n?.type).filter((t): t is string => typeof t === 'string'))];
  return {
    path,
    name: file.template.name,
    description: file.template.description,
    categories: file.template.categories,
    nodeTypes,
    nodeCount: nodes.length,
    credentials: file.template.credentials.filter((c) => !c.optional).map((c) => c.name),
    needs: [],
  };
}

/** One flow file, read and checked (the share page reads just the one it shows). */
export async function readFlow(reader: RepoReader, path: string): Promise<FlowFile['file']> {
  const parsed = fileSchema.safeParse(JSON.parse(await reader.text(path, MAX_FLOW_BYTES)));
  if (!parsed.success) throw new Error(`not a Landflow template file (${parsed.error.issues[0]?.path.join('.') || 'file'}: ${parsed.error.issues[0]?.message})`);
  return parsed.data;
}

/**
 * The flows a plugin ships: `flows/*.json` (not for a plugin at the marketplace root), plus the files or folders
 * plugin.json's or the entry's `flows` lists. Each must be a Landflow template file; others are warnings.
 */
export async function loadFlows(
  reader: RepoReader,
  entry: MarketplaceEntry,
  fromMarketplaceRoot = false,
  known?: { files: RepoFile[]; pluginJson?: Record<string, unknown> },
): Promise<{ flows: FlowFile[]; warnings: string[] }> {
  const warnings: string[] = [];
  const files = known?.files ?? (await reader.list());
  const has = (path: string) => files.some((f) => f.path === path);
  const pluginJson = known ? known.pluginJson : has('.claude-plugin/plugin.json') ? await readJson(reader, '.claude-plugin/plugin.json', warnings) : undefined;
  const json = (dir: string) => under(files, dir).filter((f) => /\.json$/i.test(f.path) && !f.path.slice(dir.length + 1).includes('/'));
  const picked = new Map<string, RepoFile>();
  if (!fromMarketplaceRoot) for (const f of json('flows')) picked.set(f.path, f);
  for (const listed of [...paths(pluginJson?.flows), ...paths(entry.flows)].map((p) => joinRelative('', p))) {
    const file = files.find((f) => f.path === listed);
    const inDir = json(listed);
    if (file) picked.set(file.path, file);
    else if (inDir.length) inDir.forEach((f) => picked.set(f.path, f));
    else warnings.push(`Flow not found: ${listed}`);
  }
  const list = [...picked.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (list.length > MAX_FLOWS) warnings.push(`Only the first ${MAX_FLOWS} of ${list.length} flows are read`);
  const flows: FlowFile[] = [];
  for (const f of list.slice(0, MAX_FLOWS)) {
    if ((f.size ?? 0) > MAX_FLOW_BYTES) {
      warnings.push(`${f.path}: larger than 1 MB, skipped`);
      continue;
    }
    try {
      flows.push({ path: f.path, file: await readFlow(reader, f.path) });
    } catch (error) {
      warnings.push(`${f.path}: ${(error as Error).message}`);
    }
  }
  return { flows, warnings };
}

/**
 * @param fromMarketplaceRoot the entry's source is the marketplace root (`"./"`), where an entry's
 *   `skills` list replaces the default `skills/` scan.
 */
export async function loadPlugin(reader: RepoReader, entry: MarketplaceEntry, fromMarketplaceRoot = false): Promise<Loaded> {
  const warnings: string[] = [];
  const files = await reader.list();
  const has = (path: string) => files.some((f) => f.path === path);
  const pluginJson = has('.claude-plugin/plugin.json') ? await readJson(reader, '.claude-plugin/plugin.json', warnings) : undefined;
  const { source: _source, ...entryFields } = entry;
  const manifest: Record<string, unknown> = { ...(pluginJson ?? {}), ...entryFields, ...(pluginJson?.version !== undefined && { version: pluginJson.version }) };

  // ---- agents: the manifest's list replaces agents/, the entry's adds to it
  const agentPaths = new Set<string>();
  const manifestAgents = paths(pluginJson?.agents);
  if (manifestAgents.length) manifestAgents.forEach((p) => agentPaths.add(joinRelative('', p)));
  else if (!pluginJson && paths(entry.agents).length) paths(entry.agents).forEach((p) => agentPaths.add(joinRelative('', p)));
  else if (!fromMarketplaceRoot) under(files, 'agents').filter((f) => /\.md$/i.test(f.path)).forEach((f) => agentPaths.add(f.path));
  if (pluginJson) paths(entry.agents).forEach((p) => agentPaths.add(joinRelative('', p)));
  const agentList = [...agentPaths].filter((p) => has(p));
  for (const missing of [...agentPaths].filter((p) => !has(p))) warnings.push(`Agent file not found: ${missing}`);
  if (agentList.length > MAX_AGENTS) warnings.push(`Only the first ${MAX_AGENTS} of ${agentList.length} agents are read`);
  const agents = (
    await pool(agentList.slice(0, MAX_AGENTS), 8, async (path) => {
      try {
        return parseAgentFile(path, await reader.text(path));
      } catch (error) {
        warnings.push(`${path}: ${(error as Error).message}`);
        return undefined;
      }
    })
  ).filter((a): a is ClaudeAgentFile => Boolean(a));

  // ---- skills: skills/ plus listed directories; from the marketplace root, only the listed ones
  const skillDirs = new Set<string>();
  const listed = [...paths(pluginJson?.skills), ...paths(entry.skills)].map((p) => joinRelative('', p));
  if (!(fromMarketplaceRoot && paths(entry.skills).length)) {
    for (const f of under(files, 'skills')) {
      const match = /^skills\/([^/]+)\/SKILL\.md$/i.exec(f.path);
      if (match) skillDirs.add(`skills/${match[1]}`);
    }
  }
  for (const dir of listed) {
    if (has(dir ? `${dir}/SKILL.md` : 'SKILL.md')) skillDirs.add(dir);
    else {
      // A listed directory of skills, like "./extra-skills/".
      const nested = under(files, dir).filter((f) => new RegExp(`^${dir ? `${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/` : ''}[^/]+/SKILL\\.md$`, 'i').test(f.path));
      if (nested.length) nested.forEach((f) => skillDirs.add(f.path.replace(/\/SKILL\.md$/i, '')));
      else warnings.push(`Skill not found: ${dir || '.'}/SKILL.md`);
    }
  }
  if (!skillDirs.size && !listed.length && !has('skills') && has('SKILL.md')) skillDirs.add('');
  const skillList = [...skillDirs];
  if (skillList.length > MAX_SKILLS) warnings.push(`Only the first ${MAX_SKILLS} of ${skillList.length} skills are read`);
  const skills = (
    await pool(skillList.slice(0, MAX_SKILLS), 8, async (dir) => {
      const prefix = dir ? `${dir}/` : '';
      try {
        const skill = parseSkillFile(dir, await reader.text(`${prefix}SKILL.md`));
        const refFiles = under(files, `${prefix}references`).filter((f) => TEXT_FILE.test(f.path));
        const references: ClaudeSkillFile['references'] = [];
        let total = 0;
        for (const file of refFiles.slice(0, MAX_REFERENCES)) {
          if ((file.size ?? 0) > MAX_REFERENCE_BYTES || total + (file.size ?? 0) > MAX_REFERENCES_TOTAL) {
            warnings.push(`${skill.name}: skipped large reference ${file.path}`);
            continue;
          }
          const content = await reader.text(file.path, MAX_REFERENCE_BYTES);
          total += content.length;
          references.push({ name: file.path.slice(`${prefix}references/`.length), content });
        }
        if (refFiles.length > MAX_REFERENCES) warnings.push(`${skill.name}: only the first ${MAX_REFERENCES} of ${refFiles.length} references are read`);
        const others = under(files, dir).filter((f) => f.path !== `${prefix}SKILL.md` && !f.path.startsWith(`${prefix}references/`) && !/(^|\/)LICENSE(\.\w+)?$/i.test(f.path));
        // From the marketplace root every file is "under" the skill; only count its own folder.
        if (dir && others.length) warnings.push(`${skill.name}: ${others.length} other file${others.length === 1 ? '' : 's'} (scripts, assets, examples) aren’t used by Landflow`);
        return { ...skill, references };
      } catch (error) {
        warnings.push(`${prefix}SKILL.md: ${(error as Error).message}`);
        return undefined;
      }
    })
  ).filter((s): s is ClaudeSkillFile => Boolean(s));

  // ---- what doesn't run in Landflow yet: listed, never dropped silently
  const unsupported: UnsupportedComponent[] = [];
  const add = (kind: UnsupportedComponent['kind'], items: string[]) => {
    const unique = [...new Set(items)].filter(Boolean);
    if (unique.length) unsupported.push({ kind, items: unique });
  };
  const fileNames = (dir: string, pattern: RegExp) => under(files, dir).filter((f) => pattern.test(f.path)).map((f) => f.path.slice(dir.length + 1));
  const commandPaths = [...paths(pluginJson?.commands), ...paths(entry.commands)];
  const commandMap = [pluginJson?.commands, entry.commands].find((c) => c && typeof c === 'object' && !Array.isArray(c));
  add('commands', [
    ...(commandPaths.length ? commandPaths.map((p) => p.replace(/^\.\//, '')) : fromMarketplaceRoot ? [] : fileNames('commands', /\.md$/i)),
    ...(commandMap ? Object.keys(commandMap) : []),
  ]);
  const hookSources: unknown[] = [pluginJson?.hooks, entry.hooks];
  if (has('hooks/hooks.json')) hookSources.push(await readJson(reader, 'hooks/hooks.json', warnings));
  add(
    'hooks',
    hookSources.flatMap((h) => {
      if (!h) return [];
      if (typeof h === 'string' || Array.isArray(h)) return paths(h).map((p) => p.replace(/^\.\//, ''));
      const events = (h as Record<string, unknown>).hooks ?? h;
      return events && typeof events === 'object' ? Object.keys(events as object) : [];
    }),
  );
  const mcp = [...serverNames(pluginJson?.mcpServers), ...serverNames(entry.mcpServers), ...paths(pluginJson?.mcpServers).map((p) => p.replace(/^\.\//, ''))];
  if (has('.mcp.json')) mcp.push(...serverNames(await readJson(reader, '.mcp.json', warnings)));
  add('mcpServers', mcp);
  const lsp = [...serverNames(pluginJson?.lspServers), ...serverNames(entry.lspServers)];
  if (has('.lsp.json')) lsp.push(...serverNames(await readJson(reader, '.lsp.json', warnings)));
  add('lspServers', lsp);
  if (!fromMarketplaceRoot) {
    add('outputStyles', fileNames('output-styles', /\.md$/i));
    add('bin', fileNames('bin', /./));
    add('workflows', fileNames('workflows', /\.js$/i));
    add('monitors', has('monitors/monitors.json') ? ['monitors.json'] : []);
  }

  // ---- a Landflow node plugin
  let nodePlugin = parseNodeManifest(entry.landflow);
  if (has('landflow.plugin.json')) {
    const file = await readJson(reader, 'landflow.plugin.json', warnings);
    nodePlugin = parseNodeManifest({ ...file, ...(entry.landflow as object | undefined) }) ?? nodePlugin;
    if (!nodePlugin) warnings.push('landflow.plugin.json needs an "id" (lowercase, dashes) and a "start" command (argv array)');
  }

  // ---- flows: Landflow template files, added to Templates on install
  const loadedFlows = await loadFlows(reader, entry, fromMarketplaceRoot, { files, pluginJson });
  warnings.push(...loadedFlows.warnings);
  const flows = loadedFlows.flows.map(flowSummary);

  let readme: string | undefined;
  const readmePath = files.find((f) => /^readme\.md$/i.test(f.path))?.path;
  if (readmePath) readme = await reader.text(readmePath, 64 * 1024).catch(() => undefined);

  return { manifest, agents, skills, unsupported, ...(nodePlugin && { nodePlugin }), flows, ...(readme && { readme }), warnings };
}
