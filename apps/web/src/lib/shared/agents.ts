/**
 * Agents (docs/agents.md): standalone tool-using assistants, separate from the AI Agent node.
 * Types shared by the API routes and the React client. No runtime imports.
 */
import type { AgentMessage } from '@landflow/engine';
import type { GuardrailsConfig, Replacement } from '../server/guardrails';

export type { AgentMessage };

/** A saved credential reference, as nodes keep them. */
export interface CredentialRef {
  id: string;
  name: string;
}

export type ModelProvider = 'anthropic' | 'openai' | 'ollama';

export interface AgentModel {
  provider: ModelProvider;
  model: string;
  /** anthropic: core.anthropicApi (optional, else ANTHROPIC_API_KEY); openai: core.openAiApi (required, any OpenAI-compatible base URL). */
  credential?: CredentialRef;
  /** ollama: the server, default http://127.0.0.1:11434 */
  baseUrl?: string;
  temperature?: number;
}

/** How the agent should handle a task, loaded on demand (Agent Skills: SKILL.md). */
export interface AgentSkill {
  id: string;
  name: string;
  /** "Use when …": always in the system prompt. */
  whenToUse: string;
  /** Step-by-step instructions, loaded with the load_skill tool. */
  instructions: string;
  /** Tool names the skill expects; informational. */
  allowedTools?: string[];
  /** Extra files from the skill's references/ folder, readable by the agent. */
  references?: Array<{ name: string; content: string }>;
}

interface ToolBase {
  id: string;
  /** Pause before the tool runs until a person approves it. */
  requireApproval?: boolean;
}

/** Any action node from any plugin, run on its own: `$fromAI('key', 'description', 'type')` marks what the model fills in. */
export interface NodeToolConfig extends ToolBase {
  type: 'node';
  /** Shown to the model as the tool name (made provider-safe). */
  name: string;
  description: string;
  nodeType: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, CredentialRef>;
}

/** A workflow that starts with "When Called by a Workflow or Agent" (core.workflowTrigger). */
export interface WorkflowToolConfig extends ToolBase {
  type: 'workflow';
  workflowId: string;
  name: string;
  description: string;
}

/** Another agent the agent can delegate a task to. */
export interface SubAgentConfig extends ToolBase {
  type: 'agent';
  agentId: string;
  /** When to delegate; defaults to the sub-agent's description. */
  useWhen?: string;
}

/** An MCP server: each tool it lists (all, selected, or all except some) becomes a tool with its JSON schema. */
export interface McpServerToolConfig extends ToolBase {
  type: 'mcp';
  /** A label for the server in the builder and in notices. */
  name: string;
  /** The MCP Client Tool's parameters (core.mcpClientTool): endpointUrl, serverTransport, authentication, include, includeTools, excludeTools, options. */
  parameters: Record<string, unknown>;
  /** httpBearerAuth or httpHeaderAuth, by the node's credential names. */
  credentials?: Record<string, CredentialRef>;
}

/**
 * A knowledge base: a vector store collection the agent searches with a `search_…` tool. It is filled by a
 * workflow with the same store and collection in “Insert Documents” mode, using the same embeddings model.
 */
export interface KnowledgeBaseToolConfig extends ToolBase {
  type: 'knowledge';
  /** The tool name the model sees (made provider-safe). */
  name: string;
  /** When to search it. */
  description: string;
  store: 'memory' | 'sqlite' | 'pgvector';
  collection: string;
  /** pgvector: a core.postgres credential and the table (default landflow_vectors). */
  credential?: CredentialRef;
  tableName?: string;
  /** Must be the model the documents were inserted with. */
  embeddings: {
    provider: 'ollama' | 'openai';
    model: string;
    /** ollama: the server, default OLLAMA_URL or http://127.0.0.1:11434 */
    baseUrl?: string;
    /** openai: a core.openAiApi credential (any OpenAI-compatible base URL). */
    credential?: CredentialRef;
    /** Put before every query (nomic-embed-text: "search_query: "). */
    queryPrefix?: string;
    dimensions?: number;
  };
  topK?: number;
  searchMode?: 'vector' | 'hybrid';
}

export type AgentToolConfig = NodeToolConfig | WorkflowToolConfig | SubAgentConfig | McpServerToolConfig | KnowledgeBaseToolConfig;

