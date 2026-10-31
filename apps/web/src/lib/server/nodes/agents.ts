/**
 * Nodes that connect workflows and Agents (docs/agents.md): a trigger that makes a workflow
 * callable by an agent (as a tool) or by another workflow (Execute Workflow, in workflows.ts),
 * and Run an Agent, which runs a published agent as a step of the flow with the chat model,
 * memory and tools connected to it.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { AgentMemory, AgentTool, LanguageModel } from '@landflow/engine';
import type { AgentStreamEvent } from '../../shared/agents';

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
    toolDescription: 'Ask another agent to do something. Argument: `message` (the full task, the agent does not see this conversation).',
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
        name: 'notice',
        displayName:
          'Connect a chat model to use it instead of the agent’s own, tools (a vector store in Retrieve Documents (As Tool) mode is a knowledge base) to add to its capabilities for this run, and a memory to keep the conversation in. Tools that require approval are refused in workflow runs (nobody is there to approve them).',
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
    const send = ctx.sendChunk;
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      try {
        const agentId = ctx.getNodeParameter<string>('agentId', i);
        const agent = agentStore.get(agentId);
        if (!agent) throw new NodeOperationError('Choose an agent — the selected one was deleted', { itemIndex: i });
        if (!agent.published) throw new NodeOperationError(`Publish “${agent.name}” first`, { description: 'Workflows run the published version of an agent.', itemIndex: i });
        const message = String(ctx.getNodeParameter('message', i) ?? '').trim();
        if (!message) throw new NodeOperationError('The message is empty', { itemIndex: i });
        const key = ctx.getNodeParameter<string>('conversation', i) === 'key' ? String(ctx.getNodeParameter('sessionKey', i) ?? '').trim() : '';
        const userId = `workflow:${ctx.getWorkflowId() ?? 'unknown'}`;
        // Links the session to this run and node, so the execution view can show the agent working.
        const node = ctx.getNode();
        const execution = { workflowId: ctx.getWorkflowId() ?? 'unknown', executionId: ctx.getExecutionId(), nodeId: node.id, ...(node.name && { nodeName: node.name }) };
        let session;
        if (memory) {
          // The connected memory holds the conversation: a new session starts from its history and saves back to it.
          session = newSession(agent, { source: 'workflow', userId, version: agent.published.version });
          session.messages = await memory.load(key || 'default');
        } else {
          const conversationKey = key ? `${userId}:${key}` : undefined;
          const existing = conversationKey ? agentStore.findConversation(agent.id, conversationKey) : undefined;
          session = (existing && { ...existing, version: agent.published.version }) ?? newSession(agent, { source: 'workflow', userId, version: agent.published.version, ...(conversationKey && { conversationKey }) });
        }
        session.execution = execution;
        send?.({ type: 'begin', itemIndex: i });
        const result = await runAgent({
          agent,
          session,
          message,
          approvals: 'deny',
          ...((model || tools.length) && { flow: { ...(model && { model }), ...(tools.length && { tools }) } }),
          // The chat panel and streaming triggers get the agent's answers and tool calls as they happen.
          ...(send && { onEvent: streamer(send, i) }),
        });
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
        return agentStore.list().map((agent) => ({
          name: agent.name,
          value: agent.id,
          description: agent.published ? `Published v${agent.published.version}` : 'Not published yet',
        }));
      },
    },
  },
});

/** An agent's timeline as the chat chunks of the AI Agent node: its answers, and its tool calls as they start and end. */
export function streamer(send: NonNullable<IExecuteContext['sendChunk']>, itemIndex: number) {
  let wrote = false;
  return (event: AgentStreamEvent) => {
    if (event.type !== 'entry') return;
    const { entry } = event;
    if (entry.type === 'assistant' && entry.text.trim()) {
      send({ type: 'item', itemIndex, content: `${wrote ? '\n\n' : ''}${entry.text}` });
      wrote = true;
    } else if (entry.type === 'tool') {
      const status = entry.status === 'running' ? 'started' : entry.status === 'success' ? 'finished' : 'failed';
      const output = entry.error ?? (entry.output === undefined ? undefined : typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output));
      send({ type: 'tool', itemIndex, tool: { id: entry.callId, name: entry.tool, status, input: entry.input as JsonObject, ...(output !== undefined && { output: output.slice(0, 2_000) }) } });
    }
  };
}
