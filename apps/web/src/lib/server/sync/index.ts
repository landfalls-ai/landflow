/**
 * Git sync against this instance: export its state as files (format.ts), and plan and apply a set of files —
 * creates and updates by stable id, deletes only with `prune`. Used by /api/sync/export and /api/sync/apply (the
 * CLI's `landflow sync`) and by source control (./git.ts).
 *
 * Conflicts: a caller that synced before sends `base`, the entity hashes it got then. A change is held back when
 * the instance moved since: an entity it would update or delete changed, one it would delete was created, or one it
 * would create was deleted. `force` applies them anyway. Without `base` the files simply win.
 *
 * Credentials never travel: files name them `{ name, type }`, and applying looks the name up among this instance's
 * credentials of that type (a missing one is a warning; the node keeps the name and needs a credential picked).
 *
 * Draft and publish: applying saves each changed workflow as a draft, then publishes it (lib/server/publish.ts
 * `publishDraft`) when its file says `active: true`, or unpublishes it when the file turns it off. Deleting a workflow
 * forgets its publication too.
 */
import type { Workflow } from '@landflow/engine';
import { COLUMN_NAME, COLUMN_TYPES, SYSTEM_COLUMNS, type ColumnType } from '../../shared/data-tables';
import type { SyncApplyResult, SyncChange, SyncExport } from '../../shared/sync';
import { credentials as vault } from '../credentials/vault';
import { dataTables } from '../datatables';
import { folders } from '../folders';
import { forgetWorkflow, publishDraft, unpublishWorkflow } from '../publish';
import { workflowSchema } from '../schemas';
import { store } from '../store';
import { MAX_KEY_LENGTH, MAX_VALUE_LENGTH, VARIABLE_KEY, variables } from '../variables';
import { deleteVersions } from '../versions';
import {
  credentialTypeOf,
  entityKey,
  idForPath,
  parseFiles,
  renderState,
  sha256,
  stringify,
  workflowDocument,
  type EntityKind,
  type SyncCredential,
  type SyncFile,
  type SyncState,
} from './format';

export * from './format';

/** The workflow fields the API writes: what files hold (the folder comes from the directory). */
export const workflowKeys = (): string[] => Object.keys(workflowSchema.shape).filter((key) => key !== 'folderId');

/** This instance's state, as the format sees it. */
export function currentState(): SyncState {
  return {
    workflows: store.listWorkflows(),
    folders: folders.list(),
    variables: variables.list(),
    dataTables: dataTables()
      .listTables()
      .map((t) => ({ id: t.id, name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) })),
    credentials: vault.list().map((c) => ({ id: c.id, name: c.name, type: c.type })),
  };
}

