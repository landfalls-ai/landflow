/**
 * A project's workspace for harness runs (docs/projects-and-goals.md#workspace): the pure helpers, validation, the route's
 * roles, the audit (never the setup text), a removed repository dropping out, defaults, deleting the project, and the card's markup.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE, SETUP_LINES_MAX, SETUP_LINE_MAX, branchFor, isValidBranch, templateProblem, workspaceSlug, type ProjectWorkspace, type ProjectWorkspaceView } from '@/lib/shared/project-workspace';
import { ProjectWorkspaceBody, draftFrom, exampleBranch, workspaceFrom } from '@/components/projects/project-workspace-card';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-workspace-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, setMember, setProjectRepos } = await import('@/lib/server/projects/store');
const { deleteProjectWithTransfer } = await import('@/lib/server/projects/transfer');
const { projectsDb } = await import('@/lib/server/projects/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const route = await import('@/app/api/projects/[id]/workspace/route');

const admin = await createUser({ email: 'admin@project-workspace.test', name: 'Ada', role: 'member', password: 'admin-password-1' });
const editor = await createUser({ email: 'editor@project-workspace.test', name: 'Ed', role: 'member', password: 'editor-password-1' });
const viewer = await createUser({ email: 'viewer@project-workspace.test', name: 'Vi', role: 'member', password: 'viewer-password-1' });
const stranger = await createUser({ email: 'stranger@project-workspace.test', name: 'Sam', role: 'member', password: 'stranger-password-1' });
const project = createTeamProject({ name: 'Billing revamp', createdBy: admin.id });
setMember(project.id, admin.id, 'admin');
setMember(project.id, editor.id, 'editor');
setMember(project.id, viewer.id, 'viewer');
setProjectRepos(project.id, ['acme/web', 'acme/api']);

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = async (id = project.id) => {
  const response = await route.GET(new Request(`http://localhost/api/projects/${id}/workspace`), params(id));
  return { status: response.status, body: (await response.json()) as ProjectWorkspaceView & { error?: string } };
};
const put = async (body: unknown, id = project.id) => {
  const response = await route.PUT(new Request(`http://localhost/api/projects/${id}/workspace`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params(id));
  return { status: response.status, body: (await response.json()) as ProjectWorkspaceView & { error?: string } };
};
const workspace = (over: Partial<ProjectWorkspace> = {}): ProjectWorkspace => ({
  repos: { 'acme/web': { defaultBranch: 'develop', setup: ['pnpm install', 'pnpm build'] } },
  worktree: 'per-run',
  branchTemplate: 'landflow/{project}/{run}',
  ...over,
});

describe('the helpers', () => {
  it('workspaceSlug', () => {
    expect(workspaceSlug('Billing revamp')).toBe('billing-revamp');
    expect(workspaceSlug('Café — Ünïcode!!')).toBe('cafe-unicode');
    expect(workspaceSlug('!!!')).toBe('project');
    expect(workspaceSlug('x'.repeat(80)).length).toBe(40);
  });
  it('branchFor fills known tokens, makes values safe and leaves unknown tokens', () => {
    expect(branchFor('landflow/{project}/{run}', { project: 'billing-revamp', run: 'R1 a/2' })).toBe('landflow/billing-revamp/r1-a-2');
    expect(branchFor('x/{task}/{nope}', { project: 'p' })).toBe('x/{task}/{nope}');
    expect(branchFor('{project}', { project: '..Odd' })).toBe('odd');
  });
  it('isValidBranch', () => {
    for (const ok of ['main', 'landflow/billing/r1', 'a.b-c_d']) expect(isValidBranch(ok)).toBe(true);
    for (const bad of ['', '/a', 'a/', 'a..b', 'a b', 'a//b', '-a', 'a.', 'a/.b', 'a.lock', 'a~b', 'a@{b', '@', 'a:b']) expect(isValidBranch(bad)).toBe(false);
  });
  it('templateProblem', () => {
    expect(templateProblem(DEFAULT_WORKSPACE.branchTemplate)).toBeUndefined();
    expect(templateProblem('')).toMatch(/Give a branch template/);
    expect(templateProblem('x/{who}')).toMatch(/Unknown token \{who\}/);
    expect(templateProblem('a b/{run}')).toMatch(/not a valid branch name/);
    expect(templateProblem('x'.repeat(200))).toMatch(/At most/);
  });
});

describe('GET before anything is saved', () => {
  it('is the default, not saved, with the project’s repositories', async () => {
    enableTestAuth(admin);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ workspace: DEFAULT_WORKSPACE, repos: ['acme/web', 'acme/api'], saved: false, canEdit: true, setupShown: true });
  });
  it('is 404 without a role', async () => {
    enableTestAuth(stranger);
    const { status, body } = await get();
    expect(status).toBe(404);
    expect(body.error).toBe('Project not found');
    expect((await get('prj_nope')).status).toBe(404);
  });
});

describe('PUT validation', () => {
  it('refuses an unknown repository, a bad branch, too many or too long lines, and a bad template', async () => {
    enableTestAuth(admin);
    const cases: Array<[ProjectWorkspace, RegExp]> = [
      [workspace({ repos: { 'acme/other': {} } }), /“acme\/other” isn't one of this project's repositories/],
      [workspace({ repos: { 'acme/web': { defaultBranch: 'a b' } } }), /not a valid branch name/],
      [workspace({ repos: { 'acme/web': { setup: Array.from({ length: SETUP_LINES_MAX + 1 }, (_, i) => `echo ${i}`) } } }), /At most 10 setup lines/],
      [workspace({ repos: { 'acme/web': { setup: ['x'.repeat(SETUP_LINE_MAX + 1)] } } }), /longer than 300/],
      [workspace({ repos: { 'acme/web': { setup: ['echo \u0007'] } } }), /control character/],
      [workspace({ branchTemplate: 'x/{who}' }), /Unknown token/],
      [workspace({ branchTemplate: 'a b/{run}' }), /not a valid branch name/],
    ];
    for (const [input, message] of cases) {
      const { status, body } = await put(input);
      expect(status).toBe(400);
      expect(body.error).toMatch(message);
    }
    expect((await put({ repos: {}, worktree: 'sideways', branchTemplate: 'a/{run}' })).status).toBe(400);
    expect((await get()).body.saved).toBe(false);
  });
});

describe('roles', () => {
  it('an editor reads with setup but gets 403 on PUT', async () => {
    enableTestAuth(editor);
    expect((await get()).body.setupShown).toBe(true);
    const { status, body } = await put(workspace());
    expect(status).toBe(403);
    expect(body.error).toBe('Only the project’s admins change its workspace');
  });

  it('an admin saves, blank setup lines are dropped, and the audit holds no setup text', async () => {
    enableTestAuth(admin);
    const { status, body } = await put(workspace({ repos: { 'acme/web': { defaultBranch: ' develop ', setup: ['pnpm install', '', '  secret-token-line  '] } } }));
    expect(status).toBe(200);
    expect(body.saved).toBe(true);
    expect(body.workspace.repos['acme/web']).toEqual({ defaultBranch: 'develop', setup: ['pnpm install', 'secret-token-line'] });
    const events = queryEvents({ action: ['project.workspace.update'] }, { limit: 10 }).events;
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events[0]);
    expect(text).not.toContain('secret-token-line');
    expect(text).not.toContain('pnpm install');
    expect(events[0]?.details).toMatchObject({ repos: 'acme/web', setupLines: 'acme/web: 2' });
  });

  it('a viewer reads the repositories and branches without setup', async () => {
    enableTestAuth(viewer);
    const { body } = await get();
    expect(body.setupShown).toBe(false);
    expect(body.canEdit).toBe(false);
    expect(body.workspace.repos['acme/web']).toEqual({ defaultBranch: 'develop' });
    expect((await put(workspace())).status).toBe(403);
  });
});

describe('a removed repository', () => {
  it('drops out on read, and a broken stored value reads as the default', async () => {
    setProjectRepos(project.id, ['acme/api']);
    enableTestAuth(admin);
    const { body } = await get();
    expect(body.workspace.repos).toEqual({});
    expect(body.repos).toEqual(['acme/api']);
    setProjectRepos(project.id, ['acme/web', 'acme/api']);
    projectsDb().upsert('project_workspaces', { project_id: project.id, data: '{not json', updated_at: new Date().toISOString(), updated_by: null });
    const broken = (await get()).body;
    expect(broken.workspace).toEqual(DEFAULT_WORKSPACE);
    expect(broken.saved).toBe(false);
    await put(workspace());
  });

  it('is pruned from the stored row, so re-adding it starts empty', async () => {
    enableTestAuth(admin);
    await put(workspace({ repos: { 'acme/web': { defaultBranch: 'develop', setup: ['pnpm install'] }, 'acme/api': { defaultBranch: 'main' } } }));
    setProjectRepos(project.id, ['acme/api']);
    const raw = projectsDb().get<{ data: string }>('SELECT data FROM project_workspaces WHERE project_id = ?', project.id);
    expect(JSON.parse(raw!.data).repos).toEqual({ 'acme/api': { defaultBranch: 'main' } });
    setProjectRepos(project.id, ['acme/web', 'acme/api']);
    expect((await get()).body.workspace.repos).toEqual({ 'acme/api': { defaultBranch: 'main' } });
    await put(workspace());
  });
});

describe('saving the same workspace again', () => {
  it('writes nothing and records no audit event', async () => {
    enableTestAuth(admin);
    await put(workspace({ worktree: 'shared' }));
    const count = () => queryEvents({ action: ['project.workspace.update'] }, { limit: 100 }).events.length;
    const before = count();
    const updatedAt = projectsDb().get<{ updated_at: string }>('SELECT updated_at FROM project_workspaces WHERE project_id = ?', project.id)?.updated_at;
    const { status, body } = await put(workspace({ worktree: 'shared' }));
    expect(status).toBe(200);
    expect(body.workspace.worktree).toBe('shared');
    expect(count()).toBe(before);
    expect(projectsDb().get<{ updated_at: string }>('SELECT updated_at FROM project_workspaces WHERE project_id = ?', project.id)?.updated_at).toBe(updatedAt);
    await put(workspace());
    expect(count()).toBe(before + 1);
  });
});

describe('deleting the project', () => {
  it('removes its workspace row', async () => {
    const doomed = createTeamProject({ name: 'Doomed', createdBy: admin.id });
    setMember(doomed.id, admin.id, 'admin');
    setProjectRepos(doomed.id, ['acme/web']);
    enableTestAuth(admin);
    expect((await put(workspace(), doomed.id)).status).toBe(200);
    expect(projectsDb().get('SELECT * FROM project_workspaces WHERE project_id = ?', doomed.id)).toBeTruthy();
    deleteProjectWithTransfer(doomed.id);
    expect(projectsDb().get('SELECT * FROM project_workspaces WHERE project_id = ?', doomed.id)).toBeUndefined();
  });
});

describe('the card', () => {
  const view = (over: Partial<ProjectWorkspaceView> = {}): ProjectWorkspaceView => ({
    workspace: workspace(),
    repos: ['acme/web', 'acme/api'],
    saved: true,
    canEdit: true,
    setupShown: true,
    ...over,
  });
  const render = (v: ProjectWorkspaceView, newRepo = '') => renderToStaticMarkup(createElement(ProjectWorkspaceBody, { view: v, draft: draftFrom(v), projectName: 'Billing revamp', newRepo }));

  it('an admin sees the add field, remove buttons, setup, the example and Save', () => {
    const html = render(view());
    expect(html).toContain('acme/web');
    expect(html).toContain('Remove acme/web');
    expect(html).toContain('Add a repository');
    expect(html).toContain('pnpm install');
    expect(html).toContain('Landflow never runs these. A harness may, in its own sandbox.');
    expect(html).toContain('One per run');
    expect(html).toContain('Save workspace');
    expect(html).toContain('landflow/billing-revamp/r1a2b3');
  });
  it('a viewer sees repositories and branches, no setup, no controls', () => {
    const html = render(view({ canEdit: false, setupShown: false, workspace: { ...workspace(), repos: { 'acme/web': { defaultBranch: 'develop' } } } }));
    expect(html).toContain('acme/web');
    expect(html).toContain('develop');
    expect(html).not.toContain('pnpm install');
    expect(html).not.toContain('Save workspace');
    expect(html).not.toContain('Remove acme/web');
    expect(html).toContain('shown to the project’s editors and admins');
  });
  it('with no repositories it says so, and an admin gets the add field', () => {
    const html = render(view({ repos: [], workspace: DEFAULT_WORKSPACE }));
    expect(html).toContain('Add a repository a harness works in');
    expect(html).toContain('owner/name');
    expect(render(view({ repos: [], canEdit: false, workspace: DEFAULT_WORKSPACE }))).not.toContain('Add a repository"');
  });
  it('a bad template shows its message, and a bad new repository says Use owner/name', () => {
    const v = view();
    const html = renderToStaticMarkup(createElement(ProjectWorkspaceBody, { view: v, draft: { ...draftFrom(v), branchTemplate: 'x/{who}' }, projectName: 'Billing revamp', newRepo: 'nope' }));
    expect(html).toContain('Unknown token {who}');
    expect(html).toContain('Use owner/name');
  });
  it('workspaceFrom leaves out a repository with nothing set; exampleBranch uses the date', () => {
    const v = view();
    expect(workspaceFrom(draftFrom(v)).repos).toEqual({ 'acme/web': { defaultBranch: 'develop', setup: ['pnpm install', 'pnpm build'] } });
    expect(exampleBranch('{project}/{date}/{task}', 'Billing revamp', new Date('2026-11-15T10:00:00Z'))).toBe('billing-revamp/2026-11-15/t42');
  });
});
