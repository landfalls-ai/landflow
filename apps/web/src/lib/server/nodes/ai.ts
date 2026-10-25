import vm from 'node:vm';
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import { toToolName, type AgentMemory, type AgentMessage, type AgentTool, type LanguageModel, type ToolResult } from '@landflow/engine';
import { anthropicModel, ollamaModel } from './models';

const main = [{ type: 'main' as const }];
/** Default Ollama address for new model nodes (OLLAMA_URL, e.g. host.docker.internal in a container). */
const DEFAULT_OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// AI Agent (root node)
// ---------------------------------------------------------------------------

export const aiAgentNode = defineNode({
  description: {
    name: 'aiAgent',
    displayName: 'AI Agent',
    description: 'A tool-using agent: plans, calls the attached tools, and answers',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:bot',
    color: '#a855f7',
    keywords: ['llm', 'claude', 'agent', 'tools', 'chat'],
    inputs: [
      { type: 'main' },
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
    ],
    outputs: main,
    properties: [
      {
        name: 'prompt',
        displayName: 'Prompt (User Message)',
        type: 'string',
        default: '{{ $json.chatInput }}',
        typeOptions: { rows: 3 },
        description: 'Defaults to the chat trigger’s message',
      },
      {
        name: 'systemMessage',
        displayName: 'System Message',
        type: 'string',
        default: 'You are a helpful assistant inside a Landflow workflow. Use the available tools when they help, and answer concisely.',
        typeOptions: { rows: 4 },
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'maxIterations', displayName: 'Max Iterations', type: 'number', default: 8, typeOptions: { minValue: 1, maxValue: 30 } },
          { name: 'sessionId', displayName: 'Session Key', type: 'string', default: '{{ $json.sessionId }}', description: 'Memory is kept per session key' },
          { name: 'returnIntermediateSteps', displayName: 'Return Intermediate Steps', type: 'boolean', default: true },
        ],
      },
    ],
  },
  async execute(ctx) {
    const connection = ctx.getInputConnectionData;
    if (!connection) throw new NodeOperationError('The AI Agent must run in-process');
    const [model] = await connection<LanguageModel>('ai_languageModel');
    if (!model) {
      throw new NodeOperationError('No chat model connected', { description: 'Attach a chat model (Anthropic, Ollama or OpenAI) to the “Chat Model” slot.' });
    }
    const [memory] = await connection<AgentMemory>('ai_memory');
    const tools = dedupe(await connection<AgentTool>('ai_tool'));
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const out: NodeItem[] = [];
    for (const [i] of ctx.getInputData().entries()) {
      const prompt = String(ctx.getNodeParameter('prompt', i) ?? '').trim();
      if (!prompt) throw new NodeOperationError('The prompt is empty', { itemIndex: i, description: 'Send a chat message or set “Prompt”.' });
      const options = ctx.getNodeParameter<{ maxIterations?: number; sessionId?: string; returnIntermediateSteps?: boolean }>('options', i) ?? {};
      const sessionId = options.sessionId || 'default';
      const maxIterations = Math.min(30, Math.max(1, Number(options.maxIterations ?? 8)));
      const system = String(ctx.getNodeParameter('systemMessage', i) ?? '');

      const history = memory ? await memory.load(sessionId) : [];
      const messages: AgentMessage[] = [...history, { role: 'user', content: prompt }];
      const steps: Array<{ tool: string; input: unknown; output: unknown; isError?: boolean }> = [];
      let answer: string | undefined;
      let iterations = 0;
      const usage = { inputTokens: 0, outputTokens: 0 };

      while (iterations < maxIterations) {
        iterations++;
        const turn = await model.generate({ system, messages, tools });
        usage.inputTokens += turn.usage?.inputTokens ?? 0;
        usage.outputTokens += turn.usage?.outputTokens ?? 0;
        messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, ...(turn.raw && { raw: turn.raw }) });
        if (!turn.toolCalls.length) {
          answer = turn.text;
          break;
        }
        // Run the turn's tool calls concurrently; all results go back in one message.
        const results = await Promise.all(
          turn.toolCalls.map(async (call): Promise<ToolResult> => {
            const tool = byName.get(call.name);
            if (!tool) return { id: call.id, name: call.name, content: `Unknown tool "${call.name}"`, isError: true };
            try {
              const output = await tool.invoke(call.input);
              steps.push({ tool: call.name, input: call.input, output });
              return { id: call.id, name: call.name, content: typeof output === 'string' ? output : JSON.stringify(output) };
            } catch (error) {
              const message = (error as Error).message;
              steps.push({ tool: call.name, input: call.input, output: message, isError: true });
              ctx.logger.warn(`tool ${call.name} failed: ${message}`);
              return { id: call.id, name: call.name, content: `Error: ${message}`, isError: true };
            }
          }),
        );
        messages.push({ role: 'tool', results });
      }

      if (answer === undefined) answer = `Stopped after ${maxIterations} iterations without a final answer.`;
      if (memory) await memory.save(sessionId, messages);
      ctx.logger.info(`${model.provider}/${model.model}: ${iterations} iteration(s), ${steps.length} tool call(s)`);
      out.push({
        json: {
          output: answer,
          sessionId,
          model: `${model.provider}/${model.model}`,
          iterations,
          usage,
          ...(options.returnIntermediateSteps !== false ? { steps: steps as never } : {}),
        } as unknown as JsonObject,
        pairedItem: { item: i },
      });
    }
    return [out];
  },
});

