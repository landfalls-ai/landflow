/**
 * AG19 (wave ag4): Spotlight reuses an agent the tenant has and says why, or builds one from the tenant (the plugins it
 * finds, an existing knowledge base, the model the person named), and its agent card draws the proposed agent as bubbles.
 * The server side (this file; the card's bubbles are `agent-reuse-card-ag4.test.ts`, which needs a DOM). Models are scripted (a local fake Ollama, `test/fake-ai-services.ts`); the triage and messaging plugins are the recorded
 * manifests' stand-ins; the `runbooks` base is the four fixture documents in a temp files directory. Nothing leaves this machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelTurn } from '@landflow/engine';
import { attachedLine, reuseLine } from '@/lib/shared/agent-card';
import { reuseSentence } from '@/lib/shared/tenant-catalog';
import { startFakeModels, type FakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const { prepare, addScenarioPlugins, runScenario } = await import('./spotlight-scenarios/harness');
const { default: scenarios } = await import('./spotlight-scenarios/sb-ag19');
const { agentStore } = await import('@/lib/server/agents/store');
const { registry } = await import('@/lib/server/plugins/registry');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { draftFrom, fromDesign, modelWhyOf, catalogAgents, designBrief } = await import('@/lib/server/assistant/architect');
const { TOOLS } = await import('@/lib/server/assistant/chat');
const { buildFlow, agentReading } = await import('@/lib/server/flow-builder');

const scenario = (id: string) => scenarios.find((s) => s.id === id)!;

beforeAll(async () => {
  prepare();
  await addScenarioPlugins({ start: { plugins: ['triage', 'messaging'] } }, 'unit');
});

// ---------------------------------------------------------------------------
// The chat: the rule, the op schema, and a reuse that makes no agent
// ---------------------------------------------------------------------------

describe('the chat reuses an agent and says why', () => {
  it('asks for list_agents first, reuses with Reuses “name”: why, and builds from the tenant when none fits', () => {
    const propose = TOOLS.find((t) => t.name === 'propose_changes')!;
    const schema = JSON.stringify(propose.inputSchema);
    for (const field of ['"knowledgeBase"', '"knowledgeFolder"', '"toolNodes"', '"model"', '"changeAgent"']) expect(schema).toContain(field);
  });

  it('asks.md A with Alert triager published: the model calls list_agents, runs it with its id, no agent is made, the reply says why', async () => {
    const outcome = await runScenario(scenario('ag19-reuse-chat'), 'unit');
    expect(outcome.error).toBeUndefined();
    expect(outcome.tools.indexOf('list_agents')).toBeGreaterThanOrEqual(0);
    expect(outcome.agentCount!.after).toBe(outcome.agentCount!.before);
    expect(outcome.text).toMatch(/^Reuses “Alert triager”: .+\.$/m);
    const s1 = agentStore.list().find((a) => a.name === 'Alert triager')!;
    expect(outcome.placed).toEqual([{ node: 'Alert triager', type: 'core.messageAgent', agentId: s1.id }]);
    // No ai_tool is wired into the placed node: the agent has its own tools.
    expect((outcome.after?.connections ?? []).some((c) => c.type === 'ai_tool')).toBe(false);
  });

  it('the Agents rule no longer tells the person to give the new agent tools or publish it (Spotlight does both)', async () => {
    const seen: string[] = [];
    const { runChat } = await import('@/lib/server/assistant/chat');
    await runChat({
      messages: [{ role: 'user', content: 'hello' }],
      workflow: { id: 'w', name: 'x', active: false, nodes: [], connections: [], pinData: {}, settings: {} } as never,
      model: { provider: 'test', model: 'scripted', async generate(input: { system?: string }) { seen.push(input.system ?? ''); return { text: 'ok', toolCalls: [], stopReason: 'stop' } as ModelTurn; } } as never,
      types: registry.nodeTypes(),
      teams: [],
      agents: [],
      actor: TEST_OWNER,
      onEvent: () => {},
    } as never);
    const system = seen[0] ?? '';
    expect(system).toContain('call list_agents');
    expect(system).toContain('Reuses “<agent name>”: <why, one clause>.');
    expect(system).toContain('read_agent_practices, list_tool_nodes');
    expect(system).not.toContain('tell the user to give it tools on the Agents page');
  });
});

// ---------------------------------------------------------------------------
// The design: reuse, plugins found by what the job needs, an existing base, the model's why
// ---------------------------------------------------------------------------

describe('the design route', () => {
  let fake: FakeModels;
  let script: Array<Partial<ModelTurn>>;
  const previousOllama = process.env.OLLAMA_URL;
  beforeAll(async () => {
    fake = await startFakeModels({
      reply: (_p, body) => {
        if (!Array.isArray((body as { messages?: unknown } | undefined)?.messages)) return { text: '', toolCalls: [] };
        const next = script.shift();
        if (!next) throw new Error('No scripted turn left');
        return { text: next.text ?? '', toolCalls: (next.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.input })) };
      },
    });
    process.env.OLLAMA_URL = fake.origin;
  });
  afterAll(async () => {
    await fake.close();
    if (previousOllama === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = previousOllama;
  });

  /** The tenant of asks.md: S1, S2 and the `runbooks` base, seeded by the scenario harness. */
  async function tenant() {
    await runScenario({ ...scenario('ag19-no-fit-no-reuse'), script: [{ text: 'x' }] } as never, 'unit').catch(() => undefined);
  }
  const design = async (body: Record<string, unknown>) => {
    const route = await import('@/app/api/agents/design/route');
    const response = await route.POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preview: true, instructions: '', ...body }) }));
    return { status: response.status, body: (await response.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const propose = (extra: Record<string, unknown>) => ({ text: '', toolCalls: [{ id: 'c1', name: 'propose_design', input: { summary: 's', name: 'Agent', role: 'Helper', instructions: 'Input: x.\nSteps:\n1. Work.\nOutput: y.\nHand over when: z.', ...extra } }] });
  const S1_ASK = 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.';
  const B_ASK = 'I need an agent that reads an alert someone pastes, pulls out the IPs and domains in it, and tells us what our incident runbooks say to do about it. Keep it cheap: Haiku is fine.';

  beforeEach(async () => {
    // seed through the harness once per test: S1, S2 and runbooks
    const sc = scenario('ag19-build-plugin-kb-model');
    script = [propose({}), { text: 'Designed.' }, { text: 'No cases.' }];
    await runScenario({ ...sc, script: [...script, ...script] } as never, 'unit');
    script = [];
  });

  it('answers reuse for the triage agent’s own ask, and the catalog it read', async () => {
    const s1 = agentStore.list().find((a) => a.name === 'Alert triager')!;
    script = [propose({ name: 'Alert triager', reuseAgentId: s1.id, reuseWhy: 'it normalises alerts, pulls out the IOCs and emails oncall@landflow.test' }), { text: 'Designed.' }, { text: 'No cases.' }];
    const { status, body } = await design({ name: 'Alert triager', description: 'Triages an alert.', ask: S1_ASK });
    expect(status).toBe(200);
    expect(body.reuse).toEqual({ agentId: s1.id, name: 'Alert triager', why: 'it normalises alerts, pulls out the IOCs and emails oncall@landflow.test', published: true, gaps: [] });
    expect(reuseLine(body.reuse)).toMatch(/^“Alert triager” already does this: .+ \(published\)$/);
    expect((body.catalog as Array<{ tool: string }>).map((c) => c.tool)).toEqual(expect.arrayContaining(['list_agents', 'list_tool_nodes', 'list_knowledge_bases', 'list_models']));
  });

  it('a made-up agent id to reuse is dropped, never answered', async () => {
    script = [propose({ reuseAgentId: 'ag_nope', reuseWhy: 'x' }), { text: 'Designed.' }, { text: 'No cases.' }];
    const { body } = await design({ name: 'Advisor', description: 'x', ask: B_ASK });
    expect(body.reuse).toBeUndefined();
  });

  it('asks.md B: Extract IOCs found by what the job needs, the runbooks base attached as it is, no Send Email, the model unavailable is said', async () => {
    const before = agentStore.list().length;
    const s2 = agentStore.list().find((a) => a.name === 'Runbook answerer')!;
    const s2Kb = s2.tools.find((t) => t.type === 'knowledge')!;
    script = [propose({ nodeTools: 'triage.extractIocs', knowledgeBase: 'runbooks' }), { text: 'Designed.' }, { text: 'No cases.' }];
    const { body } = await design({ name: 'Alert advisor', description: 'Reads an alert.', ask: B_ASK });
    const tools = (body.config.tools as Array<{ type: string; nodeType?: string; collection?: string; store?: string; embeddings?: unknown }>);
    expect(tools.some((t) => t.nodeType === 'triage.extractIocs')).toBe(true);
    expect(tools.some((t) => /emailSend/.test(t.nodeType ?? ''))).toBe(false);
    expect(body.attached).toEqual({ collection: 'runbooks', documents: 4, search: 'keyword' });
    expect(body.knowledge.folder).toBeUndefined();
    const kb = tools.find((t) => t.type === 'knowledge')!;
    expect({ store: kb.store, collection: kb.collection, embeddings: kb.embeddings }).toEqual({ store: (s2Kb as any).store, collection: 'runbooks', embeddings: (s2Kb as any).embeddings }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(attachedLine(body.attached)).toBe('runbooks · 4 documents · keyword search (BM25, built in) · already indexed');
    // Haiku is not listed on this host: the host's model stays, and the card says so (never another model).
    expect(body.modelWhy).toBe('unavailable');
    expect(body.modelNote).toMatch(/^Haiku isn’t available on this host: it runs on /);
    expect(agentStore.list().length).toBe(before); // a preview saves nothing
  });

  it('a newAgent hint reaches the design: toolNodes kept, a knowledgeBase the tenant lacks dropped with why', async () => {
    script = [propose({ nodeTools: '' }), { text: 'Designed.' }, { text: 'No cases.' }];
    const { body } = await design({ name: 'Hinted', description: 'Reads an alert for IOCs.', ask: 'Create an agent that reads an alert for IOCs.', toolNodes: [{ nodeType: 'triage.extractIocs' }], knowledgeBase: 'no-such-base', agentModel: 'anthropic/claude-haiku-4-5' });
    const tools = body.config.tools as Array<{ nodeType?: string; type: string }>;
    expect(tools.some((t) => t.nodeType === 'triage.extractIocs')).toBe(true);
    expect(tools.some((t) => t.type === 'knowledge')).toBe(false);
    expect((body.notAdded as Array<{ name: string; reason: string }>).some((n) => n.name === 'no-such-base' && /no knowledge base/.test(n.reason))).toBe(true);
    expect(body.modelWhy).toBe('unavailable');
    expect(body.modelNote).toContain('anthropic/claude-haiku-4-5 isn’t available on this host');
  });

  it('a model the person named and the host lists (Haiku) is `asked` through the design route, and the agent runs on it', async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'dev-only-not-a-key';
    try {
      script = [propose({ nodeTools: 'triage.extractIocs' }), { text: 'Designed.' }, { text: 'No cases.' }];
      const { body } = await design({ name: 'Alert advisor', description: 'Reads an alert.', ask: B_ASK });
      expect(body.modelWhy).toBe('asked');
      expect(body.config.model).toMatchObject({ provider: 'anthropic' });
      expect(String(body.config.model.model)).toMatch(/haiku/i);
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it('a model the host lists and the person named is `asked`, and never an upgrade', () => {
    const models = [{ provider: 'anthropic' as const, model: 'claude-sonnet-5-5' }, { provider: 'anthropic' as const, model: 'claude-haiku-4-5' }];
    expect(modelWhyOf('Keep it cheap: Haiku is fine.', models, models[1])).toEqual({ modelWhy: 'asked' });
    expect(modelWhyOf('Keep it cheap: Haiku is fine.', [models[0]], models[0])).toMatchObject({ modelWhy: 'unavailable', modelNote: 'Haiku isn’t available on this host: it runs on claude-sonnet-5-5' });
    expect(modelWhyOf('triage my alerts', models, models[0])).toEqual({ modelWhy: 'default' });
  });

  it('draftFrom: `reuse` is checked against the agents the caller can read; the brief lists them with ids', () => {
    const s1 = agentStore.list().find((a) => a.name === 'Alert triager')!;
    const types = registry.nodeTypes();
    const ok = draftFrom({ name: 'X', role: 'Y', instructions: 'z', tools: [], reuse: { agentId: s1.id, why: 'it does it', gaps: ['a runbook search'] } }, { types, actor: TEST_OWNER, known: '', request: 'triage an alert' });
    expect(ok.design?.reuse).toMatchObject({ agentId: s1.id, name: 'Alert triager', published: true, gaps: ['a runbook search'] });
    const bad = draftFrom({ name: 'X', role: 'Y', instructions: 'z', tools: [], reuse: { agentId: 'ag_nope', why: 'x' } }, { types, actor: TEST_OWNER, known: '', request: 'triage an alert' });
    expect(bad.design?.reuse).toBeUndefined();
    expect(bad.dropped.join(' ')).toContain('to reuse');
    expect(catalogAgents(TEST_OWNER).some((a) => a.id === s1.id && a.published === 1)).toBe(true);
    expect(designBrief({ name: 'X', description: 'triage an alert', instructions: '' }, { types, actor: TEST_OWNER })).toContain(`[${s1.id}] Alert triager`);
    expect(fromDesign({ reuseAgentId: 'ag_1', reuseWhy: 'w', reuseGaps: 'a\nb', knowledgeBase: 'runbooks' })).toMatchObject({ reuse: { agentId: 'ag_1', why: 'w', gaps: ['a', 'b'] }, knowledgeBase: 'runbooks' });
  });

  it('credentials: a tool that needs SMTP offers the tenant’s credential by name and never picks it (D2)', async () => {
    const { credentials } = await import('@/lib/server/credentials/vault');
    const made = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: 58194, user: 'x', password: 'dev-only', secure: false } } as never);
    try {
      const types = registry.nodeTypes();
      const result = draftFrom({ name: 'Mailer', role: 'Helper', instructions: 'z', tools: [{ type: 'node', nodeType: 'messaging.emailSend', name: 'send_email', description: 'Send it' }] }, { types, actor: TEST_OWNER, known: '', request: 'Create an agent that emails a summary to oncall@landflow.test with the Send Email tool' });
      const need = result.needs.find((n) => n.kind === 'credential');
      expect(need?.text).toMatch(/Mailpit SMTP/);
      const tool = (result.config.tools ?? []).find((t) => t.type === 'node') as { credentials?: unknown } | undefined;
      expect(tool?.credentials ?? {}).toEqual({});
    } finally {
      credentials.delete((made as { id: string }).id);
    }
  });

  it('the builder: a draft bound to Alert triager says which agent and why; a step with no agent says it needs a new one', () => {
    const s1 = agentStore.list().find((a) => a.name === 'Alert triager')!;
    const brief = { id: s1.id, name: s1.name, description: 'Triages an alert and emails on-call. It also judges severity.', version: 1, skills: [], tools: [] };
    const reading = agentReading([{ type: 'core.messageAgent', name: 'Alert triager', parameters: { agentId: s1.id } }, { type: 'core.messageAgent', name: 'Release translator', parameters: { agentId: '' } }], [brief]);
    expect(reading.reuses).toEqual([reuseSentence('Alert triager', 'Triages an alert and emails on-call.')]);
    expect(reading.left).toEqual([{ node: 'Release translator', field: 'agentId', kind: 'empty', text: '“Release translator”: needs a new agent: Release translator (pick one, or ask Spotlight to create it)' }]);
  });

  it('POST /api/ai/build with a reply bound to Alert triager: the summary’s first assumption is Reuses “Alert triager”: …', async () => {
    const s1 = agentStore.list().find((a) => a.name === 'Alert triager')!;
    const fake = await startFakeModels({
      reply: () => ({ text: JSON.stringify({ name: 'Triage', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start' }, { key: 'a', type: 'core.messageAgent', name: 'Alert triager', parameters: { agentId: s1.id, message: 'Triage {{ $json.alert }}' } }], connections: [{ from: 'start', to: 'a' }], testData: [{ alert: 'x' }] }), toolCalls: [] }),
    });
    const prev = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = fake.origin;
    try {
      const route = await import('@/app/api/ai/build/route');
      const response = await route.POST(new Request('http://localhost/api/ai/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'triage each alert with my triage agent', staged: false }) }));
      const body = (await response.json()) as { draft?: { summary?: { assumptions: string[] } }; error?: string };
      expect(response.status, body.error).toBe(200);
      expect(body.draft!.summary!.assumptions[0]).toMatch(/^Reuses “Alert triager”: /);
    } finally {
      await fake.close();
      if (prev === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = prev;
    }
  });

  it('the builder prompt no longer promises that Spotlight designs a new agent after Apply', () => {
    const reading = agentReading([{ type: 'core.messageAgent', name: 'Translator', parameters: { agentId: '' } }], []);
    expect(reading.left[0]!.text).toContain('pick one, or ask Spotlight to create it');
  });
});

