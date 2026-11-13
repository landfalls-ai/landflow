/**
 * Starting a run: runWorkflow (triggers, idempotency, admission, the execution record) and runSegment, one stretch of an
 * execution through the engine, with its checkpoints, trace and persistence.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import { executeWorkflow, type Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { executionScope, executionUsage, runInUsageScope } from '../ai-usage';
import { tagNodeCredentials } from '../ai-usage/credential-id';
import { TriggerBuffers, triggerBuffers } from '../trigger-buffers';
import { auditCredentialUse } from '../audit';
import { currentActorId } from '../auth/context';
import { bus } from '../bus';
import { workflowScopes } from '../composites';
import { admission, RunSkippedError } from '../concurrency';
import { DuplicateRunError, findIdempotent, rememberIdempotent } from '../idempotency';
import { publishedVersionId } from '../publications';
import { retries, retryDueFor } from '../retries';
import { versionFor } from '../versions';
import { credentials } from '../credentials/vault';
import { resolveWorkflowCredentials } from '../projects/credentials';
import { registry } from '../plugins/registry';
import { traceSegment } from '../journal';
import { parameterSecretOptions, redactRunData } from '../secrets/runtime';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger, recordRuntimeEvent } from '../telemetry';
import { variables } from '../variables';
import { dispatchSegment, preflight, shouldDispatch } from '../cluster/dispatch';
import { clusterRateLimiter } from '../cluster/limits';
import { clusterActive, coordinator, instanceId, runLeaseMs } from '../cluster/state';
import { withWorkflowTransports } from '../transports/workflow-scope';
import { resumeSignatureMode } from '../resume-signing';
import { MAX_WORKFLOW_DEPTH, type RunOptions, newExecutionId, type Segment } from './types';
import { DebugSession, live, trackProgress, resumeUrls } from './state';
import { countsAgainstLimit, isLimitedStart, overRunCap, slotCounts } from './limits';
import { saveProgress, persist } from './persist';
import { afterRun } from './links';
import { enqueue, drainQueueSafely } from './queue';
import { seedFromCheckpoint } from './recovery';

/** Execute a workflow through the registry, stream events, persist the result. */
export async function runWorkflow(options: RunOptions): Promise<ExecutionRecord> {
  // Debounce / batching of the trigger: the event is held and a later run takes it (RunBufferedError says when).
  if (!options.buffered && !options.partial && !options.fromCheckpoint) {
    const triggerNode = options.workflow.nodes.find((n) => n.id === (options.triggerOutput?.nodeId ?? options.startNodeId));
    if (TriggerBuffers.applies(triggerNode, options.mode)) {
      startTriggerBuffers();
      const items = options.triggerOutput?.items ?? options.triggerItems ?? [{ json: {} }];
      const asOutput = { asOutput: Boolean(options.triggerOutput) };
      // Queue mode: under a cluster lock, with the buffer rows read fresh (another main may hold events of this trigger).
      const held = clusterActive() ? await triggerBuffers.addExclusive(options.workflow, triggerNode, items, options.mode, asOutput) : triggerBuffers.add(options.workflow, triggerNode, items, options.mode, asOutput);
      if (held) throw held;
    }
  }
  const source = options.partial ? store.getExecution(options.partial.executionId) : undefined;
  if (options.partial && !source) throw new Error(`Execution ${options.partial.executionId} not found`);
  const seed = options.fromCheckpoint ? seedFromCheckpoint(options.fromCheckpoint.executionId, options.workflow) : undefined;

  // Everything from here to runSegment's live.set() (or enqueue) is synchronous: no two calls with one key, no overbooked slot.
  const idempotencyKey = options.idempotencyKey?.trim() || undefined;
  if (idempotencyKey) {
    const existing = findIdempotent(options.workflow.id, idempotencyKey);
    if (existing) {
      recordRuntimeEvent('deduplicated', options.workflow.id);
      throw new DuplicateRunError(existing, idempotencyKey);
    }
  }
  // Queue mode: the key and the slot are claimed in Valkey, so two processes can't both take them (throws like below).
  const claimed = clusterActive() ? await preflight(options, isLimitedStart(options), newExecutionId) : undefined;
  let admitted = claimed?.admitted ?? (isLimitedStart(options) ? admission(options.workflow.settings, slotCounts(options.workflow.id)) : ({ run: true } as const));
  // The instance's run cap (LANDFLOW_MAX_RUNS, regular mode): a production run over it waits in the queue, where priorities order it.
  if (!claimed && admitted.run && isLimitedStart(options) && overRunCap(options.mode)) admitted = { run: false, queue: true };
  if (!admitted.run && !admitted.queue) {
    recordRuntimeEvent('skipped', options.workflow.id);
    throw new RunSkippedError(options.workflow.id, admitted.reason);
  }

  const executionId = claimed?.executionId ?? options.executionId ?? newExecutionId();
  let depth = 0;
  let evaluation = options.evaluation;
  if (options.parent) {
    const parentEntry = live.get(options.parent.executionId);
    const parentRecord = parentEntry?.record ?? store.getExecution(options.parent.executionId);
    depth = (parentRecord?.depth ?? 0) + 1;
    evaluation ??= parentRecord?.evaluation;
    if (depth > MAX_WORKFLOW_DEPTH) throw new Error(`Sub-workflows can be nested at most ${MAX_WORKFLOW_DEPTH} levels deep`);
    // Linked both ways: the parent lists its sub-executions, the child names its parent.
    if (parentEntry) {
      (parentEntry.record.subExecutions ??= []).push({ executionId, workflowId: options.workflow.id, ...(options.parent.nodeId && { nodeId: options.parent.nodeId }) });
    }
  }
  const debug = options.debug ? new DebugSession(options.debug) : undefined;
  // The version it starts on (an unsaved editor draft has none: its graph is saved with the execution instead).
  const version = versionFor(options.workflow);
  const versionId = version?.id;
  // A manual run started by a signed-in user (the editor's Execute, the API's run, a retry or re-run).
  const startedBy = options.mode === 'manual' || options.mode === 'chat' ? currentActorId() : undefined;
  const record: ExecutionRecord = {
    executionId,
    workflowId: options.workflow.id,
    workflowName: options.workflow.name,
    mode: options.mode,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    durationMs: 0,
    runData: {},
    executionOrder: [],
    ...(options.rerunOf && { rerunOf: options.rerunOf }),
    ...(debug && { debug: true }),
    ...(options.parent && { parentExecutionId: options.parent.executionId, depth }),
    ...(options.parent?.nodeId && { parentNodeId: options.parent.nodeId }),
    ...(options.errorOf && { errorOf: options.errorOf }),
    ...(version && { versionId: version.id, versionNumber: version.number, versionPublished: publishedVersionId(options.workflow.id) === version.id }),
    ...(options.retry && { retryOf: options.retry.of, retryAttempt: options.retry.attempt }),
    ...(idempotencyKey && { idempotencyKey }),
    ...(evaluation && { evaluation }),
    ...(startedBy && { startedBy }),
    ...(options.buffered && { buffered: { kind: options.buffered.kind, count: options.buffered.count } }),
    ...(options.mcp && { mcp: options.mcp }),
  };
  if (idempotencyKey) rememberIdempotent(options.workflow.id, idempotencyKey, executionId);
  if (!admitted.run) return enqueue(record, options);
  if (seed) {
    record.runData = seed.runData;
    record.executionOrder = seed.executionOrder;
    return runSegment({
      record,
      workflow: options.workflow,
      engine: { resume: { state: seed.state, kind: 'restart' } },
      signal: options.signal,
      onEvent: options.onEvent,
      onStart: options.onStart,
      onReply: options.onReply,
      streaming: options.streaming,
    });
  }
  return runSegment({
    record,
    workflow: options.workflow,
    engine: {
      startNodeId: options.startNodeId,
      triggerItems: options.triggerItems,
      ...(options.triggerOutput && { triggerOutput: options.triggerOutput }),
      destinationNodeId: options.destinationNodeId,
      ...(source &&
        options.partial && {
          partial: {
            executionId: source.executionId,
            runData: source.runData,
            executionOrder: source.executionOrder,
            startNodeId: options.partial.nodeId,
            scope: options.partial.scope,
          },
        }),
      ...(options.rerunOf && {
        spanAttributes: { 'landflow.execution.rerun_of': options.rerunOf.executionId, 'landflow.execution.rerun_scope': options.rerunOf.scope },
      }),
    },
    debug,
    signal: options.signal,
    onEvent: options.onEvent,
    onStart: options.onStart,
    onReply: options.onReply,
    streaming: options.streaming,
  });
}

