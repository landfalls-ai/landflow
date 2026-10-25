/**
 * `landflow env status/promote/pull` against a real host and a local bare repository: the host is development,
 * promotes its branch to staging (preview with a diff, then for real), a hotfix on the staging branch makes the next
 * promotion a conflict (exit 5 with the preview in `error.details`) until --force; then the host becomes staging and
 * pulls its branch with --publish. The JSON shapes are the contract (README: JSON output).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const sh = (args: string[], cwd?: string) =>
  execFileSync('git', ['-c', 'user.name=Hotfixer', '-c', 'user.email=hotfix@example.test', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
const bare = temp('landflow-cli-env-bare-');
sh(['init', '-q', '--bare', bare]);

const workflow = (description?: string) => ({
  id: 'wf_env',
  name: 'Env flow',
  ...(description && { description }),
  nodes: [
    { id: 'start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'set', name: 'Set', type: 'core.set', typeVersion: 1, position: [200, 0], parameters: { mode: 'json', json: '{"v": 1}' } },
  ],
  connections: [{ id: 'e1', type: 'main', source: 'start', sourceIndex: 0, target: 'set', targetIndex: 0 }],
});

const put = (path: string, body: unknown) => fetch(`${host.url}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  delete process.env.LANDFLOW_ENVIRONMENT;
  delete process.env.LANDFLOW_ENVIRONMENT_PROTECTED;
  host = await startHost();
  cli = cliFor(host);
  ({ store } = await web('lib/server/store'));
});

afterAll(async () => {
  delete process.env.LANDFLOW_ENVIRONMENT;
  await host?.close();
});

describe('env', () => {
  it('status: no environment by default', async () => {
    const status = await cli(['env', 'status', '--json']);
    expect(status.code).toBe(0);
    expect(status.json).toMatchObject({ ok: true, environment: { protected: false, protectedSource: 'none', publishOnPull: 'file', sourceControl: false } });
    expect(status.json.environment.name).toBeUndefined();
    expect((await cli(['env', 'status'])).stdout).toMatch(/no environment/);
  });

  it('promote: preview, promote, conflict (exit 5) and --force', async () => {
    process.env.LANDFLOW_ENVIRONMENT = 'development';
    expect((await put('/api/source-control', { repository: bare, branch: 'development' })).status).toBe(200);
    store.saveWorkflow(workflow());
    expect((await cli(['source-control', 'push', '--json'])).code).toBe(0);

    const status = await cli(['env', 'status', '--json']);
    expect(status.json.environment).toMatchObject({ name: 'development', branch: 'development', environments: [{ name: 'development', current: true }, { name: 'staging', branch: 'staging' }, { name: 'production' }] });

    const preview = await cli(['env', 'promote', 'staging', '--dry-run', '--json']);
    expect(preview.code).toBe(0);
    expect(preview.json).toMatchObject({ ok: true, dryRun: true, promoted: false, conflicts: 0, from: { environment: 'development' }, to: { environment: 'staging', branch: 'staging' } });
    expect(preview.json.entries).toEqual([expect.objectContaining({ id: 'wf_env', name: 'Env flow', status: 'added' })]);
    expect((await cli(['env', 'promote', 'staging', '--dry-run', '--diff'])).stdout).toContain('+++ b/workflows/env-flow.workflow.json');

    const promoted = await cli(['env', 'promote', 'staging', '--workflow', 'Env flow', '--json']);
    expect(promoted.code).toBe(0);
    expect(promoted.json).toMatchObject({ ok: true, promoted: true });
    expect(promoted.json.commit).toBe(sh(['rev-parse', 'refs/heads/staging'], bare));

    // A hotfix straight on staging, and a change here: a conflict.
    const clone = join(temp('landflow-cli-env-clone-'), 'clone');
    sh(['clone', '-q', '--branch', 'staging', bare, clone]);
    const file = join(clone, 'workflows', 'env-flow.workflow.json');
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), description: 'hotfix' }, null, 2)}\n`);
    sh(['commit', '-q', '-am', 'Hotfix'], clone);
    sh(['push', '-q', 'origin', 'HEAD:staging'], clone);
    store.saveWorkflow(workflow('changed in development'));
    expect((await cli(['source-control', 'push', '--json'])).code).toBe(0);

    const conflict = await cli(['env', 'promote', 'staging', '--json']);
    expect(conflict.code).toBe(5);
    expect(conflict.json).toMatchObject({ ok: false, error: { code: 'conflict', status: 409 } });
    expect(conflict.json.error.details.entries[0]).toMatchObject({ id: 'wf_env', status: 'modified', conflict: expect.stringMatching(/changed this workflow since the last promotion/) });
    const forced = await cli(['env', 'promote', 'staging', '--force', '--json']);
    expect(forced.code).toBe(0);
    expect(forced.json.promoted).toBe(true);
    expect((await cli(['env', 'promote', 'staging', '--force'])).stdout).toMatch(/Nothing to promote/);

    expect((await cli(['env', 'promote', 'development', '--json'])).code).toBe(1);
    expect((await cli(['env', 'promote', '--json'])).code).toBe(2);
  });

  it('pull: the host as staging pulls its branch and publishes', async () => {
    process.env.LANDFLOW_ENVIRONMENT = 'staging';
    expect((await put('/api/source-control', { repository: bare, branch: 'staging' })).status).toBe(200);
    store.deleteWorkflow('wf_env');

    const dry = await cli(['env', 'pull', '--dry-run', '--json']);
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ ok: true, dryRun: true, branch: 'staging' });
    expect(dry.json.changes).toContainEqual(expect.objectContaining({ kind: 'workflow', action: 'create', id: 'wf_env' }));

    expect((await cli(['env', 'pull', '--publish', 'sometimes', '--json'])).code).toBe(2);
    const pulled = await cli(['env', 'pull', '--publish', 'all', '--json']);
    expect(pulled.code).toBe(0);
    expect(pulled.json).toMatchObject({ ok: true, applied: true, branch: 'staging' });
    expect(store.getWorkflow('wf_env').description).toBe('changed in development');
    const { productionWorkflowById } = await web('lib/server/publish');
    expect(productionWorkflowById('wf_env')).toBeDefined();
    // Publishing on pull doesn't make the next pull see a change in `active`; a `file` pull follows the file (inactive).
    expect((await cli(['env', 'pull', '--publish', 'all'])).stdout).toMatch(/Up to date with staging/);
    const byFile = await cli(['env', 'pull', '--json']);
    expect(byFile.json.changes).toEqual([expect.objectContaining({ action: 'update', id: 'wf_env', fields: ['active'] })]);
    expect(productionWorkflowById('wf_env')).toBeUndefined();
  });
});
