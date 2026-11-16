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
import { createRequire } from 'node:module';
import { nanoid } from 'nanoid';
import { definePlugin, defineNode } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';
import { applyOps, type AssistantOp, type RunDigest } from '@/lib/shared/assistant-ops';
import type { AgentConfig } from '@/lib/shared/agents';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { registryLookup } from '@/lib/server/assistant/ops';
import { agentStore } from '@/lib/server/agents/store';
import { handler } from '@/lib/server/http';
import { startFakeModels, readSse, type FakeModels } from '../fake-ai-services';
import { scriptedModel, touchedNodes, type Check, type Job, type Outcome, type Scenario, type ScriptTurn } from './scenario';

export type Form = 'unit' | 'live';

export interface RunOptions {
  /** Live: the Ollama model the routes are asked for. */
  model?: string;
  /** Live: the echo server the scenarios' `http://127.0.0.1:3399/…` URLs point at. */
  echo?: { port: number; log: string[] };
}

export const ECHO_PORT = 3399;

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
function stand(plugin: string, name: string, displayName: string, properties: string[]) {
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
          properties: properties.map((p) => ({ name: p, displayName: p, type: 'string' as const, default: '' })),
        },
        async execute() {
          return [[{ json: {} }]];
        },
      }),
    ],
  });
}

