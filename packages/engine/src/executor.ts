/**
 * Workflow executor.
 *
 * Scheduling follows n8n's v1 "depth-first by branch" order: a node's children
 * run before its siblings, outputs are explored in index order and, within an
 * output, targets top-to-bottom by canvas position. A node with several
 * connected main inputs (e.g. Merge) parks in `waiting` until every connected
 * input has data; if the stack drains first, it runs with what it has.
 *
 * Partial runs start from one node of an earlier execution: everything that
 * is not re-run is copied from that execution (marked `reused`), so
 * expressions like `$('Node')` and multi-input nodes still see its data.
 *
 * With a debug controller the run pauses before a node that has a breakpoint,
 * or before every node while stepping, until it gets continue/step/stop.
 *
 * Waiting: an in-process node can call `ctx.putExecutionToWait()`. The run then
 * stops scheduling and returns status `waiting` with a JSON ResumeState (stack,
 * parked nodes, outputs, run data, node state and the waiting node's input).
 * `resume` continues it later, with the resume payload as the waiting node's
 * output. Nodes keep per-run state through `ctx.getNodeState()` (Loop Over Items),
 * and loops back to an earlier node are scheduled like any other edge.
 *
 * `settings.timeoutSeconds` fails the run with "Workflow timed out after N s";
 * the time spent waiting does not count. A node's `timeoutSeconds` fails one
 * attempt of it ("Node timed out after N s") through the abort signal it gets,
 * so retries and "continue on error" apply.
 *
 * Checkpoints: before the first node and after every main-flow node, the run
 * hands `onCheckpoint` its state (the same ResumeState waits use, without a
 * waiting node). Resuming with kind `restart` continues from it: whatever was on
 * the stack runs, so a node interrupted by a crash runs again. Every node call
 * carries `idempotencyKey` = `<executionId>:<nodeId>:<runIndex>`, the same for a
 * retry of that step and for its re-run after a restart.
 *
 * Sub-nodes (anything connected through an `ai_*` port) never run in the main
 * flow. A root node pulls them through `getInputConnectionData`, and each use
 * is recorded as its own NodeRun and streamed as events, so the editor can
 * light up the model and tool nodes while an agent thinks.
 *
 * Telemetry: the run is a `workflow.execute` span; every NodeRun (main flow,
 * sub-node use or reused copy) is a `node.execute {type}` child span, and sub-node
 * uses are children of their root node's span. Node code runs with its span
 * active, so plugin RPCs and model calls nest under it.
 */
import { context, SpanStatusCode, type Attributes, type Context, type Span } from '@opentelemetry/api';
import {
  PROTOCOL_VERSION,
  type ConnectionType,
  type ExecuteRequest,
  type ExecuteResponse,
  type JsonObject,
  type LogEntry,
  type NodeItem,
} from '@landflow/protocol';
import type { ContextExtras, WaitRequest } from '@landflow/sdk';
import {
  toToolName,
  type AgentMemory,
  type AgentTool,
  type AiDocument,
  type DocumentLoader,
  type Embeddings,
  type LanguageModel,
  type Reranker,
  type Retriever,
  type TextSplitter,
} from './ai';
import { ExpressionError, ExpressionResolver } from './expression';
import { engineMetrics, failSpan, recordedIds, SOURCE_ATTRIBUTE, startChild } from './telemetry';
import { deriveToolSchema } from './tool-schema';
import type {
  ExecuteWorkflowOptions,
  ExecutionEvent,
  ExecutionResult,
  ExecutionWait,
  NodeRun,
  PauseInfo,
  ResolvedNodeType,
  ResumeKind,
  ResumeOptions,
  CheckpointState,
  ResumeStackEntry,
  ResumeState,
  RunCheckpoint,
  RunSource,
  WorkflowConnection,
  WorkflowNode,
} from './types';

class NodeExecutionError extends Error {
  constructor(
    message: string,
    readonly node: WorkflowNode,
    readonly description?: string,
  ) {
    super(message);
  }
}

class CanceledError extends Error {}

/** `settings.timeoutSeconds` ran out: the run fails (it isn't a cancel). */
class TimeoutError extends Error {}

type StackEntry = ResumeStackEntry;

/** A sub-node port type: what `getInputConnectionData` asks for. */
type SubNodeType = Exclude<ConnectionType, 'main'>;

/** Multi-input nodes waiting for more inputs: one slot per input. */
type Parked = Map<string, (NodeItem[] | undefined)[]>;

/** A node that asked to wait, until the run suspends. */
interface PendingWait {
  request: WaitRequest;
  node: WorkflowNode;
  inputs: NodeItem[][];
  outputs: NodeItem[][];
  logs?: LogEntry[];
  startedAt: number;
}

const RESUMED: Record<ResumeKind, string> = {
  time: 'Resumed after the wait',
  webhook: 'Resumed by a webhook call',
  form: 'Resumed by a form submission',
  timeout: 'Stopped waiting: the time limit was reached',
  subworkflow: 'Resumed: the sub-workflow finished',
  restart: 'Continued after a restart',
};

/** A per-node time limit on one attempt: its signal, and the error the attempt fails with. */
interface NodeLimit {
  signal: AbortSignal;
  error: () => Error;
  clear: () => void;
}

/** A node run's span, with what its metrics are keyed by. */
interface NodeTelemetry {
  span: Span;
  context: Context;
  ended: boolean;
  type: string;
  pluginId: string;
  transport?: string;
  source: RunSource;
}

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function executeWorkflow(options: ExecuteWorkflowOptions): Promise<ExecutionResult> {
  return new WorkflowRun(options).run();
}

class WorkflowRun {
  private readonly nodes = new Map<string, WorkflowNode>();
  private readonly nodesByName = new Map<string, WorkflowNode>();
  private readonly outgoing = new Map<string, WorkflowConnection[]>();
  private readonly incomingMain = new Map<string, WorkflowConnection[]>();
  private readonly incomingSub = new Map<string, WorkflowConnection[]>();
  private readonly subNodeIds = new Set<string>();
  private readonly runData: Record<string, NodeRun[]> = {};
  private readonly executionOrder: string[] = [];
  /** Latest main outputs per node name (what `$('Node')` reads). */
  private readonly latestOutputs: Record<string, NodeItem[][]> = {};
  /** ctx.getNodeState() per node id, for the length of the run. */
  private readonly nodeState: Record<string, JsonObject> = {};
  /** When the execution first started (before any wait). */
  private readonly startedAt: number;
  /** When this part of the run started (a resume starts a new one). */
  private readonly segmentStartedAt = Date.now();
  /** Running time of the earlier parts, for the timeout. */
  private readonly priorActiveMs: number;
  private lastNodeId?: string;
  private pendingWait?: PendingWait;
  /** Aborts on cancel (options.signal) and on the workflow timeout. */
  private signal?: AbortSignal;
  private timeout?: { signal: AbortSignal; message: string };
  /** Nodes allowed to run (destination / `only` runs); undefined = all. */
  private allowed?: Set<string>;
  /** Destination / `only` runs: nothing is scheduled after this node (in a loop its children are also its ancestors). */
  private destination?: string;
  /** Partial runs: nodes that run again; the rest is reused. */
  private rerun?: Set<string>;
  /** Partial runs: last recorded main outputs of reused nodes. */
  private readonly reusedOutputs = new Map<string, NodeItem[][]>();
  private stepping = false;
  /** The `workflow.execute` span and its context (set when run() starts). */
  private span!: Span;
  private rootContext!: Context;
  /** Context of each main node while it runs, so its sub-node uses become its children. */
  private readonly nodeContexts = new Map<string, Context>();
  /** Sub-node calls started per node and source (their idempotency keys). */
  private readonly subCalls = new Map<string, number>();

