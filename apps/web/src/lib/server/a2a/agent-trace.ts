/**
 * What Landflow's Claude Code agents on kagent report while they work (docs/a2a.md, "The landflow-harness mod"). kagent's
 * Claude Code harness sends no token usage over A2A, so Landflow adds its own mod to those agents
 * (claude-plugins/landflow-harness): a request from a run carries a marker line with a trace URL, and the mod posts what
 * Claude Code does there (each model request's tokens and time, each tool call's, the guardrails' decisions, the masked
 * secrets) to POST /api/agent-trace/<id> (app/api/agent-trace/[id]/route.ts).
 *
 * A trace lives in this process while its call runs: `openTrace` makes one (an unguessable id is the URL's only
 * credential), the route feeds it, and the caller reads the summary as it grows and once more when the call ends
 * (`close` waits a moment for the mod's last batch). Closed traces answer 410 for a minute, then are forgotten. In
 * queue mode the id starts with the process that holds the trace (`<instance>.<random>`): the main the mod posts to
 * forwards a batch it doesn't hold to that process's inbox (`forwardTrace`), so a worker's call gets its real usage.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AgentTraceSummary, TokenUsage, TraceGuardDecision } from '../../shared/agents';
import { agentStore } from '../agents/store';
import { estimateCost, findPrice, priceOverrides } from '../ai-usage/prices';
import { clusterActive, clusterState } from '../cluster/state';
import { singleton } from '../singleton';
import { logger } from '../telemetry';

/** Open traces at once: a run asks few agents at a time; more is a leak or abuse. */
const MAX_TRACES = 500;
const MAX_EVENTS = 5_000;
const MAX_GUARD = 50;
const MAX_CALLS = 300;
/** How long a closed trace answers 410 (the mod stops posting there), ms. */
const KEEP_CLOSED_MS = 60_000;
/** An open trace nobody closed (a crashed call) goes after this long, ms. */
const MAX_AGE_MS = 6 * 60 * 60_000;

export type GuardMode = 'strict' | 'enforce' | 'report' | 'off';

const count = z.number().finite().min(0).max(1e12).catch(0);
/** The mod's clock, epoch ms (about 1.8e12 now: over the cap of the counts). */
const clock = z.number().finite().min(0).max(1e14).catch(0);
const text = (max: number) => z.string().max(4_000).transform((s) => s.slice(0, max));
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), at: clock.optional(), mod: text(40).optional(), guard: z.enum(['strict', 'enforce', 'report', 'off']).optional() }),
  z.object({
    type: z.literal('step'),
    at: clock.optional(),
    ms: count.optional(),
    agent: text(80).optional(),
    model: text(120).optional(),
    stop: text(40).optional(),
    input: count.optional(),
    output: count.optional(),
    cacheRead: count.optional(),
    cacheWrite: count.optional(),
    tools: z.array(text(120)).max(100).optional(),
    server: z.array(text(120)).max(100).optional(),
  }),
  z.object({ type: z.literal('tool'), at: clock.optional(), ms: count.optional(), tool: text(120), agent: text(80).optional(), ok: z.boolean().optional(), denied: z.boolean().optional(), arg: text(200).optional() }),
  z.object({ type: z.literal('guard'), at: clock.optional(), rule: text(60), tool: text(120), agent: text(80).optional(), arg: text(200).optional(), reason: text(400).optional(), action: z.enum(['deny', 'report']).optional() }),
  z.object({ type: z.literal('redact'), at: clock.optional(), agent: text(80).optional(), kinds: z.array(text(60)).max(20).optional() }),
  z.object({ type: z.literal('spawn'), at: clock.optional(), agent: text(80), kind: text(80).optional(), description: text(200).optional(), model: text(120).optional() }),
  z.object({ type: z.literal('turn'), at: clock.optional(), ms: count.optional(), agent: text(80).optional(), reason: text(40).optional() }),
]);
type TraceEvent = z.infer<typeof eventSchema>;

interface Trace {
  id: string;
  /** The provider of the agent's model, to price its requests (ollama: free unless priced in Settings). */
  provider: string;
  createdAt: number;
  closedAt?: number;
  events: number;
  /** The main loop's turn ended: the mod sent everything it had. */
  done: boolean;
  summary?: AgentTraceSummary;
  listeners: Set<(summary: AgentTraceSummary) => void>;
}

const traces = () => singleton('agent-traces', () => new Map<string, Trace>());

function sweep(now = Date.now()) {
  for (const [id, trace] of traces()) {
    if ((trace.closedAt && now - trace.closedAt > KEEP_CLOSED_MS) || now - trace.createdAt > MAX_AGE_MS) traces().delete(id);
  }
}

