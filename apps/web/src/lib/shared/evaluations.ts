/**
 * Evaluations: offline runs of a workflow over a Data Table (n8n's Evaluation Trigger and Evaluation
 * nodes), and online grading of agent conversations and AI Agent node runs by an LLM judge. Types
 * shared by the API routes and the React client. No runtime imports.
 */
import type { AgentModel } from './agents';

// ---------------------------------------------------------------------------
// Offline evaluations
// ---------------------------------------------------------------------------

/** What an evaluation execution is part of: kept on the execution record (and its summary). */
export interface EvaluationRef {
  runId: string;
  /** Position of the test case in the run (0-based). */
  caseIndex: number;
  /** The Data Table row the case came from. */
  rowId?: number;
}

export type EvaluationRunStatus = 'running' | 'success' | 'error' | 'canceled';
export type EvaluationCaseStatus = 'pending' | 'running' | 'success' | 'error' | 'canceled';

/** A metric over the run's cases: the mean of the cases that recorded it. */
export interface MetricSummary {
  average: number;
  count: number;
  min: number;
  max: number;
}

export interface EvaluationRunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  /** Run number per workflow: #1, #2… */
  number: number;
  status: EvaluationRunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** The workflow version the cases ran on. */
  versionId?: string;
  dataTableId: string;
  dataTableName: string;
  /** Cases in the run, and how many finished (either way) or failed. */
  total: number;
  completed: number;
  failed: number;
  /** Per metric name. */
  metrics: Record<string, MetricSummary>;
  error?: string;
}

export interface EvaluationCase {
  runId: string;
  index: number;
  rowId?: number;
  executionId?: string;
  status: EvaluationCaseStatus;
  /** The row's columns, without the expected-output column. */
  inputs: Record<string, unknown>;
  expected?: unknown;
  /** What "Set Outputs" recorded. */
  outputs: Record<string, unknown>;
  /** What "Set Metrics" recorded (the mean when a metric was recorded for several items). */
  metrics: Record<string, number>;
  /** LLM-judge reasoning per metric, when the judge gave one. */
  reasons?: Record<string, string>;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface EvaluationRunDetail extends EvaluationRunSummary {
  cases: EvaluationCase[];
}

/** GET /api/workflows/:id/evaluations */
export interface EvaluationsOverview {
  runs: EvaluationRunSummary[];
  /** The workflow's Evaluation Trigger, when it has one. */
  trigger?: { nodeId: string; nodeName: string; dataTableId?: string; dataTableName?: string; rows?: number; expectedColumn?: string; maxRows?: number };
  /** Whether an Evaluation node in "Set Metrics" mode is on the canvas (without one, runs only collect outputs). */
  hasMetrics: boolean;
}

export interface MetricDelta {
  name: string;
  a?: number;
  b?: number;
  /** b − a, when both have it. */
  delta?: number;
}

export interface CaseComparison {
  index: number;
  rowId?: number;
  inputs: Record<string, unknown>;
  expected?: unknown;
  a?: Pick<EvaluationCase, 'status' | 'metrics' | 'outputs' | 'executionId' | 'error'>;
  b?: Pick<EvaluationCase, 'status' | 'metrics' | 'outputs' | 'executionId' | 'error'>;
  /** Per metric, b − a. */
  deltas: Record<string, number>;
}

/** GET /api/workflows/:id/evaluations/compare?a=&b= */
export interface EvaluationComparison {
  a: EvaluationRunSummary;
  b: EvaluationRunSummary;
  metrics: MetricDelta[];
  cases: CaseComparison[];
  /** Cases whose metrics went up, down, or stayed the same (over the metrics both runs have). */
  improved: number;
  regressed: number;
  unchanged: number;
}

// ---------------------------------------------------------------------------
// Online evaluations
// ---------------------------------------------------------------------------

/**
 * Online grading of one agent (a standalone agent, or an AI Agent node of a workflow): a sample of its
 * finished conversations is graded by an LLM judge against a rubric, on a 1–5 scale.
 */
export interface OnlineEvalConfig {
  enabled: boolean;
  /** Percent of finished runs that are graded (0–100). */
  sampleRate: number;
  /** What a good answer looks like; the judge grades against it. */
  rubric: string;
  /** The judge model (the agent's own model when absent, for standalone agents). */
  model?: AgentModel;
  /** Scores at or below this are flagged (1–5). */
  lowScore: number;
}

export const DEFAULT_ONLINE_EVAL: OnlineEvalConfig = {
  enabled: false,
  sampleRate: 20,
  rubric: 'The reply answers the user’s request correctly and completely, uses the tools when they are needed, and does not make things up.',
  lowScore: 2,
};

/** `agent:<agentId>` or `node:<workflowId>:<nodeId>`. */
export type OnlineEvalTarget = string;

export interface OnlineEvalScore {
  id: string;
  target: OnlineEvalTarget;
  createdAt: string;
  /** 1–5. */
  score: number;
  flagged: boolean;
  reasoning: string;
  /** What the user asked and what the agent answered (shortened). */
  input: string;
  output: string;
  /** Tools the agent called in the graded run. */
  tools?: string[];
  /** `provider/model` of the judge. */
  judge: string;
  agentId?: string;
  sessionId?: string;
  workflowId?: string;
  nodeId?: string;
  executionId?: string;
}

export interface OnlineEvalTrendPoint {
  /** YYYY-MM-DD (UTC). */
  day: string;
  average: number;
  count: number;
  flagged: number;
}

export interface OnlineEvalReport {
  target: OnlineEvalTarget;
  config: OnlineEvalConfig;
  /** Newest first. */
  scores: OnlineEvalScore[];
  /** The last 30 days with scores, oldest first. */
  trend: OnlineEvalTrendPoint[];
  total: number;
  average?: number;
  flagged: number;
  /** Mean of the last 10 scores minus the mean of the 10 before them. */
  change?: number;
}

/** GET /api/workflows/:id/online-evaluations: the workflow's AI Agent nodes, each with its report. */
export interface WorkflowOnlineEvals {
  nodes: Array<{ nodeId: string; nodeName: string; report: OnlineEvalReport }>;
}
