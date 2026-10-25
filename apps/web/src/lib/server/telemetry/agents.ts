/**
 * Agent spans and metrics (OTel GenAI agent conventions): `invoke_agent {name}` per run,
 * `execute_tool {tool}` per tool call; model calls inside are the usual `gen_ai.chat` spans.
 */
import type { Attributes } from '@opentelemetry/api';
import { hostMetrics, outcomeOf } from './metrics';
import { SpanKind, withSpan, type Span } from './spans';

export interface AgentRunInfo {
  agentId: string;
  agentName: string;
  sessionId: string;
  source: string;
  /** "draft" or the published version number. */
  version: string;
  model?: { provider: string; model: string };
  /** Start a new trace (schedules, channels) instead of a child of the active span. */
  root?: boolean;
}

const agentAttributes = (info: Pick<AgentRunInfo, 'agentId' | 'agentName'>) => ({ 'gen_ai.agent.id': info.agentId, 'gen_ai.agent.name': info.agentName });

/** Run one agent turn loop in an `invoke_agent {name}` span; `fn` returns how the run ended. */
export async function traceAgentRun<T extends { reason: string }>(info: AgentRunInfo, fn: (span: Span) => Promise<T>): Promise<T> {
  const instruments = hostMetrics();
  const base: Attributes = { ...agentAttributes(info), 'landflow.agent.source': info.source };
  const started = performance.now();
  let reason = 'error';
  try {
    return await withSpan(
      `invoke_agent ${info.agentName}`,
      {
        kind: SpanKind.INTERNAL,
        root: info.root,
        attributes: {
          ...base,
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.conversation.id': info.sessionId,
          'landflow.agent.version': info.version,
          ...(info.model && { 'gen_ai.system': info.model.provider, 'gen_ai.request.model': info.model.model }),
        },
      },
      async (span) => {
        const result = await fn(span);
        reason = result.reason;
        span.setAttribute('landflow.agent.end_reason', reason);
        return result;
      },
    );
  } finally {
    instruments.agentRuns.add(1, { ...base, 'landflow.agent.end_reason': reason });
    instruments.agentRunDuration.record(performance.now() - started, base);
  }
}

export interface ToolCallInfo {
  agentId: string;
  agentName: string;
  tool: string;
  callId: string;
  kind: string;
}

/** Run one tool call in an `execute_tool {tool}` span and count it. */
export async function traceToolCall<T>(info: ToolCallInfo, fn: () => Promise<T>): Promise<T> {
  const instruments = hostMetrics();
  const base: Attributes = { ...agentAttributes(info), 'gen_ai.tool.name': info.tool, 'landflow.agent.tool.kind': info.kind };
  const started = performance.now();
  let outcome = 'ok';
  try {
    return await withSpan(
      `execute_tool ${info.tool}`,
      { kind: SpanKind.INTERNAL, attributes: { ...base, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.id': info.callId, 'gen_ai.tool.type': 'function' } },
      fn,
    );
  } catch (error) {
    outcome = outcomeOf(error);
    throw error;
  } finally {
    instruments.agentToolCalls.add(1, { ...base, 'landflow.outcome': outcome });
    instruments.agentToolDuration.record(performance.now() - started, base);
  }
}

export function recordApproval(info: Pick<ToolCallInfo, 'agentId' | 'agentName' | 'tool'>, decision: 'approved' | 'denied') {
  hostMetrics().agentApprovals.add(1, { ...agentAttributes(info), 'gen_ai.tool.name': info.tool, 'landflow.agent.approval.decision': decision });
}

export function recordAgentTokens(info: Pick<AgentRunInfo, 'agentId' | 'agentName'>, usage: { inputTokens: number; outputTokens: number }) {
  const { agentTokens } = hostMetrics();
  if (usage.inputTokens) agentTokens.add(usage.inputTokens, { ...agentAttributes(info), 'gen_ai.token.type': 'input' });
  if (usage.outputTokens) agentTokens.add(usage.outputTokens, { ...agentAttributes(info), 'gen_ai.token.type': 'output' });
}
