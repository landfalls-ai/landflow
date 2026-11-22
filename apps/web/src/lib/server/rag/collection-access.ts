/**
 * C21: who may use a vector collection. A collection has an owner project, recorded the first time a project writes to it (or
 * by the one-time adoption of what existed before, or by an admin); any other project reads or writes it only through a grant
 * an admin of the owner gave. The Vector Store nodes, the agents' knowledge bases, project knowledge, the memory playground
 * and the architect's listings all ask here, as the HOME project of the workflow or agent that asks (never the run's project,
 * which a provider may set to another). A collection nobody owns stays open until a project writes it.
 *
 * Reads come from the host's own database copy (the replicated one), so a check is one primary-key read, never per item; a
 * second process hears a change through the replication like every other table. A claim is decided in Postgres in queue mode.
 *
 * `write` implies `read`: there is no write-only grant. So the counts a write reports (chunks embedded, reused, removed) tell a
 * writer nothing it could not read from the collection itself.
 */
import { ALL_PROJECTS_GRANT, ADOPTED_KEY, COLLECTION_LEVELS, LOST_LEVEL, brainReadAllowed, notionKeyOf, partsOfKey, type CollectionAccess, type CollectionLevel, type CollectionView, type OwnerSource, type ProjectCollections, type StoreKind } from '../../shared/collections';
import { projectRoleCan } from '../../shared/projects';
import { recordAudit } from '../audit';
import { authDb } from '../auth/db';
import type { Database } from '../db';
import { refreshRows, replicating } from '../db/replication';
import { HttpError } from '../errors';
import { isInstanceAdmin, projectRole } from '../projects/access';
import { getProject, listProjects, ProjectError } from '../projects/store';
import { singleton } from '../singleton';
import type { Actor } from '../projects/access';
import { planAdoption, type AdoptionPlan } from './collection-adoption';

export interface CollectionRow {
  store_key: string;
  store: string;
  name: string;
  owner_project_id: string;
  claimed_by: string | null;
  claimed_at: string;
  source: string;
}
interface GrantRow {
  store_key: string;
  project_id: string;
  level: string;
  created_by: string | null;
  created_at: string;
}

const db = (): Database => authDb();
const nowIso = () => new Date().toISOString();

/** Who is asking: the kind of resource (the message says "This workflow’s project …") and its home project. */
export interface Asker {
  projectId: string | undefined;
  subject: 'workflow' | 'agent' | 'project';
}

/** D7: the same message for a collection that is not there and one that is not allowed. */
export class CollectionAccessError extends HttpError {
  static readonly errorName: string = 'CollectionAccessError';
  constructor(name: string, subject: Asker['subject']) {
    super(subject === 'project' ? `This project can’t use the collection “${name.trim()}”` : `This ${subject}’s project can’t use the collection “${name.trim()}”`, 403, { expose: true });
  }
}

// ---------------------------------------------------------------------------
// The one-time adoption of what existed before (C21-D2, strict)
// ---------------------------------------------------------------------------

export interface AdoptionReport {
  at: string;
  collections: number;
  lost: Array<{ key: string; projectId: string }>;
  unresolved: string[];
}

const adoptedFor = () => singleton('collection-adopted', () => new WeakSet<Database>());
const adopting = () => singleton('collection-adopting', () => ({ running: false }));

/** Run the adoption before the first check after the upgrade: the marker row makes it once per database. */
function ensureAdopted(): void {
  const handle = db();
  if (adoptedFor().has(handle) || adopting().running) return;
  adopting().running = true;
  try {
    if (!handle.get('SELECT store_key FROM vector_collections WHERE store_key = ?', ADOPTED_KEY)) runAdoption(handle, false);
    adoptedFor().add(handle);
  } finally {
    adopting().running = false;
  }
}

