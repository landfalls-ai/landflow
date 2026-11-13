/**
 * The builder chat: a multi-turn tool-calling loop (it goes on while its steps
 * make progress, up to MAX_STEPS model calls per message) that can search the node catalog, read node docs, the workflow and
 * the last run's data, and propose changes. Proposals are validated edit
 * operations the user applies in the editor; the chat never edits the
 * workflow itself. Events stream to the caller as they happen.
 */
import { nanoid } from 'nanoid';
import type { AgentMessage, LanguageModel, ToolCall, ToolResult, ToolSpec } from '@landflow/engine';
import type { AssistantOp, RunDigest } from '@/lib/shared/assistant-ops';
import { describeAgents, withAgentId, type AgentBrief } from '@/lib/shared/agent-brief';
import { describeTeams, withTeamId, type TeamBrief } from '@/lib/shared/agent-teams';
import type { NodeTypeInfo, PropertyDescriptor, Workflow } from '@/lib/shared/types';
import { compositeOutline } from '../composites';
import { PARAMETER_FORMATS } from '../flow-builder';
import { recordSuggestions, traceAssistant } from '../telemetry/assistant';
import { assistantModel, modelLabel } from './model';
import { redundantBranches, registryLookup, validateOps, withoutRepeatedAdds } from './ops';
import { availableTypes, catalogSummary, nodeContext, nodeDocs, searchNodes, workflowOutline } from './research';

/** The most model calls for one message. A reply stops sooner when two steps in a row add nothing new. */
export const MAX_STEPS = 20;
/** Steps in a row that add nothing new (no proposal, no tool result not seen before) before the reply stops. */
const MAX_STALLED = 2;

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
  /** The published agent teams the flow can run with a Run a Team node (docs/agent-teams.md). The route reads them from the store. */
  teams?: TeamBrief[];
  /** The published agents the flow can run with a Run an Agent node (docs/assistant.md#agents-and-teams). The route reads them from the store. */
  agents?: AgentBrief[];
  /**
   * Proposals from earlier replies that are still waiting (not applied, not dismissed). They count as part of the
   * workflow the model reads, and a new proposal that repeats one is dropped.
   */
  pending?: Array<{ summary: string; ops: unknown }>;
  /** Nodes (by id) and node types the user tagged in the message with Spotlight's bubbles. */
  mentions?: { nodes?: string[]; types?: string[] };
  /**
   * The message comes from Spotlight's test-and-fix session, which applies proposals and runs the workflow itself:
   * `fix` asks for a fix (a reply that proposes nothing is sent back once), `review` whether a run did what was asked.
   * `auto`: a message the person typed in autonomous mode, whose proposals Spotlight applies and tests as it ends.
   */
  session?: 'fix' | 'review' | 'auto';
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
}

