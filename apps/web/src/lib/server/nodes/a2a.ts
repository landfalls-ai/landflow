/**
 * A2A Agent: talk to a remote agent over the A2A protocol 1.0 (JSON-RPC), such as a kagent agent, a Google ADK agent or any
 * other A2A server (docs/a2a.md). Send a message and get the reply, answer a pause (kagent's human-in-the-loop extension:
 * approve or reject the tool calls it waits on, or answer its questions), or read or cancel a task. Agents' A2A
 * capabilities (agents/tools.ts) use the same parameters.
 */
import { toToolName } from '@landflow/engine';
import { defineNode, NodeOperationError, type IBaseContext, type IExecuteContext, type JsonObject, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import {
  A2aError,
  answerMessage,
  approvalMessage,
  dataOf,
  endpointFrom,
  getAgentCard,
  hitlRequestOf,
  KAGENT_HITL_EXTENSION,
  questionTexts,
  remoteSaidOf,
  remoteStepsOf,
  replyOf,
  stateName,
  statusText,
  supportsExtension,
  usageOf,
  type A2aCredentials,
  type A2aEndpoint,
  type A2aResult,
  type A2aTask,
  type AgentCard,
  type HitlRequest,
} from '../a2a/client';
import type { AgentTraceSummary } from '../../shared/agents';
import { traceFor, usageOfTrace, withMarker } from '../a2a/agent-trace';
import { callAgent, landflowTags, taskCall, throttled } from '../a2a/traced';
import { CUT } from '../journal/content';

const main = [{ type: 'main' as const }];

export const A2A_AGENT = 'core.a2aAgent';

export const a2aCredentialRequirements = [
  { name: 'httpBearerAuth', required: true, displayOptions: { show: { authentication: ['bearerAuth'] } } },
  { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
];

/** Where the agent is and how to sign in: shared with agents' A2A capabilities (the builder's dialog shows these). */
export const a2aServerProperties: PropertyDescriptor[] = [
  {
    name: 'agentUrl',
    displayName: 'Agent URL',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'http://host.docker.internal:58083/agents/kagent/my-agent',
    description: 'The agent’s A2A JSON-RPC endpoint, or its agent card URL (…/.well-known/agent-card.json). Calls go to this URL, not to the URLs inside the card',
  },
  {
    name: 'authentication',
    displayName: 'Authentication',
    type: 'options',
    default: 'none',
    noDataExpression: true,
    options: [
      { name: 'None', value: 'none' },
      { name: 'Bearer Auth', value: 'bearerAuth', description: 'Authorization: Bearer <token>' },
      { name: 'Header Auth', value: 'headerAuth', description: 'A header name and value' },
    ],
  },
];

export const a2aTimeoutOption: PropertyDescriptor = {
  name: 'timeout',
  displayName: 'Timeout (ms)',
  type: 'number',
  default: 300_000,
  typeOptions: { minValue: 1_000, maxValue: 3_600_000 },
  description: 'How long to wait for the task to finish or pause',
};

export function a2aCredentialsOf(ctx: Pick<IBaseContext, 'getCredentials'>): A2aCredentials {
  return {
    httpBearerAuth: ctx.getCredentials('httpBearerAuth', { optional: true }),
    httpHeaderAuth: ctx.getCredentials('httpHeaderAuth', { optional: true }),
  };
}

/** One item for a send or an answer: the reply, the task's state and ids, and what a pause asks for. */
export function resultItem(card: AgentCard, result: A2aResult): JsonObject {
  if (result.kind === 'message') {
    return { reply: replyOf(result) ?? null, state: 'completed', contextId: result.message.contextId ?? null, taskId: null, agent: card.name };
  }
  const { task } = result;
  const request = hitlRequestOf(task);
  const data = dataOf(task);
  const usage = usageOf(task);
  const steps = remoteStepsOf(task);
  const said = remoteSaidOf(task);
  return {
    reply: task.status.state === 'TASK_STATE_COMPLETED' ? (replyOf(result) ?? null) : null,
    state: stateName(task.status.state),
    taskId: task.id,
    contextId: task.contextId,
    agent: card.name,
    ...(task.status.state !== 'TASK_STATE_COMPLETED' && statusText(task) && { message: statusText(task)! }),
    ...(request?.type === 'tool_approval_request' && { pause: { type: 'approval', calls: request.tools, ...(request.hint && { hint: request.hint }) } as unknown as JsonObject }),
    ...(request?.type === 'ask_user_request' && { pause: { type: 'question', questions: questionTexts(request) } }),
    ...(steps.length > 0 && { steps: steps as unknown as JsonObject[] }),
    ...(said.length > 0 && { said: said as unknown as JsonObject[] }),
    ...(data.length > 0 && { data: data as JsonObject[] }),
    ...(usage && { usage: usage as JsonObject }),
  };
}

/** An item with what the agent's mod reported: its usage (unless the task carried its own) and the trace. */
export function withTraced(item: JsonObject, summary: AgentTraceSummary | undefined): JsonObject {
  if (!summary) return item;
  const usage = item.usage ?? usageOfTrace(summary);
  return { ...item, ...(usage && { usage: usage as JsonObject }), trace: summary as unknown as JsonObject };
}

/** How many of the latest steps a progress report carries. */
const PROGRESS_STEPS = 20;
const SNIPPET = 400;

const snippet = (value: unknown, max = SNIPPET) => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Longest text a step's arguments keep the first time a report carries them. */
const ARG_CHARS = 16_000;
/** A step's arguments for the run's record: the object itself (file paths and all), each long text cut with `…[cut]`. */
const fullArgs = (value: unknown): unknown => {
  if (typeof value === 'string') return value.length > ARG_CHARS ? `${value.slice(0, ARG_CHARS)}${CUT}` : value;
  if (Array.isArray(value)) return value.map(fullArgs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fullArgs(item)]));
  return value;
};

