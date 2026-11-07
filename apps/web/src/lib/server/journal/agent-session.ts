/**
 * A Landflow agent's session in a run's journal (docs/run-trace.md): a session started by a Run an Agent node carries
 * `execution`, and its timeline entries are written under that node's span: the agent's answers as messages, its tool calls
 * (and sub-agent and A2A requests) as spans, a pause for approval as a wait, a guardrail as a check. Tools connected to the
 * node in the flow (`kind: 'flow'`) are journaled by the translator from the engine's own events, so they are skipped here.
 */
import type { AgentSession, AgentTraceSummary, TimelineEntry } from '../../shared/agents';
import { reviewCommentOf } from '../../shared/review-comments';
import { toolInput, type RunActor } from '../../shared/run-trace';
import { traceModelCalls } from './trace-calls';
import { liveJournal, type Journal } from './writer';

const HUMAN: RunActor = { id: 'human', name: 'A person', type: 'human' };

type ToolEntry = Extract<TimelineEntry, { type: 'tool' }>;

interface Call {
  spanId: string;
  waiting: boolean;
  ended: boolean;
  /** Remote steps seen: id → ended. */
  steps: Map<string, 'running' | 'awaiting' | 'ended'>;
  /** Ids of the remote agent's words already journaled. */
  said: Set<string>;
  remoteWaiting: boolean;
}

/** A notice from one of the agent layers, as a Run Trace check; undefined for any other notice. */
export function layerCheck(message: string): { name: string; status: 'pass' | 'warn'; message: string } | undefined {
  if (message.startsWith('Tool access: ')) return { name: 'Tool access', status: 'warn', message: message.slice('Tool access: '.length) };
  if (message.startsWith('Routed to ')) return { name: 'Model router', status: 'pass', message };
  if (message.startsWith('Answered from the response cache')) return { name: 'Response cache', status: 'pass', message };
  return undefined;
}

export interface AgentJournal {
  (entry: TimelineEntry): void;
  /** The span a tool call of this session is recorded under, once its entry was journaled. */
  spanOf(callId: string): string | undefined;
}

/**
 * Returns the function that journals each timeline entry the runtime upserts (a no-op for sessions outside a run).
 * A team member's session (agent-teams/runtime.ts) writes under the span of the request that asked it (`under`), its words
 * between tool calls as `inline` messages, and is named by its title.
 */
