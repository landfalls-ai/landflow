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
const HTTP_BUCKETS_S = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

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
    aiRequests: meter.createCounter('landflow.ai.requests', { description: 'Model requests (chat and embeddings)' }),
    aiDuration: meter.createHistogram('landflow.ai.duration', { description: 'Model request duration (chat and embeddings)', unit: 'ms', advice }),
    aiTokens: meter.createCounter('landflow.ai.tokens', { description: 'Model tokens (embeddings count input tokens only)' }),
    agentRuns: meter.createCounter('landflow.agent.runs', { description: 'Agent runs (one per user message, schedule fire or resumed approval)' }),
    agentRunDuration: meter.createHistogram('landflow.agent.run.duration', { description: 'Duration of an agent run', unit: 'ms', advice }),
    agentToolCalls: meter.createCounter('landflow.agent.tool.calls', { description: 'Tool calls made by agents' }),
    agentToolDuration: meter.createHistogram('landflow.agent.tool.duration', { description: 'Duration of an agent tool call', unit: 'ms', advice }),
    agentApprovals: meter.createCounter('landflow.agent.approvals', { description: 'Tool calls a person approved or denied' }),
    agentTokens: meter.createCounter('landflow.agent.tokens', { description: 'Model tokens used by agents' }),
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

export function recordScheduleLag(workflowId: string, lagMs: number) {
  hostMetrics().scheduleLag.record(Math.max(0, lagMs), { 'landflow.workflow.id': workflowId });
}

export function recordWebhookRequest(status: number, workflowId?: string) {
  hostMetrics().webhookRequests.add(1, { ...(workflowId && { 'landflow.workflow.id': workflowId }), 'http.response.status_code': status });
}

/** One announce or heartbeat from a plugin (HTTP route or gRPC RegistryService). */
export function recordHeartbeat(pluginId: string) {
  hostMetrics().heartbeats.add(1, { 'landflow.plugin.id': pluginId });
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
