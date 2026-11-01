/**
 * The AI builder's sample items (lib/server/flow-builder.ts): pinned on the Manual Trigger for test runs, and one only when
 * the flow runs an agent or a team, since each item is a whole agent run.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFakeModels } from './fake-ai-services';

let answer = '{}';
const fake = await startFakeModels({ reply: () => ({ text: answer }) });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-flow-builder-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { buildFlow } = await import('@/lib/server/flow-builder');
registry.registerBuiltin(corePlugin);

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const draft = (nodes: Array<{ key: string; type: string; name: string }>) =>
  JSON.stringify({ name: 'Draft', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start' }, ...nodes], connections: nodes.map((n, i) => ({ from: i ? nodes[i - 1].key : 'start', to: n.key })), testData: [{ q: 'one' }, { q: 'two' }, { q: 'three' }] });

describe('AI builder sample items', () => {
  it('pins every sample item on a plain flow', async () => {
    answer = draft([{ key: 'set', type: 'core.set', name: 'Set' }]);
    expect((await buildFlow('copy the fields')).pinData?.start).toHaveLength(3);
  });

  it('pins one item when the flow runs a team or an agent', async () => {
    answer = draft([{ key: 'team', type: 'core.runTeam', name: 'Team' }]);
    expect((await buildFlow('review the plugin with the team')).pinData?.start).toEqual([{ json: { q: 'one' } }]);
    answer = draft([{ key: 'agent', type: 'core.aiAgent', name: 'Agent' }]);
    expect((await buildFlow('answer questions')).pinData?.start).toHaveLength(1);
  });
});
