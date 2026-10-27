/**
 * The builder chat: a multi-turn tool-calling loop (at most 8 model calls per
 * message) that can search the node catalog, read node docs, the workflow and
 * the last run's data, and propose changes. Proposals are validated edit
 * operations the user applies in the editor; the chat never edits the
 * workflow itself. Events stream to the caller as they happen.
 */
import { nanoid } from 'nanoid';
import type { AgentMessage, LanguageModel, ToolCall, ToolResult, ToolSpec } from '@landflow/engine';
import type { AssistantOp, RunDigest } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { PARAMETER_FORMATS } from '../flow-builder';
import { recordSuggestions, traceAssistant } from '../telemetry/assistant';
import { assistantModel, modelLabel } from './model';
import { registryLookup, validateOps } from './ops';
import { availableTypes, catalogSummary, nodeContext, nodeDocs, searchNodes, workflowOutline } from './research';

export const MAX_STEPS = 8;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; label: string; ok: boolean }
  | { type: 'proposal'; id: string; summary: string; ops: AssistantOp[]; dropped: string[]; warnings: string[] }
  | { type: 'done'; model: string; durationMs: number; steps: number; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; message: string };

export interface ChatInput {
  messages: ChatTurn[];
  workflow: Workflow;
  selectedNodeId?: string;
  /** Last main run of each node, by node id. */
  runs?: Record<string, RunDigest>;
  model?: string | LanguageModel;
  /** The node types proposals may use (default: every type online). The route passes the workflow's allowed ones. */
  types?: NodeTypeInfo[];
  /** Nodes (by id) and node types the user tagged in the message with Spotlight's bubbles. */
  mentions?: { nodes?: string[]; types?: string[] };
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
}

const OP_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['addNode', 'setParameters', 'connect', 'disconnect', 'removeNode', 'renameNode'] },
    ref: { type: 'string', description: 'addNode: handle for this new node in later ops' },
    type: { type: 'string', description: 'addNode: node type id. connect/disconnect: main, ai_languageModel, ai_memory or ai_tool' },
    name: { type: 'string', description: 'addNode: node name. renameNode: the new name' },
    parameters: { type: 'object', description: 'addNode / setParameters: parameter values (merged)' },
    after: { type: 'string', description: 'addNode: existing node name or ref to wire the new node after' },
    before: { type: 'string', description: 'addNode: insert the new node in front of this node (what fed it feeds the new node)' },
    output: { type: 'integer', description: 'Output index of the source (If: 0 = true, 1 = false)' },
    node: { type: 'string', description: 'setParameters / removeNode / renameNode: node name' },
    from: { type: 'string' },
    to: { type: 'string' },
  },
  required: ['op'],
};

const TOOLS: ToolSpec[] = [
  {
    name: 'search_nodes',
    description: 'Search the node catalog by keywords (e.g. "google sheets", "dedupe", "send message"). Returns type ids, names and descriptions.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_node_docs',
    description: 'Read a node type\'s docs: parameters with options, defaults and when they show, ports and credentials. Takes a type id, or the name of a node in the workflow.',
    inputSchema: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] },
  },
  {
    name: 'get_workflow',
    description: 'Read the current workflow: nodes with their parameters, connections, and which nodes have run data. Includes changes you proposed earlier in this reply.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_run_data',
    description: 'Read what a node received and produced in the last run (first items), its error and its parameters.',
    inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'Node name' } }, required: ['node'] },
  },
  {
    name: 'propose_changes',
    description: 'Show the user a change to the workflow to review and apply. Use one call per coherent change. Refer to existing nodes by name.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line: what the change does' },
        ops: { type: 'array', items: OP_SCHEMA },
      },
      required: ['summary', 'ops'],
    },
  },
];

