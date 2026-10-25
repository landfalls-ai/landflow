/** Types shared by the API routes and the React client. No runtime imports. */
import type { DebugCommand, ExecutionEvent, ExecutionResult, ExecutionWait, NodeRun, PauseReason, Transport, Workflow } from '@landflow/engine';
import type { CredentialTypeDescriptor, NodeDescriptor, NodeItem, PluginInfo } from '@landflow/protocol';

export type { DebugCommand, ExecutionEvent, ExecutionResult, ExecutionWait, NodeRun, PauseReason, Transport, Workflow };
export type { StickyNote, WorkflowConnection, WorkflowNode, WorkflowSettings } from '@landflow/engine';
export type { CredentialTypeDescriptor, NodeDescriptor, NodeItem, PropertyDescriptor, PortDescriptor, ConnectionType } from '@landflow/protocol';

export type DiscoverySource = 'builtin' | 'announce' | 'static' | 'scan' | 'manual';
export type PluginStatus = 'online' | 'offline' | 'error';

export interface EndpointSummary {
  endpoint: string;
  transport: Transport;
  source: DiscoverySource;
  status: PluginStatus;
  lastSeen?: string;
  leaseExpiresAt?: string;
  latencyMs?: number;
  lastError?: string;
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
  /** Status `queued`: how it starts once a slot frees. */
  queued?: QueuedStart;
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
  retryOf?: string;
  retryAttempt?: number;
  retriedBy?: string;
  retryAt?: string;
  /** Shown as "resumed after restart". */
  resumedAfterRestart?: boolean;
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
  | { channel: 'execution'; workflowId: string; event: ExecutionEvent; seq: number; at: string };

/** A folder in the workflows list (GET /api/folders). Folders nest through `parentId`. */
export interface Folder {
  id: string;
  name: string;
  /** None = top level. */
  parentId?: string;
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
  format: 'n8n' | 'landflow';
  /** Nodes converted to a Landflow type. */
  mapped: Array<{ name: string; from: string; to: string }>;
  /** Nodes with no Landflow equivalent: added as disabled No Operation nodes. */
  placeholders: Array<{ name: string; type: string }>;
  stickyNotes: number;
  connections: number;
  warnings: string[];
}
