/**
 * The parts of agent memory the agent store needs (agents/store.ts) and that need nothing of the memory facade: the bounds, the
 * one-time import of the old notes, the plain synchronous add, the profile notes and the delete. Split from memory.ts so the
 * store does not import the facade (memory/ → access.ts → the store) in a cycle.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { AGENT_MEMORY_COLLECTION } from '../../shared/brain';
import { deleteFactsWhere, getFact, listFacts, sameStatement, upsertFact } from '../brain/facts';
import type { BrainFact } from '../../shared/brain';
import { database, type Database } from '../db';
import { SqliteVectorStore } from '../rag/stores';
import { logger } from '../telemetry/logger';

/** Writes a fact's vector. memory.ts sets it (brain/fact-lifecycle would pull the study into the store's imports); until then a plain add is indexed at the next study. */
let indexer: ((fact: BrainFact) => Promise<unknown>) | undefined;
export const setMemoryIndexer = (fn: (fact: BrainFact) => Promise<unknown>): void => {
  indexer = fn;
};

export const AGENT_MEMORY = { max: 1_000, recent: 10, relevant: 8, recallThreshold: 0.3, nearDuplicate: 0.92, blockChars: 4_000, factChars: 500 } as const;

export const subjectOf = (agentId: string, userId: string) => `${agentId}/${userId}`;

/**
 * Whether a session user is a person (or a workflow, schedule or channel user) with memories of their own: not an evaluation or smoke-test
 * run, not kagent's own session user, and not a sub-agent (`agent:`) or team (`team:`) run, whose "user" would pool every caller's memories.
 */
export const hasMemoryUser = (userId: string): boolean =>
  Boolean(userId) && userId !== 'evaluation' && userId !== 'smoke-test' && !userId.startsWith('kagent:') && !userId.startsWith('agent:') && !userId.startsWith('team:');

/** An agent is deleted: every person's memories of it (and their vectors) go with it. */
export async function deleteAgentMemories(agentId: string, db: Database = database()): Promise<number> {
  const ids = deleteFactsWhere({ subjectType: 'agent-user', subjectIdPrefix: `${agentId}/` }, db);
  if (ids.length) {
    try {
      await new SqliteVectorStore().deleteWhere(AGENT_MEMORY_COLLECTION, { agentId });
    } catch (error) {
      logger.warn('the vectors of a deleted agent’s memories were not removed', { 'gen_ai.agent.id': agentId, error });
    }
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// The one-time import of the old notes
// ---------------------------------------------------------------------------

interface OldNote {
  text: string;
  at: string;
}

const isNote = (n: unknown): n is OldNote => typeof n === 'object' && n !== null && typeof (n as OldNote).text === 'string' && (n as OldNote).text.trim() !== '';

/**
 * Every old `agent_memory` row (and, in files mode, every `agent-memory/<agent>.json`) becomes a non-static memory with its date.
 * The ids come from the agent, the person, the date and the words, so a second run or a second process writes nothing new. The
 * old table is left read-only for one release. Call it through `importOnce` (agents/store.ts). Returns how many it wrote.
 */
export function importAgentMemories(db: Database, dir: string): number {
  const groups = new Map<string, OldNote[]>(); // `<agentId>\u0000<userId>` → notes
  const take = (agentId: string, userId: string, notes: unknown) => {
    if (!Array.isArray(notes)) return;
    const key = `${agentId}\u0000${userId}`;
    groups.set(key, [...(groups.get(key) ?? []), ...notes.filter(isNote)]);
  };
  for (const row of db.all<{ agent_id: string; user_id: string; data: string }>('SELECT agent_id, user_id, data FROM agent_memory')) {
    try {
      take(row.agent_id, row.user_id, JSON.parse(row.data));
    } catch {
      /* a row that is not JSON has nothing to import */
    }
  }
  const folder = join(dir, 'agent-memory');
  if (existsSync(folder)) {
    for (const file of readdirSync(folder).filter((f) => f.endsWith('.json'))) {
      try {
        const all = JSON.parse(readFileSync(join(folder, file), 'utf8')) as Record<string, unknown>;
        for (const [userId, notes] of Object.entries(all)) take(file.replace(/\.json$/, ''), userId, notes);
      } catch {
        /* an unreadable file is left as it is */
      }
    }
  }
  let written = 0;
  db.transaction(() => {
    for (const [key, notes] of groups) {
      const [agentId, userId] = key.split('\u0000');
      for (const note of notes) {
        const at = Number.isNaN(Date.parse(note.at)) ? new Date().toISOString() : new Date(note.at).toISOString();
        const digest = createHash('sha256').update(at + '\n' + note.text).digest('hex').slice(0, 12);
        const id = `agent-user:${subjectOf(agentId, userId)}:memory:m_i${digest}`;
        if (getFact(id, db, { includeForgotten: true })) continue;
        upsertFact({ id, subjectType: 'agent-user', subjectId: subjectOf(agentId, userId), kind: 'memory', statement: note.text.replace(/\s+/g, ' ').trim(), confidence: 1, evidence: [] }, db, at, 'landflow', userId);
        written++;
      }
    }
  });
  return written;
}

/** The notes the profile holds, as the old `{ text, at }` (store.memories, for callers that read memory without a run). */
export function profileNotes(agentId: string, userId: string): Array<{ text: string; at: string }> {
  if (!hasMemoryUser(userId)) return [];
  const filter = { subjectType: 'agent-user' as const, subjectId: subjectOf(agentId, userId) };
  return [...listFacts({ ...filter, static: true, limit: 50 }), ...listFacts({ ...filter, static: false, limit: AGENT_MEMORY.recent })].map((f) => ({ text: f.statement, at: f.firstSeen })).reverse();
}

/**
 * A plain add, synchronously (store.remember: the callers that cannot wait, and the tests): the same words refresh the old
 * memory, anything else is added; its vector follows in the background and a failure is logged. The model's `remember` tool
 * uses `rememberMemory`, which also does near-duplicates, static, replaces and the bound.
 */
export function rememberSync(agentId: string, userId: string, text: string): void {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, AGENT_MEMORY.factChars);
  if (!clean || !hasMemoryUser(userId)) return;
  const db = database();
  const subject = subjectOf(agentId, userId);
  const same = listFacts({ subjectType: 'agent-user', subjectId: subject, limit: AGENT_MEMORY.max + 100 }, db).find((f) => sameStatement(f.statement, clean));
  if (same) {
    upsertFact(same, db, new Date().toISOString(), 'landflow', userId, { isStatic: same.static });
    return;
  }
  const fact = upsertFact({ id: `agent-user:${subject}:memory:m_${nanoid(10)}`, subjectType: 'agent-user', subjectId: subject, kind: 'memory', statement: clean, confidence: 1, evidence: [] }, db, new Date().toISOString(), 'landflow', userId);
  void indexer?.(fact)?.catch((error) => logger.warn('a memory’s vector was not written', { error }));
}
