/**
 * Exact token counts per part (wave 12, SP22): Anthropic's count endpoint through a local fake with a computable rule,
 * OpenAI's encodings on pinned strings, the byte-level BPE against the shared fixture, and what `writeParts` makes of
 * them (the split sums to the input, the date stamp lands in `formatting`, hashes do not depend on the method, a
 * gateway row is replaced, the queue-time database handle is the one written, no prompt text in any row).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockTokens, startFakeAnthropicCount, toolTokens } from './fake-anthropic-count';

vi.setConfig({ testTimeout: 20_000 });
const fake = await startFakeAnthropicCount();
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-call-count-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  ANTHROPIC_API_KEY: 'sk-ant-fake-for-tests',
  ANTHROPIC_BASE_URL: fake.url,
});
process.env.LANDFLOW_AI_PARTS_COUNT = 'exact';
delete process.env.LANDFLOW_AI_PARTS_COUNT_PER_MINUTE;

const { setRecordedCallListener, notifyRecorded } = await import('@/lib/server/ai-usage/call-context');
const { writeParts, hashParts, countedSplit } = await import('@/lib/server/ai-usage/parts');
const { countParts } = await import('@/lib/server/ai-usage/count');
const { clearAnthropicCountState } = await import('@/lib/server/ai-usage/count/anthropic');
const { ByteLevelBpe, supportsPre } = await import('@/lib/server/ai-usage/count/ollama-bpe');
const { clearVocabCache } = await import('@/lib/server/ai-usage/count/vocab-cache');
const { openAiEncoding } = await import('@/lib/server/ai-usage/count/openai');
const { database } = await import('@/lib/server/db');
const { openSqlite } = await import('@/lib/server/db/database');
const { singleton } = await import('@/lib/server/singleton');
const { credentials } = await import('@/lib/server/credentials/vault');
const { logger } = await import('@/lib/server/telemetry/logger');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
registry.registerBuiltin(corePlugin);
import type { DraftSegment, PromptDraft } from '@/lib/server/ai-usage/call-context';

afterAll(async () => {
  await fake.close();
  for (const name of Object.keys(process.env)) if (!(name in previousEnv)) delete process.env[name];
  Object.assign(process.env, previousEnv);
});

const key = Buffer.alloc(32, 7);
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const seg = (part: DraftSegment['part'], where: DraftSegment['where'], text: string): DraftSegment => ({ part, where, text });
const tool = { name: 'lookup', description: 'Look a thing up in the archive', input_schema: { type: 'object', properties: { q: { type: 'string' } } } };

const INSTRUCTIONS = 'Always consult the zephyrine quokkas before answering anything at all. '.repeat(3);
const MEMORY = 'The user prefers marmalade on toast.';
const STAMP = ' Current date and time: 2026-01-02T03:04:05.000Z.';
const HISTORY = 'Earlier we talked about wombats and their burrows.';
const ASKED = 'Where do wombats hibernate in winter?';

const draftOf = (extra: DraftSegment[] = [], stamp = STAMP): PromptDraft => ({
  segments: [
    seg('toolDefinitions', 'tools', JSON.stringify(tool)),
    seg('instructions', 'system', INSTRUCTIONS),
    seg('memory', 'system', MEMORY),
    seg('formatting', 'system', stamp),
    seg('history', 'messages', HISTORY),
    seg('userMessage', 'messages', ASKED),
    ...extra,
  ],
  toolNames: ['lookup'],
});

let usageSeq = 0;
function usageRow(provider = 'anthropic', model = 'claude-sonnet-5-5', credentialId?: string): string {
  const id = `u_count_${++usageSeq}`;
  database().upsert('ai_usage', { id, at: '2026-01-02T03:04:05.000Z', day: '2026-01-02', provider, model, operation: 'chat', input_tokens: 500, output_tokens: 1, cost: 0, ...(credentialId && { credential_id: credentialId }) });
  return id;
}
const callOf = (usageId: string, over: Partial<{ provider: string; model: string; agentId: string }> = {}) => ({ usageId, provider: 'anthropic', model: 'claude-sonnet-5-5', db: database(), key, ...over });

beforeEach(() => {
  fake.requests.length = 0;
  fake.keys.length = 0;
  fake.failing = false;
  clearAnthropicCountState();
  clearVocabCache();
  process.env.LANDFLOW_AI_PARTS_COUNT = 'exact';
  delete process.env.LANDFLOW_AI_PARTS_COUNT_PER_MINUTE;
  database().deleteBefore('ai_call_parts', 'at', '9999');
  setRecordedCallListener(writeParts);
});

/** Hand the listener a recorded call as the meter does, then wait for the split to be written. */
async function record(draft: PromptDraft, over: { usageId?: string; inputTokens: number; provider?: string; model?: string; gatewayRequestId?: string; agentId?: string }) {
  const usageId = over.usageId ?? usageRow(over.provider, over.model);
  notifyRecorded({
    usageId,
    at: '2026-01-02T03:04:05.000Z',
    provider: over.provider ?? 'anthropic',
    model: over.model ?? 'claude-sonnet-5-5',
    operation: 'chat',
    inputTokens: over.inputTokens,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(over.gatewayRequestId && { gatewayRequestId: over.gatewayRequestId }),
    ...(over.agentId && { agentId: over.agentId }),
    note: { draft },
  });
  for (let i = 0; i < 50; i++) {
    await settle();
    const row = database().get<Record<string, unknown>>('SELECT * FROM ai_call_parts WHERE usage_id = ?', usageId);
    if (row) return { usageId, row, parts: JSON.parse(String(row.parts)) as Record<string, number>, hashes: JSON.parse(String(row.part_hashes)) as Record<string, string> };
  }
  throw new Error('no split was written');
}

