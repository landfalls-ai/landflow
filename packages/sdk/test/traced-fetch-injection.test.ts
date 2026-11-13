/** `ContextExtras.fetch` (the host's guarded fetch) is what `ctx.http` calls, and the client span and trace headers stay. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { echo, executeRequest, startFakeApi, type FakeApi } from './fixtures';
import { runNode } from '../src';
import { createTelemetry, type Telemetry } from '../src/telemetry';
import { createTracedFetch } from '../src/instrumentation';

let api: FakeApi;
let telemetry: Telemetry;
const exporter = new InMemorySpanExporter();

beforeAll(async () => {
  api = await startFakeApi();
  telemetry = await createTelemetry({ pluginId: 'demo', pluginVersion: '1.0.0', env: {}, spanExporters: [exporter], logWriter: () => undefined });
});
afterAll(async () => {
  await telemetry.shutdown();
  await api.close();
});
beforeEach(() => {
  exporter.reset();
  api.requests.length = 0;
});

describe('injected fetch', () => {
  it('ctx.http calls the injected fetch instead of the global one, and still records the client span', async () => {
    const seen: string[] = [];
    const injected: typeof fetch = async (input, init) => {
      seen.push(String(input));
      return new Response('{}', { status: 203, headers: init?.headers });
    };
    const response = await runNode(echo, executeRequest('echo', {}, api.url), { telemetry, fetch: injected });
    expect(response.outputs[0][0].json).toMatchObject({ status: 203 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/ping');
    expect(api.requests).toHaveLength(0); // nothing went to the real server
    const client = exporter.getFinishedSpans().find((s) => s.name === 'HTTP GET')!;
    expect(client.kind).toBe(SpanKind.CLIENT);
    expect(client.attributes['http.response.status_code']).toBe(203);
  });

  it('a refusal thrown by the injected fetch is recorded on the span and reaches the caller', async () => {
    const traced = createTracedFetch(telemetry, {
      fetch: async () => {
        throw new Error('Blocked: 127.0.0.1 resolves to a private address');
      },
    });
    await expect(traced('http://127.0.0.1:9/x?token=abc')).rejects.toThrow(/Blocked/);
    const client = exporter.getFinishedSpans().find((s) => s.name === 'HTTP GET')!;
    expect(client.status.code).toBe(SpanStatusCode.ERROR);
    expect(client.attributes['url.full']).toBe('http://127.0.0.1:9/x');
  });

  it('without an injected fetch the global one is used', async () => {
    const response = await runNode(echo, executeRequest('echo', {}, api.url), { telemetry });
    expect(response.outputs[0][0].json).toMatchObject({ status: 200 });
    expect(api.requests).toHaveLength(1);
  });
});
