/**
 * Audit coverage (docs/features/audit-and-governance.md): who changed which role, share, transfer, variable or secret
 * provider and from what to what; failed SAML and OIDC sign-ins; denied reads (one a minute per route and caller);
 * exports; credential tests and agent tool approvals. Every change produces one event, and no secret value appears in
 * any of them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '@/lib/shared/audit';

vi.setConfig({ testTimeout: 20_000 });

// The approval route streams the agent's turn; the test only needs the decision recorded.
vi.mock('@/lib/server/agents/http', () => ({ agentEventStream: () => new Response('ok') }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-audit-coverage-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { queryEvents, countEvents } = await import('@/lib/server/audit/store');
const { deniedReadDue } = await import('@/lib/server/audit/http');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { dataTables } = await import('@/lib/server/datatables');
const { createTeamProject, setHomeProject } = await import('@/lib/server/projects');
const projectsRoute = await import('@/app/api/projects/route');
const projectRoute = await import('@/app/api/projects/[id]/route');
const membersRoute = await import('@/app/api/projects/[id]/members/route');
const projectVariablesRoute = await import('@/app/api/projects/[id]/variables/route');
const projectVariableRoute = await import('@/app/api/projects/[id]/variables/[key]/route');
const workflowSharesRoute = await import('@/app/api/workflows/[id]/shares/route');
const credentialSharesRoute = await import('@/app/api/credentials/[id]/shares/route');
const credentialTransferRoute = await import('@/app/api/credentials/[id]/transfer/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const credentialTestRoute = await import('@/app/api/credentials/test/route');
const variablesRoute = await import('@/app/api/variables/route');
const variableEnvironmentsRoute = await import('@/app/api/variables/[key]/environments/route');
const projectVariableEnvironmentsRoute = await import('@/app/api/projects/[id]/variables/[key]/environments/route');
const syncApplyRoute = await import('@/app/api/sync/apply/route');
const variableRoute = await import('@/app/api/variables/[key]/route');
const providersRoute = await import('@/app/api/external-secrets/route');
const providerRoute = await import('@/app/api/external-secrets/[name]/route');
const meRoute = await import('@/app/api/auth/me/route');
const samlAcsRoute = await import('@/app/api/auth/saml/acs/route');
const oidcCallbackRoute = await import('@/app/api/auth/oidc/callback/route');
const securitySettingsRoute = await import('@/app/api/settings/security/route');
const syncExportRoute = await import('@/app/api/sync/export/route');
const tableExportRoute = await import('@/app/api/data-tables/[id]/export/route');
const approvalsRoute = await import('@/app/api/agents/[id]/sessions/[sid]/approvals/route');

const SECRET = 'sk-coverage-secret-value-0123456789';
let member: Awaited<ReturnType<typeof createUser>>;
let other: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  member = await createUser({ email: 'member@coverage.test', name: 'Mia Member', role: 'member', password: 'member-password-1' });
  other = await createUser({ email: 'other@coverage.test', name: 'Otto Other', role: 'member', password: 'other-password-1' });
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://coverage.test${url}`, {
    method,
    headers: { 'user-agent': 'coverage-test/1', 'x-forwarded-for': '203.0.113.9', ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const events = (action: string): AuditEvent[] => queryEvents({ action: [action] }, { limit: 100 }).events;
const latest = (action: string): AuditEvent | undefined => events(action)[0];
const asRequest = (event: AuditEvent) => event.requestId;
const allText = () => JSON.stringify(database().all('SELECT * FROM audit_events'));
const json = async <T>(response: Response) => (await response.json()) as T;

describe('permission changes', () => {
  let projectId = '';

  it('records a project made, with its first members, changed, re-staffed and deleted (from → to)', async () => {
    const created = await projectsRoute.POST(req('POST', '/api/projects', { name: 'Coverage', members: [{ userId: member.id, role: 'editor' }] }));
    expect(created.status).toBe(201);
    projectId = (await json<{ project: { id: string } }>(created)).project.id;
    expect(latest('project.create')).toMatchObject({ target: { type: 'project', id: projectId, name: 'Coverage' }, projectId, actor: { id: TEST_OWNER.id } });
    expect(latest('project.member_change')).toMatchObject({ projectId, details: { change: 'added', userId: member.id, from: null, to: 'editor' } });

    const renamed = await projectRoute.PATCH(req('PATCH', `/api/projects/${projectId}`, { name: 'Coverage 2' }), params({ id: projectId }));
    expect(renamed.status).toBe(200);
    expect(latest('project.update')).toMatchObject({ projectId, details: { nameFrom: 'Coverage', nameTo: 'Coverage 2' } });

    const put = await membersRoute.PUT(req('PUT', `/api/projects/${projectId}/members`, { members: [{ userId: member.id, role: 'admin' }, { userId: other.id, role: 'viewer' }] }), params({ id: projectId }));
    expect(put.status).toBe(200);
    const changes = events('project.member_change').filter((e) => e.projectId === projectId);
    expect(changes.map((e) => e.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ change: 'changed', userId: member.id, from: 'editor', to: 'admin' }),
        expect.objectContaining({ change: 'added', userId: other.id, from: null, to: 'viewer' }),
      ]),
    );
    // Saving the same members again changes nothing, so records nothing.
    const before = countEvents();
    await membersRoute.PUT(req('PUT', `/api/projects/${projectId}/members`, { members: [{ userId: member.id, role: 'admin' }, { userId: other.id, role: 'viewer' }] }), params({ id: projectId }));
    // Only the generic line (one `api.request`): no member event for an unchanged list.
    expect(countEvents() - before).toBe(1);
  });

  it('records one event per request, not the generic line as well', async () => {
    const put = await membersRoute.PUT(req('PUT', `/api/projects/${projectId}/members`, { members: [{ userId: member.id, role: 'admin' }] }), params({ id: projectId }));
    expect(put.status).toBe(200);
    const removed = events('project.member_change').find((e) => e.details?.change === 'removed');
    expect(removed).toMatchObject({ details: { userId: other.id, from: 'viewer', to: null } });
    expect(queryEvents({ action: ['api.request'], q: `/api/projects/[id]/members` }).events.filter((e) => e.requestId === asRequest(removed!))).toHaveLength(0);
  });

  it('records a workflow shared, its role changed and the share removed, and a credential shared and moved', async () => {
    const workflow = store.saveWorkflow({ id: 'wf_cov', name: 'Shared', nodes: [], connections: [] });
    const share = (shares: unknown[]) => workflowSharesRoute.PUT(req('PUT', `/api/workflows/${workflow.id}/shares`, { shares }), params({ id: workflow.id }));
    expect((await share([{ projectId, role: 'viewer' }])).status).toBe(200);
    expect(latest('resource.share')).toMatchObject({ target: { type: 'workflow', id: workflow.id }, details: { kind: 'workflow', withProjectId: projectId, from: null, to: 'viewer' } });
    await share([{ projectId, role: 'editor' }]);
    expect(latest('resource.share')).toMatchObject({ details: { from: 'viewer', to: 'editor' } });
    await share([]);
    expect(latest('resource.unshare')).toMatchObject({ target: { id: workflow.id }, details: { withProjectId: projectId, from: 'editor', to: null } });

    const home = createTeamProject({ name: 'Home of the token' });
    const made = await credentialsRoute.POST(req('POST', '/api/credentials', { name: 'Shared token', type: 'core.httpBearerAuth', data: { token: SECRET } }));
    const credentialId = (await json<{ credential: { id: string } }>(made)).credential.id;
    setHomeProject('credential', credentialId, home.id);
    const shared = await credentialSharesRoute.PUT(req('PUT', `/api/credentials/${credentialId}/shares`, { shares: [{ projectId, role: 'user' }] }), params({ id: credentialId }));
    expect(shared.status).toBe(200);
    expect(latest('resource.share')).toMatchObject({ target: { type: 'credential', id: credentialId }, details: { to: 'user' } });

    const moved = await credentialTransferRoute.POST(req('POST', `/api/credentials/${credentialId}/transfer`, { projectId, keepAccess: true }), params({ id: credentialId }));
    expect(moved.status).toBe(200);
    expect(latest('resource.transfer')).toMatchObject({ target: { type: 'credential', id: credentialId }, details: { kind: 'credential', from: home.id, to: projectId, keepAccess: true } });
    // The kept access to the old project is a share of its own.
    expect(latest('resource.share')).toMatchObject({ target: { id: credentialId }, details: { withProjectId: home.id, to: 'user' } });
  });

  it('records the project deleted with where its items went', async () => {
    const sink = createTeamProject({ name: 'Sink' });
    const removed = await projectRoute.DELETE(req('DELETE', `/api/projects/${projectId}?transferTo=${sink.id}`), params({ id: projectId }));
    expect(removed.status).toBe(200);
    expect(latest('project.delete')).toMatchObject({ target: { type: 'project', id: projectId, name: 'Coverage 2' }, details: { transferredTo: sink.id } });
  });

  it('records a password change with who made it, never the password', async () => {
    enableTestAuth(member);
    try {
      const response = await meRoute.PATCH(req('PATCH', '/api/auth/me', { currentPassword: 'member-password-1', newPassword: 'brand-new-password-9' }));
      expect(response.status).toBe(200);
    } finally {
      enableTestAuth();
    }
    expect(latest('auth.password_change')).toMatchObject({ actor: { id: member.id }, target: { type: 'user', id: member.id }, details: { reason: 'self' } });
    expect(allText()).not.toContain('brand-new-password-9');
  });
});

describe('variables and secret providers', () => {
  it('records instance and project variables by name, never the value', async () => {
    expect((await variablesRoute.POST(req('POST', '/api/variables', { key: 'COV_VAR', value: SECRET }))).status).toBeLessThan(300);
    expect(latest('variable.create')).toMatchObject({ target: { id: 'COV_VAR' }, details: { scope: 'instance', key: 'COV_VAR' } });
    await variableRoute.PATCH(req('PATCH', '/api/variables/COV_VAR', { key: 'COV_VAR2', value: `${SECRET}-2` }), params({ key: 'COV_VAR' }));
    expect(latest('variable.update')).toMatchObject({ details: { key: 'COV_VAR2', from: 'COV_VAR', to: 'COV_VAR2', valueChanged: true } });
    // A PATCH that changes nothing records no variable.update.
    const updates = queryEvents({ action: ['variable.update'] }).events.length;
    expect((await variableRoute.PATCH(req('PATCH', '/api/variables/COV_VAR2', { value: `${SECRET}-2` }), params({ key: 'COV_VAR2' }))).status).toBe(200);
    expect(queryEvents({ action: ['variable.update'] }).events).toHaveLength(updates);
    await variableRoute.DELETE(req('DELETE', '/api/variables/COV_VAR2'), params({ key: 'COV_VAR2' }));
    expect(latest('variable.delete')).toMatchObject({ details: { scope: 'instance', key: 'COV_VAR2' } });

    const made = await projectsRoute.POST(req('POST', '/api/projects', { name: 'Vars' }));
    const id = (await json<{ project: { id: string } }>(made)).project.id;
    await projectVariablesRoute.POST(req('POST', `/api/projects/${id}/variables`, { key: 'PROJ_VAR', value: SECRET }), params({ id }));
    expect(latest('variable.create')).toMatchObject({ projectId: id, details: { scope: 'project', projectId: id, key: 'PROJ_VAR' } });
    await projectVariableRoute.DELETE(req('DELETE', `/api/projects/${id}/variables/PROJ_VAR`), params({ id, key: 'PROJ_VAR' }));
    expect(latest('variable.delete')).toMatchObject({ projectId: id, details: { scope: 'project', key: 'PROJ_VAR' } });
    // One event each: the generic layer added a line only for the PATCH that changed nothing.
    expect(queryEvents({ action: ['api.request'], q: '/variables' }).events.map((e) => [e.route, e.status])).toEqual([['/api/variables/[key]', 200]]);
  });

  it('records per-environment values once, by environment name, never the value', async () => {
    await variablesRoute.POST(req('POST', '/api/variables', { key: 'ENV_VAR', value: 'x' }));
    const before = queryEvents({ action: ['variable.update'] }).events.length;
    const put = await variableEnvironmentsRoute.PUT(req('PUT', '/api/variables/ENV_VAR/environments', { values: { production: SECRET, staging: 's' } }), params({ key: 'ENV_VAR' }));
    expect(put.status).toBe(200);
    expect(queryEvents({ action: ['variable.update'] }).events).toHaveLength(before + 1);
    expect(latest('variable.update')).toMatchObject({ details: { scope: 'instance', key: 'ENV_VAR', environments: ['production', 'staging'], cleared: [] } });
    await variableEnvironmentsRoute.PUT(req('PUT', '/api/variables/ENV_VAR/environments', { values: { staging: null } }), params({ key: 'ENV_VAR' }));
    expect(latest('variable.update')).toMatchObject({ details: { environments: [], cleared: ['staging'] } });
    // Nothing changed: no domain event (only the generic line).
    await variableEnvironmentsRoute.PUT(req('PUT', '/api/variables/ENV_VAR/environments', { values: { production: SECRET } }), params({ key: 'ENV_VAR' }));
    expect(queryEvents({ action: ['variable.update'] }).events).toHaveLength(before + 2);

    const made = await projectsRoute.POST(req('POST', '/api/projects', { name: 'EnvVars' }));
    const id = (await json<{ project: { id: string } }>(made)).project.id;
    await projectVariablesRoute.POST(req('POST', `/api/projects/${id}/variables`, { key: 'PROJ_ENV', value: 'x' }), params({ id }));
    const put2 = await projectVariableEnvironmentsRoute.PUT(req('PUT', `/api/projects/${id}/variables/PROJ_ENV/environments`, { values: { production: SECRET } }), params({ id, key: 'PROJ_ENV' }));
    expect(put2.status).toBe(200);
    expect(latest('variable.update')).toMatchObject({ projectId: id, details: { scope: 'project', projectId: id, key: 'PROJ_ENV', environments: ['production'], cleared: [] } });
    // Only the no-op PUT above left the generic line; the two that changed something did not.
    expect(queryEvents({ action: ['api.request'], q: '/environments' }).events.map((e) => [e.route, e.status])).toEqual([['/api/variables/[key]/environments', 200]]);
    expect(allText()).not.toContain(SECRET);
  });

  it('records variables a Git sync apply writes (the second path) by name and environment, never the value', async () => {
    const files = [{ path: 'landflow-sync.json', content: JSON.stringify({ format: 'landflow-sync/v1' }) }, { path: 'variables.json', content: JSON.stringify({ variables: [{ key: 'SYNC_VAR', value: SECRET, environments: { production: `${SECRET}-p` } }] }) }];
    const response = await syncApplyRoute.POST(new Request('http://sync.test/api/sync/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }) }));
    expect(response.status).toBe(200);
    expect(latest('variable.create')).toMatchObject({ target: { id: 'SYNC_VAR' }, details: { scope: 'instance', key: 'SYNC_VAR' } });
    expect(latest('variable.update')).toMatchObject({ details: { key: 'SYNC_VAR', environments: ['production'], cleared: [] } });
    expect(allText()).not.toContain(SECRET);
  });

  it('records an external secrets provider added, changed and removed, never a secret setting', async () => {
    const created = await providersRoute.POST(req('POST', '/api/external-secrets', { name: 'cov_vault', kind: 'onePassword', settings: { url: 'http://127.0.0.1:1', token: SECRET } }));
    expect(created.status).toBe(201);
    expect(latest('secret_provider.create')).toMatchObject({ target: { type: 'secret_provider', id: 'cov_vault' }, details: { provider: 'cov_vault', kind: 'onePassword' } });
    const updated = await providerRoute.PATCH(req('PATCH', '/api/external-secrets/cov_vault', { enabled: false, settings: { token: `${SECRET}-2` } }), params({ name: 'cov_vault' }));
    expect(updated.status).toBe(200);
    expect(latest('secret_provider.update')).toMatchObject({ details: { enabledFrom: true, enabledTo: false, fieldsChanged: ['token'] } });
    await providerRoute.DELETE(req('DELETE', '/api/external-secrets/cov_vault'), params({ name: 'cov_vault' }));
    expect(latest('secret_provider.delete')).toMatchObject({ details: { provider: 'cov_vault' } });
  });
});

describe('failed sign-ins, denied reads', () => {
  it('records a SAML and an OIDC sign-in that failed, with a reason category', async () => {
    const saml = await samlAcsRoute.POST(new Request('http://coverage.test/api/auth/saml/acs', { method: 'POST', body: 'SAMLResponse=PHNhbWw+' + SECRET, headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
    expect(saml.status).toBe(303);
    expect(latest('auth.sign_in_failed')).toMatchObject({ outcome: 'failure', actor: { type: 'anonymous' }, details: { method: 'saml', reason: 'not_configured' } });
    const oidc = await oidcCallbackRoute.GET(req('GET', '/api/auth/oidc/callback?code=abc&state=xyz'));
    expect(oidc.status).toBeLessThan(400);
    expect(events('auth.sign_in_failed').find((e) => e.details?.method === 'oidc')).toMatchObject({ details: { reason: 'not_configured' } });
    expect(allText()).not.toContain(SECRET);
  });

  it('records a refused read once a minute per caller and route', async () => {
    enableTestAuth(member);
    try {
      const first = await securitySettingsRoute.GET(req('GET', '/api/settings/security'));
      expect(first.status).toBe(403);
      const again = await securitySettingsRoute.GET(req('GET', '/api/settings/security'));
      expect(again.status).toBe(403);
    } finally {
      enableTestAuth();
    }
    const denied = events('api.denied').filter((e) => e.route === '/api/settings/security');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: 'denied', status: 403, method: 'GET', actor: { id: member.id } });
  });

  it('lets the next refused read through after the window and holds at most 10,000 keys', () => {
    const t0 = 1_000_000;
    expect(deniedReadDue('ip:a', '/r', t0)).toBe(true);
    expect(deniedReadDue('ip:a', '/r', t0 + 59_000)).toBe(false);
    expect(deniedReadDue('ip:a', '/r', t0 + 60_001)).toBe(true);
    expect(deniedReadDue('ip:b', '/r', t0 + 60_001)).toBe(true);
    for (let i = 0; i < 10_050; i++) deniedReadDue(`ip:${i}`, '/flood', t0 + 120_000);
    // The oldest keys were forgotten rather than the map growing without bound; a recent one is still held.
    expect(deniedReadDue('ip:10049', '/flood', t0 + 120_001)).toBe(false);
    expect(deniedReadDue('ip:0', '/flood', t0 + 120_002)).toBe(true);
  });
});

describe('exports and tests', () => {
  it('records the Git sync export and a data table export by what and how much, not their content', async () => {
    const response = await syncExportRoute.GET(req('GET', '/api/sync/export?values=true'));
    expect(response.status).toBe(200);
    expect(latest('sync.export')).toMatchObject({ details: { values: true } });
    expect(typeof latest('sync.export')!.details!.files).toBe('number');

    const service = dataTables();
    const table = service.createTable({ name: 'Cov table', columns: [{ name: 'note', type: 'string' }] });
    service.insertRows(table.id, [{ note: SECRET }, { note: 'two' }]);
    const exported = await tableExportRoute.GET(req('GET', `/api/data-tables/${table.id}/export`), params({ id: table.id }));
    expect(exported.status).toBe(200);
    expect(latest('datatable.export')).toMatchObject({ target: { type: 'data_table', id: table.id, name: 'Cov table' }, details: { rows: 2, columns: 1 } });
    expect(allText()).not.toContain(SECRET);
  });

  it('records a credential test with its type and outcome', async () => {
    const response = await credentialTestRoute.POST(req('POST', '/api/credentials/test', { type: 'core.httpBearerAuth', data: { token: SECRET } }));
    expect(response.status).toBe(200);
    expect(latest('credential.test')).toMatchObject({ target: { type: 'credential' }, details: { type: 'core.httpBearerAuth' } });
    expect(allText()).not.toContain(SECRET);
  });

  it('records a person approving or denying an agent’s tool call', async () => {
    const agent = agentStore.create({ name: 'Approver' });
    const session = newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
    session.pending = { calls: [{ callId: 'c1', tool: 'send_email', input: { to: 'x', body: SECRET } }], results: [], iterations: 1 };
    agentStore.saveSession(session);
    const response = await approvalsRoute.POST(req('POST', `/api/agents/${agent.id}/sessions/${session.id}/approvals`, { callId: 'c1', approved: true }), params({ id: agent.id, sid: session.id }));
    expect(response.status).toBe(200);
    expect(latest('agent.tool_approval')).toMatchObject({ target: { type: 'agent', id: agent.id }, details: { decision: 'approved', tool: 'send_email', sessionId: session.id } });
    expect(allText()).not.toContain(SECRET);
  });
});

describe('no secret values', () => {
  it('keeps every value this file used out of the whole log', () => {
    for (const value of [SECRET, `${SECRET}-2`, 'member-password-1', 'brand-new-password-9']) expect(allText()).not.toContain(value);
  });
});
