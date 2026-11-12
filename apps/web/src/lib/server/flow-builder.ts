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
}

const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
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

/** The draft as text from Ollama's chat API, held to SCHEMA by its `format`. */
async function draftWithOllama(model: string, request: string, timeoutMs: number): Promise<string> {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: request },
      ],
    }),
  }).catch((e: Error) => {
    // A timeout means Ollama answered too slowly, not that it is down: say so, and what to change.
    if (e.name === 'TimeoutError') {
      throw new Error(`${model} on Ollama at ${OLLAMA_URL} did not finish the draft within ${timeoutMs / 1000} s. The model may be slow or still loading: raise LANDFLOW_BUILDER_TIMEOUT_SECONDS, or set a faster LANDFLOW_BUILDER_MODEL`);
    }
    throw new Error(`Could not reach Ollama at ${OLLAMA_URL}: ${e.message}`);
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
async function draftWithProvider(model: string, request: string, timeoutMs: number): Promise<string> {
  const [provider, ...rest] = model.split('/');
  // A whole draft needs more room than the assistant's 4096 tokens; non-streaming, so ~16000 keeps under SDK timeouts.
  // `fallback`: a refused draft is retried server-side on another model (Anthropic's `fallbacks: "default"`).
  const llm = provider === 'anthropic' ? anthropicModel({ model: rest.join('/'), effort: 'medium', maxTokens: 16_000, fallback: true }) : assistantModel(model);
  const system = `${SYSTEM}\n\nAnswer with one JSON object and nothing else (no prose, no code fence), matching this JSON schema:\n${JSON.stringify(SCHEMA)}`;
  try {
    const turn = await llm.generate({ system, messages: [{ role: 'user', content: request }], tools: [], responseFormat: 'json', signal: AbortSignal.timeout(timeoutMs) });
    if (turn.stopReason === 'refusal') throw new Error(`${model} declined to draft this workflow: ${turn.text}`);
    return turn.text;
  } catch (e) {
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      throw new Error(`${model} did not finish the draft within ${timeoutMs / 1000} s: raise LANDFLOW_BUILDER_TIMEOUT_SECONDS`);
    }
    throw e;
  }
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

/**
 * `teams` and `agents`: the published agent teams and agents the caller can see, so a step that needs an agent runs one
 * that fits, and a Run a Team or Run an Agent node gets a real one (by id, never a guess).
 */
export async function buildFlow(prompt: string, model = DEFAULT_MODEL, teams: readonly TeamBrief[] = [], agents: readonly AgentBrief[] = []): Promise<FlowDraft> {
  const types = registry.nodeTypes().filter((t) => t.available);
  const byType = new Map(types.map((t) => [t.type, t]));
  const teamsNote = byType.has('core.runTeam') && teams.length ? `\n\nPublished agent teams (core.runTeam: put the team's teamId in teamId, never its name):\n${describeTeams([...teams])}` : '';
  const started = Date.now();
  const timeoutMs = builderTimeoutMs();
  const agentsNote = byType.has('core.messageAgent') && agents.length ? `\n\nYour agents (core.messageAgent: put the agent's agentId in agentId, never its name):\n${describeAgents(agents)}` : '';
  const request = `Node catalog:\n${catalog(types)}${agentsNote}${teamsNote}\n\nBuild this workflow:\n${prompt}`;
  const content = /^(anthropic|openai)\//.test(model) ? await draftWithProvider(model, request, timeoutMs) : await draftWithOllama(model, request, timeoutMs);
  let raw: { name?: string; nodes?: unknown[]; connections?: unknown[]; testData?: unknown };
  try {
    raw = JSON.parse(jsonOf(content));
  } catch {
    throw new Error('The model did not return valid JSON. Try again or rephrase.');
  }

  const dropped: string[] = [];
  const nodes: DraftNode[] = [];
  const keys = new Set<string>();
  for (const entry of raw.nodes ?? []) {
    const n = entry as { key?: string; type?: string; name?: string; parameters?: Record<string, unknown> };
    const info = n.type ? byType.get(n.type) : undefined;
    if (!info || !n.key || keys.has(n.key)) {
      dropped.push(`node ${n.name ?? n.type ?? '?'} (${n.type ?? 'no type'})`);
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
  for (const entry of raw.connections ?? []) {
    const c = entry as { from?: string; to?: string; output?: number; type?: ConnectionType };
    const type: ConnectionType = c.type ?? 'main';
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
  const testItems = (cleanTestItems(asItems(raw.testData), trigger, nodes) ?? sampleItems(trigger, nodes))?.slice(0, nodes.some((n) => AGENT_TYPES.has(n.type)) ? 1 : undefined);
  const pinData = trigger && PINNED_TRIGGERS.has(trigger.type) && testItems ? { [trigger.key]: testItems } : undefined;
  return { name: (raw.name ?? 'Generated workflow').slice(0, 80), nodes, edges, pinData, model, durationMs: Date.now() - started, dropped };
}
