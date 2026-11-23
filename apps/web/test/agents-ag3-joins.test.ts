/**
 * Wave ag3's join tests (carryover-ag3.md §2): each contract between two packages of the wave, with both real sides and
 * no fake between them. Only the edges are stubbed: the Agent architect's model (a fake Anthropic Messages API on loopback,
 * reached through the host's own `anthropic/…` builder model with a made-up key), the agent's own model and the eval gate's
 * judge (scripted, metered like a provider adapter), the browser's HTTP client (straight to the real route handlers), a fake
 * SMTP server and a fake Alertmanager. The triage, Grafana and Messaging plugins are their own code, in process. The files
 * directory is a temp folder holding a copy of the runbooks fixture; there is no embeddings server (keyword search).
 *
 * 1. Knowledge agent end to end (AG13 × AG14 × AG12).
 * 2. Triage email proof (AG14 × AG15 × AG10).
 * 3. The canvas follows the agent (AG12 × AG09).
 * 4. The canvas and the Run Trace agree (AG12).
 * 5. No secret anywhere (AG14 × AG12).
 * 6. The scenario files run (AG13 × AG15).
 * 7. The contract copies are byte-identical to backbone/contracts/ag3 (LANDFLOW_BACKBONE_CONTRACTS names the folder).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { knowledgeLine, type AgentCard } from '@/lib/shared/agent-card';
import type { AgentConfig } from '@/lib/shared/agents';
import type { ActorConnection } from '@/lib/shared/run-trace';
import { passagesOf, targetLine, type ToolTarget } from '@/lib/shared/tool-target';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { readSse, startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeSmtp } from '../../../plugins/messaging/test/fake-smtp';

vi.setConfig({ testTimeout: 60_000 });

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

// The agent's own model (smoke tests, runs, eval cases) and the eval gate's judge: scripted, each turn metered through the
// host's own `traceChat` (as a provider adapter is), so `ai_usage` gets its rows. `calls` are made on a user turn (each
// matched to an offered tool name by a pattern); what the tools answered is kept. The judge scores by the expected text.
const agentSide = vi.hoisted(() => ({
  calls: [] as Array<{ match: string; input: Record<string, unknown> }>,
  reply: 'Done.',
  judge: (_asked: string): number => 5,
  judged: [] as string[],
  asked: [] as string[],
  results: [] as Array<{ name: string; content: string }>,
  turns: 0,
}));
vi.mock('@/lib/server/agents/models', async () => {
  const { traceChat } = await import('@/lib/server/telemetry/ai');
  return {
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
      const usage = { inputTokens: 3, outputTokens: 2 };
      const turn = (input: Parameters<LanguageModel['generate']>[0]): ModelTurn => {
        if ((input.system ?? '').includes('"score"')) {
          const first = input.messages[0] as AgentMessage | undefined;
          const asked = first && 'content' in first && typeof first.content === 'string' ? first.content : JSON.stringify(first ?? '');
          agentSide.judged.push(asked);
          return { text: JSON.stringify({ score: agentSide.judge(asked), reasoning: 'scripted judge' }), toolCalls: [], stopReason: 'end_turn', usage };
        }
        agentSide.turns += 1;
        const last = input.messages.at(-1) as AgentMessage | undefined;
        if (last?.role === 'tool') for (const r of last.results) agentSide.results.push({ name: r.name, content: r.content });
        if (last?.role === 'user') {
          agentSide.asked.push(last.content);
          const offered = input.tools.map((t) => t.name);
          if (agentSide.calls.length) {
            const toolCalls = agentSide.calls.map((c, i) => ({ id: `c${agentSide.turns}_${i}`, name: offered.find((n) => new RegExp(c.match, 'i').test(n)) ?? c.match, input: c.input }));
            return { text: '', toolCalls, stopReason: 'tool_use', usage };
          }
        }
        return { text: agentSide.reply, toolCalls: [], stopReason: 'end_turn', usage };
      };
      return {
        provider: 'anthropic',
        model: config.model,
        generate: (input) => traceChat({ system: 'anthropic', model: config.model! }, async () => turn(input), (t) => ({ responseModel: config.model!, inputTokens: t.usage?.inputTokens ?? 0, outputTokens: t.usage?.outputTokens ?? 0, finishReasons: [] })),
      };
    },
  };
});

// The browser's client: every path goes to its real route handler; the calls are kept in order.
const wire = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; json?: unknown }>, impl: undefined as undefined | ((path: string, init: { method?: string; json?: unknown }) => Promise<unknown>) }));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn((path: string, init: { method?: string; json?: unknown } = {}) => wire.impl!(path, init)),
  streamEvents: vi.fn(),
}));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

// A local Alertmanager: one "High CPU on web-01" alert; `POST /api/v2/silences` records the body and the Authorization header.
const alertmanager = { silences: [] as Array<Record<string, any>>, auth: [] as string[], requests: [] as string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
const HIGH_CPU = { labels: { alertname: 'High CPU on web-01', instance: 'web-01', severity: 'critical' }, annotations: { summary: 'CPU above 90% for 5 minutes' }, status: { state: 'active' }, startsAt: '2026-11-17T09:00:00Z', fingerprint: 'ab12' };
const amServer = createServer((request, response) => {
  alertmanager.requests.push(`${request.method} ${request.url}`);
  alertmanager.auth.push(String(request.headers.authorization ?? ''));
  const path = (request.url ?? '').split('?')[0];
  if (request.method === 'GET' && path === '/api/v2/alerts') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([HIGH_CPU]));
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
const amPort = (amServer.address() as AddressInfo).port;

// The made-up secrets of this file: none may show in any timeline, journal, stream, connections answer or credential list.
const SMTP_PASSWORD = 'pw-ag3-joins-smtp-made-up';
const GRAFANA_TOKEN = 'glsa_ag3_joins_made_up_token';
const SECRETS = [SMTP_PASSWORD, GRAFANA_TOKEN, 'admin:pw', 'glsa_'];
const smtp = await startFakeSmtp({ auth: { user: 'mail', password: SMTP_PASSWORD }, authMethods: ['PLAIN'] });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ag3-joins-'));
const filesDir = join(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });
cpSync(join(import.meta.dirname, 'spotlight-scenarios', 'fixtures', 'runbooks'), join(filesDir, 'runbooks'), { recursive: true });

const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_FILES_DIR: filesDir,
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
const { nodeConnections } = await import('@/lib/server/agents/connections');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { journalStore } = await import('@/lib/server/journal');
const { SqliteVectorStore } = await import('@/lib/server/rag/stores');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const designRoute = await import('@/app/api/agents/design/route');
const importRoute = await import('@/app/api/agents/import/route');
const agentRoute = await import('@/app/api/agents/[id]/route');
const evalGateRoute = await import('@/app/api/agents/[id]/eval-gate/route');
const smokeRoute = await import('@/app/api/agents/[id]/smoke-test/route');
const publishRoute = await import('@/app/api/agents/[id]/publish/route');
const folderRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/folder/route');
const connectionsRoute = await import('@/app/api/agents/[id]/connections/route');
const previewRoute = await import('@/app/api/expressions/preview/route');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const approvalsRoute = await import('@/app/api/executions/[id]/approvals/route');
const eventsRoute = await import('@/app/api/executions/[id]/events/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const { plugin: triage } = await import('../../../plugins/triage/src/main');
const { plugin: grafana } = await import('../../../plugins/grafana/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { cardAskFor, createFromCard, designAgentCard, reviseCardFor, reviseAgentCard, applyAgentChange } = await import('@/components/editor/spotlight/agent-ask');
const { publishAgentFor, smokeTestAgent } = await import('@/components/editor/new-agent');
const { AGENT_SAVED, announceSaved } = await import('@/lib/client/agent-change');

type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = async (route: unknown, method: string, path: string, body?: unknown, params?: Record<string, string>) => {
  const response = await (route as Handler)(new Request(`http://localhost:3000${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, text, body: (text ? JSON.parse(text) : undefined) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

wire.impl = async (path, init) => {
  const method = init.method ?? 'GET';
  if (!/\/versions$/.test(path)) wire.calls.push({ method, path, json: init.json });
  if (/^\/api\/workflows\/[^/]+\/versions$/.test(path)) return { versions: [] };
  const id = /^\/api\/agents\/([^/]+)(?:\/[a-z-]+)?$/.exec(path)?.[1];
  const folder = /^\/api\/agents\/([^/]+)\/knowledge\/([^/]+)\/folder$/.exec(path);
  let result: { status: number; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (path === '/api/agents/design') result = await call(method === 'DELETE' ? designRoute.DELETE : designRoute.POST, method, path, init.json);
  else if (path === '/api/agents/import') result = await call(importRoute.POST, 'POST', path, init.json);
  else if (path === '/api/expressions/preview') result = await call(previewRoute.POST, 'POST', path, init.json);
  else if (folder) result = await call(folderRoute.POST, 'POST', path, init.json, { id: folder[1], toolId: folder[2] });
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
  for (const plugin of [triage, grafana, messaging]) registry.registerBuiltin(plugin);
  types = registry.nodeTypes().filter((t) => t.available);
});
afterAll(async () => {
  vi.unstubAllGlobals();
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
  Object.assign(agentSide, { calls: [], reply: 'Done.', judge: () => 5, turns: 0 });
  agentSide.judged.length = 0;
  agentSide.asked.length = 0;
  agentSide.results.length = 0;
  alertmanager.silences.length = 0;
  alertmanager.auth.length = 0;
  alertmanager.requests.length = 0;
  smtp.mails.length = 0;
  wire.calls.length = 0;
  enableTestAuth(TEST_OWNER);
  useAssistant.getState().reset();
  useAutonomous.setState({ on: false });
});

// ---------------------------------------------------------------------------
// Helpers: the editor's Spotlight on an empty canvas, the chat run, the routes
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
const stepOf = (agentId: string) => useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent' && n.data.wf.parameters.agentId === agentId)!;
type NodeTool = { name: string; nodeType: string; parameters?: Record<string, unknown>; requireApproval?: boolean };
const nodeTools = (config: Partial<AgentConfig> | Record<string, unknown>) => ((config as Partial<AgentConfig>).tools ?? []).filter((t) => t.type === 'node') as NodeTool[];

/** The person's change on the agent's draft (a credential is the person's pick, a From address the person's entry). */
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

