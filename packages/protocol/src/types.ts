/**
 * Landflow plugin protocol — language-neutral, JSON-serializable types.
 *
 * Field names deliberately mirror n8n's INodeTypeDescription / INodeProperties
 * where the concept is the same, so n8n node authors feel at home. Everything
 * here must survive JSON.stringify: no functions, no classes. Behaviour lives
 * in the SDKs (see @landflow/sdk for the TypeScript INodeType interface).
 */

export const PROTOCOL_VERSION = 'landflow.plugin/v1' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * `main` carries items between nodes. The `ai_*` types connect sub-nodes to a
 * root node (n8n "cluster nodes"): the sub-node *supplies* a capability (a
 * model, a tool, a memory) instead of producing items.
 */
export type ConnectionType = 'main' | 'ai_languageModel' | 'ai_tool' | 'ai_memory';

export const CONNECTION_TYPES: readonly ConnectionType[] = [
  'main',
  'ai_languageModel',
  'ai_tool',
  'ai_memory',
];

export interface PortDescriptor {
  type: ConnectionType;
  /** Label shown on the handle, e.g. "true" / "false" or "Chat Model". */
  displayName?: string;
  /** A root node cannot run until a required sub-node port is connected. */
  required?: boolean;
  /** Upper bound of incoming connections (e.g. exactly one chat model). */
  maxConnections?: number;
}

// ---------------------------------------------------------------------------
// Properties (the parameters form)
// ---------------------------------------------------------------------------

export type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options' // single select from `options`
  | 'multiOptions' // multi select from `options`
  | 'json' // JSON editor
  | 'code' // code editor, language in typeOptions.language
  | 'collection' // optional sub-fields the user adds one by one ("Add option")
  | 'fixedCollection' // named groups of sub-fields, optionally repeatable
  | 'color'
  | 'dateTime'
  | 'notice' // read-only callout, no value
  | 'hidden'; // value carried but never rendered

export type Primitive = string | number | boolean;

export interface PropertyOption {
  name: string;
  value: Primitive;
  description?: string;
  /** Optional action label, n8n-style ("Hash a value"). */
  action?: string;
}

export interface DisplayOptions {
  /** Show only when every listed parameter equals one of the values. */
  show?: Record<string, Primitive[]>;
  /** Hide when any listed parameter equals one of the values. */
  hide?: Record<string, Primitive[]>;
}

export interface PropertyTypeOptions {
  /** string: render a textarea with this many rows. */
  rows?: number;
  /** string: mask the value. */
  password?: boolean;
  /** code/json: editor language. */
  language?: 'javascript' | 'json' | 'python' | 'sql' | 'text' | 'markdown';
  minValue?: number;
  maxValue?: number;
  numberPrecision?: number;
  /** fixedCollection: allow the groups to repeat. */
  multipleValues?: boolean;
  /** options: populate from the plugin's LoadOptions method instead of `options`. */
  loadOptionsMethod?: string;
  /** options: reload when these parameters change. */
  loadOptionsDependsOn?: string[];
}

export interface FixedCollectionGroup {
  name: string;
  displayName: string;
  values: PropertyDescriptor[];
}

export interface PropertyDescriptor {
  /** Key under which the value is stored in node.parameters. */
  name: string;
  displayName: string;
  type: PropertyType;
  default?: unknown;
  description?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  /** Disallow `{{ expressions }}` for this field. */
  noDataExpression?: boolean;
  /** options / multiOptions choices. */
  options?: PropertyOption[];
  /** collection sub-fields. */
  values?: PropertyDescriptor[];
  /** fixedCollection groups. */
  groups?: FixedCollectionGroup[];
  typeOptions?: PropertyTypeOptions;
  displayOptions?: DisplayOptions;
}

// ---------------------------------------------------------------------------
// Node descriptor
// ---------------------------------------------------------------------------

/**
 * - `trigger`: starts a workflow (no main input). The host owns the event source
 *   (manual button, webhook route, schedule, chat panel) and feeds items in.
 * - `action`: transforms items; the common case.
 * - `subnode`: supplies a capability to a root node over an `ai_*` port.
 */
