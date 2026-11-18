/**
 * Wave ag5's join tests (carryover-ag5.md §2): the packages of the wave on their real sides, with no fake between them.
 *
 * The real sides: the editor's test-and-fix session (`components/editor/test-session.ts`, AG22) with the real editor and
 * assistant stores, the agent card's apply and publish (`spotlight/agent-ask.ts`), the credential picker's one-fitting pick
 * (`spotlight/agent-credential-picker.tsx`), Spotlight's chat route and tools (`get_run_log`, `propose_agent_fix`), the
 * agent design route with `keep` (AG24), the eval gate and its basis (AG24), the run route with Spotlight's approvals and the
 * agent runtime that honours them (AG23), the unattended-approvals route (AG23), the flow builder's guard and the step-agent
 * design after it (AG25), the workflow publish with its pins (ag4 AG21), the production webhook handler, and the Run Trace's
 * execution answer. Every browser call (`api`, `streamEvents`) goes to the route handler the path names under `src/app`.
 *
 * Only the edges are scripted: Spotlight's model, the Agent architect, the case writer and the flow builder (one fake Anthropic
 * Messages API on loopback, reached through the host's `anthropic/…` builder model with a made-up key); the agents' own model
 * and the eval gate's judge (`@/lib/server/agents/models`, scripted and metered as ag4's joins do); a local copy of
 * contracts/ag4/strict-receiver.cjs's behaviour on an ephemeral loopback port; a fake SMTP server
 * (plugins/messaging/test/fake-smtp.ts) behind the real messaging plugin. The "data" tool is a small in-process plugin this
 * file registers (`salesjoin`: one read node whose output carries the figures, with a credential type only this file
 * registers and exactly one credential of it, so `pickAlone` applies), since the Databases plugin is Go and not loaded here.
 *
 * 1. The autonomous fix session finishes on a saved, published flow, and production then runs the fixed agent (AG22 × AG24 × ag4 AG21).
 * 2. Spotlight's approvals in a test run, and the production line (AG22 × AG23 × the runtime).
 * 3. The first flow ask uses a saved agent, then the session reaches the review with the agent's reply (AG25 × AG22).
 * 4. A held publish says its score everywhere (AG24 × AG22 × the publish card).
 * 5. The contract copy is byte-identical to backbone/contracts/ag5 (LANDFLOW_BACKBONE_CONTRACTS names the folder).
 * 6. No secret anywhere (AG23 × AG22).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, Workflow, WorkflowNode } from '@landflow/engine';
import { defineCredentialType, definePlugin, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeSmtp } from '../../../plugins/messaging/test/fake-smtp';

vi.setConfig({ testTimeout: 120_000 });

// ---------------------------------------------------------------------------
// The edges
// ---------------------------------------------------------------------------

/** Spotlight's chat model, the architect and the case writer: one fake Anthropic, each turn the next scripted reply. */
const spot = { script: [] as FakeReply[], requests: [] as string[] };
const architect = { script: [] as FakeReply[], cases: '', requests: [] as string[] };
const builder = { answer: '' };
type AnthropicBody = { system?: unknown; messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ name?: string; function?: { name: string } }> };
const fake = await startFakeModels({
  reply: (_provider, raw): FakeReply => {
    const body = (raw ?? {}) as AnthropicBody;
    const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name ?? '');
    if (/You write test cases/.test(system)) return { text: architect.cases };
    if (tools.includes('propose_design')) {
      // A turn after the design's tool result ends the architect's loop; only a first turn takes the next scripted design.
      if (JSON.stringify(body.messages?.at(-1)?.content ?? '').includes('tool_result')) return { text: 'Done.' };
      architect.requests.push(JSON.stringify(body.messages ?? []));
      return architect.script.shift() ?? { text: 'Done.' };
    }
    if (tools.includes('get_run_log')) {
      if ((body.messages ?? []).length === 1) spot.requests.push(JSON.stringify(body.messages));
      return spot.script.shift() ?? { text: 'Yes, it does what you asked.' };
    }
    return { text: builder.answer };
  },
});

/** The agents' own model and the eval gate's judge (scripted). A sales read is called first when offered; Send Email when `mail` is set. */
const agentSide = vi.hoisted(() => ({
  judge: 5,
  invent: 'Last month: North £120k, South £80k, West £95k. North led.',
  mail: undefined as undefined | Record<string, unknown>,
  replies: [] as string[],
  turns: 0,
}));
vi.mock('@/lib/server/agents/models', async () => {
  const { traceChat } = await import('@/lib/server/telemetry/ai');
  return {
    OLLAMA_URL: 'http://127.0.0.1:9',
    modelOptions: async (provider: string) => (provider === 'anthropic' ? [{ provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: '' }] : []),
    agentModel: (config: { provider?: string; model?: string } | undefined): LanguageModel => {
      if (!config?.model) throw new Error('Choose a model for this agent first');
      const usage = { inputTokens: 3, outputTokens: 2 };
      const end = (text: string): ModelTurn => {
        agentSide.replies.push(text);
        return { text, toolCalls: [], stopReason: 'end_turn', usage };
      };
      const turn = (input: Parameters<LanguageModel['generate']>[0]): ModelTurn => {
        if ((input.system ?? '').includes('"score"')) return { text: JSON.stringify({ score: agentSide.judge, reasoning: 'scripted judge' }), toolCalls: [], stopReason: 'end_turn', usage };
        agentSide.turns += 1;
        const last = input.messages.at(-1) as AgentMessage | undefined;
        const read = input.tools.find((t) => /sales/i.test(t.name));
        const mail = input.tools.find((t) => /email/i.test(t.name));
        if (last?.role === 'user') {
          if (read) return { text: '', toolCalls: [{ id: `r${agentSide.turns}`, name: read.name, input: {} }], stopReason: 'tool_use', usage };
          if (mail && agentSide.mail) return { text: '', toolCalls: [{ id: `m${agentSide.turns}`, name: mail.name, input: agentSide.mail }], stopReason: 'tool_use', usage };
          return end(agentSide.invent);
        }
        if (last?.role === 'tool') {
          const content = last.results.map((r) => r.content).join('\n');
          if (/4,150/.test(content)) return end('Last month (October 2026): North 4,150.00, South 2,730.00, West 1,980.00. North sold the most.');
          return end(/denied|approval|refused|nobody gave/i.test(content) ? 'I could not send it.' : 'Emailed on-call a two-line summary.');
        }
        return end(agentSide.invent);
      };
      return {
        provider: config.provider ?? 'anthropic',
        model: config.model,
        generate: (input) => traceChat({ system: 'anthropic', model: config.model! }, async () => turn(input), (t) => ({ responseModel: config.model!, inputTokens: t.usage?.inputTokens ?? 0, outputTokens: t.usage?.outputTokens ?? 0, finishReasons: [] })),
      };
    },
  };
});

