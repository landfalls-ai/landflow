/**
 * The translator: turns the engine's ExecutionEvents of a run into journal events (docs/run-trace.md). It is fed every
 * (redacted) event of a segment by the runner, knows the workflow to tell agents from steps, and hands each draft to
 * `emit`. Span ids are deterministic (`run`, `node:<id>:<n>`, `<span>/step:<stepId>`, `<span>/wait`, `run/wait:<n>`), so
 * a resumed segment in another process continues the same journal: `seed` rebuilds what is open from the stored events.
 */
import type { ExecutionEvent, Workflow, WorkflowNode } from '@landflow/engine';
import type { JsonObject } from '@landflow/protocol';
import { toolInput, type JournalDraft, type JournalEvent, type RunActor, type RunCheck, type SpanKind, type SpanStatus, type TokenCounts } from '../../shared/run-trace';

/** Nodes that are agents when they run in the main flow. */
export const AGENT_NODE_TYPES = new Set(['core.messageAgent', 'core.runTeam', 'core.aiAgent', 'core.a2aAgent']);
/** Tool sub-nodes that hand a task to another agent (a request the caller waits on) rather than call a function. */
export const AGENT_TOOL_TYPES = new Set(['core.a2aAgent', 'core.messageAgent', 'core.aiAgent']);

const WORKFLOW_ID = 'workflow';
const HUMAN: RunActor = { id: 'human', name: 'A person', type: 'human' };
const NOTE_CHARS = 400;

export interface TranslatorOptions {
  workflow: Pick<Workflow, 'id' | 'name' | 'nodes' | 'settings'>;
  executionId: string;
  /** The person who started the run, when known (`human:<id>`). */
  startedBy?: { id: string; name?: string };
  emit: (draft: JournalDraft) => void;
  /** Called with the run's trace id when it starts (the writer stamps it on every event). */
  onTrace?: (traceId: string) => void;
  /** Called when the events so far must reach the store at once (the run ended or started waiting). */
  flush?: () => void;
}

type Item = Record<string, unknown>;

interface Step {
  /** The step's last known state: `running`, `awaiting`, or `ended`. */
  state: 'running' | 'awaiting' | 'ended';
}

interface SpanState {
  id: string;
  kind: SpanKind;
  actor: RunActor;
  parent?: string;
  nodeId?: string;
  open: boolean;
  status: SpanStatus;
  note?: string;
  /** A delegate's remote run. */
  remote?: Remote;
}

interface Remote {
  agent?: string;
  state?: string;
  taskId?: string;
  contextId?: string;
  steps: Map<string, Step>;
  waits: number;
  /** Ids of the words already journaled. */
  said: Set<string>;
}

const freshRemote = (): Remote => ({ steps: new Map(), waits: 0, said: new Set() });

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const short = (text: string, chars = NOTE_CHARS) => (text.length > chars ? `${text.slice(0, chars)}…` : text);
const filled = (value: object) => Object.keys(value).length > 0;
const when = (value: unknown, fallback: string) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback);

