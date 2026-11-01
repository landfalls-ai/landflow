import vm from 'node:vm';
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { toToolName, type AgentMemory, type AgentMessage, type AgentTool, type ToolCall, type ToolResult } from '@landflow/engine';
import { credentialIdOf } from '../ai-usage/credential-id';
import { parseAddresses, sendApprovalEmails } from '../approval-email';
import { mailConfigured } from '../auth/mail';
import { approvalBlocks, postMessage, SLACK_CREDENTIAL, SLACK_OAUTH2_CREDENTIAL, slackCredential } from '../slack';
import { BINARY_INPUT_OPTIONS, MEMORY_FILE_OPTIONS, optionalAttachments, reattachRemembered, withoutAttachmentData, type MediaOptions } from './attachments';
import { connectedModel, FALLBACK_PORT, FALLBACK_PROPERTY, isFallbackModel } from './fallback';
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
      FALLBACK_PORT,
      { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
    ],
    outputs: main,
    // Posting approval requests to Slack (the messaging plugin's credential: a bot token or the OAuth2 install).
    credentials: [
      { name: SLACK_CREDENTIAL, required: true, displayOptions: { show: { approvalChannel: ['slack'], slackAuthentication: ['accessToken'] } } },
      { name: SLACK_OAUTH2_CREDENTIAL, required: true, displayOptions: { show: { approvalChannel: ['slack'], slackAuthentication: ['oAuth2'] } } },
      // Transcribing audio input (“Include Binary as Input”): an OpenAI-compatible /audio/transcriptions endpoint.
      { name: 'openAiApi', required: false },
    ],
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
      FALLBACK_PROPERTY,
      {
        name: 'requireApproval',
        displayName: 'Tools Requiring Approval',
        type: 'options',
        default: 'none',
        noDataExpression: true,
        options: [
          { name: 'None', value: 'none' },
          { name: 'All Tools', value: 'all', description: 'Every tool call waits for a person' },
          { name: 'Selected Tools', value: 'selected' },
        ],
        description: 'The execution waits until a person approves or rejects the call, in the chat panel or in Slack',
      },
      {
        name: 'approvalTools',
        displayName: 'Tool Names',
        type: 'string',
        default: '',
        placeholder: 'e.g. Send Email, Delete Row',
        description: 'Names of the tool nodes that need approval, comma-separated',
        displayOptions: { show: { requireApproval: ['selected'] } },
      },
      {
        name: 'approvalChannel',
        displayName: 'Ask In',
        type: 'options',
        default: 'chat',
        noDataExpression: true,
        options: [
          { name: 'Chat / Execution View', value: 'chat', description: 'Approve or Reject buttons in the editor’s chat panel and the waiting execution' },
          { name: 'Slack', value: 'slack', description: 'A message with Approve and Reject buttons (needs the app’s Interactivity URL)' },
          { name: 'Email', value: 'email', description: 'An email with signed, single-use Approve and Reject links (the host’s SMTP, LANDFLOW_SMTP_HOST)' },
        ],
        displayOptions: { hide: { requireApproval: ['none'] } },
      },
      {
        name: 'slackAuthentication',
        displayName: 'Slack Authentication',
        type: 'options',
        default: 'accessToken',
        noDataExpression: true,
        options: [
          { name: 'Bot Token', value: 'accessToken' },
          { name: 'OAuth2 (Installed App)', value: 'oAuth2' },
        ],
        displayOptions: { show: { approvalChannel: ['slack'] }, hide: { requireApproval: ['none'] } },
      },
      {
        name: 'approvalEmails',
        displayName: 'Approver Emails',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'ana@example.com, ben@example.com',
        description: 'Each address gets one email per waiting tool call with its own Approve and Reject links; the first decision counts.',
        displayOptions: { show: { approvalChannel: ['email'] }, hide: { requireApproval: ['none'] } },
      },
      {
        name: 'slackChannel',
        displayName: 'Slack Channel',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'C0123456789',
        description: 'Channel ID (or a member ID for a DM) to post approval requests in',
        displayOptions: { show: { approvalChannel: ['slack'] }, hide: { requireApproval: ['none'] } },
      },
      {
        name: 'slackApprovers',
        displayName: 'Approvers',
        type: 'string',
        default: '',
        placeholder: 'U0123ABCD, U0456EFGH',
        description: 'Slack member IDs allowed to decide, comma-separated. Empty: anyone who can see the message.',
        displayOptions: { show: { approvalChannel: ['slack'] }, hide: { requireApproval: ['none'] } },
      },
      {
        name: 'approvalTimeoutMinutes',
        displayName: 'Approval Timeout (Minutes)',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        description: 'Reject the waiting calls after this long. 0: wait until someone decides.',
        displayOptions: { hide: { requireApproval: ['none'] } },
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
          ...BINARY_INPUT_OPTIONS,
          ...MEMORY_FILE_OPTIONS,
        ],
      },
    ],
  },
  async execute(ctx) {
    const connection = ctx.getInputConnectionData;
    if (!connection) throw new NodeOperationError('The AI Agent must run in-process');
    const model = await connectedModel(ctx, 'AI Agent');
    const [memory] = await connection<AgentMemory>('ai_memory');
    const tools = dedupe(await connection<AgentTool>('ai_tool'));
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // Back after a tool approval (WaitRequest.rerun): the loop continues where it stopped.
    const saved = ctx.getNodeState?.() as AgentNodeState | undefined;
    ctx.setNodeState?.(undefined);
    const progress = saved?.progress;
    const resume = saved?.$resume;
    const out: NodeItem[] = progress?.out ?? [];
    const send = ctx.sendChunk;

    for (let i = progress?.item ?? 0; i < ctx.getInputData().length; i++) {
      const prompt = String(ctx.getNodeParameter('prompt', i) ?? '').trim();
      const options = ctx.getNodeParameter<AgentOptions>('options', i) ?? {};
      const maxIterations = Math.min(30, Math.max(1, Number(options.maxIterations ?? 8)));
      const system = String(ctx.getNodeParameter('systemMessage', i) ?? '');
      const approval = approvalSettings(ctx, i);
      const continuing = progress && progress.item === i ? progress : undefined;

      let run: ItemRun;
      if (continuing) {
        run = { messages: continuing.messages, steps: continuing.steps, iterations: continuing.iterations, usage: continuing.usage, sessionId: continuing.sessionId, historyLength: continuing.historyLength };
      } else {
        if (!prompt) throw new NodeOperationError('The prompt is empty', { itemIndex: i, description: 'Send a chat message or set “Prompt”.' });
        const sessionId = options.sessionId || 'default';
        const history = memory ? await memory.load(sessionId) : [];
        // Memory keeps references to earlier turns' files; the option attaches them again (newest first, up to a size cap).
        const remembered =
          options.passthroughBinaryImages && options.rememberedAttachments
            ? await reattachRemembered(ctx, history, { maxBytes: Math.max(1, Number(options.rememberedAttachmentsMaxMb) || 10) * 1024 * 1024, model, ...options }, i)
            : history;
        const attachments = await optionalAttachments(ctx, i, options, model);
        run = {
          messages: [...remembered, { role: 'user', content: prompt, ...(attachments && { attachments }) }],
          steps: [],
          iterations: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          sessionId,
          historyLength: history.length,
        };
      }
      send?.({ type: 'begin', itemIndex: i });
      /** Some text went out; after tool calls, the next turn's text starts a new paragraph. */
      let streamedText = false;
      let newParagraph = false;

      const invoke = async (call: ToolCall): Promise<ToolResult> => {
        const tool = byName.get(call.name);
        if (!tool) return { id: call.id, name: call.name, content: `Unknown tool "${call.name}"`, isError: true };
        send?.({ type: 'tool', itemIndex: i, tool: { id: call.id, name: call.name, status: 'started', input: call.input as JsonObject } });
        try {
          const output = await tool.invoke(call.input);
          run.steps.push({ tool: call.name, input: call.input, output });
          const content = typeof output === 'string' ? output : JSON.stringify(output);
          send?.({ type: 'tool', itemIndex: i, tool: { id: call.id, name: call.name, status: 'finished', output: content.slice(0, 2_000) } });
          return { id: call.id, name: call.name, content };
        } catch (error) {
          const message = (error as Error).message;
          run.steps.push({ tool: call.name, input: call.input, output: message, isError: true });
          ctx.logger.warn(`tool ${call.name} failed: ${message}`);
          send?.({ type: 'tool', itemIndex: i, tool: { id: call.id, name: call.name, status: 'failed', output: message.slice(0, 2_000) } });
          return { id: call.id, name: call.name, content: `Error: ${message}`, isError: true };
        }
      };

      // Settle the calls that waited: run what was approved, refuse the rest, hand the whole turn's results back.
      if (continuing) {
        const decisions = decisionsOf(resume);
        const settled = await Promise.all(
          continuing.pending.calls.map(async (call): Promise<ToolResult> => {
            const decision = decisions[call.id];
            if (decision?.approved) return invoke(call);
            const reason = decision ? `rejected${decision.by ? ` by ${decision.by}` : ''}` : resume?.kind === 'timeout' ? 'not approved in time' : 'not approved';
            run.steps.push({ tool: call.name, input: call.input, output: `Not run: ${reason}`, isError: true });
            send?.({ type: 'tool', itemIndex: i, tool: { id: call.id, name: call.name, status: 'failed', output: `Not run: ${reason}` } });
            const content = decision ? `A person rejected this call to ${call.name}; it did not run.` : `This call to ${call.name} was ${reason}; it did not run.`;
            return { id: call.id, name: call.name, content: `${content} Don't retry it now: tell the user.`, isError: true };
          }),
        );
        const order = continuing.pending.calls.map((c) => c.id);
        const results = [...continuing.pending.results, ...settled];
        const turnOrder = lastToolCallIds(run.messages);
        run.messages.push({ role: 'tool', results: results.sort((a, b) => (turnOrder.indexOf(a.id) >= 0 ? turnOrder.indexOf(a.id) : order.indexOf(a.id)) - (turnOrder.indexOf(b.id) >= 0 ? turnOrder.indexOf(b.id) : order.indexOf(b.id))) });
      }

      let answer: string | undefined;
      while (run.iterations < maxIterations) {
        run.iterations++;
        const onToken = send
          ? (delta: string) => {
              if (newParagraph) send({ type: 'item', itemIndex: i, content: '\n\n' });
              newParagraph = false;
              streamedText = true;
              send({ type: 'item', itemIndex: i, content: delta });
            }
          : undefined;
        const turn = await model.generate({ system, messages: run.messages, tools, ...(onToken && { onToken }) });
        run.usage.inputTokens += turn.usage?.inputTokens ?? 0;
        run.usage.outputTokens += turn.usage?.outputTokens ?? 0;
        run.messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, ...(turn.raw && { raw: turn.raw }) });
        if (!turn.toolCalls.length) {
          answer = turn.text;
          break;
        }
        const waiting = turn.toolCalls.filter((call) => byName.has(call.name) && approval.needs(call.name));
        const runnable = turn.toolCalls.filter((call) => !waiting.includes(call));
        // Run the turn's tool calls concurrently; all results go back in one message.
        const results = await Promise.all(runnable.map(invoke));
        if (waiting.length) {
          await askForApproval(ctx, i, approval, waiting);
          for (const call of waiting) send?.({ type: 'tool', itemIndex: i, tool: { id: call.id, name: call.name, status: 'approval', input: call.input as JsonObject } });
          send?.({ type: 'end', itemIndex: i });
          ctx.setNodeState?.({
            progress: { item: i, out, ...run, pending: { calls: waiting, results } },
          } as unknown as JsonObject);
          return [[]];
        }
        messagesPushTool(run.messages, results, turn.toolCalls);
        newParagraph = streamedText;
      }

      if (answer === undefined) answer = `Stopped after ${maxIterations} iterations without a final answer.`;
      send?.({ type: 'end', itemIndex: i });
      // Memory keeps the files' names and references, not their bytes.
      if (memory) await memory.save(run.sessionId, run.messages.map((m) => (m.role === 'user' ? withoutAttachmentData(m) : m)));
      const used = isFallbackModel(model) ? model.lastModel : `${model.provider}/${model.model}`;
      ctx.logger.info(`${used}: ${run.iterations} iteration(s), ${run.steps.length} tool call(s)`);
      out.push({
        json: {
          output: answer,
          sessionId: run.sessionId,
          model: used,
          ...(isFallbackModel(model) && model.fallbacks > 0 && { fallbackUsed: true }),
          iterations: run.iterations,
          usage: run.usage,
          ...(options.returnIntermediateSteps !== false ? { steps: run.steps as never } : {}),
        } as unknown as JsonObject,
        pairedItem: { item: i },
      });
    }
    return [out];
  },
});

