/**
 * Failure alerts: what a run counts as (failed, timed out, retries exhausted, waiting too long) and which rules watch
 * it, each channel against a fake receiver (a Slack incoming webhook, a signed webhook, Telegram's Bot API, email
 * through a swapped mail transport), channel secrets sealed at rest and masked by the API, throttling with digests,
 * the runner's hook (a failed run, an automatic retry), the routes and a workflow's "Notify on failure" shortcut.
 * Email through a real SMTP server (Mailpit) is in alerts-smtp.test.ts (LANDFLOW_INTEGRATION=smtp).
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AlertChannel, AlertRule, AlertsView, WorkflowAlertView } from '@/lib/shared/alerts';
import type { ExecutionRecord } from '@/lib/shared/types';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-alerts-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
delete process.env.LANDFLOW_SMTP_HOST;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { waits } = await import('@/lib/server/waits');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const rules = await import('@/lib/server/alerts/rules');
const message = await import('@/lib/server/alerts/message');
const { signature } = await import('@/lib/server/alerts/channels');
const alertsRoute = await import('@/app/api/settings/alerts/route');
const channelsRoute = await import('@/app/api/settings/alerts/channels/route');
const channelRoute = await import('@/app/api/settings/alerts/channels/[id]/route');
const testRoute = await import('@/app/api/settings/alerts/channels/[id]/test/route');
const rulesRoute = await import('@/app/api/settings/alerts/rules/route');
const ruleRoute = await import('@/app/api/settings/alerts/rules/[id]/route');
const workflowAlertRoute = await import('@/app/api/workflows/[id]/alert/route');
const { defineCredentialType, defineNode, definePlugin } = await import('@landflow/sdk');

// Stands in for the messaging plugin: its Telegram API credential type is all alerts need.
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'messaging', name: 'Messaging (test)', version: '1.0.0', language: 'typescript' },
    credentialTypes: [
      defineCredentialType({
        name: 'telegramApi',
        displayName: 'Telegram API',
        properties: [
          { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://api.telegram.org' },
        ],
      }),
    ],
    nodes: [
      defineNode({
        description: { name: 'telegram', displayName: 'Telegram', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], credentials: [{ name: 'telegramApi', required: true }], properties: [] },
        async execute() {
          return [[]];
        },
      }),
    ],
  }),
);

// ---------------------------------------------------------------------------
// A fake receiver for Slack, webhooks and Telegram
// ---------------------------------------------------------------------------

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
}

const received: Received[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const json = (() => {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    received.push({ path: req.url ?? '', headers: req.headers, body, json });
    if (req.url === '/slack') return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (req.url === '/slack-gone') return res.writeHead(404, { 'content-type': 'text/plain' }).end('no_service');
    if (req.url === '/hook') return res.writeHead(204).end();
    if (req.url?.startsWith('/bot')) {
      if (json.chat_id === 'missing') return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }));
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    res.writeHead(500).end('unexpected');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const fakeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const mails: { to: string; subject: string; text: string; html?: string; from: string }[] = [];
setMailTransport({ send: async (mail) => void mails.push(mail) });

afterAll(async () => {
  alerts.stop();
  waits.stop();
  setMailTransport(undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const request = (body?: unknown, method = 'POST') => new Request('http://landflow.test/api', { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

async function until(check: () => boolean, what: string, timeoutMs = 4_000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let seq = 0;
function failedRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  seq++;
  const now = new Date().toISOString();
  return {
    executionId: `exec_${seq}`,
    workflowId: 'wf_orders',
    workflowName: 'Orders sync',
    mode: 'trigger',
    status: 'error',
    startedAt: now,
    finishedAt: now,
    durationMs: 12,
    runData: {},
    executionOrder: ['Fetch'],
    error: { message: 'Request failed with status code 502', nodeId: 'Fetch', nodeName: 'Fetch orders' },
    lastNodeId: 'Fetch',
    nodeNames: { Fetch: 'Fetch orders' },
    ...overrides,
  };
}

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return { id: 'r1', name: 'Prod', enabled: true, workflows: { mode: 'all' }, events: ['failed'], channelIds: ['c1'], throttleMinutes: 0, createdAt: '', updatedAt: '', ...overrides };
}

function resetAlerts() {
  const db = database();
  for (const table of ['alert_throttle', 'alert_waiting_sent', 'alert_rules', 'alert_channels'] as const) db.sqlite.exec(`DELETE FROM ${table}`);
  received.length = 0;
  mails.length = 0;
}

const hookChannel = () => alertStore.createChannel({ name: 'Incidents', kind: 'webhook', config: { url: `${fakeUrl}/hook`, secret: 'shh-signing-secret' } });

// ---------------------------------------------------------------------------

describe('which runs alert', () => {
  it('counts a run that failed for good, a timeout and exhausted retries', () => {
    expect(rules.eventsOf(failedRecord())).toEqual(['failed']);
    expect(rules.eventsOf(failedRecord({ status: 'success' }))).toEqual([]);
    expect(rules.eventsOf(failedRecord({ status: 'canceled' }))).toEqual([]);
    // An automatic retry is still to come: nothing yet.
    expect(rules.eventsOf(failedRecord({ retryAt: new Date().toISOString() }))).toEqual([]);
    expect(rules.eventsOf(failedRecord({ error: { message: 'Workflow timed out after 30 s' } }))).toEqual(['failed', 'timedOut']);
    expect(rules.eventsOf(failedRecord({ error: { message: 'Node timed out after 5 s', nodeName: 'Slow' } }))).toEqual(['failed', 'timedOut']);
    expect(rules.eventsOf(failedRecord({ retryOf: 'exec_0', retryAttempt: 2 }))).toEqual(['failed', 'retriesExhausted']);
    expect(rules.headlineEvent(['failed', 'retriesExhausted'])).toBe('retriesExhausted');
    expect(rules.headlineEvent(['failed', 'timedOut', 'retriesExhausted'])).toBe('timedOut');
  });

  it('watches production top-level runs of the workflows in scope', () => {
    const record = failedRecord();
    expect(rules.watches(rule(), record)).toBe(true);
    expect(rules.watches(rule({ enabled: false }), record)).toBe(false);
    expect(rules.watches(rule({ channelIds: [] }), record)).toBe(false);
    expect(rules.watches(rule(), failedRecord({ mode: 'manual' }))).toBe(false);
    expect(rules.watches(rule(), failedRecord({ mode: 'chat' }))).toBe(false);
    expect(rules.watches(rule({ includeManual: true }), failedRecord({ mode: 'manual' }))).toBe(true);
    expect(rules.watches(rule(), failedRecord({ debug: true }))).toBe(false);
    expect(rules.watches(rule(), failedRecord({ parentExecutionId: 'exec_parent' }))).toBe(false);
    expect(rules.watches(rule({ workflows: { mode: 'ids', ids: ['wf_other'] } }), record)).toBe(false);
    expect(rules.watches(rule({ workflows: { mode: 'ids', ids: ['wf_orders'] } }), record)).toBe(true);
    expect(rules.watches(rule({ workflows: { mode: 'tags', tags: ['Production'] } }), record, { tags: ['billing', 'production'] })).toBe(true);
    expect(rules.watches(rule({ workflows: { mode: 'tags', tags: ['production'] } }), record, { tags: ['staging'] })).toBe(false);
    expect(rules.matchingEvents(rule({ events: ['timedOut'] }), ['failed'])).toEqual([]);
    expect(rules.matchingEvents(rule({ events: ['timedOut', 'failed'] }), ['failed', 'timedOut'])).toEqual(['failed', 'timedOut']);
  });

  it('flags runs waiting too long, but not a Wait timer that is not due', () => {
    const now = Date.now();
    const waiting = (wait: Partial<NonNullable<ExecutionRecord['wait']>>) =>
      failedRecord({ status: 'waiting', error: undefined, wait: { nodeId: 'Approve', nodeName: 'Approve', resume: 'form', since: new Date(now - 90 * 60_000).toISOString(), ...wait } });
    const r = rule({ events: ['waiting'], waitingMinutes: 60 });
    expect(rules.waitedTooLong(r, waiting({}), now)).toBe(true);
    expect(rules.waitedTooLong(rule({ events: ['waiting'], waitingMinutes: 120 }), waiting({}), now)).toBe(false);
    expect(rules.waitedTooLong(rule({ events: ['failed'] }), waiting({}), now)).toBe(false);
    expect(rules.waitedTooLong(r, waiting({ resume: 'time', until: new Date(now + 60_000).toISOString() }), now)).toBe(false);
    expect(rules.waitedTooLong(r, waiting({ resume: 'time', until: new Date(now - 60_000).toISOString() }), now)).toBe(true);
    expect(rules.waitedTooLong(r, failedRecord(), now)).toBe(false);
  });
});

describe('the message', () => {
  it('names the workflow, the failing node and the error, and links to the execution', () => {
    const notice = message.noticeFor({ id: 'r1', name: 'Prod' }, 'failed', failedRecord({ executionId: 'exec_msg' }));
    expect(message.subjectOf(notice)).toBe('Failed: Orders sync');
    const text = message.textOf(notice);
    expect(text).toContain('Failed node: Fetch orders');
    expect(text).toContain('Error: Request failed with status code 502');
    expect(text).toContain('Execution: http://landflow.test/workflows/wf_orders/executions/exec_msg');
    expect(message.htmlOf(notice)).toContain('href="http://landflow.test/workflows/wf_orders/executions/exec_msg"');
    expect(message.subjectOf(message.noticeFor({ id: 'r1', name: 'Prod' }, 'retriesExhausted', failedRecord({ retryOf: 'x', retryAttempt: 3 })))).toBe('Failed after 3 retries: Orders sync');
    expect(message.subjectOf(message.noticeFor({ id: 'r1', name: 'Prod' }, 'timedOut', failedRecord()))).toBe('Timed out: Orders sync');
    // HTML in an error is escaped.
    const html = message.htmlOf(message.noticeFor({ id: 'r1', name: 'Prod' }, 'failed', failedRecord({ error: { message: '<script>alert(1)</script>' } })));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('clips long errors and formats durations', () => {
    const notice = message.noticeFor({ id: 'r1', name: 'Prod' }, 'failed', failedRecord({ error: { message: 'x'.repeat(5_000) } }));
    expect(notice.execution!.error!.length).toBe(1_000);
    expect(message.durationText(45 * 60_000)).toBe('45 min');
    expect(message.durationText(125 * 60_000)).toBe('2 h 5 min');
    expect(message.durationText(3 * 86_400_000)).toBe('3 days');
  });
});

describe('channels', () => {
  beforeEach(resetAlerts);

  it('keeps channel secrets sealed at rest and out of the API', async () => {
    const created = (await (await channelsRoute.POST(request({ name: '#alerts', kind: 'slack', config: { webhookUrl: `${fakeUrl}/slack` } }))).json()) as { channel: AlertChannel };
    expect(created.channel).toMatchObject({ name: '#alerts', kind: 'slack', secretsSet: ['webhookUrl'] });
    expect(created.channel.config.webhookUrl).toBeUndefined();
    const raw = database().get<{ data: string }>('SELECT data FROM alert_channels WHERE id = ?', created.channel.id)!.data;
    expect(raw).not.toContain('/slack');
    expect(raw).toMatch(/"webhookUrl":"v1\./);
    const listed = JSON.stringify(await (await alertsRoute.GET(request(undefined, 'GET'))).json());
    expect(listed).not.toContain(fakeUrl);

    // An empty secret keeps the saved one; a new one replaces it.
    await channelRoute.PATCH(request({ name: '#alerts-2', config: { webhookUrl: '' } }, 'PATCH'), params({ id: created.channel.id }));
    expect(alertStore.channelForSending(created.channel.id)!.config.webhookUrl).toBe(`${fakeUrl}/slack`);
    expect(alertStore.channel(created.channel.id)!.name).toBe('#alerts-2');
    await channelRoute.PATCH(request({ config: { webhookUrl: `${fakeUrl}/slack-gone` } }, 'PATCH'), params({ id: created.channel.id }));
    expect(alertStore.channelForSending(created.channel.id)!.config.webhookUrl).toBe(`${fakeUrl}/slack-gone`);
  });

  it('checks each kind’s settings', async () => {
    const bad = async (body: unknown) => {
      const response = await channelsRoute.POST(request(body));
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };
    expect(await bad({ name: 'Ops', kind: 'email', config: { to: 'not-an-address' } })).toContain('not an email address');
    expect(await bad({ name: 'Ops', kind: 'email', config: {} })).toContain('at least one email address');
    expect(await bad({ name: 'Slack', kind: 'slack', config: {} })).toContain('Slack incoming webhook URL');
    expect(await bad({ name: 'Hook', kind: 'webhook', config: { url: 'ftp://example.com' } })).toContain('http(s)');
    expect(await bad({ name: 'TG', kind: 'telegram', config: { chatId: '1' } })).toContain('Telegram API credential');
    const ok = alertStore.createChannel({ name: 'Ops', kind: 'email', config: { to: 'ops@example.com; Jane <jane@example.com>', url: 'dropped' } });
    expect(ok.config).toEqual({ to: 'ops@example.com, Jane <jane@example.com>' });
  });

  it('posts to a Slack incoming webhook and reports a refusal', async () => {
    const slack = alertStore.createChannel({ name: '#alerts', kind: 'slack', config: { webhookUrl: `${fakeUrl}/slack` } });
    const response = await testRoute.POST(request(), params({ id: slack.id }));
    const { delivery } = (await response.json()) as { delivery: { ok: boolean; message: string } };
    expect(delivery).toMatchObject({ ok: true, message: 'Slack answered ok' });
    const body = received.at(-1)!.json as { text: string; blocks: { type: string }[] };
    expect(body.text).toBe('Test alert from Landflow');
    expect(body.blocks.map((b) => b.type)).toEqual(['header', 'section', 'section', 'section', 'context']);

    alertStore.updateChannel(slack.id, { config: { webhookUrl: `${fakeUrl}/slack-gone` } });
    const failed = await alerts.test(slack.id);
    expect(failed).toMatchObject({ ok: false, message: 'Slack answered HTTP 404: no_service' });
    expect(alertStore.channel(slack.id)!.lastDelivery).toMatchObject({ ok: false, message: 'Slack answered HTTP 404: no_service' });
  });

  it('signs webhook bodies with HMAC-SHA256', async () => {
    const hook = hookChannel();
    expect(await alerts.test(hook.id)).toMatchObject({ ok: true, message: 'HTTP 204' });
    const call = received.at(-1)!;
    expect(call.headers['x-landflow-event']).toBe('alert.test');
    const timestamp = String(call.headers['x-landflow-timestamp']);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(5);
    const expected = `sha256=${createHmac('sha256', 'shh-signing-secret').update(`${timestamp}.${call.body}`).digest('hex')}`;
    expect(call.headers['x-landflow-signature']).toBe(expected);
    expect(signature('shh-signing-secret', timestamp, call.body)).toBe(expected);
    expect(call.json).toMatchObject({ type: 'alert.test', event: 'failed', summary: 'Test alert from Landflow', test: true });
    // Unreachable: the reason, not a stack.
    const dead = alertStore.createChannel({ name: 'Dead', kind: 'webhook', config: { url: 'http://127.0.0.1:9/hook' } });
    expect((await alerts.test(dead.id)).message).toMatch(/^The webhook could not be reached: /);
  });

  it('sends through a saved Telegram credential', async () => {
    const bot = credentials.create({ name: 'Alerts bot', type: 'messaging.telegramApi', data: { accessToken: '123:secret-bot-token', baseUrl: fakeUrl } });
    const telegram = alertStore.createChannel({ name: 'On call', kind: 'telegram', config: { credentialId: bot.id, chatId: '-100200' } });
    expect(await alerts.test(telegram.id)).toMatchObject({ ok: true });
    const call = received.at(-1)!;
    expect(call.path).toBe('/bot123:secret-bot-token/sendMessage');
    expect(call.json).toMatchObject({ chat_id: '-100200', parse_mode: 'HTML' });
    expect(String(call.json.text)).toContain('<b>Test alert from Landflow</b>');

    alertStore.updateChannel(telegram.id, { config: { credentialId: bot.id, chatId: 'missing' } });
    const failed = await alerts.test(telegram.id);
    expect(failed).toMatchObject({ ok: false, message: 'Telegram answered HTTP 400: Bad Request: chat not found' });
    expect(failed.message).not.toContain('secret-bot-token');
  });

  it('emails each address, and says so when email is not set up', async () => {
    const email = alertStore.createChannel({ name: 'Ops', kind: 'email', config: { to: 'ops@example.com, oncall@example.com' } });
    expect(await alerts.test(email.id)).toMatchObject({ ok: true, message: 'Sent to ops@example.com, oncall@example.com' });
    expect(mails.map((m) => m.to)).toEqual(['ops@example.com', 'oncall@example.com']);
    expect(mails[0]).toMatchObject({ subject: 'Test alert from Landflow' });
    expect(mails[0].html).toContain('LANDFLOW ALERT');

    setMailTransport(undefined);
    try {
      expect(await alerts.test(email.id)).toMatchObject({ ok: false, message: 'Email is not configured (LANDFLOW_SMTP_HOST)' });
      expect(((await (await alertsRoute.GET(request(undefined, 'GET'))).json()) as AlertsView).email.configured).toBe(false);
    } finally {
      setMailTransport({ send: async (mail) => void mails.push(mail) });
    }
  });

  it('takes a deleted channel out of its rules', async () => {
    const hook = hookChannel();
    const other = alertStore.createChannel({ name: 'Ops', kind: 'email', config: { to: 'ops@example.com' } });
    const created = alertStore.createRule({ name: 'All', enabled: true, workflows: { mode: 'all' }, events: ['failed'], channelIds: [hook.id, other.id], throttleMinutes: 0 });
    expect((await channelRoute.DELETE(request(undefined, 'DELETE'), params({ id: hook.id }))).status).toBe(200);
    expect(alertStore.rule(created.id)!.channelIds).toEqual([other.id]);
    expect((await channelRoute.DELETE(request(undefined, 'DELETE'), params({ id: hook.id }))).status).toBe(404);
  });
});

describe('rules, throttling and digests', () => {
  beforeEach(resetAlerts);

  it('creates, changes and deletes rules through the routes', async () => {
    const hook = hookChannel();
    const created = await rulesRoute.POST(request({ name: 'Prod failures', workflows: { mode: 'tags', tags: ['production'] }, events: ['failed', 'waiting'], waitingMinutes: 30, channelIds: [hook.id] }));
    expect(created.status).toBe(201);
    const { rule: saved } = (await created.json()) as { rule: AlertRule };
    expect(saved).toMatchObject({ name: 'Prod failures', enabled: true, throttleMinutes: 10, waitingMinutes: 30 });
    const patched = (await (await ruleRoute.PATCH(request({ enabled: false }, 'PATCH'), params({ id: saved.id }))).json()) as { rule: AlertRule };
    expect(patched.rule).toMatchObject({ enabled: false, name: 'Prod failures', events: ['failed', 'waiting'] });
    expect((await rulesRoute.POST(request({ name: 'X', workflows: { mode: 'all' }, events: ['failed'], channelIds: ['ach_nope'] }))).status).toBe(400);
    expect((await rulesRoute.POST(request({ name: 'X', workflows: { mode: 'all' }, events: [], channelIds: [hook.id] }))).status).toBe(400);
    expect((await ruleRoute.DELETE(request(undefined, 'DELETE'), params({ id: saved.id }))).status).toBe(200);
    expect(alertStore.rules()).toEqual([]);
  });

  it('sends one alert per window and the rest as a digest', async () => {
    const hook = hookChannel();
    alertStore.createRule({ name: 'Prod', enabled: true, workflows: { mode: 'all' }, events: ['failed'], channelIds: [hook.id], throttleMinutes: 10 });
    const t0 = Date.parse('2026-10-25T10:00:00Z');
    await alerts.finished(failedRecord({ executionId: 'exec_a' }), undefined, t0);
    expect(received).toHaveLength(1);
    expect(received[0].json).toMatchObject({ type: 'alert', event: 'failed', summary: 'Failed: Orders sync', execution: { id: 'exec_a', node: 'Fetch orders' } });

    await alerts.finished(failedRecord({ executionId: 'exec_b' }), undefined, t0 + 60_000);
    await alerts.finished(failedRecord({ executionId: 'exec_c', error: { message: 'Still 502' } }), undefined, t0 + 120_000);
    // Another workflow has its own window.
    await alerts.finished(failedRecord({ executionId: 'exec_x', workflowId: 'wf_billing', workflowName: 'Billing' }), undefined, t0 + 130_000);
    expect(received.map((r) => (r.json.execution as { id: string }).id)).toEqual(['exec_a', 'exec_x']);

    await alerts.tick(t0 + 5 * 60_000);
    expect(received).toHaveLength(2);
    await alerts.tick(t0 + 10 * 60_000 + 1_000);
    expect(received).toHaveLength(3);
    expect(received[2].json).toMatchObject({
      type: 'alert.digest',
      summary: 'Orders sync: 2 more failures in the last 10 min',
      digest: { count: 2, lastError: 'Still 502', lastExecutionUrl: 'http://landflow.test/workflows/wf_orders/executions/exec_c' },
      executionsUrl: 'http://landflow.test/workflows/wf_orders/executions',
    });
    expect(received[2].headers['x-landflow-event']).toBe('alert.digest');

    // The digest opened a new window: a failure in it is held back too...
    await alerts.finished(failedRecord({ executionId: 'exec_d' }), undefined, t0 + 12 * 60_000);
    expect(received).toHaveLength(3);
    await alerts.tick(t0 + 21 * 60_000);
    expect(received.at(-1)!.json).toMatchObject({ type: 'alert.digest', digest: { count: 1 } });
    // ...and a quiet window ends without a message; the next failure goes out at once.
    await alerts.tick(t0 + 32 * 60_000);
    expect(received).toHaveLength(4);
    expect(alertStore.throttle(alertStore.rules()[0].id, 'wf_orders')).toBeUndefined();
    await alerts.finished(failedRecord({ executionId: 'exec_e' }), undefined, t0 + 33 * 60_000);
    expect(received.at(-1)!.json).toMatchObject({ type: 'alert', execution: { id: 'exec_e' } });
  });

  it('sends a channel one message per run when several rules match', async () => {
    const hook = hookChannel();
    alertStore.createRule({ name: 'All', enabled: true, workflows: { mode: 'all' }, events: ['failed'], channelIds: [hook.id], throttleMinutes: 0 });
    alertStore.createRule({ name: 'Orders', enabled: true, workflows: { mode: 'ids', ids: ['wf_orders'] }, events: ['failed'], channelIds: [hook.id], throttleMinutes: 0 });
    await alerts.finished(failedRecord());
    expect(received).toHaveLength(1);
  });

  it('leads with the most specific event the rule asked for', async () => {
    const hook = hookChannel();
    alertStore.createRule({ name: 'Timeouts', enabled: true, workflows: { mode: 'all' }, events: ['timedOut'], channelIds: [hook.id], throttleMinutes: 0 });
    await alerts.finished(failedRecord());
    expect(received).toHaveLength(0);
    await alerts.finished(failedRecord({ error: { message: 'Workflow timed out after 30 s' } }));
    expect(received[0].json).toMatchObject({ event: 'timedOut', summary: 'Timed out: Orders sync' });
  });

  it('alerts once on a run waiting too long', async () => {
    const hook = hookChannel();
    alertStore.createRule({ name: 'Stuck', enabled: true, workflows: { mode: 'all' }, events: ['waiting'], waitingMinutes: 60, channelIds: [hook.id], throttleMinutes: 0 });
    const since = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const waiting = failedRecord({ executionId: 'exec_wait', status: 'waiting', error: undefined, wait: { nodeId: 'Approve', nodeName: 'Approve refund', resume: 'form', since } });
    const timer = failedRecord({ executionId: 'exec_timer', status: 'waiting', error: undefined, wait: { nodeId: 'Wait', nodeName: 'Wait', resume: 'time', until: new Date(Date.now() + 3_600_000).toISOString(), since } });
    store.saveExecution(waiting);
    store.saveExecution(timer);
    try {
      await alerts.tick();
      expect(received).toHaveLength(1);
      expect(received[0].json).toMatchObject({ event: 'waiting', summary: 'Waiting for 2 h: Orders sync', execution: { id: 'exec_wait', node: 'Approve refund', waitingFor: 'form' } });
      await alerts.tick();
      expect(received).toHaveLength(1);
      // Once it stops waiting, the marker goes.
      store.saveExecution({ ...waiting, status: 'success', wait: undefined });
      await alerts.tick();
      expect(database().all('SELECT * FROM alert_waiting_sent')).toEqual([]);
    } finally {
      store.deleteExecution(waiting.executionId);
      store.deleteExecution(timer.executionId);
    }
  });
});

describe('the runner and the workflow shortcut', () => {
  beforeEach(resetAlerts);

  function failingWorkflow(id: string, settings: Workflow['settings'] = {}): Workflow {
    return store.saveWorkflow({
      id,
      name: `Failing ${id}`,
      settings,
      nodes: [
        { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'Boom', name: 'Boom', type: 'core.stopAndError', typeVersion: 1, position: [200, 0], parameters: { message: 'Inventory API said no' } },
      ],
      connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'Boom', sourceIndex: 0, targetIndex: 0 }],
    } as Workflow);
  }

  it('alerts on a failed production run, not on an editor run', async () => {
    const workflow = failingWorkflow('wf_alert_run');
    const hook = hookChannel();
    const shortcut = (await (await workflowAlertRoute.PUT(request({ channelIds: [hook.id] }, 'PUT'), params({ id: workflow.id }))).json()) as WorkflowAlertView;
    expect(shortcut.rule).toMatchObject({ name: 'Notify on failure: Failing wf_alert_run', shortcutFor: workflow.id, workflows: { mode: 'ids', ids: [workflow.id] }, throttleMinutes: 10 });
    expect(shortcut.channels).toEqual([{ id: hook.id, name: 'Incidents', kind: 'webhook' }]);

    await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    const record = await runWorkflow({ workflow, mode: 'trigger', startNodeId: 'Start' });
    expect(record.status).toBe('error');
    await until(() => received.length > 0, 'the alert');
    expect(received).toHaveLength(1);
    expect(received[0].json).toMatchObject({
      event: 'failed',
      workflow: { id: workflow.id, name: workflow.name },
      execution: { id: record.executionId, node: 'Boom', error: 'Inventory API said no', mode: 'trigger', url: `http://landflow.test/workflows/${workflow.id}/executions/${record.executionId}` },
    });

    // Turning it off removes the rule.
    const off = (await (await workflowAlertRoute.DELETE(request(undefined, 'DELETE'), params({ id: workflow.id }))).json()) as WorkflowAlertView;
    expect(off.rule).toBeUndefined();
    expect(alertStore.rules()).toEqual([]);
  });

  it('waits for the last automatic retry, then says retries are exhausted', async () => {
    const workflow = failingWorkflow('wf_alert_retry', { retryMaxAttempts: 2, retryBaseDelaySeconds: 0 });
    const hook = hookChannel();
    alertStore.createRule({ name: 'Retries', enabled: true, workflows: { mode: 'ids', ids: [workflow.id] }, events: ['failed', 'retriesExhausted'], channelIds: [hook.id], throttleMinutes: 0 });
    const first = await runWorkflow({ workflow, mode: 'trigger', startNodeId: 'Start' });
    expect(first.retryAt).toBeTruthy();
    await until(() => received.length > 0, 'the alert after the retry');
    expect(received).toHaveLength(1);
    expect(received[0].json).toMatchObject({ event: 'retriesExhausted', summary: `Failed after 1 retry: ${workflow.name}` });
    const retried = store.getExecution((received[0].json.execution as { id: string }).id)!;
    expect(retried.retryOf).toBe(first.executionId);
    expect((received[0].json.execution as { retryAttempt?: number }).retryAttempt).toBe(1);
  });

  it('answers 404 for an unknown workflow and lists channels for the shortcut', async () => {
    expect((await workflowAlertRoute.GET(request(undefined, 'GET'), params({ id: 'wf_missing' }))).status).toBe(404);
    const workflow = failingWorkflow('wf_alert_view');
    expect(await (await workflowAlertRoute.GET(request(undefined, 'GET'), params({ id: workflow.id }))).json()).toEqual({ channels: [] });
    expect((await workflowAlertRoute.PUT(request({ channelIds: [] }, 'PUT'), params({ id: workflow.id }))).status).toBe(400);
  });
});
