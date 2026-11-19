/**
 * Wave ap1's joins (carryover-ap1.md §2; docs/approval-inbox.md): AP01's inbox (the record, the claim, the routes, the nudges),
 * AP02's Run an Agent step (the pause, the resume that trusts the record, the publish lines) and the host's doors, together, with
 * both real sides and no fake between them: the real port (`lib/server/approval-inbox`), the real webhook, hosted-chat and
 * approval routes, the messaging plugin's Send Email over a fake SMTP server, the host's mail over another, and a loopback alert
 * receiver. Only the model is scripted.
 *
 *  1. pause → record → Needs you → nudge → approve → one run of the tool (a second approve is 409, no second mail)
 *  2. deny: refused, no mail, the step ends success and the agent says it did not send
 *  3. expiry: the timer resumes the run as a timeout, the row is expired, no mail; approve after → 410; the nudge's link → 410
 *  4. restart: the timers and the port go away while a run waits; boot re-arms; approve resumes it and the tool runs once
 *  5. cancel: the row is cancelled, approve → 409, the Run Trace line reads "Cancelled with the run"
 *  6. publish lines against the runtime, for every trigger word: what the line says is what a run does (the hosted chat and an
 *     MCP call refuse even with Ask; a Refuse twin refuses; webhook, schedule and form wait)
 *  7. races: an email link and the inbox route at once, an approve against the expiry at once: one wins, the tool runs at most once
 *  8. doors: the execution route claims the same row; the agent-session route and the resume URL refuse; an API key, a viewer and
 *     another project cannot decide
 *  9. no secret anywhere
 * 10. contracts and guards
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toToolName, type Workflow, type WorkflowNode } from '@landflow/engine';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeSmtp } from '../../../plugins/messaging/test/fake-smtp';
import type { InboxRequestView, PublishLine } from '@/lib/shared/approval-inbox';

vi.setConfig({ testTimeout: 60_000 });

const DEST_PASSWORD = 'pw-ap1-joins-destination-made-up';
const HOST_PASSWORD = 'pw-ap1-joins-host-mail-made-up';
const SECRET_VALUE = 'vault-value-ap1-joins-zq7';
const destination = await startFakeSmtp({ auth: { user: 'mail', password: DEST_PASSWORD }, authMethods: ['PLAIN'] });
const hostMail = await startFakeSmtp({ auth: { user: 'host', password: HOST_PASSWORD }, authMethods: ['PLAIN'] });
const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ap1-joins-')),
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
  LANDFLOW_PUBLIC_URL: 'http://joins.test',
  LANDFLOW_SMTP_HOST: '127.0.0.1',
  LANDFLOW_SMTP_PORT: String(hostMail.port),
  LANDFLOW_SMTP_USER: 'host',
  LANDFLOW_SMTP_PASS: HOST_PASSWORD,
  LANDFLOW_SMTP_IGNORE_TLS: 'true',
  LANDFLOW_SMTP_FROM: 'landflow@joins.test',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
delete process.env.LANDFLOW_APPROVAL_INBOX_EXPIRY_MINUTES;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { runWorkflow, cancelWaitingExecution, planRetry, planRerun } = await import('@/lib/server/runner');
const { publishDraft } = await import('@/lib/server/publish');
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { singleton } = await import('@/lib/server/singleton');
const projects = await import('@/lib/server/projects/store');
const { registerInboxPort, inboxPort } = await import('@/lib/server/approval-inbox/port');
const { approvalInbox } = await import('@/lib/server/approval-inbox');
const inbox = await import('@/lib/server/approval-inbox/store');
const { flushNudges } = await import('@/lib/server/approval-inbox/nudge');
const { useLink, confirmationPage } = await import('@/lib/server/approval-email');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const { journalStore } = await import('@/lib/server/journal');
const { rememberSecretValues, forgetSecretValues } = await import('@/lib/server/secrets/redact');
const { settledLine, waitLine, refusesLine, MASK, EXPIRY_VARIABLE, REFUSE_WHY } = await import('@/lib/shared/approval-inbox');
const { unattendedTrigger } = await import('@/lib/server/agents/unattended');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');
const chatRoute = await import('@/app/chat/[...path]/route');
const listRoute = await import('@/app/api/approval-inbox/route');
const oneRoute = await import('@/app/api/approval-inbox/[id]/route');
const approveRoute = await import('@/app/api/approval-inbox/[id]/approve/route');
const denyRoute = await import('@/app/api/approval-inbox/[id]/deny/route');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');
const executionApprovals = await import('@/app/api/executions/[id]/approvals/route');
const sessionApprovals = await import('@/app/api/agents/[id]/sessions/[sid]/approvals/route');
const waitingRoute = await import('@/app/api/waiting/[id]/route');
const linesRoute = await import('@/app/api/workflows/[id]/unattended-approvals/route');

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(messaging);

// ---------------------------------------------------------------------------
// The other sides: a scripted model, a loopback alert receiver
// ---------------------------------------------------------------------------

type Body = { messages: Array<{ role: string; content: unknown }> };
const SEND = 'Send Email';
const WRITE = toToolName(SEND);
let modelCalls = 0;
/** Stateless: a fresh conversation asks to send; after the tool's answer the agent says what happened. */
const fake = await startFakeModels({
  reply: (_provider, body: Body): FakeReply => {
    modelCalls += 1;
    const last = [...body.messages].reverse().find((m) => m.role === 'tool');
    if (!last) return { toolCalls: [{ id: `c_${modelCalls}`, name: WRITE, arguments: {} }] };
    return { text: /did not run|needs a person/.test(String(last.content)) ? 'I did not send the email.' : 'Sent the email to on-call.' };
  },
});

const received: Array<{ body: string; json: Record<string, unknown> }> = [];
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ body, json: JSON.parse(body || '{}') });
    res.writeHead(204).end();
  });
});
await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

