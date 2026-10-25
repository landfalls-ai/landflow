/** Trace propagation, server/client spans, /metrics, the process log and redaction over both transports. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { HTTP_PATHS } from '@landflow/protocol';
import { executeRequestToMsg, executeResponseFromMsg, grpc, loadLandflowProto, type ExecuteResponseMsg } from '@landflow/protocol/grpc';
import { defineNode, definePlugin, runNode, REDACTED, registerSecrets, scrub } from '../src';
import { serveGrpc } from '../src/grpc';
import { createFetchHandler } from '../src/http';
import { secretValues } from '../src/redact';
import { createTelemetry, prometheusUnitSuffix, type Telemetry } from '../src/telemetry';
import { demoPlugin, executeRequest, PARENT_SPAN_ID, startFakeApi, TOKEN, TRACE_ID, TRACEPARENT, type FakeApi } from './fixtures';

const GRPC_PORT = 47331;

let api: FakeApi;
let telemetry: Telemetry;
const exporter = new InMemorySpanExporter();
const lines: string[] = [];
const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const span = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name);
const childOf = (s: ReadableSpan, parent: ReadableSpan) => s.parentSpanContext?.spanId === parent.spanContext().spanId;

beforeAll(async () => {
  api = await startFakeApi();
  telemetry = await createTelemetry({ pluginId: 'demo', pluginVersion: '1.0.0', env: {}, spanExporters: [exporter], logWriter: (line) => lines.push(line) });
});
afterAll(async () => {
  await telemetry.shutdown();
  await api.close();
});
beforeEach(() => {
  exporter.reset();
  lines.length = 0;
  api.requests.length = 0;
});

describe('HTTP binding', () => {
  const handle = createFetchHandler(demoPlugin);
  const traced = () => createFetchHandler(demoPlugin, { telemetry });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    traced()(new Request(`http://plugin${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

  it('continues the traceparent: server span → child span → HTTP client span → traceparent sent out', async () => {
    const res = await post(HTTP_PATHS.execute, executeRequest('echo', {}, api.url), { traceparent: TRACEPARENT });
    const body = await res.json();
    expect(body.outputs[0]).toHaveLength(2);
    expect(body.outputs[0][0].json).toMatchObject({ status: 200, sameCredential: true });

    const server = span('plugin.execute demo.echo')!;
    expect(server.kind).toBe(SpanKind.SERVER);
    expect(server.spanContext().traceId).toBe(TRACE_ID);
    expect(server.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(server.attributes).toMatchObject({
      'landflow.plugin.id': 'demo',
      'landflow.node.type': 'demo.echo',
      'landflow.node.name': 'My node',
      'landflow.workflow.id': 'wf_1',
      'landflow.execution.id': 'ex_1',
      'landflow.execution.mode': 'manual',
      'landflow.items.in': 2,
      'landflow.items.out': 2,
      'rpc.system': 'http',
    });
    expect(server.resource.attributes).toMatchObject({
      'service.name': 'landflow-plugin-demo',
      'service.version': '1.0.0',
      'service.namespace': 'landflow',
      'landflow.plugin.id': 'demo',
      'landflow.plugin.language': 'typescript',
    });

    const work = span('demo.work')!;
    expect(childOf(work, server)).toBe(true);
    expect(work.attributes['demo.items']).toBe(2);
    expect(work.kind).toBe(SpanKind.INTERNAL);
    expect(span('demo.smtp')!.kind).toBe(SpanKind.CLIENT);
    expect(childOf(span('demo.smtp')!, work)).toBe(true);

    const client = span('HTTP GET')!;
    expect(client.kind).toBe(SpanKind.CLIENT);
    expect(childOf(client, work)).toBe(true);
    expect(client.attributes).toMatchObject({
      'http.request.method': 'GET',
      'server.address': '127.0.0.1',
      'url.full': `${api.url}/bot${REDACTED}/ping`,
      'http.response.status_code': 200,
    });
    expect(api.requests[0].headers.traceparent).toBe(`00-${TRACE_ID}-${client.spanContext().spanId}-01`);
  });

  it('writes node logs and span.end lines with trace ids, never the credential', async () => {
    await post(HTTP_PATHS.execute, executeRequest('echo', {}, api.url), { traceparent: TRACEPARENT });
    expect(lines.join('\n')).not.toContain(TOKEN);
    const entries = logs();
    const nodeLog = entries.find((l) => String(l.msg).startsWith('calling with'))!;
    expect(nodeLog).toMatchObject({
      level: 'info',
      service: 'landflow-plugin-demo',
      msg: `calling with ${REDACTED}`,
      trace_id: TRACE_ID,
      span_id: span('demo.work')!.spanContext().spanId,
      authorization: REDACTED,
      'demo.status': 200,
      'landflow.node.type': 'demo.echo',
      'landflow.execution.id': 'ex_1',
    });
    const end = entries.find((l) => l.msg === 'span.end' && l.span === 'plugin.execute demo.echo')!;
    expect(end).toMatchObject({ level: 'info', kind: 'server', trace_id: TRACE_ID, parent_span_id: PARENT_SPAN_ID, status: 'ok' });
    expect(typeof end.duration_ms).toBe('number');
    // set by node code with span.setAttribute: redacted by the span processor
    expect(span('demo.work')!.attributes['demo.api_key']).toBe(REDACTED);
  });

  it('marks failed executions: error status, exception event, error log line, redacted message', async () => {
    const body = await (await post(HTTP_PATHS.execute, executeRequest('fail'), { traceparent: TRACEPARENT })).json();
    expect(body.error.message).toBe(`rejected token ${REDACTED}`);
    const server = span('plugin.execute demo.fail')!;
    expect(server.status).toEqual({ code: SpanStatusCode.ERROR, message: `rejected token ${REDACTED}` });
    const exception = server.events.find((e) => e.name === 'exception')!;
    expect(exception.attributes?.['exception.message']).toBe(`rejected token ${REDACTED}`);
    expect(JSON.stringify(server.events)).not.toContain(TOKEN);
    expect(logs().find((l) => l.span === 'plugin.execute demo.fail')).toMatchObject({ level: 'error', status: 'error', error: `rejected token ${REDACTED}` });
  });

  it('traces load options and test credentials', async () => {
    const credentials = { demoApi: { accessToken: TOKEN } };
    await post(HTTP_PATHS.loadOptions, { nodeType: 'picker', method: 'channels', parameters: {}, credentials }, { traceparent: TRACEPARENT });
    const loadOptions = span('plugin.load_options channels')!;
    expect(loadOptions.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(loadOptions.attributes).toMatchObject({ 'landflow.plugin.id': 'demo', 'landflow.node.type': 'demo.picker', 'landflow.load_options.method': 'channels' });

    await post(HTTP_PATHS.testCredentials, { credentialType: 'demoApi', data: { accessToken: 'wrong-token', baseUrl: api.url } }, { traceparent: TRACEPARENT });
    const test = span('plugin.test_credentials demoApi')!;
    expect(test.kind).toBe(SpanKind.SERVER);
    expect(test.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(test.attributes).toMatchObject({ 'landflow.plugin.id': 'demo', 'landflow.credential.type': 'demoApi', 'landflow.credential.ok': false });
    expect(span('HTTP GET')!.parentSpanContext?.spanId).toBe(test.spanContext().spanId);
  });

  it('opens no spans for health, manifest and well-known', async () => {
    const h = traced();
    for (const path of [HTTP_PATHS.health, HTTP_PATHS.manifest, HTTP_PATHS.wellKnown, '/metrics']) await h(new Request(`http://plugin${path}`));
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('serves Prometheus text with the plugin and custom metrics', async () => {
    await post(HTTP_PATHS.execute, executeRequest('echo', {}, api.url));
    await post(HTTP_PATHS.execute, executeRequest('fail'));
    await post(HTTP_PATHS.loadOptions, { nodeType: 'picker', method: 'channels', credentials: { demoApi: { accessToken: TOKEN } } });
    await post(HTTP_PATHS.loadOptions, { nodeType: 'picker', method: 'nope' });
    const res = await traced()(new Request('http://plugin/metrics'));
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    for (const expected of [
      'landflow_plugin_executions_total{',
      'landflow_node_type="demo.echo",landflow_node_status="success"',
      'landflow_node_type="demo.fail",landflow_node_status="error"',
      'landflow_plugin_execute_duration_milliseconds_bucket{',
      'le="60000"',
      'landflow_plugin_items_total{',
      'landflow_direction="out"',
      'landflow_plugin_load_options_total{',
      'landflow_load_options_method="channels",landflow_outcome="ok"',
      'landflow_load_options_method="nope",landflow_outcome="error"',
      'http_client_request_duration_seconds_bucket{',
      'demo_items_processed_total{',
      'landflow_plugin_id="demo"',
      'landflow_workflow_id="wf_1"',
      'demo_work_duration_milliseconds_bucket{',
      'demo_queue_depth{',
      'target_info{',
      'service_name="landflow-plugin-demo"',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain(TOKEN);
  });

  it('falls back to passive telemetry (no process log, no /metrics) when none is configured', async () => {
    const res = await handle(new Request('http://plugin/metrics'));
    expect(res.status).toBe(404);
  });
});

describe('gRPC binding', () => {
  let server: grpc.Server;
  let client: grpc.Client;
  const call = <T>(method: string, request: unknown, metadata = new grpc.Metadata()) =>
    new Promise<T>((resolve, reject) =>
      (client as unknown as Record<string, Function>)[method](request, metadata, { deadline: Date.now() + 3000 }, (error: Error | null, response: T) =>
        error ? reject(error) : resolve(response),
      ),
    );

  beforeAll(async () => {
    server = await serveGrpc(demoPlugin, { port: GRPC_PORT, host: '127.0.0.1', telemetry });
    client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
  });
  afterAll(() => {
    client.close();
    server.forceShutdown();
  });

  it('continues the trace from gRPC metadata', async () => {
    const metadata = new grpc.Metadata();
    metadata.set('traceparent', TRACEPARENT);
    metadata.set('baggage', 'landflow.tenant=t1');
    const msg = await call<ExecuteResponseMsg>('Execute', executeRequestToMsg(executeRequest('echo', {}, api.url)), metadata);
    expect(executeResponseFromMsg(msg).outputs[0]).toHaveLength(2);
    const server = span('plugin.execute demo.echo')!;
    expect(server.kind).toBe(SpanKind.SERVER);
    expect(server.spanContext().traceId).toBe(TRACE_ID);
    expect(server.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(server.attributes['rpc.system']).toBe('grpc');
    const client = span('HTTP GET')!;
    expect(client.spanContext().traceId).toBe(TRACE_ID);
    expect(api.requests[0].headers.traceparent).toBe(`00-${TRACE_ID}-${client.spanContext().spanId}-01`);
    expect(api.requests[0].headers.baggage).toBe('landflow.tenant=t1');
  });

  it('starts a new trace without metadata', async () => {
    await call<ExecuteResponseMsg>('Execute', executeRequestToMsg(executeRequest('echo', {}, api.url)));
    const server = span('plugin.execute demo.echo')!;
    expect(server.parentSpanContext).toBeUndefined();
    expect(server.spanContext().traceId).not.toBe(TRACE_ID);
  });
});

describe('OTEL_SDK_DISABLED', () => {
  it('turns spans and metrics into no-ops but keeps logs with the caller trace id', async () => {
    const disabledExporter = new InMemorySpanExporter();
    const out: string[] = [];
    const env = { OTEL_SDK_DISABLED: 'true' };
    const off = await createTelemetry({ pluginId: 'demo', env, spanExporters: [disabledExporter], logWriter: (l) => out.push(l) });
    const handle = createFetchHandler(demoPlugin, { telemetry: off });
    const res = await handle(
      new Request(`http://plugin${HTTP_PATHS.execute}`, { method: 'POST', headers: { traceparent: TRACEPARENT }, body: JSON.stringify(executeRequest('echo', {}, api.url)) }),
    );
    expect((await res.json()).outputs[0]).toHaveLength(2);
    expect(disabledExporter.getFinishedSpans()).toHaveLength(0);
    expect((await handle(new Request('http://plugin/metrics'))).status).toBe(404);
    const nodeLog = out.map((l) => JSON.parse(l)).find((l) => String(l.msg).startsWith('calling with'));
    expect(nodeLog).toMatchObject({ trace_id: TRACE_ID, msg: `calling with ${REDACTED}` });
    // the HTTP call still carries the caller's context
    expect(api.requests.at(-1)!.headers.traceparent).toContain(TRACE_ID);
  });
});

describe('custom metrics', () => {
  const metricsNode = (record: (ctx: Parameters<NonNullable<ReturnType<typeof defineNode>['execute']>>[0]) => void) =>
    defineNode({
      description: { name: 'm', displayName: 'M', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
      execute(ctx) {
        record(ctx);
        return [];
      },
    });
  const request = executeRequest('m', { credentials: undefined });

  it('rejects invalid names', async () => {
    const response = await runNode(metricsNode((ctx) => ctx.metrics.counter('Bad-Name').add(1)), request, { telemetry });
    expect(response.error?.message).toMatch(/Invalid metric name "Bad-Name"/);
  });

  it('truncates values and folds attribute sets past 1000 into otel.metric.overflow', async () => {
    const t = await createTelemetry({ pluginId: 'demo', env: { LANDFLOW_LOG_SPANS: 'false' }, logWriter: () => {} });
    const node = metricsNode((ctx) => {
      const counter = ctx.metrics.counter('demo.users.seen');
      for (let i = 0; i < 1100; i++) counter.add(1, { 'demo.user': `user-${i}` });
      ctx.metrics.counter('demo.long.values').add(1, { 'demo.value': 'x'.repeat(250) });
    });
    await runNode(node, request, { telemetry: t, pluginId: 'demo' });
    const text = (await t.scrapeMetrics())!;
    const seen = text.split('\n').filter((l) => l.startsWith('demo_users_seen_total{'));
    expect(seen).toHaveLength(1001);
    expect(seen.find((l) => l.includes('otel_metric_overflow="true"'))).toMatch(/ 100$/);
    expect(text).toContain(`demo_value="${'x'.repeat(100)}"`);
    expect(text).not.toContain('x'.repeat(101));
    await t.shutdown();
  });

  it('maps units to Prometheus suffixes', () => {
    expect(prometheusUnitSuffix('ms')).toBe('milliseconds');
    expect(prometheusUnitSuffix('By')).toBe('bytes');
    expect(prometheusUnitSuffix('{message}')).toBeUndefined();
    expect(prometheusUnitSuffix('1')).toBeUndefined();
    expect(prometheusUnitSuffix('By/s')).toBe('bytes_per_second');
  });
});

describe('redaction helpers', () => {
  it('scrubs registered secrets (raw and URL-encoded) until released', () => {
    const release = registerSecrets(['s3cr3t value', 'ab']);
    expect(scrub('x s3cr3t value y')).toBe(`x ${REDACTED} y`);
    expect(scrub('q=s3cr3t%20value')).toBe(`q=${REDACTED}`);
    expect(scrub('ab stays')).toBe('ab stays');
    release();
    expect(scrub('x s3cr3t value y')).toBe('x s3cr3t value y');
  });

  it('treats password and secret-named fields as secrets for declared types, every string otherwise', () => {
    const properties = [
      { name: 'accessToken', displayName: '', type: 'string' as const, typeOptions: { password: true } },
      { name: 'baseUrl', displayName: '', type: 'string' as const },
      { name: 'clientSecret', displayName: '', type: 'string' as const },
    ];
    const data = { accessToken: 'tok-1', baseUrl: 'https://x', clientSecret: 'sec-1', oauth: { access_token: 'nested-1', scope: 'read' } };
    expect(secretValues(data, properties).sort()).toEqual(['nested-1', 'sec-1', 'tok-1']);
    expect(secretValues({ user: 'admin', host: 'db' })).toEqual(['admin', 'db']);
  });

  it('keeps the in-process path working without any telemetry', async () => {
    const plugin = definePlugin({ info: { id: 'p', name: 'P', version: '1' }, nodes: [demoPlugin.nodes[0]], credentialTypes: [...demoPlugin.credentialTypes!] });
    const response = await runNode(plugin.nodes[0], executeRequest('echo', {}, api.url));
    expect(response.error).toBeUndefined();
    expect(response.logs).toEqual([{ level: 'info', message: `calling with ${REDACTED}` }]);
  });
});
