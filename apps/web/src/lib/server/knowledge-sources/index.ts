/**
 * C22: knowledge sources of an agent's knowledge base: list, create, change, remove, Sync now, and the history of runs. The audit
 * events are written here (credentials by id and name, never a value); the routes only check who may call. A source is the agent's
 * draft base's own (agent id + tool id) and names its collection key, so a second base on the same collection can't add the same
 * place twice. Access: a credential must be one the agent's home project may use; writes at sync time go through C21's check.
 */
import { randomUUID } from 'node:crypto';
import { ENABLED_SOURCE_KINDS, SOURCE_LIMITS, SOURCE_SCHEDULES, type SourceInput, type SourcePatch, type SourceSettings, type SourceView, type SyncRunView } from '../../shared/knowledge-sources';
import { collectionKeyOf, deleteChunksWhere, knowledgeConfigOf } from '../agents/knowledge';
import { agentStore } from '../agents/store';
import { recordAudit } from '../audit';
import { credentials } from '../credentials/vault';
import { HttpError } from '../errors';
import { credentialUsableBy } from '../projects/access';
import { homeProjectId } from '../projects/store';
import { setNextAt, stateOf } from './claim';
import { nextDue } from './schedule';
import { startSync } from './sync';
import { countSources, deleteSource, getSource, insertSource, listRuns, listSourceRows, updateSourceRow, viewOfRun, type SourceRow } from './store';
import { credentialTypeOf, SourceSettingsError, validateSettings } from './validate';

export class KnowledgeSourceError extends HttpError {
  static readonly errorName: string = 'KnowledgeSourceError';
  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message, status, { expose: true, ...(details && { details }) });
  }
}

const isRunning = (row: SourceRow, now = Date.now()): boolean => {
  const state = stateOf(row.id);
  return Boolean(state?.run_id && state.lease_until && state.lease_until >= new Date(now).toISOString());
};

function viewOf(row: SourceRow, names: Map<string, string>): SourceView {
  const state = stateOf(row.id);
  const last = listRuns(row.id, { limit: 1 }).runs[0];
  return {
    id: row.id,
    kind: row.kind as SourceView['kind'],
    name: row.name,
    settings: JSON.parse(row.settings) as SourceSettings,
    ...(row.credential_id && { credential: { id: row.credential_id, name: names.get(row.credential_id) ?? 'Deleted credential' } }),
    schedule: row.schedule as SourceView['schedule'],
    paused: Boolean(row.paused),
    ...(row.paused_reason && { pausedReason: row.paused_reason }),
    running: isRunning(row),
    ...(last && { lastRun: last }),
    ...(state?.next_at && !row.paused && { nextAt: state.next_at }),
    createdAt: row.created_at,
  };
}
const credentialNames = () => new Map(credentials.list().map((c) => [c.id, c.name]));

export function listSources(agentId: string, toolId: string): SourceView[] {
  const names = credentialNames();
  return listSourceRows(agentId, toolId).map((row) => viewOf(row, names));
}

/** The credential a kind takes: of the right type, and one the agent's home project may use (403 when not). */
function checkCredential(kind: SourceInput['kind'], credentialId: string | undefined, agentId: string): { id: string; name: string } | undefined {
  const type = credentialTypeOf(kind);
  if (!type) return undefined;
  if (!credentialId) throw new KnowledgeSourceError(`Choose ${kind === 's3' ? 'an S3 credential' : 'a Google OAuth2 credential'} for this source`);
  const found = credentials.list().find((c) => c.id === credentialId);
  if (!found) throw new KnowledgeSourceError('That credential does not exist', 400);
  if (found.type !== type) throw new KnowledgeSourceError(`That credential is a ${found.type}, not a ${type}`, 400);
  if (!credentialUsableBy(credentialId, homeProjectId('agent', agentId))) throw new KnowledgeSourceError(`This agent’s project can’t use the credential “${found.name}”`, 403);
  return { id: found.id, name: found.name };
}

const auditOf = (action: string, row: SourceRow, agentId: string, summary: string, details: Record<string, unknown>) =>
  recordAudit({ action, target: { type: 'agent', id: agentId, name: agentStore.get(agentId)?.name }, summary, details: { sourceId: row.id, kind: row.kind, source: row.name, location: row.location, ...details } });

export async function createSource(actor: { id: string } | undefined, agentId: string, toolId: string, input: SourceInput): Promise<SourceView> {
  const config = knowledgeConfigOf(agentId, toolId);
  if (!config) throw new KnowledgeSourceError('Knowledge base not found: save the agent first', 404);
  if (!ENABLED_SOURCE_KINDS.includes(input.kind)) throw new KnowledgeSourceError(`${input.kind} sources are not available`, 400);
  if (!SOURCE_SCHEDULES.includes(input.schedule)) throw new KnowledgeSourceError('The schedule is not one of manual, hourly or daily');
  if (countSources(agentId, toolId) >= SOURCE_LIMITS.sourcesPerBase) throw new KnowledgeSourceError(`A knowledge base can have ${SOURCE_LIMITS.sourcesPerBase} sources at most`, 400);
  const checked = await validateSettings(input.kind, input.settings);
  const credential = checkCredential(input.kind, input.credentialId, agentId);
  const now = new Date().toISOString();
  const row: SourceRow = {
    id: `src_${randomUUID().slice(0, 12)}`,
    agent_id: agentId,
    tool_id: toolId,
    collection_key: collectionKeyOf(config),
    kind: input.kind,
    name: (input.name?.trim() || checked.name).slice(0, 120),
    location: checked.location,
    settings: JSON.stringify(checked.settings),
    credential_id: credential?.id ?? null,
    schedule: input.schedule,
    paused: 0,
    paused_reason: null,
    created_by: actor?.id ?? null,
    created_at: now,
    updated_at: now,
  };
  insertSource(row);
  // A scheduled source syncs for the first time at the next tick; a manual one waits for Sync now.
  await setNextAt(row.id, input.schedule === 'manual' ? null : now);
  auditOf('knowledge_source.created', row, agentId, `Added the ${row.kind} source “${row.name}” to “${config.name}”`, { schedule: row.schedule, ...(credential && { credential: credential.name, credentialId: credential.id }) });
  return viewOf(row, credentialNames());
}