/** The browser's client: every call goes to the route handler its path names; each body is kept (join 1 reads them all). */
const wire = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; body: string; answer?: string }>,
  route: undefined as undefined | ((path: string, method: string, body: unknown, onEvent?: (event: string, data: unknown) => void) => Promise<unknown>),
}));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn((path: string, init: { method?: string; json?: unknown } = {}) => wire.route!(path, init.method ?? 'GET', init.json)),
  streamEvents: vi.fn((path: string, body: unknown, onEvent: (event: string, data: unknown) => void) => wire.route!(path, 'POST', body, onEvent)),
}));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

// The strict receiver (contracts/ag4/strict-receiver.cjs's behaviour): 201 for a JSON body with a non-empty `report_text`, else 400.
const receiver = { attempts: [] as Array<{ body: string; status: number }> };
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
    receiver.attempts.push({ body: raw, status: ok ? 201 : 400 });
    if (ok) response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    else response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `Bad Request: the JSON body needs a non-empty string field "report_text" with the report text (got fields: ${Object.keys(parsed).join(', ')})` }));
  });
});
await new Promise<void>((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
const RECEIVER_URL = `http://127.0.0.1:${(receiverServer.address() as AddressInfo).port}/reports/sales`;

// The made-up secrets of this file: none may show in any answer, log, record or session.
const SMTP_PASSWORD = 'pw-ag5-joins-smtp-made-up';
const SALES_SECRET = 'sales-ag5-joins-conn-made-up';
const SECRETS = [SMTP_PASSWORD, SALES_SECRET, 'sk-ant-made-up-for-the-ag5-joins'];
const smtp = await startFakeSmtp({ auth: { user: 'mail', password: SMTP_PASSWORD }, authMethods: ['PLAIN'] });

// The data tool: a read whose output carries the figures, behind a credential type only this file registers.
const salesConn = defineCredentialType({ name: 'salesConn', displayName: 'Sales connection (joins)', properties: [{ name: 'secret', displayName: 'Secret', type: 'string', default: '', typeOptions: { password: true } }] });
class SalesRead implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'salesRead',
    displayName: 'Sales Read',
    description: 'Read last month’s sales by region from the sales database',
    version: 1,
    kind: 'action',
    idempotent: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Read last month’s sales totals by region. No arguments.',
    credentials: [{ name: 'salesConn', required: true }],
    properties: [{ name: 'month', displayName: 'Month', type: 'string', default: 'last' }],
  };
  execute(ctx: IExecuteContext) {
    const conn = ctx.getCredentials<{ secret: string }>('salesConn');
    if (conn.secret !== SALES_SECRET) throw new Error('wrong sales connection');
    return [[{ json: { month: 'October 2026', rows: [{ region: 'North', total: '4,150.00' }, { region: 'South', total: '2,730.00' }, { region: 'West', total: '1,980.00' }] } }]];
  }
}
const salesPlugin = definePlugin({ info: { id: 'salesjoin', name: 'Sales (joins)', version: '0.0.1', description: 'The ag5 joins’ sales read' }, nodes: [new SalesRead()], credentialTypes: [salesConn] } as never);

const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ag5-joins-')),
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://joins-ag5.test',
  LANDFLOW_BUILDER_MODEL: 'anthropic/claude-sonnet-5-5',
  ANTHROPIC_API_KEY: 'sk-ant-made-up-for-the-ag5-joins',
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
const { addCase, adoptedRunOf, listCases } = await import('@/lib/server/agents/eval-gate');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { createOwner } = await import('@/lib/server/auth/users');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { useAutonomyFacts, noteOpened } = await import('@/components/editor/spotlight-autonomy');
const { testUntilItRuns, sendsAllowed } = await import('@/components/editor/test-session');
const { startTypedSession } = await import('@/components/editor/spotlight/typed-session');
await import('@/components/editor/spotlight/agent-ask'); // registers the session's apply and publish hooks
await import('@/components/editor/spotlight/agent-credential-picker'); // registers the one-fitting pick
const { designUnboundAgents } = await import('@/components/editor/spotlight/step-agents');
const { publishVersion } = await import('@/components/editor/publish-control');
const { PublishCardView } = await import('@/components/editor/spotlight/publish-card');
const { publishChange, heldOf } = await import('@/lib/client/agent-change');
const { heldLine: sessionHeldLine } = await import('@/components/editor/fix-session');
const { heldLine: cardHeldLine } = await import('@/lib/shared/agent-eval');
const { approvedByLine, keptOwnFixLine, pickedAloneLine, publishedLine, unattendedLine } = await import('@/lib/shared/fix-autonomy');
const { runVersionsLine } = await import('@/lib/shared/agent-versions');

