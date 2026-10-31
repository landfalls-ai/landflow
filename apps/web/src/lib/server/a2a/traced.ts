/**
 * A2A calls as Landflow makes them: streamed when the agent's card offers streaming (each tool call shows as it happens),
 * else sent and polled; inside an `invoke_agent {agent}` client span whose trace context goes along (telemetry/a2a.ts);
 * tagged with `landflow.*` message metadata. kagent's docs say it copies those onto its `a2a.request` span as
 * `a2a.message.metadata.landflow.*`; 1.0.0-alpha17 doesn't yet (docs/a2a.md), so the trace context and the shared
 * context and task ids are what tie the two sides together.
 */
import type { RemoteRun } from '../../shared/agents';
import { traceA2aCall, type A2aCallSummary } from '../telemetry';
import {
  cancelTask,
  getTask,
  hitlRequestOf,
  remoteSaidOf,
  remoteStepsOf,
  sendMessage,
  stateName,
  streamMessage,
  tokenUsageOf,
  type A2aEndpoint,
  type A2aResult,
  type A2aTask,
  type AgentCard,
  type OutgoingMessage,
  type SendOptions,
} from './client';

export interface CallOptions extends SendOptions {
  caller: 'agent' | 'node';
  /** The task after each stream event (or poll): the remote agent's progress. */
  onUpdate?: (task: A2aTask) => void;
  /** `false` sends and polls even when the agent streams. */
  stream?: boolean;
}

/** What a result says, for its span and metrics. */
export function summaryOf(result: A2aResult): A2aCallSummary {
  if (result.kind === 'message') return { state: 'completed', ...(result.message.contextId && { contextId: result.message.contextId }) };
  const { task } = result;
  const request = hitlRequestOf(task);
  const usage = tokenUsageOf(task);
  const steps = remoteStepsOf(task);
  return {
    state: stateName(task.status.state),
    taskId: task.id,
    contextId: task.contextId,
    ...(usage && { usage }),
    ...(steps.length && { steps }),
    ...(request && { pause: request.type === 'tool_approval_request' ? 'approval' : 'question' }),
  };
}

/** Send a message to the agent and wait for its task to settle, traced. */
export function callAgent(endpoint: A2aEndpoint, card: AgentCard, message: OutgoingMessage, options: CallOptions): Promise<A2aResult> {
  const streaming = options.stream !== false && Boolean(card.capabilities?.streaming);
  const { caller, stream: _stream, ...send } = options;
  return traceA2aCall(
    {
      method: streaming ? 'SendStreamingMessage' : 'SendMessage',
      url: endpoint.url,
      agentName: card.name,
      caller,
      ...(message.contextId && { contextId: message.contextId }),
      ...(message.taskId && { taskId: message.taskId }),
    },
    (headers) => {
      const withTrace = { ...send, headers: { ...send.headers, ...headers } };
      return streaming ? streamMessage(endpoint, message, withTrace) : sendMessage(endpoint, message, withTrace);
    },
    summaryOf,
  );
}

/** The remote run a task shows: state, tool calls, usage. */
export function remoteRunOf(card: AgentCard, task: A2aTask): RemoteRun {
  const usage = tokenUsageOf(task);
  const said = remoteSaidOf(task);
  return {
    agent: card.name,
    state: stateName(task.status.state),
    taskId: task.id,
    contextId: task.contextId,
    steps: remoteStepsOf(task),
    ...(said.length > 0 && { said }),
    ...(usage && { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }),
  };
}

/** Calls `report` when the run changed (a step or the state) or every half second at most: text chunks stream fast. */
export function throttled(report: ((remote: RemoteRun) => void) | undefined, card: AgentCard) {
  if (!report) return undefined;
  let last = 0;
  let lastKey = '';
  return (task: A2aTask) => {
    const run = remoteRunOf(card, task);
    const key = `${run.state}|${run.steps.map((s) => `${s.id}:${s.status}`).join(',')}|${run.said?.length ?? 0}`;
    if (key === lastKey && Date.now() - last < 500) return;
    last = Date.now();
    lastKey = key;
    report(run);
  };
}

/** GetTask or CancelTask, traced. */
export function taskCall(endpoint: A2aEndpoint, card: AgentCard, method: 'GetTask' | 'CancelTask', taskId: string, options: Omit<CallOptions, 'onUpdate' | 'stream'>): Promise<A2aTask> {
  const { caller, ...send } = options;
  return traceA2aCall(
    { method, url: endpoint.url, agentName: card.name, caller, taskId },
    (headers) => (method === 'GetTask' ? getTask : cancelTask)(endpoint, taskId, { ...send, headers: { ...send.headers, ...headers } }),
    (task) => summaryOf({ kind: 'task', task }),
  );
}

/** `landflow.*` tags for a message's metadata: string values only, empty ones dropped. */
export function landflowTags(tags: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).flatMap(([key, value]) => (value ? [[`landflow.${key}`, value]] : [])));
}
