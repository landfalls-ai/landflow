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
import { compositeOutline } from '../composites';
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
  /**
   * The message comes from Spotlight's test-and-fix session, which applies proposals and runs the workflow itself:
   * `fix` asks for a fix (a reply that proposes nothing is sent back once), `review` whether a run did what was asked.
   */
  session?: 'fix' | 'review';
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
- propose_changes puts concrete edits in front of the user, who reviews and applies them. You never change the workflow yourself, and writing about a change doesn't propose it: only a propose_changes call does.

How to work:
- Research, then propose. Use exact type ids and parameter names from the docs.
- One proposal per coherent change ("Add a Slack message after the filter"); several proposals in one reply are fine.
- To fix a node's input, prefer changing the node's own parameters (read a field the items have). To put a node between two nodes, use addNode with "before": "<the later node>".
- ops: {"op":"addNode","ref":"r1","type":"<type id>","name":"Short name","parameters":{…},"after":"<node name or ref>","output":0} (or "before":"<node name>" to insert it in front of a node, rewiring what fed that node), {"op":"setParameters","node":"<name>","parameters":{…}}, {"op":"connect","from":"<name or ref>","to":"<name or ref>","output":0,"type":"main"}, {"op":"disconnect","from":"…","to":"…"}, {"op":"removeNode","node":"…"}, {"op":"renameNode","node":"…","name":"…"}. A new workflow starts with a trigger (core.manualTrigger unless the user wants a webhook, schedule or chat). Sub-nodes (chat models, memory, tools) attach to an AI Agent with "after": "<agent>" or connect with type ai_languageModel / ai_memory / ai_tool.
- Expressions read the current item with "{{ $json.field }}" and other nodes with "{{ $('Node name').item.json.field }}".
- Never make up ids, channels, email addresses, URLs or keys the user didn't give: leave those parameters empty and say the user fills them in.
- After proposing, say in one or two sentences what it does and what the user still has to do (click Apply, pick a credential, run it). Nothing is applied yet: never say the change was applied or made. Don't repeat the ops in prose.
- When asked whether a test run's result does what the user asked for, read the output of the last step with get_run_data and compare it with the request: if it falls short (wrong items, a filter that keeps everything, fields missing), propose the change; if it does what was asked, say so in one sentence and propose nothing.
- When a message reports a failed test run, read the failing node's run data with get_run_data, find the cause and propose the smallest change that fixes it, without asking first. If only the user can fix it (a credential, an id, an account), say what to do in one sentence and propose nothing.
- When no change is needed, just answer. Be brief and concrete: your text shows in a small panel at the bottom of the canvas, so one to three short sentences, no headings or lists unless asked.
- Use only node types from the catalog below and search_nodes; anything else is not installed, offline or not allowed in this workflow.

${PARAMETER_FORMATS}`;

const SESSION = 'This message comes from Spotlight\'s test-and-fix session: it applies your proposal and runs the workflow again by itself. Never ask the user to click Apply or to run it.';

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
export function withoutInventedIds(ops: unknown, known: string, typeText: (op: Record<string, unknown>) => string = () => ''): { ops: unknown; invented: string[]; values: string[] } {
  if (!Array.isArray(ops)) return { ops, invented: [], values: [] };
  const invented: string[] = [];
  const values: string[] = [];
  const clean = (op: Record<string, unknown>, node: unknown, parameters: unknown) => {
    if (!parameters || typeof parameters !== 'object') return parameters;
    const out = { ...(parameters as Record<string, unknown>) };
    for (const [key, value] of Object.entries(out)) {
      if (!ID_PARAMETER.test(key) || typeof value !== 'string' || !value.trim() || value.includes('{{') || known.includes(value) || typeText(op).includes(JSON.stringify(value))) continue;
      delete out[key];
      invented.push(`${key} of “${String(node)}”: an id nobody gave, left for the user to fill in`);
      values.push(value);
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
  return { ops: cleaned, invented, values };
}

/** An id-like token in prose: a capital, then 8 or more capitals, digits, `_` or `-`, with a digit among them (C057L43652P). */
const ID_TOKEN = /\b(?=[A-Z\d_-]*\d)[A-Z][A-Z\d_-]{8,}\b/g;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The reply's text gets the same check as proposals: an id that nobody gave (one left out of a proposal, or an id-like
 * token the conversation, the workflow and its runs never mention) is not repeated as if it were real. In brackets it
 * goes; anywhere else it reads "the right id".
 */
export function withoutMadeUpIds(text: string, known: string, invented: Iterable<string> = []): string {
  const made = new Set([...invented].filter((value) => value.length >= 6 && /\d/.test(value)));
  for (const token of text.match(ID_TOKEN) ?? []) if (!known.includes(token)) made.add(token);
  let out = text;
  for (const value of made) {
    const id = `[“"'\`]?${escapeRegExp(value)}[”"'\`]?`;
    out = out.replace(new RegExp(`\\s*\\(\\s*${id}\\s*\\)`, 'g'), '').replace(new RegExp(id, 'g'), 'the right id');
  }
  return out;
}

