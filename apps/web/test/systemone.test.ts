import { describe, expect, it, vi } from 'vitest';
import { runGuardrails } from '../src/lib/server/guardrails';
import { SystemOneApiError, strandsConnection, systemOneDecide, systemOneJudge, typesafeConnection, typesafeModels } from '../src/lib/server/nodes/systemone';

const connection = typesafeConnection({ apiKey: ' key-1 ', baseUrl: 'https://jev.test/' });

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const answer = (noul: number, name = 'flagged') => reply({ model: 'jev-1.13.0', answers: { [name]: { type: 'noul', noul } }, usage: { input_tokens: 120, output_tokens: 9 } });

describe('the TypeSafe client', () => {
  it('trims the key and the base URL, and refuses a credential without a key', () => {
    expect(connection).toEqual({ label: 'TypeSafe', apiKey: 'key-1', baseUrl: 'https://jev.test', model: 'jev-latest' });
    expect(typesafeConnection({ apiKey: 'k' }).baseUrl).toBe('https://api.typesafe.ai');
    expect(() => typesafeConnection({ apiKey: ' ' })).toThrow(/no API key/);
  });

  it('talks to a Strands Decider server with no key and no model', async () => {
    const strands = strandsConnection({ baseUrl: 'http://127.0.0.1:8000/' });
    expect(strands).toEqual({ label: 'Strands Decider', baseUrl: 'http://127.0.0.1:8000' });
    expect(() => strandsConnection({ baseUrl: ' ' })).toThrow(/no server address/);
    const fetcher = vi.fn(async () => answer(0.7, 'ok'));
    const result = await systemOneDecide(strands, 'ping', { ok: 'Is this a greeting?' }, { fetcher });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ state: 'ping', questions: { ok: { type: 'noul', instructions: 'Is this a greeting?' } } });
    expect(result.answers.ok).toBe(0.7);
    // An error names the service, not Jev.
    await expect(systemOneDecide(strands, 'x', { ok: 'q' }, { fetcher: async () => reply({ detail: 'no model loaded' }, 500) })).rejects.toThrow(/Strands Decider answered 500: no model loaded/);
  });

  it('posts the state and the questions to /v1/systemone with a Bearer key', async () => {
    const fetcher = vi.fn(async () => answer(0.93));
    const result = await systemOneDecide(connection, 'a text', { flagged: 'Is it urgent?' }, { fetcher });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://jev.test/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key-1');
    expect(JSON.parse(init.body as string)).toEqual({ state: 'a text', model: 'jev-latest', questions: { flagged: { type: 'noul', instructions: 'Is it urgent?' } } });
    expect(result).toEqual({ model: 'jev-1.13.0', answers: { flagged: 0.93 }, usage: { inputTokens: 120, outputTokens: 9 } });
  });

  it('retries a 429 and honours retry-after, but not a rejected key', async () => {
    const limited = vi.fn().mockResolvedValueOnce(reply({ detail: 'slow down' }, 429, { 'retry-after': '0' })).mockResolvedValueOnce(answer(0.1));
    expect((await systemOneDecide(connection, 't', { flagged: 'q' }, { fetcher: limited })).answers.flagged).toBe(0.1);
    expect(limited).toHaveBeenCalledTimes(2);

    const refused = vi.fn(async () => reply({ detail: 'bad key' }, 403));
    await expect(systemOneDecide(connection, 't', { flagged: 'q' }, { fetcher: refused })).rejects.toThrow(/rejected the API key: bad key/);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('fails when a question comes back unanswered', async () => {
    const fetcher = vi.fn(async () => reply({ model: 'jev-1.13.0', answers: {}, usage: {} }));
    await expect(systemOneDecide(connection, 't', { flagged: 'q' }, { fetcher })).rejects.toBeInstanceOf(SystemOneApiError);
  });

  it('lists the models', async () => {
    const fetcher = vi.fn(async () => reply({ models: [{ name: 'jev-latest' }, { name: 'jev-preview' }] }));
    expect(await typesafeModels(connection, fetcher)).toHaveLength(2);
  });
});

describe('Jev as the guardrail judge', () => {
  it('turns the probability of yes into a verdict', async () => {
    const flagged = await systemOneJudge(connection, { fetcher: async () => answer(0.9) })('Flag insults', 'you fool');
    expect(flagged).toMatchObject({ flagged: true, confidence: 0.9 });
    const fine = await systemOneJudge(connection, { fetcher: async () => answer(0.2) })('Flag insults', 'hello');
    expect(fine).toMatchObject({ flagged: false, confidence: 0.2 });
  });

  it('sends the passages with the text for a grounded check', async () => {
    const fetcher = vi.fn(async () => answer(0.1));
    await systemOneJudge(connection, { fetcher })('Flag unsupported claims', 'Returns take 30 days', undefined, 'Returns take 14 days.');
    const body = JSON.parse(((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string));
    expect(body.state).toContain('Returns take 14 days.');
    expect(body.state).toContain('Returns take 30 days');
  });

  it('answers the model checks of runGuardrails with no chat model at all', async () => {
    const judge = systemOneJudge(connection, { fetcher: async () => answer(0.95) });
    const outcome = await runGuardrails('what is the weather', { topical: { prompt: 'Parcel delivery', threshold: 0.7 } }, { judge });
    expect(outcome.passed).toBe(false);
    expect(outcome.violations[0]).toMatchObject({ check: 'topicalAlignment', confidence: 0.95 });

    const quiet = systemOneJudge(connection, { fetcher: async () => answer(0.05) });
    expect((await runGuardrails('where is my parcel', { topical: { prompt: 'Parcel delivery', threshold: 0.7 } }, { judge: quiet })).passed).toBe(true);
  });

  it('fails closed when Jev errors', async () => {
    const judge = systemOneJudge(connection, { fetcher: async () => reply({ detail: 'down' }, 500) });
    const outcome = await runGuardrails('hello', { nsfw: { threshold: 0.7 } }, { judge });
    expect(outcome.passed).toBe(false);
    expect(outcome.violations[0]?.reason).toMatch(/check failed/);
  });
});
