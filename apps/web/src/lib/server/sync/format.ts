/**
 * The Git sync file format (`landflow-sync/v1`): how an instance's workflows, folders, variables, data table
 * schemas and credential references are laid out as files, and how those files are read back. Pure (no store),
 * so the sync endpoints, the source-control working copy and the tests share one serializer.
 *
 *   landflow-sync.json                         manifest: { "format": "landflow-sync/v1" }
 *   variables.json                             { "variables": [{ "key": "API_BASE" }] }; `value` (and `environments`, the values per
 *                                              environment, `{ "production": "…" }`) only when exported with values
 *   credentials.json                           { "credentials": [{ "name", "type" }] }: what the workflows reference, never data
 *   data-tables/<slug>.schema.json             { "id", "name", "columns": [{ "name", "type" }] }: the schema, no rows
 *   workflows/<slug>.workflow.json             a top-level workflow
 *   workflows/<folder>/.folder.json            { "id", "name" } of a folder: one directory per folder, nested
 *   workflows/<folder>/<slug>.workflow.json    a workflow in that folder
 *
 * Files are pretty-printed with a fixed key order (known keys first, the rest sorted) and end with a newline, so
 * the same state always writes the same bytes. Node parameters and pinned data keep their own key order, since a
 * node may read them in order. Nodes reference credentials as `{ name, type }`, never by id; timestamps and the
 * folder id are left out (the directory is the folder).
 */
import { createHash } from 'node:crypto';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { Folder } from '../../shared/types';

export const SYNC_FORMAT = 'landflow-sync/v1';
export const MANIFEST_FILE = 'landflow-sync.json';
export const VARIABLES_FILE = 'variables.json';
export const CREDENTIALS_FILE = 'credentials.json';
export const DATA_TABLES_DIR = 'data-tables';
export const WORKFLOWS_DIR = 'workflows';
export const FOLDER_FILE = '.folder.json';
export const WORKFLOW_SUFFIX = '.workflow.json';
export const TABLE_SUFFIX = '.schema.json';

/** One file of a sync directory: a `/`-separated path relative to the directory, and its text. */
export interface SyncFile {
  path: string;
  content: string;
}

export interface SyncCredential {
  id: string;
  name: string;
  type: string;
}

export interface SyncTable {
  id: string;
  name: string;
  columns: Array<{ name: string; type: string }>;
}

/** What an instance holds, as far as the format goes. */
export interface SyncState {
  workflows: Workflow[];
  folders: Folder[];
  /** `environments`: per-environment values (lib/server/environments), written with values only. */
  variables: Array<{ key: string; value: string; environments?: Record<string, string> }>;
  dataTables: SyncTable[];
  credentials: SyncCredential[];
}

/** Entity keys: `workflow:<id>`, `folder:<id>`, `variable:<key>`, `dataTable:<id>`. */
export type EntityKind = 'workflow' | 'folder' | 'variable' | 'dataTable';
export const entityKey = (kind: EntityKind, id: string) => `${kind}:${id}`;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** True for the paths the format owns: pull writes and removes them, push reads them; anything else is left alone. */
export function isManagedPath(path: string): boolean {
  if (path === MANIFEST_FILE || path === VARIABLES_FILE || path === CREDENTIALS_FILE) return true;
  const parts = path.split('/');
  if (parts[0] === DATA_TABLES_DIR) return parts.length === 2 && path.endsWith(TABLE_SUFFIX);
  if (parts[0] === WORKFLOWS_DIR) return parts.length >= 2 && (path.endsWith(WORKFLOW_SUFFIX) || parts.at(-1) === FOLDER_FILE);
  return false;
}

/** A relative path without `..`, empty segments, backslashes or a leading slash. */
export function isSafePath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every((p) => p && p !== '.' && p !== '..');
}

/** A file or directory name: lowercase ASCII letters, digits and dashes, at most 80 characters ('' when nothing is left). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Keys sorted at every level. */
function sortDeep(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isObject(value)) {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = sortDeep(value[key]);
    return out;
  }
  return (value ?? null) as Json;
}

