/**
 * Nodes that connect workflows and Agents (docs/agents.md): a trigger that makes a workflow
 * callable by an agent (as a tool) or by another workflow (Execute Workflow, in workflows.ts),
 * and Run an Agent, which runs a published agent as a step of the flow with the chat model,
 * memory and tools connected to it.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem, type StreamChunk } from '@landflow/sdk';
import type { AgentMemory, AgentTool, LanguageModel } from '@landflow/engine';
import { isEditorRun, PIN_PARAM, runSource } from '../../shared/agent-versions'; // AG17: AG21:
import { approvalSubject, type Agent, type AgentSession, type AgentStreamEvent } from '../../shared/agents';
import { agentAllowedBy } from '../../shared/project-policy';
// AG10: the chat approval (the AI Agent node's own wait, reused).
import { approvalSettings, askForApproval, decisionsOf, toolTargets } from './ai';
import { inboxMode, maskParams, REFUSE_WHY, refusedResult, settledLine, type InboxOpen, type RefuseWhy } from '../../shared/approval-inbox'; // AP02:
import { inboxPort } from '../approval-inbox/port'; // AP02:
import { redactValue } from '../secrets/redact'; // AP02:
import type { ExecutionRecord } from '../../shared/types'; // wave ap1:

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
        description: 'Production runs the agent version the workflow was published with; the editor tests the agent’s draft',
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
        // AP02: new steps ask; a saved step without the value keeps refusing (read from the run's workflow at run time, below).
        default: 'askInChat',
        noDataExpression: true,
        options: [
          { name: 'Ask (the editor’s chat; Needs you when nobody watches)', value: 'askInChat', description: 'A tool that needs approval waits for a person: in the editor’s chat when you run it there, in Needs you when a webhook, schedule or app trigger runs it (the request expires and is then refused)' },
          { name: 'Refuse', value: 'refuse', description: 'Tools that need approval are refused, as before' },
        ],
      },
      {
        name: 'notice',
        displayName:
          // AG17:
          'Runs the agent: its model, memory, tools and knowledge are the bubbles under this node. A model, memory or tool wired here is moved into the agent’s draft when the flow is opened (or at the host’s start); what can’t move stays and runs in this flow only. Tools that require approval are refused in workflow runs (nobody is there to approve them), unless Tool Approvals asks in the editor’s chat and you run the flow from its Chat (then the run waits for your Approve; with a model or tools still wired here it refuses). A run nobody watches (a webhook, a schedule, an app trigger) with Tool Approvals on Ask waits in Needs you for a person to approve or deny each call (and the call is refused if nobody does in time), while a step set to Refuse, a flow with a model or tools wired here, an MCP call or the hosted chat refuses it; Spotlight’s fix sessions approve their own test runs. Runs in the editor use the agent’s draft, which already holds what moved; a published workflow runs the agent’s published version, so what moved keeps running here until you publish the agent.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    // Loaded lazily: the agents runtime imports the runner, which needs the registry this plugin is part of.
    const { agentStore } = await import('../agents/store');
    const { newSession, runAgent } = await import('../agents/runtime');
    const { agentVersionConfig, agentVersionExists, fallbackPin, recordRunAgent } = await import('../agents/versions'); // AG21:
    const { configOf } = await import('../agents/store');
    const connection = ctx.getInputConnectionData;
    const [model] = connection ? await connection<LanguageModel>('ai_languageModel') : [];
    const [memory] = connection ? await connection<AgentMemory>('ai_memory') : [];
    const tools = connection ? await connection<AgentTool>('ai_tool') : [];
    // AG14: what each wired tool reaches (its sub-node's credential and host), for the via line.
    const flowTargets = await toolTargets(ctx, tools);
    // AG17: what the flow's own wiring moved into the agent's draft and the config this run uses does not have yet (production copies are pinned and never overlaid).
    const moved = async (agent: Agent) => {
      const { pendingFor } = await import('../agents/flow-moves');
      const { configOf } = await import('../agents/store');
      const node = ctx.getNode();
      const wired = new Set<string>(tools.flatMap((t) => (t.nodeId ? [t.nodeId] : [])));
      if (model) wired.add('$model');
      return pendingFor(ctx.getWorkflowId() ?? '', node.id, agent, { pinned: ctx.getNodeParameter<string | undefined>(PIN_PARAM, 0, undefined), wired, config: configOf(agent.published?.config ?? agent) });
    };
    const send = ctx.sendChunk;
    const items = ctx.getInputData();
    // AG10: back from a wait for the person's Approve in the editor's chat (WaitRequest.rerun): the items done, and the session to go on with.
    const saved = ctx.getNodeState?.() as { waiting?: { kind: 'approval'; itemIndex: number; sessionId: string; agentId: string; out: NodeItem[]; inbox?: { ids: Record<string, string>; expiresAt: string; minutes: number } /* AP02: */ }; $resume?: { kind: string; data?: JsonObject } } | undefined;
    ctx.setNodeState?.(undefined);
    const waited = saved?.waiting && saved.$resume ? saved.waiting : undefined;
    const out: NodeItem[] = waited ? [...waited.out] : [];
    const savedWithoutApprovals = await savedWithout(ctx, ctx.getNode().id, 'toolApprovals'); // AP02: once per run, not per item
    // Wave ap1: a run the hosted chat or an MCP trigger started (or one of theirs called) refuses whatever the execution mode says, as the publish line says.
    const triggerWhy = isEditorRun(ctx.getMode(), Boolean(ctx.putExecutionToWait)) ? undefined : await triggerRefusal(ctx.getExecutionId());
    for (let i = waited?.itemIndex ?? 0; i < Math.max(items.length, 1); i++) {
      try {
        const agentId = ctx.getNodeParameter<string>('agentId', i);
        const agent = agentStore.get(agentId);
        // AG21: which agent version this run uses: the pin of the published workflow version, the agent's draft in the editor, else the published one.
        const node = ctx.getNode();
        const editor = isEditorRun(ctx.getMode(), Boolean(ctx.putExecutionToWait));
        const pinParam = ctx.getNodeParameter<unknown>(PIN_PARAM, i, undefined);
        const pin = typeof pinParam === 'number' ? pinParam : editor ? undefined : fallbackPin(ctx.getExecutionId(), node.id, agentId);
        const source = runSource(pin, editor);
        if (source === 'pinned' && (!agent || !agentVersionExists(agentId, pin!)))
          throw new NodeOperationError(`“${agent?.name ?? node.name ?? agentId}” v${pin}, which this version of the workflow runs, no longer exists: publish the workflow again`, { itemIndex: i });
        if (!agent) throw new NodeOperationError('Choose an agent — the selected one was deleted', { itemIndex: i });
        if (source === 'published' && !agent.published) throw new NodeOperationError(`Publish “${agent.name}” first`, { description: 'Workflows run the published version of an agent.', itemIndex: i });
        const runVersion: 'draft' | number = source === 'pinned' ? pin! : source === 'draft' ? 'draft' : agent.published!.version;
        // Re-review: recorded before the input is checked, so a run that fails ("The message is empty") still carries its “workflow vN · agent vM” label.
        recordRunAgent(ctx.getExecutionId(), { nodeId: node.id, agentId: agent.id, version: runVersion, source }); // AG21: both versions of a run
        const runConfig = source === 'draft' ? configOf(agent) : source === 'pinned' ? agentVersionConfig(agentId, pin!)! : agent.published!.config;
        // A message that comes out empty ($fromAI with no argument, as when a roster pick starts the run here) falls back to the chat input.
        const chatInput = items[i]?.json?.chatInput;
        const message = (String(ctx.getNodeParameter('message', i) ?? '').trim() || (typeof chatInput === 'string' ? chatInput.trim() : '')).trim();
        if (!message) throw new NodeOperationError('The message is empty', { itemIndex: i });
        const key = ctx.getNodeParameter<string>('conversation', i) === 'key' ? String(ctx.getNodeParameter('sessionKey', i) ?? '').trim() : '';
        const userId = `workflow:${ctx.getWorkflowId() ?? 'unknown'}`;
        // Links the session to this run and node, so the execution view can show the agent working.
        const execution = { workflowId: ctx.getWorkflowId() ?? 'unknown', executionId: ctx.getExecutionId(), nodeId: node.id, ...(node.name && { nodeName: node.name }) };
        // AG10: only the editor's chat can ask; the hosted chat page, webhooks, schedules and manual runs refuse as before.
        // A model or tools connected here do not go through a decision, so with them the node refuses too.
        // Only a run on the published config takes the overlay: an editor run on the draft (which already holds what moved) or a pinned version runs what it says, so askInChat, the router and the cache behave as they will after publish.
        const pending = source === 'published' ? await moved(agent) : undefined;
        const waitable = Boolean(ctx.putExecutionToWait) && !model && !tools.length && !pending;
        // AG23: an autonomous fix session's editor run (the run body's `approvals: 'spotlight'`, kept on the execution record): Spotlight decides the calls that ask first.
        const spotlightRun = editor && (ctx.getMode() === 'manual' || ctx.getMode() === 'chat') ? await spotlightRunOf(ctx.getExecutionId()) : undefined;
        const spotlight = spotlightRun && {
          by: { kind: 'spotlight' as const, userId: spotlightRun.userId, sessionId: spotlightRun.sessionId },
          given: [...spotlightRun.destinations], // wave ag5 fix pass 2: the agents' own destinations are the client's snapshot from when the session started (in `destinations`), never the draft this session may have edited
          canWait: waitable,
        };
        // AP02: a step saved without Tool Approvals keeps refusing (the descriptor's default is for steps placed from now on).
        const setting = savedWithoutApprovals ? 'refuse' : ctx.getNodeParameter<string>('toolApprovals', i, 'refuse');
        // AP02: a run nobody watches (not the editor's, not an MCP call or a tool call) that can pause waits in the approval inbox, when the host has one.
        const inbox = !editor && !triggerWhy && inboxMode(ctx.getMode()) === 'inbox' && setting === 'askInChat' && waitable ? inboxPort() : undefined;
        const refusedWhy = !editor && setting === 'askInChat' && waitable && triggerWhy ? REFUSE_WHY[triggerWhy] : undefined;
        const askInChat = (setting === 'askInChat' && ctx.getMode() === 'chat' && waitable) || Boolean(spotlight?.canWait) || Boolean(inbox);
        const onEvent = send && streamer(send, i, { id: agent.id, name: agent.name, ...(agent.avatar && { face: agent.avatar as unknown as JsonObject }) });
        let result: Awaited<ReturnType<typeof runAgent>>;
        if (waited && i === waited.itemIndex) {
          // AG10: each decision goes to the session in order; the last one resumes the run.
          const { decide } = await import('../agents/runtime');
          const stored = agentStore.getSession(waited.sessionId);
          const calls = stored?.pending?.calls ?? [];
          // AP02: a wait the inbox holds is settled by the record, not by the resume's word (see inboxDecisions).
          const settled = waited.inbox ? await inboxDecisions(ctx, waited.inbox, saved?.$resume, calls, new Map((stored?.timeline ?? []).flatMap((e) => (e.type === 'tool' ? [[e.callId, e.label] as const] : []))), i) : undefined;
          const decisions = settled?.decisions ?? decisionsOf(saved?.$resume);
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
            if (settled && pendingCall.decision) continue; // AP02: a re-run never decides a call twice
            resumed = await decide(agent, waited.sessionId, pendingCall.callId, decision.approved, { ...(decision.by && { by: decision.by }), ...(waited.inbox && { inbox: true as const }), ...settled?.extra[pendingCall.callId], toolImages: { keep: Number(ctx.getNodeParameter('toolImagesKept', i, 2)) }, ...(onEvent && { onEvent }), ...(ctx.signal && { signal: ctx.signal }) });
          }
          if (!resumed || resumed.status !== 'resumed') throw new NodeOperationError('The approval was not decided for every tool call', { itemIndex: i });
          result = resumed;
        } else {
          let session;
          if (memory) {
            // The connected memory holds the conversation: a new session starts from its history and saves back to it.
            session = newSession(agent, { source: 'workflow', userId, version: runVersion });
            session.messages = await memory.load(key || 'default');
          } else {
            const conversationKey = key ? `${userId}:${key}` : undefined;
            const existing = conversationKey ? agentStore.findConversation(agent.id, conversationKey) : undefined;
            // AG10: a keyed conversation that waits for Approve or Reject takes no new message: the model would be sent an unanswered tool call.
            // N6: a waiting run that was cancelled (or failed, or is gone) leaves nobody to decide: the orphan call is settled as cancelled and the conversation goes on.
            if (existing && (existing.pending || existing.status === 'awaiting_approval') && (await orphaned(existing, (await import('../store')).store))) settleOrphan(existing, agentStore);
            if (existing && (existing.pending || existing.status === 'awaiting_approval')) throw new NodeOperationError(`${agent.name} is waiting for Approve or Reject on its last tool call: decide that first, then send the next message`, { itemIndex: i });
            session = (existing && { ...existing, version: runVersion }) ?? newSession(agent, { source: 'workflow', userId, version: runVersion, ...(conversationKey && { conversationKey }) });
          }
          session.execution = execution;
          send?.({ type: 'begin', itemIndex: i });
          result = await runAgent({
            agent,
            session,
            message,
            // AG10: 'ask' only in the editor's chat with Tool Approvals set to ask there.
            approvals: spotlight ? 'spotlight' : askInChat ? 'ask' : 'deny',
            ...(inbox && { inbox: true as const }), // AP02:
            ...(refusedWhy && { refusedWhy }), // wave ap1: the hosted chat or an MCP trigger
            ...(spotlight && { spotlight }), // AG23:
            toolImages: { keep: Number(ctx.getNodeParameter('toolImagesKept', i, 2)) },
            ...(pending && { moved: pending }), // AG17:
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
            return { id: c.callId, name: c.remote ? subject.tool : (labels.get(c.callId) ?? c.tool), input: (c.review?.params ?? subject.input) as JsonObject /* AP02: masked */ };
          });
          send?.({ type: 'end', itemIndex: i });
          // AP02: a run nobody watches: one inbox request per held call, and the wait ends with the request's expiry.
          if (inbox) {
            const opened = await openInbox(ctx, inbox, { agent, agentVersion: runVersion, session: result.session, labels, itemIndex: i });
            ctx.setNodeState?.({ waiting: { kind: 'approval', itemIndex: i, sessionId: result.session.id, agentId: agent.id, out: out as unknown as JsonObject[], inbox: { ids: opened.ids, expiresAt: opened.expiresAt, minutes: opened.minutes } } as unknown as JsonObject });
            await askForApproval(ctx, i, { ...approvalSettings(ctx, i, 'all'), channel: 'chat', timeoutMinutes: 0 }, calls, { agentApproval: { agent: agent.name }, inbox: { ids: opened.ids, expiresAt: opened.expiresAt } }, `${agent.name} wants to use ${calls.map((c) => c.name).join(', ')}`, opened.expiresAt);
            return [out];
          }
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
        const steps = result.session.timeline.flatMap((e) => (e.type === 'tool' ? [{ tool: e.tool, kind: e.kind, status: e.status, ...(e.error && { error: e.error }), ...(e.decidedLine && { approvedBy: e.decidedLine }) /* AG23: */ }] : []));
        out.push({
          json: {
            reply: result.reply ?? null,
            sessionId: result.session.id,
            agentId: agent.id,
            version: runVersion,
            model: model ? `${model.provider}/${model.model}` : runConfig.model ? `${runConfig.model.provider}/${runConfig.model.model}` : null,
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
            const state = agent.published ? `Published v${agent.published.version} · the editor tests the draft` : 'Not published yet'; // AG21: state
            const home = projectId ? projects.homeProjectId('agent', agent.id) : undefined;
            const from = home && home !== projectId ? projects.getProject(home)?.name : undefined;
            return { name: agent.name, value: agent.id, description: from ? `From ${from} · ${state}` : state };
          });
      },
    },
  },
});

