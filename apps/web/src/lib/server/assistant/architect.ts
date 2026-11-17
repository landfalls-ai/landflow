/**
 * The Agent architect (docs/agents.md#agent-architect): a multi-turn tool-calling loop, like the editor's builder chat,
 * that designs an agent with the user. It reads what the instance has (node types usable as tools from every plugin
 * online, callable workflows, other agents, credential names, persona templates) and proposes a whole agent as a
 * draft. Drafts are validated: unknown node types, workflows and agents are left out, parameters keep only the node's
 * own, ids nobody gave are dropped and credentials are never set. The user creates the agent from the draft; the
 * architect never creates or changes one itself.
 */
import { nanoid } from 'nanoid';
import { withCallNote } from '../ai-usage/call-context'; // SP03:
import { plainDraft } from '../ai-usage/drafts'; // SP03:
import { defaultParameters, isPropertyVisible } from '@landflow/protocol';
import type { AgentMessage, LanguageModel, ToolCall, ToolResult, ToolSpec } from '@landflow/engine';
import type { AgentConfig, AgentGuardrails, AgentPersona, AgentTemplate, AgentToolConfig, AnswerLength } from '@/lib/shared/agents';
import { DEFAULT_BRIEF_GUARDRAILS, isNodeKnowledge } from '@/lib/shared/agents';
import type { AgentCaseDraft } from '@/lib/shared/agent-card'; // SB17:
import { writesOutside } from '@/lib/shared/run-check'; // SB17:
import { missingSystem, type ArchitectEvent, type ArchitectMissing, type ArchitectNeed, type ArchitectTurn } from '@/lib/shared/agent-architect';
import { randomFace } from '@/lib/shared/faces';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { agentStore } from '../agents/store';
import { agentTemplates } from '../agents/templates';
import { credentials } from '../credentials/vault';
import { qualifyCredentialType } from '../mcp/bind';
import { canResource, withOwnership, type Actor } from '../projects';
import { store } from '../store';
import { traceAssistant } from '../telemetry/assistant';
import { outcomeOf } from '../telemetry/metrics';
import { failSpan } from '../telemetry/spans';
import { recordUsage } from '../usage/ledger';
import { assistantScope, isUsageCapError, runInUsageScope, type UsageScope } from '../ai-usage';
import { recoverToolCalls, withoutInventedIds, withoutRepeats } from './chat';
import { chooseModel, type AgentResources } from './agent-resources';
import { saveCheckpoint } from './checkpoints';
import { assistantModel, errorText, modelLabel } from './model';
import { isParseError, parseErrorText } from './parse-retry';
import { catalogSummary, nodeDocs, searchNodes } from './research';
import { builderContextEntry } from '../project-context/by-repo';

export const MAX_ARCHITECT_STEPS = 10;

/** Node types an agent can call: actions whose only required inputs are main ones (the Abilities tab's own filter). */
export const usableAsTool = (t: NodeTypeInfo) => t.descriptor.kind === 'action' && t.descriptor.inputs.every((p) => p.type === 'main' || !p.required);

/**
 * What the architect's stream sends besides ArchitectEvent (lib/shared/agent-architect.ts), with `trace`: the step
 * that begins, tool events with timings, `done` with the cost and `error` with its kind and a checkpoint.
 */
export type ArchitectStreamEvent =
  | ArchitectEvent
  | { type: 'step.start'; step: number; label: string }
  | { type: 'tool'; name: string; label: string; ok: boolean; id: string; step: number; durationMs: number; detail?: string }
  | { type: 'done'; model: string; durationMs: number; steps: number; usage: { inputTokens: number; outputTokens: number }; costUsd?: number; local: boolean }
  | { type: 'error'; message: string; kind: 'model' | 'cap' | 'stalled' | 'internal'; checkpoint?: string; step?: number };

/** What an architect chat keeps to be continued after an error. */
export interface ArchitectState {
  history: AgentMessage[];
  steps: number;
  draft?: Partial<AgentConfig>;
  said: string;
  proposals: number;
  lastProposal?: string;
}

export interface ArchitectInput {
  messages: ArchitectTurn[];
  draft?: Partial<AgentConfig>;
  model?: string | LanguageModel;
  /** The node types drafts may use: the route passes those online and allowed for the caller. */
  types: NodeTypeInfo[];
  actor: Actor;
  signal?: AbortSignal;
  onEvent: (event: ArchitectStreamEvent) => void;
  /** Stream the step trace and send failures as `error` events with a checkpoint (the route sets it); without it errors are thrown. */
  trace?: boolean;
  /** Continue from a checkpoint (`takeCheckpoint`): the messages so far, no tool run again. */
  resume?: ArchitectState;
  /** The models, knowledge bases and embeddings this host has (agentResources): the draft gets a model and may search a knowledge base. */
  resources?: AgentResources;
  /** The project the agent is being built for (the route checked the caller's role): its goals go to the model as data. */
  projectId?: string;
  /** The only tools the model is offered (designAgent's short attempt offers propose_design alone); all of them when
   * absent. */
  only?: string[];
  /** SB17: the person's own words, for the least-privilege rules (which apps the request names, whether it asks to write or
   * to hand over). Absent: the conversation's user messages. Spotlight's design passes its request alone, never the brief's hints. */
  request?: string;
}

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['node', 'workflow', 'agent', 'knowledge'] },
    collection: { type: 'string', description: 'knowledge: a collection from list_knowledge_bases, or a new name (lowercase-dashes) for an empty one the user fills with documents' },
    nodeType: { type: 'string', description: 'node: the node type id from search_nodes' },
    name: { type: 'string', description: 'node: the tool name the model sees, snake_case (post_to_slack)' },
    description: { type: 'string', description: 'node / workflow / knowledge: when the agent should call or search it, one sentence' },
    parameters: { type: 'object', description: 'node: parameter values from get_node_docs; what the agent decides per call is "{{ $fromAI(\'key\', \'description\', \'string\') }}"' },
    workflowId: { type: 'string', description: 'workflow: an id from list_workflows' },
    agentId: { type: 'string', description: 'agent: an id from list_agents' },
    useWhen: { type: 'string', description: 'agent: when to delegate to it' },
  },
  required: ['type'],
};

// SB17: what propose_agent and propose_design ask for beyond the persona: the four parts and the cases.
const BRIEF_PARTS =
  'Four parts, each starting a line: "Input:" (what each message or item brings), "Steps:" (numbered, naming its tools), "Output:" (what it answers, how long), "Hand over when:" (what it does not decide alone)';
const CASES_ASK = '3 to 5 test cases, one plain line each: what a person would send it => what a right answer says';

const TOOLS: ToolSpec[] = [
  {
    name: 'search_nodes',
    description: 'Search the nodes an agent can use as tools, from every plugin online, by keywords ("slack message", "jira issue", "postgres query"). Returns type ids, names, plugins and the credentials they need.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_node_docs',
    description: 'Read a node type\'s parameters (options, defaults, when they show) and credentials, before setting its parameters in a tool.',
    inputSchema: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] },
  },
  {
    name: 'list_workflows',
    description: 'The workflows an agent can call as tools (they start with "When Called by a Workflow or Agent"), with ids and descriptions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_agents',
    description: 'The other agents on this instance an agent can delegate to, with ids, roles and descriptions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_credentials',
    description: 'The credentials the user has, by name and type (never their values): which tools can work right away.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_models',
    description: 'The chat models the agent can run on, best first: local Ollama models (which call tools) before hosted ones.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_knowledge_bases',
    description: 'The knowledge bases other agents search (vector store collections of documents), with what each holds, and whether a new empty one can be started.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_templates',
    description: 'Persona templates to start from (support lead, researcher, incident responder…), with ids, roles and tones.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_agent',
    description: 'Show the user the whole agent as a draft to review and create. Each call replaces the earlier draft, so always send every field, not only what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line: what this draft is or what changed' },
        templateId: { type: 'string', description: 'Optional: a template id from list_templates to start from; the fields you give win' },
        name: { type: 'string', description: 'A short name, a person-like name is fine ("Helpdesk Hana")' },
        description: { type: 'string', description: 'One sentence: what it does' },
        role: { type: 'string', description: 'What it is in a few words ("Customer support lead")' },
        audience: { type: 'string', description: 'Who it helps' },
        mission: { type: 'string', description: 'What it does for them' },
        whatIDo: { type: 'array', items: { type: 'string' }, description: 'Up to 3 short lines (under 80 characters) for its team card: "Triages new tickets"' },
        tones: { type: 'array', items: { type: 'string' }, description: '2–3 words: Precise, Friendly, Calm, Direct, Warm, Brief, Thorough, Patient, Formal, Empathetic' },
        length: { type: 'string', enum: ['sentence', 'paragraph', 'detailed'] },
        always: { type: 'array', items: { type: 'string' }, description: 'Rules, a sentence each' },
        never: { type: 'array', items: { type: 'string' } },
        instructions: { type: 'string', description: BRIEF_PARTS }, // SB17:
        cases: { type: 'array', items: { type: 'string' }, description: CASES_ASK }, // SB17:
        model: { type: 'string', description: 'The chat model it runs on, as list_models gives it ("ollama/qwen3-coder:30b"): the first one unless the job needs another' },
        icon: { type: 'string', description: 'A lucide icon name: bot, headset, siren, search, database, chart-line, mail, calendar, code, shield, rocket, newspaper, briefcase' },
        tools: { type: 'array', items: TOOL_SCHEMA },
        missing: { type: 'array', items: { type: 'string' }, description: 'Parts of the job no node online can do, left out of the tools, as the app’s name, a colon and what the agent would do: "Grafana: read firing alerts"' },
      },
      required: ['summary', 'name', 'role', 'instructions', 'tools'],
    },
  },
];

