/**
 * Agents, their sessions and cross-session memories: one JSON document each under
 * LANDFLOW_DATA_DIR (agents/, agent-sessions/, agent-memory/), like workflows.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { JsonObject } from '@landflow/protocol';
import {
  DEFAULT_AGENT_SETTINGS,
  type Agent,
  type AgentConfig,
  type AgentSession,
  type AgentSummary,
  type SessionSummary,
} from '../../shared/agents';
import { singleton } from '../singleton';
import { store } from '../store';

const MAX_HISTORY = 20;
const MAX_SESSIONS_PER_AGENT = 200;
const MAX_MEMORIES = 50;

export interface MemoryNote {
  text: string;
  at: string;
}

function atomicWrite(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const safeId = (id: string) => /^[\w-]+$/.test(id);

/** A complete config from partial input: what the builder, import and older files may leave out. */
export function normalizeConfig(input: Partial<AgentConfig>): AgentConfig {
  return {
    name: (input.name ?? '').trim() || 'Untitled agent',
    description: input.description ?? '',
    icon: input.icon || 'bot',
    color: input.color || '#a855f7',
    ...(input.model && { model: input.model }),
    instructions: input.instructions ?? '',
    skills: input.skills ?? [],
    tools: input.tools ?? [],
    schedules: input.schedules ?? [],
    channels: input.channels ?? [],
    memory: { crossSession: Boolean(input.memory?.crossSession) },
    settings: { ...DEFAULT_AGENT_SETTINGS, ...input.settings },
  };
}

/** The config part of an agent: what a version snapshots and Export writes. */
export function configOf(agent: Agent | AgentConfig): AgentConfig {
  return normalizeConfig(agent);
}

const sameConfig = (a: AgentConfig, b: AgentConfig) => JSON.stringify(configOf(a)) === JSON.stringify(configOf(b));

