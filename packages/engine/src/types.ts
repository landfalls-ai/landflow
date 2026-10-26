import type {
  ConnectionType,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionMode,
  LogEntry,
  JsonObject,
  NodeDescriptor,
  NodeItem,
  TransportKind,
  WebhookMethodRequest,
  WebhookMethodResponse,
  WebhookRequest,
  WebhookResponse,
} from '@landflow/protocol';
import { TRANSPORT_KINDS } from '@landflow/protocol';
import type { ContextExtras, StreamChunk, WaitRequest } from '@landflow/sdk';
import type { Attributes } from '@opentelemetry/api';
import type { SecretReference, SecretValues } from './secrets';

// ---------------------------------------------------------------------------
// Workflow document
// ---------------------------------------------------------------------------

export type OnErrorBehaviour = 'stop' | 'continue';

export interface WorkflowNode {
  id: string;
  /** Unique within the workflow; what `$('Name')` refers to. */
  name: string;
  /** Fully-qualified node type: "<pluginId>.<nodeName>". */
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  onError?: OnErrorBehaviour;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTriesMs?: number;
  /** Fail an attempt that runs longer than this (its abort signal fires); retries and "continue on error" apply. */
  timeoutSeconds?: number;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  /** Saved credentials this node uses, by credential type local name. Secrets live in the host's credential store. */
  credentials?: Record<string, { id: string; name: string }>;
  /** At most `limit` calls of this node per `intervalSeconds` (main-flow runs and uses as a sub-node); extra calls wait their turn. */
  rateLimit?: NodeRateLimit;
  /** Trigger nodes: collapse events with the same key that arrive within a window into one run. */
  debounce?: TriggerDebounce;
  /** Trigger nodes: collect events and start one run with all of them. */
  batch?: TriggerBatch;
}

export interface NodeRateLimit {
  limit: number;
  intervalSeconds: number;
}

/**
 * Debounce (Inngest's `debounce`, Trigger.dev's trailing mode): each event with the same key restarts a quiet window
 * of `windowSeconds`; when it ends, one run starts with the last event (`last`) or with every event (`all`).
 * `maxWaitSeconds` caps how long a steady stream of events can hold the run back.
 */
export interface TriggerDebounce {
  windowSeconds: number;
  /** Expression evaluated on the event item, e.g. `{{ $json.body.userId }}`. Empty: one key for every event. */
  key?: string;
  mode?: 'last' | 'all';
  maxWaitSeconds?: number;
}

/** Batching (Inngest's `batchEvents`): start one run with up to `size` events, or with what arrived `timeoutSeconds` after the first. */
export interface TriggerBatch {
  size: number;
  timeoutSeconds: number;
}

/**
 * Directed edge. For `main`, items flow source → target. For `ai_*`, the
 * source is a sub-node supplying a capability to the target (root) node.
 */
export interface WorkflowConnection {
  id: string;
  type: ConnectionType;
  source: string;
  sourceIndex: number;
  target: string;
  targetIndex: number;
}