// ---------------------------------------------------------------------------
// The route table: a path goes to the handler of the file it names under src/app (static segments first, then [x], then [...x])
// ---------------------------------------------------------------------------

const APP = join(import.meta.dirname, '..', 'src', 'app');
function resolveRoute(bare: string): { file: string; params: Record<string, string | string[]> } {
  const segments = bare.split('/').filter(Boolean);
  const params: Record<string, string | string[]> = {};
  let dir = APP;
  for (let i = 0; i < segments.length; i++) {
    const segment = decodeURIComponent(segments[i]!);
    if (existsSync(join(dir, segment, 'route.ts')) || (existsSync(join(dir, segment)) && i < segments.length - 1)) {
      dir = join(dir, segment);
      continue;
    }
    const entries = readdirSync(dir);
    const one = entries.find((e) => /^\[[^.[\]]+\]$/.test(e));
    const rest = entries.find((e) => /^\[{1,2}\.\.\.[^\]]+\]{1,2}$/.test(e));
    if (one && (i < segments.length - 1 ? existsSync(join(dir, one)) : existsSync(join(dir, one, 'route.ts')))) {
      params[one.slice(1, -1)] = segment;
      dir = join(dir, one);
    } else if (rest) {
      params[rest.replace(/^\[+\.\.\./, '').replace(/\]+$/, '')] = segments.slice(i).map(decodeURIComponent);
      dir = join(dir, rest);
      break;
    } else throw new Error(`unrouted ${bare}`);
  }
  const file = join(dir, 'route.ts');
  if (!existsSync(file)) throw new Error(`no route file for ${bare}`);
  return { file, params };
}

/** Every answer a person, Spotlight or the session read (join 6 greps them all). */
const seen = { answers: [] as string[] };
type Handler = (request: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
async function callRoute(path: string, method: string, body?: unknown): Promise<{ status: number; text: string }> {
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const record = { method, path, body: bodyText ?? '' } as (typeof wire.calls)[number];
  wire.calls.push(record);
  const { file, params } = resolveRoute(path.split('?')[0]!);
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, Handler | undefined>;
  const handler = mod[method];
  if (!handler) throw new Error(`no ${method} in ${file}`);
  const response = await handler(new Request(`http://localhost:3000${path}`, { method, headers: { 'content-type': 'application/json' }, ...(bodyText !== undefined && { body: bodyText }) }), { params: Promise.resolve(params) });
  const text = await response.text();
  seen.answers.push(text);
  record.answer = text;
  return { status: response.status, text };
}
wire.route = async (path, method, body, onEvent) => {
  const { status, text } = await callRoute(path, method, body);
  const parsed = (() => {
    try {
      return text && !onEvent ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  })();
  if (status >= 400) {
    let error = parsed;
    if (onEvent) try { error = JSON.parse(text) as Record<string, unknown>; } catch { /* a plain message */ } // eslint-disable-line
    throw new ApiError(String(error?.error ?? text ?? status), status, error);
  }
  if (onEvent) {
    for (const chunk of text.split('\n\n')) {
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
    return undefined;
  }
  return parsed;
};
const api = <T = Record<string, any>>(path: string, method = 'GET', body?: unknown) => wire.route!(path, method, body) as Promise<T>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// The editor: the real stores, with the editor's run (editor.tsx `execute`) and save done through the routes
// ---------------------------------------------------------------------------

let types: ReturnType<typeof registry.nodeTypes>;
const runBodies: Array<Record<string, unknown>> = [];
async function editorRun(command: { kind: string; approvals?: Record<string, unknown>; items?: unknown[] }) {
  const state = useEditor.getState();
  if (state.running || command.kind !== 'run') return;
  state.startRun(false);
  const extra = { ...command.approvals, ...(command.items && { items: command.items }) };
  runBodies.push(extra);
  try {
    await wire.route!(`/api/workflows/${state.workflowId}/run`, 'POST', { workflow: state.toWorkflow(), ...extra }, (event, data) => {
      if (event === 'started') useEditor.setState({ executionId: (data as { executionId: string }).executionId });
      if (event === 'execution' && (data as { type?: string }).type !== 'node.chunk') useEditor.getState().applyEvent(data as never);
    });
  } finally {
    useEditor.getState().finishRun();
  }
}
async function editorSave(): Promise<boolean> {
  const wf = useEditor.getState().toWorkflow();
  const answer = await api<{ workflow: Workflow & { updatedAt: string } }>(`/api/workflows/${wf.id}`, 'PUT', wf);
  useEditor.getState().markSaved(answer.workflow.updatedAt, answer.workflow);
  return true;
}
function openInEditor(id: string, switchOn = true) {
  const wf = store.getWorkflow(id)!;
  useAssistant.getState().reset();
  useEditor.getState().load(wf, types);
  useEditor.setState({ run: (c: never) => void editorRun(c), save: editorSave } as never);
  useAutonomous.setState({ on: switchOn });
  useAutonomyFacts.setState({ switchOn, workflows: {} });
}
async function sessionOver(ms = 90_000) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  while (useAssistant.getState().testing || useAssistant.getState().pending) {
    if (Date.now() - t0 > ms) throw new Error('the session did not end');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const texts = () =>
  useAssistant
    .getState()
    .items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : p.kind === 'outcome' ? [p.outcome.text] : [])) : []));
