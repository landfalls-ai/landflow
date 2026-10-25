/**
 * `sync pull/push/status/diff` — workflows as files in a directory you commit to Git (the `landflow-sync/v1` layout:
 * one directory per folder, `<slug>.workflow.json` with a stable key order, `variables.json`, data table schemas,
 * credential references by name and type, never credential data) — and `source-control status/push/pull`, which run
 * the host's own Git integration (Settings → Source control).
 */
import { resolve } from 'node:path';
import { flag, type Command, type Context } from '../command';
import { CliError, usage } from '../errors';
import { fields, plural, table, time } from '../output';
import { unifiedDiff } from '../sync/diff';
import { hasVariableValues, isManagedPath, isSafePath, MANIFEST_FILE, readSyncDir, sameDocument, writeSyncDir, type SyncFiles } from '../sync/files';
import { fileHashes, localChanges, readState, writeState, type InstanceState } from '../sync/state';

/** One difference between the files and the instance (the host's SyncChange). */
export interface SyncChange {
  kind: 'workflow' | 'folder' | 'variable' | 'dataTable';
  action: 'create' | 'update' | 'delete';
  id: string;
  name: string;
  path?: string;
  fields?: string[];
  conflict?: string;
  skipped?: 'prune';
}

interface ApplyResult {
  dryRun: boolean;
  applied: boolean;
  appliedCount: number;
  changes: SyncChange[];
  conflicts: number;
  warnings: string[];
  errors: string[];
  hashes: Record<string, string>;
}

interface ExportResult {
  format: string;
  files: Array<{ path: string; content: string; hash: string }>;
  hashes: Record<string, string>;
  summary: Record<string, number>;
}

const dirFlag = { dir: flag.string('The sync directory (default: the current directory)', 'path', 'd') };

const syncDir = (ctx: Context) => resolve(ctx.io.cwd, String(ctx.flags.dir ?? '.'));

/** Variable values: --values / --values=false, else what the last pull did, else whatever variables.json holds now. */
const wantValues = (ctx: Context, local: SyncFiles, instance: InstanceState | undefined) =>
  typeof ctx.flags.values === 'boolean' ? ctx.flags.values : (instance?.values ?? hasVariableValues(local));