/** Apply `planAdoption()`: owners for collections nobody claimed, a `lost` row for every other naming project. */
function runAdoption(handle: Database, again: boolean): AdoptionReport {
  const plan: AdoptionPlan = planAdoption();
  const at = nowIso();
  const lost: AdoptionReport['lost'] = [];
  const created: Array<{ key: string; projectId: string }> = [];
  handle.transaction(() => {
    for (const owner of plan.owners) {
      const claimed = handle.get<CollectionRow>('SELECT * FROM vector_collections WHERE store_key = ?', owner.key);
      if (!claimed) {
        handle.insertNew('vector_collections', { store_key: owner.key, store: owner.store, name: owner.name, owner_project_id: owner.ownerProjectId, claimed_by: null, claimed_at: at, source: 'upgrade' });
        created.push({ key: owner.key, projectId: owner.ownerProjectId });
      }
      // The owner is the claim that stands: anything an admin or a first write decided before this run is kept.
      const standing = claimed?.owner_project_id ?? owner.ownerProjectId;
      for (const projectId of owner.lost) {
        if (projectId === standing) continue;
        if (handle.get('SELECT store_key FROM vector_collection_grants WHERE store_key = ? AND project_id = ?', owner.key, projectId)) continue;
        if (handle.insertNew('vector_collection_grants', { store_key: owner.key, project_id: projectId, level: LOST_LEVEL, created_by: null, created_at: at })) lost.push({ key: owner.key, projectId });
      }
    }
    const report: AdoptionReport = { at, collections: created.length, lost, unresolved: plan.unresolved.slice(0, 50) };
    handle.upsert('vector_collections', { store_key: ADOPTED_KEY, store: 'adoption', name: JSON.stringify(report).slice(0, 60_000), owner_project_id: '', claimed_by: null, claimed_at: at, source: 'upgrade' });
  });
  const projectName = (id: string) => getProject(id)?.name ?? id;
  for (const { key, projectId } of lost) {
    const owner = handle.get<CollectionRow>('SELECT * FROM vector_collections WHERE store_key = ?', key);
    recordAudit({
      action: 'collection.access_lost',
      actor: 'system',
      target: { type: 'collection', id: key, name: partsOfKey(key).name },
      project: projectId,
      summary: `Project “${projectName(projectId)}” lost access to “${partsOfKey(key).name}” (now owned by “${projectName(owner?.owner_project_id ?? '')}”) in the upgrade; an admin of the owner can grant it back`,
      details: { collection: key, from: 'open', to: 'none', ownerProject: owner?.owner_project_id ?? null },
    });
  }
  recordAudit({
    action: 'collection.adopted',
    actor: 'system',
    project: null,
    summary: `${again ? 'Looked for owners again' : 'Gave existing collections their owners'}: ${created.length} collection(s) adopted, ${lost.length} project(s) lost access, ${plan.unresolved.length} name(s) not found`,
    details: { adopted: created.length, lost: lost.map((l) => `${l.key} → ${l.projectId}`).slice(0, 100), notFound: plan.unresolved.slice(0, 50), again },
  });
  return { at, collections: created.length, lost, unresolved: plan.unresolved };
}

/** The last adoption's report, for the instance admin's view. */
export function lastAdoption(): AdoptionReport | undefined {
  ensureAdopted();
  const row = db().get<CollectionRow>('SELECT * FROM vector_collections WHERE store_key = ?', ADOPTED_KEY);
  try {
    return row ? (JSON.parse(row.name) as AdoptionReport) : undefined;
  } catch {
    return undefined;
  }
}

