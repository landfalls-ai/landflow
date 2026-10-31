/**
 * Agents, their sessions and cross-session memories. Where they live (../config-store.ts, docs/features/engine.md "Queue mode, workers and
 * high availability"):
 *
 * - `files` (the default outside queue mode): one JSON document each under LANDFLOW_DATA_DIR (agents/, agent-sessions/,
 *   agent-memory/), like workflows, held in memory by one process;
 * - `database` (the default in queue mode, or LANDFLOW_CONFIG_STORE=database): the `agent_definitions`, `agent_sessions`
 *   and `agent_memory` tables (migration 1881), read as plain SQL so every main and worker sees the others' writes (Postgres
 *   replication). The first use imports the three directories once (recorded in `meta`; rows written since win) and leaves
 *   the files. A session another process left `running` is shown idle once it has been silent for 30 minutes.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { JsonObject } from '@landflow/protocol';
import {
  cleanPlugins,
  cleanTeam,
  DEFAULT_AGENT_SETTINGS,
  type Agent,
  type AgentConfig,
  type AgentSession,
  type AgentSummary,
  type KagentDeployment,
  type SessionSummary,
} from '../../shared/agents';
import { cleanAvatar } from '../../shared/faces';
import { cleanPersona } from '../../shared/persona';
import { deleteAgentSessionFeedback } from '../chat-feedback';
import { ConfigFile, configStoreKind, importOnce } from '../config-store';
import { database, type Database } from '../db';
import { singleton } from '../singleton';
import { store } from '../store';

/** A `running` session no process has saved for this long is idle again (its process died; files mode resets them at boot). */
const STALE_RUNNING_MS = 30 * 60_000;
const MAX_HISTORY = 20;
const MAX_SESSIONS_PER_AGENT = 200;
const MAX_MEMORIES = 50;

export interface MemoryNote {
  text: string;
  at: string;
}

