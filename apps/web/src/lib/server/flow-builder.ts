/**
 * "Describe your workflow": a local model (Ollama) drafts a flow from the
 * live node catalog. The draft is validated against the registry: unknown
 * types, unknown parameters and impossible connections are dropped, and a
 * manual trigger is added when the model forgot one.
 */
import type { ConnectionType, NodeItem, NodeTypeInfo, PropertyDescriptor } from '@/lib/shared/types';
import { describeAgents, withAgentId, type AgentBrief } from '@/lib/shared/agent-brief';
import { describeTeams, withTeamId, type TeamBrief } from '@/lib/shared/agent-teams';
import { registry } from './plugins/registry';
import { collectionShape } from '@/lib/shared/assistant-ops';
import { outputFields } from './assistant/research';
import { assistantModel } from './assistant/model';
import { anthropicModel } from './nodes/models';
import { ollamaUrl } from './config';
// SB01: the draft's reply held to a schema, checked for empty parts and sent back once.
import { z } from 'zod';
import { isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import { collectionWarnings, structuralWarnings } from '@/lib/shared/assistant-ops';
import { hollowSteps } from '@/lib/shared/run-check';
import { mergeLeft, type DraftLeft } from '@/lib/shared/draft-left';

export interface DraftNode {
  key: string;
  type: string;
  name: string;
  x: number;
  y: number;
  parameters?: Record<string, unknown>;
}

export interface FlowDraft {
  name: string;
  nodes: DraftNode[];
  edges: Array<[string, string, number, ConnectionType]>;
  pinData?: Record<string, NodeItem[]>;
  model: string;
  durationMs: number;
  dropped: string[];
  /** SB01: what the draft still lacks for the person (empty fields after one send-back, types that could not be kept). */
  left?: DraftLeft[];
}

const DEFAULT_MODEL = process.env.LANDFLOW_BUILDER_MODEL ?? 'qwen3-coder:30b';

/**
 * How long one draft may take (LANDFLOW_BUILDER_TIMEOUT_SECONDS, default 600): the model reads the whole node catalog
 * before it writes, and a dense local model on a host with many plugins can spend minutes on that alone. The limit only
 * keeps a request from hanging on a stuck Ollama. Read per call, so a changed value applies to the next draft.
 */
export function builderTimeoutMs(value: string | undefined = process.env.LANDFLOW_BUILDER_TIMEOUT_SECONDS): number {
  const seconds = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 600_000;
}

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' }, parameters: { type: 'object' } },
        required: ['key', 'type', 'name', 'parameters'],
      },
    },
    connections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          output: { type: 'integer' },
          type: { type: 'string', enum: ['main', 'ai_languageModel', 'ai_memory', 'ai_tool', 'ai_embedding', 'ai_document', 'ai_textSplitter', 'ai_retriever', 'ai_reranker'] },
        },
        required: ['from', 'to'],
      },
    },
    testData: { type: 'array', items: { type: 'object' } },
  },
  required: ['name', 'nodes', 'connections'],
};

/** How the core nodes' structured parameters are written (shared with the editor assistant). */
export const PARAMETER_FORMATS = `Parameter formats:
- core.set (add or change fields): {"mode":"manual","fields":{"values":[{"name":"greeting","type":"string","value":"Hi {{ $json.name }}"}]},"includeOtherFields":true}
- core.if / core.filter: {"conditions":{"condition":[{"left":"{{ $json.score }}","operator":"gt","right":"0.5"}]},"combinator":"and"}. Operators: equals, notEquals, contains, notContains, startsWith, gt, gte, lt, lte, regex, isEmpty, isNotEmpty, isTrue, isFalse.
- core.code per item: {"mode":"each","codeEach":"return { ...$json, total: $json.a + $json.b };"}. For all items at once: {"mode":"all","code":"return items.map((item) => ({ ...item.json }));"}
- core.merge waits for both inputs: {"mode":"append"}. Connect the two branches to it.
- core.aggregate, one item with a list of each field's values: {"aggregate":"aggregateIndividualFields","fieldsToAggregate":{"fieldToAggregate":[{"fieldToAggregate":"title"}]}} puts out {"title":["…","…"]}.
- core.schedule at a time of day ("every morning at 9"): {"unit":"rules","rule":{"interval":[{"field":"days","daysInterval":1,"triggerAtHour":9,"triggerAtMinute":0}]}}. Weekdays at 9: {"unit":"rules","rule":{"interval":[{"field":"cronExpression","expression":"0 9 * * 1-5"}]}}. "unit":"hours" with "every" counts from when the workflow is activated, not from a time of day.`;