/** Instance admin: find owners again (what is already owned is kept; a project that lost access is listed again only if new). */
export function adoptAgain(actor: Actor): AdoptionReport {
  requireInstanceAdmin(actor);
  ensureAdopted();
  return runAdoption(db(), true);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const ownerRow = (key: string) => db().get<CollectionRow>('SELECT * FROM vector_collections WHERE store_key = ?', key);

/** What `projectId` may do with the collection at `key` (see CollectionAccess). A project of none uses only unclaimed ones. */
export function collectionAccess(key: string, projectId: string | undefined): CollectionAccess {
  ensureAdopted();
  const row = ownerRow(key);
  if (!row) return 'unclaimed';
  if (!projectId) return 'none';
  if (row.owner_project_id === projectId) return 'owner';
  let best: CollectionLevel | undefined;
  for (const grant of db().all<GrantRow>('SELECT * FROM vector_collection_grants WHERE store_key = ? AND project_id IN (?, ?)', key, projectId, ALL_PROJECTS_GRANT)) {
    if (grant.level === 'write') return 'write';
    if (grant.level === 'read') best = 'read';
  }
  return best ?? 'none';
}

/** The project that owns the collection at `key`, if any. */
export function ownerProjectOf(key: string): string | undefined {
  ensureAdopted();
  return key === ADOPTED_KEY ? undefined : ownerRow(key)?.owner_project_id;
}

/** Whether the project may read the collection (an owner, a grantee, or nobody owns it yet). */
export function canReadCollection(key: string, projectId: string | undefined): boolean {
  return collectionAccess(key, projectId) !== 'none';
}

/** Throws the D7 message unless `asker` may read. Synchronous: an agent's tool is refused when it is built. */
export function assertCanRead(key: string, name: string, asker: Asker): void {
  if (!canReadCollection(key, asker.projectId)) throw new CollectionAccessError(name, asker.subject);
}

/** Claim an unowned collection for the first project to write it. Decided in Postgres in queue mode. True: this project owns it. */
export async function claimCollection(handle: Database, row: CollectionRow): Promise<boolean> {
  if (handle.kind !== 'postgres') return handle.transaction(() => (handle.get('SELECT store_key FROM vector_collections WHERE store_key = ?', row.store_key) ? false : handle.insertNew('vector_collections', { ...row })));
  await handle.flush();
  const result = await handle.direct(async (client) => {
    const inserted = await client.query('INSERT INTO vector_collections (store_key, store, name, owner_project_id, claimed_by, claimed_at, source) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING store_key', [row.store_key, row.store, row.name, row.owner_project_id, row.claimed_by, row.claimed_at, row.source]);
    const payload = inserted.rows.length ? handle.keyNotice('vector_collections', [row.store_key]) : undefined;
    if (payload) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', payload]);
    return inserted.rows.length > 0;
  });
  if (result) handle.upsertLocal('vector_collections', { ...row });
  else await handle.refresh('vector_collections', { store_key: row.store_key });
  return Boolean(result);
}

/**
 * Throws the D7 message unless `asker` may write (insert, clear, delete): the owner, or a `write` grant. A collection nobody
 * owns is claimed for the asker's project here (audited); two projects racing: one owns it, the other is refused. A caller with
 * no project may write an unclaimed collection but never claims it.
 */
export async function assertCanWrite(key: string, store: StoreKind, name: string, asker: Asker): Promise<void> {
  if (replicating()) await refreshRows('vector_collections', { store_key: key });
  const access = collectionAccess(key, asker.projectId);
  if (access === 'owner' || access === 'write') return;
  if (access !== 'unclaimed') throw new CollectionAccessError(name, asker.subject);
  if (!asker.projectId) return;
  const won = await claimCollection(db(), { store_key: key, store, name: name.trim(), owner_project_id: asker.projectId, claimed_by: null, claimed_at: nowIso(), source: 'first-write' satisfies OwnerSource });
  if (!won) {
    const after = collectionAccess(key, asker.projectId);
    if (after === 'owner' || after === 'write') return;
    throw new CollectionAccessError(name, asker.subject);
  }
  recordAudit({
    action: 'collection.claimed',
    actor: 'system',
    target: { type: 'collection', id: key, name: name.trim() },
    project: asker.projectId,
    summary: `Project “${getProject(asker.projectId)?.name ?? asker.projectId}” now owns the ${store} collection “${name.trim()}” (first write)`,
    details: { collection: key, store, from: 'unowned', to: asker.projectId, source: 'first-write' },
  });
}

// ---------------------------------------------------------------------------
// The brain's closed names (FR-6, FR-7)
// ---------------------------------------------------------------------------

/** FR-7: whether `projectId`'s admin let its own flows read `landflow-notion-<project>`. */
export function notionReadOn(projectId: string): boolean {
  return Boolean(db().get('SELECT store_key FROM vector_collection_grants WHERE store_key = ? AND project_id = ? AND level = ?', notionKeyOf(projectId), projectId, 'read'));
}

/** Whether a Vector Store node of `projectId` may READ the brain-named collection `name` (only the project's own Notion knowledge, switched on). */
export function brainReadFor(name: string, projectId: string | undefined): boolean {
  return brainReadAllowed(name, projectId, projectId ? notionReadOn(projectId) : false);
}

// ---------------------------------------------------------------------------
// Grants, transfers and the views
// ---------------------------------------------------------------------------

const requireInstanceAdmin = (actor: Actor | undefined) => {
  if (!isInstanceAdmin(actor)) throw new ProjectError('Only owners and admins can do this', 403);
};

/** The owner row of a collection an admin manages; 404 when nothing is owned there. */
function ownedBy(actor: Actor, key: string): CollectionRow {
  ensureAdopted();
  const row = ownerRow(key);
  const role = row && projectRole(actor, row.owner_project_id);
  if (!row || key === ADOPTED_KEY || !role) throw new ProjectError('Collection not found', 404);
  if (!projectRoleCan.manage(role)) throw new ProjectError(`Only admins of “${getProject(row.owner_project_id)?.name ?? 'the owning project'}” can change who uses this collection`, 403);
  return row;
}

const actorOf = (actor: Actor) => ({ id: actor.id });
const nameOfProject = (projectId: string) => (projectId === ALL_PROJECTS_GRANT ? 'All projects' : (getProject(projectId)?.name ?? projectId));

/** An admin of the owner project (or an instance admin) lets `projectId` (or every project, `*`) read or write. Audited. */
export function grantCollection(actor: Actor, key: string, projectId: string, level: CollectionLevel): void {
  if (!COLLECTION_LEVELS.includes(level)) throw new ProjectError('A grant is read or write');
  const row = ownedBy(actor, key);
  if (projectId !== ALL_PROJECTS_GRANT && !getProject(projectId)) throw new ProjectError('Project not found', 404);
  if (projectId === row.owner_project_id) throw new ProjectError('The owner project already has full access');
  const handle = db();
  const before = handle.get<GrantRow>('SELECT * FROM vector_collection_grants WHERE store_key = ? AND project_id = ?', key, projectId);
  handle.upsert('vector_collection_grants', { store_key: key, project_id: projectId, level, created_by: actor.id, created_at: nowIso() });
  recordAudit({
    action: 'collection.granted',
    actor: actorOf(actor),
    target: { type: 'collection', id: key, name: row.name },
    project: row.owner_project_id,
    summary: `Gave ${nameOfProject(projectId)} ${level} access to “${row.name}”`,
    details: { collection: key, grantee: projectId, from: before && before.level !== LOST_LEVEL ? before.level : 'none', to: level },
  });
}

/** Stop sharing with `projectId` (also dismisses a "lost access" notice). Audited. */
export function revokeCollection(actor: Actor, key: string, projectId: string): void {
  const row = ownedBy(actor, key);
  const handle = db();
  const before = handle.get<GrantRow>('SELECT * FROM vector_collection_grants WHERE store_key = ? AND project_id = ?', key, projectId);
  if (!before) throw new ProjectError('No such grant', 404);
  handle.delete('vector_collection_grants', { store_key: key, project_id: projectId });
  recordAudit({
    action: 'collection.revoked',
    actor: actorOf(actor),
    target: { type: 'collection', id: key, name: row.name },
    project: row.owner_project_id,
    summary: before.level === LOST_LEVEL ? `Dismissed the notice that ${nameOfProject(projectId)} lost access to “${row.name}”` : `Stopped sharing “${row.name}” with ${nameOfProject(projectId)}`,
    details: { collection: key, grantee: projectId, from: before.level, to: 'none' },
  });
}

/** FR-7: an admin of the project turns on (or off) its own flows reading its Notion knowledge collection. Audited. */
export function setNotionRead(actor: Actor, projectId: string, on: boolean): void {
  const role = projectRole(actor, projectId);
  if (!role) throw new ProjectError('Project not found', 404);
  if (!projectRoleCan.manage(role)) throw new ProjectError(`Only admins of “${getProject(projectId)?.name ?? 'this project'}” can change this`, 403);
  const key = notionKeyOf(projectId);
  const handle = db();
  const was = notionReadOn(projectId);
  if (was === on) return;
  if (on) handle.upsert('vector_collection_grants', { store_key: key, project_id: projectId, level: 'read', created_by: actor.id, created_at: nowIso() });
  else handle.delete('vector_collection_grants', { store_key: key, project_id: projectId });
  recordAudit({
    action: on ? 'collection.granted' : 'collection.revoked',
    actor: actorOf(actor),
    target: { type: 'collection', id: key, name: partsOfKey(key).name },
    project: projectId,
    summary: on ? 'Let this project’s flows read its Notion knowledge' : 'Stopped letting this project’s flows read its Notion knowledge',
    details: { collection: key, grantee: projectId, from: was ? 'read' : 'none', to: on ? 'read' : 'none' },
  });
}

/** Instance admin: move a collection to another project (its grants stay, except the new owner's own). Audited. */
export function transferCollection(actor: Actor, key: string, toProjectId: string): void {
  requireInstanceAdmin(actor);
  ensureAdopted();
  const row = ownerRow(key);
  if (!row || key === ADOPTED_KEY) throw new ProjectError('Collection not found', 404);
  if (!getProject(toProjectId)) throw new ProjectError('Project not found', 404);
  if (row.owner_project_id === toProjectId) return;
  const handle = db();
  handle.transaction(() => {
    handle.upsert('vector_collections', { ...row, owner_project_id: toProjectId, claimed_by: actor.id, claimed_at: nowIso(), source: 'admin' });
    handle.delete('vector_collection_grants', { store_key: key, project_id: toProjectId });
  });
  recordAudit({
    action: 'collection.transferred',
    actor: actorOf(actor),
    target: { type: 'collection', id: key, name: row.name },
    project: toProjectId,
    summary: `Moved “${row.name}” from ${nameOfProject(row.owner_project_id)} to ${nameOfProject(toProjectId)}`,
    details: { collection: key, from: row.owner_project_id, to: toProjectId },
  });
}

const viewOf = (row: CollectionRow, access: CollectionView['access'], detail: boolean): CollectionView => {
  const { store, name } = partsOfKey(row.store_key);
  const grants = detail ? db().all<GrantRow>('SELECT * FROM vector_collection_grants WHERE store_key = ? ORDER BY project_id', row.store_key) : [];
  return {
    key: row.store_key,
    store,
    name: row.name || name,
    access,
    ownerProjectId: row.owner_project_id,
    ownerName: getProject(row.owner_project_id)?.name ?? row.owner_project_id,
    source: row.source as OwnerSource,
    ...(detail && {
      grants: grants.filter((g) => g.level !== LOST_LEVEL).map((g) => ({ projectId: g.project_id, projectName: nameOfProject(g.project_id), level: g.level as CollectionLevel })),
      lostAccess: grants.filter((g) => g.level === LOST_LEVEL).map((g) => ({ projectId: g.project_id, projectName: nameOfProject(g.project_id) })),
    }),
  };
};

/** What GET /api/projects/:id/collections answers: owned and granted, with grants for the owner's admins. */
export function projectCollections(projectId: string, canManage: boolean): ProjectCollections {
  ensureAdopted();
  const handle = db();
  const rows = handle.all<CollectionRow>('SELECT * FROM vector_collections WHERE store_key != ? ORDER BY name, store_key', ADOPTED_KEY);
  const collections: CollectionView[] = [];
  for (const row of rows) {
    if (row.owner_project_id === projectId) {
      collections.push(viewOf(row, 'owner', canManage));
      continue;
    }
    const access = collectionAccess(row.store_key, projectId);
    if (access === 'read' || access === 'write') collections.push(viewOf(row, access, false));
  }
  const lost = handle
    .all<GrantRow>('SELECT * FROM vector_collection_grants WHERE project_id = ? AND level = ?', projectId, LOST_LEVEL)
    .flatMap((grant) => {
      const row = ownerRow(grant.store_key);
      return row ? [{ key: grant.store_key, ...partsOfKey(grant.store_key), name: row.name, ownerProjectId: row.owner_project_id, ownerName: getProject(row.owner_project_id)?.name ?? row.owner_project_id }] : [];
    });
  return { collections, lost, canManage, notion: null };
}

/** Instance admin: every claimed collection with its owner and grants, and the last adoption's report. */
export function allCollections(actor: Actor): { collections: CollectionView[]; adoption: AdoptionReport | undefined; projects: Array<{ id: string; name: string }> } {
  requireInstanceAdmin(actor);
  ensureAdopted();
  const rows = db().all<CollectionRow>('SELECT * FROM vector_collections WHERE store_key != ? ORDER BY name, store_key', ADOPTED_KEY);
  return { collections: rows.map((row) => viewOf(row, 'owner', true)), adoption: lastAdoption(), projects: listProjects().map((p) => ({ id: p.id, name: p.name })) };
}
