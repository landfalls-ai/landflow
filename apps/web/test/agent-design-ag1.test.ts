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
const { agentAsk, askCatalog, fallbackName, toolsOf, MAIL_TO } = await import('@/lib/shared/agent-ask');
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
const catalog = () => askCatalog(types);

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

describe('the asks as typed (shots 10a, 30d)', () => {
  const TYPED_TRIAGE = 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.';
  const TYPED_UTILITY = 'Create an agent that decodes JWTs, hashes strings, makes UUIDs and slugifies titles.';

  it('names JWT Decode from "decodes JWTs"', () => {
    expect(agentAsk(TYPED_UTILITY, [], catalog())!.tools).toEqual(expect.arrayContaining(['JWT Decode']));
  });

  it('names Slugify from "slugifies" in the ask', () => {
    const read = agentAsk(TYPED_UTILITY, [], catalog())!;
    expect(read.tools).toEqual(expect.arrayContaining(['Hash', 'UUID', 'Slugify']));
  });

  it('puts Slugify on the agent or in notAdded when the architect proposes it', async () => {
    const { model } = scripted([design({ name: 'Utility helper', nodeTools: 'go-crypto.jwtDecode, text-toolkit.slugify' }), { text: 'Designed.' }]);
    const result = await designAgent(spec(TYPED_UTILITY), { types, actor: TEST_OWNER, model });
    const on = (config: { tools?: unknown[] }) => JSON.stringify(config.tools ?? []);
    expect(on(result.config) + JSON.stringify(result.notAdded ?? [])).toMatch(/slugify/i);
  });

  it('keeps the address and names the triage agent as a triager', () => {
    const read = agentAsk(TYPED_TRIAGE, [], catalog())!;
    expect(read.description).toContain('oncall@landflow.test');
    expect(read.name).toBe('Alert triager');
  });
});