  constructor(private readonly options: ExecuteWorkflowOptions) {
    const { workflow } = options;
    for (const node of workflow.nodes) {
      this.nodes.set(node.id, node);
      this.nodesByName.set(node.name, node);
    }
    for (const connection of workflow.connections) {
      if (!this.nodes.has(connection.source) || !this.nodes.has(connection.target)) continue;
      if (connection.type === 'main') {
        push(this.outgoing, connection.source, connection);
        push(this.incomingMain, connection.target, connection);
      } else {
        push(this.incomingSub, connection.target, connection);
        this.subNodeIds.add(connection.source);
      }
    }
    this.stepping = Boolean(options.debug?.stepping);
    const resumed = options.resume?.state;
    this.startedAt = resumed ? Date.parse(resumed.startedAt) || Date.now() : Date.now();
    this.priorActiveMs = resumed?.activeMs ?? 0;
    if (resumed) {
      if (resumed.allowed) this.allowed = new Set(resumed.allowed);
      if (resumed.rerun) this.rerun = new Set(resumed.rerun);
      this.destination = resumed.destination;
    } else {
      const destination = options.partial?.scope === 'only' ? options.partial.startNodeId : options.destinationNodeId;
      if (destination && this.nodes.has(destination)) {
        this.allowed = this.ancestorsOf(destination);
        this.destination = destination;
      }
    }
  }

