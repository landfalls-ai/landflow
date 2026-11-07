/**
 * "Describe your workflow": a local model (Ollama) drafts a flow from the
 * live node catalog. The draft is validated against the registry: unknown
 * types, unknown parameters and impossible connections are dropped, and a
 * manual trigger is added when the model forgot one.
 */
import type { ConnectionType, NodeItem, NodeTypeInfo, PropertyDescriptor } from '@/lib/shared/types';
import { describeTeams, withTeamId, type TeamBrief } from '@/lib/shared/agent-teams';
import { registry } from './plugins/registry';
import { outputFields } from './assistant/research';

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
- testData: 2–4 realistic sample items the flow can be tested with when run manually (objects with the fields the flow reads); just 1 when the flow runs an agent or a team, since each item is a whole agent run.

${PARAMETER_FORMATS}`;

function describeProperty(p: PropertyDescriptor): string {
  const options = p.options?.map((o) => String(o.value)).slice(0, 8);
  const hint = p.description ? ` "${p.description.slice(0, 90)}"` : '';
  return `${p.name} (${p.type}${options?.length ? `: ${options.join('|')}` : ''}${p.default !== undefined && typeof p.default !== 'object' && p.default !== '' ? `, default ${JSON.stringify(p.default)}` : ''})${hint}`;
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

/** Nodes that run a whole agent (or team) session per item: a test run of a flow with one gets one sample item. */
const AGENT_TYPES = new Set(['core.aiAgent', 'core.messageAgent', 'core.runTeam', 'core.a2aAgent']);

function asItems(rows: unknown): NodeItem[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const items = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((json) => ({ json: json as NodeItem['json'] }));
  return items.length ? items.slice(0, 10) : undefined;
}

/** `teams`: the published agent teams the caller can see, so a Run a Team node gets a real team (by id, never a guess). */
export async function buildFlow(prompt: string, model = DEFAULT_MODEL, teams: readonly TeamBrief[] = []): Promise<FlowDraft> {
  const types = registry.nodeTypes().filter((t) => t.available);
  const byType = new Map(types.map((t) => [t.type, t]));
  const teamsNote = byType.has('core.runTeam') && teams.length ? `\n\nPublished agent teams (core.runTeam: put the team's teamId in teamId, never its name):\n${describeTeams([...teams])}` : '';
  const started = Date.now();
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Node catalog:\n${catalog(types)}${teamsNote}\n\nBuild this workflow:\n${prompt}` },
      ],
    }),
  }).catch((e: Error) => {
    throw new Error(`Could not reach Ollama at ${OLLAMA_URL}: ${e.message}`);
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { message?: { content?: string } };
  let raw: { name?: string; nodes?: unknown[]; connections?: unknown[]; testData?: unknown };
  try {
    raw = JSON.parse(body.message?.content ?? '{}');
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
    const parameters = info.type === 'core.runTeam' ? withTeamId(kept, teams) : kept;
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
  const testItems = asItems(raw.testData)?.slice(0, nodes.some((n) => AGENT_TYPES.has(n.type)) ? 1 : undefined);
  const pinData = trigger && trigger.type === 'core.manualTrigger' && testItems ? { [trigger.key]: testItems } : undefined;
  return { name: (raw.name ?? 'Generated workflow').slice(0, 80), nodes, edges, pinData, model, durationMs: Date.now() - started, dropped };
}
