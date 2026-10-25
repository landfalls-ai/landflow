/**
 * `landflow sync` against a real host: pull → edit → push → the instance matches; prune; conflicts both ways (edits
 * on the instance since the last sync stop a push, local edits stop a pull); a stable diff; variable values only when
 * asked for; files that don't validate change nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;
const dir = mkdtempSync(join(tmpdir(), 'landflow-cli-sync-'));

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters });
const workflow = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  nodes: [node('start', 'Start', 'core.manualTrigger'), node('set', 'Set', 'core.set', { mode: 'json', json: '{"v": 1}' })],
  connections: [{ id: 'e1', type: 'main', source: 'start', sourceIndex: 0, target: 'set', targetIndex: 0 }],
  ...extra,
});

const read = (path: string) => readFileSync(join(dir, path), 'utf8');
const readDoc = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const writeDoc = (path: string, doc: unknown) => writeFileSync(join(dir, path), `${JSON.stringify(doc, null, 2)}\n`);
const sync = (args: string[], options: Parameters<typeof cli>[1] = {}) => cli(['sync', ...args, '--dir', dir, '--json'], options);

beforeAll(async () => {
  host = await startHost();
  cli = cliFor(host);
  ({ store } = await web('lib/server/store'));
  const { folders } = await web('lib/server/folders');
  const { variables } = await web('lib/server/variables');
  const { dataTables } = await web('lib/server/datatables');
  const ops = folders.create({ name: 'Ops', id: 'fld_ops' });
  store.saveWorkflow(workflow('wf_top', 'Top flow'));
  store.saveWorkflow({ ...workflow('wf_ops', 'Nightly report'), folderId: ops.id });
  store.saveWorkflow(workflow('wf_gone', 'Soon deleted'));
  variables.create({ key: 'API_BASE', value: 'https://api.example.com' });
  dataTables().createTable({ name: 'Leads', columns: [{ name: 'email', type: 'string' }] });
});

afterAll(async () => {
  await host?.close();
});

describe('sync', () => {
  it('pulls the instance into files', async () => {
    const pulled = await sync(['pull']);
    expect(pulled.code).toBe(0);
    expect(pulled.json).toEqual({
      ok: true,
      dir,
      url: host.url,
      dryRun: false,
      values: false,
      written: [
        'credentials.json',
        'data-tables/leads.schema.json',
        'landflow-sync.json',
        'variables.json',
        'workflows/ops/.folder.json',
        'workflows/ops/nightly-report.workflow.json',
        'workflows/soon-deleted.workflow.json',
        'workflows/top-flow.workflow.json',
      ],
      removed: [],
      unchanged: 0,
      conflicts: [],
      summary: { workflows: 3, folders: 1, variables: 1, dataTables: 1, credentials: 0 },
    });
    expect(readDoc('workflows/ops/.folder.json')).toEqual({ id: 'fld_ops', name: 'Ops' });
    expect(readDoc('variables.json')).toEqual({ variables: [{ key: 'API_BASE' }] });
    expect(Object.keys(readDoc('workflows/top-flow.workflow.json')).slice(0, 2)).toEqual(['id', 'name']);
    expect(read('.landflow/.gitignore')).toBe('*\n');
    expect(JSON.parse(read('.landflow/state.json')).instances[host.url]).toMatchObject({ url: host.url, values: false, files: expect.any(Object), hashes: expect.any(Object) });

    // Pulling again changes nothing; status and diff agree.
    expect((await sync(['pull'])).json).toMatchObject({ written: [], removed: [], unchanged: 8 });
    const status = await sync(['status', '--exit-code']);
    expect(status.code).toBe(0);
    expect(status.json).toEqual({ ok: true, dir, url: host.url, inSync: true, lastSync: expect.any(String), changes: [], conflicts: 0, warnings: [], local: { added: [], modified: [], deleted: [] } });
    const diff = await sync(['diff', '--exit-code']);
    expect(diff.code).toBe(0);
    expect(diff.json).toEqual({ ok: true, dir, url: host.url, files: [], identical: 8 });
  });

  it('pushes edits, new files and (with --prune) deletes; the instance then matches the files', async () => {
    const top = readDoc('workflows/top-flow.workflow.json');
    top.name = 'Top flow v2';
    (top.nodes as Array<{ parameters: Record<string, unknown> }>)[1].parameters.json = '{"v": 2}';
    writeDoc('workflows/top-flow.workflow.json', top);
    writeDoc('workflows/ops/brand-new.workflow.json', { ...workflow('wf_new', 'Brand new'), id: undefined });
    rmSync(join(dir, 'workflows/soon-deleted.workflow.json'));

    // A stable diff: instance (a/) → files (b/), the same every time.
    const diff = await sync(['diff', '--exit-code']);
    expect(diff.code).toBe(1);
    expect(diff.json.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
      ['workflows/ops/brand-new.workflow.json', 'added'],
      ['workflows/soon-deleted.workflow.json', 'removed'],
      ['workflows/top-flow.workflow.json', 'modified'],
    ]);
    const modified = diff.json.files[2].diff as string;
    expect(modified).toMatch(/^--- a\/workflows\/top-flow\.workflow\.json\n\+\+\+ b\/workflows\/top-flow\.workflow\.json\n@@ -\d+,\d+ \+\d+,\d+ @@\n/);
    expect(modified).toContain('-  "name": "Top flow",\n+  "name": "Top flow v2",');
    expect(modified).toContain('-        "json": "{\\"v\\": 1}"\n+        "json": "{\\"v\\": 2}"');
    expect((await sync(['diff'])).json).toEqual(diff.json);
    const human = await cli(['sync', 'diff', '--dir', dir, 'workflows/top-flow.workflow.json']);
    expect(human.stdout).toBe(modified);

    const status = await sync(['status']);
    expect(status.json.inSync).toBe(false);
    expect(status.json.local).toEqual({ added: ['workflows/ops/brand-new.workflow.json'], modified: ['workflows/top-flow.workflow.json'], deleted: ['workflows/soon-deleted.workflow.json'] });

    const dry = await sync(['push', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ dryRun: true, applied: false, appliedCount: 0, conflicts: 0, errors: [] });
    expect(store.getWorkflow('wf_top').name).toBe('Top flow');

    const pushed = await sync(['push']);
    expect(pushed.code).toBe(0);
    expect(Object.keys(pushed.json).sort()).toEqual(['applied', 'appliedCount', 'changes', 'conflicts', 'dir', 'dryRun', 'errors', 'ok', 'url', 'warnings']);
    expect(pushed.json.changes.map((c: { kind: string; action: string; name: string; skipped?: string }) => [c.action, c.kind, c.name, c.skipped ?? null])).toEqual([
      ['create', 'workflow', 'Brand new', null],
      ['update', 'workflow', 'Top flow v2', null],
      ['delete', 'workflow', 'Soon deleted', 'prune'],
    ]);
    expect(pushed.json.appliedCount).toBe(2);
    expect(store.getWorkflow('wf_top')).toMatchObject({ name: 'Top flow v2', nodes: [{ id: 'start' }, { id: 'set', parameters: { json: '{"v": 2}' } }] });
    const created = store.listWorkflows().find((w: { name: string }) => w.name === 'Brand new');
    expect(created).toMatchObject({ folderId: 'fld_ops' });
    expect(store.getWorkflow('wf_gone')).toBeDefined();

    const pruned = await sync(['push', '--prune']);
    expect(pruned.json.changes).toEqual([expect.objectContaining({ action: 'delete', kind: 'workflow', id: 'wf_gone' })]);
    expect(store.getWorkflow('wf_gone')).toBeUndefined();

    // Pull writes the canonical files back (the new workflow gets its id) without asking for --force: they were pushed.
    const repull = await sync(['pull']);
    expect(repull.code).toBe(0);
    expect(repull.json.conflicts).toEqual([]);
    expect(readDoc('workflows/ops/brand-new.workflow.json').id).toBe(created.id);
    expect((await sync(['diff', '--exit-code'])).code).toBe(0);
    expect((await sync(['status'])).json).toMatchObject({ inSync: true, local: { added: [], modified: [], deleted: [] } });
  });

  it('stops a push over edits made on the instance since the last sync, unless --force', async () => {
    store.saveWorkflow({ ...store.getWorkflow('wf_ops'), name: 'Edited in the editor' });
    const doc = readDoc('workflows/ops/nightly-report.workflow.json');
    doc.description = 'edited in Git';
    writeDoc('workflows/ops/nightly-report.workflow.json', doc);

    const status = await sync(['status']);
    expect(status.json.conflicts).toBe(1);
    expect(status.json.changes).toEqual([expect.objectContaining({ id: 'wf_ops', action: 'update', conflict: 'changed on the instance since the last sync' })]);
    const refused = await sync(['push']);
    expect(refused.code).toBe(5);
    expect(refused.json.error).toMatchObject({ code: 'conflict', status: 409, details: { conflicts: 1, applied: false } });
    expect(store.getWorkflow('wf_ops').name).toBe('Edited in the editor');

    const forced = await sync(['push', '--force']);
    expect(forced.code).toBe(0);
    expect(store.getWorkflow('wf_ops')).toMatchObject({ name: 'Nightly report', description: 'edited in Git' });
  });

  it('won’t overwrite files edited locally since the last pull, unless --force', async () => {
    await sync(['pull']);
    const doc = readDoc('workflows/top-flow-v2.workflow.json');
    doc.description = 'local work in progress';
    writeDoc('workflows/top-flow-v2.workflow.json', doc);
    store.saveWorkflow({ ...store.getWorkflow('wf_top'), name: 'Renamed on the instance' });

    const refused = await sync(['pull']);
    expect(refused.code).toBe(5);
    expect(refused.json.error).toMatchObject({ code: 'conflict', details: { conflicts: ['workflows/top-flow-v2.workflow.json'] } });
    expect(readDoc('workflows/top-flow-v2.workflow.json').description).toBe('local work in progress');
    const dry = await sync(['pull', '--dry-run']);
    expect(dry.json).toMatchObject({ dryRun: true, conflicts: ['workflows/top-flow-v2.workflow.json'] });

    const forced = await sync(['pull', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.json.removed).toEqual(['workflows/top-flow-v2.workflow.json']);
    expect(existsSync(join(dir, 'workflows/top-flow-v2.workflow.json'))).toBe(false);
    expect(readDoc('workflows/renamed-on-the-instance.workflow.json')).toMatchObject({ id: 'wf_top', name: 'Renamed on the instance' });
  });

  it('writes variable values only when asked, and remembers', async () => {
    const withValues = await sync(['pull', '--values']);
    expect(withValues.json.values).toBe(true);
    expect(readDoc('variables.json')).toEqual({ variables: [{ key: 'API_BASE', value: 'https://api.example.com' }] });
    expect((await sync(['pull'])).json).toMatchObject({ values: true, written: [] });
    writeDoc('variables.json', { variables: [{ key: 'API_BASE', value: 'https://v2.example.com' }, { key: 'REGION', value: 'eu' }] });
    const pushed = await sync(['push']);
    expect(pushed.json.changes.map((c: { action: string; id: string }) => [c.action, c.id])).toEqual([
      ['update', 'API_BASE'],
      ['create', 'REGION'],
    ]);
    const { variables } = await web('lib/server/variables');
    expect(variables.list()).toEqual([
      { key: 'API_BASE', value: 'https://v2.example.com' },
      { key: 'REGION', value: 'eu' },
    ]);
  });

  it('changes nothing when a file doesn’t validate, and needs a sync directory', async () => {
    writeFileSync(join(dir, 'workflows/broken.workflow.json'), '{ "name": ');
    const broken = await sync(['push']);
    expect(broken.code).toBe(1);
    expect(broken.json.error).toMatchObject({ code: 'sync_failed', status: 400, details: { applied: false, errors: [expect.stringContaining('broken.workflow.json')] } });
    rmSync(join(dir, 'workflows/broken.workflow.json'));

    // Symbolic links are neither read nor written through.
    const outside = mkdtempSync(join(tmpdir(), 'landflow-cli-outside-'));
    writeFileSync(join(outside, 'secret.json'), '{"not": "a workflow"}');
    symlinkSync(join(outside, 'secret.json'), join(dir, 'workflows/linked.workflow.json'));
    expect((await sync(['status'])).json.changes).toEqual([]);
    rmSync(join(dir, 'workflows/linked.workflow.json'));
    rmSync(join(dir, 'workflows/ops'), { recursive: true });
    symlinkSync(outside, join(dir, 'workflows/ops'));
    const through = await sync(['pull', '--force']);
    expect(through.code).toBe(1);
    expect(through.json.error).toMatchObject({ code: 'io', message: expect.stringContaining('symbolic link') });
    rmSync(join(dir, 'workflows/ops'));
    expect((await sync(['pull', '--force'])).code).toBe(0);

    const empty = mkdtempSync(join(tmpdir(), 'landflow-cli-empty-'));
    const notSync = await cli(['sync', 'push', '--dir', empty, '--json']);
    expect(notSync.code).toBe(2);
    expect(notSync.json.error.message).toContain('landflow-sync.json');
  });

  it('asks the host to push and pull its own repository', async () => {
    const status = await cli(['source-control', 'status', '--json']);
    expect(status.code).toBe(0);
    expect(status.json.sourceControl).toMatchObject({ configured: false, tokenSource: expect.any(String) });
    const unset = await cli(['source-control', 'push', '--json']);
    expect(unset.code).toBe(5);
    expect(unset.json.error).toMatchObject({ code: 'conflict', status: 409, message: expect.stringContaining('set up') });

    // A local bare repository in a temp directory: nothing leaves this machine.
    const bare = mkdtempSync(join(tmpdir(), 'landflow-cli-bare-'));
    execFileSync('git', ['init', '--bare', '--quiet', bare]);
    const configured = await fetch(`${host.url}/api/source-control`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repository: bare, branch: 'main' }) });
    expect(configured.status).toBe(200);

    const dry = await cli(['source-control', 'push', '--dry-run', '--json']);
    expect(dry.json).toMatchObject({ ok: true, dryRun: true, committed: false, branch: 'main', files: expect.arrayContaining([{ status: 'A', path: 'landflow-sync.json' }]) });
    const pushed = await cli(['source-control', 'push', '-m', 'Snapshot from the CLI', '--json']);
    expect(pushed.code).toBe(0);
    expect(pushed.json).toMatchObject({ ok: true, dryRun: false, committed: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/), branch: 'main' });
    expect(execFileSync('git', ['--git-dir', bare, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('Snapshot from the CLI');

    const pulled = await cli(['source-control', 'pull', '--json']);
    expect(pulled.code).toBe(0);
    expect(pulled.json).toMatchObject({ ok: true, commit: pushed.json.commit, branch: 'main', applied: true, changes: [], conflicts: 0 });
    expect((await cli(['source-control', 'status', '--json'])).json.sourceControl).toMatchObject({ configured: true, lastPush: { commit: pushed.json.commit }, lastPull: { commit: pushed.json.commit } });
  });
});
