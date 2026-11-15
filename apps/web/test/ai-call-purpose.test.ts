import type { LanguageModel } from '@landflow/engine';
import { describe, expect, it, vi } from 'vitest';
import { assistantScope, runInUsageScope } from '../src/lib/server/ai-usage';
import { currentCallNote, withCallPurpose } from '../src/lib/server/ai-usage/call-context';
import { database } from '../src/lib/server/db';
import { gradeRun } from '../src/lib/server/evaluations/online';
import { judge } from '../src/lib/server/evaluations/metrics';
import { writeBriefingText } from '../src/lib/server/brain/briefing';
import { runGuardrails } from '../src/lib/server/guardrails';
import { strandsConnection, systemOneJudge, typesafeConnection } from '../src/lib/server/nodes/systemone';
import { llmReranker } from '../src/lib/server/rag/rerank';

/** A fake chat model that reads the note in force at each call and answers with `reply`. */
function noting(reply: string) {
  const notes: Array<ReturnType<typeof currentCallNote>> = [];
  const model = {
    provider: 'fake',
    model: 'fake-1',
    async generate() {
      notes.push(currentCallNote());
      return { text: reply, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LanguageModel;
  return { model, notes };
}

const embedNotes: Array<string | undefined> = [];
vi.mock('../src/lib/server/rag/embeddings', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ollamaEmbeddings: () => ({
    embedQuery: async () => {
      embedNotes.push(currentCallNote().purpose);
      return [0.1, 0.2];
    },
  }),
}));

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jev = typesafeConnection({ apiKey: 'dev-key', baseUrl: 'https://jev.test' });

describe('purpose at the call sites (SP02)', () => {
  it('a guardrail check made by the chat model is a guardrail call', async () => {
    const { model, notes } = noting('{"flagged": false, "confidence": 0.1, "reason": "fine"}');
    await runGuardrails('hello there', { nsfw: {} }, { model }).catch(() => undefined);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.purpose === 'guardrail')).toBe(true);
  });

  it('a judge passed to the guardrails runs inside the guardrail note', async () => {
    const seen: Array<string | undefined> = [];
    const judgeFn = async () => {
      seen.push(currentCallNote().purpose);
      return { flagged: false, confidence: 0.1 };
    };
    await runGuardrails('hello there', { nsfw: {} }, { judge: judgeFn }).catch(() => undefined);
    expect(seen).toEqual(['guardrail']);
  });

  it('a guardrail inside an eval keeps its own purpose (an inner purpose wins)', () => {
    const inner = withCallPurpose('eval', () => ({ outer: currentCallNote().purpose, inner: withCallPurpose('guardrail', () => currentCallNote().purpose) }));
    expect(inner).toEqual({ outer: 'eval', inner: 'guardrail' });
  });

  it('the LLM reranker is a rerank call', async () => {
    const { model, notes } = noting('{"scores":[{"index":0,"score":3},{"index":1,"score":9}]}');
    const ranked = await llmReranker(model).rerank('q', [{ pageContent: 'a', metadata: {} }, { pageContent: 'b', metadata: {} }] as never);
    expect(notes.map((n) => n.purpose)).toEqual(['rerank']);
    expect(ranked[0]?.pageContent).toBe('b');
  });

  it('judge scores are judge calls, the text fallback included', async () => {
    const structured = noting('{"reasoning":"ok","score":4}');
    await judge(structured.model, 'rubric', { rubric: 'be kind', question: 'q', actual: 'a' });
    expect(structured.notes.map((n) => n.purpose)).toEqual(['judge']);
    const prose = noting('Score: 3');
    await judge(prose.model, 'rubric', { rubric: 'be kind', question: 'q', actual: 'a' });
    expect(prose.notes.length).toBeGreaterThan(0);
    expect(prose.notes.every((n) => n.purpose === 'judge')).toBe(true);
  });

  it('grading a run is a judge call', async () => {
    const { model, notes } = noting('{"reasoning":"ok","score":4}');
    await gradeRun('agent:sp02-test', { input: 'hi', output: 'hello' }, { model });
    expect(notes.every((n) => n.purpose === 'judge')).toBe(true);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('the semantic cache embeds its questions as cache-embed', async () => {
    const { embedderFor } = await import('../src/lib/server/agents/semantic-cache');
    await embedderFor({ model: 'nomic-embed-text' } as never)('How are you?');
    expect(embedNotes).toEqual(['cache-embed']);
  });

  it('a briefing is a summary call', async () => {
    const { model, notes } = noting('You did things.');
    await writeBriefingText({ own: [{ text: 'x' }], related: [], finished: [] } as never, model);
    expect(notes.map((n) => n.purpose)).toEqual(['summary']);
  });
});

describe('Jev and Strands judge calls are counted (SP02)', () => {
  const metered = <T>(fn: () => Promise<T>) => runInUsageScope(assistantScope({ surface: 'brain' }), fn);
  const rowsFor = (provider: string) => database().all<{ provider: string; input_tokens: number; output_tokens: number; cost: number | null }>('SELECT provider, input_tokens, output_tokens, cost FROM ai_usage WHERE provider = ?', provider);

  it('writes an unpriced ai_usage row with the tokens the service reports', async () => {
    const before = rowsFor('typesafe').length;
    const fetcher = vi.fn(async () => reply({ model: 'jev-1.13.0', answers: { flagged: { noul: 0.9 } }, usage: { input_tokens: 120, output_tokens: 9 } }));
    const onUsage = vi.fn();
    const verdict = await metered(() => systemOneJudge(jev, { fetcher, onUsage })('Flag rudeness', 'you fool', undefined));
    expect(verdict.flagged).toBe(true);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 120, outputTokens: 9 }, 'jev-1.13.0');
    const rows = rowsFor('typesafe');
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ input_tokens: 120, output_tokens: 9 });
    expect(rows.at(-1)?.cost ?? 0).toBe(0);
  });

  it('counts a Strands call too, with 0 tokens when the service reports none', async () => {
    const before = rowsFor('strands').length;
    const fetcher = vi.fn(async () => reply({ answers: { flagged: { noul: 0.1 } } }));
    await metered(() => systemOneJudge(strandsConnection({ baseUrl: 'http://127.0.0.1:8000' }), { fetcher })('Flag rudeness', 'hello'));
    expect(rowsFor('strands').length).toBe(before + 1);
  });

  it('still fails closed when the service fails, and runs inside a guardrail note', async () => {
    const fetcher = vi.fn(async () => reply({ detail: 'down' }, 500));
    const outcome = await metered(() => runGuardrails('hello', { nsfw: {} }, { judge: systemOneJudge(jev, { fetcher }) }));
    expect(outcome.passed).toBe(false);
    expect(outcome.checks.find((c) => c.check === 'nsfw')?.error).toMatch(/TypeSafe answered 500/);
  });
});