const SYSTEM = `You design workflows for Landflow, an n8n-like automation tool. Reply with JSON only, matching the schema.

A workflow is a set of nodes joined by connections, left to right. Items (JSON objects) flow along connections: each node gets the items of the node before it, processes each item and passes items on.

Rules:
- Exactly one trigger node (kind "trigger") starts the flow. Use core.manualTrigger unless the user asks for a webhook, a schedule or a chat.
- Only use node types from the catalog, with their exact "type" id. Prefer plugin nodes (not "core.") when they do the job.
- Each node gets a unique short key ("a", "b", …) and a short human name (2–4 words) describing what it does in this flow.
- Parameters: only the parameter names listed for that node. Reference fields of the current item with expressions such as "{{ $json.title }}". Field parameters (like "field") take a plain field name such as "text", not an expression.
- Nodes that write a result object into "outputField" (see the parameter notes, e.g. "receives {score, label}") nest it: compare "{{ $json.sentiment.label }}" or "{{ $json.sentiment.score }}", never the whole object.
- connections: {"from": key, "to": key, "output": n}. "output" is the source's output index (If/Filter-like nodes: 0 = true, 1 = false). AI sub-nodes attach to an AI Agent with "type" ai_languageModel, ai_memory or ai_tool, from the sub-node to the agent. RAG: a vector store (mode retrieve-as-tool) attaches to an agent as ai_tool, or (mode retrieve) to a Question and Answer Chain as ai_retriever; embeddings attach to a vector store as ai_embedding, a data loader as ai_document, a text splitter to the loader as ai_textSplitter.
- Agents: when a step needs an agent, first look at "Your agents" and "Published agent teams" after the catalog. If one's description, skills and tools cover the step, run it: core.messageAgent with its agentId (or core.runTeam with its teamId) and a "message" saying what to do with the item. Use core.aiAgent only for a small step that needs no specialist (classify, summarize, extract, draft a reply). Never invent an agentId or teamId.
- testData: 2–4 realistic sample items the flow can be tested with when run manually (objects with the fields the flow reads); just 1 when the flow runs an agent or a team, since each item is a whole agent run. With a Webhook trigger, each item is what a call brings: {"body": {…}} (plus the "headers" or "query" the flow reads); with a Form trigger, the form's fields.

${PARAMETER_FORMATS}`;

function describeProperty(p: PropertyDescriptor): string {
  const options = p.options?.map((o) => String(o.value)).slice(0, 8);
  const hint = p.description ? ` "${p.description.slice(0, 90)}"` : '';
  const shape = collectionShape(p);
  return `${p.name} (${p.type}${options?.length ? `: ${options.join('|')}` : ''}${p.default !== undefined && typeof p.default !== 'object' && p.default !== '' ? `, default ${JSON.stringify(p.default)}` : ''})${hint}${shape ? ` [${shape}]` : ''}`;
}

function catalog(types: NodeTypeInfo[]): string {
  return types
    .map((t) => {
      const d = t.descriptor;
      const outputs = d.outputs.filter((o) => o.type === 'main');
      const params = d.properties
        .filter((p) => p.type !== 'notice')
        .map(describeProperty)
        .join('; ');
      const where = t.pluginId === 'core' ? 'built in' : `${t.pluginName} plugin, ${t.language}`;
      return `- ${t.type} — ${d.displayName} [${d.kind}${d.supplies ? `, supplies ${d.supplies}` : ''}${d.usableAsTool ? ', usable as tool' : ''}] (${where}): ${d.description}${outputs.length > 1 ? ` Outputs: ${outputs.map((o, i) => `${i}=${o.displayName ?? i}`).join(', ')}.` : ''}${outputFields(d) ? ` Output item: ${outputFields(d)}.` : ''}${params ? `\n  params: ${params}` : ''}`;
    })
    .join('\n');
}

/** A Run an Agent node keeps only an agent the caller has: an id the model made up is cleared, so the node asks for one. */
function knownAgent(parameters: Record<string, unknown>, agents: readonly AgentBrief[]): Record<string, unknown> {
  const id = typeof parameters.agentId === 'string' ? parameters.agentId : '';
  return !id || id.includes('{{') || agents.some((a) => a.id === id) ? parameters : { ...parameters, agentId: '' };
}

