/** Types shared by the API routes and the React client. No runtime imports. */
import type { DebugCommand, ExecutionEvent, ExecutionResult, ExecutionWait, NodeRun, PauseReason, Transport, Workflow } from '@landflow/engine';
import type { CredentialTypeDescriptor, NodeDescriptor, NodeItem, PluginInfo } from '@landflow/protocol';
import type { EditLockView } from './auth';
import type { EvaluationRef } from './evaluations';
import type { ExecutionAiUsage } from './ai-usage';

export type { DebugCommand, ExecutionEvent, ExecutionResult, ExecutionWait, NodeRun, PauseReason, Transport, Workflow };
export type { StickyNote, WorkflowConnection, WorkflowGroup, WorkflowNode, WorkflowSettings } from '@landflow/engine';
export type { CredentialTypeDescriptor, NodeDescriptor, NodeItem, PropertyDescriptor, PortDescriptor, ConnectionType } from '@landflow/protocol';

export type DiscoverySource = 'builtin' | 'announce' | 'static' | 'scan' | 'manual' | 'kubernetes';
export type PluginStatus = 'online' | 'offline' | 'error';

/** Where a discovered endpoint came from: the Kubernetes namespace and Service (lib/server/plugins/kubernetes.ts). */
export interface EndpointOrigin {
  namespace: string;
  service: string;
}

export interface EndpointSummary {
  endpoint: string;
  transport: Transport;
  source: DiscoverySource;
  status: PluginStatus;
  lastSeen?: string;
  leaseExpiresAt?: string;
  latencyMs?: number;
  lastError?: string;
  origin?: EndpointOrigin;
}

export interface PluginSummary {
  id: string;
  info: PluginInfo;
  status: PluginStatus;
  /** Transport currently used to execute nodes. */
  transport: Transport;
  activeEndpoint?: string;
  preferredTransport?: Transport;
  endpoints: EndpointSummary[];
  source: DiscoverySource;
  registeredAt: string;
  updatedAt: string;
  lastError?: string;
  nodes: Array<Pick<NodeDescriptor, 'name' | 'displayName' | 'description' | 'icon' | 'color' | 'kind' | 'categories' | 'usableAsTool'>>;
}

export interface NodeTypeInfo {
  /** Fully-qualified type, e.g. "go-crypto.hash". */
  type: string;
  pluginId: string;
  pluginName: string;
  /** The plugin's own icon and brand colour, for node-creator segments. */
  pluginIcon?: string;
  pluginColor?: string;
  pluginDescription?: string;
  language: string;
  transport: Transport;
  available: boolean;
  descriptor: NodeDescriptor;
  /** Why the governance policy blocks this node type (Settings → Governance); the node creator hides it. */
  blocked?: string;
}

export interface CredentialTypeInfo {
  /** Fully-qualified: "messaging.telegramApi". */
  type: string;
  pluginId: string;
  pluginName: string;
  pluginIcon?: string;
  pluginColor?: string;
  available: boolean;
  descriptor: CredentialTypeDescriptor;
  /** Node types that can use it. */
  nodeTypes: string[];
  /** The types it extends, qualified and transitively (`descriptor.properties` already has theirs merged in). */
  extendsTypes?: string[];
  /** An OAuth2 type (core.oAuth2Api or one extending it): the credential dialog shows a Connect button. */
  oauth2?: boolean;
}

export interface CredentialSummary {
  id: string;
  name: string;
  /** Fully-qualified credential type. */
  type: string;
  createdAt: string;
  updatedAt: string;
  /** Workflows with a node that references this credential. */
  usedBy: Array<{ workflowId: string; workflowName: string }>;
  /** OAuth2 credentials: whether they are connected, as whom, and until when (lib/shared/oauth2.ts). */
  oauth2?: import('./oauth2').OAuth2Status;
}

export interface CredentialDetail extends CredentialSummary {
  /** Non-secret fields. Secret (password) fields are never returned by the API. */
  data: Record<string, unknown>;
  /** Secret fields that have a stored value. */
  secrets: string[];
}