const cards = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'agentCard' ? [p.card] : [])) : []));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
const node = (id: string, type: string, parameters: Record<string, unknown> = {}, name = id): WorkflowNode => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });
const saveFlow = (wf: Workflow) => store.saveWorkflow(wf, { actor: TEST_OWNER.id });
const call = (tool: string, input: Record<string, unknown> = {}): FakeReply => ({ toolCalls: [{ id: `t${++seq}`, name: tool, arguments: input }] });
let salesCredential: string;
let smtpCredential: string;

/** asks.md W's situation: a published writer with no data tool on a published Webhook flow that posts its reply as `report`. */
async function writerOnWebhook(name: string) {
  const writer = agentStore.create({
    name,
    description: 'Writes a short summary of last month’s sales by region',
    instructions: 'Input: a request for the sales summary.\nSteps:\n1. Write a short summary of last month’s sales by region.\nOutput: a short summary.',
    model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  } as never);
  const oldCase = addCase(writer.id, { input: 'Summarise: the cat sat on the mat.', expected: 'A one-line summary from the text alone.' });
  await api(`/api/agents/${writer.id}/publish`, 'POST', {});
  const id = `wf_ag5_${++seq}`;
  const path = `sales-${id}`;
  saveFlow({
    id,
    name: `Sales report ${id}`,
    nodes: [
      node('hook', 'core.webhook', { path, method: 'POST', respond: 'lastNode' }, 'Reports webhook'),
      node('agent', 'core.messageAgent', { agentId: writer.id, message: 'Write last month’s sales summary by region. {{ JSON.stringify($json.body) }}', conversation: 'new' }, name),
      node('post', 'core.httpRequest', { method: 'POST', url: RECEIVER_URL, bodyType: 'json', body: { report: '{{ $json.reply }}' } }, 'Post to reports'),
    ],
    connections: [edge('hook', 'agent'), edge('agent', 'post')],
  });
  const published = await api<{ published: { versionNumber: number } }>(`/api/workflows/${id}/publish`, 'POST', {});
  return { writer, oldCase, id, path, version: published.published.versionNumber };
}
/** A production run: the published version started from outside, as a trigger would (the webhook handler). */
async function production(path: string): Promise<string> {
  const answer = await callRoute(`/api/webhook/${path}`, 'POST', { request: 'monthly sales report' });
  const executionId = /"executionId":"([^"]+)"/.exec(answer.text)?.[1] ?? (await api<{ executions: Array<{ id: string }> }>(`/api/executions?limit=1`)).executions[0]!.id;
  return executionId;
}
async function trace(executionId: string) {
  return (await api<{ execution: { status: string; versions?: never; runData: Record<string, Array<{ outputs?: Array<Array<{ json: Record<string, unknown> }>> }>> } }>(`/api/executions/${executionId}`)).execution;
}
const DESIGN_SALES = (oldCaseId: string) =>
  call('propose_design', {
    summary: 'Connect the sales database',
    role: 'Writer',
    description: 'Writes a short summary of last month’s sales by region from the sales database',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'Input: a request for the sales summary.\nSteps:\n1. Read last month’s sales by region with the sales read tool.\n2. Write a short summary that gives each region’s total.\nOutput: a short summary.',
    nodeTools: 'salesjoin.salesRead',
    contradictedCases: oldCaseId,
    cases: 'How did sales compare by region last month? => Gives each region’s total from the sales database.\nWhich region sold the most last month? => Names the top region from the sales database.',
  });

beforeAll(async () => {
  enableTestAuth(TEST_OWNER);
  await createOwner({ email: 'owner@joins-ag5.test', name: 'Owner', password: 'landflow-dev-only' });
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(messaging);
  registry.registerBuiltin(salesPlugin);
  types = registry.nodeTypes().filter((t) => t.available);
  salesCredential = credentials.create({ name: 'Sales DB', type: 'salesjoin.salesConn', data: { secret: SALES_SECRET } }).id;
  smtpCredential = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: smtp.port, secure: false, disableStartTls: true, user: 'mail', password: SMTP_PASSWORD } }).id;
});
afterAll(async () => {
  useAssistant.getState().reset();
  await fake.close();
  await smtp.close();
  await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  Object.assign(spot, { script: [], requests: [] });
  Object.assign(architect, { script: [], cases: '', requests: [] });
  Object.assign(agentSide, { judge: 5, mail: undefined, replies: [], turns: 0 });
  builder.answer = '';
  receiver.attempts.length = 0;
  smtp.mails.length = 0;
  wire.calls.length = 0;
  runBodies.length = 0;
  sendsAllowed.clear();
  enableTestAuth(TEST_OWNER);
});

const neverSkipsTheGate = () => {
  for (const c of wire.calls) {
    expect(c.body, `${c.method} ${c.path}`).not.toMatch(/skipEval/);
    expect(c.body, `${c.method} ${c.path}`).not.toMatch(/"agents":"as-published"/);
  }
};