/** One stretch of an execution: from its start or a resume until it finishes or waits. */
export async function runSegment(segment: Segment): Promise<ExecutionRecord> {
  // Queue mode: production runs go to the workers (cluster/dispatch.ts).
  if (shouldDispatch(segment)) return dispatchSegment(segment);
  const { record, workflow } = segment;
  const { executionId } = record;
  const controller = new AbortController();
  const signal = segment.signal ? AbortSignal.any([segment.signal, controller.signal]) : controller.signal;
  const limited = countsAgainstLimit(record);
  live.set(executionId, { controller, debug: segment.debug, record, ...(segment.onReply && { onReply: segment.onReply }), ...(limited && { limited }) });
  // Queue mode: a lease says this process runs it (renewed by the heartbeat): the leader takes over runs without one.
  if (clusterActive()) void coordinator().set(`lease:${executionId}`, instanceId(), runLeaseMs()).catch(() => {});
  // Saved as running before the first node, with the workflow it runs unless a saved version has it: a crash can't lose it.
  const baseSteps = record.executionOrder.length;
  saveProgress(() => store.saveExecution(record.versionId || record.workflow ? { ...record, status: 'running' } : { ...record, status: 'running', workflow }));
  segment.onStart?.(executionId);

  let finished: ExecutionRecord;
  let checkpointed = false;
  // The Run Trace journal of this stretch (lib/server/journal): every event of the engine is told in actors and spans.
  const trace = traceSegment(record, workflow);
  // Token & cost tracking: every model call of this segment counts here, under the workflow's AI usage caps.
  // Caps per user count the runs a signed-in user started (record.startedBy: the editor's Execute, the API, chat), also after a Wait.
  const scopes = workflowScopes(workflow);
  const usage = executionScope({ executionId, workflowId: workflow.id, settings: workflow.settings, previous: record.aiUsage, ...((record.startedBy ?? currentActorId()) && { userId: (record.startedBy ?? currentActorId())! }) });
  try {
    // $secrets in node parameters (Settings → External secrets): an engine-made text (an expression error) may quote a value.
    // Transports: the workflow's overrides of plugin policies apply to the plugin calls of this segment (settings `transports`).
    const result = redactRunData(await runInUsageScope(usage, () => withWorkflowTransports(workflow.id, workflow.settings?.transports, () => executeWorkflow({
      ...segment.engine,
      ...(segment.streaming && segment.onEvent && { streaming: true }),
      workflow,
      resolver: registry,
      executionId,
      // A poll-started run is recorded as "poll", but only the trigger polls (and it doesn't run again here).
      mode: record.mode === 'poll' ? 'trigger' : record.mode,
      // Only credentials the workflow's project may use (lib/server/projects/credentials.ts).
      // Audit log: which credentials (ids, never values) the run used, once per node (lib/server/audit).
      // An MCP tool call's one-node workflow has no project: its endpoint already chose credentials the caller may use (lib/server/mcp/plugin-servers.ts).
      // The resolved objects are tagged with their credential's id: AI usage caps per credential (lib/server/ai-usage/credential-id.ts).
      resolveCredentials: (node, descriptor) => tagNodeCredentials(node, auditCredentialUse(executionId, workflow.id, node, record.mcp ? credentials.resolveFor(node, descriptor) : resolveWorkflowCredentials(workflow.id, node, descriptor))),
      // $secrets in node parameters when Settings → External secrets allows it; their values are redacted like credentials'.
      ...parameterSecretOptions,
      // $vars: read fresh for every run, so a change in Settings applies to the next one.
      variables: variables.forWorkflow(workflow.id),
      // Composite frames whose type falls back, times out or has properties run as one step (docs/composites.md).
      ...(scopes && { scopes }),
      resumeUrls: resumeUrls(executionId),
      debug: segment.debug,
      signal,
      // Queue mode: node rate limits count across all processes.
      ...(clusterActive() && { rateLimiter: clusterRateLimiter(coordinator) }),
      // A rate limit set on a credential holds for every node and run that uses it.
      credentialRateLimits: (node) => credentials.rateLimitsFor(node),
      onCheckpoint: (checkpoint) => {
        // The first checkpoint of a segment also keeps where it started and the `$('Node')` outputs it started with.
        const first = !checkpointed;
        checkpointed = true;
        saveProgress(() =>
          store.saveCheckpoint(executionId, {
            stepId: checkpoint.stepId,
            steps: checkpoint.steps,
            state: { ...checkpoint.state, runData: {}, executionOrder: [], nodeOutputs: {} },
            ...(first && { baseSteps, baseOutputs: checkpoint.state.nodeOutputs }),
          }),
        );
      },
      onEvent: (raw) => {
        const event = redactRunData(raw);
        trace.feed(event);
        if (event.type === 'execution.started' && event.traceId) record.traceId = event.traceId;
        if (event.type === 'node.finished') {
          (record.runData[event.nodeId] ??= []).push(event.run);
          record.executionOrder.push(event.nodeId);
          saveProgress(() => store.saveStep(executionId, record.executionOrder.length - 1, event.nodeId, event.run));
        }
        // In-process node logs also go to the process log; the node's span is active, so they carry its ids.
        if (event.type === 'node.log') {
          logger[event.level](event.message, { 'landflow.execution.id': executionId, 'landflow.node.id': event.nodeId, 'landflow.workflow.id': workflow.id });
        }
        trackProgress(event, executionId);
        // Streamed chunks go only to the caller that asked for them (the chat panel, a hosted chat, a streaming webhook).
        if (event.type !== 'node.chunk') bus.publish({ channel: 'execution', workflowId: workflow.id, event });
        segment.onEvent?.(event);
      },
    }))));
    const aiUsage = executionUsage(usage);
    finished = {
      ...record,
      ...result,
      ...(aiUsage && { aiUsage }),
      mode: record.mode,
      nodeNames: Object.fromEntries(workflow.nodes.map((n) => [n.id, n.name])),
      // The version that ran: a waiting execution resumes on it, whatever is saved later.
      workflow,
    };
    if (result.status !== 'waiting') {
      delete finished.wait;
      delete finished.resumeState;
    } else if (finished.wait && (finished.wait.resume === 'webhook' || finished.wait.resume === 'form') && resumeSignatureMode() === 'required') {
      // The URLs this wait handed out carry a signature, so resuming it needs one (see resume-signing.ts).
      finished.wait = { ...finished.wait, signed: true };
    }
    // An automatic retry pending: say when on the failed execution (and keep it, whatever the save settings).
    const retryDue = retryDueFor(finished, workflow);
    if (retryDue) finished.retryAt = retryDue.at;
    persist(finished, workflow.settings, Boolean(retryDue));
    // The steps are in the record now. A failed run keeps its checkpoint: a retry continues from it.
    saveProgress(() => store.clearCheckpoint(executionId, finished.status === 'error'));
    if (retryDue) {
      retries.schedule(finished, retryDue);
      recordRuntimeEvent('retry_scheduled', workflow.id);
    }
  } finally {
    trace.close();
    live.delete(executionId);
    // A worker frees its job's lease itself, once the result is out.
    if (clusterActive() && !segment.dispatched) void coordinator().deleteIfValue(`lease:${executionId}`, instanceId()).catch(() => {});
  }
  afterRun(finished, workflow);
  // A slot may have freed (also when a run starts waiting, unless the workflow is a singleton).
  if (limited) drainQueueSafely(workflow.id);
  return finished;
}

