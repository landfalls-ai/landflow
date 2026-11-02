/**
 * Agents (docs/agents.md): standalone tool-using assistants, separate from the AI Agent node.
 * Types shared by the API routes and the React client. No runtime imports.
 */
import type { AgentMessage } from '@landflow/engine';
import type { GuardrailsConfig, Replacement } from '../server/guardrails';
import type { AgentFace } from './faces';

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
  /**
   * `github`: GitHub's MCP server (docs/a2a.md). The credential is a Bearer Auth one holding a GitHub token, and the tools are cut
   * down on the server to `access`'s allow-list (lib/server/mcp/github.ts); `include` and the like are ignored.
   */
  preset?: 'github';
  /** `read` (default): look at pull requests, code and issues. `review`: also review and comment. Merging and writing code are never offered. */
  access?: 'read' | 'review';
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

/**
 * A remote agent over A2A 1.0 (docs/a2a.md): a kagent agent, a Google ADK agent, any A2A server. The model asks it with an
 * `ask_…` tool; the conversation with it lasts as long as the session. When it pauses for an approval of its own tool calls
 * (kagent's human-in-the-loop extension), the run waits for a person like any tool that needs approval.
 */
export interface A2aAgentToolConfig extends ToolBase {
  type: 'a2a';
  /** A label for the agent in the builder; the tool is `ask_<name>`. */
  name: string;
  /** The A2A Agent node's parameters (core.a2aAgent): agentUrl, authentication, options (timeout, humanInTheLoop). */
  parameters: Record<string, unknown>;
  /** httpBearerAuth or httpHeaderAuth, by the node's credential names. */
  credentials?: Record<string, CredentialRef>;
  /** When to ask it; defaults to the agent card's description and skills. */
  useWhen?: string;
}

export type AgentToolConfig = NodeToolConfig | WorkflowToolConfig | SubAgentConfig | McpServerToolConfig | KnowledgeBaseToolConfig | A2aAgentToolConfig;

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

export type AnswerLength = 'sentence' | 'paragraph' | 'detailed';

/**
 * Who the agent is and how it talks, in the parts the Persona tab edits. personaPrompt() (../shared/persona.ts) writes them
 * into the system prompt ahead of the instructions: the same text for runs here and for kagent.
 */
export interface AgentPersona {
  /** What it is, in a few words: "Editor for the docs team". */
  role?: string;
  /** Who it helps. */
  audience?: string;
  /** What it does for them. */
  mission?: string;
  /** Words for its tone: Precise, Friendly… */
  tones?: string[];
  length?: AnswerLength;
  /** The language it answers in; absent, the language it's written to in. */
  language?: string;
  /** A line it ends every answer with. */
  signoff?: string;
  /** Up to three short lines for the member cards on a team page ("Reviews every pull request"). Never part of the prompt. */
  whatIDo?: string[];
  /** Rules, a sentence each. */
  always?: string[];
  never?: string[];
  /** Exchanges that show how it answers; only complete ones go into the prompt. */
  examples?: Array<{ user: string; assistant: string }>;
}

/**
 * How the agent looks (docs/agents.md#avatars): absent, its icon on a tile tinted with its colour; or an illustrated face,
 * initials or an image. faces.ts cleans it. Never part of the prompt.
 */
export interface AgentAvatar {
  kind: 'icon' | 'face' | 'initials' | 'image';
  face?: AgentFace;
  /** One or two letters. */
  initials?: string;
  /** A data: URL (PNG, JPEG or WebP) of at most MAX_AVATAR_IMAGE characters; the picker scales images to 256 px. */
  image?: string;
  /** The tile filled with the colour instead of tinted with it. */
  solid?: boolean;
}

export const MAX_AVATAR_IMAGE = 200_000;

/** Everything that decides how the agent behaves: the draft, and each published version. */
export interface AgentConfig {
  name: string;
  description: string;
  icon: string;
  color: string;
  avatar?: AgentAvatar;
  /** The team it belongs to: the Agents page groups by it. Never part of the prompt. */
  team?: string;
  model?: AgentModel;
  persona?: AgentPersona;
  instructions: string;
  skills: AgentSkill[];
  tools: AgentToolConfig[];
  schedules: AgentSchedule[];
  channels: AgentChannel[];
  memory: { crossSession: boolean };
  settings: AgentSettings;
  guardrails?: AgentGuardrails;
  /**
   * Claude Code plugins from the added marketplaces, as `<plugin>@<marketplace>`: on kagent's Claude Code runtime, Claude
   * Code loads each whole (its agents, skills, commands, hooks and MCP servers). Other runtimes don't use them.
   */
  plugins?: string[];
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
  /** The version schedules, channels and the Run an Agent node use. Absent while unpublished. */
  published?: AgentVersion;
  /** Earlier published versions, newest first (max 20). */
  history: AgentVersion[];
  /** Where the published version also runs: kagent, with the persona, model and tools Landflow wrote there. */
  kagent?: KagentDeployment;
}