function dedupe(tools: AgentTool[]): AgentTool[] {
  const seen = new Map<string, number>();
  return tools.map((tool) => {
    const count = seen.get(tool.name) ?? 0;
    seen.set(tool.name, count + 1);
    return count ? { ...tool, name: `${tool.name}_${count + 1}` } : tool;
  });
}

// ---------------------------------------------------------------------------
// Chat models (sub-nodes)
// ---------------------------------------------------------------------------

const modelOutput = [{ type: 'ai_languageModel' as const, displayName: 'Model' }];

export const anthropicChatModelNode = defineNode({
  description: {
    name: 'anthropicChatModel',
    displayName: 'Anthropic Chat Model',
    description: 'Claude models for the AI Agent (an Anthropic credential, else ANTHROPIC_API_KEY or an `ant` profile)',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_languageModel',
    categories: ['AI', 'Models'],
    icon: 'lucide:sparkles',
    color: '#d97757',
    subtitle: '{{model}}',
    credentials: [{ name: 'anthropicApi', required: false }],
    inputs: [],
    outputs: modelOutput,
    properties: [
      {
        name: 'model',
        displayName: 'Model',
        type: 'options',
        default: 'claude-opus-5-5',
        options: [
          { name: 'Claude Opus 5.5', value: 'claude-opus-5-5', description: 'Default — best for agentic work' },
          { name: 'Claude Sonnet 5.5', value: 'claude-sonnet-5-5', description: 'Faster, lower cost' },
          { name: 'Claude Haiku 5.5', value: 'claude-haiku-5-5', description: 'Fastest, cheapest' },
          { name: 'Claude Fable 5.1', value: 'claude-fable-5-1', description: 'Most capable' },
        ],
      },
      {
        name: 'effort',
        displayName: 'Effort',
        type: 'options',
        default: 'medium',
        options: ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ name: e, value: e })),
        description: 'Thinking depth and token spend',
      },
      { name: 'maxTokens', displayName: 'Max Tokens', type: 'number', default: 16000, typeOptions: { minValue: 256, maxValue: 64000 } },
      {
        name: 'fallback',
        displayName: 'Server-side Refusal Fallback',
        type: 'boolean',
        default: true,
        description: 'Retry declined requests on Anthropic’s recommended fallback model',
      },
    ],
  },
  supplyData(ctx) {
    // Optional: without a selected credential the SDK finds ANTHROPIC_API_KEY or an `ant` profile.
    const credential = ctx.getCredentials('anthropicApi', { optional: true });
    const apiKey = typeof credential?.apiKey === 'string' ? credential.apiKey.trim() : '';
    const baseUrl = typeof credential?.baseUrl === 'string' ? credential.baseUrl.trim() : '';
    return anthropicModel({
      model: ctx.getNodeParameter<string>('model'),
      effort: ctx.getNodeParameter('effort'),
      maxTokens: Number(ctx.getNodeParameter('maxTokens')),
      fallback: ctx.getNodeParameter<boolean>('fallback'),
      ...(apiKey && { apiKey, ...(baseUrl && { baseUrl }) }),
    });
  },
});