/** `first` keys in that order, then the other keys sorted; `asIs` keys keep their value untouched, the rest are sorted deeply. */
function ordered(value: Record<string, unknown>, first: string[], asIs: string[] = [], last: string[] = []): Record<string, Json> {
  const out: Record<string, Json> = {};
  const rest = Object.keys(value)
    .filter((key) => !first.includes(key) && !last.includes(key))
    .sort();
  for (const key of [...first, ...rest, ...last]) {
    if (value[key] === undefined) continue;
    out[key] = asIs.includes(key) ? (JSON.parse(JSON.stringify(value[key])) as Json) : sortDeep(value[key]);
  }
  return out;
}

/** Pretty-printed with two spaces and a final newline: what every file of the format looks like. */
export const stringify = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/** The plugin id of a node type (`core.set` → `core`). */
const pluginOf = (type: string) => (type.includes('.') ? type.slice(0, type.indexOf('.')) : 'core');

/** The credential type a node's reference names: the saved credential's type, else the node's declared one. */
export function credentialTypeOf(node: Pick<WorkflowNode, 'type'>, key: string, saved?: SyncCredential): string {
  return saved?.type ?? (key.includes('.') ? key : `${pluginOf(node.type)}.${key}`);
}

const WORKFLOW_KEYS = ['id', 'name', 'description', 'active', 'tags', 'settings', 'nodes', 'connections', 'stickyNotes', 'groups', 'pinData'];
const NODE_KEYS = ['id', 'name', 'type', 'typeVersion', 'position', 'disabled', 'notes'];
/** Volatile or implied by the layout: never written. */
const SKIPPED_WORKFLOW_KEYS = new Set(['createdAt', 'updatedAt', 'folderId']);

/**
 * A workflow as it is written to its file: known keys in a fixed order, credentials as `{ name, type }`, no timestamps
 * and no folder id. `keys` limits the workflow-level keys (the API schema's), so fields the API can't write stay out.
 */
export function workflowDocument(workflow: Workflow, credentials: SyncCredential[] = [], keys?: readonly string[]): Record<string, Json> {
  const byId = new Map(credentials.map((c) => [c.id, c]));
  const source: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workflow)) {
    if (SKIPPED_WORKFLOW_KEYS.has(key) || (keys && !keys.includes(key))) continue;
    source[key] = value;
  }
  source.active = Boolean(workflow.active);
  if (Array.isArray(workflow.tags)) source.tags = [...workflow.tags].sort();
  if (!workflow.description) delete source.description;
  source.nodes = (workflow.nodes ?? []).map((node) => {
    const refs = node.credentials
      ? Object.fromEntries(
          Object.keys(node.credentials)
            .sort()
            .map((key) => {
              const ref = node.credentials![key];
              const saved = byId.get(ref.id);
              return [key, { name: saved?.name ?? ref.name, type: credentialTypeOf(node, key, saved) }];
            }),
        )
      : undefined;
    return ordered({ ...node, credentials: refs } as Record<string, unknown>, NODE_KEYS, ['parameters'], ['credentials', 'parameters']);
  });
  source.connections = (workflow.connections ?? []).map((c) => ordered(c as unknown as Record<string, unknown>, ['id', 'type', 'source', 'sourceIndex', 'target', 'targetIndex']));
  if (workflow.stickyNotes) source.stickyNotes = workflow.stickyNotes.map((s) => ordered(s as unknown as Record<string, unknown>, ['id']));
  // Canvas groups: written when there are some (member order kept), so files of workflows without groups don't change.
  if (workflow.groups?.length) source.groups = workflow.groups.map((g) => ordered(g as unknown as Record<string, unknown>, ['id', 'name', 'nodeIds', 'position', 'width', 'height'], ['nodeIds']));
  else delete source.groups;
  return ordered(source, WORKFLOW_KEYS, ['pinData', 'nodes', 'connections', 'stickyNotes', 'groups']);
}

// ---------------------------------------------------------------------------
// Rendering an instance
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Write variable values into variables.json (default: names only). */
  values?: boolean;
  /** Workflow-level keys to write (default: all but timestamps and the folder id). */
  workflowKeys?: readonly string[];
  /** Only these workflows (and the folders that hold them); the other files are written as usual. */
  workflowIds?: readonly string[];
}

export interface Rendered {
  files: SyncFile[];
  /** sha256 per entity (see entityKey) of its canonical form: the base for conflict checks. */
  hashes: Record<string, string>;
  /** Workflow id → its file. */
  workflowPaths: Record<string, string>;
  /** Folder id → its directory (`workflows/…`). */
  folderPaths: Record<string, string>;
}

