/**
 * A fake A2A 1.0 agent (JSON-RPC over HTTP) shaped like kagent's: an agent card, SendMessage, SendStreamingMessage (SSE),
 * GetTask and CancelTask, tool calls as function_call / function_response data parts, the usage extension, and the
 * human-in-the-loop extension (tool approvals and questions). What it does depends on the message text:
 *
 * - `slug <text>`: calls `slugify` and answers with the slug.
 * - `upper <text>`: calls `changeCase`, which needs approval; approved → the upper-case text, rejected → the reason.
 * - `ask`: asks a question; the answer comes back in the reply.
 * - `chatty <text>`: says something, calls `slugify`, says something more, then answers (words between the tool calls).
 * - `slow`: answers WORKING, and GetTask completes it.
 * - `fail`: the task fails.
 * - anything else: echoes it.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

const HITL = 'https://kagent.dev/extensions/hitl/v1';
const USAGE = 'https://kagent.dev/extensions/usage/v1';

interface Task {
  id: string;
  contextId: string;
  status: { state: string; message?: Record<string, unknown> };
  artifacts: Array<{ artifactId: string; parts: Array<Record<string, unknown>>; metadata?: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
  /** What an approval or an answer continues with. */
  pending?: { kind: 'approval'; callId: string; text: string } | { kind: 'question' };
}

export interface ReceivedCall {
  method: string;
  headers: IncomingMessage['headers'];
  params: { message?: { parts?: Array<{ text?: string }>; contextId?: string; taskId?: string; metadata?: Record<string, unknown>; extensions?: string[] }; id?: string };
}

export interface FakeA2a {
  url: string;
  calls: ReceivedCall[];
  /** Whether the card says `capabilities.streaming`. */
  streaming: boolean;
  /** Serve an A2A 0.3 card instead. */
  legacyCard: boolean;
  close(): Promise<void>;
}

const at = (offset: number) => new Date(Date.UTC(2026, 9, 30, 9, 0, offset)).toISOString();

function functionCall(id: string, name: string, args: Record<string, unknown>, second: number) {
  return { artifactId: randomUUID(), metadata: { 'kagent.dev/a2a/timeline-position': at(second) }, parts: [{ data: { id, name, args }, metadata: { 'kagent.dev/a2a/part-type': 'function_call' } }] };
}

function functionResponse(id: string, name: string, response: Record<string, unknown>, second: number) {
  return { artifactId: randomUUID(), metadata: { 'kagent.dev/a2a/timeline-position': at(second) }, parts: [{ data: { id, name, response }, metadata: { 'kagent.dev/a2a/part-type': 'function_response' } }] };
}

const textArtifact = (text: string) => ({ artifactId: randomUUID(), parts: [{ text }] });

function complete(task: Task, text: string) {
  task.artifacts.push(textArtifact(text));
  task.status = { state: 'TASK_STATE_COMPLETED' };
  task.metadata = { [USAGE]: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 150 } };
  delete task.pending;
}