const OP_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['addNode', 'newAgent', 'setParameters', 'setNodeSettings', 'connect', 'disconnect', 'removeNode', 'renameNode', 'turnIntoTeam'] },
    ref: { type: 'string', description: 'addNode: handle for this new node in later ops' },
    type: { type: 'string', description: 'addNode: node type id. connect/disconnect: main, ai_languageModel, ai_memory or ai_tool' },
    name: { type: 'string', description: 'addNode: node name. renameNode: the new name. newAgent: the new agent\'s name' },
    description: { type: 'string', description: 'newAgent: what the new agent does, one or two sentences' },
    instructions: { type: 'string', description: 'newAgent: the new agent\'s instructions: how it does the job' },
    parameters: { type: 'object', description: 'addNode / setParameters: parameter values (merged)' },
    after: { type: 'string', description: 'addNode: existing node name or ref to wire the new node after' },
    before: { type: 'string', description: 'addNode: insert the new node in front of this node (what fed it feeds the new node)' },
    output: { type: 'integer', description: 'Output index of the source (If: 0 = true, 1 = false)' },
    node: { type: 'string', description: 'setParameters / setNodeSettings / removeNode / renameNode / turnIntoTeam: node name' },
    settings: {
      type: 'object',
      description: 'setNodeSettings: the node\'s settings (not parameters): executeOnce, retryOnFail, maxTries, waitBetweenTriesMs, retryBackoff (fixed|exponential), onError (stop|continue), timeoutSeconds, alwaysOutputData, disabled',
    },
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
    description: 'Read the current workflow: nodes with their parameters, the outputs of nodes that branch and what is connected to each, connections, and which nodes have run data. Includes changes proposed earlier (marked pending: not applied yet).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_run_data',
    description: 'Read what a node received and produced in the last run (first items), its error and its parameters.',
    inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'Node name' } }, required: ['node'] },
  },
  {
    name: 'propose_changes',
    description: 'Show the user a change to the workflow to review and apply. Put everything one request asks for into as few calls as you can, wiring new nodes to each other by ref. Refer to existing nodes by name.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What the change does, past tense, at most 8 words, starting with a verb: "Set the Slack channel", "Added a filter for open tickets". Never "Fix…" or "This change…".' },
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
- When the request has several parts (a branch, then more steps on each side, a loop), first write a short numbered plan in one or two lines, then propose the whole thing in one propose_changes call, or a few: new nodes join each other with "ref" and "after"/"connect", so one call can hold a chain, both sides of a branch and a loop back. Don't research the same node twice, and don't propose one node per call.
- Changes proposed earlier in the conversation that the user hasn't applied yet are part of the workflow you read (get_workflow marks them pending). Connect to them by name; never propose them again. A node a pending proposal removes is gone because the user asked: never add it, or a node doing its job, back.
- Once everything the latest message asks for is proposed, stop: say in one line what the cards do. Don't go on to improve the workflow unasked.
- A node that already has several outputs (get_workflow lists each output and what it feeds, and get_node_docs lists its ports) branches by itself: connect new nodes from the right output ("output": 0, 1…). Don't put an If, Filter or Switch after it to test what it already separates.
- A connection back to an earlier node is allowed and makes a loop; the engine runs loops. To limit the rounds, use a round counter: a Code node that adds 1 to a round number (kept in a field the loop's nodes pass on, or read from the counter node's own previous output), then an If "round < N" whose true branch connects back to the node to repeat and whose false branch goes on to what happens after the last round.
- To fix a node's input, prefer changing the node's own parameters (read a field the items have). To put a node between two nodes, use addNode with "before": "<the later node>".
- ops: {"op":"addNode","ref":"r1","type":"<type id>","name":"Short name","parameters":{…},"after":"<node name or ref>","output":0} (or "before":"<node name>" to insert it in front of a node, rewiring what fed that node), {"op":"setParameters","node":"<name>","parameters":{…}}, {"op":"setNodeSettings","node":"<name>","settings":{"executeOnce":true}} (a node's settings, not its parameters: executeOnce runs it once for all its input items instead of once per item; also retryOnFail, maxTries, waitBetweenTriesMs, retryBackoff, onError, timeoutSeconds, alwaysOutputData, disabled), {"op":"connect","from":"<name or ref>","to":"<name or ref>","output":0,"type":"main"}, {"op":"disconnect","from":"…","to":"…"}, {"op":"removeNode","node":"…"}, {"op":"renameNode","node":"…","name":"…"}, {"op":"turnIntoTeam","node":"<a Run an Agent node with A2A Agent or Run an Agent nodes attached as its tools>"}. A new workflow starts with a trigger (core.manualTrigger unless the user wants a webhook, schedule or chat). Sub-nodes (chat models, memory, tools) attach to an AI Agent with "after": "<agent>" or connect with type ai_languageModel / ai_memory / ai_tool.
- Agents: before you add an AI Agent (core.aiAgent) for a job, check "Your agents" and "Published agent teams" below. If one's description, skills and tools cover the job, run it: Run an Agent (core.messageAgent, parameters agentId and message, what to do with the item) or Run a Team, and say in your closing sentence which one you picked and why. Use core.aiAgent only for a small step that needs no specialist (classify, summarize, extract, draft a reply). When the job needs a specialist none of them is (its own instructions, tools or knowledge, work other flows will reuse, or the user asks for an agent, a specialist or an expert to do it: that is an agent, never Ask a Person or a Confirm step), say so and propose {"op":"newAgent","ref":"a1","name":"<agent name>","description":"<what it does, one or two sentences>","instructions":"<how it does the job>","parameters":{"message":"…"},"before":"<the step it goes in front of>"} ("after" to add it after a step): applying it saves the agent as a draft and adds a Run an Agent node for it. That node runs the agent with the agent's own model and instructions: attach no chat model, memory or tools to it, and don't also add an AI Agent for the same job. One newAgent per agent, then stop. Then tell the user to give it tools on the Agents page (the Agent architect can) and publish it before the flow runs. Never invent an agentId.
- Teams: an agent team (Agents page → Teams) is a lead with members who report to it, with reviews and budgets; the Run a Team node (core.runTeam, parameters teamId and teamName, message) runs a published one as a single step, with Done and Needs a person outputs. When the user wants a team that already exists, add that node with its teamId and teamName from "Published agent teams" below; the chat model, memory and tools attached to the node go to the lead. When the user wants a lead and the agents under it turned into a team, propose {"op":"turnIntoTeam","node":"<the lead>"}: applying it creates and publishes the team and swaps the nodes, so never tell the person to create a team first or to pick one afterwards. The same action is "Turn into a team" in the toolbar of a selected Run an Agent node that has agents as tools. Never invent a teamId.
- Expressions read the current item with "{{ $json.field }}" and other nodes with "{{ $('Node name').item.json.field }}".
- Never make up ids, channels, email addresses, URLs or keys the user didn't give: leave those parameters empty and say the user fills them in.
- A tool attached to an agent: a value the agent should choose when it calls the tool (a branch, a file path, an issue or pull request number, a message) is the expression {{ $fromAI('<parameter name>', '<what it is>', 'string' | 'number' | 'boolean') }}, never a bare $fromAI; fixed values (the owner, the repository, a channel) are set plainly. Credentials are the person's to pick: never set one, name the one to pick in your closing sentence.
- After proposing, say in one sentence what it does and what the user still has to do (click Apply, pick a credential, run it). Nothing is applied yet: never say the change was applied or made. Don't repeat the ops in prose.
- When asked whether a test run's result does what the user asked for, read the output of the last step with get_run_data and compare it with the request: if it falls short (wrong items, a filter that keeps everything, fields missing), propose the change; if it does what was asked, say so in one sentence and propose nothing.
- When a message reports a failed test run, read the failing node's run data with get_run_data, find the cause and propose the smallest change that fixes it, without asking first. Say the cause in one clause of at most 12 words ("“Triage Ticket” got an empty message."). Fix the failing node or what feeds it, never something else, and never by removing a node and adding the same one back. If only the user can fix it (a credential, an id, an account), say what to do in one sentence and propose nothing.
- When no change is needed, just answer. Write for a phone: at most two short sentences (about 25 words), no headings or lists unless asked. Start with the result or the answer. Never describe what you are about to do or what you looked at ("Let me…", "I'll…", "Looking at…", "The error indicates…").
- A parameter that get_node_docs shows with "stored as …" (a collection or fixed collection) is written exactly in that shape: the group names, the field names and, for a field with options, one of the listed values. Never a flat list, never a field or option value the docs don't list.
- Chat models, memory and tools are sub-nodes: attach them to the agent with a connection of type ai_languageModel, ai_memory or ai_tool (addNode "after": "<agent>" does it), never as a normal step after the agent. Don't pin test data on a trigger unless asked.
- If the user names a model, a provider or a value you can't set (a model that isn't in the docs' options, a credential), say so in your closing sentence rather than silently picking another; a node that needs a credential gets none from you: name it.
- Use only node types from the catalog below and search_nodes; anything else is not installed, offline or not allowed in this workflow.

${PARAMETER_FORMATS}`;

const SESSION = 'This message comes from Spotlight\'s test-and-fix session: it applies your proposal and runs the workflow again by itself. Never ask the user to click Apply or to run it.';

/** Autonomous mode: what the person asked is applied and tested as soon as the reply ends (components/editor/autonomous.ts). */
const AUTO = 'Autonomous mode: Spotlight applies your proposal as soon as you finish, then tests the flow. Never mention Apply, cards or running it. End with one sentence: what changed, then only what the person must do (pick a credential, fill in a value). A new agent you propose is designed and published by Spotlight: say only "Created the agent “<name>” for <job>."';

const shorten = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The ops argument as the model sent it: an array, or a JSON string of one. */
/** The ops a model sent: an array, a single op, JSON text of either, or a wrapper with `ops` (local models vary). */
export function opsArgument(value: unknown): unknown {
  let ops = value;
  if (typeof ops === 'string') {
    try {
      ops = JSON.parse(ops);
    } catch {
      return [];
    }
  }
  if (ops && typeof ops === 'object' && !Array.isArray(ops)) {
    const one = ops as Record<string, unknown>;
    if (Array.isArray(one.ops)) return one.ops;
    if (typeof one.op === 'string') return [one];
  }
  return ops;
}
const REF_FIELDS = ['from', 'to', 'after', 'before', 'node'] as const;
/**
 * Ops with the refs of nodes added by earlier proposals in this reply written as those nodes' names: refs live inside one
 * proposal, but models keep using them ("connect Tech Lead → run_report" after proposing `run_report`).
 */
export function withEarlierRefs(ops: unknown, refs: Map<string, string>): unknown {
  if (!Array.isArray(ops) || !refs.size) return ops;
  const record = (op: unknown) => (op && typeof op === 'object' && !Array.isArray(op) ? (op as Record<string, unknown>) : undefined);
  const own = new Set(ops.flatMap((op) => (typeof record(op)?.ref === 'string' ? [record(op)!.ref as string] : [])));
  return ops.map((op) => {
    const fields = record(op);
    if (!fields) return op;
    const next = { ...fields };
    for (const field of REF_FIELDS) {
      const value = next[field];
      if (typeof value === 'string' && !own.has(value) && refs.has(value)) next[field] = refs.get(value);
    }
    return next;
  });
}

/** Where a model put its ops: `ops`, else the names local models reach for. */
const opsOf = (args: Record<string, unknown>) => opsArgument(args.ops ?? args.changes ?? args.operations);

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

const UNIT_MS = { ms: 1, s: 1000, min: 60_000, h: 3_600_000 } as const;
type Unit = keyof typeof UNIT_MS;
const UNIT_NAME: Record<Unit, string> = { ms: 'milliseconds', s: 'seconds', min: 'minutes', h: 'hours' };
const DURATION = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h)\b/gi;
const unitOfWord = (word: string): Unit => (/^(ms|milli)/i.test(word) ? 'ms' : /^s/i.test(word) ? 's' : /^m/i.test(word) ? 'min' : 'h');
/** The unit a number field is in, from its label or description: "Timeout (ms)", "Wait (seconds)". */
const unitOfField = (p: PropertyDescriptor): Unit | undefined => {
  const text = `${p.displayName} ${p.description ?? ''}`;
  if (/\(ms\)|millisecond/i.test(text)) return 'ms';
  if (/\((s|sec|seconds?)\)|in seconds/i.test(text)) return 's';
  if (/\((min|minutes?)\)|in minutes/i.test(text)) return 'min';
  return undefined;
};

/**
 * Durations the request named that a proposal set in the wrong unit: "a 30 minute timeout" on a field in milliseconds
 * proposed as 30 or 1800. Each is said as the number it should be, for sending the proposal back.
 */
export function unitSlips(ops: unknown, request: string, propertiesOf: (op: Record<string, unknown>) => PropertyDescriptor[] | undefined): string[] {
  const durations = [...request.matchAll(DURATION)].map((m) => ({ text: m[0], value: Number(m[1]), ms: Number(m[1]) * UNIT_MS[unitOfWord(m[2])] }));
  if (!durations.length || !Array.isArray(ops)) return [];
  const slips: string[] = [];
  const check = (p: PropertyDescriptor | undefined, value: unknown) => {
    const unit = p?.type === 'number' ? unitOfField(p) : undefined;
    if (!unit || typeof value !== 'number') return;
    for (const d of durations) {
      const expected = d.ms / UNIT_MS[unit];
      const misread = [d.value, ...Object.values(UNIT_MS).map((ms) => d.ms / ms)].includes(value);
      if (value !== expected && misread) slips.push(`“${p!.displayName}” is in ${UNIT_NAME[unit]}: ${d.text} is ${expected}, not ${value}`);
    }
  };
  for (const op of ops) {
    if (!op || typeof op !== 'object' || !('parameters' in op)) continue;
    const properties = propertiesOf(op as Record<string, unknown>);
    const parameters = (op as { parameters?: unknown }).parameters;
    if (!properties || !parameters || typeof parameters !== 'object') continue;
    for (const [key, value] of Object.entries(parameters)) {
      const props = properties.filter((p) => p.name === key);
      const collection = props.find((p) => p.type === 'collection');
      if (collection && value && typeof value === 'object') for (const [k, v] of Object.entries(value)) check(collection.values?.find((p) => p.name === k), v);
      else check(props.find((p) => p.type === 'number'), value);
    }
  }
  return slips;
}

/**
 * A Run a Team node's team as the model wrote it: models put the team's name or its lead's title where the id goes
 * ("Tech Lead" for team_COGk…). A name that matches one published team becomes its id, and `teamName` is filled in from
 * the team, so the node shows it and runs. `typeOf` gives the type of a node a setParameters op names.
 */
export function withTeamIds(ops: unknown, teams: readonly TeamBrief[], typeOf: (node: string) => string | undefined = () => undefined): unknown {
  if (!Array.isArray(ops) || !teams.length) return ops;
  const resolve = (parameters: unknown) => withTeamId(parameters, teams);
  return ops.map((op) => {
    if (!op || typeof op !== 'object') return op;
    const o = op as Record<string, unknown>;
    if (o.op === 'addNode' && o.type === 'core.runTeam') return { ...o, parameters: resolve(o.parameters) };
    if (o.op === 'setParameters' && typeOf(String(o.node ?? '')) === 'core.runTeam') return { ...o, parameters: resolve(o.parameters) };
    return op;
  });
}

/**
 * A Run an Agent node's agent as the model wrote it: its name where the id goes becomes the id of the one published agent
 * of that name. A newAgent op names an agent that doesn't exist yet: any agentId on it is dropped (the editor sets it).
 */
export function withAgentIds(ops: unknown, agents: readonly AgentBrief[], typeOf: (node: string) => string | undefined = () => undefined): unknown {
  if (!Array.isArray(ops)) return ops;
  const resolve = (parameters: unknown) => withAgentId(parameters, agents);
  return ops.map((op) => {
    if (!op || typeof op !== 'object') return op;
    const o = op as Record<string, unknown>;
    if (o.op === 'newAgent' || (o.op === 'addNode' && o.newAgent)) {
      const { agentId: _agentId, ...parameters } = (o.parameters && typeof o.parameters === 'object' ? o.parameters : {}) as Record<string, unknown>;
      return { ...o, parameters };
    }
    if (o.op === 'addNode' && o.type === 'core.messageAgent') return { ...o, parameters: resolve(o.parameters) };
    if (o.op === 'setParameters' && typeOf(String(o.node ?? '')) === 'core.messageAgent') return { ...o, parameters: resolve(o.parameters) };
    return op;
  });
}

const standInKey = (name: string) => name.trim().toLowerCase().replace(/\s+\d+$/, '').replace(/\s+agent$/, '');

/**
 * Local models propose a `newAgent` and then, in the same conversation, an AI Agent for the same job, or a chat model for
 * the new agent's node, believing it needs one (it runs with the agent's own). Those are left out, with what refers to
 * them, and the model is told why. `agents`: the new agents proposed so far, by `standInKey` of their names.
 */
export function withoutAgentStandIns(ops: unknown, agents: ReadonlySet<string>, kindOf: (type: string) => string | undefined = () => undefined): { ops: unknown; notes: string[] } {
  if (!Array.isArray(ops) || !agents.size) return { ops, notes: [] };
  const notes: string[] = [];
  const gone = new Set<string>();
  const isAgent = (name: unknown) => typeof name === 'string' && agents.has(standInKey(name));
  const kept = ops.filter((op) => {
    if (!op || typeof op !== 'object') return true;
    const o = op as Record<string, unknown>;
    if (o.op === 'addNode' && o.type === 'core.aiAgent' && isAgent(o.name)) {
      notes.push(`“${String(o.name)}” does the new agent's job: its Run an Agent step already runs it`);
      for (const handle of [o.ref, o.name]) if (typeof handle === 'string') gone.add(handle);
      return false;
    }
    const attached = (o.op === 'addNode' && kindOf(String(o.type ?? '')) === 'subnode' && isAgent(o.after)) || (o.op === 'connect' && typeof o.type === 'string' && o.type !== 'main' && isAgent(o.to));
    if (attached) {
      notes.push(`nothing attaches to the new agent's step: it runs with the agent's own model and tools`);
      for (const handle of [o.ref, o.name]) if (typeof handle === 'string') gone.add(handle);
      return false;
    }
    return !(o.op === 'connect' || o.op === 'disconnect') || !(gone.has(String(o.from)) || gone.has(String(o.to)));
  });
  return { ops: kept, notes: [...new Set(notes)] };
}

