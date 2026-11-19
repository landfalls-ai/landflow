/**
 * Wave ag2's join tests (carryover-ag2.md §2): each contract between two packages of the wave, with both real sides and
 * no fake between them. Only the edges are stubbed: the Agent architect's model (a fake Anthropic Messages API on loopback,
 * reached through the host's own `anthropic/…` builder model with a made-up key), the agent's own model and the eval gate's
 * judge (scripted), the browser's HTTP client (straight to the real route handlers), a fake SMTP server and a fake
 * Alertmanager. The triage, Grafana, Messaging and Text Toolkit plugins are their own code, in process.
 *
 * 1. Triage: ask → card → steps and settings → cases (AG07 × AG08).
 * 2. Revise: add and remove, the steps follow (AG09 × AG07 × AG08).
 * 3. The editor's chat approves the agent's write (AG10 × AG08 × SB16).
 * 4. History keeps the agent (AG11 × AG09 × AG10).
 * 5. Grafana acknowledges (AG10).
 * 6. The contract copies are byte-identical to backbone/contracts/ag2 (LANDFLOW_BACKBONE_CONTRACTS names the folder).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveToolSchema, type AgentMessage, type LanguageModel, type Workflow } from '@landflow/engine';
import { publishLine, smokeLine, type AgentCard } from '@/lib/shared/agent-card';
import type { AgentConfig } from '@/lib/shared/agents';
import type { ConversationItem } from '@/lib/shared/conversations';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { describesInput } from './spotlight-scenarios/scenario';
import { readSse, startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeSmtp } from '../../../plugins/messaging/test/fake-smtp';

vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// The edges
// ---------------------------------------------------------------------------

/** The architect's fake Anthropic: `design` is what propose_design proposes; `cases` what the case follow-up answers. */
const architect = { design: undefined as Record<string, unknown> | undefined, cases: '', calls: 0, caseCalls: 0 };
type AnthropicBody = { system?: unknown; messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ name?: string; function?: { name: string } }> };
const fake = await startFakeModels({
  reply: (_provider, raw): FakeReply => {
    const body = (raw ?? {}) as AnthropicBody;
    const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
    const messages = body.messages ?? [];
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
    const lastIsResult = JSON.stringify(messages.at(-1)?.content ?? '').includes('tool_result');
    if (/You write test cases/.test(system)) {
      architect.caseCalls += 1;
      return { text: architect.cases };
    }
    architect.calls += 1;
    if (tools.includes('propose_design') && !lastIsResult && architect.design) return { toolCalls: [{ id: 'd1', name: 'propose_design', arguments: architect.design }] };
    return { text: 'Done.' };
  },
});

// The agent's own model (smoke tests, runs, eval cases) and the eval gate's judge: scripted. `calls` are made on a user turn
// (each matched to an offered tool name by a pattern); what the tools answered is kept.
const agentSide = vi.hoisted(() => ({
  calls: [] as Array<{ match: string; input: Record<string, unknown> }>,
  reply: 'Done.',
  score: 5,
  asked: [] as string[],
  results: [] as Array<{ name: string; content: string }>,
  offered: [] as string[][],
  turns: 0,
}));
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:9',
  modelOptions: async (provider: string) =>
    provider === 'anthropic'
      ? [
          { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: '' },
          { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: '' },
        ]
      : [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        if ((input.system ?? '').includes('"score"')) return { text: JSON.stringify({ score: agentSide.score, reasoning: 'scripted judge' }), toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
        agentSide.turns += 1;
        const last = input.messages.at(-1) as AgentMessage | undefined;
        if (last?.role === 'tool') for (const r of last.results) agentSide.results.push({ name: r.name, content: r.content });
        if (last?.role === 'user') {
          agentSide.asked.push(last.content);
          const offered = input.tools.map((t) => t.name);
          agentSide.offered.push(offered);
          if (agentSide.calls.length) {
            const toolCalls = agentSide.calls.map((c, i) => ({ id: `c${agentSide.turns}_${i}`, name: offered.find((n) => new RegExp(c.match, 'i').test(n)) ?? c.match, input: c.input }));
            return { text: '', toolCalls, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
          }
        }
        return { text: agentSide.reply, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  },
}));

// The browser's client: every path goes to its real route handler; the calls are kept in order.
const wire = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; json?: unknown }>, impl: undefined as undefined | ((path: string, init: { method?: string; json?: unknown }) => Promise<unknown>) }));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn((path: string, init: { method?: string; json?: unknown } = {}) => wire.impl!(path, init)),
  streamEvents: vi.fn(),
}));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

