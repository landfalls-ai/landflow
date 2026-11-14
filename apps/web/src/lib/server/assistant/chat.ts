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
import { describeAgents, type AgentBrief } from '@/lib/shared/agent-brief';
import { describeTeams, type TeamBrief } from '@/lib/shared/agent-teams';
import type { NodeTypeInfo, PropertyDescriptor, Workflow } from '@/lib/shared/types';
import { compositeOutline } from '../composites';
import { PARAMETER_FORMATS } from '../flow-builder';
import { assistantScope, isUsageCapError, runInUsageScope, type UsageScope } from '../ai-usage';
import { recordSuggestions, traceAssistant } from '../telemetry/assistant';
import { outcomeOf } from '../telemetry/metrics';
import { failSpan } from '../telemetry/spans';
import { saveCheckpoint } from './checkpoints';
import { assistantModel, errorText, modelLabel } from './model';
import { redundantBranches, registryLookup, validateOps, withoutRepeatedAdds } from './ops';
import {
  APPLY_REQUEST,
  PERSON_ONLY,
  asNewAgents,
  opsArgument,
  recoverToolCalls,
  standInKey,
  unitSlips,
  wastedFix,
  withAgentIds,
  withEarlierRefs,
  withTeamIds,
  withoutAgentStandIns,
  withoutAppliedClaims,
  withoutApplyRequests,
  withoutEchoedNotes,
  withoutInventedIds,
  withoutLeakedMarkup,
  withoutMadeUpIds,
  withoutNarration,
  withoutRepeats,
} from './guards';
import { availableTypes, catalogSummary, nodeContext, nodeDocs, searchNodes, workflowOutline } from './research';

/** The most model calls for one message. A reply stops sooner when two steps in a row add nothing new. */
export const MAX_STEPS = 20;
/** Steps in a row that add nothing new (no proposal, no tool result not seen before) before the reply stops. */
const MAX_STALLED = 2;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Why a chat ended in an error: the model failed, a usage cap was reached, the steps only repeated, or the host failed. */
export type ChatErrorKind = 'model' | 'cap' | 'stalled' | 'internal';

export type ChatEvent =
  /** A model call begins (with `trace`). */
  | { type: 'step.start'; step: number; label: string }
  /** Tokens of the step as they come (with `trace`): provisional, replaced by the step's `text`. */
  | { type: 'text.delta'; step: number; text: string }
  /** The checked text of a step. With `trace`, only the last step's text is the reply (it replaces the step's deltas). */
  | { type: 'text'; text: string; step?: number }
  /** With `trace`: the text of a step that also called tools or was sent back, after the guards. It goes in the trace, never the reply. */
  | { type: 'thinking'; step: number; text: string }
  | { type: 'tool'; name: string; label: string; ok: boolean; id: string; step: number; durationMs: number; detail?: string }
  | { type: 'proposal'; id: string; summary: string; ops: AssistantOp[]; dropped: string[]; warnings: string[] }
  | { type: 'done'; model: string; durationMs: number; steps: number; usage: { inputTokens: number; outputTokens: number }; costUsd?: number; local: boolean }
  | { type: 'error'; message: string; kind?: ChatErrorKind; checkpoint?: string; step?: number };

/** What a chat keeps to be continued after an error: the messages with the tool results so far, and what the guards remember. */
export interface ChatState {
  history: AgentMessage[];
  /** Model calls made so far. */
  steps: number;
  seen: string[];
  said: string;
  /** The proposals sent so far in this reply, as validated: a resumed reply builds on them. */
  proposals: Array<{ summary: string; ops: AssistantOp[] }>;
  sent: string[];
}

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
  /**
   * Stream the step trace: `step.start`, `text.delta`, text of tool steps as `thinking`, and failures as `error` events
   * with a checkpoint (the route sets it). Without it the events are the older ones: `text` for every step, errors thrown.
   */
  trace?: boolean;
  /** The caller, for AI usage and its per-user caps, and for keeping checkpoints. */
  userId?: string;
  /** Continue from a checkpoint (`takeCheckpoint`): the messages so far, no tool run again. */
  resume?: ChatState;
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

