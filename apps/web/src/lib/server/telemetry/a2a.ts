/**
 * A2A client spans and metrics (docs/observability.md): an `invoke_agent {agent}` client span per call to a remote agent
 * (OTel GenAI agent conventions, plus the RPC ones for the JSON-RPC call), whose trace context goes along as `traceparent`
 * so the agent's own spans (kagent: controller, Agent Substrate router, agent runtime) join the trace. The task the call
 * ends with adds its id, state and token usage, and one `a2a.tool_call` event per tool call the agent made.
 */
import { context, propagation, type Attributes } from '@opentelemetry/api';
import { hostMetrics, outcomeOf } from './metrics';
import { failSpan, SpanKind, startSpan, type Span } from './spans';

export interface A2aCallInfo {
  /** The JSON-RPC method: SendMessage, SendStreamingMessage, GetTask, CancelTask. */
  method: string;
  url: string;
  /** The agent card's name. */
  agentName: string;
  /** Continuing a conversation or answering a pause. */
  contextId?: string;
  taskId?: string;
  /** Who calls: an agent's A2A capability or the A2A Agent node. */
  caller: 'agent' | 'node';
}

/** What a call ended with, read from its task by the caller (lib/server/a2a/client.ts). */
export interface A2aCallSummary {
  state: string;
  taskId?: string;
  contextId?: string;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number };
  steps?: Array<{ id: string; name: string; status: string; startedAt?: string; error?: string }>;
  /** A pause: `approval` or `question`. */
  pause?: string;
}

const RPC_SERVICE = 'lf.a2a.v1.A2AService';

function address(url: string): Attributes {
  try {
    const parsed = new URL(url);
    return { 'server.address': parsed.hostname, ...(parsed.port && { 'server.port': Number(parsed.port) }), 'url.full': `${parsed.origin}${parsed.pathname}` };
  } catch {
    return {};
  }
}

/** Record the end of a call on its span: task id, state, usage, the agent's tool calls as events. */
function describe(span: Span, info: A2aCallInfo, summary: A2aCallSummary) {
  span.setAttributes({
    'a2a.task.state': summary.state,
    ...(summary.taskId && { 'a2a.task.id': summary.taskId }),
    ...(summary.contextId && { 'gen_ai.conversation.id': summary.contextId }),
    ...(summary.usage && { 'gen_ai.usage.input_tokens': summary.usage.inputTokens, 'gen_ai.usage.output_tokens': summary.usage.outputTokens }),
    ...(summary.usage?.cachedInputTokens && { 'gen_ai.usage.cache_read.input_tokens': summary.usage.cachedInputTokens }),
    ...(summary.usage?.reasoningTokens && { 'gen_ai.usage.reasoning.output_tokens': summary.usage.reasoningTokens }),
    ...(summary.steps && { 'landflow.a2a.tool_calls': summary.steps.length }),
    ...(summary.pause && { 'landflow.a2a.pause': summary.pause }),
  });
  const instruments = hostMetrics();
  for (const step of summary.steps ?? []) {
    const at = step.startedAt ? Date.parse(step.startedAt) : NaN;
    span.addEvent(
      'a2a.tool_call',
      { 'gen_ai.tool.name': step.name, 'gen_ai.tool.call.id': step.id, 'landflow.a2a.tool.status': step.status, ...(step.error && { 'error.message': step.error.slice(0, 500) }) },
      Number.isFinite(at) ? at : undefined,
    );
    instruments.a2aToolCalls.add(1, { 'gen_ai.agent.name': info.agentName, 'gen_ai.tool.name': step.name, 'landflow.a2a.tool.status': step.status });
  }
  if (summary.usage?.inputTokens) instruments.a2aTokens.add(summary.usage.inputTokens, { 'gen_ai.agent.name': info.agentName, 'gen_ai.token.type': 'input' });
  if (summary.usage?.outputTokens) instruments.a2aTokens.add(summary.usage.outputTokens, { 'gen_ai.agent.name': info.agentName, 'gen_ai.token.type': 'output' });
}

/**
 * Run one A2A call in an `invoke_agent {agent}` client span. `call` gets the W3C trace-context headers to send; `summarize`
 * reads what the call ended with. A failed or canceled task sets the span's error status.
 */
export async function traceA2aCall<T>(info: A2aCallInfo, call: (headers: Record<string, string>) => Promise<T>, summarize: (result: T) => A2aCallSummary): Promise<T> {
  const base: Attributes = { 'gen_ai.agent.name': info.agentName, 'rpc.method': info.method, 'landflow.a2a.caller': info.caller };
  const { span, context: spanContext } = startSpan(`invoke_agent ${info.agentName}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      ...base,
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'a2a',
      'rpc.system': 'jsonrpc',
      'rpc.service': RPC_SERVICE,
      'rpc.jsonrpc.version': '2.0',
      ...address(info.url),
      ...(info.contextId && { 'gen_ai.conversation.id': info.contextId }),
      ...(info.taskId && { 'a2a.task.id': info.taskId }),
    },
  });
  const headers: Record<string, string> = {};
  propagation.inject(spanContext, headers);
  const started = performance.now();
  let outcome = 'ok';
  let state = 'unknown';
  try {
    const result = await context.with(spanContext, () => call(headers));
    const summary = summarize(result);
    state = summary.state;
    describe(span, info, summary);
    if (state === 'failed' || state === 'rejected' || state === 'canceled') {
      outcome = 'error';
      failSpan(span, new Error(`${info.agentName}: the task ${state}`));
    }
    return result;
  } catch (error) {
    outcome = outcomeOf(error);
    failSpan(span, error);
    throw error;
  } finally {
    span.end();
    const instruments = hostMetrics();
    instruments.a2aCalls.add(1, { ...base, 'a2a.task.state': state, 'landflow.outcome': outcome });
    instruments.a2aDuration.record(performance.now() - started, base);
  }
}
