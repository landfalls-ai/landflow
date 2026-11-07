/**
 * The Landflow node interface.
 *
 * Every node — the host's built-ins and every plugin, in any language — implements
 * the same shape: a JSON-serializable `description` plus behaviour methods. This
 * is n8n's INodeType idea with an explicit context argument instead of `this`
 * binding, so nodes are plain classes or objects and trivially testable.
 *
 *   class Slugify implements INodeType {
 *     description = { name: 'slugify', kind: 'action', ... };
 *     async execute(ctx: IExecuteContext) {
 *       return ctx.getInputData().map((item, i) => ({ json: { ...item.json, slug: slug(ctx.getNodeParameter('field', i)) } }));
 *     }
 *   }
 */
import { compositeTypeSchema, HEX_COLOR } from '@landflow/protocol';
import type {
  CompositeTypeDescriptor,
  ConnectionType,
  CredentialTypeDescriptor,
  ExecutionMode,
  JsonObject,
  LogEntry,
  NodeDescriptor,
  NodeArtifact,
  NodeCheck,
  NodeModelCall,
  NodeItem,
  NodeRef,
  PluginInfo,
  PluginManifest,
  PropertyDescriptor,
  PropertyOption,
} from '@landflow/protocol';
import type { IBinaryHelpers } from './binary';
import type { CredentialTypeDefinition, GetCredentials } from './credentials';
import type { NodeMetrics, SpanFunction, TracedFetch } from './instrumentation';
import { resolveIcon, toPath } from './icons';
import type { LogAttributes } from './logger';
import type { IWebhookContext, IWebhookMethods, WebhookResult } from './webhooks';

export interface ILogger {
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  error(message: string, attributes?: LogAttributes): void;
}

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  /** Plain objects are sent as JSON; strings, bytes, `FormData`, `Blob`, `URLSearchParams` and streams as they are. */
  body?: unknown;
  /** Parse the body as JSON (default: by content-type). */
  json?: boolean;
  /** `'buffer'`: return the body as a Buffer (files), not decoded text. */
  encoding?: 'buffer';
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface IBaseContext {
  getNode(): NodeRef;
  getMode(): ExecutionMode;
  /** Same as getMode(). Poll triggers see `'poll'` (scheduled) or `'manual'` (Execute in the editor). */
  readonly mode: ExecutionMode;
  getExecutionId(): string;
  getWorkflowId(): string | undefined;
  /**
   * `<executionId>:<nodeId>:<runIndex>`: the same for every retry of this step (retry on fail, re-run after a host crash).
   * Forward it to APIs that accept an idempotency key (Stripe's `Idempotency-Key`). Undefined from older hosts.
   */
  getIdempotencyKey(): string | undefined;
  /**
   * The node continues on error (n8n's `continueOnFail()`): catch a failing item, push
   * `{ json: { error: message }, pairedItem: { item: i } }` and go on with the next item.
   */
  continueOnFail(): boolean;
  /**
   * Parameter value for `name`, resolved for item `itemIndex`.
   * Lookup: per-item value → node-level value → property default → `fallback`.
   */
  getNodeParameter<T = unknown>(name: string, itemIndex?: number, fallback?: T): T;
  /**
   * Credential data sent by the host, by credential type name:
   * `ctx.getCredentials<TelegramApi>('telegramApi')`. Without a name: the only credential, or undefined.
   */
  readonly getCredentials: GetCredentials;
  /** Node logs: returned to the host (ExecuteResponse.logs) and written to the process log with trace ids. */
  readonly logger: ILogger;
  /** Child span: `await ctx.span('telegram.send', { 'telegram.chat_type': t }, async (span) => …)`. */
  readonly span: SpanFunction;
  /** Custom metrics: `ctx.metrics.counter('telegram.messages.sent').add(1)`. */
  readonly metrics: NodeMetrics;
  /** A fetch that opens an `HTTP {METHOD}` client span and sends `traceparent`. */
  readonly http: TracedFetch;
  /** HTTP and items, plus binary data: read input files and store new ones (docs/protocol.md §11). */
  readonly helpers: IBinaryHelpers & {
    /** Traced like `ctx.http`. */
    httpRequest(options: HttpRequestOptions): Promise<HttpResponse>;
    /** Wrap plain objects as items. */
    returnJsonArray(data: JsonObject | JsonObject[]): NodeItem[];
  };
}