  /** The node and every node that feeds it through main connections (loops included: each node is visited once). */
  private ancestorsOf(nodeId: string): Set<string> {
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const c of this.incomingMain.get(id) ?? []) visit(c.source);
    };
    visit(nodeId);
    return seen;
  }

  /** The node and everything downstream of it through main connections. */
  private descendantsOf(nodeId: string): Set<string> {
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const c of this.outgoing.get(id) ?? []) visit(c.target);
    };
    visit(nodeId);
    return seen;
  }

  private emit(event: ExecutionEvent) {
    try {
      this.options.onEvent?.(event);
    } catch {
      // A broken listener must never break the run.
    }
  }

  /** Why the run was aborted: a cancel, or the workflow timeout. */
  private abortError(): Error {
    if (!this.options.signal?.aborted && this.timeout?.signal.aborted) return new TimeoutError(this.timeout.message);
    return new CanceledError('Execution canceled');
  }

  private checkCanceled() {
    if (this.signal?.aborted) throw this.abortError();
  }

  /** Settle as soon as the run is aborted (or `limit` runs out), even if `promise` (a node that ignores the signal) keeps going. */
  private raceAbort<T>(promise: Promise<T>, limit?: NodeLimit): Promise<T> {
    const signal = this.signal;
    if (!signal && !limit) return promise;
    if (signal?.aborted) return Promise.reject(this.abortError());
    if (limit?.signal.aborted) return Promise.reject(limit.error());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.abortError());
      const onLimit = () => reject(limit!.error());
      const detach = () => {
        signal?.removeEventListener('abort', onAbort);
        limit?.signal.removeEventListener('abort', onLimit);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      limit?.signal.addEventListener('abort', onLimit, { once: true });
      promise.then(
        (value) => {
          detach();
          resolve(value);
        },
        (error) => {
          detach();
          reject(error);
        },
      );
    });
  }

  /** `node.timeoutSeconds` for one attempt. */
  private nodeLimit(node: WorkflowNode): NodeLimit | undefined {
    const seconds = Number(node.timeoutSeconds);
    if (!(seconds > 0)) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.round(seconds * 1000));
    timer.unref?.();
    return { signal: controller.signal, error: () => new NodeExecutionError(`Node timed out after ${seconds} s`, node), clear: () => clearTimeout(timer) };
  }

  /** The per-step idempotency key of the next run of `node` from `source` (main-flow runs: its run index). */
  private stepKey(node: WorkflowNode, source: RunSource): string {
    const index = (this.runData[node.id] ?? []).filter((run) => run.source === source).length;
    if (source === 'main') return `${this.options.executionId}:${node.id}:${index}`;
    // Sub-node uses may overlap (an agent calling a tool twice at once): count the calls started, not the runs recorded.
    const key = `${node.id}|${source}`;
    const next = Math.max(index, this.subCalls.get(key) ?? 0);
    this.subCalls.set(key, next + 1);
    return `${this.options.executionId}:${node.id}:${next}`;
  }

  private resolveType(node: WorkflowNode): ResolvedNodeType {
    const resolved = this.options.resolver.resolve(node.type);
    if ('error' in resolved) throw new NodeExecutionError(resolved.error, node);
    return resolved;
  }

  private startNodes(): StackEntry[] {
    const { startNodeId, triggerItems, partial } = this.options;
    const seed = triggerItems && triggerItems.length ? triggerItems : [{ json: {} }];
    if (partial) return [this.preparePartial(seed)];
    if (startNodeId) {
      if (!this.nodes.has(startNodeId)) throw new Error(`Start node ${startNodeId} not found`);
      return [{ nodeId: startNodeId, inputs: [seed] }];
    }
    const candidates = [...this.nodes.values()].filter(
      (node) => !node.disabled && !this.subNodeIds.has(node.id) && !this.incomingMain.has(node.id),
    );
    const triggers = candidates.filter((node) => {
      const resolved = this.options.resolver.resolve(node.type);
      return !('error' in resolved) && resolved.descriptor.kind === 'trigger';
    });
    const roots = triggers.length ? triggers.slice(0, 1) : candidates;
    if (!roots.length) throw new Error('Workflow has no start node');
    return byPosition(roots)
      .reverse()
      .map((node) => ({ nodeId: node.id, inputs: [seed] }));
  }

  /**
   * Copy what the partial run does not repeat from the earlier execution and
   * work out the start node's input: what it received last time, else what
   * its parents produced.
   */
  private preparePartial(seed: NodeItem[]): StackEntry {
    const partial = this.options.partial!;
    const start = this.nodes.get(partial.startNodeId);
    if (!start) throw new Error(`Node ${partial.startNodeId} is not in this workflow`);
    const rerun = partial.scope === 'only' ? new Set([start.id]) : this.descendantsOf(start.id);
    this.rerun = rerun;

    const counters = new Map<string, number>();
    const order = partial.executionOrder ?? Object.keys(partial.runData).flatMap((id) => partial.runData[id].map(() => id));
    for (const nodeId of order) {
      const index = counters.get(nodeId) ?? 0;
      counters.set(nodeId, index + 1);
      const run = partial.runData[nodeId]?.[index];
      const node = this.nodes.get(nodeId);
      if (!run || !node) continue;
      const repeats = run.source === 'main' ? rerun.has(nodeId) : rerun.has(run.parentNodeId ?? '');
      if (repeats) continue;
      if (run.source === 'main' && run.status === 'success') this.reusedOutputs.set(nodeId, run.outputs);
      // A zero-length span marks the copy in this trace; the original span belongs to the earlier trace.
      const telemetry = this.startNodeSpan(node, run.source, this.rootContext);
      const ids = recordedIds(telemetry.span);
      const { spanId: _original, ...copied } = run;
      const reused: NodeRun = { ...copied, reused: { executionId: partial.executionId }, ...(ids && { spanId: ids.spanId }) };
      this.endNodeSpan(telemetry, reused);
      this.record(node, reused);
    }

    const recorded = partial.runData[start.id]?.filter((r) => r.source === 'main').at(-1)?.inputs;
    const incoming = this.incomingMain.get(start.id) ?? [];
    // In a loop the last recorded input came back around the loop: rebuild it from the parents outside the loop.
    const inLoop = incoming.some((c) => rerun.has(c.source));
    if (recorded && !inLoop) return { nodeId: start.id, inputs: recorded };
    if (!incoming.length) return { nodeId: start.id, inputs: [seed] };
    const width = Math.max(...incoming.map((c) => c.targetIndex)) + 1;
    const inputs: NodeItem[][] = Array.from({ length: width }, () => []);
    let found = false;
    for (const connection of incoming) {
      const output = this.reusedOutputs.get(connection.source)?.[connection.sourceIndex];
      if (output) {
        found = true;
        inputs[connection.targetIndex] = [...inputs[connection.targetIndex], ...output];
      }
    }
    if (!found && recorded) return { nodeId: start.id, inputs: recorded };
    if (!found) throw new NodeExecutionError(`No input data for "${start.name}" in execution ${partial.executionId}. Run the nodes before it first.`, start);
    return { nodeId: start.id, inputs };
  }

  /** A fresh slot list for a multi-input node, pre-filled from reused parents. */
  private parkedSlots(targetId: string, width: number): (NodeItem[] | undefined)[] {
    const slots = Array.from({ length: width }, (): NodeItem[] | undefined => undefined);
    if (!this.rerun) return slots;
    for (const connection of this.incomingMain.get(targetId) ?? []) {
      if (this.rerun.has(connection.source)) continue;
      const output = this.reusedOutputs.get(connection.source)?.[connection.sourceIndex];
      if (output) slots[connection.targetIndex] = output;
    }
    return slots;
  }

  private async pauseIfNeeded(node: WorkflowNode, inputs: NodeItem[][]) {
    const debug = this.options.debug;
    if (!debug) return;
    const atBreakpoint = debug.breakpoints().has(node.id);
    if (!atBreakpoint && !this.stepping) return;
    const { executionId } = this.options;
    const signal = this.signal;
    const info: PauseInfo = { nodeId: node.id, nodeName: node.name, reason: atBreakpoint ? 'breakpoint' : 'step', inputs };
    this.span.addEvent('debugger.paused', { 'landflow.node.id': node.id, 'landflow.node.name': node.name, 'landflow.debugger.reason': info.reason });
    this.emit({ type: 'execution.paused', executionId, ...info, at: now() });
    const command = await new Promise<Awaited<ReturnType<typeof debug.pause>>>((resolve, reject) => {
      const onAbort = () => reject(this.abortError());
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      debug.pause(info).then(
        (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
    this.span.addEvent('debugger.resumed', { 'landflow.node.id': node.id, 'landflow.node.name': node.name, 'landflow.debugger.command': command });
    this.emit({ type: 'execution.resumed', executionId, command, at: now() });
    if (command === 'stop') throw new CanceledError('Stopped in the debugger');
    this.stepping = command === 'step';
  }

  async run(): Promise<ExecutionResult> {
    const { workflow, executionId, mode, partial, debug, resume } = this.options;
    const root = startChild('workflow.execute', {
      'landflow.workflow.id': workflow.id,
      'landflow.workflow.name': workflow.name,
      'landflow.execution.id': executionId,
      'landflow.execution.mode': mode,
      'landflow.execution.debug': Boolean(debug),
      ...(partial && !resume && { 'landflow.execution.rerun_of': partial.executionId, 'landflow.execution.rerun_scope': partial.scope }),
      ...(resume && { 'landflow.execution.resume_of': executionId, 'landflow.execution.resume_kind': resume.kind }),
      ...this.options.spanAttributes,
    });
    this.span = root.span;
    this.rootContext = root.context;
    const traceId = recordedIds(this.span)?.traceId;

    // settings.timeoutSeconds: what is left of it after the earlier parts of a resumed run.
    const timeoutSeconds = Number(workflow.settings?.timeoutSeconds ?? 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutSeconds > 0) {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), Math.max(0, timeoutSeconds * 1000 - this.priorActiveMs));
      timer.unref?.();
      this.timeout = { signal: controller.signal, message: `Workflow timed out after ${timeoutSeconds} s` };
    }
    const signals = [this.options.signal, this.timeout?.signal].filter((s): s is AbortSignal => Boolean(s));
    this.signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    engineMetrics().executionsActive.add(1, { 'landflow.execution.mode': mode });
    try {
      return await context.with(this.rootContext, () => this.execute(traceId));
    } finally {
      if (timer) clearTimeout(timer);
      engineMetrics().executionsActive.add(-1, { 'landflow.execution.mode': mode });
    }
  }

  private async execute(traceId: string | undefined): Promise<ExecutionResult> {
    const { workflow, executionId, mode, resume } = this.options;
    this.emit({ type: 'execution.started', executionId, workflowId: workflow.id, mode, ...(traceId && { traceId }), ...(resume && { resumed: true }), at: now() });

    let status: ExecutionResult['status'] = 'success';
    let error: ExecutionResult['error'];
    let suspended: { wait: ExecutionWait; state: ResumeState } | undefined;

    try {
      const stack: StackEntry[] = [];
      const parked: Parked = new Map();
      if (resume) this.restore(resume, stack, parked);
      else stack.push(...this.startNodes());
      this.checkpoint('start', undefined, stack, parked);

      while (stack.length || parked.size) {
        this.checkCanceled();
        if (!stack.length) {
          // Nothing else can feed the parked multi-input nodes: run them with what they have.
          const [nodeId, inputs] = parked.entries().next().value!;
          parked.delete(nodeId);
          stack.push({ nodeId, inputs: inputs.map((branch) => branch ?? []) });
          continue;
        }

        const entry = stack.pop()!;
        const node = this.nodes.get(entry.nodeId)!;
        await this.pauseIfNeeded(node, entry.inputs);
        const outputs = await this.runMainNode(node, entry.inputs);
        this.lastNodeId = node.id;
        if (this.pendingWait) {
          suspended = this.suspend(stack, parked);
          status = 'waiting';
          break;
        }
        this.enqueueChildren(node, outputs, stack, parked);
        const runIndex = (this.runData[node.id] ?? []).filter((run) => run.source === 'main').length - 1;
        this.checkpoint(`${node.id}#${Math.max(0, runIndex)}`, node.id, stack, parked);
      }
    } catch (caught) {
      if (caught instanceof CanceledError) {
        status = 'canceled';
        error = { message: caught.message };
      } else if (caught instanceof TimeoutError) {
        status = 'error';
        error = { message: caught.message };
      } else if (caught instanceof NodeExecutionError) {
        status = 'error';
        error = { message: caught.message, nodeId: caught.node.id, nodeName: caught.node.name };
      } else {
        status = 'error';
        error = { message: (caught as Error).message };
      }
    }

    const finishedAt = Date.now();
    // Wall time since the execution first started (waits included); the metric records this part's running time.
    const durationMs = finishedAt - this.startedAt;
    this.span.setAttribute('landflow.execution.status', status);
    if (suspended) {
      this.span.setAttributes({
        'landflow.wait.node': suspended.wait.nodeName,
        'landflow.wait.resume': suspended.wait.resume,
        ...(suspended.wait.until && { 'landflow.wait.until': suspended.wait.until }),
      });
    }
    if (status === 'error') this.span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
    this.span.end();
    const attributes: Attributes = {
      'landflow.workflow.id': workflow.id,
      'landflow.workflow.name': workflow.name,
      'landflow.execution.mode': mode,
      'landflow.execution.status': status,
    };
    engineMetrics().executions.add(1, attributes);
    engineMetrics().executionDuration.record(finishedAt - this.segmentStartedAt, attributes);
    this.emit({
      type: 'execution.finished',
      executionId,
      status,
      durationMs,
      ...(error && { error }),
      ...(suspended && { wait: suspended.wait }),
      at: now(),
    });

    return {
      executionId,
      workflowId: workflow.id,
      mode,
      status,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs,
      runData: this.runData,
      executionOrder: this.executionOrder,
      ...(error && { error }),
      ...(this.lastNodeId && { lastNodeId: this.lastNodeId }),
      ...(traceId && { traceId }),
      ...(suspended && { wait: suspended.wait, resumeState: suspended.state }),
    };
  }

  /** Queue the nodes fed by `node`'s outputs; a multi-input node parks until all its inputs have data. */
  private enqueueChildren(node: WorkflowNode, outputs: NodeItem[][], stack: StackEntry[], parked: Parked) {
    if (node.id === this.destination) return;
    const next: StackEntry[] = [];
    outputs.forEach((items, outputIndex) => {
      if (!items.length && !node.alwaysOutputData) return;
      const targets = (this.outgoing.get(node.id) ?? [])
        .filter((c) => c.sourceIndex === outputIndex)
        .sort((a, b) => positionY(this.nodes.get(a.target)) - positionY(this.nodes.get(b.target)));
      for (const connection of targets) {
        if (this.allowed && !this.allowed.has(connection.target)) continue;
        const target = this.nodes.get(connection.target)!;
        const connectedInputs = new Set((this.incomingMain.get(target.id) ?? []).map((c) => c.targetIndex));
        const width = Math.max(...connectedInputs) + 1;
        if (connectedInputs.size <= 1) {
          // Also a loop back to an earlier node (Loop Over Items): it simply runs again.
          const inputs: NodeItem[][] = Array.from({ length: width }, () => []);
          inputs[connection.targetIndex] = items;
          next.push({ nodeId: target.id, inputs });
          continue;
        }
        const slots = parked.get(target.id) ?? this.parkedSlots(target.id, width);
        slots[connection.targetIndex] = items;
        if ([...connectedInputs].every((index) => slots[index] !== undefined)) {
          parked.delete(target.id);
          next.push({ nodeId: target.id, inputs: slots.map((branch) => branch ?? []) });
        } else {
          parked.set(target.id, slots);
        }
      }
    });
    // LIFO: push in reverse so the first child runs first.
    for (const item of next.reverse()) stack.push(item);
  }

  // -------------------------------------------------------------------------
  // Waiting and resuming
  // -------------------------------------------------------------------------

  /** The scheduler state as plain JSON (no waiting node). It shares the run's live objects. */
  private snapshot(stack: StackEntry[], parked: Parked): CheckpointState {
    return {
      version: 1,
      startedAt: new Date(this.startedAt).toISOString(),
      activeMs: this.priorActiveMs + (Date.now() - this.segmentStartedAt),
      stack: stack.map((entry) => ({ nodeId: entry.nodeId, inputs: entry.inputs })),
      parked: [...parked].map(([nodeId, slots]) => ({ nodeId, slots: slots.map((slot) => slot ?? null) })),
      nodeOutputs: this.latestOutputs,
      runData: this.runData,
      executionOrder: this.executionOrder,
      nodeState: this.nodeState,
      ...(this.lastNodeId && { lastNodeId: this.lastNodeId }),
      ...(this.allowed && { allowed: [...this.allowed] }),
      ...(this.destination && { destination: this.destination }),
      ...(this.rerun && { rerun: [...this.rerun], reusedOutputs: Object.fromEntries(this.reusedOutputs) }),
    };
  }

  /** Hand the state between two nodes to `onCheckpoint`. A failing listener never breaks the run. */
  private checkpoint(stepId: string, nodeId: string | undefined, stack: StackEntry[], parked: Parked) {
    const listener = this.options.onCheckpoint;
    if (!listener) return;
    const checkpoint: RunCheckpoint = { stepId, ...(nodeId && { nodeId }), steps: this.executionOrder.length, state: this.snapshot(stack, parked) };
    try {
      listener(checkpoint);
    } catch {
      // The run goes on; it only loses the chance to continue from here after a crash.
    }
  }

  /** Stop scheduling: what the run waits for, and the state to continue from. */
  private suspend(stack: StackEntry[], parked: Parked): { wait: ExecutionWait; state: ResumeState } {
    const pending = this.pendingWait!;
    const since = new Date(pending.startedAt).toISOString();
    const wait: ExecutionWait = { ...pending.request, nodeId: pending.node.id, nodeName: pending.node.name, since };
    const waiting = { nodeId: pending.node.id, inputs: pending.inputs, outputs: pending.outputs, startedAt: since, ...(pending.logs?.length && { logs: pending.logs }) };
    return { wait, state: { ...this.snapshot(stack, parked), waiting } };
  }

  /** Load a waiting run's state, record the waiting node's run with the resume payload, and queue what follows it. */
  private restore(resume: ResumeOptions, stack: StackEntry[], parked: Parked) {
    // A copy: the caller's state stays as it was (it may be resumed again if this attempt fails to start).
    const state = structuredClone(resume.state);
    if (state.version !== 1) throw new Error(`Unsupported resume state version ${String(state.version)}`);
    Object.assign(this.runData, state.runData);
    this.executionOrder.push(...state.executionOrder);
    Object.assign(this.latestOutputs, state.nodeOutputs);
    Object.assign(this.nodeState, state.nodeState);
    for (const [nodeId, outputs] of Object.entries(state.reusedOutputs ?? {})) this.reusedOutputs.set(nodeId, outputs);
    this.lastNodeId = state.lastNodeId;
    stack.push(...state.stack);
    for (const entry of state.parked) parked.set(entry.nodeId, entry.slots.map((slot) => slot ?? undefined));
    for (const entry of [...state.stack, ...state.parked]) {
      if (!this.nodes.has(entry.nodeId)) throw new Error(`Node ${entry.nodeId} of the saved state is not in the workflow`);
    }

    const { waiting } = state;
    if (resume.kind === 'restart' || !waiting) {
      // A checkpoint: the stack holds what runs next. `$('Node')` outputs not saved with it come from the run data.
      if (!Object.keys(state.nodeOutputs ?? {}).length) {
        const counters = new Map<string, number>();
        for (const nodeId of this.executionOrder) {
          const index = counters.get(nodeId) ?? 0;
          counters.set(nodeId, index + 1);
          const run = this.runData[nodeId]?.[index];
          const node = this.nodes.get(nodeId);
          if (run && node && run.source === 'main' && run.status === 'success') this.latestOutputs[node.name] = run.outputs;
        }
      }
      return;
    }
    const node = this.nodes.get(waiting.nodeId);
    if (!node) throw new Error(`The waiting node ${waiting.nodeId} is not in the workflow`);
    const telemetry = this.startNodeSpan(node, 'main', this.rootContext);
    telemetry.span.setAttributes({ 'landflow.node.resumed': true, 'landflow.wait.resume_kind': resume.kind });
    const ids = recordedIds(telemetry.span);
    this.emit({ type: 'node.started', executionId: this.options.executionId, nodeId: node.id, nodeName: node.name, source: 'main', at: now() });
    const base = {
      startedAt: waiting.startedAt,
      durationMs: Math.max(0, Date.now() - Date.parse(waiting.startedAt)),
      source: 'main' as const,
      inputs: waiting.inputs,
      ...(ids && { spanId: ids.spanId }),
    };
    const logs: LogEntry[] = [...(waiting.logs ?? []), { level: resume.error ? 'error' : 'info', message: resume.error ?? RESUMED[resume.kind] }];
    if (resume.error) {
      if (node.onError === 'continue') {
        const outputs = [(waiting.inputs[0] ?? [{ json: {} }]).map((item: NodeItem, index) => ({ json: { ...item.json, error: { message: resume.error! } }, ...(item.binary && { binary: item.binary }), pairedItem: { item: index } }))];
        const run: NodeRun = { ...base, status: 'success', outputs, logs: [...logs, { level: 'warn', message: `Continued after error: ${resume.error}` }] };
        this.endNodeSpan(telemetry, run);
        this.record(node, run);
        this.lastNodeId = node.id;
        this.enqueueChildren(node, outputs, stack, parked);
        return;
      }
      const run: NodeRun = { ...base, status: 'error', outputs: [], error: { message: resume.error }, logs };
      this.endNodeSpan(telemetry, run);
      this.record(node, run);
      this.lastNodeId = node.id;
      throw new NodeExecutionError(resume.error, node);
    }
    const outputs = resume.outputs ?? waiting.outputs;
    const run: NodeRun = { ...base, status: 'success', outputs, logs };
    this.endNodeSpan(telemetry, run);
    this.record(node, run);
    this.lastNodeId = node.id;
    this.enqueueChildren(node, outputs, stack, parked);
  }

  // -------------------------------------------------------------------------
  // Main-flow node
  // -------------------------------------------------------------------------

  private async runMainNode(node: WorkflowNode, inputs: NodeItem[][]): Promise<NodeItem[][]> {
    const telemetry = this.startNodeSpan(node, 'main', this.rootContext);
    this.nodeContexts.set(node.id, telemetry.context);
    try {
      return await this.runMainNodeTraced(node, inputs, telemetry);
    } finally {
      this.nodeContexts.delete(node.id);
      if (!telemetry.ended) {
        // Canceled while the node ran: there is no NodeRun, but the span must still end.
        telemetry.span.setAttribute('landflow.node.status', 'canceled');
        telemetry.span.end();
      }
    }
  }

  private async runMainNodeTraced(node: WorkflowNode, inputs: NodeItem[][], telemetry: NodeTelemetry): Promise<NodeItem[][]> {
    const { executionId } = this.options;
    const started = Date.now();
    const ids = recordedIds(telemetry.span);
    this.emit({ type: 'node.started', executionId, nodeId: node.id, nodeName: node.name, source: 'main', at: now() });

    const finish = (run: Omit<NodeRun, 'startedAt' | 'durationMs' | 'source'>) => {
      const full: NodeRun = {
        ...run,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        source: 'main',
        ...(ids && { spanId: ids.spanId }),
      };
      this.endNodeSpan(telemetry, full);
      this.record(node, full);
      return full;
    };

    // Disabled nodes pass their first input straight through.
    if (node.disabled) {
      telemetry.span.setAttribute('landflow.node.disabled', true);
      const outputs = [inputs[0] ?? []];
      finish({ status: 'success', inputs, outputs });
      return outputs;
    }

    // A poll trigger already fetched its items: they are the node's output, it doesn't run again.
    const polled = this.options.triggerOutput;
    if (polled && polled.nodeId === node.id) {
      const outputs = [polled.items];
      finish({ status: 'success', inputs, outputs, logs: [{ level: 'info', message: `${polled.items.length} new item(s) from the poll` }] });
      return outputs;
    }

    const pinned = this.options.workflow.pinData?.[node.id];
    if (pinned) {
      telemetry.span.setAttribute('landflow.node.pinned', true);
      const outputs = [pinned];
      finish({ status: 'success', inputs, outputs, logs: [{ level: 'info', message: 'Using pinned data' }] });
      return outputs;
    }

    const effectiveInputs = node.executeOnce ? inputs.map((branch) => branch.slice(0, 1)) : inputs;
    const maxTries = node.retryOnFail ? Math.max(1, Math.min(node.maxTries ?? 3, 10)) : 1;
    let lastError: NodeExecutionError | undefined;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      this.checkCanceled();
      const limit = this.nodeLimit(node);
      try {
        const resolved = this.resolveType(node);
        telemetry.transport = resolved.transport;
        telemetry.span.setAttribute('landflow.transport', resolved.transport);
        const request: ExecuteRequest = { ...this.buildRequest(node, resolved, effectiveInputs, effectiveInputs[0] ?? []), idempotencyKey: this.stepKey(node, 'main') };
        const { response, wait } = await this.callExecute(node, resolved, request, telemetry.context, limit);
        if (response.error) {
          throw new NodeExecutionError(response.error.message, node, response.error.description);
        }
        if (wait) {
          // The run suspends after this node; its NodeRun is recorded when the run resumes.
          telemetry.span.setAttributes({ 'landflow.node.status': 'waiting', 'landflow.wait.resume': wait.resume, ...(wait.until && { 'landflow.wait.until': wait.until }) });
          telemetry.ended = true;
          telemetry.span.end();
          this.pendingWait = { request: wait, node, inputs: effectiveInputs, outputs: response.outputs, ...(response.logs && { logs: response.logs }), startedAt: started };
          return response.outputs;
        }
        finish({ status: 'success', inputs: effectiveInputs, outputs: response.outputs, ...(response.logs && { logs: response.logs }) });
        return response.outputs;
      } catch (caught) {
        if (caught instanceof CanceledError || caught instanceof TimeoutError) throw caught;
        lastError =
          caught instanceof NodeExecutionError
            ? caught
            : new NodeExecutionError((caught as Error).message ?? String(caught), node);
        telemetry.span.recordException(lastError);
        if (attempt < maxTries) await sleep(node.waitBetweenTriesMs ?? 1000);
      } finally {
        limit?.clear();
      }
    }

    const error = lastError!;
    if (node.onError === 'continue') {
      // Keep the flow going: emit the input items annotated with the error.
      const outputs = [(effectiveInputs[0] ?? [{ json: {} }]).map((item: NodeItem, index) => ({
        json: { ...item.json, error: { message: error.message } },
        ...(item.binary && { binary: item.binary }),
        pairedItem: { item: index },
      }))];
      finish({
        status: 'success',
        inputs: effectiveInputs,
        outputs,
        logs: [{ level: 'warn', message: `Continued after error: ${error.message}` }],
      });
      return outputs;
    }
    finish({
      status: 'error',
      inputs: effectiveInputs,
      outputs: [],
      error: { message: error.message, ...(error.description && { description: error.description }) },
    });
    throw error;
  }

  private startNodeSpan(node: WorkflowNode, source: RunSource, parent: Context): NodeTelemetry {
    const resolved = this.options.resolver.resolve(node.type);
    const pluginId = 'error' in resolved ? node.type.slice(0, Math.max(0, node.type.lastIndexOf('.'))) : resolved.pluginId;
    const transport = 'error' in resolved ? undefined : resolved.transport;
    const { span, context: spanContext } = startChild(
      `node.execute ${node.type}`,
      {
        'landflow.node.id': node.id,
        'landflow.node.name': node.name,
        'landflow.node.type': node.type,
        'landflow.plugin.id': pluginId,
        ...(transport && { 'landflow.transport': transport }),
        'landflow.node.source': SOURCE_ATTRIBUTE[source],
        'landflow.execution.id': this.options.executionId,
      },
      parent,
    );
    return { span, context: spanContext, ended: false, type: node.type, pluginId, transport, source };
  }

  private endNodeSpan(telemetry: NodeTelemetry, run: NodeRun) {
    const { span } = telemetry;
    const itemsIn = run.inputs.reduce((sum, branch) => sum + branch.length, 0);
    const itemsOut = run.outputs.reduce((sum, branch) => sum + branch.length, 0);
    span.setAttributes({ 'landflow.items.in': itemsIn, 'landflow.items.out': itemsOut, 'landflow.node.status': run.status });
    telemetry.ended = true;
    if (run.reused) {
      span.setAttribute('landflow.node.reused', true);
      span.end();
      return;
    }
    if (run.status === 'error') span.setStatus({ code: SpanStatusCode.ERROR, message: run.error?.message });
    span.end();
    const base: Attributes = { 'landflow.node.type': telemetry.type, 'landflow.plugin.id': telemetry.pluginId };
    const attributes: Attributes = {
      ...base,
      'landflow.transport': telemetry.transport ?? 'unknown',
      'landflow.node.status': run.status,
      'landflow.node.source': SOURCE_ATTRIBUTE[telemetry.source],
    };
    const instruments = engineMetrics();
    instruments.nodeRuns.add(1, attributes);
    instruments.nodeDuration.record(run.durationMs, attributes);
    if (itemsIn) instruments.nodeItems.add(itemsIn, { ...base, 'landflow.direction': 'in' });
    if (itemsOut) instruments.nodeItems.add(itemsOut, { ...base, 'landflow.direction': 'out' });
  }

  private record(node: WorkflowNode, run: NodeRun) {
    (this.runData[node.id] ??= []).push(run);
    this.executionOrder.push(node.id);
    if (run.source === 'main' && run.status === 'success') this.latestOutputs[node.name] = run.outputs;
    this.emit({
      type: 'node.finished',
      executionId: this.options.executionId,
      nodeId: node.id,
      nodeName: node.name,
      source: run.source,
      ...(run.parentNodeId && { parentNodeId: run.parentNodeId }),
      status: run.status,
      durationMs: run.durationMs,
      itemCounts: run.outputs.map((branch) => branch.length),
      run,
      at: now(),
    });
  }

  private buildRequest(
    node: WorkflowNode,
    resolved: ResolvedNodeType,
    inputs: NodeItem[][],
    expressionItems: NodeItem[],
    overrides?: Record<string, unknown>,
    toolArgs?: Record<string, unknown>,
  ): ExecuteRequest {
    const { workflow, executionId, mode, resumeUrls } = this.options;
    const skip = new Set(
      resolved.descriptor.properties.filter((p) => p.noDataExpression || p.type === 'code').map((p) => p.name),
    );
    const resolver = new ExpressionResolver({
      items: expressionItems,
      nodeOutputs: this.expressionOutputs(node),
      workflow: { id: workflow.id, name: workflow.name },
      execution: { id: executionId, mode, ...(resumeUrls && { resumeUrl: resumeUrls.webhook, resumeFormUrl: resumeUrls.form }) },
      parameters: node.parameters,
      ...(toolArgs && { toolArgs }),
      ...(this.options.variables && { variables: this.options.variables }),
    });
    try {
      const parameters = { ...resolver.resolveParameters(node.parameters, 0, skip), ...overrides } as JsonObject;
      const itemParameters = (inputs[0] ?? []).map(
        (_item, index) => ({ ...resolver.resolveParameters(node.parameters, index, skip), ...overrides }) as JsonObject,
      );
      const credentials = this.options.resolveCredentials?.(node, resolved.descriptor);
      return {
        protocol: PROTOCOL_VERSION,
        executionId,
        workflowId: workflow.id,
        mode,
        node: { id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion },
        parameters,
        itemParameters,
        inputs,
        ...(credentials && Object.keys(credentials).length > 0 && { credentials }),
        // The node handles failing items itself; a call that still fails falls back to the node-level continue below.
        ...(node.onError === 'continue' && { continueOnFail: true }),
      };
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw new NodeExecutionError(`Expression error — ${error.message}`, node, `In: {{ ${error.expression} }}`);
      }
      throw error;
    }
  }

  /**
   * What `$('Node')` reads for `node`: each node's latest output 0, or its first output with items when output 0
   * is empty (a loop's batch, an If's false branch). A direct parent shows the output that feeds `node`.
   */
  private expressionOutputs(node: WorkflowNode): Record<string, NodeItem[]> {
    const view: Record<string, NodeItem[]> = {};
    for (const [name, outputs] of Object.entries(this.latestOutputs)) {
      view[name] = outputs[0]?.length ? outputs[0] : (outputs.find((branch) => branch.length) ?? outputs[0] ?? []);
    }
    for (const connection of this.incomingMain.get(node.id) ?? []) {
      const parent = this.nodes.get(connection.source);
      const output = parent ? this.latestOutputs[parent.name]?.[connection.sourceIndex] : undefined;
      if (parent && output?.length) view[parent.name] = output;
    }
    return view;
  }

  private async callExecute(
    node: WorkflowNode,
    resolved: ResolvedNodeType,
    request: ExecuteRequest,
    spanContext: Context,
    limit?: NodeLimit,
  ): Promise<{ response: ExecuteResponse; wait?: WaitRequest }> {
    let wait: WaitRequest | undefined;
    const extras: ContextExtras = {
      signal: limit ? (this.signal ? AbortSignal.any([this.signal, limit.signal]) : limit.signal) : this.signal,
      putExecutionToWait: (requested) => {
        if (!['time', 'webhook', 'form', 'subworkflow'].includes(requested.resume)) throw new Error(`Unknown wait "${String(requested.resume)}"`);
        if (requested.until !== undefined && Number.isNaN(Date.parse(requested.until))) throw new Error(`Invalid wait time "${requested.until}"`);
        if (requested.resume === 'time' && !requested.until) throw new Error('A time wait needs "until"');
        wait = structuredClone(requested);
      },
      getNodeState: (() => this.nodeState[node.id]) as ContextExtras['getNodeState'],
      setNodeState: (state) => {
        if (state === undefined) delete this.nodeState[node.id];
        else this.nodeState[node.id] = structuredClone(state);
      },
      getNodeOutputs: () => this.expressionOutputs(node),
      onLog: (entry) =>
        this.emit({
          type: 'node.log',
          executionId: this.options.executionId,
          nodeId: node.id,
          level: entry.level,
          message: entry.message,
          at: now(),
        }),
      getInputConnectionData: <T>(type: SubNodeType, index?: number) => this.supplySubNodes(node, type, request.inputs[0] ?? [], index) as Promise<T[]>,
    };
    const response = await this.raceAbort(context.with(spanContext, () => resolved.execute(request, extras)), limit);
    return { response, ...(wait && { wait }) };
  }

  // -------------------------------------------------------------------------
  // Sub-nodes (ai_* ports)
  // -------------------------------------------------------------------------

  /**
   * What the sub-nodes on `root`'s `type` ports supply (only the `index`-th port of that type when given), in port
   * order. Their parameters resolve per root item, so a document loader's `{{ $json.text }}` follows the items it
   * loads. A sub-node can have sub-nodes of its own (a loader's text splitter, a vector store's embeddings): they
   * resolve the same way, and each use is recorded with the sub-node they serve as its parent.
   */
  private async supplySubNodes(root: WorkflowNode, type: SubNodeType, rootItems: NodeItem[], index?: number, chain: string[] = [root.id]): Promise<unknown[]> {
    const connections = (this.incomingSub.get(root.id) ?? [])
      .filter((c) => c.type === type && (index === undefined || c.targetIndex === index))
      .sort((a, b) => a.targetIndex - b.targetIndex);
    const supplied: unknown[] = [];
    for (const connection of connections) {
      const subNode = this.nodes.get(connection.source)!;
      if (subNode.disabled) continue;
      if (chain.includes(subNode.id)) throw new NodeExecutionError(`"${subNode.name}" is attached to itself through its sub-nodes`, root);
      const resolved = this.resolveType(subNode);

      if (resolved.supplyData) {
        const request = this.buildRequest(subNode, resolved, [rootItems], rootItems);
        const extras: ContextExtras = {
          ...(this.signal && { signal: this.signal }),
          getInputConnectionData: <T>(subType: SubNodeType, subIndex?: number) =>
            this.supplySubNodes(subNode, subType, rootItems, subIndex, [...chain, subNode.id]) as Promise<T[]>,
        };
        const capability = await resolved.supplyData(request, extras);
        // A toolkit (the MCP Client Tool) supplies several tools at once: each is used and recorded on its own.
        if (type === 'ai_tool' && Array.isArray(capability)) supplied.push(...capability.map((tool) => this.instrument(root, subNode, type, tool)));
        else supplied.push(this.instrument(root, subNode, type, capability));
        continue;
      }
      if (type === 'ai_tool' && resolved.descriptor.usableAsTool) {
        supplied.push(this.nodeAsTool(root, subNode, resolved));
        continue;
      }
      throw new NodeExecutionError(
        `"${subNode.name}" cannot be attached to ${type} (it neither supplies data nor is usable as a tool)`,
        root,
      );
    }
    return supplied;
  }

  /** Wrap a supplied capability so every use shows up as a sub-node run. */
  private instrument(root: WorkflowNode, subNode: WorkflowNode, type: SubNodeType, capability: unknown): unknown {
    if (type === 'ai_languageModel') {
      const model = capability as LanguageModel;
      return {
        provider: model.provider,
        model: model.model,
        generate: (input) =>
          this.trackSubRun(root, subNode, 'model', { json: { messages: input.messages.length, tools: input.tools.map((t) => t.name) } as JsonObject }, async () => {
            const turn = await model.generate(input);
            return { result: turn, output: { json: turn as unknown as JsonObject } };
          }),
      } satisfies LanguageModel;
    }
    if (type === 'ai_tool') {
      const tool = capability as AgentTool;
      return {
        ...tool,
        nodeId: subNode.id,
        invoke: (input, signal) =>
          this.trackSubRun(root, subNode, 'tool', { json: input as JsonObject }, async () => {
            const result = await tool.invoke(input, signal);
            return { result, output: { json: (isObject(result) ? result : { result }) as JsonObject } };
          }),
      } satisfies AgentTool;
    }
    if (type === 'ai_memory') {
      const memory = capability as AgentMemory;
      return {
        load: (sessionId) =>
          this.trackSubRun(root, subNode, 'memory', { json: { action: 'load', sessionId } }, async () => {
            const messages = await memory.load(sessionId);
            return { result: messages, output: { json: { action: 'load', sessionId, messages: messages.length } } };
          }),
        save: (sessionId, messages) =>
          this.trackSubRun(root, subNode, 'memory', { json: { action: 'save', sessionId } }, async () => {
            await memory.save(sessionId, messages);
            return { result: undefined, output: { json: { action: 'save', sessionId, messages: messages.length } } };
          }),
      } satisfies AgentMemory;
    }
    if (type === 'ai_embedding') {
      const embeddings = capability as Embeddings;
      return {
        provider: embeddings.provider,
        model: embeddings.model,
        embedDocuments: (texts, signal) =>
          this.trackSubRun(root, subNode, 'embedding', { json: { texts: texts.length } }, async () => {
            const vectors = await embeddings.embedDocuments(texts, signal);
            return { result: vectors, output: { json: { vectors: vectors.length, dimensions: vectors[0]?.length ?? 0 } } };
          }),
        embedQuery: (text, signal) =>
          this.trackSubRun(root, subNode, 'embedding', { json: { query: text } }, async () => {
            const vector = await embeddings.embedQuery(text, signal);
            return { result: vector, output: { json: { dimensions: vector.length } } };
          }),
      } satisfies Embeddings;
    }
    if (type === 'ai_textSplitter') {
      const splitter = capability as TextSplitter;
      return {
        splitText: (text) =>
          this.trackSubRun(root, subNode, 'textSplitter', { json: { characters: text.length } }, async () => {
            const chunks = await splitter.splitText(text);
            return { result: chunks, output: { json: { count: chunks.length, chunks: chunks.slice(0, SUB_RUN_PREVIEW) } } };
          }),
      } satisfies TextSplitter;
    }
    if (type === 'ai_document') {
      const loader = capability as DocumentLoader;
      return {
        load: (items) =>
          this.trackSubRun(root, subNode, 'document', { json: { items: items.length } }, async () => {
            const documents = await loader.load(items);
            return { result: documents, output: { json: { count: documents.length, documents: previewDocuments(documents) } } };
          }),
      } satisfies DocumentLoader;
    }
    if (type === 'ai_retriever') {
      const retriever = capability as Retriever;
      return {
        retrieve: (query, options) =>
          this.trackSubRun(root, subNode, 'retriever', { json: { query, ...(options?.topK !== undefined && { topK: options.topK }) } }, async () => {
            const documents = await retriever.retrieve(query, options);
            return { result: documents, output: { json: { count: documents.length, documents: previewDocuments(documents) } } };
          }),
      } satisfies Retriever;
    }
    if (type === 'ai_reranker') {
      const reranker = capability as Reranker;
      return {
        rerank: (query, documents, options) =>
          this.trackSubRun(root, subNode, 'reranker', { json: { query, documents: documents.length } }, async () => {
            const ranked = await reranker.rerank(query, documents, options);
            return { result: ranked, output: { json: { count: ranked.length, documents: previewDocuments(ranked) } } };
          }),
      } satisfies Reranker;
    }
    return capability;
  }

  /** Any `usableAsTool` node (local or remote) becomes an AgentTool. */
  private nodeAsTool(root: WorkflowNode, subNode: WorkflowNode, resolved: ResolvedNodeType): AgentTool {
    const { descriptor } = resolved;
    return {
      name: toToolName(subNode.name),
      description: subNode.notes || descriptor.toolDescription || descriptor.description,
      inputSchema: deriveToolSchema(descriptor, subNode.parameters),
      nodeId: subNode.id,
      invoke: (input) =>
        this.trackSubRun(root, subNode, 'tool', { json: input as JsonObject }, async () => {
          // Arguments become the item; same-named parameters are overridden; $fromAI() reads them.
          const items: NodeItem[] = [{ json: input as JsonObject }];
          const overrides = Object.fromEntries(
            Object.entries(input).filter(([key]) => descriptor.properties.some((p) => p.name === key)),
          );
          const request = { ...this.buildRequest(subNode, resolved, [items], items, overrides, input), mode: 'tool' as const, idempotencyKey: this.stepKey(subNode, 'tool') };
          const response = await resolved.execute(request, { signal: this.signal });
          if (response.error) throw new NodeExecutionError(response.error.message, subNode, response.error.description);
          const out = response.outputs[0] ?? [];
          const result = out.length === 1 ? out[0].json : out.map((item) => item.json);
          return { result, output: out.length === 1 ? out[0] : { json: { items: out.map((i) => i.json) } as JsonObject } };
        }),
    };
  }

  private async trackSubRun<T>(
    root: WorkflowNode,
    subNode: WorkflowNode,
    source: RunSource,
    input: NodeItem,
    work: () => Promise<{ result: T; output: NodeItem }>,
  ): Promise<T> {
    this.checkCanceled();
    const { executionId } = this.options;
    const started = Date.now();
    // A child of the root node's span, whatever context the root node's code calls from.
    const telemetry = this.startNodeSpan(subNode, source, this.nodeContexts.get(root.id) ?? context.active());
    const ids = recordedIds(telemetry.span);
    this.emit({
      type: 'node.started',
      executionId,
      nodeId: subNode.id,
      nodeName: subNode.name,
      source,
      parentNodeId: root.id,
      at: now(),
    });
    const base = { startedAt: new Date(started).toISOString(), source, inputs: [[input]], parentNodeId: root.id, ...(ids && { spanId: ids.spanId }) };
    try {
      const { result, output } = await context.with(telemetry.context, work);
      const run: NodeRun = { ...base, durationMs: Date.now() - started, status: 'success', outputs: [[output]] };
      this.endNodeSpan(telemetry, run);
      this.record(subNode, run);
      return result;
    } catch (error) {
      const run: NodeRun = { ...base, durationMs: Date.now() - started, status: 'error', outputs: [], error: { message: (error as Error).message } };
      failSpan(telemetry.span, error);
      this.endNodeSpan(telemetry, run);
      this.record(subNode, run);
      throw error;
    }
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function positionY(node: WorkflowNode | undefined): number {
  return node?.position?.[1] ?? 0;
}

function byPosition(nodes: WorkflowNode[]): WorkflowNode[] {
  return [...nodes].sort((a, b) => a.position[1] - b.position[1] || a.position[0] - b.position[0]);
}

/** How many chunks / documents a sub-node run keeps in its recorded output. */
const SUB_RUN_PREVIEW = 50;

function previewDocuments(documents: AiDocument[]): JsonObject[] {
  return documents.slice(0, SUB_RUN_PREVIEW).map((doc) => ({
    pageContent: doc.pageContent,
    metadata: doc.metadata,
    ...(doc.id !== undefined && { id: doc.id }),
    ...(doc.score !== undefined && { score: doc.score }),
  }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
