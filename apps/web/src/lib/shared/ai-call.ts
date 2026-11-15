/**
 * What one model call was for, and where it came from (wave 11, SP01). Shared by the server (ai-usage, telemetry,
 * the ledger event) and the screens that show a call (wave 12). Plain types and constants only: no imports, no zod.
 *
 * Contract file: owned by SP01, copied byte for byte by SP02 and SP03 (backbone/contracts/s11/README.md).
 */

/**
 * Why a call was made. A call with no purpose set is an `answer` call when it is a chat call made inside an agent
 * session or a workflow run, and `embed` when it is an embeddings call; anything else stays unset (null in the row).
 * There is no `router` purpose: the router makes no model call (docs/limitations.md), a call answered by the cheap
 * model is an `answer` call of that model.
 */
export const CALL_PURPOSES = ['answer', 'guardrail', 'judge', 'embed', 'cache-embed', 'rerank', 'summary', 'eval'] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

/** The words the screens use (docs/ui-review.md: sentence case, no jargon). */
export const CALL_PURPOSE_LABELS: Record<CallPurpose, string> = {
  answer: 'Answer',
  guardrail: 'Guardrail check',
  judge: 'Judge',
  embed: 'Embedding',
  'cache-embed': 'Cache lookup',
  rerank: 'Rerank',
  summary: 'Summary',
  eval: 'Evaluation',
};

export function isCallPurpose(value: unknown): value is CallPurpose {
  return typeof value === 'string' && (CALL_PURPOSES as readonly string[]).includes(value);
}

/**
 * The attribution columns migration 2900 adds to `ai_usage` (camelCase here, snake_case in the table). Every field is
 * optional: rows written before wave 11, rows imported from the gateway and calls outside a run have none of them.
 */
export interface AiCallAttribution {
  /** The workflow node the call ran under (the engine's active node), e.g. `n_ab12`. */
  nodeId?: string;
  /** The `gen_ai.*` span's id (16 hex), so a row opens its span in the Run Trace. */
  spanId?: string;
  purpose?: CallPurpose;
  /** The agent loop's step, from 1; absent outside an agent loop. */
  iteration?: number;
  /** The agent that asked another agent (a team member's call, an `agent` tool, an A2A call made by Landflow). */
  callerAgentId?: string;
  /** Wall time of the call, milliseconds. */
  durationMs?: number;
  /** The provider's stop reason, first finish reason (`end_turn`, `tool_use`, `max_tokens`, `stop`, `length`…). */
  stopReason?: string;
}

/**
 * The keys the `ai.call` ledger event gains in its `attrs` (lib/server/ai-usage/index.ts `recordUsage`). Only these
 * names, only when set; every key that exists today stays as it is (Landledger and Clickland read them).
 */
export interface AiCallEventAttribution {
  purpose?: CallPurpose;
  nodeId?: string;
  sessionId?: string;
  iteration?: number;
  /** The `ai_usage` row id, so a reader can ask `GET /api/ai-calls/:id` (wave 12) with its own access. */
  usageId?: string;
}
