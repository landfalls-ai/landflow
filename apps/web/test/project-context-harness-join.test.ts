/**
 * The join of project context for harnesses (contract project-context-api and its example): PC10's real
 * `GET /api/projects/context` answer, asked with the mod's own query, goes through the landflow-brain mod's parser
 * (`claude-plugins/landflow-brain/hooks/project.ts`, PC11) and `landflow work context`'s parser (`packages/cli`, PC11).
 * Each side tests itself against the example with fakes; this one seeds the example's data and joins the real sides.
 * (The wave-7 `project-context-join.test.ts` joins the run-time seam; this is the harness path.)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import example from '@/lib/shared/project-context-example.json';
import type { ProjectContextAnswer } from '@/lib/shared/project-context-api';
import { parseProjectContext, projectQuery, projectReply, projectSection } from '../claude-plugins/landflow-brain/hooks/project';
import { contextHuman, parseContext } from '../../../packages/cli/src/work/context';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-context-harness-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations (the goals source, the provider) are the real ones.
await import('@/lib/server/runtime');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, updateProjectBrief } = await import('@/lib/server/projects/store');
const { createGoalAs, setProjectGoalsAs } = await import('@/lib/server/goals/views');
const contextRoute = await import('@/app/api/projects/context/route');
const projectRoute = await import('@/app/api/projects/[id]/route');

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
for (const [id, repos] of [[billing.id, ['acme/web']], [checkout.id, ['Acme/Web']]] as const) {
  const response = await projectRoute.PATCH(new Request(`http://localhost/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repos }) }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
}

const ask = async (query: string) => {
  const response = await contextRoute.GET(new Request(`http://localhost/api/projects/context?${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as ProjectContextAnswer;
};
const exampleIds = (answer: unknown) => JSON.parse(JSON.stringify(answer).replaceAll(billing.id, 'prj_billing01').replaceAll(checkout.id, 'prj_checkout1'));

describe('PC10 route → PC11 parsers', () => {
  it('the mod’s own query gets the contract’s example', async () => {
    expect(exampleIds(await ask(projectQuery('acme/web')))).toEqual(example);
  });

  it('the mod turns the real answer into the session section and the /brain project reply', async () => {
    const found = parseProjectContext(await ask(projectQuery('acme/web')));
    expect(found?.projects.map((p) => p.name)).toEqual(['Billing revamp', 'Checkout']);
    expect(projectSection(found)).toBe(`${example.context.text}\nAlso listed in: Checkout`);
    expect(projectReply('acme/web', found)).toContain('listed by the project “Billing revamp”');
    expect(projectReply('acme/web', found)).toContain('Ship usage-based billing');
  });

  it('landflow work context prints the same block from the real answer', async () => {
    const answer = await ask('repo=acme/web&size=compact');
    const view = parseContext(answer);
    expect(exampleIds(view)).toEqual(example);
    expect(contextHuman(view, 'acme/web')).toBe(`${example.context.text}\nAlso listed in: Checkout`);
  });

  it('a repository no project lists is no section in the mod and the no-project sentence in the CLI', async () => {
    const answer = await ask('repo=acme/elsewhere&size=compact');
    expect(projectSection(parseProjectContext(answer))).toBeUndefined();
    expect(projectReply('acme/elsewhere', parseProjectContext(answer))).toBe('No project lists acme/elsewhere.');
    expect(contextHuman(parseContext(answer), 'acme/elsewhere')).toBe('No project lists acme/elsewhere.');
  });
});