/** GET /api/sync/export: the instance's files (safe, managed paths only) and its entity hashes. */
async function fetchExport(ctx: Context, values: boolean): Promise<{ files: SyncFiles; hashes: Record<string, string>; summary: Record<string, number> }> {
  const exported = await ctx.client.get<ExportResult>('/api/sync/export', { values });
  const files: SyncFiles = new Map(
    exported.files
      .filter((f) => isSafePath(f.path) && isManagedPath(f.path))
      .map((f) => [f.path, f.content] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return { files, hashes: exported.hashes ?? {}, summary: exported.summary ?? {} };
}

const describeChange = (c: SyncChange) => c.conflict ?? (c.skipped ? 'needs --prune' : c.fields?.length ? c.fields.join(', ') : '');

const changeTable = (changes: SyncChange[], empty: string) =>
  table(
    changes,
    [
      { label: 'action', value: (c) => c.action },
      { label: 'kind', value: (c) => c.kind },
      { label: 'name', value: (c) => c.name, max: 40 },
      { label: 'path', value: (c) => c.path, max: 60 },
      { label: 'note', value: describeChange, max: 60 },
    ],
    empty,
  );

/** POST /api/sync/apply; a 400 (files that don't validate) or 409 (conflicts) becomes a CliError carrying the plan. */
async function apply(ctx: Context, files: SyncFiles, options: { prune: boolean; dryRun: boolean; force: boolean; base?: Record<string, string> }, hint: string) {
  const response = await ctx.client.request<ApplyResult & { error?: string }>('POST', '/api/sync/apply', {
    body: { files: [...files].map(([path, content]) => ({ path, content })), ...options },
    accept: [400, 409],
  });
  const { error, ...result } = response.body;
  if (response.status === 400) {
    const more = result.errors?.length > 1 ? ` (and ${plural(result.errors.length - 1, 'more error')})` : '';
    throw new CliError('sync_failed', `${error ?? 'The files are invalid'}${more}`, { status: 400, details: result });
  }
  if (response.status === 409) throw new CliError('conflict', `${error ?? 'Conflicts'}: ${hint}`, { status: 409, details: result });
  return result as ApplyResult;
}

const requireSyncDir = (dir: string, files: SyncFiles) => {
  if (!files.has(MANIFEST_FILE)) throw usage(`${dir} isn't a sync directory (it has no ${MANIFEST_FILE}): run \`landflow sync pull --dir ${dir}\` first`);
};

export const pull: Command = {
  name: 'sync pull',
  summary: 'Write the instance’s workflows, folders, variables and data table schemas into a directory',
  usage: '[--dir <path>] [--values] [--dry-run] [--force]',
  details:
    'Managed files the instance no longer has are removed; other files are left alone. A file edited since the last pull is not\n' +
    'overwritten without --force (exit 5). Variable values are written only with --values (later pulls remember it).',
  flags: {
    ...dirFlag,
    values: flag.boolean('Write variable values into variables.json (default: names only)'),
    'dry-run': flag.boolean('Show what would change, write nothing', 'n'),
    force: flag.boolean('Overwrite files edited locally since the last pull', 'f'),
  },
  args: { max: 0 },
  async run(ctx) {
    const dir = syncDir(ctx);
    const url = ctx.connection.url;
    const local = readSyncDir(dir);
    const state = readState(dir);
    const instance = state.instances[url];
    const values = wantValues(ctx, local, instance);
    const { files: incoming, hashes, summary } = await fetchExport(ctx, values);

    const write = [...incoming].filter(([path, content]) => local.get(path) !== content).map(([path]) => path);
    const remove = [...local.keys()].filter((path) => !incoming.has(path));
    const edited = localChanges(local, instance);
    const touched = new Set([...edited.added, ...edited.modified, ...edited.deleted]);
    const overwritten = [...write, ...remove].filter((path) => touched.has(path)).sort();
    if (overwritten.length && !ctx.flags.force && !ctx.flags['dry-run']) {
      const listed = `${overwritten.slice(0, 5).join(', ')}${overwritten.length > 5 ? ', …' : ''}`;
      throw new CliError('conflict', `${plural(overwritten.length, 'file')} changed locally since the last pull would be overwritten (${listed}): push them first, or pull with --force`, {
        details: { conflicts: overwritten },
      });
    }
    const dryRun = Boolean(ctx.flags['dry-run']);
    if (!dryRun) {
      writeSyncDir(dir, incoming, { mirror: true });
      state.instances[url] = { url, at: new Date().toISOString(), values, files: fileHashes(incoming), hashes };
      writeState(dir, state);
    }
    const data = { dir, url, dryRun, values, written: write.sort(), removed: remove.sort(), unchanged: incoming.size - write.length, conflicts: overwritten, summary };
    return {
      data,
      human: () => {
        if (!write.length && !remove.length) return `${dir} is up to date with ${url}`;
        const verb = dryRun ? 'Would write' : 'Wrote';
        const lines = [...data.written.map((p) => `  ${local.has(p) ? 'M' : 'A'} ${p}`), ...data.removed.map((p) => `  D ${p}`)];
        return `${verb} ${plural(write.length, 'file')}${remove.length ? `, ${dryRun ? 'would remove' : 'removed'} ${remove.length}` : ''} in ${dir}:\n${lines.join('\n')}`;
      },
    };
  },
};

export const push: Command = {
  name: 'sync push',
  summary: 'Make the instance match a sync directory: create and update by stable id, delete with --prune',
  usage: '[--dir <path>] [--prune] [--dry-run] [--force]',
  details:
    'Edits made on the instance since this directory last synced with it are conflicts (exit 5): pull and merge, or --force to\n' +
    'overwrite them. Files that don’t validate stop the push before anything changes (exit 1). Credentials are matched by name and type.',
  flags: {
    ...dirFlag,
    prune: flag.boolean('Delete workflows, folders, variables and tables that have no file'),
    'dry-run': flag.boolean('Show the plan, change nothing', 'n'),
    force: flag.boolean('Apply changes that conflict with edits made on the instance', 'f'),
  },
  args: { max: 0 },
  async run(ctx) {
    const dir = syncDir(ctx);
    const url = ctx.connection.url;
    const local = readSyncDir(dir);
    requireSyncDir(dir, local);
    const state = readState(dir);
    const instance = state.instances[url];
    const dryRun = Boolean(ctx.flags['dry-run']);
    const result = await apply(ctx, local, { prune: Boolean(ctx.flags.prune), dryRun, force: Boolean(ctx.flags.force), ...(instance && { base: instance.hashes }) }, 'pull to merge them, or push with --force');
    if (!dryRun && result.applied) {
      state.instances[url] = { url, at: new Date().toISOString(), values: instance?.values ?? hasVariableValues(local), files: fileHashes(local), hashes: result.hashes };
      writeState(dir, state);
    }
    if (result.errors.length) throw new CliError('sync_failed', `${plural(result.errors.length, 'change')} failed: ${result.errors[0]}`, { details: result });
    const { hashes: _hashes, ...shown } = result;
    const data = { dir, url, ...shown };
    return {
      data,
      human: () => {
        const pending = result.changes.filter((c) => !c.skipped);
        const head = dryRun
          ? `Push would make ${plural(pending.length, 'change')} on ${url}`
          : pending.length
            ? `Pushed ${plural(result.appliedCount, 'change')} to ${url}`
            : `${url} already matches ${dir}`;
        const skipped = result.changes.length - pending.length;
        const parts = [head, result.changes.length ? changeTable(result.changes, '') : '', skipped ? `${plural(skipped, 'delete')} skipped: push with --prune to apply.` : ''];
        return [...parts, ...result.warnings.map((w) => `warning: ${w}`)].filter(Boolean).join('\n\n');
      },
    };
  },
};

export const status: Command = {
  name: 'sync status',
  summary: 'What a push would change, and the files edited locally since the last sync',
  usage: '[--dir <path>] [--prune] [--exit-code]',
  flags: {
    ...dirFlag,
    prune: flag.boolean('Count deletes as changes a push would make (they need push --prune)'),
    'exit-code': flag.boolean('Exit 1 when the directory and the instance differ'),
  },
  args: { max: 0 },
  async run(ctx) {
    const dir = syncDir(ctx);
    const url = ctx.connection.url;
    const local = readSyncDir(dir);
    requireSyncDir(dir, local);
    const instance = readState(dir).instances[url];
    const result = await apply(ctx, local, { prune: Boolean(ctx.flags.prune), dryRun: true, force: false, ...(instance && { base: instance.hashes }) }, '');
    const edited = localChanges(local, instance);
    const inSync = result.changes.length === 0;
    const data = { dir, url, inSync, lastSync: instance?.at ?? null, changes: result.changes, conflicts: result.conflicts, warnings: result.warnings, local: edited };
    return {
      data,
      exitCode: ctx.flags['exit-code'] && !inSync ? 1 : 0,
      human: () => {
        const parts = [
          fields([
            ['Directory', dir],
            ['Instance', url],
            ['Last sync', instance ? time(instance.at) : 'never'],
          ]),
          inSync ? 'The instance matches the directory.' : changeTable(result.changes, ''),
        ];
        const localLines = [...edited.added.map((p) => `  A ${p}`), ...edited.modified.map((p) => `  M ${p}`), ...edited.deleted.map((p) => `  D ${p}`)];
        if (instance && localLines.length) parts.push(`Edited locally since the last sync:\n${localLines.join('\n')}`);
        if (result.conflicts) parts.push(`${plural(result.conflicts, 'change')} conflict with edits made on the instance: pull to merge, or push --force.`);
        parts.push(...result.warnings.map((w) => `warning: ${w}`));
        return parts.join('\n\n');
      },
    };
  },
};

export const diff: Command = {
  name: 'sync diff',
  summary: 'A unified diff from the instance (a/) to the directory (b/): what a push would change, file by file',
  usage: '[--dir <path>] [<path>...] [--exit-code]',
  details: 'Paths limit the diff to those files or directories (relative to the sync directory). Differences of key order or whitespace alone are not shown.',
  flags: {
    ...dirFlag,
    values: flag.boolean('Compare variable values too (default: when variables.json has them)'),
    'exit-code': flag.boolean('Exit 1 when there are differences'),
  },
  async run(ctx) {
    const dir = syncDir(ctx);
    const url = ctx.connection.url;
    const local = readSyncDir(dir);
    requireSyncDir(dir, local);
    const instance = readState(dir).instances[url];
    const { files: remote } = await fetchExport(ctx, wantValues(ctx, local, instance));
    const filters = ctx.args.map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
    const included = (path: string) => !filters.length || filters.some((f) => path === f || path.startsWith(`${f}/`));
    const paths = [...new Set([...remote.keys(), ...local.keys()])].filter(included).sort();
    const files: Array<{ path: string; status: 'added' | 'removed' | 'modified'; diff: string }> = [];
    let identical = 0;
    for (const path of paths) {
      const before = remote.get(path);
      const after = local.get(path);
      if (before !== undefined && after !== undefined && sameDocument(before, after)) {
        identical++;
        continue;
      }
      files.push({ path, status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified', diff: unifiedDiff(path, before, after) });
    }
    return {
      data: { dir, url, files, identical },
      exitCode: ctx.flags['exit-code'] && files.length ? 1 : 0,
      human: () => (files.length ? files.map((f) => f.diff).join('').trimEnd() : `No differences between ${dir} and ${url}`),
    };
  },
};

// ---------------------------------------------------------------------------
// The host's own Git (Settings → Source control)
// ---------------------------------------------------------------------------

interface SourceControlView {
  configured: boolean;
  config?: { repository: string; branch: string; directory: string; includeVariableValues: boolean };
  tokenSource: string;
  credentialName?: string;
  workingCopy: string;
  lastPush?: { at: string; commit?: string; message?: string; count: number };
  lastPull?: { at: string; commit?: string; count: number };
}

export const scStatus: Command = {
  name: 'source-control status',
  summary: 'The host’s Git repository settings and its last push and pull',
  args: { max: 0 },
  async run(ctx) {
    const view = await ctx.client.get<SourceControlView>('/api/source-control');
    const run = (r?: { at: string; commit?: string; count: number }) => (r ? `${time(r.at)}${r.commit ? ` (${r.commit.slice(0, 7)})` : ''}, ${r.count}` : 'never');
    return {
      data: { sourceControl: view },
      human: () =>
        view.configured && view.config
          ? fields([
              ['Repository', view.config.repository],
              ['Branch', view.config.branch],
              ['Directory', view.config.directory || '/'],
              ['Token', view.tokenSource === 'credential' ? `credential ${view.credentialName ?? ''}`.trim() : view.tokenSource === 'env' ? 'LANDFLOW_GIT_TOKEN' : 'none'],
              ['Values', view.config.includeVariableValues ? 'variable values are committed' : 'names only'],
              ['Last push', run(view.lastPush)],
              ['Last pull', run(view.lastPull)],
            ])
          : 'Source control is not set up: Settings → Source control.',
    };
  },
};

export const scPush: Command = {
  name: 'source-control push',
  summary: 'The host commits its workflows to its Git repository and pushes the branch',
  usage: '[--message <text>] [--dry-run]',
  flags: { message: flag.string('The commit message', 'text', 'm'), 'dry-run': flag.boolean('Show what the commit would hold', 'n') },
  args: { max: 0 },
  async run(ctx) {
    const result = await ctx.client.post<{ dryRun: boolean; committed: boolean; commit?: string; branch: string; files: Array<{ status: string; path: string }> }>('/api/source-control/push', {
      ...(ctx.flags.message ? { message: ctx.flags.message } : {}),
      dryRun: Boolean(ctx.flags['dry-run']),
    });
    return {
      data: result,
      human: () => {
        if (!result.files.length) return `Nothing to commit: ${result.branch} is up to date${result.commit ? ` at ${result.commit.slice(0, 7)}` : ''}`;
        const count = plural(result.files.length, 'file');
        const head = result.dryRun ? `The commit on ${result.branch} would hold ${count}:` : `Pushed ${result.commit?.slice(0, 7)} to ${result.branch} (${count}):`;
        return `${head}\n${result.files.map((f) => `  ${f.status} ${f.path}`).join('\n')}`;
      },
    };
  },
};

export const scPull: Command = {
  name: 'source-control pull',
  summary: 'The host fetches its Git branch and applies the files (like `sync push` from the repository)',
  usage: '[--dry-run] [--prune] [--force]',
  flags: {
    'dry-run': flag.boolean('Show the plan, change nothing', 'n'),
    prune: flag.boolean('Delete what the repository has no file for'),
    force: flag.boolean('Apply changes that conflict with edits made on the instance', 'f'),
  },
  args: { max: 0 },
  async run(ctx) {
    const dryRun = Boolean(ctx.flags['dry-run']);
    const response = await ctx.client.request<ApplyResult & { commit: string; branch: string; error?: string }>('POST', '/api/source-control/pull', {
      body: { dryRun, prune: Boolean(ctx.flags.prune), force: Boolean(ctx.flags.force) },
      accept: [400, 409],
    });
    const { error, hashes: _hashes, ...result } = response.body;
    if (response.status === 400 && result.changes) throw new CliError('sync_failed', error ?? 'The repository files are invalid', { status: 400, details: result });
    if (response.status === 409 && result.changes) throw new CliError('conflict', `${error ?? 'Conflicts'}: push first, or pull with --force`, { status: 409, details: result });
    if (response.status !== 200) throw new CliError(response.status === 409 ? 'conflict' : 'bad_request', error ?? `Pull failed with ${response.status}`, { status: response.status });
    if (result.errors.length) throw new CliError('sync_failed', `${plural(result.errors.length, 'change')} failed: ${result.errors[0]}`, { details: result });
    return {
      data: result,
      human: () => {
        const pending = result.changes.filter((c) => !c.skipped);
        const commit = result.commit.slice(0, 7);
        const head = dryRun
          ? `Pulling ${commit} would make ${plural(pending.length, 'change')}`
          : pending.length
            ? `Applied ${plural(result.appliedCount, 'change')} from ${commit}`
            : `Up to date with ${result.branch} (${commit})`;
        return [head, result.changes.length ? changeTable(result.changes, '') : '', ...result.warnings.map((w) => `warning: ${w}`)].filter(Boolean).join('\n\n');
      },
    };
  },
};

export const syncCommands = [pull, push, status, diff, scStatus, scPush, scPull];
