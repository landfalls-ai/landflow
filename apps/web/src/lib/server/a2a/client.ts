/**
 * A2A (Agent2Agent) client, protocol 1.0 over JSON-RPC (docs/a2a.md): read an agent's card, send it a message, follow the
 * task to its end, and answer a pause. Used by the A2A Agent node (nodes/a2a.ts) and agents' A2A capabilities
 * (agents/tools.ts). Earlier protocol versions (0.3 and before) are refused: their method names and part shapes differ.
 *
 * kagent's human-in-the-loop extension (https://kagent.dev/extensions/hitl/v1) is understood: a task that waits at
 * INPUT_REQUIRED carries a `tool_approval_request` or an `ask_user_request` in its status message's metadata, and the
 * answer is a `tool_approval_response` or `ask_user_response` sent on the same task.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { RemoteSaid } from '../../shared/agents';
import { httpUrlBlocked } from '../governance/policy';
import { singleton } from '../singleton';

export const A2A_PROTOCOL_VERSION = '1.0';
export const KAGENT_HITL_EXTENSION = 'https://kagent.dev/extensions/hitl/v1';
/** kagent's per-task token usage, in the task's metadata. */
export const KAGENT_USAGE_EXTENSION = 'https://kagent.dev/extensions/usage/v1';
const CARD_PATH = '/.well-known/agent-card.json';
export const DEFAULT_TIMEOUT_MS = 300_000;
const CARD_TTL_MS = 60_000;

export type A2aAuthentication = 'none' | 'bearerAuth' | 'headerAuth';

export interface A2aCredentials {
  httpBearerAuth?: Record<string, unknown>;
  httpHeaderAuth?: Record<string, unknown>;
}

export interface A2aEndpoint {
  /** The agent's JSON-RPC endpoint. Calls go here, not to the URLs in the card (those are often cluster-internal). */
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion?: string;
  tenant?: string;
}

export interface AgentCard {
  name: string;
  description?: string;
  version?: string;
  skills?: AgentSkill[];
  capabilities?: { streaming?: boolean; pushNotifications?: boolean; extensions?: Array<{ uri: string; description?: string; required?: boolean }> };
  supportedInterfaces?: AgentInterface[];
  /** A2A 0.3 cards: the protocol version and URL at the top level. */
  protocolVersion?: string;
  url?: string;
}

