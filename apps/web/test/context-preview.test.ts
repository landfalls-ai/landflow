/**
 * GET /api/agents/:id/context-preview (PC07): the block and the practices a chat in a project would be given, for editors
 * of the agent only, for a project the agent is available in. The provider and the practices source are fakes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PracticesSource, RunContextProvider } from '@/lib/shared/project-context';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-context-preview-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { agentStore } = await import('@/lib/server/agents/store');
const { createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, replaceShares, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { setPracticesSource, setRunContextProvider } = await import('@/lib/server/project-context/seam');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const route = await import('@/app/api/agents/[id]/context-preview/route');

const home = createTeamProject({ name: 'Operations' });
const shared = createTeamProject({ name: 'Billing revamp' });
const other = createTeamProject({ name: 'Elsewhere' });

const provider: RunContextProvider = {
  resolve: (ref) => ({ ...(ref.projectId && { projectId: ref.projectId }) }),
  build: (ref, mode) => {
    const text = mode === 'off' ? '' : `## Where this work fits\nProject ${ref.projectId} (${mode})`;
    return { ...(ref.projectId && { projectId: ref.projectId }), mode, text, compact: text && `compact ${ref.projectId}`, line: '', hash: '', at: '2026-11-16T09:00:00.000Z', practices: [] };
  },
};
const practices: PracticesSource = {
  select: (q) => ({ text: `## Practices to follow\n- helm/chart-location (${q.projectId})`, practices: [{ handle: 'helm/chart-location', version: 2 }] }),
};

const agentIn = (config: Record<string, unknown> = {}) => {
  const agent = agentStore.create({ name: 'Writer', ...config });
  setHomeProject('agent', agent.id, home.id);
  return agent;
};
const get = (id: string, projectId?: string) =>
  route.GET(new Request(`http://localhost/api/agents/${id}/context-preview${projectId ? `?projectId=${projectId}` : ''}`), { params: Promise.resolve({ id }) });

// The first handler call boots the host, which sets the real provider: boot first, then put the fakes in.
beforeAll(async () => {
  await get('ag_nothing');
});
beforeEach(() => {
  enableTestAuth();
  setRunContextProvider(provider);
  setPracticesSource(undefined);
});
afterAll(() => {
  setRunContextProvider(undefined);
  setPracticesSource(undefined);
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('GET /api/agents/:id/context-preview', () => {
  it('builds the block of the home project, and respects the mode', async () => {
    const agent = agentIn();
    const full = await (await get(agent.id)).json();
    expect(full).toMatchObject({ projectId: home.id, mode: 'full', practices: { text: '', list: [] } });
    expect(full.text).toContain(`Project ${home.id} (full)`);
    const compact = agentIn({ projectContext: 'compact' });
    expect(await (await get(compact.id)).json()).toMatchObject({ mode: 'compact', text: expect.stringContaining('(compact)'), compact: `compact ${home.id}` });
  });

  it('Off gives no block', async () => {
    const agent = agentIn({ projectContext: 'off' });
    expect(await (await get(agent.id)).json()).toMatchObject({ mode: 'off', text: '', compact: '' });
  });

  it('previews a project the agent is shared to, and any project when it is available in all', async () => {
    const agent = agentIn();
    replaceShares('agent', agent.id, [{ projectId: shared.id, role: 'user' }]);
    expect(await (await get(agent.id, shared.id)).json()).toMatchObject({ projectId: shared.id });
    expect((await get(agent.id, other.id)).status).toBe(404);
    replaceShares('agent', agent.id, [{ projectId: '*', role: 'user' }]);
    expect((await get(agent.id, other.id)).status).toBe(200);
  });

  it('an unknown project or agent is 404', async () => {
    const agent = agentIn();
    expect((await get(agent.id, 'prj_nothing')).status).toBe(404);
    expect((await get('ag_nothing')).status).toBe(404);
  });

  it('carries the practices a source selects, and nothing with the switch off', async () => {
    setPracticesSource(practices);
    const on = await (await get(agentIn().id)).json();
    expect(on.practices.list).toEqual([{ handle: 'helm/chart-location', version: 2 }]);
    expect(on.practices.text).toContain(`helm/chart-location (${home.id})`);
    // AgentConfig.practices is PR06's field (the store doesn't keep it on this branch): the route reads it off the stored agent.
    const agent = agentIn();
    const real = agentStore.get(agent.id)!;
    const spy = vi.spyOn(agentStore, 'get').mockReturnValue({ ...real, practices: 'off' } as never);
    const off = await (await get(agent.id)).json();
    spy.mockRestore();
    expect(off.practices).toEqual({ text: '', list: [] });
  });

  it('is 403 for a project member who only has a share to use the agent', async () => {
    const agent = agentIn();
    replaceShares('agent', agent.id, [{ projectId: shared.id, role: 'user' }]);
    const member = await createUser({ email: 'mia@preview.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
    setMember(shared.id, member.id, 'editor');
    enableTestAuth(member);
    expect((await get(agent.id)).status).toBe(403);
    expect((await get(agent.id, shared.id)).status).toBe(403);
  });
});
