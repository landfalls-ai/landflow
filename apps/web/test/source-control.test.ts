/**
 * Settings → Source control against a local bare repository in a temp directory (nothing leaves the machine): push
 * commits the instance as sync files, a teammate's clone changes them, pull applies the changes — dry runs, conflicts
 * with edits on the instance, prune, a sub-directory on another branch — plus repository validation and how a token
 * reaches git (GIT_ASKPASS and the environment, never the URL or the repository config).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { SourceControlPullResult, SourceControlPushResult, SourceControlView } from '@/lib/shared/sync';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-source-control-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_GIT_TOKEN;

const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { variables } = await import('@/lib/server/variables');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const git = await import('@/lib/server/sync/git');
const settingsRoute = await import('@/app/api/source-control/route');
const pushRoute = await import('@/app/api/source-control/push/route');
const pullRoute = await import('@/app/api/source-control/pull/route');

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const bare = temp('landflow-bare-');
const teammate = join(temp('landflow-teammate-'), 'clone');

/** git for the test's own clones: the host account's config ignored. */
const sh = (args: string[], cwd?: string) =>
  execFileSync('git', ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.test', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();

const json = (method: string, body?: unknown) =>
  new Request('http://source-control.test/api/source-control', { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });

async function configure(body: Record<string, unknown>) {
  const response = await settingsRoute.PUT(json('PUT', body));
  return { status: response.status, body: (await response.json()) as SourceControlView & { error?: string } };
}

async function push(body: { message?: string; dryRun?: boolean } = {}) {
  const response = await pushRoute.POST(json('POST', body));
  return { status: response.status, body: (await response.json()) as SourceControlPushResult & { error?: string } };
}

async function pull(body: { dryRun?: boolean; prune?: boolean; force?: boolean } = {}) {
  const response = await pullRoute.POST(json('POST', body));
  return { status: response.status, body: (await response.json()) as SourceControlPullResult & { error?: string } };
}

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra });
const workflow = (id: string, name: string, extra: Partial<Workflow> = {}): Workflow => ({
  id,
  name,
  nodes: [node('start', 'Start', 'core.manualTrigger'), node('set', 'Set', 'core.set', { mode: 'json', json: '{"v": 1}' })],
  connections: [{ id: 'e1', type: 'main', source: 'start', sourceIndex: 0, target: 'set', targetIndex: 0 }],
  ...extra,
});

