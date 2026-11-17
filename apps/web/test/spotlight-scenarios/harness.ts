/**
 * Drives one Spotlight scenario once, through the product's own code, and returns what happened (`Outcome`).
 * docs/development.md "Spotlight scorecard"; the types and the checks are ./scenario.ts.
 *
 * Unit form: the model is scripted (`scriptedModel`) or, where the product reaches for Ollama itself (the builder, the
 * agent designer, the Agent architect), a local fake Ollama (`test/fake-ai-services.ts`) answering the same script.
 * Live form: the real route on the local model (`LANDFLOW_SPOTLIGHT_MODEL` on `OLLAMA_URL`).
 * Nothing here talks to anything but this machine; the live form runs with ./local-only.cjs loaded by the runner.
 */
import './env';
import { summaryText, type DraftSummary } from '@/lib/shared/draft-summary'; // SB15:
import { createRequire } from 'node:module';
import { nanoid } from 'nanoid';
import { definePlugin, defineNode, type PropertyDescriptor } from '@landflow/sdk';
import { Linear } from '../../../../plugins/linear/src/nodes/linear'; // SB10: the unit form's Linear stand-in carries its real operations
import type { ModelTurn, NodeRun, Workflow } from '@landflow/engine';
import { applyOps, type AssistantOp, type RunDigest } from '@/lib/shared/assistant-ops';
import { needsAClick, type Autonomy } from '@/components/editor/spotlight-autonomy';
import type { AgentConfig } from '@/lib/shared/agents';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { registryLookup } from '@/lib/server/assistant/ops';
import { agentStore } from '@/lib/server/agents/store';
import { handler } from '@/lib/server/http';
import { startFakeModels, readSse, type FakeModels } from '../fake-ai-services';
import { scriptedModel, touchedNodes, type Check, type Job, type Outcome, type Scenario, type Start, type ScriptTurn } from './scenario';

export type Form = 'unit' | 'live';

export interface RunOptions {
  /** Live: the Ollama model the routes are asked for. */
  model?: string;
  /** Live: the echo server the scenarios' `http://127.0.0.1:3399/…` URLs point at. */
  echo?: { port: number; log: string[] };
}

export const ECHO_PORT = 3399;

/**
 * SB10 (carryover item 5): `LANDFLOW_OUTBOUND_ALLOW` for a scenario's live runs. Only `start.outbound: 'allowed'` lets
 * loopback through (127.0.0.1 and localhost, nothing wider); the default and `blocked` leave it unset, so the host refuses
 * a run to 127.0.0.1 as on a fresh install. Before sb2 the live form allowed it whenever an echo server ran.
 */
export function outboundAllow(scenario: Pick<Scenario, 'start'>, form: Form): string | undefined {
  return form === 'live' && scenario.start?.outbound === 'allowed' ? '127.0.0.1,localhost' : undefined;
}

/**
 * The outbound environment of a live run, set outright: the scorecard runs in vitest (development profile), where the host
 * does not block private addresses unless told to, so both variables are set (`LANDFLOW_OUTBOUND_BLOCK_PRIVATE=true`; the
 * allow list only for `allowed`). Unit form: nothing.
 */
export function outboundEnv(scenario: Pick<Scenario, 'start'>, form: Form): Record<'LANDFLOW_OUTBOUND_BLOCK_PRIVATE' | 'LANDFLOW_OUTBOUND_ALLOW', string | undefined> | undefined {
  if (form !== 'live') return undefined;
  return { LANDFLOW_OUTBOUND_BLOCK_PRIVATE: 'true', LANDFLOW_OUTBOUND_ALLOW: outboundAllow(scenario, form) };
}

/** The live form runs only when LANDFLOW_INTEGRATION names `spotlight`. */
export const liveEnabled = (env: Record<string, string | undefined> = process.env): boolean => (env.LANDFLOW_INTEGRATION ?? '').split(',').map((s) => s.trim()).includes('spotlight');

/** The guard's refusals so far; empty when it is not loaded (the unit form). */
function refusedNow(): string[] {
  // Never load the guard from here: only the live runner does (requiring it installs it).
  if (!(globalThis as Record<symbol, unknown>)[Symbol.for('landflow.localOnly')]) return [];
  try {
    return (createRequire(import.meta.url)('./local-only.cjs') as { refused: () => string[] }).refused();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The registry the scenarios run against
// ---------------------------------------------------------------------------

/** Stand-ins for the Slack and Linear nodes (their plugins are separate processes): the properties the scenarios touch. */
function stand(plugin: string, name: string, displayName: string, properties: string[], real: PropertyDescriptor[] = []) {
  return definePlugin({
    info: { id: plugin, name: `${displayName} (stand-in)`, version: '0.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: {
          name,
          displayName,
          description: displayName,
          version: 1,
          kind: 'action',
          inputs: [{ type: 'main' }],
          outputs: [{ type: 'main' }],
          properties: [...properties.filter((p) => !real.some((r) => r.name === p)).map((p) => ({ name: p, displayName: p, type: 'string' as const, default: '' })), ...real],
        },
        async execute() {
          return [[{ json: {} }]];
        },
      }),
    ],
  });
}

