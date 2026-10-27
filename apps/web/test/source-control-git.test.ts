/**
 * Source control beyond the full push: committing some workflows only (their files and folders; the rest of the branch is
 * left alone), a workflow's history in Git (the commits that touched its file, the diff, restoring a version as a draft),
 * and SSH remotes with a private key from a credential (the ssh command, host key pinning). Local bare repositories; the
 * real SSH round trip runs against the throwaway sshd of the compose `git` profile
 * (LANDFLOW_INTEGRATION=git-ssh, after deploy/infra/git/gen-keys.sh and `--profile git up -d git-ssh`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { GitCommitDetail, GitHistory, SourceControlPullResult, SourceControlPushResult, SourceControlView } from '@/lib/shared/sync';

vi.setConfig({ testTimeout: 90_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-source-control-git-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_GIT_TOKEN;

const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { folders } = await import('@/lib/server/folders');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const git = await import('@/lib/server/sync/git');
const settingsRoute = await import('@/app/api/source-control/route');
const pushRoute = await import('@/app/api/source-control/push/route');
const pullRoute = await import('@/app/api/source-control/pull/route');
const hostKeysRoute = await import('@/app/api/source-control/host-keys/route');
const historyRoute = await import('@/app/api/workflows/[id]/git-history/route');
const commitRoute = await import('@/app/api/workflows/[id]/git-history/[commit]/route');
const restoreRoute = await import('@/app/api/workflows/[id]/git-history/[commit]/restore/route');

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const bare = temp('landflow-bare-');
const teammate = join(temp('landflow-teammate-'), 'clone');
const sh = (args: string[], cwd?: string) =>
  execFileSync('git', ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.test', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
const req = (method: string, body?: unknown, url = 'http://sc.test/api') => new Request(url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

const configure = async (body: Record<string, unknown>) => {
  const response = await settingsRoute.PUT(req('PUT', body));
  return { status: response.status, body: (await response.json()) as SourceControlView & { error?: string } };
};
const push = async (body: Record<string, unknown> = {}) => {
  const response = await pushRoute.POST(req('POST', body));
  return { status: response.status, body: (await response.json()) as SourceControlPushResult & { error?: string } };
};
const pull = async (body: Record<string, unknown> = {}) => {
  const response = await pullRoute.POST(req('POST', body));
  return { status: response.status, body: (await response.json()) as SourceControlPullResult & { error?: string } };
};
const history = async (id: string) => {
  const response = await historyRoute.GET(req('GET'), params({ id }));
  return { status: response.status, body: (await response.json()) as GitHistory & { error?: string } };
};

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
const workflow = (id: string, name: string, value = 1, extra: Partial<Workflow> = {}): Workflow => ({
  id,
  name,
  nodes: [node('start', 'Start', 'core.manualTrigger'), node('set', 'Set', 'core.set', { mode: 'json', json: `{"v": ${value}}` })],
  connections: [{ id: 'e1', type: 'main', source: 'start', sourceIndex: 0, target: 'set', targetIndex: 0 }],
  ...extra,
});

beforeAll(async () => {
  await ensureBootstrapped();
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
  sh(['init', '-q', '--bare', '--initial-branch=main', bare]);
});

describe('commit some workflows', () => {
  it('commits only the picked workflows (and their folders); the rest of the branch stays', async () => {
    folders.create({ id: 'fd_team', name: 'Team' });
    store.saveWorkflow(workflow('wf_one', 'One'));
    store.saveWorkflow(workflow('wf_two', 'Two', 1, { folderId: 'fd_team' }));
    store.saveWorkflow(workflow('wf_three', 'Three'));
    expect((await configure({ repository: bare })).status).toBe(200);

    // Nothing there yet: the first push is a picked one. Only the picked files are committed.
    const first = await push({ workflowIds: ['wf_one'], message: 'Just one' });
    expect(first.status).toBe(200);
    expect(first.body.files.map((f) => f.path).sort()).toEqual(['landflow-sync.json', 'workflows/one.workflow.json']);
    expect(sh(['--git-dir', bare, 'log', '-1', '--format=%s', 'main'])).toBe('Just one');

    // A picked workflow in a folder brings its folder file; the one already on the branch stays.
    const second = await push({ workflowIds: ['wf_two'] });
    expect(second.body.files.map((f) => f.path).sort()).toEqual(['workflows/team/.folder.json', 'workflows/team/two.workflow.json']);
    expect(sh(['--git-dir', bare, 'log', '-1', '--format=%s', 'main'])).toBe('Update “Two” from Landflow');
    expect(sh(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).split('\n').sort()).toEqual(['landflow-sync.json', 'workflows/one.workflow.json', 'workflows/team/.folder.json', 'workflows/team/two.workflow.json']);

    // Unknown workflow: 404, nothing changes.
    expect((await push({ workflowIds: ['wf_missing'] })).status).toBe(404);
    // Nothing changed for the picked one: nothing to commit.
    expect((await push({ workflowIds: ['wf_one'] })).body.committed).toBe(false);
  });

  it('a renamed workflow replaces its old file instead of leaving a second one', async () => {
    store.saveWorkflow({ ...store.getWorkflow('wf_one')!, name: 'One renamed' });
    const result = await push({ workflowIds: ['wf_one'] });
    expect(result.body.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['A workflows/one-renamed.workflow.json', 'D workflows/one.workflow.json']);
    expect(sh(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).split('\n')).not.toContain('workflows/one.workflow.json');
  });

  it('a full push after picked ones still commits the rest, and a pull sees no conflicts it caused', async () => {
    const full = await push();
    expect(full.body.committed).toBe(true);
    expect(full.body.files.map((f) => f.path)).toContain('workflows/three.workflow.json');
    const dry = await pull({ dryRun: true });
    expect(dry.body.conflicts).toBe(0);
  });

  it('keeps the pull base for the workflows that were not picked', async () => {
    // Changed on the instance after the full push, never pushed; a picked push of another workflow must not hide that.
    store.saveWorkflow({ ...store.getWorkflow('wf_three')!, name: 'Three edited here' });
    store.saveWorkflow(workflow('wf_four', 'Four'));
    await push({ workflowIds: ['wf_four'] });
    // A teammate changes Three in Git; the pull sees that Three also changed here: a conflict.
    sh(['clone', '-q', bare, teammate]);
    const file = join(teammate, 'workflows/three.workflow.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    doc.description = 'edited in git';
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    sh(['add', '-A'], teammate);
    sh(['commit', '-q', '-m', 'Teammate edits Three'], teammate);
    sh(['push', '-q', 'origin', 'HEAD:main'], teammate);
    const dry = await pull({ dryRun: true });
    expect(dry.body.changes.find((c) => c.id === 'wf_three')).toMatchObject({ conflict: 'changed on the instance since the last sync' });
  });
});

describe('a workflow’s history in Git', () => {
  it('lists the commits that touched its file, follows renames, and shows a commit’s diff', async () => {
    const result = await history('wf_one');
    expect(result.status).toBe(200);
    expect(result.body.branch).toBe('main');
    expect(result.body.path).toBe('workflows/one-renamed.workflow.json');
    expect(result.body.commits.map((c) => c.subject)).toEqual(expect.arrayContaining(['Just one']));
    expect(result.body.commits.length).toBeGreaterThanOrEqual(2);
    const oldest = result.body.commits.at(-1)!;
    expect(oldest).toMatchObject({ subject: 'Just one', path: 'workflows/one.workflow.json', author: 'Landflow' });

    // Three's history includes the teammate's commit.
    const three = await history('wf_three');
    expect(three.body.commits[0]).toMatchObject({ subject: 'Teammate edits Three', author: 'Teammate' });

    const detail = await commitRoute.GET(req('GET', undefined, `http://sc.test/api?path=${encodeURIComponent(three.body.commits[0].path)}`), params({ id: 'wf_three', commit: three.body.commits[0].commit }));
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as GitCommitDetail;
    expect(body.diff).toContain('+  "description": "edited in git"');
    expect(body.workflow).toMatchObject({ name: 'Three', nodes: 2 });
  });

  it('refuses another workflow’s file, other paths and bad commit ids', async () => {
    const one = await history('wf_one');
    const asThree = await commitRoute.GET(req('GET', undefined, `http://sc.test/api?path=${encodeURIComponent(one.body.path!)}`), params({ id: 'wf_three', commit: one.body.commits[0].commit }));
    expect(asThree.status).toBe(404);
    const traversal = await commitRoute.GET(req('GET', undefined, `http://sc.test/api?path=${encodeURIComponent('../../etc/passwd')}`), params({ id: 'wf_one', commit: one.body.commits[0].commit }));
    expect(traversal.status).toBe(400);
    const variables = await commitRoute.GET(req('GET', undefined, `http://sc.test/api?path=${encodeURIComponent('variables.json')}`), params({ id: 'wf_one', commit: one.body.commits[0].commit }));
    expect(variables.status).toBe(400);
    const bad = await commitRoute.GET(req('GET', undefined, `http://sc.test/api?path=${encodeURIComponent(one.body.path!)}`), params({ id: 'wf_one', commit: '--output=/tmp/x' }));
    expect(bad.status).toBe(400);
    expect((await history('wf_missing')).status).toBe(404);
  });

  it('restores an old version as a draft: a new version, not published, folder kept', async () => {
    const { listVersions } = await import('@/lib/server/versions');
    const { publishedVersionId } = await import('@/lib/server/publications');
    store.saveWorkflow({ ...store.getWorkflow('wf_two')!, nodes: workflow('x', 'x', 2).nodes });
    const before = listVersions('wf_two').length;
    const result = await history('wf_two');
    const commit = result.body.commits.at(-1)!;
    const response = await restoreRoute.POST(req('POST', { path: commit.path }), params({ id: 'wf_two', commit: commit.commit }));
    expect(response.status, JSON.stringify([await response.clone().json(), commit])).toBe(200);
    const restored = store.getWorkflow('wf_two')!;
    expect(JSON.stringify(restored.nodes)).toContain('\\"v\\": 1');
    expect(restored.folderId).toBe('fd_team');
    expect(listVersions('wf_two').length).toBe(before + 1);
    expect(publishedVersionId('wf_two')).toBeUndefined();
    expect((await restoreRoute.POST(req('POST', { path: commit.path }), params({ id: 'wf_one', commit: commit.commit }))).status).toBe(404);
  });
});

describe('SSH remotes with a key from a credential', () => {
  it('builds an ssh command that uses only that key and the pinned host keys', () => {
    const command = git.sshCommand({ key: '/tmp/a b/id', knownHosts: '/tmp/a b/kh' }, false);
    expect(command).toContain("-i '/tmp/a b/id'");
    for (const option of ['IdentitiesOnly=yes', 'IdentityAgent=none', 'ForwardAgent=no', 'StrictHostKeyChecking=yes', "UserKnownHostsFile='/tmp/a b/kh'", `GlobalKnownHostsFile=${devNull}`, 'PasswordAuthentication=no', 'BatchMode=yes', 'ClearAllForwardings=yes']) expect(command).toContain(option);
    expect(command).toContain(`-F ${devNull}`);
    expect(git.sshCommand({ key: '/k', knownHosts: '/h' }, true)).not.toContain('BatchMode');
  });

  it('needs an ssh repository and pinned host keys, and validates them', async () => {
    const key = credentials.create({ name: 'Deploy key', type: 'core.sshPrivateKey', data: { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----' } });
    expect((await configure({ repository: bare, sshCredentialId: key.id, knownHosts: '[h]:22 ssh-ed25519 AAAA' })).status).toBe(400);
    expect((await configure({ repository: 'git@example.test:acme/flows.git', sshCredentialId: key.id })).status).toBe(400);
    expect((await configure({ repository: 'git@example.test:acme/flows.git', sshCredentialId: key.id, knownHosts: 'not a host key line' })).status).toBe(400);
    const saved = await configure({ repository: 'git@example.test:acme/flows.git', sshCredentialId: key.id, knownHosts: 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHd9tv' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ transport: 'ssh', sshCredentialName: 'Deploy key', config: { sshCredentialId: key.id } });
    // The key never comes back from the API.
    expect(JSON.stringify(saved.body)).not.toContain('PRIVATE KEY');
    expect((await hostKeysRoute.POST(req('POST', { repository: bare }))).status).toBe(400);
  });
});

const sshEnabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('git-ssh'));
const keysDir = resolve(__dirname, '../../../deploy/infra/git/keys');
const sshPort = Number(process.env.LANDFLOW_GIT_SSH_PORT) || 52222;

describe.skipIf(!sshEnabled)('SSH round trip against the compose `git` profile', () => {
  const repoName = `landflow-${Math.random().toString(36).slice(2, 10)}.git`;
  const url = `ssh://git@127.0.0.1:${sshPort}/srv/git/${repoName}`;
  let knownHosts = '';
  let keyId = '';

  /** ssh to the throwaway server with the dev key (to create the bare repository there). */
  const remote = (command: string, hosts: string) => {
    const file = join(dataDir, 'test-known-hosts');
    writeFileSync(file, hosts);
    return execFileSync('ssh', ['-F', devNull, '-i', join(keysDir, 'id_ed25519'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${file}`, '-o', 'StrictHostKeyChecking=yes', '-p', String(sshPort), 'git@127.0.0.1', command], { encoding: 'utf8' });
  };

  it('fetches the host keys, pushes with the credential’s key, and refuses a host key that is not pinned', async () => {
    expect(existsSync(join(keysDir, 'id_ed25519'))).toBe(true);
    const scanned = await hostKeysRoute.POST(req('POST', { repository: url }));
    expect(scanned.status).toBe(200);
    const scan = (await scanned.json()) as { keys: Array<{ type: string; fingerprint: string }>; knownHosts: string };
    expect(scan.keys.length).toBeGreaterThan(0);
    expect(scan.keys[0].fingerprint).toMatch(/^SHA256:/);
    knownHosts = scan.knownHosts;
    remote(`git init -q --bare --initial-branch=main /srv/git/${repoName}`, knownHosts);

    keyId = credentials.create({ name: 'Dev deploy key', type: 'core.sshPrivateKey', data: { privateKey: readFileSync(join(keysDir, 'id_ed25519'), 'utf8') } }).id;
    store.saveWorkflow(workflow('wf_ssh', 'Over SSH'));
    expect((await configure({ repository: url, branch: 'main', sshCredentialId: keyId, knownHosts })).status).toBe(200);
    const pushed = await push({ workflowIds: ['wf_ssh'], message: 'Over ssh' });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body.committed).toBe(true);
    expect(remote(`git --git-dir /srv/git/${repoName} log -1 --format=%s main`, knownHosts).trim()).toBe('Over ssh');
    expect((await pull({ dryRun: true })).status).toBe(200);

    // No temporary key files are left behind.
    const left = execFileSync('find', [join(dataDir, 'source-control'), '-name', 'id', '-o', '-name', 'known_hosts'], { encoding: 'utf8' }).trim();
    expect(left).toBe('');

    // A different host key than the pinned one: the connection is refused (no trust on first use, no fallback).
    const other = execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dataDir, 'other')], { encoding: 'utf8' });
    expect(other).toBeDefined();
    const wrong = `[127.0.0.1]:${sshPort} ${readFileSync(join(dataDir, 'other.pub'), 'utf8').split(' ').slice(0, 2).join(' ')}\n`;
    expect((await configure({ repository: url, branch: 'main', sshCredentialId: keyId, knownHosts: wrong })).status).toBe(200);
    const refused = await push({ workflowIds: ['wf_ssh'] });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatch(/host key verification failed|Host key|REMOTE HOST IDENTIFICATION/i);
  });

  it('works with a passphrase-protected key too', async () => {
    const passphraseKey = credentials.create({
      name: 'Dev key with passphrase',
      type: 'core.sshPrivateKey',
      data: { privateKey: readFileSync(join(keysDir, 'id_ed25519_passphrase'), 'utf8'), passphrase: 'landflow-dev-only' },
    }).id;
    expect((await configure({ repository: url, branch: 'main', sshCredentialId: passphraseKey, knownHosts })).status).toBe(200);
    const result = await push({ workflowIds: ['wf_ssh'] });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  });
});
