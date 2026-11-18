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
import type { AgentPin } from '../shared/agent-versions'; // AG21: (types only: the logic loads lazily, so the routes' import closure stays small)
import { userNames } from './auth/users';
import { workflowCompositeIssues } from './composites';
import { database } from './db';
import { publishBlockedReason } from './governance/policy';
import { clearPublication, deletePublications, getPublication, listPublications, publishLog, publishedVersionId, setPublication } from './publications';
import { singleton } from './singleton';
import { store } from './store';
import { logger } from './telemetry/logger';
import { applyVersion, getVersion, listVersions, productionPins, recordVersion, versionFor } from './versions';
import { HttpError } from './errors';

export class PublishError extends HttpError {
  static readonly errorName: string = 'PublishError';
  constructor(
    message: string,
    status = 400,
    options: { code?: string; details?: Record<string, unknown> } = {}, // AG21: the 409 that names the agents
  ) {
    super(message, status, { expose: true, ...options });
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
  // AG21: each bound agent node carries the agent version this version was published with (never saved, never shown).
  const production = applyAgentPins(applyVersion(workflow, { workflow: published } as WorkflowVersion), versionId);
  merged.set(workflow, { versionId, workflow: production });
  return production;
}

const applyAgentPins = (workflow: Workflow, versionId: string): Workflow => productionPins.apply?.(workflow, versionId) ?? workflow;

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

/** AG21: publishing an agent on a workflow's behalf; `agents/publish-first.ts` sets `run` (the publish route imports it). */
export type AgentPublishOutcome = { ok: true; version: number } | { ok: false; status: number; message: string; details?: Record<string, unknown> };
export const agentPublishing = singleton('agent-publishing', () => ({ run: undefined as undefined | ((agentId: string, options: { signal?: AbortSignal }) => Promise<AgentPublishOutcome>) }));

/** AG21: how a publish treats agents whose draft is not what is published. */
export interface PublishOptions {
  /** `publish-first`: each such agent goes through its smoke test and gate first; `as-published`: pin the published versions knowingly. */
  agents?: 'publish-first' | 'as-published';
  /** The pins to set (the update path); a version's pins never change, so only for a version without any. */
  pins?: AgentPin[];
  signal?: AbortSignal;
}

/**
 * AG21: what to do about agents whose draft differs from their published version, for a graph about to be pinned.
 * Refuses (409 `agent_changes_unpublished`) unless the options say what to do; returns the log note when it pinned
 * what is published knowingly.
 */
async function resolveAgents(graph: Pick<Workflow, 'nodes'>, options: PublishOptions, by?: string): Promise<string | undefined> {
  const { blocks } = await import('./agents/versions');
  const stopping = blocks(graph);
  if (!stopping.length) return undefined;
  if (options.agents === 'publish-first') {
    for (const block of stopping) {
      if (!agentPublishing.run) throw new PublishError('Publishing agents first is not available here', 501);
      const outcome = await agentPublishing.run(block.agentId, { signal: options.signal });
      if (!outcome.ok) throw new PublishError(outcome.message, outcome.status, { code: 'agent_publish_held', details: { agent: block.agentId, ...outcome.details } });
    }
    logger.info('agents published for a workflow publish', { 'landflow.agents': stopping.length, ...(by && { 'landflow.user': by }) });
    return undefined;
  }
  if (options.agents === 'as-published') {
    const never = stopping.filter((b) => b.published === undefined);
    if (never.length) {
      throw new PublishError(`${never.map((b) => `“${b.name}”`).join(', ')} ${never.length === 1 ? 'was' : 'were'} never published, so there is no version to pin: publish ${never.length === 1 ? 'it' : 'them'} first`, 409, { code: 'agent_changes_unpublished', details: { agents: never } });
    }
    return `Pinned ${stopping.map((b) => `${b.name} v${b.published}`).join(', ')} as published, not the agent drafts the editor tested`;
  }
  throw new PublishError(`${stopping.map((b) => `“${b.name}”`).join(', ')} ${stopping.length === 1 ? 'has' : 'have'} changes that are not published, so the editor tested something production would not run`, 409, {
    code: 'agent_changes_unpublished',
    details: { agents: stopping },
  });
}

/**
 * Publish a version of a workflow: production triggers run it from now on, the workflow is active, and its app
 * webhook triggers are registered (or moved to the new version's settings). Publishing an older version is a rollback.
 * Trigger registrations that fail are reported in `triggerErrors` and retried; the publish itself stands.
 *
 * AG21: the version pins each bound agent at its published version (a version with pins publishes with them: a rollback
 * runs its own); an agent whose draft differs refuses the publish unless `options.agents` says what to do.
 *
 * `by`: who publishes (shown in the timeline). Approval flows wrap this function; it is the only one that publishes.
 */
export async function publishVersion(workflowId: string, versionId: string, by?: string, note?: string, options: PublishOptions = {}): Promise<PublishResult> {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new PublishError('Workflow not found', 404);
  const version = getVersion(workflowId, versionId);
  if (!version) throw new PublishError('Version not found', 404);
  // Settings → Governance: a version with nodes the policy doesn't allow can't go live.
  const blocked = publishBlockedReason(version.workflow);
  if (blocked) throw new PublishError(blocked, 422);
  // Composites (docs/composites.md): a frame that breaks its contract can't go live; warnings don't stop it.
  const broken = workflowCompositeIssues(version.workflow).filter((issue) => issue.severity === 'error');
  if (broken.length) {
    const listed = broken.slice(0, 3).map((issue) => issue.message).join('; ');
    throw new PublishError(`This version breaks a composite’s contract, so it can’t be published: ${listed}${broken.length > 3 ? `, and ${broken.length - 3} more` : ''}`, 422);
  }
  // AG21: a version's pins are set when it is first published and never change.
  const { pinsFor, pinsToSet, setPins } = await import('./agents/versions');
  let pins: AgentPin[] | undefined;
  let logNote = note;
  if (!pinsFor(versionId).length) {
    const decided = options.pins ? undefined : await resolveAgents(version.workflow, options, by);
    pins = options.pins ?? pinsToSet(version.workflow);
    if (decided) logNote = note ? `${note} · ${decided}` : decided;
  }
  database().transaction(() => {
    if (pins) setPins(versionId, pins);
    setPublication(workflowId, versionId, by, logNote);
    if (!workflow.active) store.saveWorkflow({ ...workflow, active: true });
  });
  logger.info('workflow published', { 'landflow.workflow.id': workflowId, 'landflow.version.id': versionId, ...(by && { 'landflow.user': by }) });
  const triggerErrors = await reconcileTriggers(workflowId);
  return { ...(await publicationStatus(workflowId)), triggerErrors };
}

const agentNames = (pins: readonly AgentPin[]) => new Map(pins.map((p) => [p.agentId, p.agentName ?? p.agentId]));

/** What changes between two pin sets, one entry per agent (for a new version's summary). */
function pinChanges(from: readonly AgentPin[], to: readonly AgentPin[]): Array<{ agentName: string; from?: number; to: number }> {
  const names = agentNames([...from, ...to]);
  const before = new Map(from.map((p) => [p.agentId, p.version]));
  const out = new Map<string, { agentName: string; from?: number; to: number }>();
  for (const p of to) if (before.get(p.agentId) !== p.version && !out.has(p.agentId)) out.set(p.agentId, { agentName: names.get(p.agentId)!, ...(before.has(p.agentId) && { from: before.get(p.agentId) }), to: p.version });
  return [...out.values()];
}

/**
 * Publish the saved draft (the newest saved state of the workflow). AG21: when its version already has pins and the
 * agents' published versions are newer, a new version is recorded (the same graph, the next number) and that one is published.
 */
export async function publishDraft(workflowId: string, by?: string, note?: string, options: PublishOptions = {}): Promise<PublishResult> {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new PublishError('Workflow not found', 404);
  let version = versionFor(workflow) ?? recordVersion(workflow);
  if (!version) throw new PublishError('This workflow has no saved version to publish: save it first', 409);
  const { pinsDiffer, pinsFor, pinsSummary, pinsToSet } = await import('./agents/versions');
  const existing = pinsFor(version.id);
  if (existing.length && pinsDiffer(existing, pinsToSet(workflow))) {
    const decided = await resolveAgents(workflow, options, by);
    const wanted = pinsToSet(workflow);
    if (pinsDiffer(existing, wanted)) {
      version = recordVersion(workflow, { force: true, summary: pinsSummary(pinChanges(existing, wanted)), ...(by && { author: by }) }) ?? version;
    }
    if (decided) note = note ? `${note} · ${decided}` : decided;
  }
  return publishVersion(workflowId, version.id, by, note, options);
}

/**
 * AG21: "Alert triager v3 is available": a new version from the production version's graph with these agents moved to
 * their published versions, published. The draft is not touched. `testedExecutionId` is the test run that passed.
 */
export async function publishUpdate(workflowId: string, agentIds: readonly string[], by?: string, testedExecutionId?: string): Promise<PublishResult> {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new PublishError('Workflow not found', 404);
  const production = getPublication(workflowId);
  const base = production && getVersion(workflowId, production.versionId);
  if (!production || !base) throw new PublishError('This workflow is not published, so there is no production version to update', 409, { code: 'not_published' });
  const { pinsFor, pinsSummary, repinned, testPassed } = await import('./agents/versions');
  const current = pinsFor(base.id);
  const wanted = repinned(current, agentIds);
  const changes = pinChanges(current, wanted);
  if (!changes.length) throw new PublishError('Nothing to update: production already runs the latest published versions of these agents', 409, { code: 'nothing_to_update' });
  const tested = testPassed(workflowId, testedExecutionId, wanted);
  if (tested !== true) throw new PublishError(tested, 409, { code: 'not_tested' });
  const graph = applyVersion(workflow, base);
  const version = recordVersion(graph, { force: true, summary: pinsSummary(changes), ...(by && { author: by }) });
  if (!version) throw new PublishError('Could not record the new version', 500);
  return publishVersion(workflowId, version.id, by, `Moved to ${pinsSummary(changes)} after a passing test`, { pins: wanted });
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
  deletePublications(workflowId)();
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