// ---------------------------------------------------------------------------
// 1. The autonomous fix session finishes on a saved, published flow
// ---------------------------------------------------------------------------

describe('1. the autonomous fix session finishes on a saved, published flow (AG22 × AG24 × ag4 AG21)', () => {
  it('run 1 400 → one flow fix with no click → run 2 → the review reads the reply → the agent fix, applied, picked and published (threshold) → run 3 posts the figures → the workflow is published pinning v2 → production posts them', async () => {
    const { writer, oldCase, id, path, version } = await writerOnWebhook('Short writer');
    // P0: production before (the last call the webhook got, which the session then tests with).
    const before = await production(path);
    expect(receiver.attempts.map((a) => a.status)).toEqual([400]);
    expect(runVersionsLine((await trace(before)).versions!)).toBe(`workflow v${version} · Short writer v1`);
    receiver.attempts.length = 0;

    spot.script = [
      call('get_run_log'),
      call('propose_changes', { summary: 'Send the reply as report_text', ops: [{ op: 'setParameters', node: 'Post to reports', parameters: { body: { report_text: '{{ $json.reply }}' } } }] }),
      { text: '“Post to reports”: the endpoint wants report_text. One change: send the reply as report_text.' },
      call('get_run_log'),
      call('propose_agent_fix', { agent: 'Short writer', step: 'Short writer', cause: 'it has no data, so its figures are made up', change: 'Connect it to the sales database so it reads last month’s totals by region.' }),
      { text: 'No, the figures are made up: “Short writer” has no tool that reads the sales. The change connects the sales database.' },
      call('get_run_log'),
      { text: 'Yes, the summary gives each region’s total from the sales database (North 4,150.00).' },
    ];
    architect.script = [DESIGN_SALES(oldCase.id)];

    openInEditor(id);
    expect(startTypedSession('The numbers look made up. Test it and fix it.')).toBe(true);
    await sessionOver();
    const lines = texts();

    // Run 1: a 400 read from the real run log; one setParameters applied with no click; the URL is the person's.
    expect(receiver.attempts.map((a) => a.status)).toEqual([400, 201, 201]);
    expect(lines.some((l) => /I test it with the last call “Reports webhook” got/.test(l))).toBe(true);
    expect(useEditor.getState().nodes.find((n) => n.data.wf.name === 'Post to reports')!.data.wf.parameters).toMatchObject({ url: RECEIVER_URL, body: { report_text: '{{ $json.reply }}' } });
    // The review read the agent step's reply, not only the last node's output.
    expect(spot.requests[1]).toContain('North £120k');
    // The agent change: the data tool added, its cases ask without figures, applied with no click; the one fitting credential picked.
    const draft = agentStore.get(writer.id)!;
    const tool = draft.tools.find((t) => t.type === 'node' && t.nodeType === 'salesjoin.salesRead') as { name: string; credentials?: Record<string, { id: string }> } | undefined;
    expect(tool?.credentials?.salesConn?.id).toBe(salesCredential);
    expect(lines).toContain(pickedAloneLine('Sales DB', tool!.name));
    const cases = listCases(writer.id);
    expect(cases.map((c) => c.input)).not.toContain(oldCase.input);
    expect(cases.every((c) => !/4,?150|2,?730|1,?980|£/.test(`${c.input} ${c.expected ?? ''}`))).toBe(true);
    // Published through the gate on its new cases (the threshold basis), never skipped, never "as published".
    expect(draft.published?.version).toBe(2);
    const agentPublish = wire.calls.filter((c) => c.path === `/api/agents/${writer.id}/publish` && c.method === 'POST').at(-1)!;
    expect(JSON.parse(agentPublish.answer!).gate.verdict).toMatchObject({ ok: true, basis: 'threshold' });
    // The adopted copy shares the draft run's createdAt, so assert on it directly, not on the list's order.
    expect(adoptedRunOf(writer.id, 2)).toBeDefined();
    neverSkipsTheGate();
    // Run 3 posted the real figures; the last line is publishedLine with the new pin.
    expect(JSON.parse(receiver.attempts[2]!.body).report_text).toMatch(/North 4,150/);
    const pub = await api<{ published?: { versionNumber: number } }>(`/api/workflows/${id}/publication`);
    expect(lines.at(-1)).toBe(publishedLine(pub.published!.versionNumber, [{ name: 'Short writer', version: 2 }]));
    expect(cards().every((c) => c.state !== 'designed')).toBe(true); // no card waited for a click
    // Every test run carried Spotlight's approvals with this session; the given destination is the receiver.
    expect(runBodies.every((b) => b.approvals === 'spotlight' && typeof b.sessionId === 'string')).toBe(true);
    expect(runBodies[0]!.destinations).toContain(new URL(RECEIVER_URL).origin);

    // P1: production after runs workflow vM with Short writer v2 and posts the figures.
    const after = await production(path);
    const run = await trace(after);
    expect(run.status).toBe('success');
    expect(runVersionsLine(run.versions!)).toBe(`workflow v${pub.published!.versionNumber} · Short writer v2`);
    expect(JSON.parse(receiver.attempts.at(-1)!.body).report_text).toMatch(/North 4,150/);
    expect(receiver.attempts.at(-1)!.status).toBe(201);
  });

  it('the held branch: the gate holds the new cases at 2.0 → the held line says the score → one more fix from the held cases, whose design would remove the added tool → dropped with the kept line; never skipEval or "as published"', async () => {
    const { writer, oldCase, id, path } = await writerOnWebhook('Held writer');
    await production(path);
    receiver.attempts.length = 0;
    agentSide.judge = 2;
    // The session's own flow fix first is not needed here: the body already says report_text.
    const wf = store.getWorkflow(id)!;
    saveFlow({ ...wf, nodes: wf.nodes.map((n) => (n.id === 'post' ? { ...n, parameters: { ...n.parameters, body: { report_text: '{{ $json.reply }}' } } } : n)) });
    spot.script = [
      call('get_run_log'),
      call('propose_agent_fix', { agent: 'Held writer', step: 'Held writer', cause: 'it has no data, so its figures are made up', change: 'Connect it to the sales database so it reads last month’s totals by region.' }),
      { text: 'No, the figures are made up. The change connects the sales database.' },
    ];
    architect.script = [
      DESIGN_SALES(oldCase.id),
      // The fix from the held cases tries to take the tool back out: the route keeps it (keep), and the session drops the design.
      call('propose_design', { summary: 'Answer from the text', role: 'Writer', description: 'Writes a short summary', model: 'anthropic/claude-sonnet-5-5', instructions: 'Input: a request.\nSteps:\n1. Write a short summary from the text.\nOutput: a short summary.', nodeTools: '' }),
    ];
    openInEditor(id);
    expect(startTypedSession('The numbers look made up. Test it and fix it.')).toBe(true);
    await sessionOver();
    const lines = texts();
    const toolName = (agentStore.get(writer.id)!.tools.find((t) => t.type === 'node') as { name: string }).name;
    const held = heldOf(writer.id);
    expect(held?.average).toBe(2);
    expect(lines).toContain(sessionHeldLine('Held writer', held, undefined));
    expect(lines.some((l) => /2\.0 \/ 5/.test(l))).toBe(true);
    // The second design was asked with the held run's low cases, sent keep, and was dropped: the draft keeps the tool.
    expect(architect.requests).toHaveLength(2);
    const designs = wire.calls.filter((c) => c.path === '/api/agents/design');
    expect(JSON.parse(designs[1]!.body).keep.tools).toContain(toolName);
    expect(lines).toContain(keptOwnFixLine({ summary: `added “${toolName}” to “Held writer”` }));
    expect(agentStore.get(writer.id)!.tools.some((t) => t.type === 'node' && t.nodeType === 'salesjoin.salesRead')).toBe(true);
    expect(agentStore.get(writer.id)!.published?.version).toBe(1); // held: never published anyway
    neverSkipsTheGate();
  });
});

