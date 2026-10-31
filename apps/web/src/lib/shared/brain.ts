/**
 * The second brain (docs/second-brain.md): the usage ledger, the facts it learns, and the suggestions it makes. Shared by
 * the server (lib/server/usage, lib/server/brain), the routes and the UI (Home's Suggestions, the canvas card, Insights).
 */
import type { AssistantOp } from './assistant-ops';
import type { Workflow } from './types';

// ---------------------------------------------------------------------------
// The usage ledger
// ---------------------------------------------------------------------------

export const USAGE_KINDS = [
  'run.finished',
  'node.failed',
  'node.slow',
  'ai.call',
  'workflow.saved',
  'workflow.published',
  'credential.used',
  'assistant.applied',
  'assistant.dismissed',
  'spotlight.asked',
  'search.empty',
  'agent.session',
  'feedback',
  'template.used',
  'plugin.installed',
  'proposal.applied',
  'proposal.dismissed',
  'tool.missing',
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

/** Kinds the editor reports itself (POST /api/usage/signal); the rest the server records where the data passes. */
export const CLIENT_SIGNALS = ['search.empty'] as const satisfies readonly UsageKind[];

export type UsageAttr = string | number | boolean;

/** One thing that happened. Metadata only: no item contents (docs/second-brain.md#principles). */
export interface UsageEvent {
  id: string;
  at: string;
  /** YYYY-MM-DD in the instance time zone, as Insights counts days. */
  day: string;
  kind: UsageKind;
  projectId?: string;
  workflowId?: string;
  nodeId?: string;
  nodeType?: string;
  agentId?: string;
  /** The user (or API key) behind it, when there was one. */
  actorId?: string;
  executionId?: string;
  /** A redacted, normalized error message's hash: the same failure has the same signature. */
  signature?: string;
  /** The redacted message (errors) or text (Spotlight asks, empty searches), clipped. */
  message?: string;
  durationMs?: number;
  items?: number;
  tokens?: number;
  cost?: number;
  attrs?: Record<string, UsageAttr>;
}

export type UsageGroup = 'day' | 'kind' | 'workflow' | 'nodeType' | 'signature' | 'agent' | 'model';

export interface UsageFilter {
  kinds?: UsageKind[];
  /** ISO time or YYYY-MM-DD; default 7 days ago. */
  from?: string;
  to?: string;
  workflowId?: string;
  agentId?: string;
  nodeType?: string;
  signature?: string;
}

/** One group of a usage report (GET /api/usage?groupBy=…). */
export interface UsageGroupRow {
  key: string;
  /** A readable name for the key (the workflow's or agent's name), when there is one. */
  label?: string;
  count: number;
  failures: number;
  durationAvgMs: number;
  durationMaxMs: number;
  items: number;
  tokens: number;
  cost: number;
}

export interface UsageReport {
  from: string;
  to: string;
  groupBy: UsageGroup;
  rows: UsageGroupRow[];
  totals: Omit<UsageGroupRow, 'key' | 'label'>;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export const DETECTORS = [
  'failure-hot-spot',
  'flaky-call',
  'slow-step',
  'ai-cost',
  'hand-run-rhythm',
  'copy-paste',
  'dead-weight',
  'agent-quality',
  'unmet-demand',
  'no-safety-net',
  'repeated-sequence',
  'missing-tool',
] as const;

export type DetectorId = (typeof DETECTORS)[number];

export const DETECTOR_LABELS: Record<DetectorId, string> = {
  'failure-hot-spot': 'Failure hot spot',
  'flaky-call': 'Flaky call',
  'slow-step': 'Slow step',
  'ai-cost': 'AI cost',
  'hand-run-rhythm': 'Hand-run rhythm',
  'copy-paste': 'Copy and paste',
  'dead-weight': 'Dead weight',
  'agent-quality': 'Agent quality',
  'unmet-demand': 'Unmet demand',
  'no-safety-net': 'No safety net',
  'repeated-sequence': 'Repeated by hand',
  'missing-tool': 'Missing tool',
};

/** Who wrote a suggestion: a built-in detector, a workflow's Suggest Improvement node, or the Platform analyst agent. */
export type ProposalSource = 'detector' | 'workflow' | 'analyst';
export type ProposalStatus = 'open' | 'applied' | 'dismissed' | 'snoozed' | 'expired';
export type ProposalRisk = 'low' | 'medium' | 'high';
/** Why it was dismissed: `intended` becomes a fact so it isn't suggested again; `wrong` and `not-relevant` quiet the detector. */
export const DISMISS_REASONS = ['intended', 'not-relevant', 'wrong', 'done'] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
export type ProposalOutcome = 'pending' | 'worked' | 'no-effect' | 'worse';

export type ProposalTargetType = 'workflow' | 'agent' | 'credential' | 'instance';

export interface AgentChange {
  always?: string[];
  never?: string[];
}

export interface ProposalEvidence {
  label: string;
  value?: string | number;
  /** A page in Landflow (an execution, a workflow, the audit log). */
  href?: string;
}

/** What a suggestion is measured by after it is applied (docs/second-brain.md#7-measuring-the-effect). */
export type ProposalMetricName = 'failureRate' | 'p95Ms' | 'costPerRun' | 'manualRuns' | 'thumbsDownRate' | 'runs';

export interface ProposalMetric {
  metric: ProposalMetricName;
  value: number;
  /** Over how many days before `at`. */
  days: number;
  at: string;
  /** Lower is better for every metric but `runs`. */
  better?: 'lower' | 'higher';
}

export interface Proposal {
  id: string;
  source: ProposalSource;
  /** Detector suggestions; workflow and analyst ones say what they are in `label`. */
  detector?: DetectorId;
  /** A short tag for workflow and analyst suggestions ("Weekly AI cost review"). */
  label?: string;
  /** The same finding again updates the open suggestion instead of adding one. */
  fingerprint: string;
  projectId?: string;
  target: { type: ProposalTargetType; id?: string; name?: string; nodeId?: string; nodeName?: string };
  title: string;
  why: string;
  evidence: ProposalEvidence[];
  /** The expected effect, in words ("about 40 fewer failed runs a week"). */
  effect?: string;
  /** Changes to the target workflow, validated against the registry; empty = advice only. */
  ops: AssistantOp[];
  /** A new workflow to create instead (unmet demand, repeated sequences). */
  draft?: Workflow;
  /** Rules to add to the target agent's persona (agent quality); applied to its draft. */
  agentChange?: AgentChange;
  warnings?: string[];
  risk: ProposalRisk;
  /** 0..1. */
  confidence: number;
  /** Ranks the inbox: higher first. */
  score: number;
  status: ProposalStatus;
  reason?: DismissReason;
  note?: string;
  snoozedUntil?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  appliedBy?: string;
  /** The workflow created from `draft`, once applied. */
  createdWorkflowId?: string;
  baseline?: ProposalMetric;
  outcome?: ProposalOutcome;
  /** The checks after 7 and 14 days. */
  checks?: ProposalMetric[];
  /** The model that wrote it, when one did. */
  model?: string;
}

/** POST /api/proposals and the Suggest Improvement node. */
export interface ProposalInput {
  title: string;
  why: string;
  label?: string;
  workflowId?: string;
  agentId?: string;
  nodeName?: string;
  evidence?: ProposalEvidence[];
  effect?: string;
  ops?: unknown;
  draft?: Workflow;
  agentChange?: AgentChange;
  risk?: ProposalRisk;
  confidence?: number;
  /** Defaults to a hash of the label, target and title. */
  fingerprint?: string;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const FACT_SUBJECTS = ['workflow', 'agent', 'nodeType', 'credential', 'instance'] as const;
export type FactSubject = (typeof FACT_SUBJECTS)[number];
export const FACT_KINDS = ['purpose', 'health', 'cost', 'failure', 'slow', 'change', 'dependency', 'usage', 'quality', 'intended'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface BrainFact {
  id: string;
  subjectType: FactSubject;
  subjectId: string;
  subjectName?: string;
  kind: FactKind;
  statement: string;
  evidence: ProposalEvidence[];
  confidence: number;
  projectId?: string;
  firstSeen: string;
  lastSeen: string;
  status: 'active' | 'stale';
}

export interface ProfileStats {
  runs: number;
  failures: number;
  failureRate: number;
  manualRuns: number;
  p95Ms: number;
  tokens: number;
  cost: number;
  /** The previous window's, for trends. */
  previous?: { runs: number; failureRate: number; p95Ms: number; cost: number };
  lastRunAt?: string;
}

export interface BrainProfile {
  subjectType: FactSubject;
  subjectId: string;
  name: string;
  projectId?: string;
  /** The workflow version (or agent version) the purpose was written for. */
  version?: string;
  purpose?: string;
  stats: ProfileStats;
  /** Node types, credentials, sub-workflows and agents it uses (from the definition). */
  uses: Array<{ type: FactSubject; id: string; name?: string }>;
  updatedAt: string;
}

/** GET /api/brain/workflows/:id: what Landflow knows about one workflow (Insights, the canvas card). */
export interface WorkflowKnowledge {
  profile?: BrainProfile;
  facts: BrainFact[];
  proposals: Proposal[];
}

/** GET /api/brain/status. */
export interface BrainStatus {
  enabled: boolean;
  model: string;
  events: number;
  oldestEvent?: string;
  facts: number;
  profiles: number;
  open: number;
  lastDetect?: string;
  lastStudy?: string;
  lastEffects?: string;
  /** Per detector: suggestions made, applied and dismissed, and how much it is quieted. */
  detectors: Array<{ id: DetectorId; made: number; applied: number; dismissed: number; quiet: number }>;
}