/**
 * For callers that answer once a run has started (a webhook answered at once, a form's end screen, a streamed reply):
 * resolves when it started (`started` resolved: undefined) or was turned down before it did (its error). onStart comes
 * synchronously in regular mode, a moment later in queue mode (the idempotency key and the slot are claimed in Valkey).
 */
export function turnedDown(run: Promise<unknown>, started: Promise<unknown>): Promise<unknown> {
  return Promise.race([started.then(() => undefined), run.then(() => undefined, (reason: unknown) => reason)]);
}

/** Start a run in the background and resolve with its id once it exists. */
export function startInBackground(options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    runWorkflow({ ...options, onStart: resolve }).catch(reject);
  });
}

/** Find the trigger node a run should start from. */
export function findTrigger(workflow: Workflow, source: 'manual' | 'webhook' | 'schedule' | 'chat', nodeId?: string) {
  if (nodeId) return workflow.nodes.find((n) => n.id === nodeId);
  return workflow.nodes.find((node) => {
    if (node.disabled) return false;
    const resolved = registry.resolve(node.type);
    return !('error' in resolved) && resolved.descriptor.kind === 'trigger' && resolved.descriptor.triggerSource === source;
  });
}

/** Held trigger events (debounce, batching) start their runs here; their timers are re-armed at boot. */
export function startTriggerBuffers(): void {
  singleton('trigger-buffers-started', () => {
    triggerBuffers.start((workflow, node, items, mode, meta) =>
      runWorkflow({
        workflow,
        mode,
        startNodeId: node.id,
        ...(meta.asOutput ? { triggerOutput: { nodeId: node.id, items } } : { triggerItems: items }),
        buffered: { kind: meta.kind, key: meta.key, count: meta.count },
      }),
    );
    return true;
  });
}
