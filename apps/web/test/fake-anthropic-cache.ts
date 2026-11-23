/**
 * A local fake of Anthropic's Messages API that simulates prompt caching (SP19, wave 12), so the cache layout is
 * measured without a vendor call. It speaks enough of /v1/messages for an agent run: it reads the request's blocks in the
 * API's order (tools, system, messages), hashes the prefix up to every `cache_control` block, keeps entries for five
 * minutes of (fake) time, looks back at most 20 blocks from a breakpoint, ignores prefixes under 1,024 tokens (characters
 * divided by four) and refuses a request with more than four breakpoints. It answers `usage` as the API does:
 * `input_tokens` is the tail after the last breakpoint, `cache_read_input_tokens` and `cache_creation_input_tokens` beside it.
 * Time is `Date.now()`, so a test that fakes the clock moves the cache's expiry with it. No prompt text is kept: only counts.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CACHE_TTL_MS = 5 * 60_000;
export const MIN_CACHEABLE_TOKENS = 1024;
export const LOOKBACK_BLOCKS = 20;

export interface FakeCachedCall {
  breakpoints: number;
  cacheRead: number;
  cacheWrite: number;
  uncachedInput: number;
  output: number;
  /** The request body as it came, for a test that checks its shape (it holds prompt text: never write it anywhere). */
  body: unknown;
}

export type FakeReply = { content: unknown[]; stopReason?: 'end_turn' | 'tool_use' };

type Block = { cache_control?: unknown } & Record<string, unknown>;

const tokensOf = (json: string) => Math.ceil(json.length / 4);

/** Every block of a request in cache order, with its JSON (without `cache_control`, which is not part of the key). */
function flatten(body: { tools?: Block[]; system?: string | Block[]; messages?: { role: string; content: string | Block[] }[] }): { json: string; mark: boolean }[] {
  const out: { json: string; mark: boolean }[] = [];
  const add = (block: Block) => {
    const { cache_control: mark, ...rest } = block;
    out.push({ json: JSON.stringify(rest), mark: Boolean(mark) });
  };
  for (const tool of body.tools ?? []) add(tool);
  if (typeof body.system === 'string') add({ type: 'text', text: body.system });
  else for (const block of body.system ?? []) add(block);
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') add({ role: message.role, type: 'text', text: message.content });
    else for (const block of message.content) add({ role: message.role, ...block });
  }
  return out;
}

export async function startFakeAnthropicCache(respond: (call: { n: number; body: any }) => FakeReply) {
  const entries = new Map<string, number>();
  const calls: FakeCachedCall[] = [];
  const state: { rewrite?: (body: any) => any } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) return send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
      const sent = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // A test may rewrite what arrived before it is read (to send the base layout's shape).
      const body = state.rewrite ? state.rewrite(sent) : sent;
      const blocks = flatten(body);
      const marks = blocks.flatMap((b, i) => (b.mark ? [i] : []));
      if (marks.length > 4) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'A maximum of 4 blocks with cache_control may be provided.' } });
      const now = Date.now();
      const hash = createHash('sha256');
      const keys: string[] = [];
      const cumulative: number[] = [];
      let total = 0;
      for (const b of blocks) {
        hash.update(b.json);
        keys.push(hash.copy().digest('hex'));
        total += tokensOf(b.json);
        cumulative.push(total);
      }
      // A hit: from each breakpoint, the nearest earlier entry within the lookback; the longest hit wins.
      let readAt = -1;
      for (const mark of marks) {
        for (let p = mark; p >= 0 && p > mark - LOOKBACK_BLOCKS; p--) {
          const expires = entries.get(keys[p]!);
          if (expires !== undefined && expires > now && cumulative[p]! >= MIN_CACHEABLE_TOKENS) {
            readAt = Math.max(readAt, p);
            break;
          }
        }
      }
      const cacheRead = readAt >= 0 ? cumulative[readAt]! : 0;
      const last = marks.at(-1);
      const lastTokens = last === undefined ? 0 : cumulative[last]!;
      for (const mark of marks) if (cumulative[mark]! >= MIN_CACHEABLE_TOKENS) entries.set(keys[mark]!, now + CACHE_TTL_MS);
      const cached = lastTokens >= MIN_CACHEABLE_TOKENS ? lastTokens : 0;
      const cacheWrite = Math.max(0, cached - cacheRead);
      const reply = respond({ n: calls.length, body });
      const output = 20;
      const usage = { input_tokens: total - Math.max(cached, cacheRead), output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
      calls.push({ breakpoints: marks.length, cacheRead, cacheWrite, uncachedInput: usage.input_tokens, output, body });
      send(200, { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: body.model, content: reply.content, stop_reason: reply.stopReason ?? (reply.content.some((c) => (c as { type?: string }).type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null, usage });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    state,
    /** Forget every cache entry and every call (a new scenario). */
    reset() {
      entries.clear();
      calls.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
