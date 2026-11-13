/** Signed resume URLs: webhook and form waits, in the required and optional modes. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-resume-'));
// The host boots lazily on the first route call, in the production profile here, so the environment passes the boot's
// configuration check (runtime.ts): a public URL and a registry secret.
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://flow.test', LANDFLOW_REGISTRY_SECRET: 'r'.repeat(24) };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { resumeSignature, verifyResumeSignature } = await import('@/lib/server/resume-signing');
const auth = await import('@/lib/server/auth');
const waitingRoute = await import('@/app/api/waiting/[id]/route');
const formWaitingRoute = await import('@/app/form/waiting/[id]/route');

registry.registerBuiltin(corePlugin);
afterAll(() => {
  for (const key of [...Object.keys(ENV), 'LANDFLOW_PROFILE', 'LANDFLOW_RESUME_SIGNATURES']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const request = (url: string, init: RequestInit = {}) => new Request(`http://flow.test${url}`, init);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (url: string) => request(url, { method: 'POST', body: JSON.stringify({ ok: true }), headers: { 'content-type': 'application/json' } });
const formPost = (url: string, field: string) => request(url, { method: 'POST', body: new URLSearchParams({ f0: field }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

function waitFlow(id: string, resume: 'webhook' | 'form') {
  const wait =
    resume === 'webhook'
      ? { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'webhook', httpMethod: 'POST', responseMode: 'lastNode' } }
      : { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'form', formTitle: 'Ask', formFields: { values: [{ fieldLabel: 'Email', fieldType: 'email' }] } } };
  const nodes = [
    { name: 'Start', type: 'core.manualTrigger' },
    { name: 'Link', type: 'core.set', parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'url', type: 'string', value: resume === 'webhook' ? '{{ $execution.resumeUrl }}' : '{{ $execution.resumeFormUrl }}' }] } } },
    wait,
    { name: 'After', type: 'core.noOp' },
  ];
  const workflow = store.saveWorkflow({
    id,
    name: id,
    nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: (n as { typeVersion?: number }).typeVersion ?? 1, position: [i * 200, 0], parameters: (n as { parameters?: object }).parameters ?? {} })),
    connections: ['Start>Link', 'Link>Wait', 'Wait>After'].map((e, i) => ({ id: `e${i}`, type: 'main', source: e.split('>')[0], target: e.split('>')[1], sourceIndex: 0, targetIndex: 0 })),
  } as Workflow);
  return runWorkflow({ workflow, mode: 'trigger', startNodeId: 'Start', triggerItems: [{ json: {} }] });
}

const mode = (profile: string, signatures?: string) => {
  process.env.LANDFLOW_PROFILE = profile;
  if (signatures) process.env.LANDFLOW_RESUME_SIGNATURES = signatures;
  else delete process.env.LANDFLOW_RESUME_SIGNATURES;
};

describe('resume signatures', () => {
  it('signs and verifies an id in constant length', () => {
    const sig = resumeSignature('ex_abc');
    expect(sig).toHaveLength(32);
    expect(verifyResumeSignature('ex_abc', sig)).toBe(true);
    expect(verifyResumeSignature('ex_abd', sig)).toBe(false);
    expect(verifyResumeSignature('ex_abc', sig.slice(1))).toBe(false);
    expect(verifyResumeSignature('ex_abc', undefined)).toBe(false);
  });

  it('production requires the signature on a webhook wait', async () => {
    mode('production');
    const waiting = await waitFlow('wf_sig_hook', 'webhook');
    const id = waiting.executionId;
    const sig = resumeSignature(id);
    expect(waiting.runData.Link.at(-1)?.outputs[0]?.[0].json.url).toBe(`http://flow.test/api/waiting/${id}?sig=${sig}`);
    expect(store.getExecution(id)?.wait?.signed).toBe(true);
    expect((await waitingRoute.POST(post(`/api/waiting/${id}`), params(id))).status).toBe(403);
    expect((await waitingRoute.POST(post(`/api/waiting/${id}?sig=${'x'.repeat(32)}`), params(id))).status).toBe(403);
    const ok = await waitingRoute.POST(post(`/api/waiting/${id}?sig=${sig}&a=1`), params(id));
    expect(ok.status).toBe(200);
    // The signature does not end up in the run's data.
    expect((await ok.json()).query).toEqual({ a: '1' });
  });

  it('a wait saved before signing (no flag) still resumes without a signature', async () => {
    mode('development');
    const waiting = await waitFlow('wf_sig_legacy', 'webhook');
    const id = waiting.executionId;
    expect(store.getExecution(id)?.wait?.signed).toBeUndefined();
    mode('production');
    expect((await waitingRoute.POST(post(`/api/waiting/${id}`), params(id))).status).toBe(200);
  });

  it('development hands out unsigned URLs, accepts unsigned calls and refuses a wrong signature', async () => {
    mode('development');
    const waiting = await waitFlow('wf_sig_dev', 'webhook');
    const id = waiting.executionId;
    expect(waiting.runData.Link.at(-1)?.outputs[0]?.[0].json.url).toBe(`http://flow.test/api/waiting/${id}`);
    expect((await waitingRoute.POST(post(`/api/waiting/${id}?sig=wrong`), params(id))).status).toBe(403);
    expect((await waitingRoute.POST(post(`/api/waiting/${id}`), params(id))).status).toBe(200);
  });

  it('form waits keep the signature through the page and the submit', async () => {
    mode('production');
    const waiting = await waitFlow('wf_sig_form', 'form');
    const id = waiting.executionId;
    const sig = resumeSignature(id);
    expect((await formWaitingRoute.GET(request(`/form/waiting/${id}`), params(id))).status).toBe(403);
    const page = await formWaitingRoute.GET(request(`/form/waiting/${id}?sig=${sig}`), params(id));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`action="/form/waiting/${id}?sig=${sig}"`);
    expect((await formWaitingRoute.POST(formPost(`/form/waiting/${id}`, 'a@b.co'), params(id))).status).toBe(403);
    const sent = await formWaitingRoute.POST(formPost(`/form/waiting/${id}?sig=${sig}`, 'a@b.co'), params(id));
    expect(sent.status).toBe(200);
    await vi.waitFor(() => expect(store.getExecution(id)?.status).toBe('success'));
  });

  it('a signed-in caller skips the signature only on a workflow it may open', async () => {
    mode('production');
    const waiting = await waitFlow('wf_sig_member', 'form');
    const id = waiting.executionId;
    const owner = auth.listUsers().find((u) => u.role === 'owner') ?? (await auth.createOwner({ email: 'owner@flow.test', name: 'Owner', password: 'owner-password-1' }));
    const member = await auth.createUser({ email: 'member@flow.test', name: 'Member', role: 'member', password: 'member-password-1' });
    const keyOf = (user: typeof owner) => auth.createApiKey(user, { label: 'form', scopes: ['workflows:read'] }).token;
    const as = (token: string) => request(`/form/waiting/${id}`, { headers: { 'x-landflow-api-key': token } });
    // The member has no access to the workflow: the key doesn't stand in for the signature.
    expect((await formWaitingRoute.GET(as(keyOf(member)), params(id))).status).toBe(403);
    expect((await formWaitingRoute.GET(as(keyOf(owner)), params(id))).status).toBe(200);
  });
});