export const ollamaChatModelNode = defineNode({
  description: {
    name: 'ollamaChatModel',
    displayName: 'Ollama Chat Model',
    description: 'Local models served by Ollama (must support tool calling)',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_languageModel',
    categories: ['AI', 'Models'],
    icon: 'lucide:cpu',
    color: '#71717a',
    subtitle: '{{model}}',
    inputs: [],
    outputs: modelOutput,
    properties: [
      { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: DEFAULT_OLLAMA_URL },
      {
        name: 'model',
        displayName: 'Model',
        type: 'options',
        default: 'qwen3-coder:30b',
        options: [{ name: 'qwen3-coder:30b', value: 'qwen3-coder:30b' }],
        typeOptions: { loadOptionsMethod: 'models', loadOptionsDependsOn: ['baseUrl'] },
      },
      { name: 'temperature', displayName: 'Temperature', type: 'number', default: 0.2, typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 } },
    ],
  },
  supplyData: (ctx) =>
    ollamaModel({
      baseUrl: ctx.getNodeParameter<string>('baseUrl'),
      model: ctx.getNodeParameter<string>('model'),
      temperature: Number(ctx.getNodeParameter('temperature')),
    }),
  methods: {
    loadOptions: {
      async models(ctx) {
        const base = String(ctx.getCurrentParameters().baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
        const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
        const data = (await response.json()) as { models: Array<{ name: string; details?: { parameter_size?: string }; capabilities?: string[] }> };
        return data.models
          .filter((m) => !m.capabilities || m.capabilities.includes('completion'))
          .map((m) => ({
            name: m.name,
            value: m.name,
            description: [m.details?.parameter_size, m.capabilities?.includes('tools') ? 'tools ✓' : 'no tool support'].filter(Boolean).join(' · '),
          }));
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Memory & tools (sub-nodes)
// ---------------------------------------------------------------------------

const memoryStore = ((globalThis as { __landflowMemory?: Map<string, AgentMessage[]> }).__landflowMemory ??= new Map());

export const simpleMemoryNode = defineNode({
  description: {
    name: 'simpleMemory',
    displayName: 'Simple Memory',
    description: 'Remember the conversation per session (in the server’s memory)',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_memory',
    categories: ['AI', 'Memory'],
    icon: 'lucide:brain',
    color: '#c084fc',
    subtitle: 'last {{turns}} turns',
    inputs: [],
    outputs: [{ type: 'ai_memory', displayName: 'Memory' }],
    properties: [{ name: 'turns', displayName: 'Turns to Keep', type: 'number', default: 10, typeOptions: { minValue: 1, maxValue: 100 } }],
  },
  supplyData(ctx): AgentMemory {
    const prefix = `${ctx.getWorkflowId() ?? 'wf'}:${ctx.getNode().id}:`;
    const turns = Number(ctx.getNodeParameter('turns'));
    return {
      async load(sessionId) {
        return structuredClone(memoryStore.get(prefix + sessionId) ?? []);
      },
      async save(sessionId, messages) {
        // Keep whole turns: cut only at user prompts so tool calls/results stay paired.
        const starts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
        const from = starts.length > turns ? starts[starts.length - turns] : 0;
        memoryStore.set(prefix + sessionId, structuredClone(messages.slice(from)));
      },
    };
  },
});

const MATH_NAMES = new Set(Object.getOwnPropertyNames(Math).concat(['pi', 'e']));

export const calculatorToolNode = defineNode({
  description: {
    name: 'calculatorTool',
    displayName: 'Calculator',
    description: 'Lets the agent evaluate arithmetic exactly',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_tool',
    categories: ['AI', 'Tools'],
    icon: 'lucide:calculator',
    color: '#f472b6',
    inputs: [],
    outputs: [{ type: 'ai_tool', displayName: 'Tool' }],
    properties: [],
  },
  supplyData(ctx): AgentTool {
    return {
      name: toToolName(ctx.getNode().name),
      description: 'Evaluate a math expression, e.g. "(12.5 * 4) / 3" or "sqrt(2) * pow(3, 4)". Math functions are available without the Math. prefix.',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'The expression to evaluate' } },
        required: ['expression'],
      },
      async invoke(input) {
        const expression = String(input.expression ?? '');
        const identifiers = expression.match(/[a-zA-Z_]+/g) ?? [];
        const unknown = identifiers.filter((id) => !MATH_NAMES.has(id));
        if (unknown.length || /[^\d\s+\-*/%().,a-zA-Z_^]/.test(expression)) {
          throw new Error(`Unsupported expression: ${unknown.join(', ') || expression}`);
        }
        const scope = Object.fromEntries([...MATH_NAMES].map((name) => [name, (Math as never)[name] ?? (name === 'pi' ? Math.PI : Math.E)]));
        const result = vm.runInNewContext(expression.replace(/\^/g, '**'), scope, { timeout: 100 });
        return { expression, result: Number(result) };
      },
    };
  },
});
