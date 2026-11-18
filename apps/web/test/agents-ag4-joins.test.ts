/**
 * Wave ag4's join tests (carryover-ag4.md §2): each contract between two packages of the wave, with both real sides and no
 * fake between them. Only the edges are scripted: the Agent architect's model (a fake Anthropic Messages API on loopback,
 * reached through the host's own `anthropic/…` builder model with a made-up key), Spotlight's chat model (a scripted
 * `LanguageModel` handed to `runChat`, as the chat route hands its own), the agents' own model and the eval gate's judge
 * (scripted, metered like a provider adapter), the browser's HTTP client (straight to the real route handlers), and a local
 * strict receiver on an ephemeral loopback port (contracts/ag4/strict-receiver.cjs's behaviour). The triage, messaging and
 * text-toolkit plugins are their own code, in process. The files directory is a temp folder holding the runbooks fixture;
 * there is no embeddings server (keyword search).
 *
 * 1. Reuse through the tenant tools (AG18 × AG19 × AG16).
 * 2. Build with the tenant's plugin, knowledge and model; the card's bubbles are the canvas's (AG18 × AG19 × AG16).
 * 3. Run, read the log, fix (AG20 × AG18 × AG19).
 * 4. The bubbles follow a change made through Spotlight (AG16 × AG19).
 * 5. Old wiring moves into the agent, all of it, now; nothing lost (AG17 × AG16 × AG19 × ag3's runtime).
 * 6. Spotlight never wires into a bound node, and the scenario files run (AG17 × AG19 × AG20).
 * 7. No secret anywhere (AG18 × AG20 × AG16 × AG17).
 * 8. The contract copies are byte-identical to backbone/contracts/ag4 (LANDFLOW_BACKBONE_CONTRACTS names the folder).
 * 9. Production keeps the agent version it was published with; every run says both (AG21 × AG16 × AG19).
 * 10. The moves compose with the pins (AG17 × AG21).
 *
 * What needs a DOM (the card's `BubbleDiagram` and the canvas's `BubbleNode` rendering the same `BubbleView`, the node card's
 * text read for `cardLeaks`, the BroadcastChannel post) is read here through the data both draw from (`cardBubbles`,
 * `bubblesFromAnswer`, the routes the bubble store reads); the rendering itself is AG16's and AG19's happy-dom tests
 * (`agent-bubbles-ag4`, `agent-reuse-card-ag4`).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import type { AgentMessage, LanguageModel, ModelTurn, Workflow, WorkflowNode } from '@landflow/engine';
import { cardBubbles, cardLeaks, KEEP_WHY, MOVE_NOTE, moveNoticeLines, pendingLine, type AgentMoveResult, type Bubble } from '@/lib/shared/agent-bubbles';
import { PIN_PARAM, runVersionsLine } from '@/lib/shared/agent-versions';
import { reuseSentence, type CatalogAgent, type RunLog } from '@/lib/shared/tenant-catalog';
import { fixLine, type AgentCard } from '@/lib/shared/agent-card';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { startFakeModels, type FakeReply } from './fake-ai-services';

vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// The edges
// ---------------------------------------------------------------------------

/** The architect's fake Anthropic: each architect turn takes the next scripted reply; the case writer answers `cases`. */
const architect = { script: [] as FakeReply[], cases: '', calls: 0, tools: [] as string[][] };
type AnthropicBody = { system?: unknown; messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ name?: string; function?: { name: string } }> };
const fake = await startFakeModels({
  reply: (_provider, raw): FakeReply => {
    const body = (raw ?? {}) as AnthropicBody;
    const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
    if (/You write test cases/.test(system)) return { text: architect.cases };
    architect.calls += 1;
    architect.tools.push((body.tools ?? []).map((t) => t.function?.name ?? t.name ?? ''));
    return architect.script.shift() ?? { text: 'Done.' };
  },
});

// The agents' own model and the eval gate's judge: scripted. Each user turn records what was offered and the model it ran
// as, and answers `calls` (each matched to an offered tool by a pattern) once; the judge scores 5.
const agentSide = vi.hoisted(() => ({
  calls: [] as Array<{ match: string; input: Record<string, unknown> }>,
  reply: 'Done.',
  offered: [] as string[][],
  models: [] as string[],
  systems: [] as string[],
  results: [] as Array<{ name: string; content: string }>,
  judged: 0,
  turns: 0,
}));
vi.mock('@/lib/server/agents/models', async () => {
  const { traceChat } = await import('@/lib/server/telemetry/ai');
  return {
    OLLAMA_URL: 'http://127.0.0.1:9',
    modelOptions: async (provider: string) =>
      provider === 'anthropic'
        ? [
            { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: '' },
            { provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: '' },
          ]
        : [],
    agentModel: (config: { provider?: string; model?: string } | undefined): LanguageModel => {
      if (!config?.model) throw new Error('Choose a model for this agent first');
      const usage = { inputTokens: 3, outputTokens: 2 };
      const turn = (input: Parameters<LanguageModel['generate']>[0]): ModelTurn => {
        if ((input.system ?? '').includes('"score"')) {
          agentSide.judged += 1;
          return { text: JSON.stringify({ score: 5, reasoning: 'scripted judge' }), toolCalls: [], stopReason: 'end_turn', usage };
        }
        agentSide.turns += 1;
        const last = input.messages.at(-1) as AgentMessage | undefined;
        if (last?.role === 'tool') for (const r of last.results) agentSide.results.push({ name: r.name, content: r.content });
        if (last?.role === 'user') {
          const offered = input.tools.map((t) => t.name);
          agentSide.offered.push(offered);
          agentSide.models.push(`${config.provider}/${config.model}`);
          agentSide.systems.push(input.system ?? '');
          const toolCalls = agentSide.calls.flatMap((c, i) => {
            const name = offered.find((n) => new RegExp(c.match, 'i').test(n));
            return name ? [{ id: `c${agentSide.turns}_${i}`, name, input: c.input }] : [];
          });
          if (toolCalls.length) return { text: '', toolCalls, stopReason: 'tool_use', usage };
        }
        return { text: agentSide.reply, toolCalls: [], stopReason: 'end_turn', usage };
      };
      return {
        provider: config.provider ?? 'anthropic',
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

// The strict receiver (contracts/ag4/strict-receiver.cjs's behaviour): 201 for a JSON body with a non-empty `report_text`,
// else 400 naming the field and the fields it got. Every attempt is kept, with the made-up header token it carried.
const receiver = { attempts: [] as Array<{ path: string; body: string; status: number; token: string }> };
const receiverServer = createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      /* not JSON: a 400 below */
    }
    const ok = typeof parsed.report_text === 'string' && parsed.report_text.trim() !== '';
    receiver.attempts.push({ path: request.url ?? '', body: raw, status: ok ? 201 : 400, token: String(request.headers['x-api-key'] ?? '') });
    if (ok) response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    else response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `Bad Request: the JSON body needs a non-empty string field "report_text" with the report text (got fields: ${Object.keys(parsed).join(', ')})` }));
  });
});
await new Promise<void>((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
const RECEIVER_URL = `http://127.0.0.1:${(receiverServer.address() as AddressInfo).port}/reports/sales`;

// The made-up secrets of this file: none may show in any answer a person or Spotlight reads.
const SMTP_PASSWORD = 'pw-ag4-joins-smtp-made-up';
const HEADER_TOKEN = 'tok-ag4-joins-header-made-up';
const SECRETS = [SMTP_PASSWORD, HEADER_TOKEN, 'sk-ant-made-up-for-the-ag4-joins'];

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ag4-joins-'));
const filesDir = join(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });
cpSync(join(import.meta.dirname, 'spotlight-scenarios', 'fixtures', 'runbooks'), join(filesDir, 'runbooks'), { recursive: true });

const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_FILES_DIR: filesDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://joins-ag4.test',
  LANDFLOW_BUILDER_MODEL: 'anthropic/claude-sonnet-5-5',
  ANTHROPIC_API_KEY: 'sk-ant-made-up-for-the-ag4-joins',
  ANTHROPIC_BASE_URL: fake.url.replace(/\/v1$/, ''),
  OLLAMA_URL: 'http://127.0.0.1:9',
  LANDFLOW_OUTBOUND_ALLOW: '127.0.0.1,localhost',
  LANDFLOW_BRAIN_MODEL: 'off',
  LANDFLOW_BRAIN_EMBEDDINGS: 'off',
};
const UNSET = ['OPENAI_API_KEY', 'LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_KEY'];
const previousEnv = { ...process.env };
for (const key of UNSET) delete process.env[key];
Object.assign(process.env, ENV);