interface AgentOptions extends MediaOptions {
  rememberedAttachments?: boolean;
  rememberedAttachmentsMaxMb?: number;
  maxIterations?: number;
  sessionId?: string;
  returnIntermediateSteps?: boolean;
  passthroughBinaryImages?: boolean;
  binaryPropertyNames?: string;
}

type Step = { tool: string; input: unknown; output: unknown; isError?: boolean };

interface ItemRun {
  messages: AgentMessage[];
  steps: Step[];
  iterations: number;
  usage: { inputTokens: number; outputTokens: number };
  sessionId: string;
  /** Messages before this run's prompt (loaded from memory). */
  historyLength: number;
}

/** Kept in node state while the execution waits for an approval. */
interface AgentNodeState {
  progress?: ItemRun & { item: number; out: NodeItem[]; pending: { calls: ToolCall[]; results: ToolResult[] } };
  $resume?: { kind: string; data?: JsonObject; error?: string };
}

/** A person's decisions, from the approval route (`{ decisions: { [callId]: { approved, by } } }`). */
export function decisionsOf(resume: AgentNodeState['$resume']): Record<string, { approved: boolean; by?: string; at?: string }> {
  const data = resume?.data as { decisions?: unknown; body?: { decisions?: unknown } } | undefined;
  const raw = (data?.decisions ?? data?.body?.decisions) as Record<string, unknown> | undefined;
  const decisions: Record<string, { approved: boolean; by?: string; at?: string }> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'boolean') decisions[id] = { approved: value };
    else if (value && typeof value === 'object') decisions[id] = { approved: Boolean((value as { approved?: unknown }).approved), ...(typeof (value as { by?: unknown }).by === 'string' && { by: (value as { by: string }).by }), ...(typeof (value as { at?: unknown }).at === 'string' && { at: (value as { at: string }).at }) };
  }
  return decisions;
}

