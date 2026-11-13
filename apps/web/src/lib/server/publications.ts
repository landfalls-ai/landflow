/**
 * Which version of a workflow is published, and the publish timeline: the `workflow_publications` and
 * `workflow_publish_log` tables (lib/server/db). Data only; lib/server/publish.ts is what publishes and unpublishes
 * (it moves the triggers too).
 *
 * The `active` flag of a workflow follows its publication: a published workflow is active, an unpublished one is not.
 * Older clients that still save `active` keep working through `syncPublication()`, which the store calls on every
 * save: turning `active` on publishes the version just saved, turning it off unpublishes.
 *
 * This module must not import the store (the store calls syncPublication()) or versions.ts (which reads
 * publishedVersionId() to keep the published version out of pruning).
 */
import { randomBytes } from 'node:crypto';
import type { Workflow } from '@landflow/engine';
import type { PublishLogEntry, WorkflowPublication } from '../shared/publish';
import { currentActorId } from './auth/context';
import { database } from './db';
import { singleton } from './singleton';
import { logger } from './telemetry/logger';

const ID = /^[\w-]+$/;

interface PublicationRow {
  workflow_id: string;
  version_id: string;
  published_at: string;
  published_by: string | null;
  note: string | null;
  number: number | null;
}

interface LogRow {
  id: string;
  workflow_id: string;
  action: string;
  version_id: string | null;
  version_number: number | null;
  at: string;
  actor: string | null;
  note: string | null;
}

/** Called with the workflow id after its publication changed (publish, unpublish, rollback). */
const listeners = singleton('publication-listeners', () => new Set<(workflowId: string) => void>());