/**
 * Triggers the draft's test items are pinned on. A Webhook or Form trigger with pinned data runs from it when tested, so
 * Spotlight's Test and fix (autonomous by default) runs the draft at once instead of waiting for a test event.
 */
const PINNED_TRIGGERS = new Set(['core.manualTrigger', 'core.webhook', 'core.formTrigger']);

/** Nodes that run a whole agent (or team) session per item: a test run of a flow with one gets one sample item. */
const AGENT_TYPES = new Set(['core.aiAgent', 'core.messageAgent', 'core.runTeam', 'core.a2aAgent']);

function asItems(rows: unknown): NodeItem[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const items = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((json) => ({ json: json as NodeItem['json'] }));
  return items.length ? items.slice(0, 10) : undefined;
}

/** Keys a model copies from a chat trigger's world onto a manual trigger's test item. */
const TRIGGER_JUNK = new Set(['chatInput', 'sessionId', 'action', 'parameters', 'type', 'typeVersion']);

/**
 * Test data for the trigger. Models pin the trigger's own parameters or a `chatInput` on a manual trigger: those keys come
 * out, and with nothing left, or nothing a node that names the fields it reads (`$json.x`) would read, there is no pin.
 */
export function cleanTestItems(items: NodeItem[] | undefined, trigger: Pick<DraftNode, 'key'> | undefined, nodes: DraftNode[]): NodeItem[] | undefined {
  if (!items || !trigger) return undefined;
  const own = new Set(Object.keys(nodes.find((n) => n.key === trigger.key)?.parameters ?? {}));
  const cleaned = items
    .map((item) => ({ ...item, json: Object.fromEntries(Object.entries(item.json).filter(([k]) => !TRIGGER_JUNK.has(k) && !own.has(k))) as NodeItem['json'] }))
    .filter((item) => Object.keys(item.json).length);
  if (!cleaned.length) return undefined;
  const text = JSON.stringify(nodes.filter((n) => n.key !== trigger.key).map((n) => n.parameters ?? {}));
  // When the flow names the fields it reads and the items carry none of them, the items are noise on the trigger.
  const read = new Set([...text.matchAll(/\$json(?:\.|\[\\?['"])(\w+)/g), ...text.matchAll(/\.json\.(\w+)/g)].map((m) => m[1]));
  return read.size && !cleaned.some((item) => Object.keys(item.json).some((k) => read.has(k))) ? undefined : cleaned;
}

/** Triggers a test run waits on for an event unless test data is pinned. */
const WAITING_TRIGGERS = new Set(['core.webhook', 'core.formTrigger']);

/**
 * One made-up item for a Webhook or Form trigger the model gave no usable test data for, so Test and fix runs the flow
 * instead of waiting for a call: the fields the steps read, at the top or under "body" as they read them.
 */
export function sampleItems(trigger: Pick<DraftNode, 'key' | 'type'> | undefined, nodes: DraftNode[]): NodeItem[] | undefined {
  if (!trigger || !WAITING_TRIGGERS.has(trigger.type)) return undefined;
  const text = JSON.stringify(nodes.filter((n) => n.key !== trigger.key).map((n) => n.parameters ?? {}));
  const top = new Set<string>();
  const body = new Set<string>();
  for (const [, field, inner] of text.matchAll(/\$json\.(\w+)(?:\.(\w+))?/g)) {
    if (field === 'body' && inner) body.add(inner);
    else if (!['body', 'headers', 'query', 'params'].includes(field)) top.add(field);
  }
  const sample = (field: string) => `Sample ${field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()}`;
  const json: NodeItem['json'] = Object.fromEntries([...top].map((f) => [f, sample(f)]));
  if (body.size || trigger.type === 'core.webhook') json.body = Object.fromEntries([...(body.size ? body : ['text'])].map((f) => [f, sample(f)]));
  return [{ json }];
}

/** One turn of the conversation that drafts a flow. */
type DraftMessage = { role: 'user' | 'assistant'; content: string };

/** What the model is told: the instructions, and the schema its reply must match (Ollama's and the providers' alike). */
const SYSTEM_WITH_SCHEMA = `${SYSTEM}\n\nAnswer with one JSON object and nothing else (no prose, no code fence), matching this JSON schema:\n${JSON.stringify(SCHEMA)}`;

/**
 * The draft as text from Ollama's chat API. SB01: `format: 'json'`, not the schema: with the whole catalog in the prompt a
 * model held to the schema wrote empty objects where `parameters` is a bare object (every If with no condition). The
 * schema is in the system prompt instead, as for the providers.
 */
async function draftWithOllama(model: string, messages: DraftMessage[], timeoutMs: number): Promise<string> {
  const response = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      messages: [{ role: 'system', content: SYSTEM_WITH_SCHEMA }, ...messages],
    }),
  }).catch((e: Error) => {
    // A timeout means Ollama answered too slowly, not that it is down: say so, and what to change.
    if (e.name === 'TimeoutError') {
      throw new Error(`${model} on Ollama at ${ollamaUrl()} did not finish the draft within ${timeoutMs / 1000} s. The model may be slow or still loading: raise LANDFLOW_BUILDER_TIMEOUT_SECONDS, or set a faster LANDFLOW_BUILDER_MODEL`);
    }
    throw new Error(`Could not reach Ollama at ${ollamaUrl()}: ${e.message}`);
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { message?: { content?: string } };
  return body.message?.content ?? '{}';
}

/**
 * The draft as text from `anthropic/<model>` or `openai/<model>` through the model adapters: the server's
 * ANTHROPIC_API_KEY (or `ant auth login`), or OPENAI_API_KEY and OPENAI_BASE_URL. These have no schema-held format here,
 * so the schema goes in the system prompt and jsonOf() takes the object out of the reply.
 */
async function draftWithProvider(model: string, messages: DraftMessage[], timeoutMs: number): Promise<string> {
  const [provider, ...rest] = model.split('/');
  // A whole draft needs more room than the assistant's 4096 tokens; non-streaming, so ~16000 keeps under SDK timeouts.
  // `fallback`: a refused draft is retried server-side on another model (Anthropic's `fallbacks: "default"`).
  const llm = provider === 'anthropic' ? anthropicModel({ model: rest.join('/'), effort: 'medium', maxTokens: 16_000, fallback: true }) : assistantModel(model);
  try {
    const turn = await llm.generate({ system: SYSTEM_WITH_SCHEMA, messages: messages.map((m) => (m.role === 'user' ? { role: 'user' as const, content: m.content } : { role: 'assistant' as const, text: m.content, toolCalls: [] })), tools: [], responseFormat: 'json', signal: AbortSignal.timeout(timeoutMs) });
    if (turn.stopReason === 'refusal') throw new Error(`${model} declined to draft this workflow: ${turn.text}`);
    return turn.text;
  } catch (e) {
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      throw new Error(`${model} did not finish the draft within ${timeoutMs / 1000} s: raise LANDFLOW_BUILDER_TIMEOUT_SECONDS`);
    }
    throw e;
  }
}

/** SB01: the one place a draft's model call is made (the first request and each send-back). */
function askModel(model: string, messages: DraftMessage[], timeoutMs: number): Promise<string> {
  return /^(anthropic|openai)\//.test(model) ? draftWithProvider(model, messages, timeoutMs) : draftWithOllama(model, messages, timeoutMs);
}

/** The JSON object in a model's reply: the whole text, or what a code fence or prose around it holds. */
export function jsonOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)?.[1]?.trim();
  if (fenced?.startsWith('{')) return fenced;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed || '{}';
}

// SB01: the reply held to a schema. Lenient where models vary (a node without a key is dropped later, as before); strict
// where a draft can't be built: `nodes` must be an array of objects, `parameters` a record, `connections` a list.
const Count = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]);
export const DraftReply = z.object({
  name: z.string().nullish(),
  nodes: z.array(z.object({ key: z.string().nullish(), type: z.string().nullish(), name: z.string().nullish(), parameters: z.record(z.string(), z.unknown()).nullish() })),
  connections: z.array(z.object({ from: z.string().nullish(), to: z.string().nullish(), output: Count.nullish(), type: z.string().nullish() })).nullish(),
  testData: z.array(z.unknown()).nullish(),
});
type Reply = z.infer<typeof DraftReply>;