const emptySummary = (): AgentTraceSummary => ({
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 },
  models: [],
  agents: [],
  tools: { calls: 0, failed: 0, ms: 0 },
  modelMs: 0,
  guard: [],
  redacted: 0,
});

function apply(trace: Trace, event: TraceEvent) {
  const s = (trace.summary ??= emptySummary());
  switch (event.type) {
    case 'start':
      if (event.mod) s.mod = event.mod;
      if (event.guard) s.guardMode = event.guard;
      break;
    case 'step': {
      const input = (event.input ?? 0) + (event.cacheRead ?? 0) + (event.cacheWrite ?? 0);
      const output = event.output ?? 0;
      const model = event.model || 'unknown';
      const cost = estimateCost(findPrice(trace.provider, model, priceOverrides()), input, output, event.cacheRead ?? 0, event.cacheWrite ?? 0);
      const add = (u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; requests: number }) => {
        u.inputTokens += input;
        u.outputTokens += output;
        u.cacheReadTokens += event.cacheRead ?? 0;
        u.cacheWriteTokens += event.cacheWrite ?? 0;
        u.costUsd += cost;
        u.requests++;
      };
      add(s.usage);
      s.usage.model = model;
      let byModel = s.models.find((m) => m.model === model);
      if (!byModel) s.models.push((byModel = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 }));
      add(byModel);
      if (event.agent) {
        let agent = s.agents.find((a) => a.id === event.agent);
        if (!agent) s.agents.push((agent = { id: event.agent, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 }));
        add(agent);
        agent.model = model;
      }
      if ((s.calls ??= []).length < MAX_CALLS) {
        s.calls.push({ ...(event.at && { at: event.at }), ms: event.ms ?? 0, model, ...(event.agent && { agent: event.agent }), inputTokens: input, outputTokens: output, cacheReadTokens: event.cacheRead ?? 0, cacheWriteTokens: event.cacheWrite ?? 0, costUsd: Math.round(cost * 1e6) / 1e6 });
      }
      s.modelMs += event.ms ?? 0;
      if (event.server?.length) s.serverTools = (s.serverTools ?? 0) + event.server.length;
      break;
    }
    case 'tool':
      s.tools.calls++;
      if (event.ok === false) s.tools.failed++;
      s.tools.ms += event.ms ?? 0;
      break;
    case 'guard': {
      const decision: TraceGuardDecision = { rule: event.rule, tool: event.tool, action: event.action ?? 'deny', ...(event.arg && { arg: event.arg }), ...(event.reason && { reason: event.reason }), ...(event.agent && { agent: event.agent }) };
      if (s.guard.length < MAX_GUARD) s.guard.push(decision);
      break;
    }
    case 'redact':
      s.redacted++;
      for (const kind of event.kinds ?? []) if (!(s.redactedKinds ??= []).includes(kind)) s.redactedKinds.push(kind);
      break;
    case 'spawn': {
      let agent = s.agents.find((a) => a.id === event.agent);
      if (!agent) s.agents.push((agent = { id: event.agent, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 }));
      if (event.kind) agent.kind = event.kind;
      if (event.description) agent.description = event.description;
      if (event.model) agent.model = event.model;
      break;
    }
    case 'turn':
      if (!event.agent) {
        s.turnMs = (s.turnMs ?? 0) + (event.ms ?? 0);
        trace.done = true;
      }
      break;
  }
}

export interface TraceHandle {
  id: string;
  /** Where the mod posts: `<landflowUrl>/api/agent-trace/<id>`. */
  url: string;
  /** The line the request starts with: the mod takes it off before the model reads the prompt. */
  marker: string;
  /** What the agent has reported so far; undefined until it reports anything (no mod, or it can't reach Landflow). */
  summary(): AgentTraceSummary | undefined;
  /** Hear each batch as it lands; returns a function that stops it. */
  onChange(listener: (summary: AgentTraceSummary) => void): () => void;
  /** The call ended: wait up to `graceMs` for the mod's last batch (its turn's end), then close. */
  close(graceMs?: number): Promise<AgentTraceSummary | undefined>;
}