/** AP02: the graph this run uses: its own record's, else the saved version it started with, else the saved workflow. */
async function runGraph(executionId: string, workflowId: string | undefined) {
  const { liveExecution } = await import('../runner');
  const { store } = await import('../store');
  const record = liveExecution(executionId) ?? (await store.loadExecution(executionId));
  const id = workflowId ?? record?.workflowId;
  const versionId = record?.versionId ?? (await import('../agents/versions')).runVersions(executionId, record)?.workflow.versionId;
  const snapshot = record?.workflow ?? (versionId && id ? (await import('../versions')).getVersion(id, versionId)?.workflow : undefined) ?? (id ? store.getWorkflow(id) : undefined);
  return { record, workflow: snapshot, workflowId: id };
}

/**
 * Wave ap1: why a run that is no editor's cannot wait for an approval, whatever its execution mode: the hosted chat page
 * (`core.chatTrigger`, started in mode 'webhook') cannot show one and an MCP call answers its caller at once, also for a
 * workflow such a run called. Read from the run's `triggerType` and its parents'; undefined for every other trigger.
 */
async function triggerRefusal(executionId: string): Promise<RefuseWhy | undefined> {
  const { liveExecution } = await import('../runner');
  const { store } = await import('../store');
  let id: string | undefined = executionId;
  for (let depth = 0; id && depth <= 16; depth++) {
    const record: ExecutionRecord | undefined = liveExecution(id) ?? (await store.loadExecution(id));
    if (!record) return undefined;
    if (record.mode === 'mcp' || record.triggerType === 'core.mcpTrigger') return 'mcp';
    if (record.triggerType === 'core.chatTrigger') return 'hostedChat';
    id = record.parentExecutionId;
  }
  return undefined;
}