const INVALID_REPLY = 'The model did not return valid JSON. Try again or rephrase.';

/** A reply as a draft, or what is wrong with it in plain words (zod's first three issues). */
function parseReply(text: string): { ok: true; reply: Reply } | { ok: false; problems: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonOf(text));
  } catch {
    return { ok: false, problems: 'it is not valid JSON' };
  }
  const parsed = DraftReply.safeParse(raw);
  if (parsed.success) return { ok: true, reply: parsed.data };
  return { ok: false, problems: parsed.error.issues.slice(0, 3).map((i) => `${i.path.length ? `“${i.path.join('.')}”` : 'the reply'}: ${i.message}`).join('; ') };
}

/** The first reply that parses: one that doesn't is sent back once with what is wrong, and a second failure is an error. */
async function parsedReply(model: string, messages: DraftMessage[], timeoutMs: number, started: number): Promise<{ text: string; reply: Reply }> {
  const text = await askModel(model, messages, timeoutMs);
  const first = parseReply(text);
  if (first.ok) return { text, reply: first.reply };
  const left = timeoutMs - (Date.now() - started);
  if (left <= 0) throw new Error(INVALID_REPLY);
  const again = await askModel(model, [...messages, { role: 'assistant', content: text }, { role: 'user', content: `That reply cannot be used: ${first.problems}. Reply again with the whole workflow as one JSON object matching the schema: "nodes" a list of {key, type, name, parameters} objects, "connections" a list of {from, to} objects.` }], left);
  const second = parseReply(again);
  if (!second.ok) throw new Error(INVALID_REPLY);
  return { text: again, reply: second.reply };
}

