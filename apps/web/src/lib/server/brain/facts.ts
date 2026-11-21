/**
 * What the brain knows (docs/second-brain.md#2-memory-profiles-and-facts): profiles of workflows, agents, node types and
 * credentials, and facts about them with their evidence. A fact of a kind is kept once per subject (id
 * `<type>:<id>:<kind>`) and refreshed by each study; a fact the study didn't confirm goes stale. `intended` facts come from
 * suggestions dismissed as intended and are never refreshed away.
 *
 * Search: BM25 over the statements, fused with a vector search of `landflow-brain` collections when facts were embedded
 * (./study.ts).
 */
import type { BrainFact, BrainProfile, FactKind, FactRelation, FactSubject } from '../../shared/brain';
import { database, type Database, type Row } from '../db';
import { HttpError } from '../errors';
import { bm25Scores } from '../rag/search';
import { logger } from '../telemetry/logger';
import type { BrainChangeOrigin } from '../../shared/brain-store'; // NB01
import { changeOrigin } from './store/origin'; // NB01
import { emitBrainChange } from './store/port'; // NB01
import type { UsageScope } from '../usage/query';

export type FactInput = Omit<BrainFact, 'id' | 'firstSeen' | 'lastSeen' | 'status'> & { id?: string };

// C01 and C02 errors live here (the lifecycle module imports this one) and are re-exported from ./fact-lifecycle.
/** A static fact is changed only by a person who says so (`replaceStatic`). */
export class StaticFactError extends HttpError {
  static readonly errorName: string = 'StaticFactError';
  constructor(message = 'This fact is static; pass replaceStatic to change it') {
    super(message, 409);
  }
}
/** Another writer moved the chain first; nothing was changed. */
export class StaleChainError extends HttpError {
  static readonly errorName: string = 'StaleChainError';
  constructor(message = 'The fact changed while you were writing; read it again') {
    super(message, 409);
  }
}
/** The new version's embedding could not be made, so nothing was written (the text and the index never disagree). */
export class MemoryIndexError extends HttpError {
  static readonly errorName: string = 'MemoryIndexError';
  constructor(message = 'The memory index is not available; try again') {
    super(message, 503);
  }
}
export class FactInputError extends HttpError {
  static readonly errorName: string = 'FactInputError';
  constructor(message: string) {
    super(message, 400);
  }
}
export class FactNotFoundError extends HttpError {
  static readonly errorName: string = 'FactNotFoundError';
  constructor(message = 'Fact not found') {
    super(message, 404);
  }
}

const MIN_FORGET_AFTER_MS = 60_000;
const MAX_FORGET_AFTER_MS = 5 * 365 * 86_400_000;
/** A forget-after time as ISO text: between a minute and five years ahead (C02 FR-6), else 400. */
export function checkForgetAfter(value: string | undefined, nowMs = Date.now()): string | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at < nowMs + MIN_FORGET_AFTER_MS || at > nowMs + MAX_FORGET_AFTER_MS) throw new FactInputError('forgetAfter must be between one minute and five years from now');
  return new Date(at).toISOString();
}

/** A chain keeps at most this many versions (C01 FR-10): the root and the newest ones; older rows are deleted. */
export const MAX_FACT_VERSIONS = 50;

const parse = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

export const factId = (subjectType: FactSubject, subjectId: string, kind: FactKind) => `${subjectType}:${subjectId}:${kind}`;

/** The one rule for "this fact is there": the latest version, not forgotten, not past its forget-after. Takes one `now` parameter. */
export const LIVE_FACT = 'is_latest = 1 AND forgotten_at IS NULL AND (forget_after IS NULL OR forget_after > ?)';

/** Two statements say the same when they differ only in spacing and case (C01 open question 1). */
const normalise = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
export const sameStatement = (a: string, b: string) => normalise(a) === normalise(b);

interface FactRow {
  data: string;
  version: number;
  is_latest: number;
  parent_id: string | null;
  root_id: string | null;
  is_static: number;
  relation: string | null;
  forgotten_at: string | null;
  forget_reason: string | null;
  forgotten_by: string | null;
  forget_after: string | null;
}
const FACT_COLUMNS = 'data, version, is_latest, parent_id, root_id, is_static, relation, forgotten_at, forget_reason, forgotten_by, forget_after';

