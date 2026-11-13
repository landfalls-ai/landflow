/**
 * The semantic cache (docs/agents.md "Response cache"): a question that means the same as a stored one gets that answer.
 * The runtime talks to the `SemanticCache` interface and an `Embedder` function only, so the database store below can be replaced
 * by a vector database (Valkey, pgvector, Qdrant) and the embedder by any model that turns text into numbers.
 */
import { createHash } from 'node:crypto';
import type { AgentConfig } from '../../shared/agents';
import { cosine, normalizeQuestion, type SemanticCache as SemanticSettings } from '../../shared/agent-cache';
import { database } from '../db';
import { ollamaEmbeddings } from '../rag/embeddings';
import { singleton } from '../singleton';
import { ollamaUrl } from '../config';
import { answerShape } from './response-cache';

export type Embedder = (text: string, signal?: AbortSignal) => Promise<number[]>;

export interface SemanticStore {
  /** The stored answer whose question is most like this one, at or above the threshold; the hit is counted. */
  find(agentId: string, configHash: string, vector: number[], threshold: number): { reply: string; question: string; similarity: number } | undefined;
  add(entry: { agentId: string; configHash: string; question: string; reply: string; vector: number[]; ttlSeconds: number }): void;
  clear(agentId: string): number;
  stats(agentId: string): { entries: number; hits: number };
}

/** A hash of what decides an answer, without the question: edit the prompt, model or guardrails and the old answers no longer match. */
export function configHash(agentId: string, config: AgentConfig): string {
  return createHash('sha256').update(JSON.stringify([agentId, answerShape(config)])).digest('hex');
}

/** The embedder the settings name: an Ollama embedding model. */
export function embedderFor(settings: SemanticSettings): Embedder {
  const embeddings = ollamaEmbeddings({ baseUrl: settings.baseUrl?.trim() || ollamaUrl(), model: settings.model });
  return (text, signal) => embeddings.embedQuery(normalizeQuestion(text), signal);
}

const db = () => database();
const MAX_ENTRIES_PER_AGENT = 500;

class DatabaseSemanticStore implements SemanticStore {
  find(agentId: string, hash: string, vector: number[], threshold: number) {
    const now = new Date().toISOString();
    const rows = db().all<{ id: string; question: string; reply: string; vector: string; hits: number; created_at: string; expires_at: string }>(
      'SELECT id, question, reply, vector, hits, created_at, expires_at FROM agent_semantic_cache WHERE agent_id = ? AND config_hash = ? AND expires_at > ?',
      agentId,
      hash,
      now,
    );
    let best: { row: (typeof rows)[number]; similarity: number } | undefined;
    for (const row of rows) {
      let stored: number[];
      try {
        stored = JSON.parse(row.vector) as number[];
      } catch {
        continue;
      }
      const similarity = cosine(vector, stored);
      if (similarity >= threshold && (!best || similarity > best.similarity)) best = { row, similarity };
    }
    if (!best) return undefined;
    const { row } = best;
    db().upsert('agent_semantic_cache', { id: row.id, agent_id: agentId, config_hash: hash, created_at: row.created_at, expires_at: row.expires_at, hits: row.hits + 1, question: row.question, reply: row.reply, vector: row.vector });
    return { reply: row.reply, question: row.question, similarity: best.similarity };
  }

  add(entry: { agentId: string; configHash: string; question: string; reply: string; vector: number[]; ttlSeconds: number }): void {
    const now = Date.now();
    const id = createHash('sha256').update(`${entry.agentId}|${entry.configHash}|${normalizeQuestion(entry.question)}`).digest('hex');
    db().transaction(() => {
      db().upsert('agent_semantic_cache', {
        id,
        agent_id: entry.agentId,
        config_hash: entry.configHash,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + entry.ttlSeconds * 1000).toISOString(),
        hits: 0,
        question: entry.question,
        reply: entry.reply,
        vector: JSON.stringify(entry.vector),
      });
      for (const { id: old } of db().all<{ id: string }>('SELECT id FROM agent_semantic_cache WHERE agent_id = ? AND expires_at <= ?', entry.agentId, new Date(now).toISOString())) db().delete('agent_semantic_cache', { id: old });
      for (const { id: old } of db().all<{ id: string }>('SELECT id FROM agent_semantic_cache WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', entry.agentId, MAX_ENTRIES_PER_AGENT)) db().delete('agent_semantic_cache', { id: old });
    });
  }

  clear(agentId: string): number {
    const ids = db().all<{ id: string }>('SELECT id FROM agent_semantic_cache WHERE agent_id = ?', agentId);
    for (const { id } of ids) db().delete('agent_semantic_cache', { id });
    return ids.length;
  }

  stats(agentId: string): { entries: number; hits: number } {
    const row = db().get<{ entries: number; hits: number | null }>('SELECT COUNT(*) AS entries, SUM(hits) AS hits FROM agent_semantic_cache WHERE agent_id = ? AND expires_at > ?', agentId, new Date().toISOString());
    return { entries: Number(row?.entries ?? 0), hits: Number(row?.hits ?? 0) };
  }
}

/** The semantic store the runtime uses. Swap the adapter here. */
export const semanticCache = singleton<SemanticStore>('agent-semantic-cache', () => new DatabaseSemanticStore());
