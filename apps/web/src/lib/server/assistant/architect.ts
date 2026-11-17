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
import { toToolName, type AgentMessage, type LanguageModel, type ToolCall, type ToolResult, type ToolSpec } from '@landflow/engine';
import { deriveToolSchema } from '@landflow/engine'; // AG08:
import type { AgentConfig, AgentGuardrails, AgentModel, AgentPersona, AgentTemplate, AgentToolConfig, AnswerLength } from '@/lib/shared/agents';
import { DEFAULT_BRIEF_GUARDRAILS, isNodeKnowledge } from '@/lib/shared/agents';
import type { AgentCaseDraft, AgentNotAdded } from '@/lib/shared/agent-card'; // SB17: AG02:
import { writesOutside } from '@/lib/shared/run-check'; // SB17:
import { missingSystem, type ArchitectEvent, type ArchitectMissing, type ArchitectNeed, type ArchitectTurn } from '@/lib/shared/agent-architect';
import { randomFace } from '@/lib/shared/faces';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { agentStore } from '../agents/store';
import { agentTemplates } from '../agents/templates';
import { credentials } from '../credentials/vault';
import { qualifyCredentialType } from '../mcp/bind';
import { githubAllowedTools } from '../mcp/github'; // AG07:
import { canResource, withOwnership, type Actor } from '../projects';
import { store } from '../store';
import { traceAssistant } from '../telemetry/assistant';
import { outcomeOf } from '../telemetry/metrics';
import { failSpan } from '../telemetry/spans';
import { recordUsage } from '../usage/ledger';
import { assistantScope, isUsageCapError, runInUsageScope, type UsageScope } from '../ai-usage';
import { recoverToolCalls, withoutInventedIds, withoutRepeats } from './chat';
import { agentModelOf, builderModel, chooseModel, type AgentResources } from './agent-resources';
import { askCatalog, fallbackName, MAIL_TO, readsTokens, toolsOf } from '@/lib/shared/agent-ask'; // AG02: ag1-int: AG09: fallbackName
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
  /** AG02: the model an agent Spotlight designs runs on (`provider/model`): the picker's, else the builder model. Absent (the dialog): the architect's own pick. */
  agentModel?: string;
  /** AG04: a change to an agent that exists writes no test cases (the agent keeps its own): no follow-up call for them. */
  noCases?: boolean;
  /** ag1: the draft is an agent that exists, and the call changes it (Spotlight's revise): its own tools stay callable in the steps. */
  revise?: boolean;
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
// AG08: the cases are the inputs themselves, written out.
const CASES_ASK = '3 to 5 test cases, one plain line each: what a person would actually send it, written out (the alert, the question, the text itself; never a description of it or a placeholder) => what a right answer says';

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
- a model: the chat model it runs on (list_models; the first listed is this host's own model: keep it unless the person names another);
- tools: plugin nodes it calls (type "node"), workflows it calls (type "workflow"), other agents it delegates to (type "agent"), knowledge bases it searches (type "knowledge").

How to work:
- If the request is too vague to pick tools (no task, or no system to work in), ask one short question. Otherwise don't ask: design.
- Research before proposing: search_nodes for each thing the agent must do (read tickets, post to Slack, query a database…), get_node_docs for each node you use, list_workflows and list_agents when an existing workflow or agent could do part of the job, list_credentials to see what works right away, list_templates when one fits as a start.
- Use only node types search_nodes returned, and ids list_workflows and list_agents returned. If nothing online can do a part of the job, leave it out of the tools, list it in propose_agent's "missing" as the app's name, a colon and what the agent would do ("Grafana: read firing alerts"), and say so in one sentence; never invent a node type.
- A node tool's parameters: set what is fixed for this agent (the operation, a resource); what the agent writes or decides per call (a subject, a body, a message, an id) is "{{ $fromAI('key', 'what it is', 'string') }}". A destination (To, URL, channel, path, repository) is set only to a value the request gives, word for word, else left empty. Never make up ids, channels, URLs or emails the user didn't give: leave those for the user.
- An agent that answers from documents (policies, contracts, docs, past tickets) searches a knowledge base: list_knowledge_bases, use one whose description fits, else start an empty one (type "knowledge" with a new collection name) and tell the user to add documents to it.
- Give each node tool a snake_case name and a one-sentence description of when to call it.
- Tools are actions the agent takes. How it is started (a webhook, a schedule, Slack or Teams, a workflow) isn't a tool: the user sets that under the agent's Abilities → Triggers, so say it in your reply instead.
- The model itself reads, parses, summarises and formats text: don't add a tool (a Code node, a formatter) for that.
- Keep the agent focused: the fewest tools that do the job, read before write, rules that matter, instructions of a few short steps. Give it a tool only for an app the request names or its job plainly needs: no Slack, email or other agents unless asked.
- Instructions have four parts, each starting a line: "Input:" (what each message or item brings), "Steps:" (numbered, naming its tools), "Output:" (what it answers, how long) and "Hand over when:" (what it does not decide alone).
- Send 3 to 5 test cases in "cases": what a person would actually send it, written out (the alert, the question, the text itself; never a description of it or a placeholder) => what a right answer says, one plain line each. On a change, send them again unless the change affects them.
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
const GENERIC_KEYWORDS = new Set(['comment', 'message', 'messages', 'trigger', 'webhook', 'file', 'files', 'send', 'create', 'update', 'search', 'record', 'records', 'database', 'table', 'event', 'events', 'document', 'documents', 'upload', 'attachment', 'attachments']);
const REPOSITORY = /(?<![\w./-])(?!(?:and\/or|either\/or|he\/she|s\/he|i\/o|ci\/cd|n\/a|w\/o|yes\/no|input\/output|pass\/fail|read\/write|prs\/mrs|go\/no-go|true\/false|on\/off)\b)[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?![\w/-])/i;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the request names the app of a node (its name, plugin id or one of its specific keywords). */
export function appNamed(info: NodeTypeInfo, request: string): boolean {
  const asked = request.toLowerCase();
  const d = info.descriptor;
  const names = [info.pluginId, d.displayName].map((n) => n?.toLowerCase().trim()).filter((n): n is string => Boolean(n) && n.length >= 3);
  const words = (d.keywords ?? []).map((k) => k.toLowerCase().trim()).filter((k) => (k.length >= 5 || k.includes(' ')) && !GENERIC_KEYWORDS.has(k));
  return [...names, ...words].some((n) => new RegExp(`(?<![a-z0-9])${/[^aeiou]y$/.test(n) ? `${escapeRegExp(n.slice(0, -1))}(?:y|ies|ied)` : `${escapeRegExp(n)}(?:e?s)?`}(?![a-z0-9])`).test(asked));
}

/** Whether the request asks the agent to change something outside (not counting "create an agent"). */
export const asksToWrite = (request: string) => WRITE_ASK.test(request.replace(AGENT_ASK, ' '));

// AG02: a write verb aimed at one tool's app, not a noun anywhere in the request ("customer comments", "an alert", "the email" are not write asks).
const WRITE_VERB = /\b(?:(?:post|send|create|raise|update|edit|write|append|delete|remove|merge|notify|publish|commit|assign|refund|approve|archive|insert|save|store|acknowledge|resolve|silence|upload)(?:e?s|d|ed|ing)?|reply|replies|comment(?:s|ed|ing)?\s+on|leav(?:e|es|ing)|change|push|close|ack|open\s+an?|file\s+an?)\b/i;
const WRITE_NAME = new RegExp(`^\\s*${WRITE_VERB.source}`, 'i');

/**
 * AG02: whether the request asks to write to this tool's app: a write verb in the sentence that names the app, or "email … to
 * <address>" for a mail tool. A core node has no app to name: the whole request decides (`asksToWrite`).
 */
export function asksToWriteTo(info: NodeTypeInfo, request: string): boolean {
  if (info.pluginId === 'core') return asksToWrite(request);
  const text = request.replace(AGENT_ASK, ' ');
  const d = info.descriptor;
  if (/e-?mail|smtp|\bmail\b/i.test([d.displayName, ...(d.keywords ?? [])].join(' ')) && MAIL_TO.test(text)) return true;
  return text.split(/(?<=[.!?])\s+|[;\n]|\sthen\s/i).some((clause) => WRITE_VERB.test(clause) && appNamed(info, clause));
}

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
  // A plugin node with no operation to read (Acknowledge Alert) is a write when its own name starts with a write verb.
  if (info.pluginId !== 'core' && !info.descriptor.properties.some((p) => p.name === 'operation') && WRITE_NAME.test(info.descriptor.displayName)) return true;
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

// AG08: a design fills a node tool's destination (where it sends or reads) only from the request, and a mail node's content per call.
const DESTINATION_NAME = /^(?:to|cc|bcc|toEmail|ccEmail|bccEmail|recipients?|url|baseUrl|endpoint|endpointUrl|webhookUrl|channel|channelId|chatId|path|filePath|repository|owner|repo)$/i;
const isMailNode = (info: NodeTypeInfo) => /e-?mail|smtp|\bmail\b/i.test([info.descriptor.displayName, ...(info.descriptor.keywords ?? [])].join(' '));
/** The addresses a request sends to: the "to <address>" targets (and ones joined by "," or "and") of its sentences that say "email/send … to", in order, once each. Never one ruled out or a cc (a sender is never a "to <address>" target). */
function mailAddresses(request: string): string[] {
  const found: string[] = [];
  const address = '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+';
  const target = new RegExp(`\\bto\\s+(${address}(?:\\s*(?:,|\\band\\b)\\s*(?:and\\s+)?${address})*)`, 'gi');
  for (const clause of request.replace(AGENT_ASK, ' ').split(/(?<=[.!?])\s+|[;\n]/)) {
    if (!MAIL_TO.test(clause)) continue;
    for (const m of clause.matchAll(target)) {
      if (/\b(?:never|not|don'?t|do not|except|without|cc|bcc)\s+(?:\w+\s+)?$/i.test(clause.slice(0, m.index))) continue;
      for (const a of m[1].match(new RegExp(address, 'g')) ?? []) if (!found.some((f) => f.toLowerCase() === a.toLowerCase())) found.push(a);
    }
  }
  return found;
}

// AG08: a test case's input that describes an input instead of being one (the same rule as the scenarios' `describesInput`).
export function describesCase(input: string): boolean {
  const text = input.trim();
  // A question is an input ('Should I restart web-01?') unless it reads as a thing or a person (below); a short command is one too ('Make a UUID').
  if (!text.endsWith('?')) {
    // A short noun phrase with an article ('A title', 'An email') names a kind of input; a placeholder is none; so is a line that says what a test checks.
    if ((text.length < 12 && /^(?:an?|the|some|another|pasted|random|sample|example|generic|typical|plain)\b/i.test(text)) || /<[^<>\n]{1,40}>/.test(text)) return true;
    if (/^(?:(?:an?|the)\s+)?(?:test|case)s?\s+(?:that|of|for|where|which|to)\b/i.test(text)) return true;
    if (/^(?:checks?|verif\w*|ensures?|tests?|validates?)\s+(?:whether|if)\b|^(?:checks?|verif\w*|ensures?|tests?|validates?)\s+that\s+(?:it|the agent)\b/i.test(text) || /^should\s+(?:it|the agent|reply|answer|return|say|ask|refuse|respond|not)\b/i.test(text)) return true;
  }
  if (text.length >= 160 || /:\s*\S.{11,}/.test(text)) return false;
  const thing = /^(?:an?|the|some|another|pasted|random|sample|example|generic|typical|plain)\b[^:]{0,80}?\b(?:alert|e-?mail|message|text|log|ticket|request|question|input|payload|event|notification|report|string|token|jwt|file|data|record|row)s?\b(?:\s+(?:about|for|with|that|from|of|where|which|containing|saying|asking|describing|showing|on|in)\b|\s*$)/i;
  const person = /^(?:an?|the|some)\s+(?:user|customer|person|visitor|engineer|teammate|colleague|client)\s+(?:asks?|says|sends|wants|reports|writes|pastes|requests|needs)\b/i;
  return thing.test(text) || person.test(text);
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
    if (describesCase(asked)) continue; // AG08:
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
  fill: { audience?: string; mission?: string; description?: string; length?: AnswerLength; tools: string[]; writes: boolean; toolNotes?: Record<string, string> /* AG02: */ },
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
  // AG02: a "Tools:" line always lists the real tools with what each is for (unless the steps already have one).
  if (steps && fill.tools.length && !/(?:^|\n)\s*(?:\d+[.)]\s*)?Tools:/i.test(steps)) {
    const lines = numbered(steps).split('\n');
    const listed = fill.tools.map((t) => (fill.toolNotes?.[t] ? `${t} (${fill.toolNotes[t]})` : t)).join(', ');
    steps = `${lines.join('\n')}\n${lines.length + 1}. Tools: ${listed}${fill.writes ? '; read before you write, and a person approves each change' : ''}.`;
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

// AG02: the steps name the agent's tools by their call names. A snake_case word that names a tool (it starts like a tool call or follows
// "call/use/run") and is not one of the agent's tools becomes the tool it plainly means (exactly one shares its words), else its clause goes.
// AG07: the steps know every call name: a node type ("grafana.getAlerts") is renamed to the agent's call name or its clause goes, a rename
// needs the same meaning (never one shared word), a sub-agent's `ask_<name>` and an MCP server's names are kept, a foreign name always goes.
const CALL_VERBS = /^(?:send|get|query|create|list|read|write|post|fetch|find|search|run|call|use|check|comment|update|delete|lookup|extract|normalize|decode|hash|analy[sz]e|summari[sz]e|notify|email|insert|select|count|parse|generate|convert|publish|slack|jira|github)_/;
const FIELD_WORD = /_(?:id|ids|at|number|name|key|url|date|time|type|status|count|value|index|ref|address|email|body|subject|text|to|by|for|from|of)$/; // a second word that is a preposition ("send_to") reads as a field too
const PREPOSITION_END = /_(?:to|by|for|from|of|at)$/; // AG07: "send_to", "group_by": a field even after "with"
const DETERMINERS = '(?:the|each|its|their|a|an|every)';

/** AG07: what the call to nameOnlyOwnTools knows beyond the tools' names (the contract's `StepsOptions`). */
export interface StepsOptions {
  /** Call names known to be someone else's (a revise's removed tools): they read as tools whatever their shape, and are never renamed. */
  foreign?: string[];
  /** A node type → the agent's call name for it (`grafana.getAlerts` → `get_alerts`). */
  nodeTypes?: Record<string, string>;
  /** Every node type online: a dotted word that is none of them is ordinary text (`landflow.test`, `config.yaml`). */
  catalog?: string[];
  /** The agent has an MCP server whose tool list is read only at run time: a name that could be one of its tools is kept. */
  open?: boolean;
}

/** AG07: a word without its plural `s` and with -ise as -ize ("alerts" and "alert", "normalise" and "normalize" are one). */
const foldWord = (w: string) => {
  const x = w.replace(/ises?$/, (m) => `ize${m.endsWith('s') ? 's' : ''}`).replace(/ies$/, 'y');
  return x.length > 3 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x;
};
const meaningOf = (name: string) => {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const verb = CALL_VERBS.test(name.toLowerCase().replace(/^([a-z]+)ise_/, '$1ize_')) && words.length > 1 ? words[0] : undefined;
  return { verb, rest: words.slice(verb ? 1 : 0).map(foldWord), all: words.map(foldWord) };
};
const sameWords = (a: string[], b: string[]) => new Set(a).size === new Set(b).size && a.every((w) => b.includes(w));
/** AG07: whether a token and a tool mean the same thing: equal content words (plural and -ise folded), or the tool's call name with a `_2` suffix. */
function sameTool(token: string, tool: string): boolean {
  if (token.toLowerCase() !== tool.toLowerCase() && token.replace(/_\d+$/, '').toLowerCase() === tool.toLowerCase()) return true;
  const a = meaningOf(token);
  const b = meaningOf(tool);
  if (a.verb && b.verb) return foldWord(a.verb) === foldWord(b.verb) && sameWords(a.rest, b.rest);
  if (a.verb || b.verb) return a.rest.length > 0 && sameWords(a.rest, b.rest);
  return sameWords(a.all, b.all);
}
const snakeOf = (type: string) => (type.split('.').pop() ?? type).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
const FIELD_CONTEXT = /^`?\s*(?:field|value|column|key|parameter)\b|^`?\s+as\s+(?:the|an?)\b|^`?\s+from\s+the\b|^`?\s+to\s+(?:order|sort|group)\b/i; // AG07: what follows a field-shaped token

export function nameOnlyOwnTools(instructions: string, tools: Array<{ name: string; description?: string }>, options: StepsOptions = {}): { text: string; dropped: string[] } {
  const own = new Set(tools.map((t) => t.name));
  const foreignNames = new Set((options.foreign ?? []).filter((f) => f && !own.has(f)));
  const catalog = new Set(options.catalog ?? []);
  const nodeTypes = options.nodeTypes ?? {};
  const known = new Set([...Object.values(nodeTypes), ...[...catalog].map(snakeOf)]); // AG07: the call names of the nodes online
  const dropped: string[] = [];
  const out: string[] = [];
  const fix = (line: string): string => {
    let current = line;
    const isTool = (t: string): boolean => {
      if (own.has(t)) return false;
      if (foreignNames.has(t)) return true;
      if (options.open && !known.has(t)) return false; // AG07: an MCP server's tools are unknown at design time
      // A tool by how it is named, before any field or determiner check: "the get_alerts tool", "call the post_message tool", "use query_logs".
      if (new RegExp(`\\b${t}\`?\\s+(?:tool|node|action|function)\\b`, 'i').test(current)) return true;
      if (/^ask_/.test(t)) return true; // AG07: a sub-agent's or an A2A agent's call name
      // An article between the verb and the name only for a tool-shaped name: "run the post_id check" and "use the source_ip" are fields.
      if (new RegExp(`\\b(?:call|invoke|run)\\s+${FIELD_WORD.test(t) ? '' : '(?:(?:the|an?)\\s+)?'}\`?${t}\\b`, 'i').test(current)) return true;
      // AG07: a token the sentence uses as a field ("send_to as the address", "update_time to order them", "the to_email field").
      const at = current.search(new RegExp(`\\b${t}\\b`));
      if (at >= 0 && (!CALL_VERBS.test(t) || FIELD_WORD.test(t)) && FIELD_CONTEXT.test(current.slice(at + t.length))) return false;
      if (CALL_VERBS.test(t) && !FIELD_WORD.test(t) && new RegExp(`\\buse\\s+(?:(?:the|an?)\\s+)?\`?${t}\\b`, 'i').test(current)) return true; // "use `user_id`" is a field
      // AG07: "with send_email", "using send_email": a tool even when it ends in a field word (not a preposition: "send_to").
      if (CALL_VERBS.test(t) && !PREPOSITION_END.test(t) && new RegExp(`\\b(?:with|using|via)\\s+(?:(?:the|an?)\\s+)?\`?${t}\\b`, 'i').test(current)) return true;
      if (CALL_VERBS.test(t)) {
        if (new RegExp(`\\buse\\s+\`?${t}\\b`, 'i').test(current)) return true;
        // Three or more words ("get_alert_status") read as a tool whatever the suffix; two ("run_id", "update_time", "email_address") are a field when they end like one or follow a determiner.
        if (t.split('_').length >= 3) return true;
        if (FIELD_WORD.test(t) || new RegExp(`(?:\\b${DETERMINERS}|\\w['’]s)\\s+\`?${t}\\b`, 'i').test(current)) return false;
        return true;
      }
      // After "use", or later in the same sentence as "call" ("call jwt_decode, hash or slugify_title"): a tool unless it is shaped like a field.
      return !FIELD_WORD.test(t) && (new RegExp(`\\buse\\s+\`?${t}\\b`, 'i').test(current) || new RegExp(`\\b(?:call|invoke|run)\\b[^.\\n]*?\\b${t}\\b`, 'i').test(current));
    };
    // AG07: the tokens: node types the catalog holds, snake_case words that read as tools, and foreign names that are not snake_case ("Call slugify on the title.").
    const dotted = [...new Set(current.match(/\b[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*\b/g) ?? [])].filter((t) => catalog.has(t));
    const snake = [...new Set(current.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])].filter(isTool);
    const plain = [...foreignNames].filter((f) => !f.includes('_') && new RegExp(`\\b(?:call|invoke|run|use|using|with|via)\\s+(?:(?:the|an?)\\s+)?\`?${escapeRegExp(f)}\\b|\\b${escapeRegExp(f)}\`?\\s+(?:tool|node|action|function)\\b`, 'i').test(current));
    for (const token of [...dotted, ...snake, ...plain]) {
      const fits = dotted.includes(token) || foreignNames.has(token) ? [] : tools.filter((t) => sameTool(token, t.name));
      const target = dotted.includes(token) ? nodeTypes[token] : fits.length === 1 ? fits[0].name : undefined;
      if (target && own.has(target)) {
        current = current.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g'), target);
        dropped.push(`instructions named ${token}, which it does not have: now ${target}`);
        continue;
      }
      const lead = /^(\s*(?:\d+[.)]|[-*•])\s+)?/.exec(current)?.[0] ?? '';
      const has = new RegExp(`\\b${escapeRegExp(token)}\\b`);
      // AG07: the clause goes from its own sentence only; the sentences around it stay.
      const kept = current
        .slice(lead.length)
        .split(/(?<=[.!?])\s+(?=[A-Z0-9`"'(])/)
        .flatMap((sentence) => {
          if (!has.test(sentence)) return [sentence];
          const clauses = sentence.split(/\s*(?:,|;|\band\b|\bthen\b)\s*/i).filter((piece) => piece && !has.test(piece));
          const joined = clauses.join(', ');
          return clauses.length ? [`${joined}${/[.!?]$/.test(sentence) && !/[.!?]$/.test(joined) ? '.' : ''}`] : [];
        });
      current = kept.length ? `${lead}${kept.join(' ')}` : '';
      dropped.push(`instructions named ${token}, which it does not have`);
    }
    return current;
  };
  for (const line of instructions.split('\n')) {
    // AG07: steps written on one line ("1. Call a. 2. Call b.") are checked one at a time.
    const pieces = line.split(/(?<=[.!?])\s+(?=\d+[.)]\s)/);
    const fixed = pieces.map(fix);
    if (fixed.every((f, i) => f === pieces[i])) out.push(line);
    else for (const piece of fixed) if (piece.trim()) out.push(piece);
  }
  // Steps whose clause went leave a gap in the numbering: number the lines again, in order.
  let n = 0;
  const text = out.map((l) => (/^\s*\d+[.)]\s/.test(l) ? l.replace(/^(\s*)\d+([.)])/, (_m, sp: string, dot: string) => `${sp}${++n}${dot}`) : ((n = 0), l))).join('\n');
  return { text, dropped };
}

/**
 * AG07: the call names of an agent's tools as the runtime builds them (node, workflow and knowledge tools `toToolName(name)`, an A2A agent and a
 * sub-agent `toToolName('ask_' + name)`, GitHub's MCP preset the names its access allows), what a node type is called, and whether an MCP
 * server's tools are unknown until run time (`open`).
 */
function stepsToolsOf(tools: AgentToolConfig[], types: NodeTypeInfo[]): { list: Array<{ name: string; description?: string }>; options: Required<Pick<StepsOptions, 'nodeTypes' | 'catalog' | 'open'>> } {
  const list: Array<{ name: string; description?: string }> = [];
  const nodeTypes: Record<string, string> = {};
  let open = false;
  const put = (name: string | undefined, description?: string) => {
    if (name && !list.some((t) => t.name === name)) list.push({ name, ...(description && { description }) });
    return name;
  };
  for (const t of tools) {
    if (t.type === 'mcp') {
      if (t.preset === 'github') for (const name of githubAllowedTools(t.access)) put(name);
      else open = true;
    } else if (t.type === 'a2a') put(toToolName(`ask_${t.name}`));
    else if (t.type === 'agent') {
      const target = agentStore.get(t.agentId);
      if (target) put(toToolName(`ask_${target.name}`));
    } else if ('name' in t && t.name) {
      const name = put(toToolName(t.name), 'description' in t ? t.description : undefined);
      if (name && t.type === 'node' && !(t.nodeType in nodeTypes)) nodeTypes[t.nodeType] = name;
    }
  }
  return { list, options: { nodeTypes, catalog: types.map((t) => t.type), open } };
}

/** AG02: what each tool is for, in a few words for the steps' Tools line: the first sentence of its description, unless it only repeats the name. */
function toolNotes(tools: Array<{ name: string; description?: string }>): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const t of tools) {
    const first = (t.description ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '').trim();
    if (!first || squash(first) === squash(t.name)) continue;
    notes[t.name] = first.length > 90 ? `${first.slice(0, 90).replace(/\s+\S*$/, '')}…` : first;
  }
  return notes;
}

const REPOSITORY_NEED = (tool: string) => `${tool}: fill in Repository (owner/name): the request names none`;

/** SB17: the guardrails every drafted agent gets: its own kept, the defaults filling what is missing (tool results only with a tool). */
function briefGuardrails(own: AgentGuardrails | undefined, hasTools: boolean, tokenJob = false /* AG02: */): AgentGuardrails {
  const defaults = structuredClone(DEFAULT_BRIEF_GUARDRAILS);
  // AG02: an agent whose job is reading tokens (a JWT decoder, a hasher) gets no secret masking on its messages (it would see "<JWT>"): its answers are masked instead.
  const input = own?.input ?? (tokenJob ? undefined : defaults.input);
  const output = own?.output ?? (tokenJob ? { enabled: true, action: 'sanitize' as const, checks: { secrets: { permissiveness: 'balanced' as const } }, reply: '' } : undefined);
  return { ...own, ...(input && { input }), ...(output && { output }), ...((own?.toolResult || hasTools) && { toolResult: own?.toolResult ?? defaults.toolResult }) };
}

/** AG02: whether the job reads tokens: the request says so, or a tool is one of the token nodes. */
export const readsTokenJob = (request: string | undefined, tools: Array<{ type?: string; nodeType?: string }> = []): boolean =>
  Boolean(request && readsTokens(request)) || tools.some((t) => t.type === 'node' && /^go-crypto\.(?:jwtDecode|hash|base64)/.test(t.nodeType ?? ''));

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
export function draftFrom(args: Record<string, unknown>, context: { types: NodeTypeInfo[]; actor: Actor; known: string; keep?: Partial<AgentConfig>; templates?: AgentTemplate[]; resources?: AgentResources; request?: string /* SB17: */; model?: string /* AG02: the model the agent runs on: Spotlight's picker, else the builder model */; revise?: boolean /* ag1: a change to an agent that exists: `keep`'s tools are still its own */ }): DraftResult {
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
      if (request !== undefined && info.type === 'core.practiceCheck') {
        if (!PRACTICES_ASK.test(request)) dropped.push('Check Practices: the request doesn’t ask for your practices'); // SB17:
        continue;
      }
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
      // SB17: least privilege and a person in the loop for every write. A write the request does not ask for at this app
      // (AG02: per tool, whether the model left the operation out or wrote one) becomes a read the node has.
      if (request !== undefined && toolWrites(info, parameters) && !asksToWriteTo(info, request)) parameters = readDefaults(info, parameters, request);
      const writes = toolWrites(info, parameters);
      if (request !== undefined && info.pluginId !== 'core' && !appNamed(info, request)) {
        names.delete(toolLabel);
        dropped.push(`${d.displayName}: the request never asks for it${writes ? ' (it would change things there)' : ''}`);
        continue;
      }
      if (request !== undefined && writes && !asksToWriteTo(info, request)) {
        names.delete(toolLabel);
        dropped.push(`${d.displayName} (${String(parameters.operation ?? 'a write')}): the request asks to read or check, not to change anything there`);
        continue;
      }
      // AG08: a destination the request does not hold word for word is left empty (and asked for); a mail node goes to the request's address, and what it writes per call is $fromAI.
      const noDestination = new Set<string>();
      if (request !== undefined) {
        const said = request.replace(AGENT_ASK, ' ').toLowerCase();
        const holds = (value: string) => value.split(',').every((part) => !part.trim() || said.includes(part.trim().toLowerCase()));
        const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
        if (isMailNode(info) && own.has('toEmail') && writes) {
          const to = mailAddresses(request);
          if (to.length) {
            const own1 = isText(parameters.toEmail) ? parameters.toEmail : '';
            const keeps = own1 !== '' && holds(own1) && own1.split(',').every((part) => !part.trim() || to.some((a) => a.toLowerCase() === part.trim().toLowerCase()));
            if (!keeps) {
              if (own1 && !holds(own1)) dropped.push(`“${own1}” as To Email of ${toolLabel}: the request gives ${to.join(', ')}`);
              parameters = { ...parameters, toEmail: to.join(', ') };
            }
          }
          const fresh = (name: string, key: string, about: string) => {
            if (own.has(name) && !(isText(parameters[name]) && (/\$fromAI\(/.test(parameters[name] as string) || holds(parameters[name] as string)))) parameters = { ...parameters, [name]: `{{ $fromAI('${key}', '${about}', 'string') }}` };
          };
          // The node's own format is html, whose Text field is hidden: a summary the model gave no format for goes out as plain text.
          if (own.has('emailFormat') && !('emailFormat' in fromModel)) parameters = { ...parameters, emailFormat: 'text' };
          fresh('subject', 'subject', 'The email subject');
          fresh(parameters.emailFormat === 'html' ? 'html' : 'text', 'body', 'The email text');
        }
        for (const property of d.properties) {
          const value = parameters[property.name];
          if (property.type !== 'string' || !isText(value) || !isPropertyVisible(property, parameters)) continue;
          if (!DESTINATION_NAME.test(property.name) && !(isMailNode(info) && property.name === 'fromEmail')) continue;
          if (holds(value)) continue;
          parameters = { ...parameters, [property.name]: '' };
          noDestination.add(property.name);
          dropped.push(`“${shorten(value, 60)}” as ${property.displayName} of ${toolLabel}: the request doesn’t give it`);
        }
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
        if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) {
          // AG08: a property the tool's schema lets the model fill on each call (Acknowledge Alert's Alert Name) is not for the person.
          const schema = deriveToolSchema(d, parameters);
          const perCall = Object.keys((d.toolInputSchema?.properties ?? {}) as object).includes(property.name) || (Array.isArray(schema.required) && (schema.required as string[]).includes(property.name));
          if (perCall) continue;
          needs.push({ tool: toolLabel, kind: 'parameter', text: noDestination.has(property.name) ? `${toolLabel}: set ${property.displayName} (the request gives none)` : `${toolLabel}: fill in ${property.displayName}` });
        }
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
  // AG02: with a `context.model` (Spotlight's design) the agent gets the picker's model, else the builder model: the architect's own pick counts only when the request names a model.
  const named = context.model !== undefined && request !== undefined && context.resources ? modelNamedIn(request, context.resources.models) : undefined;
  const model =
    context.model !== undefined
      ? (named ?? agentModelOf(context.model) ?? (context.resources ? chooseModel(undefined, context.resources.models) : undefined))
      : context.resources
        ? chooseModel(args.model, context.resources.models)
        : undefined;
  if (context.model === undefined && args.model && model && !String(args.model).endsWith(model.model)) dropped.push(`the model “${String(args.model)}”, which isn't here: it runs on ${model.provider}/${model.model}`);
  if (context.resources && !model) needs.push({ tool: 'model', kind: 'parameter', text: 'Pick a model: no local model is pulled in Ollama' });

  const about = text(args.description, 300) ?? base.description ?? keep?.description ?? '';
  // AG02: the steps name only the agent's own tools, by their call names.
  const toolList = tools.flatMap((t) => ('name' in t && t.name ? [{ name: t.name, ...('description' in t && t.description && { description: t.description }) }] : []));
  // A revise proposes the whole agent again, but least privilege leaves out the tools the change does not name: the steps that call the agent's own tools (`keep`'s) are still its own.
  // AG07: the call names of every tool it has (a sub-agent's `ask_…`, GitHub's, an MCP server open at run time), a node type's name, the node types online.
  const stepsTools = stepsToolsOf([...tools, ...(context.revise ? (keep?.tools ?? []) : [])], types);
  const reconciled = nameOnlyOwnTools(text(args.instructions, 8000) ?? base.instructions ?? '', stepsTools.list, stepsTools.options);
  dropped.push(...reconciled.dropped);
  const config: Partial<AgentConfig> = {
    ...(template && { ...base, tools: undefined }),
    name,
    description: about,
    icon: text(args.icon, 40) ?? base.icon ?? keep?.icon ?? 'bot',
    color: keep?.color ?? base.color ?? '#6366f1',
    avatar: keep?.avatar ?? base.avatar ?? { kind: 'face', face: randomFace(name) },
    ...(keep?.team && { team: keep.team }),
    ...(Object.keys(persona).length && { persona }),
    instructions: briefParts(reconciled.text, {
      ...(persona.audience && { audience: persona.audience }),
      ...(persona.mission && { mission: persona.mission }),
      ...(about && { description: about }),
      ...(persona.length && { length: persona.length }),
      tools: toolList.map((t) => t.name),
      toolNotes: toolNotes(toolList), // AG02:
      writes: tools.some((t) => t.type === 'node' && t.requireApproval),
    }), // SB17:
    ...((model ?? keep?.model ?? base.model) && { model: model ?? keep?.model ?? base.model }),
    tools,
    ...(practicesAsked && { practices: 'on' as const }), // SB17:
    guardrails: briefGuardrails(keep?.guardrails ?? base.guardrails, tools.length > 0, readsTokenJob(request, tools)), // SB17: AG02: the token flag
  };
  return { config, needs, dropped, missing, cases: parseCases(parsed(args.cases)) /* SB17: */ };
}

/** AG02: a model the request names ("on Haiku", "use claude-opus-5-5") as one of `models`: the model id, or its family word after on/use/using/with. */
function modelNamedIn(request: string, models: readonly AgentModel[]): AgentModel | undefined {
  const asked = request.toLowerCase();
  for (const m of models) {
    const id = m.model.toLowerCase();
    const family = /^claude-([a-z]+)-/.exec(id)?.[1];
    if (new RegExp(`(?<![a-z0-9.-])${escapeRegExp(id)}(?![a-z0-9-]|\\.[a-z0-9])`).test(asked)) return { provider: m.provider, model: m.model };
    if (family && new RegExp(`\\b(?:on|use|using|with|run(?:s)?\\s+on)\\s+(?:claude\\s+)?${family}\\b`).test(asked)) return { provider: m.provider, model: m.model };
  }
  return undefined;
}

/**
 * SB17: one small call for the cases alone (the agent's description and the request), when a proposal came with fewer than 3.
 * It runs inside the architect's scope, so it counts as its calls do; a model that fails leaves the cases to the person.
 */
async function casesFor(model: LanguageModel, agent: { name: string; description: string; request: string; asksFirst?: string[] /* AG15: */ }, usage: { inputTokens: number; outputTokens: number }, signal?: AbortSignal): Promise<AgentCaseDraft[]> {
  const system = 'You write test cases for an AI agent. Answer with 3 to 5 lines and nothing else, one case per line, plain text: what a person would actually send it, written out (the alert, the question, the text itself; never a description of it or a placeholder) => what a right answer says. Example: [Wazuh] rule 5710 sshd: attempt to login using a non-existent user, src 203.0.113.45 => Names the source address and says it is a login probe.' + (agent.asksFirst?.length ? ` The agent's tools ${agent.asksFirst.join(', ')} ask the person first: a case about that action expects the agent to say what it would do and that it waits for the person's approval, never that it was done.` : ''); // AG08: AG15:
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

// AG15: the tools of a config that ask the person first (a write): their names as the card shows them.
const asksFirstNames = (config: Partial<AgentConfig>): string[] => (config.tools ?? []).flatMap((t) => (t.type === 'node' && t.requireApproval ? [t.name] : []));
const VERB = 'sen[dt]s?|emails?|posts?|creates?|updates?|deletes?|acknowledg\\w*|silenc\\w*';
// A claim that the action happened: a verb opening the text or following "and"/"then"/a comma, or a past-tense word. A noun "email" mid-sentence is no claim.
const EFFECT = new RegExp(`^(?:${VERB})\\b|(?:\\band|\\bthen|[,;])\\s+(?:${VERB})\\b|\\b(?:sent|emailed|posted|created|deleted|updated|acknowledged|silenced)\\b`, 'i');
const NEGATION = /\b(?:no|not|never|nothing|without|none|doesn'?t|don'?t|won'?t|wouldn'?t|didn'?t|cannot|can'?t)\b|n't\b/i;
const GERUND: Record<string, string> = { send: 'sending', sent: 'sending', sends: 'sending', email: 'sending', emails: 'sending', emailed: 'sending', post: 'posting', posts: 'posting', posted: 'posting', create: 'creating', creates: 'creating', created: 'creating', delete: 'deleting', deletes: 'deleting', deleted: 'deleting', update: 'updating', updates: 'updating', updated: 'updating' };
/**
 * ag3 carryover (the live pass, Grafana agent): a test case that names a URL nobody gave ("What does the dashboard at
 * https://grafana.example.com/… show?") would have the smoke test and the gate send the agent's HTTP Request there (lesson 21:
 * never a destination nobody gave). A case whose input or expected answer names a URL whose host is not in what the person
 * wrote, nor in a tool's own settings, is dropped; the rest stay as they are, in order.
 */
export function casesWithoutMadeUpUrls(cases: AgentCaseDraft[], written: string, config: Partial<AgentConfig>): AgentCaseDraft[] {
  const hostOf = (url: string) => {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  };
  const given = `${written}\n${JSON.stringify(config.tools ?? [])}`.toLowerCase();
  const madeUp = (text: string | undefined) => (text?.match(/\bhttps?:\/\/[^\s"'<>)\]]+/gi) ?? []).some((url) => !given.includes(hostOf(url)));
  return cases.filter((c) => !madeUp(c.input) && !madeUp(c.expected));
}

/**
 * AG15: a case whose expected answer says a tool that asks first did its work ("Emails a summary to oncall@landflow.test") is
 * rewritten to what an honest run does when approvals are denied: it says what it would do and waits. Addresses, names and ids
 * stay exactly; the input and every other case are untouched.
 */
export function asksFirstCases(cases: AgentCaseDraft[], config: Partial<AgentConfig>): AgentCaseDraft[] {
  const asks = asksFirstNames(config);
  if (!asks.length) return cases;
  const words = asks.flatMap((n) => n.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2).flatMap((w) => (w === 'send' ? ['send', 'sent'] : [w])));
  return cases.map((c) => {
    const expected = c.expected?.trim();
    if (!expected) return c;
    const names = (text: string) => words.some((w) => new RegExp(`\\b${escapeRegExp(w)}`, 'i').test(text));
    if (!EFFECT.test(expected) || !names(expected)) return c;
    // ag3 carryover (the live pass): a negation elsewhere in a compound case ("Normalises it, no IOCs, sev1 with reason, emails
    // oncall@landflow.test.") left the send's claim standing and the gate held the agent; a negation counts in its own clause.
    if (NEGATION.test(expected)) {
      const parts = expected.split(/(,\s+|;\s+)/);
      let changed = false;
      const out = parts.map((part, i) => {
        if (i % 2 === 1) return part;
        const clause = part.trim().replace(/\.$/, '');
        if (!EFFECT.test(clause) || NEGATION.test(clause) || !names(clause)) return part;
        changed = true;
        const verbAddress = /^(sends?|emails?|posts?)\s+(?:it\s+)?(?:to\s+)?(\S+@[^\s,;]+?)\.?$/i.exec(clause);
        if (verbAddress) return `drafts the email for ${verbAddress[2]} and asks for approval before ${GERUND[verbAddress[1]!.toLowerCase()] ?? 'sending'} it`;
        const done = /^(.+?)\s+(sent|emailed|posted)(?:\s+to\s+(\S.*?))?$/i.exec(clause);
        if (done) return `drafts ${done[1]}${done[3] ? ` for ${done[3]}` : ''} and asks for approval before ${GERUND[done[2]!.toLowerCase()] ?? 'sending'} it (not ${done[2]!.toLowerCase()})`;
        return `asks for approval before it acts, without claiming it was done (${clause})`;
      });
      return changed ? { ...c, expected: out.join('').replace(/\.?$/, '.') } : c;
    }
    const toAddress = /^(sends?|emails?|posts?)\s+(\S+@\S+?)\s+(?!(?:sent|posted)\b)(.+?)\s*\.?$/i.exec(expected);
    if (toAddress) {
      const [, verb = '', who = '', what = ''] = toAddress;
      return { ...c, expected: `Drafts ${what} for ${who} and asks for approval before ${GERUND[verb.toLowerCase()] ?? 'doing'} it` };
    }
    const lead = /^(sends?|emails?|posts?|creates?|updates?|deletes?)\s+(?!(?:sent|posted|created|updated|deleted|delivered)\b)(.+?)(?:\s+(?:to|for)\s+(\S.*?))?\s*\.?$/i.exec(expected);
    if (lead) {
      const [, verb = '', what = '', who] = lead;
      return { ...c, expected: `Drafts ${what}${who ? ` for ${who}` : ''} and asks for approval before ${GERUND[verb.toLowerCase()] ?? 'doing'} it` };
    }
    return { ...c, expected: `Says what it would do and asks for approval first, without claiming it was done (${expected.replace(/\.$/, '')})` };
  });
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
        // AG13: a new knowledge base can always be started: with the host's embeddings model, or searched by keywords (built in) when it has none
        const fresh = `A new empty one can be started (type "knowledge" with a new collection name), ${input.resources?.embeddings?.provider === 'none' || !input.resources?.embeddings ? 'searched by keywords (built in, no embeddings model needed)' : `embedded with ${input.resources.embeddings.model}`}.`;
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
        const { config, needs, dropped, missing, cases: proposed } = draftFrom(args, { types, actor, known: known(), keep: draft, request: requestText, ...(input.revise && { revise: true }), ...(input.agentModel && { model: input.agentModel }) /* AG02: */, ...(input.resources && { resources: input.resources }) });
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
        if (cases.length < 3 && !input.noCases /* AG04: */) {
          const more = await casesFor(model, { name: config.name ?? '', description: config.description ?? '', request: requestText, asksFirst: asksFirstNames(config) /* AG15: */ }, usage, input.signal);
          cases = more.length > proposed.length ? more : proposed;
        }
        if (cases.length < 3 && !input.noCases /* AG04: */) needs.push({ tool: 'test cases', kind: 'parameter', text: 'Add test cases on the Evaluations tab' });
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
  /** AG02: the person's whole message: the checks read it (which apps it names, whether it asks to write there), not the short description. */
  ask?: string;
  /** AG04: a change to an agent that exists (or to a card's config): the config it starts from and what the person asked to change. */
  base?: Partial<AgentConfig>;
  change?: string;
}

/** The person's own words for an agent (no fixed sentences): the text the least-privilege rules read. */
export function designWords(spec: AgentSpec): string {
  if (spec.ask) return [spec.ask, ...(spec.tools ?? []), spec.knowledge].filter(Boolean).join('\n'); // AG02: the whole ask when given
  return [spec.name, spec.description, spec.instructions, ...(spec.tools ?? []), spec.knowledge].filter(Boolean).join('\n');
}

/** The request the architect gets for Spotlight's newAgent: design it now, model, tools and knowledge included. */
export function designRequest(spec: AgentSpec): string {
  if (spec.base && spec.change) return reviseRequest(spec.base, spec.change); // AG04:
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

// AG04:
/** The agent as its own words and tool names, for a change request. */
function baseAsk(base: Partial<AgentConfig>): string {
  const tools = (base.tools ?? []).flatMap((t) => ('name' in t && t.name ? [t.name] : []));
  return [
    `Name: ${base.name ?? 'the agent'}`,
    `What it does: ${base.description || '(see the instructions)'}`,
    base.instructions && `How: ${base.instructions.slice(0, 3000)}`,
    tools.length ? `Its tools: ${tools.join(', ')}.` : 'It has no tools.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** AG04: the request for a change: the agent as it is, then the change, with every tool proposed again. */
function reviseRequest(base: Partial<AgentConfig>, change: string): string {
  return [
    'Change this agent now and propose the whole agent again, with the change made and nothing else touched. Keep its name, model, instructions, guardrails and every tool the change does not name; leave out a tool only if the change removes it. Leave out what only I can give (a repository, a channel, an id): it is listed for me to fill in.',
    baseAsk(base),
    `The change: ${change}`,
  ].join('\n');
}

const REMOVES = /\b(?:remove|delete|drop|stop using|get rid of|take away|disable)\b/gi;
const GENERIC = new Set(['tool', 'tools', 'node', 'agent', 'with', 'from', 'that', 'this', 'also', 'make', 'give', 'get', 'set', 'list']);
/** The words of a tool's name and node type that say what it is ("send_email", "grafana.getAlerts" -> send, email, grafana, alerts). */
const toolWords = (tool: AgentToolConfig): string[] =>
  [('name' in tool && tool.name) || '', tool.type === 'node' ? tool.nodeType : '']
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !GENERIC.has(w));
const toolKey = (tool: AgentToolConfig) => (tool.type === 'node' ? `node|${tool.nodeType}|${String(tool.parameters?.operation ?? '')}` : `${tool.type}|${'name' in tool ? tool.name : ''}|${'agentId' in tool ? tool.agentId : ''}|${'workflowId' in tool ? tool.workflowId : ''}`);
/** The tool is named after a remove verb in the same clause ('remove the email tool'), not merely near 'without' ('send it to Slack without the footer'). */
const removed = (change: string, tool: AgentToolConfig) =>
  change.split(/[.;\n]+/).some((clause) => {
    REMOVES.lastIndex = 0;
    const verb = REMOVES.exec(clause);
    return verb ? names(clause.slice(verb.index), tool) : false;
  });
const names = (change: string, tool: AgentToolConfig) => toolWords(tool).some((w) => change.toLowerCase().includes(w.replace(/s$/, '')));

const TOOLS_STEP = /^\d+\. Tools: [^\n]*$/m;

/**
 * AG04: the proposal's instructions with the tools step as the final tools make it. The design adds a "Tools: …" step to
 * instructions that name none of the tools it was given: for a change that is only the new tool, so one the base never had is
 * dropped again, and one the base had (from its own design) names every tool now.
 * AG09: a tool the change adds (`add`) that no step but the Tools line names gets a step of its own.
 */
function reviseInstructions(proposed: string, base: string, tools: AgentToolConfig[], add?: { tools: AgentToolConfig[]; change: string } /* AG09: */): string {
  const text = reviseToolsLine(proposed, base, tools);
  if (!add) return text;
  // AG09: a step an earlier revise wrote for a tool the base has is kept when the proposal left it out.
  const carried = tools.filter((t) => 'name' in t && t.name && !add.tools.includes(t)).flatMap((t) => {
    const line = new RegExp(`^\\s*\\d+[.)]\\s*When .*, call ${escapeRe((t as { name: string }).name)}\\b.*$`, 'm').exec(base)?.[0];
    return line ? [{ tool: t, line }] : [];
  });
  const stepped = add.tools.length || carried.length ? withToolSteps(text, [...carried, ...add.tools.map((tool) => ({ tool }))], add.change) : text;
  return withoutHandOverFor(stepped, add.tools, add.change); // ag3 carryover:
}

/**
 * ag3 carryover (the live pass, Grafana agent): "also let it acknowledge an alert" added Acknowledge Alert and its step, but the
 * base's "Hand over when: The user asks to acknowledge, silence or fix an alert, …" stayed, so the published agent answered
 * "I can't acknowledge alerts". For each tool the change adds, whose action verb (the first word of its name, "acknowledge")
 * the change itself says, that verb leaves the Hand over line: out of a list ("acknowledge, silence or fix" → "silence or
 * fix"), or its clause when it stands alone. Other words stay as written; a hand-over the change does not touch stays whole.
 */
export function withoutHandOverFor(text: string, added: AgentToolConfig[], change: string): string {
  const verbs = added
    .map((t) => ('name' in t && t.name ? t.name : '').split(/[_\s-]+/)[0]?.toLowerCase() ?? '')
    .filter((v) => v.length >= 4 && new RegExp(`\\b${escapeRe(v)}`, 'i').test(change));
  if (!verbs.length) return text;
  return text
    .split('\n')
    .map((line) => {
      const head = /^(\s*(?:#{1,4}\s*)?hand[ -]?over(?:\s+when)?\s*:\s*)(.*)$/i.exec(line);
      if (!head) return line;
      let body = head[2];
      for (const verb of verbs) {
        const word = `${escapeRe(verb)}[a-z]*`;
        if (!new RegExp(`\\b${word}\\b`, 'i').test(body)) continue;
        const listed = body
          .replace(new RegExp(`\\b${word}\\b(?:,\\s*|\\s+(?:or|and)\\s+)(?=[a-z])`, 'i'), '')
          .replace(new RegExp(`(?:,\\s*(?:or\\s+|and\\s+)?|\\s+(?:or|and)\\s+)\\b${word}\\b`, 'i'), '');
        if (listed !== body) {
          body = listed;
          continue;
        }
        // alone in its clause: drop the clause (clauses split at ", or", ";" and sentence ends)
        const parts = body.split(/(?<=[.;])\s+|,\s+or\s+/);
        const kept = parts.filter((part) => !new RegExp(`\\b${word}\\b`, 'i').test(part));
        body = kept.join(' ').trim();
      }
      if (body === head[2]) return line;
      return body ? `${head[1]}${body.charAt(0).toUpperCase()}${body.slice(1)}` : `${head[1]}It cannot do what was asked.`;
    })
    .join('\n');
}

function reviseToolsLine(proposed: string, base: string, tools: AgentToolConfig[]): string {
  const line = TOOLS_STEP.exec(proposed)?.[0];
  if (!line) return proposed;
  if (!TOOLS_STEP.test(base)) return proposed.replace(`${line}\n`, '').replace(line, '').trim();
  // ag1-int: the line in the design's own form (AG02's `name (what it is for)`), so a revise neither drops the notes nor reads as rewritten.
  const list = tools.flatMap((t) => ('name' in t && t.name ? [{ name: t.name, ...('description' in t && t.description && { description: t.description }) }] : []));
  const notes = toolNotes(list);
  const listed = list.map((t) => (notes[t.name] ? `${t.name} (${notes[t.name]})` : t.name)).join(', ');
  const number = /^\d+\. /.exec(line)?.[0] ?? '';
  return proposed.replace(line, `${number}Tools: ${listed}${/; read before you write.*$/.exec(line)?.[0] ?? '.'}`);
}

// AG09: a tool a change adds gets a step of its own ("N. When <what the change asked>, call <name>."), before the Output part.
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOOLS_LINE = /^\s*\d+[.)]\s*Tools:/i;
const STEPS_HEAD = /^\s*(?:#{1,4}\s*)?steps\s*:/i;
const AFTER_STEPS = /^\s*(?:#{1,4}\s*)?(?:output|hand[ -]?over(?:\s+when)?)\s*:/i;
const NUMBERED = /^(\s*)\d+([.)]\s)/;

/** What the change asked, cut to one clause that reads after "When": the clause that names the tool, its leading "also"/"please" dropped, "let it X" as "it should X". */
function changeClause(change: string, tool: AgentToolConfig): string {
  const clauses = change.split(/[.;\n]+/).map((c) => c.trim()).filter(Boolean);
  const clause = clauses.find((c) => names(c, tool)) ?? clauses[0] ?? '';
  const piece = clause.split(/,|\s+(?:and|but|then)\s+/i).map((c) => c.trim()).find((c) => names(c, tool)) ?? clause;
  const text = piece.replace(/^(?:(?:also|and|please|now|then|just)\s+)+/i, '').replace(/[\s,.:;!?]+$/, '');
  // AG09: "add Slugify as a tool" configures the agent; it is no task, so the step comes from what the tool does.
  // AG09: the shape "a tool that/to/which/for …" is read before its article is stripped.
  const bare = text
    .replace(/^(?:(?:add|attach|include|install|enable|connect|use)\b|give\s+(?:it|the agent)\b)\s*/i, '')
    .replace(/\s+(?:as\s+(?:a|an|another|one more)\s+tools?|tools?)\s*$/i, '')
    // "a tool to the agent that …" / "a tool to it that …": the agent is who gets it, not what the tool does.
    .replace(/(\btools?)\s+to\s+(?:(?:the|this|my|our)\s+(?:agent|bot|assistant)|it)\b/i, '$1');
  const toolShape = /^(?:(?:a|an|the|another)\s+)?tools?\s+(?:that|which|to|for)\b/i.test(bare);
  const left = bare.replace(/^(?:the|a|an|another|one more)\s+/i, '');
  const wordsLeft = left.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const known = new Set([...toolWords(tool), 'tool', 'tools', 'the', 'a', 'an', 'to', 'it', 'too', 'also']);
  const configAsk = CONFIG_VERB.test(text) && (wordsLeft.every((w) => known.has(w) || toolWords(tool).some((k) => w.replace(/s$/, '') === k.replace(/s$/, ''))) || toolShape);
  if (configAsk) {
    const toTask = /^(?:(?:a|an|the|another)\s+)?tools?\s+to\s+(?!(?:the|this|my|our)\s+(?:agent|bot|assistant)\b|it\b)(.+)$/i.exec(bare)?.[1];
    if (toTask) return `asked to ${toTask.split(/\s+/).slice(0, 14).join(' ')}`;
    // the first sentence of what the tool says it is for, without a lead-in such as "Use this to" or "When you need to"
    const first = ('description' in tool && tool.description ? tool.description : '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].replace(/[\s.!?]+$/, '').replace(/`/g, '');
    const task = first.replace(/^(?:use|call)\s+(?:this|it)\s+(?:when|to|for|if)\s+/i, '').replace(/^(?:use\s+when|when|if)\s+(?:you\s+|the\s+agent\s+)?(?:need\s+to\s+|needs?\s+to\s+)?/i, '').trim();
    if (task) {
      const cut = task.length > 90 ? `${task.slice(0, 90).replace(/\s+\S*$/, '')}…` : task;
      return `you need to ${cut.charAt(0).toLowerCase()}${cut.slice(1)}`;
    }
    return `the job needs ${'name' in tool && tool.name ? tool.name.replace(/[_-]+/g, ' ') : 'it'}`;
  }
  const said = /^(?:let|have|make)\s+(?:it|the agent)\s+/i.test(text) ? text.replace(/^(?:let|have|make)\s+(?:it|the agent)\s+/i, 'it should ') : `asked to ${text}`;
  const words = said.split(/\s+/).slice(0, 16).join(' ');
  return words.length > 100 ? `${words.slice(0, 99).trimEnd()}…` : words;
}
const CONFIG_VERB = /^(?:add|attach|include|install|enable|connect|use|give\s+(?:it|the agent))\b/i;

function withToolSteps(text: string, added: Array<{ tool: AgentToolConfig; line?: string }>, change: string): string {
  const lines = text.split('\n');
  const stepsAt = lines.findIndex((l) => STEPS_HEAD.test(l));
  const outputAt = lines.findIndex((l, i) => i > stepsAt && AFTER_STEPS.test(l));
  const start = stepsAt + 1;
  const end = outputAt >= 0 ? outputAt : lines.length;
  const others = lines.filter((l) => !TOOLS_LINE.test(l)).join('\n');
  const missing = added.filter(({ tool: t }) => 'name' in t && t.name && !new RegExp(`(?<![A-Za-z0-9_])${escapeRe(t.name)}(?![A-Za-z0-9_])`, 'i').test(others));
  if (!missing.length) return text;
  const steps = missing.map(({ tool: t, line }) => line ?? `0. When ${changeClause(change, t)}, call ${'name' in t ? t.name : ''}${'requireApproval' in t && t.requireApproval ? ' (it asks the person first)' : ''}.`);
  const toolsAt = lines.findIndex((l, i) => i >= start && i < end && TOOLS_LINE.test(l));
  let at = toolsAt;
  if (at < 0) {
    at = end;
    while (at > start && !lines[at - 1].trim()) at--;
  }
  lines.splice(at, 0, ...steps);
  let n = 0;
  let from = start;
  let to = end + steps.length;
  if (stepsAt < 0) {
    // no Steps header: renumber only the run of numbered lines around the insertion, not other lists
    from = Math.min(at, lines.length - 1);
    while (from > 0 && NUMBERED.test(lines[from - 1])) from--;
    to = at + steps.length;
    while (to < lines.length && NUMBERED.test(lines[to])) to++;
  }
  for (let i = from; i < to; i++) if (NUMBERED.test(lines[i])) lines[i] = lines[i].replace(NUMBERED, (_m, lead: string, dot: string) => `${lead}${++n}${dot}`);
  return lines.join('\n');
}

const RENAME = /\b(?:call it|rename (?:it )?(?:to|as)?|name it|its name is)\s+["“']?([^"”'.,;\n]{2,60})/i;
const REFUSES = /\b(?:remove|delete|drop|stop using|get rid of|take away|disable|don['’]?t|do not|never|no longer|without|instead of|not)\b/i;

/**
 * ag1-int: the tools a change names to add, read as AG02 reads an ask (`toolsOf` with the catalog's names): not one it
 * removes or refuses ("remove the email tool", "not Hash"), nor the words of a new name ("call it Slack helper").
 */
function changeTools(change: string, types: NodeTypeInfo[]): string[] {
  const text = change.replace(RENAME, ' ');
  const clauses = text.split(/[.;\n]+/);
  return toolsOf(text, askCatalog(types)).filter((tool) => {
    const word = tool.split(':')[0].trim().toLowerCase();
    return !clauses.some((clause) => {
      const at = clause.toLowerCase().indexOf(word);
      return at >= 0 && REFUSES.test(clause.slice(0, at));
    });
  });
}

/**
 * AG09: a pending card's name that the design made (it is what `fallbackName` says of the card's description and tools) is made
 * again from the tools the card now has; a name the person gave, and an agent that exists (its config is the saved one, whole
 * with `memory` and `settings`), keep theirs: only a RENAME renames them.
 */
function madeAgain(base: Partial<AgentConfig>, tools: AgentToolConfig[], types: NodeTypeInfo[]): string | undefined {
  if (!base.name || ('memory' in base && 'settings' in base)) return undefined;
  const catalog = askCatalog(types);
  const shownNames = (list: AgentToolConfig[]) => list.flatMap((t) => (t.type === 'node' ? [types.find((x) => x.type === t.nodeType)?.descriptor.displayName ?? ''] : [])).filter(Boolean);
  const before = fallbackName(base.description ?? '', shownNames(base.tools ?? []), catalog);
  if (base.name !== before && base.name !== 'New agent' /* the design's placeholder when the ask gave no words for a name */) return undefined;
  const after = fallbackName(base.description ?? '', shownNames(tools), catalog);
  return after !== before ? after : undefined;
}

/**
 * ag3 carryover (the live pass): a change that gives a kept mail tool its sender ("send the email from a@b.test") sets that
 * tool's From where it is still empty. The design's flat proposal carries no parameters, so without this a revise kept the
 * base's tool as it was and said "No change". Only an address the change itself holds after "from", only into an empty From:
 * a From the person already set is never rewritten, and nothing else of the tool changes.
 */
function withSenderGiven(tool: AgentToolConfig, change: string, types: NodeTypeInfo[]): AgentToolConfig {
  if (tool.type !== 'node') return tool;
  const info = types.find((x) => x.type === tool.nodeType);
  if (!info || !isMailNode(info) || !info.descriptor.properties.some((p) => p.name === 'fromEmail')) return tool;
  const current = (tool.parameters as Record<string, unknown> | undefined)?.fromEmail;
  if (typeof current === 'string' ? current.trim() !== '' : current !== undefined && current !== null) return tool;
  const said = change.replace(AGENT_ASK, ' ');
  const senders = [...said.matchAll(/\bfrom(?:\s+(?:the\s+)?(?:address|e-?mail(?:\s+address)?|sender))?(?:\s+(?:to|as|be|is))?\s*:?\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi)].map((m) => m[1]);
  const distinct = [...new Set(senders.map((a) => a.toLowerCase()))];
  if (distinct.length !== 1) return tool; // none, or two different senders: ask, never guess
  return { ...tool, parameters: { ...((tool.parameters as Record<string, unknown> | undefined) ?? {}), fromEmail: senders[0] } } as AgentToolConfig;
}

/**
 * AG04: the proposal of a change as the agent it changes: the base's own tools stay unless the change removes them (least
 * privilege holds for the tools the change does not name), a new tool stays only when the change names it, and the name, model,
 * practices, look and team stay unless the change names them.
 */
function reviseDraft(draft: DraftResult, base: Partial<AgentConfig>, change: string, types: NodeTypeInfo[] = []): void {
  const kept = (base.tools ?? []).filter((t) => !removed(change, t)).map((t) => withSenderGiven(t, change, types)); // ag3 carryover:
  const have = new Set(kept.map(toolKey));
  const added: AgentToolConfig[] = [];
  const addedLabels = new Set<string>(); // AG09:
  const ownBy = new Map<string, AgentToolConfig | undefined>(); // AG09:
  for (const tool of draft.config.tools ?? []) {
    if (have.has(toolKey(tool)) && 'name' in tool && tool.name) ownBy.set(tool.name, kept.find((t) => toolKey(t) === toolKey(tool))); // AG09: the base's own tool under the name the design gave it
    if (have.has(toolKey(tool)) || removed(change, tool)) continue; // ag1-int: a tool the change removes is not proposed back
    if (tool.type === 'node' && !names(change, tool)) {
      draft.dropped.push(`${'name' in tool && tool.name ? tool.name : tool.nodeType}: the change doesn’t ask for it`);
      continue;
    }
    if ('name' in tool && tool.name) addedLabels.add(tool.name); // AG09: the needs of a tool the change adds are the card's
    // A name a base tool already has is not reused.
    if ('name' in tool && tool.name && kept.some((t) => 'name' in t && t.name === tool.name)) tool.name = `${tool.name.slice(0, 60)}_2`;
    added.push(tool);
  }
  const renamed = RENAME.exec(change)?.[1]?.trim();
  const modelNamed = /\b(?:model|haiku|sonnet|opus|gpt|claude|qwen|llama|gemma|mistral|ollama)\b/i.test(change);
  // The base as it is (schedules, channels, memory, persona, guardrails, access: what the change doesn't name), with what the proposal changed.
  const config: Partial<AgentConfig> = {
    ...base,
    name: renamed ?? madeAgain(base, [...kept, ...added], types) /* AG09: */ ?? base.name ?? draft.config.name,
    description: draft.config.description || base.description || '',
    instructions: reviseInstructions(draft.config.instructions ?? base.instructions ?? '', base.instructions ?? '', [...kept, ...added], { tools: added, change } /* AG09: */),
    tools: [...kept, ...added],
  };
  // The steps name only the tools the agent ends up with: a tool the change removed leaves no step that calls it.
  // AG07: the call names of the final tools, and as foreign the call names of the base's tools that are gone (a revise's removed tool leaves no step).
  const finalSteps = stepsToolsOf(config.tools ?? [], types);
  const gone = stepsToolsOf(base.tools ?? [], types).list.map((t) => t.name).filter((n) => !finalSteps.list.some((t) => t.name === n));
  const reconciled = nameOnlyOwnTools(config.instructions ?? '', finalSteps.list, { ...finalSteps.options, foreign: gone });
  config.instructions = reconciled.text;
  // The base's own tools kept here are not "never asked for": the design's rule for a tool the change does not name does not apply to them.
  const keptNames = kept.flatMap((t) => (t.type === 'node' ? [types.find((x) => x.type === t.nodeType)?.descriptor.displayName] : [])).filter((n): n is string => Boolean(n));
  draft.dropped = draft.dropped.filter((line) => !(/the request (?:never asks for it|asks to read or check)/.test(line) && keptNames.some((n) => line.startsWith(`${n}:`) || line.startsWith(`${n} (`))));
  draft.dropped.push(...reconciled.dropped);
  // AG09: the card's Left row is what this change leaves: the needs of a tool it adds, and of a kept tool only a credential slot still unset on the base's tool.
  draft.needs = draft.needs.filter((need) => {
    if (addedLabels.has(need.tool)) return true;
    const own = ownBy.get(need.tool) ?? kept.find((t) => 'name' in t && t.name === need.tool) ?? (base.tools ?? []).find((t) => 'name' in t && t.name === need.tool); // ag3 carryover: a kept tool as the change left it
    if (!own) return true; // a need of no tool (the model, a design failure) stays
    if (need.kind === 'parameter') {
      // AG09: a kept tool keeps a parameter need (Send Email's From Email) while that parameter is still empty on the base's tool.
      if (own.type !== 'node') return false;
      const info = types.find((x) => x.type === own.nodeType);
      const property = info?.descriptor.properties.find((pr) => new RegExp(`(?:set|fill in) ${escapeRe(pr.displayName)}(?:\\s|$)`).test(need.text));
      const value = property ? (own.parameters as Record<string, unknown> | undefined)?.[property.name] : undefined;
      return Boolean(property) && (value === undefined || value === '' || (Array.isArray(value) && !value.length));
    }
    if (need.kind !== 'credential') return false;
    const slot = /pick an? (.+?) credential/.exec(need.text)?.[1];
    const given = 'credentials' in own ? (own.credentials as Record<string, unknown> | undefined) : undefined;
    return !(slot && given && given[slot]);
  });
  if (modelNamed && draft.config.model) config.model = draft.config.model;
  draft.config = config;
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
    // AG13: a new knowledge base can always be started (the host's embeddings model, else keyword search), so the brief never says it cannot
    'Knowledge: only if its job means looking things up in documents (policies, contracts, playbooks, past answers). Use an existing collection only if it holds those documents; else a new name (lowercase-dashes) for an empty one the user fills (it is searched with the host\'s embeddings model, or by keywords when it has none). Most agents that act need none: leave knowledge empty.',
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
function withSpecHints(draft: DraftResult, spec: AgentSpec, input: Pick<ArchitectInput, 'types' | 'actor' | 'resources'>, base?: Partial<AgentConfig> /* ag1-int: a revise's base */): AgentNotAdded[] {
  const types = input.types.filter(usableAsTool);
  const tools = draft.config.tools ?? [];
  const ask = designWords(spec); // AG02: the whole ask when given
  const notAdded: AgentNotAdded[] = [];
  const nodeTool = (info: NodeTypeInfo) => tools.some((t) => t.type === 'node' && t.nodeType === info.type);
  const before = tools.length;
  // AG02: add one node type from the hints (the nested draft applies the same least-privilege rules, reading the whole ask).
  const add = (wanted: string, type: string): boolean => {
    const added = draftFrom({ name: draft.config.name, tools: [{ type: 'node', nodeType: type, description: wanted }] }, { types, actor: input.actor, known: '', request: [wanted, spec.ask].filter(Boolean).join('\n'), ...(input.resources && { resources: input.resources }) });
    const [tool] = added.config.tools ?? [];
    if (!tool) {
      draft.dropped.push(...added.dropped);
      return false;
    }
    if ('name' in tool && tool.name && tools.some((t) => 'name' in t && t.name === tool.name)) tool.name = `${tool.name.slice(0, 60)}_2`;
    tools.push(tool);
    draft.needs.push(...added.needs);
    return true;
  };
  for (const wanted of spec.tools ?? []) {
    // toolsOf found several mail nodes for "email … to <address>": said, not guessed.
    const several = /^([^:]{2,40}): (several nodes match \(.*\), pick one)$/.exec(wanted);
    if (several) {
      // AG07: a draft that already has a node tool that sends mail needs no pick: the mail is sent.
      const mails = several[1] === 'Send email' && tools.some((t) => { const d = t.type === 'node' ? types.find((x) => x.type === t.nodeType)?.descriptor : undefined; return Boolean(d) && /e-?mail|smtp|\bmail\b/i.test([d!.displayName, ...(d!.keywords ?? [])].join(' ')); });
      if (!mails) notAdded.push({ name: several[1], reason: several[2] });
      continue;
    }
    const [, app, rest] = /^\s*([^:]{2,40}):\s*(.+)$/.exec(wanted) ?? [undefined, undefined, wanted];
    // AG02: a catalog name ("Send Email", "Grafana"): exactly one node type by display name, else by plugin name.
    if (!app) {
      const exact = types.filter((t) => squash(t.descriptor.displayName) === squash(wanted));
      const pool = exact.length ? exact : types.filter((t) => [t.pluginName, t.pluginId].some((n) => n && squash(n) === squash(wanted)));
      if (pool.some(nodeTool)) continue;
      if (pool.length === 1) {
        if (!add(wanted, pool[0].type)) notAdded.push({ name: wanted, reason: draft.dropped.at(-1)?.replace(/^[^:]*:\s*/, '') || 'it could not be added' });
        continue;
      }
      if (pool.length > 1) {
        notAdded.push({ name: wanted, reason: `${pool.length} nodes match (${pool.slice(0, 3).map((t) => t.descriptor.displayName).join(', ')}): name the one you want` });
        continue;
      }
    }
    const hit = searchNodes(searchWords(wanted), types, 3)[0];
    const info = hit ? types.find((t) => t.type === hit.type) : undefined;
    // The app is named before the colon ("Linear: read issues"): a hit of another app is not it, whatever it scored.
    const right = hit && info && hit.score >= 8 && (!app || appNamed(info, app.trim())) ? hit : undefined;
    const covered = tools.some((t) => t.type === 'node' && (t.nodeType === right?.type || (info && right && types.find((x) => x.type === t.nodeType)?.pluginId === info.pluginId)));
    if (covered || !right) {
      const capability = rest.trim();
      if (!covered) {
        if (!draft.missing.some((m) => m.capability.toLowerCase() === capability.toLowerCase())) draft.missing.push({ capability, ...(app && { system: app.trim() }) });
        notAdded.push({ name: app?.trim() ?? wanted, reason: 'no plugin online has it' }); // AG02: said, not dropped silently
      }
      continue;
    }
    if (!add(wanted, right.type)) notAdded.push({ name: app?.trim() ?? wanted, reason: draft.dropped.at(-1)?.replace(/^[^:]*:\s*/, '') || 'it could not be added' });
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
  // AG02: every dropped line about a tool the ask named is in the person's words too; one the ask never named (least privilege) is not.
  for (const line of draft.dropped) {
    const info = types.find((t) => line.startsWith(`${t.descriptor.displayName}:`) || line.startsWith(`${t.descriptor.displayName} (`));
    const name = info?.descriptor.displayName;
    if (info && name && appNamed(info, ask) && !nodeTool(info) && !notAdded.some((n) => squash(n.name) === squash(name))) notAdded.push({ name, reason: line.replace(/^[^:]*:\s*/, '') });
  }
  if (base) {
    // ag1-int: a revise keeps the base's own form: its Tools step (when it has one) lists the tools now, its guardrails stay.
    draft.config = { ...draft.config, tools, ...(tools.length > before && { instructions: reviseInstructions(draft.config.instructions ?? '', base.instructions ?? '', tools, { tools: tools.slice(before), change: spec.ask ?? '' } /* AG09: */) }) };
    return notAdded;
  }
  const tokenJob = readsTokenJob(ask, tools);
  if (tools.length > before) {
    // The Tools line of the steps lists the tools the hints added too.
    const own = (draft.config.instructions ?? '').replace(/^\s*\d+[.)]\s*Tools:.*$/gm, '').replace(/\n{2,}/g, '\n');
    const list = tools.flatMap((t) => ('name' in t && t.name ? [{ name: t.name, ...('description' in t && t.description && { description: t.description }) }] : []));
    draft.config.instructions = briefParts(own, {
      tools: list.map((t) => t.name),
      toolNotes: toolNotes(list),
      writes: tools.some((t) => t.type === 'node' && t.requireApproval),
    });
  }
  draft.config = { ...draft.config, tools };
  if (tools.length && !draft.config.guardrails?.toolResult) draft.config.guardrails = briefGuardrails(draft.config.guardrails, true, tokenJob);
  return notAdded;
}

/** ag1-int: a failed architect call in one short clause for the card ("the model call failed: 400 …"), never more than one line. */
/** A provider's usage or rate limit in its own words ("You have reached your specified API usage limits", a 429), not a failed design. */
const PROVIDER_LIMIT = /usage limits?|rate.?limit|\b429\b|quota|credit balance|too many requests|exceeded your (?:current )?(?:limit|quota)/i;

/** A provider's message with anything that looks like a credential cut out: header and JSON values, Bearer/Basic tokens, prefixed keys, and the password of a URL. */
export function scrubSecrets(text: string): string {
  return text
    // x-api-key, api_key and authorization, as a header, an assignment or a JSON member, with or without a scheme word
    .replace(/(["']?)\b(x-api-key|api[-_]?key|authorization)\1\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?[^\s,;'"}]+["']?/gi, (_m, _q, name: string) => `${name}: …`)
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, (m) => `${m.split(/\s/)[0]} …`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '…')
    // 'key-' only with a digit in what follows: an ordinary word such as key-value_pairs is not a key
    .replace(/\bkey-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}/g, '…')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '…')
    // a provider's request and message ids (req_…, msg_…) stay: they are what you quote to its support
    .replace(/\b(?!(?:req|msg)_)[a-z]{2,4}_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{16,}/g, '…')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//…@');
}

export function designFailure(caught: unknown): string {
  const text = scrubSecrets((typeof caught === 'string' ? caught : errorText(caught)).split('\n')[0].replace(/\s+/g, ' ').trim());
  if (PROVIDER_LIMIT.test(text)) return `the model’s usage limit was reached: ${text.slice(0, 200)}`;
  return text ? `the model call failed: ${text.length > 160 ? `${text.slice(0, 159)}…` : text}` : 'the model call failed';
}

/**
 * Spotlight's newAgent, designed by the architect without a conversation (POST /api/agents/design): its last draft,
 * named as Spotlight named it. The first try hands the model what it would look up (designBrief) and offers only the
 * flat propose_design (plain strings: Ollama's parser fails on propose_agent's nested arrays); the second lets it look
 * around, with the tools the model's provider gets in a conversation. When neither proposes (or both fail), the agent is
 * what Spotlight gave, on the first model the host has, so the step still has an agent to run. A reached usage cap is
 * thrown, not swallowed.
 */
export async function designAgent(spec: AgentSpec, input: Omit<ArchitectInput, 'messages' | 'onEvent' | 'draft' | 'only' | 'request'>): Promise<DraftResult & { designed: boolean; notAdded: AgentNotAdded[] /* AG02: */; failure?: string }> {
  // AG02: the agent runs on Spotlight's model (the picker's, else the builder model); the whole ask goes to the architect beside the short spec.
  const agentModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : builderModel();
  const asked = spec.ask ? `\n\nThe person's own words, all of it (keep every address, name and id exactly as written):\n${spec.ask}` : '';
  let last: DraftResult | undefined;
  let failure: string | undefined; // ag1-int: why the architect made no design, for the card's line
  const onEvent: ArchitectInput['onEvent'] = (event) => {
    if (event.type === 'draft') last = { config: event.config, needs: event.needs, dropped: event.dropped, missing: event.missing, cases: event.cases ?? [] /* SB17: */ };
    if (event.type === 'error' && !('kind' in event && event.kind === 'cap')) failure = designFailure(event.message); // ag1-int:
  };
  const attempts: Array<Pick<ArchitectInput, 'messages' | 'only'>> = [
    { messages: [{ role: 'user', content: `${designRequest(spec)}${asked}\n\n${designBrief(spec.change ? { name: spec.name, description: spec.change, instructions: '' } /* AG04: the nodes the change matches */ : spec, input)}\n\nPropose it in one propose_design call now: short instructions, only the tools it needs.` }], only: [DESIGN_TOOL.name] },
    { messages: [{ role: 'user', content: `${designRequest(spec)}${asked}` }] },
  ];
  for (const attempt of attempts) {
    if (last || input.signal?.aborted) break;
    // A model that fails gets the fallback below; a reached usage cap is the caller's answer (the route says 429).
    // SB17: `request` is the least-privilege rules' text: the request alone, not the brief's hints.
    await runArchitect({ ...input, ...attempt, agentModel, ...(spec.base && spec.change && { draft: spec.base, noCases: true, revise: true }) /* AG04: */, request: spec.change ? `${designWords(spec)}\n${spec.change}` /* AG04: */ : designWords(spec), onEvent }).catch((caught: unknown) => {
      if (isUsageCapError(caught)) throw caught;
      failure = designFailure(caught); // ag1-int:
    });
  }
  if (last) {
    const kept: DraftResult = last;
    let notAdded: AgentNotAdded[] = [];
    if (spec.base && spec.change) {
      reviseDraft(kept, spec.base, spec.change, input.types); // AG04: the base's tools stay, a new one only when named
      // ag1-int: AG02's promise holds for a change too: a tool it names is added (the same least-privilege rules), or said why not.
      notAdded = withSpecHints(kept, { name: spec.name, description: '', instructions: '', ask: spec.change, tools: changeTools(spec.change, input.types.filter(usableAsTool)) }, input, spec.base);
    } else notAdded = withSpecHints(kept, spec, input); // SB17: AG02: what the ask named and the agent did not get
    kept.cases = asksFirstCases(kept.cases, kept.config); // AG15: a case about a tool that asks first expects the ask
    // ag3 carryover: a case naming a URL nobody gave is dropped (never a destination nobody gave); too few left → the card asks for cases.
    const before = kept.cases.length;
    kept.cases = casesWithoutMadeUpUrls(kept.cases, spec.change ? `${designWords(spec)}\n${spec.change}` : designWords(spec), kept.config);
    if (before >= 3 && kept.cases.length < 3 && !(spec.base && spec.change) && !kept.needs.some((n) => n.tool === 'test cases')) kept.needs.push({ tool: 'test cases', kind: 'parameter', text: 'Add test cases on the Evaluations tab' });
    return { ...kept, config: { ...kept.config, name: spec.base && spec.change ? (kept.config.name ?? spec.name) /* AG04: a rename is the change's */ : spec.name, description: kept.config.description || spec.description }, designed: true, notAdded };
  }
  // AG04: a change nothing proposed is no change: the base as it is.
  if (spec.base && spec.change) return { config: spec.base, needs: [], dropped: [], missing: [], cases: [], designed: false, notAdded: [], ...(failure && { failure }) };
  const model = agentModelOf(agentModel) ?? (input.resources ? chooseModel(undefined, input.resources.models) : undefined); // AG02:
  const instructions = briefParts(spec.instructions || spec.description, { ...(spec.description && { description: spec.description }), tools: [], writes: false }); // SB17:
  // ag1-int: the card says the design was not the architect's, and why, before what is left (sb3's live pass: the fallback card did not say so).
  const fallbackNeed = { tool: 'design', kind: 'parameter' as const, text: `Designed without the architect: ${input.signal?.aborted ? 'the request was stopped' : (failure ?? 'the model proposed no design')}` };
  return { config: { name: spec.name, description: spec.description, instructions, tools: [], guardrails: briefGuardrails(undefined, false) /* SB17: */, ...(model && { model }) }, needs: [fallbackNeed, { tool: 'test cases', kind: 'parameter', text: 'Add test cases on the Evaluations tab' }], dropped: [], missing: [], cases: [], designed: false, notAdded: (spec.tools ?? []).map((t) => ({ name: /^\s*([^:]{2,40}):/.exec(t)?.[1]?.trim() ?? t, reason: 'the design could not be made, so no tool was added' })) /* AG02: */ };
}