/**
 * propose_agent with only plain strings, for designAgent's short attempt and the dialog on Ollama models: qwen3-coder
 * writes a tool call as XML, and Ollama's parser fails on the nested arrays of objects propose_agent takes ("XML syntax
 * error … unexpected EOF").
 * `fromDesign` turns it into propose_agent's arguments.
 */
const DESIGN_TOOL: ToolSpec = {
  name: 'propose_design',
  description:
    'Show the user the whole agent as a draft to review and create. Every value is plain text. ' + // SB06:
    'Each call replaces the earlier draft, so always send every field, not only what changed.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One line: what this draft is or what changed' }, // SB06:
      name: { type: 'string', description: 'A short name, a person-like name is fine ("Helpdesk Hana")' }, // SB06:
      audience: { type: 'string', description: 'Who it helps' }, // SB06:
      mission: { type: 'string', description: 'What it does for them' }, // SB06:
      always: {
        type: 'string',
        description: 'Rules it always follows, one per line, a sentence each; empty for none',
      }, // SB06:
      never: { type: 'string', description: 'Rules it never breaks, one per line; empty for none' }, // SB06:
      answerLength: {
        type: 'string',
        enum: ['short', 'medium', 'long'],
        description: 'How long its answers are',
      }, // SB06:
      workflowTools: {
        type: 'string',
        description: 'Workflow ids (list_workflows) it calls as tools, comma-separated; empty for none',
      }, // SB06:
      agentTools: {
        type: 'string',
        description: 'Agent ids (list_agents) it delegates to, comma-separated; empty for none',
      }, // SB06:
      role: { type: 'string', description: 'What it is in a few words ("Contract reviewer")' },
      description: { type: 'string', description: 'One sentence: what it does' },
      instructions: { type: 'string', description: BRIEF_PARTS }, // SB17:
      cases: { type: 'string', description: `${CASES_ASK}; one line per case` }, // SB17:
      whatIDo: { type: 'string', description: 'Up to 3 short lines for its team card, one per line' },
      tones: { type: 'string', description: '2–3 words, comma-separated: Precise, Direct, Thorough…' },
      model: { type: 'string', description: 'One of the models listed ("ollama/qwen3-coder:30b")' },
      knowledge: { type: 'string', description: 'A knowledge base collection it searches (an existing one, or a new lowercase-dashes name); empty for none' },
      knowledgeDescription: { type: 'string', description: 'What that knowledge base holds, one sentence' },
      nodeTools: { type: 'string', description: 'Node type ids it calls as tools, comma-separated; empty for none' },
      missing: { type: 'string', description: 'What no node here can do, one per line: "Grafana: read firing alerts"; empty for none' },
    },
    required: ['role', 'instructions', 'model'],
  },
};

/** SB06: the tools with propose_agent replaced by the flat propose_design. */
const flatTools = (list: ToolSpec[]): ToolSpec[] => list.map((t) => (t.name === 'propose_agent' ? DESIGN_TOOL : t));

const plain = (value: unknown): string =>
  typeof value === 'string'
    ? value.replace(LEAKED_MARKUP, '').trim()
    : Array.isArray(value)
      ? value.filter((v) => typeof v === 'string').map((v) => plain(v)).filter(Boolean).join('\n')
      : '';

/** propose_design's plain strings as propose_agent's arguments. */
export function fromDesign(args: Record<string, unknown>): Record<string, unknown> {
  const list = (value: unknown, split: RegExp) => plain(value).split(split).map((v) => v.trim()).filter(Boolean);
  const knowledge = plain(args.knowledge);
  const tools: Array<Record<string, unknown>> = [ // SB06: workflow and agent tools join node and knowledge ones
    ...(knowledge && !/^(none|no|n\/a|-)$/i.test(knowledge) ? [{ type: 'knowledge', collection: knowledge, ...(plain(args.knowledgeDescription) && { description: plain(args.knowledgeDescription) }) }] : []),
    ...list(args.nodeTools, /[,\n]/).filter((t) => !/^(none|no|n\/a|-)$/i.test(t)).map((nodeType) => ({ type: 'node', nodeType })),
  ];
  const none = /^(none|no|n\/a|-)$/i; // SB06:
  /** A rule a model writes as "none" (or "no", "n/a", "-") is no rule. */
  const rules = (value: unknown) => list(value, /\n/).filter((rule) => !none.test(rule)); // SB06:
  const lengths: Record<string, string> = {
    short: 'sentence',
    medium: 'paragraph',
    long: 'detailed',
    sentence: 'sentence',
    paragraph: 'paragraph',
    detailed: 'detailed',
  };
  const length = lengths[plain(args.answerLength).toLowerCase()]; // SB06:
  tools.push(
    ...list(args.workflowTools, /[,\n]/)
      .filter((id) => !none.test(id))
      .map((workflowId) => ({ type: 'workflow', workflowId })), // SB06:
    ...list(args.agentTools, /[,\n]/)
      .filter((id) => !none.test(id))
      .map((agentId) => ({ type: 'agent', agentId })), // SB06:
  );
  return {
    // SB06: without a summary the dispatch's "Draft: <name>" applies
    ...(plain(args.summary) && { summary: plain(args.summary) }),
    ...(plain(args.name) && { name: plain(args.name) }), // SB06:
    ...(plain(args.audience) && { audience: plain(args.audience) }), // SB06:
    ...(plain(args.mission) && { mission: plain(args.mission) }), // SB06:
    ...(rules(args.always).length && { always: rules(args.always) }), // SB06:
    ...(rules(args.never).length && { never: rules(args.never) }), // SB06:
    ...(length && { length }), // SB06:
    role: plain(args.role),
    ...(plain(args.description) && { description: plain(args.description) }),
    instructions: plain(args.instructions),
    ...(plain(args.cases) && { cases: list(args.cases, /\n/) }), // SB17:
    whatIDo: list(args.whatIDo, /\n/),
    tones: list(args.tones, /,/),
    ...(plain(args.model) && { model: plain(args.model) }),
    tools,
    missing: list(args.missing, /\n/).filter((m) => !/^(none|no|n\/a|-)$/i.test(m)),
  };
}

const SYSTEM = `You are the Agent architect in Landflow, an n8n-like automation platform where every node comes from a plugin (TypeScript, Python or Go). You design agents with the user: who the agent is, how it talks, its instructions and the tools it uses. You never create the agent: you propose it, and the user reviews the draft and clicks Create.

An agent is:
- a persona: name, role, who it helps (audience), what it does for them (mission), 2–3 tones, answer length, rules it always and never follows;
- instructions: how it works, step by step, naming its tools;
- a model: the chat model it runs on (list_models; a local one first, the first listed unless the job needs another);
- tools: plugin nodes it calls (type "node"), workflows it calls (type "workflow"), other agents it delegates to (type "agent"), knowledge bases it searches (type "knowledge").

How to work:
- If the request is too vague to pick tools (no task, or no system to work in), ask one short question. Otherwise don't ask: design.
- Research before proposing: search_nodes for each thing the agent must do (read tickets, post to Slack, query a database…), get_node_docs for each node you use, list_workflows and list_agents when an existing workflow or agent could do part of the job, list_credentials to see what works right away, list_templates when one fits as a start.
- Use only node types search_nodes returned, and ids list_workflows and list_agents returned. If nothing online can do a part of the job, leave it out of the tools, list it in propose_agent's "missing" as the app's name, a colon and what the agent would do ("Grafana: read firing alerts"), and say so in one sentence; never invent a node type.
- A node tool's parameters: set what is fixed for this agent (the operation, a resource); what the agent decides per call is "{{ $fromAI('key', 'what it is', 'string') }}". Never make up ids, channels, URLs or emails the user didn't give: leave those for the user.
- An agent that answers from documents (policies, contracts, docs, past tickets) searches a knowledge base: list_knowledge_bases, use one whose description fits, else start an empty one (type "knowledge" with a new collection name) and tell the user to add documents to it.
- Give each node tool a snake_case name and a one-sentence description of when to call it.
- Tools are actions the agent takes. How it is started (a webhook, a schedule, Slack or Teams, a workflow) isn't a tool: the user sets that under the agent's Abilities → Triggers, so say it in your reply instead.
- The model itself reads, parses, summarises and formats text: don't add a tool (a Code node, a formatter) for that.
- Keep the agent focused: the fewest tools that do the job, read before write, rules that matter, instructions of a few short steps. Give it a tool only for an app the request names or its job plainly needs: no Slack, email or other agents unless asked.
- Instructions have four parts, each starting a line: "Input:" (what each message or item brings), "Steps:" (numbered, naming its tools), "Output:" (what it answers, how long) and "Hand over when:" (what it does not decide alone).
- Send 3 to 5 test cases in "cases": what a person would send it => what a right answer says, one plain line each. On a change, send them again unless the change affects them.
- When the request asks for "our practices" (standards, guidelines, conventions), the agent follows the practices the company approved: that is handled for you, don't add a tool for it.
- propose_agent replaces the whole draft each time: when the user asks for a change, send the complete agent again with the change.
- After proposing, say in one to three sentences what the agent does and what the user still has to finish (pick credentials, a model, fill in a value). Never say the agent was created. Don't repeat the draft in prose: it shows beside the chat.
- Be brief and concrete; no headings.`;

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const shorten = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
/** A list the model may send as an array or as one string, split on `split` ("Precise, Calm" or rules a line each). */
/** Tool-call markup a local model leaks into a value ("<parameter=0>", "</function>"). */
const LEAKED_MARKUP = /<\/?(?:parameter|function|tool_call)\b[^>]*>/g;

