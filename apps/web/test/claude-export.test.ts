import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent } from '@/lib/shared/agents';
import type { AgentTeam } from '@/lib/shared/agent-teams';

// Its own data directory: the marketplace store it installs into must not leak into other test files.
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-claude-export-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_MARKETPLACE_REGISTRY_URL: 'off' });

const agentExport = await import('@/app/api/agents/[id]/export/route');
const teamExport = await import('@/app/api/agent-teams/[id]/export/route');
const teams = await import('@/app/api/agent-teams/route');
const { agentStore, configOf } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { agentFromClaude, skillFromClaude } = await import('@/lib/server/marketplace/map');
const { parseAgentData, parseAgentFile, parseSkillFile, parseTeamData } = await import('@/lib/server/marketplace/plugin');
const { parseFrontmatter } = await import('@/lib/server/marketplace/frontmatter');
const { unzipFiles } = await import('@/lib/server/zip');
const { exportAgentPlugin, exportTeamPlugin } = await import('@/lib/server/marketplace/export');
const { marketplace } = await import('@/lib/server/marketplace/service');
const { clearTreeCache } = await import('@/lib/server/marketplace/reader');

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new Request(`http://localhost${path}`);

function makeAgent(): Agent {
  return agentStore.create({
    name: 'Release Notes Writer',
    description: 'Writes release notes.\nUses "quotes" and: colons.',
    icon: 'file-text',
    color: '#3b82f6',
    avatar: { kind: 'face', face: { skin: '#f2c4a3', hair: 'bun', hairColor: '#3d2a1f', eyes: 'calm', brows: 'soft', mouth: 'grin', beard: 'none', glasses: 'round', extra: 'headset' } },
    team: 'Docs crew',
    model: { provider: 'anthropic', model: 'claude-opus-5-5', credential: { id: 'cred_secret', name: 'Mine' } },
    persona: { role: 'Editor for the docs team', tones: ['Precise', 'Brief'], length: 'paragraph', always: ['Cite the PR'], never: ['Invent features'] },
    instructions: 'Summarise merged pull requests.',
    skills: [
      { id: 'sk_1', name: 'Changelog format', whenToUse: 'Use when writing a changelog', instructions: '1. Group by type\n2. Link PRs', allowedTools: ['Read', 'Grep'], references: [{ name: 'style.md', content: '# Style' }] },
    ],
    tools: [
      { id: 'tl_1', type: 'node', name: 'post_message', description: 'Post to Slack', nodeType: 'messaging.slack', parameters: { channel: '#docs' }, credentials: { slackApi: { id: 'cred_slack', name: 'Slack' } } },
      { id: 'tl_2', type: 'mcp', name: 'docs', parameters: { endpointUrl: 'http://x/mcp' }, requireApproval: true },
    ],
    schedules: [{ id: 'sc_1', prompt: 'weekly', frequency: 'daily', timezone: 'UTC', enabled: true }],
  });
}