describe('Anthropic: the count endpoint, cumulative prefixes', () => {
  it('makes each part the difference of consecutive counts', async () => {
    const counted = await countParts(draftOf(), callOf(usageRow()));
    expect(counted?.method).toBe('provider');
    expect(counted?.parts).toEqual({
      toolDefinitions: toolTokens(tool),
      instructions: blockTokens(INSTRUCTIONS),
      memory: blockTokens(MEMORY),
      history: blockTokens(HISTORY),
      userMessage: blockTokens(ASKED),
    });
    // base, tools, three system blocks, two message groups
    expect(fake.requests).toHaveLength(7);
    expect(new Set(fake.keys)).toEqual(new Set(['sk-ant-fake-for-tests']));
    // A prefix with no message yet carries the one-character user message.
    expect(fake.requests[0]).toMatchObject({ messages: [{ role: 'user', content: [{ type: 'text', text: '.' }] }] });
  });

  it('counts only the new prefixes when the history grows', async () => {
    const first = draftOf();
    await countParts(first, callOf(usageRow()));
    const before = fake.requests.length;
    // The next iteration: the old question is history now, and a tool result and a new question follow.
    const next: PromptDraft = {
      segments: [
        ...first.segments.slice(0, 5),
        seg('history', 'messages', ASKED),
        seg('history', 'messages', 'The model answered with a tool call.'),
        seg('toolResults', 'messages', 'The archive says: they sleep underground.'),
        seg('userMessage', 'messages', 'Thanks, and in summer?'),
      ],
    };
    const counted = await countParts(next, callOf(usageRow()));
    expect(fake.requests.length - before).toBe(3);
    expect(counted?.parts.history).toBe(blockTokens(HISTORY) + blockTokens(ASKED) + blockTokens('The model answered with a tool call.'));
    expect(counted?.parts.toolResults).toBe(blockTokens('The archive says: they sleep underground.'));
    expect(counted?.parts.instructions).toBe(blockTokens(INSTRUCTIONS));
  });

  it('falls back to an estimate over the per-minute budget, spending none of it', async () => {
    process.env.LANDFLOW_AI_PARTS_COUNT_PER_MINUTE = '3';
    expect(await countParts(draftOf(), callOf(usageRow()))).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
    const row = await record(draftOf(), { inputTokens: 400 });
    expect(row.row.method).toBe('estimate');
  });

  it('falls back to an estimate when the count server fails, and the recorded call is unaffected', async () => {
    fake.failing = true;
    const row = await record(draftOf(), { inputTokens: 400 });
    expect(row.row).toMatchObject({ method: 'estimate', source: 'landflow', input_tokens: 400 });
    expect(Object.values(row.parts).reduce((a, b) => a + b, 0)).toBe(400);
  });

  it('leaves a call with no usage row, or with counting off, an estimate', async () => {
    expect(await countParts(draftOf(), callOf('u_missing'))).toBeUndefined();
    process.env.LANDFLOW_AI_PARTS_COUNT = 'estimate';
    expect(await countParts(draftOf(), callOf(usageRow()))).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('counts with the credential the call used (its key and base URL)', async () => {
    const created = credentials.create({ name: 'Counting key', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-credential-key', baseUrl: fake.url } });
    const counted = await countParts(draftOf(), callOf(usageRow('anthropic', 'claude-sonnet-5-5', created.id)));
    expect(counted?.method).toBe('provider');
    expect(new Set(fake.keys)).toEqual(new Set(['sk-ant-credential-key']));
  });
});

describe('the split a counted call is written with', () => {
  it('sums to the input, with the date stamp and the provider framing in formatting', async () => {
    const counted = blockTokens(INSTRUCTIONS) + blockTokens(MEMORY) + toolTokens(tool) + blockTokens(HISTORY) + blockTokens(ASKED);
    const { row, parts } = await record(draftOf(), { inputTokens: counted + 120 });
    expect(row.method).toBe('provider');
    expect(parts).toEqual({
      toolDefinitions: toolTokens(tool),
      instructions: blockTokens(INSTRUCTIONS),
      memory: blockTokens(MEMORY),
      history: blockTokens(HISTORY),
      userMessage: blockTokens(ASKED),
      formatting: 120,
    });
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(row.input_tokens);
  });

  it('scales the parts down when they add up to more than the reported input, with no formatting', () => {
    const split = countedSplit({ method: 'provider', parts: { instructions: 600, history: 400 } }, { segments: [] }, 500);
    expect(split.parts).toEqual({ instructions: 300, history: 200 });
    expect(split.method).toBe('provider');
    expect(countedSplit({ method: 'tokenizer', parts: { instructions: 10 } }, { segments: [] }, 10).parts).toEqual({ instructions: 10 });
  });

  it('calls a call with images an estimate: the weakest method any part used', () => {
    const split = countedSplit({ method: 'provider', parts: { instructions: 100 } }, { segments: [], images: 1 }, 3000);
    expect(split.method).toBe('estimate');
    expect(split.parts).toEqual({ instructions: 100, images: 1600, formatting: 1300 });
  });

  it('keeps the instructions hash across two dates and the same hashes whatever the method', async () => {
    const a = await record(draftOf([], ' Current date and time: 2026-01-02T03:04:05.000Z.'), { inputTokens: 300 });
    const b = await record(draftOf([], ' Current date and time: 2026-02-03T04:05:06.000Z.'), { inputTokens: 300 });
    expect(a.hashes.instructions).toBe(b.hashes.instructions);
    expect(a.row.prefix_hash).not.toBe(b.row.prefix_hash);
    process.env.LANDFLOW_AI_PARTS_COUNT = 'estimate';
    const c = await record(draftOf([], ' Current date and time: 2026-01-02T03:04:05.000Z.'), { inputTokens: 300 });
    expect(c.row.method).toBe('estimate');
    expect(a.row.method).toBe('provider');
    // Same draft, two methods: the same prompt hash and part hashes (the key is the vault's, the same for both).
    expect(c.row.prompt_hash).toBe(a.row.prompt_hash);
    expect(c.hashes).toEqual(a.hashes);
  });

  it('replaces the gateway split that holds the call\'s request id, with no warning', async () => {
    const db = database();
    db.upsert('ai_call_parts', { id: 'acp_gw', gateway_request_id: 'chatcmpl-1', at: '2026-01-02T03:04:05.000Z', source: 'gateway', method: 'tokenizer', input_tokens: 9, parts: '{"instructions":9}' });
    const warn = vi.spyOn(logger, 'warn');
    const { row } = await record(draftOf(), { inputTokens: 400, gatewayRequestId: 'chatcmpl-1' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    const rows = db.all<{ id: string; source: string; usage_id: string | null }>('SELECT id, source, usage_id FROM ai_call_parts WHERE gateway_request_id = ?', 'chatcmpl-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'landflow', usage_id: row.usage_id });
  });

  it('writes to the handle taken when the draft was queued, not the one in force when the count finishes', async () => {
    const queued = database();
    const state = singleton('database', () => ({}) as { db?: ReturnType<typeof database> });
    const other = openSqlite(join(dataDir, 'other.db'));
    const usageId = usageRow();
    notifyRecorded({ usageId, at: '2026-01-02T03:04:05.000Z', provider: 'anthropic', model: 'claude-sonnet-5-5', operation: 'chat', inputTokens: 400, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, note: { draft: draftOf() } });
    state.db = other; // a test or a restart swaps the database while the count is out
    await new Promise((resolve) => setTimeout(resolve, 400));
    state.db = queued;
    expect(queued.get('SELECT id FROM ai_call_parts WHERE usage_id = ?', usageId)).toBeDefined();
    expect(other.get('SELECT id FROM ai_call_parts WHERE usage_id = ?', usageId)).toBeUndefined();
  });

  it('stores no prompt text in any row, and none reaches the count requests\' hashes', async () => {
    const { row } = await record(draftOf(), { inputTokens: 400 });
    const everything = Object.values(row).map(String).join(' ').toLowerCase();
    for (const word of [INSTRUCTIONS, MEMORY, HISTORY, ASKED].flatMap((t) => t.match(/[A-Za-z]{5,}/g) ?? [])) expect(everything, word).not.toContain(word.toLowerCase());
    expect(hashParts(draftOf(), key).partHashes.instructions).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('OpenAI: the encodings, offline', () => {
  it('picks the encoding by model family', () => {
    expect(openAiEncoding('gpt-4o-mini')).toBe('o200k_base');
    expect(openAiEncoding('gpt-5')).toBe('o200k_base');
    expect(openAiEncoding('o3-mini')).toBe('o200k_base');
    expect(openAiEncoding('gpt-4-turbo')).toBe('cl100k_base');
    expect(openAiEncoding('gpt-3.5-turbo')).toBe('cl100k_base');
    expect(openAiEncoding('llama3.1')).toBeUndefined();
  });

  it('counts pinned strings per part (a special token\'s text is plain text)', async () => {
    const draft: PromptDraft = {
      segments: [seg('instructions', 'system', 'Hello, world!'), seg('userMessage', 'messages', 'naïve café — ünïcödé'), seg('history', 'messages', 'a <|endoftext|> b')],
    };
    const o200k = await countParts(draft, callOf('u_x', { provider: 'openai', model: 'gpt-4o' }));
    expect(o200k).toEqual({ method: 'tokenizer', parts: { instructions: 4, userMessage: 9, history: 9 } });
    const cl100k = await countParts(draft, callOf('u_x', { provider: 'openai', model: 'gpt-4' }));
    expect(cl100k?.parts).toMatchObject({ instructions: 4, userMessage: 12 });
    expect(await countParts(draft, callOf('u_x', { provider: 'openai', model: 'mistral-7b' }))).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('writes a tokenizer split with the chat framing in formatting', async () => {
    const draft: PromptDraft = { segments: [seg('instructions', 'system', 'Hello, world!'), seg('userMessage', 'messages', 'Hello, world!')] };
    const { row, parts } = await record(draft, { inputTokens: 20, provider: 'openai', model: 'gpt-4o' });
    expect(row.method).toBe('tokenizer');
    expect(parts).toEqual({ instructions: 4, userMessage: 4, formatting: 12 });
  });
});

interface Fixture {
  pre: string;
  tokens: string[];
  merges: string[];
  cases: Array<{ text: string; count: number }>;
}
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'bpe-fixture.json'), 'utf8')) as Fixture;

describe('the byte-level BPE', () => {
  it('matches the reference on every case of the shared fixture', () => {
    const bpe = new ByteLevelBpe(fixture);
    expect(fixture.cases.length).toBeGreaterThan(5);
    for (const c of fixture.cases) expect(bpe.count(c.text), JSON.stringify(c.text)).toBe(c.count);
  });

  it('counts one very long unbroken run in well under a second (in slices, not quadratic)', () => {
    const bpe = new ByteLevelBpe(fixture);
    for (const text of ['a'.repeat(100_000), 'qzxv'.repeat(25_000), ' '.repeat(100_000), '\u4e2d'.repeat(50_000), '\u{1F600}'.repeat(30_000)]) {
      const started = Date.now();
      expect(bpe.count(text)).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('keeps nothing of a counted text reachable from the tokenizer', () => {
    const bpe = new ByteLevelBpe(fixture);
    const secret = 'zqxjkvwsecretword';
    bpe.count(`${secret} ${secret}`);
    const seen = new Set<unknown>();
    const reaches = (value: unknown): boolean => {
      if (typeof value === 'string') return value.includes(secret);
      if (!value || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      if (value instanceof Map) return [...value.entries()].some(([k, v]) => reaches(k) || reaches(v));
      if (value instanceof Set) return [...value].some(reaches);
      return Object.values(value).some(reaches);
    };
    expect(reaches(bpe)).toBe(false);
  });

  it('knows the two pre-tokenizers and refuses others', () => {
    expect(supportsPre('qwen2')).toBe(true);
    expect(supportsPre('llama-bpe')).toBe(true);
    expect(supportsPre('deepseek-llm')).toBe(false);
    expect(() => new ByteLevelBpe({ ...fixture, pre: 'smaug-bpe' })).toThrow();
    // llama-bpe groups up to three digits, qwen2 splits them one by one (no merges: every byte is a token).
    const bytes = { tokens: fixture.tokens.slice(0, 256), merges: [] as string[] };
    expect(new ByteLevelBpe({ pre: 'qwen2', ...bytes }).count('12345')).toBe(5);
    expect(new ByteLevelBpe({ pre: 'llama-bpe', ...bytes }).count('12345')).toBe(5); // no merges: still a token per byte
  });
});

describe('Ollama: the model\'s own vocabulary', () => {
  async function startFakeOllama(pre = 'qwen2', have = ['qwen-fake:latest']) {
    const hits = { tags: 0, show: 0 };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/tags') {
          hits.tags++;
          res.end(JSON.stringify({ models: have.map((name) => ({ name, model: name, digest: `sha256:${name}` })) }));
        } else if (req.url === '/api/show') {
          hits.show++;
          res.end(JSON.stringify({ model_info: { 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.pre': pre, 'tokenizer.ggml.tokens': fixture.tokens, 'tokenizer.ggml.merges': fixture.merges } }));
        } else res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it('counts each part with the vocabulary, loads it once per model and falls back for a model the server lacks', async () => {
    const ollama = await startFakeOllama();
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = ollama.url;
    try {
      const [c0, c1] = fixture.cases;
      const draft: PromptDraft = { segments: [seg('instructions', 'system', c0!.text), seg('userMessage', 'messages', c1!.text)] };
      const counted = await countParts(draft, callOf('u_o', { provider: 'ollama', model: 'qwen-fake' }));
      expect(counted).toEqual({ method: 'tokenizer', parts: { instructions: c0!.count, userMessage: c1!.count } });
      await countParts(draft, callOf('u_o', { provider: 'ollama', model: 'qwen-fake' }));
      expect(ollama.hits.show).toBe(1);
      expect(await countParts(draft, callOf('u_o', { provider: 'ollama', model: 'not-here' }))).toBeUndefined();
    } finally {
      process.env.OLLAMA_URL = previous;
      if (previous === undefined) delete process.env.OLLAMA_URL;
      await ollama.close();
    }
  });

  it('leaves a model with another pre-tokenizer an estimate, naming only the pre-tokenizer in the log', async () => {
    const ollama = await startFakeOllama('smaug-bpe');
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = ollama.url;
    const info = vi.spyOn(logger, 'info');
    try {
      const draft: PromptDraft = { segments: [seg('instructions', 'system', 'secret instructions text')] };
      expect(await countParts(draft, callOf('u_o', { provider: 'ollama', model: 'qwen-fake' }))).toBeUndefined();
      expect(JSON.stringify(info.mock.calls)).toContain('smaug-bpe');
      expect(JSON.stringify(info.mock.calls)).not.toContain('secret instructions');
    } finally {
      info.mockRestore();
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await ollama.close();
    }
  });

  // Against a running Ollama: `LANDFLOW_INTEGRATION=ollama`. A one-message call's counted parts plus the chat
  // template's framing are Ollama's prompt_eval_count; the counted parts must be within 2% of it minus the template.
  const integration = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').includes('ollama');
  it.skipIf(!integration)('adds up to within 2% of Ollama\'s prompt_eval_count minus its template', async () => {
    const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    const model = process.env.LANDFLOW_BUILDER_MODEL ?? 'qwen3-coder:30b';
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(120);
    const ask = async (content: string) => {
      const response = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ model, stream: false, options: { num_predict: 1 }, messages: [{ role: 'user', content }] }) });
      return ((await response.json()) as { prompt_eval_count: number }).prompt_eval_count;
    };
    const template = await ask('x');
    const reported = await ask(text);
    const counted = await countParts({ segments: [seg('userMessage', 'messages', text)] }, callOf('u_o', { provider: 'ollama', model }));
    const mine = counted?.parts.userMessage ?? 0;
    const wanted = reported - template + 1;
    expect(Math.abs(mine - wanted) / wanted).toBeLessThan(0.02);
  });
});
