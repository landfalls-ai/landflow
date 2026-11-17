/**
 * Nodes that connect workflows and Agents (docs/agents.md): a trigger that makes a workflow
 * callable by an agent (as a tool) or by another workflow (Execute Workflow, in workflows.ts),
 * and Run an Agent, which runs a published agent as a step of the flow with the chat model,
 * memory and tools connected to it.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem, type StreamChunk } from '@landflow/sdk';
import type { AgentMemory, AgentTool, LanguageModel } from '@landflow/engine';
import { approvalSubject, type AgentSession, type AgentStreamEvent } from '../../shared/agents';
import { agentAllowedBy } from '../../shared/project-policy';
// AG10: the chat approval (the AI Agent node's own wait, reused).
import { approvalSettings, askForApproval, decisionsOf, toolTargets } from './ai';

const main = [{ type: 'main' as const }];

interface InputField {
  name?: string;
  type?: 'string' | 'number' | 'boolean' | 'json';
  description?: string;
  required?: boolean;
}

/** Empty values per type, so a manual run in the editor has something to work with. */
const EXAMPLE: Record<NonNullable<InputField['type']>, JsonObject[string]> = { string: '', number: 0, boolean: false, json: {} };

function coerce(value: unknown, type: InputField['type']): JsonObject[string] {
  switch (type) {
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true';
    case 'json':
      if (typeof value !== 'string') return value as JsonObject[string];
      try {
        return JSON.parse(value) as JsonObject[string];
      } catch {
        return value;
      }
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

export const workflowTrigger = defineNode({
  description: {
    name: 'workflowTrigger',
    displayName: 'When Called by a Workflow or Agent',
    description: 'Start the workflow when an agent uses it as a tool or another workflow runs it; the arguments become the item',
    version: 1,
    kind: 'trigger',
    // "Run" in the editor starts here too, with empty example values.
    triggerSource: 'manual',
    categories: ['Triggers', 'AI'],
    icon: 'lucide:bot',
    color: '#a855f7',
    keywords: ['agent', 'tool', 'sub-workflow', 'execute workflow trigger', 'called by workflow'],
    inputs: [],
    outputs: main,
    properties: [
      {
        name: 'inputSource',
        displayName: 'Input Data Mode',
        type: 'options',
        default: 'workflowInputs',
        noDataExpression: true,
        options: [
          { name: 'Define Arguments', value: 'workflowInputs', description: 'Named, typed arguments (an agent sees them as the tool’s parameters)' },
          { name: 'Accept All Data', value: 'passthrough', description: 'Take whatever items the caller sends' },
        ],
      },
      {
        name: 'inputs',
        displayName: 'Arguments',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        description: 'What the caller must pass. An agent sees each one as a tool argument; Execute Workflow maps them.',
        default: { fields: [{ name: 'query', type: 'string', description: 'What to look up', required: true }] },
        displayOptions: { hide: { inputSource: ['passthrough'] } },
        groups: [
          {
            name: 'fields',
            displayName: 'Argument',
            values: [
              { name: 'name', displayName: 'Name', type: 'string', default: '', noDataExpression: true },
              {
                name: 'type',
                displayName: 'Type',
                type: 'options',
                default: 'string',
                noDataExpression: true,
                options: [
                  { name: 'String', value: 'string' },
                  { name: 'Number', value: 'number' },
                  { name: 'Boolean', value: 'boolean' },
                  { name: 'JSON', value: 'json' },
                ],
              },
              { name: 'description', displayName: 'Description', type: 'string', default: '', noDataExpression: true, description: 'Tells the model what to pass' },
              { name: 'required', displayName: 'Required', type: 'boolean', default: true, noDataExpression: true },
            ],
          },
        ],
      },
      {
        name: 'notice',
        displayName:
          'Add this workflow to an agent under Capabilities → Add workflow, or run it from another workflow with Execute Workflow. The output of the last node that runs is the result.',
        type: 'notice',
      },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    if (ctx.getNodeParameter('inputSource', 0) === 'passthrough') return [items.map((item, index) => ({ json: item.json, pairedItem: { item: index } }))];
    const fields = (ctx.getNodeParameter<{ fields?: InputField[] }>('inputs', 0)?.fields ?? []).filter((f) => f.name?.trim());
    return [
      (items.length ? items : [{ json: {} }]).map((item, index): NodeItem => {
        const json: JsonObject = { ...item.json };
        for (const field of fields) {
          const name = field.name!.trim();
          const type = field.type ?? 'string';
          if (json[name] === undefined || json[name] === null) {
            if (field.required !== false && ctx.mode === 'tool') throw new NodeOperationError(`The agent didn’t pass the required argument "${name}"`, { itemIndex: index });
            json[name] = EXAMPLE[type];
          } else json[name] = coerce(json[name], type);
        }
        return { json, pairedItem: { item: index } };
      }),
    ];
  },
});

export const messageAgentNode = defineNode({
  description: {
    name: 'messageAgent',
    displayName: 'Run an Agent',
    description: 'Run one of your agents in the flow: its persona, skills and capabilities, with the chat model, memory and tools connected here',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:bot-message-square',
    color: '#a855f7',
    keywords: ['agent', 'assistant', 'delegate', 'ask', 'message an agent', 'persona', 'knowledge base'],
    usableAsTool: true,
    // Delegating: the tool also takes a required `reason`, which the chat page shows as "asked <Agent>: <reason>".
    delegates: true,
    toolDescription: 'Ask another agent to do something. Arguments: `message` (the full task, the agent does not see this conversation) and `reason`.',
    // Like the AI Agent's ports, all optional: the agent brings its own model and capabilities.
    inputs: [
      { type: 'main' },
      { type: 'ai_languageModel', displayName: 'Chat Model', maxConnections: 1 },
      { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
    ],
    outputs: main,
    properties: [
      {
        name: 'agentId',
        displayName: 'Agent',
        type: 'options',
        default: '',
        required: true,
        noDataExpression: true,
        typeOptions: { loadOptionsMethod: 'agents' },
        description: 'Runs the agent’s published version',
      },
      { name: 'message', displayName: 'Message', type: 'string', default: '{{ $json.chatInput ?? $json.text }}', required: true, typeOptions: { rows: 3 } },
      {
        name: 'conversation',
        displayName: 'Conversation',
        type: 'options',
        default: 'new',
        options: [
          { name: 'New session per item', value: 'new', description: 'Every message starts fresh (a connected memory still gives it the history)' },
          { name: 'Continue by key', value: 'key', description: 'Messages with the same key share a session, or the connected memory’s history' },
        ],
      },
      {
        name: 'sessionKey',
        displayName: 'Session Key',
        type: 'string',
        default: '{{ $json.sessionId }}',
        displayOptions: { show: { conversation: ['key'] } },
      },
      {
        name: 'toolImagesKept',
        displayName: 'Tool Images to Keep',
        type: 'number',
        default: 2,
        typeOptions: { minValue: 0, maxValue: 10 },
        description: 'When the agent’s tools return images (a screenshot), only this many of the newest go back to the model on each turn; older ones are dropped and their text kept',
      },
      // AG10: a tool that needs approval can wait for the person in the editor's chat.
      {
        name: 'toolApprovals',
        displayName: 'Tool Approvals',
        type: 'options',
        default: 'refuse',
        noDataExpression: true,
        options: [
          { name: 'Refuse', value: 'refuse', description: 'Tools that need approval are refused, as before' },
          { name: 'Ask in the editor’s chat', value: 'askInChat', description: 'In the editor’s chat, a tool that needs approval waits for your Approve; every other run refuses it' },
        ],
      },
      {
        name: 'notice',
        displayName:
          'Connect a chat model to use it instead of the agent’s own, tools (a vector store in Retrieve Documents (As Tool) mode is a knowledge base) to add to its capabilities for this run, and a memory to keep the conversation in. Tools that require approval are refused in workflow runs (nobody is there to approve them), unless Tool Approvals asks in the editor’s chat and you run the flow from its Chat (then the run waits for your Approve; with a model or tools connected here it still refuses).',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    // Loaded lazily: the agents runtime imports the runner, which needs the registry this plugin is part of.
    const { agentStore } = await import('../agents/store');
    const { newSession, runAgent } = await import('../agents/runtime');
    const connection = ctx.getInputConnectionData;
    const [model] = connection ? await connection<LanguageModel>('ai_languageModel') : [];
    const [memory] = connection ? await connection<AgentMemory>('ai_memory') : [];
    const tools = connection ? await connection<AgentTool>('ai_tool') : [];
    // AG14: what each wired tool reaches (its sub-node's credential and host), for the via line.
    const flowTargets = await toolTargets(ctx, tools);
    const send = ctx.sendChunk;
    const items = ctx.getInputData();
    // AG10: back from a wait for the person's Approve in the editor's chat (WaitRequest.rerun): the items done, and the session to go on with.
    const saved = ctx.getNodeState?.() as { waiting?: { kind: 'approval'; itemIndex: number; sessionId: string; agentId: string; out: NodeItem[] }; $resume?: { kind: string; data?: JsonObject } } | undefined;
    ctx.setNodeState?.(undefined);
    const waited = saved?.waiting && saved.$resume ? saved.waiting : undefined;
    const out: NodeItem[] = waited ? [...waited.out] : [];
    for (let i = waited?.itemIndex ?? 0; i < Math.max(items.length, 1); i++) {
      try {
        const agentId = ctx.getNodeParameter<string>('agentId', i);
        const agent = agentStore.get(agentId);
        if (!agent) throw new NodeOperationError('Choose an agent — the selected one was deleted', { itemIndex: i });
        if (!agent.published) throw new NodeOperationError(`Publish “${agent.name}” first`, { description: 'Workflows run the published version of an agent.', itemIndex: i });
        // A message that comes out empty ($fromAI with no argument, as when a roster pick starts the run here) falls back to the chat input.
        const chatInput = items[i]?.json?.chatInput;
        const message = (String(ctx.getNodeParameter('message', i) ?? '').trim() || (typeof chatInput === 'string' ? chatInput.trim() : '')).trim();
        if (!message) throw new NodeOperationError('The message is empty', { itemIndex: i });
        const key = ctx.getNodeParameter<string>('conversation', i) === 'key' ? String(ctx.getNodeParameter('sessionKey', i) ?? '').trim() : '';
        const userId = `workflow:${ctx.getWorkflowId() ?? 'unknown'}`;
        // Links the session to this run and node, so the execution view can show the agent working.
        const node = ctx.getNode();
        const execution = { workflowId: ctx.getWorkflowId() ?? 'unknown', executionId: ctx.getExecutionId(), nodeId: node.id, ...(node.name && { nodeName: node.name }) };
        // AG10: only the editor's chat can ask; the hosted chat page, webhooks, schedules and manual runs refuse as before.
        // A model or tools connected here do not go through a decision, so with them the node refuses too.
        const askInChat = ctx.getNodeParameter<string>('toolApprovals', i, 'refuse') === 'askInChat' && ctx.getMode() === 'chat' && Boolean(ctx.putExecutionToWait) && !model && !tools.length;
        const onEvent = send && streamer(send, i, { id: agent.id, name: agent.name, ...(agent.avatar && { face: agent.avatar as unknown as JsonObject }) });
        let result: Awaited<ReturnType<typeof runAgent>>;
        if (waited && i === waited.itemIndex) {
          // AG10: each decision goes to the session in order; the last one resumes the run.
          const { decide } = await import('../agents/runtime');
          const decisions = decisionsOf(saved?.$resume);
          const stored = agentStore.getSession(waited.sessionId);
          const calls = stored?.pending?.calls ?? [];
          let resumed: Awaited<ReturnType<typeof decide>> | undefined;
          send?.({ type: 'begin', itemIndex: i });
          // Every edit is saved before the first decision, so no decision rewrites a stale copy of the session.
          let edited = false;
          for (const pendingCall of calls) {
            const decision = decisions[pendingCall.callId];
            if (!decision?.approved || !decision.input) continue;
            // A remote agent's pause keeps its own state, so an edit cannot be applied there: say so rather than run it unedited.
            if (pendingCall.remote) throw new NodeOperationError('The approval changed the input of a remote agent\'s call, which cannot be edited; approve it as it is', { itemIndex: i });
            pendingCall.input = decision.input as typeof pendingCall.input;
            edited = true;
          }
          if (edited && stored) agentStore.saveSession(stored);
          for (const pendingCall of calls) {
            const decision = decisions[pendingCall.callId];
            if (!decision) continue;
            resumed = await decide(agent, waited.sessionId, pendingCall.callId, decision.approved, { ...(decision.by && { by: decision.by }), toolImages: { keep: Number(ctx.getNodeParameter('toolImagesKept', i, 2)) }, ...(onEvent && { onEvent }), ...(ctx.signal && { signal: ctx.signal }) });
          }
          if (!resumed || resumed.status !== 'resumed') throw new NodeOperationError('The approval was not decided for every tool call', { itemIndex: i });
          result = resumed;
        } else {
          let session;
          if (memory) {
            // The connected memory holds the conversation: a new session starts from its history and saves back to it.
            session = newSession(agent, { source: 'workflow', userId, version: agent.published.version });
            session.messages = await memory.load(key || 'default');
          } else {
            const conversationKey = key ? `${userId}:${key}` : undefined;
            const existing = conversationKey ? agentStore.findConversation(agent.id, conversationKey) : undefined;
            // AG10: a keyed conversation that waits for Approve or Reject takes no new message: the model would be sent an unanswered tool call.
            // N6: a waiting run that was cancelled (or failed, or is gone) leaves nobody to decide: the orphan call is settled as cancelled and the conversation goes on.
            if (existing && (existing.pending || existing.status === 'awaiting_approval') && (await orphaned(existing, (await import('../store')).store))) settleOrphan(existing, agentStore);
            if (existing && (existing.pending || existing.status === 'awaiting_approval')) throw new NodeOperationError(`${agent.name} is waiting for Approve or Reject on its last tool call: decide that first, then send the next message`, { itemIndex: i });
            session = (existing && { ...existing, version: agent.published.version }) ?? newSession(agent, { source: 'workflow', userId, version: agent.published.version, ...(conversationKey && { conversationKey }) });
          }
          session.execution = execution;
          send?.({ type: 'begin', itemIndex: i });
          result = await runAgent({
            agent,
            session,
            message,
            // AG10: 'ask' only in the editor's chat with Tool Approvals set to ask there.
            approvals: askInChat ? 'ask' : 'deny',
            toolImages: { keep: Number(ctx.getNodeParameter('toolImagesKept', i, 2)) },
            ...((model || tools.length) && { flow: { ...(model && { model }), ...(tools.length && { tools, targets: flowTargets }) } }),
            // The chat panel and streaming triggers get the agent's answers and tool calls as they happen.
            ...(onEvent && { onEvent }),
          });
        }
        // AG10: the agent stopped at a tool that needs approval: the run waits for the person in the chat, then this node runs again.
        if (askInChat && result.reason === 'awaiting_approval' && result.session.pending) {
          const labels = new Map(result.session.timeline.flatMap((e) => (e.type === 'tool' ? [[e.callId, e.label] as const] : [])));
          const calls = result.session.pending.calls.filter((c) => !c.decision).map((c) => {
            const subject = approvalSubject(c);
            return { id: c.callId, name: c.remote ? subject.tool : (labels.get(c.callId) ?? c.tool), input: subject.input as JsonObject };
          });
          send?.({ type: 'end', itemIndex: i });
          ctx.setNodeState?.({ waiting: { kind: 'approval', itemIndex: i, sessionId: result.session.id, agentId: agent.id, out: out as unknown as JsonObject[] } as unknown as JsonObject });
          await askForApproval(ctx, i, approvalSettings(ctx, i, 'all'), calls, { agentApproval: { agent: agent.name } }, `${agent.name} wants to use ${calls.map((c) => c.name).join(', ')}`);
          return [out];
        }
        send?.({ type: 'end', itemIndex: i });
        if (result.reason === 'error') {
          const last = [...result.session.timeline].reverse().find((e) => e.type === 'error');
          throw new NodeOperationError(`${agent.name} failed: ${last?.type === 'error' ? last.message : 'unknown error'}`, { itemIndex: i });
        }
        if (memory) await memory.save(key || 'default', result.session.messages);
        const steps = result.session.timeline.flatMap((e) => (e.type === 'tool' ? [{ tool: e.tool, kind: e.kind, status: e.status, ...(e.error && { error: e.error }) }] : []));
        out.push({
          json: {
            reply: result.reply ?? null,
            sessionId: result.session.id,
            agentId: agent.id,
            version: agent.published.version,
            model: model ? `${model.provider}/${model.model}` : agent.published.config.model ? `${agent.published.config.model.provider}/${agent.published.config.model.model}` : null,
            endReason: result.reason,
            usage: { ...result.usage },
            steps,
          },
          pairedItem: { item: i },
        });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
      }
    }
    return [out];
  },
  methods: {
    loadOptions: {
      async agents() {
        const { agentStore } = await import('../agents/store');
        // PC06: with a project in scope (the workflow being edited), only the agents available there.
        const { tableScope } = await import('../datatables/projects');
        const projects = await import('../projects');
        const projectId = tableScope()?.projectId;
        const all = agentStore.list();
        const available = projectId ? projects.availableAgentIds(projectId, all.map((a) => a.id)) : undefined;
        // PC13: and allowed there (the project's allow-list of agents).
        const { getProjectSettings } = await import('../governance/scopes');
        const settings = projectId ? getProjectSettings(projectId) : undefined;
        return all
          .filter((agent) => !available || available.has(agent.id))
          .filter((agent) => !settings || !projectId || agentAllowedBy(settings, agent.id, projects.homeProjectId('agent', agent.id) === projectId))
          .map((agent) => {
            const state = agent.published ? `Published v${agent.published.version}` : 'Not published yet';
            const home = projectId ? projects.homeProjectId('agent', agent.id) : undefined;
            const from = home && home !== projectId ? projects.getProject(home)?.name : undefined;
            return { name: agent.name, value: agent.id, description: from ? `From ${from} · ${state}` : state };
          });
      },
    },
  },
});

/**
 * Whether nobody can decide this session's pending call any more: its execution record is gone, or was cancelled or failed.
 * A record that is waiting, or running (an Approve is resuming it: the tool may already have run), is not an orphan.
 */
async function orphaned(session: AgentSession, store: typeof import('../store').store): Promise<boolean> {
  const id = session.execution?.executionId;
  if (!id) return false;
  const record = await store.loadExecution(id);
  return !record || record.status === 'canceled' || record.status === 'error';
}

/** A pending call nobody can decide any more: each is answered "cancelled", so the transcript has no unanswered tool call, and the session is idle. */
function settleOrphan(session: AgentSession, agentStore: typeof import('../agents/store').agentStore): void {
  const pending = session.pending;
  if (pending) {
    const answered = new Set(pending.results.map((r) => r.id));
    const cancelled = pending.calls.filter((c) => !answered.has(c.callId)).map((c) => ({ id: c.callId, name: c.tool, content: 'Cancelled: the run waiting for approval was cancelled, so this call did not run.', isError: true }));
    session.messages.push({ role: 'tool', results: [...pending.results, ...cancelled] });
    for (const entry of session.timeline) if (entry.type === 'tool' && entry.status === 'awaiting_approval') Object.assign(entry, { status: 'denied', error: 'Cancelled: the run was cancelled' });
  }
  delete session.pending;
  session.status = 'idle';
  agentStore.saveSession(session);
}

/** An agent's timeline as the chat chunks of the AI Agent node: its answers, and its tool calls as they start and end. */
export function streamer(send: NonNullable<IExecuteContext['sendChunk']>, itemIndex: number, agent?: StreamChunk['agent']) {
  let wrote = false;
  /** The chunks carry who wrote them when the node labels its agent (the chat page shows it). */
  const label = agent ? { agent } : {};
  return (event: AgentStreamEvent) => {
    if (event.type !== 'entry') return;
    const { entry } = event;
    if (entry.type === 'assistant' && entry.text.trim()) {
      send({ type: 'item', itemIndex, ...label, content: `${wrote ? '\n\n' : ''}${entry.text}` });
      wrote = true;
    } else if (entry.type === 'tool') {
      // A call waiting for a person is not a failure, and a denied one is a decision (the chat's step list reads 'Waiting for approval' and 'Denied').
      const status = entry.status === 'running' ? 'started' : entry.status === 'success' ? 'finished' : entry.status === 'awaiting_approval' ? 'approval' : entry.status === 'denied' ? 'denied' : 'failed';
      const output = entry.error ?? (entry.output === undefined ? undefined : typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output));
      send({ type: 'tool', itemIndex, ...label, tool: { id: entry.callId, name: entry.tool, status, input: entry.input as JsonObject, ...(output !== undefined && { output: output.slice(0, entry.target?.knowledge ? 12_000 : 2_000) }), ...(entry.target && { target: entry.target }) } }); // AG14:
    }
  };
}