afterAll(async () => {
  waits.stop();
  alerts.stop();
  forgetSecretValues();
  enableTestAuth();
  await fake.close();
  await destination.close();
  await hostMail.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  for (const key of [...Object.keys(ENV), EXPIRY_VARIABLE]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// People, projects, the agent and the flows
// ---------------------------------------------------------------------------

const owner = await createUser({ email: 'olive@joins.test', name: 'Olive Owner', role: 'owner', password: 'olive-password-1' });
const viewer = await createUser({ email: 'vi@joins.test', name: 'Vi Viewer', role: 'member', password: 'vi-password-123' });
const outsider = await createUser({ email: 'out@joins.test', name: 'Out Sider', role: 'member', password: 'out-password-12' });
const P = projects.createTeamProject({ name: 'Alerts' }).id;
const Q = projects.createTeamProject({ name: 'Other team' }).id;
projects.setMember(P, viewer.id, 'viewer');
projects.setMember(Q, outsider.id, 'editor');
type User = typeof owner;

rememberSecretValues({ joins: SECRET_VALUE });
const smtpCredential = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: destination.port, secure: false, disableStartTls: true, user: 'mail', password: DEST_PASSWORD } });
const mailer = agentStore.create({
  name: 'Alert mailer',
  instructions: 'You email on-call.',
  model: { provider: 'ollama', model: 'mailer-model', baseUrl: fake.url.replace(/\/v1$/, '') },
  tools: [
    {
      id: 'tl_mail',
      type: 'node',
      name: SEND,
      description: 'Email on-call',
      nodeType: 'messaging.emailSend',
      parameters: { fromEmail: 'landflow@landflow.test', toEmail: 'oncall@landflow.test', subject: 'Disk full on web-01', emailFormat: 'text', text: 'Disk is full on web-01.', apiKey: SECRET_VALUE },
      credentials: { smtp: { id: smtpCredential.id, name: smtpCredential.name } },
      requireApproval: true,
    },
  ],
} as never);
agentStore.publish(mailer.id);
projects.setHomeProject('agent', mailer.id, P);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });
let flows = 0;
const TRIGGER_PARAMETERS: Record<string, (n: number) => Record<string, unknown>> = {
  'core.webhook': (n) => ({ path: `ap1-joins-${n}`, method: 'POST', respond: 'immediately' }),
  'core.chatTrigger': () => ({ public: true, responseMode: 'lastNode' }),
  'core.formTrigger': (n) => ({ path: `ap1-joins-form-${n}`, formTitle: 'Alert' }),
  'core.mcpTrigger': (n) => ({ path: `ap1-joins-mcp-${n}` }),
};
/** A published flow: the trigger → Run an Agent (the mailer, Tool Approvals as given), in project P. */
async function published(trigger = 'core.webhook', toolApprovals: string | undefined = 'askInChat'): Promise<Workflow & { path: string }> {
  const n = ++flows;
  const parameters = TRIGGER_PARAMETERS[trigger]?.(n) ?? {};
  const wf: Workflow = {
    id: `wf_ap1_joins_${n}`,
    name: `Alert mailer flow ${n}`,
    nodes: [node('Start', trigger, parameters), node('Agent', 'core.messageAgent', { agentId: mailer.id, message: trigger === 'core.chatTrigger' ? '' : 'Email on-call about the alert', conversation: 'new', ...(toolApprovals && { toolApprovals }) })],
    connections: [edge('Start', 'Agent')],
  };
  store.saveWorkflow(wf);
  projects.setHomeProject('workflow', wf.id, P);
  await publishDraft(wf.id, owner.id, 'ap1 joins');
  return { ...store.getWorkflow(wf.id)!, path: String(parameters.path ?? wf.id) };
}

// ---------------------------------------------------------------------------
// Doors and helpers
// ---------------------------------------------------------------------------