/** GET /api/sync/export: every file (or, with `workflowIds`, those workflows and their folders), with hashes. */
export function exportState(options: { values?: boolean; workflowIds?: string[] } = {}): SyncExport {
  const state = currentState();
  const rendered = renderState(state, { values: options.values, workflowKeys: workflowKeys(), workflowIds: options.workflowIds });
  const credentialsFile = rendered.files.find((f) => f.path === 'credentials.json');
  return {
    format: 'landflow-sync/v1',
    files: rendered.files.map((f) => ({ ...f, hash: sha256(f.content) })),
    hashes: rendered.hashes,
    summary: {
      workflows: Object.keys(rendered.workflowPaths).length,
      folders: Object.keys(rendered.folderPaths).length,
      variables: state.variables.length,
      dataTables: state.dataTables.length,
      credentials: credentialsFile ? (JSON.parse(credentialsFile.content) as { credentials: unknown[] }).credentials.length : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanOptions {
  /** Delete what the files don't have. */
  prune?: boolean;
  /** Apply conflicting changes too. */
  force?: boolean;
  /** Entity hashes from the last sync (see the module comment). */
  base?: Record<string, string>;
  /** Who applies (the publish timeline); `note` labels the publications. */
  by?: string;
  note?: string;
}

interface Operation {
  change: SyncChange;
  /** Order: folders, tables, variables, workflows, then deletes (workflows, folders deepest first, tables, variables). */
  stage: number;
  run: () => unknown;
}

export interface SyncPlan {
  changes: SyncChange[];
  warnings: string[];
  errors: string[];
  operations: Operation[];
}

const KIND_ORDER: Record<EntityKind, number> = { folder: 0, dataTable: 1, variable: 2, workflow: 3 };
const SYSTEM_LOWER = new Set(SYSTEM_COLUMNS.map((c) => c.toLowerCase()));
const ID = /^[\w-]+$/;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Node credential references from a file (`{ name, type }`, or `{ id, name }`) → this instance's `{ id, name }`. */
function resolveCredentials(doc: Record<string, unknown>, saved: SyncCredential[], path: string, warnings: string[]): Record<string, unknown> {
  if (!Array.isArray(doc.nodes)) return doc;
  const byId = new Map(saved.map((c) => [c.id, c]));
  const nodes = doc.nodes.map((node) => {
    if (!isObject(node) || !isObject(node.credentials)) return node;
    const refs: Record<string, { id: string; name: string }> = {};
    for (const [key, raw] of Object.entries(node.credentials)) {
      if (!isObject(raw)) continue;
      const name = typeof raw.name === 'string' ? raw.name : '';
      const type = typeof raw.type === 'string' ? raw.type : credentialTypeOf({ type: String(node.type ?? '') }, key);
      const known = typeof raw.id === 'string' ? byId.get(raw.id) : undefined;
      const match = known ?? saved.find((c) => c.type === type && c.name === name);
      if (match) refs[key] = { id: match.id, name: match.name };
      else if (name) {
        refs[key] = { id: '', name };
        warnings.push(`${path}: credential “${name}” (${type}) isn't on this instance; create it, then pick it in “${String(node.name ?? key)}”`);
      }
    }
    return { ...node, credentials: refs };
  });
  return { ...doc, nodes };
}

/** Top-level fields that differ between two workflow documents. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

/** What applying `files` would change, with every check done up front. Nothing is written. */
export function planSync(files: SyncFile[], options: PlanOptions = {}): SyncPlan {
  const desired = parseFiles(files);
  const warnings: string[] = [];
  const errors = [...desired.errors];
  const operations: Operation[] = [];
  const add = (stage: number, change: SyncChange, run: () => unknown) => operations.push({ stage, change, run });
  const state = currentState();
  const keys = workflowKeys();

  // ---- folders: by `.folder.json` id, else a same-named folder under the same parent, else an id from the path
  const folderIds = new Map<string, string>();
  const wantedFolders = new Set<string>();
  const instanceFolders = new Map(state.folders.map((f) => [f.id, f]));
  for (const folder of desired.folders) {
    const parentId = folder.parentDir ? folderIds.get(folder.parentDir) : undefined;
    const name = folder.name.trim();
    if (!name || name.length > 120) {
      errors.push(`${folder.dir}: folder names are 1 to 120 characters`);
      continue;
    }
    let id = folder.id;
    if (id && !ID.test(id)) {
      errors.push(`${folder.dir}/.folder.json: invalid id ${JSON.stringify(id)}`);
      continue;
    }
    id ??= state.folders.find((f) => f.name === name && f.parentId === parentId && !wantedFolders.has(f.id))?.id ?? idForPath('fd', folder.dir);
    if (wantedFolders.has(id)) {
      errors.push(`${folder.dir}: folder id ${id} is used by another directory too`);
      continue;
    }
    wantedFolders.add(id);
    folderIds.set(folder.dir, id);
    const existing = instanceFolders.get(id);
    const path = `${folder.dir}/.folder.json`;
    const folderId = id;
    if (!existing) {
      add(0, { kind: 'folder', action: 'create', id, name, path }, () => folders.create({ id: folderId, name, ...(parentId && { parentId }) }));
    } else {
      const fields = [...(existing.name !== name ? ['name'] : []), ...((existing.parentId ?? undefined) !== parentId ? ['parent'] : [])];
      if (fields.length) add(0, { kind: 'folder', action: 'update', id, name, path, fields }, () => folders.update(folderId, { name, parentId: parentId ?? null }));
    }
  }
  const depth = (id: string) => {
    let n = 0;
    for (let f = instanceFolders.get(id); f?.parentId && n < 100; f = instanceFolders.get(f.parentId)) n++;
    return n;
  };
  for (const folder of state.folders) {
    if (wantedFolders.has(folder.id)) continue;
    // Deepest first: a parent is empty once its children are gone.
    add(5 + (100 - depth(folder.id)) / 1000, { kind: 'folder', action: 'delete', id: folder.id, name: folder.name }, () => {
      folders.delete(folder.id, store.listWorkflows());
    });
  }

  // ---- data tables: by id, else by name; columns are added, never retyped; drops need prune
  const instanceTables = new Map(state.dataTables.map((t) => [t.id, t]));
  const matchedTables = new Set<string>();
  const tableNames = new Set<string>();
  for (const table of desired.dataTables) {
    const name = table.name.trim();
    if (!name) errors.push(`${table.path}: the table needs a name`);
    if (tableNames.has(name.toLowerCase())) errors.push(`${table.path}: another file has a table named “${name}”`);
    tableNames.add(name.toLowerCase());
    const columnNames = new Set<string>();
    for (const column of table.columns) {
      if (!COLUMN_NAME.test(column.name) || SYSTEM_LOWER.has(column.name.toLowerCase())) errors.push(`${table.path}: “${column.name}” is not a valid column name`);
      if (!COLUMN_TYPES.includes(column.type as ColumnType)) errors.push(`${table.path}: column “${column.name}” has type “${column.type}”; types are ${COLUMN_TYPES.join(', ')}`);
      if (columnNames.has(column.name.toLowerCase())) errors.push(`${table.path}: column “${column.name}” is listed twice`);
      columnNames.add(column.name.toLowerCase());
    }
    if (table.id && !ID.test(table.id)) errors.push(`${table.path}: invalid id ${JSON.stringify(table.id)}`);
    const existing =
      (table.id && instanceTables.get(table.id)) || state.dataTables.find((t) => !matchedTables.has(t.id) && t.name.toLowerCase() === name.toLowerCase() && (!table.id || !instanceTables.has(table.id)));
    if (!existing) {
      const id = table.id ?? idForPath('dt', table.path);
      add(1, { kind: 'dataTable', action: 'create', id, name, path: table.path }, () => {
        dataTables().createTable({ id, name, columns: table.columns });
      });
      continue;
    }
    matchedTables.add(existing.id);
    const added = table.columns.filter((c) => !existing.columns.some((e) => e.name === c.name));
    const removed = existing.columns.filter((e) => !table.columns.some((c) => c.name === e.name));
    for (const column of table.columns) {
      const before = existing.columns.find((e) => e.name === column.name);
      if (before && before.type !== column.type) errors.push(`${table.path}: column “${column.name}” is ${before.type} on the instance and ${column.type} in the file; change its type by hand`);
    }
    const renamed = existing.name !== name;
    if (renamed || added.length) {
      const fields = [...(renamed ? ['name'] : []), ...added.map((c) => `+column ${c.name}`)];
      add(1, { kind: 'dataTable', action: 'update', id: existing.id, name, path: table.path, fields }, () => {
        if (renamed) dataTables().renameTable(existing.id, name);
        for (const column of added) dataTables().addColumn(existing.id, column);
      });
    }
    if (removed.length) {
      const change: SyncChange = { kind: 'dataTable', action: 'update', id: existing.id, name, path: table.path, fields: removed.map((c) => `-column ${c.name}`) };
      if (options.prune) add(1.5, change, () => removed.forEach((c) => dataTables().deleteColumn(existing.id, c.name)));
      else operations.push({ stage: 99, change: { ...change, skipped: 'prune' }, run: () => {} });
    }
  }
  for (const table of state.dataTables) {
    if (matchedTables.has(table.id) || desired.dataTables.some((t) => t.id === table.id)) continue;
    add(6, { kind: 'dataTable', action: 'delete', id: table.id, name: table.name }, () => {
      dataTables().deleteTable(table.id);
    });
  }

  // ---- variables: only when variables.json is there; values only when the file has them
  if (desired.variables) {
    const instance = new Map(state.variables.map((v) => [v.key, v.value]));
    const seen = new Set<string>();
    for (const variable of desired.variables) {
      if (!VARIABLE_KEY.test(variable.key) || variable.key.length > MAX_KEY_LENGTH) errors.push(`variables.json: “${variable.key}” is not a valid variable key`);
      if (variable.value !== undefined && variable.value.length > MAX_VALUE_LENGTH) errors.push(`variables.json: the value of ${variable.key} is too long`);
      if (seen.has(variable.key)) errors.push(`variables.json: ${variable.key} is listed twice`);
      seen.add(variable.key);
      const current = instance.get(variable.key);
      if (current === undefined) {
        add(2, { kind: 'variable', action: 'create', id: variable.key, name: variable.key, path: 'variables.json' }, () => {
          variables.create({ key: variable.key, value: variable.value ?? '' });
        });
      } else if (variable.value !== undefined && variable.value !== current) {
        add(2, { kind: 'variable', action: 'update', id: variable.key, name: variable.key, path: 'variables.json', fields: ['value'] }, () => {
          variables.update(variable.key, { value: variable.value });
        });
      }
    }
    for (const variable of state.variables) {
      if (seen.has(variable.key)) continue;
      add(7, { kind: 'variable', action: 'delete', id: variable.key, name: variable.key }, () => {
        variables.delete(variable.key);
      });
    }
  }

  // ---- workflows: by the id in the file (or one from its path)
  const instanceWorkflows = new Map(state.workflows.map((w) => [w.id, w]));
  const wantedWorkflows = new Set<string>();
  for (const file of desired.workflows) {
    const rawId = file.doc.id;
    if (rawId !== undefined && (typeof rawId !== 'string' || !ID.test(rawId))) {
      errors.push(`${file.path}: invalid id ${JSON.stringify(rawId)}`);
      continue;
    }
    const id = (rawId as string | undefined) ?? idForPath('wf', file.path);
    if (wantedWorkflows.has(id)) {
      errors.push(`${file.path}: workflow id ${id} is in another file too`);
      continue;
    }
    wantedWorkflows.add(id);
    const resolved = resolveCredentials(file.doc, state.credentials, file.path, warnings);
    const parsed = workflowSchema.safeParse({ ...resolved, id });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push(`${file.path}: ${issue?.path.join('.') || 'workflow'}: ${issue?.message}`);
      continue;
    }
    const folderId = file.dir ? folderIds.get(file.dir) : undefined;
    const existing = instanceWorkflows.get(id);
    // Fields the API doesn't write (timestamps, publication state) stay as they are.
    const kept = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => !keys.includes(key) && key !== 'folderId' && key !== 'id'));
    const { folderId: _ignored, ...data } = parsed.data as Workflow;
    const next: Workflow = { ...kept, ...data, id, ...(folderId && { folderId }) } as Workflow;
    const name = next.name;
    // Save a draft (keeping the instance's activation), then publish it or unpublish to match the file.
    const save = async () => {
      store.saveWorkflow({ ...next, active: Boolean(existing?.active) });
      if (next.active) await publishDraft(id, options.by, options.note ?? 'Git sync');
      else if (existing?.active) await unpublishWorkflow(id, options.by, options.note ?? 'Git sync');
    };
    if (!existing) {
      add(3, { kind: 'workflow', action: 'create', id, name, path: file.path }, save);
      continue;
    }
    const before = workflowDocument(existing, state.credentials, keys);
    const after = workflowDocument(next, state.credentials, keys);
    const fields = changedFields(before, after);
    if ((existing.folderId ?? undefined) !== folderId) fields.push('folder');
    if (fields.length) add(3, { kind: 'workflow', action: 'update', id, name, path: file.path, fields }, save);
  }
  for (const workflow of state.workflows) {
    if (wantedWorkflows.has(workflow.id)) continue;
    add(4, { kind: 'workflow', action: 'delete', id: workflow.id, name: workflow.name }, async () => {
      if (!store.deleteWorkflow(workflow.id)) return;
      deleteVersions(workflow.id);
      await forgetWorkflow(workflow.id);
    });
  }

  // ---- deletes need prune; conflicts against the base
  const current = renderState(state, { workflowKeys: keys }).hashes;
  for (const operation of operations) {
    const { change } = operation;
    if (change.skipped) continue;
    if (change.action === 'delete' && !options.prune) {
      change.skipped = 'prune';
      continue;
    }
    if (!options.base) continue;
    const key = entityKey(change.kind, change.id);
    const base = options.base[key];
    if (change.action === 'create' && base !== undefined) change.conflict = 'deleted on the instance since the last sync';
    else if (change.action === 'delete' && base === undefined) change.conflict = 'created on the instance since the last sync';
    else if (change.action !== 'create' && base !== undefined && base !== current[key]) change.conflict = 'changed on the instance since the last sync';
  }

  operations.sort((a, b) => a.stage - b.stage || KIND_ORDER[a.change.kind] - KIND_ORDER[b.change.kind]);
  const changes = operations.map((o) => o.change);
  // Credentials the files mention that this instance lacks (credentials.json is informational).
  for (const credential of desired.credentials) {
    if (!state.credentials.some((c) => c.type === credential.type && c.name === credential.name)) {
      const message = `credential “${credential.name}” (${credential.type}) isn't on this instance`;
      if (!warnings.some((w) => w.includes(message))) warnings.push(`credentials.json: ${message}`);
    }
  }
  return { changes, warnings: [...new Set(warnings)], errors, operations };
}

