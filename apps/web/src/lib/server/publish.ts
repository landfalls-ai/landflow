/**
 * Draft and publish. Every save of a workflow is a draft version (lib/server/versions.ts); production triggers run
 * only the published one: webhooks, forms, schedules, polls, MCP Server Triggers, app webhook triggers, hosted chat,
 * error workflows and Execute Workflow calls from production runs. Manual runs in the editor use the draft.
 *
 * `publishVersion()` is the one way to publish (the editor's Publish button, rollback from the version history, the
 * API, a legacy `active: true` save through the store); it marks the version published, turns the workflow active
 * and (re)registers its app webhook triggers (lib/server/app-webhooks.ts). `unpublishWorkflow()` undoes all three.
 *
 * Workflows that were active before draft and publish existed count as published at their newest version
 * (migration 200, and `ensurePublications()` at boot for data imported after it).
 */
import type { ExecutionMode } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import type { PublicationStatus, PublishResult } from '../shared/publish';
import type { WorkflowVersion } from '../shared/types';
import { userNames } from './auth/users';
import { database } from './db';
import { publishBlockedReason } from './governance/policy';
import { clearPublication, deletePublications, getPublication, listPublications, publishLog, publishedVersionId, setPublication } from './publications';
import { singleton } from './singleton';
import { store } from './store';
import { logger } from './telemetry/logger';
import { applyVersion, getVersion, listVersions, recordVersion, versionFor } from './versions';

export class PublishError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// The production graph
// ---------------------------------------------------------------------------

/** Published snapshots by version id (immutable), the newest few. */
const snapshots = singleton('published-snapshots', () => new Map<string, Workflow>());
/** The merged production workflow per saved workflow object (a save replaces the object, so entries go with it). */
const merged = singleton('production-workflows', () => new WeakMap<Workflow, { versionId: string; workflow: Workflow }>());
const warned = singleton('production-warned', () => new Set<string>());
const MAX_SNAPSHOTS = 200;

