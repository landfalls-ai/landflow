/**
 * The approval inbox on the server (wave ap1, AP01; docs/approval-inbox.md): the contract copies, migration 2907, the store's
 * idempotent open and conditional claim, the masking, the routes (list, view, approve, deny) by access, the one claim behind every
 * door (the execution route, the agent-session side door, an API key, a cancel, the expiry), the journal row, the Needs you items
 * and what happens to rows when a workflow is deleted or moved. The waiting runs are real: a test node asks the way the Run an
 * Agent node will (an inbox request per call, then `putExecutionToWait` with `data.approval` and `data.inbox`).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';
import { MASK, maskParams, settledLine, type InboxRequestView } from '@/lib/shared/approval-inbox';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-approval-inbox-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://inbox.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
delete process.env.LANDFLOW_SMTP_HOST;
delete process.env.LANDFLOW_APPROVAL_INBOX_EXPIRY_MINUTES;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { database, MIGRATIONS, migrateSqlite } = await import('@/lib/server/db');
const { createUser, setUserDisabled } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { singleton } = await import('@/lib/server/singleton');
const projects = await import('@/lib/server/projects/store');
const { runWorkflow, cancelWaitingExecution } = await import('@/lib/server/runner');
const { inboxPort } = await import('@/lib/server/approval-inbox/port');
const inbox = await import('@/lib/server/approval-inbox/store');
const access = await import('@/lib/server/approval-inbox/access');
await import('@/lib/server/approval-inbox');
const { rememberSecretValues, forgetSecretValues } = await import('@/lib/server/secrets/redact');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { needsYou } = await import('@/lib/server/journal/needs-you');
const { journalStore } = await import('@/lib/server/journal');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { openApiDocument } = await import('@/lib/server/openapi');
const { withAuth } = await import('@/lib/server/auth/context');
const listRoute = await import('@/app/api/approval-inbox/route');
const oneRoute = await import('@/app/api/approval-inbox/[id]/route');
const approveRoute = await import('@/app/api/approval-inbox/[id]/approve/route');
const denyRoute = await import('@/app/api/approval-inbox/[id]/deny/route');
const executionApprovals = await import('@/app/api/executions/[id]/approvals/route');
const sessionApprovals = await import('@/app/api/agents/[id]/sessions/[sid]/approvals/route');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');
const { decideApproval } = await import('@/lib/server/approvals');

// ---------------------------------------------------------------------------
// The asking node: what Run an Agent will do (AP02), without the agent
// ---------------------------------------------------------------------------

const main = [{ type: 'main' as const }];
interface Plan {
  calls: Array<{ callId: string; tool: string; params: Record<string, unknown>; destination?: string }>;
  workflowId: string;
}
const plan = { current: undefined as Plan | undefined };
let sequence = 0;

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'inboxtest', name: 'Inbox test node', version: '0.0.1', description: 'Test nodes' },
    nodes: [
      defineNode({
        description: { name: 'asker', displayName: 'Asker', description: 'Asks the approval inbox, then waits', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
        async execute(ctx) {
          const saved = ctx.getNodeState?.() as { $resume?: { kind: string; data?: { decisions?: Record<string, unknown> } } } | undefined;
          ctx.setNodeState?.(undefined);
          const port = inboxPort()!;
          if (saved?.$resume) {
            const out = ctx.getNodeState ? Object.fromEntries(plan.current!.calls.map((c) => [c.callId, port.outcome(ctx.getExecutionId(), c.callId)?.status])) : {};
            return [[{ json: { resumed: saved.$resume.kind, decisions: (saved.$resume.data?.decisions ?? {}) as never, outcomes: out as never } }]];
          }
          const executionId = ctx.getExecutionId();
          const opened = await port.open(
            plan.current!.calls.map((c) => ({
              executionId,
              callId: c.callId,
              workflowId: plan.current!.workflowId,
              workflowName: 'Alert mailer flow',
              workflowVersion: 4,
              nodeId: ctx.getNode().id,
              nodeName: ctx.getNode().name,
              agentId: 'agent-ap1',
              agentName: 'Alert mailer',
              agentVersion: 2,
              sessionId: 'as_ap1',
              tool: c.tool,
              params: c.params,
              ...(c.destination && { destination: c.destination }),
              trigger: 'webhook',
            })),
          );
          ctx.putExecutionToWait!({
            resume: 'webhook',
            rerun: true,
            until: opened.expiresAt,
            data: {
              approval: { nodeName: ctx.getNode().name, nodeId: ctx.getNode().id, channel: 'chat', requestedAt: new Date().toISOString(), calls: plan.current!.calls.map((c) => ({ id: c.callId, tool: c.tool, input: c.params as never })) } as never,
              inbox: { ids: opened.ids, expiresAt: opened.expiresAt } as never,
            },
          });
          return [[]];
        },
      }),
    ],
  }),
);

beforeAll(() => {
  enableTestAuth();
});
afterAll(() => {
  waits.stop();
  forgetSecretValues();
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// The fixture: project P (editor Ed, viewer Vi), project Q (editor Out), an admin
// ---------------------------------------------------------------------------

const admin = await createUser({ email: 'ada@inbox.test', name: 'Ada Admin', role: 'admin', password: 'ada-password-1' });
const editor = await createUser({ email: 'ed@inbox.test', name: 'Ed Editor', role: 'member', password: 'ed-password-12' });
const viewer = await createUser({ email: 'vi@inbox.test', name: 'Vi Viewer', role: 'member', password: 'vi-password-12' });
const outsider = await createUser({ email: 'out@inbox.test', name: 'Out Sider', role: 'member', password: 'out-password-1' });
const P = projects.createTeamProject({ name: 'Alerts' }).id;
const Q = projects.createTeamProject({ name: 'Other team' }).id;
projects.setMember(P, editor.id, 'editor');
projects.setMember(P, viewer.id, 'viewer');
projects.setMember(Q, outsider.id, 'editor');
type User = typeof admin;

function workflow(id: string, project: string): Workflow {
  const saved = store.saveWorkflow({
    id,
    name: 'Alert mailer flow',
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'Ask', name: 'Ask', type: 'inboxtest.asker', typeVersion: 1, position: [200, 0], parameters: {} },
    ],
    connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'Ask', sourceIndex: 0, targetIndex: 0 }],
  } as unknown as Workflow);
  projects.setHomeProject('workflow', id, project);
  return saved;
}
workflow('wf_inbox', P);

const as = async <T>(user: User | undefined, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user as never);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};
/** A request as an API key (never a person): the bypass principal says `api-key`. */
const asApiKey = async <T>(fn: () => Promise<T>): Promise<T> => {
  const state = singleton('auth-test-bypass', () => ({}) as { principal?: unknown });
  state.principal = { user: admin, via: 'api-key', apiKey: { id: 'key1', scopes: ['admin'] } };
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (route: typeof approveRoute, id: string, body?: unknown) =>
  route.POST(new Request('http://inbox.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx(id));
const get = (route: { GET: (request: Request, context: never) => Promise<Response> }, id: string) => route.GET(new Request('http://inbox.test/x'), ctx(id) as never);
const list = async (query = '') => ((await (await listRoute.GET(new Request(`http://inbox.test/api/approval-inbox${query}`))).json()) as { requests: InboxRequestView[] }).requests;
const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 20 });
const PASSWORD = 'smtp-super-secret-pw';
const SECRET_VALUE = 'vault-resolved-api-credential-zz9';

/** A run of wf_inbox that opens one request per call and waits; returns its ids. */
async function ask(calls: Plan['calls'] = [{ callId: `c${++sequence}`, tool: 'Send Email', params: { to: 'oncall@acme.test', subject: 'Disk full' }, destination: 'oncall@acme.test' }], workflowId = 'wf_inbox') {
  plan.current = { calls, workflowId };
  const run = await runWorkflow({ workflow: store.getWorkflow(workflowId)!, mode: 'trigger', startNodeId: 'Start', triggerItems: [{ json: {} }] });
  await until(() => expect(store.getExecution(run.executionId)?.status).toBe('waiting'));
  const wait = store.getExecution(run.executionId)!.wait!.data as { inbox: { ids: Record<string, string>; expiresAt: string } };
  return { executionId: run.executionId, ids: wait.inbox.ids, calls, expiresAt: wait.inbox.expiresAt };
}
const idOf = (a: Awaited<ReturnType<typeof ask>>, n = 0) => a.ids[a.calls[n].callId];

// ---------------------------------------------------------------------------

describe('the contract and the table', () => {
  it.skipIf(!process.env.LANDFLOW_BACKBONE_CONTRACTS)('the copies equal contracts/ap1', () => {
    const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS!;
    const src = join(__dirname, '..', 'src', 'lib');
    expect(readFileSync(join(src, 'shared', 'approval-inbox.ts'), 'utf8')).toBe(readFileSync(join(dir, 'ap1', 'approval-inbox.ts'), 'utf8'));
    expect(readFileSync(join(src, 'server', 'approval-inbox', 'port.ts'), 'utf8')).toBe(readFileSync(join(dir, 'ap1', 'inbox-port.ts'), 'utf8'));
  });

  it('migration 2907 runs on a fresh database and on one at 2906', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const existing = new DatabaseSync(':memory:');
    migrateSqlite(existing, MIGRATIONS.filter((m) => m.version <= 2906));
    expect(existing.prepare("SELECT name FROM sqlite_master WHERE name = 'approval_inbox'").all()).toEqual([]);
    expect(migrateSqlite(existing, MIGRATIONS.filter((m) => m.version <= 2907))).toEqual([2907]);
    const fresh = new DatabaseSync(':memory:');
    expect(migrateSqlite(fresh)).toContain(2907);
    for (const db of [existing, fresh]) {
      const columns = (db.prepare('PRAGMA table_info(approval_inbox)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['id', 'execution_id', 'call_id', 'workflow_id', 'params', 'status', 'expires_at', 'nudged', 'decided_via']));
      expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval_inbox'").all() as Array<{ name: string }>).map((i) => i.name)).toEqual(expect.arrayContaining(['approval_inbox_call', 'approval_inbox_status', 'approval_inbox_workflow']));
    }
  });

  it('the policy and the openapi document name the routes', () => {
    expect(routePolicy('GET', '/api/approval-inbox')).toEqual({ scope: 'executions:read' });
    expect(routePolicy('GET', '/api/approval-inbox/abc')).toEqual({ scope: 'executions:read' });
    expect(routePolicy('POST', '/api/approval-inbox/abc/approve')).toEqual({ scope: 'run', sessionOnly: true });
    expect(routePolicy('POST', '/api/approval-inbox/abc/deny')).toEqual({ scope: 'run', sessionOnly: true });
    const paths = Object.keys((openApiDocument('http://inbox.test') as { paths: Record<string, unknown> }).paths);
    expect(paths).toEqual(expect.arrayContaining(['/api/approval-inbox', '/api/approval-inbox/{id}', '/api/approval-inbox/{id}/approve', '/api/approval-inbox/{id}/deny']));
  });
});

describe('opening a request', () => {
  it('is idempotent on (execution, call): the same ids, nothing new the second time', async () => {
    const call = { executionId: 'exec-open-1', callId: 'c1', workflowId: 'wf_inbox', workflowName: 'Alert mailer flow', nodeId: 'n', nodeName: 'Ask', agentId: 'a', agentName: 'Mailer', sessionId: 's', tool: 'Send Email', params: { to: 'x@acme.test' }, trigger: 'webhook' };
    const first = inbox.openRequests([call]);
    const second = inbox.openRequests([call]);
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.ids).toEqual(first.ids);
    expect(second.expiresAt).toBe(first.expiresAt);
    // The variable moves a request opened later, never one already open.
    process.env.LANDFLOW_APPROVAL_INBOX_EXPIRY_MINUTES = '10';
    try {
      const later = inbox.openRequests([{ ...call, executionId: 'exec-open-2' }], new Date(Date.parse(first.created[0].requested_at)));
      expect(Date.parse(later.expiresAt) - Date.parse(first.created[0].requested_at)).toBe(10 * 60_000);
      expect(inbox.openRequests([call]).expiresAt).toBe(first.expiresAt);
    } finally {
      delete process.env.LANDFLOW_APPROVAL_INBOX_EXPIRY_MINUTES;
    }
    expect(Date.parse(first.expiresAt) - Date.parse(first.created[0].requested_at)).toBe(1440 * 60_000);
  });

  it('keeps no secret: a vault value and a password key never reach the row, a view or a list', async () => {
    rememberSecretValues({ key: SECRET_VALUE });
    const a = await ask([{ callId: 'cs', tool: 'Send Email', params: { to: 'ops@acme.test', body: `token is ${SECRET_VALUE}`, smtpPassword: PASSWORD, nested: { 'x-api-key': PASSWORD }, auth: `Bearer ${'a'.repeat(24)}` }, destination: `ops@acme.test via ${SECRET_VALUE}` }]);
    const row = inbox.requestRow(idOf(a))!;
    const everything = [row.params, row.destination, JSON.stringify(access.viewFor(row, admin)), JSON.stringify(await list('?status=all'))].join('\n');
    expect(everything).not.toContain(SECRET_VALUE);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(everything).toContain(MASK);
    expect(JSON.parse(row.params)).toMatchObject({ to: 'ops@acme.test', smtpPassword: MASK });
    expect(maskParams({ maxTokens: 5, compass: 'north', accessToken: 'x1' })).toEqual({ maxTokens: 5, compass: 'north', accessToken: MASK });
    forgetSecretValues();
  });
});

describe('who sees and who decides', () => {
  it('lists and shows a request by access; canDecide needs run access; another project gets 404', async () => {
    const a = await ask();
    const id = idOf(a);
    const seen = async (user: User | undefined) => (await as(user, list)).filter((r) => r.id === id);
    expect(await seen(undefined)).toHaveLength(1);
    expect((await seen(admin))[0].canDecide).toBe(true);
    expect((await seen(editor))[0].canDecide).toBe(true);
    expect((await seen(viewer))[0].canDecide).toBe(false);
    expect(await seen(outsider)).toHaveLength(0);
    const one = await as(viewer, () => get(oneRoute, id));
    expect(one.status).toBe(200);
    expect(((await one.json()) as { request: InboxRequestView }).request).toMatchObject({ id, status: 'waiting', tool: 'Send Email', agentName: 'Alert mailer', agentVersion: 2, workflowVersion: 4, destination: 'oncall@acme.test', canDecide: false });
    expect((await as(outsider, () => get(oneRoute, id))).status).toBe(404);
    expect((await get(oneRoute, 'nope')).status).toBe(404);
    // Deciding: a viewer reads but cannot run (403), someone in another project sees nothing (404).
    expect((await as(viewer, () => post(approveRoute, id))).status).toBe(403);
    expect((await as(outsider, () => post(approveRoute, id))).status).toBe(404);
    expect(inbox.requestRow(id)!.status).toBe('waiting');
    expect(store.getExecution(a.executionId)!.status).toBe('waiting');
  });

  it('filters by status and execution, newest first', async () => {
    const a = await ask();
    expect((await list(`?executionId=${a.executionId}`)).map((r) => r.id)).toEqual([idOf(a)]);
    await post(denyRoute, idOf(a));
    expect(await list(`?executionId=${a.executionId}`)).toHaveLength(0);
    expect((await list(`?executionId=${a.executionId}&status=all`)).map((r) => r.status)).toEqual(['denied']);
    expect((await listRoute.GET(new Request('http://inbox.test/api/approval-inbox?status=bogus'))).status).toBe(400);
  });

  it('an API key never decides, and a request with no session is refused', async () => {
    const a = await ask();
    const id = idOf(a);
    expect((await asApiKey(() => post(approveRoute, id))).status).toBe(403);
    expect(inbox.requestRow(id)!.status).toBe('waiting');
    // The same through decideApproval, past the route's own guard.
    await expect(withAuth({ principal: { user: admin, via: 'api-key', apiKey: { id: 'key1', scopes: ['admin'] } } }, () => decideApproval(a.executionId, a.calls[0].callId, true, { by: 'ada@inbox.test' }))).rejects.toThrow(/A person decides an approval in Needs you/);
    await expect(decideApproval(a.executionId, a.calls[0].callId, true, { slackUser: 'U1' })).rejects.toThrow(/A person decides/);
    await expect(decideApproval(a.executionId, a.calls[0].callId, true)).rejects.toThrow(/A person decides/);
    expect(inbox.requestRow(id)!.status).toBe('waiting');
    // The execution approvals route refuses a key too, before it streams anything.
    const viaRun = await asApiKey(() =>
      executionApprovals.POST(new Request('http://inbox.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: a.calls[0].callId, approved: true }) }), ctx(a.executionId)),
    );
    expect(viaRun.status).toBe(403);
    expect(inbox.requestRow(id)!.status).toBe('waiting');
  });
});

describe('one claim behind every door', () => {
  it('approve: 200 with the settled view, the run resumes, the journal row reads settledLine; a second approve is 409', async () => {
    const a = await ask();
    const id = idOf(a);
    const response = await as(editor, () => post(approveRoute, id, { note: 'checked the recipient' }));
    expect(response.status).toBe(200);
    const view = ((await response.json()) as { request: InboxRequestView }).request;
    expect(view).toMatchObject({ id, status: 'approved', decidedBy: 'ed@inbox.test', decidedByName: 'Ed Editor', decidedVia: 'inbox', canDecide: true });
    await until(() => expect(store.getExecution(a.executionId)?.status).toBe('success'));
    const done = store.getExecution(a.executionId)!;
    expect(done.runData.Ask.at(-1)!.outputs[0]![0].json).toMatchObject({ resumed: 'approval', decisions: { [a.calls[0].callId]: { approved: true, by: 'ed@inbox.test', comment: 'checked the recipient' } }, outcomes: { [a.calls[0].callId]: 'approved' } });
    const said = journalStore.readAll(a.executionId).filter((e) => e.type === 'message').map((e) => ('text' in e ? e.text : ''));
    expect(said).toContain(settledLine({ status: 'approved', tool: 'Send Email', decidedByName: 'Ed Editor', decidedVia: 'inbox', decidedAt: view.decidedAt }, inbox.serverClock));
    expect(said.join('\n')).toMatch(/Approved by Ed Editor in Needs you · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/);
    // Double approve: who won, and nothing runs twice.
    const again = await as(admin, () => post(approveRoute, id));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/^Already approved by Ed Editor at /);
    expect((await as(admin, () => post(denyRoute, id))).status).toBe(409);
  });

  it('deny: the run resumes with the refusal recorded', async () => {
    const a = await ask();
    const response = await as(admin, () => post(denyRoute, idOf(a)));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { request: InboxRequestView }).request).toMatchObject({ status: 'denied', decidedByName: 'Ada Admin' });
    await until(() => expect(store.getExecution(a.executionId)?.status).toBe('success'));
    expect(store.getExecution(a.executionId)!.runData.Ask.at(-1)!.outputs[0]![0].json).toMatchObject({ decisions: { [a.calls[0].callId]: { approved: false } }, outcomes: { [a.calls[0].callId]: 'denied' } });
    expect((await post(denyRoute, idOf(a))).status).toBe(409);
  });

  it('a note over 500 characters is refused before anything is decided', async () => {
    const a = await ask();
    expect((await post(approveRoute, idOf(a), { note: 'x'.repeat(501) })).status).toBe(400);
    expect(inbox.requestRow(idOf(a))!.status).toBe('waiting');
  });

  it('approve after the expiry settled it: 410; and past its time an approve settles it expired instead of approving', async () => {
    const a = await ask();
    const port = inboxPort()!;
    const settled = await port.settle(a.executionId, a.calls[0].callId, 'expired');
    expect(settled.won).toBe(true);
    const late = await post(approveRoute, idOf(a));
    expect(late.status).toBe(410);
    expect(((await late.json()) as { error: string }).error).toMatch(/^This approval expired at .*: “Send Email” did not run\.$/);
    // Settling again loses, and says who won.
    expect(await port.settle(a.executionId, a.calls[0].callId, 'cancelled')).toMatchObject({ won: false, outcome: { status: 'expired', via: 'expiry' } });

    const b = await ask();
    database().sqlite.prepare('UPDATE approval_inbox SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), idOf(b));
    expect((await post(approveRoute, idOf(b))).status).toBe(410);
    expect(inbox.requestRow(idOf(b))).toMatchObject({ status: 'expired', decided_via: 'expiry' });
    expect(store.getExecution(b.executionId)!.status).toBe('waiting');
  });

  it('approve on a cancelled run: 409, and the row was settled cancelled from the bus', async () => {
    const a = await ask();
    expect(cancelWaitingExecution(a.executionId)).toBe(true);
    await until(() => expect(inbox.requestRow(idOf(a))!.status).toBe('cancelled'));
    const response = await post(approveRoute, idOf(a));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('The run was cancelled: “Send Email” did not run.');
    expect(await list(`?executionId=${a.executionId}`)).toHaveLength(0);
  });

  it('a waiting row whose run is gone settles cancelled when read', async () => {
    const a = await ask();
    store.deleteExecution(a.executionId);
    const shown = await list(`?executionId=${a.executionId}`);
    expect(shown).toHaveLength(0);
    expect(inbox.requestRow(idOf(a))).toMatchObject({ status: 'cancelled', decided_via: 'cancel' });
  });

  it('the execution approvals route claims the same row (via run-trace); the inbox route then answers 409', async () => {
    const a = await ask();
    const id = idOf(a);
    const response = await as(editor, () =>
      executionApprovals.POST(new Request('http://inbox.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: a.calls[0].callId, approved: true }) }), ctx(a.executionId)),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(inbox.requestRow(id)).toMatchObject({ status: 'approved', decided_via: 'run-trace', decided_by_name: 'Ed Editor' });
    expect((await as(admin, () => post(approveRoute, id))).status).toBe(409);
    // And the route itself answers a settled request's word before it tries anything.
    const twice = await as(admin, () =>
      executionApprovals.POST(new Request('http://inbox.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: a.calls[0].callId, approved: false }) }), ctx(a.executionId)),
    );
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { error: string }).error).toMatch(/^Already approved by Ed Editor/);
    await until(() => expect(store.getExecution(a.executionId)?.status).toBe('success'));
  });

  it('the agent-session side door answers 409 for a call that waits in Needs you, and never decides it', async () => {
    const a = await ask();
    const agent = agentStore.create({ name: 'Alert mailer', instructions: 'x' });
    projects.setHomeProject('agent', agent.id, P);
    const session = newSession(agent, { source: 'workflow', userId: 'usr_test_owner', version: 'draft' } as never);
    agentStore.saveSession({ ...session, status: 'awaiting_approval', pending: { calls: [{ callId: a.calls[0].callId, tool: 'Send Email', input: { to: 'x' } }] } as never, execution: { workflowId: 'wf_inbox', executionId: a.executionId, nodeId: 'Ask' } } as never);
    const door = () => sessionApprovals.POST(new Request('http://inbox.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: a.calls[0].callId, approved: true }) }), { params: Promise.resolve({ id: agent.id, sid: session.id }) });
    const response = await door();
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('“Send Email” waits in Needs you: decide it there');
    expect(agentStore.getSession(session.id)!.pending!.calls[0].decision).toBeUndefined();
    expect(inbox.requestRow(idOf(a))!.status).toBe('waiting');
    await post(denyRoute, idOf(a));
    expect((await door()).status).toBe(409);
  });

  it('a wait without a request decides exactly as before (no claim, no 403 for a missing person)', async () => {
    // A scripted chat-style approval wait: data.approval only.
    const now = new Date().toISOString();
    store.saveExecution({
      executionId: `exec-plain-${process.pid}`,
      workflowId: 'wf_inbox',
      workflowName: 'Alert mailer flow',
      mode: 'chat',
      status: 'waiting',
      startedAt: now,
      finishedAt: '',
      durationMs: 0,
      runData: {},
      executionOrder: [],
      wait: { nodeId: 'Ask', nodeName: 'Ask', resume: 'webhook', since: now, data: { approval: { nodeName: 'Ask', channel: 'chat', calls: [{ id: 'p1', tool: 'Send Email', input: {} }, { id: 'p2', tool: 'Send Email', input: {} }] } } },
    } as never);
    const first = await decideApproval(`exec-plain-${process.pid}`, 'p1', true, {});
    expect(first.status).toBe('waiting');
    await expect(decideApproval(`exec-plain-${process.pid}`, 'p1', false, {})).rejects.toThrow('Already approved');
    expect(inbox.rowFor(`exec-plain-${process.pid}`, 'p1')).toBeUndefined();
  });
});

describe('Needs you', () => {
  it('shows one item per waiting request with the inbox fields, and drops it once settled', async () => {
    const a = await ask([
      { callId: 'n1', tool: 'Send Email', params: { to: 'a@acme.test' }, destination: 'a@acme.test' },
      { callId: 'n2', tool: 'Post Message', params: { channel: '#ops' } },
    ]);
    const items = async (user?: User) => {
      const body = (await as(user, async () => (await needsYouRoute.GET(new Request('http://inbox.test/api/runs/needs-you'))).json())) as { items: Array<Record<string, unknown>> };
      return body.items.filter((i) => i.executionId === a.executionId);
    };
    const shown = await items();
    expect(shown).toHaveLength(2);
    expect(shown.find((i) => i.tool === 'Send Email')).toMatchObject({
      kind: 'approval',
      title: '“Alert mailer” wants to run “Send Email”',
      detail: 'a@acme.test · Alert mailer flow v4',
      requestId: a.ids.n1,
      inboxStatus: 'waiting',
      agentName: 'Alert mailer',
      agentVersion: 2,
      workflowVersion: 4,
      destination: 'a@acme.test',
      expiresAt: a.expiresAt,
      canDecide: true,
    });
    expect((await items(viewer)).every((i) => i.canDecide === false)).toBe(true);
    expect(await items(outsider)).toHaveLength(0);
    // One decided: the other stays; the whole wait is gone once both are.
    await post(approveRoute, a.ids.n1);
    expect((await items()).map((i) => i.tool)).toEqual(['Post Message']);
    await post(denyRoute, a.ids.n2);
    await until(() => expect(store.getExecution(a.executionId)?.status).toBe('success'));
    expect(await items()).toHaveLength(0);
    expect((await needsYou(undefined)).filter((i) => i.executionId === a.executionId)).toHaveLength(0);
  });
});

describe('deleted and moved workflows', () => {
  it('a deleted workflow keeps its rows (only owners and admins read them); a moved one is read through its new project', async () => {
    workflow('wf_move', P);
    const a = await ask(undefined, 'wf_move');
    const id = idOf(a);
    expect((await as(editor, list)).map((r) => r.id)).toContain(id);
    // Transferred to project Q: P's editor loses it, Q's editor gains it; the row followed `workflow_id`.
    projects.setHomeProject('workflow', 'wf_move', Q);
    expect((await as(editor, list)).map((r) => r.id)).not.toContain(id);
    expect((await as(outsider, list)).map((r) => r.id)).toContain(id);
    expect((await as(outsider, () => get(oneRoute, id))).status).toBe(200);
    expect((await as(editor, () => get(oneRoute, id))).status).toBe(404);
    // Deleted: the row stays, for the audit; the run is cancelled, so it settles and only admins read it.
    store.deleteWorkflow?.('wf_move');
    projects.forgetResource('workflow', 'wf_move');
    cancelWaitingExecution(a.executionId);
    await until(() => expect(inbox.requestRow(id)!.status).toBe('cancelled'));
    expect(inbox.requestRow(id)).toBeDefined();
    expect((await as(outsider, () => get(oneRoute, id))).status).toBe(404);
    expect((await as(admin, () => get(oneRoute, id))).status).toBe(200);
    expect(((await (await as(admin, () => get(oneRoute, id))).json()) as { request: InboxRequestView }).request.workflowName).toBe('Alert mailer flow');
  });
});
