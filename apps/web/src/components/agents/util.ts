'use client';
/** Small helpers shared by the agent pages: ids, setup checks, JSON import/export and SKILL.md parsing. */
import { nanoid } from 'nanoid';
import {
  DEFAULT_AGENT_SETTINGS,
  type Agent,
  type AgentConfig,
  type AgentSchedule,
  type AgentSkill,
  type AgentToolConfig,
  type ModelProvider,
} from '@/lib/shared/agents';

export const newId = (prefix: string) => `${prefix}_${nanoid(8)}`;

export const PROVIDERS: Array<{
  value: ModelProvider;
  label: string;
  credentialType?: string;
  credentialRequired?: boolean;
}> = [
  {
    value: 'anthropic',
    label: 'Anthropic',
    credentialType: 'core.anthropicApi',
  },
  {
    value: 'openai',
    label: 'OpenAI-compatible',
    credentialType: 'core.openAiApi',
    credentialRequired: true,
  },
  { value: 'ollama', label: 'Ollama' },
];

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/** The config part of an agent, in the server's key order: what the draft holds, a version snapshots and Export writes. */
export function configOf(source: Agent | AgentConfig): AgentConfig {
  return {
    name: source.name,
    description: source.description ?? '',
    icon: source.icon || 'bot',
    color: source.color || '#a855f7',
    ...(source.model && { model: source.model }),
    instructions: source.instructions ?? '',
    skills: source.skills ?? [],
    tools: source.tools ?? [],
    schedules: source.schedules ?? [],
    channels: source.channels ?? [],
    memory: { crossSession: Boolean(source.memory?.crossSession) },
    settings: { ...DEFAULT_AGENT_SETTINGS, ...source.settings },
    ...(source.guardrails && ((source.guardrails.input || source.guardrails.output) ? { guardrails: source.guardrails } : {})),
  };
}

/** JSON with sorted keys, so two configs compare equal whatever order their keys were written in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const sameConfig = (a: AgentConfig, b: AgentConfig) => stable(configOf(a)) === stable(configOf(b));

/** The "Finish setup" checklist. */
export function setupSteps(config: AgentConfig) {
  const provider = PROVIDERS.find((p) => p.value === config.model?.provider);
  const model = Boolean(config.model?.model) && (!provider?.credentialRequired || Boolean(config.model?.credential));
  return [
    { key: 'model', label: 'Choose a model', done: model },
    {
      key: 'instructions',
      label: 'Add instructions',
      done: config.instructions.trim().length > 0,
    },
    { key: 'tools', label: 'Add tools', done: config.tools.length > 0 },
  ];
}

/** The test chat needs a model and instructions; tools are optional. */
export const canTest = (config: AgentConfig) =>
  setupSteps(config)
    .filter((s) => s.key !== 'tools')
    .every((s) => s.done);

export function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';

/** An exported agent file: the config itself, or `{ config }` / a whole agent. */
export function parseAgentFile(text: string): Partial<AgentConfig> {
  const data = JSON.parse(text) as Record<string, unknown>;
  const config = (data && typeof data === 'object' && 'config' in data && typeof data.config === 'object' ? data.config : data) as Record<string, unknown>;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Not an agent file');
  if (!('instructions' in config) && !('tools' in config) && !('name' in config)) throw new Error('Not an agent file: no name, instructions or tools');
  const { id: _id, createdAt: _c, updatedAt: _u, published: _p, history: _h, ...rest } = config;
  return rest as Partial<AgentConfig>;
}

/** The name the model sees for a tool. */
export function toolName(tool: AgentToolConfig, agents?: Array<{ id: string; name: string }>): string {
  if (tool.type === 'agent') return agents?.find((a) => a.id === tool.agentId)?.name ?? 'Sub-agent';
  return tool.name;
}

// ---------------------------------------------------------------------------
// SKILL.md
// ---------------------------------------------------------------------------

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/** Agent Skills' SKILL.md: YAML frontmatter (name, description, allowed-tools) and a Markdown body. */
export function parseSkillMarkdown(text: string): Partial<AgentSkill> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { instructions: text.trim() };
  const meta: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (meta[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    listKey = undefined;
    if (pair[2].trim() === '') {
      listKey = pair[1];
      meta[listKey] = [];
    } else meta[pair[1]] = unquote(pair[2]);
  }
  const tools = meta['allowed-tools'] ?? meta.allowedTools;
  const allowedTools = Array.isArray(tools)
    ? tools
    : typeof tools === 'string'
      ? tools
          .replace(/^\[|\]$/g, '')
          .split(/[,\s]+/)
          .map(unquote)
          .filter(Boolean)
      : undefined;
  return {
    ...(typeof meta.name === 'string' && { name: meta.name }),
    ...(typeof meta.description === 'string' && {
      whenToUse: meta.description,
    }),
    ...(allowedTools?.length && { allowedTools }),
    instructions: match[2].trim(),
  };
}

/** A skill folder picked with webkitdirectory: its SKILL.md and the text files under references/. */
export async function readSkillFolder(files: FileList | File[]): Promise<Partial<AgentSkill>> {
  const list = Array.from(files);
  const path = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const skillFile = list.filter((f) => f.name.toLowerCase() === 'skill.md').sort((a, b) => path(a).split('/').length - path(b).split('/').length)[0];
  if (!skillFile) throw new Error('The folder has no SKILL.md');
  const root = path(skillFile).slice(0, -skillFile.name.length);
  const skill = parseSkillMarkdown(await skillFile.text());
  const references: Array<{ name: string; content: string }> = [];
  for (const file of list) {
    const p = path(file);
    if (!p.startsWith(`${root}references/`) || file.size > 512 * 1024) continue;
    const content = await file.text();
    if (content.includes('\u0000')) continue;
    references.push({
      name: p.slice(root.length + 'references/'.length),
      content,
    });
  }
  if (!skill.name) skill.name = root.split('/').filter(Boolean).pop();
  return { ...skill, ...(references.length && { references }) };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const localTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function timezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', localTimezone()];
  }
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

export function describeSchedule(s: AgentSchedule): string {
  const at = s.time ? ` at ${s.time}` : '';
  switch (s.frequency) {
    case 'hourly':
      return `Hourly at :${String(s.time ?? '0').padStart(2, '0')}`;
    case 'daily':
      return `Daily${at}`;
    case 'weekly':
      return `${WEEKDAYS[s.weekday ?? 1]}s${at}`;
    case 'monthly':
      return `Monthly on the ${ordinal(s.dayOfMonth ?? 1)}${at}`;
    case 'cron':
      return `Cron ${s.cron || '—'}`;
  }
}

/** Builder sections change the draft through this, so quick successive edits never overwrite each other. */
export type UpdateConfig = (fn: (config: AgentConfig) => AgentConfig) => void;
