/**
 * Run traces over OTLP (docs/run-trace.md, "Export over OTLP"): when `LANDFLOW_OTLP_TRACES_URL` is set (an OTLP/HTTP
 * endpoint such as `http://landflow-lgtm:4318/v1/traces`), the journal of an execution is sent there as one trace once the
 * run ends. Spans keep their parent links, start and end times and status, and carry OpenInference attributes
 * (`openinference.span.kind` AGENT, LLM, TOOL, CHAIN or EVALUATOR, `llm.model_name`, `llm.token_count.*`, `input.value`,
 * `output.value`) beside `landflow.actor` and `landflow.execution_id`. It reads the stored journal, so what it sends is
 * already redacted and cut to the run's content mode (`traceContent`); input and output values are cut again to
 * 4,000 characters. The same JSON transport the host's log export uses (telemetry/logs.ts). Spans go out in batches of 200,
 * a failed request is tried once more, and nothing here blocks or fails the run.
 */
import { createHash } from 'node:crypto';
import type { JournalEvent, RunActor, SpanKind, SpanStatus } from '../../shared/run-trace';
import { logger } from '../telemetry';
import { otlpAttributes, parseOtlpHeaders } from '../telemetry/logs';
import { store } from '../store';
import { readAll } from './store';

const BATCH = 200;
const VALUE_CHARS = 4_000;
const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_000;

/** OpenInference's span kinds, from the journal's. */
export type OpenInferenceKind = 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN' | 'EVALUATOR';

export function openInferenceKind(kind: SpanKind, attrs?: Record<string, unknown>): OpenInferenceKind {
  switch (kind) {
    case 'agent':
    case 'delegate':
    case 'handoff':
      return 'AGENT';
    case 'model':
      return 'LLM';
    case 'tool':
      return 'TOOL';
    default:
      // A Run report (or any evaluation node) judges the work.
      return /runReport|evaluat/i.test(String(attrs?.nodeType ?? '')) ? 'EVALUATOR' : 'CHAIN';
  }
}

/** Where run traces go (`LANDFLOW_OTLP_TRACES_URL`), when exporting is on. */
export function tracesUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LANDFLOW_OTLP_TRACES_URL?.trim() || undefined;
}