const SYSTEM = `You are the Landflow assistant inside the workflow editor. Landflow is an n8n-like automation tool: nodes joined by connections, JSON items flowing left to right.

You help the user build and fix the workflow open in the editor. Tools:
- search_nodes finds node types for a task. Search before using a type you haven't seen in this conversation.
- get_node_docs gives a type's parameters. Read it before setting parameters.
- get_workflow and get_run_data show the workflow and what nodes received and produced in the last run.
- propose_changes puts concrete edits in front of the user, who reviews and applies them. You never change the workflow yourself.

How to work:
- Research, then propose. Use exact type ids and parameter names from the docs.
- One proposal per coherent change ("Add a Slack message after the filter"); several proposals in one reply are fine.
- To fix a node's input, prefer changing the node's own parameters (read a field the items have). To put a node between two nodes, use addNode with "before": "<the later node>".
- ops: {"op":"addNode","ref":"r1","type":"<type id>","name":"Short name","parameters":{…},"after":"<node name or ref>","output":0} (or "before":"<node name>" to insert it in front of a node, rewiring what fed that node), {"op":"setParameters","node":"<name>","parameters":{…}}, {"op":"connect","from":"<name or ref>","to":"<name or ref>","output":0,"type":"main"}, {"op":"disconnect","from":"…","to":"…"}, {"op":"removeNode","node":"…"}, {"op":"renameNode","node":"…","name":"…"}. A new workflow starts with a trigger (core.manualTrigger unless the user wants a webhook, schedule or chat). Sub-nodes (chat models, memory, tools) attach to an AI Agent with "after": "<agent>" or connect with type ai_languageModel / ai_memory / ai_tool.
- Expressions read the current item with "{{ $json.field }}" and other nodes with "{{ $('Node name').item.json.field }}".
- Never make up ids, channels, email addresses, URLs or keys the user didn't give: leave those parameters empty and say the user fills them in.
- After proposing, say in one or two sentences what it does and what the user still has to do (click Apply, pick a credential, run it). Nothing is applied yet: never say the change was applied or made. Don't repeat the ops in prose.
- When no change is needed, just answer. Be brief and concrete: your text shows in a small panel at the bottom of the canvas, so one to three short sentences, no headings or lists unless asked.
- Use only node types from the catalog below and search_nodes; anything else is not installed, offline or not allowed in this workflow.

${PARAMETER_FORMATS}`;

const shorten = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The ops argument as the model sent it: an array, or a JSON string of one. */
function opsArgument(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const ID_PARAMETER = /^id$|[a-z]Ids?$/;

/**
 * An id the conversation, the workflow, its runs and the node type's own options never mention (a Slack channel, a
 * sheet, a user) can only have been made up: local models write plausible ones. Those parameters are left out, so the
 * user fills them in. `typeText` gives the node type's properties for an op (defaults and fixed options are known).
 */
export function withoutInventedIds(ops: unknown, known: string, typeText: (op: Record<string, unknown>) => string = () => ''): { ops: unknown; invented: string[] } {
  if (!Array.isArray(ops)) return { ops, invented: [] };
  const invented: string[] = [];
  const clean = (op: Record<string, unknown>, node: unknown, parameters: unknown) => {
    if (!parameters || typeof parameters !== 'object') return parameters;
    const out = { ...(parameters as Record<string, unknown>) };
    for (const [key, value] of Object.entries(out)) {
      if (!ID_PARAMETER.test(key) || typeof value !== 'string' || !value.trim() || value.includes('{{') || known.includes(value) || typeText(op).includes(JSON.stringify(value))) continue;
      delete out[key];
      invented.push(`${key} of “${String(node)}”: an id nobody gave, left for the user to fill in`);
    }
    return out;
  };
  const cleaned = ops.map((op) => {
    if (!op || typeof op !== 'object') return op;
    const o = op as Record<string, unknown>;
    if (o.op === 'addNode') return { ...o, parameters: clean(o, o.name ?? o.type, o.parameters) };
    if (o.op === 'setParameters') return { ...o, parameters: clean(o, o.node, o.parameters) };
    return op;
  });
  return { ops: cleaned, invented };
}

const DONE = 'updated|added|applied|inserted|connected|removed|deleted|changed|modified|created|configured|replaced|renamed';
// A sentence may open with a past tense ("Added a Slack node"), not with "Set up", which is also an instruction.
const APPLIED_CLAIM = new RegExp(
  `^(?:${DONE})\\b|\\b(?:has|have) (?:now )?been (?:${DONE}|set up|made)\\b|\\bI(?:'ve| have)?(?: just| now)? (?:${DONE}|set up|made)\\b|\\bis now (?:connected|added|configured|in place)\\b|\\bis (?:now )?ready to\\b|\\bnow (?:has|have|contains|includes)\\b`,
  'i',
);
const LIST_MARKER = /^\s*(?:\d+[.)]|[-*•])\s*/;

/**
 * Local models sometimes say a proposed change "has been added" although nothing changes until the user clicks Apply.
 * In a reply that proposed something those sentences are dropped, so the panel never says a change was made. Lines
 * and list items keep their layout; a list number stays with its item.
 */
