/**
 * The audit log (lib/server/audit): the generic layer in `handler` on representative routes (method, route pattern,
 * status, outcome; no bodies or secrets; skipped paths), domain events (sign-in, failed sign-in, sign-out, API keys,
 * workflows and publishing, credentials and their use in a run, executions, settings), filters with cursor
 * pagination, CSV and JSON export, the route policy (admins and `audit:read`; project admins their projects' events),
 * retention, and the OTel log records. The project and hash chain have their own tests (audit-chain.test.ts).
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logs } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AuditEvent, AuditPage } from '@/lib/shared/audit';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-audit-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const audit = await import('@/lib/server/audit');
const { queryEvents, pruneEvents, countEvents } = await import('@/lib/server/audit/store');
const { csvRow } = await import('@/lib/server/audit/export');
const { verifyChain } = await import('@/lib/server/audit/chain');
const { personalProjectId } = await import('@/lib/shared/projects');
const { routePattern, outcomeOf } = await import('@/lib/server/audit/http');
const { OtlpJsonLogProvider } = await import('@/lib/server/telemetry/logs');
const { auditAttributes } = await import('@/lib/server/audit/otel');
const auditRoute = await import('@/app/api/audit/route');
const exportRoute = await import('@/app/api/audit/export/route');
const auditSettingsRoute = await import('@/app/api/settings/audit/route');
const variablesRoute = await import('@/app/api/variables/route');
const variableRoute = await import('@/app/api/variables/[key]/route');
const settingsRoute = await import('@/app/api/settings/route');
const lockRoute = await import('@/app/api/workflows/[id]/lock/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const publishRoute = await import('@/app/api/workflows/[id]/publish/route');
const unpublishRoute = await import('@/app/api/workflows/[id]/unpublish/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const credentialRoute = await import('@/app/api/credentials/[id]/route');
const apiKeysRoute = await import('@/app/api/api-keys/route');
const apiKeyRoute = await import('@/app/api/api-keys/[id]/route');
const executionRoute = await import('@/app/api/executions/[id]/route');
const loginRoute = await import('@/app/api/auth/login/route');
const logoutRoute = await import('@/app/api/auth/logout/route');

registry.registerBuiltin(corePlugin);

const SECRET = 'sk-very-secret-value-0123456789';
let server: Server;
let base = '';
let member: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, auth: Boolean(req.headers.authorization) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  member = await createUser({ email: 'member@audit.test', name: 'Mia Member', role: 'member', password: 'member-password-1' });
});

afterAll(async () => {
  enableTestAuth();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://audit.test${url}`, {
    method,
    headers: { 'user-agent': 'audit-test/1', 'x-forwarded-for': '203.0.113.7', ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const latest = (action: string): AuditEvent | undefined => queryEvents({ action: [action] }, { limit: 1 }).events[0];
const allText = () => JSON.stringify(database().all('SELECT * FROM audit_events'));

describe('generic layer', () => {
  it('derives route patterns and outcomes', () => {
    expect(routePattern('/api/workflows/wf_1/publish', { id: 'wf_1' })).toBe('/api/workflows/[id]/publish');
    expect(routePattern('/api/variables/MY_KEY', { key: 'MY_KEY' })).toBe('/api/variables/[key]');
    expect(routePattern('/api/webhook/a/b', { path: ['a', 'b'] })).toBe('/api/webhook/[...path]');
    expect(routePattern('/api/workflows', undefined)).toBe('/api/workflows');
    expect([outcomeOf(200), outcomeOf(302), outcomeOf(401), outcomeOf(403), outcomeOf(404), outcomeOf(500)]).toEqual(['success', 'success', 'denied', 'denied', 'failure', 'failure']);
  });

  it('records a change without a domain event: method, route pattern, status, client and request id, never the body', async () => {
    const response = await variablesRoute.POST(req('POST', '/api/variables', { key: 'AUDIT_VAR', value: SECRET }, { 'x-request-id': 'req-audit-1' }));
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('x-request-id')).toBe('req-audit-1');
    const event = latest('api.request')!;
    expect(event).toMatchObject({ method: 'POST', route: '/api/variables', outcome: 'success', ip: '203.0.113.7', userAgent: 'audit-test/1', requestId: 'req-audit-1' });
    expect(event.actor).toMatchObject({ type: 'user', id: TEST_OWNER.id });
    expect(event.status).toBe(response.status);

    const put = await variableRoute.PATCH(req('PATCH', '/api/variables/AUDIT_VAR', { value: `${SECRET}-2` }), params({ key: 'AUDIT_VAR' }));
    expect(put.status).toBe(200);
    expect(latest('api.request')).toMatchObject({ method: 'PATCH', route: '/api/variables/[key]', target: { type: 'variable', id: 'AUDIT_VAR' } });
    expect(allText()).not.toContain(SECRET);
  });

  it('records refusals as denied, with who was refused', async () => {
    enableTestAuth(member);
    try {
      const response = await settingsRoute.PATCH(req('PATCH', '/api/settings', { timezone: 'UTC' }));
      expect(response.status).toBe(403);
    } finally {
      enableTestAuth();
    }
    const event = latest('api.request')!;
    expect(event).toMatchObject({ outcome: 'denied', status: 403, route: '/api/settings', method: 'PATCH' });
    expect(event.actor.id).toBe(member.id);
  });

  it('skips reads and noisy paths (edit-lock heartbeats)', async () => {
    const before = countEvents();
    await variablesRoute.GET(req('GET', '/api/variables'));
    const wf = store.saveWorkflow({ id: 'wf_lock', name: 'Locked', nodes: [], connections: [] });
    await lockRoute.POST(req('POST', `/api/workflows/${wf.id}/lock`, { tabId: 'tab-000001' }), params({ id: wf.id }));
    expect(countEvents()).toBe(before);
    expect(queryEvents({ q: '/lock' }).events).toHaveLength(0);
    expect(queryEvents({ q: 'GET /api/variables' }).events).toHaveLength(0);
  });
});

describe('domain events', () => {
  it('records sign-in, failed sign-in and sign-out', async () => {
    const failed = await loginRoute.POST(req('POST', '/api/auth/login', { email: 'member@audit.test', password: 'wrong-password' }));
    expect(failed.status).toBe(401);
    expect(latest('auth.sign_in_failed')).toMatchObject({ outcome: 'failure', actor: { type: 'anonymous' }, target: { type: 'user', id: member.id }, details: { reason: 'password' } });
    expect(allText()).not.toContain('wrong-password');

    const ok = await loginRoute.POST(req('POST', '/api/auth/login', { email: 'member@audit.test', password: 'member-password-1' }));
    expect(ok.status).toBe(200);
    expect(latest('auth.sign_in')).toMatchObject({ actor: { type: 'user', id: member.id, email: 'member@audit.test' }, details: { method: 'password' }, ip: '203.0.113.7' });
    // One event for the sign-in: the generic layer stays out.
    expect(queryEvents({ action: ['api.request'], q: '/api/auth/login' }).events).toHaveLength(0);

    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    await logoutRoute.POST(req('POST', '/api/auth/logout', undefined, { cookie }));
    expect(latest('auth.sign_out')).toMatchObject({ actor: { id: member.id } });
  });

  it('records API keys made and revoked, never the token', async () => {
    const created = await apiKeysRoute.POST(req('POST', '/api/api-keys', { label: 'CI key', scopes: ['workflows:read'] }));
    const { key, token } = (await created.json()) as { key: { id: string }; token: string };
    expect(latest('api_key.create')).toMatchObject({ target: { type: 'api_key', id: key.id, name: 'CI key' }, details: { scopes: ['workflows:read'] } });
    await apiKeyRoute.DELETE(req('DELETE', `/api/api-keys/${key.id}`), params({ id: key.id }));
    expect(latest('api_key.revoke')).toMatchObject({ target: { id: key.id } });
    expect(allText()).not.toContain(token);
  });

  it('records workflow saves, publishing, unpublishing and deletion', async () => {
    const created = await workflowsRoute.POST(req('POST', '/api/workflows', { name: 'Audited', nodes: [{ id: 'm', name: 'Manual', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] }));
    const { workflow } = (await created.json()) as { workflow: Workflow };
    expect(latest('workflow.create')).toMatchObject({ target: { type: 'workflow', id: workflow.id, name: 'Audited' }, details: { nodes: 1 } });
    await workflowRoute.PUT(req('PUT', `/api/workflows/${workflow.id}`, { ...workflow, name: 'Audited 2' }), params({ id: workflow.id }));
    expect(latest('workflow.update')).toMatchObject({ target: { id: workflow.id, name: 'Audited 2' } });
    const published = await publishRoute.POST(req('POST', `/api/workflows/${workflow.id}/publish`, { note: 'first' }), params({ id: workflow.id }));
    expect(published.status).toBe(200);
    expect(latest('workflow.publish')).toMatchObject({ target: { id: workflow.id }, details: { note: 'first', versionNumber: 1 }, actor: { id: TEST_OWNER.id } });
    await unpublishRoute.POST(req('POST', `/api/workflows/${workflow.id}/unpublish`), params({ id: workflow.id }));
    expect(latest('workflow.unpublish')).toMatchObject({ target: { id: workflow.id } });
    await workflowRoute.DELETE(req('DELETE', `/api/workflows/${workflow.id}`), params({ id: workflow.id }));
    expect(latest('workflow.delete')).toMatchObject({ target: { id: workflow.id, name: 'Audited 2' } });
  });

  it('records credentials made, changed, used in a run (ids only) and deleted, never their values', async () => {
    const created = await credentialsRoute.POST(req('POST', '/api/credentials', { name: 'API token', type: 'core.httpBearerAuth', data: { token: SECRET } }));
    expect(created.status).toBe(201);
    const { credential } = (await created.json()) as { credential: { id: string } };
    expect(latest('credential.create')).toMatchObject({ target: { type: 'credential', id: credential.id, name: 'API token' }, details: { credentialType: 'core.httpBearerAuth' } });
    await credentialRoute.PATCH(req('PATCH', `/api/credentials/${credential.id}`, { data: { token: `${SECRET}-new` } }), params({ id: credential.id }));
    expect(latest('credential.update')).toMatchObject({ details: { fields: ['token'] } });

    const workflow = store.saveWorkflow({
      id: 'wf_cred_use',
      name: 'Uses a credential',
      nodes: [
        { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: 'Call',
          name: 'Call',
          type: 'core.httpRequest',
          typeVersion: 1,
          position: [200, 0],
          parameters: { method: 'GET', url: `${base}/x`, authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' },
          credentials: { httpBearerAuth: { id: credential.id, name: 'API token' } },
        },
      ],
      connections: [{ id: 'e', type: 'main', source: 'Start', target: 'Call', sourceIndex: 0, targetIndex: 0 }],
    });
    const record = await runWorkflow({ workflow, mode: 'manual' });
    expect(record.status).toBe('success');
    const use = queryEvents({ action: ['credential.use'], targetId: credential.id }).events;
    expect(use).toHaveLength(1);
    expect(use[0]).toMatchObject({ actor: { type: 'system' }, details: { executionId: record.executionId, workflowId: workflow.id, nodeName: 'Call', credentialType: 'httpBearerAuth' } });

    await credentialRoute.DELETE(req('DELETE', `/api/credentials/${credential.id}`), params({ id: credential.id }));
    expect(latest('credential.delete')).toMatchObject({ target: { id: credential.id, name: 'API token' } });
    expect(allText()).not.toContain(SECRET);

    // Settings → Audit log can turn credential-use events off.
    await auditSettingsRoute.PATCH(req('PATCH', '/api/settings/audit', { credentialUse: false }));
    expect(latest('settings.update')).toMatchObject({ target: { id: 'audit' }, details: { credentialUse: false } });
    const before = queryEvents({ action: ['credential.use'] }).events.length;
    audit.auditCredentialUse('ex_other', workflow.id, workflow.nodes[1], { httpBearerAuth: {} });
    expect(queryEvents({ action: ['credential.use'] }).events).toHaveLength(before);
    await auditSettingsRoute.PATCH(req('PATCH', '/api/settings/audit', { credentialUse: true }));
  });

  it('records deleted executions', async () => {
    const record = await runWorkflow({ workflow: store.saveWorkflow({ id: 'wf_exec', name: 'Exec', nodes: [{ id: 'S', name: 'S', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] }), mode: 'manual' });
    const response = await executionRoute.DELETE(req('DELETE', `/api/executions/${record.executionId}`), params({ id: record.executionId }));
    expect(response.status).toBe(200);
    expect(latest('execution.delete')).toMatchObject({ target: { type: 'execution', id: record.executionId }, details: { workflowId: 'wf_exec', status: 'success' } });
  });

  it('drops secret-looking detail keys and redacts Landflow tokens', () => {
    const event = audit.recordAudit({ action: 'settings.update', details: { password: 'p', apiKey: 'k', note: 'token lf_abcdefghijklmnopqrstuvwxyz here', nested: { a: 1 } } })!;
    expect(event.details).toEqual({ note: 'token [redacted] here', nested: '{"a":1}' });
  });
});

describe('GET /api/audit and export', () => {
  it('filters by actor, action, category, target, outcome, time and text, newest first, with a cursor', async () => {
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 5; i++) audit.recordAudit({ action: 'workflow.update', target: { type: 'workflow', id: 'wf_page', name: `Page ${i}` }, actor: { id: 'usr_pager', name: 'Pat Pager', email: 'pat@pager.test' }, at: new Date(t0 + i * 1000) });
    audit.recordAudit({ action: 'auth.sign_in_failed', outcome: 'failure', actor: 'anonymous', target: { type: 'user', name: 'x@y.z' }, at: new Date(t0 + 10_000) });

    const page1 = (await (await auditRoute.GET(req('GET', '/api/audit?actor=pat%40pager&limit=2'))).json()) as AuditPage;
    expect(page1.events.map((e) => e.target?.name)).toEqual(['Page 4', 'Page 3']);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await (await auditRoute.GET(req('GET', `/api/audit?actor=usr_pager&limit=2&cursor=${page1.nextCursor}`))).json()) as AuditPage;
    expect(page2.events.map((e) => e.target?.name)).toEqual(['Page 2', 'Page 1']);
    const page3 = (await (await auditRoute.GET(req('GET', `/api/audit?actor=usr_pager&limit=2&cursor=${page2.nextCursor}`))).json()) as AuditPage;
    expect(page3.events.map((e) => e.target?.name)).toEqual(['Page 0']);
    expect(page3.nextCursor).toBeUndefined();

    const byCategory = queryEvents({ action: ['auth.*'], outcome: 'failure', from: new Date(t0).toISOString() }).events;
    expect(byCategory.every((e) => e.action === 'auth.sign_in_failed')).toBe(true);
    expect(queryEvents({ targetType: 'workflow', targetId: 'wf_page', from: new Date(t0 + 1500).toISOString(), to: new Date(t0 + 3500).toISOString() }).events.map((e) => e.target?.name)).toEqual(['Page 3', 'Page 2']);
    expect(queryEvents({ q: 'page 1', actor: 'usr_pager' }).events).toHaveLength(1);
  });

  it('exports CSV and JSON with the same filters (and audits the export)', async () => {
    const csv = await exportRoute.GET(req('GET', '/api/audit/export?format=csv&actor=usr_pager'));
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="landflow-audit-.*\.csv"/);
    const lines = (await csv.text()).trim().split('\r\n');
    expect(lines[0].split(',').slice(0, 5)).toEqual(['id', 'at', 'action', 'category', 'outcome']);
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain('Page 4');

    const asJson = await exportRoute.GET(req('GET', '/api/audit/export?format=json&actor=usr_pager&action=workflow.update'));
    const events = (await asJson.json()) as AuditEvent[];
    expect(events.map((e) => e.target?.name)).toEqual(['Page 4', 'Page 3', 'Page 2', 'Page 1', 'Page 0']);
    expect(latest('audit.export')).toMatchObject({ details: { format: 'json', actor: 'usr_pager' } });
    // Cells a spreadsheet would run are defused.
    expect(csvRow({ ...events[0], summary: '=HYPERLINK("x")' })).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('is for owners and admins (every event), project admins (their projects’ events), and API keys with the audit:read scope', async () => {
    const mine = personalProjectId(member.id);
    audit.recordAudit({ action: 'workflow.update', target: { type: 'workflow', id: 'wf_mine', name: 'Mine' }, project: mine });
    audit.recordAudit({ action: 'workflow.update', target: { type: 'workflow', id: 'wf_theirs', name: 'Theirs' }, project: 'prj_someone_else' });
    enableTestAuth(member);
    try {
      const page = (await (await auditRoute.GET(req('GET', '/api/audit?limit=500'))).json()) as AuditPage;
      expect(page.events.map((e) => e.target?.id)).toContain('wf_mine');
      expect(page.events.every((e) => e.projectId === mine)).toBe(true);
      expect((await auditRoute.GET(req('GET', '/api/audit?projectId=prj_someone_else'))).status).toBe(403);
      expect((await auditRoute.GET(req('GET', `/api/audit?projectId=${mine}`))).status).toBe(200);
      expect((await exportRoute.GET(req('GET', '/api/audit/export?projectId=prj_someone_else'))).status).toBe(403);
    } finally {
      enableTestAuth();
    }
    const owner = await createUser({ email: 'admin@audit.test', name: 'Ada Admin', role: 'admin', password: 'admin-password-1' });
    const without = createApiKey(owner, { label: 'no audit', scopes: ['workflows:read'] });
    const withScope = createApiKey(owner, { label: 'audit', scopes: ['audit:read'] });
    expect((await auditRoute.GET(req('GET', '/api/audit', undefined, { authorization: `Bearer ${without.token}` }))).status).toBe(403);
    const ok = await auditRoute.GET(req('GET', '/api/audit?limit=1', undefined, { authorization: `Bearer ${withScope.token}` }));
    expect(ok.status).toBe(200);
    // A refused change is in the log with the key that tried it (reads aren't audited).
    expect((await settingsRoute.PATCH(req('PATCH', '/api/settings', { timezone: 'UTC' }, { authorization: `Bearer ${without.token}` }))).status).toBe(403);
    expect(latest('api.request')).toMatchObject({ outcome: 'denied', apiKeyId: without.key.id, actor: { type: 'api_key', id: owner.id } });
  });

  it('prunes events older than the retention from the oldest end of the hash chain (which still verifies)', async () => {
    audit.recordAudit({ action: 'settings.update', summary: 'ancient', at: new Date(Date.now() - 400 * 86_400_000) });
    expect(queryEvents({ q: 'ancient' }).events).toHaveLength(1);
    // Chained after today's events, it goes once they are past the retention too: a year and a day from now.
    expect(pruneEvents(365)).toBe(0);
    expect(pruneEvents(365, Date.now() + 366 * 86_400_000)).toBeGreaterThanOrEqual(1);
    expect(queryEvents({ q: 'ancient' }).events).toHaveLength(0);
    expect(await verifyChain()).toMatchObject({ ok: true, checked: 0 });
    expect(pruneEvents(0)).toBe(0);
  });
});

describe('OTel log records', () => {
  it('emits each event as a log record with event.name and semantic attributes, exported as OTLP JSON', async () => {
    const bodies: unknown[] = [];
    const provider = new OtlpJsonLogProvider({
      url: 'http://collector.test/v1/logs',
      intervalMs: 60_000,
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    logs.disable();
    logs.setGlobalLoggerProvider(provider);
    try {
      const event = audit.recordAudit({ action: 'workflow.publish', target: { type: 'workflow', id: 'wf_otel', name: 'OTel' }, actor: { id: 'usr_otel', email: 'otel@x.test' }, details: { versionNumber: 3 } })!;
      await provider.flush();
      const record = (bodies[0] as { resourceLogs: { scopeLogs: { scope: { name: string }; logRecords: { eventName?: string; body: { stringValue: string }; attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[] }).resourceLogs[0].scopeLogs[0];
      expect(record.scope.name).toBe('landflow.audit');
      const log = record.logRecords[0];
      const attr = Object.fromEntries(log.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
      expect(attr['event.name']).toBe('landflow.audit.workflow.publish');
      expect(attr).toMatchObject({ 'user.id': 'usr_otel', 'user.email': 'otel@x.test', 'landflow.audit.target.id': 'wf_otel', 'landflow.audit.id': event.id, 'landflow.audit.outcome': 'success', 'landflow.audit.details.versionNumber': '3' });
      expect(log.body.stringValue).toBe(event.summary);
    } finally {
      logs.disable();
    }
    expect(auditAttributes({ id: 'a', at: '', action: 'api.request', category: 'api', outcome: 'denied', actor: { type: 'anonymous' }, ip: '10.0.0.1', method: 'POST', route: '/api/x', status: 403, summary: '' })).toMatchObject({
      'client.address': '10.0.0.1',
      'http.request.method': 'POST',
      'http.route': '/api/x',
      'http.response.status_code': 403,
    });
  });
});
