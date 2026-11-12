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

/** A kind Landflow records itself. */
export type BuiltinUsageKind = (typeof USAGE_KINDS)[number];
/** A kind a flow records through Record Event: `<namespace>.<name>`, such as `work.ticket_moved` (see isCustomKind). */
export type CustomUsageKind = `${string}.${string}`;
export type UsageKind = BuiltinUsageKind | CustomUsageKind;

/** The first segment of every built-in kind (run, node, ai, … feedback): a custom kind can't start with one. */
export const BUILTIN_NAMESPACES: readonly string[] = [...new Set(USAGE_KINDS.map((k) => k.split('.')[0]))];

const CUSTOM_KIND = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** Why `kind` can't be a custom kind, or undefined when it can: lowercase `<namespace>.<name>`, 3 to 64 characters, a namespace no built-in kind uses. */
export function customKindProblem(kind: string): string | undefined {
  if (kind.length < 3 || kind.length > 64 || !CUSTOM_KIND.test(kind)) {
    return 'A kind is <namespace>.<name> in lowercase letters, digits and underscores, such as work.ticket_moved (3 to 64 characters)';
  }
  const namespace = kind.split('.')[0];
  if (BUILTIN_NAMESPACES.includes(namespace)) return `The namespace “${namespace}” belongs to Landflow’s own events; pick another, such as work or ops`;
  return undefined;
}

export const isCustomKind = (kind: unknown): kind is CustomUsageKind => typeof kind === 'string' && customKindProblem(kind) === undefined;
export const isBuiltinKind = (kind: unknown): kind is BuiltinUsageKind => (USAGE_KINDS as readonly unknown[]).includes(kind);
/** A kind the ledger knows how to hold: one of ours, or a well-formed custom one. */
export const isUsageKind = (kind: unknown): kind is UsageKind => isBuiltinKind(kind) || isCustomKind(kind);

export type UsageFieldType = 'string' | 'number' | 'boolean';

/** One attribute a custom kind declares. */
export interface UsageKindField {
  name: string;
  type: UsageFieldType;
  required?: boolean;
  description?: string;
}

/** A custom kind's declared shape (the `usage_kinds` table, GET /api/usage/kinds). */
export interface UsageKindDef {
  kind: CustomUsageKind;
  description: string;
  fields: UsageKindField[];
  projectId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

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

export type UsageGroup = 'day' | 'kind' | 'workflow' | 'nodeType' | 'signature' | 'agent' | 'model' | 'attr';

/** An attribute name as it can be grouped or filtered by. */
export const ATTR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export interface UsageFilter {
  kinds?: UsageKind[];
  /** ISO time or YYYY-MM-DD; default 7 days ago. */
  from?: string;
  to?: string;
  workflowId?: string;
  agentId?: string;
  nodeType?: string;
  signature?: string;
  /** Only events whose attribute equals the value (any kind): `{ team: 'billing' }`. Compared as text. */
  attrEquals?: Record<string, string>;
  /** For groupBy `attr`: the attribute to group by. */
  attr?: string;
}

/**
 * Key/value pairs from a parameter: an object, a JSON object as text, or `team=billing, priority=high` lines. Names that
 * aren't attribute names are left out. Values are compared as text.
 */
export function parseAttrEquals(value: unknown): Record<string, string> {
  let source: unknown = value;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text) return {};
    try {
      source = JSON.parse(text);
    } catch {
      source = Object.fromEntries(
        text
          .split(/[,\n]/)
          .map((part) => part.split(/=(.*)/s))
          .filter((pair) => pair.length >= 2 && pair[0].trim())
          .map((pair) => [pair[0].trim(), pair[1].trim()]),
      );
    }
  }
  const out: Record<string, string> = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, raw] of Object.entries(source)) if (ATTR_NAME.test(key) && ['string', 'number', 'boolean'].includes(typeof raw)) out[key] = String(raw);
  }
  return out;
}

/** Whether an event's attributes hold every pair (compared as text, so 3 equals "3" and true equals "true"). */
export const attrsMatch = (attrs: Record<string, UsageAttr> | undefined, equals: Record<string, string> | undefined): boolean =>
  !equals || Object.entries(equals).every(([key, want]) => attrs?.[key] !== undefined && String(attrs[key]) === want);

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