export async function startFakeA2a(): Promise<FakeA2a> {
  const tasks = new Map<string, Task>();
  const state: FakeA2a = { url: '', calls: [], streaming: false, legacyCard: false, close: async () => {} };

  /** Run a message: a new task, or the continuation of a paused one. */
  function handle(params: ReceivedCall['params']): Task {
    const message = params.message ?? {};
    const full = (message.parts ?? []).map((p) => p.text ?? '').join('').trim();
    // A team run puts the goal and the manager's task in front of the request, then a blank line.
    const text = /^(Team goal:|.+'s current task:)/.test(full) ? full.split('\n\n').slice(1).join('\n\n').trim() : full;
    const existing = message.taskId ? tasks.get(message.taskId) : undefined;
    if (existing?.pending) {
      const payload = message.metadata?.[HITL] as { type?: string; approvals?: Array<{ approved: boolean; rejection_reason?: string }>; answers?: Array<{ answer: string[] }> } | undefined;
      if (existing.pending.kind === 'approval') {
        const decision = payload?.type === 'tool_approval_response' ? payload.approvals?.[0] : undefined;
        const { callId, text: input } = existing.pending;
        if (decision?.approved) {
          existing.artifacts.push(functionResponse(callId, 'changeCase', { output: { text: input.toUpperCase() } }, 5));
          complete(existing, input.toUpperCase());
        } else {
          existing.artifacts.push(functionResponse(callId, 'changeCase', { error: `rejected: ${decision?.rejection_reason ?? 'no reason'}` }, 5));
          complete(existing, `Not changed (${decision?.rejection_reason ?? 'no reason'})`);
        }
      } else {
        const answer = payload?.type === 'ask_user_response' ? payload.answers?.[0]?.answer?.[0] : text;
        complete(existing, `You said: ${answer}`);
      }
      return existing;
    }
    const task: Task = { id: randomUUID(), contextId: message.contextId ?? randomUUID(), status: { state: 'TASK_STATE_WORKING' }, artifacts: [] };
    tasks.set(task.id, task);
    if (text.startsWith('slug ')) {
      const input = text.slice(5);
      const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      task.artifacts.push(functionCall('call-1', 'slugify', { text: input }, 1), functionResponse('call-1', 'slugify', { output: { slug } }, 2));
      complete(task, `The slug is ${slug}`);
    } else if (text.startsWith('chatty ')) {
      const input = text.slice(7);
      const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      task.artifacts.push(
        textArtifact('Let me slugify that first.'),
        functionCall('call-1', 'slugify', { text: input }, 1),
        functionResponse('call-1', 'slugify', { output: { slug } }, 2),
        textArtifact('The slug looks right.'),
      );
      complete(task, `Done: ${slug}`);
    } else if (text.startsWith('upper ')) {
      const input = text.slice(6);
      task.artifacts.push(
        functionCall('call-2', 'changeCase', { text: input, case: 'upper' }, 1),
        functionResponse('call-2', 'changeCase', { error: 'error tool "changeCase" requires confirmation, please approve or reject' }, 2),
      );
      task.status = {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: randomUUID(),
          role: 'ROLE_AGENT',
          parts: [{ text: 'Please approve or reject the tool call changeCase()' }],
          metadata: { [HITL]: { type: 'tool_approval_request', hint: 'approve changeCase', tools: [{ id: 'adk-1', call_id: 'call-2', name: 'changeCase', args: { text: input, case: 'upper' } }] } },
        },
      };
      task.pending = { kind: 'approval', callId: 'call-2', text: input };
    } else if (text === 'ask') {
      task.status = {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Which colour?' }], metadata: { [HITL]: { type: 'ask_user_request', id: 'q-1', questions: [{ question: 'Which colour?' }] } } },
      };
      task.pending = { kind: 'question' };
    } else if (text === 'slow') {
      task.status = { state: 'TASK_STATE_WORKING' };
    } else if (text === 'fail') {
      task.status = { state: 'TASK_STATE_FAILED', message: { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'the model is down' }] } };
    } else {
      complete(task, `echo: ${text}`);
    }
    return task;
  }

  const view = (task: Task) => {
    const { pending: _pending, ...rest } = task;
    return structuredClone(rest);
  };

  const server: Server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/.well-known/agent-card.json')) {
      const card = state.legacyCard
        ? { name: 'old-agent', protocolVersion: '0.3.0', url: state.url }
        : {
            name: 'fake-agent',
            description: 'A fake kagent agent',
            skills: [{ id: 'text', name: 'Text tools', description: 'slugify and change case' }],
            capabilities: { streaming: state.streaming, extensions: [{ uri: HITL }, { uri: USAGE }] },
            supportedInterfaces: [{ url: 'http://cluster.internal/agents/fake', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body) as { id: string; method: string; params: ReceivedCall['params'] };
    state.calls.push({ method: rpc.method, headers: req.headers, params: rpc.params });
    const answer = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    if (rpc.method === 'GetTask' || rpc.method === 'CancelTask') {
      const task = tasks.get(String(rpc.params.id));
      if (!task) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: 'Task not found' } }));
        return;
      }
      if (rpc.method === 'CancelTask') task.status = { state: 'TASK_STATE_CANCELED' };
      else if (task.status.state === 'TASK_STATE_WORKING') complete(task, 'finally done');
      answer(view(task));
      return;
    }
    if (rpc.method === 'SendMessage') {
      answer({ task: view(handle(rpc.params)) });
      return;
    }
    if (rpc.method === 'SendStreamingMessage') {
      const task = handle(rpc.params);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (result: unknown) => res.write(`id: ${randomUUID()}\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
      send({ task: { id: task.id, contextId: task.contextId, status: { state: 'TASK_STATE_SUBMITTED' } } });
      send({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: { state: 'TASK_STATE_WORKING' } } });
      for (const artifact of task.artifacts) {
        const text = artifact.parts[0]?.text;
        if (typeof text === 'string' && text.length > 4) {
          // A text answer streams in two chunks, then comes whole (as kagent sends it).
          send({ artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact: { ...artifact, parts: [{ text: text.slice(0, 4) }] } } });
          send({ artifactUpdate: { taskId: task.id, contextId: task.contextId, append: true, artifact: { ...artifact, parts: [{ text: text.slice(4) }] } } });
        }
        send({ artifactUpdate: { taskId: task.id, contextId: task.contextId, lastChunk: true, artifact } });
      }
      send({ task: view(task) });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents/kagent/fake`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
