/**
 * Approval tickets (C12 / P12b): an approval request opens one ticket per (request, ticket channel) through an alert rule with
 * the event `approval`; opening retries at 1, 5 and 15 minutes and then every 15; the ticket is closed with a note when a
 * person decides (or the request expires or is cancelled in Landflow); views show the ticket; and no ticket system ever
 * decides. A ticket holds only the subject, fixed facts and the Needs you link: never a parameter, a judge's evidence or the
 * emailed Approve/Deny links. The ticket system is a local fake of ServiceNow's Table API.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { nudgeSubject, settledLine } from '@/lib/shared/approval-inbox';
import { startFakeServiceNow } from './fake-servicenow';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-approval-tickets-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://tickets.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
delete process.env.LANDFLOW_SMTP_HOST;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { credentials } = await import('@/lib/server/credentials/vault');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const { inboxPort } = await import('@/lib/server/approval-inbox/port');
await import('@/lib/server/approval-inbox');
const { flushNudges, checkApprovalAlerts } = await import('@/lib/server/approval-inbox/nudge');
const inbox = await import('@/lib/server/approval-inbox/store');
const access = await import('@/lib/server/approval-inbox/access');
const tickets = await import('@/lib/server/approval-inbox/tickets');
const { needsYou } = await import('@/lib/server/journal/needs-you');
const { hostMetrics } = await import('@/lib/server/telemetry/metrics');

registry.registerBuiltin(corePlugin);
enableTestAuth();

const fake = await startFakeServiceNow();
afterAll(async () => {
  alerts.stop();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const MIN = 60_000;
const SECRET_PARAM = 'param-value-that-must-not-travel-9f3';
const ITEM_TEXT = 'the-item-text-a-judge-read-7c1';
const basic = credentials.create({ name: 'SN', type: 'core.httpBasicAuth', data: { user: 'landflow', password: 'dev-password' } });

store.saveWorkflow({ id: 'wf_tix', name: 'Ticket flow', nodes: [{ id: 'Ask', name: 'Ask', type: 'core.noOp', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] } as unknown as Workflow);

let seq = 0;
const call = (over: Record<string, unknown> = {}) => ({
  executionId: `exec-tix-${++seq}`,
  callId: 'c1',
  workflowId: 'wf_tix',
  workflowName: 'Ticket flow',
  workflowVersion: 3,
  nodeId: 'Ask',
  nodeName: 'Ask',
  agentId: 'agent_x',
  agentName: 'Billing agent',
  agentVersion: 2 as const,
  sessionId: 's1',
  tool: 'Send Invoice',
  params: { to: 'cfo@acme.test', body: SECRET_PARAM, apiKey: 'sk-live-never-12345' },
  destination: 'cfo@acme.test',
  trigger: 'webhook',
  ...over,
});
function waitingRun(c: ReturnType<typeof call>, ids: Record<string, string>, expiresAt: string) {
  const now = new Date().toISOString();
  store.saveExecution({
    executionId: c.executionId,
    workflowId: 'wf_tix',
    workflowName: 'Ticket flow',
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
  return { ...result, c, id: result.ids[c.callId]! };
};

const sent: Array<{ channelIds: string[]; subject?: string }> = [];
const send = async (rule: { channelIds: string[] }, notice: { custom?: { subject: string } }) => void sent.push({ channelIds: rule.channelIds, subject: notice.custom?.subject });

let plain: ReturnType<typeof alertStore.createChannel>;
let snow: ReturnType<typeof alertStore.createChannel>;
const sweep = (now: number) => checkApprovalAlerts(now, send as never);
const rowsOf = (id: string) => database().all<{ channel_id: string; state: string; attempts: number; next_at: string | null; external_id: string | null; last_error: string | null }>('SELECT * FROM approval_tickets WHERE request_id = ? ORDER BY channel_id', id);
const audits = (action: string) => database().all<{ details: string; actor_type: string; summary: string }>('SELECT * FROM audit_events WHERE action = ?', action);

beforeEach(() => {
  fake.reset();
  sent.length = 0;
  for (const table of ['approval_tickets', 'approval_inbox', 'alert_waiting_sent', 'alert_rules', 'alert_channels', 'audit_events', 'executions']) database().sqlite.exec(`DELETE FROM ${table}`);
  snow = alertStore.createChannel({ name: 'Change board', kind: 'servicenow', config: { url: fake.url, credentialId: basic.id, table: 'change_request', approvedState: '3' } });
  plain = alertStore.createChannel({ name: 'Plain hook', kind: 'webhook', config: { url: `${fake.url}/plain` } });
  alertStore.createRule({ name: 'Needs you', enabled: true, workflows: { mode: 'all' }, events: ['approval'], channelIds: [snow.id, plain.id], throttleMinutes: 0 });
});

describe('opening a ticket', () => {
  it('opens one ServiceNow ticket and leaves the plain channel its one alert', async () => {
    const opened = await open();
    const now = Date.now();
    await sweep(now);
    expect(fake.records).toHaveLength(1);
    const record = fake.records[0]!;
    expect(record.fields.short_description).toBe(nudgeSubject('Send Invoice', 'Ticket flow'));
    expect(record.fields.correlation_id).toBe(opened.id);
    expect(String(record.fields.description)).toContain(`http://tickets.test/?approval=${opened.id}`);
    expect(String(record.fields.description)).toContain('Tool: Send Invoice');
    // AS-1: no parameter value, no key, and no emailed link.
    const body = JSON.stringify(fake.calls);
    expect(body).not.toContain(SECRET_PARAM);
    expect(body).not.toContain('sk-live-never-12345');
    expect(body).not.toContain('/api/approvals/email/');
    expect(rowsOf(opened.id)).toMatchObject([{ channel_id: snow.id, state: 'open', external_id: 'CHG0000001' }]);
    // The plain channel kept today's path: one alert, to it alone.
    expect(sent).toEqual([{ channelIds: [plain.id], subject: nudgeSubject('Send Invoice', 'Ticket flow') }]);
    // Again: once per request and channel.
    await sweep(now + 40_000);
    expect(fake.records).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const trail = audits('approval.ticket.open');
    expect(trail).toHaveLength(1);
    expect(trail[0]!.actor_type).toBe('system');
    expect(trail[0]!.details + trail[0]!.summary).not.toContain(SECRET_PARAM);
  });

  it('a judge request opens a ticket with the judge words and no evidence or item text', async () => {
    const opened = await open(
      call({
        kind: 'judge',
        tool: 'Refund judge',
        params: { item: ITEM_TEXT },
        evidence: { judge: 'Refund judge', fallbackReason: 'low-confidence', reason: `It looked at ${ITEM_TEXT}`, confidence: 0.4, steps: [{ tool: 'lookup', input: ITEM_TEXT, output: ITEM_TEXT }] },
      }),
    );
    await sweep(Date.now());
    expect(fake.records).toHaveLength(1);
    const fields = fake.records[0]!.fields;
    expect(String(fields.short_description)).toContain('Refund judge');
    expect(String(fields.description)).toContain('AI Judge: Refund judge');
    expect(String(fields.description)).toContain('Why it asks');
    expect(JSON.stringify(fake.calls)).not.toContain(ITEM_TEXT);
    expect(rowsOf(opened.id)[0]!.state).toBe('open');
  });

  it('with the system down: no ticket, retries at 1, 5, 15 and then every 15 minutes, the run still waiting', async () => {
    fake.failing = true;
    const opened = await open();
    const t0 = Date.now();
    await sweep(t0);
    expect(rowsOf(opened.id)[0]).toMatchObject({ state: 'opening', attempts: 1 });
    expect(Date.parse(rowsOf(opened.id)[0]!.next_at!)).toBe(t0 + MIN);
    expect(rowsOf(opened.id)[0]!.last_error).toMatch(/HTTP 500/);
    const attempts = () => fake.calls.filter((c) => c.method === 'POST').length;
    expect(attempts()).toBe(1);
    await sweep(t0 + 30_000); // not due
    expect(attempts()).toBe(1);
    const due = [MIN, 6 * MIN, 21 * MIN, 36 * MIN];
    const next = [5 * MIN, 15 * MIN, 15 * MIN, 15 * MIN];
    for (const [i, at] of due.entries()) {
      await sweep(t0 + at);
      expect(attempts()).toBe(i + 2);
      expect(Date.parse(rowsOf(opened.id)[0]!.next_at!)).toBe(t0 + at + next[i]!);
    }
    // The run is still waiting, and its expiry still refuses the call on time (AS-7).
    expect(inbox.requestRow(opened.id)!.status).toBe('waiting');
    // The system is back: the next due tick opens it.
    fake.failing = false;
    await sweep(t0 + 36 * MIN + 15 * MIN);
    expect(rowsOf(opened.id)[0]).toMatchObject({ state: 'open', external_id: 'CHG0000001' });
    expect((await inboxPort()!.settle(opened.c.executionId, 'c1', 'expired')).won).toBe(true);
  });

  it('a request settled before its ticket opened is skipped and nothing is sent', async () => {
    fake.failing = true;
    const opened = await open();
    const t0 = Date.now();
    await sweep(t0);
    await inbox.claim(opened.id, 'denied', { by: 'a@b.test', byName: 'Ann', via: 'inbox' });
    fake.failing = false;
    await sweep(t0 + 2 * MIN);
    expect(rowsOf(opened.id)[0]!.state).toBe('skipped');
    expect(fake.records).toHaveLength(0);
  });
});

describe('closing a ticket', () => {
  const settle = async (to: 'approved' | 'denied') => {
    const opened = await open();
    const t0 = Date.now();
    await sweep(t0);
    await inbox.claim(opened.id, to, { by: 'dana@acme.test', byName: 'Dana Lee', via: 'inbox', at: new Date(t0).toISOString() });
    await sweep(t0 + 31_000);
    return { opened, t0 };
  };

  it('approving adds the settled line as a work note and sets the mapped state', async () => {
    const { opened } = await settle('approved');
    const patch = fake.records[0]!.patches;
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject({ state: '3' });
    expect(String(patch[0]!.work_notes)).toMatch(/^Approved by Dana Lee in Needs you · /);
    expect(rowsOf(opened.id)[0]!.state).toBe('closed');
    expect(audits('approval.ticket.close')).toHaveLength(1);
    // Closed once.
    await sweep(Date.now() + 5 * MIN);
    expect(fake.records[0]!.patches).toHaveLength(1);
  });

  it('denying adds its line, with no state when none is mapped', async () => {
    await settle('denied');
    expect(fake.records[0]!.patches[0]).toEqual({ work_notes: expect.stringMatching(/^Denied by Dana Lee in Needs you · /) });
  });

  it('an expiry and a cancel add theirs', async () => {
    for (const to of ['expired', 'cancelled'] as const) {
      fake.reset();
      const opened = await open();
      const t0 = Date.now();
      await sweep(t0);
      await inboxPort()!.settle(opened.c.executionId, 'c1', to);
      await sweep(t0 + 31_000);
      const view = inbox.viewOf(inbox.requestRow(opened.id)!);
      expect(fake.records[0]!.patches[0]!.work_notes).toBe(settledLine(view, inbox.serverClock));
      expect(String(fake.records[0]!.patches[0]!.work_notes)).toMatch(to === 'expired' ? /^Expired/ : /^Cancelled with the run/);
    }
  });

  it('a close that keeps failing is tried three times, then failed and audited', async () => {
    const opened = await open();
    const t0 = Date.now();
    await sweep(t0);
    await inbox.claim(opened.id, 'approved', { by: 'a@b.test', byName: 'Ann', via: 'inbox' });
    fake.failing = true;
    await sweep(t0 + MIN);
    expect(rowsOf(opened.id)[0]).toMatchObject({ state: 'closing', attempts: 1 });
    await sweep(t0 + 2 * MIN);
    expect(rowsOf(opened.id)[0]).toMatchObject({ state: 'closing', attempts: 2 });
    await sweep(t0 + 7 * MIN);
    expect(rowsOf(opened.id)[0]!.state).toBe('failed');
    expect(audits('approval.ticket.failed')).toHaveLength(1);
    fake.failing = false;
    await sweep(t0 + 60 * MIN);
    expect(fake.records[0]!.patches).toHaveLength(0);
  });
});

describe('the counter', () => {
  it('counts each outcome with { system, outcome } only', async () => {
    const add = vi.spyOn(hostMetrics().approvalTickets, 'add');
    try {
      fake.failing = true;
      const opened = await open();
      const t0 = Date.now();
      await sweep(t0);
      fake.failing = false;
      await sweep(t0 + MIN);
      await inbox.claim(opened.id, 'approved', { by: 'a@b.test', byName: 'Ann', via: 'inbox' });
      await sweep(t0 + 2 * MIN);
      expect(add.mock.calls).toEqual([
        [1, { system: 'servicenow', outcome: 'open_failed' }],
        [1, { system: 'servicenow', outcome: 'opened' }],
        [1, { system: 'servicenow', outcome: 'closed' }],
      ]);
    } finally {
      add.mockRestore();
    }
  });
});

describe('the record', () => {
  const base = { request_id: 'r1', channel_id: 'c1', rule_id: 'rule', system: 'servicenow', state: 'opening', external_id: null, external_key: null, external_url: null, attempts: 0, next_at: null, last_error: null, opened_at: null, closed_at: null, created_at: new Date().toISOString() };

  it('is created once per (request, channel)', () => {
    expect(database().insertNew('approval_tickets', base)).toBe(true);
    expect(database().insertNew('approval_tickets', { ...base, state: 'open' })).toBe(false);
    expect(rowsOf('r1')).toHaveLength(1);
  });

  it('moves opening to open for one of two callers only', async () => {
    database().insertNew('approval_tickets', { ...base, request_id: 'r2' });
    const first = await tickets.moveTicket('r2', 'c1', { state: 'opening', attempts: 0 }, { state: 'open', external_id: 'A' });
    const second = await tickets.moveTicket('r2', 'c1', { state: 'opening', attempts: 0 }, { state: 'open', external_id: 'B' });
    expect([Boolean(first), Boolean(second)]).toEqual([true, false]);
    expect(rowsOf('r2')[0]!.external_id).toBe('A');
  });
});

describe('what people see', () => {
  it('shows the ticket on the request and on Needs you, and nothing for a request with no ticket channel', async () => {
    const opened = await open();
    await sweep(Date.now());
    const view = access.view(opened.id)!;
    expect(view.tickets).toEqual([{ system: 'servicenow', channel: snow.id, id: 'CHG0000001', url: expect.stringContaining('/nav_to.do?uri=change_request.do?sys_id='), state: 'open' }]);
    const items = await needsYou(undefined);
    expect(items.find((i) => i.requestId === opened.id)?.tickets).toEqual(view.tickets);
    // A rule without a ticket channel leaves the view as it was.
    database().sqlite.exec('DELETE FROM alert_rules');
    alertStore.createRule({ name: 'Plain', enabled: true, workflows: { mode: 'all' }, events: ['approval'], channelIds: [plain.id], throttleMinutes: 0 });
    const other = await open();
    await sweep(Date.now());
    expect('tickets' in access.view(other.id)!).toBe(false);
  });

  it('shows an opening ticket without an id and hides a skipped one', async () => {
    fake.failing = true;
    const opened = await open();
    const t0 = Date.now();
    await sweep(t0);
    expect(access.view(opened.id)!.tickets).toEqual([{ system: 'servicenow', channel: snow.id, state: 'opening' }]);
    await inbox.claim(opened.id, 'denied', { by: 'a@b.test', byName: 'Ann', via: 'inbox' });
    fake.failing = false;
    await sweep(t0 + 2 * MIN);
    expect(access.view(opened.id)!.tickets).toBeUndefined();
  });
});

describe('nobody but a person decides', () => {
  it('no route that reaches a ticket module claims or decides', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(process.cwd(), 'src/app/api'));
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /approval-inbox\/tickets|alerts\/tickets/.test(text) && /\b(claim|decideApproval|decideRequest)\b/.test(text);
    });
    expect(offenders).toEqual([]);
    // And the ticket modules themselves never call the decision doors.
    for (const module of ['src/lib/server/approval-inbox/tickets.ts', 'src/lib/server/alerts/tickets.ts']) {
      expect(readFileSync(join(process.cwd(), module), 'utf8')).not.toMatch(/\b(claim|decideApproval|decideRequest)\(/);
    }
  });
});
