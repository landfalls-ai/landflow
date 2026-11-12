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
let slowMs = 0;
const fake = await startFakeModels({ reply: () => ({ text: answer, ...(slowMs && { delayMs: slowMs }) }) });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-flow-builder-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { buildFlow, builderTimeoutMs } = await import('@/lib/server/flow-builder');
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

describe('AI builder teams', () => {
  const teams = [
    { id: 'team_desk1', name: 'Release notes desk', version: 1, members: [{ title: 'Editor' }, { title: 'Writer', reportsTo: 'Editor' }] },
    { id: 'team_tl1', name: 'Tech Lead team', version: 2, members: [{ title: 'Tech Lead' }] },
  ];

  it('tells the model the published teams, and turns the team name it writes into the id', async () => {
    answer = JSON.stringify({ name: 'Notes', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start' }, { key: 'team', type: 'core.runTeam', name: 'Run Team', parameters: { teamId: 'Release notes desk team', message: 'Write the notes' } }], connections: [{ from: 'start', to: 'team' }] });
    const flow = await buildFlow('run the release notes desk', undefined, teams);
    expect(flow.nodes.find((n) => n.key === 'team')!.parameters).toEqual({ teamId: 'team_desk1', teamName: 'Release notes desk', message: 'Write the notes' });
    const prompt = JSON.stringify(fake.last('/api/chat')?.body);
    expect(prompt).toContain('teamId team_desk1');
    // A lead's title is a name too; a name no team has stays as written (the node then asks for a team).
    answer = answer.replace('Release notes desk team', 'Tech Lead');
    expect((await buildFlow('review it', undefined, teams)).nodes.find((n) => n.key === 'team')!.parameters).toMatchObject({ teamId: 'team_tl1', teamName: 'Tech Lead team' });
    answer = answer.replace('Tech Lead', 'Marketing');
    expect((await buildFlow('market it', undefined, teams)).nodes.find((n) => n.key === 'team')!.parameters).toMatchObject({ teamId: 'Marketing' });
  });
});

describe('AI builder timeout', () => {
  it('defaults to 10 minutes and reads LANDFLOW_BUILDER_TIMEOUT_SECONDS', () => {
    expect(builderTimeoutMs(undefined)).toBe(600_000);
    expect(builderTimeoutMs('')).toBe(600_000);
    expect(builderTimeoutMs('900')).toBe(900_000);
    expect(builderTimeoutMs('0.5')).toBe(500);
    expect(builderTimeoutMs('0')).toBe(600_000);
    expect(builderTimeoutMs('soon')).toBe(600_000);
  });

  it('says the model was too slow, not that Ollama is unreachable', async () => {
    answer = draft([]);
    slowMs = 400;
    process.env.LANDFLOW_BUILDER_TIMEOUT_SECONDS = '0.1';
    try {
      await expect(buildFlow('anything', 'slow-model')).rejects.toThrow(/slow-model on Ollama at .* did not finish the draft within 0\.1 s.*LANDFLOW_BUILDER_TIMEOUT_SECONDS/);
    } finally {
      slowMs = 0;
      delete process.env.LANDFLOW_BUILDER_TIMEOUT_SECONDS;
    }
  });
});
