/** C23: comparing two published versions of an agent: the field diff (lib/shared/agent-diff.ts) and GET /api/agents/:id/versions/:version. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS, type AgentConfig, type AgentToolConfig } from '../src/lib/shared/agents';
import { agentFields, diffAgentConfigs } from '../src/lib/shared/agent-diff';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-compare-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const base = (): AgentConfig => ({
  name: 'Triager',
  description: 'Sorts alerts',
  icon: 'bot',
  color: '#123456',
  instructions: 'Answer briefly.',
  skills: [],
  tools: [],
  schedules: [],
  channels: [],
  memory: { crossSession: false },
  settings: { ...DEFAULT_AGENT_SETTINGS },
  model: { provider: 'ollama', model: 'qwen3:8b' },
});
const slack = (extra: Partial<Extract<AgentToolConfig, { type: 'node' }>> = {}): AgentToolConfig => ({
  id: 't_slack',
  type: 'node',
  name: 'post_to_slack',
  description: 'Post a message',
  nodeType: 'messaging.slack',
  parameters: { channel: '#oncall', text: '$fromAI("text")' },
  credentials: { slackApi: { id: 'cr_9', name: 'Slack bot' } },
  ...extra,
});

describe('diffAgentConfigs', () => {
  it('lists a changed prompt, one tool’s parameters and the model, and counts the rest as unchanged', () => {
    const a = { ...base(), tools: [slack()] };
    const b: AgentConfig = {
      ...a,
      instructions: 'Answer briefly and cite sources.',
      model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      tools: [slack({ parameters: { channel: '#alerts', text: '$fromAI("text")' } })],
    };
    const { changes, unchanged } = diffAgentConfigs(a, b);
    expect(changes.map((c) => c.label)).toEqual(['Model', 'Instructions', 'Tool “post_to_slack”']);
    expect(changes.every((c) => c.kind === 'changed')).toBe(true);
    const model = changes[0];
    expect(model.before).toContain('qwen3:8b');
    expect(model.after).toContain('claude-sonnet-5-5');
    expect(changes[2].before).toContain('#oncall');
    expect(changes[2].after).toContain('#alerts');
    // name, description, memory, limits and the credential-free rest of the fields.
    expect(unchanged).toBeGreaterThanOrEqual(4);
    expect(unchanged).toBe(agentFields(a).length - 3);
  });

  it('matches tools by id: a renamed tool is one change, not a remove and an add', () => {
    const a = { ...base(), tools: [slack()] };
    const b = { ...base(), tools: [slack({ name: 'notify_oncall' })] };
    const { changes } = diffAgentConfigs(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'changed', label: 'Tool “notify_oncall”' });
    expect(changes[0].before).toContain('post_to_slack');
    expect(changes[0].after).toContain('notify_oncall');
  });

  it('shows a tool that appeared as added and one that went as removed', () => {
    const a = { ...base(), tools: [slack()] };
    const b = { ...base(), tools: [slack({ id: 't_other', name: 'other' })] };
    const kinds = Object.fromEntries(diffAgentConfigs(a, b).changes.map((c) => [c.field, c.kind]));
    expect(kinds).toEqual({ 'tool:t_other': 'added', 'tool:t_slack': 'removed' });
  });

  it('shows credentials by name, never by id or data', () => {
    const a = { ...base(), tools: [slack()] };
    const text = agentFields(a).map((f) => f.value).join('\n');
    expect(text).toContain('Slack bot');
    expect(text).not.toContain('cr_9');
    // The credential's current name wins over the one saved in the config.
    const renamed = agentFields(a, { credential: (id) => (id === 'cr_9' ? 'Slack bot (new)' : undefined) }).map((f) => f.value).join('\n');
    expect(renamed).toContain('Slack bot (new)');
    const { changes } = diffAgentConfigs({ ...a, model: { provider: 'openai', model: 'gpt', credential: { id: 'cr_1', name: 'Key A' } } }, { ...a, model: { provider: 'openai', model: 'gpt', credential: { id: 'cr_2', name: 'Key B' } } });
    expect(changes[0].before).toContain('Key A');
    expect(changes[0].after).toContain('Key B');
    expect(JSON.stringify(changes)).not.toContain('cr_');
  });

  it('leaves the look (icon, color) out and ignores key order in parameters', () => {
    const a = { ...base(), tools: [slack({ parameters: { channel: '#oncall', text: 'x' } })] };
    const b = { ...base(), icon: 'rocket', color: '#ffffff', tools: [slack({ parameters: { text: 'x', channel: '#oncall' } })] };
    expect(diffAgentConfigs(a, b).changes).toEqual([]);
  });

  it('two identical configs: no change, every field unchanged', () => {
    const a = base();
    const diff = diffAgentConfigs(a, structuredClone(a));
    expect(diff.changes).toEqual([]);
    expect(diff.unchanged).toBe(agentFields(a).length);
  });

  it('leaves a knowledge base’s index state (lastIndex) out, so re-indexing is not a change', () => {
    const kb = (lastIndex: unknown): AgentToolConfig => ({ id: 'kb1', type: 'knowledge', name: 'runbooks', description: 'Search runbooks', store: 'sqlite', collection: 'runbooks', embeddings: { provider: 'none', model: 'bm25' }, lastIndex } as AgentToolConfig);
    const a = { ...base(), tools: [kb({ at: '2026-11-01T00:00:00.000Z', documents: 3 })] };
    const b = { ...base(), tools: [kb({ at: '2026-11-02T00:00:00.000Z', documents: 9 })] };
    expect(diffAgentConfigs(a, b).changes).toEqual([]);
    expect(agentFields(a).find((f) => f.field === 'tool:kb1')?.value).not.toContain('lastIndex');
    // A real change to the knowledge base still shows.
    expect(diffAgentConfigs(a, { ...b, tools: [{ ...kb(undefined), collection: 'other' } as AgentToolConfig] }).changes).toHaveLength(1);
  });

  it('names schedules, skills, channels and knowledge bases by what they are', () => {
    const config: AgentConfig = {
      ...base(),
      skills: [{ id: 's1', name: 'Escalate', whenToUse: 'when paged', instructions: 'page the lead' }],
      schedules: [{ id: 'sc1', prompt: 'Check the queue', frequency: 'daily', time: '09:00', timezone: 'UTC', enabled: true }],
      channels: [{ id: 'ch1', type: 'slack', credential: { id: 'cr_3', name: 'Slack app' }, access: 'private', allowedUsers: ['U1'], newSessionAfterMinutes: 0, enabled: true }],
      tools: [{ id: 'kb1', type: 'knowledge', name: 'runbooks', description: 'Search runbooks', store: 'sqlite', collection: 'runbooks', embeddings: { provider: 'none', model: 'bm25' } }],
    };
    const labels = agentFields(config).map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(['Skill “Escalate”', 'Schedule “Check the queue”', 'Channel (slack)', 'Knowledge base “runbooks”']));
  });
});

describe('GET /api/agents/:id/versions/:version', () => {
  const auth = import('@/lib/server/auth');
  const projectsP = import('@/lib/server/projects');
  const storeP = import('@/lib/server/agents/store');
  const routeP = import('@/app/api/agents/[id]/versions/[version]/route');
  let agentId = '';
  let member: { id: string; session: string };
  let owner: { id: string; session: string };

  afterAll(() => {
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  beforeAll(async () => {
    const [a, projects, { agentStore }] = await Promise.all([auth, projectsP, storeP]);
    a.disableTestAuth();
    const make = async (email: string, name: string, role: 'owner' | 'member') => {
      const record = role === 'owner' ? await a.createOwner({ email, name, password: 'password-123' }) : await a.createUser({ email, name, role, password: 'password-123' });
      return { id: record.id, session: a.createSession(record, 'password').token };
    };
    owner = await make('owner@example.com', 'Olive', 'owner');
    member = await make('member@example.com', 'Mo', 'member');
    const team = projects.createTeamProject({ name: 'Theirs' });
    projects.setMember(team.id, owner.id, 'admin');
    const { name: _n, ...rest } = base();
    const agent = agentStore.create({ name: 'Triager', ...rest });
    projects.setHomeProject('agent', agent.id, team.id);
    agentId = agent.id;
    agentStore.publish(agentId);
    agentStore.saveDraft(agentId, { instructions: 'Answer briefly and cite sources.' });
    agentStore.publish(agentId);
    agentStore.saveDraft(agentId, { instructions: 'Answer in one line.' });
    agentStore.publish(agentId);
  });

  const get = async (version: string, session: string) => {
    const route = await routeP;
    const response = await route.GET(new Request(`http://localhost:3000/api/agents/${agentId}/versions/${version}`, { headers: { cookie: `landflow_session=${session}` } }), { params: Promise.resolve({ id: agentId, version }) });
    return { status: response.status, body: (await response.json()) as { version?: number; publishedAt?: string; config?: AgentConfig; error?: string } };
  };

  it('answers the config of a published version, the live one and an older one', async () => {
    const third = await get('3', owner.session);
    expect(third.status).toBe(200);
    expect(third.body.version).toBe(3);
    expect(third.body.config?.instructions).toBe('Answer in one line.');
    expect(third.body.publishedAt).toBeTruthy();
    const first = await get('1', owner.session);
    expect(first.body.config?.instructions).toBe('Answer briefly.');
    expect((await get('2', owner.session)).body.config?.instructions).toBe('Answer briefly and cite sources.');
  });

  it('the versions list names who published each version, when it was recorded', async () => {
    const { agentStore } = await storeP;
    // The publish route passes the person; the store records it with the version.
    agentStore.saveDraft(agentId, { instructions: 'Answer in two lines.' });
    agentStore.publish(agentId, owner.id);
    const listRoute = await import('@/app/api/agents/[id]/versions/route');
    const res = await listRoute.GET(new Request(`http://localhost:3000/api/agents/${agentId}/versions`, { headers: { cookie: `landflow_session=${owner.session}` } }), { params: Promise.resolve({ id: agentId }) });
    const body = (await res.json()) as { versions: Array<{ version: number; publishedBy?: string; publishedByName?: string }> };
    const latest = body.versions.find((v) => v.version === 4);
    expect(latest).toMatchObject({ publishedBy: owner.id, publishedByName: 'Olive' });
    // Versions published without a person (before this was recorded) carry no name.
    expect(body.versions.find((v) => v.version === 1)?.publishedByName).toBeUndefined();
  });

  it('is 404 for an unknown version, a bad one, and an agent the caller cannot read', async () => {
    expect((await get('9', owner.session)).status).toBe(404);
    expect((await get('abc', owner.session)).status).toBe(404);
    expect((await get('0', owner.session)).status).toBe(404);
    // A member of no project that has the agent: it is not theirs to see.
    expect((await get('3', member.session)).status).toBe(404);
  });
});
