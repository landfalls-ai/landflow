/**
 * Landflow agents and teams → a Claude Code plugin (docs/marketplace.md#export-agents-as-plugins): the reverse of
 * `agentFromClaude` (./map.ts). Claude Code reads `.claude-plugin/plugin.json`, `agents/<slug>.md` and
 * `skills/<slug>/SKILL.md`; what only Landflow has (persona parts, tools, avatar, model provider, the team's relations)
 * goes in `.landflow/`, which Claude Code never opens, and the import reads it back.
 */
import type { Agent, AgentConfig, AgentSkill } from '../../shared/agents';
import type { AgentTeamConfig } from '../../shared/agent-teams';
import { LANDFLOW_AGENT_KIND, LANDFLOW_TEAM_KIND, type LandflowAgentData, type LandflowTeamData } from '../../shared/marketplace';
import { personaPrompt } from '../../shared/persona';
import { agentStore, configOf } from '../agents/store';
import { COLORS, MODEL_ALIASES } from './map';
import type { ZipFile } from '../zip';

export type ExportFile = ZipFile & { content: string };

export interface PluginExport {
  /** The plugin's name (a slug): the zip is `<name>.zip`. */
  name: string;
  files: ExportFile[];
}

export interface ExportOptions {
  /** Also write `.claude-plugin/marketplace.json`, so the folder is a one-plugin marketplace. */
  marketplace?: boolean;
  author?: string;
  version?: string;
}

export const slugOf = (text: string, fallback = 'agent') =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || fallback;

