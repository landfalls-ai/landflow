/**
 * Workflow version history. Every save of a workflow is recorded as a
 * snapshot under `<dataDir>/workflow-versions/<workflowId>/`: an `index.json`
 * with the summaries (newest first) and one `<versionId>.json` per version.
 * A save that leaves nodes, connections, settings and sticky notes unchanged
 * (same hash) adds no version, and only the newest MAX_VERSIONS are kept.
 *
 * This module must not import the store: the store calls recordVersion().
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import type { VersionDiff, WorkflowVersion, WorkflowVersionSummary } from '../shared/types';
import { logger } from './telemetry/logger';

/** Versions kept per workflow; older ones are deleted. */
export const MAX_VERSIONS = 50;

const ID = /^[\w-]+$/;

function dataDir() {
  return process.env.LANDFLOW_DATA_DIR ?? join(process.cwd(), '.data');
}

function workflowDir(workflowId: string) {
  return join(dataDir(), 'workflow-versions', workflowId);
}

function atomicWrite(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

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

/** sha256 of the parts of a workflow that make a new version: nodes, connections, settings and sticky notes. */
export function versionHash(workflow: Workflow): string {
  const material = { nodes: workflow.nodes ?? [], connections: workflow.connections ?? [], settings: workflow.settings ?? {}, stickyNotes: workflow.stickyNotes ?? [] };
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
  if (!parts.length && diff.nodesMoved.length) parts.push('layout changed');
  if (!parts.length) return 'No changes';
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function readIndex(workflowId: string): WorkflowVersionSummary[] {
  if (!ID.test(workflowId)) return [];
  return readJson<WorkflowVersionSummary[]>(join(workflowDir(workflowId), 'index.json')) ?? [];
}

/** Versions of a workflow, newest first. */
export function listVersions(workflowId: string): WorkflowVersionSummary[] {
  return readIndex(workflowId);
}

/** One version with its workflow snapshot. */
export function getVersion(workflowId: string, versionId: string): WorkflowVersion | undefined {
  if (!ID.test(workflowId) || !ID.test(versionId)) return undefined;
  return readJson<WorkflowVersion>(join(workflowDir(workflowId), `${versionId}.json`));
}

/**
 * Record a saved workflow as a new version, unless nothing that counts changed since the newest one.
 * Never throws: a save must not fail because of its history.
 */
export function recordVersion(workflow: Workflow): WorkflowVersionSummary | undefined {
  try {
    if (!ID.test(workflow.id)) return undefined;
    const index = readIndex(workflow.id);
    const hash = versionHash(workflow);
    const newest = index[0];
    if (newest?.hash === hash) return undefined;
    const previous = newest ? getVersion(workflow.id, newest.id)?.workflow : undefined;
    const diff = diffWorkflows(previous, workflow);
    const summary: WorkflowVersionSummary = {
      id: `v_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      workflowId: workflow.id,
      number: (newest?.number ?? 0) + 1,
      createdAt: workflow.updatedAt ?? new Date().toISOString(),
      name: workflow.name,
      nodeCount: workflow.nodes.length,
      hash,
      summary: summarizeDiff(diff, !newest),
      diff,
    };
    const dir = workflowDir(workflow.id);
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, `${summary.id}.json`), { ...summary, workflow } satisfies WorkflowVersion);
    const next = [summary, ...index];
    for (const stale of next.splice(MAX_VERSIONS)) rmSync(join(dir, `${stale.id}.json`), { force: true });
    atomicWrite(join(dir, 'index.json'), next);
    return summary;
  } catch (error) {
    logger.warn('could not record workflow version', { error, 'landflow.workflow.id': workflow.id });
    return undefined;
  }
}

/**
 * The workflow to save when restoring `version`: its nodes, connections, settings, sticky notes and pin data (for nodes it
 * has), with the current workflow's name, tags, folder and active state.
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
    pinData: Object.keys(pinData).length ? pinData : undefined,
  };
}

/** Mark a version as made by restoring an older one: sets `restoredFrom` and prefixes its summary. */
export function markRestored(workflowId: string, versionId: string, from: { id: string; number: number }): WorkflowVersionSummary | undefined {
  const index = readIndex(workflowId);
  const entry = index.find((v) => v.id === versionId);
  const version = getVersion(workflowId, versionId);
  if (!entry || !version) return undefined;
  const summary = `Restored version ${from.number}${entry.summary && entry.summary !== 'No changes' ? ` · ${entry.summary.charAt(0).toLowerCase()}${entry.summary.slice(1)}` : ''}`;
  const updated: WorkflowVersionSummary = { ...entry, summary, restoredFrom: from };
  const dir = workflowDir(workflowId);
  atomicWrite(join(dir, `${versionId}.json`), { ...version, summary, restoredFrom: from } satisfies WorkflowVersion);
  atomicWrite(
    join(dir, 'index.json'),
    index.map((v) => (v.id === versionId ? updated : v)),
  );
  return updated;
}

/** Remove a workflow's whole history (when the workflow is deleted). */
export function deleteVersions(workflowId: string) {
  if (!ID.test(workflowId)) return;
  rmSync(workflowDir(workflowId), { recursive: true, force: true });
}
