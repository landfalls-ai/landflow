/**
 * The Agent architect (docs/agents.md#agent-architect): a multi-turn tool-calling loop, like the editor's builder chat,
 * that designs an agent with the user. It reads what the instance has (node types usable as tools from every plugin
 * online, callable workflows, other agents, credential names, persona templates) and proposes a whole agent as a
 * draft. Drafts are validated: unknown node types, workflows and agents are left out, parameters keep only the node's
 * own, ids nobody gave are dropped and credentials are never set. The user creates the agent from the draft; the
 * architect never creates or changes one itself.
 */
import { nanoid } from 'nanoid';
import { defaultParameters, isPropertyVisible } from '@landflow/protocol';
import type { AgentMessage, LanguageModel, ToolCall, ToolResult, ToolSpec } from '@landflow/engine';
import type { AgentConfig, AgentPersona, AgentTemplate, AgentToolConfig, AnswerLength } from '@/lib/shared/agents';
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
import { recordUsage } from '../usage/ledger';
import { recoverToolCalls, withoutInventedIds, withoutRepeats } from './chat';
import { assistantModel, modelLabel } from './model';
import { catalogSummary, nodeDocs, searchNodes } from './research';

export const MAX_ARCHITECT_STEPS = 10;

/** Node types an agent can call: actions whose only required inputs are main ones (the Abilities tab's own filter). */
export const usableAsTool = (t: NodeTypeInfo) => t.descriptor.kind === 'action' && t.descriptor.inputs.every((p) => p.type === 'main' || !p.required);

export interface ArchitectInput {
  messages: ArchitectTurn[];
  draft?: Partial<AgentConfig>;
  model?: string | LanguageModel;
  /** The node types drafts may use: the route passes those online and allowed for the caller. */
  types: NodeTypeInfo[];
  actor: Actor;
  signal?: AbortSignal;
  onEvent: (event: ArchitectEvent) => void;
}

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['node', 'workflow', 'agent'] },
    nodeType: { type: 'string', description: 'node: the node type id from search_nodes' },
    name: { type: 'string', description: 'node: the tool name the model sees, snake_case (post_to_slack)' },
    description: { type: 'string', description: 'node / workflow: when the agent should call it, one sentence' },
    parameters: { type: 'object', description: 'node: parameter values from get_node_docs; what the agent decides per call is "{{ $fromAI(\'key\', \'description\', \'string\') }}"' },
    workflowId: { type: 'string', description: 'workflow: an id from list_workflows' },
    agentId: { type: 'string', description: 'agent: an id from list_agents' },
    useWhen: { type: 'string', description: 'agent: when to delegate to it' },
  },
  required: ['type'],
};

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
        tones: { type: 'array', items: { type: 'string' }, description: '2–3 words: Precise, Friendly, Calm, Direct, Warm, Brief, Thorough, Patient, Formal, Empathetic' },
        length: { type: 'string', enum: ['sentence', 'short', 'detailed'] },
        always: { type: 'array', items: { type: 'string' }, description: 'Rules, a sentence each' },
        never: { type: 'array', items: { type: 'string' } },
        instructions: { type: 'string', description: 'How it works, step by step, naming its tools' },
        icon: { type: 'string', description: 'A lucide icon name: bot, headset, siren, search, database, chart-line, mail, calendar, code, shield, rocket, newspaper, briefcase' },
        tools: { type: 'array', items: TOOL_SCHEMA },
        missing: { type: 'array', items: { type: 'string' }, description: 'Parts of the job no node online can do, left out of the tools, as the app’s name, a colon and what the agent would do: "Grafana: read firing alerts"' },
      },
      required: ['summary', 'name', 'role', 'instructions', 'tools'],
    },
  },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const SYSTEM = `You are the Agent architect in Landflow, an n8n-like automation platform where every node comes from a plugin (TypeScript, Python or Go). You design agents with the user: who the agent is, how it talks, its instructions and the tools it uses. You never create the agent: you propose it, and the user reviews the draft and clicks Create.

An agent is:
- a persona: name, role, who it helps (audience), what it does for them (mission), 2–3 tones, answer length, rules it always and never follows;
- instructions: how it works, step by step, naming its tools;
- tools: plugin nodes it calls (type "node"), workflows it calls (type "workflow"), other agents it delegates to (type "agent").

How to work:
- If the request is too vague to pick tools (no task, or no system to work in), ask one short question. Otherwise don't ask: design.
- Research before proposing: search_nodes for each thing the agent must do (read tickets, post to Slack, query a database…), get_node_docs for each node you use, list_workflows and list_agents when an existing workflow or agent could do part of the job, list_credentials to see what works right away, list_templates when one fits as a start.
- Use only node types search_nodes returned, and ids list_workflows and list_agents returned. If nothing online can do a part of the job, leave it out of the tools, list it in propose_agent's "missing" as the app's name, a colon and what the agent would do ("Grafana: read firing alerts"), and say so in one sentence; never invent a node type.
- A node tool's parameters: set what is fixed for this agent (the operation, a resource); what the agent decides per call is "{{ $fromAI('key', 'what it is', 'string') }}". Never make up ids, channels, URLs or emails the user didn't give: leave those for the user.
- Give each node tool a snake_case name and a one-sentence description of when to call it.
- Tools are actions the agent takes. How it is started (a webhook, a schedule, Slack or Teams, a workflow) isn't a tool: the user sets that on the agent's Deploy tab, so say it in your reply instead.
- The model itself reads, parses, summarises and formats text: don't add a tool (a Code node, a formatter) for that.
- Keep the agent focused: the few tools it needs, rules that matter, instructions of a few short steps.
- propose_agent replaces the whole draft each time: when the user asks for a change, send the complete agent again with the change.
- After proposing, say in one to three sentences what the agent does and what the user still has to finish (pick credentials, a model, fill in a value). Never say the agent was created. Don't repeat the draft in prose: it shows beside the chat.
- Be brief and concrete; no headings.`;

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const shorten = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
/** A list the model may send as an array or as one string, split on `split` ("Precise, Calm" or rules a line each). */
const texts = (value: unknown, max: number, count: number, split: RegExp) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(split) : []).flatMap((v) => text(typeof v === 'string' ? v.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '') : v, max) ?? []).slice(0, count);

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