/** A trace for one call to a Claude Code agent with the mod. `baseUrl`: Landflow as the agent reaches it. */
export function openTrace(options: { baseUrl: string; provider?: string; guard?: GuardMode }): TraceHandle {
  sweep();
  if (traces().size >= MAX_TRACES) {
    const oldest = [...traces().values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) traces().delete(oldest.id);
  }
  const random = randomBytes(18).toString('base64url');
  // In queue mode the process that holds it is in the id, so another one can pass the mod's batches on (forwardTrace).
  const id = clusterActive() ? `${Buffer.from(clusterState().config.instanceId).toString('base64url')}.${random}` : random;
  const trace: Trace = { id, provider: (options.provider ?? 'anthropic').toLowerCase(), createdAt: Date.now(), events: 0, done: false, listeners: new Set() };
  traces().set(id, trace);
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/agent-trace/${id}`;
  return {
    id,
    url,
    marker: `<!-- landflow-trace ${url}${options.guard && options.guard !== 'enforce' ? ` guard=${options.guard}` : ''} -->`,
    summary: () => (trace.summary ? structuredClone(trace.summary) : undefined),
    onChange(listener) {
      trace.listeners.add(listener);
      return () => trace.listeners.delete(listener);
    },
    async close(graceMs = 2_000) {
      for (const end = Date.now() + graceMs; !trace.done && trace.summary && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
      trace.closedAt = Date.now();
      trace.listeners.clear();
      return trace.summary ? structuredClone(trace.summary) : undefined;
    },
  };
}

export type IngestResult = 'ok' | 'unknown' | 'closed' | 'full';

/** A batch from the mod. Events that don't parse are skipped, not the batch. */
export function ingestTrace(id: string, events: unknown[]): IngestResult {
  const trace = traces().get(id);
  if (!trace || Date.now() - trace.createdAt > MAX_AGE_MS) return 'unknown';
  if (trace.closedAt) return 'closed';
  if (trace.events + events.length > MAX_EVENTS) return 'full';
  let skipped = 0;
  for (const raw of events) {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    trace.events++;
    apply(trace, parsed.data);
  }
  if (skipped) logger.debug('agent trace: events skipped', { trace: id, skipped });
  if (trace.summary) for (const listener of trace.listeners) listener(structuredClone(trace.summary));
  return 'ok';
}

/** Ids the route takes: an unguessable part, after the holder's instance in queue mode. */
export const TRACE_ID = /^(?:[A-Za-z0-9_-]{1,96}\.)?[A-Za-z0-9_-]{16,64}$/;

/** The instance that holds a trace (queue mode), from its id. */
export function traceHolder(id: string): string | undefined {
  const dot = id.indexOf('.');
  if (dot <= 0) return undefined;
  try {
    return Buffer.from(id.slice(0, dot), 'base64url').toString('utf8') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Queue mode: a batch for a trace another process holds goes to that process's inbox (it ingests it, see cluster/index.ts).
 * True when it was sent on; the answer can't say whether that process still has the trace.
 */
export function forwardTrace(id: string, events: unknown[]): boolean {
  if (!clusterActive()) return false;
  const holder = traceHolder(id);
  const { relay, config } = clusterState();
  if (!holder || !relay || holder === config.instanceId) return false;
  void relay.send(holder, { t: 'trace', id, events });
  return true;
}

/** For tests. */
export function resetTraces() {
  traces().clear();
}

const trimmed = (url: string) => url.replace(/\/+$/, '');

/**
 * A trace for a call to the A2A agent at `endpointUrl`, when it is a Landflow agent deployed to kagent with the mod
 * (its deployment has `trace`); undefined for any other agent. Matched by its A2A URL, else by the kagent name the URL
 * ends with (`…/agents/<namespace>/<name>`) when only one such agent has it.
 */
export function traceFor(endpointUrl: string): TraceHandle | undefined {
  const traced = agentStore.list().filter((agent) => agent.kagent?.trace);
  const url = trimmed(endpointUrl);
  let agent = traced.find((a) => a.kagent?.trace?.a2aUrl && trimmed(a.kagent.trace.a2aUrl) === url);
  if (!agent) {
    const name = /\/agents\/[^/]+\/([^/?#]+)$/.exec(url)?.[1];
    const named = name ? traced.filter((a) => a.kagent?.name === decodeURIComponent(name)) : [];
    if (named.length === 1) agent = named[0];
  }
  const target = agent?.kagent?.trace;
  if (!agent || !target) return undefined;
  const model = (agent.published?.config ?? agent).model;
  return openTrace({ baseUrl: target.url.replace(/\/api\/agent-trace\/?$/, ''), provider: model?.provider ?? 'anthropic' });
}

/** The message with the trace's marker as its first line (only a new request's text: the mod reads it from the prompt). */
export function withMarker<M extends { text?: string; taskId?: string }>(message: M, trace: TraceHandle | undefined): M {
  if (!trace || !message.text || message.taskId) return message;
  return { ...message, text: `${trace.marker}\n${message.text}` };
}

/** A trace's usage as a run counts it. */
export function usageOfTrace(summary: AgentTraceSummary | undefined): TokenUsage | undefined {
  if (!summary?.usage.requests) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, requests, model } = summary.usage;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: Math.round(costUsd * 1e6) / 1e6, requests, ...(model && { model }) };
}
