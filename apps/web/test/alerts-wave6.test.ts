/**
 * Alerts, wave 6: Microsoft Teams (Adaptive Card) and Discord (embed) channels against fake receivers, the failure-rate
 * rule (min runs, percent, window, once per window), the plugin offline / back online rule with its grace period, and
 * how the rule kinds are validated. The time-based rules run from the service's ticker, which only the leader runs in
 * queue mode: the tests drive `alerts.tick(now)` with a clock, and the rules read executions from the database and the
 * plugin registry, not from anything in the process that ran the workflow.
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertChannel, AlertRule } from '@/lib/shared/alerts';
import type { ExecutionRecord } from '@/lib/shared/types';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-alerts6-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { database } = await import('@/lib/server/db');
const { store } = await import('@/lib/server/store');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const { breaches, noteRegistryEvent, outageStamps } = await import('@/lib/server/alerts/monitors');
const channelsRoute = await import('@/app/api/settings/alerts/channels/route');
const rulesRoute = await import('@/app/api/settings/alerts/rules/route');
const alertsRoute = await import('@/app/api/settings/alerts/route');

registry.registerBuiltin(corePlugin);

interface Received {
  path: string;
  json: Record<string, any>;
}
const received: Received[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ path: req.url ?? '', json: body ? JSON.parse(body) : {} });
    if (req.url === '/teams') return res.writeHead(202).end();
    if (req.url === '/discord') return res.writeHead(204).end();
    if (req.url === '/gone') return res.writeHead(404, { 'content-type': 'text/plain' }).end('Unknown Webhook');
    res.writeHead(500).end('unexpected');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const fakeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(async () => {
  alerts.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const request = (body?: unknown, method = 'POST') => new Request('http://landflow.test/api', { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const hooks = () => received.filter((r) => r.path === '/hook');

function resetAlerts() {
  const db = database();
  for (const table of ['alert_state', 'alert_throttle', 'alert_rules', 'alert_channels', 'executions'] as const) db.sqlite.exec(`DELETE FROM ${table}`);
  received.length = 0;
  outageStamps.clear();
}
beforeEach(resetAlerts);
afterEach(() => vi.restoreAllMocks());

let seq = 0;
function run(status: 'success' | 'error', at: number, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  seq++;
  const iso = new Date(at).toISOString();
  const record: ExecutionRecord = {
    executionId: `exec_w6_${seq}`,
    workflowId: 'wf_orders',
    workflowName: 'Orders sync',
    mode: 'trigger',
    status,
    startedAt: iso,
    finishedAt: iso,
    durationMs: 5,
    runData: {},
    executionOrder: ['Fetch'],
    ...(status === 'error' && { error: { message: 'Request failed with status code 502', nodeId: 'Fetch', nodeName: 'Fetch orders' } }),
    lastNodeId: 'Fetch',
    nodeNames: { Fetch: 'Fetch orders' },
    ...overrides,
  };
  store.saveExecution(record);
  return record;
}

const webhook = () => alertStore.createChannel({ name: 'Hook', kind: 'webhook', config: { url: `${fakeUrl}/hook` } });
// The fake receiver answers 500 on /hook; reroute it to a 204.
server.removeAllListeners('request');
server.on('request', (req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ path: req.url ?? '', json: body ? JSON.parse(body) : {} });
    if (req.url === '/teams') return res.writeHead(202).end();
    if (req.url === '/discord' || req.url === '/hook') return res.writeHead(204).end();
    if (req.url === '/gone') return res.writeHead(404, { 'content-type': 'text/plain' }).end('Unknown Webhook');
    res.writeHead(500).end('unexpected');
  });
});

const rateRule = (channelId: string, over: Partial<AlertRule> = {}) =>
  alertStore.createRule({ name: 'Failure rate', kind: 'failureRate', enabled: true, workflows: { mode: 'all' }, events: ['failureRate'], channelIds: [channelId], throttleMinutes: 0, failureRate: { minRuns: 5, percent: 50, windowMinutes: 15 }, ...over } as never);

describe('Microsoft Teams and Discord channels', () => {
  it('posts an Adaptive Card to a Teams webhook', async () => {
    const teams = alertStore.createChannel({ name: 'Ops', kind: 'teams', config: { webhookUrl: `${fakeUrl}/teams` } });
    expect(await alerts.test(teams.id)).toMatchObject({ ok: true, message: 'Microsoft Teams accepted it (HTTP 202)' });
    const body = received.at(-1)!.json;
    expect(body.type).toBe('message');
    const attachment = body.attachments[0];
    expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(attachment.content).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
    expect(attachment.content.body[0]).toMatchObject({ type: 'TextBlock', text: 'Test alert from Landflow' });
    expect(attachment.content.body.some((b: { type: string }) => b.type === 'FactSet')).toBe(true);
  });

  it('posts an embed to a Discord webhook', async () => {
    const discord = alertStore.createChannel({ name: 'Ops', kind: 'discord', config: { webhookUrl: `${fakeUrl}/discord` } });
    expect(await alerts.test(discord.id)).toMatchObject({ ok: true, message: 'Discord accepted it (HTTP 204)' });
    const body = received.at(-1)!.json;
    expect(body.username).toBe('Landflow');
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]).toMatchObject({ title: 'Test alert from Landflow' });
    expect(body.embeds[0].footer.text).toBeTruthy();
  });

  it('reports a refusal and requires a webhook URL; the URL is masked by the API', async () => {
    const discord = alertStore.createChannel({ name: 'Gone', kind: 'discord', config: { webhookUrl: `${fakeUrl}/gone` } });
    expect(await alerts.test(discord.id)).toMatchObject({ ok: false, message: 'Discord answered HTTP 404: Unknown Webhook' });
    for (const kind of ['teams', 'discord']) {
      const response = await channelsRoute.POST(request({ name: 'X', kind, config: {} }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/webhook URL/i);
    }
    const created = await channelsRoute.POST(request({ name: 'Teams', kind: 'teams', config: { webhookUrl: `${fakeUrl}/teams` } }));
    expect(created.status).toBe(201);
    const view = (await (await alertsRoute.GET()).json()) as { channels: AlertChannel[] };
    const shown = view.channels.find((channel) => channel.kind === 'teams')!;
    expect(JSON.stringify(shown)).not.toContain(`${fakeUrl}/teams`);
    expect(shown.config.webhookUrl).not.toBe(`${fakeUrl}/teams`);
  });
});

describe('failure-rate rule', () => {
  it('decides on min runs and "more than" X%', () => {
    expect(breaches({ total: 4, failed: 4 }, { minRuns: 5, percent: 50 })).toBe(false);
    expect(breaches({ total: 10, failed: 5 }, { minRuns: 5, percent: 50 })).toBe(false);
    expect(breaches({ total: 10, failed: 6 }, { minRuns: 5, percent: 50 })).toBe(true);
  });

  it('alerts once per window per workflow, and again when the next window still fails', async () => {
    const channel = webhook();
    rateRule(channel.id);
    const now = Date.now();
    for (let i = 0; i < 4; i++) run('error', now - 60_000 - i);
    run('success', now - 90_000);
    run('error', now - 30_000);
    await alerts.tick(now);
    expect(hooks()).toHaveLength(1);
    expect(hooks()[0].json).toMatchObject({ event: 'failureRate' });
    expect(String(hooks()[0].json.summary)).toContain('83.3% of runs failed: Orders sync');
    // The same window: nothing more, however many ticks or failures.
    run('error', now - 10_000);
    await alerts.tick(now + 60_000);
    await alerts.tick(now + 120_000);
    expect(hooks()).toHaveLength(1);
    // The window has passed and it still fails: a new alert.
    const later = now + 16 * 60_000;
    for (let i = 0; i < 6; i++) run('error', later - 1_000 - i);
    await alerts.tick(later);
    expect(hooks()).toHaveLength(2);
  });

  it('stays quiet below the minimum, below the percentage, for manual runs and out-of-scope workflows', async () => {
    const channel = webhook();
    rateRule(channel.id, { workflows: { mode: 'ids', ids: ['wf_orders'] } });
    const now = Date.now();
    for (let i = 0; i < 4; i++) run('error', now - 1_000 - i); // 4 runs: under minRuns
    for (let i = 0; i < 10; i++) run('success', now - 2_000 - i, { workflowId: 'wf_fine', workflowName: 'Fine' });
    for (let i = 0; i < 10; i++) run('error', now - 3_000 - i, { workflowId: 'wf_other', workflowName: 'Other' }); // not in scope
    for (let i = 0; i < 10; i++) run('error', now - 4_000 - i, { workflowId: 'wf_manual', workflowName: 'Manual', mode: 'manual' });
    await alerts.tick(now);
    expect(hooks()).toHaveLength(0);
  });

  it('forgets a window that lapsed and no longer breaches, so a later outbreak alerts', async () => {
    const channel = webhook();
    const created = rateRule(channel.id);
    const now = Date.now();
    for (let i = 0; i < 5; i++) run('error', now - 1_000 - i);
    await alerts.tick(now);
    expect(hooks()).toHaveLength(1);
    const later = now + 20 * 60_000;
    await alerts.tick(later);
    expect(alertStore.states(created.id, 'rate:')).toHaveLength(0);
    for (let i = 0; i < 5; i++) run('error', later - 1_000 - i);
    await alerts.tick(later);
    expect(hooks()).toHaveLength(2);
  });
});

describe('plugin offline rule', () => {
  const pluginRule = (channelId: string, plugins: Record<string, unknown> = {}) =>
    alertStore.createRule({ name: 'Plugins', kind: 'plugin', enabled: true, workflows: { mode: 'all' }, events: ['pluginOffline', 'pluginOnline'], channelIds: [channelId], throttleMinutes: 0, plugins: { graceSeconds: 120, notifyRecovery: true, ...plugins } } as never);
  const fakePlugin = (status: 'online' | 'offline', id = 'py-insights') => ({
    id,
    info: { id, name: 'Insights' },
    status,
    transport: 'grpc',
    endpoints: [{ endpoint: 'main', status, transport: 'grpc', lastError: status === 'offline' ? 'connection refused' : undefined }],
  });
  const setStatus = (status: 'online' | 'offline') => vi.spyOn(registry, 'list').mockReturnValue([fakePlugin(status)] as never);

  it('alerts after the grace period, once, and says when it is back', async () => {
    const channel = webhook();
    pluginRule(channel.id);
    const now = Date.now();
    setStatus('offline');
    await alerts.tick(now);
    expect(hooks()).toHaveLength(0);
    await alerts.tick(now + 60_000);
    expect(hooks()).toHaveLength(0);
    await alerts.tick(now + 130_000);
    expect(hooks()).toHaveLength(1);
    expect(hooks()[0].json).toMatchObject({ event: 'pluginOffline' });
    expect(String(hooks()[0].json.summary)).toContain('Plugin offline: Insights');
    await alerts.tick(now + 300_000);
    expect(hooks()).toHaveLength(1);
    setStatus('online');
    await alerts.tick(now + 360_000);
    expect(hooks()).toHaveLength(2);
    expect(hooks()[1].json).toMatchObject({ event: 'pluginOnline', recovery: true });
    expect(String(hooks()[1].json.summary)).toContain('Plugin back online: Insights');
    await alerts.tick(now + 420_000);
    expect(hooks()).toHaveLength(2);
  });

  it('says nothing when the plugin returns inside the grace period (a restart)', async () => {
    const channel = webhook();
    pluginRule(channel.id);
    const now = Date.now();
    setStatus('offline');
    await alerts.tick(now);
    setStatus('online');
    await alerts.tick(now + 30_000);
    setStatus('offline');
    await alerts.tick(now + 60_000);
    setStatus('online');
    await alerts.tick(now + 400_000);
    expect(hooks()).toHaveLength(0);
  });

  it('skips the recovery message when asked, and watches only the plugins chosen', async () => {
    const channel = webhook();
    pluginRule(channel.id, { notifyRecovery: false });
    const now = Date.now();
    setStatus('offline');
    await alerts.tick(now);
    await alerts.tick(now + 200_000);
    expect(hooks()).toHaveLength(1);
    setStatus('online');
    await alerts.tick(now + 300_000);
    expect(hooks()).toHaveLength(1);

    resetAlerts();
    const other = webhook();
    pluginRule(other.id, { ids: ['some-other-plugin'] });
    setStatus('offline');
    await alerts.tick(now);
    await alerts.tick(now + 200_000);
    expect(hooks()).toHaveLength(0);
  });

  it('counts from the registry event that took the plugin offline', async () => {
    const channel = webhook();
    pluginRule(channel.id);
    const now = Date.now();
    noteRegistryEvent({ type: 'plugin.offline', pluginId: 'py-insights' }, now - 300_000);
    setStatus('offline');
    await alerts.tick(now);
    expect(hooks()).toHaveLength(1);
    noteRegistryEvent({ type: 'plugin.registered', pluginId: 'py-insights' });
    expect(outageStamps.has('py-insights')).toBe(false);
  });
});

describe('rule kinds through the API', () => {
  it('fills each kind’s events and defaults, and checks its settings', async () => {
    const channel = webhook();
    const created = await rulesRoute.POST(request({ name: 'Rate', kind: 'failureRate', workflows: { mode: 'all' }, channelIds: [channel.id] }));
    expect(created.status).toBe(201);
    const rule = ((await created.json()) as { rule: AlertRule }).rule;
    expect(rule.events).toEqual(['failureRate']);
    expect(rule.failureRate).toEqual({ minRuns: 5, percent: 50, windowMinutes: 15 });

    const plugin = ((await (await rulesRoute.POST(request({ name: 'P', kind: 'plugin', workflows: { mode: 'all' }, channelIds: [channel.id] }))).json()) as { rule: AlertRule }).rule;
    expect(plugin.events).toEqual(['pluginOffline', 'pluginOnline']);
    expect(plugin.plugins).toMatchObject({ graceSeconds: 120, notifyRecovery: true });

    expect((await rulesRoute.POST(request({ name: 'Bad', kind: 'failureRate', workflows: { mode: 'all' }, channelIds: [channel.id], failureRate: { minRuns: 0, percent: 50, windowMinutes: 15 } }))).status).toBe(400);
    expect((await rulesRoute.POST(request({ name: 'Bad', kind: 'failureRate', workflows: { mode: 'all' }, channelIds: [channel.id], failureRate: { minRuns: 5, percent: 150, windowMinutes: 15 } }))).status).toBe(400);
    expect((await rulesRoute.POST(request({ name: 'Bad', kind: 'nonsense', workflows: { mode: 'all' }, channelIds: [channel.id] }))).status).toBe(400);
    // An evaluation rule needs a limit.
    expect((await rulesRoute.POST(request({ name: 'Eval', kind: 'evaluation', workflows: { mode: 'all' }, channelIds: [channel.id], evaluation: {} }))).status).toBe(400);
    expect((await rulesRoute.POST(request({ name: 'Eval', kind: 'evaluation', workflows: { mode: 'all' }, channelIds: [channel.id], evaluation: { below: 0.8 } }))).status).toBe(201);
  });
});