/**
 * The fact a row holds: the columns are the truth for the chain and forget fields, `data` mirrors them. The reason and who
 * forgot it are a person's words and leave only with `withForget` (the forgotten list, the lifecycle, an editor's history):
 * a live fact with a pending forget-after must not carry them to MCP tools, the Usage node or the list route.
 */
function fromRow(row: FactRow, withForget = false): BrainFact | undefined {
  const fact = parse<BrainFact>(row.data);
  if (!fact) return undefined;
  const rest = { ...fact };
  for (const key of ['parentId', 'static', 'relation', 'forgottenAt', 'forgetReason', 'forgottenBy', 'forgetAfter'] as const) delete rest[key];
  return {
    ...rest,
    version: Number(row.version ?? 1),
    latest: Number(row.is_latest ?? 1) === 1,
    rootId: row.root_id ?? fact.id,
    ...(row.parent_id && { parentId: row.parent_id }),
    ...(Number(row.is_static ?? 0) === 1 && { static: true }),
    ...(row.relation && { relation: row.relation as FactRelation }),
    ...(row.forgotten_at && { forgottenAt: row.forgotten_at }),
    ...(withForget && row.forget_reason && { forgetReason: row.forget_reason }),
    ...(withForget && row.forgotten_by && { forgottenBy: row.forgotten_by }),
    ...(row.forget_after && { forgetAfter: row.forget_after }),
  };
}

/** The columns of a fact's row (the inverse of `fromRow`); `data` carries the whole fact. */
export function factRow(fact: BrainFact): Row {
  return {
    id: fact.id,
    subject_type: fact.subjectType,
    subject_id: fact.subjectId,
    kind: fact.kind,
    project_id: fact.projectId ?? null,
    status: fact.status,
    last_seen: fact.lastSeen,
    data: JSON.stringify(fact),
    version: fact.version ?? 1,
    is_latest: fact.latest === false ? 0 : 1,
    parent_id: fact.parentId ?? null,
    root_id: fact.rootId ?? fact.id,
    is_static: fact.static ? 1 : 0,
    relation: fact.relation ?? null,
    forgotten_at: fact.forgottenAt ?? null,
    forget_reason: fact.forgetReason ?? null,
    forgotten_by: fact.forgottenBy ?? null,
    forget_after: fact.forgetAfter ?? null,
  };
}

const lapsed = (fact: BrainFact, now: string) => Boolean(fact.forgottenAt || (fact.forgetAfter && fact.forgetAfter <= now));

/**
 * One fact by id. A chain id is the latest version, `<chain id>#v<n>` an earlier one. A forgotten fact (or one past its
 * forget-after) is absent unless `includeForgotten`.
 */
export function getFact(id: string, db: Database = database(), options: { includeForgotten?: boolean; now?: string } = {}): BrainFact | undefined {
  const row = db.get<FactRow>(`SELECT ${FACT_COLUMNS} FROM brain_facts WHERE id = ?`, id);
  const fact = row ? fromRow(row, options.includeForgotten) : undefined;
  if (!fact) return undefined;
  return !options.includeForgotten && lapsed(fact, options.now ?? new Date().toISOString()) ? undefined : fact;
}

export interface FactWriteOptions {
  /** A person (or Spotlight) may change a static fact; the study never passes this. */
  replaceStatic?: boolean;
  isStatic?: boolean;
  forgetAfter?: string;
  /** With `relation: 'extends' | 'derives'`: start a new chain that follows this fact. */
  parentId?: string;
  relation?: Exclude<FactRelation, 'updates'>;
}

/**
 * Move a chain forward by one version (call inside a transaction): the current row is copied to `<chain id>#v<n>` (not
 * latest), the chain row becomes version n+1, and a chain past `MAX_FACT_VERSIONS` drops the text of one old version. A
 * writer that lost a race finds the archive row there and gets `StaleChainError`.
 */