/** Plan, then (unless a dry run, errors, or conflicts without `force`) apply in order. A failing change is reported and the rest go on. */
export async function applySync(files: SyncFile[], options: PlanOptions & { dryRun?: boolean } = {}): Promise<SyncApplyResult> {
  const plan = planSync(files, options);
  const conflicts = plan.changes.filter((c) => c.conflict).length;
  const blocked = plan.errors.length > 0 || (conflicts > 0 && !options.force);
  const result: SyncApplyResult = {
    dryRun: Boolean(options.dryRun),
    applied: false,
    appliedCount: 0,
    changes: plan.changes,
    conflicts,
    warnings: plan.warnings,
    errors: [...plan.errors],
    hashes: {},
  };
  if (!options.dryRun && !blocked) {
    for (const operation of plan.operations) {
      if (operation.change.skipped) continue;
      try {
        await operation.run();
        result.appliedCount++;
      } catch (caught) {
        result.errors.push(`${operation.change.kind} “${operation.change.name}” (${operation.change.action}): ${(caught as Error).message}`);
      }
    }
    result.applied = true;
  }
  result.hashes = renderState(currentState(), { workflowKeys: workflowKeys() }).hashes;
  return result;
}

/** The canonical text of one workflow's file (the CLI's `export`). */
export function workflowFile(workflow: Workflow): string {
  return stringify(workflowDocument(workflow, currentState().credentials, workflowKeys()));
}
