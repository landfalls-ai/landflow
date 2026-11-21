/**
 * What people and agents do to a brain fact after it exists (docs/second-brain.md#fact-versions and #forgetting-a-fact):
 * supersede it (a new version, all or nothing, with its vector), forget it softly with a reason, and restore it. The study
 * writes through the synchronous `upsertFact`; these are the async operations for one caller's change, which can fail whole.
 *
 * Why the vector is written after the commit (C02 FR-2): the database transaction is synchronous and the vector store is
 * another SQLite file, so the embedding is made first (a failure writes nothing) and stored once the rows are committed. A
 * failed vector write is logged and the next study re-embeds.
 */
import type { BrainFact, ProposalEvidence } from '../../shared/brain';
import type { BrainChangeOrigin } from '../../shared/brain-store';
import { recordAudit } from '../audit';
import { database, type Database } from '../db';
import { HttpError } from '../errors';
import { envString, ollamaUrl } from '../config';
import { ollamaEmbeddings } from '../rag/embeddings';
import { SqliteVectorStore } from '../rag/stores';
import { logger } from '../telemetry/logger';
import { checkForgetAfter, FactInputError, factRow, FactNotFoundError, getFact, MemoryIndexError, sameStatement, StaleChainError, StaticFactError, upsertFact, versionFact } from './facts';
import { changeOrigin } from './store/origin';
import { emitBrainChange } from './store/port';
import { canFact } from './scope';
import { collectionFor } from './study';
import type { Actor } from '../projects/access';

export { FactInputError, FactNotFoundError, MemoryIndexError, StaleChainError, StaticFactError };

const MAX_REASON = 500;