const as = async <T>(user: User | undefined, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user as never);
  try {
    return await fn();
  } finally {
    enableTestAuth(owner as never);
  }
};
const asApiKey = async <T>(fn: () => Promise<T>): Promise<T> => {
  const state = singleton('auth-test-bypass', () => ({}) as { principal?: unknown });
  state.principal = { user: owner, via: 'api-key', apiKey: { id: 'key1', scopes: ['admin'] } };
  try {
    return await fn();
  } finally {
    enableTestAuth(owner as never);
  }
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonPost = (body?: unknown) => new Request('http://joins.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const approve = (id: string, body?: unknown) => approveRoute.POST(jsonPost(body), ctx(id));
const deny = (id: string) => denyRoute.POST(jsonPost(), ctx(id));
const viewOf = async (id: string) => ((await (await oneRoute.GET(new Request('http://joins.test/x'), ctx(id) as never)).json()) as { request: InboxRequestView }).request;
const listFor = async (workflowId: string, status = 'waiting') => ((await (await listRoute.GET(new Request(`http://joins.test/api/approval-inbox?status=${status}`))).json()) as { requests: InboxRequestView[] }).requests.filter((r) => r.workflowId === workflowId);
const until = (check: () => void | Promise<void>, timeout = 15_000) => vi.waitFor(check, { timeout, interval: 25 });
const hook = (path: string, body: Record<string, unknown> = { alert: 'disk full' }) =>
  webhookRoute.POST(new Request(`http://joins.test/api/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: [path] }) });
const toOncall = () => destination.mails.filter((m) => m.to.includes('oncall@landflow.test'));
const nudgesTo = (email: string) => hostMail.mails.filter((m) => m.to.includes(email));
const agentOut = (executionId: string) => store.getExecution(executionId)!.runData.Agent?.at(-1)?.outputs?.[0]?.[0]?.json as { reply: string; steps: Array<{ tool: string; status: string; approvedBy?: string }> };
/** A mail's source with its base64 parts decoded (what the person reads). */
const readable = (source: string) =>
  source.replace(/Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/g, (_all, body: string) => Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'));
const linksIn = (source: string) => [...readable(source).matchAll(/https?:\/\/[^\s"<>]+\/api\/approvals\/email\/[^\s"<>]+/g)].map((m) => m[0]);
const tokenOf = (url: string) => url.split('/api/approvals/email/')[1]!;

/** A webhook call through the real route that waits in the inbox: the run, its one request. */
async function waitingCall(wf: Workflow & { path: string }) {
  const before = new Set(store.listExecutions({ workflowId: wf.id }).map((e) => e.id));
  const answer = await hook(wf.path);
  expect(answer.status).toBeLessThan(300);
  let executionId = '';
  await until(() => {
    const run = store.listExecutions({ workflowId: wf.id }).find((e) => !before.has(e.id));
    expect(run?.status).toBe('waiting');
    executionId = run!.id;
  });
  const [request] = (await listFor(wf.id)).filter((r) => r.executionId === executionId);
  expect(request).toBeDefined();
  await flushNudges();
  return { executionId, request: request!, callId: request!.callId };
}

beforeEach(() => {
  enableTestAuth(owner as never);
});

// ---------------------------------------------------------------------------
// 1. Pause → record → Needs you → nudge → approve
// ---------------------------------------------------------------------------

describe('1. pause → record → Needs you → nudge → approve → one run of the tool', () => {
  it('a published Webhook flow waits in Needs you, nudges by mail and alert, and Approve sends exactly one mail', async () => {
    const channel = alertStore.createChannel({ name: 'Local alerts', kind: 'webhook', config: { url: hookUrl, secret: 'ap1-joins-hook-secret' } });
    alertStore.createRule({ name: 'Approvals', enabled: true, workflows: { mode: 'all' }, events: ['approval'] as never, channelIds: [channel.id], throttleMinutes: 0 });
    const wf = await published();
    const sentBefore = toOncall().length;
    const { executionId, request, callId } = await waitingCall(wf);

    // The record: masked parameters, the destination, both versions, the trigger word.
    expect(request).toMatchObject({ status: 'waiting', tool: SEND, agentName: 'Alert mailer', trigger: 'webhook', workflowVersion: expect.any(Number), agentVersion: expect.any(Number), canDecide: true });
    expect(request.destination).toContain('oncall@landflow.test');
    expect((request.params as Record<string, unknown>).apiKey).toBe(MASK);
    expect(store.getExecution(executionId)!.triggerType).toBe('core.webhook');

    // Needs you lists it, decidable by the owner.
    const items = ((await (await needsYouRoute.GET(new Request('http://joins.test/api/runs/needs-you'))).json()) as { items: Array<Record<string, unknown>> }).items.filter((i) => i.executionId === executionId);
    expect(items).toEqual([expect.objectContaining({ kind: 'approval', requestId: request.id, inboxStatus: 'waiting', tool: SEND, canDecide: true })]);

    // One nudge mail to the person with run access; one signed alert request naming the tool, no parameter value.
    expect(nudgesTo(owner.email)).toHaveLength(1);
    expect(nudgesTo(viewer.email)).toHaveLength(0);
    await alerts.tick();
    const hits = received.filter((r) => r.json.event === 'approval');
    expect(hits).toHaveLength(1);
    expect((hits[0]!.json.details as Record<string, string>).Tool).toBe(SEND);
    expect(hits[0]!.body).not.toContain('Disk is full on web-01.');
    expect(toOncall()).toHaveLength(sentBefore);

    // Approve: 200 with the settled view; the run ends success; exactly one mail to the destination.
    const answer = await approve(request.id, { note: 'checked' });
    expect(answer.status).toBe(200);
    const settled = ((await answer.json()) as { request: InboxRequestView }).request;
    expect(settled).toMatchObject({ status: 'approved', decidedByName: 'Olive Owner', decidedVia: 'inbox' });
    await until(() => expect(store.getExecution(executionId)?.status).toBe('success'));
    expect(toOncall()).toHaveLength(sentBefore + 1);
    const out = agentOut(executionId);
    expect(out.steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'success' })]);
    expect(out.steps[0]!.approvedBy).toMatch(/^Approved by Olive Owner in Needs you/);
    const said = journalStore.readAll(executionId).flatMap((e) => (e.type === 'message' && 'text' in e ? [String(e.text)] : []));
    expect(said.join('\n')).toContain('Approved by Olive Owner in Needs you');
    expect(settledLine(settled, (iso) => iso)).toMatch(/^Approved by Olive Owner in Needs you · /);

    // A second approve: 409 with who won; no second mail.
    const again = await approve(request.id);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/^Already approved by Olive Owner/);
    expect(toOncall()).toHaveLength(sentBefore + 1);
    expect(nudgesTo(owner.email)).toHaveLength(1);
    expect(callId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. Deny
// ---------------------------------------------------------------------------

describe('2. deny', () => {
  it('refuses the call: no mail, the step ends success and the agent says it did not send', async () => {
    const wf = await published();
    const sent = toOncall().length;
    const { executionId, request } = await waitingCall(wf);
    expect((await deny(request.id)).status).toBe(200);
    await until(() => expect(store.getExecution(executionId)?.status).toBe('success'));
    expect(toOncall()).toHaveLength(sent);
    const out = agentOut(executionId);
    expect(out.steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'denied' })]);
    expect(out.reply).toBe('I did not send the email.');
    expect((await viewOf(request.id)).status).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// 3. Expiry
// ---------------------------------------------------------------------------

/** The waits' timer, fired: the wait's `until` moved into the past and the timers re-armed (what the clock does at expiry). */
function expireNow(executionId: string) {
  const stored = store.getExecution(executionId)!;
  store.saveExecution({ ...stored, wait: { ...stored.wait!, until: new Date(Date.now() - 1000).toISOString() } });
  waits.stop();
  waits.start(0);
}

describe('3. expiry', () => {
  it('with the variable at 1 minute the timer resumes the run as a timeout: expired, no mail; approve after → 410; the link → 410', async () => {
    process.env[EXPIRY_VARIABLE] = '1';
    try {
      const wf = await published();
      const sent = toOncall().length;
      const { executionId, request } = await waitingCall(wf);
      expect(Date.parse(request.expiresAt) - Date.parse(request.requestedAt)).toBe(60_000);
      expect(store.getExecution(executionId)!.wait?.until).toBe(request.expiresAt);
      const link = linksIn(nudgesTo(owner.email).at(-1)!.data)[0]!;
      expect(link).toBeDefined();
      expireNow(executionId);
      await until(() => expect(store.getExecution(executionId)?.status).toBe('success'));
      expect((await viewOf(request.id)).status).toBe('expired');
      expect(toOncall()).toHaveLength(sent);
      expect(agentOut(executionId).steps).toEqual([expect.objectContaining({ status: 'denied' })]);
      const late = await approve(request.id);
      expect(late.status).toBe(410);
      expect((await confirmationPage(tokenOf(link))).status).toBe(410);
    } finally {
      delete process.env[EXPIRY_VARIABLE];
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Restart
// ---------------------------------------------------------------------------

describe('4. restart', () => {
  it('the timers and the port go while a run waits; boot re-arms; approve resumes it and the tool runs once; no second nudge', async () => {
    const wf = await published();
    const sent = toOncall().length;
    const { executionId, request } = await waitingCall(wf);
    const nudged = hostMail.mails.length;
    // The restart: no timer, no port; then the boot registers the port and re-arms the waits from the database.
    waits.stop();
    registerInboxPort(undefined as never);
    expect(inboxPort()).toBeUndefined();
    registerInboxPort(approvalInbox);
    waits.start(0);
    expect(waits.pending()).toContain(executionId);
    expect((await approve(request.id)).status).toBe(200);
    await until(() => expect(store.getExecution(executionId)?.status).toBe('success'));
    expect(toOncall()).toHaveLength(sent + 1);
    await flushNudges();
    expect(hostMail.mails).toHaveLength(nudged);
    expect(waits.pending()).not.toContain(executionId);
  });
});

// ---------------------------------------------------------------------------
// 5. Cancel
// ---------------------------------------------------------------------------

describe('5. cancel', () => {
  it('cancelling the waiting run settles the row cancelled; approve → 409; the Run Trace line says so', async () => {
    const wf = await published();
    const sent = toOncall().length;
    const { executionId, request } = await waitingCall(wf);
    expect(cancelWaitingExecution(executionId)).toBe(true);
    await until(async () => expect((await viewOf(request.id)).status).toBe('cancelled'));
    const answer = await approve(request.id);
    expect(answer.status).toBe(409);
    expect(settledLine(await viewOf(request.id), (iso) => iso)).toBe(`Cancelled with the run: “${SEND}” did not run`);
    expect(toOncall()).toHaveLength(sent);
  });
});

// ---------------------------------------------------------------------------
// 6. Publish lines against the runtime, for every trigger word
// ---------------------------------------------------------------------------

const linesOf = async (id: string) =>
  ((await (await (linesRoute.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request(`http://joins.test/api/workflows/${id}/unattended-approvals`), { params: Promise.resolve({ id }) })).json()) as PublishLine[]);

/** What a production run of the flow actually does at the tool that asks first, through the door that trigger uses. */
async function runtimeOutcome(wf: Workflow & { path: string }, trigger: string): Promise<'waits' | 'refuses'> {
  const sent = toOncall().length;
  let executionId: string;
  if (trigger === 'core.chatTrigger') {
    // The real hosted chat page.
    const answer = await chatRoute.POST(new Request(`http://joins.test/chat/${wf.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: `visitor-${wf.id}`, message: 'Email on-call about the alert' }) }), {
      params: Promise.resolve({ path: [wf.id] }),
    });
    const body = (await answer.json()) as { executionId?: string; status?: string; output?: string };
    expect(body.status).not.toBe('waiting');
    executionId = body.executionId ?? store.listExecutions({ workflowId: wf.id })[0]!.id;
  } else if (trigger === 'core.webhook') {
    const before = new Set(store.listExecutions({ workflowId: wf.id }).map((e) => e.id));
    await hook(wf.path);
    await until(() => expect(store.listExecutions({ workflowId: wf.id }).find((e) => !before.has(e.id) && e.status !== 'running')).toBeDefined());
    executionId = store.listExecutions({ workflowId: wf.id }).find((e) => !before.has(e.id))!.id;
  } else {
    // The mode each door starts it in (scheduler.ts 'trigger', the form route 'webhook', mcp/trigger.ts 'mcp'), the trigger's item given.
    const mode = trigger === 'core.schedule' ? 'trigger' : trigger === 'core.mcpTrigger' ? 'mcp' : 'webhook';
    executionId = (await runWorkflow({ workflow: wf, mode, triggerOutput: { nodeId: 'Start', items: [{ json: { alert: 'disk full' } }] } })).executionId;
  }
  await until(() => expect(['waiting', 'success']).toContain(store.getExecution(executionId)?.status));
  const record = store.getExecution(executionId)!;
  const waiting = (await listFor(wf.id)).filter((r) => r.executionId === executionId);
  if (record.status === 'waiting') {
    expect(waiting).toHaveLength(1);
    expect(toOncall()).toHaveLength(sent);
    cancelWaitingExecution(executionId);
    return 'waits';
  }
  expect(waiting).toHaveLength(0);
  expect(toOncall()).toHaveLength(sent);
  expect(agentOut(executionId).steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'denied' })]);
  return 'refuses';
}

describe('6. publish lines agree with the runtime, for every trigger word', () => {
  it.each([
    ['core.webhook', 'askInChat', 'webhook', 'waits', undefined],
    ['core.schedule', 'askInChat', 'schedule', 'waits', undefined],
    ['core.formTrigger', 'askInChat', 'form', 'waits', undefined],
    ['core.chatTrigger', 'askInChat', 'chat', 'refuses', 'hostedChat'],
    ['core.mcpTrigger', 'askInChat', 'MCP call', 'refuses', 'mcp'],
    ['core.webhook', 'refuse', 'webhook', 'refuses', 'refuseSetting'],
  ] as const)('%s with %s: the line says %s, and a run does the same (%s)', async (trigger, setting, word, expected, why) => {
    const wf = await published(trigger, setting);
    expect(unattendedTrigger(trigger)).toBe(word);
    const lines = await linesOf(wf.id);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({ tool: SEND, agent: 'Alert mailer', trigger: word, outcome: expected });
    if (expected === 'waits') expect(line!.line).toBe(waitLine(SEND, word, 1440));
    else {
      expect(line!.why).toBe(why);
      expect(line!.line).toBe(refusesLine(SEND, word, why!));
    }
    expect(await runtimeOutcome(wf, trigger)).toBe(line!.outcome);
    // A refusal from the trigger says the same reason in the tool's answer to the agent.
    if (why === 'hostedChat' || why === 'mcp') {
      const run = store.listExecutions({ workflowId: wf.id }).map((e) => store.getExecution(e.id)!).find((r) => r.runData.Agent)!;
      expect(JSON.stringify(agentStore.getSession((run.runData.Agent!.at(-1)!.outputs[0]![0]!.json as { sessionId: string }).sessionId))).toContain(REFUSE_WHY[why]);
    }
  });

  it('the line takes its expiry from the variable', async () => {
    const wf = await published();
    process.env[EXPIRY_VARIABLE] = '10';
    try {
      expect((await linesOf(wf.id))[0]).toMatchObject({ outcome: 'waits', expiresAfterMinutes: 10, line: waitLine(SEND, 'webhook', 10) });
    } finally {
      delete process.env[EXPIRY_VARIABLE];
    }
  });
});

describe('6b. publish lines agree with the runtime for a roster target, a called workflow and a retry (fix pass 2)', () => {
  const agentNode = (id: string) => node(id, 'core.messageAgent', { agentId: mailer.id, message: 'Email on-call about the alert', conversation: 'new', toolApprovals: 'askInChat' });
  const publishFlow = async (wf: Workflow) => {
    store.saveWorkflow(wf);
    projects.setHomeProject('workflow', wf.id, P);
    await publishDraft(wf.id, owner.id, 'ap1 joins');
    return store.getWorkflow(wf.id)!;
  };
  const noRequests = async (wfId: string) => expect((await listFor(wfId)).length).toBe(0);

  it('a hosted chat whose visitor picks a roster target: every line refuses with the hosted chat as why, and the run refuses with no request and no mail', async () => {
    const n = ++flows;
    const wf = await publishFlow({
      id: `wf_ap1_roster_${n}`,
      name: `Roster ${n}`,
      nodes: [node('Start', 'core.chatTrigger', { public: true, responseMode: 'lastNode', roster: { agent: [{ key: 'ops', label: 'Ops', target: 'Ops' }] } }), agentNode('Lead'), agentNode('Ops')],
      connections: [edge('Start', 'Lead')],
    });
    const lines = await linesOf(wf.id);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatchObject({ trigger: 'chat', outcome: 'refuses', why: 'hostedChat' });
    const sent = toOncall().length;
    const answer = await chatRoute.POST(new Request(`http://joins.test/chat/${wf.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: `visitor-roster-${n}`, message: 'Email on-call about the alert', agentKey: 'ops' }) }), { params: Promise.resolve({ path: [wf.id] }) });
    const body = (await answer.json()) as { executionId?: string; status?: string };
    expect(body.status).not.toBe('waiting');
    const run = store.getExecution(body.executionId ?? store.listExecutions({ workflowId: wf.id })[0]!.id)!;
    expect(run.triggerType).toBe('core.chatTrigger');
    expect(run.runData.Ops).toBeDefined();
    await noRequests(wf.id);
    expect(toOncall()).toHaveLength(sent);
  });

  it('a called workflow waits when a webhook run called it and refuses when a hosted chat run did, while its own line says it waits', async () => {
    const n = ++flows;
    const child = await publishFlow({ id: `wf_ap1_child_${n}`, name: `Child ${n}`, nodes: [node('Start', 'core.workflowTrigger'), agentNode('Agent')], connections: [edge('Start', 'Agent')] });
    expect(await linesOf(child.id)).toEqual([expect.objectContaining({ trigger: 'called workflow', outcome: 'waits' })]);
    const call = (parentRun: string) => runWorkflow({ workflow: child, mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: { alert: 'disk full' } }], parent: { executionId: parentRun } });
    const sent = toOncall().length;
    // From a hosted chat run: refuses, the parent need not even exist any more.
    const chat = await published('core.chatTrigger', 'refuse');
    const chatRun = (await runWorkflow({ workflow: chat, mode: 'webhook', startNodeId: 'Start', triggerType: 'core.chatTrigger', triggerItems: [{ json: { chatInput: 'hi' } }] })).executionId;
    store.deleteExecution(chatRun);
    const refused = await call(chatRun);
    expect(refused.status).toBe('success');
    expect(agentOut(refused.executionId).steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'denied' })]);
    await noRequests(child.id);
    // From a webhook run: waits.
    const hookWf = await published('core.webhook', 'refuse');
    const hookRun = (await runWorkflow({ workflow: hookWf, mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: {} }] })).executionId;
    const waits = await call(hookRun);
    expect(waits.status).toBe('waiting');
    expect((await listFor(child.id)).filter((r) => r.executionId === waits.executionId)).toHaveLength(1);
    cancelWaitingExecution(waits.executionId);
    expect(toOncall()).toHaveLength(sent);
  });

  it('an automatic retry of a failed hosted-chat run refuses as its line says, and the retry of a webhook run waits as its line says', async () => {
    for (const [trigger, expected] of [['core.chatTrigger', 'refuses'], ['core.webhook', 'waits']] as const) {
      const wf = await published(trigger);
      expect((await linesOf(wf.id))[0]).toMatchObject({ outcome: expected });
      const source = (await runWorkflow({ workflow: wf, mode: 'webhook', startNodeId: 'Start', triggerType: trigger, triggerItems: [{ json: { chatInput: 'Email on-call about the alert' } }] })).executionId;
      if (expected === 'waits') cancelWaitingExecution(source);
      store.patchExecution(source, { status: 'error', error: { message: 'boom', nodeId: 'Agent' } });
      const retried = await runWorkflow({ ...planRetry(source, { automatic: true }), bypassConcurrency: true });
      expect(retried.triggerType).toBe(trigger);
      const requests = (await listFor(wf.id)).filter((r) => r.executionId === retried.executionId);
      if (expected === 'waits') {
        expect(retried.status).toBe('waiting');
        expect(requests).toHaveLength(1);
        cancelWaitingExecution(retried.executionId);
      } else {
        expect(retried.status).toBe('success');
        expect(requests).toHaveLength(0);
      }
    }
  });
});

