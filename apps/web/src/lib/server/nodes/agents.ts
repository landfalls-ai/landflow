/**
 * Nodes that connect workflows and Agents (docs/agents.md): a trigger that makes a workflow
 * callable by an agent (as a tool) or by another workflow (Execute Workflow, in workflows.ts),
 * and an action that sends a message to a published agent.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';

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
    displayName: 'Message an Agent',
    description: 'Send a message to a published agent and get its reply',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:bot-message-square',
    color: '#a855f7',
    subtitle: '{{agentId}}',
    keywords: ['agent', 'assistant', 'delegate', 'ask'],
    usableAsTool: true,
    toolDescription: 'Ask another agent to do something. Argument: `message` (the full task, the agent does not see this conversation).',
    inputs: main,
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
          { name: 'New session per item', value: 'new', description: 'Every message starts fresh' },
          { name: 'Continue by key', value: 'key', description: 'Messages with the same key share a session (session memory)' },
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
        displayName: 'Tools that require approval are refused in workflow runs (nobody is there to approve them).',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    // Loaded lazily: the agents runtime imports the runner, which needs the registry this plugin is part of.
    const { agentStore } = await import('../agents/store');
    const { newSession, runAgent } = await import('../agents/runtime');
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
        const conversationKey = key ? `workflow:${ctx.getWorkflowId() ?? 'unknown'}:${key}` : undefined;
        const existing = conversationKey ? agentStore.findConversation(agent.id, conversationKey) : undefined;
        const session =
          (existing && { ...existing, version: agent.published.version }) ??
          newSession(agent, { source: 'workflow', userId: `workflow:${ctx.getWorkflowId() ?? 'unknown'}`, version: agent.published.version, ...(conversationKey && { conversationKey }) });
        const result = await runAgent({ agent, session, message, approvals: 'deny' });
        if (result.reason === 'error') {
          const last = [...result.session.timeline].reverse().find((e) => e.type === 'error');
          throw new NodeOperationError(`${agent.name} failed: ${last?.type === 'error' ? last.message : 'unknown error'}`, { itemIndex: i });
        }
        out.push({
          json: { reply: result.reply ?? null, sessionId: result.session.id, agentId: agent.id, version: agent.published.version, endReason: result.reason, usage: { ...result.usage } },
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
