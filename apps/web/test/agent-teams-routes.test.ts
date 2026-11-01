import { describe, expect, it } from 'vitest';
import type { AgentTeam } from '@/lib/shared/agent-teams';

const list = await import('@/app/api/agent-teams/route');
const one = await import('@/app/api/agent-teams/[id]/route');
const publish = await import('@/app/api/agent-teams/[id]/publish/route');
const unpublish = await import('@/app/api/agent-teams/[id]/unpublish/route');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { agentStore } = await import('@/lib/server/agents/store');

// Real agents: a member whose agent is gone counts as an issue.
const lead = agentStore.create({ name: 'Lead' }).id;
const lookup = agentStore.create({ name: 'Lookup' }).id;

const req = (method: string, body?: unknown) => new Request('http://localhost/api/agent-teams', { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const members = [
  { id: 'm_lead', kind: 'agent', agentId: lead, title: 'Lead' },
  { id: 'm_dev', kind: 'a2a', title: 'Developer', reportsTo: 'm_lead', parameters: { agentUrl: 'http://kagent/dev' }, budgetTokens: 50000 },
  { id: 'm_rev', kind: 'a2a', title: 'Reviewer', reportsTo: 'm_lead', reviews: ['m_dev'], parameters: { agentUrl: 'http://kagent/rev' } },
];

async function create(body: unknown = { name: 'Plugin team', goal: 'Ship it', members }): Promise<AgentTeam> {
  const res = await list.POST(req('POST', body));
  expect(res.status).toBe(201);
  return (await res.json()).team;
}

describe('agent team routes', () => {
  it('shows the face of a Landflow agent a remote member calls on kagent, and still counts it as remote', async () => {
    const dev = agentStore.create({ name: 'Developer' }).id;
    agentStore.setKagent(dev, { credential: { id: 'cred_kagent', name: 'kagent' }, name: 'routes-developer' });
    const team = await create({ name: 'On kagent', members: [members[0], { ...members[1], parameters: { agentUrl: 'http://controller:8083/agents/kagent/routes-developer' } }] });
    const summary = (await (await list.GET(req('GET'))).json()).teams.find((t: { id: string }) => t.id === team.id);
    expect(summary).toMatchObject({ agentIds: [lead, dev], remote: 1 });
    agentStore.setKagent(dev, undefined);
    await one.DELETE(req('DELETE'), ctx(team.id));
  });

  it('keeps who a member may consult, and lists a consult that has no one to go to as an issue', async () => {
    const dev = agentStore.create({ name: 'Dev' }).id;
    const team = await create({
      name: 'Peers',
      members: [members[0], { id: 'm_a', kind: 'agent', agentId: dev, title: 'Developer', reportsTo: 'm_lead', consults: ['m_b', 'm_b', 7] }, { id: 'm_b', kind: 'agent', agentId: dev, title: 'Reviewer', reportsTo: 'm_lead' }],
    });
    expect(team.draft.members[1]).toMatchObject({ consults: ['m_b'] });
    const got = await (await one.GET(req('GET'), ctx(team.id))).json();
    expect(got.issues).toEqual([]);
    const saved = await (await one.PUT(req('PUT', { ...team.draft, members: [team.draft.members[0], { ...team.draft.members[1], consults: ['m_gone'] }, team.draft.members[2]] }), ctx(team.id))).json();
    expect(saved.issues).toContain("Developer may consult a member who isn't in the team.");
    await one.DELETE(req('DELETE'), ctx(team.id));
  });

  it('creates, lists, reads, saves and deletes a team', async () => {
    const team = await create();
    expect(team.draft.members).toHaveLength(3);
    const listed = (await (await list.GET(req('GET'))).json()).teams;
    const summary = listed.find((t: { id: string }) => t.id === team.id);
    expect(summary).toMatchObject({ name: 'Plugin team', goal: 'Ship it', members: 3, lead: 'Lead', agentIds: [lead], remote: 2, issues: 0 });
    expect(summary.ownership).toBeDefined();

    const got = await (await one.GET(req('GET'), ctx(team.id))).json();
    expect(got.issues).toEqual([]);

    const saved = await (await one.PUT(req('PUT', { name: 'Renamed', members: members.slice(0, 2).map((m, i) => (i ? { ...m, reportsTo: 'm_gone' } : m)) }), ctx(team.id))).json();
    expect(saved.team.draft.name).toBe('Renamed');
    expect(saved.issues.length).toBeGreaterThan(0);

    expect((await one.DELETE(req('DELETE'), ctx(team.id))).status).toBe(200);
    expect((await one.GET(req('GET'), ctx(team.id))).status).toBe(404);
  });

  it('publishes only a team without issues, bumps the version and unpublishes', async () => {
    const broken = await create({ name: 'Broken', members: [{ id: 'm_a', kind: 'agent', agentId: '', title: 'A' }] });
    const refused = await publish.POST(req('POST'), ctx(broken.id));
    expect(refused.status).toBe(400);
    expect((await refused.json()).issues).toContain('Pick the agent for A.');

    const team = await create();
    const first = (await (await publish.POST(req('POST'), ctx(team.id))).json()).team as AgentTeam;
    expect(first.published?.version).toBe(1);
    await one.PUT(req('PUT', { ...team.draft, goal: 'Changed' }), ctx(team.id));
    expect(agentTeamStore.get(team.id)?.published?.goal).toBe('Ship it');
    expect(((await (await publish.POST(req('POST'), ctx(team.id))).json()).team as AgentTeam).published?.version).toBe(2);
    expect(((await (await unpublish.POST(req('POST'), ctx(team.id))).json()).team as AgentTeam).published).toBeUndefined();
    expect((await publish.POST(req('POST'), ctx('nope'))).status).toBe(404);
  });

  it('knows which teams an agent belongs to', async () => {
    const team = await create({ name: 'Lookup', members: [{ id: 'm_x', kind: 'agent', agentId: lookup, title: 'Solo' }] });
    expect(agentTeamStore.teamsOfAgent(lookup)).toEqual([{ id: team.id, name: 'Lookup', title: 'Solo' }]);
    expect(agentTeamStore.teamsOfAgent('ag_other')).toEqual([]);
  });
});