/** AP02: whether the run's workflow has no value saved for this parameter of the node (the descriptor's default would apply). False when the graph is not found. */
async function savedWithout(ctx: IExecuteContext, nodeId: string, name: string): Promise<boolean> {
  const { workflow } = await runGraph(ctx.getExecutionId(), ctx.getWorkflowId());
  const saved = workflow?.nodes.find((n) => n.id === nodeId);
  return Boolean(saved) && !(name in (saved!.parameters ?? {}));
}

/** AP02: the time of day a settled line shows, in the host's zone. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** AP02: one request per undecided call in the approval inbox (idempotent: a node that runs again gets the same ids and nudges nobody twice). */
async function openInbox(
  ctx: IExecuteContext,
  port: NonNullable<ReturnType<typeof inboxPort>>,
  run: { agent: Agent; agentVersion: number | 'draft'; session: AgentSession; labels: Map<string, string>; itemIndex: number },
) {
  const { runVersions } = await import('../agents/versions');
  const { unattendedTrigger } = await import('../agents/unattended');
  const { homeProjectId } = await import('../projects/store');
  const executionId = ctx.getExecutionId();
  const { record, workflow, workflowId: graphId } = await runGraph(executionId, ctx.getWorkflowId());
  const workflowId = graphId ?? 'unknown';
  const node = ctx.getNode();
  const trigger = workflow?.nodes.filter((n) => !n.disabled).flatMap((n) => unattendedTrigger(n.type) ?? [])[0] ?? 'trigger';
  const number = (() => {
    try {
      return runVersions(executionId, record)?.workflow.number;
    } catch {
      return undefined;
    }
  })();
  const projectId = homeProjectId('workflow', workflowId);
  const calls: InboxOpen[] = (run.session.pending?.calls ?? []).filter((c) => !c.decision).map((c) => ({
    executionId,
    callId: c.callId,
    workflowId,
    workflowName: workflow?.name ?? workflowId,
    ...(number !== undefined && { workflowVersion: number }),
    nodeId: node.id,
    nodeName: node.name ?? node.id,
    agentId: run.agent.id,
    agentName: run.agent.name,
    agentVersion: run.agentVersion,
    sessionId: run.session.id,
    tool: run.labels.get(c.callId) ?? c.tool,
    params: (c.review?.params ?? maskParams(redactValue(c.input))) as Record<string, unknown>,
    ...(c.review?.destination && { destination: c.review.destination }),
    trigger,
    ...(projectId && { projectId }),
  }));
  return port.open(calls);
}