const lastSegment = (type: string) => type.split('.').pop()!.toLowerCase();
const plain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * SB01: the one available type a made-up type can mean (`core.linear.linear` → the Linear plugin's `linear`): the same
 * last segment or the same display name, and exactly one candidate. None or several: undefined.
 */
function nearType(type: string, byType: Map<string, NodeTypeInfo>): NodeTypeInfo | undefined {
  const word = lastSegment(type);
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found = [...byType.values()].filter((t) => lastSegment(t.type) === word || squash(t.descriptor.displayName) === squash(word));
  return found.length === 1 ? found[0] : undefined;
}

interface Assembled {
  nodes: DraftNode[];
  edges: FlowDraft['edges'];
  dropped: string[];
  left: DraftLeft[];
  trigger: DraftNode | undefined;
}

/** The reply as validated nodes and edges: unknown types (or near-misses), unknown parameters and impossible connections handled, a manual trigger added when none. */
function assemble(raw: Reply, byType: Map<string, NodeTypeInfo>, teams: readonly TeamBrief[], agents: readonly AgentBrief[]): Assembled {
  const dropped: string[] = [];
  const left: DraftLeft[] = [];
  const nodes: DraftNode[] = [];
  const keys = new Set<string>();
  for (const n of raw.nodes) {
    // SB01: a type that is not in the catalog maps to the one available type it can mean.
    const info = n.type ? (byType.get(n.type) ?? nearType(n.type, byType)) : undefined;
    if (!info || !n.key || keys.has(n.key)) {
      dropped.push(`node ${n.name ?? n.type ?? '?'} (${n.type ?? 'no type'})`);
      if (n.type && !info) left.push({ node: n.name ?? n.type, kind: 'dropped', text: `“${n.name ?? n.type}”: the step type “${n.type}” is not available, so it was left out` });
      continue;
    }
    keys.add(n.key);
    const known = new Set(info.descriptor.properties.map((p) => p.name));
    const kept = Object.fromEntries(Object.entries(n.parameters ?? {}).filter(([k]) => known.has(k)));
    // Models write the team's name where its id goes: the one published team it names becomes the id.
    const parameters = info.type === 'core.runTeam' ? withTeamId(kept, teams) : info.type === 'core.messageAgent' ? knownAgent(withAgentId(kept, agents), agents) : kept;
    nodes.push({ key: n.key, type: info.type, name: (n.name ?? info.descriptor.displayName).slice(0, 60), x: 0, y: 0, parameters });
  }
  if (!nodes.length) throw new Error('The model did not produce any usable nodes. Try describing the steps more concretely.');

  const infoOf = (key: string) => byType.get(nodes.find((n) => n.key === key)!.type)!;
  const edges: FlowDraft['edges'] = [];
  for (const c of raw.connections ?? []) {
    const type = (c.type ?? 'main') as ConnectionType;
    if (!c.from || !c.to || !keys.has(c.from) || !keys.has(c.to) || c.from === c.to) {
      dropped.push(`connection ${c.from} → ${c.to}`);
      continue;
    }
    const source = infoOf(c.from).descriptor;
    const target = infoOf(c.to).descriptor;
    const output = Math.max(0, Math.floor(c.output ?? 0));
    const ok =
      type === 'main'
        ? output < source.outputs.filter((o) => o.type === 'main').length && target.inputs.some((i) => i.type === 'main')
        : target.inputs.some((i) => i.type === type) && (source.supplies === type || source.outputs.some((o) => o.type === type) || (type === 'ai_tool' && Boolean(source.usableAsTool)));
    if (!ok || edges.some(([f, t, o, ty]) => f === c.from && t === c.to && o === output && ty === type)) {
      if (!ok) dropped.push(`connection ${c.from} → ${c.to} (${type})`);
      continue;
    }
    edges.push([c.from, c.to, type === 'main' ? output : 0, type]);
  }

  // Every flow needs a trigger: add a manual one feeding the first steps.
  let trigger = nodes.find((n) => infoOf(n.key).descriptor.kind === 'trigger');
  if (!trigger && byType.has('core.manualTrigger')) {
    trigger = { key: '__trigger', type: 'core.manualTrigger', name: 'Run', x: 0, y: 0 };
    const roots = nodes.filter(
      (n) => infoOf(n.key).descriptor.inputs.some((i) => i.type === 'main') && !edges.some(([, to, , ty]) => to === n.key && ty === 'main'),
    );
    nodes.unshift(trigger);
    for (const root of roots) edges.push([trigger.key, root.key, 0, 'main']);
  }
  return { nodes, edges, dropped, left, trigger };
}

/** SB01: one part of a draft that is empty or unusable: `ask` is the line for the model, `left` the line for the person. */
export interface EmptyPart {
  node: string;
  key: string;
  field?: string;
  /** `empty`: a list or value the step cannot work without; `other`: a shape or wiring problem. */
  kind: 'empty' | 'other';
  ask: string;
  left: string;
}

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.every(isBlank)) || (plain(v) && Object.values(v).every(isBlank));