/**
 * How a suspended execution continues (in-process nodes only, see `IExecuteContext.putExecutionToWait`):
 * `time` resumes at `until`; `webhook` on a call to the host's `/api/waiting/<executionId>`; `form` on a
 * submission of `/form/waiting/<executionId>`; `subworkflow` when the execution in `data.executionId`
 * (a waiting sub-workflow) finishes.
 */
export interface WaitRequest {
  resume: 'time' | 'webhook' | 'form' | 'subworkflow';
  /** ISO time: when a `time` wait resumes, or when a webhook/form wait stops waiting and continues without a payload. */
  until?: string;
  /** Webhook waits: the HTTP method the resume call must use (default: any). */
  method?: string;
  /** Kept with the wait for the host's resume routes (a form page, a webhook's response mode). */
  data?: JsonObject;
  /**
   * Run this node again when the execution resumes, with the same input, instead of taking the resume payload as
   * its output. The node finds the payload in its node state under `$resume` (`{ kind, data }`), next to what it
   * saved with `setNodeState` before waiting (an AI Agent continues its loop after a tool approval this way).
   */
  rerun?: boolean;
}

/**
 * A piece of a streamed answer (`IExecuteContext.sendChunk`): n8n's streaming chunks. `begin` and `end` frame one
 * item's answer, `item` carries text as it arrives, `tool` reports an agent's tool call, `error` a failure.
 */
export interface StreamChunk {
  type: 'begin' | 'item' | 'end' | 'error' | 'tool';
  /** `item`: the text delta; `error`: the message. */
  content?: string;
  /** The input item the answer belongs to. */
  itemIndex?: number;
  /** `tool`: the call, and where it is (`started`, `finished`, `failed`, `approval` when it waits for a person). */
  tool?: { id: string; name: string; status: 'started' | 'finished' | 'failed' | 'approval'; input?: JsonObject; output?: string };
  /** Who wrote the chunk (an agent or team node labels its own): shown above the answer in the hosted chat. `face` is an emoji, an image URL or an avatar object. */
  agent?: { id: string; name: string; face?: string | JsonObject };
}

