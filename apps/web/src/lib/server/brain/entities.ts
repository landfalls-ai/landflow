/**
 * The entity registry (docs/second-brain.md#entities): the initiatives, people, customers and systems the brain reasons
 * about next to workflows and agents. An entity is a row of `brain_entities` (type, id, name, description, owner,
 * project, flat attrs); the brain learns facts about it and files suggestions about it, addressed as `entity:<type>/<id>`
 * (fact subjectType `entity`, subjectId `<type>/<id>`).
 *
 * Who sees one: an entity lives in a project (its creator's personal project unless another is named), and the people who
 * can open that project see it; owners and admins see all. Without a project it belongs to the default project, like a
 * workflow without a row. Reading and writing here is not checked: the routes and nodes check with `canEntity` / scopes.
 */
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { ATTR_NAME, ENTITY_ID, entityRef, isEntityType, type BrainEntity, type BrainFact, type EntityKnowledge, type EntityType, type FactKind, type Proposal, type ProposalEvidence } from '../../shared/brain';
import { projectRoleCan } from '../../shared/projects';
import { getUser } from '../auth/users';
import { database, type Database } from '../db';
import { projectRole, visibleProjectIds, type Actor } from '../projects/access';
import { defaultProjectId } from '../projects/store';
import type { UsageScope } from '../usage/query';
import { getProfile, listFacts, upsertFact } from './facts';
import { HttpError } from '../errors';

