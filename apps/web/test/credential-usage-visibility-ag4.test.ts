/** Review: "Used by N agent" names only the agents the caller sees: a member of another project gets the credential, not the agent's name. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-cred-usage-vis-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const auth = await import('@/lib/server/auth');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const agentsRoute = await import('@/app/api/agents/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const sharesRoute = await import('@/app/api/credentials/[id]/shares/route');
const projectsRoute = await import('@/app/api/projects/route');

type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller { id: string; session: string }
const call = async (route: unknown, path: string, method: string, caller: Caller, body?: unknown, params?: Record<string, string>) => {
  const response = await (route as Route)(new Request(`http://localhost:3000${path}`, { method, headers: { cookie: `landflow_session=${caller.session}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
};
const makeUser = async (email: string, role: 'owner' | 'admin' | 'member'): Promise<Caller> => {
  const record = role === 'owner' ? await auth.createOwner({ email, name: email, password: 'password-123' }) : await auth.createUser({ email, name: email, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
};

let ann: Caller, cat: Caller, credId = '', agentId = '';
beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  auth.disableTestAuth();
  const admin = await makeUser('admin@example.com', 'owner');
  ann = await makeUser('ann@example.com', 'member');
  cat = await makeUser('cat@example.com', 'member');
  const ops = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Operations', members: [{ userId: ann.id, role: 'admin' }] })).body.project.id;
  const billing = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Billing', members: [{ userId: cat.id, role: 'editor' }] })).body.project.id;
  credId = (await call(credentialsRoute.POST, `/api/credentials?projectId=${ops}`, 'POST', ann, { name: 'Sales DB', type: 'core.httpHeaderAuth', data: { name: 'x', value: 'y' } })).body.credential.id;
  await call(sharesRoute.PUT, `/api/credentials/${credId}/shares`, 'PUT', ann, { shares: [{ projectId: billing, role: 'user' }] }, { id: credId });
  agentId = (await call(agentsRoute.POST, `/api/agents?projectId=${ops}`, 'POST', ann, { name: 'Secret summary agent' })).body.agent.id;
  agentStore.saveDraft(agentId, { tools: [{ id: 't1', type: 'node', name: 'q', description: 'x', nodeType: 'core.httpRequest', parameters: {}, credentials: { httpHeaderAuth: { id: credId, name: 'Sales DB' } } } as never] });
});

describe('GET /api/credentials usedByAgents', () => {
  const usage = async (caller: Caller) => ((await call(credentialsRoute.GET, '/api/credentials', 'GET', caller)).body.credentials as Array<{ id: string; usedByAgents: Array<{ agentName: string }> }>).find((c) => c.id === credId);
  it('names the agent to a member who sees it', async () => expect((await usage(ann))?.usedByAgents.map((a) => a.agentName)).toEqual(['Secret summary agent']));
  it('gives a member who cannot see the agent the credential and no name', async () => {
    const seen = await usage(cat);
    expect(seen).toBeDefined();
    expect(seen?.usedByAgents).toEqual([]);
  });
});
