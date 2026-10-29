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
 * model, a tool, a memory) instead of producing items. The retrieval types
 * (RAG) follow n8n: `ai_embedding` (an embeddings model), `ai_document` (a
 * document loader), `ai_textSplitter`, `ai_retriever` and `ai_reranker`.
 * Sub-nodes can have sub-node inputs of their own (a loader takes a splitter).
 */
export type ConnectionType =
  | 'main'
  | 'ai_languageModel'
  | 'ai_tool'
  | 'ai_memory'
  | 'ai_embedding'
  | 'ai_document'
  | 'ai_textSplitter'
  | 'ai_retriever'
  | 'ai_reranker';

export const CONNECTION_TYPES: readonly ConnectionType[] = [
  'main',
  'ai_languageModel',
  'ai_tool',
  'ai_memory',
  'ai_embedding',
  'ai_document',
  'ai_textSplitter',
  'ai_retriever',
  'ai_reranker',
];

export interface PortDescriptor {
  type: ConnectionType;
  /** Label shown on the handle, e.g. "true" / "false" or "Chat Model". */
  displayName?: string;
  /** A root node cannot run until a required sub-node port is connected. */
  required?: boolean;
  /** Upper bound of incoming connections (e.g. exactly one chat model). */
  maxConnections?: number;
  /**
   * Show the port only for some parameter values, evaluated like a property's
   * (n8n's parameter-dependent ports: a vector store's Operation Mode, "Enable
   * Fallback Model"). Hidden ports keep their index, so handle ids stay stable.
   */
  displayOptions?: DisplayOptions;
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
  /**
   * On an option of the `operation` property only (docs/protocol.md §15.1): `mcp: false` keeps this operation out of
   * the plugin's MCP tools; `idempotent` marks the operation safe to repeat (it overrides the node's `idempotent`);
   * `outputSchema` and `toolAnnotations` override the node's for this operation's tool. Ignored on other options.
   */
  mcp?: false;
  idempotent?: boolean;
  outputSchema?: JsonObject;
  toolAnnotations?: McpToolAnnotations;
}

/**
 * MCP tool annotations (the MCP spec's `ToolAnnotations`): hints to the agent, never a security boundary. The host
 * derives them from the operation name (`get*`/`list*`/`search*` → `readOnlyHint`, `delete*`/`remove*` →
 * `destructiveHint`), from `idempotent` and always `openWorldHint: true`; a node or operation can override any of them.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
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
 * emits start an execution. `appWebhook`: the node registers its own webhook
 * with an external service when the workflow is published and removes it when
 * it is unpublished (WebhookMethod), and turns the service's calls into items
 * (ReceiveWebhook); see docs/protocol.md §12.
 */
export type TriggerSource = 'manual' | 'webhook' | 'schedule' | 'chat' | 'poll' | 'appWebhook';

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
  /**
   * What the node does, as dotted tags a composite slot can ask for (`ioc.extract`, `ioc.enrich`, `llm.chain`): a
   * stable contract, unlike `categories`, which only group the node creator. See CompositeTypeDescriptor.
   */
  capabilities?: string[];
  /** Credential types this node can use (declared in the manifest's `credentialTypes`). */
  credentials?: NodeCredentialRequirement[];
  /**
   * Running the node twice with the same input has the same effect as once (a lookup, an upsert keyed by the input).
   * Over a broker such a node is delivered at least once instead of at most once (docs/protocol.md §14.6), and its MCP
   * tools get `idempotentHint`. An `operation` option's `idempotent` overrides it per operation.
   */
  idempotent?: boolean;
  /** `false` keeps the whole node out of the plugin's MCP tools (docs/protocol.md §15.1); per operation see PropertyOption.mcp. */
  mcp?: false;
  /**
   * JSON Schema (2020-12) of one output item's `json`. MCP tools return `structuredContent: { items }` and declare
   * `outputSchema` from it; an `operation` option's `outputSchema` overrides it per operation.
   */
  outputSchema?: JsonObject;
  /** Overrides for the MCP tool annotations the host derives (docs/protocol.md §15.1). */
  toolAnnotations?: McpToolAnnotations;
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
  /**
   * Credential types this one builds on, n8n's `extends: ['oAuth2Api']`: the host shows the parent's properties
   * followed by this type's, a property of the same name replacing the parent's (a `hidden` property with a
   * `default` fixes a value, such as the provider's authorization URL). A local name means a type of this plugin,
   * else of the core plugin; `<pluginId>.<name>` names one exactly. Extending `oAuth2Api` gives the credential a
   * Connect button, and the host sends a fresh `accessToken` with it (docs/protocol.md §7).
   */
  extends?: string[];
}