/** A detector built into Landflow (lib/server/brain/detectors.ts). */
export type BuiltinDetectorId = (typeof DETECTORS)[number];
/** A workflow that starts from a Detector Trigger is a detector too, `flow:<workflowId>` (docs/second-brain.md#flow-detectors). */
export type FlowDetectorId = `flow:${string}`;
export type DetectorId = BuiltinDetectorId | FlowDetectorId;

export const isBuiltinDetector = (id: unknown): id is BuiltinDetectorId => (DETECTORS as readonly unknown[]).includes(id);
export const isFlowDetector = (id: unknown): id is FlowDetectorId => typeof id === 'string' && id.startsWith('flow:') && id.length > 'flow:'.length;
export const isDetectorId = (id: unknown): id is DetectorId => isBuiltinDetector(id) || isFlowDetector(id);
export const flowDetectorId = (workflowId: string): FlowDetectorId => `flow:${workflowId}`;
export const flowDetectorWorkflow = (id: FlowDetectorId) => id.slice('flow:'.length);

/**
 * The lowest confidence a quieted flow detector's finding needs to reach the inbox: none at 1 (normal), 0.5 at 1.5, 0.65 at
 * 2 and 0.8 at 3. Built-in detectors multiply their thresholds instead; a flow gets the multiplier too (Detector Trigger's
 * `quiet`) and can do both.
 */
export const quietBar = (quiet: number) => (quiet >= 3 ? 0.8 : quiet >= 2 ? 0.65 : quiet >= 1.5 ? 0.5 : 0);

