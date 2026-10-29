/** The manifest over HTTP and gRPC: nodes, credential types, icons, MCP hints; Execute works over gRPC too. */
import { describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, type PluginManifest } from '@landflow/protocol';
import { executeRequestToMsg, executeResponseFromMsg, grpc, loadLandflowProto, manifestFromMsg, unary, type ExecuteResponseMsg, type ManifestMsg } from '@landflow/protocol/grpc';
import { mcpToolsFromManifest } from '@landflow/protocol';
import { createDispatcher } from '@landflow/sdk/dispatcher';
import { serveGrpc } from '@landflow/sdk/grpc';
import { createFetchHandler } from '@landflow/sdk/http';
import { plugin } from '../src/main';
import { SEED, startFakeLandfall } from './fake-landfall';
import { executeRequest, landfallCredentials } from './helpers';

const GRPC_PORT = 47908;

function check(manifest: PluginManifest) {
  expect(manifestSchema.safeParse(manifest).success).toBe(true);
  expect(manifest.plugin).toMatchObject({ id: 'landfall', name: 'Landfall', language: 'typescript' });
  expect(manifest.nodes.map((n) => n.name)).toEqual(['landfall', 'landfallTrigger']);
  for (const icon of [manifest.plugin.icon, ...manifest.nodes.map((n) => n.icon), ...(manifest.credentialTypes ?? []).map((c) => c.icon)]) {
    expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
  }
  expect(JSON.stringify(manifest)).not.toContain('file:');
  expect(manifest.credentialTypes?.map((c) => [c.name, c.testable, c.displayName])).toEqual([
    ['landfallApi', true, 'Landfall API (lf_key_…)'],
    ['landfallHeartbeatApi', true, 'Landfall Heartbeat'],
  ]);
  for (const type of manifest.credentialTypes ?? []) {
    for (const property of type.properties) {
      if (/token|apiKey/i.test(property.name)) expect(property.typeOptions?.password).toBe(true);
    }
  }
  const landfall = manifest.nodes.find((n) => n.name === 'landfall')!;
  expect(landfall).toMatchObject({ kind: 'action', usableAsTool: true, idempotent: false });
  expect(manifest.nodes.find((n) => n.name === 'landfallTrigger')).toMatchObject({ kind: 'trigger', triggerSource: 'poll' });
  const pollInterval = manifest.nodes.find((n) => n.name === 'landfallTrigger')!.properties.find((p) => p.name === 'pollInterval');
  expect(pollInterval?.default).toBe(30);
  expect(landfall.credentials).toEqual([
    { name: 'landfallApi', required: true, displayOptions: { hide: { resource: ['heartbeat'] } } },
    { name: 'landfallHeartbeatApi', required: true, displayOptions: { show: { resource: ['heartbeat'] } } },
  ]);
}

describe('manifest', () => {
  it('is valid over HTTP, icons inlined', async () => {
    const handle = createFetchHandler(plugin);
    check((await (await handle(new Request(`http://plugin${HTTP_PATHS.manifest}`))).json()) as PluginManifest);
  });

  it('is valid over gRPC, and Execute works there too', async () => {
    const fake = await startFakeLandfall();
    const server = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
    const client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
    try {
      check(manifestSchema.parse(manifestFromMsg(await unary<object, ManifestMsg>(client, 'GetManifest', {}, 3000))) as PluginManifest);
      const request = executeRequest('landfall', { resource: 'incident', operation: 'declare', title: 'via grpc', severity: '' }, { credentials: landfallCredentials(fake) });
      const response = executeResponseFromMsg(await unary<object, ExecuteResponseMsg>(client, 'Execute', executeRequestToMsg(request), 3000));
      expect(response.outputs[0][0].json).toMatchObject({ title: 'via grpc', status: 'open' });
      expect(fake.requests[0].authorization).toBe(`Bearer ${SEED.apiKey}`);
    } finally {
      client.close();
      server.forceShutdown();
      await fake.close();
    }
  });
});

describe('operations', () => {
  const landfall = plugin.nodes.find((n) => n.description.name === 'landfall')!.description;
  const operations = landfall.properties.filter((p) => p.name === 'operation');
  const byResource = Object.fromEntries(operations.map((p) => [p.displayOptions!.show!.resource[0] as string, (p.options ?? []).map((o) => o.value)]));

  it('has the resources and operations', () => {
    expect(byResource).toEqual({
      incident: ['declare', 'get', 'getAll', 'openManually', 'openFromAlert', 'recover'],
      timeline: ['addEvent', 'addNote', 'getEvents'],
      remediation: ['recordAppliedExternally'],
      heartbeat: ['ping'],
    });
  });

  it('exposes MCP tools with read-only hints on exactly the get operations, and no trigger tool', () => {
    const tools = mcpToolsFromManifest(createDispatcher(plugin).manifest);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'heartbeat_ping',
      'incident_declare',
      'incident_get',
      'incident_getAll',
      'incident_openFromAlert',
      'incident_openManually',
      'incident_recover',
      'remediation_recordAppliedExternally',
      'timeline_addEvent',
      'timeline_addNote',
      'timeline_getEvents',
    ]);
    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(['incident_get', 'incident_getAll', 'timeline_getEvents']);
    for (const tool of tools) {
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.idempotentHint).toBe(tool.annotations.readOnlyHint);
    }
  });
});
