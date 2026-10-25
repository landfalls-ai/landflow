/** End-to-end: the same plugin over the HTTP and gRPC bindings of the TS SDK. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, manifestSchema, type ExecuteRequest, type PluginManifest } from '@landflow/protocol';
import {
  executeRequestToMsg,
  executeResponseFromMsg,
  grpc,
  loadLandflowProto,
  manifestFromMsg,
  unary,
  type ExecuteResponseMsg,
  type ManifestMsg,
} from '@landflow/protocol/grpc';
import { createFetchHandler } from '@landflow/sdk/http';
import { serveGrpc } from '@landflow/sdk/grpc';
import { createTelemetry } from '@landflow/sdk/telemetry';
import { plugin } from '../src/main';

const request = (type: string, parameters: Record<string, unknown>, items: Record<string, unknown>[]): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'ex1',
  mode: 'manual',
  node: { id: 'n1', name: 'Node', type, typeVersion: 1 },
  parameters: parameters as never,
  itemParameters: items.map(() => parameters as never),
  inputs: [items.map((json) => ({ json: json as never }))],
});

/** file: icons arrive as SVG data: URLs and the plugin colour survives the transport. */
function expectInlinedIcons(manifest: PluginManifest) {
  expect(manifest.plugin.color).toBe('#2563eb');
  for (const icon of [manifest.plugin.icon, ...manifest.nodes.map((n) => n.icon)]) expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(JSON.stringify(manifest)).not.toContain('file:');
}

describe('HTTP binding', () => {
  const handle = createFetchHandler(plugin);
  const call = (path: string, body?: unknown) =>
    handle(new Request(`http://plugin${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined));

  it('serves a valid manifest and well-known doc', async () => {
    const manifest = await (await call(HTTP_PATHS.manifest)).json();
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expectInlinedIcons(manifest);
    expect((await (await call(HTTP_PATHS.wellKnown)).json()).plugin.id).toBe('text-toolkit');
  });

  it('executes a node with pairedItem filled in', async () => {
    const response = await (await call(HTTP_PATHS.execute, request('text-toolkit.slugify', { field: 'title' }, [{ title: 'Héllo Wörld!' }]))).json();
    expect(response.outputs[0][0]).toEqual({ json: { title: 'Héllo Wörld!', slug: 'hello-world' }, pairedItem: { item: 0 } });
  });

  it('returns node errors in the body, not as HTTP errors', async () => {
    const res = await call(HTTP_PATHS.execute, request('text-toolkit.slugify', { field: 'missing' }, [{ title: 'x' }]));
    expect(res.status).toBe(200);
    expect((await res.json()).error).toMatchObject({ message: 'Field "missing" is not a string', itemIndex: 0 });
  });

  it('rejects malformed and unknown requests', async () => {
    expect((await handle(new Request(`http://plugin${HTTP_PATHS.execute}`, { method: 'POST', body: '{' }))).status).toBe(400);
    expect((await call(HTTP_PATHS.execute, request('text-toolkit.nope', {}, []))).status).toBe(404);
  });
});

describe('gRPC binding', () => {
  let server: grpc.Server;
  let client: grpc.Client;

  beforeAll(async () => {
    server = await serveGrpc(plugin, { port: 0 + 47201, host: '127.0.0.1' });
    const proto = loadLandflowProto();
    client = new proto.PluginService('127.0.0.1:47201', grpc.credentials.createInsecure());
  });
  afterAll(() => {
    client.close();
    server.forceShutdown();
  });

  it('returns the manifest, brand colour included', async () => {
    const msg = await unary<object, ManifestMsg>(client, 'GetManifest', {}, 2000);
    const manifest = manifestSchema.parse(manifestFromMsg(msg));
    expectInlinedIcons(manifest);
  });

  it('executes a node', async () => {
    const msg = await unary<object, ExecuteResponseMsg>(
      client,
      'Execute',
      executeRequestToMsg(request('text-toolkit.changeCase', { field: 'name', case: 'snake' }, [{ name: 'Hello Big World' }])),
      2000,
    );
    expect(executeResponseFromMsg(msg).outputs[0][0].json).toEqual({ name: 'hello_big_world' });
  });

  it('maps unknown nodes to NOT_FOUND', async () => {
    await expect(
      unary(client, 'Execute', executeRequestToMsg(request('text-toolkit.nope', {}, [])), 2000),
    ).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });
});

describe('telemetry', () => {
  it('records the Slugify child span and the slugs metric', async () => {
    const lines: string[] = [];
    const telemetry = await createTelemetry({ pluginId: 'text-toolkit', env: {}, logWriter: (line) => lines.push(line) });
    const handle = createFetchHandler(plugin, { telemetry });
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await handle(
      new Request(`http://plugin${HTTP_PATHS.execute}`, {
        method: 'POST',
        headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
        body: JSON.stringify(request('text-toolkit.slugify', { field: 'title' }, [{ title: 'A b' }, { title: 'C d' }])),
      }),
    );
    const spans = lines.map((line) => JSON.parse(line)).filter((line) => line.msg === 'span.end');
    const server = spans.find((s) => s.span === 'plugin.execute text-toolkit.slugify');
    const child = spans.find((s) => s.span === 'text_toolkit.slugify');
    expect(server).toMatchObject({ trace_id: traceId, parent_span_id: '00f067aa0ba902b7', kind: 'server' });
    expect(child).toMatchObject({ trace_id: traceId, parent_span_id: server.span_id, attributes: { 'text_toolkit.items': 2, 'text_toolkit.separator': '-' } });
    const metrics = await (await handle(new Request('http://plugin/metrics'))).text();
    expect(metrics).toMatch(/text_toolkit_slugs_produced_total\{[^}]*text_toolkit_separator="-"[^}]*\} 2/);
    expect(metrics).toContain('landflow_plugin_executions_total{landflow_node_type="text-toolkit.slugify",landflow_node_status="success"');
    await telemetry.shutdown();
  });
});
