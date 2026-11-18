/**
 * AG21: workflow versions pin their agents' versions (docs/features/editor.md#publishing-pins-the-agents).
 *
 * Publishing a workflow pins, for each Run an Agent / Run a Team node, the agent version that is published at that moment;
 * production runs that version until a person publishes the workflow again. Every run records both versions. Each agent
 * version is kept in `agent_versions` while it exists (`history` keeps 20), so a pinned version older than that still runs.
 * Plain server module (no Next.js imports).
 */
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { pinsDiffer, pinsSummary, PIN_PARAM, PINS_PARAM, type AgentPin, type AgentUpdate, type AgentVersionUse, type PinBlock, type RunAgentVersion, type RunSource, type RunVersions } from '../../shared/agent-versions';
import { diffConfigs, type Agent, type AgentConfig } from '../../shared/agents';
import { rootOf, type AgentTeamConfig } from '../../shared/agent-teams';
import { database } from '../db';
import { parse } from '../db/rows';
import { getPublication, listPublications } from '../publications';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { getVersion, productionPins } from '../versions';
import { agentStore, configOf } from './store';
import { agentVersionRow, recordAgentVersion } from './version-rows';

const AGENT_NODE = 'core.messageAgent';
const TEAM_NODE = 'core.runTeam';
const META_KEY = 'agents.versions.backfilled';

export { pinsDiffer, pinsSummary, recordAgentVersion };

/** The config of one published version: `published`, then `history`, then the table (a version older than the 20 kept in `history` still runs). */
export function agentVersionConfig(agentId: string, version: number): AgentConfig | undefined {
  const agent = agentStore.get(agentId);
  if (agent?.published?.version === version) return agent.published.config;
  const kept = agent?.history.find((v) => v.version === version);
  if (kept) return kept.config;
  return agentVersionRow(agentId, version);
}

/** Whether a version of the agent exists in any of the places it is kept. */
export const agentVersionExists = (agentId: string, version: number): boolean => agentVersionConfig(agentId, version) !== undefined;

// ---------------------------------------------------------------------------
// What a workflow binds
// ---------------------------------------------------------------------------

interface Bound {
  nodeId: string;
  nodeName: string;
  agentId: string;
}

/** Every bound node's agents: a Run an Agent node its agent, a Run a Team node every agent its published team runs (the lead first). */
export function boundAgents(workflow: Pick<Workflow, 'nodes'>): Bound[] {
  const out: Bound[] = [];
  for (const node of workflow.nodes ?? []) {
    if (node.disabled) continue;
    const parameters = (node.parameters ?? {}) as Record<string, unknown>;
    if (node.type === AGENT_NODE) {
      const agentId = parameters.agentId;
      if (typeof agentId === 'string' && agentId && !agentId.startsWith('=')) out.push({ nodeId: node.id, nodeName: node.name ?? node.id, agentId });
    } else if (node.type === TEAM_NODE) {
      const teamId = parameters.teamId;
      // The published team config, read from its table (the team store would make this module part of the runner's import cycle).
      const row = typeof teamId === 'string' && teamId ? database().get<{ published: string | null }>('SELECT published FROM agent_teams WHERE id = ?', teamId) : undefined;
      const config = parse<AgentTeamConfig>(row?.published);
      if (!config) continue;
      const lead = rootOf(config);
      const members = [...config.members].sort((a, b) => (a === lead ? -1 : b === lead ? 1 : 0));
      const seen = new Set<string>();
      for (const member of members) {
        if (member.kind !== 'agent' || seen.has(member.agentId)) continue;
        seen.add(member.agentId);
        out.push({ nodeId: node.id, nodeName: node.name ?? node.id, agentId: member.agentId });
      }
    }
  }
  return out;
}

/** What each bound node's agent is at its published version now. */
export function pinsToSet(workflow: Pick<Workflow, 'nodes'>): AgentPin[] {
  const pins: AgentPin[] = [];
  for (const bound of boundAgents(workflow)) {
    const agent = agentStore.get(bound.agentId);
    if (!agent?.published) continue;
    pins.push({ nodeId: bound.nodeId, nodeName: bound.nodeName, agentId: agent.id, agentName: agent.name, version: agent.published.version });
  }
  return pins;
}

