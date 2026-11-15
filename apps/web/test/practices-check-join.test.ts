/**
 * The join of Check Practices and compliance (PR08 ↔ PR09, PR04): a flow's Check Practices step fails on a required
 * practice approved in the real store; PR09's compliance counts the failed check; the waiver goes through the route, a
 * retry passes and compliance counts it waived. `resolve?id=` gives the practice `applicable` listed for the same project
 * and path, and 404 for a practice of another project. PR08 tested with a fake port, PR09 with rows it wrote itself.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ApplicableResponse, PracticeDraftInput } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-check-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { withAuth } = await import('@/lib/server/auth/context');
const { store } = await import('@/lib/server/store');
const { runWorkflow, startRetry } = await import('@/lib/server/runner');
const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { storePort } = await import('@/lib/server/practices/register');
const { approvePractice } = await import('@/lib/server/practices/approve');
const complianceRoute = await import('@/app/api/practices/[id]/compliance/route');
const waiversRoute = await import('@/app/api/practices/[id]/waivers/route');
const runPracticesRoute = await import('@/app/api/executions/[id]/practices/route');
const applicableRoute = await import('@/app/api/practices/applicable/route');
const resolveRoute = await import('@/app/api/practices/resolve/route');

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@check-join.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
enableTestAuth(owner);
const as = <T,>(fn: () => T): T => withAuth({ principal: { user: owner, via: 'test' } }, fn);
const mine = createTeamProject({ name: 'Billing', createdBy: owner.id });
const other = createTeamProject({ name: 'Search', createdBy: owner.id });
setMember(mine.id, owner.id, 'admin');
setMember(other.id, owner.id, 'admin');

const approve = (over: Partial<PracticeDraftInput>): string => {
  const input: PracticeDraftInput = { title: 'A rule', level: 'project', strength: 'required', topics: [], repos: [], paths: [], summary: 'A short rule', body: 'The full rule.', handle: 'x/x', ...over };
  const { practice } = storePort.draft(input, { source: 'person', actor: owner });
  approvePractice(owner, practice.id, { version: 1 });
  return practice.id;
};
const required = approve({ handle: 'sec/no-secrets', projectId: mine.id, paths: ['secrets/**'], checks: [{ kind: 'pathAbsent', glob: 'secrets/**' }] });
const elsewhere = approve({ handle: 'search/other', projectId: other.id, paths: ['secrets/**'], checks: [{ kind: 'pathExists', glob: 'nowhere/**' }] });

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const BAD = [{ path: 'secrets/key.txt', status: 'A', added: ['x'] }];
const flow = (id: string) => {
  const node = (nid: string, name: string, type: string, x: number, parameters: Record<string, unknown>) => ({ id: nid, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters });
  return {
    id,
    name: id,
    active: false,
    nodes: [
      node('start', 'Start', 'core.manualTrigger', 0, {}),
      node('change', 'Change', 'core.code', 260, { mode: 'all', language: 'javascript', code: `return [{ json: { files: ${JSON.stringify(BAD)} } }];` }),
      node('check', 'Check Practices', 'core.practiceCheck', 520, { repository: '', changedFiles: '{{ $json.files }}' }),
      node('after', 'After', 'core.noOp', 780, {}),
    ],
    connections: [
      { id: 'c1', type: 'main' as const, source: 'start', sourceIndex: 0, target: 'change', targetIndex: 0 },
      { id: 'c2', type: 'main' as const, source: 'change', sourceIndex: 0, target: 'check', targetIndex: 0 },
      { id: 'c3', type: 'main' as const, source: 'check', sourceIndex: 0, target: 'after', targetIndex: 0 },
    ],
  };
};
const settle = async (id: string) => {
  let record = store.getExecution(id);
  for (let i = 0; i < 100 && record?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    record = store.getExecution(id);
  }
  return record;
};
const compliance = async (id: string) => {
  const response = await complianceRoute.GET(new Request(`http://localhost/api/practices/${id}/compliance`), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { compliance: { checkPass: number; checkFail: number; waived: number } }).compliance;
};
const get = async (route: { GET: (r: Request) => Promise<Response> }, path: string) => {
  const response = await route.GET(new Request(`http://localhost${path}`));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

describe('Check Practices, compliance and the waiver', () => {
  it('fails on the required practice, counts it, waives through the route, and the retry passes', async () => {
    as(() => store.saveWorkflow(flow('wf_check_join')));
    setHomeProject('workflow', 'wf_check_join', mine.id);
    const first = await as(() => runWorkflow({ workflow: store.getWorkflow('wf_check_join')!, mode: 'manual', startNodeId: 'start' }));
    expect(first.status).toBe('error');
    expect(first.error?.message).toContain('sec/no-secrets');
    expect(first.runData.after).toBeUndefined();
    expect(await compliance(required)).toMatchObject({ checkFail: 1, checkPass: 0, waived: 0 });

    const waived = await waiversRoute.POST(
      new Request(`http://localhost/api/practices/${required}/waivers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ executionId: first.executionId, version: 1, reason: 'The key file is a fixture' }) }),
      { params: Promise.resolve({ id: required }) },
    );
    expect(waived.status, await waived.clone().text()).toBe(201);

    const retried = await settle(await startRetry(first.executionId, { from: 'start' }));
    expect(retried?.status).toBe('success');
    const out = retried?.runData.check?.at(-1)?.outputs[0]?.[0]?.json as Record<string, any>;
    expect(out).toMatchObject({ ok: true, failed: [], waived: ['sec/no-secrets'] });
    expect(retried?.runData.after).toBeDefined();
    expect(await compliance(required)).toMatchObject({ checkFail: 1, waived: 1 });
    // A practice of another project was never checked here.
    expect(await compliance(elsewhere)).toMatchObject({ checkFail: 0, checkPass: 0, waived: 0 });
    // The retry wrote no row of its own, yet its run lists the practice as waived (the waiver of the run it retried).
    const listed = async (id: string) => ((await (await runPracticesRoute.GET(new Request(`http://localhost/api/executions/${id}/practices`), { params: Promise.resolve({ id }) })).json()) as { practices: Array<{ handle: string; check?: string }> }).practices;
    expect(await listed(retried!.executionId)).toEqual(expect.arrayContaining([expect.objectContaining({ handle: 'sec/no-secrets', check: 'waived' })]));
    expect(await listed(first.executionId)).toEqual(expect.arrayContaining([expect.objectContaining({ handle: 'sec/no-secrets', check: 'waived' })]));
  });
});

describe('resolve by id (PR08) against applicable (PR04)', () => {
  it('gives the practice the listing named for the same project and path, and 404 for another project’s', async () => {
    const scope = `projectId=${mine.id}&path=secrets/key.txt`;
    const listed = (await get(applicableRoute, `/api/practices/applicable?${scope}&preview=1`)).body as ApplicableResponse;
    const item = listed.practices.find((p) => p.handle === 'sec/no-secrets')!;
    expect(item).toMatchObject({ id: required, projectId: mine.id, version: 1 });
    expect(listed.practices.map((p) => p.id)).not.toContain(elsewhere);
    const resolved = await get(resolveRoute, `/api/practices/resolve?id=${item.id}&${scope}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.practice).toMatchObject({ handle: 'sec/no-secrets', version: 1, scope: { level: 'project', projectId: mine.id } });
    expect((await get(resolveRoute, `/api/practices/resolve?id=${elsewhere}&${scope}`)).status).toBe(404);
  });
});