// ---------------------------------------------------------------------------
// 2. Spotlight's approvals in a test run, and the production line
// ---------------------------------------------------------------------------

describe('2. Spotlight’s approvals in a test run, and the production line (AG22 × AG23 × the runtime)', () => {
  const mailer = async (name: string, to: string) => {
    const agent = agentStore.create({
      name,
      description: 'Emails a two-line summary to on-call',
      instructions: 'Email a two-line summary of what you get.',
      model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      tools: [{ id: 'tl_mail', type: 'node', name: 'Send Email', description: 'Email on-call', nodeType: 'messaging.emailSend', parameters: { fromEmail: 'landflow@landflow.test', toEmail: to, subject: 'Summary', emailFormat: 'text', text: 'Summary' }, credentials: { smtp: { id: smtpCredential, name: 'Mailpit SMTP' } }, requireApproval: true }],
    } as never);
    addCase(agent.id, { input: 'Summarise: the deploy finished.', expected: 'A two-line summary.' });
    await api(`/api/agents/${agent.id}/publish`, 'POST', {});
    const id = `wf_ag5_mail_${++seq}`;
    saveFlow({ id, name: `Mail ${id}`, nodes: [node('hook', 'core.webhook', { path: id, method: 'POST' }, 'Webhook'), node('agent', 'core.messageAgent', { agentId: agent.id, message: 'Summarise: the deploy finished.', conversation: 'new' }, name)], connections: [edge('hook', 'agent')], pinData: { hook: [{ json: { body: { text: 'the deploy finished' } } }] } } as never);
    return { agent, id };
  };

  it('the session’s run lets Spotlight approve Send Email to the given address (one mail) and says so; with no fix it offers Publish (never publishes by itself), and the unattended refusal is named', async () => {
    const { agent, id } = await mailer('Oncall mailer', 'oncall@landflow.test');
    agentSide.mail = { subject: 'Summary' };
    openInEditor(id);
    expect(startTypedSession('Run it now.')).toBe(true);
    await sessionOver();
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]!.to).toEqual(['oncall@landflow.test']);
    const executionId = useEditor.getState().executionId!;
    const run = await trace(executionId);
    const steps = (run.runData.agent?.at(-1)?.outputs?.[0]?.[0]?.json as { steps: Array<{ approvedBy?: string }>; sessionId: string });
    expect(steps.steps[0]!.approvedBy).toBe(approvedByLine({ kind: 'spotlight', userId: TEST_OWNER.id, sessionId: 'x' }, true));
    const session = agentStore.getSession(steps.sessionId)!;
    expect(session.timeline.find((e) => e.type === 'tool')).toMatchObject({ by: { kind: 'spotlight', userId: TEST_OWNER.id } });
    // The session fixed nothing, so it publishes nothing by itself: the Publish card waits for the person's click (an untouched
    // draft is never published without one). The unattended route, which the publish card reads, lists Send Email for the webhook.
    const actions = useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'action' ? [p.action] : [])) : []));
    expect(actions).toContain('publish');
    expect(texts().some((l) => l.startsWith('Published: workflow v'))).toBe(false);
    expect(store.getWorkflow(id)!.active ?? false).toBe(false);
    const lines = await api<Array<{ tool: string; trigger: string; line: string }>>(`/api/workflows/${id}/unattended-approvals?version=draft`);
    expect(lines).toEqual([expect.objectContaining({ tool: 'Send Email', trigger: 'webhook', line: unattendedLine('Send Email', 'webhook') })]);
    // The person publishes; a trigger run of the published version still refuses it: nothing sent.
    await api(`/api/workflows/${id}/publish`, 'POST', {});
    smtp.mails.length = 0;
    agentSide.mail = { subject: 'Summary' };
    const prod = await production(id);
    const json = (await trace(prod)).runData.agent?.at(-1)?.outputs?.[0]?.[0]?.json as { steps: Array<{ status: string }> };
    expect(json.steps[0]!.status).toBe('denied');
    expect(smtp.mails).toHaveLength(0);
    void agent;
  });

  it('a call to an address nobody gave waits (Needs you); asks first sends no approvals; a viewer or the test-update run is refused the field', async () => {
    const { id } = await mailer('Loose mailer', "={{ $fromAI('to', 'who gets it', 'string') }}");
    agentSide.mail = { to: 'x@elsewhere.test', subject: 'Summary' };
    openInEditor(id);
    expect(startTypedSession('Run it now.')).toBe(true);
    await sessionOver();
    expect(smtp.mails).toHaveLength(0);
    expect((await trace(useEditor.getState().executionId!)).status).toBe('waiting');
    expect(texts().some((l) => /^A test run waits for your approval of “Send Email”: Needs you/.test(l))).toBe(true);
    // Asks first: the session's run carries no approvals at all (and the call is not sent).
    runBodies.length = 0;
    openInEditor(id, false);
    useEditor.setState({ pinData: { hook: [{ json: { body: { text: 'x' } } }] } } as never);
    sendsAllowed.set(id, new Set(['oncall@landflow.test']));
    expect(startTypedSession('Run it now.')).toBe(true);
    await sessionOver();
    expect(runBodies.every((b) => b.approvals === undefined)).toBe(true);
    expect(smtp.mails).toHaveLength(0);
    // No run access, or the production graph's test-update run: the field is refused.
    const body = { approvals: 'spotlight', sessionId: 'test_x', destinations: ['x@elsewhere.test'] };
    enableTestAuth({ ...TEST_OWNER, id: 'usr_viewer', email: 'viewer@joins-ag5.test', role: 'viewer' });
    expect([400, 403, 404]).toContain((await callRoute(`/api/workflows/${id}/run`, 'POST', body)).status);
    enableTestAuth(TEST_OWNER);
    expect((await callRoute(`/api/workflows/${id}/test-update`, 'POST', { agents: [], ...body })).status).toBe(400);
    expect(smtp.mails).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The first flow ask uses a saved agent, then the session fixes it
// ---------------------------------------------------------------------------

describe('3. the first flow ask uses a saved agent, then the session reaches the review (AG25 × AG22)', () => {
  it('an inline AI Agent with no model becomes a Run an Agent step; its agent is designed, created, smoke-tested and published on the new draft; the session’s review reads its reply', async () => {
    const ASK = `Every weekday at 8:00, have an agent write last month's sales summary by region, then post it to our reports endpoint at ${RECEIVER_URL}.`;
    builder.answer = JSON.stringify({
      name: 'Sales summary',
      nodes: [
        { key: 'a', type: 'core.schedule', name: 'Weekdays at 8', parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } } },
        { key: 'b', type: 'core.aiAgent', name: 'Write summary', parameters: { prompt: "Write last month's sales summary by region" } },
        { key: 'c', type: 'core.httpRequest', name: 'Post it', parameters: { method: 'POST', url: RECEIVER_URL, bodyType: 'json', body: { report_text: '{{ $json.reply }}' } } },
      ],
      connections: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    });
    const { draft } = await api<{ draft: { nodes: Array<{ key: string; type: string; name: string; parameters: Record<string, unknown> }>; edges: Array<[string, string, number, string]>; newAgents?: Record<string, never>; reuses?: string[] } }>('/api/ai/build', 'POST', { prompt: ASK, staged: false }) /* the one-shot draft: the plan path is AG25's own test */;
    expect(draft.nodes.map((n) => n.type)).not.toContain('core.aiAgent');
    const step = draft.nodes.find((n) => n.type === 'core.messageAgent')!;
    expect(step).toBeTruthy();
    const id = `wf_ag5_new_${++seq}`;
    saveFlow({ id, name: 'Sales summary', nodes: draft.nodes.map((n) => node(n.key, n.type, n.parameters, n.name)), connections: draft.edges.filter((e) => e[3] === 'main').map(([from, to]) => edge(from, to)) });
    openInEditor(id);
    noteOpened(id, 0); // a brand-new draft
    const agentsBefore = agentStore.list().length;
    if (!step.parameters.agentId) {
      architect.script = [call('propose_design', { summary: 'A sales summary writer', role: 'Writer', description: 'Writes last month’s sales summary by region', model: 'anthropic/claude-sonnet-5-5', instructions: 'Input: a request.\nSteps:\n1. Write last month’s sales summary by region.\nOutput: a short summary.', nodeTools: '', cases: 'Write the sales summary. => A short summary by region.\nWhich region led? => Names a region.\nHow did the regions compare? => Compares the regions in a few lines.' })];
      architect.cases = 'Write last month’s sales summary by region. => A short summary by region.\nWhich region led last month? => Names the top region.\nHow did the regions compare? => Compares the regions in a few lines.';
      await designUnboundAgents([step.key], ASK, draft.newAgents ?? {});
    } else expect(draft.reuses?.some((r) => r.startsWith('Reuses “'))).toBe(true); // reused: the summary says which agent
    const bound = useEditor.getState().nodes.find((n) => n.id === step.key)!.data.wf.parameters.agentId as string;
    expect(bound).toMatch(/^ag_/);
    const agent = agentStore.get(bound)!;
    expect(agent.published).toBeTruthy();
    expect(agent.config?.model ?? agent.model).toBeTruthy();
    expect(agentStore.list().length).toBe(step.parameters.agentId ? agentsBefore : agentsBefore + 1);
    spot.script = [{ text: 'Yes, the step wrote the summary and it was posted.' }];
    await testUntilItRuns(ASK);
    await sessionOver();
    expect(spot.requests.at(-1)).toContain('Last month');
    expect(spot.requests.at(-1)).toContain('Does that do what I asked for');
  });
});