export const TOOLS: ToolSpec[] = [
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

export * from './guards';

/** Where a model put its ops: `ops`, else the names local models reach for. */
const opsOf = (args: Record<string, unknown>) => opsArgument(args.ops ?? args.changes ?? args.operations);


/** The text a step's tokens are sent in: at most one `text.delta` per 50 ms. */
const DELTA_MS = 50;

/** Batches tokens into one call per `DELTA_MS`; `flush` sends what is left (call it when the step ends). */
function coalesced(send: (text: string) => void): { push: (delta: string) => void; flush: () => void } {
  let buffer = '';
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!buffer) return;
    const text = buffer;
    buffer = '';
    last = Date.now();
    send(text);
  };
  return {
    flush,
    push(delta) {
      buffer += delta;
      const wait = DELTA_MS - (Date.now() - last);
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    },
  };
}

/** One line of what a tool call did, for the trace: the query, a count, what was read. Never a result body or a secret. */
const detailOf = (text: string | undefined) => (text === undefined ? undefined : shorten(text, 300));

/** The chat: Spotlight's model calls count in AI usage (surface `spotlight`) and under the caller's caps. */
export function runChat(input: ChatInput): Promise<void> {
  const workflowId = input.workflow.id && input.workflow.id !== 'draft' ? input.workflow.id : undefined;
  const scope = assistantScope({ surface: 'spotlight', ...(input.userId && { userId: input.userId }), ...(workflowId && { workflowId }) });
  return runInUsageScope(scope, () => chat(input, scope));
}