function snapshot(workflowId: string, versionId: string): Workflow | undefined {
  const cached = snapshots.get(versionId);
  if (cached) return cached;
  const version = getVersion(workflowId, versionId);
  if (!version) return undefined;
  if (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(versionId, version.workflow);
  return version.workflow;
}

/**
 * What production triggers run for a saved workflow: the published version's nodes, connections, settings, sticky
 * notes and pin data, with the saved workflow's name, tags, folder and active flag. Undefined when it isn't published.
 */
export function productionWorkflow(workflow: Workflow): Workflow | undefined {
  if (!workflow.active) return undefined;
  const versionId = publishedVersionId(workflow.id);
  // Active but not published yet (data imported after the boot check): it runs as saved until it is published.
  if (!versionId) return workflow;
  const hit = merged.get(workflow);
  if (hit?.versionId === versionId) return hit.workflow;
  const published = snapshot(workflow.id, versionId);
  if (!published) {
    if (!warned.has(versionId)) {
      warned.add(versionId);
      logger.warn('the published version of a workflow is missing; its triggers are off until it is published again', { 'landflow.workflow.id': workflow.id, 'landflow.version.id': versionId });
    }
    return undefined;
  }
  // applyVersion reads only the snapshot.
  const production = applyVersion(workflow, { workflow: published } as WorkflowVersion);
  merged.set(workflow, { versionId, workflow: production });
  return production;
}

/** Every published workflow as production triggers see it. */
export function productionWorkflows(): Workflow[] {
  return store.listWorkflows().flatMap((workflow) => productionWorkflow(workflow) ?? []);
}

/** One workflow as production triggers see it (undefined: not found, or not published). */
export function productionWorkflowById(workflowId: string): Workflow | undefined {
  const workflow = store.getWorkflow(workflowId);
  return workflow && productionWorkflow(workflow);
}

/**
 * The workflow another run calls (Execute Workflow, an error workflow): a manual run calls the draft, a production
 * run the published version, or the saved workflow when it was never published (sub-workflows and error workflows
 * never had to be active).
 */
export function workflowForCall(workflowId: string, mode: ExecutionMode | undefined): Workflow | undefined {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow || mode === 'manual') return workflow;
  return (publishedVersionId(workflowId) && productionWorkflow(workflow)) || workflow;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** The app webhook reconciler, loaded lazily (it reads the production graph from this module). */
async function reconcileTriggers(workflowId: string): Promise<Array<{ nodeName: string; message: string }>> {
  try {
    const { appWebhooks } = await import('./app-webhooks');
    return await appWebhooks.reconcile(workflowId);
  } catch (error) {
    logger.warn('could not update the app webhook triggers', { error, 'landflow.workflow.id': workflowId });
    return [{ nodeName: 'App webhook triggers', message: (error as Error).message }];
  }
}

/** Where a workflow's publication stands: what is published, the draft, the timeline and its app webhook triggers. */
export async function publicationStatus(workflowId: string): Promise<PublicationStatus> {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new PublishError('Workflow not found', 404);
  const published = getPublication(workflowId);
  const draft = versionFor(workflow) ?? listVersions(workflowId)[0];
  const publishedHash = published ? getVersion(workflowId, published.versionId)?.hash : undefined;
  const { appWebhooks } = await import('./app-webhooks');
  const names = userNames();
  const nameOf = (id: string | undefined) => (id ? names.get(id) : undefined);
  const publishedByName = nameOf(published?.publishedBy);
  return {
    ...(published && { published: { ...published, ...(publishedByName && { publishedByName }) } }),
    ...(draft && { draft: { versionId: draft.id, versionNumber: draft.number } }),
    unpublishedChanges: Boolean(published && draft && draft.hash !== publishedHash),
    log: publishLog(workflowId).map((entry) => {
      const byName = nameOf(entry.by);
      return byName ? { ...entry, byName } : entry;
    }),
    appWebhooks: appWebhooks.status(workflowId),
  };
}

/**
 * Publish a version of a workflow: production triggers run it from now on, the workflow is active, and its app
 * webhook triggers are registered (or moved to the new version's settings). Publishing an older version is a rollback.
 * Trigger registrations that fail are reported in `triggerErrors` and retried; the publish itself stands.
 *
 * `by`: who publishes (shown in the timeline). Approval flows wrap this function; it is the only one that publishes.
 */
export async function publishVersion(workflowId: string, versionId: string, by?: string, note?: string): Promise<PublishResult> {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new PublishError('Workflow not found', 404);
  const version = getVersion(workflowId, versionId);
  if (!version) throw new PublishError('Version not found', 404);
  // Settings → Governance: a version with nodes the policy doesn't allow can't go live.
  const blocked = publishBlockedReason(version.workflow);
  if (blocked) throw new PublishError(blocked, 422);
  database().transaction(() => {
    setPublication(workflowId, versionId, by, note);
    if (!workflow.active) store.saveWorkflow({ ...workflow, active: true });
  });
  logger.info('workflow published', { 'landflow.workflow.id': workflowId, 'landflow.version.id': versionId, ...(by && { 'landflow.user': by }) });
  const triggerErrors = await reconcileTriggers(workflowId);
  return { ...(await publicationStatus(workflowId)), triggerErrors };
}

/** Publish the saved draft (the newest saved state of the workflow). */
export async function publishDraft(workflowId: string, by?: string, note?: string): Promise<PublishResult> {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new PublishError('Workflow not found', 404);
  const version = versionFor(workflow) ?? recordVersion(workflow);
  if (!version) throw new PublishError('This workflow has no saved version to publish: save it first', 409);
  return publishVersion(workflowId, version.id, by, note);
}

/** Unpublish: production triggers stop, the workflow is inactive, and its app webhooks are removed from their services. */
export async function unpublishWorkflow(workflowId: string, by?: string, note?: string): Promise<PublishResult> {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new PublishError('Workflow not found', 404);
  database().transaction(() => {
    clearPublication(workflowId, by, note);
    if (workflow.active) store.saveWorkflow({ ...workflow, active: false });
  });
  logger.info('workflow unpublished', { 'landflow.workflow.id': workflowId, ...(by && { 'landflow.user': by }) });
  const triggerErrors = await reconcileTriggers(workflowId);
  return { ...(await publicationStatus(workflowId)), triggerErrors };
}

/** After a workflow was deleted: forget its publication and remove its app webhooks from their services. */
export async function forgetWorkflow(workflowId: string): Promise<void> {
  deletePublications(workflowId);
  await reconcileTriggers(workflowId);
}

/**
 * At boot: every active workflow is published (data imported after migration 200 publishes its newest version),
 * and every published workflow is active.
 */
export function ensurePublications(): number {
  let fixed = 0;
  const published = new Set(listPublications().map((p) => p.workflowId));
  for (const workflow of store.listWorkflows()) {
    try {
      if (workflow.active && !published.has(workflow.id)) {
        const version = versionFor(workflow) ?? recordVersion(workflow);
        if (!version) continue;
        setPublication(workflow.id, version.id, 'migration', 'Active before draft and publish');
        fixed++;
      } else if (!workflow.active && published.has(workflow.id)) {
        store.saveWorkflow({ ...workflow, active: true });
        fixed++;
      }
    } catch (error) {
      logger.warn('could not check the publication of a workflow', { error, 'landflow.workflow.id': workflow.id });
    }
  }
  if (fixed) logger.info('publications brought in line with active workflows', { 'landflow.workflows': fixed });
  return fixed;
}
