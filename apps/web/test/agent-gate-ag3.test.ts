/**
 * AG15 (wave ag3): an agent that asks before it writes can pass its eval gate honestly, and its tests show as agent tests in
 * AI spend (docs/agents.md "Eval gate", docs/features/ai.md). Spotlight's design rewrites a case that claims a tool that asks
 * first did its work into the ask; casesFor's prompt names those tools; the smoke test and the gate open an `agent-test`
 * usage scope; a workflow's Run an Agent call writes none. Models are scripted; nothing leaves this machine.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, ModelTurn } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-gate-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

// The agent's scripted model (its calls are metered like a provider adapter's) and the judge's; both record what they were sent.
const script = vi.hoisted(() => ({ calls: [] as string[], reply: 'Here is the summary; I will send it to oncall@landflow.test once you approve.', judged: [] as string[], turns: 0, tool: false }));
vi.mock('@/lib/server/agents/models', async () => {
  const { traceChat } = await import('@/lib/server/telemetry/ai');
  return {
    OLLAMA_URL: 'http://127.0.0.1:11434',
    modelOptions: async () => [],
    agentModel: (config: { model?: string } | undefined): LanguageModel => ({
      provider: 'anthropic',
      model: config?.model ?? 'x',
      async generate(input): Promise<ModelTurn> {
        const turn = (): ModelTurn => {
          if ((input.system ?? '').includes('"score"')) {
            const first = input.messages[0];
            script.judged.push(typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content));
            return { text: JSON.stringify({ score: 5, reasoning: 'scripted' }), toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } };
          }
          script.turns += 1;
          if (script.tool && script.turns % 2 === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'Send_Email', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
          return { text: script.reply, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
        };
        return traceChat({ system: 'anthropic', model: 'claude-test' }, async () => turn(), (t) => ({ responseModel: 'claude-test', inputTokens: t.usage?.inputTokens ?? 0, outputTokens: t.usage?.outputTokens ?? 0, finishReasons: [] }));
      },
    }),
  };
});

const { defineNode, definePlugin } = await import('@landflow/sdk');
const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { database } = await import('@/lib/server/db');
const { agentStore } = await import('@/lib/server/agents/store');
const { addCase, runEval, checkPublish, listCases } = await import('@/lib/server/agents/eval-gate');
const { smokeTest } = await import('@/lib/server/agents/smoke-test');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { designAgent, asksFirstCases } = await import('@/lib/server/assistant/architect');
const { agentAsk, askCatalog, fallbackName } = await import('@/lib/shared/agent-ask');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { prepare, addScenarioPlugins } = await import('./spotlight-scenarios/harness');

const sent = vi.hoisted(() => ({ n: 0 }));
const base = { kind: 'action' as const, version: 1, inputs: [{ type: 'main' as const }], outputs: [{ type: 'main' as const }] };
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'standin', name: 'Stand-ins', version: '0.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: { ...base, name: 'send', displayName: 'Send Email', description: 'Send an email', properties: [] },
        async execute() {
          sent.n += 1;
          return [[{ json: { sent: true } }]];
        },
      }),
    ],
  }),
);

const TRIAGE_ASK = 'Create an agent that triages an alert: normalize it, extract the IOCs and email a short summary to oncall@landflow.test. Never email anyone else. Use the Normalize Alert, Extract IOCs and Send Email tools.';
const usageRows = (agentId: string) => database().all<Record<string, any>>('SELECT * FROM ai_usage WHERE agent_id = ? ORDER BY at, id', agentId); // eslint-disable-line @typescript-eslint/no-explicit-any
const node = (name: string, nodeType: string, extra: Record<string, unknown> = {}) => ({ id: `t_${name}`, type: 'node' as const, name, description: name, nodeType, parameters: {}, ...extra });
const makeAgent = (tools: unknown[] = []) => agentStore.create({ name: 'Triager', instructions: 'Triage.', model: { provider: 'ollama', model: 'scripted-1' }, tools } as never);

let types: NodeTypeInfo[];
beforeAll(async () => {
  prepare();
  await addScenarioPlugins({ start: { plugins: ['triage', 'messaging'] } }, 'unit');
  types = registry.nodeTypes();
});
beforeEach(() => {
  Object.assign(script, { calls: [], reply: 'Here is the summary; I will send it to oncall@landflow.test once you approve.', judged: [], turns: 0, tool: false });
  sent.n = 0;
  process.env.OLLAMA_URL = 'http://127.0.0.1:9';
});

const CASES = [
  'Emails a short summary to oncall@landflow.test',
  'Names the source address 203.0.113.45 and lists the IOCs it found',
  'Email sent to oncall@landflow.test with the alert summary',
].map((expected, i) => `[Wazuh] alert ${i + 1}: sshd login probe from 203.0.113.45 => ${expected}`);
const propose = (nodeTools: string, cases = CASES): Partial<ModelTurn> => ({ toolCalls: [{ id: 'd1', name: 'propose_design', input: { summary: 'Draft', name: 'Alert triager', role: 'Triager', instructions: 'Work.', nodeTools, cases: cases.join('\n') } }] });
function scripted(turns: Array<Partial<ModelTurn>>) {
  const systems: string[] = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(request) {
      systems.push(request.system ?? '');
      if (typeof request.system === 'string' && request.system.startsWith('You write test cases')) return { text: 'Hello there => A greeting\nWhat can you do? => What it does\nSomething odd => Says it cannot help', toolCalls: [], stopReason: 'stop' };
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return { model, systems };
}
const spec = () => {
  const catalog = askCatalog(types);
  const read = agentAsk(TRIAGE_ASK, [], catalog)!;
  return { name: read.name ?? fallbackName(read.description, read.tools, catalog), description: read.description, instructions: '', ask: TRIAGE_ASK, tools: read.tools };
};

describe('Spotlight design: cases about a tool that asks first expect the ask', () => {
  it('rewrites the claims, keeps the address, leaves the IOC case and every input alone', async () => {
    const { model } = scripted([propose('triage.normalizeAlert, triage.extractIocs, messaging.emailSend'), { text: 'Designed.' }]);
    const result = await designAgent(spec(), { types, actor: TEST_OWNER, model });
    expect(result.cases).toHaveLength(3);
    expect(result.cases.map((c) => c.input)).toEqual(CASES.map((c) => c.split(' => ')[0]));
    const [first, second, third] = result.cases;
    expect(first!.expected).toMatch(/approval before sending/);
    expect(first!.expected).toContain('oncall@landflow.test');
    expect(first!.expected).toBe('Drafts a short summary for oncall@landflow.test and asks for approval before sending it');
    expect(second!.expected).toBe('Names the source address 203.0.113.45 and lists the IOCs it found');
    expect(third!.expected).toMatch(/asks for approval first/);
    expect(third!.expected).toContain('oncall@landflow.test');
    expect(third!.expected).not.toMatch(/^Email sent/);
  });

  it('keeps the cases as proposed for an agent with no tool that asks first', async () => {
    const { model } = scripted([propose('triage.normalizeAlert, triage.extractIocs'), { text: 'Designed.' }]);
    const result = await designAgent(spec(), { types, actor: TEST_OWNER, model });
    expect(result.cases.map((c) => c.expected)).toEqual(CASES.map((c) => c.split(' => ')[1]));
  });

  it('is a pure rewrite: no expected text, no claim, no tool object match leaves a case as it is', () => {
    const config = { tools: [node('Send Email', 'messaging.emailSend', { requireApproval: true })] } as never;
    const same = [{ input: 'a' }, { input: 'b', expected: 'Posts to Slack' }, { input: 'c', expected: 'Lists the IOCs' }];
    expect(asksFirstCases(same, config)).toEqual(same);
  });

  it("casesFor's prompt names the tools that ask first", async () => {
    const { model, systems } = scripted([propose('triage.normalizeAlert, messaging.emailSend', []), { text: 'Designed.' }]);
    await designAgent(spec(), { types, actor: TEST_OWNER, model });
    const prompt = systems.find((s) => s.startsWith('You write test cases'))!;
    expect(prompt).toMatch(/ask the person first/);
    expect(prompt).toMatch(/Send Email|send_email/i);
    const { model: other, systems: otherSystems } = scripted([propose('triage.normalizeAlert', []), { text: 'Designed.' }]);
    await designAgent(spec(), { types, actor: TEST_OWNER, model: other });
    expect(otherSystems.find((s) => s.startsWith('You write test cases'))!).not.toMatch(/ask the person first/);
  });
});

describe('an agent test is agent-test spend', () => {
  it('writes agent-test rows for the smoke test, with the agent id', async () => {
    const agent = makeAgent();
    const smoke = await smokeTest(agent.id, 'Triage this alert');
    expect(smoke.state).toBe('passed');
    const rows = usageRows(agent.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.surface === 'agent-test' && r.agent_id === agent.id)).toBe(true);
  });

  it('writes agent-test rows for the gate: the agent’s calls and the judge’s', async () => {
    const agent = makeAgent();
    addCase(agent.id, { input: 'Triage the alert', expected: 'Drafts the summary for oncall@landflow.test and asks for approval before sending it' });
    await runEval(agent.id, 'draft');
    const rows = usageRows(agent.id);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.surface === 'agent-test')).toBe(true);
    expect(rows.some((r) => r.purpose === 'judge')).toBe(true);
  });

  it('a workflow’s Run an Agent call still writes no surface', async () => {
    const agent = makeAgent();
    const session = newSession(agent, { source: 'test', userId: 'u', version: 'draft' });
    await runAgent({ agent, session, message: 'hi', rootTrace: true });
    const rows = usageRows(agent.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.surface === null)).toBe(true);
    agentStore.deleteSession(agent.id, session.id);
  });
});

describe('the gate on an agent that asks before it sends', () => {
  it('hands the judge the rewritten expected text, denies the send and keeps the threshold', async () => {
    const { model } = scripted([propose('triage.normalizeAlert, messaging.emailSend'), { text: 'Designed.' }]);
    const designed = await designAgent(spec(), { types, actor: TEST_OWNER, model });
    const agent = makeAgent([node('Send Email', 'standin.send', { requireApproval: true })]);
    for (const c of designed.cases) addCase(agent.id, c);
    script.tool = true;
    const gate = await checkPublish(agent.id);
    expect(sent.n).toBe(0); // approvals stay denied
    expect(gate.run!.results).toHaveLength(3);
    expect(gate.run!.results.every((r) => r.reply.includes('once you approve'))).toBe(true);
    const asked = script.judged.find((j) => j.includes('Drafts a short summary'));
    expect(asked).toContain('Drafts a short summary for oncall@landflow.test and asks for approval before sending it');
    expect(script.judged.some((j) => j.includes('Emails a short summary'))).toBe(false);
    expect(gate.verdict).toMatchObject({ ok: true, average: 5 });
    expect(listCases(agent.id)).toHaveLength(3);
  });
});