export class EntityError extends HttpError {
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

interface Row {
  type: string;
  id: string;
  name: string;
  description: string;
  owner: string;
  project_id: string | null;
  attrs: string;
  source: string;
  created_at: string;
  updated_at: string;
}

const MAX_ATTRS = 20;
const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function fromRow(row: Row): BrainEntity {
  const owner = row.owner || undefined;
  const user = owner ? getUser(owner) : undefined;
  return {
    type: row.type as EntityType,
    id: row.id,
    name: row.name,
    ...(row.description && { description: row.description }),
    ...(owner && { owner }),
    ...(owner && { ownerName: user?.name || owner }),
    ...(row.project_id && { projectId: row.project_id }),
    attrs: parse<BrainEntity['attrs']>(row.attrs, {}),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `<type>/<id>`, the key facts, suggestions and scopes use. */
export const entityKey = (entity: Pick<BrainEntity, 'type' | 'id'>) => entityRef(entity.type, entity.id);

/** The project an entity belongs to: its own, else the default one. */
export const entityProject = (entity: Pick<BrainEntity, 'projectId'>): string | undefined => entity.projectId ?? defaultProjectId();

export function getEntity(type: string, id: string, db: Database = database()): BrainEntity | undefined {
  const row = db.get<Row>('SELECT * FROM brain_entities WHERE type = ? AND id = ?', type, id);
  return row && fromRow(row);
}

export interface EntityFilter {
  type?: string;
  /** A user id or name; matches the owner as stored or by the user's name. */
  owner?: string;
  /** Words in the name, description or owner. */
  text?: string;
  projectId?: string;
  /** What the caller can see; undefined: everything. */
  scope?: UsageScope;
  limit?: number;
}

export function listEntities(filter: EntityFilter = {}, db: Database = database()): BrainEntity[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.type) {
    where.push('type = ?');
    params.push(filter.type);
  }
  if (filter.projectId) {
    where.push('project_id = ?');
    params.push(filter.projectId);
  }
  const rows = db.all<Row>(`SELECT * FROM brain_entities ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`, ...params);
  const owner = filter.owner?.trim().toLowerCase();
  const words = (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .map(fromRow)
    .filter((e) => !filter.scope || !filter.scope.entities || filter.scope.entities.has(entityKey(e)))
    .filter((e) => !owner || [e.owner, e.ownerName].some((o) => o?.toLowerCase() === owner))
    .filter((e) => {
      if (!words.length) return true;
      const haystack = `${e.name} ${e.description ?? ''} ${e.ownerName ?? ''} ${Object.values(e.attrs).join(' ')}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .slice(0, filter.limit ?? 500);
}

export const countEntities = (db: Database = database()): number => Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM brain_entities')?.n ?? 0);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface EntityInput {
  type: string;
  /** Given: create it or update the one with this id. Absent: a new entity, id from the name. */
  id?: string;
  name?: string;
  description?: string;
  owner?: string;
  projectId?: string;
  /** Merged into the attrs it has; a null value removes one. */
  attrs?: Record<string, unknown>;
  source?: string;
}

function cleanAttrs(current: BrainEntity['attrs'], given: Record<string, unknown> | undefined): BrainEntity['attrs'] {
  const next = { ...current };
  for (const [key, value] of Object.entries(given ?? {})) {
    if (!ATTR_NAME.test(key)) throw new EntityError(`“${key}” isn’t an attribute name: letters, digits and underscores, starting with a letter (40 at most)`);
    if (value === null) delete next[key];
    else if (typeof value === 'string') next[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean') next[key] = value;
    else throw new EntityError(`The attribute “${key}” must be text, a number or true/false`);
  }
  if (Object.keys(next).length > MAX_ATTRS) throw new EntityError(`An entity keeps at most ${MAX_ATTRS} attributes`);
  return next;
}

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Create an entity, or update the one with `input.id` (fields left out stay). */
export function upsertEntity(input: EntityInput, db: Database = database(), now = new Date().toISOString()): { entity: BrainEntity; created: boolean } {
  if (!isEntityType(input.type)) throw new EntityError(`Unknown entity type “${input.type}”`);
  const id = input.id?.trim() || undefined;
  if (id && !ENTITY_ID.test(id)) throw new EntityError('An entity id is lowercase letters, digits, “_”, “-” and “.” (64 at most)');
  const existing = id ? getEntity(input.type, id, db) : undefined;
  const name = (input.name ?? existing?.name ?? '').trim();
  if (!name) throw new EntityError('An entity needs a name');
  const finalId = id ?? `${slugOf(name) || input.type}-${randomBytes(2).toString('hex')}`;
  const entity: BrainEntity = {
    type: input.type,
    id: finalId,
    name: name.slice(0, 120),
    ...((input.description ?? existing?.description) && { description: (input.description ?? existing?.description ?? '').trim().slice(0, 1_000) }),
    ...((input.owner ?? existing?.owner) && { owner: (input.owner ?? existing?.owner ?? '').trim().slice(0, 120) }),
    ...((input.projectId ?? existing?.projectId) && { projectId: input.projectId ?? existing?.projectId }),
    attrs: cleanAttrs(existing?.attrs ?? {}, input.attrs),
    source: existing?.source ?? input.source ?? 'api',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  // Clearing a field: an empty string removes the description or owner.
  if (!entity.description) delete entity.description;
  if (!entity.owner) delete entity.owner;
  database_upsert(db, entity);
  return { entity: getEntity(entity.type, entity.id, db)!, created: !existing };
}

function database_upsert(db: Database, e: BrainEntity) {
  db.upsert('brain_entities', {
    type: e.type,
    id: e.id,
    name: e.name,
    description: e.description ?? '',
    owner: e.owner ?? '',
    project_id: e.projectId ?? null,
    attrs: JSON.stringify(e.attrs),
    source: e.source,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  });
}

/** Delete an entity with what the brain held about it: its facts and profile go, its open suggestions expire. */
export function deleteEntity(type: string, id: string, db: Database = database()): boolean {
  const entity = getEntity(type, id, db);
  if (!entity) return false;
  const ref = entityKey(entity);
  db.delete('brain_entities', { type, id });
  db.delete('brain_facts', { subject_type: 'entity', subject_id: ref });
  db.delete('brain_profiles', { subject_type: 'entity', subject_id: ref });
  db.delete('brain_pages', { subject: ref });
  const now = new Date().toISOString();
  for (const row of db.all<{ data: string }>("SELECT data FROM proposals WHERE status IN ('open', 'snoozed')")) {
    const p = parse<Proposal | undefined>(row.data, undefined);
    if (p?.target.type !== 'entity' || p.target.id !== ref) continue;
    const next: Proposal = { ...p, status: 'expired', updatedAt: now, note: 'The entity was deleted' };
    db.upsert('proposals', { id: p.id, fingerprint: p.fingerprint, source: p.source, detector: p.detector ?? null, project_id: p.projectId ?? null, workflow_id: null, status: 'expired', score: p.score, created_at: p.createdAt, updated_at: now, data: JSON.stringify(next) });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Facts and knowledge
// ---------------------------------------------------------------------------

/** Facts a person or a flow wrote have ids with this marker, so the study never stales them away (facts.ts staleFactsBefore). */
export const MANUAL_FACT = 'fact_';

/** Add a statement about an entity (kept until someone deletes it). */
export function addEntityFact(entity: BrainEntity, input: { kind: FactKind; statement: string; confidence?: number; evidence?: ProposalEvidence[] }, db: Database = database()): BrainFact {
  const statement = input.statement.trim();
  if (!statement) throw new EntityError('A fact needs a statement');
  return upsertFact(
    {
      id: `entity:${entityKey(entity)}:${input.kind}:${MANUAL_FACT}${nanoid(8)}`,
      subjectType: 'entity',
      subjectId: entityKey(entity),
      subjectName: entity.name,
      kind: input.kind,
      statement: statement.slice(0, 1_000),
      evidence: input.evidence ?? [],
      confidence: input.confidence ?? 0.8,
      ...(entity.projectId && { projectId: entity.projectId }),
    },
    db,
  );
}

/** The entity with its profile, facts and open suggestions (what GET /api/entities/:type/:id and Entity Knowledge return). */
export function entityKnowledge(entity: BrainEntity, proposals: (ref: string) => Proposal[], db: Database = database()): EntityKnowledge {
  const ref = entityKey(entity);
  return { entity, profile: getProfile('entity', ref, db), facts: listFacts({ subjectType: 'entity', subjectId: ref, limit: 100 }, db), proposals: proposals(ref) };
}

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

/** The entities `actor` sees, as `<type>/<id>` (undefined: all of them, for owners and admins). */
export function entityKeysFor(actor: Actor, db: Database = database()): Set<string> | undefined {
  const projects = visibleProjectIds(actor);
  if (!projects) return undefined;
  return new Set(listEntities({}, db).filter((e) => {
    const project = entityProject(e);
    return project !== undefined && projects.has(project);
  }).map(entityKey));
}

/** The entities that live in `projectId`. */
export const entityKeysIn = (projectId: string, db: Database = database()): Set<string> => new Set(listEntities({ projectId }, db).map(entityKey));

/** Whether `actor` may read (a member of its project) or change (an editor or admin there) an entity. */
export function canEntity(actor: Actor, entity: Pick<BrainEntity, 'projectId'>, action: 'read' | 'update'): boolean {
  const role = projectRole(actor, entityProject(entity));
  return action === 'read' ? Boolean(role) : projectRoleCan.create(role);
}