/** Change a file in the teammate's clone, commit and push. */
function teammateCommits(message: string, change: () => void) {
  sh(['pull', '-q', '--ff-only', 'origin', 'main'], teammate);
  change();
  sh(['add', '-A'], teammate);
  sh(['commit', '-q', '-m', message], teammate);
  sh(['push', '-q', 'origin', 'HEAD:main'], teammate);
}
const editDoc = (path: string, change: (doc: Record<string, unknown>) => void) => {
  const full = join(teammate, path);
  const doc = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
  change(doc);
  writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`);
};

let secretId: string;

beforeAll(async () => {
  await ensureBootstrapped();
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
  sh(['init', '-q', '--bare', '--initial-branch=main', bare]);
  const secret = credentials.create({ name: 'Model key', type: 'core.openAiApi', data: { apiKey: 'sk-never-in-git' } });
  secretId = secret.id;
  store.saveWorkflow(workflow('wf_alpha', 'Alpha'));
  store.saveWorkflow({ ...workflow('wf_beta', 'Beta'), nodes: [...workflow('wf_beta', 'Beta').nodes, node('ai', 'Model', 'core.openAi', {}, { credentials: { openAiApi: { id: secret.id, name: 'Model key' } } })] });
  variables.create({ key: 'API_BASE', value: 'https://secret.example.com' });
});

describe('settings', () => {
  it('refuses repositories that could run commands or leak credentials', async () => {
    for (const repository of ['-uhelp', 'ext::sh -c touch% /tmp/pwned', 'https://user:token@github.com/acme/flows.git', 'relative/path', 'fd::17']) {
      const result = await configure({ repository });
      expect(result.status, repository).toBe(400);
    }
    expect((await configure({ repository: bare, branch: '../main' })).status).toBe(400);
    expect((await configure({ repository: bare, directory: '../outside' })).status).toBe(400);
    expect(git.repositoryProblem('git@github.com:acme/flows.git')).toBeUndefined();
    expect(git.repositoryProblem('https://github.com/acme/flows.git')).toBeUndefined();
    expect(git.repositoryProblem('ssh://git@host/flows.git')).toBeUndefined();
  });

  it('needs settings before pushing or pulling', async () => {
    expect((await push()).status).toBe(409);
    expect((await pull()).status).toBe(409);
  });

  it('saves the settings, with defaults', async () => {
    const result = await configure({ repository: bare });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      configured: true,
      config: { repository: bare, branch: 'main', directory: '', username: 'x-access-token', authorName: 'Landflow', authorEmail: 'landflow@localhost', includeVariableValues: false },
      tokenSource: 'none',
      workingCopy: join(dataDir, 'source-control', 'repo'),
    });
    expect((await settingsRoute.GET(json('GET'))).status).toBe(200);
  });
});

describe('push and pull', () => {
  it('pushes the instance as a commit: dry run first, nothing secret in it', async () => {
    const dry = await push({ dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, committed: false, branch: 'main' });
    expect(dry.body.files).toEqual(expect.arrayContaining([{ status: 'A', path: 'landflow-sync.json' }, { status: 'A', path: 'workflows/alpha.workflow.json' }]));
    expect(() => sh(['--git-dir', bare, 'rev-parse', '--verify', '-q', 'main'])).toThrow();

    const pushed = await push({ message: 'First snapshot' });
    expect(pushed.status).toBe(200);
    expect(pushed.body).toMatchObject({ dryRun: false, committed: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(sh(['--git-dir', bare, 'log', '-1', '--format=%s|%an|%ae', 'main'])).toBe('First snapshot|Landflow|landflow@localhost');
    expect(sh(['--git-dir', bare, 'rev-parse', 'main'])).toBe(pushed.body.commit);
    const tree = sh(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).split('\n');
    expect(tree).toEqual(['credentials.json', 'landflow-sync.json', 'variables.json', 'workflows/alpha.workflow.json', 'workflows/beta.workflow.json']);
    const everything = tree.map((path) => sh(['--git-dir', bare, 'show', `main:${path}`])).join('\n');
    expect(everything).not.toContain('sk-never-in-git');
    expect(everything).not.toContain(secretId);
    expect(everything).not.toContain('https://secret.example.com');
    expect(JSON.parse(sh(['--git-dir', bare, 'show', 'main:credentials.json']))).toEqual({ credentials: [{ name: 'Model key', type: 'core.openAiApi' }] });

    const again = await push();
    expect(again.body).toMatchObject({ committed: false, files: [], commit: pushed.body.commit });
    expect((await settingsRoute.GET(json('GET'))).status).toBe(200);
    expect(git.sourceControlView().lastPush).toMatchObject({ commit: pushed.body.commit, message: 'First snapshot', count: 5 });
  });

  it('pulls a teammate’s commit: dry run, then apply', async () => {
    sh(['clone', '-q', '--branch', 'main', bare, teammate]);
    teammateCommits('Rename alpha, add gamma', () => {
      editDoc('workflows/alpha.workflow.json', (doc) => {
        doc.name = 'Alpha (reviewed)';
      });
      writeFileSync(join(teammate, 'workflows/gamma.workflow.json'), `${JSON.stringify({ ...workflow('wf_gamma', 'Gamma'), active: false }, null, 2)}\n`);
    });

    const dry = await pull({ dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, applied: false, branch: 'main', commit: sh(['--git-dir', bare, 'rev-parse', 'main']) });
    expect(dry.body.changes.map((c) => [c.action, c.id])).toEqual([
      ['update', 'wf_alpha'],
      ['create', 'wf_gamma'],
    ]);
    expect(store.getWorkflow('wf_gamma')).toBeUndefined();

    const applied = await pull();
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ applied: true, appliedCount: 2, conflicts: 0 });
    expect(store.getWorkflow('wf_alpha')!.name).toBe('Alpha (reviewed)');
    expect(store.getWorkflow('wf_gamma')).toMatchObject({ name: 'Gamma' });
    expect(git.sourceControlView().lastPull).toMatchObject({ commit: applied.body.commit, count: 2 });
    // The working copy holds no credential config.
    expect(readFileSync(join(dataDir, 'source-control', 'repo', '.git', 'config'), 'utf8')).not.toMatch(/token|password|helper = [^\s]/i);
  });

  it('stops a pull over edits made on the instance since the last sync, unless forced', async () => {
    store.saveWorkflow({ ...store.getWorkflow('wf_beta')!, name: 'Beta (edited here)' });
    teammateCommits('Describe beta', () => {
      editDoc('workflows/beta.workflow.json', (doc) => {
        doc.description = 'from Git';
      });
    });
    const refused = await pull();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ applied: false, conflicts: 1 });
    expect(refused.body.changes).toEqual([expect.objectContaining({ id: 'wf_beta', conflict: 'changed on the instance since the last sync' })]);
    expect(store.getWorkflow('wf_beta')!.name).toBe('Beta (edited here)');

    const forced = await pull({ force: true });
    expect(forced.status).toBe(200);
    expect(store.getWorkflow('wf_beta')).toMatchObject({ name: 'Beta', description: 'from Git' });
    // The credential reference by name and type came back as this instance's credential.
    expect(store.getWorkflow('wf_beta')!.nodes.find((n) => n.id === 'ai')!.credentials).toEqual({ openAiApi: { id: secretId, name: 'Model key' } });
  });

  it('deletes what the branch dropped only with prune', async () => {
    teammateCommits('Drop gamma', () => rmSync(join(teammate, 'workflows/gamma.workflow.json')));
    const kept = await pull();
    expect(kept.body.changes).toEqual([expect.objectContaining({ action: 'delete', id: 'wf_gamma', skipped: 'prune' })]);
    expect(store.getWorkflow('wf_gamma')).toBeDefined();
    const pruned = await pull({ prune: true });
    expect(pruned.body).toMatchObject({ applied: true, appliedCount: 1 });
    expect(store.getWorkflow('wf_gamma')).toBeUndefined();
  });

  it('pushes the instance’s own edits on top of the teammate’s history', async () => {
    store.saveWorkflow({ ...store.getWorkflow('wf_alpha')!, description: 'edited in Landflow' });
    const pushed = await push({ message: 'Describe alpha' });
    // The file follows the renamed workflow; beta's file is rewritten in the canonical key order.
    expect(pushed.body).toMatchObject({ committed: true });
    expect(pushed.body.files).toEqual([
      { status: 'A', path: 'workflows/alpha-reviewed.workflow.json' },
      { status: 'D', path: 'workflows/alpha.workflow.json' },
      { status: 'M', path: 'workflows/beta.workflow.json' },
    ]);
    expect(JSON.parse(sh(['--git-dir', bare, 'show', 'main:workflows/alpha-reviewed.workflow.json']))).toMatchObject({ id: 'wf_alpha', description: 'edited in Landflow' });
    expect(sh(['--git-dir', bare, 'log', '--format=%s', 'main']).split('\n')).toEqual(['Describe alpha', 'Drop gamma', 'Describe beta', 'Rename alpha, add gamma', 'First snapshot']);
  });
});

describe('symbolic links in the repository', () => {
  it('reads a committed symlink as the plain file git would write without links, never the file it points at', async () => {
    const outside = temp('landflow-outside-');
    writeFileSync(join(outside, 'secret.json'), '{ "name": "TOPSECRET-VALUE" }');
    teammateCommits('Add a link', () => symlinkSync(join(outside, 'secret.json'), join(teammate, 'workflows/evil.workflow.json')));
    const linked = await pull({ dryRun: true });
    expect(linked.status).toBe(400);
    expect(linked.body.error).toContain('workflows/evil.workflow.json');
    expect(JSON.stringify(linked.body)).not.toContain('TOPSECRET-VALUE');
    teammateCommits('Remove the link', () => rmSync(join(teammate, 'workflows/evil.workflow.json')));
    expect((await pull({ dryRun: true })).status).toBe(200);
  });
});

describe('another branch and directory, and tokens', () => {
  it('writes into a sub-directory of another branch, keeping other files', async () => {
    const result = await configure({ repository: `file://${bare}`, branch: 'prod', directory: '/landflow/prod/', includeVariableValues: true });
    expect(result.body.config).toMatchObject({ branch: 'prod', directory: 'landflow/prod', includeVariableValues: true });
    expect(result.body.lastPush).toBeUndefined();
    const pushed = await push();
    expect(pushed.body).toMatchObject({ committed: true, branch: 'prod' });
    const tree = sh(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'prod']).split('\n');
    expect(tree.every((path) => path.startsWith('landflow/prod/'))).toBe(true);
    expect(JSON.parse(sh(['--git-dir', bare, 'show', 'prod:landflow/prod/variables.json']))).toEqual({ variables: [{ key: 'API_BASE', value: 'https://secret.example.com' }] });
    expect((await pull({ dryRun: true })).body.changes).toEqual([]);
  });

  it('hands a token to git through GIT_ASKPASS and the environment only', async () => {
    const env = git.gitEnvironment({ token: 'ghp_example', username: 'oauth2' });
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LANDFLOW_GIT_USERNAME: 'oauth2', LANDFLOW_GIT_PASSWORD: 'ghp_example' });
    expect(existsSync(env.GIT_ASKPASS!)).toBe(true);
    expect(readFileSync(env.GIT_ASKPASS!, 'utf8')).not.toContain('ghp_example');
    expect(execFileSync(env.GIT_ASKPASS!, ['Password for https://github.com: '], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' })).toBe('ghp_example\n');
    expect(execFileSync(env.GIT_ASKPASS!, ['Username for https://github.com: '], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' })).toBe('oauth2\n');
    expect(git.gitEnvironment()).not.toHaveProperty('GIT_ASKPASS');

    const token = credentials.create({ name: 'Git token', type: 'core.httpBearerAuth', data: { token: 'ghp_from_credential' } });
    const view = await configure({ repository: bare, credentialId: token.id });
    expect(view.body).toMatchObject({ tokenSource: 'credential', credentialName: 'Git token' });
    expect((await push()).status).toBe(200);
    expect(readFileSync(join(dataDir, 'source-control', 'repo', '.git', 'config'), 'utf8')).not.toContain('ghp_from_credential');
    expect((await configure({ repository: bare, credentialId: 'cred_missing' })).status).toBe(404);
  });

  it('disconnects: settings forgotten, working copy removed, repository untouched', async () => {
    const head = sh(['--git-dir', bare, 'rev-parse', 'main']);
    const response = await settingsRoute.DELETE(json('DELETE'));
    expect(((await response.json()) as SourceControlView).configured).toBe(false);
    expect(existsSync(join(dataDir, 'source-control'))).toBe(false);
    expect(sh(['--git-dir', bare, 'rev-parse', 'main'])).toBe(head);
  });
});