let prepared = false;
/** Register the core plugin and, unless the real ones are online, stand-ins for Slack and Linear; seed one published agent. */
export function prepare(): void {
  if (prepared) return;
  prepared = true;
  registry.registerBuiltin(corePlugin);
  if (!process.env.LANDFLOW_SPOTLIGHT_PLUGINS) {
    registry.registerBuiltin(stand('messaging', 'slack', 'Slack', ['authentication', 'resource', 'operation', 'channelId', 'text', 'blocksUi', 'otherOptions']));
    registry.registerBuiltin(stand('linear', 'linear', 'Linear', ['authentication', 'resource', 'operation', 'since', 'returnAll', 'limit', 'activityOptions']));
  }
  // The agent the evaluation's chat flow ("my Support triage agent") picks: made-up, published.
  if (!agentStore.list().some((a) => a.published?.config.name === 'Support triage')) {
    const agent = agentStore.create({ name: 'Support triage', description: 'Answers support questions from the docs and hands over what it cannot answer.', instructions: 'Answer support questions.', model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    agentStore.publish(agent.id);
  }
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

const idOf = (wf: Workflow | undefined, name: string | undefined) => (name ? (wf?.nodes.find((n) => n.name === name || n.id === name)?.id ?? name) : undefined);

/** `start.runs` (by node name) as the editor sends them (by node id). */
function runsById(wf: Workflow | undefined, runs: Record<string, RunDigest> | undefined): Record<string, RunDigest> | undefined {
  if (!runs) return undefined;
  return Object.fromEntries(Object.entries(runs).map(([name, digest]) => [idOf(wf, name)!, digest]));
}

/** What the model's script turn looks like to Ollama's API: tool inputs are `arguments`. */
function fakeReplyOf(script: ScriptTurn[]) {
  const left = [...script];
  return () => {
    const next = left.shift();
    if (!next) throw new Error('No scripted turn left');
    const turn = typeof next === 'function' ? next({ system: '', messages: [], tools: [] } as never) : next;
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
  done?: { steps: number; usage: { inputTokens: number; outputTokens: number } };
  error?: string;
  drafts: Array<Partial<AgentConfig>>;
}

function collect(events: Array<{ event: string; data: any }>): Collected { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Collected = { text: '', tools: [], proposals: [], drafts: [] };
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
      case 'draft':
        out.drafts.push(data.config);
        break;
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

interface ChatCall {
  ask: string;
  workflow: Workflow;
  selected?: string;
  runs?: Record<string, RunDigest>;
  session?: 'fix' | 'review' | 'auto';
}

/**
 * The editor's request: `messages`, `workflow`, `workflowId`, `selectedNodeId`, `runs`, `session`
 * (components/editor/assistant.ts send()). Live, the real route; unit, `runChat` directly with what the route builds for
 * it (route.ts: `allowedTypes`, `roster()`, `tagMentions`), because the route takes the model as a string and the scripted
 * one is an object. That seam is here and nowhere in the product.
 */
async function chatOnce(call: ChatCall, form: Form, script: ScriptTurn[] | undefined, options: RunOptions): Promise<Collected & { calls: number }> {
  const body = {
    messages: [{ role: 'user', content: call.ask }],
    workflow: call.workflow,
    workflowId: call.workflow.id,
    ...(call.selected && { selectedNodeId: call.selected }),
    ...(call.runs && { runs: call.runs }),
    ...(call.session && { session: call.session }),
  };
  if (form === 'live') {
    const route = await import('@/app/api/assistant/chat/route');
    const response = await route.POST(post('/api/assistant/chat', { ...body, model: options.model ?? 'qwen3-coder:30b' }));
    if (!response.ok) return { ...collect([]), error: `chat ${response.status}`, calls: 0 };
    const collected = collect(await readSse(response));
    return { ...collected, calls: collected.done?.steps ?? 0 };
  }
  const { runChat, tagMentions } = await import('@/lib/server/assistant/chat');
  const { roster } = await import('@/lib/server/assistant/roster');
  const { allowedTypes, meteredWorkflowId } = await import('@/lib/server/assistant/scope');
  const { routeActor } = await import('@/lib/server/projects/http');
  const { model, calls } = scriptedModel(script ?? []);
  const events: Array<{ event: string; data: unknown }> = [];
  await asOwner(async () => {
    const types = allowedTypes(call.workflow.id);
    const { agents, teams } = roster();
    const tagged = await tagMentions(routeActor(), [], { workflow: call.workflow, workflowId: call.workflow.id, types, ...(call.runs && { runs: call.runs }) });
    await runChat({
      messages: body.messages as never,
      workflow: { ...call.workflow, id: meteredWorkflowId(call.workflow.id) ?? 'draft' } as Workflow,
      ...(call.selected && { selectedNodeId: call.selected }),
      ...(call.runs && { runs: call.runs }),
      ...(call.session && { session: call.session }),
      model,
      types,
      teams,
      agents,
      tagged,
      trace: true,
      actor: routeActor(),
      onEvent: (event) => events.push({ event: event.type, data: event }),
    });
  });
  return { ...collect(events as never), calls: calls.length };
}

/** Apply every proposal with the product's `applyOps`, as Apply does. */
function applyAll(workflow: Workflow, proposals: Outcome['proposals']): Workflow {
  let wf = workflow;
  for (const proposal of proposals) wf = applyOps(wf, proposal.ops as AssistantOp[], lookup(), { newId: () => `n_${nanoid(6)}` }).workflow;
  return wf;
}

// ---------------------------------------------------------------------------
// The session: Spotlight's test-and-fix loop on the editor's stores, in Node
// ---------------------------------------------------------------------------

async function sessionOf(scenario: Scenario, form: Form, options: RunOptions, start: Workflow, first: Collected, afterChat: Workflow, script: ScriptTurn[] | undefined) {
  const { useEditor } = await import('@/components/editor/store');
  const { useAssistant } = await import('@/components/editor/assistant');
  const { testUntilItRuns } = await import('@/components/editor/test-session');
  const { statusesOf } = await import('@/lib/client/run-data');
  const types = registry.nodeTypes();
  useAssistant.getState().reset();
  useEditor.getState().load(afterChat, types);
  const rounds = scenario.start?.sessionRuns ?? [];
  let round = 0;

  // The editor's run: scripted rounds (unit) or the product's runner on the canvas, in this process (live).
  useEditor.setState({
    run: (async () => {
      useEditor.setState({ running: true, runStatus: undefined, statuses: {} });
      const nodes = useEditor.getState().nodes;
      if (form === 'unit') {
        // The run is seen going (the session waits for it to start) before it ends.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const scripted = rounds[Math.min(round++, Math.max(rounds.length - 1, 0))] ?? {};
        const statuses = Object.fromEntries(
          nodes.flatMap((n) => {
            const r = scripted[n.data.wf.name];
            return [[n.id, r?.error ? { state: 'error' as const, error: r.error, itemCounts: [0] } : { state: 'success' as const, itemCounts: [r?.items ?? 1] }]];
          }),
        );
        const failed = Object.values(statuses).some((s) => s.state === 'error');
        useEditor.setState({ running: false, statuses, runStatus: failed ? 'error' : 'success' });
        return;
      }
      const { runWorkflow } = await import('@/lib/server/runner');
      const record = await runWorkflow({ workflow: useEditor.getState().toWorkflow(), mode: 'manual' });
      useEditor.setState({ running: false, statuses: statusesOf(record.runData), runStatus: record.status as never });
    }) as never,
  });

  // A reply: the same chat path as above, laid out as the editor's items.
  const replies: Array<Collected & { calls: number }> = [{ ...first, calls: 0 }];
  useAssistant.setState({
    send: (async (text: string, sendOptions: { nodeId?: string; session?: 'fix' | 'review' | 'auto'; testId?: string } = {}) => {
      const workflow = useEditor.getState().toWorkflow();
      const result = await chatOnce({ ask: text, workflow, ...(sendOptions.nodeId && { selected: sendOptions.nodeId }), ...(sendOptions.session && { session: sendOptions.session }) }, form, script, options);
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

  await testUntilItRuns(scenario.ask, { publishAgents: true });
  const needs = useAssistant
    .getState()
    .items.flatMap((item) => (item.role === 'assistant' ? item.parts.flatMap((p) => (p.kind === 'needs' ? [p.need.what as string] : [])) : []));
  void start;
  return { after: useEditor.getState().toWorkflow(), needs, replies };
}

// ---------------------------------------------------------------------------
// runScenario
// ---------------------------------------------------------------------------

/** Run `scenario` once. Never throws for a product failure: that is the Outcome's `error`. */
export async function runScenario(scenario: Scenario, form: Form, options: RunOptions = {}): Promise<Outcome> {
  prepare();
  const started = Date.now();
  const refusedBefore = refusedNow().length;
  const echoBefore = options.echo?.log.length ?? 0;
  const outcome: Outcome = { scenario: scenario.id, form, ms: 0, text: '', tools: [], proposals: [], needs: [], sent: [], refused: [], agents: [], modelCalls: 0, tokens: { input: 0, output: 0 } };
  const script = form === 'unit' ? (scenario.script ?? []) : undefined;
  const canvas = canvasOf(scenario, options);
  if (canvas) outcome.before = canvas;
  const previousOllama = process.env.OLLAMA_URL;
  let fake: FakeModels | undefined;
  const previousAllow = process.env.LANDFLOW_OUTBOUND_ALLOW;
  if (form === 'live' && options.echo) process.env.LANDFLOW_OUTBOUND_ALLOW = '127.0.0.1,localhost';
  try {
    // The product reaches for Ollama itself in these (the builder, the agent designer, the architect): a fake one answers the script.
    if (form === 'unit' && scenario.via !== 'chat' && scenario.via !== 'session') {
      fake = await startFakeModels({ reply: fakeReplyOf(script ?? []) });
      process.env.OLLAMA_URL = fake.origin;
    }
    const model = form === 'live' ? (options.model ?? 'qwen3-coder:30b') : undefined;
    const withDone = (c: Collected & { calls: number }) => {
      outcome.modelCalls = c.calls;
      outcome.tokens = { input: c.done?.usage.inputTokens ?? 0, output: c.done?.usage.outputTokens ?? 0 };
    };

    if (scenario.via === 'build') {
      const route = await import('@/app/api/ai/build/route');
      const response = await route.POST(post('/api/ai/build', { prompt: scenario.ask, ...(model && { model }), ...(canvas?.id && { workflowId: canvas.id }) }));
      const body = (await response.json()) as { draft?: Record<string, unknown>; error?: string };
      if (!response.ok || !body.draft) outcome.error = body.error ?? `build ${response.status}`;
      else {
        outcome.draft = body.draft;
        outcome.after = draftToWorkflow(body.draft as never);
        outcome.text = `Built ${(body.draft.nodes as unknown[]).length} nodes`;
      }
      outcome.modelCalls = fake ? fake.requests.filter((r) => r.path === '/api/chat').length : 1;
    } else if (scenario.via === 'chat' || scenario.via === 'session') {
      if (!canvas) throw new Error(`${scenario.id}: a chat scenario needs start.workflow`);
      const result = await chatOnce({ ask: scenario.ask, workflow: canvas, selected: idOf(canvas, scenario.start?.selected), runs: runsById(canvas, scenario.start?.runs), session: scenario.start?.session }, form, script, options);
      Object.assign(outcome, { text: result.text, tools: result.tools, proposals: result.proposals, ...(result.error && { error: result.error }) });
      withDone(result);
      outcome.after = applyAll(canvas, result.proposals);
      if (scenario.via === 'session') {
        const session = await sessionOf(scenario, form, options, canvas, result, outcome.after, script);
        outcome.after = session.after;
        outcome.needs = session.needs;
        outcome.modelCalls += session.replies.slice(1).reduce((n, r) => n + r.calls, 0);
        outcome.proposals.push(...session.replies.slice(1).flatMap((r) => r.proposals));
      }
    } else if (scenario.via === 'design') {
      const route = await import('@/app/api/agents/design/route');
      const response = await route.POST(post('/api/agents/design', { name: nameOfAsk(scenario.ask), description: scenario.ask, instructions: '', ...(canvas && { workflow: canvas.name }) }));
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
  const failed = failedChecks(scenario, outcome);
  if (outcome.error) failed.unshift(`ran without error (${outcome.error})`);
  if (failed.length) throw new Error(`${scenario.id} failed: ${failed.join('; ')}`);
}

export interface Report {
  model: string;
  startedAt: string;
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

/** Sizes and check results only: no prompt text, no reply text. */
export function reportOf(model: string, startedAt: string, runs: Array<{ scenario: Scenario; outcome: Outcome }>): Report {
  const byId = new Map<string, Report['scenarios'][number]>();
  for (const { scenario, outcome } of runs) {
    const entry = byId.get(scenario.id) ?? { id: scenario.id, owner: scenario.owner, job: scenario.job, runs: [] };
    entry.runs.push({ ms: outcome.ms, checks: judge(scenario, outcome), ...(outcome.error && { error: outcome.error }) });
    byId.set(scenario.id, entry);
  }
  return { model, startedAt, scenarios: [...byId.values()] };
}

const TITLES: Record<Job, string> = { build: 'Build', fix: 'Fix one step', agent: 'Agents' };

/** The three tables, in the evaluation's words: per scenario, runs, median time and "k of n" per check. */
export function tables(report: Report, scenarios: Scenario[]): string {
  const out: string[] = [];
  for (const job of ['build', 'fix', 'agent'] as Job[]) {
    const rows = report.scenarios.filter((s) => s.job === job);
    if (!rows.length) continue;
    const labels = new Map<string, string>();
    for (const s of scenarios) for (const c of s.checks) labels.set(c.id, c.label);
    const ids = [...new Set(rows.flatMap((r) => r.runs.flatMap((run) => Object.keys(run.checks))))];
    out.push(`\n${TITLES[job]}`, ['scenario', 'runs', 'median', ...ids.map((id) => labels.get(id) ?? id)].join(' | '));
    for (const row of rows) {
      const times = row.runs.map((r) => r.ms).sort((a, b) => a - b);
      const cells = ids.map((id) => {
        const results = row.runs.map((r) => r.checks[id]).filter((v) => v !== undefined && v !== 'n/a');
        return results.length ? `${results.filter((v) => v === true).length} of ${results.length}` : 'n/a';
      });
      const errors = row.runs.filter((r) => r.error).length;
      out.push([row.id, `${row.runs.length}${errors ? ` (${errors} errors)` : ''}`, `${((times[Math.floor(times.length / 2)] ?? 0) / 1000).toFixed(1)} s`, ...cells].join(' | '));
    }
  }
  return out.join('\n');
}

export { touchedNodes };