/**
 * A new AI Agent step that wouldn't run here (no chat model attached, so OpenAI's, or a hosted one) becomes a dedicated
 * agent: a newAgent the Agent architect designs on a local model, with the tools and knowledge base it needs. One with an
 * Ollama chat model stays, as a small inline step. Its sub-nodes go with withoutAgentStandIns, given the names returned.
 */
export function asNewAgents(ops: unknown, typeOf: (name: string) => string | undefined = () => undefined, already: ReadonlySet<string> = new Set()): { ops: unknown; names: string[]; handles: string[]; notes: string[] } {
  if (!Array.isArray(ops)) return { ops, names: [], handles: [], notes: [] };
  const handles = (o: Record<string, unknown>) => [o.ref, o.name].filter((h): h is string => typeof h === 'string');
  const added = new Map<string, string>();
  for (const op of ops) {
    const o = op as Record<string, unknown>;
    if (o?.op === 'addNode' && typeof o.type === 'string') for (const h of handles(o)) added.set(h, o.type);
  }
  const typeOfHandle = (h: unknown) => (typeof h === 'string' ? (added.get(h) ?? typeOf(h)) : undefined);
  const LOCAL = 'core.ollamaChatModel';
  const runsHere = (agent: Record<string, unknown>) =>
    ops.some((op) => {
      const o = op as Record<string, unknown>;
      return (o?.op === 'addNode' && o.type === LOCAL && handles(agent).includes(String(o.after))) || (o?.op === 'connect' && o.type === 'ai_languageModel' && handles(agent).includes(String(o.to)) && typeOfHandle(o.from) === LOCAL);
    });
  const names: string[] = [];
  const agentHandles: string[] = [];
  const out = ops.map((op) => {
    const o = op as Record<string, unknown>;
    // One named after a new agent already proposed is its stand-in: withoutAgentStandIns drops it.
    if (o?.op !== 'addNode' || o.type !== 'core.aiAgent' || runsHere(o) || (typeof o.name === 'string' && already.has(standInKey(o.name)))) return op;
    const p = (o.parameters && typeof o.parameters === 'object' ? o.parameters : {}) as Record<string, unknown>;
    const said = (v: unknown) => (typeof v === 'string' && v.trim() && !v.trim().startsWith('{{') ? v.trim() : undefined);
    const name = (typeof o.name === 'string' && o.name.trim()) || 'Agent';
    names.push(name);
    agentHandles.push(name, ...(typeof o.ref === 'string' ? [o.ref] : []));
    const instructions = said(p.systemMessage) ?? said(p.prompt) ?? '';
    return {
      op: 'newAgent',
      name,
      description: (instructions.split(/(?<=[.!?])\s/)[0] ?? '').slice(0, 300) || name,
      instructions,
      ...(typeof p.prompt === 'string' && p.prompt.trim() && { parameters: { message: p.prompt } }),
      ...Object.fromEntries((['ref', 'after', 'before', 'output'] as const).filter((k) => o[k] !== undefined).map((k) => [k, o[k]])),
    };
  });
  return { ops: out, names, handles: agentHandles, notes: names.map((n) => `“${n}” is a dedicated agent (newAgent), designed on a local model: an AI Agent step here has no chat model it can run on`) };
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

/** A reply that says only the person can fix it: a credential, an account, a key, an id. */
const PERSON_ONLY = /\b(credential|api key|access token|sign in|log in|permission)s?\b/i;

/** The model saying what it is about to do or what it looked at, before the answer. */
const NARRATION = /^(?:let me|let's|i'll|i will|i need to|i'm going to|now i|now,? let|first,|next,|looking at|based on|i can see|i see that|to fix this|the user (?:wants|needs|asked))\b/i;

/** Sentences that narrate instead of answer are left out; the answer stays (and all of it, when nothing else is left). */
export function withoutNarration(text: string): string {
  const out = dropSentences(text, (sentence) => NARRATION.test(sentence.trim()));
  return out === undefined || !out.trim() ? text : out;
}

/**
 * Tool-call markup a local model leaves in its text: a `<function=…>` call with its body up to its end (or the end of
 * the text when it isn't closed), `<think>` blocks, and stray tags.
 */
export function withoutLeakedMarkup(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<function=[\s\S]*?(?:<\/function>|$)/g, '')
    .replace(/<\/?(?:tool_call|function|parameter)\b[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * Why a test-and-fix session's fix would be wasted, if it is: it touches neither the failing step nor anything that feeds
 * it, it removes a node and adds the same kind back, or it only adds a No Operation step.
 */
export function wastedFix(ops: AssistantOp[], workflow: Workflow, failingId: string | undefined): string | undefined {
  if (!ops.length) return undefined;
  const byRef = (ref: string | undefined) => workflow.nodes.find((n) => n.name === ref || n.id === ref);
  const removed = ops.flatMap((op) => (op.op === 'removeNode' ? [byRef(op.node)] : [])).filter((n): n is NonNullable<typeof n> => Boolean(n));
  const readded = ops.find((op) => op.op === 'addNode' && removed.some((n) => n.type === op.type));
  if (readded?.op === 'addNode') return `removing “${removed.find((n) => n.type === readded.type)?.name}” and adding the same kind of node back changes nothing.`;
  if (ops.every((op) => op.op === 'addNode' && op.type === 'core.noOp')) return 'a No Operation step changes nothing.';
  const failing = failingId ? workflow.nodes.find((n) => n.id === failingId) : undefined;
  if (!failing) return undefined;
  // The failing step and every node upstream of it.
  const near = new Set([failing.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of workflow.connections) if (near.has(c.target) && !near.has(c.source)) (near.add(c.source), (grew = true));
  }
  const touches = ops.some((op) => {
    const refs = [
      'node' in op ? op.node : undefined,
      'from' in op ? op.from : undefined,
      'to' in op ? op.to : undefined,
      'after' in op ? op.after : undefined,
      'before' in op ? op.before : undefined,
    ];
    return refs.some((ref) => typeof ref === 'string' && near.has(byRef(ref)?.id ?? ''));
  });
  return touches ? undefined : `the run failed at “${failing.name}”, and this change touches neither it nor what feeds it.`;
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
export function recoverToolCalls(text: string, names: ReadonlySet<string> = TOOL_NAMES): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const rest = text
    .replace(/<function=([\w-]+)>([\s\S]*?)<\/function>/g, (whole, name: string, body: string) => {
      if (!names.has(name)) return whole;
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
  /** The workflow plus what is proposed and waiting (earlier replies, then this one): later proposals build on it. */
  let working = input.workflow;
  /** Ids of the nodes proposed and not applied yet, and one line for each proposal. */
  const waiting = new Set<string>();
  const waitingSummaries: string[] = [];
  /** Nodes the pending proposals remove, by lower-case name: not to be added back. */
  const removed = new Map<string, { name: string; type: string }>();
  /** ref → name of the nodes this reply's proposals added, for later proposals that use the ref. */
  const proposedRefs = new Map<string, string>();
  const hold = (summary: string, next: Workflow) => {
    const known = new Set(working.nodes.map((n) => n.id));
    for (const node of next.nodes) if (!known.has(node.id)) waiting.add(node.id);
    const kept = new Set(next.nodes.map((n) => n.id));
    for (const node of working.nodes) if (!kept.has(node.id) && !waiting.has(node.id)) removed.set(node.name.toLowerCase(), { name: node.name, type: node.type });
    waitingSummaries.push(shorten(summary, 140));
    working = next;
  };
  for (const earlier of input.pending ?? []) {
    const validated = validateOps(working, opsArgument(earlier.ops), lookup);
    if (validated.ops.length) hold(earlier.summary, validated.workflow);
  }
  const outline = () => workflowOutline(working, runs, { types, pending: waiting, pendingSummaries: waitingSummaries, removed: [...removed.values()] });
  const latest = input.messages.findLast((m) => m.role === 'user')?.content.toLowerCase() ?? '';
  /** Whether the latest message asks to add a node by this name ("remove Check and add a new Check after Filter"). */
  const asksToAdd = (name: string) => new RegExp(`\\b(?:add|insert|put|create|new|another)\\b(?:(?!\\b(?:remove|delete|drop)\\b)[^.!?\\n])*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(latest);
  /** A node this proposal adds back after a pending proposal removed it: by name, or by type unless the latest message names the type; not when it asks for one by that name. */
  const addedBack = (ops: AssistantOp[]) =>
    ops.flatMap((op) => {
      if (op.op !== 'addNode') return [];
      if (op.name && asksToAdd(op.name)) return [];
      const gone = removed.get((op.name ?? '').toLowerCase()) ?? [...removed.values()].find((r) => r.type === op.type && !latest.includes((types.find((t) => t.type === op.type)?.descriptor.displayName ?? op.type).toLowerCase()));
      return gone ? [`“${gone.name}” (${gone.type})`] : [];
    });
  /** Whether an incomplete proposal was already sent back to the model in this reply. */
  let sentBack = false;
  /** Whether a proposal that put a branching node after a node that already branches was sent back. */
  let branchSentBack = false;
  /** Whether a proposal with parts that failed was sent back. */
  let failedSentBack = false;
  /** Whether a proposal that set a duration in the wrong unit was sent back. */
  let unitsSentBack = false;
  let proposed = false;
  /** Whether a fix request that proposed nothing was sent back for a proposal. */
  let pressed = false;
  /** A fix that missed the failing step was sent back once. */
  let offTargetSent = false;
  let applyRetried = false;
  /** The ops of each proposal so far, as sent: a model may send the same one again and again. */
  const sent = new Set<string>();
  /** What the user and the editor said, for telling a given id from a made-up one. */
  const known = () =>
    [...input.messages.map((m) => m.content), JSON.stringify(working), JSON.stringify(runs), ...(input.teams?.length ? [describeTeams(input.teams)] : []), ...(input.agents?.length ? [describeAgents(input.agents)] : [])].join('\n');
  /** The agents newAgent proposed in this reply and in pending proposals, by standInKey of their names. */
  const newAgents = new Set<string>(
    (input.pending ?? []).flatMap((p) => (Array.isArray(p.ops) ? p.ops : []).flatMap((op) => {
      const o = op as Record<string, unknown>;
      const spec = (o.newAgent ?? (o.op === 'newAgent' ? o : undefined)) as { name?: unknown } | undefined;
      return typeof spec?.name === 'string' ? [standInKey(spec.name)] : [];
    })),
  );
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
    input.agents?.length ? `\nYour agents (Run an Agent can run these; none of them may fit):\n${describeAgents(input.agents)}` : '\nYour agents: none published yet.',
    input.teams?.length ? `\nPublished agent teams (Run a Team can run these):\n${describeTeams(input.teams)}` : '',
    `\nThe editor now:\n${outline()}`,
    working.groups?.some((g) => g.composite) ? `\nComposites (frames typed by a contract: fill their slots with matching nodes, keep their rules):\n${compositeOutline(working)}` : '',
    selected ? `\nThe user has “${selected.name}” selected:\n${nodeContext(working, selected.id, runs[selected.id], types)}` : '',
    tagged.length ? `\nThe user tagged in the message:\n${tagged.join('\n')}` : '',
    input.session === 'auto' ? `\n${AUTO}` : input.session ? `\n${SESSION}` : '',
  ].join('\n');

  const execute = async (call: ToolCall): Promise<ToolResult> => {
    // `shownOk`: how the step looks to the person. A change sent back to the model to complete is an error to the model
    // but not a failure to show: Spotlight is still working on it ("Reworked the change").
    const result = (content: string, label: string, ok = true, shownOk = ok): ToolResult => {
      onEvent({ type: 'tool', name: call.name, label, ok: shownOk });
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
        const teamsNote = info.type === 'core.runTeam' ? `\nPublished agent teams:\n${input.teams?.length ? describeTeams(input.teams) : '(none yet: build one on the Agents page, or turn a lead and its agents into a team)'}` : '';
        const agentsNote = info.type === 'core.messageAgent' ? `\nYour agents:\n${input.agents?.length ? describeAgents(input.agents) : '(none published yet: propose a newAgent for one)'}` : '';
        return result(`${nodeDocs(info, existing?.parameters)}${teamsNote}${agentsNote}`, `Read ${info.descriptor.displayName} docs`);
      }
      case 'get_workflow':
        return result(outline(), 'Read the workflow');
      case 'get_run_data': {
        const node = nodeByName(String(args.node ?? ''));
        if (!node) return result(`No node named “${String(args.node ?? '')}”. Nodes: ${working.nodes.map((n) => n.name).join(', ')}`, `Looked for “${shorten(String(args.node ?? ''), 40)}”: not found`, false);
        return result(nodeContext(working, node.id, runs[node.id], types), `Read run data of “${shorten(node.name, 40)}”`);
      }
      case 'propose_changes': {
        const summary = shorten(String(args.summary ?? '').trim() || 'Proposed change', 140);
        const ops = withEarlierRefs(opsOf(args), proposedRefs);
        const asSent = JSON.stringify(ops);
        if (sent.has(asSent)) return result('Nothing changes: you proposed exactly this above. Do not propose it again.', 'Skipped a repeated proposal');
        const typeText = (op: Record<string, unknown>) => {
          const type = op.op === 'addNode' ? String(op.type ?? '') : nodeByName(String(op.node ?? ''))?.type;
          const info = types.find((t) => t.type === type);
          return info ? JSON.stringify(info.descriptor.properties) : '';
        };
        // A node already proposed and waiting is used, not added again.
        const { ops: fresh, repeated } = withoutRepeatedAdds(working, waiting, ops);
        const typeOfNode = (name: string) => nodeByName(name)?.type;
        const dedicated = asNewAgents(fresh, typeOfNode, newAgents);
        for (const handle of dedicated.handles) newAgents.add(standInKey(handle));
        const standIns = withoutAgentStandIns(withAgentIds(withTeamIds(dedicated.ops, input.teams ?? [], typeOfNode), input.agents ?? [], typeOfNode), newAgents, (type) => types.find((t) => t.type === type)?.descriptor.kind);
        standIns.notes.unshift(...dedicated.notes);
        const teamed = standIns.ops;
        if (standIns.notes.length && Array.isArray(teamed) && !teamed.length) {
          return result(`Nothing changes: ${standIns.notes.join('; ')}. If everything the latest message asks for is proposed, stop and say in one line what the cards do.`, 'Skipped a stand-in for the new agent');
        }
        const { ops: proposedOps, invented: inventedNotes, values } = withoutInventedIds(teamed, known(), typeText);
        for (const value of values) invented.add(value);
        const validated = validateOps(working, proposedOps, lookup);
        const back = addedBack(validated.ops);
        if (back.length) {
          return result(
            `Nothing changes: ${back.join(', ')} ${back.length === 1 ? 'is' : 'are'} removed by a pending proposal because the user asked; don't add ${back.length === 1 ? 'it' : 'them'}, or a node doing the same job, back. If everything the latest message asks for is proposed, stop and say in one line what the cards do.`,
            'Skipped adding back a removed node',
          );
        }
        // A fix must touch the step that failed or what feeds it, and must change something.
        const wasted = input.session === 'fix' && !offTargetSent ? wastedFix(validated.ops, working, selected ? selected.id : undefined) : undefined;
        if (wasted) {
          offTargetSent = true;
          return result(`Not shown: ${wasted} Propose a change to that step or what feeds it, or, if only the person can fix it, say what to do in one sentence.`, 'Skipped a fix that changes nothing');
        }
        if (!validated.ops.length && repeated.length && !validated.dropped.length) {
          return result(`Nothing changes: ${repeated.join('; ')}. Connect from it with another propose_changes call if something is still missing.`, 'Skipped a repeated proposal');
        }
        if (!validated.ops.length) {
          const empty = !Array.isArray(ops) || !ops.length;
          // Local models call propose_changes with no ops to "apply" what they proposed: only the person can, and it isn't needed.
          if (empty && waiting.size) {
            const names = working.nodes.filter((n) => waiting.has(n.id)).map((n) => `“${n.name}”`);
            return result(
              `Nothing could be proposed: no changes given. You can't apply proposals (the person does, with the card's Apply button), and you don't need to: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} already in the workflow you work on. Connect to ${names.length === 1 ? 'it' : 'them'} by name in a propose_changes call with the remaining ops, e.g. {"op":"connect","from":${JSON.stringify(working.nodes.find((n) => waiting.has(n.id))?.name ?? 'Run report')},"to":"<next node>","output":0}.`,
              'Proposal rejected: no changes given',
              false,
            );
          }
          const why = [...validated.dropped, ...inventedNotes].join('; ') || 'no changes given';
          // With nothing readable, show the model what it sent and the shape wanted: it corrects itself instead of retrying the same call.
          const shape = validated.dropped.length || inventedNotes.length ? '' : ` "ops" must be an array of operations, like [{"op":"addNode","ref":"r1","type":"core.runReport","name":"Run report","after":"Tech Lead"},{"op":"connect","from":"r1","to":"Open PR","output":0}]. You sent: ${shorten(JSON.stringify(args), 300)}.`;
          return result(`Nothing could be proposed: ${why}.${shape} Fix the ops (check names, type ids and parameters) and call propose_changes again.`, `Proposal rejected: ${shorten(why, 80)}`, false);
        }
        // Proposing the same thing twice (it happens with local models) changes nothing the second time.
        const graph = (wf: Workflow) => JSON.stringify([wf.nodes, wf.connections]);
        if (graph(validated.workflow) === graph(working)) {
          return result('Nothing changes: this is already in the workflow or was proposed above. Do not propose it again.', 'Skipped a repeated proposal');
        }
        // A node that already branches needs no If / Filter / Switch after it: back once, naming its outputs.
        const branching = redundantBranches(validated.workflow, validated.ops, types);
        if (branching.length && !branchSentBack) {
          branchSentBack = true;
          return result(
            `Not shown yet: ${branching.join(' ')} Call propose_changes again with those connections. If the user asked for exactly this extra node, propose it again as it is.`,
            'Reworked the change',
            false,
            true,
          );
        }
        // A duration the request named, set in the wrong unit ("30 minutes" as 30 or 1800 in a field in milliseconds), goes back once.
        const slips = unitsSentBack ? [] : unitSlips(proposedOps, latest, (op) => types.find((t) => t.type === (op.op === 'addNode' ? String(op.type ?? '') : nodeByName(String(op.node ?? ''))?.type))?.descriptor.properties);
        if (slips.length) {
          unitsSentBack = true;
          return result(`Not shown yet: ${slips.join('; ')}. Call propose_changes again with the numbers in the field's unit.`, 'Reworked the change', false, true);
        }
        // A change with parts that failed (a type that doesn't exist, a connection to a node it never added) goes back once:
        // shown as it is, it could remove a node without adding the one meant to replace it.
        if (validated.dropped.length && !failedSentBack) {
          failedSentBack = true;
          const why = validated.dropped.join('; ');
          return result(
            `Not shown yet: part of this change failed: ${why}. Add a node before connecting to it (an addNode with that "ref"), use type ids from search_nodes, and call propose_changes again with the complete change.`,
            'Reworked the change',
            false,
            true,
          );
        }
        // A change that leaves part of the flow dangling goes back once for the model to complete.
        if (validated.warnings.length && !sentBack) {
          sentBack = true;
          const why = validated.warnings.join('; ');
          return result(
            `Not shown yet: this change leaves ${why}. To put a new node in front of an existing one, use addNode with "before": "<that node>" (it rewires the input for you) instead of "after" plus connect. Otherwise add the missing connect/disconnect ops. Then call propose_changes again with the complete change.`,
            'Reworked the change',
            false,
            true,
          );
        }
        hold(summary, validated.workflow);
        for (const op of validated.ops) if (op.op === 'addNode' && op.ref && op.name) proposedRefs.set(op.ref, op.name);
        for (const op of validated.ops) if (op.op === 'addNode' && op.newAgent) for (const name of [op.newAgent.name, op.name]) if (name) newAgents.add(standInKey(name));
        sent.add(asSent);
        const dropped = [...validated.dropped, ...validated.ignored, ...inventedNotes, ...standIns.notes];
        const notes = `${dropped.length ? ` Left out: ${dropped.join('; ')}.` : ''}${repeated.length ? ` Not added again: ${repeated.join('; ')}.` : ''}`;
        const count = `${validated.ops.length} change${validated.ops.length === 1 ? '' : 's'}`;
        const shown = input.session
          ? result(`Recorded (${count}); Spotlight applies it when you finish.${notes} Don't list the changes again. If the message asks for something this doesn't cover yet, propose it now; otherwise stop with your one sentence.`, `Proposed ${count}`)
          : result(`Shown to the user as a card with an Apply button (${count}); nothing changes until they click it.${notes} Don't list the changes again, ask whether to apply them, or say they are applied. If the latest message asks for something this doesn't cover yet, propose it now (the nodes above are in the workflow for you to connect to); if it's all proposed, stop and say in one line what the cards do.`, `Proposed ${count}`);
        onEvent({ type: 'proposal', id: `pr_${nanoid(8)}`, summary, ops: validated.ops, dropped, warnings: [...validated.warnings, ...validated.cautions] });
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
    /** Steps in a row that added nothing new, and the tool results seen so far in this reply. */
    let stalled = 0;
    const seen = new Set<string>();
    while (steps < MAX_STEPS && !finished && stalled < MAX_STALLED) {
      steps++;
      const turn = await model.generate({ system, messages: history, tools: TOOLS, ...(input.signal && { signal: input.signal }) });
      usage.inputTokens += turn.usage?.inputTokens ?? 0;
      usage.outputTokens += turn.usage?.outputTokens ?? 0;
      const { text, calls } = turn.toolCalls.length ? { text: turn.text, calls: turn.toolCalls } : recoverToolCalls(turn.text);
      const proposing = proposed || calls.some((call) => call.name === 'propose_changes');
      if (text.trim()) {
        // A local model leaves its tool-call tags in the text ("…to test it.<tool_call>").
        const own = withoutNarration(withoutLeakedMarkup(withoutEchoedNotes(text)));
        // Spotlight applies a session's proposals itself: "it now posts…" is true there.
        const claimsOff = proposing && !input.session ? withoutAppliedClaims(own) : own;
        const shown = own && withoutMadeUpIds(withoutRepeats(input.session ? withoutApplyRequests(claimsOff) : claimsOff, said), known(), invented);
        said += `\n${text}`;
        if (shown.trim()) onEvent({ type: 'text', text: shown });
      }
      history.push({ role: 'assistant', text, toolCalls: calls, ...(turn.raw && { raw: turn.raw }) });
      finished = !calls.length;
      // Local models describe a fix without proposing it; a test-and-fix session needs the proposal.
      // Not when it already said only the person can fix it: pressing makes a local model invent a fix.
      if (finished && input.session === 'fix' && !proposed && !pressed && !PERSON_ONLY.test(text)) {
        pressed = true;
        finished = false;
        history.push({ role: 'user', content: 'Nothing was proposed: only a propose_changes call changes the workflow. Call propose_changes with the fix now, or, if only I can fix it, say what to do in one sentence.' });
        continue;
      }
      // The reply says to apply a card that was never made: say so and ask once more, instead of ending the turn.
      if (finished && !input.session && !proposed && !waiting.size && APPLY_REQUEST.test(text)) {
        if (!applyRetried) {
          applyRetried = true;
          finished = false;
          onEvent({ type: 'text', text: '(No change card was created, so there is nothing to apply yet. Trying again.)' });
          history.push({ role: 'user', content: 'You told me to click Apply, but no proposal exists: nothing was shown to me. Call propose_changes now with the change, or say plainly that you are not changing anything.' });
          continue;
        }
        onEvent({ type: 'text', text: '(Still no change card: nothing was proposed, so there is nothing to apply.)' });
      }
      if (finished) break;
      const results: ToolResult[] = [];
      let progress = false;
      for (const call of calls) {
        const shownBefore = waitingSummaries.length;
        const outcome = await execute(call);
        span.addEvent('assistant.tool', { 'gen_ai.tool.name': call.name, 'landflow.outcome': outcome.isError ? 'error' : 'ok' });
        results.push(outcome);
        // Progress is a new proposal, or a result this reply hasn't had yet.
        const key = `${outcome.name}\n${outcome.content}`;
        if (waitingSummaries.length > shownBefore || !seen.has(key)) progress = true;
        seen.add(key);
      }
      stalled = progress ? 0 : stalled + 1;
      history.push({ role: 'tool', results });
    }
    // A test-and-fix session goes on (or stops) by itself: "ask me to continue" would only be noise there.
    if (!finished && !input.session) {
      const text = stalled >= MAX_STALLED ? '(Stopped: the last steps only repeated what was already done. Tell me what to change, or ask me to continue.)' : `(Stopped after ${MAX_STEPS} steps. Ask me to continue if there is more to do.)`;
      onEvent({ type: 'text', text });
    }
    span.setAttribute('landflow.assistant.steps', steps);
    onEvent({ type: 'done', model: modelLabel(model), durationMs: Date.now() - started, steps, usage });
  });
}