export interface IExecuteContext extends IBaseContext {
  /** Items on main input `inputIndex` (default 0). */
  getInputData(inputIndex?: number): NodeItem[];
  /** Number of main inputs that received data. */
  getInputCount(): number;
  /**
   * In-process only: capabilities supplied by sub-nodes attached to this node's
   * `ai_*` ports (models, tools, memory, embeddings, retrievers…), in port order.
   * `index` keeps only the n-th port of that type (an agent's fallback model is
   * `ai_languageModel` 1). Remote plugins never see sub-nodes.
   */
  getInputConnectionData?<T = unknown>(type: Exclude<ConnectionType, 'main'>, index?: number): Promise<T[]>;
  /** Poll triggers: the state the previous poll returned (undefined on the first poll). */
  getPollState<T extends JsonObject = JsonObject>(): T | undefined;
  /** Poll triggers: state handed to the next poll (returned as ExecuteResponse.pollState; ignored in manual mode). */
  setPollState(state: JsonObject): void;
  /** `mode === 'poll'` and no previous state: establish the baseline and return no items. */
  isFirstPoll(): boolean;
  /** Aborted when the execution is canceled or times out (the call's deadline passed). Pass it to anything that waits. */
  readonly signal?: AbortSignal;
  /** Epoch ms by which the call must finish; `signal` aborts when it passes. Absent when the caller set no deadline. */
  readonly deadline?: number;
  /**
   * In-process only: suspend the execution once `execute` returns. The host saves the run and
   * stops; when it resumes, the resume payload (a webhook request, a form submission) becomes this
   * node's output, or what `execute` returned for a `time` wait and a wait that ran out of time.
   */
  putExecutionToWait?(request: WaitRequest): void;
  /** In-process only: state this node keeps for the length of the execution, also across waits. */
  getNodeState?<T extends JsonObject = JsonObject>(): T | undefined;
  /** In-process only: replace (or, with `undefined`, clear) this node's state. */
  setNodeState?(state: JsonObject | undefined): void;
  /** In-process only: what `$('Node')` reads for this node (each node's latest output, by name). The Code node forwards it to its sandbox. */
  getNodeOutputs?(): Record<string, NodeItem[]>;
  /**
   * In-process only, and only while something listens (a Chat or Webhook trigger in "Streaming" response mode, the
   * editor's chat panel): send part of the answer before the node finishes. Absent otherwise.
   */
  sendChunk?(chunk: StreamChunk): void;
  /**
   * In-process only: report what the node is doing while it runs (a remote agent's steps). The engine turns each call
   * into a `node.progress` event for the run's viewers, at most about twice a second (the last one always goes out), and
   * the host keeps the latest per running node. `data` is any JSON object; it is shown, not stored in the run data.
   * Also given to a node a connected agent calls as a tool. Absent in remote plugins.
   */
  sendProgress?(data: JsonObject): void;
  /**
   * Report something this node made that people will want to open: a pull request, a file, a ticket. In-process the
   * engine turns it into a `node.record` event as it happens; a remote plugin's are returned in `ExecuteResponse.records`.
   * Shown with the node's step in the run's trace. Credential values are masked in the text fields.
   */
  artifact(artifact: NodeArtifact): void;
  /** Report the outcome of a check the node made: tests passed, a reply cites its source, a refund is within policy. Delivered like `artifact`. */
  check(check: NodeCheck): void;
  /**
   * Report a model call this node made itself (a plugin that talks to a model): the host counts its tokens in AI usage, prices it,
   * applies the AI usage caps (see `meterAiUsage` on the descriptor) and shows it as a `model` step under the node in Run Trace.
   * Delivered like `artifact`; credential values are masked in the text fields.
   */
  model(call: NodeModelCall): void;
}

/** A sub-node's context. In-process sub-nodes can pull their own sub-nodes too (a document loader its text splitter). */
export type ISupplyDataContext = IBaseContext & Pick<IExecuteContext, 'getInputConnectionData'>;

export interface ILoadOptionsContext {
  getCurrentParameters(): JsonObject;
  /** Current value of a parameter, else `fallback`. */
  getNodeParameter<T = unknown>(name: string, fallback?: T): T;
  /** Same semantics as in execute; the host sends the node's credentials with LoadOptions. */
  readonly getCredentials: GetCredentials;
  readonly logger: ILogger;
  readonly http: TracedFetch;
  readonly span: SpanFunction;
  readonly helpers: { httpRequest(options: HttpRequestOptions): Promise<HttpResponse> };
}

/** What `execute` may return: outputs (`NodeItem[][]`), a single output, or plain objects. */
export type ExecuteResult = NodeItem[][] | NodeItem[] | JsonObject[];

export interface INodeType {
  readonly description: NodeDescriptor;
  /** Transform input items into output items. Required for `action` and `trigger` nodes. */
  execute?(ctx: IExecuteContext): Promise<ExecuteResult> | ExecuteResult;
  /** Sub-nodes (`kind: 'subnode'`): return the capability object for the parent. In-process only. */
  supplyData?(ctx: ISupplyDataContext): Promise<unknown> | unknown;
  methods?: {
    loadOptions?: Record<string, (ctx: ILoadOptionsContext) => Promise<PropertyOption[]> | PropertyOption[]>;
  };
  /** App webhook triggers (`triggerSource: 'appWebhook'`): check, register and remove the node's webhook at its service (docs/protocol.md §12). */
  webhookMethods?: IWebhookMethods;
  /** App webhook triggers: turn a call the service made to the webhook URL into items for a run (or just an answer). */
  webhook?(ctx: IWebhookContext): Promise<WebhookResult | NodeItem[]> | WebhookResult | NodeItem[];
}

export interface IPlugin {
  readonly info: PluginInfo;
  readonly nodes: readonly INodeType[];
  /** Credential types the nodes can use (definePlugin's `credentialTypes`). */
  readonly credentialTypes?: readonly CredentialTypeDefinition[];
  /** Composite types (definePlugin's `composites`, docs/composites.md). */
  readonly composites?: readonly CompositeTypeDescriptor[];
  /** Directory that relative `file:` icons resolve against (definePlugin's `iconDir`). */
  readonly iconDir?: string;
}