export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';

export interface AgentSchedule {
  id: string;
  /** What to do, sent as the user message of each run. */
  prompt: string;
  frequency: ScheduleFrequency;
  /** HH:MM for daily / weekly / monthly; minute past the hour for hourly. */
  time?: string;
  /** 0 = Sunday … 6, weekly only. */
  weekday?: number;
  /** 1–28, monthly only. */
  dayOfMonth?: number;
  /** Five-field cron, `cron` only. */
  cron?: string;
  timezone: string;
  enabled: boolean;
}

/** A chat app the published agent answers in. */
export interface AgentChannel {
  id: string;
  /**
   * telegram: polled through the messaging plugin; slack: Events API at /api/slack/events/<agentId>/<channelId> and slash
   * commands at /api/slack/commands/<agentId>/<channelId>; teams: Bot Framework messaging endpoint at /api/teams/messages/<agentId>/<channelId>.
   */
  type: 'telegram' | 'slack' | 'teams';
  /**
   * telegram: messaging.telegramApi; slack: messaging.slackApi or messaging.slackOAuth2Api (bot token, and the signing secret that
   * verifies events); teams: core.microsoftBotApi (app id and password of the bot registration).
   */
  credential: CredentialRef;
  access: 'private' | 'public';
  /** Private: Telegram user ids or usernames, or Slack member ids (U…), allowed to talk to the agent. */
  allowedUsers: string[];
  /** Start a new session after this many idle minutes (0 = never). Slack threads are sessions of their own. */
  newSessionAfterMinutes: number;
  enabled: boolean;
  /** Slack: answer in a thread under the message (default), else in the channel. */
  threadReplies?: boolean;
  /** Slack: answer slash commands (default on); the app's command points at /api/slack/commands/<agentId>/<channelId>. */
  slashCommands?: boolean;
}

export interface AgentSettings {
  /** Agent loop iterations per run (1–200). */
  maxIterations: number;
  /** Tool calls run at the same time. */
  toolConcurrency: number;
  /** Stop a session once it used this many tokens (0 = no cap). */
  sessionTokenBudget: number;
  /** How deep sub-agents may delegate further (1–5). */
  maxDelegationDepth: number;
  /** Usage limits across all sessions (0 or absent = none): tokens per day, USD per day, USD per calendar month (instance time zone). */
  dailyTokenLimit?: number;
  dailyCostLimit?: number;
  monthlyCostLimit?: number;
  /** Addresses that get approve / reject links by email (host SMTP) whenever a run waits for a tool approval. */
  approvalEmails?: string[];
}

/**
 * Checks on what goes into or comes out of the agent (the Guardrails node's checks: PII, secret keys, keywords, URLs,
 * prompt injection, moderation, custom). `block` answers with `reply` instead (the input never reaches the model, the
 * output never reaches the person); `sanitize` replaces what the pattern checks find (PII, secrets, keywords, URLs) and
 * goes on. Checks that need a model (injection with the model, moderation, custom) only run in `block` rules.
 */
export interface AgentGuardrail {
  enabled: boolean;
  action: 'block' | 'sanitize';
  /** block: what the person gets instead; the builder writes it. */
  reply: string;
  /** sanitize: `redact` puts <EMAIL_ADDRESS>, `mask` keeps the last characters. */
  replacement?: Replacement;
  checks: GuardrailsConfig;
}

export interface AgentGuardrails {
  /** Applied to each user message before the model sees it. */
  input?: AgentGuardrail;
  /** Applied to the final answer before it is sent. */
  output?: AgentGuardrail;
}

/** Everything that decides how the agent behaves: the draft, and each published version. */
export interface AgentConfig {
  name: string;
  description: string;
  icon: string;
  color: string;
  model?: AgentModel;
  instructions: string;
  skills: AgentSkill[];
  tools: AgentToolConfig[];
  schedules: AgentSchedule[];
  channels: AgentChannel[];
  memory: { crossSession: boolean };
  settings: AgentSettings;
  guardrails?: AgentGuardrails;
}

export interface AgentVersion {
  version: number;
  publishedAt: string;
  config: AgentConfig;
}