function atomicWrite(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
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
  const persona = cleanPersona(input.persona);
  const plugins = cleanPlugins(input.plugins);
  const avatar = cleanAvatar(input.avatar);
  const team = cleanTeam(input.team);
  return {
    name: (input.name ?? '').trim() || 'Untitled agent',
    description: input.description ?? '',
    icon: input.icon || 'bot',
    color: input.color || '#a855f7',
    ...(avatar && { avatar }),
    ...(team && { team }),
    ...(input.model && { model: input.model }),
    ...(persona && { persona }),
    instructions: input.instructions ?? '',
    skills: input.skills ?? [],
    tools: input.tools ?? [],
    schedules: input.schedules ?? [],
    channels: input.channels ?? [],
    memory: { crossSession: Boolean(input.memory?.crossSession) },
    settings: { ...DEFAULT_AGENT_SETTINGS, ...input.settings },
    ...(input.guardrails && ((input.guardrails.input || input.guardrails.output) ? { guardrails: input.guardrails } : {})),
    ...(plugins && { plugins }),
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
    ...(session.execution && { execution: session.execution }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/** Where the agents, sessions and memories are kept; the store on top adds what is the same for both. */
interface AgentBackend {
  readonly kind: 'files' | 'database';
  list(): Agent[];
  get(id: string): Agent | undefined;
  write(agent: Agent): void;
  /** The agent, its sessions and its memory. */
  remove(id: string): boolean;
  sessionCount(agentId: string): number;
  listSessions(agentId: string, limit: number): SessionSummary[];
  getSession(id: string): AgentSession | undefined;
  findConversation(agentId: string, conversationKey: string): AgentSession | undefined;
  saveSession(session: AgentSession): void;
  deleteSession(agentId: string, id: string): boolean;
  memories(agentId: string, userId: string): MemoryNote[];
  remember(agentId: string, userId: string, text: string): MemoryNote[];
}

const revive = (agent: Agent): Agent => ({ ...agent, ...normalizeConfig(agent), history: agent.history ?? [] });

/** The files under the data directory, with the agents and session summaries held in memory. */
class FileAgents implements AgentBackend {
  readonly kind = 'files' as const;
  private readonly agentsDir = join(store.dir, 'agents');
  private readonly sessionsDir = join(store.dir, 'agent-sessions');
  private readonly memoryDir = join(store.dir, 'agent-memory');
  private agents = new Map<string, Agent>();
  /** Session summaries per agent, newest first; full sessions are read from disk. */
  private sessions = new Map<string, SessionSummary[]>();

  constructor() {
    for (const dir of [this.agentsDir, this.sessionsDir, this.memoryDir]) mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(this.agentsDir).filter((f) => f.endsWith('.json'))) {
      const agent = readJson<Agent>(join(this.agentsDir, file));
      if (agent) this.agents.set(agent.id, revive(agent));
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

  list(): Agent[] {
    return [...this.agents.values()];
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  write(agent: Agent) {
    this.agents.set(agent.id, agent);
    atomicWrite(join(this.agentsDir, `${agent.id}.json`), agent);
  }

  remove(id: string): boolean {
    if (!this.agents.delete(id)) return false;
    rmSync(join(this.agentsDir, `${id}.json`), { force: true });
    for (const summary of this.sessions.get(id) ?? []) rmSync(join(this.sessionsDir, `${summary.id}.json`), { force: true });
    this.sessions.delete(id);
    rmSync(join(this.memoryDir, `${id}.json`), { force: true });
    return true;
  }

  sessionCount(agentId: string): number {
    return this.sessions.get(agentId)?.length ?? 0;
  }

  listSessions(agentId: string, limit: number): SessionSummary[] {
    return (this.sessions.get(agentId) ?? []).slice(0, limit);
  }

  getSession(id: string): AgentSession | undefined {
    if (!safeId(id)) return undefined;
    return readJson<AgentSession>(join(this.sessionsDir, `${id}.json`));
  }

  findConversation(agentId: string, conversationKey: string): AgentSession | undefined {
    for (const summary of this.sessions.get(agentId) ?? []) {
      const session = this.getSession(summary.id);
      if (session?.conversationKey === conversationKey) return session;
    }
    return undefined;
  }

  saveSession(saved: AgentSession) {
    atomicWrite(join(this.sessionsDir, `${saved.id}.json`), saved);
    const list = (this.sessions.get(saved.agentId) ?? []).filter((s) => s.id !== saved.id);
    list.unshift(summarizeSession(saved));
    for (const stale of list.splice(MAX_SESSIONS_PER_AGENT)) rmSync(join(this.sessionsDir, `${stale.id}.json`), { force: true });
    this.sessions.set(saved.agentId, list);
  }

  deleteSession(agentId: string, id: string): boolean {
    const list = this.sessions.get(agentId) ?? [];
    const index = list.findIndex((s) => s.id === id);
    if (index < 0) return false;
    list.splice(index, 1);
    rmSync(join(this.sessionsDir, `${id}.json`), { force: true });
    return true;
  }

  memories(agentId: string, userId: string): MemoryNote[] {
    return readJson<Record<string, MemoryNote[]>>(join(this.memoryDir, `${agentId}.json`))?.[userId] ?? [];
  }

  remember(agentId: string, userId: string, text: string): MemoryNote[] {
    const path = join(this.memoryDir, `${agentId}.json`);
    const all = readJson<Record<string, MemoryNote[]>>(path) ?? {};
    all[userId] = withNote(all[userId] ?? [], text);
    atomicWrite(path, all);
    return all[userId];
  }
}

const withNote = (notes: MemoryNote[], text: string): MemoryNote[] => [...notes.filter((note) => note.text !== text), { text, at: new Date().toISOString() }].slice(-MAX_MEMORIES);

interface SessionRow {
  id: string;
  agent_id: string;
  conversation_key: string | null;
  updated_at: string;
  summary: string;
  data: string;
}

/** The tables of migration 1881; the data directory's files are imported once. */
class DatabaseAgents implements AgentBackend {
  readonly kind = 'database' as const;

  constructor(
    private readonly dir: string,
    private readonly db: () => Database = database,
  ) {}

  /** Opened (and the files imported, once per database) on first use: in Postgres mode the database opens after this module loads. */
  private get sql(): Database {
    const db = this.db();
    importOnce(db, 'agents', () => {
      for (const file of safeList(join(this.dir, 'agents'))) {
        const agent = readJson<Agent>(join(this.dir, 'agents', file));
        if (agent?.id) db.insertNew('agent_definitions', definitionRow(revive(agent)));
      }
    });
    importOnce(db, 'agent-sessions', () => {
      for (const file of safeList(join(this.dir, 'agent-sessions'))) {
        const session = readJson<AgentSession>(join(this.dir, 'agent-sessions', file));
        if (!session?.id || !session.agentId) continue;
        if (session.status === 'running') session.status = 'idle';
        db.insertNew('agent_sessions', sessionRow(session));
      }
    });
    importOnce(db, 'agent-memory', () => {
      for (const file of safeList(join(this.dir, 'agent-memory'))) {
        const all = readJson<Record<string, MemoryNote[]>>(join(this.dir, 'agent-memory', file)) ?? {};
        const agentId = file.replace(/\.json$/, '');
        for (const [userId, notes] of Object.entries(all)) {
          if (Array.isArray(notes)) db.insertNew('agent_memory', { agent_id: agentId, user_id: userId, data: JSON.stringify(notes), updated_at: new Date().toISOString() });
        }
      }
    });
    return db;
  }

  list(): Agent[] {
    return this.sql.all<{ data: string }>('SELECT data FROM agent_definitions').flatMap((row) => parsed<Agent>(row.data) ?? []).map(revive);
  }

  get(id: string): Agent | undefined {
    const agent = parsed<Agent>(this.sql.get<{ data: string }>('SELECT data FROM agent_definitions WHERE id = ?', id)?.data);
    return agent && revive(agent);
  }

  write(agent: Agent) {
    this.sql.upsert('agent_definitions', definitionRow(agent));
  }

  remove(id: string): boolean {
    const db = this.sql;
    return db.transaction(() => {
      db.delete('agent_sessions', { agent_id: id });
      db.delete('agent_memory', { agent_id: id });
      return db.delete('agent_definitions', { id }) > 0;
    });
  }

  sessionCount(agentId: string): number {
    return Number(this.sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_sessions WHERE agent_id = ?', agentId)?.n ?? 0);
  }

  listSessions(agentId: string, limit: number): SessionSummary[] {
    return this.sql
      .all<{ summary: string }>('SELECT summary FROM agent_sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?', agentId, Math.max(1, Math.floor(limit)))
      .flatMap((row) => parsed<SessionSummary>(row.summary) ?? [])
      .map(settleStale);
  }

  getSession(id: string): AgentSession | undefined {
    if (!safeId(id)) return undefined;
    const session = parsed<AgentSession>(this.sql.get<{ data: string }>('SELECT data FROM agent_sessions WHERE id = ?', id)?.data);
    return session && settleStale(session);
  }

  findConversation(agentId: string, conversationKey: string): AgentSession | undefined {
    const row = this.sql.get<SessionRow>('SELECT data FROM agent_sessions WHERE agent_id = ? AND conversation_key = ? ORDER BY updated_at DESC LIMIT 1', agentId, conversationKey);
    const session = parsed<AgentSession>(row?.data);
    return session && settleStale(session);
  }

  saveSession(saved: AgentSession) {
    const db = this.sql;
    db.transaction(() => {
      db.upsert('agent_sessions', sessionRow(saved));
      const stale = db.all<{ id: string }>('SELECT id FROM agent_sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?', saved.agentId, MAX_SESSIONS_PER_AGENT);
      for (const { id } of stale) db.delete('agent_sessions', { id });
    });
  }

  deleteSession(agentId: string, id: string): boolean {
    if (!this.sql.get('SELECT id FROM agent_sessions WHERE id = ? AND agent_id = ?', id, agentId)) return false;
    return this.sql.delete('agent_sessions', { id }) > 0;
  }

  memories(agentId: string, userId: string): MemoryNote[] {
    return parsed<MemoryNote[]>(this.sql.get<{ data: string }>('SELECT data FROM agent_memory WHERE agent_id = ? AND user_id = ?', agentId, userId)?.data) ?? [];
  }

  remember(agentId: string, userId: string, text: string): MemoryNote[] {
    const db = this.sql;
    return db.transaction(() => {
      const notes = withNote(this.memories(agentId, userId), text);
      db.upsert('agent_memory', { agent_id: agentId, user_id: userId, data: JSON.stringify(notes), updated_at: new Date().toISOString() });
      return notes;
    });
  }
}

function parsed<T>(text: string | undefined): T | undefined {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

const safeList = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
};

const definitionRow = (agent: Agent) => ({ id: agent.id, created_at: agent.createdAt, updated_at: agent.updatedAt, data: JSON.stringify(agent) });

const sessionRow = (session: AgentSession) => ({
  id: session.id,
  agent_id: session.agentId,
  conversation_key: session.conversationKey ?? null,
  updated_at: session.updatedAt,
  summary: JSON.stringify(summarizeSession(session)),
  data: JSON.stringify(session),
});

/** A session a process left `running` and nobody has saved for a while: its process is gone. */
function settleStale<T extends { status: string; updatedAt: string }>(session: T): T {
  return session.status === 'running' && Date.now() - Date.parse(session.updatedAt) > STALE_RUNNING_MS ? { ...session, status: 'idle' } : session;
}

class AgentStore {
  /** Channel poll state: agent-channels.json, or its `config_files` row in queue mode (../config-store.ts). */
  private readonly channels = new ConfigFile<Record<string, JsonObject>>('agent-channels.json', { dir: () => store.dir });
  private readonly backend: AgentBackend;

  constructor(kind: 'files' | 'database' = configStoreKind()) {
    this.backend = kind === 'database' ? new DatabaseAgents(store.dir) : new FileAgents();
  }

  /** Where they are kept: `files` or `database`. */
  get storeKind(): 'files' | 'database' {
    return this.backend.kind;
  }

  // ---- agents -------------------------------------------------------------

  list(): Agent[] {
    return this.backend.list().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  summaries(): AgentSummary[] {
    return this.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      color: agent.color,
      ...(agent.avatar && { avatar: agent.avatar }),
      ...(agent.team && { team: agent.team }),
      ...(agent.persona?.role && { role: agent.persona.role }),
      ...(agent.persona?.tones && { tones: agent.persona.tones }),
      ...(agent.model && { model: `${agent.model.provider}/${agent.model.model}` }),
      tools: agent.tools.length,
      skills: agent.skills.length,
      ...(agent.published && { publishedVersion: agent.published.version }),
      draftChanged: agent.published ? !sameConfig(agent, agent.published.config) : false,
      ...(agent.kagent && { kagent: agent.kagent.name }),
      channels: [...new Set((agent.published?.config.channels ?? []).filter((c) => c.enabled).map((c) => c.type))],
      schedules: (agent.published?.config.schedules ?? []).filter((s) => s.enabled).length,
      sessions: this.backend.sessionCount(agent.id),
      updatedAt: agent.updatedAt,
    }));
  }

  get(id: string): Agent | undefined {
    return this.backend.get(id);
  }

  create(config: Partial<AgentConfig>): Agent {
    const now = new Date().toISOString();
    const agent: Agent = { id: `ag_${nanoid(10)}`, ...normalizeConfig(config), createdAt: now, updatedAt: now, history: [] };
    return this.write(agent);
  }

  /** Replace the draft. Published versions are untouched. */
  saveDraft(id: string, config: Partial<AgentConfig>): Agent | undefined {
    const agent = this.backend.get(id);
    if (!agent) return undefined;
    // The optional parts come from the new config only, so a cleared model, persona, guardrails or plugin list stays cleared.
    const { model: _model, persona: _persona, guardrails: _guardrails, plugins: _plugins, ...rest } = agent;
    return this.write({ ...rest, ...normalizeConfig({ ...configOf(agent), ...config }), updatedAt: new Date().toISOString() });
  }

  publish(id: string): Agent | undefined {
    const agent = this.backend.get(id);
    if (!agent) return undefined;
    const version = (agent.published?.version ?? agent.history[0]?.version ?? 0) + 1;
    const published = { version, publishedAt: new Date().toISOString(), config: configOf(agent) };
    const history = [published, ...agent.history].slice(0, MAX_HISTORY);
    return this.write({ ...agent, published, history, updatedAt: published.publishedAt });
  }

  unpublish(id: string): Agent | undefined {
    const agent = this.backend.get(id);
    if (!agent) return undefined;
    const { published: _published, ...rest } = agent;
    return this.write({ ...rest, updatedAt: new Date().toISOString() });
  }

  /** Record where the published agent runs in kagent, or forget it (undefined). The draft and versions are untouched. */
  setKagent(id: string, kagent: KagentDeployment | undefined): Agent | undefined {
    const agent = this.backend.get(id);
    if (!agent) return undefined;
    const { kagent: _previous, ...rest } = agent;
    return this.write({ ...rest, ...(kagent && { kagent }) });
  }

  delete(id: string): boolean {
    return this.backend.remove(id);
  }

  private write(agent: Agent): Agent {
    this.backend.write(agent);
    return agent;
  }

  // ---- sessions -----------------------------------------------------------

  listSessions(agentId: string, limit = 100): SessionSummary[] {
    return this.backend.listSessions(agentId, limit);
  }

  getSession(id: string): AgentSession | undefined {
    return this.backend.getSession(id);
  }

  /** The newest session of a channel conversation, e.g. one Telegram chat. */
  findConversation(agentId: string, conversationKey: string): AgentSession | undefined {
    return this.backend.findConversation(agentId, conversationKey);
  }

  saveSession(session: AgentSession): AgentSession {
    const saved = { ...session, updatedAt: new Date().toISOString() };
    this.backend.saveSession(saved);
    return saved;
  }

  deleteSession(agentId: string, id: string): boolean {
    if (!this.backend.deleteSession(agentId, id)) return false;
    deleteAgentSessionFeedback(id);
    return true;
  }

  // ---- cross-session memory ----------------------------------------------

  memories(agentId: string, userId: string): MemoryNote[] {
    return this.backend.memories(agentId, userId);
  }

  remember(agentId: string, userId: string, text: string): MemoryNote[] {
    return this.backend.remember(agentId, userId, text);
  }

  // ---- channel poll state (e.g. the Telegram update offset) -------------

  channelState(key: string): JsonObject | undefined {
    return this.channels.read()?.[key];
  }

  setChannelState(key: string, state: JsonObject | undefined) {
    const all = { ...this.channels.read() };
    if (state) all[key] = state;
    else delete all[key];
    this.channels.write(all);
  }
}

/** A store of the given kind (tests; the app uses `agentStore`). */
export const createAgentStore = (kind?: 'files' | 'database'): { [K in keyof AgentStore]: AgentStore[K] } => new AgentStore(kind);

export const agentStore = singleton('agent-store', () => new AgentStore());
