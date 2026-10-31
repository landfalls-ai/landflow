import { describe, expect, it } from 'vitest';
import { orgTree, rootOf, teamIssues, type AgentTeamConfig, type TeamMember } from '@/lib/shared/agent-teams';

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
});
