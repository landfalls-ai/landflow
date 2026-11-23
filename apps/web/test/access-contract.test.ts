/**
 * C35-C2 U-7: `lib/server/access/systems.ts` against the REAL plugins. Every operation it names exists in the real descriptors with
 * the parameters it sends, and one add, check and remove per system goes through `runAction` to the real GitHub Access node (in
 * process, against the plugin's stateful fake GitHub) and the real Google Workspace plugin (the Go binary, against `cmd/fakegoogle`).
 * Opt in: `LANDFLOW_INTEGRATION=access` (needs `go`); without it the file skips and nothing starts.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSystem } from '../src/lib/shared/access';

const enabled = (process.env.LANDFLOW_INTEGRATION ?? '').split(/[,\s]+/).includes('access');
const ROOT = resolve(__dirname, '../../..');
const GOOGLE_DIR = join(ROOT, 'plugins/google-workspace');

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-contract-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
if (enabled) Object.assign(process.env, ENV);

const free = () =>
  new Promise<number>((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
const until = async (url: string, ms = 120_000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`${url} did not answer`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

const children: ChildProcess[] = [];
const closers: Array<() => Promise<void> | void> = [];
/** `go build` into the test's directory (cached, a few seconds), then the binary runs: stopping it stops the plugin. */
const build = (pkg: string, out: string) => {
  const done = spawnSync('go', ['build', '-o', out, pkg], { cwd: GOOGLE_DIR, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`go build ${pkg}: ${done.stderr}`);
  return out;
};
const start = (binary: string, args: string[], env: Record<string, string> = {}) => {
  const child = spawn(binary, args, { cwd: GOOGLE_DIR, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
  children.push(child);
  return child;
};

describe.skipIf(!enabled)('systems.ts against the real plugins', () => {
  let github: string;
  let google: string;
  let mods: Awaited<ReturnType<typeof load>>;
  const load = async () => {
    const { registry } = await import('../src/lib/server/plugins/registry');
    const { credentials } = await import('../src/lib/server/credentials/vault');
    const { defaultProjectId } = await import('../src/lib/server/projects/store');
    const { createOwner } = await import('../src/lib/server/auth/users');
    const { saveAccessSettings } = await import('../src/lib/server/access/store');
    const systems = await import('../src/lib/server/access/systems');
    const { runAction } = await import('../src/lib/server/access/actions');
    return { registry, credentials, defaultProjectId, createOwner, saveAccessSettings, ...systems, runAction };
  };
  let fakeGithub: { access: { teams: Map<string, Map<string, { state: string }>>; collaborators: Map<string, string>; orgMembers: Map<string, string>; projectRoles: Map<string, string>; users: Map<string, number> }; reset(): void };
  let googleBase: string;

  beforeAll(async () => {
    mods = await load();
    await mods.createOwner({ email: 'owner@landflow.test', name: 'Olive Owner', password: 'password-123' });
    mods.saveAccessSettings({ projectId: mods.defaultProjectId() });

    // The real GitHub plugin, in process, against its own stateful fake GitHub.
    const { plugin } = await import('../../../plugins/github/src/main');
    const { FakeGitHub, TOKEN } = await import('../../../plugins/github/test/fake-github');
    const { startFakeApi } = await import('../../../plugins/github/test/helpers');
    const fake = new FakeGitHub();
    fakeGithub = fake as unknown as typeof fakeGithub;
    const api = await startFakeApi(fake.handle);
    closers.push(() => api.close());
    mods.registry.registerBuiltin(plugin);
    github = mods.credentials.create({ name: 'GitHub', type: 'github.githubApi', data: { accessToken: TOKEN, baseUrl: `${api.url}/api/v3` } }).id;

    // The real Google plugin (the Go binary) against fakegoogle.
    const [fakePort, httpPort, grpcPort] = [await free(), await free(), await free()];
    const keyFile = join(ENV.LANDFLOW_DATA_DIR, 'fake-sa.pem');
    start(build('./cmd/fakegoogle', join(ENV.LANDFLOW_DATA_DIR, 'fakegoogle')), ['-addr', `127.0.0.1:${fakePort}`, '-key-out', keyFile]);
    googleBase = `http://127.0.0.1:${fakePort}`;
    await until(`${googleBase}/_fake/state`);
    await fetch(`${googleBase}/_fake/directory/groups`, { method: 'POST', body: JSON.stringify({ email: 'eng@example.com', name: 'Engineering' }) });
    start(build('.', join(ENV.LANDFLOW_DATA_DIR, 'google-plugin')), [], { LANDFLOW_REGISTRY_URL: 'off', LANDFLOW_HTTP_PORT: String(httpPort), LANDFLOW_GRPC_PORT: String(grpcPort) });
    await until(`http://127.0.0.1:${httpPort}/landflow/v1/health`, 60_000);
    await mods.registry.addEndpoint(`http://127.0.0.1:${httpPort}`, 'static');
    google = mods.credentials.create({ name: 'Google', type: 'google.googleApi', data: { email: 'robot@fake-project.iam.gserviceaccount.com', privateKey: readFileSync(keyFile, 'utf8'), delegatedEmail: 'admin@example.com', tokenUrl: `${googleBase}/token`, baseUrl: googleBase } }).id;
  }, 240_000);

  afterAll(async () => {
    for (const child of children) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        // gone
      }
    }
    for (const close of closers) await close();
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const targets: Array<{ system: AccessSystem; config: Record<string, string>; account: string; credential: () => string }> = [
    { system: 'github-team', config: { org: 'acme', team: 'platform', role: 'member' }, account: 'bob', credential: () => github },
    { system: 'github-org', config: { org: 'acme', role: 'direct_member' }, account: 'dave', credential: () => github },
    { system: 'github-repo', config: { owner: 'acme', repository: 'widgets', permission: 'push' }, account: 'outsider', credential: () => github },
    { system: 'github-project', config: { org: 'acme', projectNumber: '7', role: 'READER' }, account: 'bob', credential: () => github },
    { system: 'google-group', config: { groupKey: 'eng@example.com', role: 'MEMBER' }, account: 'dana@example.com', credential: () => google },
  ];

  it('every operation and parameter systems.ts sends exists in the real descriptors', () => {
    for (const t of targets) {
      for (const op of ['add', 'remove', 'check'] as const) {
        if (t.system === 'github-project' && op === 'check') continue;
        const { nodeType, parameters } = mods.callOf(t.system, op, t.config, t.account);
        const resolved = mods.registry.resolve(nodeType);
        expect('error' in resolved ? resolved.error : '', `${t.system} ${op}: ${nodeType}`).toBe('');
        if ('error' in resolved) continue;
        const properties = resolved.descriptor.properties ?? [];
        const names = new Set(properties.map((p) => p.name));
        for (const name of Object.keys(parameters)) expect(names.has(name), `${t.system} ${op}: parameter ${name} on ${nodeType}`).toBe(true);
        for (const key of ['resource', 'operation'] as const) {
          const values = new Set(properties.filter((p) => p.name === key).flatMap((p) => (p.options ?? []).map((o) => (o as { value: unknown }).value)));
          expect(values.has(parameters[key]), `${t.system} ${op}: ${key} ${String(parameters[key])} among ${[...values].join(', ')}`).toBe(true);
        }
      }
    }
  });

  for (const t of targets) {
    it(`${t.system}: add, check and remove through the real plugin`, async () => {
      const target = { system: t.system, config: mods.validateTarget(t.system, t.config), credentialId: t.credential(), account: t.account };
      const added = await mods.runAction(target, 'add');
      // GitHub can't say whether a project role was already so (`changed` is null there): only the others are checked for it.
      if (t.system !== 'github-project') expect(added.changed).toBe(true);
      if (t.system !== 'github-project') {
        const checked = await mods.runAction(target, 'check');
        expect(['active', 'pending']).toContain(checked.state);
      }
      if (t.system !== 'github-project') expect((await mods.runAction(target, 'add')).changed).toBe(false);
      const removed = await mods.runAction(target, 'remove');
      expect(removed.state).toBe('none');
      if (t.system !== 'github-project') expect((await mods.runAction(target, 'check')).state).toBe('none');
      if (t.system !== 'github-project') expect((await mods.runAction(target, 'remove')).changed).toBe(false);
    });
  }

  it('the fakes hold what the actions did (Google group is empty again, GitHub team too)', async () => {
    const state = (await (await fetch(`${googleBase}/_fake/state`)).json()) as Record<string, unknown>;
    expect(JSON.stringify(state)).not.toContain('dana@example.com');
    expect(fakeGithub.access.teams.get('platform')?.has('bob')).toBe(false);
  });
});