export async function updateSource(sourceId: string, patch: SourcePatch): Promise<SourceView> {
  const row = getSource(sourceId);
  if (!row) throw new KnowledgeSourceError('Source not found', 404);
  const change: Partial<SourceRow> = {};
  if (patch.name !== undefined) change.name = patch.name.trim().slice(0, 120) || row.name;
  if (patch.schedule !== undefined) {
    if (!SOURCE_SCHEDULES.includes(patch.schedule)) throw new KnowledgeSourceError('The schedule is not one of manual, hourly or daily');
    change.schedule = patch.schedule;
  }
  if (patch.settings !== undefined) {
    const checked = await validateSettings(row.kind as SourceView['kind'], { ...(JSON.parse(row.settings) as object), ...patch.settings });
    if (checked.location !== row.location && listSourceRows(row.agent_id, row.tool_id).some((other) => other.id !== row.id && other.kind === row.kind && other.location === checked.location)) throw new KnowledgeSourceError('This knowledge base already has that source', 409);
    change.settings = JSON.stringify(checked.settings);
    change.location = checked.location;
  }
  if (patch.paused !== undefined) {
    change.paused = patch.paused ? 1 : 0;
    change.paused_reason = patch.paused ? 'Paused' : null;
  }
  const next = updateSourceRow(sourceId, change)!;
  // Pausing stops the schedule; resuming or choosing a schedule makes the source due again.
  if (next.paused || next.schedule === 'manual') await setNextAt(sourceId, null);
  else if (patch.paused === false || patch.schedule !== undefined || !stateOf(sourceId)?.next_at) await setNextAt(sourceId, nextDue(next.schedule, Date.now()));
  auditOf('knowledge_source.updated', next, row.agent_id, `Changed the ${row.kind} source “${next.name}”`, {
    from: { schedule: row.schedule, paused: Boolean(row.paused), location: row.location },
    to: { schedule: next.schedule, paused: Boolean(next.paused), location: next.location },
  });
  return viewOf(next, credentialNames());
}

/** Remove a source; with `deleteChunks` also every chunk it wrote (C22-D4: the person is asked, delete pre-selected). */
export async function removeSource(sourceId: string, options: { deleteChunks: boolean }): Promise<{ removedChunks: number }> {
  const row = getSource(sourceId);
  if (!row) throw new KnowledgeSourceError('Source not found', 404);
  if (isRunning(row)) throw new KnowledgeSourceError('A sync of this source is running; remove it when it has finished', 409);
  let removedChunks = 0;
  if (options.deleteChunks) {
    const config = knowledgeConfigOf(row.agent_id, row.tool_id);
    if (config) removedChunks = await deleteChunksWhere(config, { sourceId }, { asProject: homeProjectId('agent', row.agent_id), subject: 'agent' });
  }
  deleteSource(sourceId);
  auditOf('knowledge_source.removed', row, row.agent_id, `Removed the ${row.kind} source “${row.name}”${options.deleteChunks ? ` and ${removedChunks} chunk${removedChunks === 1 ? '' : 's'}` : ', keeping its chunks'}`, { deletedChunks: options.deleteChunks, removedChunks });
  return { removedChunks };
}

/** Sync now: the run starts in the background on this process (202); a source that is already syncing answers its run id. */
export async function syncNow(sourceId: string): Promise<{ runId: string } | { running: true; runId?: string }> {
  const row = getSource(sourceId);
  if (!row) throw new KnowledgeSourceError('Source not found', 404);
  const started = await startSync(sourceId, 'manual');
  if (started) return { runId: started.runId };
  return { running: true, ...(stateOf(sourceId)?.run_id && { runId: stateOf(sourceId)!.run_id as string }) };
}

export function runsOf(sourceId: string, cursor?: string, limit?: number): { runs: SyncRunView[]; next?: string } {
  return listRuns(sourceId, { ...(cursor && { cursor }), ...(limit && { limit }) });
}

export { SourceSettingsError, viewOfRun };

/** The source `sourceId` when it belongs to this base (a route's ids must agree, or the source is "not found"). */
export const sourceOfBase = (agentId: string, toolId: string, sourceId: string): SourceRow | undefined => {
  const row = getSource(sourceId);
  return row && row.agent_id === agentId && row.tool_id === toolId ? row : undefined;
};