let prepared = false;
/**
 * Register the core plugin and, for the unit form, stand-ins for Slack and Linear; seed one published agent. The live
 * form builds against the catalog a person has: the bundled Linear and Messaging plugins (`prepareLive`), not stand-ins.
 */
export function prepare(options: { live?: boolean } = {}): void {
  if (prepared) return;
  prepared = true;
  registry.registerBuiltin(corePlugin);
  if (!options.live && !process.env.LANDFLOW_SPOTLIGHT_PLUGINS) {
    registry.registerBuiltin(stand('messaging', 'slack', 'Slack', ['authentication', 'resource', 'operation', 'channelId', 'text', 'blocksUi', 'otherOptions']));
    // SB10: Linear's own `resource` and `operation` properties (with each operation's `outputSchema`), so a scenario's prompt shows the real fields.
    registry.registerBuiltin(stand('linear', 'linear', 'Linear', ['authentication', 'resource', 'operation', 'since', 'returnAll', 'limit', 'activityOptions'], Linear.description.properties.filter((p) => p.name === 'resource' || p.name === 'operation')));
  }
  // The agent the evaluation's chat flow ("my Support triage agent") picks: made-up, published.
  if (!agentStore.list().some((a) => a.published?.config.name === 'Support triage')) {
    const agent = agentStore.create({ name: 'Support triage', description: 'Answers support questions from the docs and hands over what it cannot answer.', instructions: 'Answer support questions.', model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    agentStore.publish(agent.id);
  }
}

/**
 * Live form: register the bundled plugins the scenarios use, in this process (their node code is the product's; no
 * server to start), unless `LANDFLOW_SPOTLIGHT_PLUGINS` names endpoints that serve them (`addPlugins`).
 */
export async function prepareLive(): Promise<string[]> {
  if (process.env.LANDFLOW_SPOTLIGHT_PLUGINS) return [];
  const added: string[] = [];
  for (const dir of ['linear', 'messaging']) {
    // A computed path: the plugins are packages of their own, outside this app's type roots.
    const path = ['..', '..', '..', '..', 'plugins', dir, 'src', 'main'].join('/');
    const { plugin } = (await import(/* @vite-ignore */ new URL(path, import.meta.url).href)) as { plugin: Parameters<typeof registry.registerBuiltin>[0] };
    registry.registerBuiltin(plugin);
    added.push(dir);
  }
  return added;
}

/** Live form: add the plugin endpoints named in LANDFLOW_SPOTLIGHT_PLUGINS (comma-separated, local URLs only). */
export async function addPlugins(): Promise<string[]> {
  const added: string[] = [];
  for (const endpoint of (process.env.LANDFLOW_SPOTLIGHT_PLUGINS ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    await registry.addEndpoint(endpoint, 'manual');
    added.push(endpoint);
  }
  return added;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const lookup = () => registryLookup(registry.nodeTypes());

/** A scenario's canvas with the echo URLs pointed at this run's echo server. */
function canvasOf(scenario: Scenario, options: RunOptions): Workflow | undefined {
  const wf = scenario.start?.workflow;
  if (!wf) return undefined;
  const port = options.echo?.port;
  const copy = JSON.parse(JSON.stringify(wf)) as Workflow;
  return port && port !== ECHO_PORT ? (JSON.parse(JSON.stringify(copy).replaceAll(`127.0.0.1:${ECHO_PORT}`, `127.0.0.1:${port}`)) as Workflow) : copy;
}

/** A string with the echo URLs pointed at this run's echo server. */
const echoed = (text: string, options: RunOptions): string => (options.echo?.port && options.echo.port !== ECHO_PORT ? text.replaceAll(`127.0.0.1:${ECHO_PORT}`, `127.0.0.1:${options.echo.port}`) : text);

const idOf = (wf: Workflow | undefined, name: string | undefined) => (name ? (wf?.nodes.find((n) => n.name === name || n.id === name)?.id ?? name) : undefined);

/** `start.runs` (by node name) as the editor sends them (by node id). */
function runsById(wf: Workflow | undefined, runs: Record<string, RunDigest> | undefined): Record<string, RunDigest> | undefined {
  if (!runs) return undefined;
  return Object.fromEntries(Object.entries(runs).map(([name, digest]) => [idOf(wf, name)!, digest]));
}

/**
 * What the model's script turn looks like to Ollama's API: tool inputs are `arguments`. A function turn gets an empty
 * request here (the build, design and architect forms reach the fake over HTTP), so function-form scripts cannot
 * inspect the request in those forms; chat and session scripts get the real one.
 */
function fakeReplyOf(script: ScriptTurn[]) {
  const left = [...script];
  return (_provider: unknown, body: unknown) => {
    // A request that is no chat (the model list the Agent architect reads first) spends no turn of the script.
    if (!Array.isArray((body as { messages?: unknown } | undefined)?.messages)) return { text: '', toolCalls: [] };
    const next = left.shift();
    if (!next) throw new Error('No scripted turn left');
    let turn: Partial<ModelTurn>;
    try {
      turn = typeof next === 'function' ? next({ system: '', messages: [], tools: [] } as never) : next;
    } catch (thrown) {
      // A turn that throws is the server's error: "Ollama error 500: {…}" answers 500 with that body.
      const message = (thrown as Error).message;
      const parts = /^\w+ error (\d{3}):\s*([\s\S]*)$/.exec(message);
      return { error: { status: parts ? Number(parts[1]) : 500, body: parts ? parts[2] : JSON.stringify({ error: message }) } };
    }
    return { text: turn.text ?? '', toolCalls: (turn.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.input })) };
  };
}

/** Run `fn` as the synthetic owner of test/setup.ts: through the product's own `handler()`, so the request context exists. */
async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  let failure: unknown;
  const response = await handler(async (_request: Request) => {
    try {
      result = await fn();
    } catch (e) {
      failure = e;
    }
    return new Response('{}');
  })(new Request('http://localhost/spotlight-scenarios'));
  void response;
  if (failure) throw failure;
  return result as T;
}

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A build's `FlowDraft` as a workflow, as the editor's template apply lays it out: ids are the keys. */
export function draftToWorkflow(draft: { name?: string; nodes: Array<{ key: string; type: string; name: string; parameters?: Record<string, unknown> }>; edges: Array<[string, string, number?, string?]>; pinData?: Workflow['pinData'] }): Workflow {
  return {
    id: 'draft',
    name: draft.name ?? 'Draft',
    active: false,
    nodes: draft.nodes.map((n, i) => ({ id: n.key, name: n.name, type: n.type, typeVersion: 1, position: [i * 280, 0] as [number, number], parameters: n.parameters ?? {} })),
    connections: draft.edges.map(([source, target, output, type], i) => ({ id: `e${i}`, source, target, sourceIndex: output ?? 0, targetIndex: 0, type: (type ?? 'main') as 'main' })),
    pinData: draft.pinData ?? {},
    settings: {},
  } as Workflow;
}

interface Collected {
  text: string;
  tools: string[];
  proposals: Outcome['proposals'];
  done?: { steps: number; model?: string; usage: { inputTokens: number; outputTokens: number } };
  error?: string;
  drafts: Array<Partial<AgentConfig>>;
  asked: Array<{ question: string; choices: string[] }>; // SB11:
  offers: NonNullable<Outcome['offers']>; // SB12:
}

function collect(events: Array<{ event: string; data: any }>): Collected { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Collected = { text: '', tools: [], proposals: [], drafts: [], asked: [], offers: [] };
  for (const { data } of events) {
    switch (data.type) {
      case 'text':
        out.text = data.text;
        break;
      case 'tool':
        out.tools.push(data.name);
        break;
      case 'proposal':
        out.proposals.push({ summary: data.summary, ops: data.ops, dropped: data.dropped ?? [], warnings: data.warnings ?? [] });
        break;
      case 'ask': // SB11:
        out.asked.push({ question: data.question, choices: data.choices });
        break;
      case 'draft':
        out.drafts.push(data.config);
        break;
      case 'credential': out.offers.push({ node: data.node, credentialTypes: data.credentialTypes }); break; // SB12:
      case 'done':
        out.done = data;
        break;
      case 'error':
        out.error = data.message;
        break;
    }
  }
  return out;
}

const agentOf = (config: Partial<AgentConfig>, published = false): Outcome['agents'][number] => ({
  name: config.name ?? '',
  ...(config.model && { model: `${config.model.provider}/${config.model.model}` }),
  tools: (config.tools ?? []).filter((t) => t.type !== 'knowledge').map((t) => ('name' in t && t.name ? t.name : t.type)),
  knowledge: (config.tools ?? []).some((t) => t.type === 'knowledge'),
  published,
});

// ---------------------------------------------------------------------------
// One chat message
// ---------------------------------------------------------------------------

type Scripted = ReturnType<typeof scriptedModel>;

interface ChatCall {
  ask: string;
  workflow: Workflow;
  selected?: string;
  runs?: Record<string, RunDigest>;
  session?: 'fix' | 'review' | 'auto';
  /** SB07: the scope by node id (`null`: lifted), and the steps tagged with @, by id. */
  scope?: { kind: 'selected' | 'tagged' | 'only' | 'insert'; nodes: string[]; side?: 'after' | 'before' } | null;
  tagged?: string[];
  /** SB19: the model the picker sends. */
  model?: string;
}

/**
 * The editor's request: `messages`, `workflow`, `workflowId`, `selectedNodeId`, `runs`, `session`
 * (components/editor/assistant.ts send()). Live, the real route; unit, `runChat` directly with what the route builds for
 * it (route.ts: `allowedTypes`, `roster()`, `tagMentions`), because the route takes the model as a string and the scripted
 * one is an object. That seam is here and nowhere in the product.
 */
async function chatOnce(call: ChatCall, form: Form, scripted: Scripted | undefined, options: RunOptions): Promise<Collected & { calls: number }> {
  const body = {
    messages: [{ role: 'user', content: call.ask }],
    workflow: call.workflow,
    workflowId: call.workflow.id,
    ...(call.selected && { selectedNodeId: call.selected }),
    ...(call.runs && { runs: call.runs }),
    ...(call.session && { session: call.session }),
    ...(call.scope !== undefined && { scope: call.scope }), // SB07:
    ...(call.tagged?.length && { mentions: { refs: call.tagged.map((id) => ({ type: 'node' as const, id, workflowId: call.workflow.id })) } }), // SB07:
  };
  if (form === 'live') {
    const route = await import('@/app/api/assistant/chat/route');
    const response = await route.POST(post('/api/assistant/chat', { ...body, model: call.model ?? options.model ?? 'qwen3-coder:30b' /* SB19: */ }));
    if (!response.ok) return { ...collect([]), error: `chat ${response.status}`, calls: 0 };
    const collected = collect(await readSse(response));
    return { ...collected, calls: collected.done?.steps ?? 0 };
  }
  const { runChat, tagMentions } = await import('@/lib/server/assistant/chat');
  const { roster } = await import('@/lib/server/assistant/roster');
  const { allowedTypes, meteredWorkflowId } = await import('@/lib/server/assistant/scope');
  const { routeActor } = await import('@/lib/server/projects/http');
  // One scripted model for the whole scenario (see `runScenario`): its turns are consumed once across every message.
  const { model, calls } = scripted ?? scriptedModel([]);
  const callsBefore = calls.length;
  const { currentPrincipal } = await import('@/lib/server/auth/guard');
  const events: Array<{ event: string; data: unknown }> = [];
  await asOwner(async () => {
    const types = allowedTypes(call.workflow.id);
    const { agents, teams } = roster();
    const actorId = currentPrincipal()?.user?.id;
    const tagged = await tagMentions(routeActor(), (body.mentions?.refs ?? []) as never, { // SB07: refs from start.tagged
      workflow: call.workflow, workflowId: call.workflow.id, types, ...(call.runs && { runs: call.runs }) });
    await runChat({
      messages: body.messages as never,
      workflow: { ...call.workflow, id: meteredWorkflowId(call.workflow.id) ?? 'draft' } as Workflow,
      ...(call.selected && { selectedNodeId: call.selected }),
      ...(call.runs && { runs: call.runs }),
      ...(call.session && { session: call.session }),
      ...(call.scope !== undefined && { scope: call.scope }), // SB07:
      model,
      types,
      teams,
      agents,
      tagged,
      trace: true,
      actor: routeActor(),
      ...(actorId && { userId: actorId }),
      onEvent: (event) => events.push({ event: event.type, data: event }),
    });
  });
  return { ...collect(events as never), calls: calls.length - callsBefore };
}

/** SB07: `start.scope` and `start.tagged` (by node name) as the request's ids. */
function scopeOfStart(canvas: Workflow, start: Start | undefined): Pick<ChatCall, 'scope' | 'tagged'> {
  const ids = (names: string[]) => names.flatMap((name) => canvas.nodes.filter((n) => n.name === name).map((n) => n.id));
  return {
    ...(start?.scope !== undefined && { scope: start.scope === null ? null : { ...start.scope, nodes: ids(start.scope.nodes) } }),
    ...(start?.tagged?.length && { tagged: ids(start.tagged) }),
  };
}

/** Apply every proposal with the product's `applyOps`, as Apply does. */
function applyAll(workflow: Workflow, proposals: Outcome['proposals']): Workflow {
  let wf = workflow;
  for (const proposal of proposals) wf = applyOps(wf, proposal.ops as AssistantOp[], lookup(), { newId: () => `n_${nanoid(6)}` }).workflow;
  return wf;
}

/**
 * `start.autonomy` (SB03, SB04; spotlight-autonomy.ts): asks-first leaves every card waiting for Apply, nobody clicks it
 * here, so the canvas stays as it was; auto applies a card unless it needs a click (it removes a step or leaves one
 * without its input). Unset: every card is applied, the measure SB00's scenarios were written against.
 */
function applyAsTheEditor(workflow: Workflow, proposals: Outcome['proposals'], autonomy: Autonomy | undefined): Workflow {
  if (autonomy === 'asks-first') return workflow;
  if (!autonomy) return applyAll(workflow, proposals);
  const graph = { nodes: workflow.nodes.map((n) => ({ id: n.id, name: n.name })), connections: workflow.connections };
  return applyAll(workflow, proposals.filter((p) => needsAClick(p.ops, graph).length === 0));
}

/** The cards of the session's replies still waiting for Apply (no state yet). */
function undecided(items: ReadonlyArray<{ role: string; parts?: ReadonlyArray<{ kind: string; proposal?: { state?: string } }> }>): number {
  return items.reduce((n, item) => n + (item.role === 'assistant' ? (item.parts ?? []).filter((p) => p.kind === 'proposal' && !p.proposal?.state).length : 0), 0);
}

// ---------------------------------------------------------------------------
// The session: Spotlight's test-and-fix loop on the editor's stores, in Node
// ---------------------------------------------------------------------------

async function sessionOf(scenario: Scenario, form: Form, options: RunOptions, first: Collected, canvas: Workflow, afterChat: Workflow, scripted: Scripted | undefined) {
  const { useEditor } = await import('@/components/editor/store');
  const { useAssistant, runDigests } = await import('@/components/editor/assistant');
  const { testUntilItRuns, approveDestinations, sendsAllowed } = await import('@/components/editor/test-session');
  const { statusesOf } = await import('@/lib/client/run-data');
  const types = registry.nodeTypes();
  useAssistant.getState().reset();
  // The canvas as the editor gives it back (its own field order and defaults), so `before` and `after` compare like for like.
  useEditor.getState().load(canvas, types);
  const before = useEditor.getState().toWorkflow();
  useEditor.getState().load(afterChat, types);
  // SB03: the person's yes to test runs that send for real, by destination (`start.approvedDestinations`); none by default.
  const workflowId = useEditor.getState().workflowId;
  sendsAllowed.delete(workflowId);
  approveDestinations(workflowId, (scenario.start?.approvedDestinations ?? []).map((d) => echoed(d, options)));
  const rounds = scenario.start?.sessionRuns ?? [];
  const roundOf = (all: typeof rounds, i: number) => all[Math.min(Math.max(i, 0), Math.max(all.length - 1, 0))] ?? {};
  let round = 0;

  // The editor's run: scripted rounds (unit) or the product's runner on the canvas, in this process (live).
  useEditor.setState({
    run: (async () => {
      useEditor.setState({ running: true, runStatus: undefined, statuses: {} });
      const nodes = useEditor.getState().nodes;
      if (form === 'unit') {
        // The run is seen going (the session waits for it to start) before it ends.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const thisRound = roundOf(rounds, round++);
        const statuses = Object.fromEntries(
          nodes.flatMap((n) => {
            const r = thisRound[n.data.wf.name];
            return [[n.id, r?.error ? { state: 'error' as const, error: r.error, itemCounts: [0] } : { state: 'success' as const, itemCounts: [r?.items ?? 1] }]];
          }),
        );
        const failed = Object.values(statuses).some((s) => s.state === 'error');
        // What the editor keeps of a run (`useEditor.runs`), which `runDigests()` hands to the assistant.
        const runs = Object.fromEntries(
          nodes.map((n) => {
            const r = thisRound[n.data.wf.name];
            const run: NodeRun = {
              startedAt: new Date().toISOString(),
              durationMs: 5,
              status: r?.error ? 'error' : 'success',
              source: 'main',
              inputs: [[{ json: {} }]],
              outputs: [r?.error ? [] : Array.from({ length: r?.items ?? 1 }, () => ({ json: {} }))],
              ...(r?.error && { error: { message: r.error } }),
            };
            return [n.id, [run]];
          }),
        );
        useEditor.setState({ running: false, statuses, runs, runStatus: failed ? 'error' : 'success' });
        return;
      }
      const { runWorkflow } = await import('@/lib/server/runner');
      const record = await runWorkflow({ workflow: useEditor.getState().toWorkflow(), mode: 'manual' });
      useEditor.setState({ running: false, statuses: statusesOf(record.runData), runs: record.runData, runStatus: record.status as never });
    }) as never,
  });

  // A reply: the same chat path as above, laid out as the editor's items.
  const replies: Array<Collected & { calls: number }> = [{ ...first, calls: 0 }];
  useAssistant.setState({
    send: (async (text: string, sendOptions: { nodeId?: string; session?: 'fix' | 'review' | 'auto'; testId?: string } = {}) => {
      const editor = useEditor.getState();
      const workflow = editor.toWorkflow();
      // As the editor's send(): the node it was asked about (else the open or selected one) and `runDigests()`.
      const selected = sendOptions.nodeId ?? editor.openNodeId ?? editor.nodes.find((n) => n.selected)?.id;
      const result = await chatOnce({ ask: text, workflow, ...(selected && { selected }), runs: runDigests(), ...(sendOptions.session && { session: sendOptions.session }) }, form, scripted, options);
      replies.push(result);
      useAssistant.getState().append([
        { id: nanoid(6), role: 'user', text, auto: true, ...(sendOptions.testId && { testId: sendOptions.testId }) },
        {
          id: nanoid(6),
          role: 'assistant',
          ...(result.error ? { error: result.error } : { done: { model: 'spotlight-scenarios', durationMs: 0, steps: result.done?.steps ?? 1 } }),
          ...(sendOptions.testId && { testId: sendOptions.testId }),
          parts: [
            ...(result.text ? [{ kind: 'text' as const, text: result.text }] : []),
            ...result.proposals.map((p) => ({ kind: 'proposal' as const, proposal: { id: nanoid(6), ...p } })),
          ],
        },
      ] as never);
    }) as never,
  });

  // `start.autonomy`: asks-first waits for an Apply nobody clicks here, so once a card has waited with nothing else going
  // on, the session is stopped as the person would (■). Unset: auto, the session applying its own fixes as SB00 measured.
  const autonomy: Autonomy = scenario.start?.autonomy ?? 'auto';
  let quiet = 0;
  const watch = setInterval(() => {
    const assistant = useAssistant.getState();
    const waiting = assistant.testing && !assistant.pending && !useEditor.getState().running && undecided(assistant.items as never) > 0;
    quiet = waiting ? quiet + 1 : 0;
    if (quiet >= 8) assistant.testing?.abort();
  }, 25);
  try {
    await testUntilItRuns(echoed(scenario.ask, options), { publishAgents: true, autonomy });
  } finally {
    clearInterval(watch);
  }
  const needs = useAssistant
    .getState()
    .items.flatMap((item) => (item.role === 'assistant' ? item.parts.flatMap((p) => (p.kind === 'needs' ? [p.need.what as string] : [])) : []));
  return { before, after: useEditor.getState().toWorkflow(), needs, replies };
}

// ---------------------------------------------------------------------------
// runScenario
// ---------------------------------------------------------------------------

/** Run `scenario` once. Never throws for a product failure: that is the Outcome's `error`. */
export async function runScenario(scenario: Scenario, form: Form, options: RunOptions = {}): Promise<Outcome> {
  prepare();
  // `start.autonomy` decides what is applied (`applyAsTheEditor`, the session's own rule) and `start.approvedDestinations`
  // what a session's test run may send to (`sessionOf`): wired at the wave sb1 merge, SB03 and SB04 having no harness.
  const started = Date.now();
  const refusedBefore = refusedNow().length;
  const echoBefore = options.echo?.log.length ?? 0;
  const outcome: Outcome = { scenario: scenario.id, form, ms: 0, text: '', tools: [], proposals: [], needs: [], sent: [], refused: [], agents: [], modelCalls: 0, tokens: { input: 0, output: 0 } };
  const script = form === 'unit' ? (scenario.script ?? []) : undefined;
  // One scripted model per scenario: the script is its replies in order, across the first message and every session reply.
  const scripted = script ? scriptedModel(script) : undefined;
  const canvas = canvasOf(scenario, options);
  if (canvas) outcome.before = canvas;
  const previousOllama = process.env.OLLAMA_URL;
  let fake: FakeModels | undefined;
  const previousAllow = process.env.LANDFLOW_OUTBOUND_ALLOW;
  const previousBlock = process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE;
  // SB10: the policy is set outright for a live run: blocked unless the scenario says allowed (it was allowed whenever an echo server ran).
  const outbound = outboundEnv(scenario, form);
  if (outbound) {
    process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE = outbound.LANDFLOW_OUTBOUND_BLOCK_PRIVATE;
    if (outbound.LANDFLOW_OUTBOUND_ALLOW) process.env.LANDFLOW_OUTBOUND_ALLOW = outbound.LANDFLOW_OUTBOUND_ALLOW;
    else delete process.env.LANDFLOW_OUTBOUND_ALLOW;
  }
  try {
    // The product reaches for Ollama itself in these (the builder, the agent designer, the architect): a fake one answers the script.
    if (form === 'unit' && scenario.via !== 'chat' && scenario.via !== 'session') {
      fake = await startFakeModels({ reply: fakeReplyOf(script ?? []) });
      process.env.OLLAMA_URL = fake.origin;
    }
    const model = form === 'live' ? (options.model ?? 'qwen3-coder:30b') : undefined;
    const withDone = (c: Collected & { calls: number }) => {
      outcome.modelCalls = c.calls;
      if (c.done?.model) outcome.model = c.done.model; // SB10:
      outcome.tokens = { input: c.done?.usage.inputTokens ?? 0, output: c.done?.usage.outputTokens ?? 0 };
    };

    if (scenario.via === 'build') {
      const route = await import('@/app/api/ai/build/route');
      const response = await route.POST(post('/api/ai/build', { prompt: scenario.ask, ...((scenario.start?.model ?? model) && { model: scenario.start?.model ?? model }), /* SB19: */ ...(canvas?.id && { workflowId: canvas.id }) }));
      const body = (await response.json()) as { draft?: Record<string, unknown>; error?: string };
      if (!response.ok || !body.draft) outcome.error = body.error ?? `build ${response.status}`;
      else {
        outcome.draft = body.draft;
        outcome.after = draftToWorkflow(body.draft as never);
        outcome.text = `Built ${(body.draft.nodes as unknown[]).length} nodes`;
        if (body.draft.summary) outcome.text = summaryText(String(body.draft.name), body.draft.summary as DraftSummary); // SB15: a build's text is what the person reads
        outcome.model = typeof body.draft.model === 'string' ? body.draft.model : undefined; // SB19:
      }
      // SB10 (carryover item 4): the calls the draft took (`draft.calls`), live and unit; the fake's count only when the route sent none.
      outcome.modelCalls = typeof body.draft?.calls === 'number' ? body.draft.calls : fake ? fake.requests.filter((r) => r.path === '/api/chat').length : 1;
      if (typeof body.draft?.model === 'string') outcome.model = body.draft.model;
    } else if (scenario.via === 'chat' || scenario.via === 'session') {
      if (!canvas) throw new Error(`${scenario.id}: a chat scenario needs start.workflow`);
      const result = await chatOnce({ ask: echoed(scenario.ask, options), workflow: canvas, selected: idOf(canvas, scenario.start?.selected), runs: runsById(canvas, scenario.start?.runs), session: scenario.start?.session, ...scopeOfStart(canvas, scenario.start), model: scenario.start?.model /* SB19: */ }, form, scripted, options);
      Object.assign(outcome, { text: result.text, tools: result.tools, proposals: result.proposals, asked: result.asked, offers: result.offers, ...(result.error && { error: result.error }) }); // SB11: asked; SB12: offers
      withDone(result);
      outcome.after = applyAsTheEditor(canvas, result.proposals, scenario.start?.autonomy);
      if (scenario.via === 'session') {
        const session = await sessionOf(scenario, form, options, result, canvas, outcome.after, scripted);
        outcome.before = session.before;
        outcome.after = session.after;
        outcome.needs = session.needs;
        outcome.modelCalls += session.replies.slice(1).reduce((n, r) => n + r.calls, 0);
        outcome.proposals.push(...session.replies.slice(1).flatMap((r) => r.proposals));
        // SB10: what a session applied is the canvas in the store; a card the guard refused or that waits for Apply changed nothing.
        if (touchedNodes(outcome.before, outcome.after).length === 0) outcome.unapplied = outcome.proposals.length;
      }
    } else if (scenario.via === 'design') {
      const route = await import('@/app/api/agents/design/route');
      const response = await route.POST(post('/api/agents/design', { name: nameOfAsk(scenario.ask), description: scenario.ask, instructions: '', ...(canvas && { workflow: canvas.name }), ...(scenario.start?.model && { model: scenario.start.model }) /* SB19: */ }));
      const body = (await response.json()) as { agent?: { id: string; name: string; tools: AgentConfig['tools']; model?: AgentConfig['model'] }; error?: string };
      if (!body.agent) outcome.error = body.error ?? `design ${response.status}`;
      else outcome.agents.push(agentOf(body.agent as Partial<AgentConfig>));
      outcome.modelCalls = fake ? fake.requests.filter((r) => r.path === '/api/chat').length : 1;
    } else {
      const route = await import('@/app/api/assistant/agent/route');
      const response = await route.POST(post('/api/assistant/agent', { messages: [{ role: 'user', content: scenario.ask }], ...(model && { model }) }));
      const result = collect(await readSse(response));
      Object.assign(outcome, { text: result.text, tools: result.tools, ...(result.error && { error: result.error }) });
      outcome.agents.push(...result.drafts.map((d) => agentOf(d)));
      withDone({ ...result, calls: result.done?.steps ?? 0 });
    }
  } catch (e) {
    outcome.error = (e as Error).message;
  } finally {
    await fake?.close();
    if (previousOllama === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = previousOllama;
    if (previousAllow === undefined) delete process.env.LANDFLOW_OUTBOUND_ALLOW;
    else process.env.LANDFLOW_OUTBOUND_ALLOW = previousAllow;
    if (previousBlock === undefined) delete process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE;
    else process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE = previousBlock;
  }
  outcome.ms = Date.now() - started;
  outcome.refused = form === 'live' ? refusedNow().slice(refusedBefore) : [];
  outcome.sent = options.echo ? options.echo.log.slice(echoBefore) : [];
  return outcome;
}

/** A short name for a designed agent, from the ask's own words. */
function nameOfAsk(ask: string): string {
  return ask.replace(/^(create|add|make)\s+an?\s+(agent\s+)?(that\s+)?/i, '').split(/\s+/).slice(0, 4).join(' ').slice(0, 60) || 'Agent';
}

// ---------------------------------------------------------------------------
// Checks, the scorecard and its report
// ---------------------------------------------------------------------------

/** The labels of the checks that came out false (a check that does not apply, 'n/a', is not a failure). */
export function failedChecks(scenario: Scenario, outcome: Outcome): string[] {
  return scenario.checks.filter((c) => c.judge(outcome) === false).map((c) => c.label);
}

/** The unit form's assertion: every check holds, and the run did not fail. Throws naming each failed check. */
export function assertUnit(scenario: Scenario, outcome: Outcome): void {
  // SB19: a scenario with a check `expects-error` is about the error (a refused model), so the error is not a failure.
  const failed = failedChecks(scenario, outcome);
  if (outcome.error && !scenario.checks.some((c) => c.id === 'expects-error')) failed.unshift(`ran without error (${outcome.error})`);
  if (failed.length) throw new Error(`${scenario.id} failed: ${failed.join('; ')}`);
}

export interface Report {
  model: string;
  startedAt: string;
  /** Scenarios not run live, with the scenario's own reason. */
  skipped: Array<{ id: string; reason: string }>;
  scenarios: Array<{ id: string; owner: string; job: Job; runs: Array<{ ms: number; checks: Record<string, boolean | 'n/a'>; error?: string }> }>;
}

/** The checks of one outcome by id. A check that throws is false. */
export function judge(scenario: Scenario, outcome: Outcome): Record<string, boolean | 'n/a'> {
  return Object.fromEntries(
    scenario.checks.map((c: Check) => {
      try {
        return [c.id, c.judge(outcome)];
      } catch {
        return [c.id, false];
      }
    }),
  );
}

/** An error's kind, not its text: a model or parser error can quote the reply (the part before the first colon or line break, cut short). */
function errorKind(error: string): string {
  return error.split(/[:\n]/)[0].trim().slice(0, 40);
}

/** Sizes and check results only: no prompt text, no reply text. */
export function reportOf(model: string, startedAt: string, runs: Array<{ scenario: Scenario; outcome: Outcome }>, skipped: Report['skipped'] = []): Report {
  const byId = new Map<string, Report['scenarios'][number]>();
  for (const { scenario, outcome } of runs) {
    const entry = byId.get(scenario.id) ?? { id: scenario.id, owner: scenario.owner, job: scenario.job, runs: [] };
    entry.runs.push({ ms: outcome.ms, checks: judge(scenario, outcome), ...(outcome.error && { error: errorKind(outcome.error) }) });
    byId.set(scenario.id, entry);
  }
  return { model, startedAt, skipped, scenarios: [...byId.values()] };
}

/** The scorecard's column for each check id, in the evaluation's words (a check's own label is for the unit form's message). */
const COLUMNS: Record<string, string> = {
  'right-types': 'Right node types',
  wiring: 'Wiring',
  'collections-filled': 'Collections filled',
  'ids-asked': 'Ids asked, not made up',
  'credentials-listed': 'Credentials listed',
  'runs-right': 'Runs right with the pinned data',
  'no-junk': 'No junk nodes',
  'left-listed': 'Left items listed',
  'only-asked-node': 'Only the asked node',
  'right-change': 'Right change',
  'no-change': 'No change for a question',
  proposed: 'Change card',
  answered: 'Answered in words',
  'no-outside': 'No outside',
  'agent-exists': 'Agent draft produced',
  model: 'Model chosen',
  tools: 'Tools least-privilege',
  knowledge: 'Knowledge base',
};

const TITLES: Record<Job, string> = { build: 'Build', fix: 'Fix one step', agent: 'Agents' };

/** The three tables, in the evaluation's words: per scenario, runs, time range and "k of n" per check. */
export function tables(report: Report, scenarios: Scenario[]): string {
  const out: string[] = [];
  for (const job of ['build', 'fix', 'agent'] as Job[]) {
    const rows = report.scenarios.filter((s) => s.job === job);
    if (!rows.length) continue;
    const labels = new Map<string, string>();
    for (const s of scenarios) for (const c of s.checks) labels.set(c.id, COLUMNS[c.id] ?? c.label);
    const ids = [...new Set(rows.flatMap((r) => r.runs.flatMap((run) => Object.keys(run.checks))))];
    out.push(`\n${TITLES[job]}`, ['scenario', 'runs', 'time', ...ids.map((id) => labels.get(id) ?? id)].join(' | '));
    for (const row of rows) {
      const times = row.runs.map((r) => r.ms).sort((a, b) => a - b);
      const cells = ids.map((id) => {
        const results = row.runs.map((r) => r.checks[id]).filter((v) => v !== undefined && v !== 'n/a');
        return results.length ? `${results.filter((v) => v === true).length} of ${results.length}` : 'n/a';
      });
      const errors = row.runs.filter((r) => r.error).length;
      out.push([row.id, `${row.runs.length}${errors ? ` (${errors} errors)` : ''}`, times.length ? `${(times[0] / 1000).toFixed(1)}–${(times[times.length - 1] / 1000).toFixed(1)} s` : 'n/a', ...cells].join(' | '));
    }
  }
  if (report.skipped.length) out.push('\nSkipped live', ...report.skipped.map((k) => `${k.id}: ${k.reason}`));
  return out.join('\n');
}

export { touchedNodes };
