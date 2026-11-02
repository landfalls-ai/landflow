/**
 * Team templates: "Save as template" on a team (the team, its Landflow agents with their published config, the remote
 * members as data, optionally one flow that runs it, credentials as slots and never secrets), and "Use template" creating
 * all of it again with fresh ids: member agent ids, the team id in the Run a Team node, Run an Agent nodes and sub-agent
 * tools remapped, credentials picked per slot, export and import of the template file, and the routes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentTeam } from '@/lib/shared/agent-teams';
import type { Workflow } from '@/lib/shared/types';
import type { TemplateDetail, UseTemplateResult } from '@/lib/shared/templates';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-team-templates-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_TEMPLATES_URL;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const templates = await import('@/lib/server/templates');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { store } = await import('@/lib/server/store');
const teamTemplateRoute = await import('@/app/api/agent-teams/[id]/template/route');
const flowsRoute = await import('@/app/api/agent-teams/[id]/flows/route');
const useRoute = await import('@/app/api/templates/[id]/use/route');
const itemRoute = await import('@/app/api/templates/[id]/route');
const listRoute = await import('@/app/api/templates/route');

registry.registerBuiltin(corePlugin);

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => new Request(`http://localhost${path}`);

let anthropic: string;
let openai: string;
let bearer: string;
let lead: string;
let dev: string;
let helper: string;
let team: AgentTeam;
let flow: Workflow;

beforeAll(() => {
  anthropic = credentials.create({ name: 'Anthropic prod', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-SECRET' } }).id;
  openai = credentials.create({ name: 'OpenAI prod', type: 'core.openAiApi', data: { apiKey: 'sk-openai-SECRET' } }).id;
  bearer = credentials.create({ name: 'Kagent token', type: 'core.httpBearerAuth', data: { token: 'bearer-SECRET' } }).id;

  helper = agentStore.create({ name: 'Helper', instructions: 'Look things up', model: { provider: 'openai', model: 'gpt-x', credential: { id: openai, name: 'OpenAI prod' } } }).id;
  dev = agentStore.create({
    name: 'Developer',
    instructions: 'Write the code',
    model: { provider: 'anthropic', model: 'claude-sonnet-5-5', credential: { id: anthropic, name: 'Anthropic prod' } },
    tools: [{ id: 'tl_sub', type: 'agent', agentId: helper }],
  }).id;
  agentStore.publish(dev);
  // The published version has the sub-agent tool; the draft changes afterwards and must not travel.
  agentStore.saveDraft(dev, { instructions: 'DRAFT ONLY', tools: [] });
  lead = agentStore.create({
    name: 'Tech Lead',
    instructions: 'Lead',
    model: { provider: 'anthropic', model: 'claude-sonnet-5-5', credential: { id: anthropic, name: 'Anthropic prod' } },
    schedules: [{ id: 'sc_1', prompt: 'weekly', frequency: 'daily', timezone: 'UTC', enabled: true }],
  }).id;
  agentStore.publish(lead);
  team = agentTeamStore.create({
    name: 'Plugin team',
    goal: 'Build approved plugins',
    members: [
      { id: 'm_lead', kind: 'agent', agentId: lead, title: 'Tech Lead' },
      { id: 'm_dev', kind: 'agent', agentId: dev, title: 'Developer', reportsTo: 'm_lead', budgetTokens: 5000 },
      {
        id: 'm_rev',
        kind: 'a2a',
        title: 'Reviewer',
        reportsTo: 'm_lead',
        reviews: ['m_dev'],
        parameters: { agentUrl: 'http://kagent.local/agents/kagent/reviewer', authentication: 'bearerAuth' },
        credentials: { httpBearerAuth: { id: bearer, name: 'Kagent token' } },
      },
    ],
  });
  team = agentTeamStore.publish(team.id)!;
  flow = store.saveWorkflow({
    id: 'wf_team_flow',
    name: 'Build a plugin',
    active: true,
    nodes: [
      { id: 'n1', name: 'Manual', type: 'core.manualTrigger', position: [0, 0], parameters: {} },
      { id: 'n2', name: 'Run team', type: 'core.runTeam', position: [200, 0], parameters: { teamId: team.id, teamName: 'Plugin team', task: 'Build it' } },
      { id: 'n3', name: 'Ask lead', type: 'core.messageAgent', position: [400, 0], parameters: { agentId: lead, message: 'status?' } },
    ],
    connections: [
      { id: 'c1', type: 'main', source: 'n1', sourceIndex: 0, target: 'n2', targetIndex: 0 },
      { id: 'c2', type: 'main', source: 'n2', sourceIndex: 0, target: 'n3', targetIndex: 0 },
    ],
  } as unknown as Workflow);
  store.saveWorkflow({ id: 'wf_other', name: 'Unrelated', active: false, nodes: [{ id: 'x', name: 'Manual', type: 'core.manualTrigger', position: [0, 0], parameters: {} }], connections: [] } as unknown as Workflow);
});

async function save(extra: Record<string, unknown> = {}) {
  const res = await teamTemplateRoute.POST(post(`/api/agent-teams/${team.id}/template`, { name: 'Plugin team kit', ...extra }), ctx(team.id));
  const body = (await res.json()) as { template?: TemplateDetail; error?: string };
  if (!body.template) throw new Error(`${res.status}: ${body.error}`);
  return { res, template: body.template };
}

describe('save a team as a template', () => {
  it('lists the flows that run the team', async () => {
    const { flows } = (await (await flowsRoute.GET(get(`/api/agent-teams/${team.id}/flows`), ctx(team.id))).json()) as { flows: Array<{ id: string }> };
    expect(flows.map((f) => f.id)).toEqual(['wf_team_flow']);
    expect((await flowsRoute.GET(get('/api/agent-teams/nope/flows'), ctx('nope'))).status).toBe(404);
  });

  it('holds the team, the agents’ published config, the remote members, the flow and credential slots, never secrets', async () => {
    const { res, template } = await save({ workflowId: 'wf_team_flow' });
    expect(res.status).toBe(201);
    const bundle = template.bundle!;
    expect(bundle).toMatchObject({ teamKey: team.id, teamPublished: true, hasWorkflow: true, workflowKey: 'wf_team_flow' });
    // Both members, plus the sub-agent the developer's published version delegates to.
    expect(bundle.agents.map((a) => a.config.name).sort()).toEqual(['Developer', 'Helper', 'Tech Lead']);
    const developer = bundle.agents.find((a) => a.key === dev)!;
    expect(developer.config.instructions).toBe('Write the code');
    expect(developer.config.tools).toEqual([{ id: 'tl_sub', type: 'agent', agentId: helper }]);
    expect(developer.published).toBe(true);
    expect(bundle.team.members.find((m) => m.id === 'm_rev')).toMatchObject({ kind: 'a2a', parameters: { agentUrl: 'http://kagent.local/agents/kagent/reviewer' } });
    expect(template.workflow.nodes.map((n) => n.type)).toEqual(['core.manualTrigger', 'core.runTeam', 'core.messageAgent']);
    expect(template.team).toMatchObject({ name: 'Plugin team', members: 3, agents: 3, remote: 1, hasWorkflow: true });
    // The card: the members' faces in chart order (a remote member by its title), and what the person picks.
    expect(template.team!.faces.map((f) => f.name)).toEqual(['Tech Lead', 'Developer', 'Reviewer']);
    expect(template.team!.picks).toContain('Ollama or Claude model');
    expect(template.team!.picks.some((p) => /SECRET/.test(p))).toBe(false);
    expect(template.categories).toContain('agent-teams');

    // Slots: one per credential type, named for who uses it; nothing of the saved credentials is kept.
    expect(template.credentials.map((s) => s.type).sort()).toEqual(['core.anthropicApi', 'core.httpBearerAuth', 'core.openAiApi']);
    expect(template.credentials.find((s) => s.type === 'core.anthropicApi')).toMatchObject({ optional: true, description: expect.stringContaining('Developer (model)') });
    expect(template.credentials.find((s) => s.type === 'core.openAiApi')?.optional).toBeUndefined();
    const text = JSON.stringify(template);
    for (const secret of ['SECRET', anthropic, openai, bearer]) expect(text).not.toContain(secret);
    expect(developer.config.model?.credential?.id).toBe(template.credentials.find((s) => s.type === 'core.anthropicApi')!.id);
  });

  it('saves the team alone when no flow is picked, and refuses a flow that doesn’t run the team', async () => {
    const { template } = await save({ name: 'Team only' });
    expect(template.bundle?.hasWorkflow).toBe(false);
    expect(template.workflow.nodes).toEqual([]);
    expect(template.team?.hasWorkflow).toBe(false);
    expect(template.usable).toBe(true);
    const wrong = await teamTemplateRoute.POST(post(`/api/agent-teams/${team.id}/template`, { name: 'x', workflowId: 'wf_other' }), ctx(team.id));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/doesn’t run this team/);
    expect((await teamTemplateRoute.POST(post(`/api/agent-teams/${team.id}/template`, { name: 'x', workflowId: 'wf_gone' }), ctx(team.id))).status).toBe(404);
    expect((await teamTemplateRoute.POST(post('/api/agent-teams/nope/template', { name: 'x' }), ctx('nope'))).status).toBe(404);
  });

  it('shows in the library as a team and is marked in the summary only', async () => {
    const { template } = await save({ name: 'Listed team kit' });
    const listed = (await (await listRoute.GET(get('/api/templates?search=listed+team'))).json()) as { templates: Array<{ id: string; team?: unknown; bundle?: unknown }> };
    const found = listed.templates.find((t) => t.id === template.id)!;
    expect(found.team).toMatchObject({ name: 'Plugin team', agents: 3 });
    expect(found.bundle).toBeUndefined();
  });
});

describe('use a team template', () => {
  it('creates the agents, team and flow with fresh ids and remaps every reference', async () => {
    const { template } = await save({ workflowId: 'wf_team_flow', name: 'Use me' });
    const slot = (type: string) => template.credentials.find((s) => s.type === type)!.id;
    const newAnthropic = credentials.create({ name: 'Other Anthropic', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-2' } }).id;
    const newBearer = credentials.create({ name: 'Other token', type: 'core.httpBearerAuth', data: { token: 't2' } }).id;
    const response = await useRoute.POST(post(`/api/templates/${template.id}/use`, { name: 'My flow', teamName: 'My plugin team', credentials: { [slot('core.anthropicApi')]: newAnthropic, [slot('core.httpBearerAuth')]: newBearer } }), ctx(template.id));
    expect(response.status).toBe(201);
    const result = (await response.json()) as UseTemplateResult;

    // Fresh ids everywhere.
    const originals = new Set([lead, dev, helper]);
    expect(result.agents).toHaveLength(3);
    for (const agent of result.agents!) expect(originals.has(agent.id)).toBe(false);
    expect(result.team!.id).not.toBe(team.id);
    expect(result.team!.name).toBe('My plugin team');
    expect(result.workflow!.id).not.toBe('wf_team_flow');
    expect(result.workflow!.name).toBe('My flow');
    expect(result.workflow!.active).toBe(false);

    // The team: members point at the new agents, the relations survive, the remote member keeps its address.
    const created = agentTeamStore.get(result.team!.id)!;
    const byName = (name: string) => result.agents!.find((a) => a.name === name)!.id;
    expect(created.draft.members).toMatchObject([
      { id: 'm_lead', kind: 'agent', agentId: byName('Tech Lead'), title: 'Tech Lead' },
      { id: 'm_dev', kind: 'agent', agentId: byName('Developer'), reportsTo: 'm_lead', budgetTokens: 5000 },
      { id: 'm_rev', kind: 'a2a', reportsTo: 'm_lead', reviews: ['m_dev'], parameters: { agentUrl: 'http://kagent.local/agents/kagent/reviewer' }, credentials: { httpBearerAuth: { id: newBearer, name: 'Other token' } } },
    ]);
    // It was published, and so are the agents that were.
    expect(created.published?.version).toBe(1);
    expect(agentStore.get(byName('Developer'))!.published).toBeDefined();
    expect(agentStore.get(byName('Helper'))!.published).toBeUndefined();

    // The agents: the published config, sub-agent tool and credentials remapped; schedules off; the helper's OpenAI slot unpicked, so dropped.
    const developer = agentStore.get(byName('Developer'))!;
    expect(developer.instructions).toBe('Write the code');
    expect(developer.tools).toEqual([{ id: 'tl_sub', type: 'agent', agentId: byName('Helper') }]);
    expect(developer.model?.credential).toEqual({ id: newAnthropic, name: 'Other Anthropic' });
    expect(agentStore.get(byName('Helper'))!.model?.credential).toBeUndefined();
    expect(agentStore.get(byName('Tech Lead'))!.schedules.every((s) => !s.enabled)).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/OpenAI prod|OpenAI/);

    // The flow: Run a Team and Run an Agent nodes follow the copies.
    const nodes = store.getWorkflow(result.workflow!.id)!.nodes;
    expect(nodes.find((n) => n.type === 'core.runTeam')!.parameters).toMatchObject({ teamId: result.team!.id, teamName: 'My plugin team', task: 'Build it' });
    expect(nodes.find((n) => n.type === 'core.messageAgent')!.parameters.agentId).toBe(byName('Tech Lead'));

    // The originals are untouched.
    expect(agentStore.get(dev)!.instructions).toBe('DRAFT ONLY');
    expect(agentTeamStore.get(team.id)!.draft.members[1]).toMatchObject({ agentId: dev });
  });

  it('creates the team alone from a template without a flow, in the project asked for', async () => {
    const { template } = await save({ name: 'Alone' });
    const response = await useRoute.POST(post(`/api/templates/${template.id}/use`, {}), ctx(template.id));
    expect(response.status).toBe(201);
    const result = (await response.json()) as UseTemplateResult;
    expect(result.workflow).toBeUndefined();
    expect(result.team?.name).toBe('Plugin team');
    expect(result.agents).toHaveLength(3);
    expect(agentTeamStore.get(result.team!.id)).toBeDefined();
    // No credentials picked: each unpicked required slot is a warning.
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('rejects a credential of the wrong type for a slot and creates nothing', async () => {
    const { template } = await save({ name: 'Wrong type' });
    const before = { agents: agentStore.list().length, teams: agentTeamStore.list().length };
    const slot = template.credentials.find((s) => s.type === 'core.anthropicApi')!.id;
    const response = await useRoute.POST(post(`/api/templates/${template.id}/use`, { credentials: { [slot]: openai } }), ctx(template.id));
    expect(response.status).toBe(400);
    expect({ agents: agentStore.list().length, teams: agentTeamStore.list().length }).toEqual(before);
  });

  it('survives export and import as a template file, and refuses to swap its flow', async () => {
    const { template } = await save({ workflowId: 'wf_team_flow', name: 'Travels' });
    const file = templates.templateFile(template);
    expect(file.template.bundle?.agents).toHaveLength(3);
    expect(JSON.stringify(file)).not.toContain('SECRET');
    const imported = templates.importTemplate(JSON.parse(JSON.stringify(file)));
    expect(imported.bundle).toEqual(template.bundle);
    // Slots used only by the agents and the remote member stay.
    expect(imported.credentials.map((s) => s.id).sort()).toEqual(template.credentials.map((s) => s.id).sort());
    expect(imported.team).toMatchObject({ agents: 3, hasWorkflow: true });
    const patched = await itemRoute.PATCH(new Request('http://localhost/api/templates/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf_other' }) }), ctx(imported.id));
    expect(patched.status).toBe(400);
    const used = await templates.useTemplate(imported.id, {});
    expect(used.team).toBeDefined();
    expect(used.workflow?.nodes.find((n) => n.type === 'core.runTeam')?.parameters.teamId).toBe(used.team!.id);
  });
});