describe('export as a Claude Code plugin', () => {
  it('writes plugin.json, an agent file, a skill and the Landflow sidecar', async () => {
    const agent = makeAgent();
    const res = await agentExport.GET(get(`/api/agents/${agent.id}/export?format=claude-plugin&marketplace=1`), ctx(agent.id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('release-notes-writer.zip');
    const files = unzipFiles(new Uint8Array(await res.arrayBuffer()));
    const byPath = new Map(files.map((f) => [f.path, f.content.toString('utf8')]));
    expect([...byPath.keys()].sort()).toEqual(
      [
        '.claude-plugin/marketplace.json',
        '.claude-plugin/plugin.json',
        '.landflow/agents/release-notes-writer.json',
        'README.md',
        'agents/release-notes-writer.md',
        'skills/changelog-format/SKILL.md',
        'skills/changelog-format/references/style.md',
      ].sort(),
    );
    const plugin = JSON.parse(byPath.get('.claude-plugin/plugin.json')!);
    expect(plugin).toMatchObject({ name: 'release-notes-writer', version: '1.0.0', author: { name: expect.any(String) } });
    expect(JSON.parse(byPath.get('.claude-plugin/marketplace.json')!).plugins[0]).toMatchObject({ name: 'release-notes-writer', source: './' });
    const front = parseFrontmatter(byPath.get('agents/release-notes-writer.md')!);
    expect(front.data).toMatchObject({ name: 'release-notes-writer', model: 'opus', color: 'blue', tools: 'Read, Grep' });
    expect(front.data.description).toBe('Writes release notes.\nUses "quotes" and: colons.');
    expect(front.body).toContain('Editor for the docs team');
    expect(front.body).toContain('Summarise merged pull requests.');
    const skill = parseFrontmatter(byPath.get('skills/changelog-format/SKILL.md')!);
    expect(skill.data).toMatchObject({ name: 'changelog-format', description: 'Use when writing a changelog', 'allowed-tools': 'Read, Grep' });
    expect(skill.body).toBe('1. Group by type\n2. Link PRs');
    // Credentials, schedules and channels stay home.
    const sidecar = byPath.get('.landflow/agents/release-notes-writer.json')!;
    expect(sidecar).not.toContain('cred_');
    expect(sidecar).not.toContain('schedules');
    agentStore.delete(agent.id);
  });

  it('imports back what it exported: name, description, persona, skills, model, tools, avatar and team label', async () => {
    const agent = makeAgent();
    const exported = exportAgentPlugin(agent);
    const text = (path: string) => exported.files.find((f) => f.path === path)!.content;
    const file = parseAgentFile('agents/release-notes-writer.md', text('agents/release-notes-writer.md'));
    file.landflow = parseAgentData(text('.landflow/agents/release-notes-writer.json'));
    expect(file.landflow?.sourceId).toBe(agent.id);
    const skill = skillFromClaude({ ...parseSkillFile('skills/changelog-format', text('skills/changelog-format/SKILL.md')), references: [{ name: 'style.md', content: '# Style' }] });
    const back = agentFromClaude(file, { pluginId: 'release-notes-writer@acme', skills: [skill] });
    const original = configOf(agent);
    expect(back.name).toBe(original.name);
    expect(back.description).toBe(original.description);
    expect(back.persona).toEqual(original.persona);
    expect(back.instructions).toBe(original.instructions);
    expect(back.model).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(back.tools).toEqual([
      { id: 'tl_1', type: 'node', name: 'post_message', description: 'Post to Slack', nodeType: 'messaging.slack', parameters: { channel: '#docs' } },
      { id: 'tl_2', type: 'mcp', name: 'docs', parameters: { endpointUrl: 'http://x/mcp' }, requireApproval: true },
    ]);
    expect(back.skills).toEqual(original.skills);
    expect(back.avatar).toEqual(original.avatar);
    expect(back.team).toBe('Docs crew');
    expect(back.icon).toBe('file-text');
    expect(back.color).toBe('#3b82f6');
    // The result is a valid new agent.
    const created = agentStore.create(back);
    expect(configOf(created)).toMatchObject({ name: original.name, persona: original.persona, skills: original.skills });
    agentStore.delete(created.id);
    agentStore.delete(agent.id);
  });

  it('treats an edited agent file body as the new prompt', () => {
    const agent = makeAgent();
    const exported = exportAgentPlugin(agent);
    const text = (path: string) => exported.files.find((f) => f.path === path)!.content;
    const edited = text('agents/release-notes-writer.md').replace(/\n---\n[\s\S]*$/, '\n---\n\nYou write terse release notes.\n');
    const file = parseAgentFile('agents/release-notes-writer.md', edited);
    file.landflow = parseAgentData(text('.landflow/agents/release-notes-writer.json'));
    const back = agentFromClaude(file, { pluginId: 'x@y', skills: [] });
    expect(back.instructions).toBe('You write terse release notes.');
    expect(back.persona).toBeUndefined();
    expect(back.tools).toHaveLength(2);
    agentStore.delete(agent.id);
  });

  it('maps another provider’s model to inherit and keeps it in the sidecar', () => {
    const agent = agentStore.create({ name: 'Local', model: { provider: 'ollama', model: 'llama3', baseUrl: 'http://127.0.0.1:11434' } });
    const exported = exportAgentPlugin(agent);
    expect(parseFrontmatter(exported.files.find((f) => f.path === 'agents/local.md')!.content).data.model).toBe('inherit');
    const data = parseAgentData(exported.files.find((f) => f.path === '.landflow/agents/local.json')!.content)!;
    expect(data.config.model).toEqual({ provider: 'ollama', model: 'llama3', baseUrl: 'http://127.0.0.1:11434' });
    agentStore.delete(agent.id);
  });

  it('exports a team with its relations and imports them back', async () => {
    const lead = agentStore.create({ name: 'Lead', instructions: 'Lead the team', tools: [] });
    const dev = agentStore.create({ name: 'Developer', instructions: 'Write code' });
    agentStore.saveDraft(lead.id, { tools: [{ id: 'tl_sub', type: 'agent', agentId: dev.id }] });
    const created = await teams.POST(
      new Request('http://localhost/api/agent-teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Plugin team',
          goal: 'Ship it',
          members: [
            { id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' },
            { id: 'm_dev', kind: 'agent', agentId: dev.id, title: 'Developer', reportsTo: 'm_lead', budgetTokens: 5000 },
            { id: 'm_rev', kind: 'a2a', title: 'Reviewer', reportsTo: 'm_lead', reviews: ['m_dev'], parameters: { agentUrl: 'http://kagent/rev' }, credentials: { httpBearerAuth: { id: 'cred_x', name: 'x' } } },
          ],
        }),
      }),
    );
    const team = (await created.json()).team as AgentTeam;
    const res = await teamExport.GET(get(`/api/agent-teams/${team.id}/export`), ctx(team.id));
    expect(res.headers.get('content-disposition')).toContain('plugin-team.zip');
    const files = unzipFiles(new Uint8Array(await res.arrayBuffer()));
    const byPath = new Map(files.map((f) => [f.path, f.content.toString('utf8')]));
    expect(byPath.has('agents/lead.md')).toBe(true);
    expect(byPath.has('agents/developer.md')).toBe(true);
    expect(byPath.get('.landflow/team.json')).not.toContain('cred_x');
    const data = parseTeamData(byPath.get('.landflow/team.json')!)!;
    expect(data.team.name).toBe('Plugin team');
    expect(data.team.members).toEqual([
      { id: 'm_lead', kind: 'agent', agent: 'lead', title: 'Lead' },
      { id: 'm_dev', kind: 'agent', agent: 'developer', title: 'Developer', reportsTo: 'm_lead', budgetTokens: 5000 },
      { id: 'm_rev', kind: 'a2a', title: 'Reviewer', reportsTo: 'm_lead', reviews: ['m_dev'], parameters: { agentUrl: 'http://kagent/rev' } },
    ]);
    const leadFile = parseAgentData(byPath.get('.landflow/agents/lead.json')!)!;
    expect(leadFile.sourceId).toBe(lead.id);
    expect(leadFile.config.tools).toEqual([{ id: 'tl_sub', type: 'agent', agentId: dev.id }]);
    for (const id of [lead.id, dev.id]) agentStore.delete(id);
    agentTeamStore.delete(team.id);
  });

  it('answers 404 for a missing agent or team, 400 for another format, and a file list for a preview', async () => {
    expect((await agentExport.GET(get('/api/agents/nope/export'), ctx('nope'))).status).toBe(404);
    expect((await teamExport.GET(get('/api/agent-teams/nope/export'), ctx('nope'))).status).toBe(404);
    const agent = makeAgent();
    expect((await agentExport.GET(get(`/api/agents/${agent.id}/export?format=zip`), ctx(agent.id))).status).toBe(400);
    const preview = await (await agentExport.GET(get(`/api/agents/${agent.id}/export?preview=1`), ctx(agent.id))).json();
    expect(preview.name).toBe('release-notes-writer');
    expect(preview.files.map((f: { path: string }) => f.path)).toContain('.claude-plugin/plugin.json');
    agentStore.delete(agent.id);
  });
});

