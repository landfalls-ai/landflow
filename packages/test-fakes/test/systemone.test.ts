/** The System One fake: the endpoint's validation, Ollama's model list and 404s, a key when seeded, keyword answers. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeSystemOne } from '../src/systemone';

const server = fakeSystemOne();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => server.reset());

const post = (body: unknown) => fetch(`${server.url}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the System One fake', () => {
  it('answers a choice with probabilities that favour the option the text talks about', async () => {
    const response = await post({ model: 'nimble:9b', state: 'I was charged twice, please refund', questions: { topic: { type: 'choice', criteria: { billing: 'charged, refund or invoice', technical: 'errors and bugs' } } } });
    const { answers } = (await response.json()) as { answers: { topic: { choice: string; probabilities: Record<string, number> } } };
    expect(answers.topic.choice).toBe('billing');
    expect(answers.topic.probabilities.billing).toBeGreaterThan(answers.topic.probabilities.technical);
  });

  it('refuses a model it does not hold the way Ollama does, and an old server with a plain 404', async () => {
    const missing = await post({ model: 'nope', state: 'x', questions: { q: { type: 'noul' } } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "model 'nope' not found" });
    const old = fakeSystemOne({ oldServer: true });
    await old.start();
    try {
      const response = await fetch(`${old.url}/v1/systemone`, { method: 'POST', body: '{}' });
      expect([response.status, await response.text()]).toEqual([404, '404 page not found']);
    } finally {
      await old.stop();
    }
  });

  it('applies the real limits and wants the key when seeded with one', async () => {
    expect((await post({ state: 'x', questions: { q: { type: 'choice', criteria: { only: null } } } })).status).toBe(422);
    expect((await post({ state: 'x', questions: {} })).status).toBe(422);
    const keyed = fakeSystemOne({ key: 'k' });
    await keyed.start();
    try {
      expect((await fetch(`${keyed.url}/api/tags`)).status).toBe(401);
      expect((await fetch(`${keyed.url}/api/tags`, { headers: { authorization: 'Bearer k' } })).status).toBe(200);
    } finally {
      await keyed.stop();
    }
  });
});