export function nextVersionRows(current: BrainFact, next: BrainFact, origin?: BrainChangeOrigin, by?: string): { archive: BrainFact; written: BrainFact; dropId?: string } {
  const n = current.version ?? 1;
  const archive: BrainFact = { ...current, id: `${current.id}#v${n}`, rootId: current.id, latest: false, version: n };
  // A supersede is always an update: `relation`/`parentId` of the chain's start (an extends link) never carry onto a later version.
  const written: BrainFact = { ...next, id: current.id, rootId: current.id, version: n + 1, latest: true, parentId: archive.id, relation: 'updates', writtenBy: { ...changeOrigin(origin, by) } };
  // Past the cap the oldest version after the root is dropped with its row (FR-10: the root and the newest 49 stay).
  const drop = n + 1 - (MAX_FACT_VERSIONS - 1);
  return { archive, written, ...(n + 1 > MAX_FACT_VERSIONS && drop > 1 && { dropId: `${current.id}#v${drop}` }) };
}

export function versionFact(db: Database, current: BrainFact, next: BrainFact, origin?: BrainChangeOrigin, by?: string): BrainFact {
  const { archive, written, dropId } = nextVersionRows(current, next, origin, by);
  if (!db.insertNew('brain_facts', factRow(archive))) throw new StaleChainError();
  db.upsert('brain_facts', factRow(written));
  if (dropId) db.delete('brain_facts', { id: dropId });
  return written;
}

/** Add a fact, or refresh the one with its id (first seen stays); a reworded statement becomes a new version of the chain. */
export function upsertFact(input: FactInput, db: Database = database(), now = new Date().toISOString(), origin?: BrainChangeOrigin, by?: string, options: FactWriteOptions = {}): BrainFact {
  const id = input.id ?? factId(input.subjectType, input.subjectId, input.kind);
  let refused = false;
  const fact = db.transaction((): BrainFact => {
    const existing = getFact(id, db, { includeForgotten: true });
    const writer = changeOrigin(origin, by);
    const base: BrainFact = {
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
      version: existing?.version ?? 1,
      latest: true,
      rootId: id,
      ...((options.isStatic ?? existing?.static) && { static: true }),
      writtenBy: writer,
    };
    if (!existing) {
      const linked = options.parentId && options.relation ? { parentId: options.parentId, relation: options.relation } : {};
      const created: BrainFact = { ...base, ...linked, ...(options.forgetAfter && { forgetAfter: options.forgetAfter }) };
      db.upsert('brain_facts', factRow(created));
      return created;
    }
    // A forgotten fact stays forgotten when the study writes it again: the person said it is wrong (restore brings it back).
    const forgotten = { ...(existing.forgottenAt && { forgottenAt: existing.forgottenAt }), ...(existing.forgetReason && { forgetReason: existing.forgetReason }), ...(existing.forgottenBy && { forgottenBy: existing.forgottenBy }) };
    const forgetAfter = options.forgetAfter ?? existing.forgetAfter;
    if (sameStatement(existing.statement, input.statement)) {
      // Same words: refresh the sightings only. The text and the stale/active state of a reworded copy are not touched.
      const refreshed: BrainFact = { ...base, statement: existing.statement, firstSeen: existing.firstSeen, ...(existing.parentId && { parentId: existing.parentId }), ...(existing.relation && { relation: existing.relation }), ...(existing.writtenBy && { writtenBy: existing.writtenBy }), ...forgotten, ...(forgetAfter && { forgetAfter }) };
      db.upsert('brain_facts', factRow(refreshed));
      return refreshed;
    }
    if (existing.static && !options.replaceStatic) {
      logger.warn('brain fact is static', { id });
      refused = true;
      return existing;
    }
    return versionFact(db, existing, { ...base, firstSeen: now, ...forgotten, ...(forgetAfter && { forgetAfter }) }, origin, by);
  });
  if (!refused) emitBrainChange({ kind: 'fact', key: id, ...(fact.projectId && { projectId: fact.projectId }), op: 'upsert', ...changeOrigin(origin, by), at: now }); // NB01
  return fact;
}

