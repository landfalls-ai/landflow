/**
 * A local fake of the OpenAI API (/v1/models, /v1/chat/completions,
 * /v1/embeddings), plus Ollama's native /api/chat and Anthropic's /v1/messages,
 * so every adapter can be tested without accounts or real keys.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatBody = {
  model: string;
  messages: Array<{ role: string; content: any; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string } }>;
  response_format?: { type: string };
};
export type ChatReply = { message: Record<string, unknown>; finish_reason: string };

/** The API key a request carried (`x-api-key`, or `authorization: Bearer`, which the Anthropic SDK also uses). */
export const sentKey = (request: { headers: IncomingHttpHeaders }) =>
  request.headers['x-api-key'] ?? String(request.headers.authorization ?? '').replace(/^Bearer /, '');

/** A local port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Default chat behaviour: call the first tool once, then answer with its result; JSON mode echoes the prompt as JSON. */
function defaultChat(body: ChatBody): ChatReply {
  const last = body.messages[body.messages.length - 1];
  if (body.tools?.length && last.role !== 'tool') {
    return {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"expression":"6*7"}' } }],
      },
      finish_reason: 'tool_calls',
    };
  }
  if (last.role === 'tool') return { message: { role: 'assistant', content: `The answer is ${last.content}` }, finish_reason: 'stop' };
  if (body.response_format?.type === 'json_object')
    return { message: { role: 'assistant', content: JSON.stringify({ echo: last.content }) }, finish_reason: 'stop' };
  return { message: { role: 'assistant', content: `<think>hmm</think>Echo: ${last.content}` }, finish_reason: 'stop' };
}

export async function startFakeOpenAi(options: { apiKey?: string; chat?: (body: ChatBody) => ChatReply | undefined } = {}) {
  const requests: FakeRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '/').split('?')[0];
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    if (options.apiKey && sentKey(req) !== options.apiKey) {
      return send(401, { type: 'error', error: { type: 'authentication_error', message: 'Incorrect API key provided', code: 'invalid_api_key' } });
    }

    if (path === '/v1/models') {
      return send(200, {
        object: 'list',
        data: [
          { id: 'gpt-test', owned_by: 'fake', type: 'model', display_name: 'GPT Test' },
          { id: 'text-embedding-test', owned_by: 'fake', type: 'model', display_name: 'Embed' },
          { id: 'tts-1', owned_by: 'fake', type: 'model', display_name: 'TTS' },
        ],
        has_more: false,
      });
    }
    if (path === '/v1/embeddings') {
      const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
      // Reversed on purpose: clients must order by `index`.
      const data = input.map((text, index) => ({ object: 'embedding', index, embedding: [text.length, index, 0.5] })).reverse();
      return send(200, { object: 'list', model: body.model, data, usage: { prompt_tokens: input.length * 3, total_tokens: input.length * 3 } });
    }
    if (path === '/v1/chat/completions') {
      if (body.model === 'missing') return send(404, { error: { message: "The model 'missing' does not exist", type: 'invalid_request_error' } });
      if (body.model === 'notfound') return send(404, '404 page not found');
      if (body.model === 'busy') return send(429, { error: { message: 'Rate limit reached for requests' } });
      if (body.model === 'broken') return send(500, 'upstream exploded');
      const reply = options.chat?.(body) ?? defaultChat(body);
      return send(200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: `${body.model}-2026`,
        choices: [{ index: 0, ...reply }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      });
    }
    if (path === '/api/chat') {
      // Ollama's qwen3-coder tool-call parser failing on a sample: "xml-once" fails its first request, "xml-always" every
      // one; "xml-stream-once" fails inside its first stream; "ollama-broken" is any other server error.
      const tries = requests.filter((r) => r.path === path && r.body?.model === body.model).length;
      const xml = 'XML syntax error on line 8: element <parameter> closed by </function>';
      if (body.model === 'xml-always' || (body.model === 'xml-once' && tries === 1)) return send(500, { error: xml });
      if (body.model === 'xml-stream-once' && tries === 1) return send(200, `${JSON.stringify({ error: xml })}\n`);
      if (body.model === 'ollama-broken') return send(500, { error: 'model runner has unexpectedly stopped' });
      return send(200, {
        model: body.model,
        message: { role: 'assistant', content: body.format === 'json' ? '{"ok": true}' : 'plain text' },
        done_reason: 'stop',
        prompt_eval_count: 3,
        eval_count: 2,
      });
    }
    if (path === '/v1/messages') {
      return send(200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'Sure: {"ok": true}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      });
    }
    send(404, { error: { message: `No route ${path}` } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: `${origin}/v1`,
    port,
    requests,
    last: (path: string) => [...requests].reverse().find((request) => request.path === path),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeServer = Awaited<ReturnType<typeof startFakeOpenAi>>;