/** A row with nothing in it: every value blank, or an option still at its default (a rule's `field: "days"`, a Set row's type). */
function rowEmpty(fields: PropertyDescriptor[] | undefined, row: unknown): boolean {
  if (!plain(row)) return isBlank(row);
  return Object.entries(row).every(([k, v]) => {
    const f = fields?.find((x) => x.name === k);
    if (f?.type === 'options' && v === f.default) return true;
    return f?.type === 'fixedCollection' && f.groups ? collectionEmpty(f, v) : isBlank(v);
  });
}

/** A fixedCollection's value with no usable row: missing, `{}`, or only empty rows. */
function collectionEmpty(p: PropertyDescriptor, value: unknown): boolean {
  if (isBlank(value)) return true;
  if (!plain(value)) return false;
  return Object.entries(value).every(([name, rows]) => (Array.isArray(rows) ? rows : [rows]).every((row) => rowEmpty(p.groups?.find((g) => g.name === name)?.values, row)));
}

/** How the parameter is written: the PARAMETER_FORMATS line for the node, else the descriptor's own shape. */
function shapeOf(type: string, p: PropertyDescriptor): string {
  const line = PARAMETER_FORMATS.split('\n').find((l) => l.startsWith('- ') && l.includes(type));
  return line ? line.slice(line.indexOf(': ') + 2) : collectionShape(p);
}

/** Lists a step cannot work without although the node ships them empty: a table write's column values. */
const NEEDED_LISTS = new Set(['core.dataTable:columns']);

/** What the person is told a step does without the list. */
function without(type: string, p: PropertyDescriptor): string {
  if (type === 'core.if' || type === 'core.filter') return 'no condition yet: it keeps every item';
  if (type === 'core.set') return 'no fields yet: it sets nothing';
  if (type === 'core.switch') return 'no routing rule yet: every item takes the fallback';
  if (type === 'core.schedule') return 'no time yet: it never runs';
  if (type === 'core.dataTable') return 'no column values yet: it writes empty rows';
  return `${p.displayName.toLowerCase()} is still empty`;
}