describe('every typed ask (10a, 60b, 30d, 50c): a sensible name, and each asked tool on the agent or in notAdded', () => {
  const TYPED = {
    triage: 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.',
    sales: 'Create an agent that answers questions about our sales table in SQLite, with stats and the sentiment of customer comments. Its tools are the SQLite node from the Databases plugin and the Field Statistics and Sentiment nodes from Insights.',
    utility: 'Create an agent that decodes JWTs, hashes strings, makes UUIDs and slugifies titles.',
    grafana: 'Create an agent that tells me which Grafana alerts are firing and what the dashboards show. Its tools are the Grafana plugin’s Get Alerts and Get Alert Details nodes, plus HTTP Request to read the dashboards.',
  };

  it('names each with a noun: no article, pronoun or comma', () => {
    for (const ask of Object.values(TYPED)) {
      const name = spec(ask).name;
      expect(name, ask).toBeTruthy();
      expect(name.length).toBeLessThanOrEqual(40);
      expect(name).not.toMatch(/,|^(?:an?|the|me|my|our|its|your|i)\b/i);
    }
    expect(spec(TYPED.triage).name).toBe('Alert triager');
    expect(spec(TYPED.utility).name).toBe('Utility helper');
    expect(spec(TYPED.grafana).name).toBe('Grafana alerts agent'); // HTTP Request is core: it names no plugin
  });

  it('reads HTTP Request (a core node of two words) as an asked tool, and Get Alerts, Get Alert Details', () => {
    const tools = agentAsk(TYPED.grafana, [], catalog())!.tools;
    expect(tools).toEqual(expect.arrayContaining(['Get Alerts', 'Get Alert Details', 'HTTP Request']));
    expect(agentAsk('Create an agent that merges code reviews', [], catalog())!.tools).not.toContain('Merge');
  });

  it('puts HTTP Request on the Grafana agent or says why not, even when the architect leaves it out', async () => {
    const { model } = scripted([design({ name: 'Grafana alerts agent', nodeTools: 'grafana.getAlerts' }), { text: 'Designed.' }]);
    const result = await designAgent(spec(TYPED.grafana), { types, actor: TEST_OWNER, model });
    const have = JSON.stringify(result.config.tools ?? []) + JSON.stringify(result.notAdded ?? []);
    for (const wanted of [/getAlerts/, /getAlertDetails|alert.?details/i, /httpRequest|HTTP Request/i]) expect(have).toMatch(wanted);
  });

  it('an acronym two nodes share asks which one, never drops silently (IOC Enrich next to Extract IOCs)', () => {
    const withEnrich = [...catalog(), { displayName: 'IOC Enrich', pluginName: 'Threat Intel' }];
    const said = toolsOf('Create an agent that triages an alert: pull out the IOCs and judge it.', withEnrich);
    expect(said.join(' ')).toMatch(/IOCs: several nodes match \(.*Extract IOCs.*IOC Enrich.*\), pick one/);
    expect(toolsOf('Create an agent that uses the Extract IOCs tool.', withEnrich)).toContain('Extract IOCs');
  });

  it('reads "email a short summary to <address>" as Send Email and "normalise" as Normalize Alert', () => {
    const tools = agentAsk(TYPED.triage, [], catalog())!.tools;
    expect(tools).toEqual(expect.arrayContaining(['Normalize Alert', 'Send Email']));
    expect(agentAsk('Create an agent that mails the report to ops@landflow.test', [], catalog())!.tools).toContain('Send Email');
    expect(agentAsk('Create an agent that emails nobody and answers questions', [], catalog())!.tools).not.toContain('Send Email'); // no address, no mail tool
  });

  it('puts Send Email on the triage agent (asks first), the address untouched, when the architect leaves it out', async () => {
    const { model } = scripted([design({ name: 'Alert triager', nodeTools: 'triage.normalizeAlert, triage.extractIocs' }), { text: 'Designed.' }]);
    const result = await designAgent(spec(TYPED.triage), { types, actor: TEST_OWNER, model });
    const mail = nodeTools(result.config).find((t) => t.nodeType === 'messaging.emailSend');
    if (mail) expect(mail).toMatchObject({ requireApproval: true });
    else expect(result.notAdded.map((n) => n.name)).toContain('Send Email');
    expect(mail, 'Send Email is on the agent').toBeTruthy();
    expect(JSON.stringify(result.config)).not.toMatch(/oncall@landflow(?!\.test)/);
  });

  it('does the same for a Jira variant: Jira is not added (no plugin), Send Email is', async () => {
    const ask = 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, open a Jira ticket, and email a short summary to oncall@landflow.test.';
    const { model } = scripted([design({ name: 'Alert triager', nodeTools: 'triage.normalizeAlert, triage.extractIocs' }), { text: 'Designed.' }]);
    const result = await designAgent(spec(ask), { types, actor: TEST_OWNER, model });
    const mail = nodeTools(result.config).find((t) => t.nodeType === 'messaging.emailSend');
    expect(mail ? mail.requireApproval : result.notAdded.map((n) => n.name)).toSatisfy((v: unknown) => v === true || (Array.isArray(v) && v.includes('Send Email')));
    expect(result.notAdded.map((n) => n.name)).toContain('Jira');
  });

  it('accounts for every tool of the sales ask', async () => {
    const { model } = scripted([design({ name: 'Sales data analyst', nodeTools: 'databases.sqlite' }), { text: 'Designed.' }]);
    const result = await designAgent(spec(TYPED.sales), { types, actor: TEST_OWNER, model });
    const have = JSON.stringify(result.config.tools ?? []) + JSON.stringify(result.notAdded ?? []);
    for (const wanted of [/sqlite/i, /stats/i, /sentiment/i]) expect(have).toMatch(wanted);
  });
});

