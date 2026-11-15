/**
 * Anthropic's own count (`POST /v1/messages/count_tokens`, free, with its own rate limit): the prompt's tools, system
 * segments and message segments are counted as cumulative prefixes in prompt order, and a part is the difference of
 * two consecutive counts. Each prefix is counted once (cached by the keyed hash of its request, never its text), so an
 * agent loop whose prefix only grows costs one or two count requests per iteration.
 *
 * The draft holds texts, not the request's structure: the count request is the tools, the system segments as text
 * blocks and the message segments as text blocks of one `user` message (a prefix with no message yet carries a fixed
 * one-character user message, subtracted as the baseline). What the real request adds beyond that (roles, tool_use and
 * tool_result framing, the tool-use preamble) lands in `formatting`.
 *
 * Count requests are not model calls: never metered, never traced as `gen_ai.*`, and made after the response, never on
 * the call's path. A failed one, or one over the per-minute budget, leaves the call an estimate.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHmac } from 'node:crypto';
import { envWithAliases } from '../../config';
import { credentials } from '../../credentials/vault';
import { isGatewayCredential } from '../../llm-gateway/settings';
import { singleton } from '../../singleton';
import { logger } from '../../telemetry/logger';
import type { DraftSegment } from '../call-context';
import type { Counter, CountCall } from './index';

const CACHE_ENTRIES = 2000;
const WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** The user message a prefix with no message yet carries. It is one token under any tokenizer of the family. */
const BASELINE_TEXT = '.';
const BASELINE_TOKENS = 1;

interface State {
  /** request hash → input tokens (insertion order = least recently used first). */
  counted: Map<string, number>;
  /** credential key → times of the count requests made in the last minute. */
  sent: Map<string, number[]>;
}
const state = singleton('ai-count-anthropic', (): State => ({ counted: new Map(), sent: new Map() }));

export function clearAnthropicCountState(): void {
  state.counted.clear();
  state.sent.clear();
}

/** Count requests allowed per minute for one credential: LANDFLOW_AI_PARTS_COUNT_PER_MINUTE, default 50. */
export const countsPerMinute = (): number => {
  const raw = envWithAliases('LANDFLOW_AI_PARTS_COUNT_PER_MINUTE');
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 50;
};

type Block = { type: 'text'; text: string };
interface CountRequest {
  system?: Block[];
  tools?: unknown[];
  messages: Array<{ role: 'user'; content: Block[] }>;
}

const block = (text: string): Block => ({ type: 'text', text });

/** One step of the walk: a request, and the segment its difference from the step before belongs to. */
interface Step {
  request: CountRequest;
  /** Index into the draft's segments that takes this step's tokens. */
  segment: number;
  /** Tokens already inside the previous request that this step replaces (the baseline message). */
  replaces: number;
}

/** The count requests of a draft, in prompt order. Undefined when a tool's text is not the JSON the adapter sends. */
function plan(segments: DraftSegment[]): { base: CountRequest; steps: Step[] } | undefined {
  const baseline: CountRequest['messages'] = [{ role: 'user', content: [block(BASELINE_TEXT)] }];
  const base: CountRequest = { messages: baseline };
  const steps: Step[] = [];
  const toolIndexes: number[] = [];
  const tools: unknown[] = [];
  segments.forEach((segment, index) => {
    if (segment.where !== 'tools' || !segment.text) return;
    toolIndexes.push(index);
    tools.push(undefined);
  });
  try {
    toolIndexes.forEach((index, i) => (tools[i] = JSON.parse(segments[index]!.text)));
  } catch {
    return undefined;
  }
  if (tools.some((tool) => !tool || typeof tool !== 'object')) return undefined;
  const withTools = tools.length ? { tools } : {};
  if (toolIndexes.length) steps.push({ request: { ...withTools, messages: baseline }, segment: toolIndexes[0]!, replaces: 0 });

  const system: Block[] = [];
  segments.forEach((segment, index) => {
    if (segment.where !== 'system' || !segment.text) return;
    system.push(block(segment.text));
    steps.push({ request: { ...withTools, system: [...system], messages: baseline }, segment: index, replaces: 0 });
  });

  // Consecutive message segments of one part are one step: a long history costs one request, not one per turn.
  const content: Block[] = [];
  let first = true;
  segments.forEach((segment, index) => {
    if (segment.where !== 'messages' || !segment.text) return;
    content.push(block(segment.text));
    const next = segments.slice(index + 1).find((s) => s.where === 'messages' && s.text);
    if (next && next.part === segment.part) return;
    steps.push({ request: { ...withTools, ...(system.length && { system: [...system] }), messages: [{ role: 'user', content: [...content] }] }, segment: groupStart(segments, index), replaces: first ? BASELINE_TOKENS : 0 });
    first = false;
  });
  return { base, steps };
}