/**
 * SB01: what a draft leaves empty or unusable, before it reaches the canvas. Generic: a visible fixedCollection that is
 * required, or that the node ships with rows in (an If's conditions, a Set's fields, a Switch's rules, a schedule's
 * rules), whose value is missing, `{}` or only empty rows. Plus the checks the editor's proposals get: the shape of each
 * collection, wiring against an empty canvas and the hollow steps of a finished run (`hollowSteps`).
 */
export function emptyParts(draft: Pick<FlowDraft, 'nodes' | 'edges'>, byType: Map<string, NodeTypeInfo>): EmptyPart[] {
  const parts: EmptyPart[] = [];
  for (const n of draft.nodes) {
    const descriptor = byType.get(n.type)?.descriptor;
    if (!descriptor) continue;
    const parameters = n.parameters ?? {};
    const effective = withPropertyDefaults(descriptor.properties, parameters);
    for (const p of descriptor.properties) {
      if (p.type !== 'fixedCollection' || !p.groups?.length || !isPropertyVisible(p, effective)) continue;
      if (!collectionEmpty(p, parameters[p.name])) continue;
      if (!p.required && !NEEDED_LISTS.has(`${n.type}:${p.name}`) && collectionEmpty(p, p.default)) continue;
      parts.push({
        node: n.name,
        key: n.key,
        field: p.name,
        kind: 'empty',
        ask: `“${n.name}” (${n.type}): ${p.name} is empty. Write ${n.type === 'core.if' || n.type === 'core.filter' ? 'the condition' : n.type === 'core.set' ? 'the fields' : 'what'} the request asks for, in this shape: ${shapeOf(n.type, p)}`,
        left: `“${n.name}”: ${without(n.type, p)}`,
      });
    }
  }
  const workflow: Workflow = {
    id: 'draft',
    name: 'Draft',
    nodes: draft.nodes.map((n) => ({ id: n.key, name: n.name, type: n.type, typeVersion: 1, position: [0, 0], parameters: n.parameters ?? {} })),
    connections: draft.edges.map(([source, target, sourceIndex, type], i) => ({ id: `c${i}`, source, target, sourceIndex, targetIndex: 0, type })),
  };
  const empty: Workflow = { ...workflow, nodes: [], connections: [] };
  const lookup = (type: string) => byType.get(type)?.descriptor;
  for (const line of [...collectionWarnings(empty, workflow, lookup), ...structuralWarnings(empty, workflow, lookup)]) {
    parts.push({ node: '', key: '', kind: 'other', ask: line, left: '' });
  }
  const flagged = new Set(parts.filter((p) => p.kind === 'empty').map((p) => p.key));
  for (const hollow of hollowSteps(draft.nodes.map((n) => ({ name: n.name, type: n.type, parameters: n.parameters ?? {} })))) {
    const n = draft.nodes.find((x) => x.name === hollow.node);
    if (n && !flagged.has(n.key)) parts.push({ node: n.name, key: n.key, kind: 'empty', ask: `${hollow.problem}. Fill it as the request asks.`, left: `“${n.name}”: ${hollow.problem.replace(/^“[^”]*” /, '')}` });
  }
  return parts;
}

/** The line that sends a draft back: its first draft stays in the conversation, one line per empty part. */
function sendBack(parts: EmptyPart[]): string {
  return `That draft leaves parts empty or wrong:\n${parts.map((p) => `- ${p.ask}`).join('\n')}\nReply again with the complete workflow as one JSON object matching the schema, with every part above filled as the request asks. Keep everything else as it is.`;
}

/** The second draft stands in for the first only when it keeps every step type the first had. */
function keepsTypes(first: Assembled, next: Assembled): boolean {
  const count = (nodes: DraftNode[]) => nodes.reduce((m, n) => m.set(n.type, (m.get(n.type) ?? 0) + 1), new Map<string, number>());
  const have = count(next.nodes);
  return [...count(first.nodes)].every(([type, n]) => (have.get(type) ?? 0) >= n);
}

const READ_OPERATION = /^(get|getall|list|search|find|read|fetch|query)/i;

/**
 * SB01: where the test items are pinned. A webhook, form or manual trigger: on itself. An app trigger (a plugin's
 * trigger node): on itself, since its output is the app's event. A schedule: on the app step after it that reads data,
 * so a test runs on sample records instead of needing the app; a schedule's own item is only a time, so otherwise none.
 */
