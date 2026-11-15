/**
 * The LLM gateway (docs/llm-gateway.md): LiteLLM in front of every model call, Landflow's caps in charge and LiteLLM's
 * budgets as the backstop. Types and pure helpers shared by the server, the routes and the AI page. No runtime imports.
 *
 * Contract file of the LiteLLM wave (LL): every package of the wave adds it byte for byte, so the branches merge
 * cleanly. Change it only through the integrator.
 */

// ---------------------------------------------------------------------------
// Settings → AI → LLM gateway (settings key `llm_gateway`)
// ---------------------------------------------------------------------------

/** The `gateway` field of the Anthropic API and OpenAI API credentials: `litellm` marks a LiteLLM proxy behind its Base URL. */
export type GatewayKind = 'none' | 'litellm';

export interface LlmGatewaySettings {
  /**
   * The instance's gateway: a saved Anthropic API or OpenAI API credential whose Gateway is LiteLLM. Absent: the
   * LANDFLOW_LLM_GATEWAY_* variables, or no gateway.
   */
  credentialId?: string;
  /** The address kagent's agents and the Claude Code harness use (e.g. http://host.docker.internal:54100). Absent: kagent is not routed. */
  clusterUrl?: string;
  /** LiteLLM's admin UI, for the admins' link. Absent: `<base URL>/ui`. */
  uiUrl?: string;
  /** Send the Customer Portal headers (x-litellm-customer-org-alias, x-litellm-customer-member-id). Off: the portal is not in a release yet. */
  portalHeaders: boolean;
  /** Import the spend of keys that are not Landflow's own (kagent, Claude Code on kagent, other clients) into ai_usage. */
  ingest: boolean;
  /** Keep LiteLLM's teams, customers and key budgets in step with Landflow's projects, people and caps (the backstop). */
  sync: boolean;
  /** How far above a Landflow cap the backstop budget sits for people and projects, in percent (runtime keys get 0). */
  headroomPercent: number;
}

export const DEFAULT_LLM_GATEWAY_SETTINGS: LlmGatewaySettings = { portalHeaders: false, ingest: true, sync: false, headroomPercent: 10 };

/** GET /api/settings/llm-gateway (and the PUT's answer). */
export interface LlmGatewaySettingsView {
  settings: LlmGatewaySettings;
  /** What the environment sets (LANDFLOW_LLM_GATEWAY_*), without the keys themselves. */
  environment: { url?: string; clusterUrl?: string; uiUrl?: string; hasKey: boolean; hasAdminKey: boolean };
  /** Credentials that can be the instance's gateway: Anthropic API or OpenAI API credentials whose Gateway is LiteLLM. */
  candidates: Array<{ id: string; name: string; type: string; hasAdminKey: boolean }>;
}

// ---------------------------------------------------------------------------
// Names in LiteLLM: deterministic, so every package and every sync agree, and nothing personal (no names, no emails)
// ---------------------------------------------------------------------------

/** What ran a model call. */
export type AiRuntime = 'landflow' | 'kagent' | 'claude' | 'other';
/** The runtimes Landflow mints a virtual key for: kagent's own runtime and Claude Code on kagent. */
export type RuntimeKeyKind = 'kagent' | 'claude';
/** Where an ai_usage row came from: Landflow's own meter, or LiteLLM's spend log (imported). */
export type AiCallSource = 'landflow' | 'litellm';

const TEAM_PREFIX = 'landflow-project-';
const CUSTOMER_PREFIX = 'landflow-user-';

export const LITELLM_IDS = {
  /** A Landflow project's LiteLLM team (`team_id`). */
  team: (projectId: string) => `${TEAM_PREFIX}${projectId}`,
  /** A Landflow person's LiteLLM customer (end user): the `x-litellm-end-user-id` Landflow sends. */
  customer: (userId: string) => `${CUSTOMER_PREFIX}${userId}`,
  /** The alias of the virtual key Landflow mints for an agent on a runtime outside it. */
  runtimeKeyAlias: (runtime: RuntimeKeyKind, agentId: string) => `landflow-${runtime}-${agentId}`,
  /** The Customer Portal's organization alias for a project (only with `portalHeaders`). */
  portalOrg: (projectId: string) => `${TEAM_PREFIX}${projectId}`,
} as const;

/** Request tags (`x-litellm-tags`, comma-separated): LiteLLM's spend by tag, and tag budgets where the build has them. */
export const LITELLM_TAGS = {
  base: 'landflow',
  project: (id: string) => `landflow-project:${id}`,
  agent: (id: string) => `landflow-agent:${id}`,
  workflow: (id: string) => `landflow-workflow:${id}`,
  surface: (surface: string) => `landflow-surface:${surface}`,
  runtime: (runtime: AiRuntime) => `landflow-runtime:${runtime}`,
} as const;