const { ApiError } = await import('@/lib/client/api');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { addCase } = await import('@/lib/server/agents/eval-gate');
const { indexFolder } = await import('@/lib/server/agents/knowledge');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { runWorkflow } = await import('@/lib/server/runner');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { createOwner } = await import('@/lib/server/auth/users');
const { registryLookup } = await import('@/lib/server/assistant/ops');
const { runChat, TOOLS } = await import('@/lib/server/assistant/chat');
const { tenantTool } = await import('@/lib/server/assistant/tenant-tools');
const { runLog } = await import('@/lib/server/assistant/run-log');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const flowMoves = await import('@/lib/server/agents/flow-moves');
const versions = await import('@/lib/server/agents/versions');
const publish = await import('@/lib/server/publish');
await import('@/lib/server/agents/publish-first'); // registers publishing an agent first (the publish route imports it)
const { getPublication, setPublication } = await import('@/lib/server/publications');
const { listVersions } = await import('@/lib/server/versions');
const { testUpdate } = await import('@/lib/server/agents/updates');
const designRoute = await import('@/app/api/agents/design/route');
const importRoute = await import('@/app/api/agents/import/route');
const agentRoute = await import('@/app/api/agents/[id]/route');
const evalGateRoute = await import('@/app/api/agents/[id]/eval-gate/route');
const smokeRoute = await import('@/app/api/agents/[id]/smoke-test/route');
const agentPublishRoute = await import('@/app/api/agents/[id]/publish/route');
const folderRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/folder/route');
const connectionsRoute = await import('@/app/api/agents/[id]/connections/route');
const agentVersionsRoute = await import('@/app/api/agents/[id]/versions/route');
const versionConnectionsRoute = await import('@/app/api/agents/[id]/versions/[version]/connections/route');
const agentMovesRoute = await import('@/app/api/agents/[id]/moves/route');
const movesRoute = await import('@/app/api/workflows/[id]/agent-moves/route');
const workflowPublishRoute = await import('@/app/api/workflows/[id]/publish/route');
const executionRoute = await import('@/app/api/executions/[id]/route');
const { plugin: triage } = await import('../../../plugins/triage/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { plugin: textToolkit } = await import('../../../plugins/text-toolkit/src/main');
const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { cardAskFor, createFromCard, designAgentCard } = await import('@/components/editor/spotlight/agent-ask');
const bubbleData = await import('@/lib/client/agent-bubble-data');
const { parseOps, applyOps } = await import('@/lib/shared/assistant-ops');

type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = async (route: unknown, method: string, path: string, body?: unknown, params?: Record<string, string>) => {
  const response = await (route as Handler)(new Request(`http://localhost:3000${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  const text = await response.text();
  seen.answers.push(text);
  return { status: response.status, text, body: (text ? JSON.parse(text) : undefined) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

wire.impl = async (path, init) => {
  const method = init.method ?? 'GET';
  wire.calls.push({ method, path, json: init.json });
  const [bare, query = ''] = path.split('?');
  if (/^\/api\/workflows\/[^/]+\/versions$/.test(bare)) return { versions: [] };
  const id = /^\/api\/agents\/([^/]+)(?:\/[a-z-]+)?$/.exec(bare)?.[1];
  const folder = /^\/api\/agents\/([^/]+)\/knowledge\/([^/]+)\/folder$/.exec(bare);
  const version = /^\/api\/agents\/([^/]+)\/versions\/(\d+)\/connections$/.exec(bare);
  const moves = /^\/api\/workflows\/([^/]+)\/agent-moves$/.exec(bare);
  let result: { status: number; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (bare === '/api/agents/design') result = await call(designRoute.POST, method, path, init.json);
  else if (bare === '/api/agents/import') result = await call(importRoute.POST, 'POST', path, init.json);
  else if (folder) result = await call(folderRoute.POST, 'POST', path, init.json, { id: folder[1], toolId: folder[2] });
  else if (version) result = await call(versionConnectionsRoute.GET, 'GET', path, undefined, { id: version[1], version: version[2] });
  else if (moves) result = await call(method === 'POST' ? movesRoute.POST : movesRoute.GET, method, path, init.json, { id: moves[1] });
  else if (id && bare.endsWith('/connections')) result = await call(connectionsRoute.GET, 'GET', `${bare}${query ? `?${query}` : ''}`, undefined, { id });
  else if (id && bare.endsWith('/eval-gate')) result = await call(method === 'GET' ? evalGateRoute.GET : evalGateRoute.POST, method, path, init.json, { id });
  else if (id && bare.endsWith('/smoke-test')) result = await call(smokeRoute.POST, 'POST', path, init.json, { id });
  else if (id && bare.endsWith('/publish')) result = await call(agentPublishRoute.POST, 'POST', path, init.json, { id });
  else if (id && bare === `/api/agents/${id}`) result = await call(method === 'PUT' ? agentRoute.PUT : agentRoute.GET, method, path, init.json, { id });
  else throw new Error(`unrouted ${method} ${path}`);
  if (result.status >= 400) throw new ApiError(result.body?.error ?? `${result.status}`, result.status, result.body);
  return result.body;
};

/** What the joins hand on, in file order: every answer a person or Spotlight read (join 7 greps them all). */
const seen = { answers: [] as string[], tenant: [] as string[], runLogs: [] as string[], mcp: [] as string[] };

let types: NodeTypeInfo[];
let smtpId: string;
const KNOWLEDGE = { id: 'tl_kb', type: 'knowledge' as const, name: 'search_runbooks', description: 'Search the incident runbooks', store: 'sqlite' as const, collection: 'runbooks', embeddings: { provider: 'none' as const, model: 'bm25' } };

beforeAll(async () => {
  enableTestAuth(TEST_OWNER);
  await createOwner({ email: 'owner@joins-ag4.test', name: 'Owner', password: 'landflow-dev-only' });
  registry.registerBuiltin(corePlugin);
  for (const plugin of [triage, messaging, textToolkit]) registry.registerBuiltin(plugin);
  types = registry.nodeTypes().filter((t) => t.available);
  smtpId = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: 9, secure: false, disableStartTls: true, user: 'mail', password: SMTP_PASSWORD } }).id;
  await indexFolder(KNOWLEDGE, 'runbooks');
});
afterAll(async () => {
  await fake.close();
  await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  Object.assign(architect, { script: [], cases: '', calls: 0, tools: [] });
  Object.assign(agentSide, { calls: [], reply: 'Done.', judged: 0, turns: 0 });
  for (const list of [agentSide.offered, agentSide.models, agentSide.systems, agentSide.results, wire.calls, receiver.attempts]) list.length = 0;
  enableTestAuth(TEST_OWNER);
  useAssistant.getState().reset();
  useAutonomous.setState({ on: false });
  bubbleData.resetBubbleData();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const json = (value: unknown) => JSON.stringify(value);
let seq = 0;
const node = (id: string, type: string, parameters: Record<string, unknown> = {}, name = id): WorkflowNode => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string, type: 'main' | 'ai_tool' | 'ai_languageModel' | 'ai_memory' = 'main') => ({ id: `${source}-${target}-${type}`, type, source, target, sourceIndex: 0, targetIndex: 0 });
const saveFlow = (wf: Workflow) => store.saveWorkflow(wf, { actor: TEST_OWNER.id });
const lookup = () => registryLookup(types);

/** S1 of asks.md: the alert triager, published, with Send Email (asks first), Extract IOCs and Normalize Alert. */
async function seedTriager(name = 'Alert triager'): Promise<string> {
  const agent = agentStore.create({
    name,
    description: 'Reads an alert, pulls out the IOCs, judges how serious it is and emails the on-call',
    instructions: 'Input: an alert.\nSteps:\n1. Normalise it.\n2. Extract the IOCs.\n3. Judge how serious it is.\n4. Email a short summary.\nOutput: three lines.\nHand over when: it is not an alert.',
    model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    tools: [
      { id: 'tl_norm', type: 'node', name: 'normalize_alert', description: 'Normalise the alert', nodeType: 'triage.normalizeAlert', parameters: {} },
      { id: 'tl_iocs', type: 'node', name: 'extract_iocs', description: 'Pull out the IPs and domains', nodeType: 'triage.extractIocs', parameters: {} },
      { id: 'tl_mail', type: 'node', name: 'send_email', description: 'Email the on-call', nodeType: 'messaging.emailSend', parameters: { toEmail: 'oncall@landflow.test' }, credentials: { smtp: { id: smtpId, name: 'Mailpit SMTP' } }, requireApproval: true },
    ],
  } as never);
  addCase(agent.id, { input: 'Wazuh alert rule 5712: sshd brute force from 203.0.113.45', expected: 'Names 203.0.113.45' });
  const published = await call(agentPublishRoute.POST, 'POST', `/api/agents/${agent.id}/publish`, {}, { id: agent.id });
  expect(published.status, published.text).toBe(200);
  return agent.id;
}
/** S2 of asks.md: the runbook answerer over the `runbooks` base (4 documents, keyword search). */
async function seedRunbookAnswerer(): Promise<string> {
  const agent = agentStore.create({ name: 'Runbook answerer', description: 'Answers from our incident runbooks', instructions: 'Search the runbooks and cite the file.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, tools: [KNOWLEDGE] } as never);
  agentStore.publish(agent.id);
  return agent.id;
}
/** A starter flow: a trigger and a Run an Agent node bound to the agent. */
function starter(agentId: string, id = `wf_starter_${++seq}`, trigger = 'core.manualTrigger'): Workflow {
  return saveFlow({ id, name: `Starter ${id}`, nodes: [node('Start', trigger, trigger === 'core.webhook' ? { path: id, method: 'POST' } : {}), node('Agent', 'core.messageAgent', { agentId, message: 'Triage {{ JSON.stringify($json) }}', conversation: 'new' }, 'Alert triager')], connections: [edge('Start', 'Agent')] });
}

/** The canvas's read: `GET /api/agents/:id/connections` for one node (AG16's route), as the bubble store reads it. */
async function bubblesAt(agentId: string, workflowId: string, nodeId: string): Promise<{ answer: bubbleData.BubbleAnswer; bubbles: Bubble[] }> {
  const res = await call(connectionsRoute.GET, 'GET', `/api/agents/${agentId}/connections?workflowId=${workflowId}&nodeId=${nodeId}`, undefined, { id: agentId });
  expect(res.status, res.text).toBe(200);
  const answer = res.body as unknown as bubbleData.BubbleAnswer;
  return { answer, bubbles: bubbleData.bubblesFromAnswer(answer, [], nodeId) };
}
const labels = (bubbles: readonly Bubble[]) => bubbles.map((b) => b.label);
const look = (bubbles: readonly Bubble[]) => bubbles.map((b) => ({ slot: b.slot, label: b.label, sub: b.sub ?? '', pending: b.pending ?? '' }));

/** Spotlight's chat with a scripted model: each turn is the next item; the events and what each tool answered are kept. */
type Turn = Partial<ModelTurn> & { calls?: Array<{ name: string; input?: Record<string, unknown> }> };
async function chat(workflow: Workflow, message: string, turns: Turn[], extra: Record<string, unknown> = {}) {
  const events: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const toolResults: Array<{ name: string; content: string }> = [];
  let n = 0;
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      const last = input.messages.at(-1) as AgentMessage | undefined;
      if (last?.role === 'tool') for (const r of last.results) toolResults.push({ name: r.name, content: r.content });
      const next = turns.shift();
      if (!next) return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      const { calls, ...turn } = next;
      const toolCalls = (calls ?? []).map((c) => ({ id: `t${++n}`, name: c.name, input: c.input ?? {} }));
      return { text: '', toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, ...turn };
    },
  };
  const agents = agentStore.list().filter((a) => a.published).map((a) => ({ id: a.id, name: a.name, description: a.description ?? '', version: a.published!.version, skills: [], tools: [] }));
  await runChat({ messages: [{ role: 'user', content: message }], workflow, model, types, trace: true, actor: { id: TEST_OWNER.id, role: TEST_OWNER.role }, userId: TEST_OWNER.id, agents, teams: [], onEvent: (e: unknown) => events.push(e as Record<string, any>), ...extra } as never); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const r of toolResults) if (['list_agents', 'get_agent', 'list_tool_nodes', 'list_knowledge_bases', 'list_models', 'list_credentials'].includes(r.name)) seen.tenant.push(r.content);
  for (const r of toolResults) if (r.name === 'get_run_log') seen.runLogs.push(r.content);
  const proposals = events.filter((e) => e.type === 'proposal') as Array<{ ops: Parameters<typeof applyOps>[1]; dropped: string[] }>;
  const text = events.filter((e) => e.type === 'text').map((e) => e.text as string).join('\n');
  return { events, toolResults, proposals, text, tools: events.filter((e) => e.type === 'tool').map((e) => e.name as string) };
}

/** Apply a proposal as the editor's Apply does, and save the workflow. */
function applyAndSave(workflow: Workflow, ops: Parameters<typeof applyOps>[1]): Workflow {
  const applied = applyOps(workflow, ops, lookup());
  expect(applied.dropped, json(applied.dropped)).toEqual([]);
  return saveFlow(applied.workflow);
}

/** The instance MCP server as the owner, over an in-memory transport. */
async function mcp() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instanceServer({ id: TEST_OWNER.id, role: 'owner' }).connect(serverSide);
  const client = new Client({ name: 'ag4-joins', version: '1.0.0' });
  await client.connect(clientSide);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const raw = ((result.content ?? []) as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text).join('');
      seen.mcp.push(raw);
      let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        data = JSON.parse(raw);
      } catch {
        data = undefined;
      }
      return { failed: Boolean(result.isError), raw, data };
    },
  };
}

const prod = (id: string) => publish.productionWorkflowById(id)!;
const runProduction = (id: string, items = [{ json: { alert: 'High CPU on web-01' } }]) => runWorkflow({ workflow: prod(id), mode: 'webhook', startNodeId: 'Start', triggerItems: items });
const runEditor = (id: string, start = 'Start') => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'manual', startNodeId: store.getWorkflow(id)!.nodes.some((n) => n.id === start) ? start : 'n-trigger' });
async function versionsLine(executionId: string): Promise<string> {
  const res = await call(executionRoute.GET, 'GET', `/api/executions/${executionId}`, undefined, { id: executionId });
  expect(res.status, res.text).toBe(200);
  return runVersionsLine(res.body.execution.versions);
}
const lastOffered = () => agentSide.offered.at(-1) ?? [];
const lastSystem = () => agentSide.systems.at(-1) ?? '';

// ---------------------------------------------------------------------------
// 1. Reuse through the tenant tools
// ---------------------------------------------------------------------------

describe('1. reuse through the tenant tools (AG18 × AG19 × AG16)', () => {
  it('asks.md A on an empty workflow: list_agents holds S1 (Send Email asks first, used by 1), the proposal runs S1, no agent is made, and both nodes draw the same bubbles', async () => {
    const s1 = await seedTriager();
    const first = starter(s1, 'wf_s1_starter');
    const empty = saveFlow({ id: 'wf_ask_a', name: 'Untitled workflow', nodes: [], connections: [] });
    const before = agentStore.list().length;

    const ask = 'Every time an alert comes in, triage it and email the on-call a short summary.';
    const reply = await chat(empty, ask, [
      { calls: [{ name: 'list_agents' }] },
      { calls: [{ name: 'propose_changes', input: { summary: 'Triage each alert with Alert triager', ops: [{ op: 'addNode', ref: 't', type: 'core.manualTrigger', name: 'Start' }, { op: 'addNode', ref: 'a', type: 'core.messageAgent', name: 'Alert triager', after: 't', parameters: { agentId: s1, message: 'Triage {{ JSON.stringify($json) }}' } }] } }] },
      { text: reuseSentence('Alert triager', 'it already normalises alerts, pulls out the IOCs and emails the on-call') },
    ]);
    expect(reply.tools.slice(0, 2)).toEqual(['list_agents', 'propose_changes']);
    const listed = JSON.parse(reply.toolResults.find((r) => r.name === 'list_agents')!.content) as CatalogAgent[] | { agents: CatalogAgent[] };
    const agents = Array.isArray(listed) ? listed : listed.agents;
    const triager = agents.find((a) => a.id === s1)!;
    expect(triager).toMatchObject({ name: 'Alert triager', published: 1, usedBy: { count: 1 } });
    expect(triager.tools.find((t) => t.name === 'send_email')).toMatchObject({ asksFirst: true, credential: 'Mailpit SMTP' });

    expect(reply.proposals).toHaveLength(1);
    const saved = applyAndSave(empty, reply.proposals[0]!.ops);
    const placed = saved.nodes.find((n) => n.type === 'core.messageAgent')!;
    expect(placed.parameters.agentId).toBe(s1);
    expect(saved.connections.some((c) => c.type === 'ai_tool')).toBe(false);
    expect(saved.nodes.some((n) => n.type === 'messaging.emailSend')).toBe(false);
    expect(agentStore.list().length).toBe(before);
    expect(reply.text).toBe('Reuses “Alert triager”: it already normalises alerts, pulls out the IOCs and emails the on-call.');

    // The canvas of both workflows: the connections route answers S1's connections and both users; the bubbles are equal.
    const there = await bubblesAt(s1, first.id, 'Agent');
    const here = await bubblesAt(s1, saved.id, placed.id);
    expect(here.answer.usedBy?.map((u) => u.workflowId).sort()).toEqual([first.id, saved.id].sort());
    expect(look(here.bubbles)).toEqual(look(there.bubbles));
    expect(labels(here.bubbles)).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'This conversation']));
    expect(here.bubbles.find((b) => /send/i.test(b.label))).toMatchObject({ asksFirst: true, sub: 'asks first' });
    // The node card (its name and type) holds none of what the bubbles hold.
    expect(cardLeaks(`${placed.name} Run an Agent`, here.bubbles)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Build with the tenant's plugin, knowledge and model
// ---------------------------------------------------------------------------

describe('2. build with the tenant’s plugin, knowledge and model (AG18 × AG19 × AG16)', () => {
  const B_ASK = 'I need an agent that reads an alert someone pastes, pulls out the IPs and domains in it, and tells us what our incident runbooks say to do about it. Keep it cheap: Haiku is fine.';

  it('the architect reads the tenant, attaches the existing runbooks (no folder call), the card’s bubbles are the canvas’s after Create, and the MCP door builds the same agent', async () => {
    const s2 = await seedRunbookAnswerer();
    const s2Kb = agentStore.get(s2)!.tools.find((t) => t.type === 'knowledge')!;
    architect.script = [
      {
        toolCalls: [
          {
            id: 'd1',
            name: 'propose_design',
            arguments: {
              summary: 'Reads an alert, pulls out the IOCs and answers from the runbooks',
              name: 'Alert advisor',
              role: 'Alert advisor',
              description: 'Reads a pasted alert, pulls out the IPs and domains, and says what the runbooks advise.',
              instructions: 'Input: an alert.\nSteps:\n1. Call extract_iocs on it.\n2. Search the runbooks for what to do.\nOutput: the IOCs and the runbook’s steps.\nHand over when: no runbook matches.',
              nodeTools: 'triage.extractIocs',
              knowledgeBase: 'runbooks',
              model: 'anthropic/claude-haiku-5-5',
            },
          },
        ],
      },
    ];
    useEditor.setState({ nodes: [], edges: [], pinData: {}, name: 'Untitled workflow', description: '', workflowId: 'wf_ask_b', nodeTypes: Object.fromEntries(types.map((t) => [t.type, t])) as never });
    const askRead = cardAskFor(B_ASK);
    expect(askRead, B_ASK).toBeDefined();
    await designAgentCard(B_ASK, askRead!, { starter: true });
    const item = useAssistant.getState().items.find((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'agentCard'))!;
    const card = (item.role === 'assistant' ? item.parts.find((p) => p.kind === 'agentCard') : undefined) as { card: AgentCard } | undefined;
    expect(card, json(useAssistant.getState().items)).toBeDefined();
    const designed = card!.card;
    // The architect's first attempt reads the tenant into its brief (AG19 over AG18's catalog): the agents, the plugins' tools
    // found by the job, the knowledge bases with their documents and the models; it proposes in one propose_design call.
    expect(architect.tools[0]).toEqual(['propose_design']);
    const brief = JSON.stringify(fake.requests.filter((r) => r.path === '/v1/messages').at(-1)!.body.messages[0]);
    for (const read of ['Runbook answerer', 'triage.extractIocs', 'runbooks', 'claude-haiku-5-5']) expect(brief, read).toContain(read);
    expect(designed.catalog?.map((c) => c.tool)).toEqual(expect.arrayContaining(['list_tool_nodes', 'list_knowledge_bases', 'list_models']));
    expect(designed.tools.some((t) => t.type === 'triage.extractIocs')).toBe(true);
    expect(designed.tools.some((t) => /emailSend/.test(t.type ?? ''))).toBe(false);
    expect(designed.attached).toEqual({ collection: 'runbooks', documents: 4, search: 'keyword' });
    expect(designed.modelWhy).toBe('asked');
    expect(designed.model).toMatch(/haiku/);
    const cardView = cardBubbles(designed);
    expect(cardView.map((b) => b.slot)).toEqual(['model', 'memory', 'tool', 'tool']);

    // Create, as the card's button does: import, nothing indexed again (the base is attached as it is).
    wire.calls.length = 0;
    await createFromCard(item.id, designed);
    const created = (useAssistant.getState().items.find((i) => i.id === item.id) as { parts: Array<{ kind: string; card?: AgentCard }> }).parts.find((p) => p.kind === 'agentCard')!.card!;
    expect(created.state, created.error).toBe('created');
    expect(wire.calls.some((c) => c.path.includes('/knowledge/'))).toBe(false);
    const made = agentStore.get(created.agentId!)!;
    const kb = made.tools.find((t) => t.type === 'knowledge') as typeof KNOWLEDGE | undefined;
    expect(kb && { store: kb.store, collection: kb.collection, embeddings: kb.embeddings }).toEqual({ store: (s2Kb as typeof KNOWLEDGE).store, collection: 'runbooks', embeddings: (s2Kb as typeof KNOWLEDGE).embeddings });
    // The person's Publish on the card: the smoke test, then the gate (scripted judge), never skipEval.
    const smoked = await call(smokeRoute.POST, 'POST', `/api/agents/${made.id}/smoke-test`, { message: 'Wazuh alert: sshd brute force from 203.0.113.45' }, { id: made.id });
    expect(smoked.status, smoked.text).toBe(200);
    const published = await call(agentPublishRoute.POST, 'POST', `/api/agents/${made.id}/publish`, {}, { id: made.id });
    expect(published.status, published.text).toBe(200);

    // The starter flow is bound to it; the canvas's bubbles for its node equal the card's (labels, slots and sub lines).
    const flow = saveFlow({ ...(useEditor.getState().toWorkflow() as Workflow), id: 'wf_ask_b' });
    const step = flow.nodes.find((n) => n.type === 'core.messageAgent' && n.parameters.agentId === made.id)!;
    expect(step).toBeDefined();
    const canvas = (await bubblesAt(made.id, flow.id, step.id)).bubbles;
    expect(canvas.map((b) => b.slot)).toEqual(['model', 'memory', 'tool', 'tool']);
    expect(canvas.find((b) => b.slot === 'model')!.label).toBe(cardView.find((b) => b.slot === 'model')!.label);
    expect(canvas.find((b) => b.kind === 'knowledge')).toMatchObject({ label: 'runbooks', sub: '4 documents' });
    expect(cardView.find((b) => b.kind === 'knowledge')).toMatchObject({ label: 'runbooks', sub: '4 documents' });
    expect(canvas.filter((b) => b.kind === 'tool').map((b) => b.nodeType)).toEqual(cardView.filter((b) => b.kind === 'tool').map((b) => b.nodeType));

    // The MCP door: the same config, created and published through the gate (no skipEval input exists).
    const door = await mcp();
    const publishSpec = (await door.client.listTools()).tools.find((t) => t.name === 'publish_agent')!;
    expect(JSON.stringify(publishSpec.inputSchema)).not.toContain('skipEval');
    const viaMcp = await door.call('create_agent', { config: { ...(designed.config as Record<string, unknown>), name: 'Alert advisor (MCP)' } });
    expect(viaMcp.failed, viaMcp.raw).toBe(false);
    const mcpId = (viaMcp.data.agent?.id ?? viaMcp.data.id) as string;
    const pub = await door.call('publish_agent', { id: mcpId });
    expect(pub.failed, pub.raw).toBe(false);
    const nodeTypesOf = (id: string) => agentStore.get(id)!.tools.map((t) => (t.type === 'node' ? t.nodeType : t.type)).sort();
    expect(nodeTypesOf(mcpId)).toEqual(nodeTypesOf(made.id));
    expect(agentStore.get(mcpId)!.published).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. Run, read the log, fix
// ---------------------------------------------------------------------------

describe('3. run, read the log, fix (AG20 × AG18 × AG19)', () => {
  it('the first run fails 400; get_run_log names report_text; one setParameters, applied, runs 201; the URL stays the person’s', async () => {
    const wf = saveFlow({
      id: 'wf_report',
      name: 'Sales report',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Shape', 'core.set', { mode: 'manual', fields: { values: [{ name: 'report', type: 'string', value: 'North 4,150' }] } }, 'Report'),
        node('Post', 'core.httpRequest', { method: 'POST', url: RECEIVER_URL, bodyType: 'json', body: { report: '{{ $json.report }}' }, headers: { header: [{ name: 'x-api-key', value: HEADER_TOKEN }] } }, 'Post report'),
      ],
      connections: [edge('Start', 'Shape'), edge('Shape', 'Post')],
    });
    const failed = await runEditor(wf.id);
    expect(failed.status).toBe('error');
    expect(receiver.attempts.at(-1)).toMatchObject({ status: 400 });

    const message = `The test run failed (execution ${failed.executionId}). Read its log and fix it.`;
    const fix = await chat(wf, message, [
      { calls: [{ name: 'get_run_log' }] },
      { calls: [{ name: 'propose_changes', input: { summary: 'Send the report as report_text', ops: [{ op: 'setParameters', node: 'Post report', parameters: { body: { report_text: '{{ $json.report }}' } } }] } }] },
      { text: '“Post report”: the receiver wants report_text. One change: send it as report_text.' },
    ], { session: 'fix' });
    expect(fix.tools.slice(0, 2)).toEqual(['get_run_log', 'propose_changes']);
    const read = fix.toolResults.find((r) => r.name === 'get_run_log')!.content;
    const log = JSON.parse(read.split('\nCause to say')[0]!) as RunLog;
    expect(log.executionId).toBe(failed.executionId);
    const post = log.nodes.find((n) => n.name === 'Post report')!;
    expect(post.error?.httpCode).toBe(400);
    expect(post.error?.description).toContain('report_text');
    expect(read).toContain('Cause to say');

    const fixed = applyAndSave(store.getWorkflow(wf.id)!, fix.proposals[0]!.ops);
    const second = await runEditor(fixed.id);
    expect(second.status).toBe('success');
    const ok = receiver.attempts.filter((a) => a.status === 201);
    expect(ok).toHaveLength(1);
    expect(JSON.parse(ok[0]!.body)).toEqual({ report_text: 'North 4,150' });
    expect(fixed.nodes.find((n) => n.name === 'Post report')!.parameters.url).toBe(RECEIVER_URL);
    // The made-up header token was sent each time (join 7: never shown).
    expect(receiver.attempts.every((a) => a.token === HEADER_TOKEN)).toBe(true);
  });

  it('a failure inside an agent: get_run_log’s agentCalls show it, propose_agent_fix offers the change with its fix line, Apply and Publish through the gate, the re-run passes', async () => {
    const agent = agentStore.create({
      name: 'Report poster',
      description: 'Posts the sales report',
      instructions: 'Post the report with post_report.',
      model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      tools: [{ id: 'tl_post', type: 'node', name: 'post_report', description: 'Post the report', nodeType: 'core.httpRequest', parameters: { method: 'POST', url: RECEIVER_URL, bodyType: 'json', body: { report: 'North 4,150' } } }],
    } as never);
    agentStore.publish(agent.id);
    const wf = saveFlow({ id: 'wf_agent_report', name: 'Agent report', nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.messageAgent', { agentId: agent.id, message: 'Post the report.', conversation: 'new' }, 'Report poster')], connections: [edge('Start', 'Agent')] });
    agentSide.calls = [{ match: 'post_report', input: {} }];
    const failed = await runEditor(wf.id);
    expect(receiver.attempts.at(-1)).toMatchObject({ status: 400 });
    const log = (await runLog({ id: TEST_OWNER.id, role: TEST_OWNER.role }, { workflowId: wf.id, executionId: failed.executionId }))!;
    seen.runLogs.push(JSON.stringify(log));
    const step = log.nodes.find((n) => n.name === 'Report poster')!;
    expect(step.agentCalls?.[0]).toMatchObject({ tool: 'post_report', status: 'error' });

    const fix = await chat(wf, `The test run failed (execution ${failed.executionId}). Read its log and fix it.`, [
      { calls: [{ name: 'get_run_log' }] },
      { calls: [{ name: 'propose_agent_fix', input: { step: 'Report poster', tool: 'post_report', cause: 'the receiver wants report_text, not report', change: 'Send the report as report_text in post_report’s body.' } }] },
      { text: 'Report poster’s post_report sent report; the change card sends report_text.' },
    ], { session: 'fix' });
    const offered = fix.events.find((e) => e.type === 'agent-fix')!;
    expect(offered).toMatchObject({ agentId: agent.id, agent: 'Report poster', fix: { executionId: failed.executionId, step: 'Report poster', tool: 'post_report' } });
    expect(fixLine('Report poster', offered.fix)).toContain('report_text');
    expect(agentStore.get(agent.id)!.tools).toEqual(agentStore.get(agent.id)!.published!.config.tools); // nothing applied by itself

    // Apply (the person's): the draft PUT with the changed body; the smoke test; Publish through the gate.
    const current = agentStore.get(agent.id)!;
    const tools = current.tools.map((t) => (t.type === 'node' ? { ...t, parameters: { ...t.parameters, body: { report_text: 'North 4,150' } } } : t));
    expect((await call(agentRoute.PUT, 'PUT', `/api/agents/${agent.id}`, { ...current, tools }, { id: agent.id })).status).toBe(200);
    expect((await call(smokeRoute.POST, 'POST', `/api/agents/${agent.id}/smoke-test`, { message: 'Post the report.' }, { id: agent.id })).status).toBe(200);
    expect((await call(agentPublishRoute.POST, 'POST', `/api/agents/${agent.id}/publish`, {}, { id: agent.id })).status).toBe(200);
    const again = await runEditor(wf.id);
    expect(again.status).toBe('success');
    expect(receiver.attempts.at(-1)).toMatchObject({ status: 201 });
  });
});

// ---------------------------------------------------------------------------
// 4. The bubbles follow a change made through Spotlight
// ---------------------------------------------------------------------------

describe('4. the bubbles follow a change made through Spotlight (AG16 × AG19)', () => {
  it('asks.md D on S1’s page attaches the existing runbooks; both workflows’ bubbles show it added and not published; Publish clears the marks', async () => {
    const s1 = await seedTriager('Alert triager D');
    const one = starter(s1, 'wf_d_one');
    const two = starter(s1, 'wf_d_two');
    const before = (await bubblesAt(s1, one.id, 'Agent')).bubbles;
    expect(before.some((b) => b.kind === 'knowledge')).toBe(false);

    architect.script = [
      { toolCalls: [{ id: 'k1', name: 'list_knowledge_bases', arguments: {} }] },
      { toolCalls: [{ id: 'd1', name: 'propose_design', arguments: { summary: 'Also searches the runbooks', name: 'Alert triager D', role: 'Alert triager', instructions: 'Input: an alert.\nSteps:\n1. Normalise it.\n2. Extract the IOCs.\n3. Search the runbooks.\n4. Email a short summary.\nOutput: three lines.\nHand over when: it is not an alert.', nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend', knowledgeBase: 'runbooks' } }] },
    ];
    const design = await call(designRoute.POST, 'POST', '/api/agents/design', { preview: true, name: 'Alert triager D', base: { agentId: s1 }, change: 'Also check what our incident runbooks say about the alert before you email.' });
    expect(design.status, design.text).toBe(200);
    const kb = (design.body.config.tools as Array<{ type: string; collection?: string }>).find((t) => t.type === 'knowledge');
    expect(kb?.collection).toBe('runbooks');
    expect(design.body.knowledge?.folder).toBeUndefined();

    // Apply: the draft PUT (the change card's Apply), never the flows.
    const current = agentStore.get(s1)!;
    const applied = await call(agentRoute.PUT, 'PUT', `/api/agents/${s1}`, { ...current, ...design.body.config }, { id: s1 });
    expect(applied.status, applied.text).toBe(200);
    expect(store.getWorkflow(one.id)!.updatedAt).toBe(one.updatedAt);

    // Both canvases re-read the route on AGENT_SAVED (the listener is AG16's, tested in agent-bubbles-ag4): the draft, the base added.
    for (const w of [one, two]) {
      const { answer, bubbles } = await bubblesAt(s1, w.id, 'Agent');
      expect(answer.agent.draftDiffers).toBe(true);
      expect(bubbles.find((b) => b.kind === 'knowledge')).toMatchObject({ label: 'runbooks', pending: 'added' });
      expect(pendingLine(bubbles)).toBe('1 change not published');
      expect(cardLeaks('Alert triager Run an Agent', bubbles)).toEqual([]);
    }
    // Publish (the chip: the smoke test, then the gate).
    expect((await call(smokeRoute.POST, 'POST', `/api/agents/${s1}/smoke-test`, { message: 'High CPU on web-01' }, { id: s1 })).status).toBe(200);
    expect((await call(agentPublishRoute.POST, 'POST', `/api/agents/${s1}/publish`, {}, { id: s1 })).status).toBe(200);
    const after = await Promise.all([one, two].map((w) => bubblesAt(s1, w.id, 'Agent')));
    for (const { bubbles } of after) expect(bubbles.some((b) => b.pending)).toBe(false);
    expect(look(after[0]!.bubbles)).toEqual(look(after[1]!.bubbles));
  });
});

// ---------------------------------------------------------------------------
// 5. Old wiring moves into the agent
// ---------------------------------------------------------------------------

const LEGACY = JSON.parse(readFileSync(new URL('./fixtures/legacy-agent-flow.json', import.meta.url), 'utf8')) as Workflow;
const legacy = (agentId: string, id: string, patch: (flow: Workflow) => Workflow = (f) => f): Workflow => {
  const base = JSON.parse(JSON.stringify(LEGACY).replace('<AGENT_ID>', agentId)) as Workflow;
  return saveFlow({ ...patch({ ...base, id, name: `Legacy ${id}` }), id });
};
const wireInto = (flow: Workflow, sub: Record<string, unknown>, type: 'ai_tool' | 'ai_languageModel'): Workflow => ({
  ...flow,
  nodes: [...flow.nodes, { typeVersion: 1, position: [0, 300], parameters: {}, ...sub } as never],
  connections: [...flow.connections, { id: `c-${sub.id as string}`, type, source: sub.id as string, sourceIndex: 0, target: 'n-agent', targetIndex: 0 }],
});
const moveRows = (agentId: string) => database().all<Record<string, unknown>>('SELECT * FROM agent_flow_moves WHERE agent_id = ? ORDER BY id', agentId);
const utility = (name: string) => {
  const agent = agentStore.create({ name, description: 'decodes and hashes', instructions: 'Help.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } } as never);
  return agentStore.publish(agent.id)!;
};

describe('5. old wiring moves into the agent, all of it, now; nothing lost (AG17 × AG16 × ag3’s runtime)', () => {
  it('the start pass moves Slugify once (B’s is the same), renames C’s, moves C’s model, keeps the memory, writes six rows and nothing the second time; runs keep working before and after Publish', async () => {
    const s4 = utility('Utility helper');
    const a = legacy(s4.id, 'legacy_a');
    const b = legacy(s4.id, 'legacy_b');
    const c = legacy(s4.id, 'legacy_c', (f) => ({
      ...wireInto({ ...f, nodes: f.nodes.filter((n) => n.id !== 'n-memory' && n.id !== 'n-slug'), connections: f.connections.filter((x) => x.source !== 'n-memory' && x.source !== 'n-slug') }, { id: 'n-model', name: 'Anthropic Chat Model', type: 'core.anthropicChatModel', parameters: { model: 'claude-haiku-5-5' } }, 'ai_languageModel'),
    }));
    const c2 = saveFlow(wireInto(c, { id: 'n-slug2', name: 'Slugify', type: 'text-toolkit.slugify', parameters: { separator: '_' } }, 'ai_tool'));
    const publishedBefore = json(agentStore.get(s4.id)!.published);

    await flowMoves.startPass();
    const draft = agentStore.get(s4.id)!;
    const slugs = draft.tools.filter((t) => t.type === 'node' && t.nodeType === 'text-toolkit.slugify');
    expect(slugs).toHaveLength(2);
    expect(draft.model).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(json(agentStore.get(s4.id)!.published)).toBe(publishedBefore);
    for (const id of [a.id, b.id, c2.id]) {
      const saved = store.getWorkflow(id)!;
      expect(saved.nodes.some((n) => n.type === 'text-toolkit.slugify' || n.type === 'core.anthropicChatModel'), id).toBe(false);
      expect(saved.connections.some((x) => x.type === 'ai_tool' || x.type === 'ai_languageModel'), id).toBe(false);
    }
    expect(store.getWorkflow(a.id)!.connections.some((x) => x.type === 'ai_memory')).toBe(true);
    const rows = moveRows(s4.id);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.outcome === 'kept').map((r) => r.why)).toEqual([KEEP_WHY.memory, KEEP_WHY.memory]);
    expect(rows.filter((r) => r.outcome === 'same')).toHaveLength(1);
    const renamed = rows.find((r) => r.workflow_id === c2.id && r.sub_node_name === 'Slugify' && r.outcome === 'moved')!;
    expect(String(renamed.why)).toContain(MOVE_NOTE.renamed(String(slugs[1]!.name)).split('(')[0]!.trim().split(' ')[0]!);
    const model = rows.find((r) => r.workflow_id === c2.id && r.moved_as === 'model')!;
    expect(model.outcome).toBe('moved');
    expect(String(model.why)).toContain(MOVE_NOTE.everywhere(2));
    expect(database().get('SELECT value FROM meta WHERE key = ?', 'agents.flowOverrides.migrated')).toBeTruthy();

    // Idempotent: the second pass writes nothing.
    const drafts = vi.spyOn(agentStore, 'saveDraft');
    const saves = vi.spyOn(store, 'saveWorkflow');
    const upserts = vi.spyOn(database(), 'upsert');
    await flowMoves.startPass();
    expect(drafts).not.toHaveBeenCalled();
    expect(saves).not.toHaveBeenCalled();
    expect(upserts).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    // It keeps running (R11): A's node is offered Slugify exactly once and keeps its memory; C's run uses C's model.
    const runA = await runEditor(a.id);
    expect(runA.status, json(runA.error)).toBe('success');
    expect(lastOffered().filter((n) => /slug/i.test(n))).toHaveLength(2); // the draft holds both Slugify tools (one renamed)
    const runC = await runEditor(c2.id);
    expect(runC.status, json(runC.error)).toBe('success');
    expect(agentSide.models.at(-1)).toBe('anthropic/claude-haiku-5-5');
    // A production-style run of the saved graph on the published config (no pin: a sub-workflow call) gets the overlay, once.
    await runWorkflow({ workflow: store.getWorkflow(a.id)!, mode: 'webhook', startNodeId: 'n-trigger' });
    expect(lastOffered().filter((n) => /slug/i.test(n))).toHaveLength(1);

    // Publish (smoke, then the gate): the moves are live and come from the agent, never twice.
    expect((await call(smokeRoute.POST, 'POST', `/api/agents/${s4.id}/smoke-test`, { message: 'slugify "x"' }, { id: s4.id })).status).toBe(200);
    expect((await call(agentPublishRoute.POST, 'POST', `/api/agents/${s4.id}/publish`, {}, { id: s4.id })).status).toBe(200);
    await runWorkflow({ workflow: store.getWorkflow(a.id)!, mode: 'webhook', startNodeId: 'n-trigger' });
    expect(lastOffered().filter((n) => /slug/i.test(n))).toHaveLength(2);
    const read = await call(agentMovesRoute.GET, 'GET', `/api/agents/${s4.id}/moves`, undefined, { id: s4.id });
    expect(read.status).toBe(200);
    const moves = (read.body.moves ?? read.body) as Array<{ outcome: string; state?: string }>;
    expect(moves.filter((m) => m.outcome === 'moved').every((m) => m.state === 'live')).toBe(true);
  });

  it('conflicts: a model wired after the move is kept (the draft already changes it, then a different one); a stale updatedAt is 412 and the draft unchanged', async () => {
    const s4 = utility('Utility helper conflicts');
    legacy(s4.id, 'legacy_m1', (f) => wireInto(f, { id: 'n-model', name: 'Anthropic Chat Model', type: 'core.anthropicChatModel', parameters: { model: 'claude-haiku-5-5' } }, 'ai_languageModel'));
    await flowMoves.startPass();
    expect(agentStore.get(s4.id)!.model).toMatchObject({ model: 'claude-haiku-5-5' });
    const fourth = legacy(s4.id, 'legacy_m2', (f) => wireInto(f, { id: 'n-model', name: 'Anthropic Chat Model', type: 'core.anthropicChatModel', parameters: { model: 'claude-opus-5-5' } }, 'ai_languageModel'));
    const kept = await call(movesRoute.POST, 'POST', `/api/workflows/${fourth.id}/agent-moves`, { updatedAt: fourth.updatedAt }, { id: fourth.id });
    expect(kept.status, kept.text).toBe(200);
    const result = kept.body as unknown as AgentMoveResult;
    expect(result.kept.find((k) => k.as === 'model' || k.slot === 'model')?.why).toBe(KEEP_WHY.draftModel('claude-haiku-5-5'));

    const draftBefore = json(agentStore.get(s4.id));
    const stale = legacy(s4.id, 'legacy_stale');
    const conflict = await call(movesRoute.POST, 'POST', `/api/workflows/${stale.id}/agent-moves`, { updatedAt: '2000-01-01T00:00:00.000Z' }, { id: stale.id });
    expect(conflict.status).toBe(412);
    expect(json(agentStore.get(s4.id))).toBe(draftBefore);
  });

  it('on open: an imported legacy flow after the pass moves once; the notice says it; the bubbles mark Slugify moved here while pending', async () => {
    const s4 = utility('Utility helper open');
    await flowMoves.startPass(); // the pass ran before the import
    const d = legacy(s4.id, 'legacy_d');
    useEditor.getState().load(d, []);
    const posted = await call(movesRoute.POST, 'POST', `/api/workflows/${d.id}/agent-moves`, { updatedAt: d.updatedAt }, { id: d.id });
    const result = posted.body as unknown as AgentMoveResult;
    expect(result.moved.map((m) => m.name)).toEqual(['Slugify']);
    expect(moveNoticeLines([...result.moved, ...result.kept], result.agents)).toEqual([
      'Moved into Utility helper open, not published yet: Slugify (tool).',
      `Kept in this flow: Window Memory. ${KEEP_WHY.memory}`,
      'Utility helper open has changes not published: the editor’s tests use them; publish Utility helper open, then this workflow, to put them live.',
    ]);
    const reloaded = store.getWorkflow(d.id)!;
    expect(reloaded.nodes.some((n) => n.id === 'n-slug')).toBe(false);
    // The canvas: the flow's moves and the agent's draft; Slugify drawn moved here while pending; the card holds no name.
    const movesRead = await call(movesRoute.GET, 'GET', `/api/workflows/${d.id}/agent-moves`, undefined, { id: d.id });
    const moves = (movesRead.body.moves ?? movesRead.body) as Parameters<typeof bubbleData.bubblesFromAnswer>[1];
    const { answer } = await bubblesAt(s4.id, d.id, 'n-agent');
    const bubbles = bubbleData.bubblesFromAnswer(answer, moves, 'n-agent');
    expect(bubbles.find((b) => /slug/i.test(b.label))).toMatchObject({ pending: 'added', movedHere: true });
    expect(cardLeaks('Utility helper Run an Agent', bubbles)).toEqual([]);
    // A chat changeAgent on the bound node is parsed by AG19's schema and applied by AG17's op: the graph is unchanged.
    const op = parseOps([{ op: 'changeAgent', node: 'Utility helper', change: 'Also hash the slug.' }]).ops;
    const applied = applyOps(reloaded, op, lookup());
    expect(applied.applied).toEqual([{ op: 'changeAgent', node: 'Utility helper', agentId: s4.id, change: 'Also hash the slug.' }]);
    expect(applied.workflow).toEqual(reloaded);
  });
});

// ---------------------------------------------------------------------------
// 6. Spotlight never wires into a bound node; the scenario files run
// ---------------------------------------------------------------------------

describe('6. Spotlight never wires into a bound node, and the scenario files run (AG17 × AG19 × AG20)', () => {
  it('a proposed ai_tool into a bound node is left out with the sentence; the next proposal is changeAgent', async () => {
    const s4 = utility('Utility helper wiring');
    const wf = saveFlow({ id: 'wf_wiring', name: 'Wiring', nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.messageAgent', { agentId: s4.id, message: 'hi' }, 'Utility helper')], connections: [edge('Start', 'Agent')] });
    const reply = await chat(wf, 'Wire a Sentiment tool into this step.', [
      { calls: [{ name: 'propose_changes', input: { summary: 'Wire a tool', ops: [{ op: 'addNode', ref: 's', type: 'text-toolkit.slugify', name: 'Slugify' }, { op: 'connect', from: 's', to: 'Utility helper', type: 'ai_tool' }] } }] },
      { calls: [{ name: 'propose_changes', input: { summary: 'Change the agent', ops: [{ op: 'changeAgent', node: 'Utility helper', change: 'Add a sentiment tool.' }] } }] },
      { text: 'Utility helper’s tools are its own: the card changes the agent.' },
    ]);
    const sentence = `“Utility helper” runs the agent “${s4.id}”: its model, memory and tools are the agent’s. Change the agent instead (changeAgent).`;
    const said = [...reply.proposals.flatMap((p) => p.dropped), ...reply.toolResults.map((r) => r.content)].join('\n');
    expect(said).toContain(sentence);
    expect(reply.proposals.flatMap((p) => p.ops).some((o) => o.op === 'connect' && (o as { type?: string }).type === 'ai_tool')).toBe(false);
    // The changeAgent proposal reaches the person (it changes the agent, not the graph, so it is no "repeat").
    expect(reply.events.filter((e) => e.type === 'tool').map((e) => e.label)).toEqual(['Reworked the change', 'Proposed 1 change']);
    expect(reply.proposals.at(-1)!.ops).toEqual([expect.objectContaining({ op: 'changeAgent', node: 'Utility helper', change: 'Add a sentiment tool.' })]);
  });

  it('OP_SCHEMA’s changeAgent fields are what parseOps reads (node, agentId, change; no moveWired in either)', () => {
    const schema = (TOOLS.find((t) => t.name === 'propose_changes')!.inputSchema as { properties: { ops: { items: { properties: Record<string, unknown> } } } }).properties.ops.items.properties;
    for (const field of ['node', 'agentId', 'change']) expect(Object.keys(schema)).toContain(field);
    expect(Object.keys(schema)).not.toContain('moveWired');
    expect(parseOps([{ op: 'changeAgent', node: 'X', agentId: 'ag_1', change: 'c', moveWired: true }]).ops).toEqual([{ op: 'changeAgent', node: 'X', agentId: 'ag_1', change: 'c' }]);
  });

  it('sb-ag19.ts and sb-ag20.ts export scenarios with those owners (the runner globs sb*.ts and does the rest)', async () => {
    const dir = join(import.meta.dirname, 'spotlight-scenarios');
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['sb-ag19.ts', 'sb-ag20.ts']));
    for (const [file, owner] of [['sb-ag19', 'AG19'], ['sb-ag20', 'AG20']] as const) {
      const mod = (await import(`./spotlight-scenarios/${file}.ts`)) as Record<string, unknown>;
      const scenarios = Object.values(mod).flatMap((v) => (Array.isArray(v) ? v : v && typeof v === 'object' && 'owner' in v ? [v] : [])) as Array<{ owner?: string }>;
      expect(scenarios.length, file).toBeGreaterThan(0);
      expect(scenarios.every((s) => s.owner === owner), json(scenarios.map((s) => s.owner))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Production keeps the agent version it was published with
// ---------------------------------------------------------------------------

describe('9. production keeps the agent version it was published with; every run says both (AG21 × AG16 × AG19)', () => {
  it('Spotlight’s publish card pins S1 v1; S1 v2 does not move production; the draft does not touch it; test then publish the update; the version’s bubbles; a draft that differs blocks; the upgrade changes nothing', async () => {
    const s1 = await seedTriager('Alert triager F');
    const wf = starter(s1, 'wf_f', 'core.webhook');

    // "Publish this flow.": propose_publish offers a card; the card's Publish is the publish route.
    const offer = await chat(store.getWorkflow(wf.id)!, 'Publish this flow.', [{ calls: [{ name: 'propose_publish' }] }, { text: 'Press Publish on the card.' }]);
    const card = offer.events.find((e) => e.type === 'publishOffer')!.offer as { kind: string; pins: Array<{ agentName: string; version: number }>; blocks?: unknown };
    expect(card).toMatchObject({ kind: 'draft', pins: [{ agentName: 'Alert triager F', version: 1 }] });
    expect(card.blocks).toBeUndefined();
    expect(getPublication(wf.id)).toBeUndefined();
    const pressed = await call(workflowPublishRoute.POST, 'POST', `/api/workflows/${wf.id}/publish`, {}, { id: wf.id });
    expect(pressed.status, pressed.text).toBe(200);
    const vk = getPublication(wf.id)!.versionId;
    const k = listVersions(wf.id).find((v) => v.id === vk)!.number;
    expect(versions.pinsFor(vk)).toMatchObject([{ nodeId: 'Agent', agentId: s1, version: 1 }]);

    // S1 moves on through a design change on its page (the runbooks), applied and published: v2.
    architect.script = [{ toolCalls: [{ id: 'd1', name: 'propose_design', arguments: { summary: 'Also searches the runbooks', name: 'Alert triager F', role: 'Alert triager', instructions: 'Input: an alert.\nSteps:\n1. Search the runbooks.\n2. Email a short summary.\nOutput: three lines.\nHand over when: it is not an alert.', nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend', knowledgeBase: 'runbooks' } }] }];
    const design = await call(designRoute.POST, 'POST', '/api/agents/design', { preview: true, name: 'Alert triager F', base: { agentId: s1 }, change: 'Also check the runbooks.' });
    expect(design.status, design.text).toBe(200);
    expect((await call(agentRoute.PUT, 'PUT', `/api/agents/${s1}`, { ...agentStore.get(s1)!, ...design.body.config }, { id: s1 })).status).toBe(200);
    expect((await call(agentPublishRoute.POST, 'POST', `/api/agents/${s1}/publish`, {}, { id: s1 })).status).toBe(200);
    expect(agentStore.get(s1)!.published!.version).toBe(2);

    const p1 = await runProduction(wf.id);
    expect(p1.status).toBe('success');
    expect(lastOffered().some((n) => /runbooks/i.test(n))).toBe(false); // v1's tools, not v2's knowledge base
    expect(versions.runVersions(p1.executionId)!.agents).toMatchObject([{ agentId: s1, version: 1, source: 'pinned' }]);
    expect(await versionsLine(p1.executionId)).toBe(`workflow v${k} · Alert triager F v1`);
    const uses = await call(agentVersionsRoute.GET, 'GET', `/api/agents/${s1}/versions`, undefined, { id: s1 });
    expect(uses.status, uses.text).toBe(200);
    expect(json(uses.body)).toContain(wf.id);
    expect(versions.agentUpdates({ workflowId: wf.id })).toMatchObject([{ pinned: 1, latest: 2 }]);

    // The draft does not touch production: a filter node saved, not published.
    const draft = store.getWorkflow(wf.id)!;
    saveFlow({ ...draft, nodes: [...draft.nodes, node('Keep', 'core.filter', {}, 'Keep high or critical')], connections: [...draft.connections, edge('Agent', 'Keep')] });
    const p2 = await runProduction(wf.id);
    expect(await versionsLine(p2.executionId)).toBe(`workflow v${k} · Alert triager F v1`);
    expect(Object.keys((p2 as { runData?: Record<string, unknown> }).runData ?? {})).not.toContain('Keep');
    expect(prod(wf.id).nodes.some((n) => n.id === 'Keep')).toBe(false);
    const manual = await runWorkflow({ workflow: store.getWorkflow(wf.id)!, mode: 'manual', startNodeId: 'Start', triggerItems: [{ json: { alert: 'x' } }] });
    expect(await versionsLine(manual.executionId)).toMatch(/^workflow draft.* · Alert triager F draft$/);

    // Test then publish the update (Spotlight's card).
    const update = await chat(store.getWorkflow(wf.id)!, 'Our triage agent has a new version. Test this flow with it and put it live if it works.', [{ calls: [{ name: 'list_agent_updates' }] }, { calls: [{ name: 'propose_agent_update', input: { agentIds: [s1] } }] }, { text: 'Test it on the card, then publish.' }]);
    expect(update.tools.slice(0, 2)).toEqual(['list_agent_updates', 'propose_agent_update']);
    expect(update.events.find((e) => e.type === 'publishOffer')!.offer).toMatchObject({ kind: 'update', updates: [{ pinned: 1, latest: 2 }] });
    await expect(publish.publishUpdate(wf.id, [s1], 'owner')).rejects.toMatchObject({ status: 409 });
    const tested = await testUpdate(wf.id, [s1], 'owner');
    expect(tested.status).toBe('success');
    await publish.publishUpdate(wf.id, [s1], 'owner', tested.executionId);
    const vm = getPublication(wf.id)!.versionId;
    const m = listVersions(wf.id).find((v) => v.id === vm)!.number;
    expect(m).toBeGreaterThan(k);
    expect(versions.pinsFor(vm)).toMatchObject([{ agentId: s1, version: 2 }]);
    expect(prod(wf.id).nodes.some((n) => n.id === 'Keep')).toBe(false);
    expect(store.getWorkflow(wf.id)!.nodes.some((n) => n.id === 'Keep')).toBe(true);
    const p3 = await runProduction(wf.id);
    expect(await versionsLine(p3.executionId)).toBe(`workflow v${m} · Alert triager F v2`);
    expect(lastOffered().some((n) => /runbooks/i.test(n))).toBe(true);
    // A rollback to v<k> runs v1 again.
    await publish.publishVersion(wf.id, vk, 'owner');
    const p4 = await runProduction(wf.id);
    expect(versions.runVersions(p4.executionId)!.agents).toMatchObject([{ version: 1, source: 'pinned' }]);
    await publish.publishVersion(wf.id, vm, 'owner');

    // The bubbles of a version: v1's connections (no runbooks), read-only; the editor's canvas draws the draft.
    const v1 = await call(versionConnectionsRoute.GET, 'GET', `/api/agents/${s1}/versions/1/connections`, undefined, { id: s1, version: '1' });
    expect(v1.status, v1.text).toBe(200);
    const v1Bubbles = bubbleData.bubblesFromAnswer(v1.body as never);
    expect(v1Bubbles.some((b) => b.kind === 'knowledge')).toBe(false);
    expect(v1Bubbles.some((b) => b.pending)).toBe(false);
    expect((await bubblesAt(s1, wf.id, 'Agent')).bubbles.some((b) => b.kind === 'knowledge')).toBe(true);

    // A draft that differs blocks the workflow's publish; Publish <agent> first publishes S1 v3 through the gate, then pins it.
    agentStore.saveDraft(s1, { ...agentStore.get(s1)!, instructions: `${agentStore.get(s1)!.instructions}\nAnswer in three lines.` } as never);
    const blocked = await call(workflowPublishRoute.POST, 'POST', `/api/workflows/${wf.id}/publish`, {}, { id: wf.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'agent_changes_unpublished', agents: [{ name: 'Alert triager F' }] });
    expect(getPublication(wf.id)!.versionId).toBe(vm);
    const first = await call(workflowPublishRoute.POST, 'POST', `/api/workflows/${wf.id}/publish`, { agents: 'publish-first' }, { id: wf.id });
    expect(first.status, first.text).toBe(200);
    expect(agentStore.get(s1)!.published!.version).toBe(3);
    expect(versions.pinsFor(getPublication(wf.id)!.versionId)).toMatchObject([{ agentId: s1, version: 3 }]);

    // The upgrade changes nothing: a publication made before the migration is pinned at what it runs; a second backfill writes nothing.
    const legacyFlow = starter(s1, 'wf_f_backfill');
    const version = listVersions(legacyFlow.id)[0]!;
    setPublication(legacyFlow.id, version.id, 'migration');
    database().delete('workflow_version_pins', { version_id: version.id });
    database().delete('meta', { key: 'agents.versions.backfilled' });
    expect(await versions.backfillVersions()).toBeGreaterThanOrEqual(1);
    expect(versions.pinsFor(version.id)).toMatchObject([{ agentId: s1, version: 3 }]);
    const pins = json(database().all('SELECT * FROM workflow_version_pins ORDER BY version_id, node_id'));
    expect(await versions.backfillVersions()).toBe(0);
    expect(json(database().all('SELECT * FROM workflow_version_pins ORDER BY version_id, node_id'))).toBe(pins);
  });
});

// ---------------------------------------------------------------------------
// 10. The moves compose with the pins
// ---------------------------------------------------------------------------

describe('10. the moves compose with the pins (AG17 × AG21)', () => {
  it('a flow published before ag4 keeps its wired Slugify in production (pinned, no overlay); the editor runs the draft; an unpinned run of the saved graph gets the overlay; publishing needs S4 first, then pins v2', async () => {
    const s4 = utility('Utility helper pins');
    // A published before ag4: the backfill pins it at S4 v1 (its production copy still wires Slugify).
    const a = legacy(s4.id, 'legacy_pinned', (f) => ({ ...f, active: true }));
    const version = listVersions(a.id)[0]!;
    setPublication(a.id, version.id, 'migration');
    database().delete('workflow_version_pins', { version_id: version.id });
    database().delete('meta', { key: 'agents.versions.backfilled' });
    await versions.backfillVersions();
    expect(versions.pinsFor(version.id)).toMatchObject([{ agentId: s4.id, version: 1 }]);
    // The start pass moves Slugify into S4's draft and saves A without it.
    await flowMoves.startPass();
    expect(store.getWorkflow(a.id)!.nodes.some((n) => n.id === 'n-slug')).toBe(false);
    expect(prod(a.id).nodes.some((n) => n.id === 'n-slug')).toBe(true);
    expect(prod(a.id).nodes.find((n) => n.id === 'n-agent')!.parameters[PIN_PARAM]).toBe(1);

    const p1 = await runWorkflow({ workflow: prod(a.id), mode: 'webhook', startNodeId: 'n-trigger' });
    expect(p1.status, json(p1.error)).toBe('success');
    expect(lastOffered().filter((n) => /slug/i.test(n))).toHaveLength(1);
    expect(versions.runVersions(p1.executionId)!.agents).toMatchObject([{ agentId: s4.id, version: 1, source: 'pinned' }]);

    const editor = await runEditor(a.id);
    expect(editor.status, json(editor.error)).toBe('success');
    expect(lastOffered().filter((n) => /slug/i.test(n))).toHaveLength(1);
    expect(versions.runVersions(editor.executionId)!.agents).toMatchObject([{ version: 'draft', source: 'draft' }]);

    // An unpinned run of A's saved graph (what a never-published caller runs: no pin, S4's published config lacks Slugify): the overlay, once.
    const unpinned = await runWorkflow({ workflow: store.getWorkflow(a.id)!, mode: 'webhook', startNodeId: 'n-trigger' });
    expect(unpinned.status, json(unpinned.error)).toBe('success');
    expect(store.getWorkflow(a.id)!.nodes.find((n) => n.id === 'n-agent')!.parameters[PIN_PARAM]).toBeUndefined();
    expect(lastOffered().filter((n) => /slug/i.test(n))).toHaveLength(1);
    expect(versions.runVersions(unpinned.executionId)!.agents).toMatchObject([{ agentId: s4.id, version: 1 }]);

    // Publishing A's draft: 409 (S4's draft differs) → Publish S4 first → S4 v2 through the gate, then A pins v2.
    const blocked = await call(workflowPublishRoute.POST, 'POST', `/api/workflows/${a.id}/publish`, {}, { id: a.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('agent_changes_unpublished');
    const first = await call(workflowPublishRoute.POST, 'POST', `/api/workflows/${a.id}/publish`, { agents: 'publish-first' }, { id: a.id });
    expect(first.status, first.text).toBe(200);
    expect(agentStore.get(s4.id)!.published!.version).toBe(2);
    const vNew = getPublication(a.id)!.versionId;
    expect(versions.pinsFor(vNew)).toMatchObject([{ agentId: s4.id, version: 2 }]);
    expect(prod(a.id).nodes.some((n) => n.id === 'n-slug')).toBe(false);
    await runWorkflow({ workflow: prod(a.id), mode: 'webhook', startNodeId: 'n-trigger' });
    expect(lastOffered().filter((n) => /slug/i.test(n))).toHaveLength(1);
    const moves = flowMoves.movesOf({ workflowId: a.id }, { id: TEST_OWNER.id, role: TEST_OWNER.role } as never);
    expect(moves.find((mv) => mv.name === 'Slugify' && mv.outcome === 'moved')?.state).toBe('live');
    // Both tables read back (the two migrations, in order, on this SQLite).
    expect(database().all('SELECT id FROM agent_flow_moves WHERE workflow_id = ?', a.id).length).toBeGreaterThan(0);
    expect(database().all('SELECT * FROM workflow_version_pins WHERE version_id = ?', vNew)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. No secret anywhere
// ---------------------------------------------------------------------------

describe('7. no secret anywhere (AG18 × AG20 × AG16 × AG17)', () => {
  it('every tenant tool answer (in process and MCP), run log, connections, moves answer and move record holds none of the made-up secrets', async () => {
    const door = await mcp();
    for (const name of ['list_agents', 'list_tool_nodes', 'list_knowledge_bases', 'list_credentials']) {
      seen.tenant.push((await tenantTool(name, {}, { actor: { id: TEST_OWNER.id, role: TEST_OWNER.role } })).text);
      seen.mcp.push((await door.call(name)).raw);
    }
    const rows = json(database().all('SELECT * FROM agent_flow_moves'));
    const all = [...seen.answers, ...seen.tenant, ...seen.runLogs, ...seen.mcp, rows];
    expect(seen.tenant.length).toBeGreaterThan(4);
    expect(seen.runLogs.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(2);
    for (const text of all) for (const secret of SECRETS) expect(text.includes(secret), `${secret} in ${text.slice(0, 200)}`).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Contract copies
// ---------------------------------------------------------------------------

// The pipeline's contracts folder lives outside the repository: set LANDFLOW_BACKBONE_CONTRACTS to it to check the copies.
const CONTRACTS = process.env.LANDFLOW_BACKBONE_CONTRACTS ?? '';
describe.skipIf(!CONTRACTS || !existsSync(join(CONTRACTS, 'ag4')))('8. the ag4 contract copies are byte-identical', () => {
  it.each([
    ['src/lib/shared/agent-card.ts', 'ag4/agent-card.ts'],
    ['test/spotlight-scenarios/scenario.ts', 'ag4/spotlight-scenario.ts'],
    ['src/lib/shared/tenant-catalog.ts', 'ag4/tenant-catalog.ts'],
    ['src/lib/shared/agent-bubbles.ts', 'ag4/agent-bubbles.ts'],
    ['src/components/canvas/bubble-view.tsx', 'ag4/bubble-view.tsx'],
    ['src/lib/shared/agent-versions.ts', 'ag4/agent-versions.ts'],
    ['test/fixtures/legacy-agent-flow.json', 'ag4/legacy-flow.json'],
  ])('%s = contracts/%s', (copy, contract) => {
    expect(readFileSync(join(import.meta.dirname, '..', copy), 'utf8')).toBe(readFileSync(join(CONTRACTS, contract), 'utf8'));
  });
});