// ---------------------------------------------------------------------------
// Composites
// ---------------------------------------------------------------------------

/**
 * What a composite slot accepts. Every field given must match; a list matches any of its values. Matching is on the
 * node's descriptor, so it works for any plugin's nodes.
 */
export interface NodeMatcher {
  /** Fully-qualified node types: `triage.triageDecision`. */
  type?: string | string[];
  kind?: NodeKind | NodeKind[];
  /** Sub-nodes: what they supply (`ai_languageModel` for a chat model). */
  supplies?: Exclude<ConnectionType, 'main'> | Array<Exclude<ConnectionType, 'main'>>;
  /** One of the node's `categories` (case-insensitive). */
  category?: string | string[];
  /** One of the node's `capabilities`. */
  capability?: string | string[];
  /** The node has an input port of this type: a reasoner is a node with an `ai_languageModel` input. */
  input?: ConnectionType;
  /** A composite of this type, nested in the frame, fills the slot instead of a node. */
  composite?: string | string[];
  /** Matches when any of these does (combined with the fields above). */
  anyOf?: NodeMatcher[];
}

/** A step a composite must (or may) contain. */
export interface CompositeSlot {
  /** Identifier, unique in the type. */
  name: string;
  displayName: string;
  description?: string;
  accepts: NodeMatcher;
  /** Fewest nodes that fill it; 0 makes it optional. Default 1. */
  min?: number;
  /** Most nodes; absent means no limit. */
  max?: number;
  /** Its nodes can be configured but not deleted or retyped. */
  locked?: boolean;
}

/**
 * A named edge of the frame. An output carries one output of a slot's node (`slot` + `index`); an input names the slot
 * whose node takes what comes in from outside (absent: whatever the frame's first nodes are).
 */
export interface CompositePort {
  name: string;
  displayName?: string;
  slot?: string;
  /** Output index on the slot's node. Default 0. */
  index?: number;
}

/** A structural rule over the frame, checked with the slots. */
export type CompositeRule =
  /** Every node of slot `to` gets a `via` connection (default `main`) from a node of slot `from`. */
  | { rule: 'feeds'; from: string; to: string; via?: ConnectionType }
  /** The nodes of these slots have this On error setting (`continue` keeps a frame fail-open). */
  | { rule: 'onError'; slots: string[]; value: 'stop' | 'continue' }
  /** Every node the frame's input reaches leads, through main connections inside the frame, to slot `to`. */
  | { rule: 'reaches'; to: string }
  /** Main connections leave the frame only through its output ports, and enter only at its input slots. */
  | { rule: 'sealed' };

/** A node of a composite's starter graph. `slot` binds it; ids are local to the starter. */
export interface CompositeStarterNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  /** Relative to the frame's top-left corner. */
  position: [number, number];
  parameters?: JsonObject;
  onError?: 'stop' | 'continue';
  retryOnFail?: boolean;
  maxTries?: number;
  slot?: string;
}

/**
 * A composite type: a contract for a canvas frame (its slots, ports and rules) plus the starter graph dropped in when
 * one is inserted. The workflow owns the frame's nodes; the contract is only checked against them, so updating a type
 * never rewrites anyone's nodes.
 */