/** Facts not refreshed since `before` go stale (intended facts, static facts, the outcomes of applied suggestions and the statements people and flows added about an entity stay). */
export function staleFactsBefore(before: string, db: Database = database()): number {
  // SP13: the whole row goes back (subject_type is NOT NULL, and the check runs before ON CONFLICT), `last_seen` unchanged.
  const rows = db.all<FactRow & { id: string }>(
    `SELECT id, ${FACT_COLUMNS} FROM brain_facts WHERE status = 'active' AND is_latest = 1 AND is_static = 0 AND last_seen < ? AND kind <> 'intended' AND id NOT LIKE '%:change:pr_%' AND id NOT LIKE 'entity:%:fact_%'`,
    before,
  );
  const who = changeOrigin(); // NB01
  let staled = 0;
  for (const row of rows) {
    const fact = fromRow(row, true); // the whole row goes back, forget fields included
    if (!fact) continue;
    db.upsert('brain_facts', factRow({ ...fact, status: 'stale' }));
    staled++;
    emitBrainChange({ kind: 'fact', key: row.id, ...(fact.projectId && { projectId: fact.projectId }), op: 'upsert', ...who, at: new Date().toISOString() }); // NB01
  }
  return staled;
}

/** Delete a fact with its whole chain (admins; a forgotten fact is kept, not deleted). One change event, for the chain id. */
export function deleteFact(id: string, db: Database = database()): boolean {
  const fact = getFact(id, db, { includeForgotten: true }); // NB01
  const removed = db.delete('brain_facts', { root_id: fact?.rootId ?? id }) > 0;
  if (removed) emitBrainChange({ kind: 'fact', key: id, ...(fact?.projectId && { projectId: fact.projectId }), op: 'delete', ...changeOrigin(), at: new Date().toISOString() }); // NB01
  return removed;
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
  filter: {
    subjectType?: FactSubject;
    subjectId?: string;
    kind?: FactKind;
    status?: 'active' | 'stale' | 'all';
    scope?: UsageScope;
    limit?: number;
    /** Include earlier versions of a chain (default: the latest only). */
    history?: boolean;
    /** `exclude` (default) leaves forgotten facts out, `only` lists just them, `include` lists both. */
    forgotten?: 'exclude' | 'include' | 'only';
    now?: string;
  } = {},
  db: Database = database(),
): BrainFact[] {
  const now = filter.now ?? new Date().toISOString();
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
  // C01/C02: the latest-live rule is part of the query, so a long history never reaches memory.
  if (!filter.history) where.push('is_latest = 1');
  const forgotten = filter.forgotten ?? 'exclude';
  if (forgotten === 'exclude') {
    where.push('forgotten_at IS NULL AND (forget_after IS NULL OR forget_after > ?)');
    params.push(now);
  } else if (forgotten === 'only') {
    where.push('(forgotten_at IS NOT NULL OR (forget_after IS NOT NULL AND forget_after <= ?))');
    params.push(now);
  }
  // A scope filter runs in JS (the visible ids are not a column), so only then the limit has to wait for it.
  const scoped = Boolean(filter.scope && (filter.scope.workflows || filter.scope.agents));
  const limit = filter.limit ?? 500;
  const sql = `SELECT ${FACT_COLUMNS} FROM brain_facts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen DESC${scoped ? '' : ` LIMIT ${Math.max(0, Math.floor(limit))}`}`;
  return db
    .all<FactRow>(sql, ...params)
    .flatMap((r) => fromRow(r, forgotten !== 'exclude') ?? [])
    .filter((f) => inScope(f, filter.scope))
    .slice(0, limit);
}

/** A chain, oldest version first, from any of its ids, paged by version (`after` is the last version of the page before). */
export function factVersions(id: string, page: { limit: number; after?: number; withForget?: boolean }, db: Database = database()): { versions: BrainFact[]; next?: number } {
  const row = db.get<{ root_id: string | null }>('SELECT root_id FROM brain_facts WHERE id = ?', id);
  if (!row) return { versions: [] };
  const limit = Math.max(1, Math.min(100, Math.floor(page.limit)));
  const rows = db.all<FactRow>(`SELECT ${FACT_COLUMNS} FROM brain_facts WHERE root_id = ? AND version > ? ORDER BY version ASC LIMIT ${limit + 1}`, row.root_id ?? id, page.after ?? 0);
  const versions = rows.slice(0, limit).flatMap((r) => fromRow(r, page.withForget) ?? []);
  return { versions, ...(rows.length > limit && { next: versions.at(-1)?.version }) };
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
    facts: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM brain_facts WHERE status = 'active' AND ${LIVE_FACT}`, new Date().toISOString())?.n ?? 0),
    profiles: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM brain_profiles')?.n ?? 0),
  };
}
