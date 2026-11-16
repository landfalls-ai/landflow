/**
 * The agent prompt's cache layout (wave 12, SP19; docs/agents.md#prompt-cache): the stable part of the system prompt
 * carries the cache point, the memory, the intro line and the date stamp come after it, the conversation gets a
 * breakpoint, memory is read once per run. The measurement runs one agent (persona, skills, cross-session memory, five
 * tools; a four-iteration run with a `remember` in it, then a second run) against a fake Anthropic that simulates prompt
 * caching, on base's layout and on the new one, and prints both. It asserts the direction, not the numbers. No vendor call.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel } from '@landflow/engine';
import type { Agent, AgentConfig } from '@/lib/shared/agents';
import type { RunContext } from '@/lib/shared/project-context';
import { startFakeAnthropicCache, type FakeReply } from './fake-anthropic-cache';
import { startFakeOpenAi } from './fake-openai';

vi.setConfig({ testTimeout: 30_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-cache-layout-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

let layout: 'base' | 'new' = 'new';
let fakeUrl = '';
let memoryAtStart: string | undefined;

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: async (config: { model?: string } | undefined): Promise<LanguageModel> => {
    const { anthropicModel } = await import('@/lib/server/nodes/models');
    const inner = anthropicModel({ model: config?.model ?? 'claude-sonnet-test', effort: 'medium', maxTokens: 1000, fallback: false, promptCache: true, apiKey: 'sk-test', baseUrl: fakeUrl });
    return {
      provider: 'anthropic',
      model: inner.model,
      async generate(input) {
        if (layout === 'new') return inner.generate(input);
        // Base read the memory on every iteration: put today's notes in place of the ones the run started with.
        const { agentStore } = await import('@/lib/server/agents/store');
        const { memoryBlock } = await import('@/lib/server/agents/runtime');
        const current = agentRef ? memoryBlock(agentRef, configRef!, sessionRef!) : undefined;
        if (input.messages.length === 1) memoryAtStart = input.system?.includes('## What you remember') ? current : undefined;
        const system = input.system && memoryAtStart && current ? input.system.replace(memoryAtStart, current) : input.system;
        if (input.messages.length === 1 && current) memoryAtStart = current;
        const { systemCacheBreak: _drop, ...rest } = input;
        void _drop;
        return inner.generate({ ...rest, ...(system !== undefined && { system }) });
      },
    };
  },
}));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent, systemPromptParts, configFor } = await import('@/lib/server/agents/runtime');
const persona = await import('@/lib/shared/persona');
const { withPractices } = await import('@/lib/server/project-context/practices');
const { agentDraft } = await import('@/lib/server/ai-usage/drafts');
const { hashParts } = await import('@/lib/server/ai-usage/parts');
const { personaPrompt, personaPromptParts } = await import('@/lib/shared/persona');
const { anthropicModel, toAnthropicMessages, withMessageBreakpoint, openAiModel, openAiConnection, ollamaModel } = await import('@/lib/server/nodes/models');

let agentRef: Agent | undefined;
let configRef: AgentConfig | undefined;
let sessionRef: ReturnType<typeof newSession> | undefined;

const key = Buffer.alloc(32, 7);
const AT = '2026-01-02T03:04:05.000Z';
const node = (name: string) => ({ id: `t_${name}`, type: 'node' as const, name, description: `${name}: hands the input back unchanged, a tool for the cache measurement`, nodeType: 'core.noOp', parameters: {} });
const PERSONA_TEXT = 'Be a careful, thorough helper who explains each step of the work and keeps a record of what was decided. '.repeat(45);

function agentOf(config: Partial<AgentConfig> = {}): Agent {
  return agentStore.create({ name: 'Helper', instructions: 'Be brief.', model: { provider: 'anthropic', model: 'claude-sonnet-test' }, ...config });
}
const sessionOf = (agent: Agent) => newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
const ctx = (over: Partial<RunContext> = {}): RunContext => ({ mode: 'off', text: '', compact: '', line: '', hash: '', at: AT, ...over });

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
});
afterAll(() => {
  process.env = previousEnv;
});

describe('personaPromptParts', () => {
  it('cuts the prompt into a stable part and a volatile part that make the same string', () => {
    const agent = agentOf({ description: 'Helps', skills: [{ id: 's1', name: 'triage', whenToUse: 'when asked', instructions: 'steps' }] });
    const config = configFor(agent, 'draft');
    for (const run of [{}, { memory: '## Memory\n- tea' }, { context: '## Where this work fits\nP', memory: '## Memory\n- tea', now: new Date(AT) }, { context: '## Where this work fits\nP', now: new Date(AT) }]) {
      const { stable, volatile } = personaPromptParts(config, run);
      expect(stable + volatile).toBe(personaPrompt(config, run));
      expect(volatile.startsWith('\n\n')).toBe(true);
      expect(stable.endsWith('\n\n')).toBe(false);
    }
    const { stable, volatile } = personaPromptParts(config, { context: 'BLOCK', memory: 'MEM', now: new Date(AT) });
    expect(stable.endsWith('BLOCK')).toBe(true);
    expect(volatile).toBe(`\n\nMEM\n\nYou are “Helper”: Helps. Current date and time: ${AT}.`);
  });
});

describe('the draft and its hashes', () => {
  const hashesOf = (agent: Agent, run: RunContext, extra?: string, memoryText?: string) => {
    const out = systemPromptParts(agent, configFor(agent, 'draft'), sessionOf(agent), run, extra, memoryText);
    const draft = agentDraft({ systemSegments: out.segments, tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }], cache: true });
    return { out, draft, hashes: hashParts(draft, key) };
  };
  const block = (text: string) => withPractices(ctx({ mode: 'full', text, hash: 'h', practices: [] }), { text: '## Practices\n- use helm', practices: [{ handle: 'helm/x', version: 1 }] });

  it('marks the last stable segment and puts the memory, the intro line and the date after it', () => {
    const agent = agentOf({ description: 'Helps', memory: { crossSession: true } as AgentConfig['memory'] });
    agentStore.remember(agent.id, 'you', 'likes tea');
    const { out, draft } = hashesOf(agent, block('## Where this work fits\nProject P'));
    expect(out.segments.map((s) => s.part)).toEqual(['instructions', 'projectBlock', 'practices', 'instructions', 'memory', 'instructions', 'formatting']);
    expect(out.segments.map((s) => Boolean(s.breakpoint))).toEqual([false, false, true, false, false, false, false]);
    expect(out.segments.slice(0, 3).map((s) => s.text).join('').length).toBe(out.cacheBreak);
    expect(out.text.slice(out.cacheBreak).startsWith('\n\n## What you remember')).toBe(true);
    expect(draft.segments.filter((s) => s.breakpoint).map((s) => s.where)).toEqual(['tools', 'system']);
    expect(draft.segments.some((s) => s.where === 'messages' && s.breakpoint)).toBe(false);
  });

  it('keeps the prefix hash across dates and memory, and changes it with the instructions, a tool, the block or the practices', () => {
    const agent = agentOf({ description: 'Helps', memory: { crossSession: true } as AgentConfig['memory'] });
    agentStore.remember(agent.id, 'you', 'likes tea');
    const a = hashesOf(agent, { ...block('## Where this work fits\nProject P'), at: '2026-01-02T03:04:05.000Z' });
    const b = hashesOf(agent, { ...block('## Where this work fits\nProject P'), at: '2026-03-04T05:06:07.000Z' }, undefined, '## What you remember about this user\n- likes coffee\nUse the remember tool for durable facts worth knowing next time.');
    expect(b.hashes.prefixHash).toBe(a.hashes.prefixHash);
    expect(b.hashes.promptHash).not.toBe(a.hashes.promptHash);
    expect(b.hashes.partHashes.memory).not.toBe(a.hashes.partHashes.memory);
    expect(b.hashes.partHashes.instructions).toBe(a.hashes.partHashes.instructions);
    // What does change the prefix.
    const other = agentOf({ instructions: 'Be verbose.', description: 'Helps', memory: { crossSession: true } as AgentConfig['memory'] });
    expect(hashesOf(other, block('## Where this work fits\nProject P')).hashes.prefixHash).not.toBe(a.hashes.prefixHash);
    expect(hashesOf(agent, block('## Where this work fits\nProject Q')).hashes.prefixHash).not.toBe(a.hashes.prefixHash);
    const changedPractice = withPractices(ctx({ mode: 'full', text: '## Where this work fits\nProject P', hash: 'h', practices: [] }), { text: '## Practices\n- use kubectl', practices: [{ handle: 'k/x', version: 1 }] });
    expect(hashesOf(agent, changedPractice).hashes.prefixHash).not.toBe(a.hashes.prefixHash);
    const tools = (name: string) => hashParts(agentDraft({ systemSegments: a.out.segments, tools: [{ name, description: 'Echo', inputSchema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }], cache: true }), key).prefixHash;
    expect(tools('echo2')).not.toBe(a.hashes.prefixHash);
  });

  it('gives the instructions the hash main gave them (the intro line joins the rest by hash)', () => {
    const agent = agentOf({ description: 'Helps', memory: { crossSession: true } as AgentConfig['memory'] });
    const { hashes } = hashesOf(agent, ctx());
    const main = hashParts({ segments: [{ part: 'instructions', where: 'system', text: 'Be brief.\n\n\n\nYou are “Helper”: Helps.' }] }, key);
    expect(hashes.partHashes.instructions).toBe(main.partHashes.instructions);
  });

  it('keeps base\'s prompt byte for byte when nothing is stable (no instructions, a half-filled example only)', () => {
    const { personaPrompt, personaPromptParts } = persona;
    const agent = agentOf({ instructions: '', persona: { examples: [{ user: 'only half', assistant: '' }] } as AgentConfig['persona'] });
    const config = configFor(agent, 'draft');
    const now = new Date(AT);
    // Literals as base built them: no separator ahead of the first line.
    expect(personaPrompt(config, { now })).toBe(`You are “Helper”. Current date and time: ${AT}.`);
    expect(personaPrompt(config, { memory: 'MEM', now })).toBe(`MEM\n\nYou are “Helper”. Current date and time: ${AT}.`);
    expect(personaPromptParts(config, { now }).stable).toBe('');
    const out = systemPromptParts(agent, configFor(agent, 'draft'), sessionOf(agent), ctx());
    expect(out.text).toBe(`You are “Helper”. Current date and time: ${AT}.`);
    expect(out.segments.map((s) => s.text).join('')).toBe(out.text);
    expect(out.cacheBreak).toBe(0);
  });

  it('keeps the segments joined equal to the text, with a team member’s tool note after the break', () => {
    const agent = agentOf({ persona: { role: 'Reviewer' } as AgentConfig['persona'] });
    const plain = systemPromptParts(agent, configFor(agent, 'draft'), sessionOf(agent), ctx());
    expect(plain.text).toBe(`## Who you are\nRole: Reviewer.\n\n## Instructions\nBe brief.\n\nYou are “Helper”. Current date and time: ${AT}.`);
    const out = systemPromptParts(agent, configFor(agent, 'draft'), sessionOf(agent), ctx(), 'Tools in this run:\n- echo');
    expect(out.text).toBe(`${plain.text}\n\nTools in this run:\n- echo`);
    expect(out.segments.map((s) => s.text).join('')).toBe(out.text);
    expect(out.segments.at(-1)).toMatchObject({ part: 'toolNote' });
    expect(out.segments.findIndex((s) => s.breakpoint)).toBe(0);
  });
});

describe('the Anthropic request', () => {
  const tool = (name: string) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' as const } });
  const marks = (value: unknown): number => (Array.isArray(value) ? value.reduce((n: number, v) => n + marks(v), 0) : value && typeof value === 'object' ? Object.entries(value).reduce((n, [k, v]) => n + (k === 'cache_control' ? 1 : marks(v)), 0) : 0);

  it('sends two system blocks and a breakpoint on the conversation, three in all', async () => {
    const fake = await startFakeAnthropicCache(() => ({ content: [{ type: 'text', text: 'ok' }] }));
    try {
      const model = anthropicModel({ model: 'claude-sonnet-test', effort: 'medium', maxTokens: 100, fallback: false, promptCache: true, apiKey: 'sk-test', baseUrl: fake.url });
      await model.generate({ system: 'STABLE-PART|VOLATILE-PART', systemCacheBreak: 'STABLE-PART'.length, messages: [{ role: 'user', content: 'hello' }], tools: [tool('a'), tool('b')] });
      const body = fake.calls[0]!.body as { system: { text: string; cache_control?: unknown }[]; tools: { cache_control?: unknown }[]; messages: { content: { cache_control?: unknown }[] }[] };
      expect(body.system.map((b) => b.text)).toEqual(['STABLE-PART', '|VOLATILE-PART']);
      expect(body.system.map((b) => Boolean(b.cache_control))).toEqual([true, false]);
      expect(body.tools.map((t) => Boolean(t.cache_control))).toEqual([false, true]);
      expect(body.messages[0]!.content).toEqual([{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
      expect(fake.calls[0]!.breakpoints).toBe(3);
    } finally {
      await fake.close();
    }
  });

  it('keeps one system block with the break at the old place when no break is given, and nothing with the cache off', async () => {
    const fake = await startFakeAnthropicCache(() => ({ content: [{ type: 'text', text: 'ok' }] }));
    try {
      const on = anthropicModel({ model: 'claude-sonnet-test', effort: 'medium', maxTokens: 100, fallback: false, promptCache: true, apiKey: 'sk-test', baseUrl: fake.url });
      await on.generate({ system: 'SYS', messages: [{ role: 'user', content: 'hello' }], tools: [] });
      expect((fake.calls[0]!.body as { system: unknown[] }).system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
      const off = anthropicModel({ model: 'claude-sonnet-test', effort: 'medium', maxTokens: 100, fallback: false, apiKey: 'sk-test', baseUrl: fake.url });
      await off.generate({ system: 'SYS', systemCacheBreak: 1, messages: [{ role: 'user', content: 'hello' }], tools: [tool('a')] });
      const body = fake.calls[1]!.body as { system: string; messages: { content: unknown }[] };
      expect(body.system).toBe('SYS');
      expect(body.messages[0]!.content).toBe('hello');
      expect(marks(fake.calls[1]!.body)).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it('sends base’s request shape when the fake rewrites the new request back (compared with a literal derived by hand from base’s params)', async () => {
    const fake = await startFakeAnthropicCache(() => ({ content: [{ type: 'text', text: 'ok' }] }));
    fake.state.rewrite = toBase;
    try {
      const model = anthropicModel({ model: 'claude-sonnet-test', effort: 'medium', maxTokens: 100, fallback: false, promptCache: true, apiKey: 'sk-test', baseUrl: fake.url });
      await model.generate({
        system: 'STABLE|VOLATILE',
        systemCacheBreak: 6,
        messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', text: 'calling', toolCalls: [{ id: 'c1', name: 'a', input: { x: 1 } }] }, { role: 'tool', results: [{ id: 'c1', name: 'a', content: 'result' }] }],
        tools: [tool('a')],
      });
      // What base's anthropicModel put in `params` for this input: one system block with the breakpoint, the last tool with one, the messages without.
      const base = {
        model: 'claude-sonnet-test',
        max_tokens: 100,
        system: [{ type: 'text', text: 'STABLE|VOLATILE', cache_control: { type: 'ephemeral' } }],
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'result' }] },
        ],
        tools: [{ name: 'a', description: 'a tool', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: 'medium' },
      };
      expect(fake.calls[0]!.body).toEqual(base);
      expect(marks(fake.calls[0]!.body)).toBe(2);
    } finally {
      await fake.close();
    }
  });

  it('never sends more than four cache_control blocks, over random conversations with tool use and thinking blocks', async () => {
    const fake = await startFakeAnthropicCache(() => ({ content: [{ type: 'text', text: 'ok' }] }));
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    try {
      const model = anthropicModel({ model: 'claude-sonnet-test', effort: 'medium', maxTokens: 100, fallback: false, promptCache: true, apiKey: 'sk-test', baseUrl: fake.url });
      for (let i = 0; i < 60; i++) {
        const messages: AgentMessage[] = [{ role: 'user', content: rand(5) ? 'hello' : '' }];
        for (let turn = rand(5); turn > 0; turn--) {
          const id = `c${i}_${turn}`;
          const raw = rand(2) ? { provider: 'anthropic', content: [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, ...(rand(2) ? [{ type: 'text', text: 'calling' }] : []), { type: 'tool_use', id, name: 'a', input: {} }] } : undefined;
          messages.push({ role: 'assistant', text: 'calling', toolCalls: [{ id, name: 'a', input: {} }], ...(raw && { raw }) });
          messages.push({ role: 'tool', results: [{ id, name: 'a', content: rand(4) ? 'result' : '' }] });
        }
        if (rand(4) === 0) messages.push({ role: 'assistant', text: '', toolCalls: [], raw: { provider: 'anthropic', content: [{ type: 'thinking', thinking: 'only', signature: 'sig' }] } });
        const before = JSON.stringify(messages);
        await model.generate({ system: 'A'.repeat(20), systemCacheBreak: rand(3) ? rand(20) : undefined, messages, tools: Array.from({ length: rand(4) }, (_, n) => tool(`t${n}`)) });
        expect(JSON.stringify(messages)).toBe(before);
      }
      expect(fake.calls).toHaveLength(60);
      expect(Math.max(...fake.calls.map((c) => c.breakpoints))).toBeLessThanOrEqual(3);
      // A thinking block never carries the mark.
      for (const call of fake.calls) for (const m of (call.body as { messages: { content: unknown }[] }).messages) if (Array.isArray(m.content)) for (const b of m.content as { type: string; cache_control?: unknown }[]) if (b.type === 'thinking') expect(b.cache_control).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it('leaves the stored messages and replayed blocks untouched (a copy gets the mark)', () => {
    const raw = { provider: 'anthropic', content: [{ type: 'text', text: 'x' }] };
    const messages = toAnthropicMessages([{ role: 'user', content: 'q' }, { role: 'assistant', text: 'x', toolCalls: [], raw }]);
    const marked = withMessageBreakpoint(messages);
    expect(JSON.stringify(raw)).toBe(JSON.stringify({ provider: 'anthropic', content: [{ type: 'text', text: 'x' }] }));
    expect(marks(messages)).toBe(0);
    expect(marks(marked)).toBe(1);
  });

  it('sends OpenAI and Ollama the same request with or without a cache break', async () => {
    const fake = await startFakeOpenAi();
    try {
      const input = { system: 'STABLE|VOLATILE', messages: [{ role: 'user' as const, content: 'hello' }], tools: [tool('a')] };
      const openai = openAiModel(openAiConnection({ apiKey: 'sk-test', baseUrl: fake.url }), { model: 'gpt-test' });
      await openai.generate(input);
      await openai.generate({ ...input, systemCacheBreak: 6 });
      const ollama = ollamaModel({ baseUrl: fake.origin, model: 'llama-test' });
      await ollama.generate(input);
      await ollama.generate({ ...input, systemCacheBreak: 6 });
      const sent = fake.requests.filter((r) => r.method === 'POST').map((r) => r.body);
      expect(sent).toHaveLength(4);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[3]).toEqual(sent[2]);
      expect(JSON.stringify(sent)).not.toContain('cache_control');
    } finally {
      await fake.close();
    }
  });
});

/** Base's layout from the new request: one system block with the breakpoint, none on the messages. */
function toBase(body: any): any {
  const text = typeof body.system === 'string' ? body.system : (body.system as { text: string }[]).map((b) => b.text).join('');
  const strip = (block: any) => {
    const { cache_control: _c, ...rest } = block;
    void _c;
    return rest;
  };
  return {
    ...body,
    system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
    messages: body.messages.map((m: any) => (typeof m.content === 'string' ? m : { ...m, content: m.content.map(strip) })),
  };
}