export interface Part {
  text?: string;
  data?: unknown;
  url?: string;
  raw?: string;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface A2aMessage {
  messageId: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

export interface A2aTask {
  id: string;
  contextId: string;
  status: { state: TaskState; message?: A2aMessage; timestamp?: string };
  artifacts?: Artifact[];
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
}

/** What SendMessage answers: a task, or (for agents that reply without one) a plain message. */
export type A2aResult = { kind: 'task'; task: A2aTask } | { kind: 'message'; message: A2aMessage };

/** One tool call kagent waits to have approved: `id` is the approval's, `callId` the tool call's (a step of remoteStepsOf). */
export interface ToolApprovalCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  callId?: string;
}

export type HitlRequest =
  | { type: 'tool_approval_request'; hint?: string; tools: ToolApprovalCall[] }
  | { type: 'ask_user_request'; id: string; questions: unknown[] };

export class A2aError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** The auth header of the node's credential: `Authorization: Bearer …` or a custom header. */
function authHeaders(authentication: unknown, credentials: A2aCredentials): Record<string, string> {
  if (authentication === 'bearerAuth') {
    const token = String(credentials.httpBearerAuth?.token ?? '').trim();
    if (!token) throw new A2aError('Choose a Bearer Auth credential with a token');
    return { Authorization: `Bearer ${token}` };
  }
  if (authentication === 'headerAuth') {
    const name = String(credentials.httpHeaderAuth?.name ?? '').trim();
    if (!name) throw new A2aError('Choose a Header Auth credential with a header name');
    return { [name]: String(credentials.httpHeaderAuth?.value ?? '') };
  }
  return {};
}

/** The endpoint an A2A node's parameters describe: `agentUrl` (the JSON-RPC endpoint or the card URL), auth, timeout. */
export function endpointFrom(parameters: { agentUrl?: unknown; authentication?: unknown; options?: unknown }, credentials: A2aCredentials): A2aEndpoint {
  const raw = String(parameters.agentUrl ?? '').trim();
  if (!raw) throw new A2aError('Enter the agent’s A2A URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new A2aError(`“${raw}” is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new A2aError('The agent URL must start with http:// or https://');
  // Settings → Governance: the HTTP host rules apply (A2A is plain HTTP).
  const blocked = httpUrlBlocked(parsed.toString());
  if (blocked) throw new A2aError(`Blocked by policy: ${blocked}. An admin can allow it in Settings → Governance.`, 403);
  const url = parsed.toString().replace(/\/\.well-known\/agent(-card)?\.json$/, '').replace(/\/+$/, '');
  const options = (parameters.options && typeof parameters.options === 'object' ? parameters.options : {}) as { timeout?: unknown };
  const timeout = Number(options.timeout);
  return { url, headers: authHeaders(parameters.authentication, credentials), timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS };
}

function signalFor(endpoint: A2aEndpoint, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(endpoint.timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function networkError(endpoint: A2aEndpoint, error: unknown): A2aError {
  const err = error as Error & { cause?: { code?: string } };
  if (err.name === 'TimeoutError') return new A2aError(`The agent at ${endpoint.url} did not answer within ${Math.round(endpoint.timeoutMs / 1000)} s`);
  if (err.name === 'AbortError') return new A2aError('Canceled');
  return new A2aError(`Could not reach ${endpoint.url}: ${err.cause?.code ?? err.message}`);
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

const cards = singleton('a2a-cards', () => new Map<string, { card: AgentCard; at: number }>());

function cardKey(endpoint: A2aEndpoint): string {
  // Hashed: the key would otherwise hold the token.
  return createHash('sha256').update(JSON.stringify([endpoint.url, Object.entries(endpoint.headers).sort()])).digest('hex');
}

/** The interfaces of a card that Landflow can call: JSON-RPC, protocol 1.x. */
export function jsonRpcInterfaces(card: AgentCard): AgentInterface[] {
  return (card.supportedInterfaces ?? []).filter((i) => i.protocolBinding?.toUpperCase() === 'JSONRPC' && /^1(\.|$)/.test(String(i.protocolVersion ?? '')));
}

/** The agent's card (cached for a minute). Throws when the agent doesn't speak A2A 1.0 over JSON-RPC. */
export async function getAgentCard(endpoint: A2aEndpoint, options: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<AgentCard> {
  const key = cardKey(endpoint);
  const cached = cards.get(key);
  if (cached && !options.fresh && Date.now() - cached.at < CARD_TTL_MS) return cached.card;
  let response: Response;
  try {
    response = await fetch(`${endpoint.url}${CARD_PATH}`, { headers: { accept: 'application/json', ...endpoint.headers }, signal: signalFor(endpoint, options.signal) });
  } catch (error) {
    throw networkError(endpoint, error);
  }
  if (!response.ok) throw new A2aError(`No agent card at ${endpoint.url}${CARD_PATH} (HTTP ${response.status})`, response.status);
  let card: AgentCard;
  try {
    card = (await response.json()) as AgentCard;
  } catch {
    throw new A2aError(`The agent card at ${endpoint.url}${CARD_PATH} is not JSON`);
  }
  if (!card || typeof card.name !== 'string') throw new A2aError(`The agent card at ${endpoint.url}${CARD_PATH} has no name`);
  if (!jsonRpcInterfaces(card).length) {
    const versions = [...new Set([...(card.supportedInterfaces ?? []).map((i) => `${i.protocolVersion ?? '?'} (${i.protocolBinding})`), ...(card.protocolVersion ? [card.protocolVersion] : [])])];
    throw new A2aError(`${card.name} speaks A2A ${versions.join(', ') || 'of an unknown version'}; Landflow speaks A2A ${A2A_PROTOCOL_VERSION} over JSON-RPC`);
  }
  cards.set(key, { card, at: Date.now() });
  return card;
}

/** Whether the card declares an extension. */
export const supportsExtension = (card: AgentCard, uri: string) => Boolean(card.capabilities?.extensions?.some((e) => e.uri === uri));

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

function rpcInit(endpoint: A2aEndpoint, method: string, params: unknown, options: SendOptions, accept: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept,
      'A2A-Version': A2A_PROTOCOL_VERSION,
      ...(options.extensions?.length && { 'A2A-Extensions': options.extensions.join(', ') }),
      // W3C trace context (traceparent, tracestate): the agent's spans join the caller's trace.
      ...options.headers,
      ...endpoint.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: signalFor(endpoint, options.signal),
  };
}

async function rpc<T>(endpoint: A2aEndpoint, method: string, params: unknown, options: SendOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint.url, rpcInit(endpoint, method, params, options, 'application/json'));
  } catch (error) {
    throw networkError(endpoint, error);
  }
  const text = await response.text();
  let body: { result?: T; error?: { code?: number; message?: string } } | undefined;
  try {
    body = JSON.parse(text);
  } catch {
    throw new A2aError(`${method}: HTTP ${response.status} ${text.slice(0, 200)}`.trim(), response.status);
  }
  if (body?.error) throw new A2aError(`${method}: ${body.error.message ?? 'error'}${body.error.code !== undefined ? ` (${body.error.code})` : ''}`, body.error.code);
  if (!response.ok || body?.result === undefined) throw new A2aError(`${method}: HTTP ${response.status}`, response.status);
  return body.result;
}

/** A task that has stopped: finished, failed, or waiting for someone. */
export const isSettled = (state: TaskState) => state !== 'TASK_STATE_SUBMITTED' && state !== 'TASK_STATE_WORKING';

export interface SendOptions {
  signal?: AbortSignal;
  /** Extensions to activate on the call (the A2A-Extensions header). */
  extensions?: string[];
  /** More request headers: the trace context of the caller's span. */
  headers?: Record<string, string>;
}

export interface OutgoingMessage {
  text?: string;
  data?: Record<string, unknown>;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

function toMessage(message: OutgoingMessage): A2aMessage {
  const parts: Part[] = [];
  if (message.text) parts.push({ text: message.text });
  if (message.data) parts.push({ data: message.data });
  if (!parts.length) throw new A2aError('The message is empty');
  return {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts,
    ...(message.contextId && { contextId: message.contextId }),
    ...(message.taskId && { taskId: message.taskId }),
    ...(message.metadata && { metadata: message.metadata }),
    ...(message.extensions?.length && { extensions: message.extensions }),
  };
}

/** Read a task (GetTask). */
export const getTask = (endpoint: A2aEndpoint, taskId: string, options: SendOptions = {}) => rpc<A2aTask>(endpoint, 'GetTask', { id: taskId }, options);

/** Stop a running task (CancelTask). */
export const cancelTask = (endpoint: A2aEndpoint, taskId: string, options: SendOptions = {}) => rpc<A2aTask>(endpoint, 'CancelTask', { id: taskId }, options);

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new A2aError('Canceled'))), { once: true });
  });

