/**
 * Per-workflow transport overrides (workflow settings `transports`, docs/transports.md "Where the choice is set"): the
 * merge with the plugin's policy (an override replaces mode, pin and objective, and only narrows the allow-list), the
 * setting's schema, and the registry choosing by the override only for calls made inside the workflow's scope.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@landflow/protocol';
import type { grpc } from '@landflow/protocol/grpc';
import { defineNode, definePlugin } from '@landflow/sdk';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-transport-override-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEY: 'override-test-key' });

const { registry } = await import('@/lib/server/plugins/registry');
const { transportPolicies, withWorkflowOverride } = await import('@/lib/server/transports/policy-store');
const { workflowTransportOverrideSchema } = await import('@/lib/server/transports/schema');
const { withWorkflowTransports, workflowTransportOverride } = await import('@/lib/server/transports/workflow-scope');
const { workflowSchema } = await import('@/lib/server/schemas');
const { createFetchHandler } = await import('@landflow/sdk/http');
const { serveGrpc } = await import('@landflow/sdk/grpc');

const AUTO = { mode: 'auto' as const, objective: 'balanced' as const };

describe('withWorkflowOverride', () => {
  it('no override: the plugin’s policy', () => {
    expect(withWorkflowOverride(AUTO, undefined)).toEqual(AUTO);
  });

  it('replaces the mode, the pin and the objective', () => {
    expect(withWorkflowOverride(AUTO, { mode: 'pinned', pinned: 'kafka' })).toEqual({ mode: 'pinned', pinned: 'kafka', objective: 'balanced' });
    expect(withWorkflowOverride({ mode: 'pinned', pinned: 'grpc', objective: 'balanced' }, { mode: 'auto', objective: 'latency' })).toEqual({ mode: 'auto', objective: 'latency' });
    // Only the objective: the plugin's pin stays.
    expect(withWorkflowOverride({ mode: 'pinned', pinned: 'grpc', objective: 'balanced' }, { objective: 'throughput' })).toEqual({ mode: 'pinned', pinned: 'grpc', objective: 'throughput' });
    // `pinned` alone pins.
    expect(withWorkflowOverride(AUTO, { pinned: 'nats' })).toEqual({ mode: 'pinned', pinned: 'nats', objective: 'balanced' });
  });

  it('only narrows the plugin’s allow-list', () => {
    const plugin = { mode: 'auto' as const, allowed: ['http', 'grpc', 'kafka'], objective: 'balanced' as const };
    expect(withWorkflowOverride(plugin, { allowed: ['kafka', 'nats'] })).toEqual({ mode: 'auto', allowed: ['kafka'], objective: 'balanced' });
    expect(withWorkflowOverride(AUTO, { allowed: ['nats'] })).toEqual({ mode: 'auto', allowed: ['nats'], objective: 'balanced' });
    expect(withWorkflowOverride(plugin, { allowed: ['nats'] })).toEqual({ error: "the workflow's allowed transports (nats) and the plugin's (http, grpc, kafka) share none" });
    expect(withWorkflowOverride(plugin, { mode: 'pinned', pinned: 'nats' })).toEqual({ error: 'the workflow pins nats, which the allowed transports (http, grpc, kafka) leave out' });
  });
});

describe('the setting', () => {
  it('validates an override', () => {
    expect(workflowTransportOverrideSchema.safeParse({ mode: 'pinned', pinned: 'kafka' }).success).toBe(true);
    expect(workflowTransportOverrideSchema.safeParse({ objective: 'latency' }).success).toBe(true);
    expect(workflowTransportOverrideSchema.safeParse({ mode: 'pinned' }).success).toBe(false);
    expect(workflowTransportOverrideSchema.safeParse({ mode: 'auto', pinned: 'kafka' }).success).toBe(false);
    expect(workflowTransportOverrideSchema.safeParse({ pinned: 'kafka', allowed: ['grpc'] }).success).toBe(false);
    expect(workflowTransportOverrideSchema.safeParse({ allowed: [] }).success).toBe(false);
    expect(workflowTransportOverrideSchema.safeParse({ mode: 'auto', extra: 1 }).success).toBe(false);
    expect(workflowTransportOverrideSchema.safeParse({ pinned: 'Kafka' }).success).toBe(false);
  });

  it('is part of the workflow settings', () => {
    const parsed = workflowSchema.parse({ name: 'w', nodes: [], connections: [], settings: { transports: { 'text-toolkit': { mode: 'pinned', pinned: 'nats' } } } });
    expect(parsed.settings?.transports).toEqual({ 'text-toolkit': { mode: 'pinned', pinned: 'nats' } });
    expect(workflowSchema.safeParse({ name: 'w', nodes: [], connections: [], settings: { transports: { 'text-toolkit': { mode: 'pinned' } } } }).success).toBe(false);
  });

  it('is in scope only inside the workflow’s run, and a nested run has its own', () => {
    expect(workflowTransportOverride('p')).toBeUndefined();
    withWorkflowTransports('wf1', { p: { pinned: 'http' } }, () => {
      expect(workflowTransportOverride('p')).toEqual({ workflowId: 'wf1', override: { pinned: 'http' } });
      expect(workflowTransportOverride('other')).toBeUndefined();
      // A sub-execution of a workflow without overrides doesn't inherit the parent's.
      withWorkflowTransports('wf2', undefined, () => expect(workflowTransportOverride('p')).toBeUndefined());
    });
  });
});

describe('registry: a workflow’s override chooses its calls’ transport', () => {
  const PLUGIN_ID = 'tp-override';
  const HTTP_PORT = 7660;
  const GRPC_PORT = 7661;
  const HTTP = `http://127.0.0.1:${HTTP_PORT}`;
  const GRPC = `grpc://127.0.0.1:${GRPC_PORT}`;
  const plugin = definePlugin({
    info: { id: PLUGIN_ID, name: 'Override Echo', version: '1.0.0' },
    nodes: [
      defineNode({
        description: { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
        execute: (ctx) => ctx.getInputData().map((item) => ({ json: { ...item.json, echoed: true } })),
      }),
    ],
  });
  let httpServer: Server;
  let grpcServer: grpc.Server;
  const execute = async () => {
    const resolved = registry.resolve(`${PLUGIN_ID}.echo`);
    if ('error' in resolved) throw new Error(resolved.error);
    return resolved.execute({
      protocol: PROTOCOL_VERSION,
      executionId: 'ex1',
      workflowId: 'wf1',
      mode: 'manual',
      node: { id: 'n1', name: 'Echo', type: `${PLUGIN_ID}.echo`, typeVersion: 1 },
      parameters: {},
      itemParameters: [{}],
      inputs: [[{ json: { a: 1 } }]],
    });
  };

  beforeAll(async () => {
    const handle = createFetchHandler(plugin);
    httpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const response = await handle(new Request(`http://plugin${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(chunks.length && { body: Buffer.concat(chunks) }) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, '127.0.0.1', resolve));
    grpcServer = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
    await registry.addEndpoint(HTTP, 'manual');
    await registry.addEndpoint(GRPC, 'manual');
  });

  afterAll(async () => {
    registry.remove(PLUGIN_ID);
    transportPolicies.remove(PLUGIN_ID);
    grpcServer.forceShutdown();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('outside a run the plugin’s policy chooses; inside, the workflow’s pin', async () => {
    expect(registry.select(PLUGIN_ID)).toMatchObject({ kind: 'grpc' });
    const pinned = await withWorkflowTransports('wf1', { [PLUGIN_ID]: { mode: 'pinned', pinned: 'http' } }, async () => {
      expect(registry.select(PLUGIN_ID)).toEqual({ endpoint: HTTP, kind: 'http', reason: 'pinned' });
      return execute();
    });
    expect(pinned.outputs?.[0]?.[0]?.json).toMatchObject({ a: 1, echoed: true });
    // The Plugins page still shows the plugin's own choice.
    expect(registry.list().find((p) => p.id === PLUGIN_ID)?.choice).toMatchObject({ kind: 'grpc' });
    // Another workflow without an override keeps it too.
    withWorkflowTransports('wf2', {}, () => expect(registry.select(PLUGIN_ID)).toMatchObject({ kind: 'grpc' }));
  });

  it('the plugin’s allow-list still applies: a pin outside it fails the call with the reason', async () => {
    registry.setPolicy(PLUGIN_ID, { mode: 'auto', allowed: ['grpc'] });
    await withWorkflowTransports('wf1', { [PLUGIN_ID]: { pinned: 'http' } }, async () => {
      const message = `Plugin "${PLUGIN_ID}": the workflow pins http, which the allowed transports (grpc) leave out (workflow settings → Transports)`;
      expect(registry.select(PLUGIN_ID)).toEqual({ error: message });
      expect(registry.resolve(`${PLUGIN_ID}.echo`)).toEqual({ error: message.replace(`Plugin "${PLUGIN_ID}"`, 'Plugin "Override Echo"') });
    });
    // An objective-only override keeps the allow-list.
    await withWorkflowTransports('wf1', { [PLUGIN_ID]: { objective: 'latency' } }, async () => {
      expect(registry.select(PLUGIN_ID)).toMatchObject({ kind: 'grpc', reason: 'only' });
      expect((await execute()).outputs?.[0]?.[0]?.json).toMatchObject({ echoed: true });
    });
    registry.setPolicy(PLUGIN_ID, { mode: 'auto' });
  });
});
