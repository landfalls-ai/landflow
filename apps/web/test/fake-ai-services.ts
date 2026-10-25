/**
 * Local fakes for the chat and AI-ops tests: model APIs that stream (OpenAI-compatible SSE, Ollama NDJSON,
 * Anthropic Messages SSE) and a Slack Web API that records what it was asked. No accounts, no network.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  /** Slack: the message `ts` the fake answered with. */
  ts?: string;
}

export interface FakeReply {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: { input: number; output: number };
}

type Provider = 'openai' | 'ollama' | 'anthropic';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Split text into deltas of `size` characters. */
const pieces = (text: string, size = 4) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, i * size + size));

/** The last user text of any provider's messages. */
function lastUserText(provider: Provider, body: { messages?: Array<{ role: string; content: unknown }> }): string {
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  const content = user?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.find((part: { type?: string; text?: string }) => part.type === 'text' && typeof part.text === 'string') as { text?: string } | undefined;
    if (text?.text) return text.text;
    // Anthropic tool results are user messages too.
    const result = content.find((part: { type?: string }) => part.type === 'tool_result') as { content?: string } | undefined;
    if (result) return String(result.content ?? '');
  }
  void provider;
  return '';
}

/** Default behaviour: call the first tool once, then answer with its result; without tools echo the question. */
function defaultReply(provider: Provider, body: { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ name?: string; function?: { name: string } }> }): FakeReply {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const toolResult =
    last?.role === 'tool' ? String(last.content) : Array.isArray(last?.content) && (last.content as Array<{ type?: string }>).some((p) => p.type === 'tool_result') ? lastUserText(provider, body) : undefined;
  if (toolResult !== undefined) return { text: `The answer is ${toolResult}` };
  const tool = body.tools?.[0];
  const name = tool?.function?.name ?? tool?.name;
  if (name) return { toolCalls: [{ id: 'call_1', name, arguments: { expression: '6*7' } }] };
  return { text: `Echo: ${lastUserText(provider, body)}` };
}

export async function startFakeModels(options: { reply?: (provider: Provider, body: Recorded['body']) => FakeReply | undefined; delayMs?: number } = {}) {
  const requests: Recorded[] = [];
  const delay = options.delayMs ?? 3;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '/').split('?')[0];
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });
    const provider: Provider = path === '/api/chat' ? 'ollama' : path === '/v1/messages' ? 'anthropic' : 'openai';
    const reply = options.reply?.(provider, body) ?? defaultReply(provider, body);
    const text = reply.text ?? '';
    const usage = reply.usage ?? { input: 12, output: 8 };

    if (path === '/v1/chat/completions') {
      const toolCalls = (reply.toolCalls ?? []).map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length && { tool_calls: toolCalls }) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      for (const delta of pieces(text)) {
        await sleep(delay);
        send({ model: body.model, choices: [{ index: 0, delta: { content: delta } }] });
      }
      toolCalls.forEach((call, index) => {
        const half = Math.ceil(call.function.arguments.length / 2);
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments.slice(0, half) } }] } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: call.function.arguments.slice(half) } }] } }] });
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] });
      if (body.stream_options?.include_usage) send({ choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } });
      res.end('data: [DONE]\n\n');
      return;
    }

    if (path === '/api/chat') {
      const toolCalls = (reply.toolCalls ?? []).map((call) => ({ function: { name: call.name, arguments: call.arguments } }));
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: text, ...(toolCalls.length && { tool_calls: toolCalls }) }, done: true, done_reason: 'stop', prompt_eval_count: usage.input, eval_count: usage.output }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const delta of pieces(text)) {
        await sleep(delay);
        res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: delta }, done: false })}\n`);
      }
      if (toolCalls.length) res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '', tool_calls: toolCalls }, done: false })}\n`);
      res.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: usage.input, eval_count: usage.output })}\n`);
      return;
    }

    if (path === '/v1/messages') {
      const content = [
        ...(text ? [{ type: 'text', text }] : []),
        ...(reply.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
      ];
      const stopReason = reply.toolCalls?.length ? 'tool_use' : 'end_turn';
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } } });
      let index = 0;
      if (text) {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        for (const delta of pieces(text)) {
          await sleep(delay);
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } });
        }
        send('content_block_stop', { type: 'content_block_stop', index });
        index++;
      }
      for (const call of reply.toolCalls ?? []) {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } });
        send('content_block_stop', { type: 'content_block_stop', index });
        index++;
      }
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output } });
      send('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `No route ${path}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    /** OpenAI-compatible base URL. */
    url: `${origin}/v1`,
    requests,
    last: (path: string) => [...requests].reverse().find((request) => request.path === path),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeModels = Awaited<ReturnType<typeof startFakeModels>>;

/** A Slack Web API double: every method answers `ok`, chat.postMessage hands out increasing `ts` values. */
export async function startFakeSlack(options: { token?: string } = {}) {
  const calls: Recorded[] = [];
  let next = 1;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const method = (req.url ?? '/').split('?')[0].replace(/^\/api\//, '');
    const body = raw ? JSON.parse(raw) : {};
    const ts = method === 'chat.postMessage' ? `1700000000.${String(next++).padStart(6, '0')}` : body.ts;
    calls.push({ method: req.method ?? 'POST', path: method, headers: req.headers, body, ts });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) return res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }));
    res.end(JSON.stringify({ ok: true, channel: body.channel, ts }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api`,
    calls,
    /** Calls of one Web API method. */
    of: (method: string) => calls.filter((call) => call.path === method),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeSlack = Awaited<ReturnType<typeof startFakeSlack>>;

/** Read an SSE response into its events (`event:` name, parsed `data:` JSON). */
export async function readSse(response: Response): Promise<Array<{ event: string; data: any }>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      return { event, data: data ? JSON.parse(data) : undefined };
    })
    .filter((entry) => entry.data !== undefined);
}