export interface WorkflowSettings {
  /** Stop a run after this many seconds. */
  timeoutSeconds?: number;
  /** Workflow whose Error Trigger runs when an execution of this one fails. */
  errorWorkflowId?: string;
  /** IANA time zone for schedules and `$now` (default: the host's). */
  timezone?: string;
  /** Which workflows may run this one through Execute Workflow: any, none, or `callerIds`. */
  callerPolicy?: 'any' | 'none' | 'list';
  callerIds?: string[];
  /** Keep executions of this kind in the history (default: true). */
  saveSuccessfulExecutions?: boolean;
  saveFailedExecutions?: boolean;
  saveManualExecutions?: boolean;
  /** Minutes of manual work one successful run saves (Insights' "time saved"). */
  timeSavedMinutes?: number;
  /** Most production runs going at once (waiting runs don't count). Manual runs and sub-executions bypass it. */
  concurrencyLimit?: number;
  /** One run at a time, waiting runs included. */
  singleton?: boolean;
  /** A trigger run over the limit (or while the singleton runs): wait in a FIFO queue (default) or be skipped. */
  concurrencyOverflow?: 'queue' | 'skip';
  /** Longest queue (default 100); runs beyond it are skipped. */
  concurrencyQueueSize?: number;
  /** Retry a failed production run automatically: attempts in all, the first run included (2 or more turns it on). */
  retryMaxAttempts?: number;
  /** Seconds before the first automatic retry (default 30); each further retry waits twice as long. */
  retryBaseDelaySeconds?: number;
  /** AI caps (input + output tokens, or estimated US dollars): a run that goes over stops with an error. 0/absent = no cap. */
  aiMaxTokensPerExecution?: number;
  aiMaxCostPerExecution?: number;
  /** The same over all runs of the workflow in a day (the instance time zone). */
  aiMaxTokensPerDay?: number;
  aiMaxCostPerDay?: number;
  /** Transport policy overrides by plugin id for this workflow's runs (the host's selector; docs/transports.md). */
  transports?: Record<string, { mode?: 'auto' | 'pinned'; pinned?: string; allowed?: string[]; objective?: 'balanced' | 'latency' | 'throughput' }>;
}

/** A canvas note. It never runs; the engine ignores it. */
export interface StickyNote {
  id: string;
  /** Markdown. */
  content: string;
  position: [number, number];
  width: number;
  height: number;
  /** Index into the editor's sticky palette. */
  color?: number;
}

/**
 * A canvas group: a labelled, coloured frame drawn behind some nodes. Like a sticky note it lives beside the nodes in
 * its own list (`workflow.groups`), never runs, and the engine ignores it. Membership is explicit (`nodeIds`, a node
 * in at most one group), so moving, collapsing and copying a group don't depend on where nodes happen to sit.
 */
export interface WorkflowGroup {
  id: string;
  /** The frame's label. */
  name: string;
  /** Ids of the nodes inside the frame. */
  nodeIds: string[];
  /** Top-left corner of the frame. */
  position: [number, number];
  /** Size of the frame when expanded. */
  width: number;
  height: number;
  /** Index into the editor's palette (the sticky colours). */
  color?: number;
  /** Drawn as one compact box: its nodes are hidden and their connections end at the box. */
  collapsed?: boolean;
  /** The group this one sits in (nested groups); `nodeIds` lists only its own nodes, not those of the groups inside it. */
  parentId?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  active?: boolean;
  /** Fixed output per node id, used instead of executing it (n8n "pin data"). */
  pinData?: Record<string, NodeItem[]>;
  settings?: WorkflowSettings;
  stickyNotes?: StickyNote[];
  /** Canvas groups (frames around nodes): editor-only, like sticky notes. */
  groups?: WorkflowGroup[];
  tags?: string[];
  /** Folder in the workflows list (see the folders store); none = top level. */
  folderId?: string;
  createdAt?: string;
  updatedAt?: string;
  /** The user (id) who created it and who saved it last, when a signed-in user did (the host's sign-in). */
  createdBy?: string;
  updatedBy?: string;
}

// ---------------------------------------------------------------------------
// Node type resolution (implemented by the host registry)
// ---------------------------------------------------------------------------

/**
 * How a node's plugin is reached: in this process, directly (`http`, `grpc`) or through a broker kind (`kafka`, `nats`,
 * …; `@landflow/protocol`'s TRANSPORT_KINDS). Open: any kind a host and plugin agree on is carried as is into
 * `landflow.transport` on spans and metrics. Compare with the KNOWN_TRANSPORTS constants, never with an exhaustive switch.
 */
export type Transport = 'in-process' | TransportKind;

/** The transports this version knows, `in-process` first (the engine's own core plugin). */
export const KNOWN_TRANSPORTS: readonly Transport[] = ['in-process', ...TRANSPORT_KINDS];