// A local Alertmanager: one "High CPU on web-01" alert; `POST /api/v2/silences` records the body; the old `/api/v2/silence` is 404.
const alertmanager = { alerts: [] as unknown[], silences: [] as Array<Record<string, any>>, requests: [] as string[] };
const HIGH_CPU = { labels: { alertname: 'High CPU on web-01', instance: 'web-01', severity: 'critical' }, annotations: { summary: 'CPU above 90% for 5 minutes' }, status: { state: 'active' }, startsAt: '2026-11-17T09:00:00Z', fingerprint: 'ab12' };
const amServer = createServer((request, response) => {
  alertmanager.requests.push(`${request.method} ${request.url}`);
  const path = (request.url ?? '').split('?')[0];
  if (request.method === 'GET' && path === '/api/v2/alerts') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(alertmanager.alerts));
  } else if (request.method === 'POST' && path === '/api/v2/silences') {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      alertmanager.silences.push(JSON.parse(raw || '{}'));
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ silenceID: `sil-${alertmanager.silences.length}` }));
    });
  } else response.writeHead(404).end();
});
await new Promise<void>((resolve) => amServer.listen(0, '127.0.0.1', resolve));
const amUrl = `http://127.0.0.1:${(amServer.address() as AddressInfo).port}`;
const smtp = await startFakeSmtp();

const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ag2-joins-')),
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_BUILDER_MODEL: 'anthropic/claude-sonnet-5-5',
  ANTHROPIC_API_KEY: 'sk-ant-made-up-for-the-test',
  ANTHROPIC_BASE_URL: fake.url.replace(/\/v1$/, ''),
  OLLAMA_URL: 'http://127.0.0.1:9',
  LANDFLOW_OUTBOUND_ALLOW: '127.0.0.1,localhost',
};
const UNSET = ['OPENAI_API_KEY', 'LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_KEY'];
const previousEnv = { ...process.env };
for (const key of UNSET) delete process.env[key];
Object.assign(process.env, ENV);

