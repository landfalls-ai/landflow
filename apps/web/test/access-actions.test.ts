/**
 * C35 (docs/access-requests.md#systems): each system's target is checked, and add, check and remove go through the
 * system's plugin node with the entry's credential, from the host, in a mode that is never `tool`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-actions-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { defaultProjectId, setHomeProject, createTeamProject } = await import('@/lib/server/projects/store');
const { createOwner } = await import('@/lib/server/auth/users');
const { fake, fakeGithubPlugin, fakeGooglePlugin } = await import('./fixtures/fake-access-plugins');
const { saveAccessSettings } = await import('@/lib/server/access/store');
const { SYSTEMS, validateTarget, validateGithubLogin, targetOf } = await import('@/lib/server/access/systems');
const { runAction } = await import('@/lib/server/access/actions');
const { AccessActionError, AccessError } = await import('@/lib/server/access/errors');

registry.registerBuiltin(fakeGithubPlugin);
registry.registerBuiltin(fakeGooglePlugin);

await createOwner({ email: 'owner@landflow.test', name: 'Olive Owner', password: 'password-123' });
const TOKEN = 'ghp_the-secret-token-value';
const github = credentials.create({ name: 'GitHub', type: 'github.githubApi', data: { accessToken: TOKEN } });
const google = credentials.create({ name: 'Google', type: 'google.googleApi', data: { privateKey: 'google-private-key-value' } });
const googleOAuth = credentials.create({ name: 'Google OAuth', type: 'google.googleOAuth2Api', data: { refreshToken: 'google-refresh-token-value' } });
saveAccessSettings({ projectId: defaultProjectId() });

beforeEach(() => {
  fake.reset();
  fake.seedTeam('acme', 'platform');
  fake.seedOrg('acme');
  fake.seedRepo('acme', 'widgets');
  fake.seedProject('acme', 7);
  fake.seedGroup('eng@example.com');
});

const team = { system: 'github-team' as const, config: validateTarget('github-team', { org: 'acme', team: 'platform' }), credentialId: github.id, account: 'octocat' };
const group = { system: 'google-group' as const, config: validateTarget('google-group', { groupKey: 'eng@example.com' }), credentialId: google.id, account: 'dana@example.com' };

describe('targets', () => {
  const rejects = (system: Parameters<typeof validateTarget>[0], input: Record<string, unknown>, field: string) => {
    try {
      validateTarget(system, input);
    } catch (error) {
      expect(error).toBeInstanceOf(AccessError);
      expect((error as InstanceType<typeof AccessError>).status).toBe(400);
      expect((error as InstanceType<typeof AccessError>).details).toMatchObject({ field });
      return;
    }
    throw new Error('expected a 400');
  };
  it('refuses a bad value and names the field', () => {
    rejects('github-team', { org: 'acme', team: '' }, 'team');
    rejects('github-team', { org: 'acme/evil', team: 'x' }, 'org');
    rejects('github-team', { org: '..', team: 'x' }, 'org');
    rejects('github-repo', { owner: 'acme', repository: 'w', permission: 'owner' }, 'permission');
    rejects('github-project', { org: 'acme', projectNumber: 'seven' }, 'projectNumber');
    rejects('google-group', { groupKey: 'eng' }, 'groupKey');
    rejects('google-group', { groupKey: 'eng@example.com', role: 'BOSS' }, 'role');
    expect(() => validateGithubLogin('-bad-')).toThrow(AccessError);
    expect(validateGithubLogin(' octocat ')).toBe('octocat');
  });
  it('keeps only the system’s own fields, with the defaults, and labels the target', () => {
    expect(validateTarget('github-team', { org: ' acme ', team: 'platform', extra: 'x' })).toEqual({ org: 'acme', team: 'platform', role: 'member' });
    expect(validateTarget('github-repo', { owner: 'acme', repository: 'widgets' })).toEqual({ owner: 'acme', repository: 'widgets', permission: 'pull' });
    expect(targetOf('github-team', team.config)).toMatchObject({ key: 'acme/platform', type: 'github-team', label: 'GitHub team acme/platform (member)' });
    expect(SYSTEMS.manual.nodeType).toBeUndefined();
  });
});

describe('actions', () => {
  it('adds a member, sees them, and adding again changes nothing', async () => {
    expect(await runAction(team, 'check')).toMatchObject({ state: 'none' });
    expect(await runAction(team, 'add')).toEqual({ changed: true, state: 'active', alreadyHad: false });
    expect(fake.members('teams', 'acme/platform')).toEqual({ octocat: 'member' });
    expect(await runAction(team, 'check')).toMatchObject({ state: 'active' });
    expect(await runAction(team, 'add')).toEqual({ changed: false, state: 'active', alreadyHad: true });
  });

  it('says alreadyHad for access a person had before, even a higher one', async () => {
    fake.seedTeam('acme', 'platform', { octocat: 'maintainer' });
    expect(await runAction(team, 'add')).toMatchObject({ changed: false, alreadyHad: true });
    expect(fake.members('teams', 'acme/platform')).toEqual({ octocat: 'maintainer' });
  });

  it('removes a member, and removing a non-member succeeds with changed false', async () => {
    await runAction(team, 'add');
    expect(await runAction(team, 'remove')).toMatchObject({ changed: true, state: 'none' });
    expect(fake.members('teams', 'acme/platform')).toEqual({});
    expect(await runAction(team, 'remove')).toMatchObject({ changed: false, state: 'none' });
  });

  it('reaches the organization, a repository, a project and a Google group', async () => {
    const org = { system: 'github-org' as const, config: validateTarget('github-org', { org: 'acme' }), credentialId: github.id, account: 'octocat' };
    const repo = { system: 'github-repo' as const, config: validateTarget('github-repo', { owner: 'acme', repository: 'widgets', permission: 'push' }), credentialId: github.id, account: 'octocat' };
    const project = { system: 'github-project' as const, config: validateTarget('github-project', { org: 'acme', projectNumber: '7', role: 'WRITER' }), credentialId: github.id, account: 'octocat' };
    await runAction(org, 'add');
    await runAction(repo, 'add');
    await runAction(project, 'add');
    await runAction(group, 'add');
    expect(fake.members('orgs', 'acme')).toEqual({ octocat: 'direct_member' });
    expect(fake.members('repos', 'acme/widgets')).toEqual({ octocat: 'push' });
    expect(fake.members('projects', 'acme/7')).toEqual({ octocat: 'WRITER' });
    expect(fake.members('groups', 'eng@example.com')).toEqual({ 'dana@example.com': 'MEMBER' });
    expect(await runAction(group, 'check')).toMatchObject({ state: 'active' });
    expect(await runAction(group, 'add')).toMatchObject({ changed: false, alreadyHad: true });
    await runAction(group, 'remove');
    expect(fake.members('groups', 'eng@example.com')).toEqual({});
    await expect(runAction(project, 'check')).rejects.toThrow(AccessError);
  });

  it('calls the node from the host in trigger mode with the credential, never as a tool, and uses the credential type of an OAuth Google entry', async () => {
    await runAction(team, 'add');
    await runAction({ ...group, credentialId: googleOAuth.id }, 'add');
    expect(fake.calls.map((c) => [c.type, c.mode, c.credential])).toEqual([['github.githubAccess', 'trigger', true], ['google.googleDirectory', 'trigger', true]]);
    expect(fake.calls[1]!.parameters).toMatchObject({ authentication: 'oAuth2', resource: 'member', operation: 'add', groupKey: 'eng@example.com', memberKey: 'dana@example.com', role: 'MEMBER' });
  });

  it('answers the plugin’s own message when it says no', async () => {
    fake.teams.clear();
    await expect(runAction(team, 'add')).rejects.toThrow('No team acme/platform');
    await expect(runAction(team, 'add')).rejects.toBeInstanceOf(AccessActionError);
  });

  it('never lets a token out in the message', async () => {
    fake.failNext = 'GitHub answered 401 for {{token}}';
    const error = await runAction(team, 'add').catch((e: Error) => e);
    expect(error).toBeInstanceOf(AccessActionError);
    expect((error as Error).message).toMatch(/redacted/i);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('refuses a credential the access project can no longer use before any call', async () => {
    setHomeProject('credential', github.id, createTeamProject({ name: 'Elsewhere' }).id);
    fake.calls.length = 0;
    await expect(runAction(team, 'add')).rejects.toThrow(/no longer be used/);
    expect(fake.calls).toEqual([]);
    setHomeProject('credential', github.id, defaultProjectId()!);
    await expect(runAction({ ...team, credentialId: undefined }, 'add')).rejects.toThrow(/no credential/);
  });

  it('has no automatic action for a manual entry', async () => {
    await expect(runAction({ system: 'manual', config: {}, account: '' }, 'add')).rejects.toThrow(AccessError);
  });
});