describe('installing an exported team', () => {
  const root = mkdtempSync(join(tmpdir(), 'landflow-export-'));
  let addedId: string | undefined;
  beforeAll(() => {
    process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL = '1';
    clearTreeCache();
  });
  afterAll(async () => {
    delete process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL;
    // The marketplace store is shared by every test file in this worker: leave it as found.
    if (addedId) await marketplace.remove(addedId);
  });

  it('creates the agents, sub-agent links and the team, and uninstall removes them', async () => {
    const dev = agentStore.create({ name: 'Builder', instructions: 'Build', persona: { role: 'Builder' } });
    const lead = agentStore.create({ name: 'Boss', instructions: 'Lead', tools: [{ id: 'tl_a', type: 'agent', agentId: dev.id }] });
    const exported = exportTeamPlugin(
      {
        name: 'Round trip',
        goal: 'Ship',
        members: [
          { id: 'm_1', kind: 'agent', agentId: lead.id, title: 'Boss' },
          { id: 'm_2', kind: 'agent', agentId: dev.id, title: 'Builder', reportsTo: 'm_1', reviews: [] },
          { id: 'm_3', kind: 'a2a', title: 'Remote', reportsTo: 'm_1', parameters: { agentUrl: 'http://kagent/x' } },
        ],
      },
      { marketplace: true },
    );
    for (const file of exported.files) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.content);
    }
    for (const id of [lead.id, dev.id]) agentStore.delete(id);
    const added = await marketplace.add(root);
    addedId = added.id;
    const result = (await marketplace.install(added.id, 'round-trip')) as { installed: { id: string; agents: Array<{ id: string; name: string }>; teams?: Array<{ id: string; name: string }> } };
    expect(result.installed.agents.map((a) => a.name).sort()).toEqual(['Boss', 'Builder']);
    const [team] = result.installed.teams!;
    const draft = agentTeamStore.get(team.id)!.draft;
    const agentIds = new Map(result.installed.agents.map((a) => [a.name, a.id]));
    expect(draft).toMatchObject({ name: 'Round trip', goal: 'Ship' });
    expect(draft.members).toMatchObject([
      { id: 'm_1', kind: 'agent', agentId: agentIds.get('Boss'), title: 'Boss' },
      { id: 'm_2', kind: 'agent', agentId: agentIds.get('Builder'), reportsTo: 'm_1' },
      { id: 'm_3', kind: 'a2a', reportsTo: 'm_1', parameters: { agentUrl: 'http://kagent/x' } },
    ]);
    const boss = agentStore.get(agentIds.get('Boss')!)!;
    expect(boss.tools).toEqual([{ id: 'tl_a', type: 'agent', agentId: agentIds.get('Builder') }]);
    expect(agentStore.get(agentIds.get('Builder')!)!.persona).toEqual({ role: 'Builder' });

    await marketplace.uninstall(result.installed.id);
    expect(agentTeamStore.get(team.id)).toBeUndefined();
    expect(agentStore.get(agentIds.get('Boss')!)).toBeUndefined();
  });
});
