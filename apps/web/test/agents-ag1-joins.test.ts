/**
 * Wave ag1's join tests (carryover-ag1.md §2): each contract between two packages of the wave, with both real sides and
 * no fake between them. Only the edges are stubbed: the Agent architect's model (a fake Anthropic Messages API on loopback,
 * reached through the host's own `anthropic/…` builder model with a made-up key), the agent's own model and the eval gate's
 * judge (scripted), the browser's HTTP client (straight to the real route handlers), a fake SMTP server and a fake
 * Alertmanager. The triage, Grafana, Messaging and Text Toolkit plugins are their own code, in process; the Go and Python
 * plugins are their recorded manifests (design only).
 *
 * 1. Triage: ask → card → node tool item → honest smoke → publish (AG02 → AG03 → AG05).
 * 2. Grafana: declared credential → card need → untested → picker → passed (AG03 → AG02 → AG05 → AG06).
 * 3. Revise keeps the design's rules (AG04 × AG02 × AG05).
 * 4. The chat's typed message reaches the starter's agent (AG01 × SB16 × SB18).
 * 5. Reads stay reads (AG02 × AG06).
 * 6. The contract copies are byte-identical to backbone/contracts/ag1 (LANDFLOW_BACKBONE_CONTRACTS names the folder).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, Workflow } from '@landflow/engine';
import { publishLine, starterSample, type AgentCard, type AgentPublish } from '@/lib/shared/agent-card';
import type { AgentConfig } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { readSse, startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeSmtp } from '../../../plugins/messaging/test/fake-smtp';

vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// The edges
// ---------------------------------------------------------------------------

/** The architect's fake Anthropic: `design` is what propose_design proposes; every call is counted. */
const architect = { design: undefined as Record<string, unknown> | undefined, calls: 0, prompts: [] as string[] };
type AnthropicBody = { system?: unknown; messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ name?: string; function?: { name: string } }> };
const fake = await startFakeModels({
  reply: (_provider, raw): FakeReply => {
    const body = (raw ?? {}) as AnthropicBody;
    const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
    const messages = body.messages ?? [];
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
    const lastIsResult = JSON.stringify(messages.at(-1)?.content ?? '').includes('tool_result');
    if (/You write test cases/.test(system)) return { text: 'Triage this alert => Names the source address\nIs this serious? => Says how serious\nSend it to everyone => Sends only to on-call' };
    architect.calls += 1;
    architect.prompts.push(JSON.stringify(messages[0]?.content ?? ''));
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
          if (agentSide.calls.length) {
            const offered = input.tools.map((t) => t.name);
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

// A local Alertmanager: one "High CPU on web-01" alert, or none.
const alertmanager = { alerts: [] as unknown[], hits: 0 };
const HIGH_CPU = { labels: { alertname: 'High CPU on web-01', instance: 'web-01', severity: 'critical' }, annotations: { summary: 'CPU above 90% for 5 minutes' }, status: { state: 'active' }, startsAt: '2026-11-17T09:00:00Z', fingerprint: 'ab12' };
const amServer = createServer((request, response) => {
  if (request.url?.startsWith('/api/v2/alerts')) {
    alertmanager.hits += 1;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(alertmanager.alerts));
  } else response.writeHead(404).end();
});
await new Promise<void>((resolve) => amServer.listen(0, '127.0.0.1', resolve));
const amUrl = `http://127.0.0.1:${(amServer.address() as AddressInfo).port}`;
const smtp = await startFakeSmtp();

const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ag1-joins-')),
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
const { defineNode, definePlugin } = await import('@landflow/sdk');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { httpRequestNode } = await import('@/lib/server/nodes/data');
const { agentStore } = await import('@/lib/server/agents/store');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const designRoute = await import('@/app/api/agents/design/route');
const importRoute = await import('@/app/api/agents/import/route');
const agentRoute = await import('@/app/api/agents/[id]/route');
const evalGateRoute = await import('@/app/api/agents/[id]/eval-gate/route');
const smokeRoute = await import('@/app/api/agents/[id]/smoke-test/route');
const publishRoute = await import('@/app/api/agents/[id]/publish/route');
const previewRoute = await import('@/app/api/expressions/preview/route');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const { plugin: triage } = await import('../../../plugins/triage/src/main');
const { plugin: grafana } = await import('../../../plugins/grafana/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { plugin: textToolkit } = await import('../../../plugins/text-toolkit/src/main');
const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { cardAskFor, createFromCard, designAgentCard, reviseCardFor, agentCardQuestion, reviseAgentCard, applyAgentChange, publishAgentChange } = await import('@/components/editor/spotlight/agent-ask');
const { publishAgentFor } = await import('@/components/editor/new-agent');
const { toolCredentialSlots } = await import('@/components/agents/capabilities-card');

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

/** The Go and Python plugins as their recorded manifests: their nodes exist for the design; they put out nothing. */
function fromManifest(path: string): void {
  const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { plugin: Parameters<typeof definePlugin>[0]['info']; nodes: Array<Parameters<typeof defineNode>[0]['description']>; credentialTypes?: never[] };
  const nodes = manifest.nodes.filter((d) => d.kind !== 'trigger').map((description) => defineNode({ description, execute: async () => [[{ json: {} }]] }));
  registry.registerBuiltin(definePlugin({ info: manifest.plugin, nodes, ...(manifest.credentialTypes && { credentialTypes: manifest.credentialTypes }) } as Parameters<typeof definePlugin>[0]));
}

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  for (const plugin of [triage, grafana, messaging, textToolkit]) registry.registerBuiltin(plugin);
  fromManifest('./fixtures/plugin-manifests/databases.json');
  fromManifest('../../../packages/protocol/test/fixtures/manifests/go-crypto.json');
  fromManifest('../../../packages/protocol/test/fixtures/manifests/py-insights.json');
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
  architect.design = undefined;
  architect.calls = 0;
  architect.prompts.length = 0;
  Object.assign(agentSide, { calls: [], reply: 'Done.', score: 5, turns: 0 });
  agentSide.asked.length = 0;
  agentSide.results.length = 0;
  alertmanager.alerts = [HIGH_CPU];
  alertmanager.hits = 0;
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

/** The ask typed into Spotlight on an empty, untitled workflow: the agent card (asks first). */
async function designOnEmpty(workflowId: string, ask: string): Promise<{ id: string; card: AgentCard }> {
  useEditor.setState({ nodes: [], edges: [], pinData: {}, name: 'Untitled workflow', description: '', workflowId, nodeTypes: Object.fromEntries(types.map((t) => [t.type, t])) as never });
  const read = cardAskFor(ask);
  expect(read, ask).toBeDefined();
  await designAgentCard(ask, read!, { starter: true });
  return cardOf();
}
const cardOf = (index = 0): { id: string; card: AgentCard } => {
  const found: Array<{ id: string; card: AgentCard }> = [];
  for (const item of useAssistant.getState().items) if (item.role === 'assistant') for (const p of item.parts) if (p.kind === 'agentCard') found.push({ id: item.id, card: p.card });
  if (!found[index]) throw new Error(`no agent card ${index}`);
  return found[index];
};
const agentRow = (agentId: string) => useAssistant.getState().agents.find((a) => a.agentId === agentId);
const nodeTools = (config: Partial<AgentConfig> | Record<string, unknown>) => ((config as Partial<AgentConfig>).tools ?? []).filter((t) => t.type === 'node') as Array<{ name: string; nodeType: string; parameters?: Record<string, unknown>; requireApproval?: boolean; credentials?: Record<string, unknown> }>;
const descriptorOf = (type: string) => types.find((t) => t.type === type)!.descriptor;

/** The person's pick of a credential on every node tool of `nodeType` (D2: picked by the person, never by Spotlight). */
function pick(agentId: string, nodeType: string, slot: string, credential: { id: string; name: string }) {
  const agent = agentStore.get(agentId)!;
  const config = { ...agent, tools: agent.tools.map((t) => (t.type === 'node' && t.nodeType === nodeType ? { ...t, credentials: { ...(t.credentials ?? {}), [slot]: credential } } : t)) };
  return call(agentRoute.PUT, 'PUT', `/api/agents/${agentId}`, config, { id: agentId });
}

// The Wazuh alert of the live host's check (contracts/ag1/live-host.md A5).
const WAZUH = {
  timestamp: '2026-11-17T09:12:44.000+0000',
  rule: { level: 12, description: 'sshd: brute force trying to get access to the system.', id: '5763', groups: ['sshd', 'authentication_failures'] },
  agent: { id: '003', name: 'web-01', ip: '10.0.4.12' },
  id: '1763370764.1001',
  full_log: 'Nov 17 09:12:43 web-01 sshd[2211]: Failed password for root from 203.0.113.45 port 52144 ssh2',
  data: { srcip: '203.0.113.45', srcuser: 'root' },
};

// ---------------------------------------------------------------------------
// 1. Triage: ask → card → node tool item → honest smoke → publish
// ---------------------------------------------------------------------------

const TRIAGE_ASK = 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test. Use the Normalize Alert, Extract IOCs and Send Email tools.';

describe('1. triage: ask → card → node tool item → honest smoke → publish (AG02 → AG03 → AG05)', () => {
  it('the card follows the ask, the tools get the alert, the denied email is named, and a low score holds the publish', async () => {
    architect.design = propose({
      name: 'Alert triage agent',
      role: 'Alert triager',
      description: 'Triages alerts and emails on-call.',
      instructions: 'Input: an alert.\nSteps:\n1. Call normalize_alert on the alert.\n2. Call lookup_threat_intel for each IOC.\n3. Call send_email to oncall@landflow.test.\nOutput: a short summary.\nHand over when: it is not an alert.',
      model: 'anthropic/claude-opus-5-5',
      nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend',
    });
    const { id, card } = await designOnEmpty('wf_ag1_triage', TRIAGE_ASK);

    // (a) AG02: a noun name, the address whole, the builder model, reads without approval, the write asks first, only its own tools named.
    expect(card.name).not.toMatch(/^(?:an?|the|me|my)\b|,/i);
    // The address whole where the card's agent says what it does (the scenario contract's keepsText: description or steps), never cut.
    expect(`${card.description}\n${String(card.config.instructions)}`).toMatch(/oncall@landflow\.test(?!\w)/);
    expect(`${card.description}\n${String(card.config.instructions)}`).not.toMatch(/oncall@landflow(?!\.test)/);
    expect(card.model).toBe('anthropic/claude-sonnet-5-5');
    expect(card.models?.[0]).toBe('anthropic/claude-sonnet-5-5');
    expect(architect.prompts[0]).toContain('oncall@landflow.test'); // the whole ask reached the architect
    const tool = (type: string) => card.tools.find((t) => t.type === type);
    expect(tool('triage.normalizeAlert')).toMatchObject({ requireApproval: false });
    expect(tool('triage.extractIocs')).toMatchObject({ requireApproval: false });
    expect(tool('messaging.emailSend')).toMatchObject({ requireApproval: true });
    const instructions = String(card.config.instructions);
    expect(instructions).not.toContain('lookup_threat_intel');
    expect(card.notAdded ?? []).toEqual([]);

    // (b) Create (the person's click), then the person picks the SMTP credential (D2): the fake SMTP server.
    const mail = credentials.create({ name: 'Local SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: smtp.port, secure: false, disableStartTls: true, user: '', password: '' } });
    // Create's smoke test runs before a pick can happen; the agent's model calls the tools with the alert as `item`.
    agentSide.calls = [
      { match: 'normali', input: { item: WAZUH } },
      { match: 'ioc', input: { item: WAZUH } },
      { match: 'email', input: { toEmail: 'oncall@landflow.test', subject: 'Alert', text: 'Brute force from 203.0.113.45 on web-01' } },
    ];
    agentSide.reply = 'High severity: brute force from 203.0.113.45 on web-01. The email to oncall@landflow.test needs your approval: not sent.';
    await createFromCard(id, card);
    const created = cardOf().card;
    expect(created.state).toBe('created');
    const agentId = created.agentId!;
    // Send Email has no credential yet: the honest smoke test is untested, nothing ran.
    expect(agentRow(agentId)?.smoke).toMatchObject({ state: 'untested', reason: expect.stringMatching(/^needs a credential: Send Email/) });
    expect(agentSide.turns).toBe(0);
    expect((await pick(agentId, 'messaging.emailSend', 'smtp', { id: mail.id, name: mail.name })).status).toBe(200);

    // The row's test again: the agent's model calls normalize_alert with the Wazuh alert; the node got it and put out a full alert.
    const sample = starterSample(created);
    const { body } = await call(smokeRoute.POST, 'POST', `/api/agents/${agentId}/smoke-test`, { message: sample }, { id: agentId });
    const normalized = agentSide.results.find((r) => /normali/i.test(r.name));
    expect(normalized, json(agentSide.results)).toBeDefined();
    expect(normalized!.content).toContain('203.0.113.45');
    expect(normalized!.content).toMatch(/"title"/);
    expect(normalized!.content).toMatch(/"severity"/);
    expect(agentSide.results.find((r) => /ioc/i.test(r.name))?.content).toContain('203.0.113.45');

    // (c) AG05: passed with each call named, the denied write in the reason, and nothing reached the SMTP server.
    const smoke = body.smoke as NonNullable<AgentCard['smoke']>;
    expect(smoke.state).toBe('passed');
    // One call each (the denied one is recorded when it is decided, before the parallel calls run).
    const status = (pattern: RegExp) => smoke.tools?.filter((t) => pattern.test(t.name)).map((t) => t.status);
    expect(smoke.tools).toHaveLength(3);
    expect(status(/normali/i)).toEqual(['success']);
    expect(status(/ioc/i)).toEqual(['success']);
    expect(status(/email/i)).toEqual(['denied']);
    expect(smoke.reason).toMatch(/^Send Email needs approval: not sent/);
    expect(smtp.mails).toHaveLength(0);

    // (d) the row's Publish: publishing with the case count, then the judge under 3 / 5 holds it; the words are publishLine's.
    const nodeId = useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent')!.id;
    useAssistant.getState().setAgent(nodeId, { smoke });
    agentSide.score = 2;
    agentSide.calls = [];
    const seen: AgentPublish[] = [];
    const stop = useAssistant.subscribe((s) => {
      const p = s.agents.find((a) => a.nodeId === nodeId)?.publish;
      if (p && seen.at(-1) !== p) seen.push(p);
    });
    const published = await publishAgentFor(nodeId);
    stop();
    expect(published).toBe(false);
    expect(seen.find((p) => p.state === 'publishing' && p.cases)).toMatchObject({ state: 'publishing', cases: created.cases.length });
    const row = agentRow(agentId)!;
    expect(row.publish?.state).toBe('held');
    expect(row.held).toBe(publishLine(row.publish));
    expect(row.held).toMatch(/^held by the eval gate: 2\.0 \/ 5/);
    expect(agentStore.get(agentId)?.published).toBeUndefined();
    expect(json(wire.calls)).not.toContain('skipEval');
  });
});

// ---------------------------------------------------------------------------
// 2. Grafana: declared credential → card need → untested → picker → passed
// ---------------------------------------------------------------------------

const GRAFANA_ASK = 'Create an agent that lists the firing alerts in Grafana and explains what each one means. Use the Get Alerts and Get Alert Details tools.';

describe('2. Grafana: declared credential → card need → untested → picker → passed (AG03 → AG02 → AG05 → AG06)', () => {
  it('names the credential, stays untested without it, and passes or fails on what Alertmanager answers once it is picked', async () => {
    architect.design = propose({ name: 'Grafana alerts agent', role: 'Alert reader', instructions: 'Input: a question.\nSteps:\n1. Call get_alerts.\nOutput: each alert explained.\nHand over when: it is not about alerts.', model: 'anthropic/claude-sonnet-5-5', nodeTools: 'grafana.getAlerts, grafana.getAlertDetails' });
    const { id, card } = await designOnEmpty('wf_ag1_grafana', GRAFANA_ASK);

    // (a) the card's needs name the Grafana credential for Get Alerts (the architect reads AG03's declaration).
    expect(card.tools.map((t) => t.type)).toEqual(expect.arrayContaining(['grafana.getAlerts', 'grafana.getAlertDetails']));
    expect(card.tools.every((t) => !t.requireApproval)).toBe(true);
    expect(card.needs.some((n) => /get_alerts|Get Alerts/.test(n) && /grafana\w* credential/i.test(n)), json(card.needs)).toBe(true);

    // (b) Create: untested, "needs a credential: Get Alerts", and the agent's model never called.
    agentSide.calls = [{ match: 'get_alerts|Get_Alerts', input: {} }];
    agentSide.reply = 'One alert is firing: High CPU on web-01 (critical).';
    await createFromCard(id, card);
    const agentId = cardOf().card.agentId!;
    expect(agentRow(agentId)?.smoke).toMatchObject({ state: 'untested', reason: expect.stringMatching(/^needs a credential: Get Alerts/) });
    expect(agentSide.turns).toBe(0);

    // (c) AG06: the tool dialog's slots: Get Alerts lists the Grafana slot as required; HTTP Request with Authentication None lists none.
    const slots = toolCredentialSlots(descriptorOf('grafana.getAlerts'), {});
    expect(slots.map((s) => [s.name, s.required])).toEqual([['grafana_alertmanager_api_token', true]]);
    expect(toolCredentialSlots(httpRequestNode.description, { authentication: 'none' })).toEqual([]);

    // (d) the person's pick (the fake Alertmanager, a made-up token): the smoke test runs, Get Alerts succeeds, it passes.
    const local = credentials.create({ name: 'Local Grafana', type: 'grafana.grafana_alertmanager_api_token', data: { url: `${amUrl}/`, token: 'glsa_made_up_for_the_test' } });
    for (const type of ['grafana.getAlerts', 'grafana.getAlertDetails']) expect((await pick(agentId, type, 'grafana_alertmanager_api_token', { id: local.id, name: local.name })).status).toBe(200);
    const passed = (await call(smokeRoute.POST, 'POST', `/api/agents/${agentId}/smoke-test`, { message: 'What is firing in Grafana right now?' }, { id: agentId })).body.smoke;
    expect(alertmanager.hits).toBe(1);
    expect(passed).toMatchObject({ state: 'passed', tools: [{ name: expect.stringMatching(/get.?alerts/i), status: 'success' }] });
    expect(agentSide.results.find((r) => /alerts/i.test(r.name))?.content).toContain('High CPU on web-01');

    // With Alertmanager answering [], the same test fails: nothing to work with.
    alertmanager.alerts = [];
    agentSide.turns = 0;
    const empty = (await call(smokeRoute.POST, 'POST', `/api/agents/${agentId}/smoke-test`, { message: 'What is firing in Grafana right now?' }, { id: agentId })).body.smoke;
    expect(empty).toMatchObject({ state: 'failed', reason: expect.stringMatching(/^Get Alerts returned nothing to work with/) });
  });
});

// ---------------------------------------------------------------------------
// 3. Revise keeps the design's rules
// ---------------------------------------------------------------------------

const UTILITY_ASK = 'Create an agent that decodes JWTs, hashes strings and makes UUIDs.';
const UTILITY_STEPS = 'Input: a token or text.\nSteps:\n1. Decode, hash or make a UUID as asked.\nOutput: the result.\nHand over when: it is not one of these.';

describe('3. revise keeps the design’s rules (AG04 × AG02 × AG05)', () => {
  it('revises the pending card in place, answers a question without designing, and changes a created agent only through its draft', async () => {
    architect.design = propose({ name: 'Utility helper', instructions: UTILITY_STEPS, model: 'anthropic/claude-opus-5-5', nodeTools: 'go-crypto.jwtDecode, go-crypto.hash, go-crypto.uuid' });
    const first = await designOnEmpty('wf_ag1_utility', UTILITY_ASK);
    // AG02: a job that reads tokens is not secret-masked on input; the builder model.
    expect(first.card.model).toBe('anthropic/claude-sonnet-5-5');
    expect((first.card.config as Partial<AgentConfig>).guardrails?.input?.enabled).toBeFalsy();
    expect(first.card.guardrails.some((g) => /Doesn’t mask tokens/.test(g))).toBe(true);
    expect(first.card.tools.some((t) => t.type === 'text-toolkit.slugify')).toBe(false);

    // "add Slugify as a tool" under the pending card: the same card, revised in place; nothing else changes, no flow build.
    architect.design = propose({ name: 'Utility helper', instructions: UTILITY_STEPS, model: 'anthropic/claude-opus-5-5', nodeTools: 'go-crypto.jwtDecode, go-crypto.hash, go-crypto.uuid, text-toolkit.slugify' });
    const change = 'add Slugify as a tool';
    const target = reviseCardFor(change);
    expect(target?.itemId).toBe(first.id);
    await reviseAgentCard(target!.itemId, target!.card, change);
    const revised = cardOf();
    expect(revised.id).toBe(first.id);
    expect(() => cardOf(1)).toThrow();
    // AG09: the card's name was the design's ("Crypto Toolkit agent"): it is made again from the new tools, and the Changes row says why.
    expect(first.card.name).toBe('Crypto Toolkit agent');
    expect(revised.card.name).toBe('Utility helper');
    expect(revised.card.changes).toEqual(['Adds the tool Slugify', 'Renames it to Utility helper (its tools changed)']);
    expect(revised.card.tools.some((t) => t.type === 'text-toolkit.slugify')).toBe(true);
    expect(revised.card.model).toBe(first.card.model);
    expect(revised.card.guardrails).toEqual(first.card.guardrails);
    expect(revised.card.notAdded ?? []).toEqual([]);
    expect(wire.calls.some((c) => c.path.startsWith('/api/ai/build'))).toBe(false);

    // A question under the card is answered by the chat, never applied: no design call, the card as it was.
    const callsBefore = architect.calls;
    const question = 'why does it need Hash?';
    expect(agentCardQuestion(question)).toBe(true);
    expect(reviseCardFor(question)).toBeUndefined();
    expect(architect.calls).toBe(callsBefore);
    expect(cardOf().card).toEqual(revised.card);

    // Create, then a change on the created card: a change card; Apply saves the draft (PUT) and smoke-tests it.
    await createFromCard(revised.id, revised.card);
    const agentId = cardOf().card.agentId!;
    expect(agentRow(agentId)?.smoke?.state).toBe('passed');
    agentStore.publish(agentId);
    const publishedBefore = json(agentStore.get(agentId)!.published);
    architect.design = propose({ name: 'Utility helper', instructions: `${UTILITY_STEPS}\nSlugify titles in upper case first.`, model: 'anthropic/claude-opus-5-5', nodeTools: 'go-crypto.jwtDecode, go-crypto.hash, go-crypto.uuid, text-toolkit.slugify, text-toolkit.changeCase' });
    const later = 'also slugify titles in upper case';
    const created = reviseCardFor(later);
    expect(created?.card.state).toBe('created');
    wire.calls.length = 0;
    await reviseAgentCard(created!.itemId, created!.card, later);
    const proposal = cardOf(1);
    expect(proposal.card.base?.agentId).toBe(agentId);
    expect(proposal.card.state).toBe('designed');
    expect(proposal.card.model).toBe('anthropic/claude-sonnet-5-5');
    expect(json(agentStore.get(agentId)!.published)).toBe(publishedBefore); // a proposal saved nothing

    await applyAgentChange(proposal.id, proposal.card);
    const applied = cardOf(1).card;
    expect(wire.calls.map((c) => `${c.method} ${c.path.replace(agentId, ':id')}`)).toEqual(['POST /api/agents/design', 'PUT /api/agents/:id', 'POST /api/agents/:id/smoke-test']);
    expect(applied.smoke?.state).toBe('passed');
    expect(json(agentStore.get(agentId)!.published)).toBe(publishedBefore); // Apply is the draft only

    // Publish only after the pass, through the eval gate (a low score holds it, in publishLine's words); never skipEval.
    agentSide.score = 2;
    await publishAgentChange(proposal.id, applied);
    const held = cardOf(1).card.publish;
    expect(held?.state).toBe('held');
    expect(publishLine(held)).toMatch(/^held by the eval gate: 2\.0 \/ 5/);
    expect(json(agentStore.get(agentId)!.published)).toBe(publishedBefore);
    expect(json(wire.calls)).not.toContain('skipEval');
  });

  it('a revise whose proposal leaves out the tool the change names still adds it (AG02’s promise), and says what it could not add', async () => {
    const without = propose({ name: 'Utility helper', instructions: UTILITY_STEPS, model: 'anthropic/claude-opus-5-5', nodeTools: 'go-crypto.jwtDecode, go-crypto.hash, go-crypto.uuid' });
    architect.design = without;
    const first = await designOnEmpty('wf_ag1_utility_omit', UTILITY_ASK);
    expect(first.card.tools.some((t) => t.type === 'text-toolkit.slugify')).toBe(false);
    const replyText = () => {
      const last = useAssistant.getState().items.at(-1)!;
      return last.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join(' ');
    };

    // The model's proposal for "add Slugify as a tool" leaves Slugify out (as a real model may): the change's named tool is added anyway.
    architect.design = without;
    await reviseAgentCard(first.id, first.card, 'add Slugify as a tool');
    const revised = cardOf();
    expect(revised.card.tools.some((t) => t.type === 'text-toolkit.slugify')).toBe(true);
    expect(revised.card.changes).toEqual(['Adds the tool Slugify']);
    expect(revised.card.notAdded ?? []).toEqual([]);
    expect(replyText()).toBe('Changed the card above: adds the tool Slugify.');

    // A tool no plugin online has: not added, said on the card and in the reply, never "already has what you asked".
    architect.design = propose({ name: 'Utility helper', instructions: UTILITY_STEPS, model: 'anthropic/claude-opus-5-5', nodeTools: 'go-crypto.jwtDecode, go-crypto.hash, go-crypto.uuid, text-toolkit.slugify' });
    await reviseAgentCard(revised.id, revised.card, 'also create Jira issues');
    const after = cardOf();
    expect(after.card.changes).toEqual([]);
    expect(after.card.notAdded).toEqual([{ name: 'Jira', reason: 'no plugin online has it' }]);
    expect(replyText()).toBe('No change to the card above. Not added: Jira (no plugin online has it).');
    expect(replyText()).not.toMatch(/already has what you asked/);
  });
});

// ---------------------------------------------------------------------------
// 4. The chat's typed message reaches the starter's agent
// ---------------------------------------------------------------------------

describe('4. the chat’s typed message reaches the starter’s agent (AG01 × SB16 × SB18)', () => {
  it('chat sends what was typed, Execute uses the pin, the smoke test used the sample, and Unpin is saved', async () => {
    architect.design = propose({ name: 'Refund helper', role: 'Refund answerer', instructions: 'Input: a question.\nSteps:\n1. Answer it.\nOutput: one answer.\nHand over when: it is not about refunds.', model: 'anthropic/claude-sonnet-5-5', nodeTools: '' });
    const { id, card } = await designOnEmpty('wf_ag1_chat', 'Create an agent that answers refund questions.');
    await createFromCard(id, card);
    const created = cardOf().card;
    const agentId = created.agentId!;
    const sample = starterSample(created);
    // SB18: the smoke test ran on the starter's pinned sample.
    expect(wire.calls.find((c) => c.path.endsWith('/smoke-test'))?.json).toEqual({ message: sample });
    agentStore.publish(agentId);

    const { nodes, pinData } = useEditor.getState();
    const trigger = nodes.find((n) => n.data.wf.type === 'core.chatTrigger')!;
    const step = nodes.find((n) => n.data.wf.type === 'core.messageAgent')!;
    expect(pinData[trigger.id]?.[0]?.json).toMatchObject({ chatInput: sample });
    const draft = { ...useEditor.getState().toWorkflow(), id: 'wf_ag1_chat' } as Workflow;
    store.saveWorkflow(draft);

    // The editor's chat: the typed message reaches Run an Agent and the agent's prompt, not the sample.
    agentSide.asked.length = 0;
    const typed = 'Is a refund possible after 45 days?';
    const events = await readSse(await runRoute.POST(new Request('http://localhost:3000/api/workflows/wf_ag1_chat/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: { message: typed, sessionId: 's1' } }) }), { params: Promise.resolve({ id: 'wf_ag1_chat' }) }));
    const result = events.find((e) => e.event === 'result')!.data as { status: string; executionId: string };
    expect(result.status).toBe('success');
    const execution = (await store.loadExecution(result.executionId))!;
    expect(json(execution.runData[step.id].at(-1)!.inputs)).toContain(typed);
    expect(agentSide.asked.some((m) => m.includes(typed))).toBe(true);
    expect(agentSide.asked.some((m) => m.includes(sample))).toBe(false);

    // Execute workflow (manual, no items): the pin.
    agentSide.asked.length = 0;
    const manual = await runWorkflow({ workflow: draft, mode: 'manual', startNodeId: trigger.id });
    expect(manual.status).toBe('success');
    expect(agentSide.asked.some((m) => m.includes(sample))).toBe(true);

    // Unpin: the draft sends pinData {} and the saved workflow keeps none.
    useEditor.getState().setPinData(trigger.id, undefined);
    const unpinned = useEditor.getState().toWorkflow();
    expect(unpinned.pinData).toEqual({});
    const saved = await call(workflowRoute.PUT, 'PUT', '/api/workflows/wf_ag1_chat', { ...unpinned, id: 'wf_ag1_chat' }, { id: 'wf_ag1_chat' });
    expect(saved.status).toBe(200);
    expect(Object.keys(store.getWorkflow('wf_ag1_chat')!.pinData ?? {})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Reads stay reads
// ---------------------------------------------------------------------------

const ANALYST_ASK = 'Create an agent that answers questions about our sales table in SQLite, with stats and the sentiment of customer comments. Its tools are the SQLite node from the Databases plugin and the Field Statistics and Sentiment nodes from Insights.';

describe('5. reads stay reads (AG02 × AG06)', () => {
  const preview = async (ask: string, name: string) => {
    const read = (await import('@/lib/shared/agent-ask')).agentAsk(ask, [], (await import('@/lib/shared/agent-ask')).askCatalog(types))!;
    const { status, body } = await call(designRoute.POST, 'POST', '/api/agents/design', { name, description: read.description, instructions: '', ask, ...(read.tools.length && { tools: read.tools }), preview: true });
    expect(status).toBe(200);
    return nodeTools(body.config).find((t) => t.nodeType === 'databases.sqlite')!;
  };

  it('the analyst’s SQLite is a Select with no approval and only the sqlite slot; an ask to insert gets Insert with approval', async () => {
    architect.design = propose({ name: 'Sales data analyst', instructions: 'Input: a question.\nSteps:\n1. Query the sales table.\nOutput: the answer.\nHand over when: it is not about sales.', model: 'anthropic/claude-sonnet-5-5', nodeTools: 'databases.sqlite, py-insights.stats, py-insights.sentiment' });
    const sqlite = await preview(ANALYST_ASK, 'Sales data analyst');
    expect(sqlite.parameters?.operation).toBe('select');
    expect(sqlite.requireApproval).toBeFalsy();
    expect(toolCredentialSlots(descriptorOf('databases.sqlite'), sqlite.parameters ?? {}).map((s) => s.name)).toEqual(['sqlite']);

    architect.design = propose({ name: 'Order writer', instructions: 'Input: orders.\nSteps:\n1. Insert each order.\nOutput: what was written.\nHand over when: it is not an order.', model: 'anthropic/claude-sonnet-5-5', nodeTools: 'databases.sqlite' });
    const writer = await preview('Create an agent that inserts each order into SQLite. Use the SQLite tool.', 'Order writer');
    expect(writer.parameters?.operation).toBe('insert');
    expect(writer.requireApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Contract copies
// ---------------------------------------------------------------------------

// The pipeline's contracts folder lives outside the repository: set LANDFLOW_BACKBONE_CONTRACTS to it to check the copies.
const CONTRACTS = process.env.LANDFLOW_BACKBONE_CONTRACTS ?? '';
describe.skipIf(!CONTRACTS || !existsSync(join(CONTRACTS, 'ag2')))('6. the ag1 contract copies are byte-identical', () => {
  it.each([
    // Wave ag2 replaced these two contracts (contracts/ag2, checked in agents-ag2-joins.test.ts).
    ['src/lib/shared/agent-card.ts', 'ag2/agent-card.ts'],
    ['test/spotlight-scenarios/scenario.ts', 'ag2/spotlight-scenario.ts'],
  ])('%s = contracts/%s', (copy, contract) => {
    expect(readFileSync(join(import.meta.dirname, '..', copy), 'utf8')).toBe(readFileSync(join(CONTRACTS, contract), 'utf8'));
  });
});
