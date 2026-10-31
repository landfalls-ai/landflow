/**
 * Host telemetry (docs/observability.md). Spans and metrics are no-ops until
 * startTelemetry() has run (instrumentation.ts) and when OTEL_SDK_DISABLED=true.
 */
export { telemetryConfig, traceUrl } from './config';
export { logger, type Logger, type LogAttributes } from './logger';
export { startTelemetry, prometheusText } from './sdk';
export { activeTraceIds, failSpan, SpanKind, SpanStatusCode, startSpan, traceHeaders, traceparentHeader, withSpan, type Span, type SpanOptions } from './spans';
export { fireTrigger, startTrigger, tracePoll, type PollInfo, type TriggerFire, type TriggerInfo, type TriggerSource } from './triggers';
export { tracePluginRpc, withTransportChoice, type RpcMethod, type RpcTarget, type TransportChoiceAttributes } from './rpc';
export { traceChat, traceEmbeddings, type ChatRequest, type ChatResponse, type EmbeddingsResponse } from './ai';
export { traceGuardrails, traceRerank, traceVectorStore, type VectorStoreCall, type VectorStoreOperation } from './rag';
export { traceA2aCall, type A2aCallInfo, type A2aCallSummary } from './a2a';
export { recordAgentTokens, recordApproval, traceAgentRun, traceToolCall, type AgentRunInfo, type ToolCallInfo } from './agents';
export { observePluginsOnline, recordHeartbeat, recordRuntimeEvent, recordScheduleLag, recordWebhookRequest, type RuntimeEvent } from './metrics';
export { recordFlowMetric, type FlowMetricType } from './flow-metrics';
