/**
 * App webhook triggers (lib/server/app-webhooks.ts, docs/protocol.md §12) end to end: publishing registers the
 * trigger's hook with a fake service (checkExists / create), the service's signed calls to
 * /api/webhook/app/<workflowId>/<nodeId> start runs of the published version, a changed trigger re-registers, unpublish
 * deletes the hook, and failed creates are retried. The same plugin runs in process, over HTTP and over gRPC.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin, githubSignature, verifyGitHubSignature, type JsonObject } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';
import type { grpc } from '@landflow/protocol/grpc';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-app-webhooks-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://apphooks.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { publishDraft, unpublishWorkflow, publicationStatus } = await import('@/lib/server/publish');
const { appWebhooks, getStaticData } = await import('@/lib/server/app-webhooks');
const { serveHttp } = await import('@landflow/sdk/http');
const { serveGrpc } = await import('@landflow/sdk/grpc');
const appRoute = await import('@/app/api/webhook/app/[workflowId]/[nodeId]/route');

const GRPC_PORT = 47361;

// ---------------------------------------------------------------------------
// The fake service and the trigger
// ---------------------------------------------------------------------------

interface Hook {
  id: string;
  url: string;
  secret: string;
  events: string;
}

const service = { hooks: new Map<string, Hook>(), next: 1, failCreates: false, calls: [] as string[] };
let serviceServer: Server;
let serviceUrl = '';

const hookTrigger = defineNode({
  description: {
    name: 'hookTrigger',
    displayName: 'Hook Trigger',
    description: 'Starts on events from the fake service',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    inputs: [],
    outputs: [{ type: 'main' }],
    properties: [{ name: 'events', displayName: 'Events', type: 'string', default: 'push' }],
  },
  webhookMethods: {
    async checkExists(ctx) {
      const id = ctx.getStaticData().hookId;
      return Boolean(id) && (await ctx.helpers.httpRequest({ url: `${serviceUrl}/hooks/${id}` })).status === 200;
    },
    async create(ctx) {
      const response = await ctx.helpers.httpRequest({ method: 'POST', url: `${serviceUrl}/hooks`, body: { url: ctx.getWebhookUrl(), events: ctx.getNodeParameter('events') } });
      if (response.status !== 201) throw new Error(`The service refused the hook (HTTP ${response.status})`);
      const hook = response.body as Hook;
      Object.assign(ctx.getStaticData(), { hookId: hook.id, secret: hook.secret });
    },
    async delete(ctx) {
      const id = ctx.getStaticData().hookId;
      if (id) await ctx.helpers.httpRequest({ method: 'DELETE', url: `${serviceUrl}/hooks/${id}` });
      ctx.setStaticData({});
    },
  },
  webhook(ctx) {
    if (!verifyGitHubSignature(String(ctx.getStaticData().secret ?? ''), ctx.getRawBody(), ctx.getHeader('x-hub-signature-256'))) return { response: { status: 401, body: 'bad signature' } };
    const body = ctx.getBody<JsonObject>();
    if (body.zen) return { response: { status: 200, body: 'pong' } };
    return { items: [{ event: ctx.getHeader('x-event') ?? 'unknown', body }], idempotencyKey: ctx.getHeader('x-delivery') };
  },
});

const plugins = {
  'in-process': definePlugin({ info: { id: 'hooks', name: 'Hooks', version: '1.0.0' }, nodes: [hookTrigger] }),
  http: definePlugin({ info: { id: 'httphooks', name: 'HTTP hooks', version: '1.0.0' }, nodes: [hookTrigger] }),
  grpc: definePlugin({ info: { id: 'grpchooks', name: 'gRPC hooks', version: '1.0.0' }, nodes: [hookTrigger] }),
};

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(plugins['in-process']);

let httpPlugin: Server;
let grpcPlugin: grpc.Server;

beforeAll(async () => {
  serviceServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      service.calls.push(`${req.method} ${req.url}`);
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const id = /^\/hooks\/([^/]+)$/.exec(req.url ?? '')?.[1];
      if (req.method === 'POST' && req.url === '/hooks') {
        if (service.failCreates) return send(503, { message: 'down for maintenance' });
        const input = JSON.parse(raw) as { url: string; events: string };
        const hook: Hook = { id: `h${service.next}`, url: input.url, events: input.events, secret: `secret-${service.next++}` };
        service.hooks.set(hook.id, hook);
        return send(201, hook);
      }
      if (id && req.method === 'GET') return service.hooks.has(id) ? send(200, service.hooks.get(id)) : send(404);
      if (id && req.method === 'DELETE') return service.hooks.delete(id) ? send(204) : send(404);
      send(404);
    });
  });
  await new Promise<void>((resolve) => serviceServer.listen(0, '127.0.0.1', resolve));
  serviceUrl = `http://127.0.0.1:${(serviceServer.address() as AddressInfo).port}`;

  httpPlugin = await serveHttp(plugins.http, { port: 0, host: '127.0.0.1' });
  await registry.addEndpoint(`http://127.0.0.1:${(httpPlugin.address() as AddressInfo).port}`, 'static');
  grpcPlugin = await serveGrpc(plugins.grpc, { port: GRPC_PORT, host: '127.0.0.1' });
  await registry.addEndpoint(`grpc://127.0.0.1:${GRPC_PORT}`, 'static');
});

afterAll(async () => {
  appWebhooks.stop();
  grpcPlugin?.forceShutdown();
  await new Promise<void>((resolve) => httpPlugin.close(() => resolve()));
  await new Promise<void>((resolve) => serviceServer.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workflowFor(id: string, pluginId: string, events = 'push'): Workflow {
  return {
    id,
    name: `App hooks ${id}`,
    nodes: [
      { id: 'trigger', name: 'Service', type: `${pluginId}.hookTrigger`, typeVersion: 1, position: [0, 0], parameters: { events } },
      { id: 'after', name: 'After', type: 'core.noOp', typeVersion: 1, position: [220, 0], parameters: {} },
    ],
    connections: [{ id: 'c', type: 'main', source: 'trigger', target: 'after', sourceIndex: 0, targetIndex: 0 }],
  };
}

function deliver(workflowId: string, body: unknown, headers: (raw: string) => Record<string, string>) {
  const raw = JSON.stringify(body);
  return appRoute.POST(
    new Request(`http://apphooks.test/api/webhook/app/${workflowId}/trigger`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...headers(raw) } }),
    { params: Promise.resolve({ workflowId, nodeId: 'trigger' }) },
  );
}

async function until<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.each(Object.entries(plugins))('app webhook trigger (%s)', (transport, plugin) => {
  const id = `wf_app_${transport.replace(/\W/g, '_')}`;
  const url = `http://apphooks.test/api/webhook/app/${id}/trigger`;

  it('registers on publish, starts runs from signed calls, re-registers on change and deletes on unpublish', async () => {
    store.saveWorkflow(workflowFor(id, plugin.info.id));
    // Not published: no hook, and calls are refused.
    expect([...service.hooks.values()].some((hook) => hook.url === url)).toBe(false);
    expect((await deliver(id, {}, () => ({}))).status).toBe(404);

    const published = await publishDraft(id);
    expect(published.triggerErrors).toEqual([]);
    expect(published.appWebhooks).toEqual([expect.objectContaining({ nodeId: 'trigger', nodeName: 'Service', webhookUrl: url, registered: true })]);
    const hook = [...service.hooks.values()].find((h) => h.url === url)!;
    expect(hook).toMatchObject({ events: 'push' });
    expect(getStaticData(id, 'trigger')).toEqual({ hookId: hook.id, secret: hook.secret });

    // A signed event starts a run of the published version; the trigger outputs what webhook() returned.
    const signed = (event: string, delivery: string) => (raw: string) => ({ 'x-hub-signature-256': githubSignature(hook.secret, raw), 'x-event': event, 'x-delivery': delivery });
    const started = await deliver(id, { ref: 'main' }, signed('push', `d-${transport}-1`));
    expect(started.status).toBe(200);
    const { status, executionId } = (await started.json()) as { status: string; executionId: string };
    expect(status).toBe('started');
    const record = await until(() => {
      const execution = store.getExecution(executionId);
      return execution?.status === 'success' ? execution : undefined;
    });
    expect(record).toMatchObject({ mode: 'webhook', versionPublished: true, idempotencyKey: `d-${transport}-1` });
    expect(record.runData.after[0].inputs[0].map((item) => item.json)).toEqual([{ event: 'push', body: { ref: 'main' } }]);

    // A redelivery starts nothing new; a forged signature is refused; a ping answers without a run.
    expect(await (await deliver(id, { ref: 'main' }, signed('push', `d-${transport}-1`))).json()).toMatchObject({ status: 'duplicate', executionId });
    const forged = await deliver(id, { ref: 'main' }, () => ({ 'x-hub-signature-256': githubSignature('guess', '{}') }));
    expect(forged.status).toBe(401);
    expect(await forged.text()).toBe('bad signature');
    const ping = await deliver(id, { zen: 'Design for failure.' }, (raw) => ({ 'x-hub-signature-256': githubSignature(hook.secret, raw) }));
    expect([ping.status, await ping.text()]).toEqual([200, 'pong']);
    expect(store.listExecutions({ workflowId: id })).toHaveLength(1);

    // The trigger's settings change and the draft is published: the old hook goes, a new one comes.
    store.saveWorkflow(workflowFor(id, plugin.info.id, 'push,issues'));
    expect(service.hooks.has(hook.id)).toBe(true);
    await publishDraft(id);
    expect(service.hooks.has(hook.id)).toBe(false);
    const replaced = [...service.hooks.values()].find((h) => h.url === url)!;
    expect(replaced).toMatchObject({ events: 'push,issues' });
    expect(getStaticData(id, 'trigger')).toMatchObject({ hookId: replaced.id });

    // Publishing again without changes only checks that the hook is still there.
    const calls = service.calls.length;
    await publishDraft(id);
    expect(service.calls.slice(calls)).toEqual([`GET /hooks/${replaced.id}`]);

    const unpublished = await unpublishWorkflow(id);
    expect(unpublished.triggerErrors).toEqual([]);
    expect(service.hooks.has(replaced.id)).toBe(false);
    expect(getStaticData(id, 'trigger')).toEqual({});
    expect((await publicationStatus(id)).appWebhooks).toEqual([]);
  });
});

describe('failures', () => {
  it('reports a failed create, keeps the publish, and registers on retry', async () => {
    const id = 'wf_app_retry';
    store.saveWorkflow(workflowFor(id, 'hooks'));
    service.failCreates = true;
    const result = await publishDraft(id);
    expect(result.published).toBeDefined();
    expect(result.triggerErrors).toEqual([{ nodeName: 'Service', message: expect.stringMatching(/refused the hook \(HTTP 503\)/) }]);
    expect(result.appWebhooks[0]).toMatchObject({ registered: false, error: expect.stringMatching(/HTTP 503/) });

    service.failCreates = false;
    expect(await appWebhooks.reconcile(id)).toEqual([]);
    expect((await publicationStatus(id)).appWebhooks[0]).toMatchObject({ registered: true });
    expect([...service.hooks.values()].some((hook) => hook.url.endsWith(`/${id}/trigger`))).toBe(true);
    await unpublishWorkflow(id);
  });

  it('re-creates a hook that was removed at the service', async () => {
    const id = 'wf_app_gone';
    store.saveWorkflow(workflowFor(id, 'hooks'));
    await publishDraft(id);
    const before = getStaticData(id, 'trigger').hookId as string;
    service.hooks.delete(before);
    await appWebhooks.reconcile(id);
    const after = getStaticData(id, 'trigger').hookId as string;
    expect(after).not.toBe(before);
    expect(service.hooks.has(after)).toBe(true);
    await unpublishWorkflow(id);
  });
});