/** The vector of one fact, ready to store (undefined with embeddings off). Throws `MemoryIndexError` when the model is not reachable. */
async function embed(fact: BrainFact): Promise<{ collection: string; text: string; embedding: number[] } | undefined> {
  const model = envString('LANDFLOW_BRAIN_EMBEDDINGS');
  if (model?.toLowerCase() === 'off') return undefined;
  const text = `${fact.subjectName ?? fact.subjectId}: ${fact.statement}`;
  try {
    const embeddings = ollamaEmbeddings({ baseUrl: ollamaUrl(), model: model || 'nomic-embed-text', documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' });
    const [embedding] = await embeddings.embedDocuments([text]);
    if (!embedding?.length) throw new Error('empty embedding');
    return { collection: collectionFor(fact.projectId), text, embedding };
  } catch (error) {
    logger.warn('a brain fact could not be embedded; it was not changed', { id: fact.id, error });
    throw new MemoryIndexError();
  }
}

export interface SupersedeInput {
  statement: string;
  evidence?: ProposalEvidence[];
  confidence?: number;
  /** A person or Spotlight changing a static fact. */
  replaceStatic?: boolean;
  /** The version the writer read; another writer moving the chain since answers `StaleChainError`. Default: the version read now. */
  expectedVersion?: number;
}

/**
 * Write a new version of a fact for a person or an agent, all or nothing: the embedding first, then the rows in one
 * transaction (in Postgres one conditional write, so two writers of the same version cannot both win), then the vector.
 */
export async function supersedeFact(chainId: string, next: SupersedeInput, who: { origin?: BrainChangeOrigin; by?: string } = {}, db: Database = database()): Promise<BrainFact> {
  const current = getFact(chainId, db);
  if (!current || current.latest === false) throw new FactNotFoundError();
  if (current.static && !next.replaceStatic) throw new StaticFactError();
  const expected = next.expectedVersion ?? current.version ?? 1;
  const now = new Date().toISOString();
  if (sameStatement(current.statement, next.statement)) {
    if (expected !== (current.version ?? 1)) throw new StaleChainError();
    // Same words: only the sightings move, as the study's refresh does.
    return upsertFact({ ...current, statement: current.statement, evidence: next.evidence ?? current.evidence, confidence: next.confidence ?? current.confidence }, db, now, who.origin, who.by, { replaceStatic: next.replaceStatic });
  }
  const proposed: BrainFact = { ...current, statement: next.statement.trim(), evidence: next.evidence ?? current.evidence, confidence: Math.max(0, Math.min(1, next.confidence ?? current.confidence)), firstSeen: now, lastSeen: now, status: 'active' };
  const vector = await embed(proposed); // before any row is written
  const written = db.kind === 'postgres' ? await supersedePostgres(db, current, proposed, expected, who) : db.transaction(() => {
    const row = getFact(chainId, db, { includeForgotten: true });
    if (!row || (row.version ?? 1) !== expected) throw new StaleChainError();
    return versionFact(db, row, proposed, who.origin, who.by);
  });
  if (vector) {
    try {
      // `INSERT OR REPLACE` by id: the chain id's vector now says the new statement.
      await new SqliteVectorStore().add(vector.collection, [{ id: written.id, pageContent: vector.text, metadata: { factId: written.id, subjectType: written.subjectType, subjectId: written.subjectId, kind: written.kind }, embedding: vector.embedding }]);
    } catch (error) {
      logger.warn('the vector of a new fact version was not stored; the next study embeds it', { id: written.id, error });
    }
  }
  emitBrainChange({ kind: 'fact', key: written.id, ...(written.projectId && { projectId: written.projectId }), op: 'upsert', ...changeOrigin(who.origin, who.by), at: now });
  return written;
}

/** The conditional write in Postgres (the `claim()` pattern): the archive row is new and the chain row still holds the version read. */
async function supersedePostgres(db: Database, current: BrainFact, proposed: BrainFact, expected: number, who: { origin?: BrainChangeOrigin; by?: string }): Promise<BrainFact> {
  await db.flush();
  // The same rows `versionFact` writes on SQLite, composed here because Postgres decides the race in one SQL transaction.
  const n = current.version ?? 1;
  const archive: BrainFact = { ...current, id: `${current.id}#v${n}`, rootId: current.id, latest: false, version: n };
  const written: BrainFact = { ...proposed, id: current.id, rootId: current.id, version: n + 1, latest: true, parentId: archive.id, relation: 'updates', writtenBy: { ...changeOrigin(who.origin, who.by) } };
  const archiveRow = factRow(archive);
  const chainRow = factRow(written);
  const columns = Object.keys(chainRow);
  const result = await db.direct(async (client) => {
    await client.query('BEGIN');
    try {
      const inserted = await client.query(`INSERT INTO brain_facts (${Object.keys(archiveRow).join(', ')}) VALUES (${Object.keys(archiveRow).map((_c, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING RETURNING id`, Object.values(archiveRow));
      const sets = columns.filter((c) => c !== 'id').map((c, i) => `${c} = $${i + 3}`);
      const updated = inserted.rows[0] ? await client.query(`UPDATE brain_facts SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING id`, [written.id, expected, ...columns.filter((c) => c !== 'id').map((c) => chainRow[c] ?? null)]) : undefined;
      if (!updated?.rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
  if (!result) throw new StaleChainError();
  // This process's copy follows (nothing is queued: Postgres already holds both rows).
  db.upsertLocal('brain_facts', archiveRow);
  db.upsertLocal('brain_facts', chainRow);
  return written;
}

export interface ForgetBy {
  userId: string;
  name?: string;
}

/**
 * Forget the latest version of a fact softly: it leaves every list, search, prompt and MCP tool but the row stays, with who
 * and why, and can be restored. With `forgetAfter` it only sets the time it goes (reads hide it from then, no sweep needed).
 */
export async function forgetFact(id: string, input: { reason: string; forgetAfter?: string }, by: ForgetBy, db: Database = database()): Promise<BrainFact> {
  const reason = input.reason?.trim() ?? '';
  if (!reason || reason.length > MAX_REASON) throw new FactInputError(`A reason of 1 to ${MAX_REASON} characters is required`);
  const fact = getFact(id, db, { includeForgotten: true });
  if (!fact || fact.latest === false) throw new FactNotFoundError();
  const now = Date.now();
  const forgetAfter = checkForgetAfter(input.forgetAfter, now);
  const stamp = new Date(now).toISOString();
  const forgotten: BrainFact = { ...fact, forgetReason: reason, forgottenBy: by.userId, ...(forgetAfter ? { forgetAfter } : { forgottenAt: stamp }) };
  db.upsert('brain_facts', factRow(forgotten));
  if (!forgetAfter) await dropVector(forgotten);
  recordAudit({
    action: 'brain.fact_forgotten',
    target: { type: 'brain_fact', id, name: fact.subjectName ?? fact.subjectId },
    project: fact.projectId ?? null,
    // The reason is a person's words: it goes to the audit log, never into a prompt.
    details: { reason, from: 'live', to: forgetAfter ? 'forgetting' : 'forgotten', ...(forgetAfter && { forgetAfter }) },
    actor: { id: by.userId, ...(by.name && { name: by.name }) },
  });
  emitBrainChange({ kind: 'fact', key: id, ...(fact.projectId && { projectId: fact.projectId }), op: 'upsert', origin: 'person', by: by.userId, at: stamp });
  return forgotten;
}

/** Bring a forgotten fact back (a past version stays a past version: restoring never makes it the latest). */
export function restoreFact(id: string, by: ForgetBy, db: Database = database()): BrainFact {
  const fact = getFact(id, db, { includeForgotten: true });
  if (!fact) throw new FactNotFoundError();
  const { forgottenAt, forgetReason, forgottenBy, forgetAfter, ...rest } = fact;
  const was = forgottenAt || forgetAfter || forgetReason || forgottenBy;
  const restored: BrainFact = rest;
  if (was) db.upsert('brain_facts', factRow(restored));
  recordAudit({
    action: 'brain.fact_restored',
    target: { type: 'brain_fact', id, name: fact.subjectName ?? fact.subjectId },
    project: fact.projectId ?? null,
    details: { from: 'forgotten', to: 'live' },
    actor: { id: by.userId, ...(by.name && { name: by.name }) },
  });
  emitBrainChange({ kind: 'fact', key: id, ...(fact.projectId && { projectId: fact.projectId }), op: 'upsert', origin: 'person', by: by.userId, at: new Date().toISOString() });
  return restored;
}

/** Drop a forgotten fact's vector (the next study would leave it out anyway); a failure is logged, never raised. */
async function dropVector(fact: BrainFact): Promise<void> {
  try {
    await new SqliteVectorStore().deleteWhere(collectionFor(fact.projectId), { factId: fact.id });
  } catch (error) {
    logger.warn('the vector of a forgotten fact was not removed; the next study drops it', { id: fact.id, error });
  }
}

/**
 * The fact `actor` may read (or change), forgotten ones included: 404 when they may not know it exists, 403 when they may
 * read it but not change it.
 */
export function factFor(actor: Actor, id: string, action: 'read' | 'update', db: Database = database()): BrainFact {
  const fact = getFact(id, db, { includeForgotten: true });
  if (!fact || !canFact(actor, fact, 'read')) throw new FactNotFoundError();
  if (action === 'update' && !canFact(actor, fact, 'update')) throw new HttpError('You can’t change this fact', 403);
  return fact;
}
