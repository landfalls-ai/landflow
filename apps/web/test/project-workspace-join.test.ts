/**
 * The join of a project's workspace (contracts/w9/project-workspace.ts, project-context-api.ts as PC16 amended it) with
 * wave 8's project context for harnesses (PC10's route and repositories, PC11's parsers in the landflow-brain mod and
 * `landflow work context`): the workspace is saved as the Workspace card builds it, through PC16's real route, and the
 * real `GET /api/projects/context` answer goes through both parsers, which must give exactly the section they gave before.
 * Seeds the data of `project-context-example.json` (as project-context-harness-join.test.ts does).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import example from '@/lib/shared/project-context-example.json';
import type { ProjectContextAnswer } from '@/lib/shared/project-context-api';
import type { ProjectWorkspaceView } from '@/lib/shared/project-workspace';
import { draftFrom, workspaceFrom } from '../src/components/projects/project-workspace-card';
import { parseProjectContext, projectQuery, projectReply, projectSection } from '../claude-plugins/landflow-brain/hooks/project';
import { contextHuman, parseContext } from '../../../packages/cli/src/work/context';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-workspace-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations (the goals source, the provider) are the real ones.
await import('@/lib/server/runtime');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, setMember, updateProjectBrief } = await import('@/lib/server/projects/store');
const { createGoalAs, setProjectGoalsAs } = await import('@/lib/server/goals/views');
const contextRoute = await import('@/app/api/projects/context/route');
const projectRoute = await import('@/app/api/projects/[id]/route');
const workspaceRoute = await import('@/app/api/projects/[id]/workspace/route');

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// The example's data: two projects list acme/web; the first has a goal chain and a brief.
enableTestAuth();
const owner = { id: TEST_OWNER.id, role: 'owner' as const };
const billing = createTeamProject({ name: 'Billing revamp' });
const checkout = createTeamProject({ name: 'Checkout' });
updateProjectBrief(billing.id, { brief: 'Move invoices to usage-based pricing without breaking existing plans.' });
const company = createGoalAs(owner, { level: 'company', title: 'Grow paid accounts', status: 'active' });
const goal = createGoalAs(owner, { level: 'project', projectId: billing.id, parentId: company.id, title: 'Ship usage-based billing', status: 'active' });
setProjectGoalsAs(owner, billing.id, [goal.id]);
const setRepos = async (id: string, repos: string[]) => {
  const response = await projectRoute.PATCH(new Request(`http://localhost/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repos }) }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
};
await setRepos(billing.id, ['acme/web']);
await setRepos(checkout.id, ['Acme/Web']);

const viewer = await createUser({ email: 'vic@workspace-join.test', name: 'Vic', role: 'member', password: 'viewer-password-1' });
setMember(billing.id, viewer.id, 'viewer');

const ask = async (query: string) => {
  const response = await contextRoute.GET(new Request(`http://localhost/api/projects/context?${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as ProjectContextAnswer;
};
const exampleIds = (answer: unknown) => JSON.parse(JSON.stringify(answer).replaceAll(billing.id, 'prj_billing01').replaceAll(checkout.id, 'prj_checkout1'));
const ctx = { params: Promise.resolve({ id: billing.id }) };
const readWorkspace = async () => (await (await workspaceRoute.GET(new Request(`http://localhost/api/projects/${billing.id}/workspace`), ctx)).json()) as ProjectWorkspaceView;
const sections = (answer: ProjectContextAnswer) => ({
  mod: projectSection(parseProjectContext(answer)),
  reply: projectReply('acme/web', parseProjectContext(answer)),
  cli: contextHuman(parseContext(answer), 'acme/web'),
});

const before = sections(await ask(projectQuery('acme/web')));

describe('PC16’s workspace in PC10’s answer, through PC11’s parsers', () => {
  it('with no saved workspace the answer is still the contract’s example', async () => {
    expect(exampleIds(await ask(projectQuery('acme/web')))).toEqual(example);
    expect(exampleIds(await ask('repo=acme/web&size=compact'))).toEqual(example);
  });

  it('saved as the card builds it, the answer carries workspace and both parsers give exactly their section', async () => {
    enableTestAuth();
    const draft = draftFrom(await readWorkspace());
    draft.repos['acme/web'] = { defaultBranch: 'develop', setup: 'pnpm install\npnpm build' };
    draft.worktree = 'shared';
    const saved = await workspaceRoute.PUT(new Request(`http://localhost/api/projects/${billing.id}/workspace`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(workspaceFrom(draft)) }), ctx);
    expect(saved.status).toBe(200);

    const answer = await ask(projectQuery('acme/web'));
    expect(answer.workspace).toEqual({
      projectId: billing.id,
      repos: { 'acme/web': { defaultBranch: 'develop', setup: ['pnpm install', 'pnpm build'] } },
      worktree: 'shared',
      branchTemplate: 'landflow/{project}/{run}',
      branchPattern: 'landflow/billing-revamp/{run}',
    });
    // Everything else is the example, and the readers that ignore the field give what they gave.
    const { workspace: _workspace, ...rest } = answer;
    expect(exampleIds(rest)).toEqual(example);
    expect(sections(answer)).toEqual(before);
    expect(sections(await ask('repo=acme/web&size=compact'))).toEqual(before);
    expect(sections(answer).mod).toBe(`${example.context.text}\nAlso listed in: Checkout`);
  });

  it('a viewer’s answer has no setup', async () => {
    enableTestAuth(viewer);
    const answer = await ask(projectQuery('acme/web'));
    expect(answer.workspace?.repos['acme/web']).toEqual({ defaultBranch: 'develop' });
    expect(JSON.stringify(answer)).not.toContain('pnpm install');
    expect((await readWorkspace()).setupShown).toBe(false);
    enableTestAuth();
  });

  it('removing a repository through PC10’s PATCH drops its workspace entry on the next read', async () => {
    await setRepos(billing.id, ['acme/web', 'acme/api']);
    enableTestAuth();
    const draft = draftFrom(await readWorkspace());
    draft.repos['acme/api'] = { defaultBranch: 'main', setup: 'make deps' };
    expect((await workspaceRoute.PUT(new Request(`http://localhost/api/projects/${billing.id}/workspace`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(workspaceFrom(draft)) }), ctx)).status).toBe(200);
    expect(Object.keys((await ask(`projectId=${billing.id}`)).workspace?.repos ?? {}).sort()).toEqual(['acme/api', 'acme/web']);

    await setRepos(billing.id, ['acme/web']);
    expect(Object.keys((await ask(`projectId=${billing.id}`)).workspace?.repos ?? {})).toEqual(['acme/web']);
    expect(Object.keys((await readWorkspace()).workspace.repos)).toEqual(['acme/web']);
    expect(sections(await ask(projectQuery('acme/web')))).toEqual(before);
  });
});
