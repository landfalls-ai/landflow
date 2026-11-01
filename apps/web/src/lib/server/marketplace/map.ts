/** Claude Code agents and skills → Landflow agent configs and agent skills. */
import { nanoid } from 'nanoid';
import { cleanTeam, type AgentConfig, type AgentModel, type AgentSkill } from '../../shared/agents';
import { cleanAvatar, randomFace } from '../../shared/faces';
import type { ClaudeAgentFile, ClaudeSkillFile, LandflowAgentData } from '../../shared/marketplace';

/** Claude Code's model aliases. `inherit` means "the main conversation's model", Sonnet by default. */
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5',
  inherit: 'claude-sonnet-5-5',
};

export function mapModel(value: string | undefined): AgentModel | undefined {
  const model = value?.trim().toLowerCase();
  if (!model) return undefined;
  if (MODEL_ALIASES[model]) return { provider: 'anthropic', model: MODEL_ALIASES[model] };
  if (/^claude-[a-z0-9.-]+$/.test(model)) return { provider: 'anthropic', model };
  return undefined;
}

export const COLORS: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  purple: '#a855f7',
  magenta: '#d946ef',
  pink: '#ec4899',
};

/** A lucide icon from what the agent does. */
export function pickIcon(text: string): string {
  const t = text.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/secur|vulnerab|threat/, 'shield-check'],
    [/test|qa\b|coverage/, 'flask-conical'],
    [/review|audit|analy[sz]/, 'scan-search'],
    [/architect|design|plan/, 'drafting-compass'],
    [/explor|research|search|investigat/, 'compass'],
    [/doc|writ|comment/, 'file-text'],
    [/debug|bug|error|fail/, 'bug'],
    [/data|sql|database/, 'database'],
    [/deploy|infra|devops|ci\b/, 'rocket'],
    [/code|refactor|simplif|type/, 'code'],
  ];
  return rules.find(([pattern]) => pattern.test(t))?.[1] ?? 'bot';
}

/** The name says the most ("code-explorer"); the description decides when it says nothing. */
const iconFor = (name: string, description: string) => (pickIcon(name) !== 'bot' ? pickIcon(name) : pickIcon(description));

export function titleCase(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function skillFromClaude(skill: ClaudeSkillFile): AgentSkill {
  return {
    id: `sk_${nanoid(8)}`,
    name: skill.name,
    whenToUse: skill.description || `Use for ${titleCase(skill.name).toLowerCase()} tasks.`,
    instructions: skill.body,
    ...(skill.allowedTools.length && { allowedTools: skill.allowedTools }),
    ...(skill.references.length && { references: skill.references }),
  };
}

const MAX_DESCRIPTION = 600;

/**
 * One Claude Code agent as a Landflow agent draft, with the plugin's skills attached. It gets a face seeded by the
 * plugin and its name, and the plugin as its team, so a plugin's agents sit together on the roster.
 */
export function agentFromClaude(agent: ClaudeAgentFile, options: { pluginId: string; skills: AgentSkill[]; team?: string }): Partial<AgentConfig> {
  if (agent.landflow) return agentFromExport(agent, agent.landflow, options);
  const model = mapModel(agent.model);
  let description = agent.description.length > MAX_DESCRIPTION ? `${agent.description.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : agent.description;
  const notes = [`Installed from ${options.pluginId}.`];
  // Claude Code's tools (Read, Bash, Grep…) have no Landflow equivalent to map to automatically.
  if (agent.tools.length) notes.push(`Claude Code tools not mapped: ${agent.tools.join(', ')} — add equivalent tools under Capabilities.`);
  if (agent.model && !model) notes.push(`Model "${agent.model}" isn’t known — choose one.`);
  description = [description, ...notes].filter(Boolean).join('\n\n');
  return {
    name: titleCase(agent.name),
    description,
    icon: iconFor(agent.name, agent.description),
    color: (agent.color && COLORS[agent.color.toLowerCase()]) ?? (agent.color && /^#[0-9a-f]{6}$/i.test(agent.color) ? agent.color : '#a855f7'),
    ...(model && { model }),
    avatar: { kind: 'face', face: randomFace(`${options.pluginId}/${agent.name}`) },
    ...(cleanTeam(options.team) && { team: cleanTeam(options.team) }),
    instructions: agent.body,
    skills: options.skills,
  };
}

/**
 * An agent a Landflow export wrote (`.landflow/agents/<slug>.json`, ./export.ts): the config it kept, so nothing the
 * agent file can't hold is lost. The agent file's body counts as the prompt only if someone edited it since: then it
 * replaces the instructions, and the persona parts (already in the old body) are dropped. Credentials, schedules and
 * channels were never exported; the agent's own `team` label wins over the plugin's.
 */
function agentFromExport(agent: ClaudeAgentFile, data: LandflowAgentData, options: { skills: AgentSkill[]; team?: string }): Partial<AgentConfig> {
  const { config } = data;
  const edited = agent.body.trim() !== data.body.trim();
  const avatar = cleanAvatar(config.avatar);
  const team = cleanTeam(config.team) ?? cleanTeam(options.team);
  return {
    ...config,
    name: config.name || titleCase(agent.name),
    description: config.description ?? agent.description,
    ...(avatar ? { avatar } : { avatar: { kind: 'face' as const, face: randomFace(agent.name) } }),
    ...(team && { team }),
    instructions: edited ? agent.body : (config.instructions ?? agent.body),
    ...(edited && { persona: undefined }),
    skills: config.skills ?? options.skills,
    tools: config.tools ?? [],
  };
}
