import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import { canTurnIntoTeam, replaceWithTeam, teamFromLead, turnIntoTeamBlocker } from '@/lib/shared/turn-into-team';
import { teamIssues } from '@/lib/shared/agent-teams';

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  name: id,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
  ...extra,
});
const edge = (source: string, target: string, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({
  id: `${source}-${target}`,
  type,
  source,
  target,
  sourceIndex: 0,
  targetIndex: 0,
});

const flow = (): Workflow => ({
  id: 'wf',
  name: 'Plugin flow',
  nodes: [
    node('Start', 'core.manualTrigger'),
    node(
      'Tech Lead',
      'core.messageAgent',
      {
        agentId: 'ag_lead',
        message: 'Do {{ $json.task }}',
        conversation: 'new',
      },
      { position: [300, 100], notes: 'the lead' },
    ),
    node(
      'Planner',
      'core.a2aAgent',
      {
        agentUrl: 'http://kagent/planner',
        authentication: 'bearerAuth',
        options: { timeout: 1000, questionsGoTo: 'person' },
      },
      {
        notes: 'Writes PLAN.md',
        credentials: { httpBearerAuth: { id: 'cr_1', name: 'kagent' } },
      },
    ),
    node('Developer', 'core.a2aAgent', {
      agentUrl: 'http://kagent/dev',
      authentication: 'none',
    }),
    node('Reviewer agent', 'core.messageAgent', { agentId: 'ag_rev' }),
    node('Model', 'core.openAiChatModel'),
    node('Check branch', 'core.httpRequest'),
    node('Done', 'core.noOp'),
  ],
  connections: [
    edge('Start', 'Tech Lead'),
    edge('Tech Lead', 'Done'),
    edge('Planner', 'Tech Lead', 'ai_tool'),
    edge('Developer', 'Tech Lead', 'ai_tool'),
    edge('Reviewer agent', 'Tech Lead', 'ai_tool'),
    edge('Check branch', 'Tech Lead', 'ai_tool'),
    edge('Model', 'Tech Lead', 'ai_languageModel'),
  ],
});

describe('Turn into a team', () => {
  it('reads the lead and its delegating sub-nodes as a team', () => {
    const made = teamFromLead(flow(), 'Tech Lead', {
      newId: (
        (n) => () =>
          `m${++n}`
      )(0),
    });
    if ('error' in made) throw new Error(made.error);
    expect(made.team.name).toBe('Tech Lead team');
    expect(made.team.members.map((m) => [m.title, m.kind, m.reportsTo])).toEqual([
      ['Tech Lead', 'agent', undefined],
      ['Planner', 'a2a', 'm1'],
      ['Developer', 'a2a', 'm1'],
      ['Reviewer agent', 'agent', 'm1'],
    ]);
    expect(made.team.members[1]).toMatchObject({
      role: 'Writes PLAN.md',
      questionsTo: 'person',
      credentials: { httpBearerAuth: { id: 'cr_1', name: 'kagent' } },
      parameters: {
        agentUrl: 'http://kagent/planner',
        authentication: 'bearerAuth',
        options: { timeout: 1000 },
      },
    });
    expect(made.team.members[2]).toMatchObject({ questionsTo: 'manager' });
    expect(made.members.map((m) => m.nodeId)).toEqual(['Planner', 'Developer', 'Reviewer agent']);
    // A team the editor can publish as it is.
    expect(teamIssues(made.team)).toEqual([]);
  });

  it('puts one Run a Team node where the lead was, keeping model, other tools and main connections', () => {
    const wf = flow();
    const made = teamFromLead(wf, 'Tech Lead');
    if ('error' in made) throw new Error(made.error);
    const next = replaceWithTeam(
      wf,
      'Tech Lead',
      made.members.map((m) => m.nodeId),
      { id: 'team_1', name: 'Tech Lead team' },
    );
    expect(next.nodes.map((n) => n.id)).toEqual(['Start', 'Tech Lead', 'Model', 'Check branch', 'Done']);
    expect(next.nodes[1]).toMatchObject({
      type: 'core.runTeam',
      position: [300, 100],
      notes: 'the lead',
      parameters: {
        teamId: 'team_1',
        teamName: 'Tech Lead team',
        message: 'Do {{ $json.task }}',
        version: 'published',
      },
    });
    expect(next.nodes[1].parameters.agentId).toBeUndefined();
    expect(next.connections.map((c) => `${c.type}:${c.source}>${c.target}`)).toEqual([
      'main:Start>Tech Lead',
      'main:Tech Lead>Done',
      'ai_tool:Check branch>Tech Lead',
      'ai_languageModel:Model>Tech Lead',
    ]);
    // The original is untouched (the editor keeps it for undo).
    expect(wf.nodes).toHaveLength(8);
  });

  it('makes titles different when two nodes share a name, and says why a node cannot lead', () => {
    const wf = flow();
    wf.nodes.push(node('planner', 'core.a2aAgent', { agentUrl: 'http://kagent/p2' }));
    wf.connections.push(edge('planner', 'Tech Lead', 'ai_tool'));
    const made = teamFromLead(wf, 'Tech Lead');
    if ('error' in made) throw new Error(made.error);
    expect(made.team.members.map((m) => m.title)).toContain('planner 2');
    expect(turnIntoTeamBlocker(wf, 'Start')).toMatch(/Only a Run an Agent node/);
    expect(turnIntoTeamBlocker({ nodes: wf.nodes, connections: [] }, 'Tech Lead')).toMatch(/Nothing hangs under it/);
    wf.nodes[1].parameters.agentId = '{{ $json.agent }}';
    expect(canTurnIntoTeam(wf, 'Tech Lead')).toBe(false);
  });
});