/** Whether test data is pinned on the trigger itself (a webhook, form or manual trigger, or an app's own trigger). */
export function pinsOnTrigger(type: string, info: NodeTypeInfo | undefined): boolean {
  return PINNED_TRIGGERS.has(type) || Boolean(info && info.pluginId !== 'core' && info.descriptor.kind === 'trigger');
}

function pinTarget(draft: Assembled, byType: Map<string, NodeTypeInfo>): DraftNode | undefined {
  const { trigger, nodes, edges } = draft;
  if (!trigger) return undefined;
  if (pinsOnTrigger(trigger.type, byType.get(trigger.type))) return trigger;
  if (trigger.type !== 'core.schedule') return undefined;
  return edges
    .filter(([from, , , type]) => from === trigger.key && type === 'main')
    .map(([, to]) => nodes.find((n) => n.key === to))
    .find((n) => {
      const step = n && byType.get(n.type);
      return step && step.pluginId !== 'core' && step.descriptor.kind === 'action' && READ_OPERATION.test(String(n.parameters?.operation ?? step.descriptor.properties.find((p) => p.name === 'operation')?.default ?? ''));
    });
}

/**
 * `teams` and `agents`: the published agent teams and agents the caller can see, so a step that needs an agent runs one
 * that fits, and a Run a Team or Run an Agent node gets a real one (by id, never a guess).
 */
export async function buildFlow(prompt: string, model = DEFAULT_MODEL, teams: readonly TeamBrief[] = [], agents: readonly AgentBrief[] = [], options: { types?: NodeTypeInfo[] } = {}): Promise<FlowDraft> { // SB02: the workflow's allowed types
  const types = options.types ?? registry.nodeTypes().filter((t) => t.available); // SB02: same as availableTypes(), with no new import
  const byType = new Map(types.map((t) => [t.type, t]));
  const teamsNote = byType.has('core.runTeam') && teams.length ? `\n\nPublished agent teams (core.runTeam: put the team's teamId in teamId, never its name):\n${describeTeams([...teams])}` : '';
  const started = Date.now();
  const timeoutMs = builderTimeoutMs();
  const agentsNote = byType.has('core.messageAgent') && agents.length ? `\n\nYour agents (core.messageAgent: put the agent's agentId in agentId, never its name):\n${describeAgents(agents)}` : '';
  const request = `Node catalog:\n${catalog(types)}${agentsNote}${teamsNote}\n\nBuild this workflow:\n${prompt}`;
  // SB01: the first reply (sent back once when it does not parse), then the draft checked and sent back once.
  const messages: DraftMessage[] = [{ role: 'user', content: request }];
  const first = await parsedReply(model, messages, timeoutMs, started);
  let reply = first.reply;
  let draft = assemble(reply, byType, teams, agents);
  const empty = emptyParts(draft, byType);
  const budget = timeoutMs - (Date.now() - started);
  if (empty.length && budget > 0) {
    try {
      const again = parseReply(await askModel(model, [...messages, { role: 'assistant', content: first.text }, { role: 'user', content: sendBack(empty) }], budget));
      if (again.ok) {
        const next = assemble(again.reply, byType, teams, agents);
        // The second draft stands in only when it keeps the first one's steps and is no worse.
        if (keepsTypes(draft, next) && emptyParts(next, byType).length <= empty.length) {
          reply = again.reply;
          draft = next;
        }
      }
    } catch {
      // The first draft stands: a failed send-back is no reason to lose it.
    }
  }
  const { nodes, edges, dropped } = draft;
  const left = mergeLeft(
    draft.left,
    emptyParts(draft, byType)
      .filter((p) => p.kind === 'empty')
      .map((p): DraftLeft => ({ node: p.node, field: p.field, kind: 'empty', text: p.left })),
  );
  const target = pinTarget(draft, byType);
  const testItems = (cleanTestItems(asItems(reply.testData), target, nodes) ?? sampleItems(target, nodes))?.slice(0, nodes.some((n) => AGENT_TYPES.has(n.type)) ? 1 : undefined);
  const pinData = target && testItems ? { [target.key]: testItems } : undefined;
  return { name: (reply.name ?? 'Generated workflow').slice(0, 80), nodes, edges, pinData, model, durationMs: Date.now() - started, dropped, left };
}