/** A YAML double-quoted scalar the frontmatter reader (./frontmatter.ts) and Claude Code both read. */
const quote = (text: string) =>
  `"${text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;

const jsonFile = (path: string, value: unknown): ExportFile => ({ path, content: `${JSON.stringify(value, null, 2)}\n` });

/** Claude Code's alias for a model id (`claude-sonnet-5-5` → `sonnet`), or the id itself; none for other providers. */
export function claudeModel(config: Pick<AgentConfig, 'model'>): string | undefined {
  const model = config.model;
  if (!model || model.provider !== 'anthropic') return undefined;
  const alias = Object.entries(MODEL_ALIASES).find(([name, id]) => name !== 'inherit' && id === model.model)?.[0];
  return alias ?? (/^claude-[a-z0-9.-]+$/.test(model.model) ? model.model : undefined);
}

/** Claude Code's colour name closest to the agent's colour. */
export function claudeColor(hex: string): string | undefined {
  const rgb = (value: string) => /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)?.slice(1).map((h) => parseInt(h, 16));
  const wanted = rgb(hex);
  if (!wanted) return undefined;
  let best: [string, number] | undefined;
  for (const [name, value] of Object.entries(COLORS)) {
    const have = rgb(value)!;
    const distance = have.reduce((sum, c, i) => sum + (c - wanted[i]) ** 2, 0);
    if (!best || distance < best[1]) best = [name, distance];
  }
  return best?.[0];
}

/** The config an export keeps: no schedules or channels (they are bound to this instance's credentials), no credentials. */
export function portableConfig(config: AgentConfig): Partial<AgentConfig> {
  const { schedules: _schedules, channels: _channels, ...rest } = structuredClone(config);
  if (rest.model) delete rest.model.credential;
  rest.tools = rest.tools.map((tool) => {
    const { credentials: _credentials, ...kept } = tool as typeof tool & { credentials?: unknown };
    if ('credential' in kept) delete (kept as { credential?: unknown }).credential;
    if (kept.type === 'knowledge') delete (kept.embeddings as { credential?: unknown }).credential;
    return kept as typeof tool;
  });
  return rest;
}

interface SkillFolder {
  slug: string;
  skill: AgentSkill;
}

function skillFiles(folders: SkillFolder[]): ExportFile[] {
  return folders.flatMap(({ slug, skill }) => {
    const front = [`name: ${slug}`, `description: ${quote(skill.whenToUse)}`, ...(skill.allowedTools?.length ? [`allowed-tools: ${skill.allowedTools.join(', ')}`] : [])];
    return [
      { path: `skills/${slug}/SKILL.md`, content: `---\n${front.join('\n')}\n---\n\n${skill.instructions.trim()}\n` },
      ...(skill.references ?? []).map((ref) => ({ path: `skills/${slug}/references/${ref.name}`, content: ref.content })),
    ];
  });
}

/** The agent file's body: the prompt the agent runs with (persona parts, instructions, skills list), without a run's memory or time. */
export const agentBody = (config: AgentConfig) => personaPrompt(config).trim();

function agentFile(slug: string, config: AgentConfig, sourceId: string | undefined): ExportFile[] {
  const model = claudeModel(config);
  const color = claudeColor(config.color);
  const tools = [...new Set(config.skills.flatMap((s) => s.allowedTools ?? []))];
  const body = agentBody(config);
  const front = [
    `name: ${slug}`,
    `description: ${quote(config.description.trim() || `${config.name}, a Landflow agent.`)}`,
    ...(tools.length ? [`tools: ${tools.join(', ')}`] : []),
    `model: ${model ?? 'inherit'}`,
    ...(color ? [`color: ${color}`] : []),
  ];
  const data: LandflowAgentData = { kind: LANDFLOW_AGENT_KIND, version: 1, ...(sourceId && { sourceId }), config: portableConfig(config), body };
  return [{ path: `agents/${slug}.md`, content: `---\n${front.join('\n')}\n---\n\n${body}\n` }, jsonFile(`.landflow/agents/${slug}.json`, data)];
}

/** The plugin's files for these agents (and the team that relates them). */
function build(name: string, description: string, agents: Array<{ id?: string; config: AgentConfig; slug?: string }>, team: AgentTeamConfig | undefined, options: ExportOptions): PluginExport {
  const author = options.author?.trim() || 'Landflow';
  const version = options.version ?? '1.0.0';
  const taken = new Set<string>();
  const unique = (base: string, used = taken) => {
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    return slug;
  };
  const named = agents.map((a) => ({ ...a, slug: unique(slugOf(a.config.name)) }));
  const skillSlugs = new Set<string>();
  const folders: SkillFolder[] = [];
  const seen = new Map<string, string>();
  for (const { config } of named) {
    for (const skill of config.skills) {
      const key = `${skill.name}\u0000${skill.instructions}`;
      if (seen.has(key)) continue;
      const slug = unique(slugOf(skill.name, 'skill'), skillSlugs);
      seen.set(key, slug);
      folders.push({ slug, skill });
    }
  }
  const files: ExportFile[] = [
    // The lists make the folder read the same when it is a marketplace's root plugin (Landflow then skips the default folders).
    jsonFile('.claude-plugin/plugin.json', {
      name,
      version,
      description,
      author: { name: author },
      keywords: ['landflow', ...(team ? ['team'] : ['agent'])],
      agents: named.map((a) => `./agents/${a.slug}.md`),
      ...(folders.length && { skills: folders.map((f) => `./skills/${f.slug}`) }),
    }),
    ...(options.marketplace ? [jsonFile('.claude-plugin/marketplace.json', { name: `${name}-marketplace`, owner: { name: author }, metadata: { description }, plugins: [{ name, source: './', description, version, category: 'agents' }] })] : []),
    ...named.flatMap((a) => agentFile(a.slug, a.config, a.id)),
    ...skillFiles(folders),
  ];
  if (team) {
    const byAgent = new Map(named.flatMap((a) => (a.id ? [[a.id, a.slug] as const] : [])));
    const members = team.members.map((member) => {
      if (member.kind !== 'agent') {
        const { credentials: _credentials, ...rest } = member;
        return rest as Record<string, unknown>;
      }
      const { agentId, ...rest } = member;
      return { ...rest, ...(byAgent.has(agentId) && { agent: byAgent.get(agentId) }) } as Record<string, unknown>;
    });
    const data: LandflowTeamData = { kind: LANDFLOW_TEAM_KIND, version: 1, team: { name: team.name, ...(team.goal && { goal: team.goal }), ...(team.description && { description: team.description }), members } };
    files.push(jsonFile('.landflow/team.json', data));
  }
  files.push({
    path: 'README.md',
    content: [
      `# ${name}`,
      '',
      description,
      '',
      `Exported from Landflow as a Claude Code plugin. ${team ? 'Its agents are in `agents/`' : 'The agent is in `agents/`'}${folders.length ? ' and its skills in `skills/`' : ''}.`,
      '',
      '`.landflow/` holds what only Landflow uses (persona parts, tools, avatar, model provider' + (team ? ', the team’s relations' : '') + '). Claude Code ignores it; installing the plugin in Landflow restores it.',
      '',
    ].join('\n'),
  });
  return { name, files };
}

/** One agent as a plugin (its draft, as the builder shows it). */
export function exportAgentPlugin(agent: Agent | AgentConfig, options: ExportOptions = {}): PluginExport {
  const config = configOf(agent);
  const id = 'id' in agent ? agent.id : undefined;
  return build(slugOf(config.name), config.description.trim() || `${config.name}, a Landflow agent.`, [{ id, config }], undefined, options);
}

/** A team as a plugin: its Landflow agents' files, the skills they share, and the team's relations. */
export function exportTeamPlugin(team: AgentTeamConfig, options: ExportOptions = {}): PluginExport {
  const ids = [...new Set(team.members.flatMap((m) => (m.kind === 'agent' && m.agentId ? [m.agentId] : [])))];
  const agents = ids.flatMap((id) => {
    const agent = agentStore.get(id);
    return agent ? [{ id, config: configOf(agent) }] : [];
  });
  return build(slugOf(team.name, 'team'), team.goal?.trim() || team.description?.trim() || `${team.name}, a Landflow agent team.`, agents, team, options);
}