export interface Agent extends AgentConfig {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The version schedules, channels and the Message an Agent node use. Absent while unpublished. */
  published?: AgentVersion;
  /** Earlier published versions, newest first (max 20). */
  history: AgentVersion[];
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  model?: string;
  tools: number;
  skills: number;
  publishedVersion?: number;
  /** The draft has changes the published version doesn't. */
  draftChanged: boolean;
  sessions: number;
  updatedAt: string;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { maxIterations: 12, toolConcurrency: 5, sessionTokenBudget: 0, maxDelegationDepth: 2 };

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionSource = 'test' | 'schedule' | 'telegram' | 'slack' | 'teams' | 'workflow' | 'agent' | 'api';
export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'error';
export type ToolKind = 'node' | 'workflow' | 'agent' | 'skill' | 'memory';

/** One step of a session, as the UI shows it. Entries are upserted by id while a run streams. */
export type TimelineEntry =
  | { id: string; type: 'user'; text: string; at: string; from?: string }
  | { id: string; type: 'assistant'; text: string; at: string; model?: string; usage?: TokenUsage }
  | {
      id: string;
      type: 'tool';
      callId: string;
      /** The name the model called. */
      tool: string;
      /** What the user calls it (node / workflow / agent name). */
      label: string;
      kind: ToolKind;
      /** Node type, for the icon. */
      nodeType?: string;
      input: Record<string, unknown>;
      output?: unknown;
      error?: string;
      status: 'running' | 'success' | 'error' | 'awaiting_approval' | 'denied';
      durationMs?: number;
      /** A workflow tool's workflow and execution, or a sub-agent and its session. */
      workflowId?: string;
      executionId?: string;
      childAgentId?: string;
      childSessionId?: string;
      at: string;
    }
  /** An input or output guardrail that blocked or sanitized the text (nothing is shown when the text passed). */
  | {
      id: string;
      type: 'guardrail';
      stage: 'input' | 'output';
      action: 'blocked' | 'sanitized';
      /** What was found; matches are masked. */
      violations: Array<{ check: string; type: string; match?: string; confidence?: number; reason?: string }>;
      /** blocked: the reply that went out instead. */
      reply?: string;
      at: string;
    }
  | { id: string; type: 'error'; message: string; at: string }
  | { id: string; type: 'notice'; message: string; at: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PendingCall {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  decision?: 'approved' | 'denied';
  /** Who decided (a Slack member id, "you" in the test chat). */
  decidedBy?: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
  agentName: string;
  source: SessionSource;
  /** Who is talking (channel user, workflow, "you" in the test chat); keys cross-session memory. */
  userId: string;
  title: string;
  status: SessionStatus;
  /** Which config ran: the draft or a published version. */
  version: 'draft' | number;
  /** The model transcript (session memory). */
  messages: AgentMessage[];
  timeline: TimelineEntry[];
  /** Tool calls waiting for a person, with the results of the same turn's other calls. */
  pending?: { calls: PendingCall[]; results: Array<{ id: string; name: string; content: string; isError?: boolean }>; iterations: number };
  usage: TokenUsage;
  /** One trace per run, newest last. */
  traceIds: string[];
  parentSessionId?: string;
  /** The agent that delegated to this session (with parentSessionId). */
  parentAgentId?: string;
  /** Channel conversation this session belongs to (e.g. a Telegram chat id). */
  conversationKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  source: SessionSource;
  userId: string;
  title: string;
  status: SessionStatus;
  version: 'draft' | number;
  turns: number;
  toolCalls: number;
  usage: TokenUsage;
  traceId?: string;
  parentSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Streamed by POST /api/agents/:id/chat and the approval route (SSE `data:` lines). */
export type AgentStreamEvent =
  | { type: 'run.started'; sessionId: string; traceId?: string; /** With LANDFLOW_TRACE_URL set. */ traceUrl?: string }
  | { type: 'entry'; sessionId: string; entry: TimelineEntry }
  /** `usage` is the session's total so far. */
  | { type: 'run.finished'; sessionId: string; status: SessionStatus; reply?: string; reason: RunEndReason; usage: TokenUsage };

export type RunEndReason = 'completed' | 'awaiting_approval' | 'max_iterations' | 'budget' | 'error' | 'canceled';

/** Model choices for the builder's picker. */
export interface ModelOption {
  provider: ModelProvider;
  model: string;
  label: string;
  description?: string;
}