/** The tokens in `json.usage`, when it has some. */
function usageIn(json: unknown): TokenCounts | undefined {
  const usage = isObject(json) && isObject(json.usage) ? json.usage : undefined;
  if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

const isRemoteRun = (data: JsonObject) => Array.isArray(data.steps) || (typeof data.agent === 'string' && typeof data.state === 'string');

export type Translator = ReturnType<typeof createTranslator>;

export function createTranslator(options: TranslatorOptions) {
  const { workflow, executionId, emit } = options;
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const workflowActor: RunActor = { id: WORKFLOW_ID, name: workflow.name, type: 'system' };
  const spans = new Map<string, SpanState>();
  /** Spans of a node, oldest first. */
  const ofNode = new Map<string, string[]>();
  const counts = new Map<string, number>();
  let waits = 0;
  let traceId: string | undefined;
  const callerActor: RunActor | undefined = options.startedBy ? { id: `human:${options.startedBy.id}`, name: options.startedBy.name ?? 'A person', type: 'human' } : undefined;

  // ---- spans --------------------------------------------------------------

  function start(span: Omit<SpanState, 'open' | 'status'> & { name: string; caller?: RunActor; input?: unknown; attrs?: Record<string, unknown>; at?: string }) {
    const { name, caller, input, attrs, at, ...state } = span;
    spans.set(state.id, { ...state, open: true, status: 'running' });
    if (state.nodeId) ofNode.set(state.nodeId, [...(ofNode.get(state.nodeId) ?? []), state.id]);
    emit({
      type: 'span.started',
      spanId: state.id,
      ...(state.parent && { parentSpanId: state.parent }),
      kind: state.kind,
      name,
      actor: state.actor,
      ...(caller && { caller }),
      ...(state.nodeId && { nodeId: state.nodeId }),
      ...(input !== undefined && { input }),
      ...(attrs && filled(attrs) && { attrs }),
      ...(at && { at }),
    });
  }

  function update(id: string, patch: { status?: SpanStatus; state?: string; note?: string; attrs?: Record<string, unknown>; at?: string }) {
    const span = spans.get(id);
    if (!span?.open) return;
    if (patch.status) span.status = patch.status;
    if (patch.note !== undefined) span.note = patch.note;
    emit({ type: 'span.updated', spanId: id, ...(patch.status && { status: patch.status }), ...(patch.state && { state: patch.state }), ...(patch.note !== undefined && { note: patch.note }), ...(patch.attrs && filled(patch.attrs) && { attrs: patch.attrs }), ...(patch.at && { at: patch.at }) });
  }

  function end(id: string, status: Exclude<SpanStatus, 'running'>, result: { output?: unknown; error?: string; usage?: TokenCounts; attrs?: Record<string, unknown>; at?: string } = {}) {
    const span = spans.get(id);
    if (!span?.open) return;
    // Whatever the span still has open (a remote agent's calls, a wait) ends with it, unless a remote agent is left paused.
    const paused = span.remote?.state === 'input-required' || span.remote?.state === 'auth-required';
    if (!paused) for (const child of spans.values()) if (child.open && child.parent === id) end(child.id, child.kind === 'wait' ? 'success' : 'canceled', { ...(result.at && { at: result.at }) });
    span.open = false;
    emit({
      type: 'span.ended',
      spanId: id,
      status,
      ...(result.output !== undefined && { output: result.output }),
      ...(result.error && { error: result.error }),
      ...(result.usage && { usage: result.usage }),
      ...(result.attrs && filled(result.attrs) && { attrs: result.attrs }),
      ...(result.at && { at: result.at }),
    });
  }

  /** The open span of a node, else its latest. */
  function spanOfNode(nodeId: string): string | undefined {
    const ids = ofNode.get(nodeId) ?? [];
    return [...ids].reverse().find((id) => spans.get(id)?.open) ?? ids.at(-1);
  }

  /** Who a node acts as in the record: the actor of its span. */
  function actorOfNode(nodeId: string): RunActor | undefined {
    const id = spanOfNode(nodeId);
    return id ? spans.get(id)?.actor : undefined;
  }

  // ---- actors -------------------------------------------------------------

  const isAgent = (node: WorkflowNode | undefined) => Boolean(node && AGENT_NODE_TYPES.has(node.type));

  function nodeActor(node: WorkflowNode | undefined, name: string, type: RunActor['type']): RunActor {
    return { id: `node:${node?.id ?? name}`, name, type, ...(node?.notes?.trim() && { role: short(node.notes.trim(), 200) }), ...(node && { nodeType: node.type }) };
  }

  function modelName(node: WorkflowNode | undefined, fallback: string): string {
    for (const key of ['model', 'modelName', 'modelId']) {
      const value = node?.parameters?.[key];
      if (typeof value === 'string' && value.trim() && !value.includes('{{')) return value.trim();
    }
    return fallback;
  }

  // ---- node events --------------------------------------------------------

  function nodeStarted(e: { nodeId: string; nodeName: string; source: string; parentNodeId?: string; input?: JsonObject; at: string }) {
    const node = nodes.get(e.nodeId);
    const n = counts.get(e.nodeId) ?? 0;
    counts.set(e.nodeId, n + 1);
    const id = `node:${e.nodeId}:${n}`;
    const base = { id, nodeId: e.nodeId, at: e.at };
    if (e.parentNodeId === undefined) {
      // A node that waited and runs again after the resume: its earlier span is done.
      // (`resumed` tells that run from a loop's next round.)
      const priors = ofNode.get(e.nodeId) ?? [];
      const resumed = priors.some((prior) => spans.get(prior)?.status === 'waiting');
      for (const prior of priors) end(prior, 'success', { at: e.at });
      const agent = isAgent(node);
      start({ ...base, kind: agent ? 'agent' : 'step', actor: agent ? nodeActor(node, e.nodeName, 'agent') : workflowActor, parent: 'run', name: e.nodeName, attrs: { ...(node && { nodeType: node.type }), ...(resumed && { resumed: true }) } });
      return;
    }
    const rootId = spanOfNode(e.parentNodeId);
    const root = rootId ? spans.get(rootId) : undefined;
    const parent = root?.id ?? 'run';
    const rootActor = root?.actor ?? workflowActor;
    if (e.source === 'model') {
      const model = modelName(node, e.nodeName);
      start({ ...base, kind: 'model', actor: { id: `model:${model}`, name: model, type: 'model', ...(node && { nodeType: node.type }) }, parent, name: model, caller: rootActor, attrs: { ...(node && { nodeType: node.type, nodeName: e.nodeName }) } });
    } else if (e.source === 'tool' || e.source === 'main') {
      if (node && AGENT_TOOL_TYPES.has(node.type)) {
        const agentId = str(node.parameters?.agentId);
        const actor: RunActor = agentId && !agentId.includes('{{') ? { id: `agent:${agentId}`, name: e.nodeName, type: 'agent', nodeType: node.type } : { id: `remote:${e.nodeName}`, name: e.nodeName, type: 'agent', nodeType: node.type };
        if (node.notes?.trim()) actor.role = short(node.notes.trim(), 200);
        // The caller's `reason` argument (the engine adds it to delegating tools) is why it asked: kept beside the request, not in it.
        const { reason, ...asked } = isObject(e.input) ? e.input : ({} as Item);
        const why = str(reason);
        start({ ...base, kind: 'delegate', actor, parent, name: e.nodeName, caller: rootActor, ...(e.input !== undefined && { input: why ? asked : e.input }), attrs: { nodeType: node.type, ...(why && { reason: short(why, 600) }) }, remote: freshRemote() });
      } else {
        start({ ...base, kind: 'tool', actor: rootActor, parent, name: e.nodeName, ...(e.input !== undefined && { input: e.input }), attrs: { ...(node && { nodeType: node.type }) } });
      }
    } else {
      // Memory, retrievers, embeddings…: the agent's plumbing, kept for the trace but out of the story.
      start({ ...base, kind: 'step', actor: rootActor, parent, name: e.nodeName, attrs: { hidden: true, source: e.source, ...(node && { nodeType: node.type }) } });
    }
  }

  function nodeFinished(e: Extract<ExecutionEvent, { type: 'node.finished' }>) {
    let id = (ofNode.get(e.nodeId) ?? []).find((spanId) => spans.get(spanId)?.open);
    if (!id) {
      // No start seen (the segment began mid-node): open the span now, at the time the node began.
      nodeStarted({ nodeId: e.nodeId, nodeName: e.nodeName, source: e.source, ...(e.parentNodeId && { parentNodeId: e.parentNodeId }), at: e.run.startedAt ?? e.at });
      id = spanOfNode(e.nodeId);
    }
    const span = id ? spans.get(id) : undefined;
    if (!id || !span) return;
    const item = e.run.outputs?.[0]?.[0]?.json as Item | undefined;
    const total = (e.run.outputs ?? []).reduce((sum, branch) => sum + branch.length, 0);
    const status = e.status === 'success' ? 'success' : 'error';
    const error = e.run.error?.message;
    const attrs: Record<string, unknown> = { durationMs: e.durationMs, ...(e.run.spanId && { otelSpanId: e.run.spanId }) };
    let output: unknown;
    const usage = usageIn(item);

    if (span.kind === 'model') {
      if (item) output = { text: item.text ?? '', ...(Array.isArray(item.toolCalls) && item.toolCalls.length ? { toolCalls: item.toolCalls } : {}) };
    } else if (span.kind === 'delegate') {
      if (item) {
        output = item.reply ?? undefined;
        reconcile(span, item, e.at);
        for (const key of ['state', 'taskId', 'contextId', 'agent', 'pause']) if (item[key] !== undefined && item[key] !== null) attrs[key] = item[key];
        // A question the calling agent answers with its next call is no wait for a person.
        if (item.asksCaller === true) attrs.asked = true;
        if (str(item.state)) span.remote!.state = item.asksCaller === true ? 'completed' : String(item.state);
      }
    } else if (total > 1) output = { items: total };
    else if (item) output = item;
    else output = { items: 0 };

    // A chat or form trigger's input is the first thing said in the run.
    if (span.kind === 'step' && item && e.parentNodeId === undefined && /Trigger$/.test(nodes.get(e.nodeId)?.type ?? '')) trigger(nodes.get(e.nodeId)!, item, e.at);

    // Tokens of an agent node come from its model sub-spans; the node's own usage is kept when it reports one.
    end(id, status, { ...(output !== undefined && { output }), ...(error && { error: e.run.error?.description ? `${error}: ${e.run.error.description}` : error }), ...(usage && { usage }), attrs, at: e.at });
  }

  /** The chat message or form fields that started the run, said by the person. */
  function trigger(node: WorkflowNode, item: Item, at: string) {
    const type = node.type;
    let text: string | undefined;
    let who = 'User';
    if (typeof item.chatInput === 'string' && item.chatInput.trim()) {
      text = item.chatInput;
      who = 'Chat user';
    } else if (type.endsWith('.formTrigger')) {
      text = Object.entries(item)
        .filter(([key, value]) => !key.startsWith('_') && key !== 'submittedAt' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
      who = 'Form submitter';
    }
    if (!text) return;
    const by = str(item.sessionId) ?? options.startedBy?.id ?? 'user';
    emit({ type: 'message', spanId: 'run', from: { id: `human:${by}`, name: options.startedBy?.name ?? who, type: 'human' }, text, at });
  }

  // ---- a remote agent's run ----------------------------------------------

  function waitOpen(span: SpanState): string | undefined {
    for (let n = span.remote?.waits ?? 0; n >= 1; n--) {
      const id = n === 1 ? `${span.id}/wait` : `${span.id}/wait:${n}`;
      if (spans.get(id)?.open) return id;
    }
    return undefined;
  }

  function remoteProgress(span: SpanState, data: JsonObject, at: string) {
    const remote = (span.remote ??= freshRemote());
    const attrs: Record<string, unknown> = {};
    const agent = str(data.agent);
    if (agent && remote.agent !== agent) {
      remote.agent = agent;
      attrs.agent = agent;
      span.actor = { ...span.actor, name: agent };
    }
    for (const key of ['taskId', 'contextId'] as const) {
      const value = str(data[key]);
      if (value && remote[key] !== value) {
        remote[key] = value;
        attrs[key] = value;
      }
    }
    const state = str(data.state);
    const pause = (s: string | undefined) => s === 'input-required' || s === 'auth-required';
    if (state && state !== remote.state) {
      const before = remote.state;
      remote.state = state;
      update(span.id, { state, ...(pause(state) ? { status: 'waiting' as const } : span.status === 'waiting' || before === undefined ? { status: 'running' as const } : {}), attrs: { ...attrs }, at });
      const open = waitOpen(span);
      if (pause(state) && !open) {
        remote.waits++;
        start({ id: remote.waits === 1 ? `${span.id}/wait` : `${span.id}/wait:${remote.waits}`, kind: 'wait', actor: HUMAN, parent: span.id, name: `${remote.agent ?? span.actor.name} needs an answer`, caller: span.actor, attrs: { wait: 'question' }, at });
      } else if (!pause(state) && open) end(open, 'success', { at });
    } else if (filled(attrs)) update(span.id, { attrs, at });

    remoteEvents(span, data, at);
  }

  /** The steps of a remote run and the words it said between them, in the order they happened. */
  function remoteEvents(span: SpanState, data: Item, at: string) {
    const steps = Array.isArray(data.steps) ? (data.steps as unknown[]).filter(isObject) : [];
    const said = Array.isArray(data.said) ? (data.said as unknown[]).filter(isObject) : [];
    let next = 0;
    const sayUpTo = (steps: number) => {
      for (; next < said.length && (typeof said[next].afterSteps === 'number' ? (said[next].afterSteps as number) : 0) <= steps; next++) say(span, said[next], at);
    };
    steps.forEach((step, index) => {
      sayUpTo(index);
      stepEvent(span, step, at);
    });
    sayUpTo(Infinity);
  }

  /** Words a member said between its tool calls, once. */
  function say(span: SpanState, words: Item, at: string) {
    const id = str(words.id);
    const text = str(words.text);
    if (!id || !text) return;
    const remote = (span.remote ??= freshRemote());
    if (remote.said.has(id)) return;
    remote.said.add(id);
    emit({ type: 'message', spanId: span.id, from: span.actor, text: short(text, 8_000), inline: true, at: when(words.at, at) });
  }

  /** One step of the remote run (progress or the final output): start it if new, end it if it ended. */
  function stepEvent(span: SpanState, step: Item, at: string) {
    const stepId = str(step.id);
    if (!stepId) return;
    const remote = span.remote!;
    const id = `${span.id}/step:${stepId}`;
    let known = remote.steps.get(stepId);
    const status = str(step.status);
    if (!known) {
      known = { state: 'running' };
      remote.steps.set(stepId, known);
      start({ id, kind: 'tool', actor: span.actor, parent: span.id, name: str(step.name) ?? 'tool', ...(step.args !== undefined && { input: toolInput(step.args) }), at: when(step.startedAt, at) });
    }
    if ((status === 'success' || status === 'error') && known.state !== 'ended') {
      known.state = 'ended';
      end(id, status, { ...(step.output !== undefined && { output: step.output }), ...(typeof step.error === 'string' && step.error && { error: step.error }), at: when(step.endedAt, at) });
    } else if (status === 'awaiting_approval' && known.state === 'running') {
      known.state = 'awaiting';
      update(id, { status: 'waiting', at });
    } else if (status === 'running' && known.state === 'awaiting') {
      known.state = 'running';
      update(id, { status: 'running', at });
    }
  }

  /** The final output of a delegate has all the steps, unshortened: record the ones not recorded or not ended. */
  function reconcile(span: SpanState, item: Item, at: string) {
    if (!span.remote) span.remote = freshRemote();
    const remote = span.remote;
    const agent = str(item.agent);
    if (agent && remote.agent !== agent) {
      remote.agent = agent;
      update(span.id, { attrs: { agent }, at });
      span.actor = { ...span.actor, name: agent };
    }
    remoteEvents(span, item, at);
  }

  function nodeProgress(e: Extract<ExecutionEvent, { type: 'node.progress' }>) {
    const id = (ofNode.get(e.nodeId) ?? []).find((spanId) => spans.get(spanId)?.open);
    const span = id ? spans.get(id) : undefined;
    if (!span) return;
    if (span.kind === 'delegate' && isRemoteRun(e.data)) return remoteProgress(span, e.data, e.at);
    const message = str(e.data.message) ?? str(e.data.status) ?? short(JSON.stringify(e.data));
    if (message === span.note) return;
    update(span.id, { note: short(message), at: e.at });
  }

  function nodeRecord(e: Extract<ExecutionEvent, { type: 'node.record' }>) {
    const spanId = spanOfNode(e.nodeId) ?? 'run';
    const at = when(e.record.at, e.at);
    const { type, at: _at, ...fields } = e.record;
    if (type === 'artifact') emit({ type: 'artifact', spanId, artifact: fields as Extract<typeof e.record, { type: 'artifact' }>, at });
    else {
      const check: RunCheck = { ...(fields as RunCheck), source: 'node' };
      emit({ type: 'check', spanId, check, at });
    }
  }

  // ---- the run ------------------------------------------------------------

  function waitDescription(wait: NonNullable<Extract<ExecutionEvent, { type: 'execution.finished' }>['wait']>) {
    const data = (wait.data ?? {}) as Item;
    const attrs: Record<string, unknown> = { wait: wait.resume, nodeId: wait.nodeId, nodeName: wait.nodeName, ...(wait.until && { until: wait.until }) };
    let name: string;
    let actor: RunActor = HUMAN;
    const approval = isObject(data.approval) ? data.approval : undefined;
    const form = isObject(data.form) ? data.form : undefined;
    if (approval && Array.isArray(approval.calls)) {
      const calls = (approval.calls as unknown[]).filter(isObject);
      attrs.wait = 'approval';
      attrs.channel = approval.channel;
      attrs.calls = calls.map((c) => ({ id: c.id, tool: c.tool, input: c.input }));
      const tools = calls.map((c) => String(c.tool)).filter(Boolean);
      name = tools.length ? `Approve ${tools.join(', ')}` : 'Approve a tool call';
    } else if (wait.resume === 'form') {
      // A Run report asking a person about its failed checks (nodes/run-report.ts) is a gate, answered in place.
      const gate = isObject(data.runReport) && data.runReport.gate ? data.runReport : undefined;
      attrs.wait = gate ? 'gate' : 'form';
      if (gate) attrs.failed = gate.failed;
      name = str(form?.title) ?? str(form?.formTitle) ?? 'Fill in the form';
    } else if (isObject(data.pause) && data.pause.type === 'question') {
      attrs.wait = 'question';
      name = 'Answer the agent’s question';
    } else if (wait.resume === 'time') {
      actor = { id: 'system:timer', name: 'Timer', type: 'system' };
      name = wait.until ? `Wait until ${wait.until}` : 'Wait';
    } else if (wait.resume === 'subworkflow') {
      actor = { id: 'system:subworkflow', name: 'Sub-workflow', type: 'system' };
      name = 'Waiting for a sub-workflow';
    } else {
      actor = { id: 'system:webhook', name: 'Webhook', type: 'system' };
      name = `Waiting for a ${wait.method ?? 'webhook'} call`;
    }
    return { name, actor, attrs };
  }

  function executionFinished(e: Extract<ExecutionEvent, { type: 'execution.finished' }>) {
    if (e.status === 'waiting' && e.wait) {
      const holder = spanOfNode(e.wait.nodeId);
      if (holder && spans.get(holder)?.open) update(holder, { status: 'waiting', at: e.at });
      update('run', { status: 'waiting', at: e.at });
      const { name, actor, attrs } = waitDescription(e.wait);
      waits++;
      start({ id: `run/wait:${waits}`, kind: 'wait', actor, parent: 'run', name, caller: spans.get(holder ?? '')?.actor ?? workflowActor, attrs, at: e.wait.since && Date.parse(e.wait.since) ? e.wait.since : e.at });
      options.flush?.();
      return;
    }
    const status = e.status === 'waiting' ? 'success' : e.status;
    // Whatever is still open ends with the run: the node that failed with its error, waits nobody answered as canceled.
    const open = [...spans.values()].filter((s) => s.open && s.id !== 'run').reverse();
    for (const span of open) {
      if (!span.open) continue;
      if (status === 'error' && span.nodeId && span.nodeId === e.error?.nodeId && span.kind !== 'wait') end(span.id, 'error', { ...(e.error?.message && { error: e.error.message }), at: e.at });
      else end(span.id, span.kind === 'wait' || status !== 'success' ? 'canceled' : 'success', { at: e.at });
    }
    end('run', status, { ...(e.error?.message && { error: e.error.message }), attrs: { durationMs: e.durationMs, ...(e.error?.nodeId && { nodeId: e.error.nodeId }) }, at: e.at });
    options.flush?.();
  }

  function feed(e: ExecutionEvent) {
    switch (e.type) {
      case 'execution.started': {
        if (e.traceId) {
          traceId = e.traceId;
          options.onTrace?.(e.traceId);
        }
        if (e.resumed || spans.get('run')?.open) {
          // Continuing after a wait: the run is running again and the wait it was in is over.
          if (!spans.has('run')) start({ id: 'run', kind: 'run', actor: workflowActor, name: workflow.name, ...(callerActor && { caller: callerActor }), attrs: { mode: e.mode, resumed: true }, at: e.at });
          else update('run', { status: 'running', at: e.at });
          for (const span of [...spans.values()]) if (span.open && span.kind === 'wait' && span.parent === 'run') end(span.id, 'success', { at: e.at });
          break;
        }
        start({ id: 'run', kind: 'run', actor: workflowActor, name: workflow.name, ...(callerActor && { caller: callerActor }), attrs: { mode: e.mode, ...(traceId && { traceId }), ...(workflow.settings?.runProfile && { profile: workflow.settings.runProfile }) }, at: e.at });
        break;
      }
      case 'node.started':
        nodeStarted(e);
        break;
      case 'node.progress':
        nodeProgress(e);
        break;
      case 'node.record':
        nodeRecord(e);
        break;
      case 'node.finished':
        nodeFinished(e);
        break;
      case 'execution.finished':
        executionFinished(e);
        break;
      default:
        break;
    }
  }

  /** Rebuild what the stored events of this execution say is open and how many times each node ran (a resumed segment). */
  function seed(stored: JournalEvent[]) {
    for (const event of stored) {
      if (event.type === 'span.started') {
        const nodeMatch = /^node:(.+):(\d+)$/.exec(event.spanId);
        if (nodeMatch) counts.set(nodeMatch[1], Math.max(counts.get(nodeMatch[1]) ?? 0, Number(nodeMatch[2]) + 1));
        const waitMatch = /^run\/wait:(\d+)$/.exec(event.spanId);
        if (waitMatch) waits = Math.max(waits, Number(waitMatch[1]));
        const state: SpanState = { id: event.spanId, kind: event.kind, actor: event.actor, open: true, status: 'running', ...(event.parentSpanId && { parent: event.parentSpanId }), ...(event.nodeId && { nodeId: event.nodeId }) };
        spans.set(event.spanId, state);
        if (event.nodeId) ofNode.set(event.nodeId, [...(ofNode.get(event.nodeId) ?? []), event.spanId]);
        if (event.kind === 'delegate') state.remote = freshRemote();
        const stepMatch = /^(.+)\/step:(.+)$/.exec(event.spanId);
        if (stepMatch) spans.get(stepMatch[1])?.remote?.steps.set(stepMatch[2], { state: 'running' });
        const parentWait = /^(.+)\/wait(?::(\d+))?$/.exec(event.spanId);
        if (parentWait && !event.spanId.startsWith('run/')) {
          const owner = spans.get(parentWait[1]);
          if (owner?.remote) owner.remote.waits = Math.max(owner.remote.waits, Number(parentWait[2] ?? 1));
        }
      } else if (event.type === 'span.updated') {
        const span = spans.get(event.spanId);
        if (span) {
          if (event.status) span.status = event.status;
          if (event.state && span.remote) span.remote.state = event.state;
        }
      } else if (event.type === 'span.ended') {
        const span = spans.get(event.spanId);
        if (span) {
          span.open = false;
          const stepMatch = /^(.+)\/step:(.+)$/.exec(event.spanId);
          if (stepMatch) {
            const step = spans.get(stepMatch[1])?.remote?.steps.get(stepMatch[2]);
            if (step) step.state = 'ended';
          }
        }
      }
    }
  }

  return { feed, seed, spanOfNode, actorOfNode, openSpans: () => [...spans.values()].filter((s) => s.open).map((s) => s.id) };
}