// ---------------------------------------------------------------------------
// 4. A held publish says its score everywhere
// ---------------------------------------------------------------------------

describe('4. a held publish says its score everywhere (AG24 × AG22 × the publish card)', () => {
  it('publishChange, the workflow publish with publish-first (twice) and the session’s line all hold the average, the basis and the reason; the card renders it', async () => {
    const { writer, oldCase, id } = await writerOnWebhook('Gate writer');
    // A draft that replaced its cases (the session's change), judged 2 by the scripted judge.
    const current = agentStore.get(writer.id)!;
    agentStore.write({ ...current, tools: [{ id: 'tl_s', type: 'node', name: 'sales_read', description: 'Read sales', nodeType: 'salesjoin.salesRead', parameters: {}, credentials: { salesConn: { id: salesCredential, name: 'Sales DB' } } }] } as never);
    await api(`/api/agents/${writer.id}/eval-gate`, 'PATCH', { remove: [oldCase.id], add: [{ input: 'How did sales compare by region last month?', expected: 'Gives each region’s total from the sales database.' }] });
    agentSide.judge = 2;
    const viaCard = await publishChange(writer.id);
    expect(viaCard.state).toBe('held');
    const held = heldOf(writer.id)!;
    expect(held).toMatchObject({ average: 2, basis: 'threshold' });
    const session = sessionHeldLine('Gate writer', held, viaCard.reason);
    expect(session).toContain('2.0 / 5');
    expect(session).toContain('judged on its new cases');
    for (let attempt = 1; attempt <= 2; attempt++) {
      let thrown: InstanceType<typeof ApiError> | undefined;
      await publishVersion(id, { agents: 'publish-first' }).catch((e: InstanceType<typeof ApiError>) => (thrown = e));
      expect(thrown?.status, `attempt ${attempt}`).toBe(409);
      const verdict = (thrown!.body as { code?: string; gate?: { verdict?: { average: number; basis: string; reason: string } } }).gate?.verdict;
      expect(verdict).toMatchObject({ average: 2, basis: 'threshold' });
      expect(verdict!.reason).toBe(held.reason);
      const html = renderToStaticMarkup(createElement(PublishCardView, { itemId: 'i_held', offer: { workflowId: id, kind: 'draft', nextVersion: 3, pins: [], blocks: [{ agentId: writer.id, name: 'Gate writer', published: 1, changes: ['Tools'] }] } as never, card: { phase: 'failed', error: thrown!.message, held: verdict } as never }));
      expect(html).toContain('publish-held');
      expect(html).toContain(cardHeldLine(verdict as never).replace(/&/g, '&amp;').replace(/“/g, '“'));
      expect(html).toContain('2.0 / 5');
    }
    neverSkipsTheGate();
  });
});