function summarizeSession(session: AgentSession): SessionSummary {
  return {
    id: session.id,
    agentId: session.agentId,
    source: session.source,
    userId: session.userId,
    title: session.title,
    status: session.status,
    version: session.version,
    turns: session.timeline.filter((e) => e.type === 'user').length,
    toolCalls: session.timeline.filter((e) => e.type === 'tool').length,
    usage: session.usage,
    ...(session.traceIds.length && { traceId: session.traceIds.at(-1) }),
    ...(session.parentSessionId && { parentSessionId: session.parentSessionId }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

class AgentStore {
  private readonly agentsDir = join(store.dir, 'agents');
  private readonly sessionsDir = join(store.dir, 'agent-sessions');
  private readonly memoryDir = join(store.dir, 'agent-memory');
  private readonly channelsPath = join(store.dir, 'agent-channels.json');
  private agents = new Map<string, Agent>();
  /** Session summaries per agent, newest first; full sessions are read from disk. */
  private sessions = new Map<string, SessionSummary[]>();

  constructor() {
    for (const dir of [this.agentsDir, this.sessionsDir, this.memoryDir]) mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(this.agentsDir).filter((f) => f.endsWith('.json'))) {
      const agent = readJson<Agent>(join(this.agentsDir, file));
      if (agent) this.agents.set(agent.id, { ...agent, ...normalizeConfig(agent), history: agent.history ?? [] });
    }
    for (const file of readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'))) {
      const session = readJson<AgentSession>(join(this.sessionsDir, file));
      if (!session) continue;
      // A run can't survive a restart: what was running is idle now.
      if (session.status === 'running') session.status = 'idle';
      const list = this.sessions.get(session.agentId) ?? [];
      list.push(summarizeSession(session));
      this.sessions.set(session.agentId, list);
    }
    for (const list of this.sessions.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ---- agents -------------------------------------------------------------

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  summaries(): AgentSummary[] {
    return this.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      color: agent.color,
      ...(agent.model && { model: `${agent.model.provider}/${agent.model.model}` }),
      tools: agent.tools.length,
      skills: agent.skills.length,
      ...(agent.published && { publishedVersion: agent.published.version }),
      draftChanged: agent.published ? !sameConfig(agent, agent.published.config) : false,
      sessions: this.sessions.get(agent.id)?.length ?? 0,
      updatedAt: agent.updatedAt,
    }));
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  create(config: Partial<AgentConfig>): Agent {
    const now = new Date().toISOString();
    const agent: Agent = { id: `ag_${nanoid(10)}`, ...normalizeConfig(config), createdAt: now, updatedAt: now, history: [] };
    return this.write(agent);
  }

  /** Replace the draft. Published versions are untouched. */
  saveDraft(id: string, config: Partial<AgentConfig>): Agent | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    return this.write({ ...agent, ...normalizeConfig({ ...configOf(agent), ...config }), updatedAt: new Date().toISOString() });
  }

  publish(id: string): Agent | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    const version = (agent.published?.version ?? agent.history[0]?.version ?? 0) + 1;
    const published = { version, publishedAt: new Date().toISOString(), config: configOf(agent) };
    const history = [published, ...agent.history].slice(0, MAX_HISTORY);
    return this.write({ ...agent, published, history, updatedAt: published.publishedAt });
  }

  unpublish(id: string): Agent | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    const { published: _published, ...rest } = agent;
    return this.write({ ...rest, updatedAt: new Date().toISOString() });
  }

  delete(id: string): boolean {
    if (!this.agents.delete(id)) return false;
    rmSync(join(this.agentsDir, `${id}.json`), { force: true });
    for (const summary of this.sessions.get(id) ?? []) rmSync(join(this.sessionsDir, `${summary.id}.json`), { force: true });
    this.sessions.delete(id);
    rmSync(join(this.memoryDir, `${id}.json`), { force: true });
    return true;
  }

  private write(agent: Agent): Agent {
    this.agents.set(agent.id, agent);
    atomicWrite(join(this.agentsDir, `${agent.id}.json`), agent);
    return agent;
  }

  // ---- sessions -----------------------------------------------------------

  listSessions(agentId: string, limit = 100): SessionSummary[] {
    return (this.sessions.get(agentId) ?? []).slice(0, limit);
  }

  getSession(id: string): AgentSession | undefined {
    if (!safeId(id)) return undefined;
    return readJson<AgentSession>(join(this.sessionsDir, `${id}.json`));
  }

  /** The newest session of a channel conversation, e.g. one Telegram chat. */
  findConversation(agentId: string, conversationKey: string): AgentSession | undefined {
    for (const summary of this.sessions.get(agentId) ?? []) {
      const session = this.getSession(summary.id);
      if (session?.conversationKey === conversationKey) return session;
    }
    return undefined;
  }

  saveSession(session: AgentSession): AgentSession {
    const saved = { ...session, updatedAt: new Date().toISOString() };
    atomicWrite(join(this.sessionsDir, `${saved.id}.json`), saved);
    const list = (this.sessions.get(saved.agentId) ?? []).filter((s) => s.id !== saved.id);
    list.unshift(summarizeSession(saved));
    for (const stale of list.splice(MAX_SESSIONS_PER_AGENT)) rmSync(join(this.sessionsDir, `${stale.id}.json`), { force: true });
    this.sessions.set(saved.agentId, list);
    return saved;
  }

  deleteSession(agentId: string, id: string): boolean {
    const list = this.sessions.get(agentId) ?? [];
    const index = list.findIndex((s) => s.id === id);
    if (index < 0) return false;
    list.splice(index, 1);
    rmSync(join(this.sessionsDir, `${id}.json`), { force: true });
    return true;
  }

  // ---- cross-session memory ----------------------------------------------

  memories(agentId: string, userId: string): MemoryNote[] {
    return readJson<Record<string, MemoryNote[]>>(join(this.memoryDir, `${agentId}.json`))?.[userId] ?? [];
  }

  remember(agentId: string, userId: string, text: string): MemoryNote[] {
    const path = join(this.memoryDir, `${agentId}.json`);
    const all = readJson<Record<string, MemoryNote[]>>(path) ?? {};
    const notes = (all[userId] ?? []).filter((note) => note.text !== text);
    notes.push({ text, at: new Date().toISOString() });
    all[userId] = notes.slice(-MAX_MEMORIES);
    atomicWrite(path, all);
    return all[userId];
  }

  // ---- channel poll state (e.g. the Telegram update offset) -------------

  channelState(key: string): JsonObject | undefined {
    return readJson<Record<string, JsonObject>>(this.channelsPath)?.[key];
  }

  setChannelState(key: string, state: JsonObject | undefined) {
    const all = readJson<Record<string, JsonObject>>(this.channelsPath) ?? {};
    if (state) all[key] = state;
    else delete all[key];
    atomicWrite(this.channelsPath, all);
  }
}

export const agentStore = singleton('agent-store', () => new AgentStore());
