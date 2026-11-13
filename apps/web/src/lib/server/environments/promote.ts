/**
 * Promotion: copy workflows from one environment's Git branch to another's (development → staging → production),
 * the way a release moves forward. The target instance then pulls its branch (Settings → Source control, or
 * POST /api/environment/pull), applying the files with its own credentials, variables and external secrets.
 *
 * It runs in its own working copy (<data>/source-control/promote), one source-control operation at a time with the
 * pushes and pulls of ./sync/git.ts (the same queue). The source branch is read as it is in the repository, so push
 * before promoting what the instance holds. For every workflow (all of them, or the ones selected) the target gets
 * the source's file, keeping the target's `active` (publication is the target's own; a new workflow keeps the
 * source's). Variables.json is merged (keys the target lacks are added without a value; the target's values stay;
 * per-environment values come from the source), credentials.json gains the references the promoted workflows make,
 * folders on their paths come along, and data table schemas with "all". `prune` (with "all") removes the target's
 * workflows the source no longer has.
 *
 * Credentials and data table rows come from this instance when it promotes its own environment (the usual case): the
 * credentials the promoted workflows use travel as definitions in credentials.json (name, type, non-secret fields;
 * secret fields stay empty, or take the `$secrets` reference Settings → Environments maps them to, and never their
 * value), and the tables opted in to row promotion get a `data-tables/<slug>.rows.json` with their rows. The target's
 * pull creates the credentials it lacks and replaces those tables' rows (../sync/index.ts).
 *
 * Approvals: with four-eyes on, a promotion is a request (./approvals.ts); approving promotes with `expectDigest`, the
 * digest of what the preview would write, so only what was reviewed goes (anything else: StalePromotionError).
 *
 * Conflicts: a promotion commit carries `Landflow-Promoted-From: <environment>` and `Landflow-Promoted-Commit: <sha>`
 * trailers. A workflow conflicts when the target's file differs from the source's and the target changed it since the
 * last promotion from this environment (or there is none to compare with): someone edited the target directly, and
 * promoting would overwrite that. Conflicts stop the promotion unless `force`. A dry run returns the preview, with a
 * unified diff per workflow, and changes nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hasSecretReference } from '@landflow/engine';
import type { PromotionCredential, PromotionEntry, PromotionResult, PromotionTable } from '../../shared/secrets';
import { credentials as vault } from '../credentials/vault';
import { dataTables } from '../datatables';
import { dataDir } from '../db';
import { singleton, singletonKeys } from '../singleton';
import { readSyncDir, writeSyncDir } from '../sync/files';
import {
  CREDENTIALS_FILE,
  DATA_TABLES_DIR,
  FOLDER_FILE,
  idForPath,
  MANIFEST_FILE,
  rowsPathFor,
  stringify,
  SYNC_FORMAT,
  TABLE_SUFFIX,
  VARIABLES_FILE,
  WORKFLOW_SUFFIX,
  WORKFLOWS_DIR,
  type SyncFile,
} from '../sync/format';
import { git, gitAuthFor, sourceControlView, SourceControlError } from '../sync/git';
import { unifiedDiff } from './diff';
import { branchOf, currentEnvironment, ENVIRONMENT_NAME, EnvironmentError, rowMergeSettings, rowTableIds, secretMappingsFor } from './settings';

export const PROMOTED_FROM = 'Landflow-Promoted-From';
export const PROMOTED_COMMIT = 'Landflow-Promoted-Commit';

export interface PromoteInput {
  /** The environment to promote to. */
  target: string;
  /** The environment to promote from (default: this one). */
  source?: string;
  /** Workflow ids (or names) to promote; all of them when absent or empty. */
  workflows?: string[];
  /** With all workflows: remove the target's workflows the source doesn't have. */
  prune?: boolean;
  dryRun?: boolean;
  /** Promote over conflicts. */
  force?: boolean;
  message?: string;
  /** Who promotes (a user name, for the commit message). */
  by?: string;
  /** Tables (ids or names) whose rows go along; default: Settings → Environments' row tables. */
  rowTables?: string[];
  /** Write the definitions of the credentials the promoted workflows use (default: true). */
  credentials?: boolean;
  /** Promote only if it writes exactly what a preview with this digest would (approvals). */
  expectDigest?: string;
}

