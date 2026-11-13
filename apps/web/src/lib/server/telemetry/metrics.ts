/**
 * Host metric instruments (docs/observability.md §5). The flow metrics of
 * executions and node runs are recorded by the engine itself.
 */
import { metrics, type Attributes, type Counter, type Histogram, type MeterProvider } from '@opentelemetry/api';
import { DURATION_BUCKETS_MS } from '@landflow/engine';
import { telemetryConfig } from './config';

export const HOST_SCOPE = 'landflow-host';
const advice = { explicitBucketBoundaries: DURATION_BUCKETS_MS };
/** Semantic-convention buckets for http.server.request.duration (seconds). */
/** Database calls are mostly well under a millisecond: finer low buckets than the duration default. */
const DB_BUCKETS_MS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 1000];
const HTTP_BUCKETS_S = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

/**
 * `landflow.workflow.id` on the counters below only with LANDFLOW_METRICS_WORKFLOW_LABEL=true: one series per workflow
 * grows without bound, and on a histogram it multiplies by every bucket. Spans and exemplars keep the id.
 */
export const workflowLabel = (workflowId?: string): Attributes => (workflowId && telemetryConfig.workflowLabel ? { 'landflow.workflow.id': workflowId } : {});

function create(provider: MeterProvider) {
  const meter = provider.getMeter(HOST_SCOPE, telemetryConfig.serviceVersion);
  return {
    meter,
    triggerFires: meter.createCounter('landflow.trigger.fires', { description: 'Triggers that started an execution' }),
    pollRuns: meter.createCounter('landflow.poll.runs', { description: 'Polls of polling triggers' }),
    pollDuration: meter.createHistogram('landflow.poll.duration', { description: 'Duration of a poll', unit: 'ms', advice }),
    scheduleLag: meter.createHistogram('landflow.schedule.lag', { description: 'How late a scheduled run started', unit: 'ms', advice }),
    webhookRequests: meter.createCounter('landflow.webhook.requests', { description: 'Production webhook requests' }),
    rpcDuration: meter.createHistogram('landflow.plugin.rpc.duration', { description: 'Host to plugin RPC duration', unit: 'ms', advice }),
    heartbeats: meter.createCounter('landflow.plugin.heartbeats', { description: 'Plugin announces and heartbeats received' }),
    mcpToolCalls: meter.createCounter('landflow.mcp.tool.calls', { description: 'Tool calls on the per-plugin MCP endpoints, by plugin, tool and outcome' }),
    aiRequests: meter.createCounter('landflow.ai.requests', { description: 'Model requests (chat and embeddings)' }),
    aiDuration: meter.createHistogram('landflow.ai.duration', { description: 'Model request duration (chat and embeddings)', unit: 'ms', advice }),
    aiTokens: meter.createCounter('landflow.ai.tokens', { description: 'Model tokens (embeddings count input tokens only)' }),
    aiCost: meter.createCounter('landflow.ai.cost', { description: 'Estimated cost of model calls by the price table', unit: 'USD' }),
    aiCapsReached: meter.createCounter('landflow.ai.caps_reached', { description: 'Model calls refused or runs stopped by an AI usage cap' }),
    agentRuns: meter.createCounter('landflow.agent.runs', { description: 'Agent runs (one per user message, schedule fire or resumed approval)' }),
    agentRunDuration: meter.createHistogram('landflow.agent.run.duration', { description: 'Duration of an agent run', unit: 'ms', advice }),
    agentToolCalls: meter.createCounter('landflow.agent.tool.calls', { description: 'Tool calls made by agents' }),
    agentToolDuration: meter.createHistogram('landflow.agent.tool.duration', { description: 'Duration of an agent tool call', unit: 'ms', advice }),
    agentApprovals: meter.createCounter('landflow.agent.approvals', { description: 'Tool calls a person approved or denied' }),
    agentTokens: meter.createCounter('landflow.agent.tokens', { description: 'Model tokens used by agents' }),
    a2aCalls: meter.createCounter('landflow.a2a.calls', { description: 'Calls to remote A2A agents, by agent, method, final task state and outcome' }),
    a2aDuration: meter.createHistogram('landflow.a2a.call.duration', { description: 'Duration of a call to a remote A2A agent (until its task settles)', unit: 'ms', advice }),
    a2aTokens: meter.createCounter('landflow.a2a.tokens', { description: 'Model tokens remote A2A agents report using (kagent usage extension)' }),
    a2aToolCalls: meter.createCounter('landflow.a2a.tool.calls', { description: 'Tool calls remote A2A agents made, by agent, tool and status' }),
    dbDuration: meter.createHistogram('landflow.db.query.duration', { description: 'Duration of a database call (SQL text is never a label)', unit: 'ms', advice: { explicitBucketBoundaries: DB_BUCKETS_MS } }),
    gcDuration: meter.createHistogram('landflow.runtime.gc.duration', { description: 'Garbage collection pauses, by kind', unit: 'ms', advice: { explicitBucketBoundaries: DB_BUCKETS_MS } }),
    signInFailures: meter.createCounter('landflow.auth.sign_in_failures', { description: 'Failed sign-in attempts (wrong password or unknown user)' }),
    authLimited: meter.createCounter('landflow.auth.limited', { description: 'Attempts a rate limiter refused, by limiter' }),
    sseConnections: meter.createUpDownCounter('landflow.sse.connections', { description: 'Open Server-Sent Events streams, by route' }),
    runtimeEvents: meter.createCounter('landflow.runtime.events', { description: 'Durable runtime events: deduplicated, skipped, queued, recovered and retried runs' }),
    httpDuration: meter.createHistogram('http.server.request.duration', {
      description: 'Duration of HTTP server requests',
      unit: 's',
      advice: { explicitBucketBoundaries: HTTP_BUCKETS_S },
    }),
  };
}