/**
 * Send a message (SendMessage) and wait for the task to settle: completed, failed, canceled, rejected, or waiting for input
 * or credentials. Agents that answer before the task settles (state SUBMITTED or WORKING) are polled with GetTask until it
 * does or the endpoint's timeout passes.
 */
export async function sendMessage(endpoint: A2aEndpoint, message: OutgoingMessage, options: SendOptions = {}): Promise<A2aResult> {
  const started = Date.now();
  const result = await rpc<{ task?: A2aTask; message?: A2aMessage }>(endpoint, 'SendMessage', { message: toMessage(message) }, options);
  if (result.message && !result.task) return { kind: 'message', message: result.message };
  if (!result.task?.id || !result.task.status?.state) throw new A2aError('SendMessage: the agent answered with neither a task nor a message');
  return { kind: 'task', task: await settle(endpoint, result.task, started, options) };
}

/** Poll a task with GetTask until it settles or the endpoint's timeout passes. */
async function settle(endpoint: A2aEndpoint, task: A2aTask, started: number, options: SendOptions & { onUpdate?: (task: A2aTask) => void }): Promise<A2aTask> {
  for (let wait = 500; !isSettled(task.status.state); wait = Math.min(wait * 2, 5_000)) {
    if (Date.now() - started > endpoint.timeoutMs) throw new A2aError(`The task ${task.id} is still ${stateName(task.status.state)} after ${Math.round(endpoint.timeoutMs / 1000)} s: read it later with Get Task`);
    await delay(wait, options.signal);
    task = await getTask(endpoint, task.id, options);
    options.onUpdate?.(task);
  }
  return task;
}

/** One SendStreamingMessage event (StreamResponse): a task snapshot, a message, or an update of the task. */
interface StreamEvent {
  task?: A2aTask;
  message?: A2aMessage;
  statusUpdate?: { taskId: string; contextId: string; status: A2aTask['status']; metadata?: Record<string, unknown> };
  artifactUpdate?: { taskId: string; contextId: string; artifact: Artifact; append?: boolean; lastChunk?: boolean };
}