/** Give each item a unique name among its siblings: the first (by id) keeps the slug, later ones get `-<id>`. */
function uniqueNames<T extends { id: string }>(items: T[], slugOf: (item: T) => string): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const item of sorted) {
    const base = slugOf(item) || slugify(item.id) || 'item';
    let name = base;
    if (taken.has(name)) name = `${base}-${slugify(item.id) || 'x'}`;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    names.set(item.id, name);
  }
  return names;
}

/** Directory of every folder (`workflows/a/b`); a folder whose parent is missing or makes a cycle sits at the top. */
export function folderDirectories(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parentOf = (folder: Folder) => {
    const seen = new Set([folder.id]);
    for (let p = folder.parentId ? byId.get(folder.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
      if (seen.has(p.id)) return undefined;
      seen.add(p.id);
    }
    return folder.parentId && byId.has(folder.parentId) ? folder.parentId : undefined;
  };
  const children = new Map<string | undefined, Folder[]>();
  for (const folder of folders) {
    const parent = parentOf(folder);
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const dirs = new Map<string, string>();
  const walk = (parent: string | undefined, dir: string) => {
    const list = children.get(parent) ?? [];
    const names = uniqueNames(list, (f) => slugify(f.name));
    for (const folder of list) {
      const path = `${dir}/${names.get(folder.id)}`;
      dirs.set(folder.id, path);
      walk(folder.id, path);
    }
  };
  walk(undefined, WORKFLOWS_DIR);
  return dirs;
}

/** Per-environment values sorted by environment, or undefined when there are none. */
const environmentsOf = (v: { environments?: Record<string, string> }) =>
  v.environments && Object.keys(v.environments).length ? Object.fromEntries(Object.entries(v.environments).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : undefined;
const variableHash = (v: { key: string; value: string; environments?: Record<string, string> }) => {
  const environments = environmentsOf(v);
  return sha256(stringify({ key: v.key, value: v.value, ...(environments && { environments }) }));
};
const tableDocument = (t: SyncTable) => ({ id: t.id, name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) });
const folderHash = (f: Folder) => sha256(stringify({ id: f.id, name: f.name, parentId: f.parentId ?? null }));

/** The files of an instance's state, sorted by path, with the entity hashes. */
export function renderState(state: SyncState, options: RenderOptions = {}): Rendered {
  const files: SyncFile[] = [{ path: MANIFEST_FILE, content: stringify({ format: SYNC_FORMAT }) }];
  const hashes: Record<string, string> = {};
  const only = options.workflowIds ? new Set(options.workflowIds) : undefined;
  const workflows = only ? state.workflows.filter((w) => only.has(w.id)) : state.workflows;

  // Folders: every folder (or, for some workflows, the folders on their paths).
  const allDirs = folderDirectories(state.folders);
  const byId = new Map(state.folders.map((f) => [f.id, f]));
  const wanted = new Set<string>();
  for (const folder of state.folders) {
    if (!only) wanted.add(folder.id);
    hashes[entityKey('folder', folder.id)] = folderHash(folder);
  }
  if (only) {
    for (const workflow of workflows) {
      for (let f = workflow.folderId ? byId.get(workflow.folderId) : undefined, guard = 0; f && guard < 100; f = f.parentId ? byId.get(f.parentId) : undefined, guard++) wanted.add(f.id);
    }
  }
  const folderPaths: Record<string, string> = {};
  for (const folder of state.folders) {
    const dir = allDirs.get(folder.id);
    if (!dir || !wanted.has(folder.id)) continue;
    folderPaths[folder.id] = dir;
    files.push({ path: `${dir}/${FOLDER_FILE}`, content: stringify({ id: folder.id, name: folder.name }) });
  }

  // Workflows, grouped by directory so names are unique per directory.
  const byDir = new Map<string, Workflow[]>();
  for (const workflow of state.workflows) {
    const dir = (workflow.folderId && allDirs.get(workflow.folderId)) || WORKFLOWS_DIR;
    byDir.set(dir, [...(byDir.get(dir) ?? []), workflow]);
  }
  const workflowPaths: Record<string, string> = {};
  for (const [dir, list] of byDir) {
    const names = uniqueNames(list, (w) => slugify(w.name));
    for (const workflow of list) {
      const content = stringify(workflowDocument(workflow, state.credentials, options.workflowKeys));
      hashes[entityKey('workflow', workflow.id)] = sha256(content);
      if (only && !only.has(workflow.id)) continue;
      const path = `${dir}/${names.get(workflow.id)}${WORKFLOW_SUFFIX}`;
      workflowPaths[workflow.id] = path;
      files.push({ path, content });
    }
  }

  // Variables: names, or names and values.
  const variables = [...state.variables].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  files.push({
    path: VARIABLES_FILE,
    content: stringify({
      variables: variables.map((v) => {
        const environments = options.values ? environmentsOf(v) : undefined;
        return options.values ? { key: v.key, value: v.value, ...(environments && { environments }) } : { key: v.key };
      }),
    }),
  });
  for (const variable of variables) hashes[entityKey('variable', variable.key)] = variableHash(variable);

  // Data tables: one schema file each.
  const tableNames = uniqueNames(state.dataTables, (t) => slugify(t.name));
  for (const table of state.dataTables) {
    const content = stringify(tableDocument(table));
    hashes[entityKey('dataTable', table.id)] = sha256(content);
    files.push({ path: `${DATA_TABLES_DIR}/${tableNames.get(table.id)}${TABLE_SUFFIX}`, content });
  }

  // Credentials the written workflows reference: name and type only.
  const used = new Map<string, { name: string; type: string }>();
  const savedById = new Map(state.credentials.map((c) => [c.id, c]));
  for (const workflow of workflows) {
    for (const node of workflow.nodes ?? []) {
      for (const [key, ref] of Object.entries(node.credentials ?? {})) {
        const saved = savedById.get(ref.id);
        const entry = { name: saved?.name ?? ref.name, type: credentialTypeOf(node, key, saved) };
        used.set(`${entry.type}\u0000${entry.name}`, entry);
      }
    }
  }
  const credentials = [...used.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  files.push({ path: CREDENTIALS_FILE, content: stringify({ credentials }) });

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, hashes, workflowPaths, folderPaths };
}

/** The hash of one variable or folder, the way renderState computes it (for comparing against a base). */
export const hashOf = { variable: variableHash, folder: folderHash, table: (t: SyncTable) => sha256(stringify(tableDocument(t))) };

// ---------------------------------------------------------------------------
// Reading files back
// ---------------------------------------------------------------------------

export interface DesiredFolder {
  /** `workflows/a/b` */
  dir: string;
  /** From `.folder.json`; absent for a directory without one. */
  id?: string;
  name: string;
  /** The parent's directory, or undefined at the top level. */
  parentDir?: string;
}

export interface DesiredWorkflow {
  path: string;
  /** The parsed file (validated later against the API schema). */
  doc: Record<string, unknown>;
  /** The folder directory, or undefined at the top level. */
  dir?: string;
}

export interface DesiredTable {
  path: string;
  id?: string;
  name: string;
  columns: Array<{ name: string; type: string }>;
}

export interface DesiredState {
  folders: DesiredFolder[];
  workflows: DesiredWorkflow[];
  /** Undefined when variables.json is missing: variables are left alone. */
  variables?: Array<{ key: string; value?: string; environments?: Record<string, string> }>;
  dataTables: DesiredTable[];
  /** credentials.json, for warnings only: push never creates credentials. */
  credentials: Array<{ name: string; type: string }>;
  errors: string[];
}

function parseJson(file: SyncFile, errors: string[]): unknown {
  try {
    return JSON.parse(file.content);
  } catch (caught) {
    errors.push(`${file.path}: not valid JSON (${(caught as Error).message})`);
    return undefined;
  }
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

/** Read a sync directory's managed files. Problems are collected in `errors`; other files are ignored. */
export function parseFiles(input: SyncFile[]): DesiredState {
  const errors: string[] = [];
  const state: DesiredState = { folders: [], workflows: [], dataTables: [], credentials: [], errors };
  const files = input.filter((f) => isSafePath(f.path) && isManagedPath(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();

  const manifest = files.find((f) => f.path === MANIFEST_FILE);
  if (!manifest) errors.push(`${MANIFEST_FILE} is missing: this isn't a Landflow sync directory (pull into it first)`);
  else {
    const doc = parseJson(manifest, errors);
    if (doc !== undefined && (!isObject(doc) || doc.format !== SYNC_FORMAT)) errors.push(`${MANIFEST_FILE}: unknown format ${JSON.stringify(isObject(doc) ? doc.format : doc)} (this host reads ${SYNC_FORMAT})`);
  }

  const folderDirs = new Map<string, DesiredFolder>();
  const ensureFolder = (dir: string) => {
    if (dir === WORKFLOWS_DIR || folderDirs.has(dir)) return;
    const parent = dirOf(dir);
    ensureFolder(parent);
    folderDirs.set(dir, { dir, name: dir.slice(dir.lastIndexOf('/') + 1), ...(parent !== WORKFLOWS_DIR && { parentDir: parent }) });
  };

  for (const file of files) {
    if (seen.has(file.path)) {
      errors.push(`${file.path}: given twice`);
      continue;
    }
    seen.add(file.path);
    if (file.path === MANIFEST_FILE) continue;
    if (file.path === VARIABLES_FILE) {
      const doc = parseJson(file, errors);
      if (doc === undefined) continue;
      const list = isObject(doc) ? doc.variables : undefined;
      if (!Array.isArray(list)) {
        errors.push(`${file.path}: expected { "variables": [{ "key": "NAME" }] }`);
        continue;
      }
      state.variables = [];
      for (const [i, entry] of list.entries()) {
        if (!isObject(entry) || typeof entry.key !== 'string' || (entry.value !== undefined && typeof entry.value !== 'string')) {
          errors.push(`${file.path}: variables[${i}] needs a string "key" (and an optional string "value")`);
          continue;
        }
        const environments = entry.environments;
        if (environments !== undefined && (!isObject(environments) || Object.values(environments).some((v) => typeof v !== 'string'))) {
          errors.push(`${file.path}: variables[${i}].environments maps environment names to string values`);
          continue;
        }
        state.variables.push({
          key: entry.key,
          ...(typeof entry.value === 'string' && { value: entry.value }),
          ...(environments !== undefined && { environments: environments as Record<string, string> }),
        });
      }
      continue;
    }
    if (file.path === CREDENTIALS_FILE) {
      const doc = parseJson(file, errors);
      const list = isObject(doc) && Array.isArray(doc.credentials) ? doc.credentials : [];
      state.credentials = list.filter((c): c is { name: string; type: string } => isObject(c) && typeof c.name === 'string' && typeof c.type === 'string');
      continue;
    }
    if (file.path.startsWith(`${DATA_TABLES_DIR}/`)) {
      const doc = parseJson(file, errors);
      if (doc === undefined) continue;
      if (!isObject(doc) || typeof doc.name !== 'string' || !Array.isArray(doc.columns)) {
        errors.push(`${file.path}: expected { "name", "columns": [{ "name", "type" }] }`);
        continue;
      }
      const columns = doc.columns.filter((c): c is { name: string; type: string } => isObject(c) && typeof c.name === 'string' && typeof c.type === 'string');
      if (columns.length !== doc.columns.length) errors.push(`${file.path}: every column needs a string "name" and "type"`);
      state.dataTables.push({ path: file.path, ...(typeof doc.id === 'string' && doc.id && { id: doc.id }), name: doc.name, columns: columns.map((c) => ({ name: c.name, type: c.type })) });
      continue;
    }
    // workflows/…
    const dir = dirOf(file.path);
    if (file.path.endsWith(`/${FOLDER_FILE}`)) {
      const doc = parseJson(file, errors);
      ensureFolder(dir);
      if (doc === undefined) continue;
      if (!isObject(doc) || typeof doc.name !== 'string' || (doc.id !== undefined && typeof doc.id !== 'string')) {
        errors.push(`${file.path}: expected { "id", "name" }`);
        continue;
      }
      const folder = folderDirs.get(dir)!;
      folder.name = doc.name;
      if (typeof doc.id === 'string' && doc.id) folder.id = doc.id;
      continue;
    }
    const doc = parseJson(file, errors);
    if (doc === undefined) continue;
    if (!isObject(doc)) {
      errors.push(`${file.path}: a workflow file holds one JSON object`);
      continue;
    }
    ensureFolder(dir);
    state.workflows.push({ path: file.path, doc, ...(dir !== WORKFLOWS_DIR && { dir }) });
  }
  state.folders = [...folderDirs.values()].sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || (a.dir < b.dir ? -1 : 1));
  return state;
}

/** An id for a workflow or folder file that has none: stable for its path. */
export const idForPath = (prefix: string, path: string) => `${prefix}_${sha256(path).slice(0, 12)}`;
