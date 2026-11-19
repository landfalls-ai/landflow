/**
 * The nudges of a new approval request (wave ap1, AP01; docs/approval-inbox.md#nudges): one mail to every active user with run
 * access on the workflow and to each of the agent's approval addresses (deduplicated), with masked parameters and links that
 * decide once and expire with the request; no mail without SMTP, none on a re-open; and an alert rule with the event `approval`
 * on a local signed webhook gets one request per request, signed, without any parameter value. The host's mail is the swapped
 * transport; the receiver is an ephemeral loopback server.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { MASK, nudgeSubject } from '@/lib/shared/approval-inbox';

vi.setConfig({ testTimeout: 30_000 });
// The links decide a scripted waiting run; its resume is not what this file tests.
vi.mock('@/lib/server/runner', async (original) => ({ ...(await original<typeof import('@/lib/server/runner')>()), resumeExecution: vi.fn(async () => ({ status: 'success' })) }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-approval-nudge-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://nudge.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
delete process.env.LANDFLOW_SMTP_HOST;

const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { createUser, setUserDisabled } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const projects = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const { signature } = await import('@/lib/server/alerts/channels');
const { inboxPort } = await import('@/lib/server/approval-inbox/port');
await import('@/lib/server/approval-inbox');
const { flushNudges } = await import('@/lib/server/approval-inbox/nudge');
const inbox = await import('@/lib/server/approval-inbox/store');
const access = await import('@/lib/server/approval-inbox/access');
const { describeLink, confirmationPage, useLink, verifyLink, LinkError } = await import('@/lib/server/approval-email');

enableTestAuth();

// The receiver of the signed webhook.
interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
}
const received: Received[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ headers: req.headers, body, json: JSON.parse(body || '{}') });
    res.writeHead(204).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
const mails: { to: string; subject: string; text: string; html?: string }[] = [];

afterAll(async () => {
  alerts.stop();
  setMailTransport(undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const SECRET_PARAM = 'param-value-that-must-not-travel-9f3';
const PASSWORD = 'smtp-password-in-a-parameter';
const owner = await createUser({ email: 'owner@nudge.test', name: 'Olive Owner', role: 'owner', password: 'owner-password-1' });
const ed1 = await createUser({ email: 'ed1@nudge.test', name: 'Ed One', role: 'member', password: 'ed1-password-12' });
const ed2 = await createUser({ email: 'ed2@nudge.test', name: 'Ed Two', role: 'member', password: 'ed2-password-12' });
const vi1 = await createUser({ email: 'viewer@nudge.test', name: 'Vi Viewer', role: 'member', password: 'vi-password-123' });
const off = await createUser({ email: 'off@nudge.test', name: 'Off Boarded', role: 'member', password: 'off-password-12' });
const P = projects.createTeamProject({ name: 'Alerts' }).id;
for (const [user, role] of [[ed1, 'editor'], [ed2, 'editor'], [vi1, 'viewer'], [off, 'editor']] as const) projects.setMember(P, user.id, role);
setUserDisabled(off.id, true);
store.saveWorkflow({ id: 'wf_nudge', name: 'Alert mailer flow', nodes: [{ id: 'Ask', name: 'Ask', type: 'core.noOp', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] } as unknown as Workflow);
projects.setHomeProject('workflow', 'wf_nudge', P);
// The agent's own approval addresses: one is also a user (deduplicated), one is not.
const agent = agentStore.create({ name: 'Alert mailer', instructions: 'x', settings: { approvalEmails: ['ED1@nudge.test', 'pager@acme.test'] } as never });
agentStore.publish(agent.id);

let seq = 0;
const call = (over: Record<string, unknown> = {}) => ({
  executionId: `exec-nudge-${++seq}`,
  callId: 'c1',
  workflowId: 'wf_nudge',
  workflowName: 'Alert mailer flow',
  workflowVersion: 4,
  nodeId: 'Ask',
  nodeName: 'Ask',
  agentId: agent.id,
  agentName: 'Alert mailer',
  agentVersion: 2 as const,
  sessionId: 's1',
  tool: 'Send Email',
  params: { to: 'oncall@acme.test', subject: 'Disk full', body: SECRET_PARAM, smtpPassword: PASSWORD },
  destination: 'oncall@acme.test',
  trigger: 'webhook',
  ...over,
});
/** A waiting run for the call, as the node leaves it (the nudge's links decide through it). */
function waitingRun(c: ReturnType<typeof call>, ids: Record<string, string>, expiresAt: string) {
  const now = new Date().toISOString();
  store.saveExecution({
    executionId: c.executionId,
    workflowId: 'wf_nudge',
    workflowName: 'Alert mailer flow',
    mode: 'trigger',
    status: 'waiting',
    startedAt: now,
    finishedAt: '',
    durationMs: 0,
    runData: {},
    executionOrder: [],
    wait: { nodeId: 'Ask', nodeName: 'Ask', resume: 'webhook', since: now, until: expiresAt, data: { approval: { nodeName: 'Ask', channel: 'chat', calls: [{ id: c.callId, tool: c.tool, input: {} }] }, inbox: { ids, expiresAt } } },
  } as never);
}
const open = async (c = call()) => {
  const result = await inboxPort()!.open([c]);
  waitingRun(c, result.ids, result.expiresAt);
  await flushNudges();
  return { ...result, c, id: result.ids[c.callId] };
};
const urlsIn = (text: string) => [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
const tokenOf = (url: string) => url.split('/api/approvals/email/')[1];

describe('the mail nudge', () => {
  it('sends nothing without the host’s SMTP', async () => {
    const opened = await open();
    expect(mails).toHaveLength(0);
    expect(inbox.requestRow(opened.id)!.nudged).toBeNull();
  });

  it('one mail to each active user with run access and each approval address, deduplicated; none to a viewer or a disabled user', async () => {
    setMailTransport({ send: async (mail) => void mails.push(mail) });
    const opened = await open();
    const to = mails.map((m) => m.to).sort();
    expect(to).toEqual(['ED1@nudge.test'.toLowerCase(), 'ed2@nudge.test', 'owner@nudge.test', 'pager@acme.test'].sort());
    for (const mail of mails) {
      expect(mail.subject).toBe(nudgeSubject('Send Email', 'Alert mailer flow'));
      expect(mail.text).toContain('Agent: Alert mailer v2');
      expect(mail.text).toContain('Workflow: Alert mailer flow v4');
      expect(mail.text).toContain('oncall@acme.test');
      expect(mail.text).toContain(`${MASK}`);
      expect(mail.text).toContain(`http://nudge.test/?approval=${opened.id}`);
      expect(mail.text).toContain(`expires ${opened.expiresAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`);
      // The parameters are shown masked: the password key never travels, and a plain value does (the person must see what runs).
      expect(mail.text + mail.html).not.toContain(PASSWORD);
    }
    // Counts only: never an address.
    const row = inbox.requestRow(opened.id)!;
    expect(JSON.parse(row.nudged!)).toMatchObject({ email: 4, channels: 0 });
    expect(row.nudged).not.toContain('@');
    expect(access.view(opened.id)!.nudged).toEqual({ email: 4, channels: 0 });
    // A re-open sends nothing more.
    mails.length = 0;
    await inboxPort()!.open([opened.c]);
    await flushNudges();
    expect(mails).toHaveLength(0);
  });

  it('each link decides through useLink once, and expires with the request', async () => {
    mails.length = 0;
    const opened = await open();
    const mail = mails.find((m) => m.to === 'ed2@nudge.test')!;
    const [approve, deny] = urlsIn(mail.text).filter((u) => u.includes('/api/approvals/email/'));
    const payload = verifyLink(tokenOf(approve));
    expect(payload).toMatchObject({ t: { t: 'wf', e: opened.c.executionId, c: 'c1' }, d: 'approve', m: 'ed2@nudge.test' });
    expect(payload.x).toBe(Date.parse(opened.expiresAt));
    expect(await (await confirmationPage(tokenOf(approve))).status).toBe(200);
    const result = await useLink(tokenOf(approve));
    expect(result).toMatchObject({ approved: true, tool: 'Send Email' });
    expect(inbox.requestRow(opened.id)).toMatchObject({ status: 'approved', decided_via: 'email', decided_by: 'email:ed2@nudge.test' });
    // The other link of the group, and another recipient's link, read the closed answer.
    await expect(useLink(tokenOf(deny))).rejects.toMatchObject({ status: 409 });
    const other = urlsIn(mails.find((m) => m.to === 'owner@nudge.test')!.text).filter((u) => u.includes('/api/approvals/email/'))[1];
    const page = await confirmationPage(tokenOf(other));
    expect(page.status).toBe(409);
    expect(await page.text()).toContain('Already approved by ed2@nudge.test');
    await expect(useLink(tokenOf(other))).rejects.toThrow(/^Already approved by ed2@nudge\.test/);
  });

  it('an expired request answers 410 on its link page, and a link past expires_at is expired', async () => {
    mails.length = 0;
    const opened = await open();
    const link = urlsIn(mails.find((m) => m.to === 'owner@nudge.test')!.text).filter((u) => u.includes('/api/approvals/email/'))[0];
    await inboxPort()!.settle(opened.c.executionId, 'c1', 'expired');
    const page = await confirmationPage(tokenOf(link));
    expect(page.status).toBe(410);
    expect(await page.text()).toContain('This approval expired');
    await expect(useLink(tokenOf(link))).rejects.toBeInstanceOf(LinkError);
    await expect(describeLink(tokenOf(link))).resolves.toMatchObject({ closed: expect.stringContaining('expired'), closedStatus: 410 });
    // Past the request's expiry the signed link itself is refused (410).
    expect(() => verifyLink(tokenOf(link), Date.parse(opened.expiresAt) + 1)).toThrow(/expired/);
  });
});

describe('the alert nudge', () => {
  const rule = (events: string[]) => {
    const channel = alertStore.createChannel({ name: 'Approvals hook', kind: 'webhook', config: { url: hookUrl, secret: 'approval-hook-secret' } });
    return alertStore.createRule({ name: 'Approvals', enabled: true, workflows: { mode: 'all' }, events: events as never, channelIds: [channel.id], throttleMinutes: 0 });
  };
  const reset = () => {
    for (const table of ['alert_throttle', 'alert_waiting_sent', 'alert_rules', 'alert_channels'] as const) database().sqlite.exec(`DELETE FROM ${table}`);
    received.length = 0;
    mails.length = 0;
  };

  it('a rule with the event gets one signed request per request, naming the tool and never a parameter value', async () => {
    reset();
    database().sqlite.exec("UPDATE approval_inbox SET status = 'cancelled' WHERE status = 'waiting'");
    const r = rule(['approval']);
    const opened = await open();
    await alerts.tick();
    await alerts.tick();
    expect(received).toHaveLength(1);
    const hit = received[0];
    expect(hit.headers['x-landflow-event']).toBe('alert');
    const timestamp = String(hit.headers['x-landflow-timestamp']);
    expect(hit.headers['x-landflow-signature']).toBe(signature('approval-hook-secret', timestamp, hit.body));
    expect(hit.headers['x-landflow-signature']).toBe(`sha256=${createHmac('sha256', 'approval-hook-secret').update(`${timestamp}.${hit.body}`).digest('hex')}`);
    expect(hit.json).toMatchObject({ event: 'approval', rule: { id: r.id }, summary: nudgeSubject('Send Email', 'Alert mailer flow'), workflow: { name: 'Alert mailer flow' } });
    const details = hit.json.details as Record<string, string>;
    expect(details).toMatchObject({ Tool: 'Send Email', Agent: 'Alert mailer v2', Workflow: 'Alert mailer flow v4', 'Goes to': 'oncall@acme.test' });
    expect(details.Expires).toContain('UTC');
    expect(hit.json.executionsUrl).toBe(`http://nudge.test/?approval=${opened.id}`);
    expect(hit.body).not.toContain(SECRET_PARAM);
    expect(hit.body).not.toContain(PASSWORD);
    expect(JSON.parse(inbox.requestRow(opened.id)!.nudged!).channels).toBe(1);
    // A second request is a second message; a settled request forgets its marker.
    await open();
    await alerts.tick();
    expect(received).toHaveLength(2);
    await inboxPort()!.settle(opened.c.executionId, 'c1', 'cancelled');
    await alerts.tick();
    expect(database().all('SELECT * FROM alert_waiting_sent WHERE execution_id = ?', `approval:${opened.id}`)).toEqual([]);
  });

  it('a rule without the event gets nothing', async () => {
    reset();
    rule(['failed', 'waiting']);
    await open();
    await alerts.tick();
    expect(received).toHaveLength(0);
  });
});
