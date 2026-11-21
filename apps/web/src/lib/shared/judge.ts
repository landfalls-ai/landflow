/**
 * The AI Judge's vocabulary (C13, docs/features/ai.md#ai-judge): why it could not decide, the limits it keeps, and the
 * evidence an undecided judge puts in the approval inbox. Browser-safe: the inbox UI and the server share it.
 */

export type JudgeDecision = 'approve' | 'deny';

/** Every way a judge ends without a decision it may act on. None of them ever outputs Approved. */
export type FallbackReason =
  | 'no decision'
  | 'invalid decision'
  | 'two decisions'
  | 'low confidence'
  | 'round limit'
  | 'tool call limit'
  | 'model error'
  | 'tool error'
  | 'usage cap'
  | 'cannot wait';

/** The plain words for each reason (Needs you, the mail, the Run Trace). Fixed text: safe for an alert, never model output. */
export const FALLBACK_WORDS: Record<FallbackReason, string> = {
  'no decision': 'it gave no decision',
  'invalid decision': 'its decision was not valid',
  'two decisions': 'it decided twice',
  'low confidence': 'it was not sure enough',
  'round limit': 'it ran out of rounds',
  'tool call limit': 'it ran out of tool calls',
  'model error': 'the model failed',
  'tool error': 'a tool failed',
  'usage cap': 'the AI usage cap was reached',
  'cannot wait': 'this run cannot wait for a person',
};

/** One tool call the judge made. */
export interface JudgeStep {
  tool: string;
  input: unknown;
  /** The tool's answer, cut short in the inbox's evidence. */
  output: string;
  isError?: boolean;
}

/** What an undecided judge shows the person who decides (stored on the inbox row, masked and capped). */
export interface JudgeEvidence {
  /** The judge's own reason, when it gave a valid decision that was not sure enough. */
  reason?: string;
  confidence?: number;
  decision?: JudgeDecision;
  fallbackReason: FallbackReason;
  rounds: number;
  toolCalls: number;
  steps: JudgeStep[];
}

/** The limits of the loop. Settable lower on the node, never higher. */
export const JUDGE_LIMITS = { rounds: 8, toolCalls: 12, resultChars: 8_000, policyChars: 8_000, tools: 10, reasonChars: 1_000 } as const;
export const DEFAULT_THRESHOLD = 0.7;
export const MIN_THRESHOLD = 0.5;
/** The most the evidence of one request holds, in bytes of its JSON. */
export const EVIDENCE_MAX_BYTES = 16_384;
/** One step's output in the evidence, in characters. */
export const EVIDENCE_OUTPUT_CHARS = 500;

/** The title of a request or a Needs you row: “Refund check” could not decide: it was not sure enough. */
export function judgeTitle(node: string, why: FallbackReason, confidence?: number): string {
  const sure = why === 'low confidence' && typeof confidence === 'number' ? ` (${confidence.toFixed(2)})` : '';
  return `“${node}” could not decide: ${FALLBACK_WORDS[why]}${sure}`;
}

/** The nudge's subject (mail, alert) for a judge request. */
export const judgeNudgeSubject = (node: string, workflowName: string): string => `Decision needed: “${node}” in “${workflowName}”`;

/** Whether `text` names one of the fallback reasons (a stored value is never trusted to be one). */
export const isFallbackReason = (text: unknown): text is FallbackReason => typeof text === 'string' && text in FALLBACK_WORDS;
