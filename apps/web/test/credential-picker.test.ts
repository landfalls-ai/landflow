/**
 * SB12: the credentials a step could use are offered on Spotlight's reply for the person to pick (decision D2). The route
 * the picker reads (GET /api/credentials?workflowId=) shows a member only what their project may use and never data; the
 * picker lists them with nothing chosen, even when exactly one fits; a `credential` event becomes a "Needs you" part.
 * Real users and sessions (the test bypass is off), made-up data.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-credential-picker-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The picker's sources, stubbed for the markup tests: two header-auth credentials, or one.
let listed: Array<{ id: string; name: string; type: string }> = [];
vi.mock('@/components/credentials/use-credentials', async (original) => ({
  ...(await original<typeof import('@/components/credentials/use-credentials')>()),
  useCredentials: () => ({ credentials: listed, types: [] }),
}));
vi.mock('@/components/projects/use-projects', async (original) => ({
  ...(await original<typeof import('@/components/projects/use-projects')>()),
  useCredentialScope: () => ({ scope: undefined, reload: async () => {} }),
}));

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const projectsRoute = await import('@/app/api/projects/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const { CredentialPicker } = await import('@/components/editor/spotlight/credential-picker');
const { applyStreamEvent } = await import('@/components/editor/assistant');
type AssistantTurn = import('@/components/editor/assistant').AssistantTurn;

registry.registerBuiltin(corePlugin);

const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
}

async function call(route: unknown, path: string, method: string, caller: Caller, body?: unknown) {
  const headers: Record<string, string> = { cookie: `landflow_session=${caller.session}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await (route as Route)(new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) }));
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any>, text };
}

async function makeUser(email: string, name: string, role: 'owner' | 'admin' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('GET /api/credentials?workflowId= as a member', () => {
  it('lists only what the workflow’s project may use, and no data', async () => {
    auth.disableTestAuth();
    const admin = await makeUser('admin@example.com', 'Ada Admin', 'admin');
    const ben = await makeUser('ben@example.com', 'Ben', 'member');
    const cat = await makeUser('cat@example.com', 'Cat', 'member');
    const ops = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Operations', members: [{ userId: ben.id, role: 'editor' }] })).body.project.id;
    const billing = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Billing', members: [{ userId: cat.id, role: 'editor' }] })).body.project.id;
    const wf = (await call(workflowsRoute.POST, `/api/workflows?projectId=${ops}`, 'POST', ben, { name: 'Flow', nodes: [], connections: [] })).body.workflow.id;
    const echo = (await call(credentialsRoute.POST, `/api/credentials?projectId=${ops}`, 'POST', ben, { name: 'Echo token', type: 'core.httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer eval-token' } })).body.credential.id;
    await call(credentialsRoute.POST, `/api/credentials?projectId=${billing}`, 'POST', cat, { name: 'Other token', type: 'core.httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer other-made-up' } });

    const answer = await call(credentialsRoute.GET, `/api/credentials?workflowId=${wf}`, 'GET', ben);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.credentials.map((c: { id: string }) => c.id)).toEqual([echo]);
    expect(answer.text).not.toMatch(/eval-token|other-made-up|"data"/);
    expect(projects.homeProjectId('workflow', wf)).toBe(ops);
  });
});

describe('the picker', () => {
  const html = (props: Partial<Parameters<typeof CredentialPicker>[0]> = {}) =>
    renderToStaticMarkup(createElement(CredentialPicker, { workflowId: 'wf_1', node: 'Open status incident', nodeType: 'core.httpRequest', credentialTypes: ['httpHeaderAuth'], onPicked: () => {}, ...props }));

  it('lists the credentials that fit by name, with nothing chosen, and Create one', () => {
    listed = [
      { id: 'c1', name: 'Echo token', type: 'core.httpHeaderAuth' },
      { id: 'c2', name: 'Other token', type: 'core.httpHeaderAuth' },
      { id: 'c3', name: 'A bearer', type: 'core.httpBearerAuth' },
    ];
    const out = html();
    expect(out).toContain('Echo token');
    expect(out).toContain('Other token');
    expect(out).not.toContain('A bearer');
    expect(out).not.toMatch(/checked=""/);
    expect(out).toContain('Create one');
    expect(out).toContain('Use it');
  });

  it('picks nothing by itself when exactly one fits (the node panel would)', () => {
    listed = [{ id: 'c1', name: 'Echo token', type: 'core.httpHeaderAuth' }];
    const out = html();
    expect(out).toContain('Echo token');
    expect(out).not.toMatch(/checked=""/);
    expect(out).toContain('Create one');
  });
});

describe('the stream', () => {
  it('a credential event adds a needs part with the types, and no secret', () => {
    const turn: AssistantTurn = { id: 'a', role: 'assistant', parts: [] };
    const next = applyStreamEvent(turn, { type: 'credential', node: 'Open status incident', nodeId: 'n_http', credentialTypes: ['httpHeaderAuth'], text: '“Open status incident” needs a credential: pick one or create one.' });
    expect(next.parts).toEqual([{ kind: 'needs', need: { what: 'credential', text: '“Open status incident” needs a credential: pick one or create one.', node: 'Open status incident', nodeId: 'n_http', credentialTypes: ['httpHeaderAuth'] } }]);
  });
});