export type NodeKind = 'trigger' | 'action' | 'subnode';

/**
 * How the host should wire up a trigger node. `poll`: the host calls Execute
 * with mode "poll" every `pollInterval` seconds while the workflow is active,
 * passing back the `pollState` the previous poll returned; any items the poll
 * emits start an execution.
 */
export type TriggerSource = 'manual' | 'webhook' | 'schedule' | 'chat' | 'poll';

/** A credential a node can use, by the local name of a credential type its plugin declares. */
export interface NodeCredentialRequirement {
  name: string;
  required?: boolean;
  /** Only ask for it when these parameters match (e.g. one credential per auth method). */
  displayOptions?: DisplayOptions;
}

export interface NodeDescriptor {
  /** Local name, unique inside the plugin: "hash". Fully-qualified type is `${pluginId}.${name}`. */
  name: string;
  displayName: string;
  description: string;
  /** Supported type versions. A workflow node pins one via `typeVersion`. */
  version: number | number[];
  defaultVersion?: number;
  kind: NodeKind;
  triggerSource?: TriggerSource;
  /** Node-creator grouping, e.g. ["Core"], ["AI", "Tools"], ["Data"]. */
  categories?: string[];
  /** "lucide:<icon-name>" | "emoji:<char>" | https or data: URL. */
  icon?: string;
  /** Accent colour (hex). */
  color?: string;
  /** Short line under the node title. `{{param}}` placeholders are substituted. */
  subtitle?: string;
  inputs: PortDescriptor[];
  outputs: PortDescriptor[];
  properties: PropertyDescriptor[];
  /** Any action node flagged here can be attached to an agent's ai_tool port. */
  usableAsTool?: boolean;
  /** Description given to the model when used as a tool (defaults to `description`). */
  toolDescription?: string;
  /**
   * Optional JSON Schema for the tool's arguments. Without it the host derives
   * one from the primitive properties; arguments become the input item's JSON
   * and override same-named parameters.
   */
  toolInputSchema?: JsonObject;
  /** For subnodes: what they supply (matches the parent's port type). */
  supplies?: Exclude<ConnectionType, 'main'>;
  documentationUrl?: string;
  /** Free-form tags for search. */
  keywords?: string[];
  /** Credential types this node can use (declared in the manifest's `credentialTypes`). */
  credentials?: NodeCredentialRequirement[];
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * A kind of secret a plugin's nodes need (an API token, a database DSN, an
 * OAuth client). The host renders a form from `properties`, stores the values
 * encrypted and sends the decrypted values with each Execute / LoadOptions
 * call in `credentials[<name>]`. Fields with `typeOptions.password` are
 * masked in the UI and never returned by the host API.
 */
export interface CredentialTypeDescriptor {
  /** Local name, unique inside the plugin: "telegramApi". Fully-qualified: `${pluginId}.${name}`. */
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  documentationUrl?: string;
  properties: PropertyDescriptor[];
  /** The plugin implements TestCredentials for this type ("Test connection" in the UI). */
  testable?: boolean;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  language: string;
  sdk?: { name: string; version: string };
  /** Brand icon, same forms as NodeDescriptor.icon (typically a colourful SVG data: URL). */
  icon?: string;
  /** Brand colour (hex, e.g. "#2563eb"): tints the plugin's segment in the node creator. */
  color?: string;
  author?: string;
  homepage?: string;
}

export interface PluginManifest {
  protocol: ProtocolVersion;
  plugin: PluginInfo;
  nodes: NodeDescriptor[];
  credentialTypes?: CredentialTypeDescriptor[];
}

/** Served at GET /.well-known/landflow — the cheap discovery probe. */
export interface WellKnownDocument {
  protocol: ProtocolVersion;
  plugin: Pick<PluginInfo, 'id' | 'name' | 'version' | 'language'>;
  endpoints: {
    manifest: string;
    execute: string;
    loadOptions: string;
    health: string;
    testCredentials?: string;
  };
}

