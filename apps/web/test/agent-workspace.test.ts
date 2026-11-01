/**
 * The agent workspace (docs/agents.md, "Avatars", "Teams" and "Templates"): faces and other avatars are cleaned and never
 * reach the prompt, teams group the roster, and personas start new agents: built in, or saved from an agent without its
 * tools, channels, schedules or credentials.
 */
import { describe, expect, it } from 'vitest';
import type { AgentConfig, AgentSummary, AgentTemplate } from '@/lib/shared/agents';

const { agentStore } = await import('@/lib/server/agents/store');
const { personaPrompt } = await import('@/lib/shared/persona');
const { cleanAvatar, cleanFace, randomFace, DEFAULT_FACE, CHROME_SKIN } = await import('@/lib/shared/faces');
const { BUILTIN_AGENT_TEMPLATES } = await import('@/lib/server/agents/templates');
const agentsRoute = await import('@/app/api/agents/route');
const templatesRoute = await import('@/app/api/agent-templates/route');
const templateRoute = await import('@/app/api/agent-templates/[id]/route');

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const call = async <T,>(handler: unknown, method: string, body?: unknown, id = ''): Promise<{ status: number; data: T }> => {
  const init = { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
  const response = await (handler as Handler)(new Request(`http://localhost/api/x/${id}`, init), { params: Promise.resolve({ id }) });
  return { status: response.status, data: (await response.json()) as T };
};

const PNG = `data:image/png;base64,${'A'.repeat(64)}`;

describe('faces and avatars', () => {
  it('makes the same face from the same seed, a different one from another, and sometimes a robot', () => {
    expect(randomFace('ag_123')).toEqual(randomFace('ag_123'));
    const faces = Array.from({ length: 60 }, (_, i) => randomFace(`agent-${i}`));
    expect(new Set(faces.map((f) => JSON.stringify(f))).size).toBeGreaterThan(50);
    const robots = faces.filter((f) => f.skin === CHROME_SKIN);
    expect(robots.length).toBeGreaterThan(0);
    expect(robots.every((f) => f.extra === 'antenna' && f.hair === 'bald')).toBe(true);
    for (const face of faces) expect(cleanFace(face)).toEqual(face);
  });

  it('cleans a face: unknown parts and colours fall back to the default ones', () => {
    expect(cleanFace({ skin: 'pink', hair: 'mullet', hairColor: '#ABCDEF', eyes: 'happy' })).toEqual({ ...DEFAULT_FACE, hairColor: '#abcdef', eyes: 'happy' });
    expect(cleanFace('face')).toBeUndefined();
  });

  it('keeps only the part an avatar’s kind uses, and drops what isn’t valid', () => {
    expect(cleanAvatar({ kind: 'face', face: randomFace('x'), initials: 'AB', image: PNG })).toEqual({ kind: 'face', face: randomFace('x') });
    expect(cleanAvatar({ kind: 'initials', initials: ' t f x', solid: true })).toEqual({ kind: 'initials', initials: 'TF', solid: true });
    expect(cleanAvatar({ kind: 'initials', initials: '  ' })).toBeUndefined();
    expect(cleanAvatar({ kind: 'image', image: PNG, solid: true })).toEqual({ kind: 'image', image: PNG });
    expect(cleanAvatar({ kind: 'image', image: 'https://example.com/a.png' })).toBeUndefined();
    expect(cleanAvatar({ kind: 'image', image: `data:image/png;base64,${'A'.repeat(200_001)}` })).toBeUndefined();
    expect(cleanAvatar({ kind: 'image', image: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBeUndefined();
    // The icon on a tinted tile is the default, so it isn't stored; a solid tile is.
    expect(cleanAvatar({ kind: 'icon' })).toBeUndefined();
    expect(cleanAvatar({ kind: 'icon', solid: true })).toEqual({ kind: 'icon', solid: true });
    expect(cleanAvatar({ kind: 'face' })).toBeUndefined();
  });

  it('stores the avatar and team with the agent, and neither changes the prompt kagent and the runtime use', () => {
    const base: Partial<AgentConfig> = { name: 'Docs editor', persona: { role: 'Editor' }, instructions: 'Tidy drafts.' };
    const plain = agentStore.create(base);
    const dressed = agentStore.create({ ...base, avatar: { kind: 'face', face: randomFace('docs') }, team: '  Content   team ' });
    expect(dressed.avatar).toEqual({ kind: 'face', face: randomFace('docs') });
    expect(dressed.team).toBe('Content team');
    expect(personaPrompt(dressed)).toBe(personaPrompt(plain));
    expect(agentStore.create({ ...base, team: '   ' }).team).toBeUndefined();
  });

  it('gives the roster what its cards show: avatar, team, role, tones and where the published version runs', () => {
    const agent = agentStore.create({
      name: 'On-call',
      team: 'Operations',
      avatar: { kind: 'initials', initials: 'OC' },
      persona: { role: 'Incident responder', tones: ['Calm', 'Direct'] },
      channels: [{ id: 'ch1', type: 'slack', enabled: true, credential: { id: 'c1', name: 'Slack' } } as never],
      schedules: [{ id: 's1', enabled: true, frequency: 'daily', time: '09:00', timezone: 'UTC', prompt: 'Check alerts' } as never],
    });
    agentStore.publish(agent.id);
    const summary = agentStore.summaries().find((s) => s.id === agent.id) as AgentSummary;
    expect(summary).toMatchObject({ team: 'Operations', avatar: { kind: 'initials', initials: 'OC' }, role: 'Incident responder', tones: ['Calm', 'Direct'], channels: ['slack'], schedules: 1, draftChanged: false });
    const bare = agentStore.create({ name: 'Bare' });
    expect(agentStore.summaries().find((s) => s.id === bare.id)).toMatchObject({ channels: [], schedules: 0 });
  });
});

describe('templates', () => {
  it('lists the built-in personas first, the blank one last among them', async () => {
    const { status, data } = await call<{ templates: AgentTemplate[] }>(templatesRoute.GET, 'GET');
    expect(status).toBe(200);
    const builtin = data.templates.filter((t) => t.source === 'builtin');
    expect(builtin.map((t) => t.id)).toEqual(BUILTIN_AGENT_TEMPLATES.map((t) => t.id));
    expect(builtin.at(-1)?.id).toBe('blank');
    // Every persona but the blank one comes with a face.
    expect(builtin.filter((t) => t.id !== 'blank').every((t) => t.config.avatar?.kind === 'face' && t.config.persona?.role)).toBe(true);
  });

  it('creates an agent from a built-in persona, with the name and avatar the dialog gave', async () => {
    const avatar = { kind: 'face', face: randomFace('mine') };
    const { status, data } = await call<{ agent: { id: string } }>(agentsRoute.POST, 'POST', { templateId: 'support-lead', name: 'Helpdesk', avatar, team: 'Support' });
    expect(status).toBe(201);
    const agent = agentStore.get(data.agent.id)!;
    expect(agent).toMatchObject({ name: 'Helpdesk', team: 'Support', icon: 'headset', avatar, persona: { role: 'Customer support lead' } });
    expect(agent.tools).toEqual([]);
    expect(agent.published).toBeUndefined();

    const blank = await call<{ agent: { id: string } }>(agentsRoute.POST, 'POST', { templateId: 'blank' });
    expect(agentStore.get(blank.data.agent.id)).toMatchObject({ name: 'Untitled agent' });
    expect(agentStore.get(blank.data.agent.id)?.persona).toBeUndefined();

    expect((await call(agentsRoute.POST, 'POST', { templateId: 'nope' })).status).toBe(404);
    // Without a template or an avatar (a script, another agent): a face from its name, never the bare robot icon.
    const plain = await call<{ agent: { id: string } }>(agentsRoute.POST, 'POST', { name: 'Plain' });
    expect(agentStore.get(plain.data.agent.id)).toMatchObject({ name: 'Plain', icon: 'bot', avatar: { kind: 'face', face: randomFace('Plain') } });
    // An icon asked for stays an icon.
    const iconic = await call<{ agent: { id: string } }>(agentsRoute.POST, 'POST', { name: 'Iconic', avatar: { kind: 'icon', solid: true } });
    expect(agentStore.get(iconic.data.agent.id)?.avatar).toEqual({ kind: 'icon', solid: true });
  });

  it('saves an agent as a template without its tools, channels, schedules, team or credential, and starts new agents from it', async () => {
    const helper = agentStore.create({ name: 'Formatter' });
    const source = agentStore.create({
      name: 'Release notes',
      description: 'Writes release notes',
      team: 'Content',
      avatar: { kind: 'face', face: randomFace('notes') },
      model: { provider: 'anthropic', model: 'claude-sonnet-5-5', credential: { id: 'cred_1', name: 'Anthropic' } },
      persona: { role: 'Writer', tones: ['Warm'] },
      instructions: 'Group the changes.',
      tools: [
        { type: 'node', id: 't1', name: 'github_prs', description: 'Merged PRs', nodeType: 'core.httpRequest', parameters: {} },
        { type: 'agent', id: 't2', agentId: helper.id, description: 'Formats text' },
      ] as never,
      channels: [{ id: 'ch1', type: 'slack', enabled: true } as never],
      schedules: [{ id: 's1', enabled: true, frequency: 'weekly', weekday: 5, time: '16:00', timezone: 'UTC', prompt: 'Write the notes' } as never],
    });
    const saved = await call<{ template: AgentTemplate }>(templatesRoute.POST, 'POST', { agentId: source.id, category: 'Content' });
    expect(saved.status).toBe(201);
    const template = saved.data.template;
    expect(template).toMatchObject({ source: 'saved', name: 'Release notes', category: 'Content', description: 'Writes release notes', suggests: 'github_prs, Formatter', canEdit: true });
    expect(template.config).toMatchObject({ persona: { role: 'Writer', tones: ['Warm'] }, instructions: 'Group the changes.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
    expect(template.config.model?.credential).toBeUndefined();
    for (const key of ['tools', 'channels', 'schedules', 'team', 'name'] as const) expect(template.config[key]).toBeUndefined();

    const listed = await call<{ templates: AgentTemplate[] }>(templatesRoute.GET, 'GET');
    expect(listed.data.templates.find((t) => t.id === template.id)).toMatchObject({ source: 'saved', canEdit: true });

    const created = await call<{ agent: { id: string } }>(agentsRoute.POST, 'POST', { templateId: template.id });
    expect(agentStore.get(created.data.agent.id)).toMatchObject({ name: 'Release notes', persona: { role: 'Writer' }, avatar: source.avatar, tools: [], channels: [], schedules: [] });
    expect(agentStore.get(created.data.agent.id)?.team).toBeUndefined();

    expect((await call(templateRoute.DELETE, 'DELETE', undefined, template.id)).status).toBe(200);
    expect((await call<{ templates: AgentTemplate[] }>(templatesRoute.GET, 'GET')).data.templates.some((t) => t.id === template.id)).toBe(false);
    // Built-in ones can't be deleted, and an unknown agent can't be saved.
    expect((await call(templateRoute.DELETE, 'DELETE', undefined, 'support-lead')).status).toBe(404);
    expect((await call(templatesRoute.POST, 'POST', { agentId: 'ag_nope' })).status).toBe(404);
  });
});