/** The first segment of the run of message segments of one part that ends at `end`. */
function groupStart(segments: DraftSegment[], end: number): number {
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    const s = segments[i]!;
    if (s.where !== 'messages' || !s.text) continue;
    if (s.part !== segments[end]!.part) break;
    start = i;
  }
  return start;
}

const requestKey = (key: Buffer, model: string, request: CountRequest): string => createHmac('sha256', key).update(model).update('\0').update(JSON.stringify(request)).digest('hex');

async function clientFor(call: CountCall): Promise<Anthropic | undefined> {
  const row = call.db.get<{ credential_id: string | null }>('SELECT credential_id FROM ai_usage WHERE id = ?', call.usageId);
  if (!row) return undefined; // no row, no credential to count with
  const credentialId = row.credential_id ?? undefined;
  if (!credentialId) return new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }); // the SDK's own resolution, as anthropicModel does
  const data = await credentials.dataWithSecrets({ id: credentialId, name: credentialId }, 'core.anthropicApi');
  if (isGatewayCredential(data)) return undefined; // a LiteLLM gateway counts locally, not with Anthropic's tokenizer
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
  const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl.trim() : '';
  return apiKey ? new Anthropic({ apiKey, ...(baseUrl && { baseURL: baseUrl }), timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }) : new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
}

/** Reserve `n` count requests of the credential's per-minute budget; false when they do not fit (nothing is reserved). */
function reserve(credential: string, n: number, now = Date.now()): boolean {
  const recent = (state.sent.get(credential) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length + n > countsPerMinute()) {
    state.sent.set(credential, recent);
    return false;
  }
  for (let i = 0; i < n; i++) recent.push(now);
  state.sent.set(credential, recent);
  return true;
}

export const anthropicCounter: Counter = {
  method: 'provider',
  async count(call, draft) {
    const walk = plan(draft.segments);
    if (!walk) return undefined;
    const { base, steps } = walk;
    const requests = [base, ...steps.map((s) => s.request)];
    const keys = requests.map((r) => requestKey(call.key, call.model, r));
    const missing = [...new Set(keys.filter((k) => !state.counted.has(k)))];
    // The client first: a call with no `ai_usage` row, or on a gateway credential, is not counted and uses none of the budget.
    const client = await clientFor(call);
    if (!client) return undefined;
    if (missing.length) {
      const credential = call.db.get<{ credential_id: string | null }>('SELECT credential_id FROM ai_usage WHERE id = ?', call.usageId)?.credential_id ?? 'default';
      if (!reserve(credential, missing.length)) {
        logger.info('a model call stays an estimate: its count requests are over the per-minute budget');
        return undefined;
      }
    }
    const values = new Map<string, number>();
    for (const [i, request] of requests.entries()) {
      const key = keys[i]!;
      let tokens = state.counted.get(key) ?? values.get(key);
      if (tokens === undefined) {
        const reply = await client.beta.messages.countTokens({ model: call.model, ...request } as Anthropic.Beta.Messages.MessageCountTokensParams);
        tokens = reply.input_tokens;
        values.set(key, tokens);
        state.counted.set(key, tokens);
        while (state.counted.size > CACHE_ENTRIES) state.counted.delete(state.counted.keys().next().value as string);
      } else {
        state.counted.delete(key);
        state.counted.set(key, tokens);
      }
    }
    const counts = keys.map((k) => state.counted.get(k) ?? values.get(k)!);
    const perSegment = new Array<number>(draft.segments.length).fill(0);
    const baseline = counts[0]!;
    let before = baseline;
    steps.forEach((step, i) => {
      const total = counts[i + 1]!;
      perSegment[step.segment]! += Math.max(0, total - before + step.replaces);
      before = total;
    });
    return perSegment;
  },
};