describe('6c. a run saved before the wave has no triggerType (fix pass 3)', () => {
  const agentNode = (id: string) => node(id, 'core.messageAgent', { agentId: mailer.id, message: 'Email on-call about the alert', conversation: 'new', toolApprovals: 'askInChat' });
  const publishFlow = async (wf: Workflow) => {
    store.saveWorkflow(wf);
    projects.setHomeProject('workflow', wf.id, P);
    await publishDraft(wf.id, owner.id, 'ap1 joins');
    return store.getWorkflow(wf.id)!;
  };
  /** A record as the version before the wave saved it. */
  const unstamp = (id: string) => store.patchExecution(id, { triggerType: undefined });
  const requestsOf = async (wfId: string, executionId: string) => (await listFor(wfId)).filter((r) => r.executionId === executionId);
  /** A hosted chat run that began at the roster target ('Ops'), or its webhook twin starting at the same node. */
  const rosterFlow = (trigger: 'core.chatTrigger' | 'core.webhook') => {
    const n = ++flows;
    return publishFlow({
      id: `wf_ap1_prewave_${n}`,
      name: `Pre-wave ${n}`,
      nodes: [node('Start', trigger, trigger === 'core.webhook' ? { path: `ap1-prewave-${n}`, method: 'POST' } : { public: true, responseMode: 'lastNode' }), agentNode('Lead'), agentNode('Ops')],
      connections: [edge('Start', 'Lead')],
    });
  };
  const startAt = (wf: Workflow, trigger: string) => runWorkflow({ workflow: wf, mode: 'webhook', startNodeId: trigger === 'core.webhook' ? 'Start' : 'Ops', triggerType: trigger, triggerItems: [{ json: { chatInput: 'Email on-call about the alert' } }] });

  it.each([
    ['core.chatTrigger', 'refuses'],
    ['core.webhook', 'waits'],
  ] as const)('a pre-wave %s run, re-run whole: it %s', async (trigger, expected) => {
    const wf = await rosterFlow(trigger);
    const source = await startAt(wf, trigger);
    if (expected === 'waits') cancelWaitingExecution(source.executionId);
    unstamp(source.executionId);
    const sent = toOncall().length;
    const again = await runWorkflow({ ...planRerun(source.executionId, { scope: 'all' }) });
    const requests = await requestsOf(wf.id, again.executionId);
    if (expected === 'waits') {
      expect(again.status).toBe('waiting');
      expect(requests).toHaveLength(1);
      cancelWaitingExecution(again.executionId);
    } else {
      expect(again.status).toBe('success');
      expect(requests).toHaveLength(0);
      const steps = (store.getExecution(again.executionId)!.runData.Ops?.at(-1)?.outputs?.[0]?.[0]?.json as { steps: Array<{ tool: string; status: string }> }).steps;
      expect(steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'denied' })]);
    }
    expect(toOncall()).toHaveLength(sent);
  });

  it.each([
    ['core.chatTrigger', 'refuses'],
    ['core.webhook', 'waits'],
  ] as const)('a pre-wave %s run, retried automatically from the start: it %s', async (trigger, expected) => {
    const wf = await rosterFlow(trigger);
    const source = await startAt(wf, trigger);
    if (expected === 'waits') cancelWaitingExecution(source.executionId);
    unstamp(source.executionId);
    store.patchExecution(source.executionId, { status: 'error', error: { message: 'boom', nodeId: 'Gone' } });
    const sent = toOncall().length;
    const retried = await runWorkflow({ ...planRetry(source.executionId, { automatic: true, from: 'start' }), bypassConcurrency: true });
    const requests = await requestsOf(wf.id, retried.executionId);
    if (expected === 'waits') {
      expect(retried.status).toBe('waiting');
      expect(requests).toHaveLength(1);
      cancelWaitingExecution(retried.executionId);
    } else {
      expect(retried.status).toBe('success');
      expect(requests).toHaveLength(0);
    }
    expect(toOncall()).toHaveLength(sent);
  });

  it.each([
    ['core.chatTrigger', 'refuses'],
    ['core.webhook', 'waits'],
  ] as const)('a workflow called by a pre-wave %s parent: it %s', async (trigger, expected) => {
    const n = ++flows;
    const parent = await published(trigger, 'refuse');
    const parentRun = (await runWorkflow({ workflow: parent, mode: 'webhook', startNodeId: 'Start', triggerType: trigger, triggerItems: [{ json: { chatInput: 'hi' } }] })).executionId;
    unstamp(parentRun);
    const child = await publishFlow({ id: `wf_ap1_prechild_${n}`, name: `Pre child ${n}`, nodes: [node('Start', 'core.workflowTrigger'), agentNode('Agent')], connections: [edge('Start', 'Agent')] });
    const called = await runWorkflow({ workflow: child, mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: {} }], parent: { executionId: parentRun } });
    if (expected === 'waits') {
      expect(called.status).toBe('waiting');
      expect(await requestsOf(child.id, called.executionId)).toHaveLength(1);
      cancelWaitingExecution(called.executionId);
    } else {
      expect(called.triggerType).toBe('core.chatTrigger');
      expect(called.status).toBe('success');
      expect(await requestsOf(child.id, called.executionId)).toHaveLength(0);
    }
  });

  it('a refusing inherited trigger wins over the one the caller passed', async () => {
    const n = ++flows;
    const parent = await published('core.chatTrigger', 'refuse');
    const parentRun = (await runWorkflow({ workflow: parent, mode: 'webhook', startNodeId: 'Start', triggerType: 'core.chatTrigger', triggerItems: [{ json: { chatInput: 'hi' } }] })).executionId;
    const child = await publishFlow({ id: `wf_ap1_winchild_${n}`, name: `Win child ${n}`, nodes: [node('Start', 'core.workflowTrigger'), agentNode('Agent')], connections: [edge('Start', 'Agent')] });
    const called = await runWorkflow({ workflow: child, mode: 'webhook', startNodeId: 'Start', triggerType: 'core.webhook', triggerItems: [{ json: {} }], parent: { executionId: parentRun } });
    expect(called.triggerType).toBe('core.chatTrigger');
    expect(await requestsOf(child.id, called.executionId)).toHaveLength(0);
  });

  it('a retry from the checkpoint of a pre-wave roster-target run keeps its refusal, and the plan names the trigger it derived', async () => {
    const n = ++flows;
    const wf = await publishFlow({
      id: `wf_ap1_precp_${n}`,
      name: `Pre checkpoint ${n}`,
      nodes: [node('Start', 'core.chatTrigger', { public: true, responseMode: 'lastNode' }), node('Ops', 'core.noOp'), node('Boom', 'core.stopAndError', { message: 'boom' }), agentNode('Agent')],
      connections: [edge('Start', 'Ops'), edge('Ops', 'Boom'), edge('Boom', 'Agent')],
    });
    const source = await runWorkflow({ workflow: wf, mode: 'webhook', startNodeId: 'Ops', triggerType: 'core.chatTrigger', triggerItems: [{ json: { chatInput: 'x' } }] });
    expect(source.status).toBe('error');
    expect(store.getCheckpoint(source.executionId)).toBeDefined();
    unstamp(source.executionId);
    const plan = planRetry(source.executionId, { automatic: true });
    expect(plan.fromCheckpoint).toBeDefined();
    expect(plan.triggerType).toBe('core.noOp');
    // The graph repaired (the failing step is now a no-op) and resumed from the checkpoint: the agent after it must refuse.
    const repaired = { ...wf, nodes: wf.nodes.map((nd) => (nd.id === 'Boom' ? node('Boom', 'core.noOp') : nd)) };
    const sent = toOncall().length;
    const retried = await runWorkflow({ ...plan, workflow: repaired, bypassConcurrency: true });
    expect(retried.status).toBe('success');
    expect(await requestsOf(wf.id, retried.executionId)).toHaveLength(0);
    expect(toOncall()).toHaveLength(sent);
  });
});

