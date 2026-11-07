/**
 * Run a Team, the leftovers: it delegates (a required `reason`, so the chat shows "asked <Team>: <reason>") and takes a
 * per-node "Tool Images to Keep" that reaches the lead's run; members keep their own agent's setting.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { deriveToolSchema, withReason, type NodeDescriptor, type Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-finish-team-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const requests: Array<{ agent: string; toolImages?: { keep?: number } }> = [];
vi.mock('@/lib/server/agents/runtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/server/agents/runtime')>();
  return {
    ...real,
    runAgent: async (request: { agent: { name: string }; session: unknown; toolImages?: { keep?: number } }) => {
      requests.push({ agent: request.agent.name, toolImages: request.toolImages });
      return { session: request.session, reason: 'completed', reply: 'Team done.', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
});

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const descriptor = () => (registry.resolve('core.runTeam') as { descriptor: NodeDescriptor }).descriptor;

describe('Run a Team as a delegating tool', () => {
  it('is usable as a tool and its schema requires a message and a reason', () => {
    const d = descriptor();
    expect(d.usableAsTool).toBe(true);
    expect(d.delegates).toBe(true);
    const schema = withReason(deriveToolSchema(d, { teamId: 't', message: 'x' })) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['message', 'reason']);
    expect(Object.keys(schema.properties).sort()).toEqual(['message', 'reason']);
  });

  it('matches Run an Agent, so the chat shows the same “asked” line for both', () => {
    const agent = (registry.resolve('core.messageAgent') as { descriptor: NodeDescriptor }).descriptor;
    expect(descriptor().delegates).toBe(agent.delegates);
  });
});

describe('Tool Images to Keep on Run a Team', () => {
  const lead = agentStore.create({ name: 'Lead', instructions: 'Lead.', model: { provider: 'ollama', model: 'x' } });
  agentStore.publish(lead.id);
  const team = agentTeamStore.create({ name: 'Solo', goal: 'Do it', members: [{ id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id }] });
  agentTeamStore.publish(team.id);

  const run = async (parameters: Record<string, unknown>) => {
    const wf: Workflow = {
      id: `wf_keep_${Math.random().toString(36).slice(2, 8)}`,
      name: 'team',
      nodes: [
        { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'Team', name: 'Team', type: 'core.runTeam', typeVersion: 1, position: [0, 0], parameters: { teamId: team.id, message: 'go', ...parameters } },
      ],
      connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Team', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(wf);
    requests.length = 0;
    const record = await runWorkflow({ workflow: wf, mode: 'manual' } as never);
    expect(record.status).toBe('success');
  };

  it('has the setting with a default of 2 and passes it to the lead', async () => {
    expect(descriptor().properties.find((p) => p.name === 'toolImagesKept')).toMatchObject({ default: 2, typeOptions: { minValue: 0, maxValue: 10 } });
    await run({});
    expect(requests).toEqual([{ agent: 'Lead', toolImages: { keep: 2 } }]);
    await run({ toolImagesKept: 5 });
    expect(requests).toEqual([{ agent: 'Lead', toolImages: { keep: 5 } }]);
    await run({ toolImagesKept: 0 });
    expect(requests[0].toolImages).toEqual({ keep: 0 });
  });
});
