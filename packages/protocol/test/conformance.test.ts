import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src';
import {
  CONFORMANCE_KIT,
  conformanceExecuteInput,
  listConformanceSuites,
  loadConformancePluginManifest,
  loadConformanceSuite,
  loadConformanceSuites,
  loadMcpToolsFixture,
  outputsMatch,
  TRANSPORT_ERROR_CODES,
} from '../conformance';

describe('conformance kit', () => {
  it('lists the behavioural suites', () => {
    expect(listConformanceSuites()).toEqual(['cancellation', 'deadlines', 'delivery-modes', 'errors', 'size-limits']);
  });

  it('loads well-formed suites whose cases are unique and reference conformance plugin nodes', () => {
    const manifest = loadConformancePluginManifest();
    expect(parseManifest(manifest)).toMatchObject({ ok: true });
    const nodes = new Set(manifest.nodes.map((n) => n.name));
    for (const suite of loadConformanceSuites()) {
      expect(suite.kit).toBe(CONFORMANCE_KIT);
      const ids = suite.cases.map((c) => c.id);
      expect(new Set(ids).size, suite.suite).toBe(ids.length);
      for (const c of suite.cases) {
        const outcomes = Array.isArray(c.expect.outcome) ? c.expect.outcome : [c.expect.outcome];
        for (const outcome of outcomes) expect(['reply', 'node-error', 'transport-error', 'no-reply'], `${suite.suite}/${c.id}`).toContain(outcome);
        if (c.expect.code) expect(TRANSPORT_ERROR_CODES, `${suite.suite}/${c.id}`).toContain(c.expect.code);
        if (c.call.method === 'execute' && c.id !== 'unknown-node') expect(nodes.has(c.call.node!), `${suite.suite}/${c.id}: node ${c.call.node}`).toBe(true);
        if (outcomes.includes('transport-error') && !outcomes.includes('reply')) expect(c.expect.code, `${suite.suite}/${c.id} needs a code`).toBeDefined();
      }
    }
  });

  it('filters by face', () => {
    const messaging = loadConformanceSuites('messaging').flatMap((s) => s.cases.map((c) => c.id));
    const http = loadConformanceSuites('http').flatMap((s) => s.cases.map((c) => c.id));
    expect(messaging).toContain('bad-signature');
    expect(http).not.toContain('bad-signature');
    expect(loadConformanceSuites('http').map((s) => s.suite)).not.toContain('delivery-modes');
    expect(loadConformanceSuite('deadlines').cases.length).toBeGreaterThan(2);
  });

  it('derives execute input from a case, padding when asked', () => {
    const manifest = loadConformancePluginManifest();
    const input = conformanceExecuteInput(manifest, { method: 'execute', node: 'echo', parameters: { message: 'a' }, padBytes: 10 });
    expect(input.node).toEqual({ id: 'n-echo', name: 'Echo', type: 'landflow-conformance.echo', typeVersion: 1 });
    expect(input.parameters.message).toBe('axxxxxxxxx');
    expect(input.items).toEqual([{ json: {} }]);
  });

  it('matches outputs as subsets', () => {
    expect(outputsMatch([[{ json: { a: 1 } }]], [[{ json: { a: 1, b: 2 } }]])).toBe(true);
    expect(outputsMatch([[{ json: { a: 1 } }]], [[{ json: { a: 2 } }]])).toBe(false);
    expect(outputsMatch([[{ json: {} }]], [[]])).toBe(false);
    expect(outputsMatch(undefined, [])).toBe(true);
  });

  it('has an MCP fixture with every synthetic manifest', () => {
    const fixture = loadMcpToolsFixture();
    expect(fixture.cases.map((c) => c.id)).toEqual(['crm-suite', 'twilio', 'utilities']);
    for (const c of fixture.cases) expect(parseManifest(c.manifest), c.id).toMatchObject({ ok: true });
  });
});
