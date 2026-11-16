/**
 * The node panel picks a credential by itself when exactly one fits. Every way that pick could show in the panel and
 * not be used by the run: the pick came from a project that may not use it (picked before the scope was known), two
 * requirements picked in one go lost one, a requirement that appears later was never picked, a read-only tab picked
 * what it can't save. Made-up data; the markup tests stub the hooks, the run rule uses real users and projects.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-credential-autopick-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

let listed: Array<{ id: string; name: string; type: string }> = [];
let scopeState: { scope?: { ids: Set<string>; projectId?: string }; failed: boolean } = { failed: false };
vi.mock('@/components/credentials/use-credentials', async (original) => ({
  ...(await original<typeof import('@/components/credentials/use-credentials')>()),
  useCredentials: () => ({ credentials: listed, types: [] }),
}));
vi.mock('@/components/projects/use-projects', async (original) => ({
  ...(await original<typeof import('@/components/projects/use-projects')>()),
  useCredentialScope: () => ({ ...scopeState, reload: async () => {} }),
}));

const { autoPickStep, autoPicks, credentialInputs, credentialsDiffer } = await import('@/components/credentials/use-credentials');
const { NodeCredentials } = await import('@/components/credentials/node-credentials');
const auth = await import('@/lib/server/auth');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const projectsRoute = await import('@/app/api/projects/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const { resolveWorkflowCredentials } = await import('@/lib/server/projects/credentials');
registry.registerBuiltin(corePlugin);

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const HEADER = { id: 'h1', name: 'Echo header', type: 'core.httpHeaderAuth' };
const BEARER = { id: 'b1', name: 'Echo bearer', type: 'core.httpBearerAuth' };
const step = (over: Partial<Parameters<typeof autoPickStep>[0]> = {}) =>
  autoPickStep({ nodeType: 'core.httpRequest', requirements: [{ name: 'httpHeaderAuth' }], candidates: [HEADER], scoped: false, scopeKnown: false, settled: new Set(), value: undefined, ...over });

describe('which credential is picked, and when', () => {
  it('picks the only credential of the type', () => {
    expect(step().next).toEqual({ httpHeaderAuth: { id: 'h1', name: 'Echo header' } });
  });

  it('picks nothing while the workflow’s project has not said what it may use (cause 1)', () => {
    expect(step({ scoped: true, scopeKnown: false }).next).toBeUndefined();
    expect(step({ scoped: true, scopeKnown: true }).next).toBeDefined();
  });

  it('picks nothing from several credentials, or a read-only edit (cause 6)', () => {
    expect(step({ candidates: [HEADER, { ...HEADER, id: 'h2', name: 'Other' }] }).next).toBeUndefined();
    expect(step({ readOnly: true }).next).toBeUndefined();
  });

  it('puts every requirement in one update, keeping what is set (cause 2)', () => {
    const next = autoPicks('core.httpRequest', [{ name: 'httpHeaderAuth' }, { name: 'httpBearerAuth' }, { name: 'oAuth2Api' }], [HEADER, BEARER], { oAuth2Api: { id: 'o1', name: 'Mine' } });
    expect(next).toEqual({ oAuth2Api: { id: 'o1', name: 'Mine' }, httpHeaderAuth: { id: 'h1', name: 'Echo header' }, httpBearerAuth: { id: 'b1', name: 'Echo bearer' } });
  });

  it('picks a requirement that appears later, and leaves one the person cleared (cause 3)', () => {
    const first = step({ requirements: [{ name: 'oAuth2Api' }], candidates: [HEADER, BEARER] });
    expect(first.next).toBeUndefined();
    const later = step({ requirements: [{ name: 'oAuth2Api' }, { name: 'httpHeaderAuth' }], settled: first.settled });
    expect(later.next).toEqual({ httpHeaderAuth: { id: 'h1', name: 'Echo header' } });
    // The person clears it: the next step keeps it empty.
    const cleared = step({ settled: later.settled, value: undefined });
    expect(cleared.next).toBeUndefined();
  });
});

describe('what the panel works from', () => {
  const all = [HEADER, BEARER];
  it('is every credential, and not scope-known, until the workflow’s project answers (cause 1)', () => {
    expect(credentialInputs({ all, scope: undefined, workflowId: 'wf_1' })).toEqual({ candidates: all, scoped: true, scopeKnown: false });
    expect(credentialInputs({ all, scope: { ids: new Set(['b1']) }, workflowId: 'wf_1' })).toEqual({ candidates: [BEARER], scoped: true, scopeKnown: true });
    expect(credentialInputs({ all, scope: undefined, workflowId: undefined })).toEqual({ candidates: all, scoped: false, scopeKnown: false });
    expect(credentialInputs({ all: undefined, scope: undefined, workflowId: 'wf_1' }).candidates).toBeUndefined();
  });

  it('settles a slot that has a credential even while blocked, so clearing it before the scope arrives leaves it empty', () => {
    const blocked = step({ scoped: true, scopeKnown: false, value: { httpHeaderAuth: { id: 'h1', name: 'x' } } });
    expect(blocked.settled.has('httpHeaderAuth')).toBe(true);
    expect(step({ scoped: true, scopeKnown: true, settled: blocked.settled, value: undefined }).next).toBeUndefined();
  });

  it('compares a node’s credentials with the published version’s by id, per slot', () => {
    expect(credentialsDiffer({ a: { id: '1' } }, { a: { id: '1' } })).toBe(false);
    expect(credentialsDiffer({ a: { id: '1' } }, { a: { id: '2' } })).toBe(true);
    expect(credentialsDiffer({ a: { id: '1' } }, undefined)).toBe(true);
    expect(credentialsDiffer(undefined, {})).toBe(false);
  });
});

describe('what the panel says', () => {
  const html = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(NodeCredentials, { nodeType: 'core.httpRequest', workflowId: 'wf_1', requirements: [{ name: 'httpHeaderAuth', required: true }], onChange: () => {}, ...props }));

  it('says when the project’s credentials could not be checked', () => {
    listed = [HEADER];
    scopeState = { failed: true };
    expect(html()).toContain('none is picked automatically');
    scopeState = { scope: { ids: new Set(['h1']) }, failed: false };
    expect(html()).not.toContain('none is picked automatically');
  });

  it('says a live workflow’s runs by trigger keep the published credential until publish (cause 4)', () => {
    listed = [HEADER];
    scopeState = { scope: { ids: new Set(['h1']) }, failed: false };
    const value = { httpHeaderAuth: { id: 'h1', name: 'Echo header' } };
    expect(html({ value, publishPending: true })).toContain('until you publish');
    expect(html({ value })).not.toContain('until you publish');
  });
});

describe('what a run does with the panel’s picks', () => {
  it('refuses a credential of another project, and ignores one in a slot the node no longer shows (causes 1 and 3)', async () => {
    auth.disableTestAuth();
    const make = async (email: string, role: 'owner' | 'admin' | 'member') => {
      const record = role === 'owner' ? await auth.createOwner({ email, name: email, password: 'password-123' }) : await auth.createUser({ email, name: email, role, password: 'password-123' });
      return { session: auth.createSession(record, 'password').token, id: record.id };
    };
    const call = async (route: unknown, path: string, method: string, who: { session: string }, body?: unknown) => {
      const response = await (route as (r: Request) => Promise<Response>)(
        new Request(`http://localhost:3000${path}`, { method, headers: { cookie: `landflow_session=${who.session}`, ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) }),
      );
      return (await response.json()) as Record<string, any>;
    };
    const admin = await make('admin@example.com', 'admin');
    const ops = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Operations' })).project.id;
    const billing = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Billing' })).project.id;
    const wf = (await call(workflowsRoute.POST, `/api/workflows?projectId=${ops}`, 'POST', admin, { name: 'Flow', nodes: [], connections: [] })).workflow.id;
    const other = (await call(credentialsRoute.POST, `/api/credentials?projectId=${billing}`, 'POST', admin, { name: 'Billing header', type: 'core.httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer made-up' } })).credential.id;
    const descriptor = registry.nodeTypes().find((t) => t.type === 'core.httpRequest')!.descriptor;
    const node = { type: 'core.httpRequest', parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }, credentials: { httpHeaderAuth: { id: other, name: 'Billing header' } } };
    expect(() => resolveWorkflowCredentials(wf, node, descriptor)).toThrow(/isn’t available to this workflow’s project/);
    // The person switched to Bearer: the stale Header slot is not read, so it can neither break nor be used by the run.
    const switched = { ...node, parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' }, credentials: { ...node.credentials, httpBearerAuth: { id: 'gone', name: 'x' } } };
    expect(Object.keys(resolveWorkflowCredentials(wf, { ...switched, credentials: node.credentials }, descriptor, true))).toEqual([]);
  });
});