export interface ResolvedNodeType {
  type: string;
  pluginId: string;
  transport: Transport;
  descriptor: NodeDescriptor;
  execute(request: ExecuteRequest, extras?: ContextExtras): Promise<ExecuteResponse>;
  /** In-process sub-nodes only. `extras.getInputConnectionData` supplies the sub-node's own sub-nodes. */
  supplyData?(request: ExecuteRequest, extras?: ContextExtras): Promise<unknown>;
  /** App webhook triggers (`triggerSource: 'appWebhook'`, docs/protocol.md §12): checkExists / create / delete of the node's webhook. */
  webhookMethod?(request: WebhookMethodRequest): Promise<WebhookMethodResponse>;
  /** App webhook triggers: one call to the node's webhook URL. */
  webhook?(request: WebhookRequest): Promise<WebhookResponse>;
}

export interface NodeTypeResolver {
  resolve(type: string): ResolvedNodeType | { error: string };
}

// ---------------------------------------------------------------------------
// Run data & events
// ---------------------------------------------------------------------------

/** `main`, or the port a sub-node was used through (`landflow.node.source` maps them to `ai_*`). */
export type RunSource = 'main' | 'tool' | 'model' | 'memory' | 'embedding' | 'document' | 'textSplitter' | 'retriever' | 'reranker';
export type RunStatus = 'success' | 'error';

export interface NodeRun {
  startedAt: string;
  durationMs: number;
  status: RunStatus;
  source: RunSource;
  inputs: NodeItem[][];
  outputs: NodeItem[][];
  error?: { message: string; description?: string };
  logs?: LogEntry[];
  /** For sub-node runs: the root node that used the capability. */
  parentNodeId?: string;
  /** Copied from an earlier execution instead of being run again (partial re-runs). */
  reused?: { executionId: string };
  /** The run's `node.execute` span (same trace as ExecutionResult.traceId), when it was recorded. */
  spanId?: string;
}

/** `waiting`: a node suspended the run (see ExecutionResult.wait); it continues with `ExecuteWorkflowOptions.resume`. */
export type ExecutionStatus = 'running' | 'waiting' | 'success' | 'error' | 'canceled';

export type DebugCommand = 'continue' | 'step' | 'stop';
export type PauseReason = 'breakpoint' | 'step';

export interface PauseInfo {
  nodeId: string;
  nodeName: string;
  reason: PauseReason;
  /** The input the node is about to receive. */
  inputs: NodeItem[][];
}

/**
 * Interactive debugging. The run pauses before a main-flow node when it has
 * a breakpoint, or before every node while stepping, and waits for a command.
 */
export interface DebugController {
  /** Read before every node, so breakpoints can change while the run is going. */
  breakpoints(): ReadonlySet<string>;
  /** Start in step mode: pause before the first node. */
  stepping?: boolean;
  pause(info: PauseInfo): Promise<DebugCommand>;
}

/** Re-run part of an earlier execution, reusing its recorded data. */
export interface PartialRun {
  executionId: string;
  runData: Record<string, NodeRun[]>;
  executionOrder?: string[];
  /** The node to start from. Its recorded input (or its parents' recorded output) is replayed. */
  startNodeId: string;
  /** `from` continues downstream; `only` runs just this node. */
  scope: 'from' | 'only';
}

export type ExecutionEvent =
  | {
      type: 'execution.started';
      executionId: string;
      workflowId: string;
      mode: ExecutionMode;
      traceId?: string;
      /** The run continues after a wait (same execution id). */
      resumed?: boolean;
      at: string;
    }
  | {
      type: 'node.started';
      executionId: string;
      nodeId: string;
      nodeName: string;
      source: RunSource;
      parentNodeId?: string;
      at: string;
    }
  | {
      type: 'node.finished';
      executionId: string;
      nodeId: string;
      nodeName: string;
      source: RunSource;
      parentNodeId?: string;
      status: RunStatus;
      durationMs: number;
      itemCounts: number[];
      run: NodeRun;
      at: string;
    }
  | { type: 'node.log'; executionId: string; nodeId: string; level: LogEntry['level']; message: string; at: string }
  /** Part of a streamed answer (ctx.sendChunk), only with `ExecuteWorkflowOptions.streaming`. */
  | { type: 'node.chunk'; executionId: string; nodeId: string; nodeName: string; chunk: StreamChunk; at: string }
  | ({ type: 'execution.paused'; executionId: string; at: string } & PauseInfo)
  | { type: 'execution.resumed'; executionId: string; command: DebugCommand; at: string }
  | {
      type: 'execution.finished';
      executionId: string;
      status: Exclude<ExecutionStatus, 'running'>;
      durationMs: number;
      error?: { message: string; nodeId?: string; nodeName?: string };
      /** Status `waiting`: what the run waits for. */
      wait?: ExecutionWait;
      at: string;
    };