const texts = (value: unknown, max: number, count: number, split: RegExp) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(split) : [])
    .flatMap((v) => text(typeof v === 'string' ? v.replace(LEAKED_MARKUP, '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '') : v, max) ?? [])
    .slice(0, count);

/** A tool name the providers accept: lower snake_case, at most 64 characters. */
export const toolName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'tool';

/**
 * A model may send the tools (or a list of rules) as a JSON string rather than an array, or as a list in brackets
 * without quotes ("[Calm, Direct]", "[Always cite, Always be brief]"): its items start with a capital after a comma.
 */
export function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    const list = /^\s*\[([^]*)\]\s*$/.exec(value);
    if (!list) return value;
    return list[1].split(/\n|,\s*(?=["'“A-Z])/).flatMap((item) => item.trim().replace(/^["'“]|["'”]$/g, '') || []);
  }
}

/** The workflows an agent can call: they start with core.workflowTrigger and the actor may read them. */
function callableWorkflows(actor: Actor) {
  return store.listWorkflows().filter((w) => w.nodes.some((n) => n.type === 'core.workflowTrigger') && canResource(actor, 'workflow', w.id, 'read'));
}

const otherAgents = (actor: Actor) => agentStore.summaries().filter((a) => canResource(actor, 'agent', a.id, 'read'));

// SB17: the agent brief: fixed parts, approved practices, least privilege, approval on writes, guardrails and cases.

/** A request that asks for the company's approved practices ("our practices", "our standards", "our guidelines", "our conventions"). */
export const PRACTICES_ASK = /\bour\s+(?:approved\s+)?(?:practices?|standards?|guidelines?|conventions?)\b/i;
/** A request that asks to hand work to another agent. */
export const HANDOVER_ASK = /\b(?:hand(?:s|ed)?\s+(?:it\s+|them\s+|this\s+|work\s+)?(?:over|off)|delegat\w*|(?:another|other|second|specialist|sub-?)\s*agents?|escalat\w*\s+to\s+an?\s+agent|run\s+an?\s+agent|team\s+of\s+agents)\b/i;
/** A request that asks the agent to change something outside: post, send, comment, create, update, delete, merge … ("create an agent" is not one). */
const WRITE_ASK = /\b(?:post|send|reply|replies|comment\w*|create|raise|update|change|edit|write|delete|remove|merge|notify|alert|e-?mail|publish|commit|push|assign|close|refund|approve|archive|open\s+an?|file\s+an?)\b/i;
const AGENT_ASK = /\b(?:create|make|build|design|add)\s+(?:me\s+)?an?\s+(?:[\w-]+\s+){0,2}agent\b/gi;
/** A request that says what the agent answers from: documents, docs, a knowledge base, policies … (a knowledge tool needs one). */
export const KNOWLEDGE_ASK = /\b(?:knowledge|docs?|documents?|documentation|wiki|playbooks?|policies|policy|manuals?|faq|handbook|runbooks?|articles?|past\s+(?:tickets|answers)|contracts?)\b/i;
/** Words of a node's keywords too general to say the request names its app. */
const GENERIC_KEYWORDS = new Set(['comment', 'message', 'messages', 'trigger', 'webhook', 'file', 'files', 'send', 'create', 'update', 'search', 'record', 'records', 'database', 'table', 'event', 'events']);
const REPOSITORY = /(?<![\w./-])(?!(?:and\/or|either\/or|he\/she|s\/he|i\/o|ci\/cd|n\/a|w\/o|yes\/no|input\/output)\b)[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?![\w/-])/i;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the request names the app of a node (its name, plugin id or one of its specific keywords). */
export function appNamed(info: NodeTypeInfo, request: string): boolean {
  const asked = request.toLowerCase();
  const d = info.descriptor;
  const names = [info.pluginId, d.displayName].map((n) => n?.toLowerCase().trim()).filter((n): n is string => Boolean(n) && n.length >= 3);
  const words = (d.keywords ?? []).map((k) => k.toLowerCase().trim()).filter((k) => (k.length >= 5 || k.includes(' ')) && !GENERIC_KEYWORDS.has(k));
  return [...names, ...words].some((n) => new RegExp(`(?<![a-z0-9])${escapeRegExp(n)}(?:e?s)?(?![a-z0-9])`).test(asked));
}

/** Whether the request asks the agent to change something outside (not counting "create an agent"). */
export const asksToWrite = (request: string) => WRITE_ASK.test(request.replace(AGENT_ASK, ' '));

/** The operation options visible under these parameters, with whether the plugin marks each safe to repeat (a read). */
function operationsOf(info: NodeTypeInfo, parameters: Record<string, unknown>) {
  return info.descriptor.properties.filter((p) => p.name === 'operation' && isPropertyVisible(p, parameters)).flatMap((p) => p.options ?? []);
}

/**
 * Whether the tool changes something outside. The shared heuristic (run-check.ts `writesOutside`) reads the operation's
 * name; a plugin that marks its reads (`idempotent: true` on an operation) also tells which operations are not reads
 * ("commit", "merge"), so an operation of such a node that is not marked is a write.
 */
function toolWrites(info: NodeTypeInfo, parameters: Record<string, unknown>): boolean {
  if (writesOutside({ type: info.type, parameters })) return true;
  const options = operationsOf(info, parameters);
  const current = options.find((o) => o.value === parameters.operation);
  const marksReads = info.descriptor.properties.some((p) => p.name === 'operation' && p.options?.some((o) => o.idempotent === true));
  return Boolean(current && marksReads && current.idempotent !== true);
}

/**
 * A read for a tool the model left on the node's defaults: the resource the request talks about ("pull requests"), else the
 * default one, and its first operation the plugin marks as a read.
 */
function readDefaults(info: NodeTypeInfo, parameters: Record<string, unknown>, request: string): Record<string, unknown> {
  const asked = request.toLowerCase();
  const resource = info.descriptor.properties.find((p) => p.name === 'resource')?.options?.find((o) => {
    const words = [o.name, String(o.value).replace(/([a-z])([A-Z])/g, '$1 $2')].map((w) => w.toLowerCase());
    return words.some((w) => w.length > 3 && asked.includes(w));
  });
  const next = { ...parameters, ...(resource && { resource: resource.value }) };
  const read = operationsOf(info, next).find((o) => o.idempotent === true);
  return read ? { ...next, operation: read.value } : parameters;
}

/** "what a person would send => what a right answer says", one per line (or a list of such lines): at most 5, each input under 4 000 characters. */
export function parseCases(value: unknown, needsExpected = false): AgentCaseDraft[] {
  const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
  const cases: AgentCaseDraft[] = [];
  for (const raw of lines) {
    if (typeof raw !== 'string') continue;
    const line = raw.replace(LEAKED_MARKUP, '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    const [input, ...rest] = line.split(/\s*(?:=>|⇒|→)\s*/);
    const asked = input.replace(/^["'“]|["'”]$/g, '').trim().slice(0, 4000);
    const expected = rest.join(' => ').replace(/^["'“]|["'”]$/g, '').trim().slice(0, 1000);
    if (asked.length < 3 || (needsExpected && !expected)) continue;
    if (cases.some((c) => c.input.toLowerCase() === asked.toLowerCase())) continue;
    cases.push({ input: asked, ...(expected && { expected }) });
    if (cases.length === 5) break;
  }
  return cases;
}

const PART_LINE = /^\s*(?:#{1,4}\s*|\*\*|__)?\s*(input|steps|output|hand[ -]?over(?:\s+when)?)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;

/**
 * The instructions in four headed parts, in order: Input, Steps, Output, Hand over when. A part the draft has is kept; one it
 * lacks is written from what the draft says of itself (its audience, mission, description, answer length and tools).
 */
export function briefParts(
  instructions: string,
  fill: { audience?: string; mission?: string; description?: string; length?: AnswerLength; tools: string[]; writes: boolean },
): string {
  const parts: string[][] = [[], [], [], []];
  const preamble: string[] = [];
  let at = -1;
  for (const line of instructions.split('\n')) {
    const head = PART_LINE.exec(line);
    if (head) {
      const name = head[1].toLowerCase();
      at = name === 'input' ? 0 : name === 'steps' ? 1 : name === 'output' ? 2 : 3;
      if (head[2].trim()) parts[at].push(head[2].trim());
    } else if (at >= 0) parts[at].push(line);
    else preamble.push(line);
  }
  const body = (lines: string[]) => lines.join('\n').trim();
  const intro = body(preamble);
  const sentence = (value: string) => (/[.!?:]$/.test(value) ? value : `${value}.`);
  const numbered = (value: string) => {
    const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.some((l) => /^(?:\d+[.)]|[-*•])\s/.test(l))) return lines.join('\n');
    return value
      .split(/(?<=[.!?])\s+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((l, i) => `${i + 1}. ${l}`)
      .join('\n');
  };
  const input = body(parts[0]) || sentence(`Each message or item that reaches it${fill.audience ? `, from ${fill.audience}` : ''}${fill.mission || fill.description ? `: ${fill.mission || fill.description}` : ''}`.replace(/\.$/, ''));
  let steps = body(parts[1]);
  if (steps && intro) steps = `${numbered(intro)}\n${steps}`;
  if (!steps && intro) steps = numbered(intro);
  // Steps name the tools: a line that does, when the given steps name none of them.
  const names = (text: string) => fill.tools.some((t) => text.toLowerCase().includes(t.toLowerCase()) || text.toLowerCase().includes(t.replace(/_/g, ' ').toLowerCase()));
  if (steps && fill.tools.length && !names(steps)) {
    const lines = numbered(steps).split('\n');
    steps = `${lines.join('\n')}\n${lines.length + 1}. Tools: ${fill.tools.join(', ')}${fill.writes ? '; read before you write, and a person approves each change' : ''}.`;
  }
  if (!steps) {
    const use = fill.tools.length ? `Use ${fill.tools.join(', ')} for what it needs${fill.writes ? '; read before you write' : ''}.` : 'Work from the message alone.';
    steps = `1. Read what the message or item asks.\n2. ${use}\n3. Answer as Output says.`;
  }
  const output =
    body(parts[2]) ||
    (fill.length === 'sentence' ? 'One sentence.' : fill.length === 'detailed' ? 'A detailed answer: the result first, then how it got there.' : 'A short paragraph (about 100 words): the result first, then why.');
  const handOver =
    body(parts[3]) ||
    `It needs something it cannot see or a choice only a person should make (an id it was not given, money, deleting, posting for someone). Say what is missing and ask; never guess.${fill.writes ? ' A change outside waits for a person to approve it.' : ''}`;
  const one = (head: string, value: string) => (value.includes('\n') ? `${head}\n${value}` : `${head} ${value}`);
  return [one('Input:', input), `Steps:\n${steps}`, one('Output:', output), one('Hand over when:', handOver)].join('\n').slice(0, 8000);
}

const REPOSITORY_NEED = (tool: string) => `${tool}: fill in Repository (owner/name): the request names none`;

/** SB17: the guardrails every drafted agent gets: its own kept, the defaults filling what is missing (tool results only with a tool). */
function briefGuardrails(own: AgentGuardrails | undefined, hasTools: boolean): AgentGuardrails {
  const defaults = structuredClone(DEFAULT_BRIEF_GUARDRAILS);
  return { ...own, input: own?.input ?? defaults.input, ...((own?.toolResult || hasTools) && { toolResult: own?.toolResult ?? defaults.toolResult }) };
}

export interface DraftResult {
  config: Partial<AgentConfig>;
  needs: ArchitectNeed[];
  dropped: string[];
  /** What the architect said no node online can do, plus node types it made up for an app no plugin covers. */
  missing: ArchitectMissing[];
  /** SB17: 3 to 5 test cases for the eval gate, from the proposal (fewer when it sent fewer: the architect asks once more). */
  cases: AgentCaseDraft[];
}

/**
 * The model's propose_agent arguments as an agent config: a template's persona under the fields given, tools checked
 * against what exists, parameters kept to the node's own (over its defaults), invented ids left out. `keep` is the
 * draft so far: its avatar, colour and team (the user may have changed them) carry over.
 */
export function draftFrom(args: Record<string, unknown>, context: { types: NodeTypeInfo[]; actor: Actor; known: string; keep?: Partial<AgentConfig>; templates?: AgentTemplate[]; resources?: AgentResources; request?: string /* SB17: */ }): DraftResult {
  const { types, actor, known, keep, request } = context; // SB17: request
  const dropped: string[] = [];
  const needs: ArchitectNeed[] = [];
  const missing: ArchitectMissing[] = [];
  const rawMissing = parsed(args.missing);
  for (const item of Array.isArray(rawMissing) ? rawMissing : typeof rawMissing === 'string' ? rawMissing.split('\n') : []) {
    // "Grafana: read firing alerts", or { capability, system }.
    const [, app, rest] = typeof item === 'string' ? (/^\s*([^:]{2,40}):\s*(.+)$/.exec(item) ?? [undefined, undefined, item]) : [];
    const capability = text(typeof item === 'string' ? rest : (item as Record<string, unknown>)?.capability, 200);
    const named = typeof item === 'string' ? text(app, 60) : item && typeof item === 'object' ? text((item as Record<string, unknown>).system, 60) : undefined;
    const system = capability && missingSystem(capability, named);
    // A plugin that is online isn't missing ("Text Toolkit: format the summary"), nor is an app one of its nodes is named
    // after ("Slack: post to a channel", with Messaging's Slack node): the model missed them.
    const online = system && types.find((t) => [t.pluginName, t.pluginId].some((n) => n && squash(n) === squash(system)));
    const node = !online && system ? types.find((t) => squash(t.descriptor.displayName) === squash(system)) : undefined;
    if (online || node) {
      dropped.push(`“${capability}” as missing: ${online ? `${online.pluginName} is online` : `${node!.pluginName}’s ${node!.descriptor.displayName} node is online`}`);
      continue;
    }
    if (capability && !missing.some((m) => m.capability.toLowerCase() === capability.toLowerCase())) missing.push({ capability, ...(system && { system }) });
  }
  const templateId = text(args.templateId, 100);
  const template = templateId ? (context.templates ?? agentTemplates.list(actor)).find((t) => t.id === templateId) : undefined;
  if (templateId && !template) dropped.push(`the template “${templateId}”, which doesn’t exist`);
  const base = template?.config ?? {};
  const name = text(args.name, 80) ?? keep?.name ?? template?.name ?? 'Untitled agent';

  const persona: AgentPersona = { ...base.persona };
  const set = <K extends keyof AgentPersona>(key: K, value: AgentPersona[K] | undefined) => {
    if (value !== undefined && (!Array.isArray(value) || value.length)) persona[key] = value;
  };
  set('role', text(args.role, 120));
  set('audience', text(args.audience, 200));
  set('mission', text(args.mission, 300));
  set('whatIDo', texts(parsed(args.whatIDo), 120, 3, /\n/));
  set('tones', texts(parsed(args.tones), 24, 4, /[,;\n]/));
  set('always', texts(parsed(args.always), 200, 8, /\n/));
  set('never', texts(parsed(args.never), 200, 8, /\n/));
  if (args.length === 'sentence' || args.length === 'paragraph' || args.length === 'detailed') {
    persona.length = args.length as AnswerLength;
  } else if (args.length === 'short') persona.length = 'paragraph'; // the old name for the middle value

  const tools: AgentToolConfig[] = [];
  const names = new Set<string>();
  const unique = (wanted: string) => {
    let candidate = toolName(wanted);
    for (let i = 2; names.has(candidate); i++) candidate = `${toolName(wanted).slice(0, 60)}_${i}`;
    names.add(candidate);
    return candidate;
  };
  const credentialList = withOwnership(actor, 'credential', credentials.list());
  const rawTools = parsed(args.tools);
  for (const raw of Array.isArray(rawTools) ? rawTools : []) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = raw as Record<string, unknown>;
    const kind = tool.type ?? (tool.nodeType ? 'node' : tool.workflowId ? 'workflow' : tool.agentId ? 'agent' : undefined);
    if (kind === 'node') {
      const asked = String(tool.nodeType ?? '');
      const info = types.find((t) => t.type === asked);
      if (!info || !usableAsTool(info)) {
        dropped.push(`${asked || 'a node tool'}: ${info ? 'not usable as a tool' : 'not a node type online here'}`);
        // A made-up type for an app no plugin online covers ("grafana.getAlerts") is a tool someone could build.
        const prefix = asked.includes('.') ? asked.slice(0, asked.indexOf('.')) : '';
        if (!info && prefix && !types.some((t) => t.pluginId === prefix)) {
          const capability = text(tool.description, 200) ?? asked;
          if (!missing.some((m) => m.capability.toLowerCase() === capability.toLowerCase())) missing.push({ capability, system: prefix.charAt(0).toUpperCase() + prefix.slice(1) });
        }
        continue;
      }
      const d = info.descriptor;
      // SB17: the model's own Check Practices tool is replaced below by the brief's, and only for a request that asks for practices.
      if (request !== undefined && info.type === 'core.practiceCheck') { dropped.push('Check Practices: the request doesn’t ask for your practices'); continue; } // SB17:
      if (request !== undefined && /^core\.message(?:Agent|Team)$/.test(info.type) && !HANDOVER_ASK.test(request)) {
        dropped.push(`${d.displayName}: the request doesn’t ask to hand over to another agent`); // SB17:
        continue;
      }
      const toolLabel = unique(text(tool.name, 64) ?? d.displayName);
      const given = parsed(tool.parameters);
      const own = new Set(d.properties.map((p) => p.name));
      const fromModel: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(given && typeof given === 'object' && !Array.isArray(given) ? given : {})) {
        if (own.has(key)) fromModel[key] = value;
        else dropped.push(`“${key}” of ${toolLabel}: not a parameter of ${d.displayName}`);
      }
      const { ops, invented } = withoutInventedIds([{ op: 'addNode', name: toolLabel, parameters: fromModel }], known, () => JSON.stringify(d.properties));
      dropped.push(...invented);
      const kept = ((ops as Array<{ parameters: Record<string, unknown> }>)[0]?.parameters ?? {}) as Record<string, unknown>;
      let parameters: Record<string, unknown> = { ...defaultParameters({ properties: d.properties.filter((p) => !(p.name in kept)) }), ...kept };
      // SB17: least privilege and a person in the loop for every write. An operation the model left to its default, which
      // writes, becomes a read the node has when the request does not ask to write.
      if (request !== undefined && !('operation' in kept) && toolWrites(info, parameters) && !asksToWrite(request)) parameters = readDefaults(info, parameters, request);
      const writes = toolWrites(info, parameters);
      if (request !== undefined && info.pluginId !== 'core' && !appNamed(info, request)) {
        names.delete(toolLabel);
        dropped.push(`${d.displayName}: the request never asks for it${writes ? ' (it would change things there)' : ''}`);
        continue;
      }
      if (request !== undefined && writes && !asksToWrite(request)) {
        names.delete(toolLabel);
        dropped.push(`${d.displayName} (${String(parameters.operation ?? 'a write')}): the request asks to read or check, not to change anything there`);
        continue;
      }
      tools.push({ id: `tl_${nanoid(8)}`, type: 'node', name: toolLabel, description: text(tool.description, 300) ?? d.toolDescription ?? d.description, nodeType: info.type, parameters, ...(writes && { requireApproval: true }) /* SB17: */ });
      for (const slot of d.credentials ?? []) {
        if (!slot.required || !isPropertyVisible(slot, parameters)) continue;
        const type = qualifyCredentialType(info.pluginId, slot.name);
        const have = credentialList.filter((c) => c.type === type).map((c) => `“${c.name}”`);
        needs.push({ tool: toolLabel, kind: 'credential', text: `${toolLabel}: pick a ${slot.name} credential${have.length ? ` (you have ${have.slice(0, 3).join(', ')})` : ' (none yet: create one under Credentials)'}` });
      }
      for (const property of d.properties) {
        const value = parameters[property.name];
        if (!property.required || property.type === 'notice' || !isPropertyVisible(property, parameters)) continue;
        if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) needs.push({ tool: toolLabel, kind: 'parameter', text: `${toolLabel}: fill in ${property.displayName}` });
      }
    } else if (kind === 'workflow') {
      const workflow = callableWorkflows(actor).find((w) => w.id === tool.workflowId);
      if (!workflow) {
        dropped.push(`the workflow ${String(tool.workflowId ?? '')}: not one an agent can call`);
        continue;
      }
      tools.push({ id: `tl_${nanoid(8)}`, type: 'workflow', workflowId: workflow.id, name: unique(text(tool.name, 64) ?? workflow.name), description: text(tool.description, 300) ?? workflow.description ?? workflow.name });
    } else if (kind === 'agent') {
      const agent = otherAgents(actor).find((a) => a.id === tool.agentId);
      if (!agent) {
        dropped.push(`the agent ${String(tool.agentId ?? '')}: not on this instance`);
        continue;
      }
      if (tools.some((t) => t.type === 'agent' && t.agentId === agent.id)) continue;
      if (request !== undefined && !HANDOVER_ASK.test(request) && !(agent.name && request.toLowerCase().includes(agent.name.toLowerCase()))) {
        dropped.push(`the agent “${agent.name}”: the request doesn’t ask to hand over to another agent`); // SB17:
        continue;
      }
      tools.push({ id: `tl_${nanoid(8)}`, type: 'agent', agentId: agent.id, ...(text(tool.useWhen ?? tool.description, 300) && { useWhen: text(tool.useWhen ?? tool.description, 300) }) });
    } else if (kind === 'knowledge') {
      const collection = text(tool.collection ?? tool.name, 80)?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!collection) {
        dropped.push('a knowledge base without a collection');
        continue;
      }
      if (tools.some((t) => t.type === 'knowledge' && !isNodeKnowledge(t) && t.collection === collection)) continue;
      // SB17: a knowledge base only for a request that says what it answers from (practices are the Check Practices node's, not documents).
      if (request !== undefined && !KNOWLEDGE_ASK.test(request)) {
        dropped.push(`the knowledge base “${collection}”: the request doesn’t say what it answers from`);
        continue;
      }
      const existing = context.resources?.knowledge.find((k) => k.collection === collection);
      const embeddings = existing?.embeddings ?? context.resources?.embeddings;
      if (!embeddings) {
        dropped.push(`the knowledge base “${collection}”: no embeddings model is pulled in Ollama (ollama pull nomic-embed-text)`);
        continue;
      }
      const label = unique(text(tool.name, 64) ?? `search_${collection}`);
      const description = text(tool.description, 300) ?? existing?.description ?? `Search the ${collection} documents`;
      if (existing) {
        const { usedBy: _usedBy, ...base } = existing;
        tools.push({ ...base, id: `tl_${nanoid(8)}`, type: 'knowledge', name: label, description });
      } else {
        tools.push({ id: `tl_${nanoid(8)}`, type: 'knowledge', name: label, description, store: 'sqlite', collection, embeddings });
        needs.push({ tool: label, kind: 'parameter', text: `${label}: add documents to the new “${collection}” knowledge base (the agent's Knowledge tab)` });
      }
    } else {
      dropped.push(`a tool of kind “${String(kind ?? 'unknown')}”`);
    }
  }
  // SB17: a request for "our practices" keeps the approved practices in the prompt and gives the agent the Check Practices node.
  const practicesAsked = request !== undefined && PRACTICES_ASK.test(request);
  if (practicesAsked) {
    const info = types.find((t) => t.type === 'core.practiceCheck');
    if (!info) dropped.push('Check Practices: not a node online here');
    else {
      const repository = REPOSITORY.exec(request)?.[0] ?? '';
      const label = unique('check_practices');
      const parameters = {
        ...defaultParameters({ properties: info.descriptor.properties }),
        repository,
        changedFiles: "{{ $fromAI('changedFiles', 'the files the change touches: [{ path, status }]', 'json') }}",
      };
      tools.push({ id: `tl_${nanoid(8)}`, type: 'node', name: label, description: 'Check the change’s files against the practices the company approved; it says which practice a file breaks.', nodeType: info.type, parameters });
      if (!repository) needs.push({ tool: label, kind: 'parameter', text: REPOSITORY_NEED(label) });
    }
  }
  // The model it runs on: one the host has, the local one Spotlight uses unless another was named.
  const model = context.resources ? chooseModel(args.model, context.resources.models) : undefined;
  if (args.model && model && !String(args.model).endsWith(model.model)) dropped.push(`the model “${String(args.model)}”, which isn't here: it runs on ${model.provider}/${model.model}`);
  if (context.resources && !model) needs.push({ tool: 'model', kind: 'parameter', text: 'Pick a model: no local model is pulled in Ollama' });

  const about = text(args.description, 300) ?? base.description ?? keep?.description ?? '';
  const config: Partial<AgentConfig> = {
    ...(template && { ...base, tools: undefined }),
    name,
    description: about,
    icon: text(args.icon, 40) ?? base.icon ?? keep?.icon ?? 'bot',
    color: keep?.color ?? base.color ?? '#6366f1',
    avatar: keep?.avatar ?? base.avatar ?? { kind: 'face', face: randomFace(name) },
    ...(keep?.team && { team: keep.team }),
    ...(Object.keys(persona).length && { persona }),
    instructions: briefParts(text(args.instructions, 8000) ?? base.instructions ?? '', {
      ...(persona.audience && { audience: persona.audience }),
      ...(persona.mission && { mission: persona.mission }),
      ...(about && { description: about }),
      ...(persona.length && { length: persona.length }),
      tools: tools.flatMap((t) => ('name' in t && t.name ? [t.name] : [])),
      writes: tools.some((t) => t.type === 'node' && t.requireApproval),
    }), // SB17:
    ...((model ?? keep?.model ?? base.model) && { model: model ?? keep?.model ?? base.model }),
    tools,
    ...(practicesAsked && { practices: 'on' as const }), // SB17:
    guardrails: briefGuardrails(keep?.guardrails ?? base.guardrails, tools.length > 0), // SB17:
  };
  return { config, needs, dropped, missing, cases: parseCases(parsed(args.cases)) /* SB17: */ };
}

/**
 * SB17: one small call for the cases alone (the agent's description and the request), when a proposal came with fewer than 3.
 * It runs inside the architect's scope, so it counts as its calls do; a model that fails leaves the cases to the person.
 */
async function casesFor(model: LanguageModel, agent: { name: string; description: string; request: string }, usage: { inputTokens: number; outputTokens: number }, signal?: AbortSignal): Promise<AgentCaseDraft[]> {
  const system = 'You write test cases for an AI agent. Answer with 3 to 5 lines and nothing else, one case per line, plain text: what a person would send it => what a right answer says.';
  const messages: AgentMessage[] = [{ role: 'user', content: `Agent: ${agent.name}\nWhat it does: ${agent.description}\nThe request it was designed from:\n${agent.request.slice(0, 1500)}` }];
  try {
    const turn = await withCallNote({ purpose: 'answer', draft: plainDraft({ system, tools: [], messages }) }, () => model.generate({ system, messages, tools: [], ...(signal && { signal }) }));
    usage.inputTokens += turn.usage?.inputTokens ?? 0;
    usage.outputTokens += turn.usage?.outputTokens ?? 0;
    return parseCases(turn.text, true); // prose around the lines has no "=>"
  } catch (caught) {
    if (isUsageCapError(caught)) throw caught;
    return [];
  }
}

/** The architect: its model calls count in AI usage (surface `architect`) and under the caller's caps. */
export function runArchitect(input: ArchitectInput): Promise<void> {
  const scope = assistantScope({ surface: 'architect', userId: input.actor.id });
  return runInUsageScope(scope, () => architect(input, scope));
}

async function architect(input: ArchitectInput, scope: UsageScope): Promise<void> {
  const { onEvent, actor } = input;
  const trace = input.trace === true;
  const types = input.types.filter(usableAsTool);
  const model = assistantModel(input.model); // SB06: moved up, the tool choice reads its provider
  // SB06: a local model is offered the flat propose_design in propose_agent's place: its nested arrays don't survive
  // Ollama's parser.
  const tools = input.only
    ? [...TOOLS, DESIGN_TOOL].filter((t) => input.only!.includes(t.name))
    : model.provider === 'ollama'
      ? flatTools(TOOLS)
      : TOOLS;
  const started = Date.now();
  let draft = input.resume ? input.resume.draft : input.draft;
  let said = input.resume?.said ?? '';
  let proposals = input.resume?.proposals ?? 0;
  /** The last proposal's arguments, as sent: local models propose the same agent again and again. */
  let lastProposal: string | undefined = input.resume?.lastProposal;
  /** Missing tools recorded in this reply, once each. */
  const recorded = new Set<string>();
  const usage = { inputTokens: 0, outputTokens: 0 };
  // SB17: the person's words (the least-privilege rules read them) and the cases the last proposal came with.
  const requestText = input.request ?? input.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  let cases: AgentCaseDraft[] = [];
  const known = () => [...input.messages.map((m) => m.content), JSON.stringify(draft ?? {})].join('\n');
  const draftJson = draft ? JSON.stringify({ ...draft, avatar: undefined }).slice(0, 6000) : '';
  const system = [
    SYSTEM,
    `\nPlugins online and the nodes an agent can use from them (search_nodes for details):\n${catalogSummary(types)}`,
    input.projectId ? builderContextEntry(input.actor, { projectId: input.projectId }) : '', // PC10
    draft
      ? `\nThe draft so far (a new proposal replaces it):\n${draftJson}`
      : '',
  ].join('\n');

  let currentStep = 0;
  const execute = async (call: ToolCall): Promise<ToolResult> => {
    const toolStarted = Date.now();
    let detail: string | undefined;
    const result = (content: string, label: string, ok = true): ToolResult => {
      onEvent({ type: 'tool', name: call.name, label, ok, id: `t_${nanoid(8)}`, step: currentStep, durationMs: Date.now() - toolStarted, ...(detail && { detail: shorten(detail, 300) }) });
      return { id: call.id, name: call.name, content, ...(!ok && { isError: true }) };
    };
    const design = call.name === DESIGN_TOOL.name;
    const args = design ? fromDesign(call.input ?? {}) : (call.input ?? {});
    switch (design ? 'propose_agent' : call.name) {
      case 'search_nodes': {
        const query = String(args.query ?? '');
        detail = `“${query}”`;
        const hits = searchNodes(query, types).map(({ score: _score, ...hit }) => {
          const info = types.find((t) => t.type === hit.type);
          const needed = info?.descriptor.credentials?.filter((c) => c.required).map((c) => c.name);
          return { ...hit, ...(info && { plugin: info.pluginId === 'core' ? 'Built in' : info.pluginName }), ...(needed?.length && { credentials: needed }) };
        });
        return result(hits.length ? JSON.stringify(hits) : `No node an agent can use matches “${query}”. Try other words; if nothing fits, that part isn't available here.`, `Searched plugins for “${shorten(query, 40)}”`);
      }
      case 'get_node_docs': {
        const asked = String(args.type ?? '');
        detail = asked;
        // By type id, by the id without its plugin ("httpRequest"), or by name ("HTTP Request", "http.request").
        const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
        const info =
          types.find((t) => t.type === asked) ??
          types.find((t) => plain(t.type.slice(t.type.indexOf('.') + 1)) === plain(asked) || plain(t.descriptor.displayName) === plain(asked) || plain(t.type) === plain(asked));
        if (!info) {
          const close = searchNodes(asked, types, 3).map((h) => h.type);
          return result(`Unknown node type “${asked}”.${close.length ? ` Did you mean: ${close.join(', ')}?` : ''}`, `Looked up “${shorten(asked, 40)}”: not found`, false);
        }
        return result(nodeDocs(info), `Read ${info.descriptor.displayName} docs`);
      }
      case 'list_workflows': {
        const list = callableWorkflows(actor).map((w) => ({ id: w.id, name: w.name, ...(w.description && { description: w.description }) }));
        return result(list.length ? JSON.stringify(list) : 'No workflow starts with “When Called by a Workflow or Agent” yet.', `Listed ${list.length} callable workflow${list.length === 1 ? '' : 's'}`);
      }
      case 'list_agents': {
        const list = otherAgents(actor).map((a) => ({ id: a.id, name: a.name, ...(a.role && { role: a.role }), ...(a.description && { description: shorten(a.description, 160) }) }));
        return result(list.length ? JSON.stringify(list) : 'There are no other agents yet.', `Listed ${list.length} agent${list.length === 1 ? '' : 's'}`);
      }
      case 'list_credentials': {
        const list = withOwnership(actor, 'credential', credentials.list()).map((c) => ({ name: c.name, type: c.type }));
        return result(list.length ? JSON.stringify(list) : 'The user has no credentials yet.', `Listed ${list.length} credential${list.length === 1 ? '' : 's'}`);
      }
      case 'list_models': {
        const list = input.resources?.models ?? [];
        return result(list.length ? JSON.stringify(list.map((m) => ({ model: `${m.provider}/${m.model}`, note: m.note }))) : 'No models are known here: leave the model out; the user picks one.', `Listed ${list.length} model${list.length === 1 ? '' : 's'}`);
      }
      case 'list_knowledge_bases': {
        const list = input.resources?.knowledge ?? [];
        const fresh = input.resources?.embeddings ? `A new empty one can be started (type "knowledge" with a new collection name), embedded with ${input.resources.embeddings.model}.` : 'No embeddings model is pulled, so no new one can be started.';
        return result(`${list.length ? JSON.stringify(list.map((k) => ({ collection: k.collection, description: k.description, store: k.store, usedBy: k.usedBy }))) : 'No agent searches a knowledge base yet.'} ${fresh}`, `Listed ${list.length} knowledge base${list.length === 1 ? '' : 's'}`);
      }
      case 'list_templates': {
        const list = agentTemplates
          .list(actor)
          .filter((t) => t.id !== 'blank')
          .map((t) => ({ id: t.id, name: t.name, category: t.category, description: t.description, ...(t.config.persona?.role && { role: t.config.persona.role }), ...(t.config.persona?.tones?.length && { tones: t.config.persona.tones }) }));
        return result(JSON.stringify(list), `Listed ${list.length} templates`);
      }
      case 'propose_agent': {
        const { summary: _summary, ...rest } = args;
        detail = text(args.summary, 200);
        const asSent = JSON.stringify(rest);
        if (asSent === lastProposal) return result('Nothing changes: you proposed exactly this agent already. Do not propose it again; answer the user.', 'Skipped a repeated proposal');
        lastProposal = asSent;
        const { config, needs, dropped, missing, cases: proposed } = draftFrom(args, { types, actor, known: known(), keep: draft, request: requestText, ...(input.resources && { resources: input.resources }) });
        const summary = shorten(text(args.summary, 200) ?? `Draft: ${config.name}`, 140);
        draft = config;
        proposals++;
        // The second brain's "Missing tool" suggestions read these (docs/second-brain.md).
        for (const item of missing) {
          const key = `${item.system ?? ''}|${item.capability}`.toLowerCase();
          if (recorded.has(key)) continue;
          recorded.add(key);
          recordUsage({ kind: 'tool.missing', actorId: actor.id, message: item.capability, attrs: { source: 'architect', ...(item.system && { system: item.system }), ...(config.name && { agent: config.name }) } });
        }
        // SB17: 3 to 5 cases from the proposal, else the ones of the last proposal, else one small follow-up call; still fewer: say so.
        cases = proposed.length >= 3 ? proposed : cases.length >= 3 ? cases : proposed;
        if (cases.length < 3) {
          const more = await casesFor(model, { name: config.name ?? '', description: config.description ?? '', request: requestText }, usage, input.signal);
          cases = more.length > proposed.length ? more : proposed;
        }
        if (cases.length < 3) needs.push({ tool: 'test cases', kind: 'parameter', text: 'Add test cases on the Evaluations tab' });
        onEvent({ type: 'draft', id: `dr_${nanoid(8)}`, summary, config, needs, dropped, missing, cases });
        const notes = [dropped.length ? `Left out: ${dropped.join('; ')}.` : '', missing.length ? `Noted as missing (the user sees it): ${missing.map((m) => m.capability).join('; ')}.` : '', needs.length ? `The user still has to: ${needs.map((n) => n.text).join('; ')}.` : ''].filter(Boolean).join(' ');
        return result(`Shown to the user beside the chat with a Create button (${config.tools?.length ?? 0} tools). ${notes} Don't repeat the draft or say it was created.`, `Proposed “${shorten(config.name ?? 'agent', 40)}” with ${config.tools?.length ?? 0} tools`);
      }
      default:
        return result(`Unknown tool ${call.name}`, `Unknown tool ${call.name}`, false);
    }
  };

  await traceAssistant('architect', { 'gen_ai.request.model': model.model, 'landflow.assistant.turns': input.messages.length }, async (span, setOutcome) => {
    const history: AgentMessage[] = input.resume ? [...input.resume.history] : input.messages.map((m) => (m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', text: m.content, toolCalls: [] }));
    let steps = input.resume?.steps ?? 0;
    const stepLimit = steps + MAX_ARCHITECT_STEPS;
    let finished = false;
    const fail = (caught: unknown, kind: 'model' | 'cap' | 'internal', failedStep: number): boolean => {
      if (!trace || input.signal?.aborted) return false;
      // The error event is the reply's end, but the request still failed: count it and mark the span.
      setOutcome(outcomeOf(caught));
      span.setAttribute('landflow.error.kind', kind);
      failSpan(span, caught);
      const keep = kind !== 'cap' && failedStep > 1 && history.at(-1)?.role === 'tool';
      const checkpoint = keep ? saveCheckpoint(actor.id, { history: [...history], steps, draft, said, proposals, ...(lastProposal && { lastProposal }) } satisfies ArchitectState, 'architect') : undefined;
      onEvent({ type: 'error', kind, message: errorText(caught), ...(checkpoint && { checkpoint, step: failedStep }) });
      return true;
    };
    try {
      while (steps < stepLimit && !finished) {
        steps++;
        currentStep = steps;
        if (trace) onEvent({ type: 'step.start', step: steps, label: steps === 1 ? 'Reading your request' : 'Thinking' });
        let offered = tools; // SB06: the retry after a parse error offers the flat tool
        const generate = () =>
          withCallNote({ purpose: 'answer', draft: plainDraft({ system, tools: offered, messages: history }) }, () =>
            model.generate({
              system,
              messages: history,
              tools: offered,
              ...(input.signal && { signal: input.signal }),
            }),
          ); // SP03:
        let turn: Awaited<ReturnType<typeof generate>>;
        try {
          // Ollama answers 500 when it can't parse the tool call qwen3-coder wrote ("XML syntax error", sometimes with
          // no detail): ask once more, as the chat does (parse-retry.ts).
          turn = await generate().catch((error: unknown) => {
            if (input.signal?.aborted || isUsageCapError(error) || !isParseError(error)) throw error; // SB06:
            span.addEvent('assistant.retry', { 'landflow.reason': parseErrorText(error) }); // SB06:
            offered = flatTools(tools); // SB06:
            return generate();
          });
        } catch (caught) {
          steps--;
          if (fail(caught, isUsageCapError(caught) ? 'cap' : 'model', steps + 1)) return;
          throw caught;
        }
        usage.inputTokens += turn.usage?.inputTokens ?? 0;
        usage.outputTokens += turn.usage?.outputTokens ?? 0;
        const { text: reply, calls } = turn.toolCalls.length
          ? { text: turn.text, calls: turn.toolCalls }
          : recoverToolCalls(turn.text, new Set([...offered.map((t) => t.name), 'propose_agent'])); // SB06:
        if (reply.trim()) {
          const shown = withoutRepeats(reply, said);
          said += `\n${reply}`;
          if (shown.trim()) onEvent({ type: 'text', text: shown });
        }
        history.push({ role: 'assistant', text: reply, toolCalls: calls, ...(turn.raw && { raw: turn.raw }) });
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
    } catch (caught) {
      if (fail(caught, 'internal', steps)) return;
      throw caught;
    }
    if (!finished) onEvent({ type: 'text', text: `(Stopped after ${MAX_ARCHITECT_STEPS} steps. Ask me to continue if there is more to do.)` });
    span.setAttribute('landflow.assistant.steps', steps);
    span.setAttribute('landflow.architect.proposals', proposals);
    const costUsd = scope.tree.calls ? Math.round(scope.tree.cost * 1e8) / 1e8 : undefined;
    onEvent({ type: 'done', model: modelLabel(model), durationMs: Date.now() - started, steps, usage, ...(costUsd !== undefined && { costUsd }), local: model.provider === 'ollama' });
  });
}

/** What Spotlight knows of an agent it proposes (its `newAgent`), and where in the flow it runs. */
export interface AgentSpec {
  name: string;
  description: string;
  instructions: string;
  /** The workflow it runs in, and the step before and after it, for the architect's request. */
  workflow?: string;
  after?: string;
  before?: string;
  /** SB05: the apps or actions it needs ("Linear: read issues"), and the documents it answers from. */
  tools?: string[];
  knowledge?: string;
}

/** The person's own words for an agent (no fixed sentences): the text the least-privilege rules read. */
export function designWords(spec: AgentSpec): string {
  return [spec.name, spec.description, spec.instructions, ...(spec.tools ?? []), spec.knowledge].filter(Boolean).join('\n');
}

/** The request the architect gets for Spotlight's newAgent: design it now, model, tools and knowledge included. */
export function designRequest(spec: AgentSpec): string {
  const where = [spec.workflow && `in the workflow “${spec.workflow}”`, spec.after && `after the step “${spec.after}”`, spec.before && `before “${spec.before}”`].filter(Boolean).join(', ');
  return [
    // SB17: design from what is written; what only the person can give is left out (it is listed for them), never invented.
    `Design this agent now and propose it from what is written here. Leave out what only I can give (a repository, a channel, an id): it is listed for me to fill in. It runs as a step${where ? ` ${where}` : ''}: each item that reaches it is a message to it.`,
    `Name: ${spec.name}`,
    `What it does: ${spec.description || '(see the instructions)'}`,
    spec.instructions && `How: ${spec.instructions}`,
    spec.tools?.length && `It needs: ${spec.tools.join('; ')}.`, // SB05:
    spec.knowledge && // SB05:
      `It answers from: ${spec.knowledge}: give it a knowledge base (list_knowledge_bases; say so if none fits).`,
    'Pick its model (list_models: a local one), the tools it needs from the plugins online (search_nodes), and a knowledge base if it works from documents (list_knowledge_bases). Keep the name.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What the architect would look up for `spec`, written into the request: the host's models, its knowledge bases and
 * the nodes that match what the agent does. With these in hand one propose_agent call is enough, which is what a local
 * model gets right: a long look-around grows the context until Ollama fails on the proposal.
 */
const FILLER = new Set('the and for with each when its into from that this then them they their what which who your you any all are was has have not but per one two its also only must should will can new'.split(' '));

/** A request's own words for a node search: two-letter words ("to", "on") are inside half the node names. */
const searchWords = (value: string | undefined) =>
  (value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !FILLER.has(w))
    .join(' ');

export function designBrief(spec: AgentSpec, input: Pick<ArchitectInput, 'types' | 'resources'>): string {
  const types = input.types.filter(usableAsTool);
  const hits = new Map<string, string>();
  // SB05: the tools it was said to need are searched first, so their nodes rank first.
  for (const query of [...(spec.tools ?? []), spec.description, spec.instructions, spec.name].map(searchWords)) {
    // A score under 4 is words of the request found only in a node's description: not a match.
    for (const hit of query ? searchNodes(query, types, 6) : []) if (hit.score >= 4 && !hits.has(hit.type) && hits.size < 8) hits.set(hit.type, `${hit.type} (${hit.displayName}): ${shorten(hit.description, 120)}`);
  }
  const models = input.resources?.models ?? [];
  const knowledge = input.resources?.knowledge ?? [];
  return [
    models.length ? `Models (pick one, the first is best here): ${models.map((m) => `${m.provider}/${m.model} (${m.note})`).join('; ')}` : 'Models: none known; leave the model out.',
    knowledge.length ? `Knowledge bases: ${knowledge.map((k) => `${k.collection}: ${k.description}`).join('; ')}` : 'Knowledge bases: none yet.',
    input.resources?.embeddings
      ? 'Knowledge: only if its job means looking things up in documents (policies, contracts, playbooks, past answers). Use an existing collection only if it holds those documents; else a new name (lowercase-dashes) for an empty one the user fills. Most agents that act need none: leave knowledge empty.'
      : 'No new knowledge base can be started here (no embeddings model): leave knowledge empty.',
    'Node tools: only for what it must do outside its reply (post a message, create a ticket, fetch a record). Reading, judging or summarising the message it gets needs no tool: then leave nodeTools empty.',
    hits.size ? `Nodes that matched the request (most are probably not needed): ${[...hits.values()].join('; ')}` : 'No node matched the request.',
    'If it must act in an app none of these nodes covers (Slack, Jira…), name it in missing ("Slack: post a message") instead of picking a node that doesn\'t do it.',
  ].join('\n');
}

/**
 * SB17: a tool Spotlight's newAgent named ("Linear: read issues") that the model left out comes back from designBrief's
 * top hit for it when that hit scored 8 or more, else it is named in `missing`; the documents it answers from get a
 * knowledge tool when the model left it out and this host can start one.
 */
function withSpecHints(draft: DraftResult, spec: AgentSpec, input: Pick<ArchitectInput, 'types' | 'actor' | 'resources'>): void {
  const types = input.types.filter(usableAsTool);
  const tools = draft.config.tools ?? [];
  for (const wanted of spec.tools ?? []) {
    const [, app, rest] = /^\s*([^:]{2,40}):\s*(.+)$/.exec(wanted) ?? [undefined, undefined, wanted];
    const hit = searchNodes(searchWords(wanted), types, 3)[0];
    const info = hit ? types.find((t) => t.type === hit.type) : undefined;
    // The app is named before the colon ("Linear: read issues"): a hit of another app is not it, whatever it scored.
    const right = hit && info && hit.score >= 8 && (!app || appNamed(info, app.trim())) ? hit : undefined;
    const covered = tools.some((t) => t.type === 'node' && (t.nodeType === right?.type || (info && right && types.find((x) => x.type === t.nodeType)?.pluginId === info.pluginId)));
    if (covered || !right) {
      const capability = rest.trim();
      if (!covered && !draft.missing.some((m) => m.capability.toLowerCase() === capability.toLowerCase())) draft.missing.push({ capability, ...(app && { system: app.trim() }) });
      continue;
    }
    
    const added = draftFrom({ name: draft.config.name, tools: [{ type: 'node', nodeType: right.type, description: wanted }] }, { types, actor: input.actor, known: '', request: wanted, ...(input.resources && { resources: input.resources }) });
    const [tool] = added.config.tools ?? [];
    if (!tool) {
      draft.dropped.push(...added.dropped);
      continue;
    }
    if ('name' in tool && tool.name && tools.some((t) => 'name' in t && t.name === tool.name)) tool.name = `${tool.name.slice(0, 60)}_2`;
    tools.push(tool);
    draft.needs.push(...added.needs);
  }
  if (spec.knowledge && !tools.some((t) => t.type === 'knowledge')) {
    const words = searchWords(spec.knowledge).split(' ').filter(Boolean);
    const existing = input.resources?.knowledge.find((k) => words.some((w) => `${k.collection} ${k.description}`.toLowerCase().includes(w)));
    const collection = existing?.collection ?? (words.slice(0, 3).join('-') || 'documents');
    const added = draftFrom({ name: draft.config.name, tools: [{ type: 'knowledge', collection, description: `Search ${spec.knowledge}` }] }, { types, actor: input.actor, known: '', ...(input.resources && { resources: input.resources }) });
    if (added.config.tools?.length) {
      tools.push(...added.config.tools);
      draft.needs.push(...added.needs);
    } else draft.dropped.push(...added.dropped);
  }
  draft.config = { ...draft.config, tools };
  if (tools.length && !draft.config.guardrails?.toolResult) draft.config.guardrails = briefGuardrails(draft.config.guardrails, true);
}

/**
 * Spotlight's newAgent, designed by the architect without a conversation (POST /api/agents/design): its last draft,
 * named as Spotlight named it. The first try hands the model what it would look up (designBrief) and offers only the
 * flat propose_design (plain strings: Ollama's parser fails on propose_agent's nested arrays); the second lets it look
 * around, with the tools the model's provider gets in a conversation. When neither proposes (or both fail), the agent is
 * what Spotlight gave, on the first model the host has, so the step still has an agent to run. A reached usage cap is
 * thrown, not swallowed.
 */
export async function designAgent(spec: AgentSpec, input: Omit<ArchitectInput, 'messages' | 'onEvent' | 'draft' | 'only' | 'request'>): Promise<DraftResult & { designed: boolean }> {
  let last: DraftResult | undefined;
  const onEvent: ArchitectInput['onEvent'] = (event) => {
    if (event.type === 'draft') last = { config: event.config, needs: event.needs, dropped: event.dropped, missing: event.missing, cases: event.cases ?? [] /* SB17: */ };
  };
  const attempts: Array<Pick<ArchitectInput, 'messages' | 'only'>> = [
    { messages: [{ role: 'user', content: `${designRequest(spec)}\n\n${designBrief(spec, input)}\n\nPropose it in one propose_design call now: short instructions, only the tools it needs.` }], only: [DESIGN_TOOL.name] },
    { messages: [{ role: 'user', content: designRequest(spec) }] },
  ];
  for (const attempt of attempts) {
    if (last || input.signal?.aborted) break;
    // A model that fails gets the fallback below; a reached usage cap is the caller's answer (the route says 429).
    // SB17: `request` is the least-privilege rules' text: the request alone, not the brief's hints.
    await runArchitect({ ...input, ...attempt, request: designWords(spec), onEvent }).catch((caught: unknown) => {
      if (isUsageCapError(caught)) throw caught;
    });
  }
  if (last) {
    const kept: DraftResult = last;
    withSpecHints(kept, spec, input); // SB17:
    return { ...kept, config: { ...kept.config, name: spec.name, description: kept.config.description || spec.description }, designed: true };
  }
  const model = input.resources ? chooseModel(undefined, input.resources.models) : undefined;
  const instructions = briefParts(spec.instructions || spec.description, { ...(spec.description && { description: spec.description }), tools: [], writes: false }); // SB17:
  return { config: { name: spec.name, description: spec.description, instructions, tools: [], guardrails: briefGuardrails(undefined, false) /* SB17: */, ...(model && { model }) }, needs: [{ tool: 'test cases', kind: 'parameter', text: 'Add test cases on the Evaluations tab' }], dropped: [], missing: [], cases: [], designed: false };
}