const SENTENCE = /(?<=[^\d\s][.!?])\s+/;
const LIST_MARKER = /^\s*(?:\d+[.)]|[-*•])\s*/;

/** Drop the sentences `drop` picks, keeping lines and list items in place. Undefined when nothing was dropped. */
function dropSentences(text: string, drop: (sentence: string) => boolean): string | undefined {
  let dropped = false;
  const lines = text.split('\n');
  const kept = lines.map((line) => {
    const sentences = line.split(SENTENCE);
    const left = sentences.filter((sentence) => !drop(sentence.replace(LIST_MARKER, '')));
    if (left.length !== sentences.length) dropped = true;
    return left.join(' ');
  });
  if (!dropped) return undefined;
  return kept
    .filter((line, i) => line.trim() || !lines[i].trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DONE = 'updated|added|applied|inserted|connected|removed|deleted|changed|modified|created|configured|replaced|renamed|fixed';
// A sentence may open with a past tense ("Added a Slack node"), not with "Set up", which is also an instruction.
const APPLIED_CLAIM = new RegExp(
  `^(?:${DONE})\\b|\\b(?:has|have) (?:now )?been (?:${DONE}|set up|made)\\b|\\bI(?:'ve| have)?(?: just| now)? (?:${DONE}|set up|made)\\b|\\bis now (?:connected|added|configured|in place)\\b|\\bis (?:now )?ready to\\b|\\bnow (?:has|have|contains|includes)\\b|\\b(?:was|were) (?:${DONE}|set up)\\b|\\bwill now\\b|\\bnow (?:posts|sends|runs|writes|saves|calls|replies|returns|uses|keeps|filters)\\b`,
  'i',
);

/**
 * Local models sometimes say a proposed change "has been added" (or "the workflow will now post…") although nothing
 * changes until the user clicks Apply. In a reply that proposed something those sentences are dropped, so the panel
 * never says a change was made. Lines and list items keep their layout; a list number stays with its item.
 */
export function withoutAppliedClaims(text: string): string {
  const out = dropSentences(text, (sentence) => APPLIED_CLAIM.test(sentence));
  if (out === undefined) return text;
  return out || 'Review the change on the card, then click Apply to make it.';
}

/** The notes the conversation history gives of earlier proposals and test runs ("[Proposed “…”: applied]"). */
const ECHOED_NOTE = /^[ \t]*\[(?:Proposed “[^”]*”|Test run \d+ \w+): [^\]\n]*\][ \t]*(?:\n|$)/gm;

/** A local model may copy those notes into its text as if writing one made a change: they are left out. */
export function withoutEchoedNotes(text: string): string {
  return text.replace(ECHOED_NOTE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Content words (four letters or more, a plural "s" off) for telling a repeated sentence. */
const contentWords = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\d][\p{L}\d'-]*/gu) ?? []).map((w) => w.replace(/'s$/, '').replace(/s$/, '')).filter((w) => w.length >= 4));

/**
 * A local model often answers, calls a tool to check, then answers again in other words. A later sentence whose
 * content words (six or more) were nearly all said earlier in the same reply is left out.
 */
export function withoutRepeats(text: string, earlier: string): string {
  if (!earlier.trim()) return text;
  const said = contentWords(earlier);
  const plain = (sentence: string) => sentence.toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim();
  const sentences = new Set(earlier.split('\n').flatMap((line) => line.split(SENTENCE)).map(plain));
  return (
    dropSentences(text, (sentence) => {
      if (plain(sentence).length > 12 && sentences.has(plain(sentence))) return true;
      const own = [...contentWords(sentence)];
      return own.length >= 6 && own.filter((w) => said.has(w)).length / own.length >= 0.8;
    }) ?? text
  );
}