/** The Landflow project a LiteLLM team id names, if it is one of ours. */
export function projectIdOfTeam(teamId: string | null | undefined): string | undefined {
  return teamId && teamId.startsWith(TEAM_PREFIX) && teamId.length > TEAM_PREFIX.length ? teamId.slice(TEAM_PREFIX.length) : undefined;
}

/** The Landflow user a LiteLLM customer (end user) id names, if it is one of ours. */
export function userIdOfCustomer(customerId: string | null | undefined): string | undefined {
  return customerId && customerId.startsWith(CUSTOMER_PREFIX) && customerId.length > CUSTOMER_PREFIX.length ? customerId.slice(CUSTOMER_PREFIX.length) : undefined;
}

/**
 * `x-litellm-spend-logs-metadata` on Landflow's own calls (`landflow: 'in-process'`), and the key metadata of a runtime
 * key (`landflow: 'runtime'`). The spend import skips every row marked `in-process`: Landflow's meter counted it.
 */
export interface LandflowSpendMetadata {
  landflow: 'in-process' | 'runtime';
  runtime?: AiRuntime;
  project?: string;
  agent?: string;
  workflow?: string;
  execution?: string;
  session?: string;
  surface?: string;
}

// ---------------------------------------------------------------------------
// Backstop budgets
// ---------------------------------------------------------------------------

/** A LiteLLM budget: dollars per window. LiteLLM budgets are in dollars only, so token caps have no backstop. */
export interface GatewayBudget {
  maxBudget: number;
  duration: '1d' | '30d';
}

/** Round up to the cent, ignoring float noise (1 × 1.1 × 100 is 110.00000000000001, which must not become 1.11). */
const cents = (value: number): number => Math.ceil(Number((value * 100).toFixed(6))) / 100;

const positive = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The backstop for a Landflow cap set: the daily dollar cap when there is one (window `1d`), else the monthly one
 * (`30d`), raised by `headroomPercent` so Landflow's own stop comes first for calls it makes itself. Undefined when the
 * set has no dollar cap. Rounded up to the cent.
 */
export function backstopBudget(set: { dayCost?: number; monthCost?: number } | undefined, headroomPercent: number): GatewayBudget | undefined {
  const factor = 1 + Math.max(0, positive(headroomPercent)) / 100;
  const day = positive(set?.dayCost);
  if (day) return { maxBudget: cents(day * factor), duration: '1d' };
  const month = positive(set?.monthCost);
  if (month) return { maxBudget: cents(month * factor), duration: '30d' };
  return undefined;
}

// ---------------------------------------------------------------------------
// Status, import and sync (GET /api/llm-gateway/status, GET/POST /api/llm-gateway/sync)
// ---------------------------------------------------------------------------

/** The spend import's state (settings key `llm_gateway_ingest`). */
export interface IngestStatus {
  enabled: boolean;
  lastRunAt?: string;
  /** The end of the last window read (ISO); the next run starts 15 minutes before it. */
  lastEnd?: string;
  /** Rows imported, and rows skipped (Landflow's own, already imported, failed calls), in the last run. */
  imported: number;
  skipped: number;
  /** Since the instance started importing. */
  totalImported: number;
  error?: string;
}