describe('6d. a pre-wave child of a pre-wave parent is judged by its parent (fix pass 4)', () => {
  const agentNode = (id: string) => node(id, 'core.messageAgent', { agentId: mailer.id, message: 'Email on-call about the alert', conversation: 'new', toolApprovals: 'askInChat' });
  const publishFlow = async (wf: Workflow) => {
    store.saveWorkflow(wf);
    projects.setHomeProject('workflow', wf.id, P);
    await publishDraft(wf.id, owner.id, 'ap1 joins');
    return store.getWorkflow(wf.id)!;
  };
  const unstamp = (id: string) => store.patchExecution(id, { triggerType: undefined });
  const requestsOf = async (wfId: string, executionId: string) => (await listFor(wfId)).filter((r) => r.executionId === executionId);
  /** A parent run begun by `trigger`, and a workflow it called, both saved as the version before the wave saved them (no triggerType). */
  async function preWavePair(trigger: 'core.chatTrigger' | 'core.webhook') {
    const n = ++flows;
    const parent = await published(trigger, 'refuse');
    const parentRun = (await runWorkflow({ workflow: parent, mode: 'webhook', startNodeId: 'Start', triggerType: trigger, triggerItems: [{ json: { chatInput: 'hi' } }] })).executionId;
    const child = await publishFlow({ id: `wf_ap1_pair_${n}`, name: `Pair child ${n}`, nodes: [node('Start', 'core.workflowTrigger'), agentNode('Agent')], connections: [edge('Start', 'Agent')] });
    // The child as the version before the wave ran it: it waited (or ran) under its parent with no stamp on either record.
    const childRun = trigger === 'core.webhook'
      ? await runWorkflow({ workflow: child, mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: {} }], parent: { executionId: parentRun } })
      : await runWorkflow({ workflow: child, mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: {} }], triggerType: 'core.workflowTrigger', parent: { executionId: parentRun } });
    if (trigger === 'core.webhook') cancelWaitingExecution(childRun.executionId);
    unstamp(parentRun);
    unstamp(childRun.executionId);
    expect(store.getExecution(childRun.executionId)!.parentExecutionId).toBe(parentRun);
    return { child, childRun: childRun.executionId, parentRun };
  }

  it.each([
    ['core.chatTrigger', 'refuses'],
    ['core.webhook', 'waits'],
  ] as const)('a pre-wave child of a pre-wave %s parent, re-run whole: it %s', async (trigger, expected) => {
    const { child, childRun } = await preWavePair(trigger);
    expect(planRerun(childRun, { scope: 'all' }).triggerType).toBe(trigger === 'core.chatTrigger' ? 'core.chatTrigger' : 'core.workflowTrigger');
    const again = await runWorkflow({ ...planRerun(childRun, { scope: 'all' }) });
    const requests = await requestsOf(child.id, again.executionId);
    if (expected === 'waits') {
      expect(again.status).toBe('waiting');
      expect(requests).toHaveLength(1);
      cancelWaitingExecution(again.executionId);
    } else {
      expect(again.status).toBe('success');
      expect(requests).toHaveLength(0);
    }
  });

  it.each([
    ['core.chatTrigger', 'refuses'],
    ['core.webhook', 'waits'],
  ] as const)('a pre-wave child of a pre-wave %s parent, retried by a person: it %s', async (trigger, expected) => {
    const { child, childRun } = await preWavePair(trigger);
    store.patchExecution(childRun, { status: 'error', error: { message: 'boom', nodeId: 'Gone' } });
    const sent = toOncall().length;
    const retried = await runWorkflow({ ...planRetry(childRun, { from: 'start' }), bypassConcurrency: true });
    const requests = await requestsOf(child.id, retried.executionId);
    if (expected === 'waits') {
      expect(retried.status).toBe('waiting');
      expect(requests).toHaveLength(1);
      cancelWaitingExecution(retried.executionId);
    } else {
      expect(retried.status).toBe('success');
      expect(requests).toHaveLength(0);
    }
    expect(toOncall()).toHaveLength(sent);
  });

  it('the verdict the agent node reads on a resume (recordTrigger through the live lookup) is the parent\'s for a pre-wave child, recursively; an unreadable parent is no trigger that may wait', async () => {
    const { recordTrigger, triggerCanWait, UNKNOWN_ORIGIN } = await import('@/lib/server/runner/trigger');
    const record = (over: Record<string, unknown>) => ({ executionId: 'x', workflowId: 'w', workflowName: 'w', mode: 'webhook', status: 'running', startedAt: '', finishedAt: '', durationMs: 0, runData: {}, executionOrder: [], ...over }) as never;
    const chat = record({ executionId: 'p0', workflow: { id: 'w', name: 'w', nodes: [node('Start', 'core.chatTrigger')], connections: [] }, executionOrder: ['Start'] });
    const mid = record({ executionId: 'p1', parentExecutionId: 'p0', workflow: { id: 'w', name: 'w', nodes: [node('Start', 'core.workflowTrigger')], connections: [] }, executionOrder: ['Start'] });
    const leaf = record({ executionId: 'p2', parentExecutionId: 'p1', workflow: { id: 'w', name: 'w', nodes: [node('Start', 'core.workflowTrigger')], connections: [] }, executionOrder: ['Start'] });
    const all: Record<string, unknown> = { p0: chat, p1: mid, p2: leaf };
    expect(recordTrigger(leaf, (id) => all[id] as never)).toBe('core.chatTrigger');
    expect(recordTrigger(leaf, () => undefined)).toBe(UNKNOWN_ORIGIN);
    expect(triggerCanWait(UNKNOWN_ORIGIN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Races
// ---------------------------------------------------------------------------

describe('7. races', () => {
  it('an email link and the inbox route on the same request at once: exactly one wins, the tool runs once', async () => {
    const wf = await published();
    const sent = toOncall().length;
    const { executionId, request } = await waitingCall(wf);
    const link = linksIn(nudgesTo(owner.email).at(-1)!.data)[0]!;
    const [byLink, byRoute] = await Promise.allSettled([useLink(tokenOf(link)), approve(request.id)]);
    const routeWon = byRoute.status === 'fulfilled' && byRoute.value.status === 200;
    const linkWon = byLink.status === 'fulfilled';
    expect(Number(routeWon) + Number(linkWon)).toBe(1);
    await until(() => expect(store.getExecution(executionId)?.status).toBe('success'));
    expect(toOncall()).toHaveLength(sent + 1);
    expect((await viewOf(request.id)).decidedVia).toBe(linkWon ? 'email' : 'inbox');
  });

  it('an approve against the expiry at once: one outcome in the record, the tool runs at most once', async () => {
    const wf = await published();
    const sent = toOncall().length;
    const { executionId, request, callId } = await waitingCall(wf);
    const [byRoute, byTimer] = await Promise.all([approve(request.id), inboxPort()!.settle(executionId, callId, 'expired')]);
    const routeWon = byRoute.status === 200;
    expect(Number(routeWon) + Number(byTimer.won)).toBe(1);
    const status = (await viewOf(request.id)).status;
    expect(status).toBe(routeWon ? 'approved' : 'expired');
    if (!routeWon) expireNow(executionId);
    await until(() => expect(store.getExecution(executionId)?.status).toBe('success'));
    expect(toOncall()).toHaveLength(sent + (routeWon ? 1 : 0));
  });
});

// ---------------------------------------------------------------------------
// 8. Doors
// ---------------------------------------------------------------------------

describe('8. doors', () => {
  it('the execution route claims the same row; the agent-session route and the resume URL refuse; keys, viewers and other projects cannot decide', async () => {
    const wf = await published();
    const sent = toOncall().length;
    const { executionId, request, callId } = await waitingCall(wf);
    const sessionId = inbox.requestRow(request.id)!.session_id;
    expect(agentStore.getSession(sessionId)?.pending?.calls.map((c) => c.callId)).toEqual([callId]);

    // The resume URL refuses an approval wait.
    const resumed = await waitingRoute.POST(new Request(`http://joins.test/api/waiting/${executionId}`, { method: 'POST', body: '{}' }), ctx(executionId) as never);
    expect(resumed.status).toBe(409);
    // The agent-session side door answers 409.
    const side = await sessionApprovals.POST(jsonPost({ callId, approved: true }), { params: Promise.resolve({ id: mailer.id, sid: sessionId }) });
    expect(side.status).toBe(409);
    expect(agentStore.getSession(sessionId)!.pending!.calls[0]!.decision).toBeUndefined();
    // An API key never decides; a viewer reads but cannot run; another project sees nothing.
    expect((await asApiKey(() => approve(request.id))).status).toBe(403);
    expect((await as(viewer, () => approve(request.id))).status).toBe(403);
    expect((await as(outsider, () => approve(request.id))).status).toBe(404);
    expect((await viewOf(request.id)).status).toBe('waiting');

    // The execution approvals route claims the same row (via run-trace); the inbox route then answers 409.
    const viaRun = await executionApprovals.POST(jsonPost({ callId, approved: true }), ctx(executionId));
    expect(viaRun.status).toBe(200);
    await viaRun.text();
    expect(await viewOf(request.id)).toMatchObject({ status: 'approved', decidedVia: 'run-trace' });
    expect((await approve(request.id)).status).toBe(409);
    await until(() => expect(store.getExecution(executionId)?.status).toBe('success'));
    expect(toOncall()).toHaveLength(sent + 1);
  });
});

// ---------------------------------------------------------------------------
// 9. No secret
// ---------------------------------------------------------------------------

describe('9. no secret', () => {
  it('a vault value and the SMTP passwords appear in no row, view, Needs you item, nudge, alert, execution, event or session', async () => {
    const wf = await published();
    const { executionId, request } = await waitingCall(wf);
    await alerts.tick();
    const views = JSON.stringify([await viewOf(request.id), await listFor(wf.id, 'all')]);
    const needs = JSON.stringify(await (await needsYouRoute.GET(new Request('http://joins.test/api/runs/needs-you'))).json());
    const row = JSON.stringify(inbox.requestRow(request.id));
    expect((await approve(request.id)).status).toBe(200);
    await until(() => expect(store.getExecution(executionId)?.status).toBe('success'));
    const record = JSON.stringify(store.getExecution(executionId));
    const events = JSON.stringify(journalStore.readAll(executionId));
    const session = JSON.stringify(agentStore.getSession(agentOut(executionId) && (store.getExecution(executionId)!.runData.Agent!.at(-1)!.outputs[0]![0]!.json as { sessionId: string }).sessionId));
    const nudges = hostMail.mails.map((m) => readable(m.data)).join('\n');
    expect(nudges).toContain('Disk is full on web-01.'); // decoded: the check below reads what the person reads
    const alertBodies = received.map((r) => r.body).join('\n');
    for (const [where, text] of Object.entries({ row, views, needs, record, events, session, nudges, alertBodies, steps: JSON.stringify(agentOut(executionId).steps) })) {
      for (const secret of [SECRET_VALUE, DEST_PASSWORD, HOST_PASSWORD]) expect(text.includes(secret), `${where} holds a secret`).toBe(false);
    }
    expect(row).toContain(MASK);
  });
});

// ---------------------------------------------------------------------------
// 10. Contracts and guards
// ---------------------------------------------------------------------------

describe('10. contracts and guards', () => {
  const repo = join(__dirname, '..', '..', '..');
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    } catch (error) {
      if ((error as { status?: number }).status === 1) return '';
      throw error;
    }
  };

  it.skipIf(!process.env.LANDFLOW_BACKBONE_CONTRACTS)('the copies equal contracts/ap1 and fix-autonomy.ts equals contracts/ag5', () => {
    const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS!;
    const src = join(__dirname, '..', 'src', 'lib');
    expect(readFileSync(join(src, 'shared', 'approval-inbox.ts'), 'utf8')).toBe(readFileSync(join(dir, 'ap1', 'approval-inbox.ts'), 'utf8'));
    expect(readFileSync(join(src, 'server', 'approval-inbox', 'port.ts'), 'utf8')).toBe(readFileSync(join(dir, 'ap1', 'inbox-port.ts'), 'utf8'));
    expect(readFileSync(join(src, 'shared', 'fix-autonomy.ts'), 'utf8')).toBe(readFileSync(join(dir, 'ag5', 'fix-autonomy.ts'), 'utf8'));
  });

  it('no Spotlight, MCP or kagent path names the inbox; approval_inbox is in TABLES; 2907 is the last migration', async () => {
    expect(git('grep', '-n', '-i', '-e', 'approval-inbox', '-e', 'approvalInbox', '-e', 'approval_inbox', '--', 'apps/web/src/lib/server/assistant', 'apps/web/src/lib/server/mcp', 'apps/web/src/lib/server/kagent', 'apps/web/src/lib/shared/assistant-ops.ts')).toBe('');
    const { MIGRATIONS, TABLES } = (await import('@/lib/server/db/schema')) as unknown as { MIGRATIONS: Array<{ version: number }>; TABLES: Record<string, unknown> };
    expect(Object.keys(TABLES)).toContain('approval_inbox');
    expect(MIGRATIONS.at(-1)!.version).toBe(2907);
    expect(MIGRATIONS.filter((m) => m.version > 2906).map((m) => m.version)).toEqual([2907]);
  });
});