export interface CompositeTypeDescriptor {
  /** Local name, unique in the plugin together with `version`: `aiTriage` → `${pluginId}.aiTriage`. */
  name: string;
  displayName: string;
  description: string;
  /** A plugin may declare several versions of a type; an instance pins the one it was built for. */
  version: number;
  icon?: string;
  /** Accent colour (hex). */
  color?: string;
  inputs?: CompositePort[];
  outputs?: CompositePort[];
  slots: CompositeSlot[];
  rules?: CompositeRule[];
  /** Nodes that fill no slot are allowed unless the type is closed. */
  closed?: boolean;
  /**
   * `fallback`: when a node inside fails (after its retries and without On error → Continue), the run doesn't stop: the
   * rest of the frame is skipped and the items that entered it, with the error added, go to the frame's fallback
   * targets (picked in its contract panel, `GroupComposite.fallback`).
   */
  onError?: 'stop' | 'fallback';
  /** Seconds the whole frame may take; past it, a node inside fails (and `fallback` applies). */
  timeoutSeconds?: number;
  /** Settings of the whole frame, read inside it as `$composite.params.<name>`. */
  properties?: PropertyDescriptor[];
  starter?: { nodes: CompositeStarterNode[]; connections: Array<{ source: string; sourceIndex?: number; target: string; targetIndex?: number; type?: ConnectionType }> };
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
  /** Composite types: canvas frames with a contract (docs/composites.md). Fully-qualified: `${pluginId}.${name}`. */
  composites?: CompositeTypeDescriptor[];
  /**
   * The faces this plugin process was built with (`http`, `grpc`, `mcp`, broker kinds; see TRANSPORT_KINDS). A hint
   * for the Plugins page and the selector: an endpoint is used only when it is live, whatever this says. Absent from
   * plugins built on older SDKs (gRPC: `GetManifestResponse.transports`).
   */
  transports?: string[];
  /**
   * How many calls one instance of the plugin takes at once (docs/protocol.md §14.6). The selector fills a direct
   * transport up to this and spills over; brokered consumers use it as their prefetch. Absent: the host assumes 16.
   */
  maxConcurrency?: number;
}

/** What the host assumes for `PluginManifest.maxConcurrency` when a plugin does not say. */
export const DEFAULT_MAX_CONCURRENCY = 16;

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
    /** Present when a node has `triggerSource: "appWebhook"`. */
    webhookMethod?: string;
    webhook?: string;
    /** The plugin's own MCP endpoint (Streamable HTTP, docs/protocol.md §15.2), when the MCP face is on. */
    mcp?: string;
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

/**
 * A file attached to an item (n8n's IBinaryData). The bytes live in the host's binary store, not in the item: a ref
 * the host sends always has an `id`, and `GET {binaryAccess.url}/{id}` returns the bytes. A node may instead return
 * a small file inline as base64 `data` (no `id`); the host stores it and swaps in a stored ref before the next node.
 */
export interface BinaryRef {
  /** Store id (`<scope>.<random>`). Absent only on an inline ref a node returns. */
  id?: string;
  mimeType: string;
  fileName?: string;
  /** Without the dot: "pdf". */
  fileExtension?: string;
  /** Size in bytes. */
  fileSize: number;
  /** Coarse kind for previews, derived from `mimeType`. */
  fileType?: BinaryFileType;
  /** Inline bytes, base64 (only on refs a node returns; the SDKs inline files up to MAX_INLINE_BINARY_BYTES). */
  data?: string;
}

export type BinaryFileType = 'image' | 'text' | 'json' | 'html' | 'pdf' | 'audio' | 'video' | 'other';

/**
 * Where a plugin reads and writes the bytes of binary data during one Execute call (docs/protocol.md §11):
 * `GET {url}/{id}` and `POST {url}`, each with `Authorization: Bearer {token}`.
 */
export interface BinaryAccess {
  /** The host's binary API, e.g. "http://127.0.0.1:3000/api/binary". */
  url: string;
  /** Scoped to this execution (it writes there, and reads that plus the files of its input items); expires. */
  token: string;
}

/** The unit of data that flows between nodes (n8n's INodeExecutionData). */
export interface NodeItem {
  json: JsonObject;
  /** Files by property name (n8n's `item.binary`); `data` is the usual name of a single file. */
  binary?: Record<string, BinaryRef>;
  pairedItem?: PairedItem;
}

/**
 * `poll`: a scheduled poll of a `triggerSource: "poll"` node (see ExecuteRequest.pollState).
 * `mcp`: started by an MCP client (an MCP Server Trigger's tool call, or the host's MCP server).
 */
export type ExecutionMode = 'manual' | 'trigger' | 'webhook' | 'tool' | 'chat' | 'poll' | 'mcp';

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
  /**
   * `<executionId>:<nodeId>:<runIndex>` (runIndex = 0-based run of this node in the execution): the same for every retry of
   * this step (retry on fail, re-run after a host crash), new for a new execution. Forward it to APIs that accept an
   * idempotency key (Stripe's `Idempotency-Key`) so a repeated step does not repeat side effects. Absent from older hosts.
   */
  idempotencyKey?: string;
  /** Read and write the bytes of `item.binary` files (absent when the host has no binary store, e.g. older hosts). */
  binaryAccess?: BinaryAccess;
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
// App webhook triggers (triggerSource "appWebhook", docs/protocol.md §12)
// ---------------------------------------------------------------------------

