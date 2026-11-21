/**
 * Ticket channels (C12 / P12a): the ServiceNow alert channel and the webhook channel's "Opens tickets" option.
 * Settings (what a channel keeps and refuses), opening and closing a ticket against a local fake of ServiceNow's Table
 * API and a signed webhook fake, the channel Test, and the settings fields. A ticket never carries a parameter value.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertChannel } from '@/lib/shared/alerts';
import { opensTickets } from '@/lib/shared/alerts';
import { startFakeServiceNow } from './fake-servicenow';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-tickets-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const { signature, sendThrough } = await import('@/lib/server/alerts/channels');
const { openTicket, closeTicket, testTicketChannel } = await import('@/lib/server/alerts/tickets');
const { testNotice } = await import('@/lib/server/alerts/message');
const channelsRoute = await import('@/app/api/settings/alerts/channels/route');
const { AlertTicketFields } = await import('@/components/settings/alert-ticket-fields');

registry.registerBuiltin(corePlugin);

const fake = await startFakeServiceNow();

// A webhook receiver whose answer each test sets.
interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
}
const hooks: Received[] = [];
let hookAnswer: { status: number; body?: unknown } = { status: 200, body: { ticket: { id: 'T-1', url: 'https://t.example/T-1' } } };
let hookDelayMs = 0;
const hook = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    hooks.push({ path: req.url ?? '', headers: req.headers, body, json: JSON.parse(body || '{}') as Record<string, unknown> });
    setTimeout(() => res.writeHead(hookAnswer.status, { 'content-type': 'application/json' }).end(hookAnswer.body === undefined ? '' : JSON.stringify(hookAnswer.body)), hookDelayMs);
  });
});
await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/tickets`;

afterAll(async () => {
  alerts.stop();
  await fake.close();
  await new Promise<void>((resolve) => hook.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const basic = credentials.create({ name: 'ServiceNow basic', type: 'core.httpBasicAuth', data: { user: 'landflow', password: 'dev-password' } });
const bearer = credentials.create({ name: 'ServiceNow bearer', type: 'core.httpBearerAuth', data: { token: 'dev-bearer-token' } });
const wrongType = credentials.create({ name: 'Not a ticket login', type: 'core.openAiApi', data: { apiKey: 'sk-dev' } });

beforeEach(() => {
  fake.reset();
  hooks.length = 0;
  hookAnswer = { status: 200, body: { ticket: { id: 'T-1', url: 'https://t.example/T-1' } } };
  hookDelayMs = 0;
  database().sqlite.exec('DELETE FROM alert_channels');
});

const request = (body: unknown) => new Request('http://landflow.test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const create = (body: unknown) => channelsRoute.POST(request(body));

const ticketRequest = {
  requestId: 'req_123',
  kind: 'tool' as const,
  subject: 'Approval needed: Send invoice (Billing agent)',
  facts: [
    { label: 'Workflow', value: 'Invoices' },
    { label: 'Expires', value: '2026-11-22 14:00' },
  ],
  link: 'http://landflow.test/?needsYou=req_123',
  expiresAt: '2026-11-22T14:00:00.000Z',
};
const close = { requestId: 'req_123', status: 'approved' as const, line: 'Approved by Dana Lee in Needs you · 14:05' };

const serviceNow = (config: Record<string, unknown> = {}, credentialId = basic.id): AlertChannel =>
  alertStore.createChannel({ name: 'Change board', kind: 'servicenow', config: { url: fake.url, credentialId, table: 'change_request', ...config } });
const webhook = (config: Record<string, unknown> = {}) => alertStore.createChannel({ name: 'Tickets', kind: 'webhook', config: { url: hookUrl, secret: 'sign-me', tickets: true, ...config } });
const sendable = (channel: AlertChannel) => alertStore.channelForSending(channel.id)!;

// ---------------------------------------------------------------------------

describe('ticket channel settings', () => {
  it('refuses a ServiceNow channel that is incomplete, with the words', async () => {
    const refused = async (config: Record<string, unknown>) => {
      const response = await create({ name: 'SN', kind: 'servicenow', config });
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };
    expect(await refused({ credentialId: basic.id })).toMatch(/instance URL/i);
    expect(await refused({ url: fake.url })).toMatch(/Basic Auth or Bearer Auth credential/);
    expect(await refused({ url: fake.url, credentialId: wrongType.id })).toMatch(/Basic Auth or Bearer Auth/);
    expect(await refused({ url: fake.url, credentialId: 'cred_missing' })).toMatch(/credential/i);
    expect(await refused({ url: fake.url, credentialId: basic.id, table: 'Change Request' })).toMatch(/table name/i);
    expect(await refused({ url: 'ftp://x', credentialId: basic.id })).toMatch(/http\(s\)/);
    expect(await refused({ url: fake.url, credentialId: basic.id, approvedState: 'a b; drop' })).toMatch(/state/i);
  });

  it('keeps the settings of a valid ServiceNow channel and drops unknown ones', async () => {
    const response = await create({ name: 'SN', kind: 'servicenow', config: { url: `${fake.url}/`, credentialId: bearer.id, table: 'incident', approvedState: '3', deniedState: '4', secret: 'x', chatId: '1' } });
    expect(response.status).toBe(201);
    const { channel } = (await response.json()) as { channel: AlertChannel };
    expect(channel.kind).toBe('servicenow');
    expect(channel.config).toEqual({ url: fake.url, credentialId: bearer.id, table: 'incident', approvedState: '3', deniedState: '4' });
    expect(opensTickets(channel)).toBe(true);
  });

  it('defaults the table to change_request', () => {
    expect(serviceNow({ table: undefined }).config.table).toBe('change_request');
  });

  it('keeps "Opens tickets" on a webhook channel; an old one reads it as undefined', async () => {
    const ticking = webhook();
    expect(ticking.config.tickets).toBe(true);
    expect(opensTickets(ticking)).toBe(true);
    const old = alertStore.createChannel({ name: 'Plain', kind: 'webhook', config: { url: hookUrl } });
    expect(old.config.tickets).toBeUndefined();
    expect(opensTickets(old)).toBe(false);
    const edited = alertStore.updateChannel(ticking.id, { config: { url: hookUrl, tickets: false } });
    expect(edited.config.tickets).toBeUndefined();
    const route = await create({ name: 'Hook', kind: 'webhook', config: { url: hookUrl, tickets: true } });
    expect(((await route.json()) as { channel: AlertChannel }).channel.config.tickets).toBe(true);
  });

  it('opensTickets is true for ServiceNow and the ticked webhook only', () => {
    expect(opensTickets({ kind: 'servicenow', config: {} })).toBe(true);
    expect(opensTickets({ kind: 'webhook', config: { tickets: true } })).toBe(true);
    expect(opensTickets({ kind: 'webhook', config: {} })).toBe(false);
    expect(opensTickets({ kind: 'slack', config: { tickets: true } as never })).toBe(false);
  });
});

describe('ServiceNow tickets', () => {
  it('opens a record with Basic auth, the facts and the Needs you link, and no parameter value', async () => {
    const channel = sendable(serviceNow());
    // AS-1: a parameter value that reached the request object by mistake must not reach the ticket.
    const poisoned = { ...ticketRequest, params: { token: 'sk-live-should-never-appear' } };
    const ref = await openTicket(channel, poisoned);
    expect(ref).toEqual({ system: 'servicenow', id: 'CHG0000001', key: fake.records[0]!.sys_id, url: `${fake.url}/nav_to.do?uri=change_request.do?sys_id=${fake.records[0]!.sys_id}` });
    const call = fake.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/api/now/table/change_request');
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('landflow:dev-password').toString('base64')}`);
    expect(call.json.short_description).toBe(ticketRequest.subject);
    expect(call.json.correlation_id).toBe('req_123');
    expect(call.json.correlation_display).toBe('Landflow');
    expect(String(call.json.description)).toContain('Workflow: Invoices');
    expect(String(call.json.description)).toContain(ticketRequest.link);
    expect(Object.keys(call.json).sort()).toEqual(['correlation_display', 'correlation_id', 'description', 'short_description']);
    expect(call.body).not.toContain('sk-live-should-never-appear');
  });

  it('sends a bearer credential as the header', async () => {
    await openTicket(sendable(serviceNow({}, bearer.id)), ticketRequest);
    expect(fake.calls[0]!.headers.authorization).toBe('Bearer dev-bearer-token');
    expect(fake.records).toHaveLength(1);
  });

  it('closes with a work note; with a mapped state it also sets the state', async () => {
    const plain = sendable(serviceNow());
    const ref = await openTicket(plain, ticketRequest);
    await closeTicket(plain, ref, close);
    const patch = fake.calls.at(-1)!;
    expect(patch.method).toBe('PATCH');
    expect(patch.path).toBe(`/api/now/table/change_request/${ref.key}`);
    expect(patch.json).toEqual({ work_notes: close.line });

    fake.reset();
    const mapped = sendable(serviceNow({ approvedState: '3', deniedState: '4' }));
    const second = await openTicket(mapped, ticketRequest);
    await closeTicket(mapped, second, close);
    expect(fake.calls.at(-1)!.json).toEqual({ work_notes: close.line, state: '3' });
    await closeTicket(mapped, second, { ...close, status: 'denied', line: 'Denied by Dana Lee in Needs you · 14:06' });
    expect(fake.calls.at(-1)!.json).toEqual({ work_notes: 'Denied by Dana Lee in Needs you · 14:06', state: '4' });
    await closeTicket(mapped, second, { ...close, status: 'expired', line: 'Expired' });
    expect(fake.calls.at(-1)!.json).toEqual({ work_notes: 'Expired' });
  });

  it('says why when the instance refuses or is down, without the credential', async () => {
    const channel = sendable(serviceNow());
    fake.failing = true;
    await expect(openTicket(channel, ticketRequest)).rejects.toThrow(/ServiceNow answered HTTP 500/);
    fake.failing = false;
    fake.auth = { basic: 'someone:else' };
    const error = await openTicket(channel, ticketRequest).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/HTTP 401/);
    expect((error as Error).message).not.toContain('dev-password');
    fake.auth = { basic: 'landflow:dev-password', bearer: 'dev-bearer-token' };
  });

  it('refuses a plain alert sent to a ServiceNow channel, and Test opens a ticket and adds a note', async () => {
    const channel = serviceNow();
    const refusal = await sendThrough(sendable(channel), { ...testNotice(), test: false }).catch((e: Error) => e.message);
    expect(refusal).toBe('A ServiceNow channel only opens tickets for approval requests');
    expect(fake.calls).toHaveLength(0);

    const delivery = await alerts.test(channel.id);
    expect(delivery.ok).toBe(true);
    expect(delivery.message).toMatch(/CHG0000001/);
    expect(fake.records).toHaveLength(1);
    expect(fake.records[0]!.patches).toEqual([{ work_notes: 'Test from Landflow: the channel works.' }]);
    expect(String(fake.records[0]!.fields.short_description)).toMatch(/test/i);
  });

  it('testTicketChannel answers with what it did', async () => {
    expect(await testTicketChannel(sendable(serviceNow()))).toMatch(/Opened CHG0000001.*note/);
  });
});

describe('webhook tickets', () => {
  it('opens with a signed approval.requested POST and keeps the answered id and link', async () => {
    const channel = sendable(webhook());
    const ref = await openTicket(channel, ticketRequest);
    expect(ref).toEqual({ system: 'webhook', id: 'T-1', key: 'T-1', url: 'https://t.example/T-1' });
    const call = hooks[0]!;
    expect(call.headers['x-landflow-event']).toBe('approval.requested');
    const timestamp = String(call.headers['x-landflow-timestamp']);
    expect(call.headers['x-landflow-signature']).toBe(signature('sign-me', timestamp, call.body));
    expect(call.json).toMatchObject({ event: 'approval.requested', request: { id: 'req_123', kind: 'tool', subject: ticketRequest.subject, link: ticketRequest.link, expiresAt: ticketRequest.expiresAt } });
    expect(call.body).not.toContain('"params"');
  });

  it('closes with a signed approval.settled POST naming the ticket', async () => {
    const channel = sendable(webhook());
    const ref = await openTicket(channel, ticketRequest);
    await closeTicket(channel, ref, close);
    const call = hooks.at(-1)!;
    expect(call.headers['x-landflow-event']).toBe('approval.settled');
    expect(call.json).toMatchObject({ event: 'approval.settled', request: { id: 'req_123', status: 'approved', line: close.line }, ticket: { id: 'T-1' } });
    expect(call.headers['x-landflow-signature']).toBe(signature('sign-me', String(call.headers['x-landflow-timestamp']), call.body));
  });

  it('drops a ticket link that is not http(s), and an answer without a ticket is a failed open', async () => {
    const channel = sendable(webhook());
    hookAnswer = { status: 200, body: { ticket: { id: 'T-9', url: 'javascript:alert(1)' } } };
    expect(await openTicket(channel, ticketRequest)).toEqual({ system: 'webhook', id: 'T-9', key: 'T-9' });
    hookAnswer = { status: 200, body: { ok: true } };
    await expect(openTicket(channel, ticketRequest)).rejects.toThrow(/did not answer with a ticket/);
    hookAnswer = { status: 204 };
    await expect(openTicket(channel, ticketRequest)).rejects.toThrow(/did not answer with a ticket/);
  });

  it('fails with the status on a 500 and with the wait on a timeout', async () => {
    const channel = sendable(webhook());
    hookAnswer = { status: 500, body: { error: 'boom' } };
    await expect(openTicket(channel, ticketRequest)).rejects.toThrow(/HTTP 500/);
    hookAnswer = { status: 200, body: { ticket: { id: 'T-1' } } };
    hookDelayMs = 400;
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(100));
    await expect(openTicket(channel, ticketRequest)).rejects.toThrow(/could not be reached: no answer within/);
    spy.mockRestore();
  });

  it('keeps sending plain alerts as a signed webhook, and its Test opens and settles a ticket', async () => {
    const channel = webhook();
    await sendThrough(sendable(channel), { ...testNotice(), test: false });
    expect(hooks[0]!.headers['x-landflow-event']).toBe('alert');
    hooks.length = 0;
    const delivery = await alerts.test(channel.id);
    expect(delivery.ok).toBe(true);
    expect(hooks.map((h) => h.headers['x-landflow-event'])).toEqual(['approval.requested', 'approval.settled']);
    expect(hooks[0]!.json).toMatchObject({ test: true });
  });
});

describe('ticket fields in Settings', () => {
  const noop = () => {};
  const render = (kind: 'servicenow' | 'webhook', config = {}, name = '') =>
    renderToStaticMarkup(
      createElement(AlertTicketFields, {
        kind,
        config,
        set: noop,
        saved: () => false,
        credentials: [
          { id: basic.id, name: name || 'ServiceNow basic', type: 'core.httpBasicAuth' },
          { id: 'x', name: 'Other', type: 'core.openAiApi' },
        ],
      }),
    );

  it('shows the instance URL, a login, the table and the four states for ServiceNow', () => {
    const html = render('servicenow');
    for (const label of ['Instance URL', 'Credential', 'Table', 'State when approved', 'State when denied', 'State when expired', 'State when cancelled']) expect(html).toContain(label);
    expect(html).toContain('ServiceNow basic');
    expect(html).not.toContain('Other');
  });

  it('shows Opens tickets with its hint for a webhook, and nothing for other kinds', () => {
    const html = render('webhook');
    expect(html).toContain('Opens tickets');
    expect(html).toContain('ticket');
    expect(renderToStaticMarkup(createElement(AlertTicketFields, { kind: 'slack', config: {}, set: noop, saved: () => false, credentials: [] }))).toBe('');
  });

  it('renders a name holding markup as text', () => {
    const html = render('servicenow', {}, '<b>bold</b>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });
});