const { ApiError } = await import('@/lib/client/api');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { listCases } = await import('@/lib/server/agents/eval-gate');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { waitingOfExecution } = await import('@/lib/server/approval-inbox/store'); // AP02 × AP01: a webhook run with Ask waits in the inbox
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const designRoute = await import('@/app/api/agents/design/route');
const importRoute = await import('@/app/api/agents/import/route');
const agentRoute = await import('@/app/api/agents/[id]/route');
const evalGateRoute = await import('@/app/api/agents/[id]/eval-gate/route');
const smokeRoute = await import('@/app/api/agents/[id]/smoke-test/route');
const publishRoute = await import('@/app/api/agents/[id]/publish/route');
const previewRoute = await import('@/app/api/expressions/preview/route');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const approvalsRoute = await import('@/app/api/executions/[id]/approvals/route');
const conversationsRoute = await import('@/app/api/conversations/route');
const conversationRoute = await import('@/app/api/conversations/[id]/route');
const conversationItemsRoute = await import('@/app/api/conversations/[id]/items/route');
const { plugin: triage } = await import('../../../plugins/triage/src/main');
const { plugin: grafana } = await import('../../../plugins/grafana/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { plugin: textToolkit } = await import('../../../plugins/text-toolkit/src/main');
const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { cardAskFor, createFromCard, designAgentCard, reviseCardFor, reviseAgentCard, applyAgentChange } = await import('@/components/editor/spotlight/agent-ask');
const { publishAgentFor, smokeTestAgent } = await import('@/components/editor/new-agent');
const { stillLeft } = await import('@/lib/client/agent-change');
const { emptyStored, planKeeping, recordPlan, restore } = await import('@/components/editor/spotlight-history');

type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = async (route: unknown, method: string, path: string, body?: unknown, params?: Record<string, string>) => {
  const response = await (route as Handler)(new Request(`http://localhost:3000${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
};

wire.impl = async (path, init) => {
  const method = init.method ?? 'GET';
  if (!/\/versions$/.test(path)) wire.calls.push({ method, path, json: init.json });
  if (/^\/api\/workflows\/[^/]+\/versions$/.test(path)) return { versions: [] };
  const id = /^\/api\/agents\/([^/]+)(?:\/[a-z-]+)?$/.exec(path)?.[1];
  let result: { status: number; body: Record<string, any> };
  if (path === '/api/agents/design') result = await call(method === 'DELETE' ? designRoute.DELETE : designRoute.POST, method, path, init.json);
  else if (path === '/api/agents/import') result = await call(importRoute.POST, 'POST', path, init.json);
  else if (path === '/api/expressions/preview') result = await call(previewRoute.POST, 'POST', path, init.json);
  else if (id && path.endsWith('/eval-gate')) result = await call(method === 'GET' ? evalGateRoute.GET : evalGateRoute.POST, method, path, init.json, { id });
  else if (id && path.endsWith('/smoke-test')) result = await call(smokeRoute.POST, 'POST', path, init.json, { id });
  else if (id && path.endsWith('/publish')) result = await call(publishRoute.POST, 'POST', path, init.json, { id });
  else if (id && path === `/api/agents/${id}`) result = await call(method === 'PUT' ? agentRoute.PUT : agentRoute.GET, method, path, init.json, { id });
  else throw new Error(`unrouted ${method} ${path}`);
  if (result.status >= 400) throw new ApiError(result.body?.error ?? `${result.status}`, result.status, result.body);
  return result.body;
};

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  for (const plugin of [triage, grafana, messaging, textToolkit]) registry.registerBuiltin(plugin);
  types = registry.nodeTypes().filter((t) => t.available);
});
afterAll(async () => {
  await fake.close();
  await smtp.close();
  await new Promise<void>((resolve) => amServer.close(() => resolve()));
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  Object.assign(architect, { design: undefined, cases: '', calls: 0, caseCalls: 0 });
  Object.assign(agentSide, { calls: [], reply: 'Done.', score: 5, turns: 0 });
  agentSide.asked.length = 0;
  agentSide.results.length = 0;
  agentSide.offered.length = 0;
  alertmanager.alerts = [HIGH_CPU];
  alertmanager.silences.length = 0;
  alertmanager.requests.length = 0;
  smtp.mails.length = 0;
  wire.calls.length = 0;
  enableTestAuth(TEST_OWNER);
  useAssistant.getState().reset();
  useAutonomous.setState({ on: false });
});

// ---------------------------------------------------------------------------
// Helpers: the editor's Spotlight on an empty canvas
// ---------------------------------------------------------------------------

const json = (value: unknown) => JSON.stringify(value);
const propose = (input: Record<string, unknown>) => ({ summary: 'Draft', role: 'Helper', ...input });

/** The ask typed into Spotlight on an empty, untitled workflow (the composer's path: `cardAskFor`, then the card; asks first). */
async function designOnEmpty(workflowId: string, ask: string): Promise<{ id: string; card: AgentCard }> {
  useEditor.setState({ nodes: [], edges: [], pinData: {}, name: 'Untitled workflow', description: '', workflowId, nodeTypes: Object.fromEntries(types.map((t) => [t.type, t])) as never });
  const read = cardAskFor(ask);
  expect(read, ask).toBeDefined();
  await designAgentCard(ask, read!, { starter: !useEditor.getState().nodes.length });
  return cardOf();
}
const cards = (): Array<{ id: string; card: AgentCard }> => {
  const found: Array<{ id: string; card: AgentCard }> = [];
  for (const item of useAssistant.getState().items) if (item.role === 'assistant') for (const p of item.parts) if (p.kind === 'agentCard') found.push({ id: item.id, card: p.card });
  return found;
};
const cardOf = (index = 0): { id: string; card: AgentCard } => {
  const found = cards()[index];
  if (!found) throw new Error(`no agent card ${index}`);
  return found;
};
const agentRow = (agentId: string) => useAssistant.getState().agents.find((a) => a.agentId === agentId && !a.nodeId.startsWith('card:'));
type NodeTool = { name: string; nodeType: string; parameters?: Record<string, unknown>; requireApproval?: boolean; credentials?: Record<string, unknown> };
const nodeTools = (config: Partial<AgentConfig> | Record<string, unknown>) => ((config as Partial<AgentConfig>).tools ?? []).filter((t) => t.type === 'node') as NodeTool[];
const descriptorOf = (type: string) => types.find((t) => t.type === type)!.descriptor;
/** The numbered steps, without the "Tools:" line (which lists every tool by design). */
const stepLines = (instructions: string) => instructions.split('\n').filter((l) => /^\s*\d+[.)]\s/.test(l) && !/^\s*\d+[.)]\s*Tools:/.test(l));

/** The person's change on the agent's draft (D2: a credential is the person's pick, a From address the person's entry). */
async function personSets(agentId: string, nodeType: string, change: { slot?: string; credential?: { id: string; name: string }; parameters?: Record<string, unknown> }) {
  const agent = agentStore.get(agentId)!;
  const tools = agent.tools.map((t) =>
    t.type === 'node' && t.nodeType === nodeType
      ? { ...t, ...(change.credential && { credentials: { ...(t.credentials ?? {}), [change.slot!]: change.credential } }), ...(change.parameters && { parameters: { ...t.parameters, ...change.parameters } }) }
      : t,
  );
  const saved = await call(agentRoute.PUT, 'PUT', `/api/agents/${agentId}`, { ...agent, tools }, { id: agentId });
  expect(saved.status).toBe(200);
}

/** The editor's chat: the run route with a typed message (mode chat); the SSE's result. */
async function chatRun(workflowId: string, message: string) {
  const events = await readSse(await runRoute.POST(new Request(`http://localhost:3000/api/workflows/${workflowId}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: { message, sessionId: `s_${workflowId}` } }) }), { params: Promise.resolve({ id: workflowId }) }));
  const result = events.find((e) => e.event === 'result');
  expect(result, json(events.map((e) => e.event))).toBeDefined();
  return result!.data as { status: string; executionId: string };
}

/** The chat's approval card: the waiting calls (GET), then the person's decision (POST, SSE) on the one call. */
async function decide(executionId: string, approved: boolean) {
  const waiting = await call(approvalsRoute.GET, 'GET', `/api/executions/${executionId}/approvals`, undefined, { id: executionId });
  expect(waiting.status).toBe(200);
  const calls = waiting.body.approval.calls as Array<{ id: string; tool: string; input: Record<string, unknown> }>;
  expect(calls).toHaveLength(1);
  const response = await approvalsRoute.POST(new Request(`http://localhost:3000/api/executions/${executionId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: calls[0].id, approved }) }), { params: Promise.resolve({ id: executionId }) });
  const events = await readSse(response);
  return { call: calls[0], events, result: events.find((e) => e.event === 'result')?.data as { status: string } | undefined };
}

/** The editor's starter flow as the editor would save it. */
function saveDraft(workflowId: string): Workflow {
  const draft = { ...useEditor.getState().toWorkflow(), id: workflowId } as Workflow;
  store.saveWorkflow(draft);
  return draft;
}

// The Wazuh alert of the live host's check (contracts/ag1/live-host.md A5).
const WAZUH = 'Wazuh alert rule 5712 level 10: sshd brute force from 203.0.113.45 against web-01 (user root, 23 failures in 60s); related domain bad-login.example.net';

// The triage ask of ag1's live pass (backbone/ag1-findings.md; typed word for word, as live/wave-ag1 recorded it).
const TRIAGE_ASK = 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.';
// What the ag1 run's architect did: steps naming node types and a made-up send_summary, no Extract IOCs, cases that describe alerts.
const AG1_TRIAGE = {
  name: 'Alert triage agent',
  role: 'Alert triager',
  description: 'Triages alerts and emails on-call.',
  instructions: 'Input: an alert.\nSteps:\n1. Call triage.normalizeAlert on the alert.\n2. Call grafana.getAlerts for the related alerts.\n3. Judge how serious it is.\n4. Send the summary with send_summary to oncall@landflow.test.\nOutput: a short summary.\nHand over when: it is not an alert.',
  model: 'anthropic/claude-opus-5-5',
  nodeTools: 'triage.normalizeAlert, messaging.emailSend',
  cases: ['A pasted Wazuh alert about SSH brute force => Says it is high severity', 'An alert from Grafana about high CPU => Says it is medium', 'A sample alert with no IOCs => Says nothing to extract'],
};
const REAL_CASES = [
  'Wazuh alert rule 5712 level 10: sshd brute force from 198.51.100.7 against db-02 (user admin, 40 failures in 60s) => High severity; names 198.51.100.7',
  '[FIRING:1] High CPU on web-01 (critical): CPU above 90% for 5 minutes since 09:00 => Medium severity; names web-01',
  'Suricata ET POLICY curl User-Agent outbound from 10.0.4.12 to evil.example.net:443 => Names evil.example.net',
].join('\n');

// ---------------------------------------------------------------------------
// 1. Triage: ask → card → steps and settings → cases
// ---------------------------------------------------------------------------

describe('1. triage: ask → card → steps and settings → cases (AG07 × AG08)', () => {
  it('names Extract IOCs, only the agent’s own tools in the steps, fills Send Email from the ask, and saves real cases', async () => {
    architect.design = propose(AG1_TRIAGE);
    architect.cases = REAL_CASES;
    const { id, card } = await designOnEmpty('wf_ag2_triage', TRIAGE_ASK);

    // (a) AG07: Extract IOCs is on the card, or Not added names it with a reason (never silent).
    const extract = card.tools.find((t) => t.type === 'triage.extractIocs');
    if (!extract) expect(card.notAdded?.find((n) => /Extract IOCs/.test(n.name))?.reason, json(card.notAdded)).toBeTruthy();
    // The instructions name only normalize_alert, extract_iocs and send_email: no node type, no made-up name.
    const instructions = String(card.config.instructions);
    const named = new Set((instructions.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []).filter((t) => !/^(?:oncall|landflow)/.test(t)));
    expect([...named].every((t) => ['normalize_alert', 'extract_iocs', 'send_email'].includes(t)), instructions).toBe(true);
    expect(instructions).not.toMatch(/triage\.|grafana\.|core\.|send_summary/);

    // (b) AG08: Send Email goes to the ask's address; Subject and Text are $fromAI; From is the person's need, To is none.
    const mail = nodeTools(card.config).find((t) => t.nodeType === 'messaging.emailSend')!;
    expect(mail.parameters?.toEmail).toBe('oncall@landflow.test');
    expect(String(mail.parameters?.subject)).toMatch(/\$fromAI\(/);
    expect(String(mail.parameters?.text)).toMatch(/\$fromAI\(/);
    expect(card.needs.some((n) => /From Email/.test(n)), json(card.needs)).toBe(true);
    expect(card.needs.some((n) => /To Email/.test(n)), json(card.needs)).toBe(false);
    const schema = deriveToolSchema(descriptorOf('messaging.emailSend'), mail.parameters ?? {}) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('toEmail');

    // The architect's description cases were dropped and one follow-up made real ones; Create saves them as the gate's cases.
    expect(architect.caseCalls).toBe(1);
    expect(card.cases.length).toBeGreaterThanOrEqual(3);
    expect(card.cases.every((c) => !describesInput(c.input)), json(card.cases)).toBe(true);
    agentSide.reply = 'High severity.';
    await createFromCard(id, card);
    const agentId = cardOf().card.agentId!;
    const saved = listCases(agentId);
    expect(saved.map((c) => c.input)).toEqual(card.cases.map((c) => c.input));
    expect(saved.every((c) => !describesInput(c.input))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Revise: add and remove, the steps follow
// ---------------------------------------------------------------------------

const GRAFANA_ASK = 'Create an agent that lists the firing alerts in Grafana and explains what each one means. Use the Get Alerts and Get Alert Details tools.';
const GRAFANA_STEPS = 'Input: a question about alerts.\nSteps:\n1. Call get_alerts to list the firing alerts.\n2. Call get_alert_details for each alert by its name.\n3. Explain what each one means.\nOutput: each alert explained.\nHand over when: it is not about alerts.';

describe('2. revise: add and remove, the steps follow (AG09 × AG07 × AG08)', () => {
  it('a change adds Acknowledge Alert with its own step and (asks first), the Left row follows the draft, and a removal leaves no step', async () => {
    architect.design = propose({ name: 'Grafana observer', role: 'Alert reader', instructions: GRAFANA_STEPS, model: 'anthropic/claude-sonnet-5-5', nodeTools: 'grafana.getAlerts, grafana.getAlertDetails' });
    architect.cases = REAL_CASES;
    const { id, card } = await designOnEmpty('wf_ag2_grafana', GRAFANA_ASK);
    expect(stepLines(String(card.config.instructions)).join('\n')).toMatch(/get_alerts[\s\S]*get_alert_details/);
    agentSide.reply = 'One alert is firing: High CPU on web-01.';
    await createFromCard(id, card);
    const agentId = cardOf().card.agentId!;
    // The person picks the Viewer credential for the two reads (D2).
    const viewer = credentials.create({ name: 'Local Grafana', type: 'grafana.grafana_alertmanager_api_token', data: { url: amUrl, token: 'glsa_made_up_viewer' } });
    for (const type of ['grafana.getAlerts', 'grafana.getAlertDetails']) await personSets(agentId, type, { slot: 'grafana_alertmanager_api_token', credential: { id: viewer.id, name: viewer.name } });

    // "also let it acknowledge an alert" under the created card: a change card.
    architect.design = propose({ name: 'Grafana observer', role: 'Alert reader', instructions: GRAFANA_STEPS, model: 'anthropic/claude-sonnet-5-5', nodeTools: 'grafana.getAlerts, grafana.getAlertDetails, grafana.acknowledgeAlert' });
    const add = 'also let it acknowledge an alert';
    const target = reviseCardFor(add);
    expect(target?.card.state).toBe('created');
    await reviseAgentCard(target!.itemId, target!.card, add);
    const change = cardOf(1);
    expect(change.card.base?.agentId).toBe(agentId);
    expect(change.card.changes).toContain('Adds the tool Acknowledge Alert (asks first)');
    // Left: Acknowledge Alert's credential only; none for Get Alerts (set) and no Alert Name (the model fills it per call, AG08).
    expect(change.card.needs.some((n) => /^get_alerts: pick/.test(n)), json(change.card.needs)).toBe(false);
    expect(change.card.needs.some((n) => /Alert Name/i.test(n)), json(change.card.needs)).toBe(false);
    expect(change.card.needs.some((n) => /^acknowledge_alert: pick/.test(n)), json(change.card.needs)).toBe(true);
    // AG09's step for the added tool survived AG07's check: a step calls acknowledge_alert, not only the Tools line.
    const added = String(change.card.config.instructions);
    expect(stepLines(added).some((l) => /\backnowledge_alert\b/.test(l)), added).toBe(true);
    expect(stepLines(added).find((l) => /\backnowledge_alert\b/.test(l))).toMatch(/asks the person first/);

    // Apply to its draft: PUT, then the smoke test on the draft.
    wire.calls.length = 0;
    agentSide.calls = [{ match: 'get_alerts', input: {} }];
    await applyAgentChange(change.id, change.card);
    expect(wire.calls.map((c) => `${c.method} ${c.path.replace(agentId, ':id')}`)).toEqual(['PUT /api/agents/:id', 'POST /api/agents/:id/smoke-test']);
    const applied = cardOf(1).card;
    expect(applied.state).toBe('created');
    expect(applied.smoke?.state).toBeDefined();

    // The person picks the Editor credential for Acknowledge Alert on the agent's page: the builder's save (AGENT_SAVED) makes the
    // card read the draft again, and the Left row drops the line.
    const editor = credentials.create({ name: 'Local Grafana (editor)', type: 'grafana.grafana_alertmanager_api_token', data: { url: amUrl, token: 'glsa_made_up_editor' } });
    const before = stillLeft(applied.needs, (await call(agentRoute.GET, 'GET', `/api/agents/${agentId}`, undefined, { id: agentId })).body.agent);
    expect(before.some((n) => /^acknowledge_alert: pick/.test(n))).toBe(true);
    await personSets(agentId, 'grafana.acknowledgeAlert', { slot: 'grafana_alertmanager_api_token', credential: { id: editor.id, name: editor.name } });
    const after = stillLeft(applied.needs, (await call(agentRoute.GET, 'GET', `/api/agents/${agentId}`, undefined, { id: agentId })).body.agent);
    expect(after.some((n) => /^acknowledge_alert: pick/.test(n)), json(after)).toBe(false);

    // "stop using Get Alert Details": the change removes it, and no step names get_alert_details (AG07's `foreign`).
    architect.design = propose({ name: 'Grafana observer', role: 'Alert reader', instructions: `${GRAFANA_STEPS.replace('3. Explain', '3. Call acknowledge_alert when asked; it asks the person first.\n4. Explain')}`, model: 'anthropic/claude-sonnet-5-5', nodeTools: 'grafana.getAlerts, grafana.acknowledgeAlert' });
    const remove = 'stop using Get Alert Details';
    const latest = reviseCardFor(remove);
    expect(latest?.itemId).toBe(change.id);
    await reviseAgentCard(latest!.itemId, latest!.card, remove);
    const removal = cards().at(-1)!;
    expect(removal.card.changes).toContain('Removes the tool Get Alert Details');
    expect(String(removal.card.config.instructions)).not.toMatch(/\bget_alert_details\b/);
    expect(nodeTools(removal.card.config).some((t) => t.nodeType === 'grafana.getAlertDetails')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The editor's chat approves the agent's write
// ---------------------------------------------------------------------------

describe('3. the editor’s chat approves the agent’s write (AG10 × AG08 × SB16)', () => {
  it('the starter flow asks in the chat; Approve sends one email to the ask’s address with the model’s subject; a webhook run waits in Needs you (a Refuse twin refuses)', async () => {
    architect.design = propose({ ...AG1_TRIAGE, nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend' });
    architect.cases = REAL_CASES;
    const { id, card } = await designOnEmpty('wf_ag2_chat', TRIAGE_ASK);
    agentSide.reply = 'High severity.';
    await createFromCard(id, card);
    const agentId = cardOf().card.agentId!;

    // SB16 × AG10: Create on an empty canvas laid out the starter flow, whose Run an Agent step asks in the editor's chat.
    const step = useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent')!;
    expect(step.data.wf.parameters).toMatchObject({ agentId, toolApprovals: 'askInChat' });

    // The person picks the SMTP credential and enters the From address; the smoke test passes; the gate's judge passes.
    const mail = credentials.create({ name: 'Local SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: smtp.port, secure: false, disableStartTls: true, user: '', password: '' } });
    await personSets(agentId, 'messaging.emailSend', { slot: 'smtp', credential: { id: mail.id, name: mail.name }, parameters: { fromEmail: 'landflow@landflow.test' } });
    expect((await smokeTestAgent(step.id))?.state).toBe('passed');
    expect(smtp.mails).toHaveLength(0); // the smoke test's write was denied, never sent
    agentSide.score = 5;
    expect(await publishAgentFor(step.id)).toBe(true);
    expect(agentStore.get(agentId)?.published).toBeDefined();
    const flow = saveDraft('wf_ag2_chat');

    // The editor's chat: the agent's model sends with a To of its own; the run waits with one call.
    agentSide.calls = [{ match: 'email', input: { subject: 'Brute force on web-01', body: 'sshd brute force from 203.0.113.45 against web-01.', toEmail: 'attacker@example.net' } }];
    agentSide.reply = 'Sent the summary to on-call.';
    const waiting = await chatRun('wf_ag2_chat', WAZUH);
    expect(waiting.status).toBe('waiting');
    expect(agentSide.asked.some((m) => m.includes('203.0.113.45'))).toBe(true);
    // AG08: the tool offered the model no toEmail; AG10: the approval card holds the call, and shows only what the schema offered.
    const decided = await decide(waiting.executionId, true);
    expect(json(decided.call.input)).not.toContain('attacker@example.net');
    expect(decided.call.tool).toMatch(/^(?:send_email|Send Email)$/);
    expect(decided.result?.status).toBe('success');
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0].to).toEqual(['oncall@landflow.test']);
    expect(smtp.mails[0].data).toMatch(/^Subject: Brute force on web-01/m);
    expect(json(smtp.mails[0])).not.toContain('attacker@example.net');

    // The same flow from a webhook (wave ap1, AP02: the person's decision of 2026-11-18): it waits in Needs you, one
    // approval-inbox request for the held call, nothing more sent until someone approves.
    agentSide.turns = 0;
    const trigger = flow.nodes.find((n) => n.type === 'core.chatTrigger')!;
    const hooked = await runWorkflow({ workflow: flow, mode: 'webhook', startNodeId: trigger.id, triggerItems: [{ json: { chatInput: WAZUH } }] });
    expect(hooked.status).toBe('waiting');
    expect(waitingOfExecution(hooked.executionId)).toHaveLength(1);
    expect(smtp.mails).toHaveLength(1);

    // Twin: the same flow with Tool Approvals Refuse still refuses from a webhook, nothing more sent.
    agentSide.turns = 0;
    const refusing = { ...flow, nodes: flow.nodes.map((n) => (n.type === 'core.messageAgent' ? { ...n, parameters: { ...n.parameters, toolApprovals: 'refuse' } } : n)) } as Workflow;
    const refused = await runWorkflow({ workflow: refusing, mode: 'webhook', startNodeId: trigger.id, triggerItems: [{ json: { chatInput: WAZUH } }] });
    expect(refused.status).toBe('success');
    expect(json(refused.runData)).toMatch(/needs a person'?s approval|denied/);
    expect(waitingOfExecution(refused.executionId)).toHaveLength(0);
    expect(smtp.mails).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. History keeps the agent
// ---------------------------------------------------------------------------

describe('4. history keeps the agent (AG11 × AG09 × AG10)', () => {
  it('the created card comes back with its row’s words; an applied change card comes back applied with its smoke line', async () => {
    const workflowId = 'wf_ag2_history';
    const conversation = await call(conversationsRoute.POST, 'POST', '/api/conversations', { surface: 'spotlight', subjectType: 'workflow', subjectId: workflowId });
    expect(conversation.status).toBe(201);
    const conversationId = conversation.body.conversation.id as string;
    const stored = emptyStored();
    // The panel's keeping effect: plan, store through the route, record.
    const keep = async () => {
      const plan = planKeeping(useAssistant.getState().items, stored, { keeping: true, live: false, agents: useAssistant.getState().agents });
      recordPlan(stored, plan);
      if (!plan.inputs.length) return;
      const posted = await call(conversationItemsRoute.POST, 'POST', `/api/conversations/${conversationId}/items`, { items: plan.inputs }, { id: conversationId });
      expect(posted.status, json(posted.body)).toBe(200);
    };

    architect.design = propose({ ...AG1_TRIAGE, nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend' });
    architect.cases = REAL_CASES;
    const { id, card } = await designOnEmpty(workflowId, TRIAGE_ASK);
    await keep();
    agentSide.reply = 'High severity.';
    await createFromCard(id, card);
    await keep();
    const agentId = cardOf().card.agentId!;
    const step = useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent')!;
    const mail = credentials.create({ name: 'Local SMTP (history)', type: 'messaging.smtp', data: { host: '127.0.0.1', port: smtp.port, secure: false, disableStartTls: true, user: '', password: '' } });
    await personSets(agentId, 'messaging.emailSend', { slot: 'smtp', credential: { id: mail.id, name: mail.name }, parameters: { fromEmail: 'landflow@landflow.test' } });
    expect((await smokeTestAgent(step.id))?.state).toBe('passed');
    await keep();
    agentSide.score = 2;
    expect(await publishAgentFor(step.id)).toBe(false);
    await keep();
    const row = agentRow(agentId)!;
    expect(row.publish?.state).toBe('held');
    const words = { smoke: smokeLine(row.smoke), publish: publishLine(row.publish) };
    expect(words.publish).toMatch(/^held by the eval gate: 2\.0 \/ 5/);

    // A change under the created card, applied: a change card with its smoke line.
    architect.design = propose({ ...AG1_TRIAGE, instructions: `${AG1_TRIAGE.instructions}\nKeep the summary under five lines.`, nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend' });
    const ask = 'also keep the summary under five lines';
    const target = reviseCardFor(ask)!;
    await reviseAgentCard(target.itemId, target.card, ask);
    await keep();
    const change = cards().at(-1)!;
    expect(change.card.base?.agentId).toBe(agentId);
    await applyAgentChange(change.id, change.card);
    await keep();
    const applied = cards().at(-1)!.card;
    expect(applied.state).toBe('created');
    const appliedSmoke = smokeLine(applied.smoke);

    // The reload: the conversation as the route gives it, restored.
    const read = await call(conversationRoute.GET, 'GET', `/api/conversations/${conversationId}`, undefined, { id: conversationId });
    expect(read.status).toBe(200);
    const back = restore(read.body.items as ConversationItem[]);
    const restoredCards = back.items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'agentCard' ? [p.card] : [])) : []));
    const created = restoredCards.find((c) => c.agentId === agentId && !c.base)!;
    expect(created.state).toBe('created');
    const restoredRow = back.agents.find((a) => a.agentId === agentId)!;
    expect(smokeLine(restoredRow.smoke)).toBe(words.smoke);
    expect(publishLine(restoredRow.publish)).toBe(words.publish);
    const restoredChange = restoredCards.find((c) => c.base?.agentId === agentId)!;
    expect(restoredChange.state).toBe('created');
    expect(smokeLine(restoredChange.smoke)).toBe(appliedSmoke);
  });
});

// ---------------------------------------------------------------------------
// 5. Grafana acknowledges
// ---------------------------------------------------------------------------

describe('5. Grafana acknowledges (AG10)', () => {
  it('a chat run waits, Approve posts one silence matching the alert’s name, and Get Alert Details finds the alert by name', async () => {
    const viewer = credentials.create({ name: 'Local Grafana (join 5)', type: 'grafana.grafana_alertmanager_api_token', data: { url: amUrl, token: 'glsa_made_up_viewer' } });
    const editor = credentials.create({ name: 'Local Grafana (editor, join 5)', type: 'grafana.grafana_alertmanager_api_token', data: { url: amUrl, token: 'glsa_made_up_editor' } });
    const slot = (c: { id: string; name: string }) => ({ grafana_alertmanager_api_token: { id: c.id, name: c.name } });
    const observer = agentStore.create({
      name: 'Grafana observer',
      instructions: 'Input: a question about alerts.\nSteps:\n1. Call get_alerts.\n2. Call get_alert_details by name.\n3. Call acknowledge_alert when asked; it asks the person first.\nOutput: the answer.',
      model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      tools: [
        { id: 't1', type: 'node', name: 'Get Alerts', description: 'List firing alerts', nodeType: 'grafana.getAlerts', parameters: {}, credentials: slot(viewer) },
        { id: 't2', type: 'node', name: 'Get Alert Details', description: 'One alert by name', nodeType: 'grafana.getAlertDetails', parameters: {}, credentials: slot(viewer) },
        { id: 't3', type: 'node', name: 'Acknowledge Alert', description: 'Silence an alert', nodeType: 'grafana.acknowledgeAlert', parameters: {}, credentials: slot(editor), requireApproval: true },
      ],
    } as never);
    agentStore.publish(observer.id);
    const { starterFlow } = await import('@/lib/shared/agent-card');
    const flow = starterFlow({ id: observer.id, name: observer.name }, 'What is firing?');
    const ids = Object.fromEntries(flow.nodes.map((n) => [n.key, n.name]));
    const workflow: Workflow = {
      id: 'wf_ag2_grafana_ack',
      name: flow.name,
      nodes: flow.nodes.map((n) => ({ id: n.name, name: n.name, type: n.type, typeVersion: 1, position: [n.x, n.y], parameters: n.parameters })),
      connections: flow.edges.map(([from, to], i) => ({ id: `e${i}`, type: 'main', source: ids[from], target: ids[to], sourceIndex: 0, targetIndex: 0 })),
    } as Workflow;
    store.saveWorkflow(workflow);

    agentSide.calls = [{ match: 'acknowledge', input: { alertId: 'High CPU on web-01' } }];
    agentSide.reply = 'Acknowledged High CPU on web-01.';
    const waiting = await chatRun(workflow.id, 'acknowledge High CPU on web-01');
    expect(waiting.status).toBe('waiting');
    expect(alertmanager.silences).toHaveLength(0); // nothing before the person's decision
    const decided = await decide(waiting.executionId, true);
    expect(decided.call.tool).toBe('Acknowledge Alert');
    expect(decided.result?.status).toBe('success');
    expect(alertmanager.silences).toHaveLength(1);
    expect(alertmanager.silences[0].matchers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'alertname', value: 'High CPU on web-01' })]));
    expect(alertmanager.requests.filter((r) => r.startsWith('POST /api/v2/silences'))).toHaveLength(1);
    expect(alertmanager.requests.some((r) => /\/api\/v2\/silence(?:$|[/?])/.test(r))).toBe(false);

    // Get Alert Details by name: a read, no approval; the alert comes back.
    agentSide.results.length = 0;
    agentSide.calls = [{ match: 'details', input: { alertId: 'High CPU on web-01' } }];
    agentSide.reply = 'High CPU on web-01 is critical.';
    const details = await chatRun(workflow.id, 'what are the details of High CPU on web-01?');
    expect(details.status).toBe('success');
    const read = agentSide.results.find((r) => /details/i.test(r.name));
    expect(read?.content, json(agentSide.results)).toContain('High CPU on web-01');
    expect(alertmanager.requests.some((r) => r.startsWith('GET /api/v2/alerts?filter='))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Contract copies
// ---------------------------------------------------------------------------

// The pipeline's contracts folder lives outside the repository: set LANDFLOW_BACKBONE_CONTRACTS to it to check the copies.
const CONTRACTS = process.env.LANDFLOW_BACKBONE_CONTRACTS ?? '';
describe.skipIf(!CONTRACTS || !existsSync(join(CONTRACTS, 'ag4')))('6. the ag2 contract copies are byte-identical', () => {
  it.each([
    // Wave ag4 replaced these two contracts (contracts/ag4, checked in agents-ag4-joins.test.ts).
    ['src/lib/shared/agent-card.ts', 'ag4/agent-card.ts'],
    ['test/spotlight-scenarios/scenario.ts', 'ag4/spotlight-scenario.ts'],
  ])('%s = contracts/%s', (copy, contract) => {
    expect(readFileSync(join(import.meta.dirname, '..', copy), 'utf8')).toBe(readFileSync(join(CONTRACTS, contract), 'utf8'));
  });
});