describe('instruction tool names that end like a field', () => {
  const tools = [{ name: 'get_alerts' }, { name: 'get_alert_details' }, { name: 'send_email' }];
  it('replaces or drops a called tool whatever its suffix', () => {
    for (const bad of ['get_alert_status', 'get_user_by_id', 'get_order_status', 'update_ticket_status', 'lookup_customer_name']) {
      const { text, dropped } = nameOnlyOwnTools(`Steps:\n1. Call ${bad} for each alert.`, tools);
      expect(text, bad).not.toContain(bad);
      expect(dropped.join(' '), bad).toContain(bad);
    }
  });
  it('replaces a tool named later in the same call sentence ("call get_alerts, send_email or get_alert_summary")', () => {
    const { text, dropped } = nameOnlyOwnTools('Steps:\n2. Call get_alerts, send_email or lookup_alert for each.', tools);
    expect(text).not.toContain('lookup_alert');
    expect(dropped.join(' ')).toContain('lookup_alert');
    const own = 'Steps:\n1. Call get_alerts and read the customer_id from each.';
    expect(nameOnlyOwnTools(own, tools)).toEqual({ text: own, dropped: [] });
  });
  it('leaves a verb_noun field alone: run_id, post_id, list_id, update_time, email_address (the text unchanged, nothing dropped)', () => {
    for (const line of [
      'Read the run_id and the post_id from the input.',
      'Sort by update_time, newest first.',
      'Read each alert\'s list_id and group by it.',
      'Reply to the email_address in the message.',
      'Check the send_time and get_count of the batch.',
    ]) {
      const text = `Steps:\n1. ${line}`;
      expect(nameOnlyOwnTools(text, tools), line).toEqual({ text, dropped: [] });
    }
  });
  it('still reads a three-word or called token as a tool, whatever its suffix', () => {
    for (const line of ['Use update_ticket_status when it is closed.', 'Then call lookup_customer_name.', 'Run get_alert_status first.']) {
      const { dropped } = nameOnlyOwnTools(`Steps:\n1. ${line}`, tools);
      expect(dropped.length, line).toBeGreaterThan(0);
    }
  });
  it('reads a token named as a tool as a tool, even after a determiner or with a field ending', () => {
    for (const line of ['Call the get_alerts tool for the last hour.', '2. Call the post_message tool with the summary.', 'Use the query_logs tool to search.', 'Send it via the slack_post tool.']) {
      const { dropped, text } = nameOnlyOwnTools(`Steps:\n1. ${line}`, [{ name: 'send_email' }]);
      expect(dropped.length, line).toBeGreaterThan(0);
      expect(text, line).not.toMatch(/get_alerts|post_message|query_logs|slack_post/);
    }
  });
  it('a two-word token whose second word is a preposition is a field ("send_to")', () => {
    const line = 'Steps:\n1. Read send_to and move_from, then group_by the type.';
    expect(nameOnlyOwnTools(line, tools)).toEqual({ text: line, dropped: [] });
  });
  it('leaves a field after "use the" or "run the" alone: source_ip, error_message, log_level, the post_id check', () => {
    for (const line of [
      'Use the source_ip and dest_ip from the alert to judge reach.',
      'Use the error_message to explain what failed.',
      'Use the time_range and the log_level from the question.',
      'Use a short_summary and the severity_level in the reply.',
      'Read the alert, then run the post_id check.',
    ]) {
      const text = `Steps:\n1. ${line}`;
      expect(nameOnlyOwnTools(text, tools), line).toEqual({ text, dropped: [] });
    }
    const { dropped } = nameOnlyOwnTools('Steps:\n1. Use the fetch_logs for the host.', tools);
    expect(dropped.join(' ')).toContain('fetch_logs');
  });
  it('leaves a bare field word alone', () => {
    const line = 'Steps:\n1. Read the customer_id and `user_id` and ticket_number from the input.';
    expect(nameOnlyOwnTools(line, tools)).toEqual({ text: line, dropped: [] });
  });
});

