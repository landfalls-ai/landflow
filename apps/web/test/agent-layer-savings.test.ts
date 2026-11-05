import { describe, expect, it } from 'vitest';
import { estimateSavings } from '@/lib/server/agents/layer-savings';
import type { AgentSession, TimelineEntry } from '@/lib/shared/agents';

const at = '2026-11-05T10:00:00Z';
const session = (timeline: TimelineEntry[]) => ({ timeline }) as unknown as AgentSession;
const prices = [{ provider: 'anthropic', model: 'claude-x', input: 3, output: 15 }];
const own = { provider: 'anthropic', model: 'claude-x' };
const answer = (model: string, inputTokens: number, outputTokens: number, when = at): TimelineEntry => ({ id: `a${inputTokens}`, type: 'assistant', text: 'ok', at: when, model, usage: { inputTokens, outputTokens } });
const notice = (message: string, when = at): TimelineEntry => ({ id: `n${message.length}`, type: 'notice', message, at: when });

describe('estimateSavings', () => {
  it('prices what the agent\'s own model would have charged for an answer the cheap model gave', () => {
    const routed = session([notice('Routed to small: short request'), answer('ollama/small', 1_000, 500)]);
    // 1000 x $3 + 500 x $15 per million, against a local model that costs nothing.
    expect(estimateSavings([routed], own, prices).routing).toBeCloseTo(0.0105);
  });

  it('values a cache answer as an average answer of the agent\'s own model', () => {
    const asked = session([answer('anthropic/claude-x', 2_000, 1_000)]);
    const hit = session([notice('Answered from the response cache: no model call.'), { id: 'c', type: 'assistant', text: 'ok', at, model: 'response cache' }]);
    expect(estimateSavings([asked, hit], own, prices).cache).toBeCloseTo(0.021);
    // With no answers of its own to average there is nothing to say.
    expect(estimateSavings([hit], own, prices).cache).toBe(0);
  });

  it('counts only steps since a time, and nothing without a model', () => {
    const routed = session([notice('Routed to small: x', '2026-10-01T00:00:00Z'), answer('ollama/small', 1_000, 500, '2026-10-01T00:00:00Z')]);
    expect(estimateSavings([routed], own, prices, '2026-11-01T00:00:00Z').routing).toBe(0);
    expect(estimateSavings([routed], undefined, prices)).toEqual({ routing: 0, cache: 0 });
  });
});