export type RegistryEvent =
  | { type: 'plugin.registered'; pluginId: string; endpoint: string; source: DiscoverySource; message: string }
  | { type: 'plugin.updated'; pluginId: string; endpoint?: string; message: string }
  | { type: 'plugin.heartbeat'; pluginId: string; endpoint: string; message: string }
  | { type: 'plugin.offline'; pluginId: string; endpoint?: string; message: string }
  | { type: 'plugin.removed'; pluginId: string; message: string }
  | { type: 'plugin.error'; pluginId?: string; endpoint: string; message: string }
  | { type: 'scan.started'; targets: number; message: string }
  | { type: 'scan.probe'; endpoint: string; found: boolean; pluginId?: string; message: string }
  | { type: 'scan.finished'; found: number; durationMs: number; message: string };

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  nodeCount: number;
  nodeTypes: string[];
  tags: string[];
  /** Folder in the workflows list; none = top level. */
  folderId?: string;
  updatedAt: string;
  createdAt: string;
}

/** `all` replays the whole run with the same input; `from` re-runs a node and everything after it; `only` re-runs one node. */
export type RerunScope = 'all' | 'from' | 'only';

export interface RerunOf {
  executionId: string;
  scope: RerunScope;
  nodeId?: string;
}

export interface PausedState {
  nodeId: string;
  nodeName: string;
  reason: PauseReason;
  since: string;
}

/** `queued`: a trigger run waiting for a concurrency slot of its workflow (it starts by itself). */
export type ExecutionState = ExecutionResult['status'] | 'running' | 'queued';

/** A queued execution: how it starts once its workflow has a free slot. */
export interface QueuedStart {
  startNodeId?: string;
  triggerItems?: NodeItem[];
  triggerOutput?: { nodeId: string; items: NodeItem[] };
  queuedAt: string;
  /** Queue mode: waiting for a worker to take its job (not held by the concurrency limit). */
  worker?: boolean;
}

export interface ExecutionRecord extends Omit<ExecutionResult, 'status'> {
  status: ExecutionState;
  workflowName: string;
  /** node id → display name at the time of the run. */
  nodeNames?: Record<string, string>;
  /** The workflow as it ran, so the run can be repeated exactly. */
  workflow?: Workflow;
  rerunOf?: RerunOf;
  debug?: boolean;
  /** Live runs only: where the debugger is holding it. */
  paused?: PausedState;
  /** Started by an Execute Workflow node: the calling execution. */
  parentExecutionId?: string;
  /** The Execute Workflow node of the parent that started it. */
  parentNodeId?: string;
  /** Executions this one started through Execute Workflow nodes. */
  subExecutions?: SubExecutionRef[];
  /** Execute Workflow nesting level (absent: top level). */
  depth?: number;
  /** An error workflow run: the failed execution that started it. */
  errorOf?: string;
  /** What a Form node's completion step showed (the form's last page). */
  formCompletion?: FormCompletion;
  /** The workflow version the execution started on (absent: an unsaved editor draft, kept in `workflow`). */
  versionId?: string;
  /** That version's number, and whether it was the published version when the run started ("ran version 7 (published)"). */
  versionNumber?: number;
  versionPublished?: boolean;
  /** The failed execution this one retries, and which retry it is (1 = the first). */
  retryOf?: string;
  retryAttempt?: number;
  /** Set on a failed execution: the retry that followed it. */
  retriedBy?: string;
  /** Set on a failed execution: when its automatic retry starts. */
  retryAt?: string;
  /** The host restarted while the run was going: it continued from its last checkpoint. */
  resumedAfterRestart?: { at: string; stepId: string };
  /** The trigger call's Idempotency-Key. */
  idempotencyKey?: string;
  /** A manual run: the user (id) who started it. */
  startedBy?: string;
  /** Status `queued`: how it starts once a slot frees. */
  queued?: QueuedStart;
  /** A run of an offline evaluation (one test case): left out of Insights and production counts. */
  evaluation?: EvaluationRef;
  /** Tokens and estimated cost of the model calls this execution made (lib/server/ai-usage). */
  aiUsage?: ExecutionAiUsage;
  /** Started by the trigger's debounce or batching: how many held events the run took. */
  buffered?: { kind: 'debounce' | 'batch'; count: number };
}

export interface SubExecutionRef {
  executionId: string;
  workflowId: string;
  /** The Execute Workflow node that started it. */
  nodeId?: string;
}