/** Thrown by node code to report a user-facing failure. */
export class NodeOperationError extends Error {
  readonly description?: string;
  readonly itemIndex?: number;

  constructor(message: string, options: { description?: string; itemIndex?: number } = {}) {
    super(message);
    this.name = 'NodeOperationError';
    this.description = options.description;
    this.itemIndex = options.itemIndex;
  }
}

/** Identity helper that gives object-literal nodes full type inference. */
export function defineNode<T extends INodeType>(node: T): T {
  return node;
}

/**
 * The standard `pollInterval` property of a poll trigger (seconds, minimum 10).
 * The host reads it to schedule `mode: "poll"` executions.
 */
export function pollIntervalProperty(defaultSeconds = 60): PropertyDescriptor {
  return {
    name: 'pollInterval',
    displayName: 'Poll Interval (seconds)',
    type: 'number',
    default: Math.max(10, defaultSeconds),
    description: 'How often to check for new events while the workflow is active',
    noDataExpression: true,
    typeOptions: { minValue: 10, numberPrecision: 0 },
  };
}

export const SDK_INFO = { name: 'landflow-sdk-typescript', version: '0.2.0' } as const;

const CREDENTIAL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export interface PluginDefinition {
  info: Omit<PluginInfo, 'language' | 'sdk'> & Partial<PluginInfo>;
  nodes: INodeType[];
  /** Credential types; a type with `test` is served by TestCredentials and marked `testable`. */
  credentialTypes?: CredentialTypeDefinition<any>[];
  /**
   * Composite types: canvas frames with a contract (slots its nodes must fill, named ports, rules) and a starter
   * graph. Announced in the manifest; the host checks every frame of that type against it (docs/composites.md).
   */
  composites?: CompositeTypeDescriptor[];
  /**
   * Base for relative `file:` icons on the plugin and its nodes, as a path or a
   * file URL: `new URL('../icons/', import.meta.url)`.
   */
  iconDir?: string | URL;
}

function validateNode(id: string, node: INodeType, credentialNames: Set<string>) {
  const { description } = node;
  for (const requirement of description.credentials ?? []) {
    // A qualified name (`messaging.slackApi`) is another plugin's credential type; the host resolves it.
    if (!requirement.name.includes('.') && !credentialNames.has(requirement.name)) {
      throw new Error(`Plugin ${id}: node "${description.name}" uses credential type "${requirement.name}", which is not in credentialTypes`);
    }
  }
  if (description.triggerSource === 'poll') {
    if (description.kind !== 'trigger') throw new Error(`Plugin ${id}: node "${description.name}" has triggerSource "poll" but kind "${description.kind}"`);
    if (!node.execute) throw new Error(`Plugin ${id}: poll trigger "${description.name}" needs an execute() method`);
    const interval = description.properties.find((p) => p.name === 'pollInterval');
    if (interval?.type !== 'number') {
      throw new Error(`Plugin ${id}: poll trigger "${description.name}" needs a number property "pollInterval" (add pollIntervalProperty())`);
    }
  }
  if (description.triggerSource === 'appWebhook') {
    if (description.kind !== 'trigger') throw new Error(`Plugin ${id}: node "${description.name}" has triggerSource "appWebhook" but kind "${description.kind}"`);
    if (!node.webhookMethods?.create || !node.webhookMethods.delete) throw new Error(`Plugin ${id}: app webhook trigger "${description.name}" needs webhookMethods.create and webhookMethods.delete`);
    if (!node.webhook) throw new Error(`Plugin ${id}: app webhook trigger "${description.name}" needs a webhook() method`);
  }
}

