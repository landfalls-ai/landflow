/**
 * Workflow version history. Every save of a workflow is recorded as a snapshot in the
 * `workflow_versions` table (lib/server/db): the version summary and the workflow as saved.
 * A save that leaves nodes, connections, settings, sticky notes and groups unchanged (same hash) adds no
 * version, and only the newest MAX_VERSIONS are kept per workflow (plus the published one: lib/server/publications.ts).
 * Executions record the version they started on (`versionFor`), and resume on it after a restart.
 *
 * This module must not import the store: the store calls recordVersion().
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Workflow, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import type { VersionDiff, WorkflowVersion, WorkflowVersionSummary } from '../shared/types';
import { database } from './db';
import { parse, versionRow } from './db/rows';
import { publishedVersionId } from './publications';
import { logger } from './telemetry/logger';

/** Versions kept per workflow; older ones are deleted. */
export const MAX_VERSIONS = 50;

/** Autosaves by one person within this long of each other are one version (one editing session). */
export const AUTOSAVE_WINDOW_MS = 10 * 60 * 1000;

const ID = /^[\w-]+$/;

/** JSON with object keys sorted, so equal documents hash the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * sha256 of the parts of a workflow that make a new version: nodes, connections, settings, sticky notes and canvas groups.
 * Groups only count when there are some, so workflows without groups keep the hashes they always had.
 */
export function versionHash(workflow: Workflow): string {
  const material = {
    nodes: workflow.nodes ?? [],
    connections: workflow.connections ?? [],
    settings: workflow.settings ?? {},
    stickyNotes: workflow.stickyNotes ?? [],
    ...(workflow.groups?.length && { groups: workflow.groups }),
  };
  return createHash('sha256').update(stableStringify(material)).digest('hex');
}

/** A node without its position and id: what "changed" compares. */
function nodeContent(node: WorkflowNode): string {
  const { position: _position, id: _id, ...rest } = node;
  return stableStringify(rest);
}

const connectionKey = (c: WorkflowConnection) => `${c.type}|${c.source}|${c.sourceIndex}|${c.target}|${c.targetIndex}`;