/**
 * AP02: the decisions of a resumed inbox wait, from the record (the truth), never from the resume's word alone. `approved` and
 * `denied` are the record's; on a timeout a `waiting` record is settled `expired` (and if another door won the race, its word
 * stands); an expired, denied or cancelled call is denied to the agent with the refusal as its result and the settled line as its
 * decidedLine. An approval the record does not say fails closed: the node stops rather than run the call.
 */
async function inboxDecisions(
  ctx: IExecuteContext,
  wait: { ids: Record<string, string>; expiresAt: string; minutes: number },
  resume: { kind: string; data?: JsonObject } | undefined,
  calls: Array<{ callId: string; tool: string; decision?: 'approved' | 'denied'; input: Record<string, unknown> }>,
  labels: Map<string, string>,
  itemIndex: number,
) {
  const port = inboxPort();
  if (!port) throw new NodeOperationError('This host has no approval inbox, so this approval cannot be settled', { itemIndex });
  const decisions: ReturnType<typeof decisionsOf> = {};
  const extra: Record<string, { line: string; refusal?: string }> = {};
  const executionId = ctx.getExecutionId();
  for (const call of calls) {
    if (call.decision) continue;
    let outcome = port.outcome(executionId, call.callId);
    if (outcome?.status === 'waiting' || !outcome) {
      if (resume?.kind === 'timeout' || !outcome) outcome = (await port.settle(executionId, call.callId, 'expired')).outcome;
      // A deny the record does not say fails closed too (AP01's claim settles the record first); the throw leaves the request waiting.
      else throw new NodeOperationError('The approval inbox has no decision for this tool call', { itemIndex });
    }
    const label = labels.get(call.callId) ?? call.tool;
    const view = { status: outcome.status, tool: label, ...(outcome.byName && { decidedByName: outcome.byName }), ...(outcome.by && { decidedBy: outcome.by }), ...(outcome.via && { decidedVia: outcome.via }), ...(outcome.at && { decidedAt: outcome.at }) };
    const line = settledLine(view, clock);
    if (outcome.status === 'approved') {
      decisions[call.callId] = { approved: true, ...(outcome.by && { by: outcome.by }), }; // an edited input is never carried: the inbox approved the review as shown (the doors are Approve and Deny)
      extra[call.callId] = { line };
    } else if (outcome.status === 'waiting') throw new NodeOperationError('The approval inbox has no decision for this tool call', { itemIndex });
    else {
      decisions[call.callId] = { approved: false, ...(outcome.by && { by: outcome.by }) };
      extra[call.callId] = { line, refusal: refusedResult(outcome.status, label, outcome.byName ?? outcome.by, wait.minutes) };
    }
  }
  return { decisions, extra };
}

/** AG23: the Spotlight test run this execution belongs to, if any (kept on its record by the run route; it survives a wait). */
async function spotlightRunOf(executionId: string) {
  const { liveExecution } = await import('../runner');
  return (liveExecution(executionId) ?? (await (await import('../store')).store.loadExecution(executionId)))?.spotlightApprovals;
}

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