export interface ExecutionResult {
  executionId: string;
  workflowId: string;
  mode: ExecutionMode;
  status: Exclude<ExecutionStatus, 'running'>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runData: Record<string, NodeRun[]>;
  /** Order in which nodes finished (main flow and sub-nodes). */
  executionOrder: string[];
  error?: { message: string; nodeId?: string; nodeName?: string };
  /** Output of the last main-flow node that ran. */
  lastNodeId?: string;
  /** OpenTelemetry trace of the run (its `workflow.execute` span), when it was recorded. */
  traceId?: string;
  /** Status `waiting`: what the run waits for. */
  wait?: ExecutionWait;
  /** Status `waiting`: everything needed to continue (pass it back as `ExecuteWorkflowOptions.resume.state`). */
  resumeState?: ResumeState;
}

// ---------------------------------------------------------------------------
// Waiting and resuming
// ---------------------------------------------------------------------------

/** What a waiting execution waits for: the node that asked, and its WaitRequest. */
export interface ExecutionWait extends WaitRequest {
  nodeId: string;
  nodeName: string;
  /** When the node asked to wait. */
  since: string;
}

/** A node ready to run: its main inputs. */
export interface ResumeStackEntry {
  nodeId: string;
  inputs: NodeItem[][];
}

/**
 * Everything a waiting execution needs to continue, as plain JSON: the scheduler's stack and
 * parked multi-input nodes, what `$('Node')` reads, the run data so far, per-node state and the
 * waiting node with its input.
 */
export interface ResumeState {
  version: 1;
  /** When the execution first started. */
  startedAt: string;
  /** Time spent running so far, without the waits (counts against `settings.timeoutSeconds`). */
  activeMs: number;
  /** Nodes still to run, last one first (LIFO, as the scheduler pops them). */
  stack: ResumeStackEntry[];
  /** Multi-input nodes that got data on some inputs: one slot per input, `null` = nothing yet. */
  parked: Array<{ nodeId: string; slots: Array<NodeItem[] | null> }>;
  /** Latest main outputs per node name. */
  nodeOutputs: Record<string, NodeItem[][]>;
  runData: Record<string, NodeRun[]>;
  executionOrder: string[];
  /** Per-run node state (ctx.getNodeState), by node id. */
  nodeState: Record<string, JsonObject>;
  lastNodeId?: string;
  /** The waiting node: its input, what `execute` returned when it asked to wait, and its logs. `rerun`: it runs again on resume (WaitRequest.rerun). */
  waiting: { nodeId: string; inputs: NodeItem[][]; outputs: NodeItem[][]; startedAt: string; logs?: LogEntry[]; rerun?: boolean };
  /** Destination / `only` runs: the nodes allowed to run, and the node after which nothing is scheduled. */
  allowed?: string[];
  destination?: string;
  /** Partial runs: the nodes that run again, and the reused outputs of the others. */
  rerun?: string[];
  reusedOutputs?: Record<string, NodeItem[][]>;
}

/**
 * How a wait ended. `timeout`: a webhook or form wait reached its time limit; `subworkflow`: the awaited sub-execution
 * finished; `approval`: a person decided on the tool calls an AI Agent waits for. `restart`: not a wait: the run continues from a checkpoint (after a crash, or a retry of a failed run).
 */
export type ResumeKind = 'time' | 'webhook' | 'form' | 'timeout' | 'subworkflow' | 'restart' | 'approval';