/** What changed from `prev` to `next`. Nodes are matched by id; connections by their ends, ignoring edge ids. */
export function diffWorkflows(prev: Workflow | undefined, next: Workflow): VersionDiff {
  const before = new Map((prev?.nodes ?? []).map((n) => [n.id, n]));
  const after = new Map((next.nodes ?? []).map((n) => [n.id, n]));
  const diff: VersionDiff = {
    nodesAdded: [],
    nodesRemoved: [],
    nodesChanged: [],
    nodesMoved: [],
    connectionsAdded: 0,
    connectionsRemoved: 0,
    settingsChanged: stableStringify(prev?.settings ?? {}) !== stableStringify(next.settings ?? {}),
    stickiesChanged: stableStringify(prev?.stickyNotes ?? []) !== stableStringify(next.stickyNotes ?? []),
  };
  if (stableStringify(prev?.groups ?? []) !== stableStringify(next.groups ?? [])) diff.groupsChanged = true;
  for (const [id, node] of after) {
    const old = before.get(id);
    if (!old) diff.nodesAdded.push(node.name);
    else if (nodeContent(old) !== nodeContent(node)) diff.nodesChanged.push(node.name);
    else if (old.position[0] !== node.position[0] || old.position[1] !== node.position[1]) diff.nodesMoved.push(node.name);
  }
  for (const [id, node] of before) if (!after.has(id)) diff.nodesRemoved.push(node.name);
  const oldEdges = new Set((prev?.connections ?? []).map(connectionKey));
  const newEdges = new Set((next.connections ?? []).map(connectionKey));
  for (const key of newEdges) if (!oldEdges.has(key)) diff.connectionsAdded++;
  for (const key of oldEdges) if (!newEdges.has(key)) diff.connectionsRemoved++;
  return diff;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function names(list: string[]) {
  return list.length > 2 ? `${list.slice(0, 2).join(', ')}, …` : list.join(', ');
}

/** One short line for the version list. `first`: the workflow's first version. */
export function summarizeDiff(diff: VersionDiff, first: boolean): string {
  if (first) return `Created with ${plural(diff.nodesAdded.length, 'node')}`;
  const parts: string[] = [];
  if (diff.nodesAdded.length) parts.push(`${plural(diff.nodesAdded.length, 'node')} added (${names(diff.nodesAdded)})`);
  if (diff.nodesRemoved.length) parts.push(`${diff.nodesRemoved.length} removed (${names(diff.nodesRemoved)})`);
  if (diff.nodesChanged.length) parts.push(`${diff.nodesChanged.length} changed (${names(diff.nodesChanged)})`);
  if (diff.connectionsAdded || diff.connectionsRemoved) parts.push('connections changed');
  if (diff.settingsChanged) parts.push('settings changed');
  if (diff.stickiesChanged) parts.push('sticky notes changed');
  if (diff.groupsChanged) parts.push('groups changed');
  if (!parts.length && diff.nodesMoved.length) parts.push('layout changed');
  if (!parts.length) return 'No changes';
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function readIndex(workflowId: string): WorkflowVersionSummary[] {
  if (!ID.test(workflowId)) return [];
  return database()
    .all<{ summary: string }>('SELECT summary FROM workflow_versions WHERE workflow_id = ? ORDER BY number DESC', workflowId)
    .flatMap((row) => parse<WorkflowVersionSummary>(row.summary) ?? []);
}

/** Versions of a workflow, newest first. */
export function listVersions(workflowId: string): WorkflowVersionSummary[] {
  return readIndex(workflowId);
}

/** One version with its workflow snapshot. */
export function getVersion(workflowId: string, versionId: string): WorkflowVersion | undefined {
  if (!ID.test(workflowId) || !ID.test(versionId)) return undefined;
  const row = database().get<{ summary: string; workflow: string }>('SELECT summary, workflow FROM workflow_versions WHERE id = ? AND workflow_id = ?', versionId, workflowId);
  const summary = parse<WorkflowVersionSummary>(row?.summary);
  const workflow = parse<Workflow>(row?.workflow);
  return summary && workflow ? { ...summary, workflow } : undefined;
}

/**
 * The version whose graph is exactly `workflow`'s (what an execution of it records), if any: the published version
 * when it matches (a production run of it), else the newest that does.
 */
export function versionFor(workflow: Workflow): WorkflowVersionSummary | undefined {
  try {
    if (!ID.test(workflow.id)) return undefined;
    const hash = versionHash(workflow);
    const published = publishedVersionId(workflow.id);
    const row =
      (published && database().get<{ summary: string }>('SELECT summary FROM workflow_versions WHERE id = ? AND hash = ?', published, hash)) ||
      database().get<{ summary: string }>('SELECT summary FROM workflow_versions WHERE workflow_id = ? AND hash = ? ORDER BY number DESC LIMIT 1', workflow.id, hash);
    return parse<WorkflowVersionSummary>(row?.summary);
  } catch {
    return undefined;
  }
}

/**
 * Record a saved workflow as a new version, unless nothing that counts changed since the newest one.
 * An autosave (`options.autosave`) replaces the newest version when that was an autosave by the same person within
 * AUTOSAVE_WINDOW_MS (and is not the published one), so an editing session is one version, not one per drag. Manual
 * saves, publishes and tab-leave saves always add a version.
 * Never throws: a save must not fail because of its history.
 */
export function recordVersion(workflow: Workflow, options: { autosave?: { by: string } } = {}): WorkflowVersionSummary | undefined {
  try {
    if (!ID.test(workflow.id)) return undefined;
    const db = database();
    const newest = readIndex(workflow.id)[0];
    const hash = versionHash(workflow);
    if (newest?.hash === hash) return undefined;
    const createdAt = workflow.updatedAt ?? new Date().toISOString();
    const auto = options.autosave;
    const replaces =
      auto && newest?.autosave?.by === auto.by && newest.id !== publishedVersionId(workflow.id) && Math.abs(Date.parse(createdAt) - Date.parse(newest.createdAt)) < AUTOSAVE_WINDOW_MS ? newest : undefined;
    // A replaced version is compared with the one before it, so its line still says everything the session changed.
    const base = replaces ? readIndex(workflow.id)[1] : newest;
    const previous = base ? getVersion(workflow.id, base.id)?.workflow : undefined;
    const diff = diffWorkflows(previous, workflow);
    const summary: WorkflowVersionSummary = {
      id: replaces?.id ?? `v_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      workflowId: workflow.id,
      number: replaces?.number ?? (newest?.number ?? 0) + 1,
      createdAt,
      name: workflow.name,
      nodeCount: workflow.nodes.length,
      hash,
      summary: summarizeDiff(diff, !base),
      diff,
      ...(auto && { autosave: auto }),
    };
    db.transaction(() => {
      db.upsert('workflow_versions', versionRow({ ...summary, workflow }));
      const stale = db.all<{ id: string }>('SELECT id FROM workflow_versions WHERE workflow_id = ? ORDER BY number DESC LIMIT -1 OFFSET ?', workflow.id, MAX_VERSIONS);
      // The published version stays however old it is: production triggers run it.
      const published = publishedVersionId(workflow.id);
      for (const { id } of stale) if (id !== published) db.delete('workflow_versions', { id });
    });
    return summary;
  } catch (error) {
    logger.warn('could not record workflow version', { error, 'landflow.workflow.id': workflow.id });
    return undefined;
  }
}

/**
 * The workflow to save when restoring `version`: its nodes, connections, settings, sticky notes, groups and pin data (for
 * nodes it has), with the current workflow's name, tags, folder and active state.
 */
export function applyVersion(current: Workflow, version: WorkflowVersion): Workflow {
  const snapshot = version.workflow;
  const nodeIds = new Set(snapshot.nodes.map((n) => n.id));
  const pinData = Object.fromEntries(Object.entries(snapshot.pinData ?? {}).filter(([nodeId]) => nodeIds.has(nodeId)));
  return {
    ...current,
    nodes: snapshot.nodes,
    connections: snapshot.connections,
    settings: snapshot.settings,
    stickyNotes: snapshot.stickyNotes,
    groups: snapshot.groups?.length ? snapshot.groups : undefined,
    pinData: Object.keys(pinData).length ? pinData : undefined,
  };
}

/** Mark a version as made by restoring an older one: sets `restoredFrom` and prefixes its summary. */
export function markRestored(workflowId: string, versionId: string, from: { id: string; number: number }): WorkflowVersionSummary | undefined {
  const version = getVersion(workflowId, versionId);
  if (!version) return undefined;
  const { workflow, ...entry } = version;
  const summary = `Restored version ${from.number}${entry.summary && entry.summary !== 'No changes' ? ` · ${entry.summary.charAt(0).toLowerCase()}${entry.summary.slice(1)}` : ''}`;
  const updated: WorkflowVersionSummary = { ...entry, summary, restoredFrom: from };
  database().upsert('workflow_versions', versionRow({ ...updated, workflow }));
  return updated;
}

/** Remove a workflow's whole history (when the workflow is deleted). */
export function deleteVersions(workflowId: string) {
  if (!ID.test(workflowId)) return;
  database().delete('workflow_versions', { workflow_id: workflowId });
}