/** What an approved promotion would write changed since the request (the branches moved, a credential or rows changed). */
export class StalePromotionError extends EnvironmentError {
  constructor(message = 'What this promotion writes changed since it was previewed') {
    super(message, 409);
    this.name = 'StalePromotionError';
  }
}

/** Diffs past this size are cut (a large table's rows). */
const MAX_DIFF = 200_000;
const capped = (diff: string) => (diff.length > MAX_DIFF ? `${diff.slice(0, diff.lastIndexOf('\n', MAX_DIFF))}\n… (diff cut at ${MAX_DIFF / 1000} kB)\n` : diff);

/** The queue of ../sync/git.ts (`exclusive` there): one source-control operation at a time, promotions included. */
const queue = singleton(singletonKeys.sourceControlQueue, () => ({ tail: Promise.resolve() as Promise<unknown> }));
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.tail.then(fn, fn);
  queue.tail = run.catch(() => undefined);
  return run;
}

const promoteDir = () => join(dataDir(), 'source-control', 'promote');

interface WorkflowFile {
  id: string;
  name: string;
  path: string;
  content: string;
  doc: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(content: string): Record<string, unknown> | undefined {
  try {
    const doc = JSON.parse(content) as unknown;
    return isObject(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** The workflows of a sync directory's files, by id (a file without one: the id a pull gives it). */
function workflowsOf(files: SyncFile[]): Map<string, WorkflowFile> {
  const out = new Map<string, WorkflowFile>();
  for (const file of files) {
    if (!file.path.startsWith(`${WORKFLOWS_DIR}/`) || !file.path.endsWith(WORKFLOW_SUFFIX)) continue;
    const doc = parse(file.content);
    if (!doc) continue;
    const id = typeof doc.id === 'string' && doc.id ? doc.id : idForPath('wf', file.path);
    out.set(id, { id, name: typeof doc.name === 'string' ? doc.name : id, path: file.path, content: file.content, doc });
  }
  return out;
}

/** A workflow document as compared across environments: without `active`, which each environment has its own. */
const comparable = (doc: Record<string, unknown> | undefined) => (doc ? JSON.stringify({ ...doc, active: undefined }) : undefined);

/** Top-level fields that differ, `active` aside. */
function changedFields(before: Record<string, unknown> | undefined, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys].filter((key) => key !== 'active' && JSON.stringify(before?.[key]) !== JSON.stringify(after[key])).sort();
}

/** The source's file with the target's `active` (when the target has the workflow). */
function promotedContent(source: WorkflowFile, target: WorkflowFile | undefined): string {
  if (!target || Boolean(target.doc.active) === Boolean(source.doc.active)) return source.content;
  // Keep the key order: `active` stays where the source has it.
  return stringify(Object.fromEntries(Object.entries(source.doc).map(([key, value]) => [key, key === 'active' ? Boolean(target.doc.active) : value])));
}

interface VariableEntry {
  key: string;
  value?: string;
  environments?: Record<string, string>;
}

function variablesOf(file: SyncFile | undefined): VariableEntry[] | undefined {
  const doc = file && parse(file.content);
  if (!doc || !Array.isArray(doc.variables)) return undefined;
  return doc.variables.filter((v): v is VariableEntry => isObject(v) && typeof v.key === 'string');
}

/**
 * variables.json for the target: its own entries and values, the source's per-environment values over its own, and
 * the source's new keys without a value (each environment has its own; a per-environment value supplies it).
 */
function mergeVariables(source: SyncFile | undefined, target: SyncFile | undefined, targetEnvironment: string, warnings: string[]): string | undefined {
  const from = variablesOf(source);
  const into = variablesOf(target);
  if (!from) return target?.content;
  const merged = new Map((into ?? []).map((v) => [v.key, { ...v }]));
  for (const variable of from) {
    const existing = merged.get(variable.key);
    const environments = variable.environments && Object.keys(variable.environments).length ? variable.environments : undefined;
    if (existing) {
      if (environments) existing.environments = { ...existing.environments, ...environments };
      continue;
    }
    merged.set(variable.key, { key: variable.key, ...(into?.some((v) => v.value !== undefined) && { value: '' }), ...(environments && { environments }) });
    if (!environments?.[targetEnvironment]) warnings.push(`Variable ${variable.key} is new in ${targetEnvironment}: give it a value there after the pull (or a ${targetEnvironment} value here)`);
  }
  const list = [...merged.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((v) => {
      const environments = v.environments && Object.keys(v.environments).length ? Object.fromEntries(Object.entries(v.environments).sort(([a], [b]) => (a < b ? -1 : 1))) : undefined;
      return { key: v.key, ...(v.value !== undefined && { value: v.value }), ...(environments && { environments }) };
    });
  return stringify({ variables: list });
}

/** An entry of credentials.json: a reference, or (written by a promotion) a definition with `data` and `secretFields`. */
type CredentialEntry = { name: string; type: string; data?: Record<string, unknown>; secretFields?: string[] };

function credentialsOf(file: SyncFile | undefined): CredentialEntry[] {
  const doc = file && parse(file.content);
  return doc && Array.isArray(doc.credentials) ? doc.credentials.filter((c): c is CredentialEntry => isObject(c) && typeof c.name === 'string' && typeof c.type === 'string') : [];
}

const credentialKey = (c: { name: string; type: string }) => `${c.type}\u0000${c.name}`;
const entryOf = (c: CredentialEntry): CredentialEntry => ({ name: c.name, type: c.type, ...(c.data && { data: c.data }), ...(c.secretFields && { secretFields: c.secretFields }) });

/**
 * This instance's definition of a credential the files reference (by type and name): non-secret fields and the
 * secret fields that read `$secrets`, a mapped secret field set to its reference. Undefined when it has none.
 */
function definitionOf(ref: { name: string; type: string }, target: string): (CredentialEntry & { mapped: string[] }) | undefined {
  const summary = vault.list().find((c) => c.type === ref.type && c.name === ref.name);
  const definition = summary && vault.definition(summary.id);
  if (!definition) return undefined;
  const data: Record<string, unknown> = { ...definition.data };
  for (const mapping of secretMappingsFor(target)) {
    if (mapping.type === ref.type && mapping.name === ref.name && definition.secretFields.includes(mapping.field)) data[mapping.field] = mapping.value;
  }
  const mapped = definition.secretFields.filter((field) => hasSecretReference(data[field]));
  const sorted = Object.fromEntries(Object.keys(data).sort().map((key) => [key, data[key]]));
  return { name: ref.name, type: ref.type, data: sorted, secretFields: definition.secretFields, mapped };
}

/** The credential references of workflow documents. */
function referencedCredentials(docs: Array<Record<string, unknown>>): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const doc of docs) {
    for (const node of Array.isArray(doc.nodes) ? doc.nodes : []) {
      if (!isObject(node) || !isObject(node.credentials)) continue;
      for (const ref of Object.values(node.credentials)) if (isObject(ref) && typeof ref.name === 'string' && typeof ref.type === 'string') out.push({ name: ref.name, type: ref.type });
    }
  }
  return out;
}

/**
 * credentials.json for the target: its entries (with `replace`, none), then the references the promoted workflows make,
 * each a definition when there is one (`definitions`, by type and name) or else the target's own entry or a reference.
 */
function mergeCredentials(target: SyncFile | undefined, add: Array<{ name: string; type: string }>, replace: boolean, definitions: Map<string, CredentialEntry>): string {
  const theirs = new Map(credentialsOf(target).map((c) => [credentialKey(c), c]));
  const all = new Map<string, CredentialEntry>();
  if (!replace) for (const [key, c] of theirs) all.set(key, entryOf(c));
  for (const c of add) {
    const key = credentialKey(c);
    all.set(key, entryOf(definitions.get(key) ?? theirs.get(key) ?? { name: c.name, type: c.type }));
  }
  return stringify({ credentials: [...all.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)) });
}

/** `workflows/a/b/x.workflow.json` → the folder files on its path (`workflows/a/.folder.json`, `workflows/a/b/.folder.json`). */
function folderFilesOn(path: string): string[] {
  const parts = path.split('/').slice(1, -1);
  return parts.map((_, i) => [WORKFLOWS_DIR, ...parts.slice(0, i + 1), FOLDER_FILE].join('/'));
}

/** A path for `wanted` that no other workflow of the target uses. */
function freePath(wanted: string, taken: Map<string, string>, id: string): string {
  if (!taken.has(wanted) || taken.get(wanted) === id) return wanted;
  const stem = wanted.slice(0, -WORKFLOW_SUFFIX.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${WORKFLOW_SUFFIX}`;
    if (!taken.has(candidate) || taken.get(candidate) === id) return candidate;
  }
}

const refExists = (cwd: string, ref: string) =>
  git(['rev-parse', '--verify', '-q', ref], { cwd }).then(
    (r) => r.stdout.trim() || undefined,
    () => undefined,
  );

/** Check out `ref` (detached) and read its managed files under `directory`. */
async function filesAt(cwd: string, ref: string, directory: string): Promise<SyncFile[]> {
  await git(['checkout', '-q', '-f', '--detach', ref], { cwd });
  await git(['clean', '-fdxq'], { cwd });
  return readSyncDir(directory ? join(cwd, directory) : cwd);
}

/** The newest commit of `ref` that a promotion from `source` made, and the source commit it promoted. */
async function lastPromotion(cwd: string, ref: string, source: string): Promise<{ commit: string; from?: string } | undefined> {
  const out = await git(['log', '-n', '1', `--grep=^${PROMOTED_FROM}: ${source}$`, '--format=%H%x00%B', ref], { cwd }).then(
    (r) => r.stdout,
    () => '',
  );
  if (!out.trim()) return undefined;
  const [commit, body = ''] = out.split('\0');
  const from = new RegExp(`^${PROMOTED_COMMIT}: ([0-9a-f]{7,64})$`, 'm').exec(body)?.[1];
  return { commit: commit.trim(), ...(from && { from }) };
}

/** Preview, or promote, `input.source`'s branch onto `input.target`'s. */
export function promoteEnvironment(input: PromoteInput): Promise<PromotionResult> {
  const sourceEnvironment = input.source?.trim() || currentEnvironment();
  if (!sourceEnvironment) throw new EnvironmentError('Set LANDFLOW_ENVIRONMENT (or name the source environment) to promote', 409);
  const targetEnvironment = input.target?.trim();
  if (!targetEnvironment || !ENVIRONMENT_NAME.test(targetEnvironment)) throw new EnvironmentError('Name the environment to promote to');
  if (!ENVIRONMENT_NAME.test(sourceEnvironment)) throw new EnvironmentError(`“${sourceEnvironment}” is not an environment name`);
  if (targetEnvironment === sourceEnvironment) throw new EnvironmentError('Promote to another environment');
  const view = sourceControlView();
  if (!view.config) throw new EnvironmentError('Source control isn’t set up: add the repository in Settings → Source control', 409);
  const config = view.config;
  const sourceBranch = branchOf(sourceEnvironment);
  const targetBranch = branchOf(targetEnvironment);
  if (sourceBranch === targetBranch) throw new EnvironmentError(`${sourceEnvironment} and ${targetEnvironment} use the same branch (${sourceBranch}): give them their own in Settings → Environments`);

  return exclusive(async () => {
    const auth = await gitAuthFor(config);
    const cwd = promoteDir();
    const remoteUrl = existsSync(join(cwd, '.git'))
      ? await git(['remote', 'get-url', 'origin'], { cwd }).then(
          (r) => r.stdout.trim(),
          () => '',
        )
      : '';
    if (remoteUrl !== config.repository) {
      rmSync(cwd, { recursive: true, force: true });
      mkdirSync(cwd, { recursive: true });
      await git(['init', '-q', `--initial-branch=${targetBranch}`], { cwd });
      await git(['remote', 'add', 'origin', config.repository], { cwd });
    }
    await git(['fetch', '-q', '--prune', '--no-tags', 'origin'], { cwd, auth });

    const sourceRef = `refs/remotes/origin/${sourceBranch}`;
    const targetRef = `refs/remotes/origin/${targetBranch}`;
    const sourceCommit = await refExists(cwd, sourceRef);
    if (!sourceCommit) throw new SourceControlError(`The branch ${sourceBranch} (${sourceEnvironment}) isn’t in the repository yet: push first`, 404);
    const targetCommit = await refExists(cwd, targetRef);
    const directory = config.directory;

    const sourceFiles = await filesAt(cwd, sourceRef, directory);
    if (!sourceFiles.some((f) => f.path === MANIFEST_FILE)) throw new SourceControlError(`No Landflow files (${MANIFEST_FILE}) in ${directory || 'the repository root'} on ${sourceBranch}`, 404);
    const base = targetCommit ? await lastPromotion(cwd, targetRef, sourceEnvironment) : undefined;
    const baseFiles = base ? await filesAt(cwd, base.commit, directory) : undefined;
    // The working tree ends on the target branch (or an empty one), ready for the commit.
    let targetFiles: SyncFile[] = [];
    if (targetCommit) {
      await git(['checkout', '-q', '-f', '-B', targetBranch, targetRef], { cwd });
      await git(['clean', '-fdxq'], { cwd });
      targetFiles = readSyncDir(directory ? join(cwd, directory) : cwd);
    } else {
      await git(['checkout', '-q', '-f', '--detach'], { cwd }).catch(() => undefined);
      await git(['symbolic-ref', 'HEAD', `refs/heads/${targetBranch}`], { cwd });
      await git(['update-ref', '-d', `refs/heads/${targetBranch}`], { cwd }).catch(() => undefined);
      await git(['read-tree', '--empty'], { cwd });
      await git(['clean', '-fdxq'], { cwd });
    }

    const source = workflowsOf(sourceFiles);
    const target = workflowsOf(targetFiles);
    const baseline = baseFiles ? workflowsOf(baseFiles) : undefined;
    const sourceByPath = new Map(sourceFiles.map((f) => [f.path, f]));
    const targetByPath = new Map(targetFiles.map((f) => [f.path, f]));
    const warnings: string[] = [];

    // Which workflows: the selected ones (by id or name), or all.
    const selection = (input.workflows ?? []).map((w) => w.trim()).filter(Boolean);
    const all = !selection.length;
    const chosen: WorkflowFile[] = [];
    for (const wanted of selection) {
      const found = source.get(wanted) ?? [...source.values()].find((w) => w.name === wanted);
      if (!found) throw new EnvironmentError(`${sourceBranch} (${sourceEnvironment}) has no workflow “${wanted}”`, 404);
      if (!chosen.includes(found)) chosen.push(found);
    }
    if (all) chosen.push(...source.values());
    if (input.prune && !all) warnings.push('prune applies to promoting all workflows: nothing is removed');

    const next = new Map(targetFiles.map((f) => [f.path, f.content]));
    const pathOwners = new Map([...target.values()].map((w) => [w.path, w.id]));
    const entries: PromotionEntry[] = [];
    /** Workflow files removed or moved away: their folders may be left without workflows. */
    const vacated = new Set<string>();
    for (const workflow of chosen) {
      const existing = target.get(workflow.id);
      const content = promotedContent(workflow, existing);
      if (existing) {
        next.delete(existing.path);
        pathOwners.delete(existing.path);
        vacated.add(existing.path);
      }
      const path = freePath(workflow.path, pathOwners, workflow.id);
      next.set(path, content);
      pathOwners.set(path, workflow.id);
      for (const folderFile of folderFilesOn(path)) {
        const folder = sourceByPath.get(folderFile);
        if (folder) next.set(folderFile, folder.content);
      }
      const same = existing && comparable(existing.doc) === comparable(workflow.doc) && existing.path === path;
      const entry: PromotionEntry = { id: workflow.id, name: workflow.name, path, ...(existing && { targetPath: existing.path }), status: !existing ? 'added' : same ? 'unchanged' : 'modified' };
      if (entry.status !== 'unchanged') {
        entry.diff = unifiedDiff(path, existing?.content, content);
        if (existing) entry.fields = changedFields(existing.doc, workflow.doc);
      }
      if (existing && comparable(existing.doc) !== comparable(workflow.doc)) {
        const before = baseline?.get(workflow.id);
        if (!baseline) entry.conflict = `${targetBranch} has its own version of this workflow and nothing was promoted there from ${sourceEnvironment} yet`;
        else if (comparable(before?.doc) !== comparable(existing.doc)) entry.conflict = `${targetBranch} changed this workflow since the last promotion from ${sourceEnvironment}`;
      }
      entries.push(entry);
    }
    if (all && input.prune) {
      for (const workflow of target.values()) {
        if (source.has(workflow.id)) continue;
        next.delete(workflow.path);
        vacated.add(workflow.path);
        entries.push({ id: workflow.id, name: workflow.name, targetPath: workflow.path, status: 'deleted', diff: unifiedDiff(workflow.path, workflow.content, undefined) });
      }
    }
    if (all) {
      // Every folder and data table schema; with prune, the target's others go.
      for (const file of sourceFiles) if (file.path.endsWith(`/${FOLDER_FILE}`) || file.path.startsWith(`${DATA_TABLES_DIR}/`)) next.set(file.path, file.content);
      if (input.prune) for (const path of targetByPath.keys()) if ((path.endsWith(`/${FOLDER_FILE}`) || path.startsWith(`${DATA_TABLES_DIR}/`)) && !sourceByPath.has(path)) next.delete(path);
    }
    // A folder this promotion emptied (its workflows moved or removed) goes too.
    for (const folderFile of new Set([...vacated].flatMap(folderFilesOn))) {
      const dir = folderFile.slice(0, -FOLDER_FILE.length);
      if (next.has(folderFile) && !sourceByPath.has(folderFile) && ![...next.keys()].some((p) => p.startsWith(dir) && p.endsWith(WORKFLOW_SUFFIX))) next.delete(folderFile);
    }
    next.set(MANIFEST_FILE, targetByPath.get(MANIFEST_FILE)?.content ?? stringify({ format: SYNC_FORMAT }));
    const variables = mergeVariables(sourceByPath.get(VARIABLES_FILE), targetByPath.get(VARIABLES_FILE), targetEnvironment, warnings);
    if (variables !== undefined) next.set(VARIABLES_FILE, variables);
    const remaining = [...next.entries()].filter(([path]) => path.endsWith(WORKFLOW_SUFFIX)).flatMap(([, content]) => [parse(content)].filter(isObject));
    const references = referencedCredentials(all && input.prune ? remaining : chosen.map((w) => w.doc));

    // Credential definitions and table rows: from this instance, when it is the source environment.
    const local = sourceEnvironment === currentEnvironment();
    const wantsRows = input.rowTables ?? rowTableIds();
    if (!local && (input.credentials !== false || wantsRows.length)) {
      warnings.push(`Credential definitions and data table rows come from ${sourceEnvironment}’s own instance: promote there to include them`);
    }
    const definitions = new Map<string, CredentialEntry>();
    const credentialPreview: PromotionCredential[] = [];
    if (local && input.credentials !== false) {
      const theirs = new Map(credentialsOf(targetByPath.get(CREDENTIALS_FILE)).map((c) => [credentialKey(c), c]));
      for (const ref of references) {
        const key = credentialKey(ref);
        if (definitions.has(key)) continue;
        const definition = definitionOf(ref, targetEnvironment);
        if (!definition) continue;
        const { mapped, ...entry } = definition;
        definitions.set(key, entry);
        const before = theirs.get(key);
        const status = !before?.data ? 'added' : JSON.stringify(entryOf(before)) === JSON.stringify(entryOf(entry)) ? 'unchanged' : 'modified';
        credentialPreview.push({ name: ref.name, type: ref.type, status, secretFields: entry.secretFields ?? [], mapped });
      }
      credentialPreview.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    }
    next.set(CREDENTIALS_FILE, mergeCredentials(targetByPath.get(CREDENTIALS_FILE), references, Boolean(all && input.prune), definitions));

    const tablePreview: PromotionTable[] = [];
    if (local && wantsRows.length) {
      // A table's schema file in the target after this promotion (the rows file sits next to it).
      const schemaPaths = new Map<string, string>();
      for (const [path, content] of next) {
        if (!path.startsWith(`${DATA_TABLES_DIR}/`) || !path.endsWith(TABLE_SUFFIX)) continue;
        const doc = parse(content);
        if (doc && typeof doc.id === 'string') schemaPaths.set(doc.id, path);
      }
      const seen = new Set<string>();
      for (const wanted of wantsRows) {
        const table = dataTables().findTable(wanted);
        if (!table) {
          warnings.push(`Data table “${wanted}” (rows to promote) isn’t on this instance`);
          continue;
        }
        if (seen.has(table.id)) continue;
        seen.add(table.id);
        const schemaPath = schemaPaths.get(table.id);
        if (!schemaPath) {
          warnings.push(`Data table “${table.name}” isn’t on ${targetBranch}: push, then promote all workflows (which brings the table schemas) before its rows`);
          continue;
        }
        const columns = table.columns.map((c) => c.name);
        const rows = dataTables()
          .listRows(table.id, { sortBy: 'id', sortDirection: 'asc' })
          .rows.map((row) => Object.fromEntries(columns.filter((c) => row[c] !== undefined).map((c) => [c, row[c]])));
        const path = rowsPathFor(schemaPath);
        const merge = rowMergeSettings()[table.id];
        // A merge needs its key columns in the table (a column dropped since the setting was saved turns it into a replace, with a warning).
        const usable = merge?.keys.every((k) => columns.includes(k));
        if (merge && !usable) warnings.push(`Data table “${table.name}”: the merge key columns (${merge.keys.join(', ')}) aren’t all columns any more: its rows replace the target’s`);
        const content = stringify({ id: table.id, name: table.name, ...(merge && usable && { merge: { keys: merge.keys, ...(merge.deleteMissing && { deleteMissing: true }) } }), rows });
        const before = targetByPath.get(path)?.content;
        next.set(path, content);
        tablePreview.push({ id: table.id, name: table.name, path, rows: rows.length, status: before === undefined ? 'added' : before === content ? 'unchanged' : 'modified' });
      }
      tablePreview.sort((a, b) => a.name.localeCompare(b.name));
    }

    const files: PromotionResult['files'] = [];
    for (const [path, content] of next) {
      if (path.endsWith(WORKFLOW_SUFFIX)) continue;
      const before = targetByPath.get(path)?.content;
      if (before === undefined) files.push({ status: 'A', path, diff: capped(unifiedDiff(path, undefined, content)) });
      else if (before !== content) files.push({ status: 'M', path, diff: capped(unifiedDiff(path, before, content)) });
    }
    for (const [path, file] of targetByPath) if (!next.has(path) && !path.endsWith(WORKFLOW_SUFFIX)) files.push({ status: 'D', path, diff: capped(unifiedDiff(path, file.content, undefined)) });
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    entries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const conflicts = entries.filter((e) => e.conflict).length;
    const changes = entries.filter((e) => e.status !== 'unchanged').length + files.length;
    // What the promotion writes, for approvals: the target's files after it.
    const digest = createHash('sha256')
      .update([...next.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, content]) => `${path}\u0000${content}`).join('\u0001'))
      .digest('hex');
    const result: PromotionResult = {
      dryRun: Boolean(input.dryRun),
      from: { environment: sourceEnvironment, branch: sourceBranch, commit: sourceCommit },
      to: { environment: targetEnvironment, branch: targetBranch, ...(targetCommit && { commit: targetCommit }) },
      entries,
      conflicts,
      files,
      credentials: credentialPreview,
      tables: tablePreview,
      promoted: false,
      digest,
      warnings,
    };
    if (!changes) warnings.push(`${targetBranch} already has ${all ? 'every workflow' : 'these workflows'} as ${sourceBranch} has ${all ? 'them' : 'it'}: nothing to promote`);
    if (input.dryRun || !changes || (conflicts && !input.force)) return result;
    if (input.expectDigest && input.expectDigest !== digest) throw new StalePromotionError();

    const root = directory ? join(cwd, directory) : cwd;
    mkdirSync(root, { recursive: true });
    writeSyncDir(
      root,
      [...next.entries()].map(([path, content]) => ({ path, content })),
    );
    await git(['add', '-A', '--', directory || '.'], { cwd });
    const promotedCount = entries.filter((e) => e.status !== 'unchanged').length;
    const credentialChanges = credentialPreview.filter((c) => c.status !== 'unchanged');
    const tableChanges = tablePreview.filter((t) => t.status !== 'unchanged');
    const what = promotedCount || (!credentialChanges.length && !tableChanges.length) ? `${promotedCount} workflow${promotedCount === 1 ? '' : 's'}` : [credentialChanges.length && 'credentials', tableChanges.length && 'data table rows'].filter(Boolean).join(' and ');
    const subject = input.message?.trim() || `Promote ${what} from ${sourceEnvironment} to ${targetEnvironment}`;
    const body = [
      ...entries.filter((e) => e.status !== 'unchanged').map((e) => `- ${e.status}: ${e.name}${e.conflict ? ' (over a conflict)' : ''}`),
      ...credentialChanges.map((c) => `- credential ${c.status}: ${c.name} (${c.type})`),
      ...tableChanges.map((t) => `- rows ${t.status}: ${t.name} (${t.rows})`),
      ...(input.by ? ['', `Promoted by ${input.by}`] : []),
      '',
      `${PROMOTED_FROM}: ${sourceEnvironment}`,
      `${PROMOTED_COMMIT}: ${sourceCommit}`,
    ].join('\n');
    await git(['-c', `user.name=${config.authorName}`, '-c', `user.email=${config.authorEmail}`, 'commit', '-q', '--no-verify', '--allow-empty', '-m', subject, '-m', body], { cwd });
    const commit = (await refExists(cwd, 'HEAD'))!;
    try {
      await git(['push', '-q', 'origin', `HEAD:refs/heads/${targetBranch}`], { cwd, auth });
    } catch (caught) {
      if (/rejected|non-fast-forward|fetch first/i.test((caught as Error).message)) throw new SourceControlError(`The branch ${targetBranch} moved on while promoting; preview again`, 409);
      throw caught;
    }
    return { ...result, promoted: true, commit };
  });
}