export interface SyncCounts {
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

/** What one budgets sync did (settings key `llm_gateway_sync`). Landflow never deletes in LiteLLM: what it no longer needs is listed as an orphan. */
export interface SyncReport {
  at: string;
  trigger: 'manual' | 'schedule' | 'change' | 'approval';
  teams: SyncCounts;
  customers: SyncCounts;
  keys: SyncCounts;
  orphans: Array<{ kind: 'team' | 'customer' | 'key'; litellmId: string; note: string }>;
  errors: string[];
}

export type GatewayHealth = 'ok' | 'degraded' | 'down' | 'unknown';

/** GET /api/llm-gateway/status. Everyone signed in gets the health and the models; admins get `admin`. */
export interface GatewayStatus {
  configured: boolean;
  source?: 'credential' | 'environment';
  health: GatewayHealth;
  checkedAt: string;
  error?: string;
  models: Array<{ id: string; ownedBy?: string }>;
  admin?: {
    baseUrl: string;
    /** Only from server configuration (Settings, the variable, the admin address); never a credential's URL. */
    uiUrl?: string;
    credentialId?: string;
    clusterUrl?: string;
    portalHeaders: boolean;
    ingest: IngestStatus;
    sync?: SyncReport;
  };
}

// ---------------------------------------------------------------------------
// Cap-raise requests (POST/GET /api/ai/cap-requests); a person decides each through Ask a Person
// ---------------------------------------------------------------------------

export type CapKind = 'workflow' | 'agent' | 'credential' | 'user';

/** A cap's id as lib/server/ai-usage/alerts.ts `watchedCaps()` builds it: `<kind>:<subject id>:<day|month>:<tokens|cost>`. */
export interface ParsedCapId {
  kind: CapKind;
  subjectId: string;
  period: 'day' | 'month';
  metric: 'tokens' | 'cost';
}

export function parseCapId(id: string): ParsedCapId | undefined {
  const parts = id.split(':');
  if (parts.length < 4) return undefined;
  const kind = parts[0] as CapKind;
  const metric = parts[parts.length - 1];
  const period = parts[parts.length - 2];
  const subjectId = parts.slice(1, -2).join(':');
  if (!['workflow', 'agent', 'credential', 'user'].includes(kind) || !subjectId) return undefined;
  if (period !== 'day' && period !== 'month') return undefined;
  if (metric !== 'tokens' && metric !== 'cost') return undefined;
  return { kind, subjectId, period, metric };
}

export const capIdOf = (cap: ParsedCapId): string => `${cap.kind}:${cap.subjectId}:${cap.period}:${cap.metric}`;

/**
 * pending: filed, the flow not started yet; asking: Ask a Person is waiting; approved: the Landflow cap was raised;
 * rejected: a person said no; failed: approved but the cap could not be changed; cancelled: the requester withdrew it.
 */
export type CapRaiseStatus = 'pending' | 'asking' | 'approved' | 'rejected' | 'failed' | 'cancelled';

export interface CapRaiseRequest {
  id: string;
  capId: string;
  /** As the cap names itself: "user “Ana”", "agent “Support”". */
  subject: string;
  metric: 'tokens' | 'cost';
  period: 'day' | 'month';
  /** The cap when the request was filed, and the cap asked for. */
  current: number;
  requested: number;
  reason: string;
  requestedBy: string;
  requestedByName?: string;
  status: CapRaiseStatus;
  /** The cap-raise flow's run that asks a person (Run Trace link). */
  workflowId?: string;
  executionId?: string;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: string;
  note?: string;
  /** What happened to the LiteLLM backstop on approval. */
  gateway?: 'updated' | 'skipped' | 'failed';
  createdAt: string;
  updatedAt: string;
}

/** POST /api/ai/cap-requests */
export interface CapRaiseInput {
  capId: string;
  requested: number;
  reason: string;
}

/** GET/POST /api/ai/cap-requests/setup: the cap-raise flow (installed from its template, published by an admin). */
export interface CapRaiseSetup {
  workflowId?: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// The AI page (GET /api/insights/ai)
// ---------------------------------------------------------------------------

export type AiConsolePeriod = '24h' | '7d' | '30d';
export type AiConsoleGroup = 'project' | 'agent' | 'person' | 'model' | 'source';

/** Tokens, estimated cost and calls (the same shape as lib/shared/ai-usage.ts AiUsageTotals, repeated so this file has no imports). */
export interface AiConsoleTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: number;
  calls: number;
}

export interface AiConsoleRow extends AiConsoleTotals {
  /** The group's key: a project, agent or user id, `provider/model`, or `source/runtime` (`landflow/landflow`, `litellm/kagent`). */
  key: string;
  label: string;
  href?: string;
  /** Share of the period's cost (of its tokens when nothing cost anything), 0 to 1. */
  share: number;
}

export interface AiConsoleCap {
  /** The watched cap's id (parseCapId reads it). */
  id: string;
  subject: string;
  period: 'day' | 'month';
  metric: 'tokens' | 'cost';
  max: number;
  used: number;
  /** used / max. */
  ratio: number;
  setIn: string;
  link: string;
  /** The viewer may ask for more (their own user cap, or a cap of an agent or workflow they can open). */
  canRequest: boolean;
  pendingRequestId?: string;
  /** The LiteLLM backstop the sync last wrote for it, if any. */
  backstop?: GatewayBudget;
}

export interface AiConsoleReport {
  period: AiConsolePeriod;
  from: string;
  to: string;
  totals: AiConsoleTotals;
  groups: Record<AiConsoleGroup, AiConsoleRow[]>;
  caps: AiConsoleCap[];
  /** Admins: every open request; members: their own. Newest first. */
  requests: CapRaiseRequest[];
  viewer: { admin: boolean; userId?: string };
  /** Whether the cap-raise flow is installed and published (members see "Ask for more" only when it is). */
  capRaise: CapRaiseSetup;
}