/** The task after one stream event: updates change the snapshot; appended chunks extend their artifact. */
export function applyStreamEvent(task: A2aTask | undefined, event: StreamEvent): A2aTask | undefined {
  if (event.task) return event.task;
  const update = event.statusUpdate ?? event.artifactUpdate;
  if (!update) return task;
  const next: A2aTask = task ? { ...task, artifacts: [...(task.artifacts ?? [])] } : { id: update.taskId, contextId: update.contextId, status: { state: 'TASK_STATE_WORKING' }, artifacts: [] };
  if (event.statusUpdate) {
    next.status = event.statusUpdate.status;
    if (event.statusUpdate.metadata) next.metadata = { ...next.metadata, ...event.statusUpdate.metadata };
  } else if (event.artifactUpdate) {
    const { artifact, append } = event.artifactUpdate;
    const artifacts = next.artifacts!;
    const index = artifacts.findIndex((a) => a.artifactId === artifact.artifactId);
    if (index < 0) artifacts.push(artifact);
    else if (append) artifacts[index] = { ...artifacts[index], parts: [...artifacts[index].parts, ...artifact.parts], metadata: { ...artifacts[index].metadata, ...artifact.metadata } };
    else artifacts[index] = artifact;
  }
  return next;
}

/** `data:` payloads of a server-sent event stream, one per event. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
  const tail = buffer.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  if (tail) yield tail;
}

/**
 * Send a message with SendStreamingMessage (agents whose card says `capabilities.streaming`): `onUpdate` gets the task
 * after every event (each tool call and result as it happens), and the result is the settled task. A stream that ends
 * before the task settles is followed with GetTask, like sendMessage.
 */
export async function streamMessage(endpoint: A2aEndpoint, message: OutgoingMessage, options: SendOptions & { onUpdate?: (task: A2aTask) => void } = {}): Promise<A2aResult> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint.url, rpcInit(endpoint, 'SendStreamingMessage', { message: toMessage(message) }, options, 'text/event-stream'));
  } catch (error) {
    throw networkError(endpoint, error);
  }
  if (!response.ok || !response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // A JSON-RPC error (or an HTTP one) comes back as a plain JSON body.
    const text = await response.text().catch(() => '');
    let error: { code?: number; message?: string } | undefined;
    try {
      error = JSON.parse(text)?.error;
    } catch {
      // not JSON
    }
    if (error) throw new A2aError(`SendStreamingMessage: ${error.message ?? 'error'}${error.code !== undefined ? ` (${error.code})` : ''}`, error.code);
    throw new A2aError(`SendStreamingMessage: HTTP ${response.status} ${text.slice(0, 200)}`.trim(), response.status);
  }
  let task: A2aTask | undefined;
  try {
    for await (const data of sseData(response.body)) {
      let body: { result?: StreamEvent; error?: { code?: number; message?: string } };
      try {
        body = JSON.parse(data);
      } catch {
        continue;
      }
      if (body.error) throw new A2aError(`SendStreamingMessage: ${body.error.message ?? 'error'}${body.error.code !== undefined ? ` (${body.error.code})` : ''}`, body.error.code);
      if (!body.result) continue;
      if (body.result.message && !task) return { kind: 'message', message: body.result.message };
      task = applyStreamEvent(task, body.result);
      if (task) options.onUpdate?.(task);
    }
  } catch (error) {
    if (error instanceof A2aError) throw error;
    throw networkError(endpoint, error);
  }
  if (!task) throw new A2aError('SendStreamingMessage: the stream ended without a task');
  return { kind: 'task', task: await settle(endpoint, task, started, options) };
}

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

/** `TASK_STATE_INPUT_REQUIRED` → `input-required`. */
export const stateName = (state: TaskState | string) => String(state).replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-');

const texts = (parts: Part[] = []) => parts.flatMap((p) => (typeof p.text === 'string' && p.text.trim() ? [p.text] : []));

/** The agent's answer: the text of its last artifact with text, else the status message's, else the message's. */
export function replyOf(result: A2aResult): string | undefined {
  if (result.kind === 'message') return texts(result.message.parts).join('\n\n') || undefined;
  const { task } = result;
  const withText = (task.artifacts ?? []).filter((a) => texts(a.parts).length).at(-1);
  if (withText) return texts(withText.parts).join('');
  return texts(task.status.message?.parts).join('\n\n') || undefined;
}