const APPLY_REQUEST = /\bclick (?:on )?(?:the )?["“]?apply\b|\bapply (?:this|that|the|these|those|my)(?: \w+)? (?:change|fix|proposal)e?s?\b|\b(?:run|test) (?:the workflow|it) again\b/i;

/** A line that is only a JSON object: a tool call or its result written as text (`{"error": "No change needed"}`). */
const JSON_LINE = /^[ \t]*\{[^\n]*\}[ \t]*(?:\n|$)/gm;

/**
 * In a test-and-fix session Spotlight applies and runs by itself: "click Apply" and "run it again" are left out, and so
 * are lines that are only a JSON object (the session's text is a log of what happened, not a place for data).
 */
export function withoutApplyRequests(text: string): string {
  const prose = text.replace(JSON_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  return dropSentences(prose, (sentence) => APPLY_REQUEST.test(sentence)) ?? prose;
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
  /** Whether a fix request that proposed nothing was sent back for a proposal. */
  let pressed = false;
  /** The ops of each proposal so far, as sent: a model may send the same one again and again. */
  const sent = new Set<string>();
  /** What the user and the editor said, for telling a given id from a made-up one. */
  const known = () => [...input.messages.map((m) => m.content), JSON.stringify(working), JSON.stringify(runs)].join('\n');
  /** Ids left out of proposals as made up: the text doesn't repeat them either. */
  const invented = new Set<string>();
  /** The text shown so far in this reply, for leaving out what it says twice. */
  let said = '';
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
    working.groups?.some((g) => g.composite) ? `\nComposites (frames typed by a contract: fill their slots with matching nodes, keep their rules):\n${compositeOutline(working)}` : '',
    selected ? `\nThe user has “${selected.name}” selected:\n${nodeContext(working, selected.id, runs[selected.id], types)}` : '',
    tagged.length ? `\nThe user tagged in the message:\n${tagged.join('\n')}` : '',
    input.session ? `\n${SESSION}` : '',
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
        const asSent = JSON.stringify(opsArgument(args.ops));
        if (sent.has(asSent)) return result('Nothing changes: you proposed exactly this above. Do not propose it again.', 'Skipped a repeated proposal');
        const typeText = (op: Record<string, unknown>) => {
          const type = op.op === 'addNode' ? String(op.type ?? '') : nodeByName(String(op.node ?? ''))?.type;
          const info = types.find((t) => t.type === type);
          return info ? JSON.stringify(info.descriptor.properties) : '';
        };
        const { ops: proposedOps, invented: inventedNotes, values } = withoutInventedIds(opsArgument(args.ops), known(), typeText);
        for (const value of values) invented.add(value);
        const validated = validateOps(working, proposedOps, lookup);
        if (!validated.ops.length) {
          const why = [...validated.dropped, ...inventedNotes].join('; ') || 'no changes given';
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
        sent.add(asSent);
        const dropped = [...validated.dropped, ...validated.ignored, ...inventedNotes];
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
      if (text.trim()) {
        const own = withoutEchoedNotes(text);
        const claimsOff = proposing ? withoutAppliedClaims(own) : own;
        const shown = own && withoutMadeUpIds(withoutRepeats(input.session ? withoutApplyRequests(claimsOff) : claimsOff, said), known(), invented);
        said += `\n${text}`;
        if (shown.trim()) onEvent({ type: 'text', text: shown });
      }
      history.push({ role: 'assistant', text, toolCalls: calls, ...(turn.raw && { raw: turn.raw }) });
      finished = !calls.length;
      // Local models describe a fix without proposing it; a test-and-fix session needs the proposal.
      if (finished && input.session === 'fix' && !proposed && !pressed) {
        pressed = true;
        finished = false;
        history.push({ role: 'user', content: 'Nothing was proposed: only a propose_changes call changes the workflow. Call propose_changes with the fix now, or, if only I can fix it, say what to do in one sentence.' });
        continue;
      }
      if (finished) break;
      const results: ToolResult[] = [];
      for (const call of calls) {
        const outcome = await execute(call);
        span.addEvent('assistant.tool', { 'gen_ai.tool.name': call.name, 'landflow.outcome': outcome.isError ? 'error' : 'ok' });
        results.push(outcome);
      }
      history.push({ role: 'tool', results });
    }
    // A test-and-fix session goes on (or stops) by itself: "ask me to continue" would only be noise there.
    if (!finished && !input.session) onEvent({ type: 'text', text: `(Stopped after ${MAX_STEPS} steps. Ask me to continue if there is more to do.)` });
    span.setAttribute('landflow.assistant.steps', steps);
    onEvent({ type: 'done', model: modelLabel(model), durationMs: Date.now() - started, steps, usage });
  });
}