type SseEvent = { event: string; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
/** The editor's chat: the run route with a typed message (mode chat); the SSE's events and its result. */
async function chatRun(workflowId: string, message: string) {
  const events = (await readSse(await runRoute.POST(new Request(`http://localhost:3000/api/workflows/${workflowId}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: { message, sessionId: `s_${workflowId}` } }) }), { params: Promise.resolve({ id: workflowId }) }))) as SseEvent[];
  const result = events.find((e) => e.event === 'result');
  expect(result, json(events.map((e) => e.event))).toBeDefined();
  return { events, ...(result!.data as { status: string; executionId: string }) };
}
/** The stream's tool chunks (the Run an Agent node's `streamer`, as the editor's chat reads them). */
const toolChunks = (events: SseEvent[]) =>
  events.flatMap((e) => (e.event === 'execution' && e.data?.type === 'node.chunk' && e.data.chunk?.type === 'tool' ? [e.data.chunk.tool as { name: string; status: string; output?: string; target?: ToolTarget }] : []));

/** The chat's approval card: the waiting calls (GET), then the person's decision (POST, SSE) on the one call. */
async function decide(executionId: string, approved: boolean) {
  const waiting = await call(approvalsRoute.GET, 'GET', `/api/executions/${executionId}/approvals`, undefined, { id: executionId });
  expect(waiting.status).toBe(200);
  const calls = waiting.body.approval.calls as Array<{ id: string; tool: string; input: Record<string, unknown> }>;
  expect(calls).toHaveLength(1);
  const response = await approvalsRoute.POST(new Request(`http://localhost:3000/api/executions/${executionId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: calls[0].id, approved }) }), { params: Promise.resolve({ id: executionId }) });
  const events = (await readSse(response)) as SseEvent[];
  return { call: calls[0], events, result: events.find((e) => e.event === 'result')?.data as { status: string } | undefined };
}

/** The editor's starter flow as the editor would save it. */
function saveDraft(workflowId: string): Workflow {
  const draft = { ...useEditor.getState().toWorkflow(), id: workflowId } as Workflow;
  store.saveWorkflow(draft);
  return draft;
}

/** The canvas's band: `GET /api/agents/:id/connections` (with the node's workflow and id when given). */
async function connectionsOf(agentId: string, at?: { workflowId: string; nodeId: string }) {
  const query = at ? `?workflowId=${at.workflowId}&nodeId=${at.nodeId}` : '';
  const response = await connectionsRoute.GET(new Request(`http://localhost:3000/api/agents/${agentId}/connections${query}`), { params: Promise.resolve({ id: agentId }) });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  seen.connections.push(text);
  return JSON.parse(text) as { agent: { id: string; name: string; published: boolean; draftDiffers: boolean }; connections: ActorConnection[] };
}

/** The journal's tool spans of an execution, read as the Run Trace reads them (`GET /api/executions/:id/events`). */
async function journalOf(executionId: string) {
  const read = await call(eventsRoute.GET, 'GET', `/api/executions/${executionId}/events?limit=2000`, undefined, { id: executionId });
  expect(read.status).toBe(200);
  seen.journals.push(read.text);
  return read.body.events as Array<{ type: string; spanId?: string; attrs?: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** The tool spans as the Run Trace reduces them: the started span's attrs with what its updates and its end add (run-trace-model.ts). */
const toolSpans = (events: Array<{ type: string; spanId?: string; attrs?: Record<string, any> }>) => // eslint-disable-line @typescript-eslint/no-explicit-any
  events
    .filter((e) => e.type === 'span.started' && e.attrs?.tool)
    .map((started) => ({ ...started, attrs: Object.assign({}, started.attrs, ...events.filter((e) => (e.type === 'span.updated' || e.type === 'span.ended') && e.spanId === started.spanId).map((e) => e.attrs ?? {})) }));

/** Every session timeline of an agent. */
const timelinesOf = (agentId: string) => agentStore.listSessions(agentId, 100).map((s) => agentStore.getSession(s.id)!.timeline);

/** What joins 1–3 hand on (in file order): the agents, workflows and executions they made, and every answer they read. */
const seen = { connections: [] as string[], journals: [] as string[], streams: [] as string[], agents: [] as string[], triage: undefined as undefined | { agentId: string; workflowId: string; nodeId: string } };

// ---------------------------------------------------------------------------
// The asks (contracts/ag3/asks.md)
// ---------------------------------------------------------------------------

// E: the knowledge agent over the runbooks, and its first real task (known answer: 730 MB, from runbooks/disk-full.md).
const ASK_E = 'Create an agent that answers questions from our incident runbooks in the folder runbooks and says which runbook each answer comes from.';
const QUESTION_1 = 'How much journal do we keep when a web node’s disk is full?';
const RUNBOOK_DESIGN = propose({
  name: 'Runbook answerer',
  role: 'Runbook reader',
  instructions: 'Input: a question about an incident.\nSteps:\n1. Search the runbooks for the question.\n2. Answer from the passages and name the runbook file.\nOutput: the answer and its source.\nHand over when: the runbooks do not cover it.',
  model: 'anthropic/claude-sonnet-5-5',
  nodeTools: '',
  knowledge: 'runbooks',
  knowledgeDescription: 'The incident runbooks (RB-101 … RB-104)',
});
const RUNBOOK_CASES = [
  'How much journal do we keep when a web node’s disk is full? => 730 MB, from runbooks/disk-full.md',
  'How many days before expiry do we renew a TLS certificate? => 19 days, from runbooks/certificate-expiry.md',
  'How long may I silence the High CPU alert? => 45 minutes, from runbooks/high-cpu.md',
].join('\n');

// A: alert triage → email (the ask of ag1's live pass, word for word), its real task, and the Wazuh alert.
const TRIAGE_ASK = 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.';
const WAZUH = 'Wazuh alert rule 5712 level 10: sshd brute force from 203.0.113.45 against web-01 (user root, 23 failures in 60s); related domain bad-login.example.net';
const TRIAGE_DESIGN = propose({
  name: 'Alert triage agent',
  role: 'Alert triager',
  description: 'Triages alerts and emails on-call.',
  instructions: 'Input: an alert.\nSteps:\n1. Call normalize_alert on the alert.\n2. Call extract_iocs on it.\n3. Judge how serious it is.\n4. Call send_email with the summary.\nOutput: a short summary.\nHand over when: it is not an alert.',
  model: 'anthropic/claude-opus-5-5',
  nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend',
});
// Cases as the ag2 live pass saw them: two claim the email was sent (AG15 rewrites those into the ask), one names the IOCs.
const TRIAGE_CASES = [
  'Wazuh alert rule 5712 level 10: sshd brute force from 198.51.100.7 against db-02 (user admin, 40 failures in 60s) => Emails a short summary to oncall@landflow.test naming 198.51.100.7',
  '[FIRING:1] High CPU on web-01 (critical): CPU above 90% for 5 minutes since 09:00 => Names web-01 and says it is medium severity',
  'Suricata ET POLICY curl User-Agent outbound from 10.0.4.12 to evil.example.net:443 => Email sent to oncall@landflow.test naming evil.example.net',
].join('\n');
/** The judge reads the case's expected text: one that claims the email went out fails (the gate denies every write), the ask passes. */
const judgeByExpected = (asked: string) => (/EXPECTED:\s*(?:Emails a short summary|Email sent to)\b/.test(asked) ? 1 : 5);

// ---------------------------------------------------------------------------
// 1. Knowledge agent end to end
// ---------------------------------------------------------------------------

describe('1. knowledge agent end to end (AG13 × AG14 × AG12)', () => {
  it('the card names runbooks/ with its 4 files and keyword search; Create indexes them; the band counts 4; the chat run proves the search', async () => {
    architect.design = RUNBOOK_DESIGN;
    architect.cases = RUNBOOK_CASES;
    const workflowId = 'wf_ag3_knowledge';
    const { id, card } = await designOnEmpty(workflowId, ASK_E);

    // AG13: the preview's knowledge names the folder, its four files and keyword search (no embeddings model on this host).
    expect(card.knowledgeSetup, json(card)).toMatchObject({ folder: 'runbooks', fileCount: 4, search: 'keyword', embeddings: 'keyword search (BM25, built in)' });
    expect(card.knowledgeSetup?.files).toEqual(['runbooks/certificate-expiry.md', 'runbooks/disk-full.md', 'runbooks/high-cpu.md', 'runbooks/ssh-brute-force.md']);
    expect(knowledgeLine(card.knowledgeSetup)).toBe('runbooks/ · 4 files · keyword search (BM25, built in)');
    const collection = card.knowledgeSetup!.collection;

    // Create (the client's createFromCard): the folder route indexed the four files, each chunk naming its file under runbooks/.
    agentSide.reply = 'From runbooks/disk-full.md: keep 730 MB of journal.';
    // ag3 carryover: the indexing announces the save, so the canvas band re-reads the documents (live, it read "0 docs").
    const tab = new EventTarget();
    const saved: string[] = [];
    tab.addEventListener(AGENT_SAVED, (e) => saved.push((e as CustomEvent<{ agentId: string }>).detail.agentId));
    vi.stubGlobal('window', tab);
    try {
      await createFromCard(id, card);
    } finally {
      vi.unstubAllGlobals();
    }
    const created = cardOf().card;
    expect(saved, 'the indexing announced the agent').toContain(created.agentId);
    expect(created.state, json(created)).toBe('created');
    const agentId = created.agentId!;
    seen.agents.push(agentId);
    expect(wire.calls.some((c) => c.method === 'POST' && /\/knowledge\/[^/]+\/folder$/.test(c.path))).toBe(true);
    expect(created.knowledgeSetup).toMatchObject({ state: 'indexed', indexed: { documents: 4, failed: [] } });
    expect(knowledgeLine(created.knowledgeSetup)).toMatch(/^runbooks\/ · 4 files · keyword search \(BM25, built in\) · indexed 4 files, \d+ passages$/);
    const rows = await new SqliteVectorStore().metadataOf(collection);
    expect(rows.length).toBe(created.knowledgeSetup!.indexed!.chunks);
    expect(rows.every((r) => String(r.metadata.source).startsWith('runbooks/')), json(rows.map((r) => r.metadata.source))).toBe(true);

    // AG12: the starter flow's Run an Agent node; its band lists the knowledge base with 4 documents and keyword search.
    const step = stepOf(agentId);
    expect(step).toBeDefined();
    saveDraft(workflowId);
    const band = await connectionsOf(agentId, { workflowId, nodeId: step.id });
    expect(band.agent).toMatchObject({ id: agentId, published: false });
    const kb = band.connections.find((c) => c.kind === 'knowledge');
    expect(kb, json(band.connections)).toMatchObject({ name: collection, documents: 4 });
    expect(kb!.detail).toContain('keyword search (BM25, built in)');

    // Publish (a scripted judge passing), then the editor's chat run with question 1.
    expect((await smokeTestAgent(step.id))?.state).toBe('passed');
    expect(await publishAgentFor(step.id)).toBe(true);
    expect(agentStore.get(agentId)?.published).toBeDefined();
    saveDraft(workflowId);
    agentSide.results.length = 0;
    agentSide.calls = [{ match: 'runbook|search|knowledge', input: { query: 'how much journal do we keep when the disk is full' } }];
    agentSide.reply = 'Keep 730 MB of journal (journalctl --vacuum-size=730M). Source: runbooks/disk-full.md (RB-101).';
    const run = await chatRun(workflowId, QUESTION_1);
    seen.streams.push(json(run.events));
    expect(run.status, json(run.events.at(-1))).toBe('success');
    expect(agentSide.asked.some((m) => m.includes('How much journal'))).toBe(true);

    // AG14: the tool chunk and the journal span carry target.knowledge (collection, SQLite, keyword search, 4 documents).
    const knowledge = { collection, store: 'SQLite', embeddings: 'keyword search (BM25, built in)', documents: 4 };
    const chunk = toolChunks(run.events).find((c) => c.status === 'finished');
    expect(chunk, json(toolChunks(run.events))).toBeDefined();
    expect(chunk!.target).toMatchObject({ knowledge });
    expect(targetLine(chunk!.target)).toBe(`${collection} · SQLite store · keyword search (BM25, built in) · 4 documents`);
    const spans = toolSpans(await journalOf(run.executionId));
    expect(spans.some((s) => s.attrs?.target?.knowledge && json(s.attrs.target.knowledge) === json(knowledge)), json(spans)).toBe(true);
    // The passages the person reads: runbooks/disk-full.md first, with the fact; the model was given the same.
    const passages = passagesOf(JSON.parse(chunk!.output!));
    expect(passages[0]?.source, json(passages)).toBe('runbooks/disk-full.md');
    expect(passages[0]?.text).toMatch(/730/);
    expect(agentSide.results[0]?.content).toContain('runbooks/disk-full.md');
    // The reply names it.
    expect(json(run.events)).toContain('Source: runbooks/disk-full.md');
  });
});

// ---------------------------------------------------------------------------
// 2. Triage email proof
// ---------------------------------------------------------------------------

describe('2. triage email proof (AG14 × AG15 × AG10)', () => {
  it('the cases expect the ask, the gate passes honestly, Approve sends one email, and every record names Mailpit SMTP; tests are agent-test spend', async () => {
    architect.design = TRIAGE_DESIGN;
    architect.cases = TRIAGE_CASES;
    const workflowId = 'wf_ag3_triage';
    const { id, card } = await designOnEmpty(workflowId, TRIAGE_ASK);
    const mailTool = nodeTools(card.config).find((t) => t.nodeType === 'messaging.emailSend')!;
    expect(mailTool.requireApproval).toBe(true);
    expect(mailTool.parameters?.toEmail).toBe('oncall@landflow.test');

    // AG15: a case about the send expects the ask, with the address kept; the IOC case and every input stay as written.
    const proposed = TRIAGE_CASES.split('\n').map((l) => l.split(' => '));
    expect(card.cases.map((c) => c.input)).toEqual(proposed.map(([input]) => input));
    const [first, second, third] = card.cases;
    expect(first.expected).toMatch(/asks for approval before sending it$/);
    expect(first.expected).toContain('oncall@landflow.test');
    expect(first.expected).toContain('198.51.100.7');
    expect(second.expected).toBe(proposed[1][1]);
    expect(third.expected).toMatch(/asks for approval first|asks for approval before sending it/);
    expect(third.expected).toContain('oncall@landflow.test');

    agentSide.reply = 'High severity. I will send the summary to oncall@landflow.test once you approve.';
    await createFromCard(id, card);
    const agentId = cardOf().card.agentId!;
    seen.agents.push(agentId);
    const step = stepOf(agentId);
    expect(step.data.wf.parameters).toMatchObject({ agentId, toolApprovals: 'askInChat' });

    // The person's credential "Mailpit SMTP" on the fake SMTP (a made-up password) and the From address.
    const mail = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: smtp.port, secure: false, disableStartTls: true, user: 'mail', password: SMTP_PASSWORD } });
    await personSets(agentId, 'messaging.emailSend', { slot: 'smtp', credential: { id: mail.id, name: mail.name }, parameters: { fromEmail: 'landflow@landflow.test' } });
    expect((await smokeTestAgent(step.id))?.state).toBe('passed');
    expect(smtp.mails).toHaveLength(0); // the smoke test's write was denied, never sent

    // The gate (approvals denied) with a judge that scores by the expected text: the rewritten cases pass it honestly.
    agentSide.judge = judgeByExpected;
    expect(await publishAgentFor(step.id)).toBe(true);
    expect(agentStore.get(agentId)?.published).toBeDefined();
    expect(agentSide.judged.length).toBeGreaterThanOrEqual(3);
    expect(agentSide.judged.some((j) => /asks for approval/.test(j))).toBe(true);
    expect(agentSide.judged.some((j) => judgeByExpected(j) === 1), json(agentSide.judged)).toBe(false);
    expect(smtp.mails).toHaveLength(0);

    // AG15: the smoke test's and the gate's calls (the judge's too) are agent-test spend, with the agent's id.
    const tests = database().all<{ surface: string | null; purpose: string | null }>('SELECT surface, purpose FROM ai_usage WHERE agent_id = ?', agentId);
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.every((r) => r.surface === 'agent-test'), json(tests)).toBe(true);
    expect(tests.some((r) => r.purpose === 'judge')).toBe(true);

    // The editor's chat run with the Wazuh alert: the waiting call, Approve, one message To oncall@landflow.test.
    const flow = saveDraft(workflowId);
    agentSide.calls = [{ match: 'email', input: { subject: 'Brute force on web-01', text: 'sshd brute force from 203.0.113.45 against web-01.' } }];
    agentSide.reply = 'Sent the summary to on-call.';
    const waiting = await chatRun(workflowId, WAZUH);
    seen.streams.push(json(waiting.events));
    expect(waiting.status).toBe('waiting');
    const decided = await decide(waiting.executionId, true);
    seen.streams.push(json(decided.events));
    expect(decided.result?.status).toBe('success');
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0].to).toEqual(['oncall@landflow.test']);
    expect(smtp.mails[0].authMethod).toBe('PLAIN');

    // AG14: the settled tool chunk, the timeline entry and the journal span name what the call reached.
    const target = { name: 'Mailpit SMTP', system: 'SMTP', endpoint: `127.0.0.1:${smtp.port}`, credentialId: mail.id };
    const settled = toolChunks([...waiting.events, ...decided.events]).filter((c) => c.status === 'finished');
    expect(settled.some((c) => json(c.target) === json(target)), json(toolChunks([...waiting.events, ...decided.events]))).toBe(true);
    expect(targetLine(target)).toBe(`Mailpit SMTP · SMTP 127.0.0.1:${smtp.port}`);
    const entries = timelinesOf(agentId).flat().filter((e) => e.type === 'tool' && e.status === 'success' && /email/i.test(e.tool));
    expect(entries.some((e) => e.type === 'tool' && json(e.target) === json(target)), json(entries)).toBe(true);
    const spans = toolSpans(await journalOf(waiting.executionId));
    expect(spans.some((s) => /email/i.test(String(s.attrs?.tool)) && json(s.attrs?.target) === json(target)), json(spans)).toBe(true);

    seen.triage = { agentId, workflowId, nodeId: flow.nodes.find((n) => n.type === 'core.messageAgent')!.id };
  });
});

// ---------------------------------------------------------------------------
// 3. The canvas follows the agent
// ---------------------------------------------------------------------------

const GRAFANA_ASK = 'Create an agent that lists the firing alerts in Grafana and explains what each one means. Use the Get Alerts and Get Alert Details tools.';
const GRAFANA_STEPS = 'Input: a question about alerts.\nSteps:\n1. Call get_alerts to list the firing alerts.\n2. Call get_alert_details for each alert by its name.\n3. Explain what each one means.\nOutput: each alert explained.\nHand over when: it is not about alerts.';

describe('3. the canvas follows the agent (AG12 × AG09)', () => {
  it('draft-only, then published, then a Spotlight change on the draft: the band shows the published tools and the draft that differs', async () => {
    architect.design = propose({ name: 'Grafana observer', role: 'Alert reader', instructions: GRAFANA_STEPS, model: 'anthropic/claude-sonnet-5-5', nodeTools: 'grafana.getAlerts, grafana.getAlertDetails' });
    architect.cases = 'What is firing? => Names High CPU on web-01\nIs web-01 healthy? => Says High CPU on web-01 is firing\nAny critical alert? => Names High CPU on web-01';
    const { id, card } = await designOnEmpty('wf_ag3_canvas', GRAFANA_ASK);
    agentSide.reply = 'One alert is firing: High CPU on web-01.';
    await createFromCard(id, card);
    const agentId = cardOf().card.agentId!;
    seen.agents.push(agentId);
    const step = stepOf(agentId);

    expect((await connectionsOf(agentId)).agent).toMatchObject({ published: false, draftDiffers: false });
    expect(await publishAgentFor(step.id)).toBe(true);
    const published = await connectionsOf(agentId);
    expect(published.agent).toMatchObject({ published: true, draftDiffers: false });
    const publishedTools = published.connections.filter((c) => c.kind === 'tool').map((c) => c.name);
    expect(publishedTools.map((n) => n.toLowerCase().replace(/\s+/g, '_')), json(publishedTools)).toEqual(['get_alerts', 'get_alert_details']);

    // Spotlight's change under the created card, applied to the draft (PUT + smoke test): the band keeps the published tools.
    architect.design = propose({ name: 'Grafana observer', role: 'Alert reader', instructions: GRAFANA_STEPS, model: 'anthropic/claude-sonnet-5-5', nodeTools: 'grafana.getAlerts, grafana.getAlertDetails, grafana.acknowledgeAlert' });
    const add = 'also let it acknowledge an alert';
    const target = reviseCardFor(add)!;
    await reviseAgentCard(target.itemId, target.card, add);
    const change = cards().at(-1)!;
    expect(change.card.changes).toContain('Adds the tool Acknowledge Alert (asks first)');
    await applyAgentChange(change.id, change.card);
    expect(nodeTools(agentStore.get(agentId)!).some((t) => t.nodeType === 'grafana.acknowledgeAlert')).toBe(true);
    const changed = await connectionsOf(agentId);
    expect(changed.agent).toMatchObject({ published: true, draftDiffers: true });
    expect(changed.connections.filter((c) => c.kind === 'tool').map((c) => c.name)).toEqual(publishedTools);
    expect(changed.connections.some((c) => /acknowledge/i.test(c.name))).toBe(false);

    // Another tab: its post on BroadcastChannel('landflow-agents') becomes this tab's AGENT_SAVED once; this tab never echoes it.
    const tab = new EventTarget();
    vi.stubGlobal('window', tab);
    const heard: string[] = [];
    tab.addEventListener(AGENT_SAVED, (e) => heard.push((e as CustomEvent<{ agentId: string }>).detail.agentId));
    const other = new BroadcastChannel('landflow-agents');
    const posts: unknown[] = [];
    other.onmessage = (m) => posts.push(m.data);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    try {
      announceSaved(agentId); // this tab's save: its own listener hears it, and the other tab gets one post
      await settle();
      expect(heard).toEqual([agentId]);
      expect(posts).toEqual([{ type: AGENT_SAVED, agentId }]);
      other.postMessage({ type: AGENT_SAVED, agentId }); // the other tab's save
      await settle();
      expect(heard).toEqual([agentId, agentId]);
      expect(posts).toHaveLength(1); // no echo: the channel received one post
    } finally {
      other.close();
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The canvas and the Run Trace agree
// ---------------------------------------------------------------------------

describe('4. the canvas and the Run Trace agree (AG12)', () => {
  it('with a wired Ollama Chat Model, the route and nodeConnections name the same tools with the same asks-first and credentials', async () => {
    expect(seen.triage, 'join 2 ran first').toBeDefined();
    const { agentId, workflowId, nodeId } = seen.triage!;
    const flow = store.getWorkflow(workflowId)!;
    const wired = {
      ...flow,
      nodes: [...flow.nodes, { id: 'ollama_model', name: 'Local llama', type: 'core.ollamaChatModel', typeVersion: 1, position: [0, 200], parameters: { model: 'llama3.2' } }],
      connections: [...(flow.connections ?? []), { id: 'c_model', type: 'ai_languageModel', source: 'ollama_model', sourceIndex: 0, target: nodeId, targetIndex: 0 }],
    } as Workflow;
    store.saveWorkflow(wired);
    const node = wired.nodes.find((n) => n.id === nodeId)!;

    const band = (await connectionsOf(agentId, { workflowId, nodeId })).connections;
    const trace = nodeConnections(node, { model: true, memory: false })!;
    const shape = (list: ActorConnection[]) =>
      list
        .filter((c) => c.kind === 'tool' || c.kind === 'knowledge')
        .map((c) => ({ kind: c.kind, name: c.name, asksFirst: Boolean(c.asksFirst), credential: c.credential ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(shape(band).length).toBeGreaterThanOrEqual(3);
    expect(shape(band)).toEqual(shape(trace));
    expect(shape(band).find((c) => /send.?email/i.test(c.name)), json(shape(band))).toMatchObject({ asksFirst: true, credential: 'Mailpit SMTP' });
    // The route keeps the agent's own model, replaced by the wired one; the Run Trace drops it, as before.
    const own = (agentStore.get(agentId)!.published!.config.model as { model: string }).model;
    expect(band.find((c) => c.kind === 'model')).toMatchObject({ name: own, overriddenBy: 'Local llama' });
    expect(trace.some((c) => c.kind === 'model')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. No secret anywhere
// ---------------------------------------------------------------------------

describe('5. no secret anywhere (AG14 × AG12)', () => {
  it('after joins 1–2 and Grafana acknowledges (made-up token; admin:pw@ in one URL), nothing a person reads holds a secret', async () => {
    const { starterFlow } = await import('@/lib/shared/agent-card');
    /** A published Grafana acknowledger on `credential`, its starter flow, a chat run and the person's Approve. */
    const acknowledge = async (key: string, credential: { id: string; name: string }) => {
      const observer = agentStore.create({
        name: `Grafana acknowledger ${key}`,
        instructions: 'Input: an alert to acknowledge.\nSteps:\n1. Call acknowledge_alert by its name; it asks the person first.\nOutput: the silence.',
        model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        tools: [{ id: 't_ack', type: 'node', name: 'Acknowledge Alert', description: 'Silence an alert', nodeType: 'grafana.acknowledgeAlert', parameters: {}, credentials: { grafana_alertmanager_api_token: { id: credential.id, name: credential.name } }, requireApproval: true }],
      } as never);
      agentStore.publish(observer.id);
      seen.agents.push(observer.id);
      const flow = starterFlow({ id: observer.id, name: observer.name }, 'acknowledge High CPU on web-01');
      const ids = Object.fromEntries(flow.nodes.map((n) => [n.key, n.name]));
      const workflow = {
        id: `wf_ag3_grafana_ack_${key}`,
        name: flow.name,
        nodes: flow.nodes.map((n) => ({ id: n.name, name: n.name, type: n.type, typeVersion: 1, position: [n.x, n.y], parameters: n.parameters })),
        connections: flow.edges.map(([from, to], i) => ({ id: `e${i}`, type: 'main', source: ids[from], target: ids[to], sourceIndex: 0, targetIndex: 0 })),
      } as Workflow;
      store.saveWorkflow(workflow);
      agentSide.calls = [{ match: 'acknowledge', input: { alertId: 'High CPU on web-01' } }];
      agentSide.reply = 'Acknowledged High CPU on web-01.';
      const waiting = await chatRun(workflow.id, 'acknowledge High CPU on web-01');
      seen.streams.push(json(waiting.events));
      expect(waiting.status).toBe('waiting');
      const decided = await decide(waiting.executionId, true);
      seen.streams.push(json(decided.events));
      expect(decided.result?.status).toBe('success');
      await journalOf(waiting.executionId);
      await connectionsOf(observer.id, { workflowId: workflow.id, nodeId: workflow.nodes.find((n) => n.type === 'core.messageAgent')!.id });
      return toolChunks(decided.events).filter((c) => c.status !== 'started');
    };

    // A URL with a user and password: the host's HTTP client refuses it (fetch takes no credentials in a URL), so the call fails
    // before it leaves; the failure and the target say so without the URL's secret.
    const withUser = credentials.create({ name: 'Local Grafana (userinfo)', type: 'grafana.grafana_alertmanager_api_token', data: { url: `http://admin:pw@127.0.0.1:${amPort}`, token: GRAFANA_TOKEN } });
    const refused = await acknowledge('userinfo', withUser);
    expect(refused.map((c) => c.status), json(refused)).toEqual(['failed']);
    expect(refused[0].output).toMatch(/URL that includes credentials/);
    expect(refused[0].target).toMatchObject({ name: 'Local Grafana (userinfo)', endpoint: `127.0.0.1:${amPort}` });
    expect(alertmanager.silences).toHaveLength(0);

    // The same token on a plain URL: the acknowledge reaches the fake Alertmanager, with the token in its header there only.
    const editor = credentials.create({ name: 'Local Grafana (editor)', type: 'grafana.grafana_alertmanager_api_token', data: { url: `http://127.0.0.1:${amPort}`, token: GRAFANA_TOKEN } });
    const acked = await acknowledge('editor', editor);
    expect(alertmanager.silences, json([alertmanager.requests, acked])).toHaveLength(1);
    expect(alertmanager.silences[0].matchers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'alertname', value: 'High CPU on web-01' })]));
    expect(alertmanager.auth).toContain(`Bearer ${GRAFANA_TOKEN}`);
    expect(acked.map((c) => c.status)).toEqual(['finished']);
    expect(acked[0].target).toMatchObject({ name: 'Local Grafana (editor)', endpoint: `127.0.0.1:${amPort}`, credentialId: editor.id });
    expect(targetLine(acked[0].target)).toBe(`Local Grafana (editor) · Grafana Alertmanager API Token 127.0.0.1:${amPort}`);

    // Everything a person reads: every session timeline, every journal read, every stream, every band answer, the credential list.
    const timelines = seen.agents.map((a) => json(timelinesOf(a)));
    const listed = await call(credentialsRoute.GET, 'GET', '/api/credentials');
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('Local Grafana (editor)');
    expect(listed.text).toContain('Local Grafana (userinfo)');
    const everything = [...timelines, ...seen.journals, ...seen.streams, ...seen.connections, listed.text];
    expect(seen.journals.length).toBeGreaterThanOrEqual(4);
    expect(seen.streams.length).toBeGreaterThanOrEqual(7);
    for (const text of everything) for (const secret of SECRETS) expect(text.includes(secret), `${secret} in ${text.slice(0, 200)}`).toBe(false);
    // The vault's own read leaves the token out (it is a password field since AG14).
    expect(credentials.secretFieldsOf('grafana.grafana_alertmanager_api_token')).toContain('token');
    for (const c of [withUser, editor]) {
      expect(json(credentials.get(c.id))).not.toContain(GRAFANA_TOKEN);
      expect((credentials.get(c.id) as { data?: Record<string, unknown> } | undefined)?.data?.token).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The scenario files run
// ---------------------------------------------------------------------------

describe('6. the scenario files run (AG13 × AG15)', () => {
  it('sb-ag13.ts and sb-ag15.ts export scenarios with those owners (the runner globs sb*.ts and does the rest)', async () => {
    const dir = join(import.meta.dirname, 'spotlight-scenarios');
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['sb-ag13.ts', 'sb-ag15.ts']));
    for (const [file, owner] of [['sb-ag13', 'AG13'], ['sb-ag15', 'AG15']] as const) {
      const mod = (await import(`./spotlight-scenarios/${file}.ts`)) as Record<string, unknown>;
      const scenarios = Object.values(mod).flatMap((v) => (Array.isArray(v) ? v : v && typeof v === 'object' && 'owner' in v ? [v] : [])) as Array<{ owner?: string }>;
      expect(scenarios.length, file).toBeGreaterThan(0);
      expect(scenarios.every((s) => s.owner === owner), json(scenarios.map((s) => s.owner))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Contract copies
// ---------------------------------------------------------------------------

// The pipeline's contracts folder lives outside the repository: set LANDFLOW_BACKBONE_CONTRACTS to it to check the copies.
const CONTRACTS = process.env.LANDFLOW_BACKBONE_CONTRACTS ?? '';
describe.skipIf(!CONTRACTS || !existsSync(join(CONTRACTS, 'ag3')))('7. the ag3 contract copies are byte-identical', () => {
  const runbooks = existsSync(join(CONTRACTS, 'ag3', 'runbooks')) ? readdirSync(join(CONTRACTS, 'ag3', 'runbooks')).filter((f) => f.endsWith('.md')) : [];
  it.each([
    // Wave ag4 replaced these two contracts (contracts/ag4, checked in agents-ag4-joins.test.ts).
    ['src/lib/shared/agent-card.ts', 'ag4/agent-card.ts'],
    ['test/spotlight-scenarios/scenario.ts', 'ag4/spotlight-scenario.ts'],
    ['src/lib/shared/tool-target.ts', 'ag3/tool-target.ts'],
    ...runbooks.map((f) => [`test/spotlight-scenarios/fixtures/runbooks/${f}`, `ag3/runbooks/${f}`]),
  ])('%s = contracts/%s', (copy, contract) => {
    expect(readFileSync(join(import.meta.dirname, '..', copy), 'utf8')).toBe(readFileSync(join(CONTRACTS, contract), 'utf8'));
  });
  it('the four runbooks are all there', () => {
    expect(runbooks.sort()).toEqual(['certificate-expiry.md', 'disk-full.md', 'high-cpu.md', 'ssh-brute-force.md']);
  });
});