describe('the measurement: base’s layout against the new one', () => {
  const TOOLS = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  let runIndex = 0;
  let toolSeq = 0;
  const plan: FakeReply['content'][][] = [
    [[tool('Alpha')], [{ type: 'tool_use', id: 'x', name: 'remember', input: { fact: 'prefers short answers' } }], [tool('Beta')], [{ type: 'text', text: 'All done.' }]],
    [[tool('Gamma')], [{ type: 'text', text: 'Done again.' }]],
  ];
  function tool(name: string) {
    return { type: 'tool_use', id: `toolu_${++toolSeq}`, name, input: { text: 'ping' } };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const PRICE = { input: 3, read: 0.3, write: 3.75, output: 15 };
  const cost = (calls: { cacheRead: number; cacheWrite: number; uncachedInput: number; output: number }[]) => calls.reduce((sum, c) => sum + (c.uncachedInput * PRICE.input + c.cacheRead * PRICE.read + c.cacheWrite * PRICE.write + c.output * PRICE.output) / 1e6, 0);
  const total = (calls: { cacheRead: number; cacheWrite: number; uncachedInput: number }[], field: 'cacheRead' | 'cacheWrite' | 'uncachedInput') => calls.reduce((n, c) => n + c[field], 0);

  async function measure(which: 'base' | 'new') {
    layout = which;
    runIndex = 0;
    toolSeq = 0;
    const fake = await startFakeAnthropicCache(({ body }) => {
      const answered = (body.messages as { role: string }[]).filter((m) => m.role === 'assistant').length;
      return { content: plan[runIndex]![answered]! };
    });
    fakeUrl = fake.url;
    if (which === 'base') fake.state.rewrite = toBase;
    try {
      const agent = agentOf({
        persona: { role: 'Operations lead', goal: PERSONA_TEXT } as AgentConfig['persona'],
        instructions: PERSONA_TEXT,
        description: 'Runs the daily work',
        skills: [{ id: 's1', name: 'triage', whenToUse: 'when asked to triage', instructions: 'steps' }],
        memory: { crossSession: true } as AgentConfig['memory'],
        tools: TOOLS.map((n) => ({ id: `t_${n}`, type: 'node' as const, name: n, description: `${n} hands the input back unchanged`, nodeType: 'core.noOp', parameters: {} })),
      });
      agentStore.remember(agent.id, 'you', 'works in the Berlin office');
      agentRef = agent;
      configRef = configFor(agent, 'draft');
      const first = sessionOf(agent);
      sessionRef = first;
      memoryAtStart = undefined;
      await runAgent({ agent, session: first, message: 'Please go through the open items and tell me what is left.' });
      const run1 = [...fake.calls];
      expect(run1).toHaveLength(4);
      // Four minutes later: a new run (its date line differs), the cache still alive.
      vi.setSystemTime(new Date('2026-05-01T10:04:00.000Z'));
      runIndex = 1;
      const second = sessionOf(agent);
      sessionRef = second;
      memoryAtStart = undefined;
      await runAgent({ agent, session: second, message: 'And what about the closed ones?' });
      const run2 = fake.calls.slice(4);
      expect(run2).toHaveLength(2);
      return { run1, run2 };
    } finally {
      fake.state.rewrite = undefined;
      await fake.close();
    }
  }

  it('reads more and pays less on the second and later iterations and on the second run, and a remember is no full miss', async () => {
    const base = await measure('base');
    const next = await measure('new');
    const row = (label: string, r: { run1: typeof base.run1; run2: typeof base.run2 }) => {
      const later = r.run1.slice(1);
      return {
        layout: label,
        'cache read (iters 2-4)': total(later, 'cacheRead'),
        'uncached input (iters 2-4)': total(later, 'uncachedInput'),
        'cache write (run 1)': total(r.run1, 'cacheWrite'),
        'cache read (run 2)': total(r.run2, 'cacheRead'),
        'uncached input (run 2)': total(r.run2, 'uncachedInput'),
        'cache write (run 2)': total(r.run2, 'cacheWrite'),
        'cost run 1 ($)': Number(cost(r.run1).toFixed(5)),
        'cost run 2 ($)': Number(cost(r.run2).toFixed(5)),
      };
    };
    console.table([row('base', base), row('new', next)]);
    console.log('per call (read / write / uncached):', JSON.stringify({ base: [...base.run1, ...base.run2].map((c) => [c.cacheRead, c.cacheWrite, c.uncachedInput]), new: [...next.run1, ...next.run2].map((c) => [c.cacheRead, c.cacheWrite, c.uncachedInput]) }));
    // The second and later iterations: more read from the cache, less full-price input, a lower cost.
    expect(total(next.run1.slice(1), 'cacheRead')).toBeGreaterThan(total(base.run1.slice(1), 'cacheRead'));
    expect(total(next.run1.slice(1), 'uncachedInput')).toBeLessThan(total(base.run1.slice(1), 'uncachedInput'));
    expect(cost(next.run1.slice(1))).toBeLessThan(cost(base.run1.slice(1)));
    // The second run reads the stable system (base's date line made the prefix new).
    expect(total(next.run2, 'cacheRead')).toBeGreaterThan(total(base.run2, 'cacheRead'));
    expect(total(next.run2, 'uncachedInput')).toBeLessThan(total(base.run2, 'uncachedInput'));
    expect(cost(next.run2)).toBeLessThan(cost(base.run2));
    // The remember (answered in iteration 2) forced base to re-read the changed prompt at full price in iteration 3; the new layout reads as much as before.
    expect(base.run1[2]!.cacheRead).toBeLessThan(base.run1[1]!.cacheRead);
    expect(next.run1[2]!.cacheRead).toBeGreaterThanOrEqual(next.run1[1]!.cacheRead);
    // Never more than three breakpoints.
    expect(Math.max(...[...next.run1, ...next.run2].map((c) => c.breakpoints))).toBeLessThanOrEqual(3);
  });
});
