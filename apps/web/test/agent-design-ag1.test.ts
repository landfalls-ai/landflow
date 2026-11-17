/**
 * AG02 (wave ag1): the agent Spotlight designs is what the person asked for: the host's model, the whole ask read, the address
 * kept, the asked tools added or said why not, a sensible name, instructions that name only its tools, reads without approval
 * and no secret masking for a job that reads tokens. The model is scripted; nothing leaves this machine.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentMessage, LanguageModel, ModelTurn } from '@landflow/engine';
import type { AgentConfig, NodeToolConfig } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';

// The agent's own model for the run below: it records what it was sent. Anthropic's list is the real one; Ollama has none.
const seen = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock('@/lib/server/agents/models', async (original) => ({
  ...(await original<typeof import('@/lib/server/agents/models')>()),
  modelOptions: async (provider: string, options: never) => (provider === 'ollama' ? [] : (await original<typeof import('@/lib/server/agents/models')>()).modelOptions(provider as never, options)),
  agentModel: (config: { model?: string } | undefined): LanguageModel => ({
    provider: 'scripted',
    model: config?.model ?? 'x',
    async generate(input) {
      const user = input.messages.findLast((m: AgentMessage) => m.role === 'user');
      seen.messages.push(typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content));
      return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  }),
}));

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { agentResources, agentModelOf } = await import('@/lib/server/assistant/agent-resources');
const { designAgent, draftFrom, nameOnlyOwnTools, asksToWriteTo } = await import('@/lib/server/assistant/architect');
const { agentAsk, fallbackName } = await import('@/lib/shared/agent-ask');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { prepare, addScenarioPlugins, checkRunnerModel } = await import('./spotlight-scenarios/harness');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');

const TRIAGE_ASK = 'Create an agent that triages an alert: normalize it, extract the IOCs and email a short summary to oncall@landflow.test. Never email anyone else. Use the Normalize Alert, Extract IOCs and Send Email tools.';
const ANALYST_ASK = 'Create an agent that analyses sales data in a SQLite database and the sentiment of customer comments. Use the SQLite, Field Statistics and Sentiment tools.';
const GRAFANA_ASK = 'Create an agent that lists the firing alerts in Grafana and explains what each one means. Use the Get Alerts and Get Alert Details tools.';
const UTILITY_ASK = 'Create an agent that decodes JWTs, hashes text, makes UUIDs and slugifies titles. Use the JWT Decode, Hash, UUID and Slugify tools.';

let types: NodeTypeInfo[];
beforeAll(async () => {
  prepare();
  registry.registerBuiltin(corePlugin);
  await addScenarioPlugins({ start: { plugins: ['triage', 'messaging', 'databases', 'py-insights', 'go-crypto', 'text-toolkit', 'grafana'] } }, 'unit');
  types = registry.nodeTypes();
});
const catalog = () => types.filter((t) => t.pluginId !== 'core').map((t) => ({ displayName: t.descriptor.displayName, pluginName: t.pluginName }));

const ENV = ['LANDFLOW_BUILDER_MODEL', 'ANTHROPIC_API_KEY', 'OLLAMA_URL'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // nothing listens: Ollama has no models
  seen.messages.length = 0;
});

function scripted(turns: Array<Partial<ModelTurn>>) {
  const calls: Array<{ system?: string; user: string }> = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(request) {
      if (typeof request.system === 'string' && request.system.startsWith('You write test cases')) return { text: 'Hello => A greeting\nWhat can you do? => What it does\nSomething odd => Says it cannot help', toolCalls: [], stopReason: 'stop' as const };
      const first = request.messages[0];
      calls.push({ system: request.system, user: typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content) });
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return { model, calls };
}
const design = (input: Record<string, unknown>) => ({ toolCalls: [{ id: 'd1', name: 'propose_design', input: { summary: 'Draft', role: 'Helper', instructions: 'Work.', ...input } }] });
const spec = (ask: string, extra: Record<string, unknown> = {}) => {
  const read = agentAsk(ask, [], catalog())!;
  return { name: read.name ?? fallbackName(read.description, read.tools, catalog()), description: read.description, instructions: '', ask, ...(read.tools.length && { tools: read.tools }), ...extra };
};
const nodeTools = (config: Partial<AgentConfig>) => (config.tools ?? []) as NodeToolConfig[];

describe('the model: the host’s, never the architect’s upgrade (finding 2)', () => {
  it('lists the builder model first, then the provider’s others', async () => {
    process.env.LANDFLOW_BUILDER_MODEL = 'anthropic/claude-sonnet-5-5';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-for-the-test';
    const { models } = await agentResources(TEST_OWNER);
    expect(models[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(models.filter((m) => m.model === 'claude-sonnet-5-5')).toHaveLength(1);
    expect(models.map((m) => m.model)).toContain('claude-opus-5-5');
    expect(agentModelOf('anthropic/claude-sonnet-5-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(agentModelOf('qwen3-coder:30b')).toEqual({ provider: 'ollama', model: 'qwen3-coder:30b' });
    expect(agentModelOf('litellm/x')).toBeUndefined();
  });

  it('runs the agent on the builder model though the architect writes Opus, and on the model the ask names', async () => {
    process.env.LANDFLOW_BUILDER_MODEL = 'anthropic/claude-sonnet-5-5';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-for-the-test';
    const resources = await agentResources(TEST_OWNER);
    const picked = scripted([design({ name: 'Helper', model: 'anthropic/claude-opus-5-5' }), { text: 'Designed.' }]);
    const withPick = await designAgent({ name: 'Helper', description: 'x', instructions: '', ask: 'Create an agent that answers questions' }, { types, actor: TEST_OWNER, resources, model: picked.model });
    expect(withPick.config.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    const named = scripted([design({ name: 'Helper' }), { text: 'Designed.' }]);
    const haiku = await designAgent({ name: 'Helper', description: 'x', instructions: '', ask: 'Create an agent that answers questions. Use claude-haiku-5-5.' }, { types, actor: TEST_OWNER, resources, model: named.model });
    expect(haiku.config.model).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
  });

  it('follows the model Spotlight’s picker names (a local one)', () => {
    const { config } = draftFrom({ name: 'Helper', role: 'Helper', instructions: 'Work.', model: 'anthropic/claude-opus-5-5', tools: [] }, { types, actor: TEST_OWNER, known: '', request: 'Create an agent that answers questions', model: 'qwen3-coder:30b', resources: { models: [{ provider: 'ollama', model: 'qwen3-coder:30b', note: 'local' }, { provider: 'anthropic', model: 'claude-opus-5-5', note: 'x' }], knowledge: [] } });
    expect(config.model).toEqual({ provider: 'ollama', model: 'qwen3-coder:30b' });
  });
});

describe('the ask: read whole, the address kept (finding 4)', () => {
  it('keeps oncall@landflow.test and the later sentences in the description', () => {
    const read = agentAsk(TRIAGE_ASK, [], catalog())!;
    expect(read.description).toContain('oncall@landflow.test');
    expect(read.description).not.toMatch(/oncall@landflow(?!\.test)/);
    expect(read.description).toContain('Never email anyone else');
    expect([...read.tools].sort()).toEqual(['Extract IOCs', 'Normalize Alert', 'Send Email']);
  });

  it('reaches the architect: its prompt holds the second sentence of the ask', async () => {
    const { model, calls } = scripted([design({ name: 'Alert triager' }), { text: 'Designed.' }]);
    await designAgent(spec('Create an agent that triages an alert. Never email anyone but oncall@landflow.test.'), { types, actor: TEST_OWNER, model });
    expect(calls[0].user).toContain('Never email anyone but oncall@landflow.test.');
  });

  it('names the four agents with a noun: no article, pronoun or comma', () => {
    const names = [TRIAGE_ASK, ANALYST_ASK, GRAFANA_ASK, UTILITY_ASK].map((ask) => spec(ask).name);
    expect(names).toEqual(['Alert triager', 'Sales data analyst', 'Grafana alerts agent', 'Utility helper']);
    expect(agentAsk('Create an agent that triages an alert')?.name).toBe('Alert triager'); // not "An triager"
    expect(fallbackName('Me grafana agent that watches alerts')).not.toMatch(/^Me\b|,/);
  });
});

describe('the tools: added from the ask, or said why not (finding 9)', () => {
  it('adds Field Statistics and Sentiment when the architect proposes only SQLite', async () => {
    const { model } = scripted([design({ name: 'Sales data analyst', nodeTools: 'databases.sqlite' }), { text: 'Designed.' }]);
    const result = await designAgent(spec(ANALYST_ASK), { types, actor: TEST_OWNER, model });
    expect(nodeTools(result.config).map((t) => t.nodeType)).toEqual(expect.arrayContaining(['databases.sqlite', 'py-insights.stats', 'py-insights.sentiment']));
    expect(result.notAdded).toEqual([]);
  });

  it('says why a tool no plugin online has is not added', async () => {
    const { model } = scripted([design({ name: 'Ticketer', nodeTools: 'none' }), { text: 'Designed.' }]);
    const result = await designAgent(spec('Create an agent that creates Jira issues for each failed alert'), { types, actor: TEST_OWNER, model });
    expect(result.notAdded).toEqual([{ name: 'Jira', reason: expect.stringMatching(/no plugin online/) }]);
  });

  it('leaves out a tool the ask never named (least privilege) and does not list it as not added', async () => {
    const { model } = scripted([design({ name: 'Sales data analyst', nodeTools: 'databases.sqlite, messaging.slack' }), { text: 'Designed.' }]);
    const result = await designAgent(spec(ANALYST_ASK), { types, actor: TEST_OWNER, model });
    expect(nodeTools(result.config).map((t) => t.nodeType)).not.toContain('messaging.slack');
    expect(result.dropped.join(' ')).toContain('Slack: the request never asks for it');
    expect(result.notAdded.map((n) => n.name)).not.toContain('Slack');
  });
});

describe('the instructions name only the agent’s tools (finding 3)', () => {
  it('replaces or drops a tool it does not have, and the Tools line lists the real ones', async () => {
    const { model } = scripted([design({ name: 'Alert mailer', instructions: 'Steps:\n1. Read the alert.\n2. Call send_slack_message with the summary.\n3. Call send_email to the person.', nodeTools: 'messaging.emailSend' }), { text: 'Designed.' }]);
    const result = await designAgent(spec('Create an agent that emails an alert summary to oncall@landflow.test. Use Send Email.'), { types, actor: TEST_OWNER, model });
    const text = result.config.instructions ?? '';
    expect(text).not.toContain('send_slack_message');
    expect(text).toMatch(/Tools: send_email/);
    expect(result.dropped.join(' ')).toContain('instructions named send_slack_message, which it does not have');
  });

  it('turns a near name into the tool it plainly means', () => {
    const { text, dropped } = nameOnlyOwnTools('Steps:\n1. Call comment_sentiment on the text.', [{ name: 'sentiment', description: 'Sentiment of a text' }]);
    expect(text).toContain('Call sentiment on the text.');
    expect(dropped).toEqual([]);
  });
});

describe('reads need no approval, a write asks (finding 12)', () => {
  const sqlite = (operation?: string) => ({ name: 'Analyst', role: 'Analyst', instructions: 'Work.', tools: [{ type: 'node', nodeType: 'databases.sqlite', name: 'sqlite', ...(operation && { parameters: { operation } }) }] });
  const context = (request: string) => ({ types, actor: TEST_OWNER, known: '', request });

  it('reads customer comments: select, no approval, also when the architect wrote insert', () => {
    for (const operation of [undefined, 'insert']) {
      const [tool] = nodeTools(draftFrom(sqlite(operation), context(ANALYST_ASK)).config);
      expect(tool.parameters.operation).toBe('select');
      expect(tool.requireApproval).toBeUndefined();
    }
  });

  it('inserts when asked to, with approval', () => {
    const [tool] = nodeTools(draftFrom(sqlite('insert'), context('Create an agent that inserts each new order into SQLite')).config);
    expect(tool.parameters.operation).toBe('insert');
    expect(tool.requireApproval).toBe(true);
  });

  it('keeps Send Email with approval and the triage nodes without', async () => {
    const { model } = scripted([design({ name: 'Alert triager', nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend' }), { text: 'Designed.' }]);
    const result = await designAgent(spec(TRIAGE_ASK), { types, actor: TEST_OWNER, model });
    const by = Object.fromEntries(nodeTools(result.config).map((t) => [t.nodeType, t.requireApproval === true]));
    expect(by).toEqual({ 'triage.normalizeAlert': false, 'triage.extractIocs': false, 'messaging.emailSend': true });
  });

  it('reads a write verb aimed at the app, not a noun', () => {
    const info = (type: string) => types.find((t) => t.type === type)!;
    expect(asksToWriteTo(info('databases.sqlite'), 'the sentiment of customer comments from SQLite')).toBe(false);
    expect(asksToWriteTo(info('databases.sqlite'), 'insert each new order into SQLite')).toBe(true);
    expect(asksToWriteTo(info('messaging.emailSend'), 'email a short summary to oncall@landflow.test')).toBe(true);
    expect(asksToWriteTo(info('messaging.emailSend'), 'summarise the email')).toBe(false);
  });
});

describe('guardrails: no masking where tokens are the job (finding 6)', () => {
  const triage = async () => {
    const { model } = scripted([design({ name: 'Alert triager', nodeTools: 'triage.normalizeAlert' }), { text: 'Designed.' }]);
    return designAgent(spec(TRIAGE_ASK), { types, actor: TEST_OWNER, model });
  };
  const utility = async () => {
    const { model } = scripted([design({ name: 'Utility helper', nodeTools: 'go-crypto.jwtDecode' }), { text: 'Designed.' }]);
    return designAgent(spec(UTILITY_ASK), { types, actor: TEST_OWNER, model });
  };
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZzEtdGVzdCIsIm5hbWUiOiJMYW5kZmxvdyBUZXN0IiwiaWF0IjoxNzYzMzM3NjAwfQ.c2lnbmF0dXJlLW5vdC1jaGVja2Vk';

  it('gives the utility agent no input secrets rule, and the triage agent SB17’s defaults', async () => {
    const helper = (await utility()).config;
    expect(helper.guardrails?.input).toBeUndefined();
    expect(helper.guardrails?.toolResult?.enabled).toBe(true);
    expect(helper.guardrails?.output?.checks?.secrets).toBeDefined();
    const mailer = (await triage()).config;
    expect(mailer.guardrails?.input?.checks?.secrets).toEqual({ permissiveness: 'balanced' });
    expect(mailer.guardrails?.output).toBeUndefined();
  });

  it('lets a JWT reach the model whole for the utility agent; the default rule masks it', async () => {
    for (const [make, whole] of [[utility, true], [triage, false]] as const) {
      const config = (await make()).config;
      const agent = agentStore.create({ ...config, name: `Guardrail check ${whole}`, model: { provider: 'ollama', model: 'scripted' } } as AgentConfig);
      seen.messages.length = 0;
      await runAgent({ agent, session: newSession(agent, { source: 'test', userId: 'you', version: 'draft' }), message: `Decode ${JWT}` });
      expect(seen.messages[0]?.includes(JWT)).toBe(whole);
    }
  });

  it('masking answers leaves a SHA-256, a UUID and a decoded JWT payload alone', async () => {
    const { applyGuardrail } = await import('@/lib/server/agents/guardrails');
    const output = (await utility()).config.guardrails!.output!;
    const answer = 'SHA-256: 4eda698b43dfea0337a912e555dd3ca137c750c37cd87a9630860dafddab0cff\nUUID: 3f2b8c1e-5d4a-4c7e-9b1a-2e6f8d0a7c11\nPayload: {"sub":"ag1-test","name":"Landflow Test","iat":1763337600}';
    const checked = await applyGuardrail(output, 'output', answer, { model: () => { throw new Error('no model needed'); } });
    expect(checked?.action ?? 'passed').not.toBe('blocked');
    expect(checked?.text ?? answer).toBe(answer);
  });
});

describe('the runner on a cloud model', () => {
  it('does not ask for Ollama when the model is anthropic/…, and says which key is missing', async () => {
    const never = (async () => { throw new Error('Ollama was asked'); }) as unknown as typeof fetch;
    await expect(checkRunnerModel('anthropic/claude-sonnet-5-5', { ANTHROPIC_API_KEY: 'x' } as NodeJS.ProcessEnv, never)).resolves.toBeUndefined();
    await expect(checkRunnerModel('anthropic/claude-sonnet-5-5', {} as NodeJS.ProcessEnv, never)).rejects.toThrow(/needs ANTHROPIC_API_KEY/);
    await expect(checkRunnerModel('qwen3-coder:30b', {} as NodeJS.ProcessEnv, never)).rejects.toThrow(/Ollama is not answering/);
  });
});

describe('the card (client)', () => {
  it('shows the Model select and the Not added row from the preview, and says why a token job is not masked', async () => {
    const { cardFromPreview, setCardModel } = await import('@/components/editor/spotlight/agent-ask');
    const { AgentCardView } = await import('@/components/editor/spotlight/agent-card');
    const { useAssistant } = await import('@/components/editor/assistant');
    const read = agentAsk(UTILITY_ASK, [], catalog())!;
    const config = { name: 'Utility helper', description: read.description, model: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, tools: [], guardrails: { toolResult: { enabled: true, action: 'block', checks: { jailbreak: { useModel: false } }, reply: '' } } };
    const card = cardFromPreview({ config, needs: [], missing: [], designed: true, cases: [], agent: undefined as never, notAdded: [{ name: 'Jira', reason: 'no plugin online has it' }], models: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'] }, read, true, UTILITY_ASK);
    expect(card).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', ask: UTILITY_ASK, notAdded: [{ name: 'Jira' }], models: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'] });
    expect(card.guardrails).toContain('Doesn’t mask tokens in messages: its job reads them');
    const html = renderToStaticMarkup(createElement(AgentCardView, { itemId: 'i1', card }));
    expect(html).toContain('<select');
    expect(html).toContain('anthropic/claude-opus-5-5');
    expect(html).toContain('Not added');
    expect(html).toContain('Jira: no plugin online has it');
    // The select sets the model Create sends.
    useAssistant.getState().append([{ id: 'i1', role: 'assistant', parts: [{ kind: 'agentCard', card }] }] as never);
    setCardModel('i1', 'anthropic/claude-opus-5-5');
    const part = useAssistant.getState().items.find((i) => i.id === 'i1')!.parts.find((p) => p.kind === 'agentCard') as { card: { model: string; config: { model: unknown } } };
    expect(part.card.model).toBe('anthropic/claude-opus-5-5');
    expect(part.card.config.model).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    // Created, it reads as text.
    expect(renderToStaticMarkup(createElement(AgentCardView, { itemId: 'i1', card: { ...card, state: 'created' } }))).not.toContain('<select');
  });
});
