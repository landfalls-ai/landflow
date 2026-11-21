/**
 * The team notebook block on What it saw (C11 T-9, docs/run-trace.md#what-it-saw): the lead's and each agent member's span
 * record a `team-notebook` source with the notes' ids and the block's text. The notebook block is not a person's memory, so
 * `memoryFor` and `memoryAgent` stay unset.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { AgentTeamConfig, TeamMember } from '@/lib/shared/agent-teams';
import { startFakeModels, type FakeReply } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-team-saw-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { noteStore } = await import('@/lib/server/notebook/store');
const { read } = await import('@/lib/server/journal/store');
const { resetJournals } = await import('@/lib/server/journal/writer');
registry.registerBuiltin(corePlugin);

type Body = { model: string; messages: Array<{ role: string; content: string }> };
const scripts = new Map<string, (turn: number, body: Body) => FakeReply>();
const turns = new Map<string, number>();
const fake = await startFakeModels({
  reply: (_provider, body: Body) => {
    const turn = (turns.get(body.model) ?? 0) + 1;
    turns.set(body.model, turn);
    return scripts.get(body.model)?.(turn, body);
  },
});
afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const agent = (name: string, model: string) => {
  const created = agentStore.create({ name, instructions: `You are ${name}.`, model: { provider: 'ollama', model, baseUrl: fake.url.replace(/\/v1$/, '') } });
  agentStore.publish(created.id);
  return created;
};
const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}-0`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });

describe('the notebook block on What it saw', () => {
  it('is recorded on the lead and on an agent member that got it, as a team-notebook source with the text', async () => {
    const lead = agent('Lead', 'saw-lead');
    const dev = agent('Dev', 'saw-dev');
    const config: AgentTeamConfig = { name: 'Saw team', goal: 'Ship', members: [{ id: 'm_lead', title: 'Tech Lead', kind: 'agent', agentId: lead.id }, { id: 'm_dev', title: 'Developer', kind: 'agent', agentId: dev.id, reportsTo: 'm_lead' } as TeamMember] };
    const team = agentTeamStore.create(config);
    agentTeamStore.publish(team.id);
    const note = noteStore.insert({ teamId: team.id, kind: 'decision', text: 'Target the v2 alerting API only', scope: 'team', author: 'Lead' });
    scripts.set('saw-lead', (turn) => (turn === 1 ? { toolCalls: [{ id: 'd1', name: 'ask_developer', arguments: { message: 'Build it', reason: 'code' } }] } : { text: 'done' }));
    scripts.set('saw-dev', () => ({ text: 'built' }));
    const wf: Workflow = { id: 'wf_team_saw', name: 'team', nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: team.id, message: 'Go' })], connections: [edge('Start', 'Team')] };
    store.saveWorkflow(wf);
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    resetJournals();
    expect(record.error?.message ?? record.status).toBe('success');
    const saws = read(record.executionId).flatMap((e) => ((e as { attrs?: { saw?: Record<string, unknown> } }).attrs?.saw ? [(e as unknown as { attrs: { saw: Record<string, unknown> } }).attrs.saw] : []));
    const withMemory = saws.filter((s) => Array.isArray(s.memory));
    expect(withMemory).toHaveLength(2);
    for (const saw of withMemory) {
      expect(saw.memory).toMatchObject([{ source: 'team-notebook', count: 1, items: [{ id: note.id, kind: 'decision' }], hash: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
      expect(saw.memoryText).toContain('Target the v2 alerting API only');
      // Not a person's memory: nothing says whose it is.
      expect(saw.memoryFor).toBeUndefined();
      expect(saw.memoryAgent).toBeUndefined();
    }
  });
});