// ---------------------------------------------------------------------------
// Items & execution
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface PairedItem {
  item: number;
  input?: number;
}

/** The unit of data that flows between nodes (n8n's INodeExecutionData). */
export interface NodeItem {
  json: JsonObject;
  pairedItem?: PairedItem;
}

/** `poll`: a scheduled poll of a `triggerSource: "poll"` node (see ExecuteRequest.pollState). */
export type ExecutionMode = 'manual' | 'trigger' | 'webhook' | 'tool' | 'chat' | 'poll';

export interface NodeRef {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
}

export interface ExecuteRequest {
  protocol: ProtocolVersion;
  executionId: string;
  workflowId?: string;
  mode: ExecutionMode;
  node: NodeRef;
  /** Parameters with expressions resolved against item 0 of input 0 (or no item). */
  parameters: JsonObject;
  /** Parameters resolved per item of input 0 — what getNodeParameter(name, i) reads. */
  itemParameters: JsonObject[];
  /** inputs[i] = the items that arrived on main input i. */
  inputs: NodeItem[][];
  /** Decrypted credential data keyed by credential type local name: { telegramApi: { accessToken } }. */
  credentials?: Record<string, JsonObject>;
  /** Poll triggers: the state the previous poll returned (absent on the first poll). */
  pollState?: JsonObject;
  /**
   * The node is set to continue on error (n8n's "Continue On Fail"): instead of failing the call, emit
   * `{ json: { error }, pairedItem }` for an item that fails and go on with the next one.
   */
  continueOnFail?: boolean;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
}

export interface NodeErrorPayload {
  message: string;
  description?: string;
  itemIndex?: number;
}

export interface ExecuteResponse {
  /** outputs[i] = the items emitted on main output i. */
  outputs: NodeItem[][];
  logs?: LogEntry[];
  error?: NodeErrorPayload;
  /** Poll triggers: state to pass to the next poll (e.g. the newest id seen). */
  pollState?: JsonObject;
}

export interface LoadOptionsRequest {
  nodeType: string;
  method: string;
  parameters: JsonObject;
  /** Same shape as ExecuteRequest.credentials, for option lists that call an API. */
  credentials?: Record<string, JsonObject>;
}

export interface TestCredentialsRequest {
  /** Local credential type name. */
  credentialType: string;
  data: JsonObject;
}

export interface TestCredentialsResponse {
  ok: boolean;
  message?: string;
}

export interface LoadOptionsResponse {
  options: PropertyOption[];
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptimeMs: number;
  pluginId: string;
  version: string;
}

// ---------------------------------------------------------------------------
// Registry (self-announcement)
// ---------------------------------------------------------------------------

export interface AnnounceRequest {
  protocol: ProtocolVersion;
  /** "http://127.0.0.1:7101" or "grpc://127.0.0.1:7203". */
  endpoint: string;
  pluginId: string;
  version: string;
  ttlSeconds?: number;
}

export interface AnnounceResponse {
  accepted: boolean;
  heartbeatIntervalSeconds: number;
  message?: string;
}

export interface WithdrawRequest {
  endpoint: string;
  pluginId?: string;
}

// ---------------------------------------------------------------------------
// HTTP binding
// ---------------------------------------------------------------------------

export const HTTP_PATHS = {
  wellKnown: '/.well-known/landflow',
  manifest: '/landflow/v1/manifest',
  execute: '/landflow/v1/execute',
  loadOptions: '/landflow/v1/load-options',
  testCredentials: '/landflow/v1/test-credentials',
  health: '/landflow/v1/health',
} as const;

/**
 * Observability (see docs/observability.md): the host sends W3C trace context
 * with every call (HTTP headers / gRPC metadata) so plugin spans join the
 * workflow's trace.
 */
export const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'] as const;

export const DEFAULT_ANNOUNCE_TTL_SECONDS = 30;
export const DEFAULT_HEARTBEAT_SECONDS = 10;
