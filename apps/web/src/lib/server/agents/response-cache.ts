/**
 * The response cache's storage (docs/agents.md "Response cache"). The runtime talks to the `ResponseCache` interface only, so the
 * database adapter below can be replaced (Valkey, a gateway's cache) without touching the runtime.
 */
import { createHash } from 'node:crypto';
import type { AgentConfig } from '../../shared/agents';
import { normalizeQuestion } from '../../shared/agent-cache';
import { database } from '../db';
import { singleton } from '../singleton';

export interface ResponseCache {
  /** The stored answer, counting the hit; `undefined` when there is none or it has expired. */
  get(key: string): string | undefined;
  set(agentId: string, key: string, reply: string, ttlSeconds: number): void;
  /** Removes an agent's answers (all of them when it is deleted or the person clears the cache). Returns how many. */
  clear(agentId: string): number;
  stats(agentId: string): { entries: number; hits: number };
}

/** Only what decides the answer: the look, the schedules and the channels can change without making an answer wrong. */
function answerShape(config: AgentConfig) {
  return { model: config.model, persona: config.persona, instructions: config.instructions, skills: config.skills, tools: config.tools, guardrails: config.guardrails, router: config.router, plugins: config.plugins };
}

/** A key for one question to one agent config: edit the prompt, model or guardrails and the old answers no longer match. */
export function cacheKey(agentId: string, config: AgentConfig, question: string): string {
  return createHash('sha256').update(JSON.stringify([agentId, answerShape(config), normalizeQuestion(question)])).digest('hex');
}

const db = () => database();
const MAX_ENTRIES_PER_AGENT = 1_000;

class DatabaseCache implements ResponseCache {
  get(key: string): string | undefined {
    const now = new Date().toISOString();
    const row = db().get<{ reply: string; hits: number; agent_id: string; created_at: string; expires_at: string }>('SELECT agent_id, created_at, expires_at, hits, reply FROM agent_response_cache WHERE id = ?', key);
    if (!row) return undefined;
    if (row.expires_at <= now) {
      db().delete('agent_response_cache', { id: key });
      return undefined;
    }
    db().upsert('agent_response_cache', { id: key, agent_id: row.agent_id, created_at: row.created_at, expires_at: row.expires_at, hits: row.hits + 1, reply: row.reply });
    return row.reply;
  }

  set(agentId: string, key: string, reply: string, ttlSeconds: number): void {
    const now = Date.now();
    db().transaction(() => {
      db().upsert('agent_response_cache', { id: key, agent_id: agentId, created_at: new Date(now).toISOString(), expires_at: new Date(now + ttlSeconds * 1000).toISOString(), hits: 0, reply });
      // Expired answers go first, then the oldest past the limit.
      for (const { id } of db().all<{ id: string }>('SELECT id FROM agent_response_cache WHERE agent_id = ? AND expires_at <= ?', agentId, new Date(now).toISOString())) db().delete('agent_response_cache', { id });
      for (const { id } of db().all<{ id: string }>('SELECT id FROM agent_response_cache WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', agentId, MAX_ENTRIES_PER_AGENT)) db().delete('agent_response_cache', { id });
    });
  }

  clear(agentId: string): number {
    const ids = db().all<{ id: string }>('SELECT id FROM agent_response_cache WHERE agent_id = ?', agentId);
    for (const { id } of ids) db().delete('agent_response_cache', { id });
    return ids.length;
  }

  stats(agentId: string): { entries: number; hits: number } {
    const row = db().get<{ entries: number; hits: number | null }>('SELECT COUNT(*) AS entries, SUM(hits) AS hits FROM agent_response_cache WHERE agent_id = ? AND expires_at > ?', agentId, new Date().toISOString());
    return { entries: Number(row?.entries ?? 0), hits: Number(row?.hits ?? 0) };
  }
}

/** The cache the runtime uses. Swap the adapter here. */
export const responseCache = singleton<ResponseCache>('agent-response-cache', () => new DatabaseCache());
