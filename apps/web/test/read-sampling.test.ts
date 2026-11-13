import { describe, expect, it } from 'vitest';
import { context, SpanKind, trace } from '@opentelemetry/api';
import { AlwaysOnSampler, ParentBasedSampler, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace';

// Reads are kept only when slow (here 1000 ms by default) or when they fail with a 5xx.
const { LandflowSampler, LandflowSpanProcessor } = await import('@/lib/server/telemetry/processors');

function setup(slowMs = 1000) {
  const exported: ReadableSpan[] = [];
  const downstream = { onStart() {}, onEnd: (span: ReadableSpan) => void exported.push(span), forceFlush: async () => {}, shutdown: async () => {} };
  const provider = new TracerProvider({
    sampler: new LandflowSampler(new ParentBasedSampler({ root: new AlwaysOnSampler() })),
    spanProcessors: [new LandflowSpanProcessor([downstream], slowMs)],
  });
  const tracer = provider.getTracer('test');
  /** One request: a server span with a child (a db.query), lasting `ms`, with an HTTP status. */
  function request(method: string, path: string, ms: number, status = 200) {
    const start = Date.now() - ms;
    const server = tracer.startSpan('GET', { kind: SpanKind.SERVER, startTime: start, attributes: { 'next.span_type': 'BaseServer.handleRequest', 'http.method': method, 'http.target': path } });
    const child = tracer.startSpan('db.query', {}, trace.setSpan(context.active(), server));
    child.end();
    server.setAttribute('http.status_code', status);
    server.end();
    return server;
  }
  const names = () => exported.map((span) => span.name);
  return { request, exported, names };
}

describe('read sampling', () => {
  it('drops a fast GET and its child spans', () => {
    const { request, exported } = setup();
    request('GET', '/api/workflows', 12);
    expect(exported).toHaveLength(0);
  });

  it('keeps a slow GET with its children, in one trace', () => {
    const { request, exported } = setup();
    const server = request('GET', '/api/workflows', 1500);
    expect(exported.map((span) => span.name)).toEqual(['db.query', 'GET']);
    expect(new Set(exported.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(exported[1].spanContext().spanId).toBe(server.spanContext().spanId);
  });

  it('keeps a failed GET however fast, and a 4xx is not a failure', () => {
    const { request, exported } = setup();
    request('GET', '/api/workflows', 5, 503);
    expect(exported).toHaveLength(2);
    request('GET', '/api/workflows', 5, 404);
    expect(exported).toHaveLength(2);
  });

  it('honours the threshold it is given', () => {
    const { request, exported } = setup(10);
    request('GET', '/api/runs', 50);
    expect(exported).toHaveLength(2);
  });

  it('always keeps writes, and leaves polled paths and pages unsampled', () => {
    const { request, exported } = setup();
    request('POST', '/api/workflows', 3);
    expect(exported).toHaveLength(2);
    request('GET', '/api/events', 5000);
    request('GET', '/workflows', 5000);
    expect(exported).toHaveLength(2);
  });

  describe('by descent', () => {
    function build(slowMs = 1000) {
      const exported: ReadableSpan[] = [];
      const downstream = { onStart() {}, onEnd: (span: ReadableSpan) => void exported.push(span), forceFlush: async () => {}, shutdown: async () => {} };
      const provider = new TracerProvider({
        sampler: new LandflowSampler(new ParentBasedSampler({ root: new AlwaysOnSampler() })),
        spanProcessors: [new LandflowSpanProcessor([downstream], slowMs)],
      });
      const tracer = provider.getTracer('test');
      const get = (parent: ReturnType<typeof tracer.startSpan>, startTime = Date.now()) =>
        tracer.startSpan('GET', { kind: SpanKind.SERVER, startTime, attributes: { 'next.span_type': 'BaseServer.handleRequest', 'http.method': 'GET', 'http.target': '/api/binary/x' } }, trace.setSpan(context.active(), parent));
      const child = (parent: ReturnType<typeof tracer.startSpan>, name: string) => tracer.startSpan(name, {}, trace.setSpan(context.active(), parent));
      return { tracer, exported, get, child, names: () => exported.map((span) => span.name) };
    }

    it('keeps a sibling of a read that ends while the read is in flight', () => {
      const { tracer, exported, get, child } = build();
      const run = tracer.startSpan('workflow.execute');
      const a = child(run, 'node.execute A');
      const read = get(a);
      const b = child(run, 'node.execute B');
      b.end();
      const inner = child(read, 'db.query');
      inner.end();
      read.setAttribute('http.status_code', 200);
      read.end();
      a.end();
      run.end();
      expect(exported.map((span) => span.name).sort()).toEqual(['node.execute A', 'node.execute B', 'workflow.execute']);
    });

    it('decides two concurrent reads in one trace separately', () => {
      const { tracer, exported, get, child } = build();
      const run = tracer.startSpan('workflow.execute');
      const slow = get(run, Date.now() - 2000);
      const fast = get(run);
      child(slow, 'slow.child').end();
      child(fast, 'fast.child').end();
      fast.setAttribute('http.status_code', 200);
      fast.end();
      slow.setAttribute('http.status_code', 200);
      slow.end();
      run.end();
      expect(exported.map((span) => span.name).sort()).toEqual(['GET', 'slow.child', 'workflow.execute']);
    });

    it('lets a child that ends after a read follow its verdict', () => {
      const { tracer, exported, get, child } = build();
      const run = tracer.startSpan('workflow.execute');
      const fast = get(run);
      const lateFast = child(fast, 'late.fast');
      fast.setAttribute('http.status_code', 200);
      fast.end();
      lateFast.end();
      expect(exported).toHaveLength(0);
      const slow = get(run, Date.now() - 2000);
      const lateSlow = child(slow, 'late.slow');
      slow.setAttribute('http.status_code', 200);
      slow.end();
      lateSlow.end();
      expect(exported.map((span) => span.name).sort()).toEqual(['GET', 'late.slow']);
    });
  });
});