const hex = (text: string, length: number) => createHash('sha256').update(text).digest('hex').slice(0, length);
const validTraceId = (id: string | undefined) => (id && /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : undefined);
const nanos = (iso: string) => `${BigInt(Date.parse(iso) || Date.now()) * 1_000_000n}`;
const cut = (text: string) => (text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…[cut]` : text);

/** A value as OpenInference's `input.value`: text as is, anything else as JSON; the mime type says which. */
function valueOf(value: unknown): { text: string; mime: 'text/plain' | 'application/json' } | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return { text: cut(value), mime: 'text/plain' };
  try {
    return { text: cut(JSON.stringify(value)), mime: 'application/json' };
  } catch {
    return undefined;
  }
}

interface SpanDraft {
  id: string;
  parent?: string;
  kind: SpanKind;
  name: string;
  actor: RunActor;
  startedAt: string;
  endedAt?: string;
  status: SpanStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number; model?: string };
  attrs: Record<string, unknown>;
  events: Array<{ at: string; name: string; attributes: Record<string, unknown> }>;
}

/** The journal's events as OTLP resourceSpans (one trace), or undefined when it holds no span. */
export function journalToOtlp(executionId: string, events: JournalEvent[], info: { workflowId?: string; workflowName?: string } = {}): { spans: number; body: unknown } | undefined {
  const spans = new Map<string, SpanDraft>();
  let traceId: string | undefined;
  let lastAt = '';
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    traceId ??= validTraceId(event.traceId);
    lastAt = event.at > lastAt ? event.at : lastAt;
    if (event.type === 'span.started') {
      spans.set(event.spanId, { id: event.spanId, parent: event.parentSpanId, kind: event.kind, name: event.name, actor: event.actor, startedAt: event.at, status: 'running', input: event.input, attrs: { ...event.attrs }, events: [] });
      continue;
    }
    const span = spans.get(event.spanId);
    if (!span) continue;
    if (event.type === 'span.updated') {
      if (event.status) span.status = event.status;
      Object.assign(span.attrs, event.attrs);
    } else if (event.type === 'span.ended') {
      span.status = event.status;
      span.endedAt = event.at;
      if (event.output !== undefined) span.output = event.output;
      if (event.error) span.error = event.error;
      if (event.usage) span.usage = event.usage;
      Object.assign(span.attrs, event.attrs);
    } else if (event.type === 'check') {
      span.events.push({ at: event.at, name: 'check', attributes: { 'landflow.check.name': event.check.name, 'landflow.check.status': event.check.status, ...(event.check.message && { 'landflow.check.message': cut(event.check.message) }) } });
    } else if (event.type === 'artifact') {
      span.events.push({ at: event.at, name: 'artifact', attributes: { 'landflow.artifact.name': event.artifact.name, ...(event.artifact.kind && { 'landflow.artifact.kind': event.artifact.kind }), ...(event.artifact.url && { 'landflow.artifact.url': event.artifact.url }) } });
    } else if (event.type === 'message') {
      span.events.push({ at: event.at, name: 'message', attributes: { 'landflow.message.from': event.from.name, 'landflow.message.text': cut(event.text) } });
    }
  }
  if (!spans.size) return undefined;

  const trace = traceId ?? hex(`trace:${executionId}`, 32);
  const spanId = (id: string) => hex(`${executionId}:${id}`, 16);
  const out = [...spans.values()].map((span) => {
    const input = valueOf(span.input);
    const output = valueOf(span.error && span.output === undefined ? span.error : span.output);
    const model = span.usage?.model ?? (span.kind === 'model' ? span.name : undefined);
    const attributes: Record<string, unknown> = {
      'openinference.span.kind': openInferenceKind(span.kind, span.attrs),
      'landflow.execution_id': executionId,
      'landflow.actor': span.actor.name,
      'landflow.actor_id': span.actor.id,
      'landflow.span_id': span.id,
      'landflow.span_kind': span.kind,
      'landflow.status': span.status,
      ...(info.workflowId && { 'landflow.workflow_id': info.workflowId }),
      ...(model && { 'llm.model_name': model }),
      ...(span.usage && {
        'llm.token_count.prompt': span.usage.inputTokens,
        'llm.token_count.completion': span.usage.outputTokens,
        'llm.token_count.total': span.usage.inputTokens + span.usage.outputTokens,
        ...(span.usage.cacheReadTokens !== undefined && { 'llm.token_count.prompt_details.cache_read': span.usage.cacheReadTokens }),
        ...(span.usage.cacheWriteTokens !== undefined && { 'llm.token_count.prompt_details.cache_write': span.usage.cacheWriteTokens }),
        ...(span.usage.costUsd !== undefined && { 'llm.cost.total': span.usage.costUsd }),
      }),
      ...(input && { 'input.value': input.text, 'input.mime_type': input.mime }),
      ...(output && { 'output.value': output.text, 'output.mime_type': output.mime }),
    };
    const ended = span.endedAt ?? (span.status === 'running' || span.status === 'waiting' ? lastAt : span.startedAt);
    return {
      traceId: trace,
      spanId: spanId(span.id),
      ...(span.parent && spans.has(span.parent) && { parentSpanId: spanId(span.parent) }),
      name: span.name || span.kind,
      kind: 1,
      startTimeUnixNano: nanos(span.startedAt),
      endTimeUnixNano: nanos(ended < span.startedAt ? span.startedAt : ended),
      attributes: otlpAttributes(attributes),
      ...(span.events.length && { events: span.events.map((e) => ({ timeUnixNano: nanos(e.at), name: e.name, attributes: otlpAttributes(e.attributes) })) }),
      // 1 OK, 2 ERROR; a canceled or unfinished span has no verdict.
      status: span.status === 'error' ? { code: 2, ...(span.error && { message: cut(span.error) }) } : span.status === 'success' ? { code: 1 } : { code: 0 },
    };
  });
  const resource = otlpAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'landflow-host',
    'openinference.project.name': info.workflowName || 'landflow',
    'landflow.execution_id': executionId,
  });
  return { spans: out.length, body: { resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ scope: { name: 'landflow.run-trace' }, spans: out }] }] } };
}

export interface ExportOptions {
  url?: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

async function post(url: string, headers: Record<string, string>, body: unknown, options: ExportOptions): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await (options.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    } catch (error) {
      if (attempt >= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? RETRY_DELAY_MS));
    }
  }
}

/**
 * Send an execution's journal as one trace, in batches, each tried twice. Resolves with how many spans and requests went
 * out (undefined: exporting is off or there is nothing to send) and rejects when a request failed twice.
 */
export async function exportRunTraces(executionId: string, options: ExportOptions = {}): Promise<{ spans: number; requests: number } | undefined> {
  const url = options.url ?? tracesUrl();
  if (!url) return undefined;
  const record = store.getExecution(executionId);
  const converted = journalToOtlp(executionId, readAll(executionId), { workflowId: record?.workflowId, workflowName: record?.workflowName });
  if (!converted) return undefined;
  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const body = converted.body as { resourceSpans: Array<{ resource: unknown; scopeSpans: Array<{ scope: unknown; spans: unknown[] }> }> };
  const [resourceSpans] = body.resourceSpans;
  const [scopeSpans] = resourceSpans.scopeSpans;
  let requests = 0;
  for (let at = 0; at < scopeSpans.spans.length; at += BATCH) {
    await post(url, headers, { resourceSpans: [{ resource: resourceSpans.resource, scopeSpans: [{ scope: scopeSpans.scope, spans: scopeSpans.spans.slice(at, at + BATCH) }] }] }, options);
    requests++;
  }
  return { spans: converted.spans, requests };
}

/** Export a finished run in the background: never throws, never waits. */
export function exportRunInBackground(executionId: string) {
  if (!tracesUrl()) return;
  const timer = setTimeout(() => {
    exportRunTraces(executionId).catch((error: Error) => logger.warn('could not export the run trace over OTLP', { error: error.message, 'landflow.execution.id': executionId }));
  }, 0);
  timer.unref?.();
}
