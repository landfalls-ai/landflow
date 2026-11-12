/**
 * What the brain knows (docs/second-brain.md#2-memory-profiles-and-facts): profiles of workflows, agents, node types and
 * credentials, and facts about them with their evidence. A fact of a kind is kept once per subject (id
 * `<type>:<id>:<kind>`) and refreshed by each study; a fact the study didn't confirm goes stale. `intended` facts come from
 * suggestions dismissed as intended and are never refreshed away.
 *
 * Search: BM25 over the statements, fused with a vector search of `landflow-brain` collections when facts were embedded
 * (./study.ts).
 */
import type { BrainFact, BrainProfile, FactKind, FactSubject } from '../../shared/brain';
import { database, type Database } from '../db';
import { bm25Scores } from '../rag/search';
import type { UsageScope } from '../usage/query';

export type FactInput = Omit<BrainFact, 'id' | 'firstSeen' | 'lastSeen' | 'status'> & { id?: string };

const parse = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

export const factId = (subjectType: FactSubject, subjectId: string, kind: FactKind) => `${subjectType}:${subjectId}:${kind}`;

export function getFact(id: string, db: Database = database()): BrainFact | undefined {
  const row = db.get<{ data: string }>('SELECT data FROM brain_facts WHERE id = ?', id);
  return row ? parse<BrainFact>(row.data) : undefined;
}

/** Add a fact, or refresh the one with its id (first seen stays). */
export function upsertFact(input: FactInput, db: Database = database(), now = new Date().toISOString()): BrainFact {
  const id = input.id ?? factId(input.subjectType, input.subjectId, input.kind);
  const existing = getFact(id, db);
  const fact: BrainFact = {
    id,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    ...(input.subjectName && { subjectName: input.subjectName }),
    kind: input.kind,
    statement: input.statement,
    evidence: input.evidence ?? [],
    confidence: Math.max(0, Math.min(1, input.confidence)),
    ...(input.projectId && { projectId: input.projectId }),
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
    status: 'active',
  };
  db.upsert('brain_facts', { id, subject_type: fact.subjectType, subject_id: fact.subjectId, kind: fact.kind, project_id: fact.projectId ?? null, status: 'active', last_seen: now, data: JSON.stringify(fact) });
  return fact;
}

/** Facts not refreshed since `before` go stale (intended facts, the outcomes of applied suggestions and the statements people and flows added about an entity stay). */
export function staleFactsBefore(before: string, db: Database = database()): number {
  const rows = db.all<{ data: string }>("SELECT data FROM brain_facts WHERE status = 'active' AND last_seen < ? AND kind <> 'intended' AND id NOT LIKE '%:change:pr_%' AND id NOT LIKE 'entity:%:fact_%'", before);
  for (const row of rows) {
    const fact = parse<BrainFact>(row.data);
    if (!fact) continue;
    db.upsert('brain_facts', { id: fact.id, status: 'stale', data: JSON.stringify({ ...fact, status: 'stale' }) });
  }
  return rows.length;
}

export function deleteFact(id: string, db: Database = database()): boolean {
  return db.delete('brain_facts', { id }) > 0;
}

function inScope(fact: { subjectType: FactSubject; subjectId: string }, scope?: UsageScope): boolean {
  if (!scope || (!scope.workflows && !scope.agents)) return true;
  if (fact.subjectType === 'workflow') return Boolean(scope.workflows?.has(fact.subjectId));
  if (fact.subjectType === 'agent') return Boolean(scope.agents?.has(fact.subjectId));
  // An entity's subjectId is `<type>/<id>`, the key the scope holds.
  if (fact.subjectType === 'entity') return Boolean(scope.entities?.has(fact.subjectId));
  // Node types, credentials and the instance span projects: owners and admins only.
  return false;
}

export function listFacts(
  filter: { subjectType?: FactSubject; subjectId?: string; kind?: FactKind; status?: 'active' | 'stale' | 'all'; scope?: UsageScope; limit?: number } = {},
  db: Database = database(),
): BrainFact[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.subjectType) {
    where.push('subject_type = ?');
    params.push(filter.subjectType);
  }
  if (filter.subjectId) {
    where.push('subject_id = ?');
    params.push(filter.subjectId);
  }
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  if ((filter.status ?? 'active') !== 'all') {
    where.push('status = ?');
    params.push(filter.status ?? 'active');
  }
  const rows = db.all<{ data: string }>(`SELECT data FROM brain_facts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen DESC`, ...params);
  return rows
    .flatMap((r) => parse<BrainFact>(r.data) ?? [])
    .filter((f) => inScope(f, filter.scope))
    .slice(0, filter.limit ?? 500);
}

/** The best matching facts for `query`: BM25 over statement and subject, fused with `vectorHits` (fact ids, best first). */
export function searchFacts(query: string, options: { scope?: UsageScope; limit?: number; vectorHits?: string[] } = {}, db: Database = database()): BrainFact[] {
  const facts = listFacts({ scope: options.scope, limit: 5_000 }, db);
  if (!facts.length) return [];
  const limit = options.limit ?? 8;
  const texts = facts.map((f) => `${f.subjectName ?? ''} ${f.kind} ${f.statement}`);
  const scores = query.trim() ? bm25Scores(query, texts) : facts.map(() => 0);
  const ranked = facts.map((fact, i) => ({ fact, score: scores[i] })).filter((r) => r.score > 0 || !query.trim());
  ranked.sort((a, b) => b.score - a.score);
  if (!options.vectorHits?.length) return ranked.slice(0, limit).map((r) => r.fact);
  // Reciprocal rank fusion of the keyword list and the vector list.
  const fused = new Map<string, number>();
  ranked.forEach((r, i) => fused.set(r.fact.id, (fused.get(r.fact.id) ?? 0) + 1 / (60 + i + 1)));
  options.vectorHits.forEach((id, i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + i + 1)));
  const byId = new Map(facts.map((f) => [f.id, f]));
  return [...fused]
    .sort((a, b) => b[1] - a[1])
    .flatMap(([id]) => byId.get(id) ?? [])
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export function saveProfile(profile: BrainProfile, db: Database = database()) {
  db.upsert('brain_profiles', { subject_type: profile.subjectType, subject_id: profile.subjectId, project_id: profile.projectId ?? null, updated_at: profile.updatedAt, data: JSON.stringify(profile) });
}

export function getProfile(subjectType: FactSubject, subjectId: string, db: Database = database()): BrainProfile | undefined {
  const row = db.get<{ data: string }>('SELECT data FROM brain_profiles WHERE subject_type = ? AND subject_id = ?', subjectType, subjectId);
  return row ? parse<BrainProfile>(row.data) : undefined;
}

export function listProfiles(subjectType?: FactSubject, db: Database = database()): BrainProfile[] {
  const rows = subjectType ? db.all<{ data: string }>('SELECT data FROM brain_profiles WHERE subject_type = ?', subjectType) : db.all<{ data: string }>('SELECT data FROM brain_profiles');
  return rows.flatMap((r) => parse<BrainProfile>(r.data) ?? []);
}

export function countFacts(db: Database = database()): { facts: number; profiles: number } {
  return {
    facts: Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM brain_facts WHERE status = 'active'")?.n ?? 0),
    profiles: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM brain_profiles')?.n ?? 0),
  };
}