export function withoutAppliedClaims(text: string): string {
  let dropped = false;
  const lines = text.split('\n');
  const kept = lines.map((line) => {
    const sentences = line.split(/(?<=[^\d\s][.!?])\s+/);
    const left = sentences.filter((sentence) => !APPLIED_CLAIM.test(sentence.replace(LIST_MARKER, '')));
    if (left.length !== sentences.length) dropped = true;
    return left.join(' ');
  });
  if (!dropped) return text;
  const out = kept
    .filter((line, i) => line.trim() || !lines[i].trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out || 'Review the change on the card, then click Apply to make it.';
}

/**
 * Local models (qwen3-coder in particular) sometimes write a tool call as text,
 * `<function=name><parameter=key>value</parameter></function>`, instead of a
 * structured one. Read those back so the turn still works.
 */
export function recoverToolCalls(text: string): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const rest = text
    .replace(/<function=([\w-]+)>([\s\S]*?)<\/function>/g, (whole, name: string, body: string) => {
      if (!TOOL_NAMES.has(name)) return whole;
      const input: Record<string, unknown> = {};
      for (const [, key, value] of body.matchAll(/<parameter=([\w-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) {
        try {
          input[key] = JSON.parse(value);
        } catch {
          input[key] = value;
        }
      }
      calls.push({ id: `call_text_${Date.now().toString(36)}_${calls.length}`, name, input });
      return '';
    })
    .replace(/<\/?tool_call>/g, '')
    .trim();
  return calls.length ? { text: rest, calls } : { text, calls };
}

export async function runChat(input: ChatInput): Promise<void> {
  const { onEvent, runs = {} } = input;
  const types = input.types ?? availableTypes();
  const lookup = registryLookup(types);
  const model = assistantModel(input.model);
  const started = Date.now();
  /** The workflow plus what was proposed so far in this reply: later proposals build on earlier ones. */
  let working = input.workflow;
  /** Whether an incomplete proposal was already sent back to the model in this reply. */
  let sentBack = false;
  let proposed = false;
  /** What the user and the editor said, for telling a given id from a made-up one. */
  const known = () => [...input.messages.map((m) => m.content), JSON.stringify(working), JSON.stringify(runs)].join('\n');
  const usage = { inputTokens: 0, outputTokens: 0 };

  const nodeByName = (name: string) => working.nodes.find((n) => n.name === name) ?? working.nodes.find((n) => n.name.toLowerCase() === name.toLowerCase() || n.id === name);
  const selected = input.selectedNodeId && working.nodes.find((n) => n.id === input.selectedNodeId);
  const tagged = [
    ...(input.mentions?.nodes ?? []).flatMap((id) => working.nodes.filter((n) => n.id === id)).map((n) => `- the node “${n.name}” (${n.type})`),
    ...(input.mentions?.types ?? []).flatMap((type) => types.filter((t) => t.type === type)).map((t) => `- the node type ${t.descriptor.displayName} (${t.type}): ${t.descriptor.description.slice(0, 120)}`),
  ];
  const system = [
    SYSTEM,
    `\nApps and plugins this workflow can use (search_nodes for the rest):\n${catalogSummary(types)}`,
    `\nThe editor now:\n${workflowOutline(working, runs)}`,
    selected ? `\nThe user has “${selected.name}” selected:\n${nodeContext(working, selected.id, runs[selected.id], types)}` : '',
    tagged.length ? `\nThe user tagged in the message:\n${tagged.join('\n')}` : '',
  ].join('\n');

  const execute = async (call: ToolCall): Promise<ToolResult> => {
    const result = (content: string, label: string, ok = true): ToolResult => {
      onEvent({ type: 'tool', name: call.name, label, ok });
      return { id: call.id, name: call.name, content, ...(!ok && { isError: true }) };
    };
    const args = call.input ?? {};
    switch (call.name) {
      case 'search_nodes': {
        const query = String(args.query ?? '');
        const hits = searchNodes(query, types);
        return result(hits.length ? JSON.stringify(hits.map(({ score: _score, ...hit }) => hit)) : `No node types match “${query}”. Try other words.`, `Searched nodes for “${shorten(query, 40)}”`);
      }
      case 'get_node_docs': {
        const asked = String(args.type ?? args.node ?? '');
        const existing = nodeByName(asked);
        const info = types.find((t) => t.type === (existing?.type ?? asked)) ?? types.find((t) => t.descriptor.displayName.toLowerCase() === asked.toLowerCase());
        if (!info) {
          const close = searchNodes(asked, types, 3).map((h) => h.type);
          return result(`Unknown node type “${asked}”.${close.length ? ` Did you mean: ${close.join(', ')}?` : ''}`, `Looked up “${shorten(asked, 40)}”: not found`, false);
        }
        return result(nodeDocs(info, existing?.parameters), `Read ${info.descriptor.displayName} docs`);
      }
      case 'get_workflow':
        return result(workflowOutline(working, runs), 'Read the workflow');
      case 'get_run_data': {
        const node = nodeByName(String(args.node ?? ''));
        if (!node) return result(`No node named “${String(args.node ?? '')}”. Nodes: ${working.nodes.map((n) => n.name).join(', ')}`, `Looked for “${shorten(String(args.node ?? ''), 40)}”: not found`, false);
        return result(nodeContext(working, node.id, runs[node.id], types), `Read run data of “${shorten(node.name, 40)}”`);
      }
      case 'propose_changes': {
        const summary = shorten(String(args.summary ?? '').trim() || 'Proposed change', 140);
        const typeText = (op: Record<string, unknown>) => {
          const type = op.op === 'addNode' ? String(op.type ?? '') : nodeByName(String(op.node ?? ''))?.type;
          const info = types.find((t) => t.type === type);
          return info ? JSON.stringify(info.descriptor.properties) : '';
        };
        const { ops: proposedOps, invented } = withoutInventedIds(opsArgument(args.ops), known(), typeText);
        const validated = validateOps(working, proposedOps, lookup);
        if (!validated.ops.length) {
          const why = [...validated.dropped, ...invented].join('; ') || 'no changes given';
          return result(`Nothing could be proposed: ${why}. Fix the ops (check names, type ids and parameters) and call propose_changes again.`, `Proposal rejected: ${shorten(why, 80)}`, false);
        }
        // Proposing the same thing twice (it happens with local models) changes nothing the second time.
        const graph = (wf: Workflow) => JSON.stringify([wf.nodes, wf.connections]);
        if (graph(validated.workflow) === graph(working)) {
          return result('Nothing changes: this is already in the workflow or was proposed above. Do not propose it again.', 'Skipped a repeated proposal');
        }
        // A change that leaves part of the flow dangling goes back once for the model to complete.
        if (validated.warnings.length && !sentBack) {
          sentBack = true;
          const why = validated.warnings.join('; ');
          return result(
            `Not shown yet: this change leaves ${why}. To put a new node in front of an existing one, use addNode with "before": "<that node>" (it rewires the input for you) instead of "after" plus connect. Otherwise add the missing connect/disconnect ops. Then call propose_changes again with the complete change.`,
            `Proposal incomplete: ${shorten(why, 80)}`,
            false,
          );
        }
        working = validated.workflow;
        const dropped = [...validated.dropped, ...validated.ignored, ...invented];
        const notes = dropped.length ? ` Left out: ${dropped.join('; ')}.` : '';
        const count = `${validated.ops.length} change${validated.ops.length === 1 ? '' : 's'}`;
        const shown = result(`Shown to the user as a card with an Apply button (${count}); nothing changes until they click it.${notes} Don't list the changes again, ask whether to apply them, or say they are applied.`, `Proposed ${count}`);
        onEvent({ type: 'proposal', id: `pr_${nanoid(8)}`, summary, ops: validated.ops, dropped, warnings: validated.warnings });
        proposed = true;
        recordSuggestions(['proposal']);
        return shown;
      }
      default:
        return result(`Unknown tool ${call.name}`, `Unknown tool ${call.name}`, false);
    }
  };

  await traceAssistant('chat', { 'landflow.workflow.id': input.workflow.id, 'gen_ai.request.model': model.model, 'landflow.assistant.turns': input.messages.length }, async (span) => {
    const history: AgentMessage[] = input.messages.map((m) => (m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', text: m.content, toolCalls: [] }));
    let steps = 0;
    let finished = false;
    while (steps < MAX_STEPS && !finished) {
      steps++;
      const turn = await model.generate({ system, messages: history, tools: TOOLS, ...(input.signal && { signal: input.signal }) });
      usage.inputTokens += turn.usage?.inputTokens ?? 0;
      usage.outputTokens += turn.usage?.outputTokens ?? 0;
      const { text, calls } = turn.toolCalls.length ? { text: turn.text, calls: turn.toolCalls } : recoverToolCalls(turn.text);
      const proposing = proposed || calls.some((call) => call.name === 'propose_changes');
      if (text.trim()) onEvent({ type: 'text', text: proposing ? withoutAppliedClaims(text.trim()) : text.trim() });
      history.push({ role: 'assistant', text, toolCalls: calls, ...(turn.raw && { raw: turn.raw }) });
      finished = !calls.length;
      if (finished) break;
      const results: ToolResult[] = [];
      for (const call of calls) {
        const outcome = await execute(call);
        span.addEvent('assistant.tool', { 'gen_ai.tool.name': call.name, 'landflow.outcome': outcome.isError ? 'error' : 'ok' });
        results.push(outcome);
      }
      history.push({ role: 'tool', results });
    }
    if (!finished) onEvent({ type: 'text', text: `(Stopped after ${MAX_STEPS} steps. Ask me to continue if there is more to do.)` });
    span.setAttribute('landflow.assistant.steps', steps);
    onEvent({ type: 'done', model: modelLabel(model), durationMs: Date.now() - started, steps, usage });
  });
}