describe('a write tool with no operation (Acknowledge Alert)', () => {
  const GRAFANA_READ = 'Create an agent that lists the firing alerts in Grafana and explains what each one means.';
  const ack = { name: 'Helper', role: 'Helper', instructions: 'Work.', tools: [{ type: 'node', nodeType: 'grafana.acknowledgeAlert', description: 'Acknowledge' }] };
  const run = (request: string) => draftFrom(ack as never, { types, actor: TEST_OWNER, known: '', request });
  it('is dropped, and said, when the ask only reads', () => {
    const draft = run(GRAFANA_READ);
    expect(JSON.stringify(draft.config.tools ?? [])).not.toMatch(/acknowledge/i);
    expect(draft.dropped.join(' ')).toMatch(/Acknowledge Alert/);
  });
  it('is kept behind approval when the ask is to acknowledge', () => {
    const draft = run('Create an agent that lists the firing alerts in Grafana and acknowledges each one in Grafana.');
    const tool = (draft.config.tools ?? []).find((t) => t.type === 'node' && t.nodeType === 'grafana.acknowledgeAlert');
    expect(tool).toMatchObject({ requireApproval: true });
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
    expect(dropped.join(' ')).toContain('now sentiment'); // a replacement is said too
  });

  it('leaves field names alone: customer_id, user_id, ticket_number are not tools', () => {
    const tools = [{ name: 'get_user', description: 'Get a user by id from the CRM.' }, { name: 'send_email' }];
    for (const line of ['Look up the customer with customer_id, then summarise.', 'Use `user_id` from the input.', 'Check the ticket via ticket_number and decide.']) {
      const { text, dropped } = nameOnlyOwnTools(`Steps:\n1. ${line}`, tools);
      expect(text).toContain(line);
      expect(dropped).toEqual([]);
    }
  });
});

describe('a revise keeps the steps that call the agent’s own tools (the live pass: "add Extract IOCs as a tool" cut the normalize and send steps)', () => {
  const STEPS = 'Input: one alert.\nSteps:\n1. Call normalize_alert with the alert.\n2. Call extract_iocs on the normalised alert.\n3. Judge severity.\n4. Call send_email to oncall@landflow.test with a subject, and a short summary.\nOutput: short.\nHand over when: unclear.';
  const node = (name: string, nodeType: string, extra: Record<string, unknown> = {}) => ({ id: `tl_${name}`, type: 'node', name, nodeType, description: name, parameters: {}, ...extra });
  it('the base’s tools stay callable in the revised instructions', async () => {
    const base = {
      name: 'Alert triager', description: 'Triages an alert.', instructions: 'Input: one alert.\nSteps:\n1. Call normalize_alert with the alert.\n2. Judge severity.\n3. Call send_email to oncall@landflow.test with a subject, and a short summary.\nOutput: short.\nHand over when: unclear.',
      tools: [node('normalize_alert', 'triage.normalizeAlert'), node('send_email', 'messaging.emailSend', { requireApproval: true })],
    };
    const { model } = scripted([design({ name: 'Alert triager', instructions: STEPS, nodeTools: 'triage.normalizeAlert, messaging.emailSend, triage.extractIocs' }), { text: 'Changed.' }]);
    const result = await designAgent({ name: 'Alert triager', description: '', instructions: '', ask: 'add Extract IOCs as a tool', change: 'add Extract IOCs as a tool', base: base as never }, { types, actor: TEST_OWNER, model });
    const text = result.config.instructions ?? '';
    expect(text).toContain('Call normalize_alert with the alert.');
    expect(text).toContain('Call send_email to oncall@landflow.test');
    expect(text).toContain('Call extract_iocs');
    expect(result.dropped.join(' ')).not.toMatch(/instructions named/);
    expect(nodeTools(result.config).map((t) => t.nodeType)).toEqual(expect.arrayContaining(['triage.normalizeAlert', 'messaging.emailSend', 'triage.extractIocs']));
  });
});