type Instruments = ReturnType<typeof create>;
let cached: { provider: MeterProvider; instruments: Instruments } | undefined;

/** The instruments, re-created if the global meter provider changed (the metrics API has no proxy). */
export function hostMetrics(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider !== provider) cached = { provider, instruments: create(provider) };
  return cached.instruments;
}

export type Outcome = 'ok' | 'error' | 'timeout';

/** `timeout` for deadline / abort-timeout errors, else `error`. */
export function outcomeOf(error: unknown): Outcome {
  const { name, code } = (error ?? {}) as { name?: string; code?: unknown };
  return name === 'TimeoutError' || code === 4 /* grpc DEADLINE_EXCEEDED */ ? 'timeout' : 'error';
}

// ---------------------------------------------------------------------------
// Small recorders used across the host
// ---------------------------------------------------------------------------

export function recordScheduleLag(_workflowId: string, lagMs: number) {
  hostMetrics().scheduleLag.record(Math.max(0, lagMs));
}

export function recordWebhookRequest(status: number, workflowId?: string) {
  hostMetrics().webhookRequests.add(1, { ...workflowLabel(workflowId), 'http.response.status_code': status });
}

/** What the durable runtime did with a run (docs/observability.md §5). */
export type RuntimeEvent = 'deduplicated' | 'skipped' | 'queued' | 'recovered' | 'recovery_failed' | 'retry_scheduled' | 'retried' | 'stopped';

export function recordRuntimeEvent(event: RuntimeEvent, workflowId?: string, count = 1) {
  if (count > 0) hostMetrics().runtimeEvents.add(count, { 'landflow.runtime.event': event, ...workflowLabel(workflowId) });
}

/** One announce or heartbeat from a plugin (HTTP route or gRPC RegistryService). */
export function recordHeartbeat(pluginId: string) {
  hostMetrics().heartbeats.add(1, { 'landflow.plugin.id': pluginId });
}

export type DbOperation = 'select' | 'insert' | 'upsert' | 'delete' | 'direct';

export function recordDbQuery(operation: DbOperation, ms: number) {
  hostMetrics().dbDuration.record(ms, { 'db.operation': operation });
}

/** A failed sign-in (docs/observability.md §5): the counter an alert on credential stuffing reads. */
export function recordSignInFailure() {
  hostMetrics().signInFailures.add(1);
}

/** A rate limiter said no (`limiter`: `email`, `ip`, `form`). */
export function recordAuthLimited(limiter: string) {
  hostMetrics().authLimited.add(1, { 'landflow.limiter': limiter });
}

/** An SSE stream opened (+1) or closed (-1). */
export function recordSseConnection(route: string, delta: 1 | -1) {
  hostMetrics().sseConnections.add(delta, { 'http.route': route });
}

export function recordHttpServerDuration(seconds: number, attributes: Attributes) {
  hostMetrics().httpDuration.record(seconds, attributes);
}

const observed = new WeakSet<object>();

/**
 * `landflow.plugins.online`: plugins online per language, read from `list()` at
 * every collection. Registered once per meter provider.
 */
export function observePluginsOnline(list: () => Array<{ status: string; info: { language: string } }>) {
  const { meter } = hostMetrics();
  if (observed.has(meter)) return;
  observed.add(meter);
  meter.createObservableGauge('landflow.plugins.online', { description: 'Registered plugins that are online' }).addCallback((result) => {
    const byLanguage = new Map<string, number>();
    for (const plugin of list()) {
      const language = plugin.info.language || 'unknown';
      byLanguage.set(language, (byLanguage.get(language) ?? 0) + (plugin.status === 'online' ? 1 : 0));
    }
    for (const [language, count] of byLanguage) result.observe(count, { 'landflow.plugin.language': language });
  });
}

export type { Counter, Histogram };
