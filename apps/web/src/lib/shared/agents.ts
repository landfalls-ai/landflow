/**
 * Agents (docs/agents.md): standalone tool-using assistants, separate from the AI Agent node.
 * Types shared by the API routes and the React client. No runtime imports.
 */
import type { AgentMessage } from '@landflow/engine';

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

/** A workflow that starts with "When Called by an Agent" (core.workflowTrigger). */
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

export type AgentToolConfig = NodeToolConfig | WorkflowToolConfig | SubAgentConfig;

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
  type: 'telegram';
  credential: CredentialRef;
  access: 'private' | 'public';
  /** Private: Telegram user ids or usernames allowed to talk to the agent. */
  allowedUsers: string[];
  /** Start a new session after this many idle minutes (0 = never). */
  newSessionAfterMinutes: number;
  enabled: boolean;
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

export type SessionSource = 'test' | 'schedule' | 'telegram' | 'workflow' | 'agent' | 'api';
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