/** A ResumeState without a waiting node: the run's state between two nodes. */
export type CheckpointState = Omit<ResumeState, 'waiting'> & { waiting?: undefined };

/**
 * The run's state between two main-flow nodes (ExecuteWorkflowOptions.onCheckpoint): continue from it with
 * `resume: { state, kind: 'restart' }`, which runs what is still on the stack. A node that was running when the
 * process died runs again, with the same per-step idempotency key.
 */
export interface RunCheckpoint {
  /** `<nodeId>#<runIndex>` of the main-flow node that just finished, or `start` before the first node. */
  stepId: string;
  nodeId?: string;
  /** How many entries of `executionOrder` the checkpoint covers. */
  steps: number;
  /**
   * The state without a waiting node. It shares the run's live objects: serialize it during the call. Resuming
   * from it needs `runData` and `executionOrder` as they were (the first `steps` entries) and `nodeOutputs`
   * (rebuilt from the run data when left empty).
   */
  state: CheckpointState;
}

export interface ResumeOptions {
  /** A waiting run's state, or a checkpoint (kind `restart`). */
  state: ResumeState | CheckpointState;
  /** The waiting node's output; default: what it returned when it asked to wait. */
  outputs?: NodeItem[][];
  kind: ResumeKind;
  /** The wait failed (an awaited sub-execution failed or was canceled): the waiting node fails with this message. */
  error?: string;
}

export interface ExecuteWorkflowOptions {
  workflow: Workflow;
  resolver: NodeTypeResolver;
  executionId: string;
  mode: ExecutionMode;
  /** Trigger node to start from (default: first trigger, else every root node). */
  startNodeId?: string;
  /** Items handed to the start node (default: one empty item). */
  triggerItems?: NodeItem[];
  /** The start node's output, already produced (a poll trigger's new items): the node is not executed. */
  triggerOutput?: { nodeId: string; items: NodeItem[] };
  /** Stop after this node: only it and its ancestors run. */
  destinationNodeId?: string;
  partial?: PartialRun;
  debug?: DebugController;
  onEvent?: (event: ExecutionEvent) => void;
  signal?: AbortSignal;
  /** Decrypted credential data for a node, keyed by credential type local name (sent as ExecuteRequest.credentials). */
  resolveCredentials?: (node: WorkflowNode, descriptor: NodeDescriptor) => Record<string, JsonObject> | undefined;
  /** Extra attributes for the `workflow.execute` span (e.g. `landflow.execution.rerun_of`). */
  spanAttributes?: Attributes;
  /** Instance variables, read-only in expressions as `$vars.NAME`. */
  variables?: Record<string, string>;
  /**
   * `$secrets` in node parameters: reads the secrets a node's parameters reference (literally), right before each call
   * of the node. Without it, a parameter that reads `$secrets` fails. A rejection fails the node with its message.
   */
  loadSecrets?: (references: SecretReference[], node: WorkflowNode) => Promise<SecretValues>;
  /** Each resolved parameter value that read `$secrets` (per item), so the host can redact it like the secrets themselves. */
  onSecretParameter?: (value: unknown) => void;
  /** Continue a waiting execution (same `executionId`); start options are ignored. */
  resume?: ResumeOptions;
  /** `$execution.resumeUrl` / `$execution.resumeFormUrl`: where a webhook or form wait of this run is resumed. */
  resumeUrls?: { webhook: string; form: string };
  /** Called before the first node and after every main-flow node that finished: the state to continue from after a crash. */
  onCheckpoint?: (checkpoint: RunCheckpoint) => void;
  /** Someone listens for streamed answers: in-process nodes get `ctx.sendChunk`, and their chunks become `node.chunk` events. */
  streaming?: boolean;
  /** Enforces `node.rateLimit` (default: one limiter shared by every run in the process). */
  rateLimiter?: RateLimiterLike;
}

/** What the executor needs from a rate limiter: wait for a turn under `key`; resolves with the milliseconds waited. */
export interface RateLimiterLike {
  acquire(key: string, limit: NodeRateLimit, signal?: AbortSignal): Promise<number>;
}