export interface DraftResult {
  config: Partial<AgentConfig>;
  needs: ArchitectNeed[];
  dropped: string[];
  /** What the architect said no node online can do, plus node types it made up for an app no plugin covers. */
  missing: ArchitectMissing[];
}

/**
 * The model's propose_agent arguments as an agent config: a template's persona under the fields given, tools checked
 * against what exists, parameters kept to the node's own (over its defaults), invented ids left out. `keep` is the
 * draft so far: its avatar, colour and team (the user may have changed them) carry over.
 */
export function draftFrom(args: Record<string, unknown>, context: { types: NodeTypeInfo[]; actor: Actor; known: string; keep?: Partial<AgentConfig>; templates?: AgentTemplate[] }): DraftResult {
  const { types, actor, known, keep } = context;
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
  set('tones', texts(parsed(args.tones), 24, 4, /[,;\n]/));
  set('always', texts(parsed(args.always), 200, 8, /\n/));
  set('never', texts(parsed(args.never), 200, 8, /\n/));
  if (args.length === 'sentence' || args.length === 'short' || args.length === 'detailed') persona.length = args.length as AnswerLength;

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
      const parameters = { ...defaultParameters({ properties: d.properties.filter((p) => !(p.name in kept)) }), ...kept };
      tools.push({ id: `tl_${nanoid(8)}`, type: 'node', name: toolLabel, description: text(tool.description, 300) ?? d.toolDescription ?? d.description, nodeType: info.type, parameters });
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
      tools.push({ id: `tl_${nanoid(8)}`, type: 'agent', agentId: agent.id, ...(text(tool.useWhen ?? tool.description, 300) && { useWhen: text(tool.useWhen ?? tool.description, 300) }) });
    } else {
      dropped.push(`a tool of kind “${String(kind ?? 'unknown')}”`);
    }
  }

  const config: Partial<AgentConfig> = {
    ...(template && { ...base, tools: undefined }),
    name,
    description: text(args.description, 300) ?? base.description ?? keep?.description ?? '',
    icon: text(args.icon, 40) ?? base.icon ?? keep?.icon ?? 'bot',
    color: keep?.color ?? base.color ?? '#6366f1',
    avatar: keep?.avatar ?? base.avatar ?? { kind: 'face', face: randomFace(name) },
    ...(keep?.team && { team: keep.team }),
    ...(Object.keys(persona).length && { persona }),
    instructions: text(args.instructions, 8000) ?? base.instructions ?? '',
    tools,
  };
  return { config, needs, dropped, missing };
}