/** The end screen of a hosted form: a message, or a redirect. */
export interface FormCompletion {
  respondWith: 'text' | 'redirect';
  title?: string;
  message?: string;
  url?: string;
}

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  mode: ExecutionResult['mode'];
  status: ExecutionState;
  startedAt: string;
  durationMs: number;
  nodesRun: number;
  error?: ExecutionResult['error'];
  rerunOf?: RerunOf;
  debug?: boolean;
  paused?: PausedState;
  /** Waiting runs: what they wait for. */
  wait?: Pick<ExecutionWait, 'nodeName' | 'resume' | 'until'>;
  parentExecutionId?: string;
  versionId?: string;
  versionNumber?: number;
  versionPublished?: boolean;
  retryOf?: string;
  retryAttempt?: number;
  retriedBy?: string;
  retryAt?: string;
  /** Shown as "resumed after restart". */
  resumedAfterRestart?: boolean;
  /** An evaluation case's execution. */
  evaluation?: Pick<EvaluationRef, 'runId'>;
}

/** Where a poll trigger of an active workflow stands (GET /api/workflows/:id/polls). */
export interface PollStatus {
  nodeId: string;
  nodeName: string;
  intervalSeconds: number;
  /** The poller is waiting for the first poll, which only sets the baseline. */
  baseline: boolean;
  lastPolledAt?: string;
  nextPollAt?: string;
  /** New items the last poll returned. */
  lastItems?: number;
  lastError?: string;
  lastExecutionId?: string;
  polls: number;
}

/** SSE payload of /api/events. */
export type StreamEvent =
  | { channel: 'registry'; event: RegistryEvent; seq: number; at: string }
  | { channel: 'execution'; workflowId: string; event: ExecutionEvent; seq: number; at: string }
  | { channel: 'lock'; workflowId: string; lock: EditLockView | null; seq: number; at: string };

/** A folder in the workflows list (GET /api/folders). Folders nest through `parentId`. */
export interface Folder {
  id: string;
  name: string;
  /** None = top level. */
  parentId?: string;
  /** The project the folder (and its subfolders and workflows) belongs to; none = the default project. */
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

/** What changed between a version and the one before it. */
export interface VersionDiff {
  nodesAdded: string[];
  nodesRemoved: string[];
  /** Parameters, settings or type changed (by node name). */
  nodesChanged: string[];
  /** Only the position changed. */
  nodesMoved: string[];
  connectionsAdded: number;
  connectionsRemoved: number;
  settingsChanged: boolean;
  stickiesChanged: boolean;
  /** Canvas groups were added, removed, moved, renamed or regrouped (absent: unchanged). */
  groupsChanged?: boolean;
}

/** A saved snapshot of a workflow (GET /api/workflows/:id/versions). */
export interface WorkflowVersionSummary {
  id: string;
  workflowId: string;
  /** 1, 2, 3… per workflow. */
  number: number;
  createdAt: string;
  /** Workflow name at the time. */
  name: string;
  nodeCount: number;
  /** Hash of nodes, connections, settings and sticky notes: an unchanged save adds no version. */
  hash: string;
  /** One line, e.g. "2 nodes added · 1 changed · connections changed". */
  summary: string;
  diff?: VersionDiff;
  /** Set when this version was made by restoring an older one. */
  restoredFrom?: { id: string; number: number };
}

/** GET /api/workflows/:id/versions/:versionId */
export interface WorkflowVersion extends WorkflowVersionSummary {
  workflow: Workflow;
}

/** What POST /api/workflows/import did with each node of the file. */
export interface ImportReport {
  format: 'n8n' | 'flowise' | 'landflow';
  /** Nodes converted to a Landflow type. */
  mapped: Array<{ name: string; from: string; to: string }>;
  /** Nodes with no Landflow equivalent: added as disabled No Operation nodes. */
  placeholders: Array<{ name: string; type: string }>;
  stickyNotes: number;
  /** Canvas groups kept (Landflow JSON; n8n and Flowise have none). */
  groups?: number;
  connections: number;
  warnings: string[];
  /** Nodes the governance policy blocks (Settings → Governance): imported, but the workflow can't be published with them. */
  blocked?: Array<{ name: string; type: string; reason: string }>;
}