export function agentSessionJournal(session: Pick<AgentSession, 'execution'>, agent: { id: string; name: string }, options: { under?: string; inline?: boolean } = {}): AgentJournal {
  const execution = session.execution;
  const calls = new Map<string, Call>();
  const spanOf = (callId: string) => calls.get(callId)?.spanId;
  if (!execution) return Object.assign((_entry: TimelineEntry) => {}, { spanOf });
  const own: RunActor = { id: `agent:${agent.id}`, name: agent.name, type: 'agent' };
  let actor = own;
  const guardrails = new Set<string>();

  const journalEntry = (entry: TimelineEntry) => {
    try {
      const journal = liveJournal(execution.executionId);
      if (!journal) return;
      const parent = options.under ?? journal.spanOfNode(execution.nodeId) ?? 'run';
      // In a flow the agent is its node: the node's spans and the session's words share one actor (a team member keeps its title).
      if (!options.under) actor = journal.actorOfNode(execution.nodeId) ?? own;
      const record = journal.record.bind(journal);

      if (entry.type === 'assistant') {
        record({ type: 'message', spanId: parent, from: actor, text: entry.text, ...(options.inline && { inline: true }), at: entry.at });
        return;
      }
      if (entry.type === 'guardrail') {
        if (guardrails.has(entry.id)) return;
        guardrails.add(entry.id);
        const found = entry.violations.map((v) => v.reason ?? `${v.check}: ${v.type}`).join('; ');
        record({
          type: 'check',
          spanId: parent,
          check: { name: `${entry.stage === 'input' ? 'Input' : entry.stage === 'tool' ? 'Tool result' : 'Output'} guardrail`, status: entry.action === 'blocked' ? 'fail' : 'warn', message: `${entry.tool ? `${entry.tool}: ` : ''}${found || (entry.action === 'blocked' ? 'Blocked' : 'Sanitized')}`, subject: agent.name, source: 'builtin', evidence: { action: entry.action, violations: entry.violations.map((v) => ({ ...v })) } },
          at: entry.at,
        });
        return;
      }
      if (entry.type === 'notice') {
        // The layers' decisions (docs/agents.md "Layers") as checks: who may use which tool, which model answered, what the cache did.
        const layer = layerCheck(entry.message);
        if (layer && !guardrails.has(entry.id)) {
          guardrails.add(entry.id);
          record({ type: 'check', spanId: parent, check: { ...layer, subject: agent.name, source: 'builtin' }, at: entry.at } as never);
        }
        return;
      }
      if (entry.type !== 'tool' || entry.kind === 'flow') return;
      tool(entry, parent, record);
    } catch {
      // The journal never breaks an agent run.
    }
  };
  return Object.assign(journalEntry, { spanOf });

  function tool(entry: ToolEntry, parent: string, record: Journal['record']) {
    const spanId = `${parent}/step:${entry.callId}`;
    let call = calls.get(entry.callId);
    const delegate = entry.kind === 'agent' || entry.kind === 'a2a';
    const remote = entry.remote;
    const target: RunActor = delegate ? { id: entry.childAgentId ? `agent:${entry.childAgentId}` : `remote:${entry.label}`, name: remote?.agent || entry.label, type: 'agent', ...(entry.nodeType && { nodeType: entry.nodeType }) } : actor;
    if (!call) {
      call = { spanId, waiting: false, ended: false, steps: new Map(), said: new Set(), remoteWaiting: false };
      calls.set(entry.callId, call);
      // A delegating tool's `reason` argument is why the agent asked: kept beside the request, not in it.
      const { reason, ...asked } = entry.input && typeof entry.input === 'object' && !Array.isArray(entry.input) ? (entry.input as Record<string, unknown>) : ({} as Record<string, unknown>);
      const why = delegate && typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 600) : undefined;
      record({
        type: 'span.started',
        spanId,
        parentSpanId: parent,
        kind: delegate ? 'delegate' : 'tool',
        name: entry.label,
        actor: target,
        ...(delegate && { caller: actor }),
        input: why ? asked : entry.input,
        attrs: { tool: entry.tool, toolKind: entry.kind, ...(entry.nodeType && { nodeType: entry.nodeType }), ...(why && { reason: why }) },
        at: entry.at,
      });
    }
    if (call.ended) return;

    // The remote agent's own calls, as the task reports them.
    if (remote) {
      const paused = remote.state === 'input-required' || remote.state === 'auth-required';
      const said = remote.said ?? [];
      const spoken = call.said;
      let nextSaid = 0;
      const sayUpTo = (steps: number) => {
        for (; nextSaid < said.length && said[nextSaid].afterSteps <= steps; nextSaid++) {
          const words = said[nextSaid];
          if (spoken.has(words.id)) continue;
          spoken.add(words.id);
          record({ type: 'message', spanId, from: target, text: words.text.slice(0, 8_000), inline: true, at: words.at ?? entry.at });
        }
      };
      for (const [index, step] of remote.steps.entries()) {
        sayUpTo(index);
        const id = `${spanId}/step:${step.id}`;
        let known = call.steps.get(step.id);
        if (!known) {
          known = 'running';
          call.steps.set(step.id, known);
          record({ type: 'span.started', spanId: id, parentSpanId: spanId, kind: 'tool', name: step.name, actor: target, ...(step.args !== undefined && { input: toolInput(step.args) }), at: step.startedAt });
        }
        if ((step.status === 'success' || step.status === 'error') && known !== 'ended') {
          call.steps.set(step.id, 'ended');
          record({ type: 'span.ended', spanId: id, status: step.status, ...(step.output !== undefined && { output: step.output }), ...(step.error && { error: step.error }), at: step.endedAt });
          // A review or comment the member left through GitHub's MCP tools (`mcp__<server>__<tool>`).
          if (step.status === 'success') reviewComment(record, id, step.name, step.args, step.output, step.endedAt);
        } else if (step.status === 'awaiting_approval' && known === 'running') {
          call.steps.set(step.id, 'awaiting');
          record({ type: 'span.updated', spanId: id, status: 'waiting' });
        }
      }
      sayUpTo(Infinity);
      if (paused && !call.remoteWaiting) {
        call.remoteWaiting = true;
        record({ type: 'span.started', spanId: `${spanId}/wait`, parentSpanId: spanId, kind: 'wait', name: `${remote.agent} needs an answer`, actor: HUMAN, caller: target, attrs: { wait: 'question' } });
      }
    }

    if (entry.status === 'awaiting_approval') {
      if (!call.waiting) {
        call.waiting = true;
        record({ type: 'span.updated', spanId, status: 'waiting', state: remote?.state });
        record({ type: 'span.started', spanId: `${spanId}/approval`, parentSpanId: spanId, kind: 'wait', name: entry.approval?.message || `Approve ${entry.label}`, actor: HUMAN, caller: target, attrs: { wait: 'approval', tool: entry.tool } });
      }
      return;
    }
    if (call.waiting) {
      call.waiting = false;
      record({ type: 'span.ended', spanId: `${spanId}/approval`, status: 'success' });
      if (entry.status === 'running') record({ type: 'span.updated', spanId, status: 'running' });
    }
    if (entry.status === 'running') return;

    // Done: success, error, or refused by a person (or by the run's rules).
    if (call.remoteWaiting) record({ type: 'span.ended', spanId: `${spanId}/wait`, status: 'success' });
    for (const [id, state] of call.steps) if (state !== 'ended') record({ type: 'span.ended', spanId: `${spanId}/step:${id}`, status: 'canceled' });
    call.ended = true;
    // A Landflow agent's own call of one of GitHub's MCP tools (nodeType core.mcpClientTool, named by the tool).
    if (entry.status === 'success' && entry.nodeType === 'core.mcpClientTool') reviewComment(record, spanId, entry.tool, entry.input, entry.output, undefined);
    if (remote?.trace) traceModelCalls(target, remote.trace, spanId, record);
    record({
      type: 'span.ended',
      spanId,
      status: entry.status === 'success' ? 'success' : entry.status === 'denied' ? 'canceled' : 'error',
      // A tool that returned images: the text as before and the images' references, so Run Trace can show them.
      ...(entry.output !== undefined && { output: entry.images?.length ? { text: entry.output, images: entry.images } : entry.output }),
      ...(entry.error && { error: entry.error }),
      ...(remote?.usage && { usage: remote.usage }),
      attrs: {
        ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
        ...(entry.childSessionId && { childSessionId: entry.childSessionId }),
        ...(entry.executionId && { executionId: entry.executionId }),
        ...(entry.workflowId && { workflowId: entry.workflowId }),
        ...(remote && { state: remote.state, ...(remote.taskId && { taskId: remote.taskId }), ...(remote.contextId && { contextId: remote.contextId }) }),
        ...(remote?.trace && { trace: { tools: remote.trace.tools, modelMs: remote.trace.modelMs, models: remote.trace.models.map((m) => m.model), subagents: remote.trace.agents.length, ...(remote.trace.mod && { mod: remote.trace.mod }) } }),
      },
    });
    if (remote?.trace) traceChecks(remote.agent, remote.trace, spanId, record);
  }
}