/** Agents the workflow binds whose draft is not what is published (or was never published): what stops a publish. */
export function blocks(workflow: Pick<Workflow, 'nodes'>): PinBlock[] {
  const seen = new Set<string>();
  const out: PinBlock[] = [];
  for (const bound of boundAgents(workflow)) {
    if (seen.has(bound.agentId)) continue;
    seen.add(bound.agentId);
    const agent = agentStore.get(bound.agentId);
    if (!agent) continue;
    if (!agent.published) {
      out.push({ agentId: agent.id, name: agent.name, changes: ['Never published'] });
      continue;
    }
    const changes = diffConfigs(agent.published.config, configOf(agent));
    if (changes.length) out.push({ agentId: agent.id, name: agent.name, published: agent.published.version, changes: changes.slice(0, 5).map((c) => c.label) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pins of a workflow version
// ---------------------------------------------------------------------------

interface PinRow {
  node_id: string;
  agent_id: string;
  agent_version: number;
}

/** The pins of a workflow version (empty for a version never published). */
export function pinsFor(versionId: string): AgentPin[] {
  const rows = database().all<PinRow>('SELECT node_id, agent_id, agent_version FROM workflow_version_pins WHERE version_id = ?', versionId);
  return rows.map((r) => {
    const agent = agentStore.get(r.agent_id);
    return { nodeId: r.node_id, agentId: r.agent_id, version: Number(r.agent_version), ...(agent && { agentName: agent.name }) };
  });
}

/** Pins for a version that has none: a version's pins never change. Returns whether they were written. */
export function setPins(versionId: string, pins: readonly AgentPin[]): boolean {
  const db = database();
  if (db.get('SELECT 1 AS n FROM workflow_version_pins WHERE version_id = ? LIMIT 1', versionId)) return false;
  const at = new Date().toISOString();
  for (const p of pins) db.insertNew('workflow_version_pins', { version_id: versionId, node_id: p.nodeId, agent_id: p.agentId, agent_version: p.version, pinned_at: at });
  return true;
}

/** The pins a node carries in the production copy: `agentVersion` for a Run an Agent node, `agentVersions` (agent id → version) for a team. */
export function withPins(workflow: Workflow, pins: readonly AgentPin[]): Workflow {
  if (!pins.length) return workflow;
  const byNode = new Map<string, AgentPin[]>();
  for (const p of pins) byNode.set(p.nodeId, [...(byNode.get(p.nodeId) ?? []), p]);
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const own = byNode.get(node.id);
      if (!own) return node;
      const parameters = { ...node.parameters };
      if (node.type === TEAM_NODE) parameters[PINS_PARAM] = Object.fromEntries(own.map((p) => [p.agentId, p.version]));
      else parameters[PIN_PARAM] = own[0]!.version;
      return { ...node, parameters };
    }),
  };
}

/** Replace the pins of agents named by `agentIds` with their published versions (the "update" path), for the workflow's production version. */
export function repinned(pins: readonly AgentPin[], agentIds: readonly string[]): AgentPin[] {
  return pins.map((p) => {
    if (!agentIds.includes(p.agentId)) return p;
    const agent = agentStore.get(p.agentId);
    return agent?.published ? { ...p, version: agent.published.version, agentName: agent.name } : p;
  });
}

// ---------------------------------------------------------------------------
// Updates and uses
// ---------------------------------------------------------------------------

const versionNumber = (versionId: string): number | undefined => database().get<{ number: number }>('SELECT number FROM workflow_versions WHERE id = ?', versionId)?.number;

/** Production pins older than the agent's published version, for one workflow or one agent. */
export function agentUpdates(scope: { workflowId: string } | { agentId: string }): AgentUpdate[] {
  const publications = 'workflowId' in scope ? listPublications().filter((p) => p.workflowId === scope.workflowId) : listPublications();
  const updates: AgentUpdate[] = [];
  for (const publication of publications) {
    const workflow = store.getWorkflow(publication.workflowId);
    if (!workflow) continue;
    const grouped = new Map<string, { pinned: number; nodes: string[] }>();
    for (const pin of pinsFor(publication.versionId)) {
      if ('agentId' in scope && scope.agentId !== pin.agentId) continue;
      const agent = agentStore.get(pin.agentId);
      if (!agent?.published || agent.published.version <= pin.version) continue;
      const nodeName = getVersion(publication.workflowId, publication.versionId)?.workflow.nodes.find((n) => n.id === pin.nodeId)?.name ?? pin.nodeId;
      const entry = grouped.get(pin.agentId) ?? { pinned: pin.version, nodes: [] };
      entry.pinned = Math.min(entry.pinned, pin.version);
      if (!entry.nodes.includes(nodeName)) entry.nodes.push(nodeName);
      grouped.set(pin.agentId, entry);
    }
    for (const [agentId, entry] of grouped) {
      const agent = agentStore.get(agentId)!;
      updates.push({
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowVersion: versionNumber(publication.versionId) ?? 0,
        agentId,
        agentName: agent.name,
        pinned: entry.pinned,
        latest: agent.published!.version,
        nodes: entry.nodes,
      });
    }
  }
  return updates;
}

/** Every published agent version and the workflow versions that pin it (the newest version first). */
export function agentVersionUses(agentId: string): AgentVersionUse[] {
  const db = database();
  const agent = agentStore.get(agentId);
  const versions = new Map<number, { publishedAt: string; publishedBy?: string }>();
  for (const v of agent?.history ?? []) versions.set(v.version, { publishedAt: v.publishedAt });
  if (agent?.published) versions.set(agent.published.version, { publishedAt: agent.published.publishedAt });
  for (const row of db.all<{ version: number; published_at: string; published_by: string | null }>('SELECT version, published_at, published_by FROM agent_versions WHERE agent_id = ?', agentId)) {
    const known = versions.get(Number(row.version));
    versions.set(Number(row.version), { publishedAt: known?.publishedAt ?? row.published_at, ...(row.published_by && { publishedBy: row.published_by }) });
  }
  const pins = db.all<{ version_id: string; agent_version: number }>('SELECT DISTINCT version_id, agent_version FROM workflow_version_pins WHERE agent_id = ?', agentId);
  const byVersion = new Map<number, AgentVersionUse['usedBy']>();
  for (const pin of pins) {
    const row = db.get<{ workflow_id: string; number: number }>('SELECT workflow_id, number FROM workflow_versions WHERE id = ?', pin.version_id);
    if (!row) continue;
    const workflow = store.getWorkflow(row.workflow_id);
    if (!workflow) continue;
    const list = byVersion.get(Number(pin.agent_version)) ?? [];
    list.push({ workflowId: row.workflow_id, name: workflow.name, workflowVersion: Number(row.number), production: getPublication(row.workflow_id)?.versionId === pin.version_id });
    byVersion.set(Number(pin.agent_version), list);
  }
  return [...versions.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([version, meta]) => ({
      version,
      publishedAt: meta.publishedAt,
      ...(meta.publishedBy && { publishedBy: meta.publishedBy }),
      usedBy: (byVersion.get(version) ?? []).sort((a, b) => Number(b.production) - Number(a.production) || b.workflowVersion - a.workflowVersion),
    }));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** One row per node and agent when its session starts. Never throws: a run must not fail because of its record. */
export function recordRunAgent(executionId: string, row: { nodeId: string; agentId: string; version: number | 'draft'; source: RunSource }): void {
  try {
    database().upsert('execution_agent_versions', {
      execution_id: executionId,
      node_id: row.nodeId,
      agent_id: row.agentId,
      agent_version: row.version === 'draft' ? null : row.version,
      draft: row.version === 'draft' ? 1 : 0,
      source: row.source,
      at: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn('could not record the agent version of a run', { error, 'landflow.execution.id': executionId });
  }
}

/** What a recorded run pinned for a node and agent (a run that waited and went on carries it across). */
export function recordedPin(executionId: string, nodeId: string, agentId: string): number | undefined {
  const row = database().get<{ agent_version: number | null; source: string }>('SELECT agent_version, source FROM execution_agent_versions WHERE execution_id = ? AND node_id = ? AND agent_id = ?', executionId, nodeId, agentId);
  return row && row.source === 'pinned' && row.agent_version !== null ? Number(row.agent_version) : undefined;
}

/** The pin a non-editor run uses when its node carries none (a resumed, retried or queued run reads its snapshot, which has none): what it recorded, else its version's. */
export function fallbackPin(executionId: string | undefined, nodeId: string, agentId: string): number | undefined {
  if (!executionId) return undefined;
  const recorded = recordedPin(executionId, nodeId, agentId);
  if (recorded !== undefined) return recorded;
  const versionId = database().get<{ version_id: string | null }>('SELECT version_id FROM executions WHERE id = ?', executionId)?.version_id;
  return versionId ? versionPin(versionId, nodeId, agentId) : undefined;
}

/** The pin a published workflow version holds for a node's agent. */
export function versionPin(versionId: string, nodeId: string, agentId: string): number | undefined {
  const row = database().get<{ agent_version: number }>('SELECT agent_version FROM workflow_version_pins WHERE version_id = ? AND node_id = ? AND agent_id = ?', versionId, nodeId, agentId);
  return row ? Number(row.agent_version) : undefined;
}

/** Both versions of a run. */
export function runVersions(executionId: string, known?: Pick<ExecutionRecord, 'workflowId' | 'workflow' | 'versionId' | 'versionNumber' | 'versionPublished'>): RunVersions | undefined {
  const row = known ? undefined : database().get<{ workflow_id: string; version_id: string | null }>('SELECT workflow_id, version_id FROM executions WHERE id = ?', executionId);
  if (!known && !row) return undefined;
  const versionId = known?.versionId ?? row?.version_id ?? undefined;
  const record = known ?? {
    workflowId: row!.workflow_id,
    workflow: undefined,
    versionId,
    versionNumber: versionId ? versionNumber(versionId) : undefined,
    versionPublished: Boolean(versionId && getPublication(row!.workflow_id)?.versionId === versionId),
  };
  const rows = database().all<{ node_id: string; agent_id: string; agent_version: number | null; draft: number; source: string }>(
    'SELECT node_id, agent_id, agent_version, draft, source FROM execution_agent_versions WHERE execution_id = ? ORDER BY at, node_id',
    executionId,
  );
  const nodeName = (nodeId: string) => (record.workflow ?? store.getWorkflow(record.workflowId))?.nodes.find((n) => n.id === nodeId)?.name;
  const agents: RunAgentVersion[] = rows.map((r) => ({
    nodeId: r.node_id,
    ...(nodeName(r.node_id) && { nodeName: nodeName(r.node_id) }),
    agentId: r.agent_id,
    agentName: agentStore.get(r.agent_id)?.name ?? r.agent_id,
    version: Number(r.draft) ? 'draft' : Number(r.agent_version),
    source: r.source as RunSource,
  }));
  return {
    workflow: { ...(record.versionId && { versionId: record.versionId }), ...(record.versionNumber !== undefined && { number: record.versionNumber }), production: Boolean(record.versionPublished) },
    agents,
  };
}

// ---------------------------------------------------------------------------
// The one-time backfill
// ---------------------------------------------------------------------------

/**
 * Once (`meta` remembers): every agent's published version and history go into `agent_versions`, and every currently
 * published workflow version's bound nodes are pinned at the agent's published version now (what production runs today:
 * nothing changes at the upgrade). Never rejects. Returns how many pins it wrote.
 */
export async function backfillVersions(): Promise<number> {
  try {
    const db = database();
    if (db.get('SELECT value FROM meta WHERE key = ?', META_KEY)) return 0;
    for (const agent of agentStore.list()) {
      for (const v of [...agent.history].reverse()) {
        db.insertNew('agent_versions', { agent_id: agent.id, version: v.version, published_at: v.publishedAt, published_by: null, config: JSON.stringify(v.config) });
      }
      recordAgentVersion(agent);
    }
    let pinned = 0;
    for (const publication of listPublications()) {
      const version = getVersion(publication.workflowId, publication.versionId);
      if (!version) continue;
      if (setPins(publication.versionId, pinsToSet(version.workflow))) pinned += 1;
    }
    db.upsert('meta', { key: META_KEY, value: new Date().toISOString() });
    return pinned;
  } catch (error) {
    logger.warn('the agent versions backfill failed', { error });
    return 0;
  }
}


/** Whether a test run passed for exactly these pins: true, or the sentence that says why not (the update path's `testedExecutionId`). */
export function testPassed(workflowId: string, executionId: string | undefined, wanted: readonly AgentPin[]): true | string {
  if (!executionId) return 'Test the update first: publishing it without a passing test run is not offered';
  const record = database().get<{ workflow_id: string; status: string }>('SELECT workflow_id, status FROM executions WHERE id = ?', executionId);
  if (!record || record.workflow_id !== workflowId) return 'That test run was not found for this workflow';
  if (record.status !== 'success') return `The test run did not pass (it ${record.status === 'error' ? 'failed' : `is ${record.status}`}): fix it or run it again`;
  const rows = database().all<{ node_id: string; agent_id: string; agent_version: number | null; source: string }>('SELECT node_id, agent_id, agent_version, source FROM execution_agent_versions WHERE execution_id = ?', executionId);
  const ran = new Set(rows.filter((r) => r.source === 'pinned' && r.agent_version !== null).map((r) => `${r.node_id}:${r.agent_id}:${Number(r.agent_version)}`));
  // Every pin that moved must have run at its new version in the test (a node the run never reached is not tested).
  const current = new Map(pinsFor(getPublication(workflowId)?.versionId ?? '').map((p) => [`${p.nodeId}:${p.agentId}`, p.version]));
  const missing = wanted.filter((p) => current.get(`${p.nodeId}:${p.agentId}`) !== p.version && !ran.has(`${p.nodeId}:${p.agentId}:${p.version}`));
  return missing.length ? `The test run did not reach ${missing.map((p) => `${p.agentName ?? p.agentId} v${p.version}`).join(', ')}: run it again` : true;
}

// The production copy of a published version carries its agents' pins (lib/server/publish.ts `productionWorkflow`).
productionPins.apply = (workflow, versionId) => withPins(workflow, pinsFor(versionId));