export function onPublicationChanged(listener: (workflowId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Listeners that also hear of publications other processes changed (queue mode: app webhooks and IMAP IDLE on the leader). */
const everywhere = singleton('publication-listeners-everywhere', () => new Set<(workflowId: string) => void>());

export function onPublicationChangedAnywhere(listener: (workflowId: string) => void): () => void {
  everywhere.add(listener);
  return () => everywhere.delete(listener);
}

function changed(workflowId: string, local = true) {
  for (const listener of [...(local ? listeners : []), ...everywhere]) {
    try {
      listener(workflowId);
    } catch (error) {
      logger.warn('publication listener failed', { error, 'landflow.workflow.id': workflowId });
    }
  }
}

/** Queue mode: another process changed a workflow's publication (only the listeners that asked for those hear of it). */
export function publicationChangedElsewhere(workflowId: string) {
  changed(workflowId, false);
}

const toPublication = (row: PublicationRow): WorkflowPublication => ({
  workflowId: row.workflow_id,
  versionId: row.version_id,
  ...(row.number !== null && { versionNumber: Number(row.number) }),
  publishedAt: row.published_at,
  ...(row.published_by && { publishedBy: row.published_by }),
  ...(row.note && { note: row.note }),
});

/** The published version of a workflow, if any. */
export function getPublication(workflowId: string): WorkflowPublication | undefined {
  if (!ID.test(workflowId)) return undefined;
  const row = database().get<PublicationRow>(
    `SELECT p.workflow_id, p.version_id, p.published_at, p.published_by, p.note, v.number
     FROM workflow_publications p LEFT JOIN workflow_versions v ON v.id = p.version_id WHERE p.workflow_id = ?`,
    workflowId,
  );
  return row ? toPublication(row) : undefined;
}

/** The id of the published version, if any. */
export function publishedVersionId(workflowId: string): string | undefined {
  if (!ID.test(workflowId)) return undefined;
  try {
    return database().get<{ version_id: string }>('SELECT version_id FROM workflow_publications WHERE workflow_id = ?', workflowId)?.version_id;
  } catch {
    return undefined;
  }
}

/** Published workflow ids with their versions (the boot check and the trigger reconciler). */
export function listPublications(): Array<{ workflowId: string; versionId: string }> {
  return database()
    .all<{ workflow_id: string; version_id: string }>('SELECT workflow_id, version_id FROM workflow_publications')
    .map((row) => ({ workflowId: row.workflow_id, versionId: row.version_id }));
}

function versionNumber(versionId: string): number | undefined {
  const row = database().get<{ number: number }>('SELECT number FROM workflow_versions WHERE id = ?', versionId);
  return row ? Number(row.number) : undefined;
}

function log(workflowId: string, action: PublishLogEntry['action'], versionId: string | undefined, by: string | undefined, note: string | undefined, at: string) {
  database().upsert('workflow_publish_log', {
    id: `pl_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`,
    workflow_id: workflowId,
    action,
    version_id: versionId,
    version_number: versionId ? versionNumber(versionId) : undefined,
    at,
    actor: by,
    note,
  });
}

/** Make `versionId` the published version (and log it). The caller checked that the version exists. */
export function setPublication(workflowId: string, versionId: string, by?: string, note?: string): WorkflowPublication {
  const at = new Date().toISOString();
  const db = database();
  const cleanNote = note?.trim() || undefined;
  db.transaction(() => {
    db.upsert('workflow_publications', { workflow_id: workflowId, version_id: versionId, published_at: at, published_by: by, note: cleanNote });
    log(workflowId, 'publish', versionId, by, cleanNote, at);
  });
  changed(workflowId);
  return getPublication(workflowId)!;
}

/** Unpublish (and log it). Returns whether the workflow was published. */
export function clearPublication(workflowId: string, by?: string, note?: string): boolean {
  const db = database();
  const previous = publishedVersionId(workflowId);
  if (!previous) return false;
  db.transaction(() => {
    db.delete('workflow_publications', { workflow_id: workflowId });
    log(workflowId, 'unpublish', previous, by, note?.trim() || undefined, new Date().toISOString());
  });
  changed(workflowId);
  return true;
}

/** Publishes and unpublishes of a workflow, newest first. */
export function publishLog(workflowId: string, limit = 50): PublishLogEntry[] {
  if (!ID.test(workflowId)) return [];
  return database()
    .all<LogRow>('SELECT id, workflow_id, action, version_id, version_number, at, actor, note FROM workflow_publish_log WHERE workflow_id = ? ORDER BY at DESC, id DESC LIMIT ?', workflowId, limit)
    .map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      action: row.action === 'unpublish' ? 'unpublish' : 'publish',
      ...(row.version_id && { versionId: row.version_id }),
      ...(row.version_number !== null && { versionNumber: Number(row.version_number) }),
      at: row.at,
      ...(row.actor && { by: row.actor }),
      ...(row.note && { note: row.note }),
    }));
}

/**
 * Forget a deleted workflow's publication and timeline. Listeners are not told here: the returned function tells them,
 * and a caller inside a larger transaction calls it after the commit (a rollback must not have announced anything).
 */
export function deletePublications(workflowId: string): () => void {
  if (!ID.test(workflowId)) return () => {};
  const db = database();
  const had = Boolean(publishedVersionId(workflowId));
  db.transaction(() => {
    db.delete('workflow_publications', { workflow_id: workflowId });
    db.delete('workflow_publish_log', { workflow_id: workflowId });
  });
  return had ? () => changed(workflowId) : () => {};
}

/**
 * Keep the publication in line with a saved workflow's `active` flag (the store calls it inside the save's
 * transaction, with the version the save recorded or matched): active without a publication publishes that version,
 * inactive with one unpublishes. Saving an active workflow otherwise changes only the draft.
 */
export function syncPublication(saved: Workflow, versionId: string | undefined): void {
  try {
    const published = publishedVersionId(saved.id);
    if (saved.active && !published && versionId) setPublication(saved.id, versionId, currentActorId(), 'Activated');
    else if (!saved.active && published) clearPublication(saved.id, currentActorId(), 'Deactivated');
  } catch (error) {
    logger.warn('could not sync the publication with the active flag', { error, 'landflow.workflow.id': saved.id });
  }
}