export async function runArchitect(input: ArchitectInput): Promise<void> {
  const { onEvent, actor } = input;
  const types = input.types.filter(usableAsTool);
  const model = assistantModel(input.model);
  const started = Date.now();
  let draft = input.draft;
  let said = '';
  let proposals = 0;
  /** The last proposal's arguments, as sent: local models propose the same agent again and again. */
  let lastProposal: string | undefined;
  /** Missing tools recorded in this reply, once each. */
  const recorded = new Set<string>();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const known = () => [...input.messages.map((m) => m.content), JSON.stringify(draft ?? {})].join('\n');
  const system = [
    SYSTEM,
    `\nPlugins online and the nodes an agent can use from them (search_nodes for details):\n${catalogSummary(types)}`,
    draft ? `\nThe draft so far (propose_agent replaces it):\n${JSON.stringify({ ...draft, avatar: undefined }).slice(0, 6000)}` : '',
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
        const hits = searchNodes(query, types).map(({ score: _score, ...hit }) => {
          const info = types.find((t) => t.type === hit.type);
          const needed = info?.descriptor.credentials?.filter((c) => c.required).map((c) => c.name);
          return { ...hit, ...(info && { plugin: info.pluginId === 'core' ? 'Built in' : info.pluginName }), ...(needed?.length && { credentials: needed }) };
        });
        return result(hits.length ? JSON.stringify(hits) : `No node an agent can use matches “${query}”. Try other words; if nothing fits, that part isn't available here.`, `Searched plugins for “${shorten(query, 40)}”`);
      }
      case 'get_node_docs': {
        const asked = String(args.type ?? '');
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
      case 'list_templates': {
        const list = agentTemplates
          .list(actor)
          .filter((t) => t.id !== 'blank')
          .map((t) => ({ id: t.id, name: t.name, category: t.category, description: t.description, ...(t.config.persona?.role && { role: t.config.persona.role }), ...(t.config.persona?.tones?.length && { tones: t.config.persona.tones }) }));
        return result(JSON.stringify(list), `Listed ${list.length} templates`);
      }
      case 'propose_agent': {
        const { summary: _summary, ...rest } = args;
        const asSent = JSON.stringify(rest);
        if (asSent === lastProposal) return result('Nothing changes: you proposed exactly this agent already. Do not propose it again; answer the user.', 'Skipped a repeated proposal');
        lastProposal = asSent;
        const { config, needs, dropped, missing } = draftFrom(args, { types, actor, known: known(), keep: draft });
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
        onEvent({ type: 'draft', id: `dr_${nanoid(8)}`, summary, config, needs, dropped, missing });
        const notes = [dropped.length ? `Left out: ${dropped.join('; ')}.` : '', missing.length ? `Noted as missing (the user sees it): ${missing.map((m) => m.capability).join('; ')}.` : '', needs.length ? `The user still has to: ${needs.map((n) => n.text).join('; ')}.` : ''].filter(Boolean).join(' ');
        return result(`Shown to the user beside the chat with a Create button (${config.tools?.length ?? 0} tools). ${notes} Don't repeat the draft or say it was created.`, `Proposed “${shorten(config.name ?? 'agent', 40)}” with ${config.tools?.length ?? 0} tools`);
      }
      default:
        return result(`Unknown tool ${call.name}`, `Unknown tool ${call.name}`, false);
    }
  };

  await traceAssistant('architect', { 'gen_ai.request.model': model.model, 'landflow.assistant.turns': input.messages.length }, async (span) => {
    const history: AgentMessage[] = input.messages.map((m) => (m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', text: m.content, toolCalls: [] }));
    let steps = 0;
    let finished = false;
    while (steps < MAX_ARCHITECT_STEPS && !finished) {
      steps++;
      const generate = () => model.generate({ system, messages: history, tools: TOOLS, ...(input.signal && { signal: input.signal }) });
      // Ollama answers 500 when it can't parse the tool call qwen3-coder wrote ("XML syntax error"): ask once more.
      const turn = await generate().catch((error: unknown) => {
        if (input.signal?.aborted || !/XML syntax error|tool call|unexpected end/i.test(String((error as Error)?.message ?? error))) throw error;
        span.addEvent('assistant.retry', { 'landflow.reason': String((error as Error)?.message ?? error).slice(0, 200) });
        return generate();
      });
      usage.inputTokens += turn.usage?.inputTokens ?? 0;
      usage.outputTokens += turn.usage?.outputTokens ?? 0;
      const { text: reply, calls } = turn.toolCalls.length ? { text: turn.text, calls: turn.toolCalls } : recoverToolCalls(turn.text, TOOL_NAMES);
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
    if (!finished) onEvent({ type: 'text', text: `(Stopped after ${MAX_ARCHITECT_STEPS} steps. Ask me to continue if there is more to do.)` });
    span.setAttribute('landflow.assistant.steps', steps);
    span.setAttribute('landflow.architect.proposals', proposals);
    onEvent({ type: 'done', model: modelLabel(model), durationMs: Date.now() - started, steps, usage });
  });
}
