import { describe, expect, it } from 'vitest';
import { consultEdges, deploymentOf, memberAgent, orgTree, rootOf, teamIssues, type AgentTeamConfig, type TeamMember } from '@/lib/shared/agent-teams';

const remote = (id: string, title: string, extra: Partial<TeamMember> = {}): TeamMember => ({ id, title, kind: 'a2a', reportsTo: 'm_lead', parameters: { agentUrl: `http://kagent/${id}` }, ...extra }) as TeamMember;

const pluginTeam = (): AgentTeamConfig => ({
  name: 'Plugin team',
  goal: 'Build approved plugins on a branch, tested and reviewed',
  members: [
    { id: 'm_lead', title: 'Tech Lead', kind: 'agent', agentId: 'ag_lead' },
    remote('m_plan', 'Planner'),
    remote('m_dev', 'Developer'),
    remote('m_rev', 'Reviewer', { reviews: ['m_dev'] }),
  ],
});

describe('agent teams', () => {
  it('accepts the plugin team and draws its chart from the lead down', () => {
    const team = pluginTeam();
    expect(teamIssues(team)).toEqual([]);
    expect(rootOf(team)?.title).toBe('Tech Lead');
    expect(orgTree(team)?.reports.map((n) => n.member.title)).toEqual(['Planner', 'Developer', 'Reviewer']);
  });

  it('needs exactly one lead', () => {
    const team = pluginTeam();
    team.members[1] = { ...team.members[1], reportsTo: undefined };
    expect(teamIssues(team)).toContain('Only one member can lead: Tech Lead, Planner report to nobody.');
    expect(orgTree(team)).toBeUndefined();
  });

  it('refuses circles, self-review, unknown members and remote managers', () => {
    const team = pluginTeam();
    team.members[0] = { ...team.members[0], reportsTo: 'm_dev' };
    team.members[2] = { ...team.members[2], reportsTo: 'm_rev', reviews: ['m_dev'] };
    team.members[3] = { ...team.members[3], reportsTo: 'm_dev', reviews: ['m_gone'] };
    const issues = teamIssues(team);
    expect(issues).toContain('One member must lead and report to nobody.');
    expect(issues.some((i) => i.includes('goes round in a circle'))).toBe(true);
    expect(issues).toContain("Developer can't review its own work.");
    expect(issues).toContain("Reviewer reviews a member who isn't in the team.");
    expect(issues).toContain('Developer is a remote agent, so nobody can report to it: only Landflow agents can manage.');
  });

  it('counts a member whose agent was deleted', () => {
    expect(teamIssues(pluginTeam(), { agentExists: (id) => id !== 'ag_lead' })).toEqual(["Tech Lead's agent no longer exists: pick another."]);
  });

  it('wants titles that tell members apart', () => {
    const team = pluginTeam();
    team.members[2] = { ...team.members[2], title: 'planner' };
    expect(teamIssues(team)).toContain('Two members share a title: titles are how managers call them.');
  });

  it('checks who a member may consult: someone in the team, not itself, and not from a remote member', () => {
    const team = pluginTeam();
    team.members[2] = { ...team.members[2], consults: ['m_dev', 'm_gone'] } as TeamMember;
    team.members[3] = { ...team.members[3], consults: ['m_rev'] } as TeamMember;
    team.members[1] = { ...team.members[1], consults: ['m_plan'] } as TeamMember;
    const issues = teamIssues(team);
    expect(issues).toContain("Developer may consult a member who isn't in the team.");
    expect(issues.some((i) => i.includes("can't consult itself"))).toBe(true);
    expect(issues.some((i) => i.includes("can't consult anyone"))).toBe(true);
  });

  it('finds the Landflow agent behind a member, also one called on kagent', () => {
    const agents = [
      { id: 'ag_lead', name: 'Tech Lead' },
      { id: 'ag_plan', name: 'Planner', kagent: 'landflow-planner' },
    ];
    const team = pluginTeam();
    team.members[1] = remote('m_plan', 'Planner', { parameters: { agentUrl: 'http://host.docker.internal:58083/agents/kagent/landflow-planner/' } } as Partial<TeamMember>);
    expect(memberAgent(team.members[0], agents)?.id).toBe('ag_lead');
    expect(memberAgent(team.members[1], agents)?.id).toBe('ag_plan');
    // A remote agent that isn't one of ours keeps no face.
    expect(memberAgent(team.members[2], agents)).toBeUndefined();
    expect(deploymentOf('http://kagent-controller:8083/agents/kagent/landflow-text?x=1#y')).toBe('landflow-text');
    // Only kagent's controller route names an agent: a bare path is some other A2A server.
    expect(deploymentOf('http://kagent/dev')).toBeUndefined();
    expect(deploymentOf('')).toBeUndefined();
  });
});

describe('consultEdges', () => {
  const m = (id: string, consults?: string[]) => ({ id, consults });
  it('lists each consult once, from the member that may ask to the peer', () => {
    expect(consultEdges({ members: [m('a', ['b']), m('b'), m('c', ['a'])] })).toEqual([
      { from: 'a', to: 'b', mutual: false },
      { from: 'c', to: 'a', mutual: false },
    ]);
  });
  it('makes one marked line of two members consulting each other', () => {
    expect(consultEdges({ members: [m('a', ['b']), m('b', ['a'])] })).toEqual([{ from: 'a', to: 'b', mutual: true }]);
    expect(consultEdges({ members: [m('b', ['a']), m('a', ['b', 'b'])] })).toEqual([{ from: 'b', to: 'a', mutual: true }]);
  });
  it('drops ids that are not in the team and self-consults', () => {
    expect(consultEdges({ members: [m('a', ['gone', 'a', 'b']), m('b')] })).toEqual([{ from: 'a', to: 'b', mutual: false }]);
    expect(consultEdges({ members: [] })).toEqual([]);
  });
});