async function chat(input: ChatInput, scope: UsageScope): Promise<void> {
  const { onEvent, runs = {} } = input;
  const trace = input.trace === true;
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
  /** The proposals of this reply (and of the reply a resume continues), for the checkpoint. */
  const proposalLog: ChatState['proposals'] = [];
  for (const earlier of input.pending ?? []) {
    const validated = validateOps(working, opsArgument(earlier.ops), lookup);
    if (validated.ops.length) hold(earlier.summary, validated.workflow);
  }
  // A resumed reply builds on the proposals the failed one had sent.
  for (const earlier of input.resume?.proposals ?? []) {
    const validated = validateOps(working, earlier.ops, lookup);
    if (!validated.ops.length) continue;
    hold(earlier.summary, validated.workflow);
    proposalLog.push(earlier);
    for (const op of validated.ops) if (op.op === 'addNode' && op.ref && op.name) proposedRefs.set(op.ref, op.name);
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
  let proposed = proposalLog.length > 0;
  /** Whether a fix request that proposed nothing was sent back for a proposal. */
  let pressed = false;
  /** A fix that missed the failing step was sent back once. */
  let offTargetSent = false;
  let applyRetried = false;
  /** The ops of each proposal so far, as sent: a model may send the same one again and again. */
  const sent = new Set<string>(input.resume?.sent);
  /** What the user and the editor said, for telling a given id from a made-up one. */
  const known = () =>
    [...input.messages.map((m) => m.content), JSON.stringify(working), JSON.stringify(runs), ...(input.teams?.length ? [describeTeams(input.teams)] : []), ...(input.agents?.length ? [describeAgents(input.agents)] : [])].join('\n');
  /** The agents newAgent proposed in this reply and in pending proposals, by standInKey of their names. */
  const newAgents = new Set<string>(
    [...(input.pending ?? []), ...(input.resume?.proposals ?? [])].flatMap((p) => (Array.isArray(p.ops) ? p.ops : []).flatMap((op) => {
      const o = op as Record<string, unknown>;
      const spec = (o.newAgent ?? (o.op === 'newAgent' ? o : undefined)) as { name?: unknown } | undefined;
      return typeof spec?.name === 'string' ? [standInKey(spec.name)] : [];
    })),
  );
  /** Ids left out of proposals as made up: the text doesn't repeat them either. */
  const invented = new Set<string>();
  /** The text shown so far in this reply, for leaving out what it says twice. */
  let said = input.resume?.said ?? '';
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

  /** The step now running, for the tool events. */
  let currentStep = 0;
  const execute = async (call: ToolCall): Promise<ToolResult> => {
    const toolStarted = Date.now();
    let detail: string | undefined;
    // `shownOk`: how the step looks to the person. A change sent back to the model to complete is an error to the model
    // but not a failure to show: Spotlight is still working on it ("Reworked the change").
    const result = (content: string, label: string, ok = true, shownOk = ok): ToolResult => {
      onEvent({ type: 'tool', name: call.name, label, ok: shownOk, id: `t_${nanoid(8)}`, step: currentStep, durationMs: Date.now() - toolStarted, ...(detailOf(detail) && { detail: detailOf(detail) }) });
      return { id: call.id, name: call.name, content, ...(!ok && { isError: true }) };
    };
    const args = call.input ?? {};
    switch (call.name) {
      case 'search_nodes': {
        const query = String(args.query ?? '');
        const hits = searchNodes(query, types);
        detail = `“${query}”: ${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`;
        return result(hits.length ? JSON.stringify(hits.map(({ score: _score, ...hit }) => hit)) : `No node types match “${query}”. Try other words.`, `Searched nodes for “${shorten(query, 40)}”`);
      }
      case 'get_node_docs': {
        const asked = String(args.type ?? args.node ?? '');
        detail = asked;
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
        detail = `${working.nodes.length} node${working.nodes.length === 1 ? '' : 's'}`;
        return result(outline(), 'Read the workflow');
      case 'get_run_data': {
        const node = nodeByName(String(args.node ?? ''));
        detail = node?.name ?? String(args.node ?? '');
        if (!node) return result(`No node named “${String(args.node ?? '')}”. Nodes: ${working.nodes.map((n) => n.name).join(', ')}`, `Looked for “${shorten(String(args.node ?? ''), 40)}”: not found`, false);
        return result(nodeContext(working, node.id, runs[node.id], types), `Read run data of “${shorten(node.name, 40)}”`);
      }
      case 'propose_changes': {
        const summary = shorten(String(args.summary ?? '').trim() || 'Proposed change', 140);
        detail = summary;
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
        proposalLog.push({ summary, ops: validated.ops });
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

  await traceAssistant('chat', { 'landflow.workflow.id': input.workflow.id, 'gen_ai.request.model': model.model, 'landflow.assistant.turns': input.messages.length }, async (span, setOutcome) => {
    const history: AgentMessage[] = input.resume ? [...input.resume.history] : input.messages.map((m) => (m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', text: m.content, toolCalls: [] }));
    let steps = input.resume?.steps ?? 0;
    /** A resumed reply gets a fresh budget of steps; the count goes on from where it stopped. */
    const stepLimit = steps + MAX_STEPS;
    let finished = false;
    /** Steps in a row that added nothing new, and the tool results seen so far in this reply. */
    let stalled = 0;
    const seen = new Set<string>(input.resume?.seen);
    /** What a checkpoint keeps: the messages up to the last finished step. */
    const checkpoint = () => saveCheckpoint(input.userId, { history: [...history], steps, seen: [...seen], said, proposals: [...proposalLog], sent: [...sent] } satisfies ChatState);
    /** Ends the reply with an error event (with `trace`); false when the error is the caller's own abort or the older events are wanted. */
    const fail = (caught: unknown, kind: ChatErrorKind, failedStep: number): boolean => {
      if (!trace || input.signal?.aborted) return false;
      // The error event is the reply's end, but the request still failed: count it and mark the span.
      setOutcome(outcomeOf(caught));
      span.setAttribute('landflow.error.kind', kind);
      failSpan(span, caught);
      // A checkpoint needs at least one finished step to continue from; a reached cap would only stop it again.
      const keep = kind !== 'cap' && failedStep > 1 && history.at(-1)?.role === 'tool';
      onEvent({ type: 'error', kind, message: errorText(caught), ...(keep && { checkpoint: checkpoint(), step: failedStep }) });
      return true;
    };
    try {
      while (steps < stepLimit && !finished && stalled < MAX_STALLED) {
        steps++;
        currentStep = steps;
        if (trace) onEvent({ type: 'step.start', step: steps, label: steps === 1 ? 'Reading your request' : 'Working on it' });
        const batch = trace ? coalesced((delta) => onEvent({ type: 'text.delta', step: currentStep, text: delta })) : undefined;
        let turn: Awaited<ReturnType<typeof model.generate>>;
        try {
          turn = await model.generate({ system, messages: history, tools: TOOLS, ...(input.signal && { signal: input.signal }), ...(batch && { onToken: batch.push }) });
        } catch (caught) {
          batch?.flush();
          // The failed step is not in the history: a checkpoint continues at it.
          steps--;
          if (isUsageCapError(caught) ? fail(caught, 'cap', steps + 1) : fail(caught, 'model', steps + 1)) return;
          throw caught;
        }
        batch?.flush();
        usage.inputTokens += turn.usage?.inputTokens ?? 0;
        usage.outputTokens += turn.usage?.outputTokens ?? 0;
        const { text, calls } = turn.toolCalls.length ? { text: turn.text, calls: turn.toolCalls } : recoverToolCalls(turn.text);
        const proposing = proposed || calls.some((call) => call.name === 'propose_changes');
        // Whether this step is sent back to the model (a fix that proposed nothing; a card announced and never made): then it is not the reply.
        const pressNow = !calls.length && input.session === 'fix' && !proposed && !pressed && !PERSON_ONLY.test(text);
        const applyNow = !calls.length && !input.session && !proposed && !waiting.size && APPLY_REQUEST.test(text);
        const continues = calls.length > 0 || pressNow || (applyNow && !applyRetried);
        /** Text a step sends: its checked text is the reply when it is the last step, else part of the trace. */
        const say = (shown: string, last = !continues) => {
          if (!trace) onEvent({ type: 'text', text: shown });
          else if (last) onEvent({ type: 'text', text: shown, step: currentStep });
          else onEvent({ type: 'thinking', step: currentStep, text: shown });
        };
        let sentText = false;
        if (text.trim()) {
          // A local model leaves its tool-call tags in the text ("…to test it.<tool_call>").
          const own = withoutNarration(withoutLeakedMarkup(withoutEchoedNotes(text)));
          // Spotlight applies a session's proposals itself: "it now posts…" is true there.
          const claimsOff = proposing && !input.session ? withoutAppliedClaims(own) : own;
          const shown = own && withoutMadeUpIds(withoutRepeats(input.session ? withoutApplyRequests(claimsOff) : claimsOff, said), known(), invented);
          said += `\n${text}`;
          if (shown.trim()) {
            say(shown);
            sentText = true;
          }
        }
        // The deltas of a last step that the guards left nothing of: an empty `text` clears them.
        if (trace && !continues && !sentText) onEvent({ type: 'text', text: '', step: currentStep });
        history.push({ role: 'assistant', text, toolCalls: calls, ...(turn.raw && { raw: turn.raw }) });
        finished = !calls.length;
        // Local models describe a fix without proposing it; a test-and-fix session needs the proposal.
        // Not when it already said only the person can fix it: pressing makes a local model invent a fix.
        if (finished && pressNow) {
          pressed = true;
          finished = false;
          history.push({ role: 'user', content: 'Nothing was proposed: only a propose_changes call changes the workflow. Call propose_changes with the fix now, or, if only I can fix it, say what to do in one sentence.' });
          continue;
        }
        // The reply says to apply a card that was never made: say so and ask once more, instead of ending the turn.
        if (finished && applyNow) {
          if (!applyRetried) {
            applyRetried = true;
            finished = false;
            say('(No change card was created, so there is nothing to apply yet. Trying again.)', false);
            history.push({ role: 'user', content: 'You told me to click Apply, but no proposal exists: nothing was shown to me. Call propose_changes now with the change, or say plainly that you are not changing anything.' });
            continue;
          }
          say('(Still no change card: nothing was proposed, so there is nothing to apply.)', true);
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
    } catch (caught) {
      // Not a model failure (those returned above): a tool or the host failed.
      if (fail(caught, 'internal', steps)) return;
      throw caught;
    }
    // A test-and-fix session goes on (or stops) by itself: "ask me to continue" would only be noise there.
    if (!finished && !input.session) {
      const repeated = stalled >= MAX_STALLED;
      const text = repeated ? '(Stopped: the last steps only repeated what was already done. Tell me what to change, or ask me to continue.)' : `(Stopped after ${MAX_STEPS} steps. Ask me to continue if there is more to do.)`;
      // With a trace, a stall ends as an error the client can continue from; running out of steps is the reply's last word.
      if (repeated && trace) {
        setOutcome('error');
        span.setAttribute('landflow.error.kind', 'stalled');
        failSpan(span, new Error(text));
        onEvent({ type: 'error', kind: 'stalled', message: text, checkpoint: checkpoint(), step: steps });
        return;
      }
      if (trace) onEvent({ type: 'text', text, step: steps });
      else onEvent({ type: 'text', text });
    }
    span.setAttribute('landflow.assistant.steps', steps);
    const costUsd = scope.tree.calls ? Math.round(scope.tree.cost * 1e8) / 1e8 : undefined;
    onEvent({ type: 'done', model: modelLabel(model), durationMs: Date.now() - started, steps, usage, ...(costUsd !== undefined && { costUsd }), local: model.provider === 'ollama' });
  });
}
