/**
 * A local server answering Anthropic's `POST /v1/messages/count_tokens` by a fixed rule, so tests can compute the
 * numbers: a text block (system or message) is ceil(characters / 4) tokens, a tool is ceil(characters of its JSON / 4),
 * and each message adds 3. Records every request it gets (the tests count them; nothing here is a real vendor).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CountRequestBody {
  model: string;
  system?: Array<{ type: string; text: string }> | string;
  tools?: unknown[];
  messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>;
}

export const blockTokens = (text: string): number => Math.ceil(text.length / 4);
export const toolTokens = (tool: unknown): number => Math.ceil(JSON.stringify(tool).length / 4);

/** The fake's rule over one request. */
export function ruleTokens(body: CountRequestBody): number {
  const system = typeof body.system === 'string' ? blockTokens(body.system) : (body.system ?? []).reduce((n, b) => n + blockTokens(b.text), 0);
  const tools = (body.tools ?? []).reduce<number>((n, t) => n + toolTokens(t), 0);
  const messages = body.messages.reduce((n, m) => n + 3 + (typeof m.content === 'string' ? blockTokens(m.content) : m.content.reduce((k, b) => k + blockTokens(b.text), 0)), 0);
  return system + tools + messages;
}

export async function startFakeAnthropicCount(): Promise<{ url: string; requests: CountRequestBody[]; keys: string[]; failing: boolean; close: () => Promise<void> }> {
  const state = { url: '', requests: [] as CountRequestBody[], keys: [] as string[], failing: false, close: async () => {} };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'POST' || path !== '/v1/messages/count_tokens') {
        res.writeHead(404).end('{}');
        return;
      }
      if (state.failing) {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"api_error","message":"down"}}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CountRequestBody;
      state.requests.push(body);
      state.keys.push(String(req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer /, '')));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: ruleTokens(body) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
