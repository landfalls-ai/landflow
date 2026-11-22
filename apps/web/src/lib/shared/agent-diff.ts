/**
 * C23: an agent's config as named fields, and the difference between two published versions (the history sheet's
 * compare, docs/agents.md#version-history-and-restore). Each field is one thing a person sees in the builder: the model,
 * the instructions, one tool by id, one skill, one schedule. Tools, skills, schedules and channels are matched by their
 * `id`, so a renamed tool is one change, not a removal and an addition. Credentials show by name, never by id or data,
 * and the look (icon, color, avatar) is left out. Plain module: no server imports (the sheet runs it in the browser).
 */
import type { FieldChange } from './field-change';
import type { AgentChannel, AgentConfig, AgentSchedule, AgentSkill, AgentToolConfig, CredentialRef } from './agents';

export interface AgentField {
  /** A stable key: `model`, `instructions`, `tool:<id>`. */
  field: string;
  label: string;
  value: string;
}

export interface CredentialNames {
  /** The credential's name now; absent, the name the config saved. */
  credential?: (id: string) => string | undefined;
}

type Names = CredentialNames | undefined;

/** An object's keys sorted, deeply, so two writings of the same parameters read the same. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]));
  return value;
}

const isRef = (value: unknown): value is CredentialRef => Boolean(value) && typeof value === 'object' && typeof (value as CredentialRef).id === 'string' && typeof (value as CredentialRef).name === 'string';

const refName = (ref: CredentialRef, names: Names): string => `“${names?.credential?.(ref.id) ?? ref.name}”`;

/** One value on one line: a string as it is, a credential by name, anything else as sorted JSON. */
function one(value: unknown, names: Names): string {
  if (typeof value === 'string') return value;
  if (isRef(value)) return refName(value, names);
  return JSON.stringify(sorted(scrub(value, names)));
}

/** Credentials inside a value replaced by their names (a credential is `{ id, name }` under a `credential` or `credentials` key). */
function scrub(value: unknown, names: Names): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v, names));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => {
      if ((key === 'credential' || key === 'credentials') && v && typeof v === 'object') {
        if (isRef(v)) return [key, refName(v, names)];
        return [key, Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, r]) => [k, isRef(r) ? refName(r, names) : r]))];
      }
      return [key, scrub(v, names)];
    }),
  );
}

/** An object as `key: value` lines, keys in order, the listed keys left out. */
function lines(object: object, names: Names, skip: string[] = []): string {
  return Object.entries(scrub(object, names) as Record<string, unknown>)
    .filter(([key, value]) => !skip.includes(key) && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(sorted(value))}`)
    .join('\n');
}

function toolLabel(tool: AgentToolConfig): string {
  switch (tool.type) {
    case 'knowledge':
      return `Knowledge base “${tool.name}”`;
    case 'mcp':
      return `MCP server “${tool.name}”`;
    case 'a2a':
      return `Remote agent “${tool.name}”`;
    case 'agent':
      return `Sub-agent ${tool.agentId}`;
    case 'workflow':
      return `Workflow tool “${tool.name}”`;
    default:
      return `Tool “${tool.name}”`;
  }
}

const channelLabel = (channel: AgentChannel): string => `Channel (${channel.type})`;
const scheduleLabel = (schedule: AgentSchedule): string => `Schedule “${schedule.prompt.length > 40 ? `${schedule.prompt.slice(0, 40)}…` : schedule.prompt}”`;
const skillLabel = (skill: AgentSkill): string => `Skill “${skill.name}”`;

/** The model on one line: "ollama · qwen3:8b · temperature 0.2 · key “Prod”". */
function modelLine(model: NonNullable<AgentConfig['model']>, names: Names): string {
  return [model.provider, model.model, model.temperature !== undefined && `temperature ${model.temperature}`, model.baseUrl, model.credential && `key ${refName(model.credential, names)}`].filter(Boolean).join(' · ');
}

/**
 * The config as the fields a person reads it by, in the order the builder shows them: what it is, the model, the
 * instructions, skills, tools (knowledge bases among them), schedules, channels, then limits and the rest.
 */
export function agentFields(config: AgentConfig, names?: CredentialNames): AgentField[] {
  const out: AgentField[] = [];
  const add = (field: string, label: string, value: string | undefined) => {
    if (value !== undefined && value !== '') out.push({ field, label, value });
  };
  add('name', 'Name', config.name);
  add('description', 'Description', config.description);
  add('team', 'Team', config.team);
  if (config.model) add('model', 'Model', modelLine(config.model, names));
  if (config.persona) add('persona', 'Persona', lines(config.persona, names));
  add('instructions', 'Instructions', config.instructions);
  for (const skill of config.skills) add(`skill:${skill.id}`, skillLabel(skill), lines(skill, names, ['id']));
  // A knowledge base's `lastIndex` is the state of its last indexing pass, not something the person configured.
  for (const tool of config.tools) add(`tool:${tool.id}`, toolLabel(tool), lines(tool, names, tool.type === 'knowledge' ? ['id', 'lastIndex'] : ['id']));
  for (const schedule of config.schedules) add(`schedule:${schedule.id}`, scheduleLabel(schedule), lines(schedule, names, ['id']));
  for (const channel of config.channels) add(`channel:${channel.id}`, channelLabel(channel), lines(channel, names, ['id']));
  add('memory', 'Memory', lines(config.memory, names));
  add('settings', 'Limits', lines(config.settings, names));
  for (const [key, label] of [['input', 'Input guardrail'], ['output', 'Output guardrail'], ['toolResult', 'Tool-result guardrail']] as const) {
    const rule = config.guardrails?.[key];
    if (rule) add(`guardrail:${key}`, label, lines(rule, names));
  }
  if (config.router) add('router', 'Router', lines(config.router, names));
  if (config.cache) add('cache', 'Response cache', lines(config.cache, names));
  if (config.access) add('access', 'Tool access', one(config.access, names));
  if (config.plugins?.length) add('plugins', 'Plugins', config.plugins.join('\n'));
  add('projectContext', 'Project context', config.projectContext);
  add('practices', 'Practices', config.practices);
  return out;
}

/**
 * What differs between two configs: a change per field whose value differs (`added` or `removed` when only one side has
 * it), and how many fields are the same. Fields keep the first version's order, new ones after their group.
 */
export function diffAgentConfigs(a: AgentConfig, b: AgentConfig, names?: CredentialNames): { changes: FieldChange[]; unchanged: number } {
  const before = agentFields(a, names);
  const after = agentFields(b, names);
  const was = new Map(before.map((f) => [f.field, f]));
  const now = new Map(after.map((f) => [f.field, f]));
  // The order the builder reads in: the newer version's fields, with the removed ones back where they were.
  const order: string[] = [];
  const seen = new Set<string>();
  const place = (list: AgentField[]) => {
    let anchor = -1;
    for (const f of list) {
      if (!seen.has(f.field)) {
        seen.add(f.field);
        order.splice(anchor + 1, 0, f.field);
      }
      anchor = order.indexOf(f.field);
    }
  };
  place(after);
  place(before);
  const changes: FieldChange[] = [];
  let unchanged = 0;
  for (const key of order) {
    const x = was.get(key);
    const y = now.get(key);
    if (x && y) {
      if (x.value === y.value) unchanged++;
      else changes.push({ field: key, label: y.label, kind: 'changed', before: x.value, after: y.value });
    } else if (y) changes.push({ field: key, label: y.label, kind: 'added', after: y.value });
    else if (x) changes.push({ field: key, label: x.label, kind: 'removed', before: x.value });
  }
  return { changes, unchanged };
}