/**
 * n8n's `webhookMethods`: `checkExists` (is the webhook in `staticData` still registered at the service?), `create`
 * (register `webhookUrl`, store its id or secret in the static data) and `delete` (remove it). The host calls `create`
 * when the workflow is published (after a `checkExists` that answered false) and `delete` when it is unpublished, the
 * node changes or the workflow is deleted.
 */
export type WebhookMethodName = 'checkExists' | 'create' | 'delete';

export interface WebhookMethodRequest {
  protocol: ProtocolVersion;
  method: WebhookMethodName;
  workflowId: string;
  node: NodeRef;
  /** The node's parameters, expressions resolved without items. */
  parameters: JsonObject;
  credentials?: Record<string, JsonObject>;
  /** Where the service must send its calls: `{publicUrl}/api/webhook/app/<workflowId>/<nodeId>`. */
  webhookUrl: string;
  /** What the node stored for this workflow and node so far (`{}` at first). */
  staticData: JsonObject;
}

export interface WebhookMethodResponse {
  /** checkExists: the webhook is registered. */
  exists?: boolean;
  /** The node's static data after the call (the webhook id, a signing secret); absent = unchanged. */
  staticData?: JsonObject;
  logs?: LogEntry[];
  error?: NodeErrorPayload;
}

/** A call the external service made to the node's webhook URL, as received. */
export interface IncomingWebhookRequest {
  method: string;
  /** The URL path after the host's origin. */
  path: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  query: Record<string, string>;
  /** The raw body, base64 (gRPC: bytes), exactly as sent: signatures are computed over these bytes. */
  body: string;
}

export interface WebhookRequest {
  protocol: ProtocolVersion;
  workflowId: string;
  node: NodeRef;
  parameters: JsonObject;
  credentials?: Record<string, JsonObject>;
  webhookUrl: string;
  staticData: JsonObject;
  request: IncomingWebhookRequest;
}

/** What the service gets back. Default: 200 `{ status, executionId }`. */
export interface WebhookReply {
  status?: number;
  headers?: Record<string, string>;
  /** Text body (set `content-type` in `headers` for JSON). */
  body?: string;
}

export interface WebhookResponse {
  /** Start a run with these items as the trigger's output; none (or empty) starts no run (a ping, a rejected signature). */
  items?: NodeItem[];
  response?: WebhookReply;
  /** The node's static data after the call; absent = unchanged. */
  staticData?: JsonObject;
  /** A key that identifies the event (GitHub's `X-GitHub-Delivery`): a redelivery within the retention window starts no second run. */
  idempotencyKey?: string;
  logs?: LogEntry[];
  error?: NodeErrorPayload;
}

// ---------------------------------------------------------------------------
// Registry (self-announcement)
// ---------------------------------------------------------------------------

export interface AnnounceRequest {
  protocol: ProtocolVersion;
  /**
   * "http://127.0.0.1:7101" or "grpc://127.0.0.1:7203". Brokered endpoints (`kafka://kafka-main/twilio`, §14) are
   * announced over the broker's registry channel, not here, but a host accepts them in this field too.
   */
  endpoint: string;
  pluginId: string;
  version: string;
  ttlSeconds?: number;
  /**
   * A random id the plugin picks once per process and sends with every announce. When it changes for an online
   * endpoint (the plugin restarted, maybe with new nodes but the same version), the host pulls the manifest again.
   * Opaque, 1–128 characters; the SDKs send 32 hex characters. Older plugins leave it out.
   */
  instanceId?: string;
  /** The faces this plugin process was built with (`["http", "grpc", "kafka"]`), as in the manifest's `transports` hint (§14.1). */
  transports?: string[];
  /** How many calls one instance takes at once, as in the manifest's `maxConcurrency` hint (§14.1). */
  maxConcurrency?: number;
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
  webhookMethod: '/landflow/v1/webhook-method',
  webhook: '/landflow/v1/webhook',
} as const;

/**
 * Observability (see docs/observability.md): the host sends W3C trace context
 * with every call (HTTP headers / gRPC metadata) so plugin spans join the
 * workflow's trace.
 */
export const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'] as const;

/** The SDKs return files up to this size inline (`BinaryRef.data`) instead of uploading them. */
export const MAX_INLINE_BINARY_BYTES = 64 * 1024;

export const DEFAULT_ANNOUNCE_TTL_SECONDS = 30;
export const DEFAULT_HEARTBEAT_SECONDS = 10;