const lastToolCallIds = (messages: AgentMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant') return message.toolCalls.map((c) => c.id);
  }
  return [];
};

function messagesPushTool(messages: AgentMessage[], results: ToolResult[], calls: ToolCall[]) {
  const order = calls.map((c) => c.id);
  messages.push({ role: 'tool', results: results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) });
}

export interface ApprovalSettings {
  needs: (toolName: string) => boolean;
  channel: 'chat' | 'slack' | 'email';
  slackChannel: string;
  slackAuthentication: 'accessToken' | 'oAuth2';
  emails: string[];
  approvers: string[];
  timeoutMinutes: number;
}

/** `mode` overrides the node's Require Approval (the Run a Team node has none: every tool that needs approval asks). */
export function approvalSettings(ctx: IExecuteContext, itemIndex: number, mode = String(ctx.getNodeParameter('requireApproval', itemIndex, 'none'))): ApprovalSettings {
  const names = new Set(
    String(ctx.getNodeParameter('approvalTools', itemIndex, '') ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .flatMap((name) => [name, toToolName(name)]),
  );
  const list = (value: unknown) =>
    String(value ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  return {
    needs: (tool) => mode === 'all' || (mode === 'selected' && (names.has(tool) || names.has(tool.replace(/_\d+$/, '')))),
    channel: mode === 'none' ? 'chat' : ((['slack', 'email'].find((c) => c === String(ctx.getNodeParameter('approvalChannel', itemIndex, 'chat'))) as 'slack' | 'email' | undefined) ?? 'chat'),
    slackChannel: String(ctx.getNodeParameter('slackChannel', itemIndex, '') ?? '').trim(),
    slackAuthentication: String(ctx.getNodeParameter('slackAuthentication', itemIndex, 'accessToken')) === 'oAuth2' ? 'oAuth2' : 'accessToken',
    emails: parseAddresses(ctx.getNodeParameter('approvalEmails', itemIndex, '')),
    approvers: list(ctx.getNodeParameter('slackApprovers', itemIndex, '')),
    timeoutMinutes: Math.max(0, Number(ctx.getNodeParameter('approvalTimeoutMinutes', itemIndex, 0)) || 0),
  };
}

/**
 * Put the execution to wait for a person (WaitRequest.rerun: this node runs again on resume). The wait's
 * `data.approval` is what the chat panel, the execution view and POST /api/executions/:id/approvals read;
 * with Slack, each call is posted as a message with Approve / Reject buttons first.
 */
export async function askForApproval(ctx: IExecuteContext, itemIndex: number, settings: ApprovalSettings, calls: ToolCall[], extra: JsonObject = {}, title?: string) {
  if (!ctx.putExecutionToWait) throw new NodeOperationError('Tool approvals need a host that can pause executions');
  const node = ctx.getNode();
  const approval: JsonObject = {
    nodeName: node.name,
    nodeId: node.id,
    itemIndex,
    channel: settings.channel,
    calls: calls.map((call) => ({ id: call.id, tool: call.name, input: call.input as JsonObject })),
    requestedAt: new Date().toISOString(),
    ...(title && { title }),
  };
  if (settings.channel === 'slack') {
    if (!settings.slackChannel) throw new NodeOperationError('Set the Slack channel to post approval requests in', { itemIndex });
    const credential = slackCredential(ctx.getCredentials<JsonObject>(settings.slackAuthentication === 'oAuth2' ? SLACK_OAUTH2_CREDENTIAL : SLACK_CREDENTIAL));
    const messages: JsonObject = {};
    for (const call of calls) {
      const target = { t: 'wf' as const, e: ctx.getExecutionId(), c: call.id };
      const ts = await postMessage(credential, {
        channel: settings.slackChannel,
        text: `${title ?? node.name}: approve ${call.name}?`,
        blocks: approvalBlocks({ title: title ?? `${node.name} wants to run a tool`, tool: call.name, input: call.input, target }),
      });
      if (ts) messages[call.id] = ts;
    }
    approval.slack = { channel: settings.slackChannel, messages, ...(settings.approvers.length && { approvers: settings.approvers }) };
  }
  if (settings.channel === 'email') {
    if (!settings.emails.length) throw new NodeOperationError('Set the approver emails to send approval requests to', { itemIndex });
    if (!mailConfigured()) throw new NodeOperationError('Approvals by email need the host’s SMTP: set LANDFLOW_SMTP_HOST', { itemIndex });
    const target = (call: ToolCall) => ({ t: 'wf' as const, e: ctx.getExecutionId(), c: call.id });
    await sendApprovalEmails({
      to: settings.emails,
      title: title ?? `${node.name} wants to run a tool`,
      calls: calls.map((call) => ({ tool: call.name, input: call.input, target: target(call) })),
      ...(settings.timeoutMinutes > 0 && { note: `Unanswered calls are rejected after ${settings.timeoutMinutes} minutes.` }),
    });
    approval.email = { to: settings.emails };
  }
  ctx.logger.info(`waiting for approval of ${calls.map((c) => c.name).join(', ')}${settings.channel === 'slack' ? ` in Slack ${settings.slackChannel}` : settings.channel === 'email' ? ` by email (${settings.emails.length})` : ''}`);
  ctx.putExecutionToWait({
    resume: 'webhook',
    rerun: true,
    ...(settings.timeoutMinutes > 0 && { until: new Date(Date.now() + settings.timeoutMinutes * 60_000).toISOString() }),
    data: { approval, ...extra },
  });
}

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
    icon: 'brand:claude',
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
      ...(credentialIdOf(credential) && { credentialId: credentialIdOf(credential) }),
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
    icon: 'brand:ollama',
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