/**
 * A published agent deployed to kagent (docs/a2a.md, "Landflow agents on kagent"): Landflow writes its persona (the system
 * prompt the runtime builds), model and tools as kagent resources, and writes them again on every publish.
 */
export interface KagentDeployment {
  /** The kagent cluster: a core.kagentApi credential (Kubernetes API, namespace, harness, the two URLs). */
  credential: CredentialRef;
  /** The name of the Agent, AgentTemplate, ModelConfig and RemoteMCPServer in kagent (a DNS label). */
  name: string;
  /** The Harness it runs on, which picks the runtime (kagent's own, Claude Code); absent, the credential's. */
  harness?: string;
  /** The published version written last, and when. */
  version?: number;
  deployedAt?: string;
  /** The token kagent calls the agent's MCP endpoint with, sealed with the encryption key (kagent keeps it in a Secret). */
  token?: string;
  /** Claude Code: the plugins written last, each pinned to the commit it was at then. */
  plugins?: KagentPlugin[];
  /** The EgressPolicies its Agent references (what its sandbox may reach); absent, the credential's. */
  egressPolicies?: string[];
  /** Claude Code: the landflow-harness mod's guard for this agent (absent: `enforce`). A request can't loosen it. */
  guard?: KagentGuard;
  /**
   * Claude Code with Landflow's landflow-harness mod (docs/a2a.md, "The landflow-harness mod"): where the mod posts what
   * the agent does (`<landflowUrl>/api/agent-trace`), so a run shows its real tokens, cost and tool calls.
   */
  trace?: { url: string; /** The agent's A2A URL then, to know a call goes to it. */ a2aUrl?: string };
}

/**
 * How strictly the landflow-harness mod guards a Claude Code agent (docs/a2a.md, "The landflow-harness mod"): `strict`
 * keeps it read-only on the code (a reviewer), `enforce` refuses what no agent here needs to do (the default), `report`
 * only reports what would have been refused.
 */
export type KagentGuard = 'strict' | 'enforce' | 'report';
export const KAGENT_GUARDS: readonly KagentGuard[] = ['strict', 'enforce', 'report'];

/**
 * A Claude Code plugin as kagent fetches it: a git repository at one commit and the plugin's folder in it, and the image
 * Landflow packed from them when the cluster pulls plugins from Landflow's registry.
 */
export interface KagentPlugin {
  /** `<plugin>@<marketplace>` */
  id: string;
  url: string;
  commit: string;
  path?: string;
  /** `<registry>/plugins/<marketplace>/<plugin>@sha256:…` */
  oci?: string;
  /** A built-in plugin's options Landflow wrote as its plugin.json defaults (the landflow-harness mod's `guard`). */
  options?: Record<string, string>;
}

/** What runs an agent on kagent: its own ADK runtime, Claude Code, Codex, or an image of one's own. */
export type KagentRuntime = 'kagent' | 'claude' | 'codex' | 'byo';

/** A kagent Harness: a runtime and the sandbox policy agents on it share. */
export interface KagentHarness {
  name: string;
  runtime: KagentRuntime;
}

/** A difference between what kagent holds and what Landflow writes from the published version. */
export interface KagentDrift {
  /** `systemPrompt`, `description`, `tools`, `plugins`, `model`, `harness`, `mcpServer`, or the kind of a missing resource. */
  field: string;
  landflow: string;
  kagent?: string;
}

