/**
 * Wave ag3 carryover (the live pass, triage agent): a credential-less plugin tool's via line read "triage plugin · Normalize
 * Alert" without where the plugin answers, because the line shows the system and drops the plugin part. With no URL or file
 * of its own, the call goes to the plugin: the target's endpoint is the plugin's ("… · Normalize Alert 127.0.0.1:7798");
 * a URL the parameters name still wins, and a builtin plugin with no endpoint gets none.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-plugin-target-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { targetOfNode } = await import('@/lib/server/agents/tool-target');
const { targetLine } = await import('@/lib/shared/tool-target');
const { plugin: triage } = await import('../../../plugins/triage/src/main');

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(triage);
});
afterEach(() => vi.restoreAllMocks());

const answeringAt = (endpoint: string) => {
  const real = registry.list.bind(registry);
  vi.spyOn(registry, 'list').mockImplementation(() => real().map((p) => (p.id === 'triage' ? { ...p, activeEndpoint: endpoint } : p)) as never);
};

describe("a plugin tool's target says where the plugin answers", () => {
  it('names the plugin endpoint, never its scheme or path', () => {
    answeringAt('grpc://127.0.0.1:7798/landflow');
    const t = targetOfNode('triage.normalizeAlert', undefined, {});
    expect(t).toMatchObject({ name: 'triage plugin', system: 'Normalize Alert', endpoint: '127.0.0.1:7798', plugin: { id: 'triage', endpoint: '127.0.0.1:7798' } });
    expect(targetLine(t)).toBe('triage plugin · Normalize Alert 127.0.0.1:7798');
  });

  it('a builtin plugin with no endpoint gets none', () => {
    const t = targetOfNode('triage.normalizeAlert', undefined, {});
    expect(t.endpoint).toBeUndefined();
    expect(targetLine(t)).toBe('triage plugin · Normalize Alert');
  });
});