/**
 * `ctx.sendProgress` as the remote run so far: the agent, the task's state and the latest steps. A step's arguments go
 * in full the first time a report carries it (the journal records the step from that report, so Edits and Writes keep
 * their paths and text for the Artifacts tab) and shortened after; results are always shortened.
 */
export function progressReporter(ctx: Pick<IExecuteContext, 'sendProgress'>, card: AgentCard, options: { questionsToCaller?: boolean } = {}): ((task: A2aTask) => void) | undefined {
  const send = ctx.sendProgress;
  if (!send) return undefined;
  const reported = new Set<string>();
  return throttled((run) => {
    const steps = run.steps.slice(-PROGRESS_STEPS);
    const first = steps.filter((step) => !reported.has(step.id));
    for (const step of first) reported.add(step.id);
    send({
      agent: run.agent,
      // A question the calling agent answers is not a wait for a person: the run reports it as work until the call ends.
      state: options.questionsToCaller && run.state === 'input-required' ? 'working' : run.state,
      ...(run.taskId && { taskId: run.taskId }),
      ...(run.contextId && { contextId: run.contextId }),
      steps: steps.map((step) => ({
        id: step.id,
        name: step.name,
        status: step.status,
        ...(step.args !== undefined && { args: first.includes(step) ? fullArgs(step.args) : snippet(step.args) }),
        ...(step.output !== undefined && { output: snippet(step.output) }),
        ...(step.error && { error: snippet(step.error) }),
        ...(step.startedAt && { startedAt: step.startedAt }),
        ...(step.endedAt && { endedAt: step.endedAt }),
      })) as JsonObject[],
      ...(run.said?.length && { said: run.said.map((words) => ({ id: words.id, text: snippet(words.text, 2_000), afterSteps: words.afterSteps })) as JsonObject[] }),
    });
  }, card);
}

/** A failed, rejected or canceled task fails the item (the agent's status message says why). */
function assertNotFailed(card: AgentCard, result: A2aResult, itemIndex: number) {
  if (result.kind !== 'task') return;
  const { state } = result.task.status;
  if (state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_REJECTED' || state === 'TASK_STATE_CANCELED') {
    throw new NodeOperationError(`${card.name}: the task ${stateName(state)}`, { description: statusText(result.task), itemIndex });
  }
}