/** GET /api/agents/<id>/kagent: the deployment and what kagent holds now. */
export interface KagentStatus {
  deployed: boolean;
  credential?: CredentialRef;
  name?: string;
  namespace?: string;
  /** The Harness the agent runs on. */
  harness?: KagentHarness;
  /** Claude Code: the plugins it loads, at the commits written last. */
  plugins?: KagentPlugin[];
  /** The EgressPolicies its Agent references. */
  egressPolicies?: string[];
  /** Claude Code: the mod's guard for this agent. */
  guard?: KagentGuard;
  version?: number;
  deployedAt?: string;
  /** The agent's A2A endpoint on kagent's controller, as Landflow reaches it. */
  a2aUrl?: string;
  /** kagent's copy matches what Landflow writes from the published version. */
  inSync: boolean;
  drift: KagentDrift[];
  /** The published version is newer than the one written last. */
  outdated: boolean;
  /** The AgentTemplate's systemPrompt as kagent holds it. */
  systemPrompt?: string;
  /** The Agent's Ready condition. */
  ready?: { status: boolean; reason?: string; message?: string };
  /** kagent couldn't be read. */
  error?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  avatar?: AgentAvatar;
  team?: string;
  /** The persona's role and tones, for the roster's cards. */
  role?: string;
  tones?: string[];
  /** The member card's “what I do” lines: the persona's own, else the first sentences of its mission or instructions (whatIDoLines). */
  whatIDo?: string[];
  model?: string;
  tools: number;
  skills: number;
  publishedVersion?: number;
  /** The draft has changes the published version doesn't. */
  draftChanged: boolean;
  /** Where the published version runs besides Landflow: its kagent deployment, enabled channels and schedules. */
  kagent?: string;
  channels: string[];
  schedules: number;
  /** The marketplace plugin whose install created the agent (GET /api/agents adds it): uninstalling it deletes the agent. */
  marketplace?: { installedId: string; plugin: string; marketplace: string };
  sessions: number;
  updatedAt: string;
}

/** A team name as stored: trimmed, at most 60 characters; absent when blank. */
export function cleanTeam(team: string | undefined): string | undefined {
  const kept = team?.replace(/\s+/g, ' ').trim().slice(0, 60);
  return kept || undefined;
}

/**
 * A persona to start a new agent from (docs/agents.md#templates): built in, or saved from an agent ("Save as template").
 * Its config has the persona, instructions, skills, model (no credential), avatar and settings, never tools, channels or
 * schedules: `suggests` names the tools the agent had.
 */
export interface AgentTemplate {
  id: string;
  source: 'builtin' | 'saved';
  name: string;
  /** Support, Operations, Content, Data, Research… */
  category: string;
  description: string;
  suggests?: string;
  config: Partial<AgentConfig>;
  author?: string;
  /** Saved ones: the project it's shared in; absent, the whole instance. */
  projectId?: string;
  projectName?: string;
  canEdit?: boolean;
  createdAt?: string;
}

/** A Claude Code plugin's id as Claude Code writes it: `<plugin>@<marketplace>`. */
export const PLUGIN_ID = /^[^@\s]+@[^@\s]+$/;

/** The plugins as stored: trimmed, valid, each once; absent when there are none. */
export function cleanPlugins(plugins: string[] | undefined): string[] | undefined {
  const kept = [...new Set((plugins ?? []).map((id) => id.trim()).filter((id) => PLUGIN_ID.test(id)))];
  return kept.length ? kept : undefined;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { maxIterations: 12, toolConcurrency: 5, sessionTokenBudget: 0, maxDelegationDepth: 2 };

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionSource = 'test' | 'schedule' | 'telegram' | 'slack' | 'teams' | 'workflow' | 'agent' | 'api';
export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'error';
/** `flow`: a tool connected to the agent's node in a workflow (Run an Agent), for that run only. `notebook`: a team run's notebook tools (docs/team-notebook.md). */
export type ToolKind = 'node' | 'workflow' | 'agent' | 'skill' | 'memory' | 'a2a' | 'flow' | 'notebook';

/** A tool call a remote (A2A) agent made, as its task reports it. */
export interface RemoteToolStep {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  status: 'running' | 'success' | 'error' | 'awaiting_approval';
  /** The remote agent's timestamps, ISO. */
  startedAt?: string;
  endedAt?: string;
}

/** Words a remote agent said between its tool calls (not its final answer): after how many tool calls it said them. */
export interface RemoteSaid {
  id: string;
  text: string;
  afterSteps: number;
  at?: string;
}

/** What a remote agent did during one tool call: its task, its tool calls (live while it works), its token usage. */
export interface RemoteRun {
  agent: string;
  /** The task's state: working, completed, input-required, failed… */
  state: string;
  taskId?: string;
  contextId?: string;
  steps: RemoteToolStep[];
  /** What it said between the tool calls, in order with them (`afterSteps`). */
  said?: RemoteSaid[];
  usage?: TokenUsage;
  /** What the agent reported through Landflow's landflow-harness mod (a Claude Code agent on kagent). */
  trace?: AgentTraceSummary;
}

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
      /** An A2A agent's task: its tool calls and usage. */
      remote?: RemoteRun;
      /** awaiting_approval: what the person is asked (a remote agent's pause names the calls it waits on). */
      approval?: { message: string };
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
  /** Of `inputTokens`, read from and written to the prompt cache, when the model said so. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** What it cost in USD when Landflow priced it from what the agent reported (a remote agent's mod). */
  costUsd?: number;
  /** Model requests behind it, when the agent reported them. */
  requests?: number;
  /** The model that answered (the last one, when several did). */
  model?: string;
}