// ---------------------------------------------------------------------------
// 5. The contract copy
// ---------------------------------------------------------------------------

describe('5. the contract copy is byte-identical (LANDFLOW_BACKBONE_CONTRACTS)', () => {
  const contracts = process.env.LANDFLOW_BACKBONE_CONTRACTS;
  it.skipIf(!contracts)('apps/web/src/lib/shared/fix-autonomy.ts = contracts/ag5/fix-autonomy.ts', () => {
    expect(readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'shared', 'fix-autonomy.ts'), 'utf8')).toBe(readFileSync(join(contracts!, 'ag5', 'fix-autonomy.ts'), 'utf8'));
  });
});

// ---------------------------------------------------------------------------
// 6. No secret anywhere
// ---------------------------------------------------------------------------

describe('6. no secret anywhere (AG23 × AG22)', () => {
  it('every route answer, run record, agent session and design answer of joins 1–4 holds none of the made-up secrets', async () => {
    const records: string[] = [...seen.answers];
    for (const agent of agentStore.list()) for (const s of agentStore.listSessions(agent.id, 200)) records.push(JSON.stringify(agentStore.getSession(s.id)));
    for (const e of (await api<{ executions: Array<{ id: string }> }>('/api/executions?limit=100')).executions) records.push(JSON.stringify(await store.loadExecution(e.id)));
    expect(records.length).toBeGreaterThan(20);
    const all = records.join('\n');
    for (const secret of SECRETS) expect(all.includes(secret), secret).toBe(false);
  });
});