function endpointOf(ctx: IExecuteContext, itemIndex: number): A2aEndpoint {
  try {
    return endpointFrom(
      { agentUrl: ctx.getNodeParameter('agentUrl', itemIndex), authentication: ctx.getNodeParameter('authentication', itemIndex), options: ctx.getNodeParameter('options', itemIndex, {}) },
      a2aCredentialsOf(ctx),
    );
  } catch (error) {
    throw new NodeOperationError((error as Error).message, { itemIndex });
  }
}

/** What a tool-mode node remembers for the run: the conversation, and the question it waits on an answer to. */
interface Remembered {
  contextId: string;
  taskId?: string;
  question?: { id: string; questions: string[] };
}

/** The question a calling agent has to answer, as its tool result. */
function questionText(card: AgentCard, questions: string[], tool: string): string {
  return `${card.name} asks:\n${questions.map((q) => `- ${q}`).join('\n')}\nCall ${tool} again with your answer as the message.`;
}

export const a2aAgentNode = defineNode({
  description: {
    name: 'a2aAgent',
    displayName: 'A2A Agent',
    description: 'Send a message to a remote agent over the A2A protocol (kagent, Google ADK, any A2A 1.0 server) and get its reply',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:radio-tower',
    color: '#a855f7',
    subtitle: '{{operation}}',
    keywords: ['a2a', 'agent2agent', 'agent to agent', 'kagent', 'adk', 'remote agent', 'delegate'],
    usableAsTool: true,
    delegates: true,
    toolDescription:
      'Ask a remote agent to do something. Arguments: `message` (the task or the follow-up) and `reason`. The agent keeps the conversation across your calls in this run, so a follow-up can build on what it already knows; it does not see your own conversation. When it asks a question, call again with your answer as the message.',
    toolInputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The task, or the follow-up or answer in a conversation with this agent already under way' } },
      required: ['message'],
    },
    credentials: a2aCredentialRequirements,
    inputs: main,
    outputs: main,
    properties: [
      ...a2aServerProperties,
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'sendMessage',
        noDataExpression: true,
        options: [
          { name: 'Send Message', value: 'sendMessage', description: 'Send a message and wait for the reply (or a pause)' },
          { name: 'Answer a Pause', value: 'respond', description: 'Approve or reject the tool calls a paused task waits on, or answer its questions' },
          { name: 'Get Task', value: 'getTask', description: 'Read a task' },
          { name: 'Cancel Task', value: 'cancelTask', description: 'Stop a running task' },
        ],
      },
      {
        name: 'message',
        displayName: 'Message',
        type: 'string',
        default: '{{ $json.chatInput ?? $json.text }}',
        required: true,
        typeOptions: { rows: 3 },
        displayOptions: { show: { operation: ['sendMessage'] } },
      },
      {
        name: 'contextId',
        displayName: 'Context ID',
        type: 'string',
        default: '',
        description: 'Continue a conversation: the contextId of an earlier reply. Empty starts a new one',
        displayOptions: { show: { operation: ['sendMessage'] } },
      },
      {
        name: 'taskId',
        displayName: 'Task ID',
        type: 'string',
        default: '{{ $json.taskId }}',
        required: true,
        displayOptions: { show: { operation: ['respond', 'getTask', 'cancelTask'] } },
      },
      {
        name: 'response',
        displayName: 'Answer',
        type: 'options',
        default: 'approve',
        options: [
          { name: 'Approve', value: 'approve', description: 'Run every tool call the task waits on' },
          { name: 'Reject', value: 'reject', description: 'Refuse them; the agent hears the reason and carries on' },
          { name: 'Answer Questions', value: 'answer', description: 'Reply to the questions the agent asked' },
        ],
        displayOptions: { show: { operation: ['respond'] } },
      },
      {
        name: 'rejectionReason',
        displayName: 'Reason',
        type: 'string',
        default: '',
        description: 'Told to the agent so it can adapt',
        displayOptions: { show: { operation: ['respond'], response: ['reject'] } },
      },
      {
        name: 'answers',
        displayName: 'Answers',
        type: 'string',
        default: '',
        typeOptions: { rows: 3 },
        description: 'One answer per line, in the order of the questions',
        displayOptions: { show: { operation: ['respond'], response: ['answer'] } },
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          a2aTimeoutOption,
          {
            name: 'humanInTheLoop',
            displayName: 'Human in the Loop',
            type: 'boolean',
            default: true,
            description: 'Ask for kagent’s human-in-the-loop extension, so a pause names the tool calls to approve (only when the agent card offers it)',
          },
          {
            name: 'questionsGoTo',
            displayName: 'Questions Go To',
            type: 'options',
            default: 'agent',
            options: [
              { name: 'The Calling Agent', value: 'agent', description: 'Used as an agent’s tool: the agent gets the question as the tool result and answers it with its next call' },
              { name: 'A Person', value: 'person', description: 'The call ends paused at the question, for a person to answer (Answer a Pause)' },
            ],
            description: 'Where a question the remote agent asks goes when this node is an agent’s tool. Tool approvals always go to a person',
          },
        ],
      },
      {
        name: 'notice',
        displayName:
          'Each item becomes { reply, state, taskId, contextId, agent, steps }. `steps` are the tool calls the agent made. A paused task has state "input-required" and a pause ({ type: "approval", calls } or { type: "question", questions }): answer it with Answer a Pause. Pass contextId on to keep talking in the same conversation.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      try {
        const endpoint = endpointOf(ctx, i);
        const operation = String(ctx.getNodeParameter('operation', i, 'sendMessage') ?? 'sendMessage');
        const card = await getAgentCard(endpoint, { signal: ctx.signal });
        const options = ctx.getNodeParameter<{ humanInTheLoop?: boolean; questionsGoTo?: string }>('options', i, {}) ?? {};
        // As an agent's tool the node keeps the conversation for the run and hands the agent the remote agent's questions.
        const asTool = ctx.getMode() === 'tool' && Boolean(ctx.getNodeState && ctx.setNodeState);
        const questionsToCaller = asTool && options.questionsGoTo !== 'person';
        const remembered = asTool ? ctx.getNodeState?.<Remembered & JsonObject>() : undefined;
        const toolName = toToolName(ctx.getNode().name);
        const extensions = options.humanInTheLoop !== false && supportsExtension(card, KAGENT_HITL_EXTENSION) ? [KAGENT_HITL_EXTENSION] : [];
        // A streaming card lets the node report the remote agent's steps while it works (the execution view shows them live).
        const send = { signal: ctx.signal, extensions, caller: 'node' as const, onUpdate: progressReporter(ctx, card, { questionsToCaller }) };
        // Tags for finding this run from the agent's side (kagent documents copying them onto its spans; see lib/server/a2a/traced.ts).
        const metadata = landflowTags({ 'workflow.id': ctx.getWorkflowId(), 'execution.id': ctx.getExecutionId(), 'node.name': ctx.getNode().name });
        let result: A2aResult;
        let traced: AgentTraceSummary | undefined;
        if (operation === 'sendMessage') {
          const text = String(ctx.getNodeParameter('message', i) ?? '').trim();
          if (!text) throw new NodeOperationError('The message is empty', { itemIndex: i });
          const contextId = String(ctx.getNodeParameter('contextId', i, '') ?? '').trim() || remembered?.contextId;
          if (remembered?.taskId && remembered.question) {
            // The remote agent asked a question last time: this call answers it, on the same task.
            const request: Extract<HitlRequest, { type: 'ask_user_request' }> = { type: 'ask_user_request', id: remembered.question.id, questions: remembered.question.questions };
            const answer = answerMessage({ id: remembered.taskId, contextId: remembered.contextId }, request, [text]);
            result = await callAgent(endpoint, card, { ...answer, metadata: { ...metadata, ...answer.metadata } }, send);
          } else {
            // A Landflow agent on kagent with the landflow-harness mod reports its real usage, cost and tool calls here.
            const message = { text, metadata, ...(contextId && { contextId }), ...(remembered?.taskId && { taskId: remembered.taskId }) };
            const trace = message.taskId ? undefined : traceFor(endpoint.url, ctx.getExecutionId() && ctx.getWorkflowId() ? { executionId: ctx.getExecutionId()!, workflowId: ctx.getWorkflowId()!, nodeId: ctx.getNode().id, member: ctx.getNode().name } : undefined);
            try {
              result = await callAgent(endpoint, card, withMarker(message, trace), send);
            } finally {
              traced = await trace?.close();
            }
          }
        } else {
          const taskId = String(ctx.getNodeParameter('taskId', i) ?? '').trim();
          if (!taskId) throw new NodeOperationError('Enter the task ID', { itemIndex: i });
          if (operation === 'getTask') result = { kind: 'task', task: await taskCall(endpoint, card, 'GetTask', taskId, send) };
          else if (operation === 'cancelTask') result = { kind: 'task', task: await taskCall(endpoint, card, 'CancelTask', taskId, send) };
          else {
            const task = await taskCall(endpoint, card, 'GetTask', taskId, send);
            const request = hitlRequestOf(task);
            if (!request) throw new NodeOperationError(`The task is ${stateName(task.status.state)}, not waiting for an answer it can read`, { description: statusText(task), itemIndex: i });
            const response = String(ctx.getNodeParameter('response', i, 'approve'));
            if (response === 'answer') {
              if (request.type !== 'ask_user_request') throw new NodeOperationError('The task waits for tool approvals, not answers', { itemIndex: i });
              const answers = String(ctx.getNodeParameter('answers', i, '') ?? '').split('\n').map((a) => a.trim()).filter(Boolean);
              const answer = answerMessage(task, request, answers);
              result = await callAgent(endpoint, card, { ...answer, metadata: { ...metadata, ...answer.metadata } }, send);
            } else {
              if (request.type !== 'tool_approval_request') throw new NodeOperationError('The task asks questions: answer them instead', { itemIndex: i });
              const reason = String(ctx.getNodeParameter('rejectionReason', i, '') ?? '').trim();
              const answer = approvalMessage(task, request, response === 'approve', reason || undefined);
              result = await callAgent(endpoint, card, { ...answer, metadata: { ...metadata, ...answer.metadata } }, send);
            }
          }
        }
        if (operation !== 'cancelTask') assertNotFailed(card, result, i);
        const item = withTraced(resultItem(card, result), traced);
        if (asTool && operation === 'sendMessage') {
          const contextId = result.kind === 'message' ? result.message.contextId : result.task.contextId;
          const request = result.kind === 'task' ? hitlRequestOf(result.task) : undefined;
          const waiting = result.kind === 'task' && result.task.status.state === 'TASK_STATE_INPUT_REQUIRED' && request?.type !== 'tool_approval_request';
          if (waiting && questionsToCaller && result.kind === 'task') {
            const questions = request?.type === 'ask_user_request' ? questionTexts(request) : [statusText(result.task) ?? 'The agent needs more input'];
            ctx.setNodeState!({ contextId: result.task.contextId, taskId: result.task.id, ...(request?.type === 'ask_user_request' && { question: { id: request.id, questions } }) });
            delete item.pause;
            item.reply = questionText(card, questions, toolName);
            item.asksCaller = true;
          } else if (contextId) ctx.setNodeState!({ contextId });
        }
        out.push({ json: item, pairedItem: { item: i } });
      } catch (error) {
        const failure = error instanceof A2aError ? new NodeOperationError(error.message, { itemIndex: i }) : error;
        if (!ctx.continueOnFail()) throw failure;
        out.push({ json: { error: (failure as Error).message }, pairedItem: { item: i } });
      }
    }
    return [out];
  },
});