/** Data parts of the task's artifacts (kagent puts each tool call and result there), for the node's output. */
export function dataOf(task: A2aTask): unknown[] {
  return (task.artifacts ?? []).flatMap((a) => a.parts.flatMap((p) => (p.data !== undefined ? [p.metadata ? { ...(p.data as object), _meta: p.metadata } : p.data] : [])));
}

/** kagent's token usage for the task, when it reports it. */
export function usageOf(task: A2aTask): Record<string, unknown> | undefined {
  const usage = task.metadata?.[KAGENT_USAGE_EXTENSION];
  return usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : undefined;
}

/** kagent's usage extension as token counts. */
export function tokenUsageOf(task: A2aTask): { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number } | undefined {
  const usage = usageOf(task);
  if (!usage) return undefined;
  const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
  return {
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    ...(count('cachedInputTokens') > 0 && { cachedInputTokens: count('cachedInputTokens') }),
    ...(count('reasoningTokens') > 0 && { reasoningTokens: count('reasoningTokens') }),
  };
}

/** A tool call the remote agent made, read from its task (kagent: function_call and function_response data parts). */
export interface RemoteStep {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  status: 'running' | 'success' | 'error' | 'awaiting_approval';
  /** The agent's own timestamps (kagent's timeline position), ISO. */
  startedAt?: string;
  endedAt?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const PART_TYPE = 'kagent.dev/a2a/part-type';
const TIMELINE_POSITION = 'kagent.dev/a2a/timeline-position';

/**
 * Why a tool's response is a failure, when it is one: an `error` string, or `isError: true` on the response or its `output`
 * (tools that report a failed command that way, such as `{"output": {"isError": true, "result": "Exit code 128 …"}}`).
 */
function stepFailure(response: unknown): string | undefined {
  if (!isObject(response)) return undefined;
  if (typeof response.error === 'string') return response.error;
  for (const candidate of [response, response.output]) {
    if (!isObject(candidate) || candidate.isError !== true) continue;
    for (const key of ['result', 'content', 'error', 'message']) {
      const value = candidate[key];
      if (typeof value === 'string' && value) return value;
      if (value !== undefined && value !== null && typeof value !== 'string') return JSON.stringify(value);
    }
    return 'The tool reported an error';
  }
  return undefined;
}

/** The remote agent's tool calls so far, in order: what it called, with what, what came back. Calls a pause waits on are `awaiting_approval`. */
export function remoteStepsOf(task: A2aTask): RemoteStep[] {
  const steps = new Map<string, RemoteStep>();
  for (const artifact of task.artifacts ?? []) {
    const at = typeof artifact.metadata?.[TIMELINE_POSITION] === 'string' ? (artifact.metadata[TIMELINE_POSITION] as string) : undefined;
    for (const part of artifact.parts) {
      const data = part.data as { id?: unknown; name?: unknown; args?: unknown; response?: unknown } | undefined;
      const kind = part.metadata?.[PART_TYPE];
      if (!data || typeof data.id !== 'string' || (kind !== 'function_call' && kind !== 'function_response')) continue;
      const name = String(data.name ?? 'tool');
      if (kind === 'function_call') {
        steps.set(data.id, { id: data.id, name, status: 'running', ...(isObject(data.args) && { args: data.args }), ...(at && { startedAt: at }) });
        continue;
      }
      const step = steps.get(data.id) ?? { id: data.id, name, status: 'running' as const };
      const response = data.response as { error?: unknown; output?: unknown } | undefined;
      const failure = stepFailure(response);
      steps.set(data.id, {
        ...step,
        status: failure !== undefined ? 'error' : 'success',
        ...(failure !== undefined ? { error: failure, output: undefined } : { output: response && typeof response === 'object' && 'output' in response ? response.output : response, error: undefined }),
        ...(at && { endedAt: at }),
      });
    }
  }
  const request = hitlRequestOf(task);
  if (request?.type === 'tool_approval_request') {
    for (const call of request.tools) {
      const step = call.callId ? steps.get(call.callId) : undefined;
      if (step) steps.set(step.id, { ...step, status: 'awaiting_approval', error: undefined, endedAt: undefined });
    }
  }
  return [...steps.values()].map((step) => Object.fromEntries(Object.entries(step).filter(([, v]) => v !== undefined)) as unknown as RemoteStep);
}

/**
 * What the remote agent said between its tool calls, in order: the text of every artifact followed by a later one (the
 * last artifact's text is its answer or its question, not "said"). `afterSteps` places each among the tool calls.
 */
export function remoteSaidOf(task: A2aTask): RemoteSaid[] {
  const artifacts = task.artifacts ?? [];
  const calls = new Set<string>();
  const said: RemoteSaid[] = [];
  artifacts.forEach((artifact, index) => {
    const at = typeof artifact.metadata?.[TIMELINE_POSITION] === 'string' ? (artifact.metadata[TIMELINE_POSITION] as string) : undefined;
    artifact.parts.forEach((part, partIndex) => {
      const data = part.data as { id?: unknown } | undefined;
      const kind = part.metadata?.[PART_TYPE];
      if (data && typeof data.id === 'string' && (kind === 'function_call' || kind === 'function_response')) {
        calls.add(data.id);
        return;
      }
      if (typeof part.text !== 'string' || !part.text.trim() || index === artifacts.length - 1) return;
      said.push({ id: `${artifact.artifactId}:${partIndex}`, text: part.text.trim(), afterSteps: calls.size, ...(at && { at }) });
    });
  });
  return said;
}

/** What a task waiting at INPUT_REQUIRED asks for, when the agent sent it with kagent's HITL extension. */
export function hitlRequestOf(task: A2aTask): HitlRequest | undefined {
  if (task.status.state !== 'TASK_STATE_INPUT_REQUIRED') return undefined;
  const payload = task.status.message?.metadata?.[KAGENT_HITL_EXTENSION] as Record<string, unknown> | undefined;
  if (payload?.type === 'tool_approval_request' && Array.isArray(payload.tools)) {
    const tools = (payload.tools as Array<Record<string, unknown>>)
      .filter((t) => typeof t.id === 'string')
      .map((t) => ({
        id: String(t.id),
        name: String(t.name ?? 'tool'),
        ...(isObject(t.args) && { args: t.args }),
        ...(typeof t.call_id === 'string' && { callId: t.call_id }),
      }));
    return { type: 'tool_approval_request', tools, ...(typeof payload.hint === 'string' && { hint: payload.hint }) };
  }
  if (payload?.type === 'ask_user_request' && typeof payload.id === 'string') {
    return { type: 'ask_user_request', id: payload.id, questions: Array.isArray(payload.questions) ? payload.questions : [] };
  }
  return undefined;
}

/** The text of a task's status message (why it stopped or failed). */
export const statusText = (task: A2aTask) => texts(task.status.message?.parts).join('\n') || undefined;

// ---------------------------------------------------------------------------
// Answering a pause (kagent HITL)
// ---------------------------------------------------------------------------

/** The message that decides every call of a tool_approval_request. Rejections carry the reason to the agent. */
export function approvalMessage(task: Pick<A2aTask, 'id' | 'contextId'>, request: Extract<HitlRequest, { type: 'tool_approval_request' }>, approved: boolean, reason?: string): OutgoingMessage {
  const payload = {
    type: 'tool_approval_response',
    approvals: request.tools.map((t) => ({ id: t.id, approved, ...(!approved && reason && { rejection_reason: reason }) })),
  };
  // The URI goes in both `metadata` and `extensions`: kagent ignores a payload the extensions array doesn't declare.
  return {
    text: approved ? 'Approved' : `Rejected${reason ? `: ${reason}` : ''}`,
    taskId: task.id,
    contextId: task.contextId,
    metadata: { [KAGENT_HITL_EXTENSION]: payload },
    extensions: [KAGENT_HITL_EXTENSION],
  };
}

/** The message that answers an ask_user_request, one answer per question in order. */
export function answerMessage(task: Pick<A2aTask, 'id' | 'contextId'>, request: Extract<HitlRequest, { type: 'ask_user_request' }>, answers: string[]): OutgoingMessage {
  return {
    text: answers.join('\n'),
    taskId: task.id,
    contextId: task.contextId,
    metadata: { [KAGENT_HITL_EXTENSION]: { type: 'ask_user_response', id: request.id, answers: answers.map((answer) => ({ answer: [answer] })) } },
    extensions: [KAGENT_HITL_EXTENSION],
  };
}

/** The question texts of an ask_user_request (kagent sends objects with a `question` field, or plain strings). */
export function questionTexts(request: Extract<HitlRequest, { type: 'ask_user_request' }>): string[] {
  return request.questions.map((q) => (typeof q === 'string' ? q : String((q as { question?: unknown; text?: unknown })?.question ?? (q as { text?: unknown })?.text ?? JSON.stringify(q))));
}
