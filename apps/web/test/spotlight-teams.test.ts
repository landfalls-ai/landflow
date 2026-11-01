/**
 * Spotlight and agent teams (docs/agent-teams.md): the assistant sees the published teams, can propose a Run a Team node for
 * one, and can turn a lead and the agents under it into a team (the `turnIntoTeam` op).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { TeamBrief } from '@/lib/shared/agent-teams';
import { applyOps, describeOps } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';
import { registryLookup, validateOps } from '@/lib/server/assistant/ops';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): Workflow['nodes'][number] => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string, type: 'main' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

const leadFlow = (): Workflow => ({
  id: 'wf',
  name: 'Plugin flow',
  nodes: [node('Start', 'core.manualTrigger'), node('Tech Lead', 'core.messageAgent', { agentId: 'ag_lead' }), node('Planner', 'core.a2aAgent', { agentUrl: 'http://kagent/planner' }), node('Developer', 'core.a2aAgent', { agentUrl: 'http://kagent/dev' })],
  connections: [edge('Start', 'Tech Lead'), edge('Planner', 'Tech Lead', 'ai_tool'), edge('Developer', 'Tech Lead', 'ai_tool')],
});

const teams: TeamBrief[] = [
  {
    id: 'team_abc',
    name: 'Plugin team',
    goal: 'Build approved plugins',
    version: 3,
    members: [{ title: 'Tech Lead' }, { title: 'Planner', reportsTo: 'Tech Lead' }, { title: 'Developer', reportsTo: 'Tech Lead' }],
  },
];

function scripted(turns: Array<Partial<ModelTurn>>) {
  const calls: GenerateInput[] = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      calls.push({ ...input, messages: [...input.messages] });
      return { text: '', toolCalls: [], stopReason: 'stop', ...turns.shift() };
    },
  };
  return { model, calls };
}

describe('Spotlight and teams', () => {
  it('sees the published teams, and reads them again in the Run a Team docs', async () => {
    const { model, calls } = scripted([{ toolCalls: [{ id: 'c1', name: 'get_node_docs', input: { type: 'core.runTeam' } }] }, { text: 'Use the Plugin team.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Run the plugin team on the task' }], workflow: leadFlow(), model, types, teams, onEvent: (e) => events.push(e) });
    expect(calls[0].system).toContain('Published agent teams');
    expect(calls[0].system).toContain('“Plugin team” (teamId team_abc, v3)');
    expect(calls[0].system).toContain('Planner (reports to Tech Lead)');
    const docs = (calls[1].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content;
    expect(docs).toContain('Run a Team');
    expect(docs).toContain('Needs a person');
    expect(docs).toContain('teamId team_abc');
  });

  it('proposes a Run a Team node for an existing team', async () => {
    const { model } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Run the plugin team', ops: [{ op: 'addNode', type: 'core.runTeam', name: 'Plugin team', after: 'Start', parameters: { teamId: 'team_abc', teamName: 'Plugin team' } }] } }] },
      { text: 'Click Apply.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Run the plugin team' }], workflow: { ...leadFlow(), nodes: leadFlow().nodes.slice(0, 1), connections: [] }, model, types, teams, onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === 'proposal')).toMatchObject({ ops: [{ op: 'addNode', type: 'core.runTeam', parameters: { teamId: 'team_abc', teamName: 'Plugin team' } }] });
  });

  it('turns a lead and its agents into a team with the turnIntoTeam op', async () => {
    const lookup = registryLookup(types);
    const result = applyOps(leadFlow(), [{ op: 'turnIntoTeam', node: 'Tech Lead' }], lookup);
    expect(result.dropped).toEqual([]);
    expect(result.workflow.nodes.map((n) => [n.name, n.type])).toEqual([
      ['Start', 'core.manualTrigger'],
      ['Tech Lead', 'core.runTeam'],
    ]);
    expect(result.workflow.connections.map((c) => `${c.source}>${c.target}`)).toEqual(['Start>Tech Lead']);
    expect(describeOps(result.applied, lookup)[0].text).toContain('become a team');

    const { model } = scripted([{ toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Turn the lead into a team', ops: [{ op: 'turnIntoTeam', node: 'Tech Lead' }] } }] }, { text: 'Apply it.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Turn the Tech Lead and its agents into a team' }], workflow: leadFlow(), model, types, teams: [], onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === 'proposal')).toMatchObject({ summary: 'Turn the lead into a team', ops: [{ op: 'turnIntoTeam', node: 'Tech Lead' }], warnings: [] });
  });

  it('drops the op for a node that cannot lead', () => {
    const wf = leadFlow();
    const { dropped, ops } = validateOps(wf, [{ op: 'turnIntoTeam', node: 'Planner' }]);
    expect(ops).toEqual([]);
    expect(dropped[0]).toContain('Only a Run an Agent node can lead a team');
  });
});
