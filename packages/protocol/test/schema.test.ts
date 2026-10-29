import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { announceRequestSchema, manifestSchema, parseManifest, type PluginManifest } from '../src';
import { manifestFromMsg, manifestToMsg } from '../src/grpc';

const manifestsDir = join(import.meta.dirname, 'fixtures', 'manifests');
const bundled = readdirSync(manifestsDir).map((file) => JSON.parse(readFileSync(join(manifestsDir, file), 'utf8')) as PluginManifest);

const minimal = (): PluginManifest => ({
  protocol: 'landflow.plugin/v1',
  plugin: { id: 'p', name: 'P', version: '1.0.0', language: 'typescript' },
  nodes: [{ name: 'n', displayName: 'N', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] }],
});

describe('manifest schema: backward compatible', () => {
  it('still validates every bundled plugin manifest (no new field is required)', () => {
    expect(bundled.length).toBe(10);
    for (const manifest of bundled) expect(parseManifest(manifest), manifest.plugin.id).toMatchObject({ ok: true });
  });

  it('accepts the transport hints and the MCP fields', () => {
    const manifest = minimal();
    manifest.transports = ['http', 'grpc', 'kafka', 'mcp'];
    manifest.maxConcurrency = 8;
    manifest.nodes[0].idempotent = true;
    manifest.nodes[0].mcp = false;
    manifest.nodes[0].outputSchema = { type: 'object' };
    manifest.nodes[0].toolAnnotations = { readOnlyHint: true, openWorldHint: false };
    manifest.nodes[0].properties = [
      { name: 'operation', displayName: 'Operation', type: 'options', default: 'get', options: [{ name: 'Get', value: 'get', idempotent: true, mcp: false, outputSchema: {}, toolAnnotations: { destructiveHint: false } }] },
    ];
    const parsed = manifestSchema.safeParse(manifest);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('rejects bad hints', () => {
    expect(manifestSchema.safeParse({ ...minimal(), transports: ['Kafka!'] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...minimal(), maxConcurrency: 0 }).success).toBe(false);
    const manifest = minimal();
    (manifest.nodes[0] as { mcp?: unknown }).mcp = true; // only `false` is meaningful
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
});

describe('announce endpoint', () => {
  it('accepts direct and brokered endpoints', () => {
    const base = { protocol: 'landflow.plugin/v1', pluginId: 'p', version: '1' };
    for (const endpoint of ['http://127.0.0.1:7101', 'grpc://127.0.0.1:7203', 'kafka://kafka-main/twilio', 'NATS://nats-1/p']) {
      expect(announceRequestSchema.safeParse({ ...base, endpoint }).success, endpoint).toBe(true);
    }
    for (const endpoint of ['twilio', 'kafka://conn', 'kafka://conn/p/x', '127.0.0.1:7101']) {
      expect(announceRequestSchema.safeParse({ ...base, endpoint }).success, endpoint).toBe(false);
    }
  });
});

describe('gRPC manifest message', () => {
  it('carries the hints and leaves them out when absent', () => {
    const manifest = { ...minimal(), transports: ['http', 'kafka'], maxConcurrency: 4 };
    const msg = manifestToMsg(manifest);
    expect(msg.transports).toEqual(['http', 'kafka']);
    expect(msg.maxConcurrency).toBe(4);
    expect(manifestFromMsg(msg)).toMatchObject({ transports: ['http', 'kafka'], maxConcurrency: 4 });

    const plain = manifestToMsg(minimal());
    expect(plain).toMatchObject({ transports: [], maxConcurrency: 0 });
    const back = manifestFromMsg(plain) as Record<string, unknown>;
    expect('transports' in back).toBe(false);
    expect('maxConcurrency' in back).toBe(false);
    // An older plugin's message has neither field at all.
    const { transports: _t, maxConcurrency: _m, ...old } = plain;
    expect(parseManifest(manifestFromMsg(old as typeof plain))).toMatchObject({ ok: true });
  });
});