describe('a change that removes a tool leaves no step that calls it, and a kept tool is not "never asked for"', () => {
  const STEPS = 'Input: one alert.\nSteps:\n1. Call normalize_alert with the alert.\n2. Judge severity.\n3. Call send_email to oncall@landflow.test with a summary.\nOutput: short.\nHand over when: unclear.';
  const node = (name: string, nodeType: string, extra: Record<string, unknown> = {}) => ({ id: `tl_${name}`, type: 'node', name, nodeType, description: name, parameters: {}, ...extra });
  const base = { name: 'Alert triager', description: 'Triages an alert.', instructions: STEPS, tools: [node('normalize_alert', 'triage.normalizeAlert'), node('send_email', 'messaging.emailSend', { requireApproval: true })] };
  it('"remove the email tool": the step is gone and dropped says so', async () => {
    const { model } = scripted([design({ name: 'Alert triager', instructions: STEPS, nodeTools: 'triage.normalizeAlert, messaging.emailSend' }), { text: 'Changed.' }]);
    const result = await designAgent({ name: 'Alert triager', description: '', instructions: '', ask: 'remove the email tool', change: 'remove the email tool', base: base as never }, { types, actor: TEST_OWNER, model });
    expect(result.config.instructions ?? '').not.toContain('send_email');
    expect(result.config.instructions ?? '').toContain('Call normalize_alert');
    expect(result.dropped.join(' ')).toContain('instructions named send_email, which it does not have');
  });
  it('a base tool the design proposes again is not listed as "never asked for"', async () => {
    const { model } = scripted([design({ name: 'Alert triager', instructions: STEPS, nodeTools: 'triage.normalizeAlert, messaging.emailSend, triage.extractIocs' }), { text: 'Changed.' }]);
    const result = await designAgent({ name: 'Alert triager', description: '', instructions: '', ask: 'add Extract IOCs as a tool', change: 'add Extract IOCs as a tool', base: base as never }, { types, actor: TEST_OWNER, model });
    expect(result.dropped.join(' ')).not.toMatch(/Send Email[^;]*never asks/);
    expect(nodeTools(result.config).map((t) => t.nodeType)).toContain('messaging.emailSend');
  });
  it('in the architect chat, a tool the person drops takes its step with it (the old draft’s tools are not its own)', () => {
    const keep = { ...base };
    const args = { name: 'Alert triager', role: 'Triager', instructions: STEPS, tools: [{ type: 'node', nodeType: 'triage.normalizeAlert', name: 'normalize_alert' }] };
    const chat = draftFrom(args, { types, actor: TEST_OWNER, known: '', keep: keep as never });
    expect(chat.config.instructions ?? '').not.toContain('send_email');
    expect(chat.dropped.join(' ')).toContain('instructions named send_email');
    const revise = draftFrom(args, { types, actor: TEST_OWNER, known: '', keep: keep as never, revise: true });
    expect(revise.config.instructions ?? '').toContain('send_email');
  });
});

describe('one mail regex, several mail nodes, analyse/analyze', () => {
  it('forwards … to <address> is mail-to, from one shared regex', () => {
    expect(MAIL_TO.test('forwards the summary to oncall@landflow.test')).toBe(true);
    expect(MAIL_TO.test('forward the report to ops@landflow.test')).toBe(true);
    expect(MAIL_TO.test('forward the report to the team')).toBe(false);
  });
  it('takes a mail node only when exactly one matches; several are said', () => {
    const one = [{ displayName: 'Send Email', pluginName: 'Messaging' }];
    const two = [...one, { displayName: 'Send Mail (SMTP)', pluginName: 'Smtp' }];
    expect(toolsOf('email a summary to oncall@landflow.test', one)).toContain('Send Email');
    const tools = toolsOf('email a summary to oncall@landflow.test', two);
    expect(tools).toContain('Send email: several nodes match (Send Email, Send Mail (SMTP)), pick one');
    expect(tools).not.toContain('Send Email');
  });
  it('the several-nodes line reaches Not added', async () => {
    const { model } = scripted([design({ name: 'Alert triager', nodeTools: 'triage.normalizeAlert' }), { text: 'Designed.' }]);
    const result = await designAgent({ name: 'Alert triager', description: '', instructions: '', ask: 'x', tools: ['Send email: several nodes match (Send Email, Send Mail), pick one'] }, { types, actor: TEST_OWNER, model });
    expect(result.notAdded).toContainEqual({ name: 'Send email', reason: 'several nodes match (Send Email, Send Mail), pick one' });
  });
  it('analyse and analyze are one word', () => {
    const catalogOf = [{ displayName: 'Analyze Logs', pluginName: 'Logs' }];
    expect(toolsOf('an agent that can analyse logs', catalogOf)).toContain('Analyze Logs');
    expect(toolsOf('an agent that can analyze logs', catalogOf)).toContain('Analyze Logs');
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