/** What one model, or one subagent, of a traced agent used (`AgentTraceSummary`). */
export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Model requests. */
  requests: number;
  model?: string;
}

/** One model request of a traced agent (the journal records each as a `model` span under the agent's request). */
export interface TraceCall {
  /** When the request ended, epoch ms, as the mod's clock said (absent: unknown). */
  at?: number;
  /** How long it took, ms. */
  ms: number;
  model: string;
  /** The subagent that made it; absent, the main loop. */
  agent?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** A tool call Landflow's guardrails stopped (or, with guard=report, would have stopped) inside a remote agent. */
export interface TraceGuardDecision {
  /** secret-file, env-dump, git-push, git-auth-config, merge, destructive, upload, write-outside-workspace */
  rule: string;
  tool: string;
  action: 'deny' | 'report';
  /** The command or path, with secrets masked and cut short. */
  arg?: string;
  reason?: string;
  /** The subagent that made the call; absent, the main loop. */
  agent?: string;
}

/**
 * What a Claude Code agent on kagent reported through the landflow-harness mod for one call (server/a2a/agent-trace.ts):
 * its real token usage and cost, per model and per subagent, its tool calls and what the guardrails stopped.
 */
export interface AgentTraceSummary {
  usage: TraceUsage;
  models: Array<TraceUsage & { model: string }>;
  /** The subagents it started, with what each used. */
  agents: Array<TraceUsage & { id: string; kind?: string; description?: string }>;
  tools: { calls: number; failed: number; ms: number };
  /** Each model request, in order (the first 300). */
  calls?: TraceCall[];
  /** Time spent waiting on the model, ms (subagents' included, so it can exceed the turn). */
  modelMs: number;
  /** The main loop's turn, ms. */
  turnMs?: number;
  /** Tool calls the API ran itself (web search, code execution). */
  serverTools?: number;
  guard: TraceGuardDecision[];
  guardMode?: 'strict' | 'enforce' | 'report' | 'off';
  /** Tool results that had a secret masked, and the kinds. */
  redacted: number;
  redactedKinds?: string[];
  /** The mod's version. */
  mod?: string;
}

export interface PendingCall {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  decision?: 'approved' | 'denied';
  /** Who decided (a Slack member id, "you" in the test chat). */
  decidedBy?: string;
  /**
   * The call already ran and the remote (A2A) agent it asked paused for approval of its own tool calls: the decision is
   * sent to that agent, which goes on (and may pause again).
   */
  remote?: { agent: string; calls: Array<{ name: string; args?: Record<string, unknown> }>; state: Record<string, unknown> };
  /** A person's answer, when the remote agent paused on a question for one (a team member's question): sent to it as the reply. */
  answer?: string;
}

/** What an approval card shows for a pending call: a remote agent's pause names the agent and the calls it waits on. */
export function approvalSubject(call: Pick<PendingCall, 'tool' | 'input' | 'remote'>): { tool: string; input: Record<string, unknown> } {
  if (!call.remote) return { tool: call.tool, input: call.input };
  const { agent, calls } = call.remote;
  return { tool: `${agent} → ${calls.map((c) => c.name).join(', ')}`, input: calls.length === 1 ? (calls[0].args ?? {}) : { calls } };
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
  /** The conversation with each A2A agent (by capability id): its context, and a task waiting for an answer. */
  remoteContexts?: Record<string, { contextId: string; taskId?: string; question?: { id: string; questions: string[] } }>;
  usage: TokenUsage;
  /** One trace per run, newest last. */
  traceIds: string[];
  parentSessionId?: string;
  /** The agent that delegated to this session (with parentSessionId). */
  parentAgentId?: string;
  /** Channel conversation this session belongs to (e.g. a Telegram chat id). */
  conversationKey?: string;
  /** The workflow run and Run an Agent node that started this session (the execution view shows it live). */
  execution?: SessionExecution;
  createdAt: string;
  updatedAt: string;
}

/** Where a workflow-started session came from. */
export interface SessionExecution {
  workflowId: string;
  executionId: string;
  nodeId: string;
  nodeName?: string;
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
  execution?: SessionExecution;
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