export function definePlugin(plugin: PluginDefinition): IPlugin {
  const { id, color } = plugin.info;
  if (color !== undefined && !HEX_COLOR.test(color)) throw new Error(`Plugin ${id}: color "${color}" must be a hex colour like #2563eb`);
  const credentialTypes = plugin.credentialTypes ?? [];
  const credentialNames = new Set<string>();
  for (const type of credentialTypes) {
    if (!CREDENTIAL_NAME.test(type.name)) throw new Error(`Plugin ${id}: credential type name "${type.name}" must be an identifier`);
    if (credentialNames.has(type.name)) throw new Error(`Plugin ${id}: duplicate credential type "${type.name}"`);
    credentialNames.add(type.name);
  }
  const names = new Set<string>();
  for (const node of plugin.nodes) {
    if (names.has(node.description.name)) {
      throw new Error(`Plugin ${id}: duplicate node name "${node.description.name}"`);
    }
    names.add(node.description.name);
    validateNode(id, node, credentialNames);
  }
  const composites = plugin.composites ?? [];
  const versions = new Set<string>();
  for (const composite of composites) {
    const parsed = compositeTypeSchema.safeParse(composite);
    if (!parsed.success) throw new Error(`Plugin ${id}: composite "${composite.name}": ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    const key = `${composite.name}@${composite.version}`;
    if (versions.has(key)) throw new Error(`Plugin ${id}: duplicate composite "${composite.name}" version ${composite.version}`);
    versions.add(key);
  }
  const result: IPlugin = {
    info: { language: 'typescript', sdk: { ...SDK_INFO }, ...plugin.info },
    nodes: plugin.nodes,
    ...(credentialTypes.length > 0 && { credentialTypes }),
    ...(composites.length > 0 && { composites }),
    ...(plugin.iconDir !== undefined && { iconDir: toPath(plugin.iconDir) }),
  };
  // Resolve every icon once now so a missing or oversized file fails at startup, not on the first manifest pull.
  const icons: Array<[string, string | undefined]> = [
    ['plugin', result.info.icon],
    ...plugin.nodes.map((n): [string, string | undefined] => [`node "${n.description.name}"`, n.description.icon]),
    ...credentialTypes.map((t): [string, string | undefined] => [`credential type "${t.name}"`, t.icon]),
    ...composites.map((c): [string, string | undefined] => [`composite "${c.name}"`, c.icon]),
  ];
  for (const [label, icon] of icons) {
    try {
      resolveIcon(icon, result.iconDir);
    } catch (error) {
      throw new Error(`Plugin ${id}: ${label} ${(error as Error).message}`);
    }
  }
  return result;
}

/** The wire descriptor of a credential type: no `test` function, `testable: true` when there is one. */
export function toCredentialDescriptor(type: CredentialTypeDefinition, iconDir?: string): CredentialTypeDescriptor {
  const { test, ...descriptor } = type;
  return {
    ...descriptor,
    ...(descriptor.icon?.startsWith('file:') && { icon: resolveIcon(descriptor.icon, iconDir) }),
    ...(test && { testable: true }),
  };
}

/** The wire manifest. `file:` icons are inlined as data: URLs here, so the host never sees a path. */
export function buildManifest(plugin: IPlugin): PluginManifest {
  const withIcon = <T extends { icon?: string }>(value: T): T =>
    value.icon?.startsWith('file:') ? { ...value, icon: resolveIcon(value.icon, plugin.iconDir) } : value;
  const credentialTypes = (plugin.credentialTypes ?? []).map((type) => toCredentialDescriptor(type, plugin.iconDir));
  return {
    protocol: 'landflow.plugin/v1',
    plugin: withIcon(plugin.info),
    nodes: plugin.nodes.map((node) => withIcon(node.description)),
    ...(credentialTypes.length > 0 && { credentialTypes }),
    ...(plugin.composites?.length && { composites: plugin.composites.map(withIcon) }),
  };
}

/** Identity helper for a composite type (definePlugin's `composites`), with full type inference. */
export function defineComposite(composite: CompositeTypeDescriptor): CompositeTypeDescriptor {
  return composite;
}

export function collectingLogger(sink: LogEntry[], prefix?: string): ILogger {
  const push = (level: LogEntry['level']) => (message: string) => {
    sink.push({ level, message });
    if (process.env.LANDFLOW_SDK_DEBUG) console.log(`[${prefix ?? 'node'}] ${level}: ${message}`);
  };
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}