export const DETECTOR_LABELS: Record<BuiltinDetectorId, string> = {
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

/** A detector's name: a built-in one's label, or a flow detector's workflow name (`name`, or the suggestion's label). */
export const detectorLabel = (id: DetectorId, name?: string) => (isBuiltinDetector(id) ? DETECTOR_LABELS[id] : name || 'Flow detector');

/** Who wrote a suggestion: a built-in detector, a workflow's Suggest Improvement node, or the Platform analyst agent. */
/** `notebook`: a team's notebook proposes keeping a note for the project (docs/team-notebook.md). */
export type ProposalSource = 'detector' | 'workflow' | 'analyst' | 'notebook';
export type ProposalStatus = 'open' | 'applied' | 'dismissed' | 'snoozed' | 'expired';
export type ProposalRisk = 'low' | 'medium' | 'high';
/** Why it was dismissed: `intended` becomes a fact so it isn't suggested again; `wrong` and `not-relevant` quiet the detector. */
export const DISMISS_REASONS = ['intended', 'not-relevant', 'wrong', 'done'] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
export type ProposalOutcome = 'pending' | 'worked' | 'no-effect' | 'worse';

export type ProposalTargetType = 'workflow' | 'agent' | 'credential' | 'instance' | 'team';

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
export type ProposalMetricName = 'failureRate' | 'p95Ms' | 'costPerRun' | 'manualRuns' | 'thumbsDownRate' | 'runs' | 'custom';

export interface ProposalMetric {
  metric: ProposalMetricName;
  value: number;
  /** Over how many days before `at`. */
  days: number;
  at: string;
  /** Lower is better for every metric but `runs` and a declared one that says otherwise. */
  better?: 'lower' | 'higher';
  /** A declared metric's name ("Initiatives merged or reused"). */
  label?: string;
  /** A baseline that is still being measured (a sub-workflow runs right after Apply): `value` is not real yet. */
  pending?: boolean;
  /** The sub-workflow failed or returned no number, so there is no value (never a made-up 0); it is tried again on the brain's next look. */
  failed?: boolean;
}

/** What a declared metric can sum or average besides an event attribute. */
export const METRIC_FIELDS = ['cost', 'tokens', 'durationMs', 'items'] as const;

/**
 * A metric a detector flow declares for its suggestions (docs/second-brain.md#7-measuring-the-effect): a query over the
 * usage ledger, or a sub-workflow that returns the number. It is set on the Detector Trigger, and a Suggest Improvement
 * node may override it. The suggestion keeps it as `metricSpec`.
 */
export interface MetricSpec {
  source: 'usage' | 'workflow';
  /** "Initiatives merged or reused". */
  label: string;
  better: 'higher' | 'lower';
  usage?: {
    kinds: UsageKind[];
    attrEquals?: Record<string, string>;
    aggregate: 'count' | 'sum' | 'avg';
    /** For sum and avg: an event attribute, or one of METRIC_FIELDS. */
    field?: string;
    /** `target`: events about the suggestion's workflow or agent. `instance`: everything the flow's creator can see. */
    about: 'target' | 'instance';
  };
  workflow?: {
    workflowId: string;
    /** The field of the first output item that holds the number. */
    field: string;
    timeoutSeconds?: number;
  };
}

/**
 * The metric a node's parameters declare, or undefined for none (`default`, empty), or a `problem` to tell the person.
 * `read` returns a parameter by name: metricSource, metricLabel, metricBetter, metricKinds, metricAttrEquals,
 * metricAggregate, metricField, metricAbout, metricWorkflowId, metricOutputField, metricTimeout.
 */
export function metricSpecFrom(read: (name: string) => unknown): { spec?: MetricSpec; problem?: string } {
  const source = String(read('metricSource') ?? '');
  if (source !== 'usage' && source !== 'workflow') return {};
  const text = (name: string) => String(read(name) ?? '').trim();
  const label = text('metricLabel').slice(0, 80);
  if (!label) return { problem: 'Name the metric (Metric Name), so people know what is measured' };
  const better = text('metricBetter') === 'lower' ? 'lower' : 'higher';
  if (source === 'workflow') {
    const workflowId = text('metricWorkflowId');
    const field = text('metricOutputField');
    if (!workflowId) return { problem: 'Choose the metric’s sub-workflow' };
    if (!field) return { problem: 'Name the field of the sub-workflow’s first output item that holds the number' };
    const timeout = Number(read('metricTimeout'));
    return { spec: { source, label, better, workflow: { workflowId, field, ...(Number.isFinite(timeout) && timeout > 0 && { timeoutSeconds: Math.min(600, Math.floor(timeout)) }) } } };
  }
  const rawKinds = read('metricKinds');
  const kinds = (Array.isArray(rawKinds) ? rawKinds.map(String) : String(rawKinds ?? '').split(',')).map((k) => k.trim()).filter(Boolean);
  if (!kinds.length) return { problem: 'Choose at least one event kind to count' };
  const unknown = kinds.find((k) => !isUsageKind(k));
  if (unknown) return { problem: `“${unknown}” is not an event kind` };
  const aggregate = ['sum', 'avg'].includes(text('metricAggregate')) ? (text('metricAggregate') as 'sum' | 'avg') : 'count';
  const field = text('metricField');
  if (aggregate !== 'count' && !(METRIC_FIELDS as readonly string[]).includes(field) && !ATTR_NAME.test(field)) {
    return { problem: `Name what to ${aggregate}: an attribute, or one of ${METRIC_FIELDS.join(', ')}` };
  }
  const attrEquals = parseAttrEquals(read('metricAttrEquals'));
  return {
    spec: {
      source,
      label,
      better,
      usage: { kinds: kinds as UsageKind[], ...(Object.keys(attrEquals).length && { attrEquals }), aggregate, ...(aggregate !== 'count' && { field }), about: text('metricAbout') === 'instance' ? 'instance' : 'target' },
    },
  };
}

/** A button a flow put on a suggestion ("Intro us"): taking it records the decision and starts the flows listening. */
export interface ProposalAction {
  /** Slug-like, up to 32 characters: what On Suggestion Decided filters on. */
  id: string;
  label: string;
  style?: 'primary' | 'default';
  /** Ask first, with this text. */
  confirm?: string;
}

export const MAX_PROPOSAL_ACTIONS = 4;
export const RESERVED_ACTION_IDS = ['applied', 'dismissed', 'snoozed', 'action'];

/** Someone a suggestion is addressed to (docs/second-brain.md#suggestions-with-an-audience). Emails are resolved to Landflow users where they exist. */
export interface AudienceMember {
  userId?: string;
  email?: string;
  slackUserId?: string;
  name?: string;
}

export const MAX_AUDIENCE = 10;

/** Where a suggestion was mirrored to Slack: the credential that posted and each direct message (channel + ts) so a decision can update them. */
export interface ProposalSlackMirror {
  credential: { id: string; name: string };
  messages: Array<{ slackUserId: string; channel: string; ts: string }>;
}

/** What was decided: `action` is applied, dismissed or snoozed, or the id of a flow-defined action. */
export interface ProposalDecision {
  action: string;
  label: string;
  by?: string;
  at: string;
  note?: string;
  /** For a dismissal. */
  reason?: DismissReason;
}

export interface Proposal {
  id: string;
  source: ProposalSource;
  /** Detector suggestions; workflow and analyst ones say what they are in `label`, and so do flow detectors (the workflow's name). */
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
  /** Keep a team's note for the project: applying it moves the note to project scope (notebook/approve.ts). */
  notebook?: { teamId: string; noteId: string };
  warnings?: string[];
  risk: ProposalRisk;
  /** 0..1. */
  confidence: number;
  /** Ranks the inbox: higher first. */
  score: number;
  status: ProposalStatus;
  /** Buttons a flow added (Suggest Improvement's Actions), shown next to Apply. */
  actions?: ProposalAction[];
  /** Who it is addressed to: they see it in their inbox even when it is about something outside their projects. */
  audience?: AudienceMember[];
  /** The Slack direct messages that mirror it (set when the flow asked for a mirror). */
  slack?: ProposalSlackMirror;
  /** The latest decision made on it, for the flows that listen (On Suggestion Decided). */
  decision?: ProposalDecision;
  reason?: DismissReason;
  note?: string;
  snoozedUntil?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  appliedBy?: string;
  /** The workflow created from `draft`, once applied. */
  createdWorkflowId?: string;
  /** The metric the flow that made it declared; measured instead of the detector's own (./effect.ts). */
  metricSpec?: MetricSpec;
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
  /** Buttons for the card (at most 4); taking one starts the flows on On Suggestion Decided. */
  actions?: unknown;
  /** Named people it is addressed to (at most 10): a list of { userId?, email?, slackUserId?, name? }, or emails and Slack member ids in a string or list. */
  audience?: unknown;
  /** Mirror it to Slack as a direct message to each audience member with a Slack id (or an email Slack knows), through this credential. */
  slackCredential?: { id: string; name: string };
  /** Defaults to a hash of the label, target and title. */
  fingerprint?: string;
  /** Only flow detectors declare one (the Detector Trigger and Suggest Improvement nodes). */
  metricSpec?: MetricSpec;
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
export interface DetectorStat {
  id: DetectorId;
  /** The built-in label, or the flow detector's workflow name. */
  label: string;
  made: number;
  applied: number;
  dismissed: number;
  /** 1 = normal; higher means its thresholds are multiplied (it was mostly dismissed as wrong or not relevant). */
  quiet: number;
  /** A flow detector's workflow, and whether it is published (only published ones run). */
  workflowId?: string;
  active?: boolean;
}

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
  detectors: DetectorStat[];
}

/** The reserved name of the brain's vector collections: `landflow-brain` and `landflow-brain-<project>`. */
export const BRAIN_COLLECTION_PREFIX = 'landflow-brain';

/** Whether a vector collection name is one of the brain's. Workflows and agents can't read or write these (nodes/vector-stores.ts). */
export const isBrainCollection = (name: string): boolean => {
  const lower = name.trim().toLowerCase();
  return lower === BRAIN_COLLECTION_PREFIX || lower.startsWith(`${BRAIN_COLLECTION_PREFIX}-`);
};

export const SIMILAR_KINDS = ['workflow', 'agent', 'fact'] as const;
export type SimilarKind = (typeof SIMILAR_KINDS)[number];

/**
 * What Find Similar knows of a neighbour in a project the caller can't see (docs/second-brain.md#find-similar): these six
 * fields and nothing else: no id, no link, no fact statements, no evidence.
 */
export interface SimilarElsewhere {
  type: 'workflow' | 'agent';
  title: string;
  /** Who made it (a workflow's creator, an agent's project owner). */
  owner?: string;
  /** One line: its purpose or description. */
  goal?: string;
  /** The project it lives in. */
  project?: string;
  /** 0..1. */
  score: number;
}

/** A neighbour in a project the caller can open: the same six fields, plus what lets them open it. */
export interface SimilarOwn extends Omit<SimilarElsewhere, 'type'> {
  type: SimilarKind;
  yours: true;
  id: string;
  /** A fact: its kind and statement, and what it is about. */
  kind?: FactKind;
  statement?: string;
  subject?: { type: FactSubject; id: string };
  description?: string;
  active?: boolean;
}

export type SimilarMatch = SimilarOwn | SimilarElsewhere;