/** The artifact a review or comment left through GitHub's MCP tools is (lib/shared/review-comments.ts), under the span of the call. */
function reviewComment(record: Journal['record'], spanId: string, tool: string, args: unknown, output: unknown, at: string | undefined) {
  const artifact = reviewCommentOf(tool, args, output);
  if (artifact) record({ type: 'artifact', spanId, artifact, ...(at && { at }) });
}

/**
 * What the landflow-harness mod saw inside a remote agent (a2a/agent-trace.ts) as checks on its request: each tool call
 * the guardrails stopped (or, in report mode, would have), and the secrets masked in its tool results.
 */
export function traceChecks(agent: string, trace: AgentTraceSummary, spanId: string, record: Journal['record']) {
  for (const stop of trace.guard) {
    const what = `${stop.tool}${stop.arg ? `: ${stop.arg}` : ''}`;
    record({
      type: 'check',
      spanId,
      check: {
        name: 'Guardrail',
        status: 'warn',
        message: `${stop.action === 'deny' ? 'Stopped' : 'Would have stopped'} ${what} (${stop.rule}${stop.reason ? `: ${stop.reason}` : ''})`,
        subject: agent,
        source: 'builtin',
        evidence: { rule: stop.rule, tool: stop.tool, action: stop.action, ...(stop.arg && { arg: stop.arg }), ...(stop.agent && { subagent: stop.agent }) },
      },
    });
  }
  if (trace.redacted) {
    const kinds = trace.redactedKinds?.length ? ` (${trace.redactedKinds.join(', ')})` : '';
    record({
      type: 'check',
      spanId,
      check: { name: 'Secrets masked', status: 'warn', message: `Masked secrets in ${trace.redacted} tool result${trace.redacted > 1 ? 's' : ''}${kinds} before the model read them`, subject: agent, source: 'builtin', evidence: { results: trace.redacted, kinds: trace.redactedKinds ?? [] } },
    });
  }
}
